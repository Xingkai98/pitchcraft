//! P17A 异常规则（design §3.7）。
//!
//! 规则是**代码里的具名条项**，不是报告里的手写散文——因此 300 seed 重跑后结论自动重算，
//! 阈值与证据样本都可复核。
//!
//! 每条规则必须：
//! 1. 声明 `min_sample_size`，低于它时状态降级为 `insufficient_sample`（**不静默省略**）；
//! 2. 至少给一条**动作链证据**（seed + 时间 + episode/restart 标识 + 事件下标）；
//! 3. 未触发时也输出（`within_expectation`），使报告能区分"检查过没问题"与"没检查"；
//! 4. `baseline_expectation` 必须以 [`UNCALIBRATED_TAG`] 开头——本 change 没用真实比赛数据集；
//! 5. 报数一律取自**与报告表同一份 `Stat`**（逐场先算再跨场聚合），不得自己算池化均值；
//! 6. 证据样本的母体必须**与统计量的分母口径一致**（见 A5 一例）。

use crate::metrics::{ControlTransitions, PossessionShape, Rate, RestartQuality};
use crate::model::MatchRecord;
use crate::motifs::{EvidenceSample, MotifReport};

/// 规则状态：只有 `anomaly` 会进入报告的异常清单。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Anomaly,
    WithinExpectation,
    InsufficientSample,
}

impl Status {
    pub const fn as_str(self) -> &'static str {
        match self {
            Status::Anomaly => "anomaly",
            Status::WithinExpectation => "within_expectation",
            Status::InsufficientSample => "insufficient_sample",
        }
    }
}

/// `baseline_expectation` 的**标定状态标签**（2026-09-24 审阅要求）。
///
/// 本 change **没有使用任何真实比赛数据集**：这些"期望"来自足球常识与设计文档的定性印象，
/// 是**待标定的领域假设**，不是从真实数据测得的参照值。因此：
/// - 每条规则的 `baseline_expectation` 必须以本标签开头（守卫 `anomaly_expectations_are_tagged_uncalibrated`）；
/// - 规则阈值是**内部诊断阈值**（本 change 自定），不得被读作"与真实足球的偏差量"；
/// - 标定要等 #15B（phase）/ #16（空间）与真实比赛数据到位。
pub const UNCALIBRATED_TAG: &str = "[未标定] ";

#[derive(Debug, Clone)]
pub struct Anomaly {
    pub id: &'static str,
    /// 标题可以带**由指标插值**的数值（不要写死常数：canary 与 baseline 的量级不同，
    /// 写死会让同一份产物自相矛盾，见 2026-09-24 审阅的 A7 一例）。
    pub title: String,
    pub status: Status,
    pub severity: &'static str,
    pub confidence: &'static str,
    pub value: f64,
    pub unit: &'static str,
    pub baseline_expectation: &'static str,
    pub sample_size: usize,
    pub min_sample_size: usize,
    /// 规则自述的判据（阈值与来源），让 reviewer 能判断阈值是否合理。
    pub criterion: String,
    pub evidence: Vec<EvidenceSample>,
    pub why_not_football: &'static str,
    pub mechanism_hypothesis: &'static str,
    pub mechanism_area: &'static str,
    pub missing_evidence: &'static str,
}

pub struct Ctx<'a> {
    pub per_match: &'a [MatchRecord],
    pub possession: &'a PossessionShape,
    pub transitions: &'a ControlTransitions,
    pub restarts: &'a RestartQuality,
    pub motifs: &'a MotifReport,
}

fn decide(hits: usize, denominator: usize, min_n: usize) -> Status {
    if denominator < min_n {
        Status::InsufficientSample
    } else if hits > 0 {
        Status::Anomaly
    } else {
        Status::WithinExpectation
    }
}

/// 取"动作间隔最大"的 episode 作为证据（大小降序，再按 seed/t 升序 → 确定性）。
fn widest_gap_samples(per_match: &[MatchRecord], want: usize) -> Vec<EvidenceSample> {
    let mut rows: Vec<(f64, u64, f64, u64, Vec<usize>)> = Vec::new();
    for m in per_match {
        for ep in &m.episodes {
            if let Some(g) = ep.action_gaps.iter().cloned().fold(None, |acc: Option<f64>, v| {
                Some(acc.map_or(v, |a| a.max(v)))
            }) {
                rows.push((
                    g,
                    m.seed,
                    ep.start_t,
                    ep.id,
                    ep.actions.iter().map(|a| a.event_index).take(6).collect(),
                ));
            }
        }
    }
    rows.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap()
            .then_with(|| a.1.cmp(&b.1))
            .then_with(|| a.2.partial_cmp(&b.2).unwrap())
    });
    rows.into_iter()
        .take(want)
        .map(|(g, seed, t, id, idxs)| EvidenceSample {
            seed,
            t,
            episode_id: Some(id),
            restart_id: None,
            event_indexes: idxs,
            note: format!("episode 内最大动作间隔 {:.1}s（持球后出球耗时）", g),
        })
        .collect()
}

// ============================== A1 持球-出球节奏 ==============================

/// A1：possession 内相邻动作间隔（= 持球后出球耗时）远超（未标定的）期望量级。
///
/// 判据：逐场平均间隔 > [`DWELL_ANOMALY_SECONDS`]（**内部诊断阈值**）。
/// 期望量级（持球者 1–3 s 内出球）是**领域假设**，见 [`UNCALIBRATED_TAG`]——本轮没有真实比赛数据集。
///
/// **机制不是 `HOLD_MIN_TICKS`**（2026-09-24 审阅更正）：`HOLD_MIN_TICKS` / `HOLD_MAX_TICKS` /
/// `POSSESSION_HOLD_MIN` / `POSSESSION_HOLD_MAX` 在 P31 删槽位后**已无任何读取点**
/// （`engine/src/lib.rs` 只剩声明；改它们不影响任何输出）。真正的驱动是
/// P28/P31 的**行动机会 deadline**：`open_action_opportunity`（lib.rs:1751）用
/// `action_deadline_for`（lib.rs:1731）→ `compute_action_deadline`（lib.rs:1619）算出
/// `BASE_ACTION_DEADLINE_TICKS=7`（lib.rs:1077）再按危险/压迫/出球空间压缩到
/// `MIN/MAX_ACTION_DEADLINE_TICKS=3/12`（lib.rs:1085-1086，门将 +3，lib.rs:1088）；
/// 机会到期后 `build_action_plan` 若结算为「继续带球」就**重新开一个机会再等一个 deadline**
/// （lib.rs:2225-2262 的 `advance_action_opportunity`），于是"带球—等待—再带球"会累积成
/// 多个 deadline 之和——这解释了为什么实测 P90 达到 16.6 s、最大 42 s，而不是上界 12 s。
pub const DWELL_ANOMALY_SECONDS: f64 = 6.0;

fn a1(ctx: &Ctx) -> Anomaly {
    let v = ctx.possession.action_gap_seconds.mean_of_means;
    let den = ctx.possession.action_gap_seconds.observations;
    let firing = v > DWELL_ANOMALY_SECONDS;
    Anomaly {
        id: "A1",
        title: format!(
            "持球-出球节奏：possession 内相邻动作间隔 {:.1} s，超出未标定的期望量级（持球后 1–3 s 出球）",
            v
        ),
        status: decide(firing as usize, den, 500),
        severity: "high",
        confidence: "high",
        value: v,
        unit: "s",
        baseline_expectation: "[未标定] 领域假设（非实测）：真实比赛持球者 1–3 s 内出球；\
                               一次 possession 的相邻决策间隔中位数约 2–4 s",
        sample_size: den,
        min_sample_size: 500,
        criterion: format!(
            "逐场相邻动作间隔均值再跨场平均 > {:.1}s 即判异常（口径见 design §3.3）",
            DWELL_ANOMALY_SECONDS
        ),
        evidence: widest_gap_samples(ctx.per_match, 5),
        why_not_football: "持球者的每一次决策都要等到行动机会 deadline 到期（基准 7 tick、按场面压缩到 3–12）才出球，\
                        而「继续带球」会重置 deadline 再等一轮，等于无球跑动与压迫多数时候不改变出球时刻：\
                        真实足球里持球时长主要由压迫与接应选项决定，而不是由一轮轮固定额度的 deadline 累积决定。\
                        这同时把一场比赛的传球量与 possession 数压到真实的约一半。",
        // 不含运行时比例（2026-09-24 第四轮审阅）：此前的「（约占 73%）」是本条判据在某个 seed 集上的
        // 实测占比，写进静态文本后 canary 与 baseline 共用一句、与各自产物自相矛盾。凡随 seed 集变化的
        // 量（占比/计数/均值）一律只在 criterion 里由指标插值；此处只写**不随运行变化**的机制链路。
        // 守卫 `mechanism_prose_carries_no_frozen_statistical_ratios`。
        mechanism_hypothesis: "出球时机由行动机会 deadline 统一驱动：`advance_action_opportunity` 只在 deadline 到期时\
                              才让 `build_action_plan` 产出一次决策，而「继续带球」的结算会**重置 deadline 再等一轮**，\
                              因此相邻动作间隔 = 若干轮 deadline 之和（轮数随场面变化，不由任何常量决定）\
                              + 交付飞行/transition 的 tick（`BASE_ACTION_DEADLINE_TICKS=7`，\
                              按危险/压迫压缩到 3–12，门将 +3）",
        mechanism_area: "lib.rs:2225 `advance_action_opportunity`（`opp.age_ticks >= opp.deadline_ticks` 才结算）、lib.rs:1753 `open_action_opportunity`、lib.rs:1731 `action_deadline_for`、lib.rs:1619 `compute_action_deadline`、lib.rs:1077/1085-1088 常量",
        missing_evidence: "#16 空间特征——无法区分'因为无人可传而持球等待'与'按 deadline 无条件等待'；\
                        需要球附近接应人数与最近防守距离才能定性。\
                        （`PRESSURE_URGENCY`/`ESCAPE_BONUS` 已把压迫与出球空间计入 deadline，\
                        所以本条**不是**「与场面完全无关」——待空间特征到位后应重新表述）",
    }
}

// ============================== A2 争抢时长退化 ==============================

/// A2：争抢（松散球）时长只取极少数取值——绝大多数是 0 s（同 tick 即被拾回）。
///
/// 判据：`duration == 0` 的占比 > [`INSTANT_CONTEST_SHARE`]。
pub const INSTANT_CONTEST_SHARE: f64 = 0.5;

fn a2(ctx: &Ctx) -> Anomaly {
    let total: usize = ctx.transitions.duration_value_counts.values().sum();
    let instant: usize = ctx
        .transitions
        .duration_value_counts
        .get("0.000")
        .cloned()
        .unwrap_or(0);
    let share = crate::model::share_of(instant, total);
    let distinct = ctx.transitions.duration_value_counts.len();

    // 证据：取「争抢时长最长的几条」+「同 tick 拾回的几条」，两者都能回放。
    let mut samples: Vec<EvidenceSample> = Vec::new();
    for m in ctx.per_match {
        for c in &m.contests {
            if samples.len() >= 5 {
                break;
            }
            if c.duration == Some(0.0) {
                samples.push(EvidenceSample {
                    seed: m.seed,
                    t: c.start_t,
                    episode_id: c.next_episode.map(|i| m.episodes[i].id),
                    restart_id: None,
                    event_indexes: c.source_event_index.into_iter().collect(),
                    note: format!(
                        "争抢 {}：时长 0s（同 tick 收束），丢球方={:?} 拾回方={:?}",
                        c.reason, c.losing_team, c.pickup_team
                    ),
                });
            }
        }
    }

    Anomaly {
        id: "A2",
        title: format!(
            "争抢时长退化：{:.0}% 的松散球同 tick 被拾回，没有连续的争抢过程",
            100.0 * share
        ),
        status: decide((share > INSTANT_CONTEST_SHARE) as usize, total, 200),
        severity: "high",
        confidence: "high",
        value: share,
        unit: "share",
        baseline_expectation: "[未标定] 领域假设（非实测）：真实足球的松散球/二点球是连续过程\
                               （球员跑动、身体对抗、多次触碰），时长分布连续且很少为 0",
        sample_size: total,
        min_sample_size: 200,
        criterion: format!(
            "争抢时长为 0s 的占比 > {:.2} 即判异常；同时报告去重取值数（{}）作为退化证据",
            INSTANT_CONTEST_SHARE, distinct
        ),
        evidence: samples,
        why_not_football: "`control_lost → contest → pickup` 在多数情况下没有占用任何时间：球权在同一 tick 从一队转移到另一队。\
                        这意味着「松散球」不是一个可竞争的状态，而只是控制权交接的一条记账旁路——\
                        真实足球里争抢的结果由谁先到、谁更强壮决定，因此必然消耗时间并产生二点球。",
        mechanism_hypothesis: "**时长档位由「指定的追逐者是否已经在球上」决定，不由 `winning_team` 的有无决定**\
                             （2026-09-24 二审更正——此前的 Some/None 说法被产物自身反证：`tackle_loose` 走 `Some` 却是 3 s，\
                             `pass_lost` 走 `None` 却同时出现在 0/1/3 s）。真正判据是 `advance_loose` 的第一个检查：\
                             **松散球创建当刻，`chaser` 是否已在 `PICKUP_RADIUS_METERS`（0.5 m）内**\
                             （lib.rs:5260）——是则当拍拾取（0 s），否则追逐者要跑过去（≈3 tick 后拾取）。\
                             `interception_loose` 恒 0 s 是因为拦截路径**显式把拦截者对账到拦截点**\
                             （lib.rs:4637「拦截者位置已对账到 at」），创建松散球时距离即 0；\
                             `tackle_loose` 恒 3 s 是因为抢断的松散球点取 `deflect_point(...)`（lib.rs:4461），\
                             把球捅到离抢断者约 5.25 m（`TACKLE_DEFLECT_DISTANCE=0.05`，归一化 ≈ 球场长度的 1/20）处，\
                             追逐者必须先跑过去。`winning_team` 只决定**谁被允许追**，不决定 0 还是 3。\
                             角球 battle（`start_battle_loose`，lib.rs:5235）仍是唯一双队对等的争抢，\
                             且不要把 `delivery_loose` 的争抢归属（其夺回率见 M2 表，随 seed 集变化）夺回归给它\
                             ——`delivery_loose` 同时来自角球 battle（lib.rs:4871）、解围（4886）与门球（4902）\
                             三处，门球是最大来源",
        mechanism_area: "lib.rs:5260 `advance_loose` 的 `d < norm_step(PICKUP_RADIUS_METERS)` 当拍拾取判据、lib.rs:5225 `start_loose_ball`、lib.rs:4637 拦截者对账到 `at`、lib.rs:4461 `emit_tackle_highlight_impl` 的 `deflect_point` 松散球点（经 lib.rs:4929 `start_loose_ball` 落地）、lib.rs:5235 `start_battle_loose`、lib.rs:505 LOOSE_MAX_TICKS、lib.rs:503 PICKUP_RADIUS_METERS",
        missing_evidence: "#16 空间特征——需要落点附近双方球员距离/速度，才能证明对手在空间上本可赶到；\
                        当前只能证明「时长由追逐者创建当刻的初始距离决定（0 或需跑过去）」，与球员速度无关",
    }
}

// ============================== A3 丢球后归属由原因决定 ==============================

/// 判据阈值：某争抢原因只要样本 ≥ [`REGAIN_REASON_MIN_SAMPLE`] 且夺回率 ≤ [`REGAIN_DETERMINISTIC_MAX`]，
/// 就算一条"确定性归属"通道。出现 ≥ [`REGAIN_DETERMINISTIC_CHANNELS`] 条即判异常。
///
/// 为什么用"按原因分解"而不是总夺回率：**总有回率会被不同原因的混合掩盖**。实测 canary 上
/// 总夺回率 21.8% 看起来"还算有争抢"，但分解后 `interception_loose` 0/741、`tackle_loose` 0/129
/// 是**零方差的全胜映射**，而 `pass_lost` 95.7% —— 真实过程不会因为丢球方式不同而变成确定结果。
pub const REGAIN_REASON_MIN_SAMPLE: usize = 100;
pub const REGAIN_DETERMINISTIC_MAX: f64 = 0.05;
pub const REGAIN_DETERMINISTIC_CHANNELS: usize = 2;
/// 或：夺回率的极差（最高 - 最低）超过该值即判异常。
pub const REGAIN_SPREAD_MIN: f64 = 0.60;

fn a3(ctx: &Ctx) -> Anomaly {
    let rate: Rate = ctx.transitions.regain_by_loser;
    let mut deterministic: Vec<(&str, f64, usize)> = Vec::new();
    let mut rates: Vec<(f64, usize)> = Vec::new();
    for (k, v) in &ctx.transitions.regain_by_reason {
        if v.denominator >= REGAIN_REASON_MIN_SAMPLE {
            rates.push((v.value, v.denominator));
            if v.value <= REGAIN_DETERMINISTIC_MAX {
                deterministic.push((k.as_str(), v.value, v.denominator));
            }
        }
    }
    let spread = rates
        .iter()
        .map(|(v, _)| *v)
        .fold(f64::NEG_INFINITY, f64::max)
        - rates.iter().map(|(v, _)| *v).fold(f64::INFINITY, f64::min);
    let spread = if rates.is_empty() { 0.0 } else { spread };

    let firing = deterministic.len() >= REGAIN_DETERMINISTIC_CHANNELS || spread >= REGAIN_SPREAD_MIN;
    let den: usize = rates.iter().map(|(_, d)| *d).sum();

    // 证据：确定性通道各取一条 + 高夺回率通道一条，构成"同一现象两个极端"。
    let mut samples = Vec::new();
    for m in ctx.per_match {
        for c in &m.contests {
            if samples.len() >= 6 {
                break;
            }
            let deterministic_here = deterministic.iter().any(|(k, _, _)| *k == c.reason);
            let extreme_here = spread >= REGAIN_SPREAD_MIN
                && ctx
                    .transitions
                    .regain_by_reason
                    .get(c.reason)
                    .map(|r| r.value >= 0.9)
                    .unwrap_or(false);
            if (deterministic_here || extreme_here) && c.regained_by_loser.is_some() {
                samples.push(EvidenceSample {
                    seed: m.seed,
                    t: c.start_t,
                    episode_id: c.next_episode.map(|i| m.episodes[i].id),
                    restart_id: None,
                    event_indexes: c.source_event_index.into_iter().collect(),
                    note: format!(
                        "{}：丢球方={:?} → 拾回方={:?}（{}）",
                        c.reason,
                        c.losing_team,
                        c.pickup_team,
                        if c.regained_by_loser == Some(true) {
                            "原队夺回"
                        } else {
                            "对手"
                        }
                    ),
                });
            }
        }
    }

    let detail = ctx
        .transitions
        .regain_by_reason
        .iter()
        .filter(|(_, v)| v.denominator >= REGAIN_REASON_MIN_SAMPLE)
        .map(|(k, v)| format!("{}={:.1}%({})", k, 100.0 * v.value, v.denominator))
        .collect::<Vec<_>>()
        .join(", ");

    Anomaly {
        id: "A3",
        title: format!(
            "丢球后归属由「丢球方式」确定：按原因分解的夺回率极差 {:.1} 个百分点",
            100.0 * spread
        ),
        status: decide(firing as usize, den, 400),
        severity: "high",
        confidence: "high",
        value: spread,
        unit: "rate_spread",
        baseline_expectation: "[未标定] 领域假设（非实测）：同一个二点球由谁拿到取决于位置与人数，\
                               不同丢球方式（被断、被铲、传球失误）都不存在「必定归对手」的规则，\
                               夺回率不会为 0 也不会接近 100%",
        sample_size: den,
        min_sample_size: 400,
        criterion: format!(
            "按争抢原因分解后：样本 ≥{} 且夺回率 ≤{:.0}% 的通道数 ≥{}，或夺回率极差 ≥{:.0}% → 判异常。\
             实测 {}；总夺回率 {:.1}%（{} / {}）",
            REGAIN_REASON_MIN_SAMPLE,
            100.0 * REGAIN_DETERMINISTIC_MAX,
            REGAIN_DETERMINISTIC_CHANNELS,
            100.0 * REGAIN_SPREAD_MIN,
            detail,
            100.0 * rate.value,
            rate.hits,
            rate.denominator
        ),
        evidence: samples,
        why_not_football: "拦截和抢断之后，球权固定落到对手；而传球丢失之后，球权固定被原队拿回。\
                        这说明「谁拿到松散球」不是由球落在哪、谁离得近决定的，而是由丢球方式在代码里预先决定的。\
                        真实足球里这三种情形的二点球归属都只是概率——原队反抢和对手推进都会发生。\
                        直接后果是：拦截和抢断在比赛里是完全等价的两种动作（都等于换球权），抢断这个动作本身不产生任何附加过程。\
                        （具体次数见下方 criterion，已由指标插值——不要硬编码，canary 与 baseline 计数不同。）",
        mechanism_hypothesis: "松散球的追逐者由 `start_loose_ball` 的 `winning_team` 参数按**单队**选出：\
                              拦截走 lib.rs:4652 `Some(拦截者所属球队)`、抢断走 lib.rs:4929 `Some(防守方)`——\
                              于是拾取者在该队内是「离落点最近者」，但对手根本不参与竞争，归属必然是 100%/0%。\
                              `pass_lost`（lib.rs:4669）与射门补射（lib.rs:4757）传 `None`，走 `nearest_any`，\
                              才有真正的双向比较；角球用 `start_battle_loose`（双队 + RNG）是唯一完全对等的争抢",
        mechanism_area: "lib.rs:5225 `start_loose_ball`；调用点 lib.rs:4652（拦截）、lib.rs:4929（抢断）、lib.rs:4669（传失）、lib.rs:5235（角球 battle）",
        missing_evidence: "#16 空间特征——需要落点附近双方球员位置/距离，才能判断「对手是否本可赶到」；\
                          但归属呈现 0%/100% 的极端已足以说明：结果不是由位置竞争产生的，\
                          因为**每一次**拦截与**每一次**抢断（次数见下方 criterion，已插值）都无一例外",
    }
}

// ============================== A4 重开后被立即夺回 ==============================

/// A4：重开交付之后球权立刻丢失（首个开放动作即失败传球，或交付后 ≤3 s 内丢球）。
pub const RESTART_IMMEDIATE_LOSS_MAX: f64 = 0.25;

fn a4(ctx: &Ctx) -> Anomaly {
    let rate = ctx.restarts.immediate_loss;
    let firing = rate.denominator >= 200 && rate.value > RESTART_IMMEDIATE_LOSS_MAX;

    let mut samples = Vec::new();
    for m in ctx.per_match {
        for r in &m.restarts {
            if samples.len() >= 5 {
                break;
            }
            if let Some(i) = r.first_episode {
                let ep = &m.episodes[i];
                if crate::motifs::matches_restart_immediate_loss(ep) {
                    samples.push(EvidenceSample {
                        seed: m.seed,
                        t: r.start_t,
                        episode_id: Some(ep.id),
                        restart_id: Some(r.id),
                        event_indexes: ep.actions.iter().map(|a| a.event_index).collect(),
                        note: format!(
                            "{} 重开：交付后立即丢失（end={}, 动作链={:?}）",
                            r.kind,
                            ep.end_reason.unwrap_or("-"),
                            ep.tokens()
                        ),
                    });
                }
            }
        }
    }

    Anomaly {
        id: "A4",
        title: format!(
            "重开质量：{:.0}% 的定位球交付出球权立即被夺回",
            100.0 * rate.value
        ),
        status: decide(firing as usize, rate.denominator, 200),
        severity: "medium",
        confidence: "medium",
        value: rate.value,
        unit: "share",
        baseline_expectation: "[未标定] 领域假设（非实测）：定位球（界外球/任意球/门球）多数能带来\
                               数秒以上的己方控制；立即丢失属于少数",
        sample_size: rate.denominator,
        min_sample_size: 200,
        criterion: format!(
            "重开后首个 possession 立即丢失（首个开放动作即失败传球，或交付后 ≤{:.0}s 内 control_lost）占比 > {:.2} 即判异常",
            crate::motifs::IMMEDIATE_LOSS_SECONDS,
            RESTART_IMMEDIATE_LOSS_MAX
        ),
        evidence: samples,
        why_not_football: "定位球是**设计好的**重新开始：发球方按规则先触碰球、且有站位优势。\
                        如果交付之后立刻丢球成为常见结果，说明交付目标选择与接应位置没有体现这一优势。",
        mechanism_hypothesis: "定位球交付走的是与开放比赛相同的传球概率（`INTERCEPT_*` / `PASS_MISS_P`），未按重开场景调整目标选择",
        mechanism_area: "lib.rs:288-302 拦截/传失概率常量（`INTERCEPT_P_TIGHT/MID/FAR`、`PASS_MISS_P`）、定位球交付的目标选择路径（P6 重开接线）",
        missing_evidence: "#15B phase / #16 空间——需要交付时接应点数量与防守站位，才能判定「本就无人可传」还是「选人错误」",
    }
}

// ============================== A5 射门前动作链 ==============================

/// A5：射门几乎是单动作/单传球的产物，缺少"经过若干次传球后进入射门"的链条。
pub const PRE_SHOT_PASSES_MAX: f64 = 1.0;

fn a5(ctx: &Ctx) -> Anomaly {
    let v = ctx.possession.pre_shot_successful_passes.mean_of_means;
    let den = ctx.possession.pre_shot_successful_passes.observations;
    let firing = den >= 100 && v < PRE_SHOT_PASSES_MAX;

    // 证据必须取自**统计量自己的母体**：`pre_shot_successful_passes` 的分母是
    // `first_shot_index.is_some()`（动作链里含 shot 事件的 episode），不是
    // `is_shot_ending`（`end_reason ∈ {goal, saved_caught, shot_rebound}`）。
    // 2026-09-24 审阅实测两者在 baseline 上是 2760 vs 572（相差 4.8 倍）：原先用
    // `is_shot_ending` 选样本，等于给"链长 4.23（n=2760）"配上来自另一小撮 episode 的回放定位
    // ——被扑出后由**对手**控制、以及射门后以 `out`/`foul` 收场的 episode 全被排除在外，
    // 而它们恰恰是"射门不进球"的主要形态。守卫 `a5_evidence_comes_from_the_statistic_population`。
    let mut samples = Vec::new();
    for m in ctx.per_match {
        for ep in &m.episodes {
            if samples.len() >= 5 {
                break;
            }
            if let Some(n) = crate::motifs::successful_passes_before_shot(ep) {
                samples.push(EvidenceSample {
                    seed: m.seed,
                    t: ep.start_t,
                    episode_id: Some(ep.id),
                    restart_id: None,
                    event_indexes: ep.actions.iter().map(|a| a.event_index).collect(),
                    note: format!(
                        "射门前成功传球 {}，动作链 {:?}，end={}",
                        n,
                        ep.tokens(),
                        ep.end_reason.unwrap_or("-")
                    ),
                });
            }
        }
    }

    Anomaly {
        id: "A5",
        title: format!("射门前链条短：射门前成功传球 {:.2} 次（未触发的内部阈值 < 1 次）", v),
        status: decide(firing as usize, den, 100),
        severity: "medium",
        confidence: "medium",
        value: v,
        unit: "passes",
        baseline_expectation: "[未标定] 领域假设（非实测）：一次射门前通常经过多次传球\
                               （射门是进攻组织的终点，不是单次动作的终点）",
        sample_size: den,
        min_sample_size: 100,
        criterion: format!(
            "射门前成功传球数（逐场均值再跨场平均，母体 = 动作链里含 shot 的 episode）< {:.1} 即判异常。\
             实测 {:.3}（n {}；P50 {:.2}，P90 {:.2}）",
            PRE_SHOT_PASSES_MAX,
            v,
            den,
            ctx.possession.pre_shot_successful_passes.p50_of_p50,
            ctx.possession.pre_shot_successful_passes.p90_of_p90
        ),
        evidence: samples,
        why_not_football: "如果射门总是紧跟在一次传球（或直接由持球者）之后，那么进攻组织（build-up → progression）在生成层里不存在，\
                        射门退化为一次独立抽奖，与球场上其他球员的位置无关。",
        mechanism_hypothesis: "射门由局部 hazard 触发，触发条件不要求 possession 内达到若干次成功传球或推进到指定区域",
        mechanism_area: "射门机会驱动路径（P29/P31 的 shot_setup 与 hazard 五因子）",
        missing_evidence: "#15B phase——需要把射门放进 possession 阶段才能说清「缺的是 build-up 还是 final-third 组织」；\
                        当前只能说链长",
    }
}

// ============================== A6 无动作的 possession ==============================

/// A6：存在大量"持续时间长、动作极少"的 possession——持球时间被消耗但没有发生任何决策。
pub const EMPTY_POSSESSION_SECONDS: f64 = 20.0;
pub const EMPTY_POSSESSION_SHARE: f64 = 0.20;

fn a6(ctx: &Ctx) -> Anomaly {
    let mut hits = 0usize;
    let mut den = 0usize;
    let mut samples = Vec::new();
    for m in ctx.per_match {
        for ep in &m.episodes {
            let Some(d) = ep.duration else { continue };
            den += 1;
            if d >= EMPTY_POSSESSION_SECONDS && ep.action_count() <= 1 {
                hits += 1;
                if samples.len() < 5 {
                    samples.push(EvidenceSample {
                        seed: m.seed,
                        t: ep.start_t,
                        episode_id: Some(ep.id),
                        restart_id: None,
                        event_indexes: ep.actions.iter().map(|a| a.event_index).collect(),
                        note: format!(
                            "{}s 的 possession 只有 {} 个动作（{:?}），end={}",
                            d as i64,
                            ep.action_count(),
                            ep.tokens(),
                            ep.end_reason.unwrap_or("-")
                        ),
                    });
                }
            }
        }
    }
    let share = crate::model::share_of(hits, den);
    Anomaly {
        id: "A6",
        title: format!(
            "空转 possession：{:.1}% 的 possession ≥{:.0} s 却只有 ≤1 个决策动作",
            100.0 * share,
            EMPTY_POSSESSION_SECONDS
        ),
        status: decide((share > EMPTY_POSSESSION_SHARE) as usize, den, 200),
        severity: "medium",
        confidence: "high",
        value: share,
        unit: "share",
        baseline_expectation: "[未标定] 领域假设（非实测）：一次 20 s 以上的控球通常伴随 3 次以上\
                               传球或带球推进；长时间零动作不构成控球过程",
        sample_size: den,
        min_sample_size: 200,
        criterion: format!(
            "持续时间 ≥{:.0}s 且动作数 ≤1 的 episode 占全部已闭合 episode 的比例 > {:.2} 即判异常",
            EMPTY_POSSESSION_SECONDS, EMPTY_POSSESSION_SHARE
        ),
        evidence: samples,
        why_not_football: "这些 episode 在时间轴上占了 20 s 以上却只有一个事件：画面观众会看到球员原地控球很久、然后才发生一次传球。\
                        控球时长与决策数量脱钩，是「计时器驱动」而非「选项驱动」的直接特征。",
        mechanism_hypothesis: "与 A1 同源：行动机会 deadline 未到期就不产生新决策，而「继续带球」会把 deadline 重置再等一轮；\
                              动作数因此与控球时长脱钩（注意：**不是** `HOLD_MIN/MAX_TICKS`——那两个常量已无读取点）",
        mechanism_area: "lib.rs:2225 `advance_action_opportunity`、lib.rs:1077/1085-1086 deadline 常量",
        missing_evidence: "无（本条不需要空间数据即可确认；它的价值是把 A1 的后果量化成可回放的静止控球片段）",
    }
}

// ============================== A7 重开准备期是方式常数 ==============================

/// 判据：某重开方式只要样本 ≥ [`PREP_KIND_MIN_SAMPLE`] 且其准备期**逐场取值极差为 0**（零方差），
/// 就算一条"常数化"通道。出现 ≥ [`PREP_CONSTANT_CHANNELS`] 条即判异常。
///
/// 为什么用"极差为 0"而不是"均值偏大/偏小"：均值大小本身不是缺陷（真实足球角球确实要摆人墙），
/// 但**同一种重开方式的准备期从来没有变化**才是：真实比赛里同一个任意球可能 2 s 发出（快发），
/// 也可能 25 s（等人墙），它的长短由场面决定。零方差说明这个时长不是过程的产物，而是一个配置值。
pub const PREP_KIND_MIN_SAMPLE: usize = 50;
pub const PREP_CONSTANT_CHANNELS: usize = 2;

fn a7(ctx: &Ctx) -> Anomaly {
    // 每种重开方式的准备期取值集合。**只用于零方差判定**（下面的极差），不用于报数。
    let mut raw_per_kind: std::collections::BTreeMap<&'static str, Vec<f64>> =
        std::collections::BTreeMap::new();
    for m in ctx.per_match {
        for r in &m.restarts {
            if let Some(v) = r.prep_duration {
                raw_per_kind.entry(r.kind).or_default().push(v);
            }
        }
    }
    let mut constant: Vec<(&str, f64, usize)> = Vec::new();
    let mut detail: Vec<String> = Vec::new();
    // 报数一律取自 `restarts.prep_seconds_by_kind`——与报告 M3 的表**同一份 `Stat`**
    // （逐场先算再跨场聚合）。2026-09-24 审阅实测过两口径不一致：本规则原先自己算池化
    // `model::mean(vals)`，kickoff 得到 3.58 s，而表里是 2.58 s（各场 kickoff 观测数不等，
    // 池化把观测多的场加权了）——同一个 kind 在产物里出现两个数，读者无法判断哪个是判据。
    // 现在 kind 的均值/离散度只有一处来源；下面的零方差判定与逐场口径**等价**：
    // 并集极差为 0 ⟺ 每场内部极差为 0 且各场均值相同 ⟺ 全部取值恒等。
    for (k, s) in &ctx.restarts.prep_seconds_by_kind {
        let vals = raw_per_kind.get(k.as_str());
        if s.observations < PREP_KIND_MIN_SAMPLE {
            continue;
        }
        detail.push(format!(
            "{}={:.1}s(场间 sd {:.2}, n {}, matches {})",
            k, s.mean_of_means, s.cross_match_mean_sd, s.observations, s.matches
        ));
        if let Some(vals) = vals {
            let mn = vals.iter().cloned().fold(f64::INFINITY, f64::min);
            let mx = vals.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            if mx - mn == 0.0 {
                constant.push((k.as_str(), mn, s.observations));
            }
        }
    }
    let firing = constant.len() >= PREP_CONSTANT_CHANNELS;
    let den: usize = ctx
        .restarts
        .prep_seconds_by_kind
        .values()
        .filter(|s| s.observations >= PREP_KIND_MIN_SAMPLE)
        .map(|s| s.observations)
        .sum();

    // 证据：每个常数化方式各取最多 3 条，**并为「准备期最长的方式」留名额**。
    // 为什么不是"先到先得取满 6 条"（2026-09-24 审阅实测的问题）：按 seed 顺序扫描时，
    // 早期 seed 的任意球（prep=1 s）会把 6 个名额占满，于是角球（本引擎唯一有真实准备期的
    // 方式）从不出现在证据里——而机制解释恰恰要拿它作对照（"引擎**有**准备期机制"）。
    let sample_cap = 3usize;
    let mut samples = Vec::new();
    // 对照通道：有真实准备期（均值最大）的方式，在 `constant` 之外单独留一条。
    let widest_kind = ctx
        .restarts
        .prep_seconds_by_kind
        .iter()
        .filter(|(k, s)| {
            s.observations >= PREP_KIND_MIN_SAMPLE && !constant.iter().any(|(c, _, _)| c == k)
        })
        .max_by(|a, b| a.1.mean_of_means.partial_cmp(&b.1.mean_of_means).unwrap())
        .map(|(k, _)| k.as_str());
    let mut per_kind_seen: std::collections::BTreeMap<&'static str, usize> =
        std::collections::BTreeMap::new();
    for m in ctx.per_match {
        for r in &m.restarts {
            let is_constant = constant.iter().any(|(k, _, _)| *k == r.kind);
            let is_control = widest_kind == Some(r.kind);
            if !is_constant && !is_control {
                continue;
            }
            let seen = per_kind_seen.entry(r.kind).or_insert(0);
            if *seen >= sample_cap {
                continue;
            }
            *seen += 1;
            let role = if is_constant {
                "常数化通道"
            } else {
                "对照（有真实准备期）"
            };
            samples.push(EvidenceSample {
                seed: m.seed,
                t: r.start_t,
                episode_id: None,
                restart_id: Some(r.id),
                event_indexes: r.event_indexes.clone(),
                note: format!(
                    "{} 重开（{}）：准备期 {:?}s、飞行 {:?}s、开赛后首个 possession 在 {:?}s",
                    r.kind, role, r.prep_duration, r.flight_duration, r.first_control_delay
                ),
            });
        }
    }

    // 交叉证据：`restart_preparation_started` 事实数 < `restart_taken` 事实数
    //（差值 ≈ 从未进入准备期的重开数，即门球）。
    let (prep_facts, taken_facts) = ctx
        .per_match
        .iter()
        .fold((0usize, 0usize), |(p, t), m| {
            (
                p + m.fact_kind_counts
                    .iter()
                    .filter(|(k, _)| k.starts_with("restart_preparation_started"))
                    .map(|(_, v)| *v)
                    .sum::<usize>(),
                t + m.fact_kind_counts
                    .iter()
                    .filter(|(k, _)| k.starts_with("restart_taken"))
                    .map(|(_, v)| *v)
                    .sum::<usize>(),
            )
        });
    let zero_prep = constant
        .iter()
        .filter(|(_, v, _)| *v == 0.0)
        .map(|(k, _, _)| *k)
        .collect::<Vec<_>>()
        .join(", ");

    let constant_kinds = constant
        .iter()
        .map(|(k, v, n)| format!("{}={:.1}s(n {})", k, v, n))
        .collect::<Vec<_>>()
        .join(", ");

    Anomaly {
        id: "A7",
        title: if constant.is_empty() {
            format!(
                "重开准备期：未发现取值恒定的方式（内部阈值 ≥{} 条零方差方式才判异常）",
                PREP_CONSTANT_CHANNELS
            )
        } else {
            format!(
                "重开准备期是「方式常数」：{} 恒定，准备期由配置而非场面决定",
                constant_kinds
            )
        },
        status: decide(firing as usize, den, 400),
        severity: "high",
        confidence: "high",
        value: constant.len() as f64,
        unit: "constant_kinds",
        baseline_expectation: "[未标定] 领域假设（非实测；原文中的具体秒数如 2 s/20 s 没有实测来源）：\
                               重开准备时长由场面决定（快发、等人墙、等队友跑位），\
                               同一方式的取值有大幅波动，不存在零方差的几种方式",
        sample_size: den,
        min_sample_size: 400,
        criterion: format!(
            "样本 ≥{} 且准备期取值**极差为 0** 的重开方式数 ≥{} → 判异常。\
             各方式（逐场先算再跨场聚合，与 M3 表同一 `Stat`）{}；\
             零准备期方式 = [{}]；交叉证据 restart_preparation_started={} < restart_taken={}（差 {}）",
            PREP_KIND_MIN_SAMPLE,
            PREP_CONSTANT_CHANNELS,
            detail.join(", "),
            zero_prep,
            prep_facts,
            taken_facts,
            taken_facts.saturating_sub(prep_facts)
        ),
        evidence: samples,
        why_not_football: "重开不是「哨响后立刻出球」，而是球员走位、摆球、对手布防的一段过程。\
                        这里门球的准备期恒为 0 s——球刚出底线就在同一秒被发出，画面上看不到任何球员走到球边的过程；\
                        任意球恒为 1 s，同样没有这个过程。\
                        **对照**：角球（本引擎唯一有真实准备期的方式，各方式的均值/场间 sd 见下方 criterion）\
                        说明引擎**有**准备期机制，只是这两种重开一个被结构跳过、一个因为球位恰在被犯规者（即发球者）\
                        脚下而退化成 1 tick。\
                        （具体数值一律由指标插值——不要在此硬编码：canary 与 baseline 的量级不同，\
                        写死会让同一份产物自相矛盾，2026-09-24 审阅已在 A7 抓到过一例。）",
        mechanism_hypothesis: "**两种不同成因，不要合并成「按 kind 取常数」**（2026-09-24 审阅更正）：\
                              ① **门球**是结构性的——`goal_kick_started`（observation.rs:2066）在死球**当拍**同时提交 \
                              `dead_ball_started` 与 `restart_taken`，完全不进 `RestartPreparation` 状态，\
                              所以准备期恒 0；② **任意球恒 1 s** 不是常数，而是**几何涌现**——\
                              准备期本身是「走向球位」的距离循环（lib.rs:5047-5065，8 m/step，另有\
                              `min_ticks = if kind == Corner { CORNER_SETUP_MIN_TICKS } else { 0 }`，lib.rs:5067），\
                              而 `emit_foul_and_free_kick`（lib.rs:7097）把球位设在**被犯规持球者自己的位置**\
                              （`let spot = st.pos[carrier as usize]`，lib.rs:2328）、\
                              发球者取 \
                              `nearest_in_team`，于是发球者恒在 1 step + 拾取半径内 → 下一 tick 即发出。\
                              只有角球真正常数（`CORNER_SETUP_MIN_TICKS`，lib.rs:661）",
        mechanism_area: "observation.rs:2066 `goal_kick_started`（同时提交 taken，跳过准备期）；lib.rs:5047-5067 重开准备期距离循环 + `min_ticks`；lib.rs:661 CORNER_SETUP_MIN_TICKS；`emit_foul_and_free_kick`（球位=犯规点）",
        missing_evidence: "#16 空间特征——需要发球者与球的距离，才能把②的「恒 1 s」从几何解释升级为可观测结论；\
                          ①（门球跳过准备期）已由 sidecar 事实计数实证，不需要空间数据",
    }
}

// ============================== A8 丢球位置带 ==============================

/// A8：丢球/争抢位置集中在场地中央的 40% 区间，两端各 20% 的区间几乎没有丢球。
///
/// **措辞纪律**（2026-09-24 审阅）：`x ∈ [0.5±0.2]` 是**中央 40% 区间**，不是"窄带"——
/// 它已覆盖球场 40% 的纵向长度，把它称作窄带会夸大异常。异常成立靠的是**两端空集**
/// （五等分带 0 与 4 各 ~3%），不是"带很窄"。
pub const TURNOVER_MID_BAND_SHARE: f64 = 0.70;
pub const TURNOVER_MID_BAND_WIDTH: f64 = 0.2;

fn a8(ctx: &Ctx) -> Anomaly {
    let mut in_band = 0usize;
    let mut with_loc = 0usize;
    let mut bands: Vec<usize> = vec![0; 5];
    let mut samples = Vec::new();
    for m in ctx.per_match {
        for c in &m.contests {
            let Some((x, _y)) = c.location else { continue };
            if !(0.0..=1.0).contains(&x) {
                continue;
            }
            with_loc += 1;
            let b = ((x * 5.0).floor() as usize).min(4);
            bands[b] += 1;
            if (x - 0.5).abs() <= TURNOVER_MID_BAND_WIDTH {
                in_band += 1;
                if samples.len() < 5 {
                    samples.push(EvidenceSample {
                        seed: m.seed,
                        t: c.start_t,
                        episode_id: c.next_episode.map(|i| m.episodes[i].id),
                        restart_id: None,
                        event_indexes: c.source_event_index.into_iter().collect(),
                        note: format!(
                            "{} 发生在 x={:.3}（中央 40% 区间 [0.3, 0.7] 内）",
                            c.reason, x
                        ),
                    });
                }
            }
        }
    }
    let share = crate::model::share_of(in_band, with_loc);
    // 两端 = 五等分带 0 与 4（各覆盖场地的 20%）。中间的 1/3 带与中央 40% 区间**部分重叠**，
    // 故不能用"1+2+3 带"当中央区间的占比——那会得到 94% 而不是 85%。
    let end_pct = 100.0 * crate::model::share_of(bands[0] + bands[4], with_loc);
    Anomaly {
        id: "A8",
        title: format!(
            "丢球位置集中：{:.0}% 的争抢/丢球落在中央 {:.0}% 区间，两端各 20% 的区间合计仅 {:.0}%",
            100.0 * share,
            100.0 * (2.0 * TURNOVER_MID_BAND_WIDTH),
            end_pct
        ),
        status: decide((share > TURNOVER_MID_BAND_SHARE) as usize, with_loc, 200),
        severity: "high",
        confidence: "medium",
        value: share,
        unit: "share",
        baseline_expectation: "[未标定] 领域假设（非实测）：丢球分布覆盖整个球场，\
                               高强度丢球（前场反抢、后场被压迫）在两端区间都显著存在",
        sample_size: with_loc,
        min_sample_size: 200,
        criterion: format!(
            "争抢位置落在中央 {:.0}% 区间 x∈[0.5±{:.1}] 的占比 > {:.2} 即判异常；\
             同时报告五等分 x 带计数（{:?}，带 0 与带 4 = 两端各 20%，合计仅 {:.1}%）——\
             异常依据是**两端近乎空集**，不是因为该区间「窄」（它本身就覆盖 {:.0}% 的球场长度）",
            100.0 * (2.0 * TURNOVER_MID_BAND_WIDTH),
            TURNOVER_MID_BAND_WIDTH,
            TURNOVER_MID_BAND_SHARE,
            bands,
            end_pct,
            100.0 * (2.0 * TURNOVER_MID_BAND_WIDTH)
        ),
        evidence: samples,
        why_not_football: "丢球位置决定了转换发生的区域，而转换区域决定了比赛的空间结构。\
                        若丢球几乎只发生在场地中央区间、两端区间近乎空集，那么进攻既不会因为推进到前场而冒险丢球，\
                        防守也不会在自己的危险区域承受压力——两种情况在真实足球里都是比赛的主要内容。",
        mechanism_hypothesis: "传球落点与双方队形的纵向移动范围受限（`SIDE_SHIFT_FACTOR` lib.rs:665、`OFF_BALL_RUN_DIST` lib.rs:418 等形状常量），\
                              使球很少被带到两端球门区，因而争抢也就集中在中带。\
                              **（本条未逐条读代码核对，置信度 medium——2026-09-24 审阅已剔除原先并列的\
                              `INTERCEPT_D_TIGHT_M/MID_M` 一项：那是围绕传球落点的**米制半径**，\
                              半径大小无法产生「集中在中场横带」这种位置分布，两者无因果关系。）**",
        mechanism_area: "lib.rs:665 SIDE_SHIFT_FACTOR、lib.rs:418 OFF_BALL_RUN_DIST（**未核对**，见上；\
                         原先并列的 `CORNER_SETUP_MIN_TICKS`（lib.rs:661）与本题无关，已剔除）",
        missing_evidence: "#16 空间特征——需要 22 人位置分布（宽度/纵深/线间距）才能区分「球到不了前场」与「到了前场但没人丢球」；\
                          本条也是本轮唯一未做代码核对的机制假设",
    }
}

// ============================== A9 传递深度 ==============================

/// A9：possession 缺少多脚**开放比赛**传递——绝大多数的 episode 里开放成功传球数 ≤1。
///
/// 判据：**开放比赛**成功传球 ≥2 的 episode 占比 < [`MULTI_PASS_SHARE_MIN`]。它衡量的是**链深分布**，
/// 与 A1（时长节奏）、A5（射门前链长）、A6（空转 possession）互不重复：A1/A6 说"控球很久但
/// 没动作"，本条说"即使有动作，也基本只有一次传球就结束"。
///
/// **口径**（2026-09-24 审阅定死）：只计 `!is_delivery` 的成功传球。定位球**交付**是重开片段的
/// 第一步，不是开放比赛的推进；把它算进来会把「一次交付 + 一次开放传球」记成多脚传递。
/// 300 场实测口径差异 2063 个 episode：旧口径（含交付）比例 65.7%，本条口径 57.9%。
/// 两种口径下比例都远高于未触发阈值 20%，故结论不变；变的是**语义**——"传递深度"讲的是开放比赛。
pub const MULTI_PASS_SHARE_MIN: f64 = 0.20;

fn a9(ctx: &Ctx) -> Anomaly {
    let mut multi = 0usize;
    let mut den = 0usize;
    let mut delivery_only_multi = 0usize;
    let mut samples = Vec::new();
    for m in ctx.per_match {
        for ep in &m.episodes {
            den += 1;
            let open = ep.open_play_pass_success_count();
            if open >= 2 {
                multi += 1;
            } else {
                // 口径差异的显式计数：旧口径会算多、本条不算的 episode（交付撑起来的"多脚"）。
                if ep.pass_success_count() >= 2 {
                    delivery_only_multi += 1;
                    if samples.len() < 5 {
                        samples.push(EvidenceSample {
                            seed: m.seed,
                            t: ep.start_t,
                            episode_id: Some(ep.id),
                            restart_id: None,
                            event_indexes: ep.actions.iter().map(|a| a.event_index).collect(),
                            note: format!(
                                "开放成功传球 {} 次（含交付共 {} 次），动作 {:?}，start={} end={}",
                                open,
                                ep.pass_success_count(),
                                ep.tokens(),
                                ep.start_reason,
                                ep.end_reason.unwrap_or("-")
                            ),
                        });
                    }
                } else if samples.len() < 5 {
                    samples.push(EvidenceSample {
                        seed: m.seed,
                        t: ep.start_t,
                        episode_id: Some(ep.id),
                        restart_id: None,
                        event_indexes: ep.actions.iter().map(|a| a.event_index).collect(),
                        note: format!(
                            "开放成功传球 {} 次（含交付共 {} 次），动作 {:?}，end={}",
                            open,
                            ep.pass_success_count(),
                            ep.tokens(),
                            ep.end_reason.unwrap_or("-")
                        ),
                    });
                }
            }
        }
    }
    let share = crate::model::share_of(multi, den);
    let firing = den >= 200 && share < MULTI_PASS_SHARE_MIN;
    // motif 面的交叉证据：`pickup→pass→lost`（拿球只传一次就丢）的比例。
    let ppl = ctx
        .motifs
        .named
        .iter()
        .find(|h| h.name == "pickup→pass→lost")
        .map(|h| (h.hits, h.denominator, h.rate))
        .unwrap_or((0, 0, 0.0));

    Anomaly {
        id: "A9",
        title: format!(
            "传递深度：开放比赛成功传球 ≥2 的 possession 占 {:.0}%（未触发的内部阈值 < {:.0}%）",
            100.0 * share,
            100.0 * MULTI_PASS_SHARE_MIN
        ),
        status: decide(firing as usize, den, 200),
        severity: "high",
        confidence: "high",
        value: share,
        unit: "share",
        baseline_expectation: "[未标定] 领域假设（非实测）：一次控球通常包含多脚连续传球\
                               （短传配合是控球的基本单位），单传即结束属于少数",
        sample_size: den,
        min_sample_size: 200,
        criterion: format!(
            "**开放比赛**成功传球（排除定位球交付）≥2 的 episode 占比 < {:.2} 即判异常\
             （分母 = 全部已闭合 episode {}）。口径差异：若把交付传球也算进来，占比为 {:.1}%，\
             另有 {} 个 episode 仅靠交付达到「≥2」（本条不计）——两种口径都不触发。\
             交叉证据 `pickup→pass→lost` 命中 {} / {} = {:.1}%",
            MULTI_PASS_SHARE_MIN,
            den,
            100.0 * crate::model::share_of(multi + delivery_only_multi, den),
            delivery_only_multi,
            ppl.0,
            ppl.1,
            100.0 * ppl.2
        ),
        evidence: samples,
        why_not_football: "如果一次控球基本只包含一次成功传球，那么「后场建立 → 中场推进 → 前场结束」这条链路在生成层\
                        根本不存在：球在队内传递的深度被压到 1 跳，比赛退化为「拿球—传一次—丢球」的循环。",
        mechanism_hypothesis: "传球选人只考虑单次传球的成功/收益，不区分「保持控球的回传/横传」与「冒险的向前传球」；\
                              加上行动机会 deadline（A1）使每次出球都被迫产生一次有风险的传球",
        mechanism_area: "传球选人路径与 lib.rs:302 `PASS_MISS_P`、lib.rs:288-289 `INTERCEPT_D_TIGHT_M/MID_M`、\
                         A1 的行动机会 deadline（lib.rs:2225 `advance_action_opportunity`）——\
                         **注意不是** `HOLD_MIN/MAX_TICKS`（lib.rs:513-514 已无读取点，见 A1 注释）",
        missing_evidence: "#15B phase——需要把 possession 分段成 build_up / progression 才能说清「多脚传递」缺失\
                          发生在哪个阶段；#16 空间——需要接应点数量才能判断是否本就无安全传球选项",
    }
}

// ============================== A10 失败传球不是失球 ==============================

/// A10：`pass.result="lost"` 之后，球权在原队手里——失败传球并不造成失球。
///
/// 判据：`pass_lost` 争抢的原队夺回率 > [`LOST_PASS_REGAIN_MIN`]。
///
/// 为什么单列（而不是并进 A3）：A3 讲的是"归属由丢球方式决定"，本条的结论不同且更尖锐——
/// **`lost` 这个标签在行为上不表示失去球权**。而 `tests/realism.rs::l1_pass_completion_rate`
/// 恰恰把 `lost` 计入失败分母并与拦截一起校验比例，也就是说：一个统计上被当作失败的传球，
/// 在比赛过程里几乎从不导致换球权。属于"分布正确、行为不同"的典型。
pub const LOST_PASS_REGAIN_MIN: f64 = 0.75;

fn a10(ctx: &Ctx) -> Anomaly {
    let rate = ctx
        .transitions
        .regain_by_reason
        .get("pass_lost")
        .copied()
        .unwrap_or(Rate::new(0, 0));
    let duration = ctx.transitions.duration_by_reason.get("pass_lost");
    let firing = rate.denominator >= 200 && rate.value > LOST_PASS_REGAIN_MIN;

    let mut samples = Vec::new();
    for m in ctx.per_match {
        for c in &m.contests {
            if samples.len() >= 5 {
                break;
            }
            if c.reason == "pass_lost" && c.regained_by_loser == Some(true) {
                samples.push(EvidenceSample {
                    seed: m.seed,
                    t: c.start_t,
                    episode_id: c.next_episode.map(|i| m.episodes[i].id),
                    restart_id: None,
                    event_indexes: c.source_event_index.into_iter().collect(),
                    note: format!(
                        "pass_lost：争抢 {:?}s 后仍由原队 {:?} 拿回（不是失球）",
                        c.duration, c.pickup_team
                    ),
                });
            }
        }
    }

    let dur = duration
        .map(|d| format!("{:.2}s（P50 {:.2}s）", d.mean_of_means, d.p50_of_p50))
        .unwrap_or_else(|| "-".to_string());

    Anomaly {
        id: "A10",
        title: format!(
            "失败传球不等于失球：`pass.result=\"lost\"` 之后原队仍拿回球权 {:.0}%",
            100.0 * rate.value
        ),
        status: decide(firing as usize, rate.denominator, 200),
        severity: "high",
        confidence: "high",
        value: rate.value,
        unit: "share",
        baseline_expectation: "[未标定] 领域假设（非实测）：一次传球失误通常意味着球权易主\
                               或至少进入真实争夺；若传球方几乎总能拿回，则该传球在设计上并未失准",
        sample_size: rate.denominator,
        min_sample_size: 200,
        criterion: format!(
            "`pass_lost` 的原队夺回率 > {:.0}% 即判异常（实测 {:.1}%，{} / {}；该原因下的争抢时长 {}）。\
             交叉检查：引擎 `EpisodeStartReason::SuccessfulReceive` 计数为 0，即同队拿回也是**新 episode**（pickup），\
             所以这不是「同一段控球延续」，而是真的发生过一次控制权交接",
            100.0 * LOST_PASS_REGAIN_MIN,
            100.0 * rate.value,
            rate.hits,
            rate.denominator,
            dur
        ),
        evidence: samples,
        why_not_football: "`lost` 在统计口径里是一次失败传球（`l1_pass_completion_rate` 把它计入失败分母），\
                        但在比赛过程里它几乎不产生失球：原队经过约 3 s 的争抢拿回球权并开启新 episode。\
                        这意味着「传球失误」这个事件在行为层没有代价——既没有把球交给对手，也没有让本队失去位置，\
                        只是消耗了 3 秒并打断了一次 episode。若把 A1（出球计时器）与本条合起来看，\
                        当前模型的球权转移实际只由「被拦截」和「被抢断」两条路径驱动，传球失误不参与其中",
        mechanism_hypothesis: "**结构性偏向传球方**（不是「通常离得近」）：`lost_pass_highlight`（lib.rs:3908）\
                              把落点设为 `lead_point(from_pos, to_pos, lead)`——即朝**原定接球队友**的提前量点\
                              （lib.rs:3735 算 `lead_point`、lib.rs:3911 取 `(clamp01(lx), clamp01(ly))` 为落点 x2/y2），\
                              接球者当前位置虽在 lib.rs:3732-3733 读出为 `rx/ry`，但只作为事件字段 `receiver_x/y` 上报、\
                              **刻意不写回落点**（`lost_pass_highlight` 的文档明写「接收者 NOT 对账到落点」）；\
                              随后 `start_loose_ball(.., None)`（lib.rs:4669）→ `nearest_any` 在全体球员里取最近者。\
                              原队接球者本就是按这条传球选中的、落点又按他的提前量算，故拾回概率结构性偏高。\
                              对比 `intercepted`（lib.rs:4652 传 `Some(拦截者球队)`）：那条路径的球直接飞向拦截者本人\
                              （lib.rs:3862 取 `let (ix, iy) = st.pos[interceptor]`、lib.rs:3871-3872 令 `x2/y2 = ix/iy`；\
                              `intercept_pass_highlight`（lib.rs:3860）的文档明写「拦截者离球最近默认拿到」），\
                              归属由标签预定。两条路径的差别不在随机性，而在**谁被允许竞争**",
        mechanism_area: "lib.rs:3908-3911 `lost_pass_highlight`（落点=朝原目标的提前量点，接球者位置只上报不回写）、lib.rs:3860-3872 `intercept_pass_highlight`（落点=拦截者本人位置）、lib.rs:4669 / 4652 的 `start_loose_ball` 调用、lib.rs:5225-5230 `start_loose_ball` 内 `nearest_any` vs `nearest_in_team`",
        missing_evidence: "#16 空间特征——需要落点附近双方球员位置，才能判断「本队球员确实离落点最近」\
                          与「结算无条件偏向传球方」；当前证据只能证明归属与传球结果标签矛盾",
    }
}

/// 全部规则（顺序 = 报告顺序）。未触发的规则也会返回，状态为 `within_expectation`。
pub fn evaluate(ctx: &Ctx) -> Vec<Anomaly> {
    vec![
        a1(ctx),
        a2(ctx),
        a3(ctx),
        a4(ctx),
        a5(ctx),
        a6(ctx),
        a7(ctx),
        a8(ctx),
        a9(ctx),
        a10(ctx),
    ]
}
