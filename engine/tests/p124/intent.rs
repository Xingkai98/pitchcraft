//! P124 Slice 3：**意图类特征**（逐 episode）。
//!
//! ## 铁律（本模块的头号约束）
//!
//! **不得从位置反推意图**——P16 已证空间量不足以判 `build_up`/`progression`。
//! 本模块的每个特征都**只读引擎的显式状态**（`IntentState` / `DefensiveIntent`），
//! **一次位置都不读**（结构上：本模块不接收 `StateSnapshot`，只接收 `IntentSnapshot`）。
//!
//! ## 两条来源通道（粒度不同，attribution 方式也不同）
//!
//! | 通道 | 粒度 | 归因方式 |
//! |---|---|---|
//! | [`IntentSnapshot`] | 逐 tick（与位置同拍） | 按 episode 时间窗 `[start_t, end_t]` 过滤（与 P16 的帧过滤**逐字同法**） |
//! | [`DefensiveIntent`] | 稀疏事件 | 每条按 `t` 落进哪个 episode 的窗——**不按下标** |
//!
//! ## 特征清单（每条：定义 + 覆盖率 + 缺失原因分类）
//!
//! | 特征 | 定义 | 缺失原因 |
//! |---|---|---|
//! | `window_opened` | episode 内**是否**出现过起脚窗口（`in_window` 至少一拍） | 无（bool 恒可算；见下「bool 的缺失」注） |
//! | `window_share` | `in_window` 拍数 / 有效拍数 | 有效拍数为 0 → `None` |
//! | `setup_share` | `has_shot_setup` 拍数 / 有效拍数 | 同上 |
//! | `first_window_frac` | **首次**进窗的归一化时刻 `(t − start)/(end − start)` | 未开窗 / 时长 ≤0 → `None` |
//! | `max_window_ticks` | episode 内 `window_ticks` 的最大值（窗口内**犹豫**时长） | 未开窗 → `None` |
//! | `pressure_share` | `pressure_state_ticks > 0` 的拍数 / 有效拍数 | 有效拍数为 0 → `None` |
//! | `pressure_mean` | `pressure_state_ticks` 的逐拍均值 | 有效拍数为 0 → `None` |
//! | `def_per_s` | 防守机会数 / 时长（**累计量须按秒归一**，见 [`EpisodeIntent::def_per_s`]） | 时长不可得或 ≤0 → `None` |
//! | `def_contain_share` 等 | 各类防守动作占该 episode 防守机会的比例 | **无机会 → `None`**（不是 0） |
//!
//! ⚠️ **bool 的缺失**：`window_opened` 是 bool，**没有 `None`**——但它有**判别力前提**：
//! 该 episode 必须有**有效拍**（否则「没开窗」与「没有观测」混为一谈）。故
//! [`EpisodeIntent::valid_ticks`] 为 0 时，`window_opened` 记 `false` 但**同时**在
//! 覆盖率的缺失分类里记一笔；下游判断「没开窗」时**必须先看 `valid_ticks`**。
//!
//! ⚠️ **防守比例是「对手的意图」，不是本方的**：防守机会点上的 `DefensiveAction` 由
//! **防守方**（本 episode 的对手）选出。这**正是**我们要的——「对手怎么防我们」是
//! 本 episode 所处的战术情境（design §2.2）。命名用 `def_*` 前缀，不写「我们」。
//!
//! ## 已记录的缺口（**不冒充**）
//!
//! 见 [`INTENT_FEATURE_LIMITATIONS`]。

use fm_engine::observation::*;
use std::collections::BTreeMap;

/// 逐 episode 的意图特征（缺的记 `None`，不猜）。
#[derive(Debug, Clone, Default)]
pub struct EpisodeIntent {
    /// 该 episode 时间窗内**有效拍数**（有意图快照的拍）。0 = **没有观测**（不是「没有意图」）。
    pub valid_ticks: usize,
    /// episode 内是否出现过起脚窗口。⚠️ 判别力前提见模块头「bool 的缺失」。
    pub window_opened: bool,
    /// `in_window` 拍数 / 有效拍数。
    pub window_share: Option<f64>,
    /// `has_shot_setup` 拍数 / 有效拍数。
    pub setup_share: Option<f64>,
    /// 首次进窗的归一化时刻 ∈ [0,1]。
    pub first_window_frac: Option<f64>,
    /// `window_ticks` 的最大值（窗口内犹豫时长，单位 = 决策 tick）。
    pub max_window_ticks: Option<u32>,
    /// `pressure_state_ticks > 0` 的拍数 / 有效拍数。
    pub pressure_share: Option<f64>,
    /// `pressure_state_ticks` 的逐拍均值（原始 tick 数，**未归一**，见 design §6.2）。
    pub pressure_mean: Option<f64>,
    /// 该 episode 时间窗内的防守机会数。
    pub def_opportunities: usize,
    /// episode 时长（秒）；`end_t` 不可得时为 `None`。
    ///
    /// **为什么意图模块也要带它**：`def_opportunities` 是**累计**量，随 episode 时长增长
    /// （与 P16 的 `backward_m` 同型混淆）。要在 build_up / progression 之间比它，
    /// **必须先按秒归一**，而时长是那个归一化唯一的除数来源。
    pub duration_s: Option<f64>,
    /// 各类防守动作占该 episode 防守机会的比例（**无机会 → `None`**，不是 0）。
    pub def_share: [Option<f64>; 5],
}

impl EpisodeIntent {
    /// 按 [`DefensiveIntentKind::ALL`] 的顺序取比例（`tackle`/`foul`/`contain`/`jockey`/`none`）。
    pub fn def_share_of(&self, k: DefensiveIntentKind) -> Option<f64> {
        let idx = DefensiveIntentKind::ALL
            .iter()
            .position(|x| *x == k)
            .expect("闭集成员必须在 ALL 里");
        self.def_share[idx]
    }

    /// 防守机会**速率**（次/秒）。`duration_s` 不可得或 ≤0 → `None`（不猜 0）。
    ///
    /// ⚠️ 用它而不是原始计数：`def_opportunities` 是累计量，随 episode 时长增长
    /// （`build_up` 的时长是另两档的 ~1.7 倍，P16 已实测）。直接比计数 = 比时长。
    pub fn def_per_s(&self) -> Option<f64> {
        let d = self.duration_s?;
        if d <= 1e-9 {
            return None;
        }
        Some(self.def_opportunities as f64 / d)
    }
}

/// 某个防守动作的**下标**（`ALL` 顺序）。
pub fn kind_index(k: DefensiveIntentKind) -> usize {
    DefensiveIntentKind::ALL
        .iter()
        .position(|x| *x == k)
        .expect("闭集成员必须在 ALL 里")
}

/// 从意图快照 + 稀疏防守事件抽一个 episode 的意图特征。
///
/// `start`/`end` = 该 episode 的时间窗（秒），与 P16 的帧过滤**同一口径**
/// （闭区间 `[start, end]`，容差 `1e-9`）。`end` 不可得时用最后一个快照时刻——
/// **与 P16 的 `episode_features` 逐字同法**，避免两处口径分叉。
pub fn episode_intent(
    snaps: &[IntentSnapshot],
    defensive: &[DefensiveIntent],
    start: f64,
    end: f64,
    duration_s: Option<f64>,
) -> EpisodeIntent {
    // ── 逐 tick 通道：按 episode 时间窗过滤（同 P16） ──
    let in_window: Vec<&IntentSnapshot> = snaps
        .iter()
        .filter(|s| s.t.value + 1e-9 >= start && s.t.value <= end + 1e-9)
        .collect();
    let mut out = EpisodeIntent {
        valid_ticks: in_window.len(),
        duration_s,
        ..Default::default()
    };
    if !in_window.is_empty() {
        let n = in_window.len() as f64;
        let n_setup = in_window.iter().filter(|s| s.state.has_shot_setup).count();
        let n_win = in_window.iter().filter(|s| s.state.in_window).count();
        let n_press = in_window
            .iter()
            .filter(|s| s.state.pressure_state_ticks > 0)
            .count();
        let press_sum: u64 = in_window
            .iter()
            .map(|s| s.state.pressure_state_ticks as u64)
            .sum();
        out.window_opened = n_win > 0;
        out.window_share = Some(n_win as f64 / n);
        out.setup_share = Some(n_setup as f64 / n);
        out.pressure_share = Some(n_press as f64 / n);
        out.pressure_mean = Some(press_sum as f64 / n);
        if n_win > 0 {
            // 首次进窗：`in_window` 的**最早**一拍（`in_window` 为真时，`window_ticks`
            // 是该窗口已消耗的决策 tick 数；首次进窗那拍 `window_ticks == 0`）。
            let first = in_window
                .iter()
                .find(|s| s.state.in_window)
                .expect("已确认 n_win > 0");
            let span = end - start;
            out.first_window_frac = if span > 1e-9 {
                Some(((first.t.value - start) / span).clamp(0.0, 1.0))
            } else {
                None // 时长 ≤0 ⇒ 归一化无定义（不猜 0）
            };
            out.max_window_ticks = Some(
                in_window
                    .iter()
                    .map(|s| s.state.window_ticks)
                    .max()
                    .unwrap_or(0),
            );
        }
    }
    // ── 稀疏通道：每条防守机会按 `t` 落进 episode 窗（**不按下标**） ──
    let mut counts = [0usize; 5];
    for d in defensive {
        if d.t.value + 1e-9 >= start && d.t.value <= end + 1e-9 {
            counts[kind_index(d.kind)] += 1;
        }
    }
    out.def_opportunities = counts.iter().sum();
    if out.def_opportunities > 0 {
        let n = out.def_opportunities as f64;
        for (i, c) in counts.iter().enumerate() {
            out.def_share[i] = Some(*c as f64 / n);
        }
    }
    out
}

/// 逐 episode 的意图特征覆盖率（每条给覆盖率 + 缺失原因分类）。
#[derive(Debug, Clone, Default)]
pub struct IntentCoverage {
    pub episodes: usize,
    /// 各特征「可算」的 episode 数（键 = 特征名，稳定 token）。
    pub computed: BTreeMap<&'static str, usize>,
    /// 缺失原因分类（**闭集式枚举**：每个特征缺时只可能落进这几类）。
    pub missing: BTreeMap<&'static str, usize>,
    /// `valid_ticks == 0` 的 episode 数（「没有观测」——与「没有意图」不同）。
    pub episodes_without_ticks: usize,
    /// `def_opportunities == 0` 的 episode 数（「没有防守机会」——与「防守比例为 0」不同）。
    pub episodes_without_def_opportunities: usize,
}

impl IntentCoverage {
    pub fn observe(&mut self, e: &EpisodeIntent) {
        self.episodes += 1;
        // 「可算」的计数键与缺失键分开——键空间不同，避免把「缺」读成「有」。
        if e.valid_ticks == 0 {
            self.episodes_without_ticks += 1;
        }
        if e.def_opportunities == 0 {
            self.episodes_without_def_opportunities += 1;
        }
        for (name, ok, why) in [
            ("window_share", e.window_share.is_some(), "无有效拍"),
            ("setup_share", e.setup_share.is_some(), "无有效拍"),
            (
                "first_window_frac",
                e.first_window_frac.is_some(),
                "未开窗或时长为 0",
            ),
            (
                "max_window_ticks",
                e.max_window_ticks.is_some(),
                "未开窗",
            ),
            ("pressure_share", e.pressure_share.is_some(), "无有效拍"),
            ("pressure_mean", e.pressure_mean.is_some(), "无有效拍"),
            (
                "def_per_s",
                e.def_per_s().is_some(),
                "时长不可得或为 0",
            ),
        ] {
            if ok {
                *self.computed.entry(name).or_insert(0) += 1;
            } else {
                *self.missing.entry(why).or_insert(0) += 1;
            }
        }
        // 防守比例：五类一起（要么全可算，要么全缺）。
        if e.def_opportunities > 0 {
            *self.computed.entry("def_share[*]").or_insert(0) += 1;
        } else {
            *self.missing.entry("无防守机会").or_insert(0) += 1;
        }
    }

}

/// 已知缺口（**记录在案，不冒充**）。每条给「影响哪条特征」与「要补什么」。
pub const INTENT_FEATURE_LIMITATIONS: &[(&str, &str)] = &[
    (
        "committed_is_unobservable_at_the_sampling_point",
        "`IntentState::committed` 在逐拍采样点上**恒为 false**（提交射门与序列销毁同一 tick，\
         见 `observation.rs` 的 `IntentState` 与 `committed_is_not_observable_...` 测试）。\
         ⇒ 本模块**不产出**任何以 `committed` 为输入的特征——「提交时刻」这一意图信号\
         在本采样口径下**不可得**。要它须把采样点挪进 `tick()` 内（本 change 不做，\
         那会改变 P16 已定死的位置采样口径）。",
    ),
    (
        "defensive_intent_is_the_opponent_intent",
        "防守机会点上的 `DefensiveAction` 由**防守方**（本 episode 的对手）选出。\
         本模块把它当作「本 episode 所处的战术情境」——这是**有意的解释**，不是测量误差。\
         但它**不是**「我方意图」，命名与下游解读都不得混。",
    ),
    (
        "def_share_is_none_not_zero_when_no_opportunity",
        "无防守机会的 episode，五类防守比例全部记 `None`（不是 0）——「没机会」与\
         「机会全是 contain」是两种不同的比赛事实，用 0 顶替会把前者读成后者的极端。",
    ),
    (
        "pressure_state_is_a_countdown_not_an_intensity",
        "`pressure_state_ticks` 是**剩余保持 tick 数**（倒计时），不是压迫强度，且在此**不归一**\
         （design §6.2）。下游要强度须自己除以满值常量并显式声明。",
    ),
];

/// 从一场比赛的意图通道抽出逐 episode 的意图特征。
///
/// ## ⚠️ 签名是**类型隔离**，不是风格选择（本 change 的头号铁律的落点）
///
/// 铁律：**不得从位置反推意图**（P16 已证空间量不足）。positions 只活在
/// [`DiagnosticMatch::state_snapshots`]。**本函数刻意不接收 `DiagnosticMatch`**，
/// 只接收三个**不含任何位置字段**的切片：
///
/// - `snaps: &[IntentSnapshot]`——意图快照（无位置）；
/// - `defensive: &[DefensiveIntent]`——稀疏防守事件（无位置）；
/// - `episodes: &[PossessionEpisode]`——只提供 episode 的时间边界与 id，**无位置**。
///
/// ⇒ 本函数及其**任何** helper（无论定义在哪个文件）都**结构上够不着位置**：
/// 没有 `dm`，也没有可回推位置的字段。这是 P16 最终采用的**类型隔离**做法
/// （文本扫描做不到这件事——见 `p16/reference.rs` 的说明），本模块沿用。
///
/// ## 下标空间
///
/// 返回长度 == `episodes.len()`（**不做任何过滤**）：缺 caliber 的 episode 也返回一条
/// （`valid_ticks == 0` 的空特征）。调用侧以 `assert_eq!` 与 `episode_features` 比对——
/// 「一侧静默少一条」正是 P16 join bug 的入口。
pub fn match_intents(
    snaps: &[IntentSnapshot],
    defensive: &[DefensiveIntent],
    episodes: &[PossessionEpisode],
) -> Vec<EpisodeIntent> {
    let last_snapshot_t = snaps.last().map(|s| s.t.value).unwrap_or(0.0);
    episodes
        .iter()
        .map(|ep| {
            let end = ep.end_t.map(|t| t.value).unwrap_or(last_snapshot_t);
            let duration = ep.end_t.map(|t| t.value - ep.start_t.value);
            episode_intent(snaps, defensive, ep.start_t.value, end, duration)
        })
        .collect()
}
