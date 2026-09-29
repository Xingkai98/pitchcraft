//! P16 Slice 1：**位置口径**（本 change 的第一交付，先于任何数字）。
//!
//! ## 为什么口径要先定
//!
//! 2026-09-29 侦察（`.scratch/notes/116-spatial-recon-2026-09-29.md`）实测：同一批 episode，
//! 「从哪开始」用不同层的量算，给出的「后场起点占比」差 3 倍。本模块把口径**收敛成唯一入口**，
//! 使下游特征在结构上不可能各取各的口径。
//!
//! ## 口径（三条，全部是本 change 的规范）
//!
//! 1. **位置一律取自观测层事实**（[`ControlFact::location`]）——它是 #15A 观测层对
//!    「episode 在哪开始/结束」的定义。
//!    **不得**以决策动作的 [`fm_engine::Event::x`] 代替：它是**动作主体的位置**，
//!    对 `tackle` 甚至是防守者的位置，只有在主体恰为持球者时才等于球位。
//!    实测机制：episode 开场通常是带球（`beat.main`），首个决策动作晚**中位 8 秒**
//!    （p10 −2s / p90 16s，n=9292，100 seed）——届时球已离开后场。
//! 2. **起止同源**：起点取该 episode 的**首条** `control_established` 事实；
//!    终点取**同一条事实族**在 episode 窗内、下标严格晚于起点事实的**最后一条**带位置事实。
//!    两处都读 [`ControlFact::location`]，不一处用事实、一处用动作位置。
//! 3. **缺失不猜**：收束侧位置不可得 → 该 episode 的**终点位置口径不可用**
//!    （`None`），由下游计入 `unknown`，不退回起点、不取动作位置、不插值。
//!    **也不跨 episode 边界读**（下界 = 本 episode 首条事实下标）——那会把下一个
//!    episode 的起点当成这一个的终点。
//!
//! ## 已记录的放大器（不是缺陷）
//!
//! `goal_kick_land`（`engine/src/lib.rs` 的 `fn goal_kick_land`）逐字把门球落点钳在
//! `dir > 0 ? [0.50, 0.82] : [0.18, 0.50]`——**恒过半场**。门球占全部重开 **31.7%**
//! （本模块的 100 seed 复现：1666 / 5258）。门球本就该开到中场，故不是缺陷；但它是
//! 「用首个决策动作当位置」时把**货真价实的后场开局**（门将持球）记成中场开局的主要来源。
//! 守护见 [`goal_kick_amplifier_matches_the_pinned_share`]。
//!
//! ## 时间基准（design §2.3）
//!
//! sidecar 有四种 [`TimeBasis`]。**同一特征只混用同 basis 的字段**；本模块只读
//! `ControlFact.location`（与 basis 无关的位置字段），但**把起点事实的 basis 记下来**
//! 供下游特征核对（见 [`EpisodeCaliber::start_basis`]）。
//!
//! ## 定向变异证据（2026-09-29 实跑，本 change 的门槛要求）
//!
//! 本仓的教训是「守卫可能是恒真断言」。口径的三条规则各有定向变异，**实跑均红**：
//!
//! | 变异 | 改法 | 抓它的测试 |
//! |---|---|---|
//! | 起点改用被禁口径 | `caliber_of` 的起点取 `episode.event_indexes` 里首个 `pass` 的 `Event.x` | `caliber_start_comes_from_control_fact_not_action_position` + `caliber_guard_has_discriminating_power` + `caliber_coverage_on_a_real_seed` |
//! | 回退分支去掉时间上界 | `closing_fact` 的回退分支删 `f.t.value < end_t - eps` | `caliber_never_reads_across_episode_boundaries` |
//! | 同刻取「最后一条」 | `find(..)` 换成 `filter(..).last()` | `caliber_closing_fact_tie_break_names_the_episode_closing_fact` |
//!
//! ⚠️ 第三条**只有**审计栏断言能抓（两种取法的位置值实测 10102 条里 0 条分歧）——
//! 这正说明「断言输入须对目标变异有区分度」不只是位置断言的事。

use fm_engine::observation::*;
use std::collections::BTreeMap;

/// 口径的版本号。**判据变化必须递增**——产物 provenance 记它，
/// 使「口径不同的两次运行」在产物层可区分（spec「口径写进产物」）。
pub const CALIBER_VERSION: &str = "p16-caliber-v1";

// ============================== 进攻方向 ==============================

/// 归一化方向：`+1` = 主队进攻方向（x 增大），`-1` = 客队。
///
/// 引擎固定主队攻 x=1、客队攻 x=0（`formation_target` 的 `attack_dir` 同此约定）。
pub const fn attack_dir(team: TeamId) -> f64 {
    match team {
        TeamId::Home => 1.0,
        TeamId::Away => -1.0,
    }
}

/// **球门向推进度**：`0` = 本方球门线，`1` = 对方球门线。
///
/// 这是全仓唯一的「方向归一」入口——所有跨队可比的位置统计必须过它，
/// 否则主客两侧的 `x` 语义相反（客队攻 x=0），池化会得到恒等于 0.5 的无意义均值。
pub fn progress(x: f64, team: TeamId) -> f64 {
    match team {
        TeamId::Home => x,
        TeamId::Away => 1.0 - x,
    }
}

/// `progress` 的三分带。**只用于报告分桶，不是战术阶段**——
/// 契约明禁把球场区域等同为 `build_up`/`progression`/`final_third`
/// （`map.md` 行为真实性方向的 grilling 契约；见本 change 的 phaseability gate）。
pub fn progress_band(p: f64) -> &'static str {
    if p < 1.0 / 3.0 {
        "back"
    } else if p < 2.0 / 3.0 {
        "mid"
    } else {
        "front"
    }
}

// ============================== 逐 episode 的位置口径 ==============================

/// 一个 episode 的**权威位置口径**产物。
///
/// 全部字段来自 [`ControlFact`]，没有一项取自决策动作的 `Event` 位置。
#[derive(Debug, Clone, PartialEq)]
pub struct EpisodeCaliber {
    pub episode_id: u64,
    pub team: TeamId,
    /// 起点（归一化原始坐标）。
    pub start: (f64, f64),
    /// 起点在进攻方向上的推进度（`progress(start.0, team)`）。
    pub start_progress: f64,
    /// 起点事实的 [`TimeBasis`]——下游特征据此核对「同一特征不混 basis」。
    pub start_basis: TimeBasis,
    /// 起点事实的 [`ControlFactBasis`]（`engine_state` / `finalized_outcome` / …）。
    pub start_fact_basis: ControlFactBasis,
    /// episode 起点原因（`restart_control` / `pickup` / …）——供按来源分解覆盖率。
    pub start_reason: EpisodeStartReason,
    /// 终点：收束侧事实的位置，**与起点同源**。不可得时为 `None`（**不退回起点**）。
    pub end: Option<(f64, f64)>,
    /// 终点在进攻方向上的推进度；`end` 为 `None` 时同为 `None`。
    pub end_progress: Option<f64>,
    /// 供出终点的**事实类型**。审计用：让 reviewer 不必读源码就能核对
    /// 「终点到底取的是哪一类事实」。
    pub end_fact_kind: Option<ControlFactKind>,
    /// 供出终点的事实相对 `end_t` 是否**同刻**（= 收束侧事实）。
    /// `false` 表示取的是窗内较早的一条（episode 以死球/哨声收束时没有位置的收束事实）。
    pub end_fact_at_close: bool,
    /// 本 episode 的 `end_t` 是否可得（开放 episode / 流截断时 `None`）。
    pub has_end_t: bool,
}

impl EpisodeCaliber {
    /// **净推进**（球门向，含回撤为负）。终点口径不可用时为 `None`——不猜。
    pub fn net_progress(&self) -> Option<f64> {
        self.end_progress.map(|e| e - self.start_progress)
    }

    /// 起点→终点的**位移极差**（方向归一，绝对值）。
    pub fn progress_span(&self) -> Option<f64> {
        self.net_progress().map(f64::abs)
    }
}

/// **终点的取法**（唯一实现，见模块头口径 2/3）。
///
/// 规则（两段，2026-09-29 实测选定）：
///
/// 1. **收束侧事实**：`t == end_t` 且带 `location` 的**最早**一条——`end_at_close = true`。
/// 2. **回退**：`end_t` 上没有带位置的事实（死球 / 哨声收束：`dead_ball_started` 与
///    `match_ended` **不带 `location`**）时，取窗内（`start_t ≤ t < end_t`、下标严格晚于
///    起点事实）**最后一条**带位置的事实——`end_at_close = false`。
///
/// ## 为什么是「最早」而不是「最后」（实测依据，100 seed / 10102 episodes）
///
/// 「`t == end_t` 的最后一条」这一朴素写法会**选到下一个 episode 的开启事实**：
/// 争抢收束路径下 `contest_started`（本 episode 的收束）与随后 `advance_loose` 的
/// `control_established`（下一个 episode 的开启）**同刻**，`last()` 取到后者——
/// 实测 **2578 / 10102（25.5%）** 选中「他队的 `control_established`」。取**最早**一条后
/// 降到 **172 / 10102（1.7%）**（那 1.7% 是跨队易主的同刻交接，`control_established` 同时
/// 是这一条 episode 的收束事实**与**下一条的开启事实——**本就是收束侧**，见
/// `observation.rs` 的 `control_established`：同 `t` 里先 `close_episode` 再
/// `open_new_episode`）。
///
/// **两种取法的位置值实测完全一致**（10102 条里 0 条分歧）——差异只在**审计栏**
/// （`end_fact_kind` 报的是什么）。故这条选择是为了让「终点到底取的哪类事实」这句话
/// 说得准，不是为了让数字好看。
///
/// ⚠️ 为什么**不**把搜索限制在 `episode.control_fact_indexes` 里：收束侧事实往往**不属于**
/// 该 vector（跨队易主的 `control_established` 只记进新 episode），限制在那里会丢掉
/// `saved_caught` 一类的收束侧事实（实测丢 24/172）。
///
/// ⚠️ 为什么**不**用「下一个 episode 的首条事实下标」当上界：同刻交接时那条事实**就是**
/// 本 episode 的收束事实（同一个下标），设界会把它排除。
///
/// `end_t` 不可得（开放 episode / 流截断）时返回 `None`——**不猜**，不用最后一条事实顶替。
fn closing_fact<'a>(
    dm: &'a DiagnosticMatch,
    ep: &PossessionEpisode,
) -> Option<(&'a ControlFact, bool)> {
    let first = *ep.control_fact_indexes.first()?;
    let start_t = ep.start_t.value;
    let end_t = ep.end_t?.value;
    let eps = 1e-9;
    dm.control_facts
        .iter()
        .find(|f| (f.t.value - end_t).abs() < eps && f.location.is_some())
        .or_else(|| {
            dm.control_facts
                .iter()
                .enumerate()
                .filter(|(i, f)| {
                    *i > first
                        && f.t.value >= start_t - eps
                        && f.t.value < end_t - eps
                        && f.location.is_some()
                })
                .last()
                .map(|(_, f)| f)
        })
        .map(|f| (f, (f.t.value - end_t).abs() < eps))
}

/// 从一个已闭合/开放的 episode 导出**权威位置口径**。
///
/// 起点事实缺失（`control_fact_indexes` 为空或越界、或首条无 `location`）时返回 `None`：
/// 那说明输入不是本观察层产出的 episode，**不猜**。
pub fn caliber_of(dm: &DiagnosticMatch, ep: &PossessionEpisode) -> Option<EpisodeCaliber> {
    let first = ep
        .control_fact_indexes
        .first()
        .copied()
        .and_then(|i| dm.control_facts.get(i))?;
    let start = first.location?;
    let (end, end_fact_kind, end_fact_at_close) = match closing_fact(dm, ep) {
        Some((f, at_close)) => {
            // `filter(|f| f.location.is_some())` 已保证 Some；`unwrap_or` 只为免 panic 路径。
            (f.location, Some(f.kind), at_close)
        }
        None => (None, None, false),
    };
    Some(EpisodeCaliber {
        episode_id: ep.id,
        team: ep.team,
        start,
        start_progress: progress(start.0, ep.team),
        start_basis: first.t.basis,
        start_fact_basis: first.basis,
        start_reason: ep.start_reason,
        end,
        end_progress: end.map(|p| progress(p.0, ep.team)),
        end_fact_kind,
        end_fact_at_close,
        has_end_t: ep.end_t.is_some(),
    })
}

/// 全量导出（逐场，纯函数）。
pub fn calibers_of(dm: &DiagnosticMatch) -> Vec<EpisodeCaliber> {
    dm.possession_episodes
        .iter()
        .filter_map(|ep| caliber_of(dm, ep))
        .collect()
}

// ============================== 对照口径（**只用于守卫与对照报告**） ==============================

/// **被禁的口径**：episode 内首个决策动作的 `Event.x`，方向归一后。
///
/// 它只存在于本模块的**对照**位置，有两个合法用途：
/// 1. 守卫 [`crate::caliber_guard_has_discriminating_power`] 用它构造变异，证明门会红；
/// 2. 报告里并列展示两口径的差（让读者看到偏差量级）。
///
/// **任何特征都不得读它。** 生产代码读它 = 把动作主体的位置当球位。
pub fn forbidden_first_action_progress(dm: &DiagnosticMatch, ep: &PossessionEpisode) -> Option<f64> {
    ep.event_indexes
        .iter()
        .filter_map(|i| dm.events.get(*i))
        .find(|e| {
            matches!(
                e.type_,
                fm_engine::EventType::Pass
                    | fm_engine::EventType::Shot
                    | fm_engine::EventType::Tackle
                    | fm_engine::EventType::Foul
                    | fm_engine::EventType::Kickoff
            )
        })
        .map(|e| progress(e.x, ep.team))
}

// ============================== 派生统计（供覆盖率报告） ==============================

/// 口径覆盖率与偏差对照（逐场算，报告在跨场层聚合）。
#[derive(Debug, Clone, Default)]
pub struct CaliberCoverage {
    pub episodes: usize,
    /// 起点位置可得（应恒 = `episodes`；不为恒等说明输入形状变了）。
    pub start_available: usize,
    /// 终点位置可得（**同源收束侧事实**）。
    pub end_available: usize,
    /// 终点事实与 `end_t` 同刻（真正的「收束侧事实」；否则是窗内较早的一条）。
    pub end_at_close: usize,
    /// 两口径落在**不同推进带**的 episode 数（对照报告用）。
    pub band_disagreement: usize,
    /// 两口径都可算的 episode 数（分歧率的分母，**不拿不可算的顶数**）。
    pub band_comparable: usize,
    /// 起点推进带 → 条数。
    pub start_bands: BTreeMap<&'static str, usize>,
    /// 终点推进带 → 条数。
    pub end_bands: BTreeMap<&'static str, usize>,
    /// 收束侧事实类型 → 条数（审计终点到底取的哪类事实）。
    pub end_fact_kinds: BTreeMap<&'static str, usize>,
    /// 终点不可得的 episode 按 `end_reason` 分解（缺失原因分类）。
    pub end_missing_by_reason: BTreeMap<&'static str, usize>,
    /// 起点事实 `TimeBasis` → 条数（下游特征核对 basis 纪律用）。
    pub start_bases: BTreeMap<&'static str, usize>,
}

impl CaliberCoverage {
    /// 累积一场的覆盖统计。
    pub fn observe_match(&mut self, dm: &DiagnosticMatch) {
        for ep in &dm.possession_episodes {
            self.episodes += 1;
            let Some(c) = caliber_of(dm, ep) else {
                continue;
            };
            self.start_available += 1;
            *self
                .start_bands
                .entry(progress_band(c.start_progress))
                .or_insert(0) += 1;
            *self
                .start_bases
                .entry(c.start_basis.as_str())
                .or_insert(0) += 1;

            match c.end_progress {
                Some(p) => {
                    self.end_available += 1;
                    if c.end_fact_at_close {
                        self.end_at_close += 1;
                    }
                    *self.end_bands.entry(progress_band(p)).or_insert(0) += 1;
                    if let Some(k) = c.end_fact_kind {
                        *self.end_fact_kinds.entry(k.as_str()).or_insert(0) += 1;
                    }
                }
                None => {
                    let reason = ep.end_reason.map(|r| r.as_str()).unwrap_or("<open>");
                    *self.end_missing_by_reason.entry(reason).or_insert(0) += 1;
                }
            }

            if let Some(other) = forbidden_first_action_progress(dm, ep) {
                self.band_comparable += 1;
                if progress_band(other) != progress_band(c.start_progress) {
                    self.band_disagreement += 1;
                }
            }
        }
    }

    /// 跨场合并（计数型：直接相加——计数比例按逐场分母合并，不做「先算比例再平均」）。
    pub fn merge(&mut self, other: &CaliberCoverage) {
        self.episodes += other.episodes;
        self.start_available += other.start_available;
        self.end_available += other.end_available;
        self.end_at_close += other.end_at_close;
        self.band_disagreement += other.band_disagreement;
        self.band_comparable += other.band_comparable;
        for (k, v) in &other.start_bands {
            *self.start_bands.entry(*k).or_insert(0) += v;
        }
        for (k, v) in &other.end_bands {
            *self.end_bands.entry(*k).or_insert(0) += v;
        }
        for (k, v) in &other.end_fact_kinds {
            *self.end_fact_kinds.entry(*k).or_insert(0) += v;
        }
        for (k, v) in &other.end_missing_by_reason {
            *self.end_missing_by_reason.entry(*k).or_insert(0) += v;
        }
        for (k, v) in &other.start_bases {
            *self.start_bases.entry(*k).or_insert(0) += v;
        }
    }
}

/// 某一进档占全部起点的比例（0 分母时 `None`——**不用 0.0 伪造观测**）。
pub fn band_share(bands: &BTreeMap<&'static str, usize>, band: &str, total: usize) -> Option<f64> {
    if total == 0 {
        return None;
    }
    Some(*bands.get(band).unwrap_or(&0) as f64 / total as f64)
}

// ============================== 门球放大器（记录在案） ==============================

/// 门球在全部重开中的占比（**2026-09-29 实测值，100 seed × 90 分钟**）。
///
/// 冻结为常量而非每次重算：它是**记录在案的偏差量级**（design §2.2 要求记录），
/// 不是判据。守护 [`crate::goal_kick_amplifier_matches_the_pinned_share`] 会在引擎改变
/// 重开分布时变红——那时须复核这条放大器还成不成立，并更新本常量与文档。
pub const GOAL_KICK_RESTART_SHARE: f64 = 0.317;

/// `goal_kick_land` 的落点区间（方向归一后，`0` = 本方球门线、`1` = 对方球门线）。
///
/// 对应源码 `fn goal_kick_land` 的 `let (lo, hi) = if dir > 0.0 { (0.50, 0.82) } else { (0.18, 0.50) };`
/// ——**恒过中线**。写成常量是为了让「用时序上的第一个动作当位置会把门球开局记成中场开局」
/// 这条机制在测试里可核对，而不必去读一行源码。
pub const GOAL_KICK_LAND_PROGRESS: (f64, f64) = (0.50, 0.82);

/// 观测到的门球交付落点（方向归一后的推进度）。
///
/// ⚠️ **不能靠 `Event.detail == "goal_kick"` 找**：实测 `pass.detail` 的取值集合是
/// `{None, clearance, corner, free_kick, out_goal_line, out_sideline, throw_in}`——
/// **没有 `goal_kick`**。门球交付是一条**普通 `pass`**，只能经
/// [`RestartSequence`] 的 `kind == goal_kick` 定位：取该 sequence `taken_t` 之后的第一条
/// 非 `beat` 事件（实测 326/326 都是 `pass`）。落点取该事件的 `x2`（`pass` 的落点）。
///
/// 方向：交付方 = `Event.subject` 所在队（门球恒由门将开出，id 0 = 主队 / 21 = 客队）。
pub fn observe_goal_kick_lands(dm: &DiagnosticMatch) -> Vec<f64> {
    let mut out = Vec::new();
    for r in &dm.restart_sequences {
        if r.kind != RestartKind::GoalKick {
            continue;
        }
        let Some(taken) = r.taken_t else { continue };
        let Some(e) = dm
            .events
            .iter()
            .find(|e| e.t >= taken.value - 1e-9 && e.type_ != fm_engine::EventType::Beat)
        else {
            continue;
        };
        let Some(x2) = e.x2 else { continue };
        let team = if e.subject <= 10 {
            TeamId::Home
        } else {
            TeamId::Away
        };
        out.push(progress(x2, team));
    }
    out
}
