//! P124 Slice 1：**重新净化 motif 混淆**（本 change 的前置，先于任何新信号）。
//!
//! ## 要净化什么
//!
//! P16 的裁决里，`build_up` 与 `progression` 的参考集定义**同时**在两处不同：
//!
//! | 混淆量 | `build_up` | `progression` |
//! |---|---|---|
//! | 是否从重开开始（`from_restart`） | **是** | **否** |
//! | 开放成功传球数（`open_success_passes`） | **≥3** | **≥1** |
//!
//! 故「用某个量把这两档分开」既可能是战术形态，也可能只是「重开与否」或
//! 「传了几脚」——**后者与 motif 定义本身同源，是循环的**。
//!
//! ## 净化的做法：逐条抽掉，看 AUC 是否塌回 0.5
//!
//! 构造**四个臂**，每臂把上表的一个（或两个）判别子句抹平，
//! 其余不变，再用**同一套特征与同一个 AUC 实现**重算：
//!
//! | 臂 | `build_up` 谓词 | `progression` 谓词 | 抽掉了什么 |
//! |---|---|---|---|
//! | [`ARM_CURRENT`] | `R ∧ P≥3 ∧ ¬S` | `¬R ∧ P≥1 ∧ ¬S` | （基线，什么都不抽） |
//! | [`ARM_DROP_RESTART`] | `P≥3 ∧ ¬S` | `P≥1 ∧ ¬S` | 是否重开 |
//! | [`ARM_DROP_PASSCOUNT`] | `R ∧ ¬S` | `¬R ∧ ¬S` | 传球数 |
//! | [`ARM_EMPTY_CONTROL`] | `¬S` | `¬S` | **两个都抽**（空对照） |
//!
//! （`R` = `from_restart`，`P` = `open_success_passes`，`S` = `has_shot`。）
//!
//! **空对照是本模块的核心**：两臂谓词**逐字相同** ⇒ 两侧是同一个多重集合 ⇒
//! 取值必须**逐位相等**（主判据），AUC 必须**无偏**于 0.5（兜底判据）。
//! 任何偏离都说明**比较本身有偏**（一侧被额外过滤 / 下标不同步）。
//!
//! ⚠️ **不**断言「AUC 恰好 0.5」：P16 的 AUC 带一个**不对称的**并列容差
//! （两个不同 episode 的取值相差 `< 1e-12` 时，`(x,y)` 判胜而 `(y,x)` 判并列），
//! 实测可让同集合两侧偏离 0.5 约 **1.2e-5**。机制与逐对计数见
//! [`empty_control_auc_is_unbiased`] 的 doc——那是**观测到的机制，不是猜测**。
//!
//! ## 两条对照的分工（**缺一不可，别把任一条当充分**）
//!
//! - **空对照**（[`ARM_EMPTY_CONTROL`]）证明比较**无系统偏置**（结构性：两侧取值逐位
//!   相等）——但它**抓不到**对称的 join bug：两臂用同一个错下标时，集合仍然相同，
//!   逐位相等与 AUC≈0.5 都照样成立。
//! - **反证条**（[`counter_proof_final_third`]）证明管线**仍有判别力**——
//!   已知应给高分的 `final_third` 必须复现 ≈0.855；join bug 会把它摊平到 ~0.5。
//!
//! ⇒ 空对照管「不偏」，反证条管「没坏」。**P16 的假证据形态 2（`flatten` 压缩索引
//! 使 0.855 变 0.493）正是靠反证条抓的**，空对照对它无感。
//!
//! ## 本模块为什么不碰位置
//!
//! 四个臂的谓词只读 [`ActionFacts`] 的四个字段（传球数 / 是否射门 / 收尾动作 /
//! 是否重开），**没有任何位置量**。这不是纪律声明，是**类型隔离**：
//! `ActionFacts` 结构上就没有位置字段（见 `p16/reference.rs` 的说明）。

use crate::probe::{complement, rate_auc, set_where, Pooled, RateAuc};
use crate::reference::ActionFacts;

/// 一个净化臂：两档的谓词 + 它抽掉了什么。
pub struct PurifyArm {
    /// 臂名（报告与断言里引用）。
    pub name: &'static str,
    /// 它**抽掉**的混淆量（人读用；空对照写「两个都抽」）。
    pub removes: &'static str,
    /// `build_up` 档的谓词。
    pub build_up: fn(&ActionFacts) -> bool,
    /// `progression` 档的谓词。
    pub progression: fn(&ActionFacts) -> bool,
}

/// **基线臂**：P16 的原定义（重开 + 传球数**同时**不同）。
pub const ARM_CURRENT: PurifyArm = PurifyArm {
    name: "current[p16 原定义]",
    removes: "（基线，什么都不抽）",
    build_up: |f| f.from_restart && f.open_success_passes >= 3 && !f.has_shot,
    progression: |f| !f.from_restart && f.open_success_passes >= 1 && !f.has_shot,
};

/// 抽掉「是否重开」：两档**只**在传球数上不同。
///
/// ⚠️ 此时 `build_up ⊆ progression`（`P≥3 ⇒ P≥1`）——这不是错误，是「只留传球数」
/// 这个对照的必然形态。AUC 的分母因此含重叠。
pub const ARM_DROP_RESTART: PurifyArm = PurifyArm {
    name: "drop_restart[只留传球数]",
    removes: "是否重开",
    build_up: |f| f.open_success_passes >= 3 && !f.has_shot,
    progression: |f| f.open_success_passes >= 1 && !f.has_shot,
};

/// 抽掉「传球数」：两档**只**在是否重开上不同。
///
/// 此时两档在 `¬S` 内**互补**（`R` 与 `¬R`）。
pub const ARM_DROP_PASSCOUNT: PurifyArm = PurifyArm {
    name: "drop_passcount[只留是否重开]",
    removes: "传球数",
    build_up: |f| f.from_restart && !f.has_shot,
    progression: |f| !f.from_restart && !f.has_shot,
};

/// **空对照**：两个混淆量都抽掉 ⇒ 两档谓词**逐字相同** ⇒ 两侧是同一个集合。
///
/// 它是本模块的**探针自检**：两侧取值必须逐位相等、AUC 必须无偏于 0.5
/// （判据与其浮点残差的机制见 [`empty_control_auc_is_unbiased`]）。
pub const ARM_EMPTY_CONTROL: PurifyArm = PurifyArm {
    name: "empty_control[两个都抽]",
    removes: "两个都抽（空对照）",
    build_up: |f| !f.has_shot,
    progression: |f| !f.has_shot,
};

/// 全部四个臂（报告与断言按此顺序遍历）。
pub const PURIFY_ARMS: &[PurifyArm] = &[
    ARM_CURRENT,
    ARM_DROP_RESTART,
    ARM_DROP_PASSCOUNT,
    ARM_EMPTY_CONTROL,
];

/// 一个臂的两档集合（全局下标）。
pub struct ArmSets {
    pub build_up: Vec<usize>,
    pub progression: Vec<usize>,
}

/// 在池化空间里按臂的谓词取出两档集合。
pub fn arm_sets(p: &Pooled, arm: &PurifyArm) -> ArmSets {
    ArmSets {
        build_up: set_where(p, arm.build_up),
        progression: set_where(p, arm.progression),
    }
}

/// 用**球门向推进速率**（[`crate::probe::forward_rate`]）算该臂的 `build_up` vs `progression` AUC。
pub fn arm_auc(p: &Pooled, arm: &PurifyArm) -> RateAuc {
    let s = arm_sets(p, arm);
    rate_auc(
        p,
        &s.build_up,
        &s.progression,
        &format!("{}:forward_m/s", arm.name),
        crate::probe::forward_rate,
    )
}

// ============================== 反证条（P16 假证据形态 2 的直接防线） ==============================

/// P16 三档 motif 名 → 谓词。**与 `p16/reference.rs::reference_set` 必须逐字一致**——
/// 由 `motif_predicates_agree_with_the_p16_reference_set` 守（防止两处口径分叉）。
pub fn motif_pred(name: &str) -> fn(&ActionFacts) -> bool {
    match name {
        "final_third_candidate" => |f| f.ends_shot,
        "build_up_candidate" => |f| f.from_restart && f.open_success_passes >= 3 && !f.has_shot,
        "progression_candidate" => |f| !f.from_restart && f.open_success_passes >= 1 && !f.has_shot,
        _ => |_| false,
    }
}

/// **反证条**：已知应给高分的 `final_third`（P16 实测 0.855 / 30 seed）。
///
/// 它与净化臂**共用**同一条特征函数（[`crate::probe::forward_rate`]）、同一个
/// [`rate_auc`] 实现、同一个池化空间。故：
///
/// - 探针若因 `flatten` 之类压缩了索引空间 ⇒ 本值会塌向 0.5 ⇒ **判红**；
/// - 探针若把 NaN 静默吞掉 ⇒ [`crate::probe::require_finite`] 当场判红。
///
/// ⚠️ **它单独立在净化臂之外**，因为它的作用不是「净化」而是「证明管线没坏」——
/// 任何一次净化运行都应**先**跑它。
pub fn counter_proof_final_third(p: &Pooled) -> RateAuc {
    let final_set = set_where(p, motif_pred("final_third_candidate"));
    let rest = complement(p, &final_set);
    rate_auc(p, &final_set, &rest, "counter_proof:final_third", crate::probe::forward_rate)
}

/// 本 change 对反证条的**期望带**（P16 的 30 seed 实测 = 0.855）。
///
/// ⚠️ **口径不可跨 seed 数互换**：P16 的 300 seed 基线是 0.862，与 0.855 不是同一个数。
/// 本常量只对 [`crate::pool::GATE_SEEDS`]（30 seed）成立。
pub const COUNTER_PROOF_EXPECTED: f64 = 0.855;
/// 反证条的容差。取 ±0.05：够松以容纳「池化顺序/浮点」的极小扰动，
/// 够紧以让**任何把它摊平到 0.5 的 join bug** 判红（0.855−0.05 = 0.805 ≫ 0.5）。
pub const COUNTER_PROOF_TOL: f64 = 0.05;

/// 判反证条是否落在期望带内（**不 panic**，由调用侧决定怎么报）。
pub fn counter_proof_is_intact(r: &RateAuc) -> bool {
    r.auc
        .map(|a| (a - COUNTER_PROOF_EXPECTED).abs() <= COUNTER_PROOF_TOL)
        .unwrap_or(false)
}

/// 空对照的 AUC 是否**无偏**（落在 0.5 附近）。
///
/// ## ⚠️ 为什么不是「恰好 0.5」——实测的机制（本 change 的探针发现）
///
/// 数学上，两侧是**同一个多重集合**时秩基 AUC **必须**恰好 0.5：
/// 对每一对 `(p_i, n_j)`，其对称对 `(p_j, n_i)` 给相反的贡献，
/// 故「胜」与「负」逐对抵消（n=2248 时精确到整数：`gt == lt`、`wins = n²/2`）。
///
/// **但 P16 的 AUC 实现带一个并列容差**：`(p − n).abs() < 1e-12` 记 0.5，
/// 否则记 1 或 0（见 `p16/gate.rs::auc`）。这个容差**对近并列值不对称**：
/// 设两个**不同** episode 的取值 `x > y` 且 `x − y < 1e-12`，则
/// `(x, y)` 判为**胜**（1.0，因为 `x > y` 为真），而 `(y, x)` 判为**并列**（0.5）——
/// 同一对在两个方向上的贡献和为 1.5，而「无容差」时是 1.0。抵消被打破。
///
/// 实测（30 seed、空对照臂、`forward_m/s`，n = 2248）：
/// `gt = 2525528`、`lt = 2525405`（**差 123**）、`eq = 2571`、总对 `= 2248² = 5053504`。
/// 123 正是**无序近并列对的个数**（每对贡献 `gt+1` 与 `eq+1`），
/// 残差 `= 0.5 × 123 / 5053504 = 1.22e-5`。近并列值的来源是
/// `forward_m / duration_s` 的浮点除法——不同 episode 却落在同一个 ulp 邻域。
///
/// ⚠️ **这是观测到的机制，不是猜测**：它由一次性探针逐对计数验证
/// （`gt` / `lt` / `eq` 三个整数 + `gt − lt == 无序近并列对数`）。
/// 它**不影响任何结论**（1e-5 量级），但它解释了「为什么不能断言恰好 0.5」——
/// 以及为什么**结构性的逐位相等检查才是主判据**。
///
/// ## 判据怎么取（两条互补，别只留一条）
///
/// - **结构性**（强）：两侧**取值逐位相等**——见
///   [`crate::probe::values_are_identical`]。不受任何容差影响，偏置多小都会红。
/// - **数值性**（本函数，弱，作兜底）：`|AUC − 0.5| ≤ 1e-3`。
///   实测残差 1.2e-5，留 ~80 倍余量；而真实的偏置（一侧被过滤 1%）会给 ~5e-3、
///   join bug 会给 ~5e-2 以上——**都远在带外**。
pub fn empty_control_auc_is_unbiased(r: &RateAuc) -> bool {
    r.auc.map(|a| (a - 0.5).abs() <= 1e-3).unwrap_or(false)
}

/// 空对照残差的**实测上界**（口径：30 seed / `forward_m/s`）。
///
/// ⚠️ 这是**观测值不是判据**——它的存在是为了让「1e-3 的容差是否合理」可被核对，
/// 而不是被当成又一条阈值写死。判据见 [`empty_control_auc_is_unbiased`]。
pub const EMPTY_CONTROL_RESIDUAL_OBSERVED: f64 = 1.2e-5;

/// 一个臂在报告里的一行。
#[derive(Debug, Clone)]
pub struct ArmRow {
    pub name: &'static str,
    pub removes: &'static str,
    pub auc: Option<f64>,
    pub build_n: usize,
    pub prog_n: usize,
    pub skipped_in_set: usize,
}

impl ArmRow {
    pub fn of(p: &Pooled, arm: &PurifyArm) -> Self {
        let s = arm_sets(p, arm);
        let r = arm_auc(p, arm);
        ArmRow {
            name: arm.name,
            removes: arm.removes,
            auc: r.auc,
            build_n: s.build_up.len(),
            prog_n: s.progression.len(),
            skipped_in_set: r.skipped_in_set,
        }
    }
}

/// 某档集合是否**非空**——空集会让 AUC 变成 `None` 而不是低分，
/// 二者含义完全不同：前者是「算不出」，后者是「算得出但分不开」。
impl ArmSets {
    pub fn both_non_empty(&self) -> bool {
        !self.build_up.is_empty() && !self.progression.is_empty()
    }
}

/// 按臂名取回臂（供报告行 → 集合的核对）。
///
/// 名字不存在时 **panic**——静默返回一个占位臂会让「报告里的臂」与「实际算的臂」
/// 悄悄分叉（本仓「结论对但机制错」的同型风险）。
pub fn arm_of(name: &str) -> &'static PurifyArm {
    PURIFY_ARMS
        .iter()
        .find(|a| a.name == name)
        .unwrap_or_else(|| panic!("报告里的臂名 `{name}` 不在 PURIFY_ARMS 里——两处已分叉"))
}
