//! P17B Slice 2：四类归因的**口径**与**措辞规则**。
//!
//! ## 本模块存在的理由：防「假覆盖」
//!
//! 诊断器最危险的失败不是「算错」，而是**声称能解释它看不见的东西**。
//! 侦察实测（30 seed）给出了这个失败的具体形态：占丢球 **36%** 的 `interception_loose`
//! **一次都不产 loose beat**（729/729）——如果报告只写一句「丢球后谁做了什么：可答」，
//! 读者会以为 100% 的丢球都有追逐过程可看，而真相是 **53.3% 的丢球上看不到**。
//!
//! ⇒ 本模块把「**每个 `ContestStartReason` 逐项声明覆盖**」做成**数据结构 + 守卫**：
//! 闭集里每多一个成员、而 [`CONTEST_COVERAGE`] 没跟上，测试就红
//! （`every_contest_start_reason_is_declared`）。这是本 change 的**立身之本**。
//!
//! ## 测得的覆盖缺口（30 seed，探针 `zz_17b_probe.rs` 实跑，非读码推断）
//!
//! | 成因 | 争抢数 | 产 loose beat | 覆盖 |
//! |---|---:|---:|---|
//! | `tackle_loose` | 434 | 434 | 全可答 |
//! | `pass_lost` | 212 | 198 | 部分（14 条同拍拾取，无追逐可看） |
//! | `delivery_loose` | 645 | 307 | 部分（338 条无 loose beat） |
//! | `shot_rebound` | 7 | 7 | 全可答（样本极小） |
//! | `interception_loose` | 729 | **0** | **恒不可见** |
//! | `unknown` | 0 | 0 | 生产路径不产出（闭集成员仍须声明） |
//!
//! ⚠️ **这些是 30 seed 的实测值，会随 seed 集变化**——守卫核的是「**声明存在**」，
//! 不是「数值等于这张表」。把数值写进断言 = 每次重跑都可能红，且那不是判据。

use fm_engine::observation::*;

// ============================== 覆盖声明 ==============================

/// 某成因下「丢球后追逐过程」是否可答。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContestVisibility {
    /// 产 loose beat ⇒ 能看到追球者（`chase`）与被追逐的段。
    Visible,
    /// **不产 loose beat** ⇒ 只能看到拾取者与归属，**看不到追逐过程**。
    Invisible,
    /// 该成因在**生产路径**上不产出（闭集成员仍须声明，免新增成员时漏项）。
    NotProduced,
}

impl ContestVisibility {
    pub const fn as_str(self) -> &'static str {
        match self {
            ContestVisibility::Visible => "追逐可见",
            ContestVisibility::Invisible => "追逐不可见",
            ContestVisibility::NotProduced => "生产路径不产出",
        }
    }
}

/// 一个争抢成因的覆盖声明（**逐项**，不允许笼统一句）。
#[derive(Debug, Clone, Copy)]
pub struct ContestCoverageRow {
    pub reason: ContestStartReason,
    pub visibility: ContestVisibility,
    /// 为什么是可见/不可见——必须能追到机制，不能只写「实测如此」。
    pub mechanism: &'static str,
}

/// **每个 `ContestStartReason` 的覆盖声明**（design §4.4.2 的落地）。
///
/// 覆盖的**机制**（不是「实测如此」）：loose beat 由 `advance_loose` 的**跑动阶段**产出
/// （球在滚、有人在追）；而 `interception_loose` 的拦截路径**把拦截者对账到拦截点**
/// （创建松散球时距离即 0），下一拍即拾取 ⇒ 不存在「跑动阶段」⇒ 恒无 loose beat。
/// `tackle_loose` 相反：抢断把球捅到约 5.25 m 外，追逐者必须先跑过去 ⇒ 恒有跑动阶段。
pub const CONTEST_COVERAGE: &[ContestCoverageRow] = &[
    ContestCoverageRow {
        reason: ContestStartReason::InterceptionLoose,
        visibility: ContestVisibility::Invisible,
        mechanism: "拦截路径把拦截者对账到拦截点（创建松散球时距离即 0）⇒ 同拍拾取，无跑动阶段 ⇒ \
                    **不产 loose beat**。实测 729/729。这是 P17A 的 A2（同拍收束）主因所在",
    },
    ContestCoverageRow {
        reason: ContestStartReason::TackleLoose,
        visibility: ContestVisibility::Visible,
        mechanism: "抢断把球捅到约 5.25 m 外（`deflect_point`）⇒ 追逐者必须先跑过去 ⇒ 产出跑动阶段。实测 434/434",
    },
    ContestCoverageRow {
        reason: ContestStartReason::PassLost,
        visibility: ContestVisibility::Visible,
        mechanism: "传球失准后球在场上滚动 ⇒ 跑动阶段存在。**但非全部**：若追逐者当刻已在拾取半径内，\
                    则同拍拾取、无跑动阶段（实测 212 中 14 条如此）⇒ 本行声明的是**该成因整体可见**，\
                    单条 episode 仍可能记「追逐不可见」（报告逐条判，不按成因一刀切）",
    },
    ContestCoverageRow {
        reason: ContestStartReason::DeliveryLoose,
        visibility: ContestVisibility::Visible,
        mechanism: "定位球/解围发出后的落点争抢：球飞行后落地滚动 ⇒ 跑动阶段存在。\
                    **但非全部**（实测 645 中 307 条产 loose beat；其余为落点直接争到 / 飞行段）",
    },
    ContestCoverageRow {
        reason: ContestStartReason::ShotRebound,
        visibility: ContestVisibility::Visible,
        mechanism: "射门被扑/击中门框后弹回场内 ⇒ 跑动阶段存在。实测 7/7（样本极小，报告须标样本量）",
    },
    ContestCoverageRow {
        reason: ContestStartReason::Unknown,
        visibility: ContestVisibility::NotProduced,
        mechanism: "证据不足才用该值；开放比赛路径**不产出**它（保留在闭集里是为了在输入形状变化时\
                    能被**显式**看见，而不是被默默归到别的成因）",
    },
];

/// 在**任意**声明表里查某成因的覆盖声明；`None` = **未声明**。
///
/// ⚠️ 拆出这个函数是为了让反证条能对**真实现**判红（审阅 P2-2）：初版的
/// `contest_coverage_guard_has_discriminating_power` 用**本地副本表**做
/// `filter` + `find`，是同义反复，**根本没调用 `coverage_of`**——
/// 实测给 `coverage_of` 加一条「查不到就兜底返回第一行」的变异时，
/// 覆盖缺口门**全绿**（而那条兜底会让**未声明**的成因被静默当成已声明，
/// 正是 BLOCKER-1 的复发形态）。现在守卫可以直接对 `coverage_in` 喂一张
/// **缺项的表**并断言 `None`。
pub fn coverage_in(
    table: &[ContestCoverageRow],
    reason: ContestStartReason,
) -> Option<&ContestCoverageRow> {
    table.iter().find(|r| r.reason == reason)
}

/// 取某成因的覆盖声明；`None` = **未声明**（守卫会红）。
///
/// **实现必须只经过 [`coverage_in`]**——不得有任何兜底（见上）。
pub fn coverage_of(reason: ContestStartReason) -> Option<&'static ContestCoverageRow> {
    coverage_in(CONTEST_COVERAGE, reason)
}

/// 某成因**整体**是否可能看到追逐过程（用于报告的表头）。
///
/// ⚠️ **这不是「这条丢球可答」**——`Visible` 的成因仍可能单条不可见（见 `PassLost` 的说明）。
/// 报告必须**逐条**判（`EpisodeCard::pursuit`），本函数只用于**聚合表的分组成因栏**。
pub fn reason_is_ever_visible(reason: ContestStartReason) -> bool {
    matches!(
        coverage_of(reason).map(|r| r.visibility),
        Some(ContestVisibility::Visible)
    )
}

// ============================== 闭合性提醒 ==============================

/// 闭集成员数（守卫用：`CONTEST_COVERAGE` 的条数必须等于它）。
pub fn contest_reason_count() -> usize {
    ContestStartReason::ALL.len()
}

// ============================== P17A 异常规则的逐 episode 覆盖 ==============================

/// 一条 P17A 异常规则在本层（逐 episode）的**可覆盖性声明**。
///
/// ## 为什么需要这张表（spec 的 Scenario「覆盖 P17A 点名的异常样本（在证据边界内）」）
///
/// spec 要求：对 P17A 触发的**每条**异常规则，报告给出对应的逐 episode 样本，
/// **或**逐条说明它落在哪条证据边界之外。设计已判定「每条异常都能找到样本」**做不到**——
/// A2（同拍收束）的样本恰好全落在「不产 loose beat」的盲区里。
/// ⇒ 这张表把「可覆盖 / 落在盲区」**逐条**写死，并由守卫核对**规则集合与 P17A 一致**。
#[derive(Debug, Clone, Copy)]
pub struct AnomalyCoverageRow {
    /// P17A 的规则 id。
    pub rule: &'static str,
    /// P17A 那条规则讲什么（一句话）。
    pub topic: &'static str,
    /// 本层是否能给出**逐 episode 样本**。
    pub per_episode_samples: bool,
    /// 落在哪条边界之外 / 本层的对应物是什么。**即使是可覆盖的也要写**——
    /// 「可覆盖」不是一个可以留空的断言。
    pub note: &'static str,
}

/// P17A 十条规则在本层的覆盖声明（**逐条**，不许给笼统的「可答」）。
///
/// ⚠️ **这条边界是本 change 最重要的如实记录**：A2 / A3 的**归属事实**可覆盖，
/// 但它们关心的**追逐过程**（谁在追、追了多久）在 `interception_loose` 上
/// **落在盲区外**——那正是 A2 样本最集中的地方。
pub const ANOMALY_COVERAGE: &[AnomalyCoverageRow] = &[
    AnomalyCoverageRow {
        rule: "A1",
        topic: "持球-出球节奏：possession 内相邻动作间隔过大",
        per_episode_samples: true,
        note: "本层对应 `long_dwell` 筛子（逐 episode 的相邻决策动作最大间隔）；产物卡的 `chain` 逐节点给**事件下标与时刻**",
    },
    AnomalyCoverageRow {
        rule: "A2",
        topic: "争抢时长退化：多数松散球同 tick 被拾回",
        per_episode_samples: true,
        note: "**部分覆盖，有两层缺口**：\n\
               （a）本层的 `instant_contest` 只覆盖 A2 母体的 **~70%**——A2 数**全部**零时长争抢\n\
               （300 seed 实测 10564/20053），而诊断卡只能展开**收束了一段 episode 的**那些\n\
               （实测 7364）；余下约 30% 发生在「控制已释放、球还在飞」的**两段 episode 之间**，\n\
               在 L2 的争抢成因表里数得到，但没有 card 可挂；\n\
               （b）A2 关心的**追逐过程**在其主因 `interception_loose` 上**落在盲区**——\n\
               该成因 729/729 不产 loose beat，诊断卡的【丢球后】一节只能记「追逐不可见」",
    },
    AnomalyCoverageRow {
        rule: "A3",
        topic: "丢球后归属由争抢原因决定（夺回率按原因分化）",
        per_episode_samples: true,
        note: "本层给每段的 `contest_start` 成因（产物键）与收束事实下标。\
               ⚠️ **拾取方（队/人）须由消费方拿该下标回原对象读**（`ControlFact.team` 与\
               `ControlFact.player`，故意不进产物）；且同样**不含**追逐过程——理由同 A2",
    },
    AnomalyCoverageRow {
        rule: "A4",
        topic: "重开交付之后球权立刻丢失",
        per_episode_samples: true,
        note: "本层给 `start_reason`（`restart_control`）+ 链首动作 token + 段时长（`duration_s`）。\
               ⚠️ **产物里没有逐条的重开窗右端来源**——重开窗只用于**内部判据**\
               （排除准备期），不随产物导出",
    },
    AnomalyCoverageRow {
        rule: "A5",
        topic: "射门几乎是单动作/单传球的产物",
        per_episode_samples: true,
        note: "本层给逐段的完整动作链（`chain`），射门前传球数可由链直接读出",
    },
    AnomalyCoverageRow {
        rule: "A6",
        topic: "空转 possession：持续久但动作极少",
        per_episode_samples: true,
        note: "本层对应 `empty_possession` 筛子；产物卡的 `duration_s` 即 `PossessionEpisode.start_t,end_t` 之差",
    },
    AnomalyCoverageRow {
        rule: "A7",
        topic: "重开准备期常数化（同种重开时长零方差）",
        per_episode_samples: true,
        note: "**本层不给逐条重开窗**（重开窗只用于内部判据）——\
               与 A7 的关系只有「本层用重开窗排除了准备期的松散球」这一条；\
               ⚠️ 产物的卡里**没有**重开窗的起止或右端来源",
    },
    AnomalyCoverageRow {
        rule: "A8",
        topic: "丢球/争抢位置集中在中央 40% 区间",
        per_episode_samples: true,
        note: "本层给收束侧事实下标（`closing_fact_index`）**与争抢窗**（`contest_window`），\
               但**产物里没有位置字段**——`ControlFact.location` 须由消费方拿该下标回原对象读。\
               ⚠️ 不得用决策动作的 `Event.x,y` 顶替（P16 口径 1：那是动作主体的位置）",
    },
    AnomalyCoverageRow {
        rule: "A9",
        topic: "缺少多脚开放比赛传递（链深分布）",
        per_episode_samples: true,
        note: "本层给逐段动作链；开放比赛成功传球数可由链上 token（`pass+` 且非交付）读出",
    },
    AnomalyCoverageRow {
        rule: "A10",
        topic: "`pass_lost` 之后球权仍在原队（失败传球不造成失球）",
        per_episode_samples: true,
        note: "本层给 `contest_start` 成因 + 收束事实下标 + 争抢窗（`contest_window`）。\
               ⚠️ **产物里没有「下一段」的字段**——要判「球权是否回到原队」须由消费方\
               拿 `event_indexes` / 时间回原对象读下一段；单张卡**看不到**",
    },
];

/// 取某条 P17A 规则的覆盖声明。
pub fn anomaly_coverage_of(rule: &str) -> Option<&'static AnomalyCoverageRow> {
    ANOMALY_COVERAGE.iter().find(|r| r.rule == rule)
}

// ============================== 措辞规则 ==============================

/// 措辞规则：**每条结论该怎么说**。
///
/// 这些是**报告模板**要遵守的规则，也是 `p17b_diagnosis_report.rs` 的措辞守卫的判据来源。
/// 规则本身**成对**给出「可说」与「不可说」——只给禁令无法核对「那该怎么说」。
#[derive(Debug, Clone, Copy)]
pub struct WordingRule {
    /// 规则名（守卫与报告引用它）。
    pub name: &'static str,
    /// 允许的说法。
    pub allowed: &'static str,
    /// 禁止的说法（及其为什么禁止）。
    pub forbidden: &'static str,
    pub why: &'static str,
}

pub const WORDING_RULES: &[WordingRule] = &[
    WordingRule {
        name: "动作：分类而非并称",
        allowed: "`chase`（靶点恒为球，可称追球）；`close_down` 单列并标注其靶点来源",
        forbidden: "把 `chase` 与 `close_down` 并称「追球者」",
        why: "`close_down` 的靶点按 `TransitionSource` 分流——源码上 `Tackle → st.ball_pos`、\
              `SaveCaught → attacking_forward(..)`（**前插球员**）。并称会让读者以为它们都在追球。\
              ⚠️ **不要用「距球远」当追人的证据**（审阅轮 2 推翻）：`close_down_stop` 只推进约 2 m、\
              打不到靶点，远端球员的终点天然离球远（实测 8 seed 全部朝球逼近）。\
              实测 `SaveCaught` 分流只占 `close_down` 的约 **9.9%**（30 seed 215/2162）。",
    },
    WordingRule {
        name: "压力：报状态不报因果",
        allowed: "「这一拍 `pressure_state_ticks = 0`」（报状态）",
        forbidden: "「因为压力小所以选择传球」（报因果）",
        why: "因果是**机制假设**，未验证；且 `pressure_state_ticks` 是**剩余保持 tick 数**，不是强度。\
              P124 实测 `pressure_*` 对 phase 的 AUC = 0.372（无判别力）",
    },
    WordingRule {
        name: "转换：报事件级不报相位",
        allowed: "`EpisodeStartReason` / `EpisodeEndReason` / `ContestStartReason` 的取值",
        forbidden: "战术相位名（三档 phase 成员名）",
        why: "#16（空间）与 #124（意图）**双双**判定 phase 不可判——phase 判据目前没有可用的观测依据。\
              本 change **不实现** #15B，也不为它背书",
    },
    WordingRule {
        name: "传球：只报结果",
        allowed: "「这次传球的结果是 `intercepted`」（报结果）",
        forbidden: "「因为…所以传了」（报选择理由）",
        why: "传球**没有选择集**（引擎私有打分，sidecar 无出口）——只有结果，没有备选",
    },
    WordingRule {
        name: "观察不可信：标注且不进聚合",
        allowed: "标注 `观察不可信` 并**保留**该卡（读者能看到它的完整证据与缺陷）",
        forbidden: "把不自洽的 seed **静默**混进 L2 聚合的分子/分母",
        why: "前置门（design §3.0）：观察不可信时诊断无意义。但**不排除**该卡——\
              拒答会隐藏「观察层本身有问题」这个更重要的信号（用户拍板：标注但保留）",
    },
];
