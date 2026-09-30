//! P17B Slice 2：逐 episode 派生（动作链 / 结束前窗口 / 松散球期的追球者）。
//!
//! 本模块是**纯函数层**：输入一场比赛的公开 `DiagnosticMatch` + seed，输出 [`EpisodeCard`]。
//! 不做 I/O、不写文件、不读环境——便于单测与确定性比对（同 P17A `model.rs` 的形状）。
//!
//! ## 四条口径纪律（改动前先读，勿退回）
//!
//! 1. **动作 = 决策事件**：`pass` / `shot` / `tackle` / `foul` / `kickoff`。`beat` 是逐拍位移
//!    节拍，**不计入动作链**（同 P17A）。故「动作链」只走 episode 的 `event_indexes`。
//! 2. **松散球判据必须排除重开准备期**（`loose && !in_restart_window`）——`BallState{loose:true}`
//!    有**两个**生产点：真松散球与**角球/界外球发球前的走位等待**（球钉在发球点）。
//!    裸用会让比例失真（侦察初版 43%/27% 即由此而来）。
//! 3. **`chase` 与 `close_down` 不得并称「追球者」**：`chase` 靶点恒为球；
//!    `close_down` 的靶点按 `TransitionSource` 分流（`SaveCaught` 时追**人**）。
//! 4. **缺证据不猜**：不可得记 `None` / `unknown`，不用默认值或代理量顶替。
//!
//! ## 时间基准
//!
//! 本模块只用 `state_commit` 基准的时刻（快照 / episode 起止 / 重开窗），
//! 与 `beat` 事件的 `t` 同源（都取自同一 tick 计数器）。**不混用** `event_emit` /
//! `flight_end` 基准（design §2.3 / P16 口径 2 的同款纪律）。

use crate::evidence::{Locus, TAIL_TICKS, WindowEnd};
use fm_engine::observation::*;
use fm_engine::{Event, EventType};
use std::collections::BTreeMap;

// ============================== 动作链 ==============================

/// 决策动作的**闭集 token**。与 P17A `ActionKind::token` 同读法（`pass+` 等短串便于入 JSON）。
///
/// ⚠️ 与 P17A 的实现是**两份独立代码**（本 change 不 include `p17a`），
/// 故有一条交叉守卫：同一 seed 上两条实现给的 token 序列必须一致
/// （`action_tokens_match_the_p17a_reference`）。这是「同源」在**行为层**的核，
/// 因为二者的口径相同但实现分离。
pub fn action_token(e: &Event) -> &'static str {
    match e.type_ {
        EventType::Kickoff => "kickoff",
        EventType::Pass => match e.result.as_deref().unwrap_or("") {
            "success" => "pass+",
            "intercepted" => "passI",
            "lost" => "passL",
            "out" => "passO",
            "contested" => "passC",
            _ => "pass?",
        },
        EventType::Shot => match e.result.as_deref().unwrap_or("") {
            "goal" => "shotG",
            "saved" => "shotS",
            "off_target" => "shotX",
            _ => "shot?",
        },
        EventType::Tackle => "tackle",
        EventType::Foul => "foul",
        _ => "other",
    }
}

/// 一条动作链节点。
#[derive(Debug, Clone, PartialEq)]
pub struct ChainNode {
    /// 在 `DiagnosticMatch.events` 里的**最终**下标（可回放定位用）。
    pub event_index: usize,
    pub t: f64,
    pub token: &'static str,
    /// 动作主体（球员 id）——回放定位与逐条核对用。
    pub subject: i32,
    /// 该动作的落点（`None` = 该事件类型不带落点，如 `tackle`）。`观测`。
    pub locus: Locus,
}

/// 从 episode 的 `event_indexes` 里抽决策动作链（跳过 `beat` / `lineup` / `whistle` /
/// `substitution`）。下标越界时**跳过并在计数里记一笔**（不猜、不 panic）。
pub fn action_chain(dm: &DiagnosticMatch, ep: &PossessionEpisode, bad_indexes: &mut usize) -> Vec<ChainNode> {
    let mut out = Vec::new();
    for i in &ep.event_indexes {
        let Some(e) = dm.events.get(*i) else {
            *bad_indexes += 1;
            continue;
        };
        if e.type_ == EventType::Beat {
            continue;
        }
        let locus = match e.type_ {
            EventType::Pass | EventType::Shot | EventType::Kickoff => Locus::EventTargetPosition,
            _ => Locus::EventPosition,
        };
        out.push(ChainNode {
            event_index: *i,
            t: e.t,
            token: action_token(e),
            subject: e.subject,
            locus,
        });
    }
    out
}

// ============================== 重开窗口 ==============================

/// 一段重开准备期窗口 `[start_t, end_t)` 及其**终点来源**（可审计）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RestartWindow {
    pub start: f64,
    pub end: f64,
    pub end_source: WindowEnd,
}

/// 由 `restart_sequences` 构造重开准备期窗口集（**唯一实现**）。
///
/// ## 终点取值链（design §5 待决策 3 的闭合）
///
/// 按序取：`taken_t` → `open_play_resumed_t` → 下一条重开的 `start_t` → 事件流末端。
/// **顺序不是任意的**：`taken_t` 是「球被发出」的权威时刻（准备期在那一刻结束）；
/// 缺失时退到「已恢复开放比赛」；再缺则退到「下一段死球开启（本段准备期无论如何结束了）」；
/// 都没有（流在重开中截断）则延到流末——**这不是「没有准备期」，而是「准备期到流末为止」**。
///
/// ⚠️ 三档 fallback 都**不改判据**（窗口语义仍是「重开准备期」），只影响窗口右端的估计；
/// `end_source` 把它记下来，使报告能说清「这个窗口的右端是猜的还是观测的」。
pub fn restart_windows(dm: &DiagnosticMatch) -> Vec<RestartWindow> {
    let stream_end = dm.events.last().map(|e| e.t).unwrap_or(f64::INFINITY);
    let mut out = Vec::with_capacity(dm.restart_sequences.len());
    for (i, r) in dm.restart_sequences.iter().enumerate() {
        let start = r.start_t.value;
        let (end, end_source) = if let Some(t) = r.taken_t {
            (t.value, WindowEnd::Taken)
        } else if let Some(t) = r.open_play_resumed_t {
            (t.value, WindowEnd::OpenPlayResumed)
        } else if let Some(next) = dm.restart_sequences.get(i + 1) {
            (next.start_t.value, WindowEnd::NextRestartStart)
        } else {
            (stream_end, WindowEnd::StreamEnd)
        };
        // 不变量 5 保证 taken_t ≥ start_t，但 fallback 档没有该保证 ⇒ 钳一下，
        // 避免出现「负长度窗口」让下方的一切 `t >= start && t < end` 恒假。
        out.push(RestartWindow {
            start,
            end: end.max(start),
            end_source,
        });
    }
    out
}

/// 某时刻是否落在**任一**重开准备期窗口内。
///
/// 这是设计 §4.4.1 定死的判据的另一半：松散球 = `beat.ball.loose && !in_restart_window(t)`。
/// 抽成函数使「排除准备期」这件事**只有一个实现**，定向变异（去掉排除）只需改一处。
pub fn in_restart_window(windows: &[RestartWindow], t: f64) -> bool {
    windows.iter().any(|w| t >= w.start - 1e-9 && t < w.end - 1e-9)
}

// ============================== 松散球段与追球者 ==============================

/// 谁在追——**分类**，不并称（design §4.4.3）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PursuitRole {
    /// `Mover.action == "chase"`：**靶点恒为球**（可称「追球」）。
    Chase,
    /// `Mover.action == "close_down"`：靶点按 `TransitionSource` 分流，
    /// `SaveCaught` 时是**前插球员**（追人）。**不得**与 `Chase` 并称「追球者」。
    CloseDown,
    /// 其余动作（`run` / `keeper_return` / 未知串）——都不是「追球」。
    Other,
}

impl PursuitRole {
    pub const fn as_str(self) -> &'static str {
        match self {
            PursuitRole::Chase => "chase",
            PursuitRole::CloseDown => "close_down",
            PursuitRole::Other => "other",
        }
    }

    /// 从开集字符串分类。⚠️ `Mover.action` **无编译期闭集**（30 seed 实跑恰为
    /// `{chase, close_down, run, keeper_return}`）⇒ 未列举的串静默落入 `Other`，
    /// 由报告的可审计栏位（`other_actions`）暴露，而不是假装它不存在。
    pub fn of(action: &str) -> PursuitRole {
        match action {
            "chase" => PursuitRole::Chase,
            "close_down" => PursuitRole::CloseDown,
            _ => PursuitRole::Other,
        }
    }
}

/// 一个松散球段（连续 loose beat 串）里的追球者与归属。
#[derive(Debug, Clone, PartialEq)]
pub struct LooseRun {
    /// 段内 beats 在事件流里的下标（升序）。
    pub event_indexes: Vec<usize>,
    pub start_t: f64,
    pub end_t: f64,
    pub beats: usize,
    /// `chase` 追球者（按 id 升序去重）。
    pub chasers: Vec<i32>,
    /// `close_down` 执行者（按 id 升序去重）——**与 `chasers` 分列**。
    pub close_downers: Vec<i32>,
    /// 段内出现过的**其它** `Mover.action` 串（按字典序去重）。
    /// 它让「开集字符串出现新值」在产物里**可见**，而不是静默丢失。
    pub other_actions: Vec<String>,
    /// 段内出现过的动作 → 次数（**按 [`PursuitRole`] 归类**）。
    /// 报告用它展示「本段有哪些角色」，且 [`PursuitRole::Other`] 那一栏
    /// 正是「开集里出现了未列举的值」的可审计出口。
    pub role_counts: BTreeMap<&'static str, usize>,
}

impl LooseRun {
    /// `chase` 追球者的**归属队**（由 `Mover.id` 映射：0–10 主队、11–21 客队）。
    ///
    /// 设计 §5 待决策 9 定死为**这一种**读法：`mover.id` 是 beat 数组里唯一的球队线索，
    /// 且 `chase` 恒由「被允许追的一队」推出（`winning_team` 决定谁被允许追），
    /// 故 id→队 的映射与引擎的 id 空间是**同一套**（`TeamId::from_player`）。
    /// 无法映射的 id（越界）**不计入**任一方——不用「猜」补。
    pub fn chasing_teams(&self) -> (bool, bool) {
        let mut home = false;
        let mut away = false;
        for id in &self.chasers {
            match TeamId::from_player(*id) {
                Some(TeamId::Home) => home = true,
                Some(TeamId::Away) => away = true,
                None => {}
            }
        }
        (home, away)
    }

    /// 归属的**分类**（`两队都追` / `只一队` / `none`）。**由 `chase` 判**，
    /// `close_down` **不参与**（否则就是把追人算成追球——MAJOR-2 的变异形态）。
    pub fn chase_class(&self) -> &'static str {
        match self.chasing_teams() {
            (true, true) => "both",
            (false, false) => "none",
            _ => "one",
        }
    }
}

/// 取一个 episode 的松散球段。
///
/// 段 = **事件流里相邻**的 loose beat 串（任何非 beat / 非 loose beat / 准备期 beat 都断开）。
/// 「流中相邻」是刻意的：松散球过程的**时间连续性**由事件流的相邻性表达，
/// 跳过中间的 dry beat 会把两段无关的球拼成一段（实测差 3 倍，见报告的口径对照栏）。
///
/// 只收 `[start_t, end_t]` 窗内的 beat（episode 收束后的事件属于下一段 possession）。
pub fn loose_runs(
    dm: &DiagnosticMatch,
    windows: &[RestartWindow],
    span: (f64, Option<f64>),
) -> Vec<LooseRun> {
    let end = span.1.unwrap_or(f64::INFINITY);
    let mut out: Vec<LooseRun> = Vec::new();
    let mut cur: Option<LooseRun> = None;
    for (i, ev) in dm.events.iter().enumerate() {
        let inside = ev.t >= span.0 - 1e-9 && ev.t <= end + 1e-9;
        let is_loose_beat = ev.type_ == EventType::Beat
            && ev.ball.as_ref().map(|b| b.loose).unwrap_or(false)
            && !in_restart_window(windows, ev.t);
        if !inside || !is_loose_beat {
            if let Some(c) = cur.take() {
                out.push(c);
            }
            continue;
        }
        let run = match cur.as_mut() {
            Some(c) => c,
            None => {
                cur = Some(LooseRun {
                    event_indexes: Vec::new(),
                    start_t: ev.t,
                    end_t: ev.t,
                    beats: 0,
                    chasers: Vec::new(),
                    close_downers: Vec::new(),
                    other_actions: Vec::new(),
                    role_counts: BTreeMap::new(),
                });
                cur.as_mut().expect("just inserted")
            }
        };
        run.event_indexes.push(i);
        run.end_t = ev.t;
        run.beats += 1;
        for m in ev.movers.iter().flatten() {
            let role = PursuitRole::of(&m.action);
            *run.role_counts.entry(role.as_str()).or_insert(0) += 1;
            match role {
                PursuitRole::Chase => run.chasers.push(m.id),
                PursuitRole::CloseDown => run.close_downers.push(m.id),
                PursuitRole::Other => run.other_actions.push(m.action.clone()),
            }
        }
    }
    if let Some(c) = cur.take() {
        out.push(c);
    }
    for r in out.iter_mut() {
        r.chasers.sort_unstable();
        r.chasers.dedup();
        r.close_downers.sort_unstable();
        r.close_downers.dedup();
        r.other_actions.sort();
        r.other_actions.dedup();
    }
    out
}

// ============================== 结束前窗口 ==============================

/// 结束前窗口的一拍。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TailTick {
    pub t: f64,
    /// 接应者数（复用 #16 `support_formation` 口径；不可算时 `None`）。
    pub supporters: Option<usize>,
    /// 最近接应者距离（米）；无接应者时 `None`。
    pub nearest_support_m: Option<f64>,
    /// 持球者受压倒计时（**剩余保持 tick 数**，不是强度）。
    pub pressure_state_ticks: Option<u32>,
    /// 起脚窗口是否已开。
    pub shot_window_open: Option<bool>,
    /// 已耗拍数。
    pub window_ticks: Option<u32>,
    /// 是否已 committed。
    pub committed: Option<bool>,
    /// 球位（归一化）；该拍无快照时 `None`。
    pub ball: Option<(f64, f64)>,
}

/// episode 的**结束前窗口**（末 `TAIL_TICKS` 拍，按时间升序）。
///
/// ## 为什么以 `end_t` 为锚而不是「最后 N 条事件」
///
/// 诊断要回答的是「**结束前**发生了什么」，锚必须是收束时刻。用事件条数会让
/// 「收束前一段长带球（无决策事件）」这类过程**整段消失**——而那恰是 A1 关注的形态
/// （实测 episode 内动作间隔中位 ≈ 8 s）。故按**时间**取窗。
///
/// ## `end_t` 不可得时
///
/// 开放 episode（`end_t == None`，流在 possession 中途截断）**没有尾部**——
/// 返回空且由报告记 `unknown`（不拿「最后一个快照」冒充收束时刻）。
pub fn tail_window(
    dm: &DiagnosticMatch,
    team: TeamId,
    end_t: Option<f64>,
) -> Vec<TailTick> {
    let Some(end) = end_t else {
        return Vec::new();
    };
    // TAIL_TICKS 拍，含结束那一拍：窗口 = (end - (TAIL_TICKS-1)*Δt, end]。
    // 以快照的**实际**采样点为准（不假设步长），取时间上最接近的若干拍。
    let lo = end - (TAIL_TICKS as f64 - 1.0) - 1e-9;
    let snaps: Vec<&StateSnapshot> = dm
        .state_snapshots
        .iter()
        .filter(|s| s.t.value >= lo && s.t.value <= end + 1e-9)
        .collect();
    let mut out = Vec::with_capacity(snaps.len());
    for s in snaps {
        let sup = crate::features::support_formation(s, team);
        let intent = dm
            .intent_snapshots
            .iter()
            .find(|i| (i.t.value - s.t.value).abs() < 1e-9)
            .map(|i| i.state);
        out.push(TailTick {
            t: s.t.value,
            supporters: sup.map(|x| x.supporters),
            nearest_support_m: sup.and_then(|x| x.nearest_support_m),
            pressure_state_ticks: intent.map(|i| i.pressure_state_ticks),
            shot_window_open: intent.map(|i| i.in_window),
            window_ticks: intent.map(|i| i.window_ticks),
            committed: intent.map(|i| i.committed),
            ball: Some(s.ball),
        });
    }
    out
}

// ============================== 判据自述（能力边界，不是结论） ==============================

/// **每一条归因到底能不能答**——本表是「假边界」的抗体（spec 的 Scenario
///「已知不可得项被如实声明」/「覆盖缺口必须按成因分别声明」）。
///
/// ⚠️ 本表声明的是**能力**（我能不能看见），不是**结论**（我看见了什么）。
/// 两者混同正是 BLOCKER-1 的形态：初版给了一个笼统的「Q3 可答」，
/// 而 36% 的丢球上**根本产不出 loose beat**。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CoverageClaim {
    pub question: &'static str,
    pub answerable: &'static str,
    pub locus: Locus,
}

/// 四类归因的覆盖声明（design §4 / §7 的收敛版）。
pub const COVERAGE_CLAIMS: &[CoverageClaim] = &[
    CoverageClaim {
        question: "Q1 这次 possession 为什么结束",
        answerable: "全部：`EpisodeEndReason` 是闭集且每段闭合 episode 都有值",
        locus: Locus::EpisodeEndReason,
    },
    CoverageClaim {
        question: "Q2 为什么在这里选择射门",
        answerable: "射门侧：起脚窗口全相 + 门将位置 + 射门者起脚位置可得；\
                     **hazard 值本身与 `cooldown_ticks` 不可得**",
        locus: Locus::IntentShotWindow,
    },
    CoverageClaim {
        question: "Q2 为什么这样传球",
        answerable: "**不可答**：只有结果（`Event.result`），**没有候选/选择集**——\
                     报告只报结果，不得写成「因为…所以传了」",
        locus: Locus::EventResult,
    },
    CoverageClaim {
        question: "Q3 丢球后谁做了什么",
        answerable: "**按成因分别可答**：见 `reasons.rs` 的逐项声明——\
                     `interception_loose` 恒不可见（不产 loose beat）",
        locus: Locus::MoverAction,
    },
    CoverageClaim {
        question: "Q4 问题属于哪个战术阶段",
        answerable: "**不可答**（结构性）：只报事件级转换（`EpisodeStartReason` / \
                     `EpisodeEndReason` / `ContestStartReason`）",
        locus: Locus::FactDetail,
    },
];

// ============================== 逐 episode 诊断卡 ==============================

/// 「丢球后」一节的三种形态。**第三种是刻意的**——留空会被读成「没发生」（design §5 待决策 8）。
#[derive(Debug, Clone, PartialEq)]
pub enum PursuitView {
    /// 产了 loose beat（有可看的追逐过程）。
    Visible {
        runs: Vec<LooseRun>,
        /// 逐段归属（`both` / `one` / `none`）。
        classes: Vec<&'static str>,
    },
    /// **不产 loose beat** ⇒ 看不到追逐过程。带**为什么**（成因），不留给读者猜。
    Invisible { reason: &'static str, contest_reason: &'static str },
    /// 本 episode 不以争抢收束 ⇒ 这个问题不适用（不是「不可见」，也不是「没发生」）。
    NotApplicable,
}

/// 一张逐 episode 诊断卡（L1 的最小单元）。
#[derive(Debug, Clone)]
pub struct EpisodeCard {
    pub seed: u64,
    pub episode_id: u64,
    pub team: TeamId,
    pub start_t: f64,
    pub end_t: Option<f64>,
    pub start_reason: EpisodeStartReason,
    pub end_reason: Option<EpisodeEndReason>,
    /// 观察可信度（前置门，design §3.0）。
    pub coherent: bool,
    pub gap_count: usize,
    pub chain: Vec<ChainNode>,
    pub tail: Vec<TailTick>,
    pub pursuit: PursuitView,
    /// 本 episode 收束时的争抢成因（`ContestStartReason`），`None` = 非争抢收束。
    pub contest_start: Option<ContestStartReason>,
    /// 收束侧事实下标（回放定位用）。
    pub closing_fact_index: Option<usize>,
    /// 事件下标越界计数（>0 说明输入形状变了——如实记录，不静默）。
    pub bad_event_indexes: usize,
}

/// 从一个 episode 派生诊断卡。
///
/// `windows` 由 [`restart_windows`] 一次算好传入（避免每 episode 重算）。
pub fn card_of(
    dm: &DiagnosticMatch,
    windows: &[RestartWindow],
    seed: u64,
    ep: &PossessionEpisode,
    bad_indexes: &mut usize,
) -> EpisodeCard {
    let end_t = ep.end_t.map(|t| t.value);
    let mut chain = action_chain(dm, ep, bad_indexes);
    let closing = closing_contest_fact(dm, ep);
    // 收束侧事实的成因：`contest_started` 的 detail（本 change 只报事件级转换）。
    let contest_start = closing.and_then(|(_, f)| match f.detail {
        Some(ControlFactDetail::ContestStart(r)) => Some(r),
        _ => None,
    });
    // 「上一段怎么结束 → 这一段怎么开始」：链尾的动作 token 即上一段的收束动作。
    if chain.len() > 64 {
        // 诊断卡不截断链（可回放性要求完整），但这里保留一处显式的位置：
        // 若将来为可读性截断，必须同时给出被截断的子段定位。
    }
    let pursuit = if let Some(reason) = contest_start {
        let runs = loose_runs(dm, windows, (ep.start_t.value, end_t));
        if runs.is_empty() {
            PursuitView::Invisible {
                reason: "该成因不产 loose beat ⇒ **追逐不可见**（不是「没发生」）",
                contest_reason: reason.as_str(),
            }
        } else {
            let classes = runs.iter().map(|r| r.chase_class()).collect();
            PursuitView::Visible { runs, classes }
        }
    } else {
        PursuitView::NotApplicable
    };
    EpisodeCard {
        seed,
        episode_id: ep.id,
        team: ep.team,
        start_t: ep.start_t.value,
        end_t,
        start_reason: ep.start_reason,
        end_reason: ep.end_reason,
        coherent: dm.is_coherent() && dm.gap_count() == 0,
        gap_count: dm.gap_count(),
        chain: std::mem::take(&mut chain),
        tail: tail_window(dm, ep.team, end_t),
        pursuit,
        contest_start,
        closing_fact_index: closing.map(|(i, _)| i),
        bad_event_indexes: *bad_indexes,
    }
}

/// 找 episode 的**收束侧争抢事实**：`t == end_t` 的 `contest_started`。
///
/// 只在**同刻**找（`t == end_t`）——窗内更早的 `contest_started` 属于**别**的过程。
/// 同刻多条时取**最早**一条（与 P16 `caliber.rs` 的 `closing_fact` 同款理由：
/// `t == end_t` 上「最后一条」会选到下一个 episode 的开启事实）。
pub fn closing_contest_fact<'a>(
    dm: &'a DiagnosticMatch,
    ep: &PossessionEpisode,
) -> Option<(usize, &'a ControlFact)> {
    let end = ep.end_t?.value;
    dm.control_facts
        .iter()
        .enumerate()
        .find(|(_, f)| f.kind == ControlFactKind::ContestStarted && (f.t.value - end).abs() < 1e-9)
}

/// 一场比赛的全部诊断卡 + 逐场统计。
#[derive(Debug, Clone, Default)]
pub struct MatchCards {
    pub cards: Vec<EpisodeCard>,
    /// 每段的松散球段数（分母是**有 loose beat 的**段——防空转用）。
    pub loose_runs: usize,
    /// `chase` 总数 / `close_down` 总数 / 其它动作总数（**分类计数，不并称**）。
    pub chasers: usize,
    pub close_downers: usize,
    pub other_movers: usize,
    pub bad_event_indexes: usize,
}

/// 逐场派生（纯函数）。
pub fn cards_of(dm: &DiagnosticMatch, seed: u64) -> MatchCards {
    let windows = restart_windows(dm);
    let mut out = MatchCards::default();
    let mut bad = 0usize;
    for ep in &dm.possession_episodes {
        let card = card_of(dm, &windows, seed, ep, &mut bad);
        if let PursuitView::Visible { runs, .. } = &card.pursuit {
            out.loose_runs += runs.len();
            for r in runs {
                out.chasers += r.chasers.len();
                out.close_downers += r.close_downers.len();
                out.other_movers += r.other_actions.len();
            }
        }
        out.cards.push(card);
    }
    out.bad_event_indexes = bad;
    out
}

/// 松散球段计数的**跨场**合并（逐场先算，再相加——同 P17A 口径纪律）。
pub fn merge_counts(total: &mut BTreeMap<&'static str, usize>, per_match: &MatchCards) {
    *total.entry("loose_runs").or_insert(0) += per_match.loose_runs;
    *total.entry("chasers").or_insert(0) += per_match.chasers;
    *total.entry("close_downers").or_insert(0) += per_match.close_downers;
    *total.entry("other_movers").or_insert(0) += per_match.other_movers;
}

// ============================== 异常筛选（L1 粒度的第二半） ==============================

/// 长持球阈值（秒）——与 P17A 的 `DWELL_ANOMALY_SECONDS` **同值**。
///
/// 同名同值不是巧合：P17A 用它在**逐场均值**上判 A1，本 change 用它筛**单条 episode**
/// （逐 episode 是 P17A 的点名方向）。两条报告若阈值不同，「A1 的样本」在两份产物里
/// 就会指不同的东西，交叉引用立刻失效。故 `exception_thresholds_match_the_p17a_rules`
/// 守卫会**从 `tests/p17a/anomalies.rs` 的源码文本里抽出这三个常量**并逐位比对——
/// 阈值一旦在 P17A 侧改变，本 change 的守卫立刻红，逼一次**有意识**的同步。
pub const EXC_LONG_DWELL_SECONDS: f64 = 6.0;

/// 空 possession 阈值（秒）——与 P17A 的 `EMPTY_POSSESSION_SECONDS` 同值。
pub const EXC_EMPTY_POSSESSION_SECONDS: f64 = 20.0;

/// 异常类别（**筛子**，不是判定——报告不产生 pass/fail）。
///
/// 每条对应 P17A 的一条**聚合**异常规则在本层的**逐 episode 化身**（design §7 的
/// 「把 P17A 从聚合降到逐 episode」）。分类是**可重入的**：一张卡可同时落进多类，
/// 故 [`classify`] 返回**切片**而不是 `Option`——把多类压成一类会丢信息，
/// 而 L2 的按类计数会因此**少算**（本仓「假覆盖」的又一种形态）。
pub const EXCEPTION_CLASSES: &[(&str, &str)] = &[
    ("instant_contest", "同拍收束：争抢收束且 possession 时长为 0（P17A A2 的逐 episode 化身）"),
    ("empty_possession", "空 possession：时长超过阈值却几乎没有决策动作（P17A A6）"),
    ("long_dwell", "长持球：链内相邻决策动作最大间隔超阈值（P17A A1）"),
    ("shot_rebound_end", "射门被扑/中框后弹回场内收束（P17A A4 关注的过程）"),
];

/// 一张诊断卡命中的**全部**异常类别（按 [`EXCEPTION_CLASSES`] 顺序，去重且稳定）。
pub fn classify(c: &EpisodeCard) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    let duration = c.end_t.map(|e| e - c.start_t);
    if duration == Some(0.0) && c.contest_start.is_some() {
        out.push("instant_contest");
    }
    if duration.map(|d| d > EXC_EMPTY_POSSESSION_SECONDS).unwrap_or(false) && c.chain.len() <= 1 {
        out.push("empty_possession");
    }
    if max_chain_gap(&c.chain) > EXC_LONG_DWELL_SECONDS {
        out.push("long_dwell");
    }
    if c.end_reason == Some(EpisodeEndReason::ShotRebound)
        || c.contest_start == Some(ContestStartReason::ShotRebound)
    {
        out.push("shot_rebound_end");
    }
    out
}

/// 链内相邻决策动作的**最大**时间间隔（秒）。链长 < 2 时无间隔 ⇒ 0.0。
///
/// ⚠️ 这是**链内**间隔，不是「持球到出球」的绝对耗时：episode 开场到首个决策动作的
/// 那段没有前驱，不产生间隔。P17A 的 A1 同样用间隔（`action_gaps`），故二者可比。
pub fn max_chain_gap(chain: &[ChainNode]) -> f64 {
    chain
        .windows(2)
        .map(|w| w[1].t - w[0].t)
        .fold(0.0f64, f64::max)
}

/// 筛选尾部的分位（baseline 模式：每个异常类**只留尾部的这一段**）。
///
/// ## 为什么是「类内分位」而不是「命中该类就留」（实测驱动的选择）
///
/// 初版写的是「命中任一异常类就收录」。实测（300 seed / 30179 episode）：
/// `long_dwell` 一类就命中 **22111 张（73%）**——而它的阈值（相邻决策动作间隔 > 6 s）
/// 正是 P17A 的 A1 阈值，**在逐 episode 粒度上本就是常态**，不是异常。
/// 结果是 baseline 收录 23482 张、产物 73 MB，**与人眼可读背道而驰**，
/// 而「按异常筛选」的**目的**恰恰是可读。
///
/// ⇒ 改为**类内分位尾部**：每类按它自己的驱动量取 `p90`，只留 ≥ 该分位的卡。
/// 这仍在 design §5 待决策 1 的拍板范围内（拍板是「baseline 按异常筛选」），
/// 且 design 自己给的例子就是「只报链长 > **p90** 的段」。
/// 分位取自 [`crate::shape::quantile_sorted`]（P16 的 R type-7 口径，活读）。
pub const EXC_TAIL_QUANTILE: f64 = 0.90;

/// 小于该规模的异常类**整类保留**——对小类抽样既无意义，又会把稀有形态藏起来。
///
/// 反例：`instant_contest` 在 300 seed 上只命中 8 张（`interception_loose` 使然），
/// 按分位尾部会只剩不到 1 张，等于把这个**最重要的发现**从产物里删掉。
pub const EXC_TAIL_MIN_CLASS: usize = 50;

/// 某异常类的**驱动量**（分位排序的键）。越大越极端。
///
/// `None` = 该类没有连续驱动量（整类保留，见 [`EXC_TAIL_MIN_CLASS`]）。
pub fn exception_driver(class: &str, c: &EpisodeCard) -> Option<f64> {
    match class {
        "long_dwell" => Some(max_chain_gap(&c.chain)),
        "empty_possession" => c.end_t.map(|e| e - c.start_t),
        // 同拍收束：驱动量恒 0（时长都是 0），分位选不出东西 ⇒ 整类保留。
        // 射门弹回收束同理（样本极小）。
        _ => None,
    }
}

/// L1 是否收录这张卡。
///
/// - `canary`：**全覆盖**（用户拍板：canary 上逐条都有卡，便于人眼核对口径）；
/// - `baseline`：**按异常筛选**（用户拍板）——且筛选是**类内分位尾部**，
///   使产物真正可读（见 [`EXC_TAIL_QUANTILE`] 的实测依据）。
///
/// `mode` 只认这两个值；其余一律按 `baseline`（保守：宁可筛掉也不产出无法阅读的产物）。
pub fn should_keep(mode: &str, exc: &[&'static str]) -> bool {
    match mode {
        "canary" => true,
        _ => !exc.is_empty(),
    }
}
