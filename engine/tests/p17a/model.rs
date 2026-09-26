//! P17A 逐场派生与指标口径（design.md §3）。
//!
//! 本模块是**纯函数层**：输入一场比赛的公开 `DiagnosticMatch` + seed，输出 [`MatchRecord`]。
//! 不做 I/O、不写文件、不读环境——便于单测与确定性比对。
//!
//! 三条口径纪律（改动前先读 design.md §3，勿退回）：
//!
//! 1. **动作 = 决策事件**：`pass` / `shot` / `tackle` / `foul` / `kickoff`。`beat` 是每 tick 的
//!    位移节拍（carrier 带球 + movers 跑位），**不计入动作链**；它的绑定数另记，用作
//!    `event_indexes` 归属完整性的交叉检查。
//! 2. **每场先算，再跨场聚合**：分位/离散度在单场内算完，再对逐场结果取统计量；不把跨 seed 的
//!    原始观测池化后一次算分位（池化把场间差异当场内方差，会虚高 sd 并奖励压平量级的改动）。
//! 3. **缺证据不猜**：字段缺失时记 `None` / `unknown` 计数，不用默认值伪造观测。

use fm_engine::observation::*;
use fm_engine::{Event, EventType};
use std::collections::BTreeMap;

// ============================== 动作 ==============================

/// 决策动作的闭集（本引擎 v6 事件流里可出现在 possession 内的全部动作类型）。
///
/// 注意：本引擎**不产出** `dribble` / `interception` / `off_ball_run` 顶层事件——拦截编码为
/// `pass.result="intercepted"`，带球只存在于 `beat.main`。故本闭集不含它们，`action_of` 对
/// `EventType::Beat` 等返回 `None`（见模块头口径 1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ActionKind {
    Kickoff,
    PassSuccess,
    PassIntercepted,
    PassLost,
    PassOut,
    PassContested,
    PassOther,
    ShotGoal,
    ShotSaved,
    ShotOffTarget,
    ShotOther,
    Tackle,
    Foul,
}

impl ActionKind {
    /// 稳定 token（motif / 计数 / JSON 键都用它）。
    pub const fn token(self) -> &'static str {
        match self {
            ActionKind::Kickoff => "kickoff",
            ActionKind::PassSuccess => "pass+",
            ActionKind::PassIntercepted => "passI",
            ActionKind::PassLost => "passL",
            ActionKind::PassOut => "passO",
            ActionKind::PassContested => "passC",
            ActionKind::PassOther => "pass?",
            ActionKind::ShotGoal => "shotG",
            ActionKind::ShotSaved => "shotS",
            ActionKind::ShotOffTarget => "shotX",
            ActionKind::ShotOther => "shot?",
            ActionKind::Tackle => "tackle",
            ActionKind::Foul => "foul",
        }
    }

    pub const fn is_pass(self) -> bool {
        matches!(
            self,
            ActionKind::PassSuccess
                | ActionKind::PassIntercepted
                | ActionKind::PassLost
                | ActionKind::PassOut
                | ActionKind::PassContested
                | ActionKind::PassOther
        )
    }

    pub const fn is_pass_failure(self) -> bool {
        matches!(
            self,
            ActionKind::PassIntercepted | ActionKind::PassLost
        )
    }

    pub const fn is_shot(self) -> bool {
        matches!(
            self,
            ActionKind::ShotGoal
                | ActionKind::ShotSaved
                | ActionKind::ShotOffTarget
                | ActionKind::ShotOther
        )
    }

    pub const fn all() -> &'static [ActionKind] {
        &[
            ActionKind::Kickoff,
            ActionKind::PassSuccess,
            ActionKind::PassIntercepted,
            ActionKind::PassLost,
            ActionKind::PassOut,
            ActionKind::PassContested,
            ActionKind::PassOther,
            ActionKind::ShotGoal,
            ActionKind::ShotSaved,
            ActionKind::ShotOffTarget,
            ActionKind::ShotOther,
            ActionKind::Tackle,
            ActionKind::Foul,
        ]
    }
}

/// 正式事件 → 决策动作。非决策事件（`beat` / `lineup` / `whistle` / `substitution`）返回 `None`。
pub fn action_of(e: &Event) -> Option<ActionKind> {
    match e.type_ {
        EventType::Pass => Some(match e.result.as_deref().unwrap_or("") {
            "success" => ActionKind::PassSuccess,
            "intercepted" => ActionKind::PassIntercepted,
            "lost" => ActionKind::PassLost,
            "out" => ActionKind::PassOut,
            "contested" => ActionKind::PassContested,
            _ => ActionKind::PassOther,
        }),
        EventType::Shot => Some(match e.result.as_deref().unwrap_or("") {
            "goal" => ActionKind::ShotGoal,
            "saved" => ActionKind::ShotSaved,
            "off_target" => ActionKind::ShotOffTarget,
            _ => ActionKind::ShotOther,
        }),
        EventType::Tackle => Some(ActionKind::Tackle),
        EventType::Foul => Some(ActionKind::Foul),
        EventType::Kickoff => Some(ActionKind::Kickoff),
        EventType::Lineup
        | EventType::Whistle
        | EventType::Interception
        | EventType::Dribble
        | EventType::Substitution
        | EventType::OffBallRun
        | EventType::Beat => None,
    }
}

/// episode 内的一步动作，带完整回放定位（seed 由 [`MatchRecord::seed`] 提供）。
#[derive(Debug, Clone)]
pub struct Action {
    pub event_index: usize,
    pub t: f64,
    pub kind: ActionKind,
    /// 动作主体所属球队（`subject` → `TeamId::from_player`；非法 id 为 `None`，不猜）。
    pub team: Option<TeamId>,
    /// 该动作是否是定位球**交付**（`detail` ∈ free_kick / throw_in / corner / goal_kick）。
    /// 交付动作属于重开片段，不是开放比赛动作——重开口径与 motif 都要能区分它。
    pub is_delivery: bool,
    pub detail: Option<String>,
    pub x: f64,
    pub y: f64,
}

// ============================== 逐场记录 ==============================

#[derive(Debug, Clone)]
pub struct EpisodeRecord {
    pub id: u64,
    pub team: TeamId,
    pub start_t: f64,
    pub end_t: Option<f64>,
    pub duration: Option<f64>,
    pub start_reason: &'static str,
    pub end_reason: Option<&'static str>,
    /// 动作链（只含决策事件，按 `event_indexes` 顺序）。
    pub actions: Vec<Action>,
    /// 归属本 episode 的 `beat` 事件数（不入动作链，仅作归属完整性交叉检查）。
    pub beat_bindings: usize,
    /// 相邻动作的时间差（秒）。"持球-出球节奏"的直接观测。
    pub action_gaps: Vec<f64>,
    /// 射门动作在动作链中的下标（0-based）；无射门为 `None`。
    pub first_shot_index: Option<usize>,
    /// 进球是否由本 episode 产生。
    pub has_goal: bool,
}

impl EpisodeRecord {
    pub fn action_count(&self) -> usize {
        self.actions.len()
    }

    /// 开放比赛动作（排除定位球交付）。
    pub fn open_play_actions(&self) -> impl Iterator<Item = &Action> {
        self.actions.iter().filter(|a| !a.is_delivery)
    }

    pub fn pass_count(&self) -> usize {
        self.actions.iter().filter(|a| a.kind.is_pass()).count()
    }

    pub fn pass_success_count(&self) -> usize {
        self.actions
            .iter()
            .filter(|a| a.kind == ActionKind::PassSuccess)
            .count()
    }

    /// 成功传球数，**只计开放比赛**（排除定位球交付）——A9「传递深度」的口径。
    ///
    /// 为什么要排除交付（2026-09-24 审阅）：定位球交付（`is_delivery`）是重开片段的第一步，
    /// 不是开放比赛的推进。把它算进「成功传球 ≥2」会把「一次交付 + 一次开放传球」记成多脚传递
    /// ——300 场实测有 2063 个 episode 属于这种口径差异（A9 占比 65.7% → 57.9%）。
    /// 守卫见 `multi_pass_share_counts_open_play_passes_only`。
    pub fn open_play_pass_success_count(&self) -> usize {
        self.open_play_actions()
            .filter(|a| a.kind == ActionKind::PassSuccess)
            .count()
    }

    pub fn has_failed_pass(&self) -> bool {
        self.actions.iter().any(|a| a.kind.is_pass_failure())
    }

    pub fn tokens(&self) -> Vec<&'static str> {
        self.actions.iter().map(|a| a.kind.token()).collect()
    }
}

impl Action {
    // 供 motif / 异常规则使用：交付动作也算 pass，但调用方须显式决定是否排除。
    pub fn is_delivery_pass(&self) -> bool {
        self.is_delivery && self.kind.is_pass()
    }
}

/// 一次争抢（`contest_started` → 紧邻的 `contest_ended`）。
///
/// `losing_team` = `contest_started.team`，按 `ControlFact.team` 的 kind 相关语义，它是
/// **失去控制的一方**；`pickup_team` = 争抢结束后下一条 `control_established` 的球队。
/// 故 `regained_by_loser == true` 表示**丢球方夺回**（真实足球里的二点球回收）。
#[derive(Debug, Clone)]
pub struct ContestRecord {
    pub start_t: f64,
    pub end_t: Option<f64>,
    pub duration: Option<f64>,
    pub reason: &'static str,
    pub end_reason: Option<&'static str>,
    pub losing_team: Option<TeamId>,
    pub pickup_team: Option<TeamId>,
    pub regained_by_loser: Option<bool>,
    pub location: Option<(f64, f64)>,
    pub source_event_index: Option<usize>,
    /// 争抢结束后开启的新 episode 下标（`MatchRecord::episodes` 内）。
    pub next_episode: Option<usize>,
}

#[derive(Debug, Clone)]
pub struct RestartRecord {
    pub id: u64,
    pub kind: &'static str,
    pub team: &'static str,
    pub start_t: f64,
    /// 死球确认 → 发出（准备期时长）。
    pub prep_duration: Option<f64>,
    /// 发出 → 恢复开放比赛（交付飞行时长）。
    pub flight_duration: Option<f64>,
    pub end_reason: Option<&'static str>,
    pub taken_t: Option<f64>,
    /// 重开后**首个** episode 的下标（`start_t >= taken_t` 的最早 episode）。
    pub first_episode: Option<usize>,
    /// 发出 → 首次明确控制（秒）。
    pub first_control_delay: Option<f64>,
    /// 归属本重开片段的正式事件下标（来自 `RestartSequence::event_indexes`）。
    /// 异常回放定位要用它——restart 自身的下标是「回到事件流 / viewer」的唯一入口。
    pub event_indexes: Vec<usize>,
}

#[derive(Debug, Clone)]
pub struct MatchRecord {
    pub seed: u64,
    pub events_len: usize,
    pub facts_len: usize,
    pub gap_count: usize,
    pub invariant_violations: usize,
    pub episodes: Vec<EpisodeRecord>,
    pub contests: Vec<ContestRecord>,
    pub restarts: Vec<RestartRecord>,
    /// 每场动作计数（用于分母与防空转下限）。
    pub action_counts: BTreeMap<&'static str, usize>,
    pub event_type_counts: BTreeMap<&'static str, usize>,
    pub fact_kind_counts: BTreeMap<String, usize>,
    pub restart_kind_counts: BTreeMap<&'static str, usize>,
    pub episode_end_reason_counts: BTreeMap<&'static str, usize>,
    pub episode_start_reason_counts: BTreeMap<&'static str, usize>,
    /// 比赛结束时比分（whistle 的 `score`），缺证据为 `None`。
    pub final_score: Option<(u32, u32)>,
}

fn team_of(e: &Event) -> Option<TeamId> {
    TeamId::from_player(e.subject)
}

fn is_delivery_detail(detail: Option<&str>) -> bool {
    matches!(
        detail,
        Some("free_kick") | Some("throw_in") | Some("corner") | Some("goal_kick")
    )
}

fn score_of(e: &Event) -> Option<(u32, u32)> {
    let s = e.score.as_deref()?;
    let (h, a) = s.split_once('-')?;
    Some((h.trim().parse().ok()?, a.trim().parse().ok()?))
}

/// 逐场派生（纯函数）。
pub fn derive_match(seed: u64, dm: &DiagnosticMatch) -> MatchRecord {
    let mut event_type_counts: BTreeMap<&'static str, usize> = BTreeMap::new();
    for e in &dm.events {
        *event_type_counts.entry(e.type_.as_str()).or_insert(0) += 1;
    }

    let mut action_counts: BTreeMap<&'static str, usize> = BTreeMap::new();
    for e in &dm.events {
        if let Some(k) = action_of(e) {
            *action_counts.entry(k.token()).or_insert(0) += 1;
        }
    }

    let mut fact_kind_counts: BTreeMap<String, usize> = BTreeMap::new();
    for f in &dm.control_facts {
        let key = format!(
            "{}/{}",
            f.kind.as_str(),
            f.detail.map(|d| d.as_str()).unwrap_or("-")
        );
        *fact_kind_counts.entry(key).or_insert(0) += 1;
    }

    // ---- episodes ----
    let mut episodes: Vec<EpisodeRecord> = Vec::with_capacity(dm.possession_episodes.len());
    for ep in &dm.possession_episodes {
        let mut actions = Vec::new();
        let mut beat_bindings = 0usize;
        for &i in &ep.event_indexes {
            let Some(e) = dm.events.get(i) else { continue };
            match action_of(e) {
                Some(kind) => actions.push(Action {
                    event_index: i,
                    t: e.t,
                    kind,
                    team: team_of(e),
                    is_delivery: is_delivery_detail(e.detail.as_deref()),
                    detail: e.detail.clone(),
                    x: e.x,
                    y: e.y,
                }),
                None => {
                    if e.type_ == EventType::Beat {
                        beat_bindings += 1;
                    }
                }
            }
        }
        let mut action_gaps = Vec::new();
        for w in actions.windows(2) {
            action_gaps.push(w[1].t - w[0].t);
        }
        let first_shot_index = actions.iter().position(|a| a.kind.is_shot());
        let has_goal = actions.iter().any(|a| a.kind == ActionKind::ShotGoal);
        let duration = ep.end_t.map(|t| t.value - ep.start_t.value);
        episodes.push(EpisodeRecord {
            id: ep.id,
            team: ep.team,
            start_t: ep.start_t.value,
            end_t: ep.end_t.map(|t| t.value),
            duration,
            start_reason: ep.start_reason.as_str(),
            end_reason: ep.end_reason.map(|r| r.as_str()),
            actions,
            beat_bindings,
            action_gaps,
            first_shot_index,
            has_goal,
        });
    }

    let mut episode_end_reason_counts: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut episode_start_reason_counts: BTreeMap<&'static str, usize> = BTreeMap::new();
    for ep in &episodes {
        // 闭集 0 计数也要显式出现（防空转：某成员消失时报告必须显示 0，不能省略整行）。
        *episode_start_reason_counts
            .entry(ep.start_reason)
            .or_insert(0) += 1;
        if let Some(r) = ep.end_reason {
            *episode_end_reason_counts.entry(r).or_insert(0) += 1;
        }
    }
    for r in EpisodeStartReason::ALL {
        episode_start_reason_counts.entry(r.as_str()).or_insert(0);
    }
    for r in EpisodeEndReason::ALL {
        episode_end_reason_counts.entry(r.as_str()).or_insert(0);
    }

    // ---- contests：把 contest_started 与**紧邻的** contest_ended 配对 ----
    //
    // 取紧邻而非"下一条 contest_ended"：`contest_started` 本身被不变量约束为不能在争抢中重入
    // （`ContestStartedWhileContested`），故紧邻就是它自己的收束；向前搜会读到别人的收束。
    let mut contests = Vec::new();
    for (i, f) in dm.control_facts.iter().enumerate() {
        if f.kind != ControlFactKind::ContestStarted {
            continue;
        }
        let mut end_t = None;
        let mut end_reason = None;
        if let Some(n) = dm.control_facts.get(i + 1) {
            if n.kind == ControlFactKind::ContestEnded {
                end_t = Some(n.t.value);
                end_reason = match n.detail {
                    Some(ControlFactDetail::ContestEnd(reason)) => Some(reason.as_str()),
                    _ => None,
                };
            }
        }
        // pickup 队伍：争抢收束后的下一条 `control_established`，但**只在本次结算的窗口内**找。
        //
        // 为什么必须设边界：`obs_contest_pickup` 是在 `contest_ended` **紧邻**提交
        // `control_established` 的，所以正常的拾回就在下一条；而无界向前搜会在「争抢以死球/哨声
        // 收束」时读到**很久之后**另一次进攻的 control_established，把无关球队记成本次拾回方
        // （与 `duration` 那条同理：向前搜会读到别人的收束）。边界取「下一个会改变比赛状态的
        // 事实」——另一次争抢、死球、重开准备或终场，任一出现即停止（此时拾回方为 None，不猜）。
        let pickup_team = dm
            .control_facts
            .iter()
            .skip(i + 1)
            .take_while(|n| {
                !matches!(
                    n.kind,
                    ControlFactKind::ContestStarted
                        | ControlFactKind::DeadBallStarted
                        | ControlFactKind::RestartPreparationStarted
                        | ControlFactKind::MatchEnded
                )
            })
            .find(|n| n.kind == ControlFactKind::ControlEstablished)
            .and_then(|n| n.team);
        let losing_team = f.team;
        let next_episode = end_t.and_then(|t| {
            episodes
                .iter()
                .enumerate()
                .filter(|(_, ep)| ep.start_t + 1e-9 >= t)
                .min_by(|a, b| a.1.start_t.partial_cmp(&b.1.start_t).unwrap())
                .map(|(idx, _)| idx)
        });
        contests.push(ContestRecord {
            start_t: f.t.value,
            end_t,
            duration: end_t.map(|t| t - f.t.value),
            reason: match f.detail {
                Some(ControlFactDetail::ContestStart(r)) => r.as_str(),
                _ => "unknown",
            },
            end_reason,
            losing_team,
            pickup_team,
            regained_by_loser: match (losing_team, pickup_team) {
                (Some(l), Some(p)) => Some(l == p),
                _ => None,
            },
            location: f.location,
            source_event_index: f.source_event_index,
            next_episode,
        });
    }

    // ---- restarts ----
    let mut restart_kind_counts: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut restarts = Vec::new();
    for r in &dm.restart_sequences {
        *restart_kind_counts.entry(r.kind.as_str()).or_insert(0) += 1;
        let taken_t = r.taken_t.map(|t| t.value);
        let first_episode = taken_t.and_then(|t| {
            episodes
                .iter()
                .enumerate()
                .filter(|(_, ep)| ep.start_t + 1e-9 >= t)
                .min_by(|a, b| a.1.start_t.partial_cmp(&b.1.start_t).unwrap())
                .map(|(idx, _)| idx)
        });
        restarts.push(RestartRecord {
            id: r.id,
            kind: r.kind.as_str(),
            team: r.team.as_str(),
            start_t: r.start_t.value,
            prep_duration: r.taken_t.map(|t| t.value - r.start_t.value),
            flight_duration: match (r.taken_t, r.open_play_resumed_t) {
                (Some(a), Some(b)) => Some(b.value - a.value),
                _ => None,
            },
            end_reason: r.end_reason.map(|e| e.as_str()),
            taken_t,
            first_episode,
            first_control_delay: match (taken_t, first_episode) {
                (Some(t), Some(i)) => Some(episodes[i].start_t - t),
                _ => None,
            },
            event_indexes: r.event_indexes.clone(),
        });
    }

    let final_score = dm.events.iter().rev().find_map(score_of);

    MatchRecord {
        seed,
        events_len: dm.events.len(),
        facts_len: dm.control_facts.len(),
        gap_count: dm.gap_count(),
        invariant_violations: dm.invariant_violations.len(),
        episodes,
        contests,
        restarts,
        action_counts,
        event_type_counts,
        fact_kind_counts,
        restart_kind_counts,
        episode_end_reason_counts,
        episode_start_reason_counts,
        final_score,
    }
}

// ============================== 聚合（每场先算，再跨场） ==============================

/// 单场内一个标量的跨场聚合结果。
///
/// `mean_of_means` = 逐场均值再跨场平均；`p50_of_p50` / `p90_of_p90` = 逐场分位再跨场平均；
/// `cross_match_mean_sd` = 逐场均值之间的样本 sd（1 场时为 0）。语义上这是"场间差异"，
/// 与"场内方差"不是一回事——不要把两者合并成一个口径报告。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Stat {
    pub matches: usize,
    pub observations: usize,
    pub mean_of_means: f64,
    pub p50_of_p50: f64,
    pub p90_of_p90: f64,
    pub max_of_max: f64,
    pub cross_match_mean_sd: f64,
}

impl Stat {
    /// `per_match`：每个元素是**一场比赛内**的观测序列。空场次被跳过（计入 `matches` 只算有观测的场）。
    pub fn from_observations(per_match: &[Vec<f64>]) -> Stat {
        Self::from_observations_filtered(per_match, |v| v.to_vec())
    }

    /// 同上，但允许先对场内观测做一次映射（例如"先取每场最大，再跨场平均"）。
    pub fn from_observations_filtered<F: Fn(&[f64]) -> Vec<f64>>(
        per_match: &[Vec<f64>],
        project: F,
    ) -> Stat {
        let mut means = Vec::new();
        let mut p50s = Vec::new();
        let mut p90s = Vec::new();
        let mut maxs = Vec::new();
        let mut observations = 0usize;
        for raw in per_match {
            let vals = project(raw);
            if vals.is_empty() {
                continue;
            }
            observations += vals.len();
            let mut s = vals;
            s.sort_by(|a, b| a.partial_cmp(b).unwrap());
            means.push(mean(&s));
            p50s.push(quantile(&s, 0.5));
            p90s.push(quantile(&s, 0.9));
            maxs.push(*s.last().unwrap());
        }
        Stat {
            matches: means.len(),
            observations,
            mean_of_means: mean(&means),
            p50_of_p50: mean(&p50s),
            p90_of_p90: mean(&p90s),
            // 空输入必须给有限值：`fold(NEG_INFINITY, f64::max)` 在无观测时返回 -inf，
            // 序列化后是 `null`，会让下游把"没有观测"读成"观测到无穷大"。
            max_of_max: if maxs.is_empty() {
                0.0
            } else {
                maxs.iter().cloned().fold(f64::NEG_INFINITY, f64::max)
            },
            cross_match_mean_sd: sd(&means),
        }
    }

    /// 从"每场一个标量"的序列聚合（例如 episodes/场）。
    pub fn from_per_match_values(values: &[f64]) -> Stat {
        let per_match: Vec<Vec<f64>> = values.iter().map(|v| vec![*v]).collect();
        Self::from_observations(&per_match)
    }
}

pub fn mean(v: &[f64]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.iter().sum::<f64>() / v.len() as f64
}

/// R type-7 线性插值分位（与 numpy 默认一致），输入须已升序。
pub fn quantile(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    if sorted.len() == 1 {
        return sorted[0];
    }
    let pos = q * (sorted.len() - 1) as f64;
    let lo = pos.floor() as usize;
    let hi = pos.ceil() as usize;
    if lo == hi {
        return sorted[lo];
    }
    let frac = pos - lo as f64;
    sorted[lo] * (1.0 - frac) + sorted[hi] * frac
}

pub fn sd(v: &[f64]) -> f64 {
    if v.len() < 2 {
        return 0.0;
    }
    let m = mean(v);
    let var = v.iter().map(|x| (x - m) * (x - m)).sum::<f64>() / (v.len() - 1) as f64;
    var.sqrt()
}

/// 计数型聚合：逐场求和后归一（design §3.1 的例外说明——计数比例按此口径）。
pub fn share_of(count: usize, total: usize) -> f64 {
    if total == 0 {
        0.0
    } else {
        count as f64 / total as f64
    }
}


// ============================== sidecar schema 指纹 ==============================

/// sidecar schema 指纹：对 observation 模块全部闭集枚举的 `ALL` 成员串名做顺序敏感哈希，
/// 并附成员数。闭集变化（新增/删除/重命名成员）必然改变指纹，使"两次结果不可比"在产物层可察觉。
///
/// 包含：fact/contest/restart/episode/phase 等所有 `ALL` 闭集。**不含** `BehaviorControlState`
/// （它没有 `ALL`），故另记 `state_variants` 供人工核对。
pub fn sidecar_schema_fingerprint() -> (String, Vec<(&'static str, usize)>) {
    let mut parts: Vec<String> = Vec::new();
    let mut sizes: Vec<(&'static str, usize)> = Vec::new();
    macro_rules! add {
        ($name:expr, $all:expr) => {{
            let items = $all;
            sizes.push(($name, items.len()));
            let mut line = String::from($name);
            for x in items {
                line.push('|');
                line.push_str(x.as_str());
            }
            parts.push(line);
        }};
    }
    add!("TeamId", TeamId::ALL);
    add!("TeamRef", TeamRef::ALL);
    add!("TimeBasis", TimeBasis::ALL);
    add!("ControlFactKind", ControlFactKind::ALL);
    add!("ControlFactBasis", ControlFactBasis::ALL);
    add!("ObservationGapReason", ObservationGapReason::ALL);
    add!("IllegalInput", IllegalInput::ALL);
    add!("RestartKind", RestartKind::ALL);
    add!("DeadBallReason", DeadBallReason::ALL);
    add!("FlightAction", FlightAction::ALL);
    add!("RestartEndReason", RestartEndReason::ALL);
    add!("EpisodeStartReason", EpisodeStartReason::ALL);
    add!("EpisodeEndReason", EpisodeEndReason::ALL);
    add!("ContestStartReason", ContestStartReason::ALL);
    add!("ContestEndReason", ContestEndReason::ALL);
    add!("Phase", Phase::ALL);
    add!("PhaseProvenance", PhaseProvenance::ALL);
    parts.sort();
    let joined = parts.join("\n");
    (format!("fnv1a64:{:016x}", fnv1a(&joined)), sizes)
}

/// FNV-1a 64 位（与 `tests/realism.rs` / `tests/p15_behavior_observation.rs` 同算法）。
pub fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}
