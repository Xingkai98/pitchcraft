//! P17B Slice 1：**证据边界表**（本 change 的第一交付）。
//!
//! ## 这个模块在回答什么
//!
//! 诊断器能说什么，**严格由现有 sidecar 能观测到什么决定**。本模块把 design §2 的表
//! **落成代码**：每条量 → 它落在哪个公开字段（[`Locus`]）→ 它是**观测**还是**派生**
//! （[`EvidenceKind`]）。报告里每一条结论都必须引用表里的一个 [`Locus`]，
//! 而 `Locus` 是**枚举**、不是自由字符串——于是「引用了不存在的字段」这件事
//! **不可能编译通过**（比扫文本更强：扫文本只能抓拼写，抓不到「字段改名后引用照旧」）。
//!
//! ## 为什么这张表是「结论的闸门」而不是文档
//!
//! 设计阶段这张表**自己出过两处错**（design §2 如实记录）：
//! ① 把**射门时的门将位置**错列进「不可得」——它其实在 `Event::keeper_x/keeper_y`
//! （普通射门与头球射门都设）且逐拍就在 `StateSnapshot::pos` 上。这是**反向的假边界**
//! （把可得说成不可得），同样让报告放弃本可做的解释；
//! ② 把 `entry_pressure_bucket` 错列为 hazard 的输入——`compute_shot_score` 的五因子
//! 里没有它（它供提交率方向门用）。
//! 连同侦察阶段被探针推翻的两处读码推断，**同一族错在本 change 出现四次**。
//! ⇒ 结论：这张表的每一条都必须**实测核对**；表里每条 `availability` 都写明它是
//! 怎么被核对的（探针 / 读 [`Locus`] 的公开类型）。
//!
//! ## 与 provenance 的相容（design §4.1 的 MAJOR-1）
//!
//! sidecar 的 schema 指纹**包含** `Phase` 闭集（`tests/p17a/model.rs` 的
//! `sidecar_schema_fingerprint`）——指纹漏了它就没在守护闭集完整性。故 `Phase` 出现在
//! **指纹构造点**是正确的，本 change 直接**复用** `p17a` 的那个函数而不是重写一份，
//! 于是本 change 的产物里也（正确地）带着它。**本 change 不声称能判相位**——
//! 这是两回事，措辞守卫守的是后者（见 `p17b_diagnosis_report.rs`）。

use fm_engine::observation::*;

/// 分析器版本。**内容变化时必须手改**（判据 / 口径 / 覆盖声明 / 模板都算内容变化）。
///
/// 为什么不能自动算：`sidecar_schema_fingerprint` 只覆盖 sidecar 的闭集枚举，
/// **不覆盖本 change 自己的判据**（P17A 的 `ANALYZER_VERSION` 有同款说明与一次真实事故）。
pub const ANALYZER_VERSION: &str = "p17b-1";

/// **口径版本**。判据（松散球窗口定义 / 归属队读法 / 分类边界 / 尾部窗口长度）变化时递增。
/// 产物 provenance 记它，使「口径不同的两次运行」在产物层可区分（spec「provenance 可区分口径」）。
pub const CALIBER_VERSION: &str = "p17b-caliber-v1";

/// 产物 schema 标签。
pub const SCHEMA_TAG: &str = "p17b-explainable-diagnosis/1";

// ============================== 证据性质 ==============================

/// 结论的**性质**——本 change 的核心纪律（design §2 规则）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum EvidenceKind {
    /// 引擎直接提交的事实（字段原样读出，不做任何计算）。
    Observed,
    /// 由观测**确定性**算出（换个人按同一口径算会得到同一个数）。
    Derived,
}

impl EvidenceKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            EvidenceKind::Observed => "观测",
            EvidenceKind::Derived => "派生",
        }
    }
}

// ============================== 落点（编译期存在性证明） ==============================

/// 报告可引用的**落点**：`observation` 模块公开类型上的一个字段（或公开方法）。
///
/// ## 为什么是枚举而不是 `&str`
///
/// spec 要求「每条结论附产生它的公开字段路径」，且「其落点字段确实存在于 `observation`
/// 模块的**公开**类型上（有守卫扫描）」。自由字符串做不到这件事：字段改名后旧字符串照样
/// 编过，报告会引用一个不存在的字段而**无人察觉**——本仓的「假覆盖」正是这一族。
///
/// 改为枚举后，每个变体的 [`Locus::read`] **必须真的读那个字段**：
///字段被改名 / 改成私有 / 所在类型不再是公开的，本模块**编译不过**。
/// 判别力测试（`locus_read_probes_actually_read_the_field`）再证明这些读探针在真实
/// 输入上确实取到了值——否则「编译过」可能只是读了个恒 `None` 的路径。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Locus {
    EpisodeStartReason,
    EpisodeEndReason,
    EpisodeEventIndexes,
    EpisodeControlFactIndexes,
    EpisodeStartT,
    EpisodeEndT,
    FactKind,
    FactDetail,
    FactSourceEventIndex,
    FactLocation,
    EventType,
    EventResult,
    EventDetail,
    EventPosition,
    EventTargetPosition,
    EventKeeperPosition,
    MoverAction,
    MoverId,
    MoverTarget,
    BallLoose,
    SnapshotPos,
    SnapshotBall,
    IntentPressureTicks,
    IntentShotWindow,
    IntentCommitted,
    IntentEntryPressureBucket,
    DefensiveIntentKind,
    DefensiveIntentDefender,
    RestartStartT,
    RestartTakenT,
    RestartOpenPlayResumedT,
    MatchCoherence,
    MatchGapCount,
}

impl Locus {
    /// 全部变体（守护「表不漏项」：新增变体而不进 [`EVIDENCE_TABLE`] 会红）。
    pub const ALL: &'static [Locus] = &[
        Locus::EpisodeStartReason,
        Locus::EpisodeEndReason,
        Locus::EpisodeEventIndexes,
        Locus::EpisodeControlFactIndexes,
        Locus::EpisodeStartT,
        Locus::EpisodeEndT,
        Locus::FactKind,
        Locus::FactDetail,
        Locus::FactSourceEventIndex,
        Locus::FactLocation,
        Locus::EventType,
        Locus::EventResult,
        Locus::EventDetail,
        Locus::EventPosition,
        Locus::EventTargetPosition,
        Locus::EventKeeperPosition,
        Locus::MoverAction,
        Locus::MoverId,
        Locus::MoverTarget,
        Locus::BallLoose,
        Locus::SnapshotPos,
        Locus::SnapshotBall,
        Locus::IntentPressureTicks,
        Locus::IntentShotWindow,
        Locus::IntentCommitted,
        Locus::IntentEntryPressureBucket,
        Locus::DefensiveIntentKind,
        Locus::DefensiveIntentDefender,
        Locus::RestartStartT,
        Locus::RestartTakenT,
        Locus::RestartOpenPlayResumedT,
        Locus::MatchCoherence,
        Locus::MatchGapCount,
    ];

    /// 落点的**字段路径字面量**（报告与产物里打印它）。
    pub const fn as_str(self) -> &'static str {
        match self {
            Locus::EpisodeStartReason => "PossessionEpisode.start_reason",
            Locus::EpisodeEndReason => "PossessionEpisode.end_reason",
            Locus::EpisodeEventIndexes => "PossessionEpisode.event_indexes",
            Locus::EpisodeControlFactIndexes => "PossessionEpisode.control_fact_indexes",
            Locus::EpisodeStartT => "PossessionEpisode.start_t",
            Locus::EpisodeEndT => "PossessionEpisode.end_t",
            Locus::FactKind => "ControlFact.kind",
            Locus::FactDetail => "ControlFact.detail",
            Locus::FactSourceEventIndex => "ControlFact.source_event_index",
            Locus::FactLocation => "ControlFact.location",
            Locus::EventType => "Event.type_",
            Locus::EventResult => "Event.result",
            Locus::EventDetail => "Event.detail",
            Locus::EventPosition => "Event.{x,y}",
            Locus::EventTargetPosition => "Event.{x2,y2}",
            Locus::EventKeeperPosition => "Event.{keeper_x,keeper_y}",
            Locus::MoverAction => "Mover.action",
            Locus::MoverId => "Mover.id",
            Locus::MoverTarget => "Mover.{to_x,to_y}",
            Locus::BallLoose => "BallState.loose",
            Locus::SnapshotPos => "StateSnapshot.pos",
            Locus::SnapshotBall => "StateSnapshot.ball",
            Locus::IntentPressureTicks => "IntentState.pressure_state_ticks",
            Locus::IntentShotWindow => "IntentState.{in_window,window_ticks}",
            Locus::IntentCommitted => "IntentState.committed",
            Locus::IntentEntryPressureBucket => "IntentState.entry_pressure_bucket",
            Locus::DefensiveIntentKind => "DefensiveIntent.kind",
            Locus::DefensiveIntentDefender => "DefensiveIntent.defender",
            Locus::RestartStartT => "RestartSequence.start_t",
            Locus::RestartTakenT => "RestartSequence.taken_t",
            Locus::RestartOpenPlayResumedT => "RestartSequence.open_play_resumed_t",
            Locus::MatchCoherence => "DiagnosticMatch::is_coherent()",
            Locus::MatchGapCount => "DiagnosticMatch::gap_count()",
        }
    }

    /// **存在性证明**：读一遍该落点。
    ///
    /// 返回 `true` = 本次输入上该字段**可取**（用于判别力测试，不是「非空」的意思——
    /// 空 episode 列表是合法输入）。本函数的价值在**编译期**：字段一改名就编译不过。
    pub fn read(self, dm: &DiagnosticMatch) -> bool {
        let ep = dm.possession_episodes.first();
        // ⚠️ 取**第一个带该字段的事件**，而不是 `events.first()`：流首是 `lineup`/`kickoff`，
        // 既无 `movers` 也无 `ball`。用 `first()` 会让探针恒假（本仓的「空转」形态），
        // 而它读起来完全正常——这正是 `locus_read_probes_actually_read_the_field` 要抓的。
        let any_mover_ev = dm.events.iter().find(|e| e.movers.is_some());
        let any_ball_ev = dm.events.iter().find(|e| e.ball.is_some());
        let ev = dm.events.first();
        let mv = any_mover_ev.and_then(|e| e.movers.as_ref()).and_then(|m| m.first());
        let snap = dm.state_snapshots.first();
        let intent = dm.intent_snapshots.first();
        let def = dm.defensive_intents.first();
        let rst = dm.restart_sequences.first();
        match self {
            Locus::EpisodeStartReason => ep.map(|e| e.start_reason.as_str()).is_some(),
            Locus::EpisodeEndReason => ep.map(|e| e.end_reason.map(|r| r.as_str())).is_some(),
            Locus::EpisodeEventIndexes => ep.map(|e| e.event_indexes.len()).is_some(),
            Locus::EpisodeControlFactIndexes => ep.map(|e| e.control_fact_indexes.len()).is_some(),
            Locus::EpisodeStartT => ep.map(|e| e.start_t.value).is_some(),
            Locus::EpisodeEndT => ep.map(|e| e.end_t.map(|t| t.value)).is_some(),
            Locus::FactKind => dm.control_facts.first().map(|f| f.kind.as_str()).is_some(),
            Locus::FactDetail => dm
                .control_facts
                .first()
                .map(|f| f.detail.map(|d| d.as_str()))
                .is_some(),
            Locus::FactSourceEventIndex => dm
                .control_facts
                .first()
                .map(|f| f.source_event_index)
                .is_some(),
            Locus::FactLocation => dm.control_facts.first().map(|f| f.location).is_some(),
            Locus::EventType => ev.map(|e| e.type_.as_str()).is_some(),
            Locus::EventResult => ev.map(|e| e.result.as_ref().map(|r| r.len())).is_some(),
            Locus::EventDetail => ev.map(|e| e.detail.as_ref().map(|d| d.len())).is_some(),
            Locus::EventPosition => ev.map(|e| (e.x, e.y)).is_some(),
            Locus::EventTargetPosition => ev.map(|e| (e.x2, e.y2)).is_some(),
            Locus::EventKeeperPosition => ev.map(|e| (e.keeper_x, e.keeper_y)).is_some(),
            Locus::MoverAction => mv.map(|m| m.action.as_str()).is_some(),
            Locus::MoverId => mv.map(|m| m.id).is_some(),
            Locus::MoverTarget => mv.map(|m| (m.to_x, m.to_y)).is_some(),
            Locus::BallLoose => any_ball_ev.map(|e| e.ball.as_ref().map(|b| b.loose)).is_some(),
            Locus::SnapshotPos => snap.map(|s| s.pos.len()).is_some(),
            Locus::SnapshotBall => snap.map(|s| s.ball).is_some(),
            Locus::IntentPressureTicks => intent.map(|s| s.state.pressure_state_ticks).is_some(),
            Locus::IntentShotWindow => intent.map(|s| (s.state.in_window, s.state.window_ticks)).is_some(),
            Locus::IntentCommitted => intent.map(|s| s.state.committed).is_some(),
            Locus::IntentEntryPressureBucket => {
                intent.map(|s| s.state.entry_pressure_bucket).is_some()
            }
            Locus::DefensiveIntentKind => def.map(|d| d.kind.as_str()).is_some(),
            Locus::DefensiveIntentDefender => def.map(|d| d.defender).is_some(),
            Locus::RestartStartT => rst.map(|r| r.start_t.value).is_some(),
            Locus::RestartTakenT => rst.map(|r| r.taken_t.map(|t| t.value)).is_some(),
            Locus::RestartOpenPlayResumedT => {
                rst.map(|r| r.open_play_resumed_t.map(|t| t.value)).is_some()
            }
            Locus::MatchCoherence => dm.is_coherent(),
            Locus::MatchGapCount => dm.gap_count() == dm.gap_count(),
        }
    }
}

// ============================== 证据表 ==============================

/// 表里的一行：量 → 落点 → 性质 → 核对方式。
#[derive(Debug, Clone, Copy)]
pub struct EvidenceRow {
    /// 量的名字（人可读）。
    pub quantity: &'static str,
    pub locus: Locus,
    pub kind: EvidenceKind,
    /// 这一条**是怎么被核对的**（本 change 的纪律：表本身出过四次错，每条都要有出处）。
    pub how_verified: &'static str,
}

/// design §2 的表，**逐行落成代码**。
pub const EVIDENCE_TABLE: &[EvidenceRow] = &[
    EvidenceRow {
        quantity: "控制权建立/释放（队、人、位置、依据）",
        locus: Locus::FactLocation,
        kind: EvidenceKind::Observed,
        how_verified: "`ControlFact` 是 #15A 观测层对控制权的权威提交；位置口径经 P16 `caliber` 复核",
    },
    EvidenceRow {
        quantity: "episode 起止与原因",
        locus: Locus::EpisodeStartReason,
        kind: EvidenceKind::Observed,
        how_verified: "闭集 `EpisodeStartReason` / `EpisodeEndReason`（`as_str` 串名由 P17A 指纹守护）",
    },
    EvidenceRow {
        quantity: "episode 结束原因",
        locus: Locus::EpisodeEndReason,
        kind: EvidenceKind::Observed,
        how_verified: "同上；开放 episode 的 `end_t` 为 `None` ⇒ 报告记 `unknown`，不猜",
    },
    EvidenceRow {
        quantity: "争抢成因 / 结局",
        locus: Locus::FactDetail,
        kind: EvidenceKind::Observed,
        how_verified: "`ControlFactDetail::{ContestStart,ContestEnd}` 是封闭联合（不变量 10 强制 kind 配对）",
    },
    EvidenceRow {
        quantity: "归属事件下标",
        locus: Locus::FactSourceEventIndex,
        kind: EvidenceKind::Observed,
        how_verified: "绑定必须经 `bind_event_index`；可回放定位门逐条核 `event_index` 能取到事件",
    },
    EvidenceRow {
        quantity: "episode 归属事件下标",
        locus: Locus::EpisodeEventIndexes,
        kind: EvidenceKind::Observed,
        how_verified: "回放定位门核对每个下标能回到 `DiagnosticMatch.events` 且时间自洽",
    },
    EvidenceRow {
        quantity: "episode 归属控制事实下标",
        locus: Locus::EpisodeControlFactIndexes,
        kind: EvidenceKind::Observed,
        how_verified: "起点/收束侧事实的定位来源——P16 的 `caliber` 用同一下标空间；\
                       报告用它把「收束侧争抢事实」指回具体一条事实",
    },
    EvidenceRow {
        quantity: "动作（`chase`/`close_down`/`run`/`keeper_return`）",
        locus: Locus::MoverAction,
        kind: EvidenceKind::Observed,
        how_verified: "⚠️ 是**开集字符串**：30 seed 实跑产出恰为 `{chase, close_down, run, keeper_return}`，\
                      无编译期闭集 ⇒ 新值会静默落入 `other`，报告按「闭集声明 + `other` 兜底」处理",
    },
    EvidenceRow {
        quantity: "松散球期的追球者（`chase`，靶点恒为球）",
        locus: Locus::MoverAction,
        kind: EvidenceKind::Observed,
        how_verified: "30 seed 实测 `chase` **全量 6745 个**；其中落在「开球期松散球 beat」内的是\
                       **3091** 个，另 3654 个落在**非松散球**的 beat 上（即带球/争抢之外的跑位），\
                       重开准备期 **0** 个。⚠️ 本行前版写「`chase` 共 3091 个」——把子集写成了全集\
                       （审阅 MINOR 抓到）。覆盖缺口见 `ContestStartReason` 逐项声明（`reasons.rs`）",
    },
    EvidenceRow {
        quantity: "触球结果（pass result / shot result / tackle）",
        locus: Locus::EventResult,
        kind: EvidenceKind::Observed,
        how_verified: "决策事件的 `result` 串（P17A 的 `action_of` 用同一读法）",
    },
    EvidenceRow {
        quantity: "22 人位置 + 球位（逐拍）",
        locus: Locus::SnapshotPos,
        kind: EvidenceKind::Observed,
        how_verified: "P16 的门已核 `state_snapshots` 与 beat 投影**逐位恒等**；步长实测恒 1.0 s",
    },
    EvidenceRow {
        quantity: "球位（逐拍）",
        locus: Locus::SnapshotBall,
        kind: EvidenceKind::Observed,
        how_verified: "同上；⚠️ 死球/重开准备期它是**约定点**不是物理位置（P16 `features.rs` 记录在案）",
    },
    EvidenceRow {
        quantity: "起脚窗口相（开窗 / 已耗拍 / committed / 入窗压力档）",
        locus: Locus::IntentShotWindow,
        kind: EvidenceKind::Observed,
        how_verified: "P124 的逐拍意图快照；`intent_snapshots[i].t == state_snapshots[i].t`（实测 161970/161970 同刻）",
    },
    EvidenceRow {
        quantity: "防守动作类型 + 防守者",
        locus: Locus::DefensiveIntentKind,
        kind: EvidenceKind::Observed,
        how_verified: "P124 的稀疏防守意图（`defender` 语义由 P124 测试钉住）",
    },
    EvidenceRow {
        quantity: "持球者受压倒计时",
        locus: Locus::IntentPressureTicks,
        kind: EvidenceKind::Observed,
        how_verified: "⚠️ 是**剩余保持 tick 数**，**不是「强度」**；P124 实测它对 phase 的 AUC = 0.372（无判别力）",
    },
    EvidenceRow {
        quantity: "接应者数 / 最近接应距离",
        locus: Locus::SnapshotPos,
        kind: EvidenceKind::Derived,
        how_verified: "复用 #16 已固化的 `support_formation` 口径（`#[path]` 活读，含其阈值常量）",
    },
    EvidenceRow {
        quantity: "动作链（事件序列 → 链）",
        locus: Locus::EventType,
        kind: EvidenceKind::Derived,
        how_verified: "由 `episode.event_indexes` 里的事件序列确定性算出（P17A `ActionKind` 同读法）",
    },
    EvidenceRow {
        quantity: "射门时门将位置",
        locus: Locus::EventKeeperPosition,
        kind: EvidenceKind::Observed,
        how_verified: "⚠️ **本行是设计阶段的一处错的正果**：初版把它错列为「不可得」。\
                       普通射门与头球射门都设 `keeper_x/keeper_y`，逐拍也在 `StateSnapshot.pos` 上",
    },
    EvidenceRow {
        quantity: "射门者的起脚位置",
        locus: Locus::EventPosition,
        kind: EvidenceKind::Observed,
        how_verified: "`shot` 事件的 `subject` 位置（`Event.{x,y}`）",
    },
    EvidenceRow {
        quantity: "episode 起止时刻",
        locus: Locus::EpisodeStartT,
        kind: EvidenceKind::Observed,
        how_verified: "`state_commit` 基准；步长实测恒 1.0 s（`TICK_SECONDS`），故时刻与拍数一一对应",
    },
    EvidenceRow {
        quantity: "episode 结束时刻",
        locus: Locus::EpisodeEndT,
        kind: EvidenceKind::Observed,
        how_verified: "开放 episode 为 `None` ⇒ 报告记 `unknown` 且不给结束前窗口（不猜）",
    },
    EvidenceRow {
        quantity: "控制事实的类型",
        locus: Locus::FactKind,
        kind: EvidenceKind::Observed,
        how_verified: "闭集 `ControlFactKind`；报告用它区分「收束侧事实」到底取的是哪一类                       （P16 `caliber` 实测四类都可能出现）",
    },
    EvidenceRow {
        quantity: "事件的附加说明（如 `pass.detail` 的 corner / throw_in）",
        locus: Locus::EventDetail,
        kind: EvidenceKind::Observed,
        how_verified: "⚠️ 取值集合实测为 `{None, clearance, corner, free_kick, out_goal_line, \
                       out_sideline, throw_in}`——**没有 `goal_kick`**（门球交付是普通 `pass`，\
                       只能经 `RestartSequence.kind` 定位）。故本字段**不得**用来判重开类型",
    },
    EvidenceRow {
        quantity: "动作的目标位置（pass 落点 / shot 方向）",
        locus: Locus::EventTargetPosition,
        kind: EvidenceKind::Observed,
        how_verified: "决策事件的 `x2/y2`；`tackle` 等无落点的事件为 `None`（报告记 `unknown`）",
    },
    EvidenceRow {
        quantity: "追球者的球员 id（用于归属队）",
        locus: Locus::MoverId,
        kind: EvidenceKind::Observed,
        how_verified: "id 空间与 `TeamId::from_player` 同源（0–10 主队、11–21 客队）；\
                       越界 id **不计入任一方**（不用猜补）",
    },
    EvidenceRow {
        quantity: "追球者的移动终点（用于区分「追球」与「追人」）",
        locus: Locus::MoverTarget,
        kind: EvidenceKind::Observed,
        how_verified: "实测（8 seed、**世界坐标** `Δx·105 m, Δy·68 m`，球位取当拍 `BallState`）：\
                       168/513（32.8%）的 `close_down` 终点距球 > 5.25 m，median 2.39 m。\
                       ⚠️ **不得把「距球远」读成「在追人」**（审阅轮 2 推翻）：\
                       `close_down_stop` 只推进 `d − CLOSE_DOWN_STOP_DIST`（≈2 m），**打不到靶点**，\
                       故**远端球员的 mover 终点天然离球远**——实测 8 seed 的 513 个 `close_down` \
                       **全部朝球逼近**（靠近 513 / 远离 0）。真正的「追人」只在 `SaveCaught` 分流上，\
                       而该分流实测仅约 **9.9%**（30 seed 215/2162；8 seed 1.8%）。\
                       本行的用途仅剩「两动作的终点分布不同」这一**值层面**的事实；\
                       「不得把 `chase` 与 `close_down` 并称」的**依据是靶点分流本身**（见 `reasons.rs`），\
                       不是这里的距离。⚠️ 设计稿载的 `188/513` 另有一层单位混用（归一化距离比 5.25）。",
    },
    EvidenceRow {
        quantity: "球是否松散（`loose`）",
        locus: Locus::BallLoose,
        kind: EvidenceKind::Observed,
        how_verified: "⚠️ **本字段有口径陷阱**：它同时覆盖重开准备期（球钉在发球点）。\
                       判据必须是 `loose && !in_restart_window`（见 `episode.rs`）",
    },
    EvidenceRow {
        quantity: "射门是否已 committed",
        locus: Locus::IntentCommitted,
        kind: EvidenceKind::Observed,
        how_verified: "P124 的起脚窗口相之一；⚠️ P124 实测它在**逐拍采样点**上不可观测                       （`committed_is_not_observable_at_the_per_tick_sampling_point`）——报告只报值，不解释",
    },
    EvidenceRow {
        quantity: "入窗压力档",
        locus: Locus::IntentEntryPressureBucket,
        kind: EvidenceKind::Observed,
        how_verified: "⚠️ **本行是设计阶段的一处错的正果**：初版把它错列为射门 hazard 的输入——\
                       `compute_shot_score` 的五因子里**没有**它（它供提交率方向门用）。\
                       现行：**可得但**与 hazard 无关，报告只报值不给因果",
    },
    EvidenceRow {
        quantity: "防守动作的防守者 id",
        locus: Locus::DefensiveIntentDefender,
        kind: EvidenceKind::Observed,
        how_verified: "P124 的稀疏防守意图；`defender` 语义（`None` = 无具体防守者）由 P124 测试钉住",
    },
    EvidenceRow {
        quantity: "重开开始时刻",
        locus: Locus::RestartStartT,
        kind: EvidenceKind::Observed,
        how_verified: "重开准备期窗口的**左端**（闭区间起点）",
    },
    EvidenceRow {
        quantity: "重开发出时刻",
        locus: Locus::RestartTakenT,
        kind: EvidenceKind::Observed,
        how_verified: "窗口的**首选右端**（闭开区间末端）。⚠️ 实测（30 seed）1613 个重开里 **2 个缺失**                       （≈0.12%，非零）⇒ `episode.rs` 必须给出显式 fallback 链并记下用了哪一档",
    },
    EvidenceRow {
        quantity: "恢复开放比赛时刻",
        locus: Locus::RestartOpenPlayResumedT,
        kind: EvidenceKind::Observed,
        how_verified: "窗口 `taken_t` 缺失时的**第二档** fallback（不变量 5：有它必有 `taken_t`，\
                       故它只在不变量被破坏时才单独出现——报告仍显式处理）",
    },
    EvidenceRow {
        quantity: "观察缺口计数",
        locus: Locus::MatchGapCount,
        kind: EvidenceKind::Observed,
        how_verified: "`gap_count()` 是 P15A 既有契约，**不新增**接口；>0 的 seed 标 `观察不可信`",
    },
    EvidenceRow {
        quantity: "观察可信度",
        locus: Locus::MatchCoherence,
        kind: EvidenceKind::Observed,
        how_verified: "`is_coherent()` / `gap_count()` 是 P15A 既有契约，**不新增**接口",
    },
];

/// **结构性不可得**（不是「还没做」）——报告文档必须如实列出（spec 的 Scenario
///「已知不可得项被如实声明」）。
///
/// 每条给：不可得的量 / **为什么**不可得 / **验证它需要什么**（design §2 的规则：
/// 「假设」类文字必须附「验证它需要什么」，本表是它的结构化形态）。
#[derive(Debug, Clone, Copy)]
pub struct UnavailableItem {
    pub quantity: &'static str,
    pub reason: &'static str,
    pub what_would_verify: &'static str,
}

pub const STRUCTURAL_UNAVAILABLE: &[UnavailableItem] = &[
    UnavailableItem {
        quantity: "战术阶段（三档 phase 标注）",
        reason: "#16 判「空间量本身不足」、#124 判「意图信号也不足」——phase 判据目前**没有**可用的观测依据",
        what_would_verify: "需要新的观测来源（如带球方向意图 / 传球选择集的观测出口）；本 change **不实现** #15B",
    },
    UnavailableItem {
        quantity: "传球当时的候选 / 选择集",
        reason: "引擎私有打分，sidecar 无出口（只有**结果**，没有**备选**）",
        what_would_verify: "引擎侧导出传球候选集与各自得分——须**另开 change**（引擎改动须自带 gate）",
    },
    UnavailableItem {
        quantity: "射门当时的 hazard 值本身",
        reason: "`compute_shot_score` 是引擎私有打分；其 5 个因子里 4 个的输入可得，\
                 **`cooldown_penalty` 的 `cooldown_ticks` 不可得**（`MatchState` 私有字段，`observation` 零出口）",
        what_would_verify: "引擎侧导出 `shot_cooldown_ticks`；或导出 hazard 分量本身",
    },
    UnavailableItem {
        quantity: "「因为压力大所以传丢」这类因果",
        reason: "sidecar 能给出压力状态与传递结果，**不能给出两者的因果**；相关 ≠ 因果",
        what_would_verify: "需要对照实验（同一局面改变单一变量）或引擎侧决策日志；本 change 只报共现，不报因果",
    },
];

// ============================== 口径常量（活读，不复制） ==============================

/// 接应口径**不在此声明**——它由 `#[path]` 包含的 `tests/p16/features.rs` 活读
/// （[`crate::features::SUPPORT_MAX_DIST_M`] / `SUPPORT_MIN_FORWARD_M`）。
///
/// ## 复盘：设计在两处都写着 `SUPPORT_MAX_DIST_M`，数值都是 25.0——同一个常量
///
/// 设计 §1 的初稿写「复制最小的口径常量 + 逐位比对守卫」，但因**本仓既成做法是 `#[path]`
/// 活读**（`p124/report.rs` 直接读 `crate::features::SUPPORT_MAX_DIST_M`），
/// 经用户拍板：**采用 `#[path]` including**。理由：
/// - 活读时**不存在漂移**——根本就不存在第二份常量（复制的守卫只能靠文本比对，
///   而文本比对挡不住「换个写法」的等价复制）；
/// - 代价（如实记录）：`tests/p16/features.rs` 被**两处**编译，p16 的改动会**静默**影响
///   p17b。**这一点由产物 provenance 兜**：接应阈值进 caliber 快照，阈值一变产物即不可比。
///
/// 同源哨兵仍保留（`support_caliber_is_live_read_from_p16_not_copied`）：
/// 它断言 p16 源码文本里的字面值与 p17b 运行时读到的值一致、且 p17b **自己没再声明一份**。
/// 这是防「有人为了消耦合把常量抄进来」——抄的那一刻，本哨兵与 provenance 都会说话。

/// 尾部窗口长度（拍）。**这是可调参数，不是判据**（同 P16 `WINDOW_SECONDS` 的地位）。
///
/// 取 **3 拍**的理由：诊断卡要展示「结束前发生了什么」，3 拍（实测 = 3 s，步长恒 1.0 s）
/// 足够覆盖最后一次决策动作到收束；再长会把上一段 possession 的尾部卷进来。
/// 实测（30 seed / 3075 episode）该窗口恒有 2–3 帧快照（0 帧 0 次）⇒ 不产生空窗。
pub const TAIL_TICKS: usize = 3;

/// 重开准备期窗口终点的**取值链**（`taken_t` 缺失时的行为，design §5 待决策 3 的闭合）。
///
/// ⚠️ 缺失**非零**（30 seed 实测 1613 个重开里 2 个；300 seed 实测 15584 个里 10 个，
/// ≈0.06%）⇒ **必须定义行为**（不能按「不会发生」处理），且行为要**可审计**：
/// 报告记下每个窗口用的是哪一档，而不是悄悄 fallback。
///
/// ## 实测：这条链上**只有两档真的会走到**（300 seed，实跑，非读码推断）
///
/// ```text
///   taken_t            15574
///   open_play_resumed_t    0   ← 一次都没走到
///   next_restart_start_t   0   ← 一次都没走到
///   stream_end            10   ← 10 例全部是流末的那条重开
/// ```
///
/// 中间两档是**防御性**的（`restart_windows` 要是一个**全函数**——任何输入都要给出
/// 确定的窗口右端）。它们**成立的条件**：`taken_t` 缺失但已恢复开放比赛 ⇒ 不变量 5
/// 被破坏；或缺失但后面还有**下一条**重开 ⇒ 本段被顶掉却没记下发球时刻。
/// 两者在当前引擎上都**不产生**（10 例缺 `taken_t` 的**全部**是流末那条，
/// 即没有下一条重开、也没有 `open_play_resumed_t`）。
///
/// ⇒ 守卫 [`crate::restart_window_falls_back_explicitly_when_taken_t_is_missing`]
/// 在**300 seed** 上核这个分布，并**在中间两档开始出现时判红**——
/// 那说明引擎的处置形态变了，值得人看一眼，而不是让产物悄悄跟着变。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum WindowEnd {
    /// 正常档：`taken_t`（重开发出的时刻）。
    Taken,
    // ⚠️ 中间两档**实测从不构造**（300 seed 全量为 0）。它们保留是因为
    // `restart_windows` 必须是一个**全函数**——任何输入都要给出确定的窗口右端。
    // `allow(dead_code)` 是**如实记录**「这两档当前不产生」，而不是假装它们在用：
    // 一旦它们开始被构造，`restart_window_falls_back_explicitly_when_taken_t_is_missing`
    // 的「防御档恒 0」哨兵会红，逼人核一眼。
    /// `taken_t` 缺失但已恢复开放比赛 ⇒ **不变量 5 被破坏**（有 `open_play_resumed_t`
    /// 就必须先有 `taken_t`）。当前引擎实测不产生；保留为全函数的防御档。
    #[allow(dead_code)]
    OpenPlayResumed,
    /// 两者都缺但**还有下一条重开**（本段被顶掉却未记发球时刻）。
    /// 当前引擎实测不产生；保留为全函数的防御档。
    NextRestartStart,
    /// 末段兜底：**没有下一条重开** ⇒ 窗口延到**事件流末端**。
    /// 这就是实测唯一会走到的 fallback（10/10）。
    StreamEnd,
}

impl WindowEnd {
    pub const fn as_str(self) -> &'static str {
        match self {
            WindowEnd::Taken => "taken_t",
            WindowEnd::OpenPlayResumed => "open_play_resumed_t",
            WindowEnd::NextRestartStart => "next_restart_start_t",
            WindowEnd::StreamEnd => "stream_end",
        }
    }
}
