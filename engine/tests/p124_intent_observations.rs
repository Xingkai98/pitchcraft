//! P124（#124）：意图类观测 + 重跑 phaseability gate。
//!
//! 本 change 是 **P16（#123）的续作**。P16 用**空间特征**裁决三档 phase，
//! 结论是**部分够**：`final_third` 可判（`forward_m/s` AUC 0.855 / 30 seed），
//! `build_up` / `progression` **判不了**（0.461）。P16 的审阅者自己扫了 21 个空间量，
//! 最强非循环量只 0.634 ⇒ **「空间量本身不足」**，不是「特征没选好」。
//!
//! 本 change 接出**意图类观测**（起脚窗口 / 防守动作 / 压迫），重跑 gate，并给裁决。
//!
//! ## 分层（对齐 `CLAUDE.md` 的分层验证表）
//!
//! | 本文件的测试 | 判据层 | 默认跑? |
//! |---|---|---|
//! | [`counter_proof_confirms_the_probe_is_intact`] | 探针（**反证条**，先于任何净化数字） | ✅ |
//! | [`empty_control_is_unbiased`] | 探针（空对照 = 无系统偏置） | ✅ |
//! | [`probe_rejects_non_finite_and_never_hides_skips`] | 探针（**判别力**：NaN / 跳过数） | ✅ |
//! | [`pool_rejects_index_space_mismatch`] | 探针（**判别力**：索引空间错位即红） | ✅ |
//! | [`motif_predicates_agree_with_the_p16_reference_set`] | 净化（谓词与 P16 同源） | ✅ |
//! | [`purification_reproduces_the_p16_verdict`] | 净化（本 change 的 Slice 1 产出） | ✅ |
//! | [`intent_export_is_tick_aligned_with_positions`] | 意图接出（两条通道同拍） | ✅ |
//! | [`intent_export_never_enters_the_formal_path`] | 意图接出（正式路径逐字节 + 空操作） | ✅ |
//! | [`intent_semantics_are_pinned`] | 意图接出（三态语义被钉住） | ✅ |
//! | [`defensive_intents_are_sparse_and_well_formed`] | 意图接出（稀疏 + 分母 + `defender` 语义） | ✅ |
//! | [`contact_intents_match_the_event_stream`] | 意图接出（**独立来源**交叉核对） | ✅ |
//! | [`committed_is_not_observable_at_the_per_tick_sampling_point`] | 意图接出（**已知缺口**被钉住） | ✅ |
//! | [`intent_features_share_the_index_space_with_calibers`] | 意图特征（下标空间同 P16） | ✅ |
//! | [`intent_features_cannot_reach_positions`] | 意图特征（**铁律**：够不着位置） | ✅ |
//! | [`intent_feature_coverage_is_reported`] | 意图特征（覆盖率 + 缺失分类） | ✅ |
//! | [`def_share_is_none_when_there_was_no_opportunity`] | 意图特征（缺失语义） | ✅ |
//! | [`defensive_intents_are_attributed_by_time_window_not_by_index`] | 意图特征（**时间窗归因**，变异逼出） | ✅ |
//!
//! 跑法：
//!
//! ```text
//! cargo test --test p124_intent_observations
//! ```
//!
//! **行号引用会漂**：本文件的注释与文档一律用**符号名**，不写 `lib.rs:NNNN`。

#[path = "p124/probe.rs"]
mod probe;
#[path = "p124/purify.rs"]
mod purify;
#[path = "p124/pool.rs"]
mod pool;
#[path = "p124/intent.rs"]
mod intent;

// 复用 P16 的管线（**只读**：不改 `tests/p16/*`，只 include 其模块）。
//
// ⚠️ `allow(dead_code)`：本测试只用到 P16 管线的一个子集（口径 / 特征 / 参考集 / AUC），
// 而 P16 的模块还导出覆盖率、报告、产物等**本 change 不用**的项。允许它们闲置，
// **不得**为了消警告去改 `tests/p16/*`（那是 P16 的已交付代码，本 change 只读它）。
#[allow(dead_code)]
#[path = "p16/caliber.rs"]
mod caliber;
#[allow(dead_code)]
#[path = "p16/shape.rs"]
mod shape;
#[allow(dead_code)]
#[path = "p16/features.rs"]
mod features;
#[allow(dead_code)]
#[path = "p16/gate.rs"]
mod gate;
#[allow(dead_code, unused_imports)]
#[path = "p16/reference.rs"]
mod reference;

use fm_engine::observation::{
    BehaviorObservationRecorder, DefensiveIntent, DefensiveIntentKind, DiagnosticMatch,
    IntentSnapshot, IntentState, ObservedTime,
};
use pool::*;
use probe::*;
use purify::*;

// ============================== Slice 1：探针纪律的自检 ==============================

/// **反证条**：已知应给高分的 `final_third` 必须复现 P16 的 ≈0.855。
///
/// ⚠️ **本测试必须先于任何净化数字跑**（design §4：「一条已知应给高分的对照先跑通，
/// 否则探针坏了结论不可信」）。它单独立在这里而不是塞进净化测试，
/// 是为了让「管线没坏」与「净化结论是什么」在报告里**分开可读**。
///
/// 它抓的是 **P16 假证据形态 2**：主 session 在净化探针里用 `flatten()` 丢 `None`，
/// 压缩了索引空间，把 0.855 算成 **0.493**。本 change 的 [`Pooled`] 结构上禁止
/// 这种压缩（`feats` 与 `facts` 同长同索引 + 构造时断言），本测试证明它确实生效。
///
/// 它**不**（也做不到）抓对称的 join bug——那由 [`empty_control_is_unbiased`] 配合：
/// 空对照管「不偏」，反证条管「没坏」，**缺一不可**。
#[test]
fn counter_proof_confirms_the_probe_is_intact() {
    let p = pool_gate_seeds();
    let r = counter_proof_final_third(&p);
    println!(
        "反证条 final_third vs 其余（forward_m/s）：AUC = {:?}  [pos={} neg={} 跳过={}]\n  \
         口径：{}（期望 {COUNTER_PROOF_EXPECTED:.3} ± {COUNTER_PROOF_TOL:.2}）",
        r.auc.map(|a| (a * 1000.0).round() / 1000.0),
        r.pos_n,
        r.neg_n,
        r.skipped_in_set,
        p.caliber_line()
    );
    assert!(
        r.auc.is_some(),
        "反证条算不出 AUC（pos={}, neg={}）——样本或谓词有问题",
        r.pos_n,
        r.neg_n
    );
    let auc = r.auc.unwrap();
    assert!(
        counter_proof_is_intact(&r),
        "**反证条判红**：final_third 的 forward_m/s AUC = {auc:.3}，落在期望带 \
         [{:.3}, {:.3}] 之外（P16 的 30 seed 实测 {COUNTER_PROOF_EXPECTED:.3}）。\n\
         这不是「结论变了」，是**探针坏了**——按 P16 的血泪史逐条查：\n\
         ① 索引空间是否被压缩（`flatten` / 过滤掉 `None` 后没抬 offset）——本次实测值 \
         {auc:.3}{}；\n\
         ② 是否有非有限值被静默吞掉（`require_finite` 是否真的挂在逐值路径上）；\n\
         ③ 池化下标是否跨 seed 重叠（`pool_episodes` 的三处 `assert_eq!` 是否被绕过）。",
        COUNTER_PROOF_EXPECTED - COUNTER_PROOF_TOL,
        COUNTER_PROOF_EXPECTED + COUNTER_PROOF_TOL,
        if (auc - 0.5).abs() < 0.1 {
            "——**≈0.5 正是 `flatten` 压缩索引空间的签名**"
        } else {
            ""
        }
    );
}

/// **空对照**——「比较本身没有系统偏置」的证据。
///
/// `ARM_EMPTY_CONTROL` 把两档谓词抹平成**逐字相同**（`¬S`），故两侧是**同一个集合**。
///
/// ## 判据取两条（**结构性为主，数值性为辅**）
///
/// 1. **结构性**：两侧取值**逐位相等**（[`values_are_identical`]）。
///    不受任何浮点容差影响，偏置多小都会红——这才是主判据。
/// 2. **数值性**：`|AUC − 0.5| ≤ 1e-3`（[`empty_control_auc_is_unbiased`]）。
///
/// ## ⚠️ 为什么**不**断言「恰好 0.5」——本 change 探针实测的机制
///
/// 数学上同一个多重集合两侧应恰好 0.5（对称对抵消）。但 P16 的 AUC 带一个
/// **不对称的**并列容差：两个不同 episode 的取值若相差 `< 1e-12`，
/// 则 `(x,y)` 判胜（1.0）而 `(y,x)` 判并列（0.5），贡献和 1.5 ≠ 1.0。
/// 实测 gt−lt = **123**（= 无序近并列对数）、n = 2248 ⇒ 残差 **1.22e-5**。
/// 机制与整数的逐对计数见 [`empty_control_auc_is_unbiased`] 的 doc。
///
/// ⇒ 断言「恰好 0.5」会**因为一个与偏置无关的浮点细节**判红——
/// 那是把探针本身的口径当成了被检验的偏置（本仓「结论对但机制错」的同型风险）。
///
/// ⚠️ **它抓不到对称的 join bug**：两臂用同一个错下标时集合仍然相同，
/// 逐位相等与 AUC=0.5 都照样成立。抓 join bug 是
/// [`counter_proof_confirms_the_probe_is_intact`] 的活——
/// **两条一起才完整**（本仓「假覆盖」教训：别把一条当另一条的充分条件）。
#[test]
fn empty_control_is_unbiased() {
    let p = pool_gate_seeds();
    let r = arm_auc(&p, &ARM_EMPTY_CONTROL);
    let s = arm_sets(&p, &ARM_EMPTY_CONTROL);
    println!(
        "空对照（两臂谓词逐字相同 = `!has_shot`）：AUC = {:?}  \
         [build={} prog={} | rate_auc: pos={} neg={} skipped={}]\n  \
         两侧是同一个集合 ⇒ 取值必须逐位相等；AUC 因 P16 的不对称并列容差可偏离 0.5 \
         ~1e-5（实测残差 {EMPTY_CONTROL_RESIDUAL_OBSERVED:e}）",
        r.auc,
        s.build_up.len(),
        s.progression.len(),
        r.pos_n,
        r.neg_n,
        r.skipped_in_set
    );
    // ① 结构性（主判据）：两侧取值逐位相等。
    match values_are_identical(&p, &s.build_up, &s.progression, forward_rate) {
        Ok(()) => {}
        Err(e) => panic!(
            "**空对照判红（结构性）**：两臂谓词逐字相同 ⇒ 两侧取值必须**逐位相等**，\
             但 {e}。这不是浮点问题，是**比较有偏**：某侧被额外过滤、下标空间不同步，\
             或两臂谓词其实有差别。"
        ),
    }
    // 集合元素也须逐位相同（取值相等的必要前提）。
    assert_eq!(
        s.build_up, s.progression,
        "空对照的两臂谓词应逐字相同 ⇒ 取出的下标集必须**逐位相等**"
    );
    // ② 数值性（兜底）：AUC 无偏。
    assert!(
        empty_control_auc_is_unbiased(&r),
        "**空对照判红（数值性）**：AUC = {:?} 偏离 0.5 超过 1e-3。\
         已知的浮点残差只有 ~1e-5（{EMPTY_CONTROL_RESIDUAL_OBSERVED:e}），\
         超出说明是**真的偏置**（某侧被额外过滤 / 下标不同步）。",
        r.auc
    );
    assert!(
        !s.build_up.is_empty(),
        "空对照集合为空——那是「算不出」，与「算得出且无偏」含义完全不同"
    );
}

/// **探针自身的判别力**：把已知的坏形态喂给 `require_finite`，
/// 必须判红——否则它就是一条恒真断言（本仓「假覆盖」教训）。
#[test]
fn probe_rejects_non_finite_and_never_hides_skips() {
    // ① NaN 必须判红（P16 假证据形态 1：`NaN > max` 恒假 ⇒ 打出「max|Δ| = 0」）。
    let caught = std::panic::catch_unwind(|| require_finite("nan_case", f64::NAN));
    assert!(caught.is_err(), "`require_finite` 放过了 NaN——它就不是一条守卫");
    let caught = std::panic::catch_unwind(|| require_finite("inf_case", f64::INFINITY));
    assert!(caught.is_err(), "`require_finite` 放过了 Inf——它就不是一条守卫");
    // 反证：正常值不判红（否则守卫过强，任何运行都红——同样没用）。
    assert_eq!(require_finite("ok", 1.25), 1.25);

    // ② 跳过数与比较数**并列报**（P16 教训：「N 点通过」不该被读成「大部分点通过了」）。
    let p = pool_gate_seeds();
    assert!(!p.is_empty(), "池化空间为空——样本有问题");
    let r = arm_auc(&p, &ARM_CURRENT);
    println!(
        "记账形状检查：pos={} neg={} skipped_in_set={}（三个数都必须可读，不只是分母）",
        r.pos_n, r.neg_n, r.skipped_in_set
    );
    assert!(r.pos_n > 0 && r.neg_n > 0, "基线臂两侧都应非空");
    // 当前臂的特征（forward_m/s）不应有集内缺失——有的话 AUC 会被选择效应污染，
    // 那时必须**显式**改用 `rate_auc` 并记录，而不是静默通过。
    // 这条由 `RateAuc::require_clean` 承担（它也顺带断言 AUC 可算）。
    r.require_clean("baseline:build_up_vs_progression");
    assert_eq!(
        r.skipped_in_set, 0,
        "基线臂在参考集内有 {} 个 episode 缺 forward_m/s——AUC 会被选择效应污染。\
         若这是预期的，请显式记录并说明缺失在两侧是否均衡。",
        r.skipped_in_set
    );
}

// ============================== Slice 1：净化 ==============================

/// 净化用的谓词必须与 P16 的 `reference_set` **逐字同源**——否则「重跑 P16 的 gate」
/// 就变成了「跑一个碰巧长得像的东西」。
///
/// ⚠️ 本仓高发缺陷是「结论对但机制错」：两处各写一遍谓词，短期数字一致、
/// 长期分叉且**没有任何测试会红**。故这里直接对**同一个池化空间**取集合、逐位比对。
#[test]
fn motif_predicates_agree_with_the_p16_reference_set() {
    let p = pool_gate_seeds();
    for name in [
        "final_third_candidate",
        "build_up_candidate",
        "progression_candidate",
    ] {
        let mine = set_where(&p, motif_pred(name));
        // P16 的入口：refs 是**逐场本地下标**；此处逐位抬成全局后与 `mine` 比对。
        let mut theirs: Vec<usize> = Vec::new();
        let mut offset = 0usize;
        for seed in GATE_SEEDS.0..=GATE_SEEDS.1 {
            let dm = observe(seed);
            let all = crate::gate::reference_sets(&dm);
            let v = all
                .iter()
                .find(|(n, _)| *n == name)
                .map(|(_, v)| v.clone())
                .unwrap_or_default();
            theirs.extend(v.into_iter().map(|i| i + offset));
            offset += dm.possession_episodes.len();
        }
        assert_eq!(
            mine, theirs,
            "净化谓词 `{name}` 与 P16 的 `reference_set` 取出的集合**逐位不等**——\
             两处口径已分叉。净化结论若不建立在同一个参考集上，就不能用来判定 P16 的裁决。"
        );
        assert!(!mine.is_empty(), "`{name}` 集合为空——样本或谓词有问题");
    }
}

/// **Slice 1 的产出**：在净化下，P16 的裁决是否仍成立。
///
/// ## 四个臂（见 `p124/purify.rs` 的表）
///
/// | 臂 | 抽掉了什么 | 预期 |
/// |---|---|---|
/// | `current` | （基线） | P16 的 0.461 |
/// | `drop_restart` | 是否重开 | 0.437（主 session 的 30 seed 实测） |
/// | `drop_passcount` | 传球数 | 0.490 |
/// | `empty_control` | 两个都抽 | **0.500**（结构必然） |
///
/// ## 本测试断言什么（三条，各管一件事）
///
/// 1. **净化不推翻裁决**——四个臂的 AUC 全部落在 `[0.40, 0.56]`：
///    `build_up` 与 `progression` 在**剥掉两个混淆量之后**仍分不开。
///    这才是「P16 的裁决不是混淆造成的假象」的**证据**（P16 的 tasks.md 只记了主 session
///    的一次口头复现，没有落成可复跑的断言）。
/// 2. **空对照无偏**（两侧取值逐位相等 + `|AUC − 0.5| ≤ 1e-3`）——比较无系统偏置
///    （详见 [`empty_control_is_unbiased`]）。
/// 3. **方向仍为反向**（AUC < 0.5）——P16 实测 `build_up` 的推进速率**更低**，
///    这条方向信息本身是证据（`build_up` 不是「推得更快」，恰恰相反）。
#[test]
fn purification_reproduces_the_p16_verdict() {
    let p = pool_gate_seeds();
    println!("净化臂（{})：build_up vs progression，forward_m/s", p.caliber_line());
    let mut rows: Vec<ArmRow> = Vec::new();
    for arm in PURIFY_ARMS {
        let row = ArmRow::of(&p, arm);
        println!(
            "  {:<28} 抽掉：{:<18} AUC={:?}  [build={} prog={} 跳过={}]",
            row.name,
            row.removes,
            row.auc.map(|a| (a * 1000.0).round() / 1000.0),
            row.build_n,
            row.prog_n,
            row.skipped_in_set
        );
        rows.push(row);
    }

    // 每一臂都必须真的算得出 AUC（空集是「算不出」，不是「分不开」）。
    for row in &rows {
        assert!(
            row.auc.is_some(),
            "臂 `{}` 算不出 AUC（build={}, prog={}）——空组不得静默通过",
            row.name,
            row.build_n,
            row.prog_n
        );
        assert!(
            arm_sets(&p, arm_of(row.name)).both_non_empty(),
            "臂 `{}` 有一侧为空（build={}, prog={}）——空集是「算不出」，不是「分不开」",
            row.name,
            row.build_n,
            row.prog_n
        );
    }

    // ① 净化不推翻裁决：四臂全部不可分。
    for row in &rows {
        let a = row.auc.unwrap();
        assert!(
            (a - 0.5).abs() <= 0.06,
            "臂 `{}` 的 AUC = {a:.3} 越出 [0.44, 0.56]——**净化下 build_up 与 progression 变得可分**，\
             P16 的裁决（「空间量不足以判这两档」）须重新检验。",
            row.name
        );
    }

    // ② 空对照无偏（结构 + 数值两条；详见 `empty_control_is_unbiased`）。
    let ctrl_sets = arm_sets(&p, &ARM_EMPTY_CONTROL);
    if let Err(e) = values_are_identical(&p, &ctrl_sets.build_up, &ctrl_sets.progression, forward_rate)
    {
        panic!("空对照结构性判红：{e}");
    }
    let ctrl = rows
        .iter()
        .find(|r| r.name == ARM_EMPTY_CONTROL.name)
        .expect("空对照臂必须在 PURIFY_ARMS 里");
    let ctrl_full = arm_auc(&p, &ARM_EMPTY_CONTROL);
    assert!(
        empty_control_auc_is_unbiased(&ctrl_full),
        "空对照臂的 AUC = {:?} 偏离 0.5 超过 1e-3——比较有系统偏置（见 `empty_control_is_unbiased`）",
        ctrl.auc
    );

    // ③ 方向仍是反向（P16 实测 0.461 / 300 seed 0.431 都 < 0.5）。
    let cur = rows
        .iter()
        .find(|r| r.name == ARM_CURRENT.name)
        .expect("基线臂必须在 PURIFY_ARMS 里");
    assert!(
        cur.auc.unwrap() < 0.5,
        "基线臂的 AUC = {:?} 不再是反向（< 0.5）——方向翻了，P16 裁决的理由须重写",
        cur.auc
    );

    // ④ 抽掉「是否重开」之后**仍**不可分——这是「不是重开在作祟」的直接证据。
    let no_restart = rows
        .iter()
        .find(|r| r.name == ARM_DROP_RESTART.name)
        .expect("抽重开臂必须在 PURIFY_ARMS 里");
    assert!(
        (no_restart.auc.unwrap() - 0.5).abs() <= 0.06,
        "抽掉「是否重开」后 AUC = {:?} 变得可分——P16 的不可分结论**部分来自重开混淆**，须重写",
        no_restart.auc
    );

    // ⑤ 抽掉「传球数」之后**仍**不可分——同上，针对传球数。
    let no_passcount = rows
        .iter()
        .find(|r| r.name == ARM_DROP_PASSCOUNT.name)
        .expect("抽传球数臂必须在 PURIFY_ARMS 里");
    assert!(
        (no_passcount.auc.unwrap() - 0.5).abs() <= 0.06,
        "抽掉「传球数」后 AUC = {:?} 变得可分——P16 的不可分结论**部分来自传球数混淆**，须重写",
        no_passcount.auc
    );
}

/// **索引空间错位必须当场判红**——`Pooled` 的结构性契约的判别力测试。
///
/// 直接构造一个「`facts` 比 `feats` 短一条」的错位形态（P16 join bug 的最小复现），
/// 断言 `pool_episodes` 的断言会拒绝它。若这条守卫被绕过（比如有人加了 `flatten`），
/// 本测试会红。
///
/// ⚠️ **不能用生产不可达的入参**（本仓 P15/P17A 教训）：本测试**真的**跑 `observe`，
/// 只是喂给一个**故意做坏的观察包装**——它模拟「某个 seed 的 episode 数被少报」，
/// 而这是 `episode_features` 跳过缺 caliber episode 时的**真实**后果。
#[test]
fn pool_rejects_index_space_mismatch() {
    let real = observe;
    // 做坏：把第 2 个 seed 的 `possession_episodes` 截短一条（模拟「特征少一条」）。
    // 这条路径在生产里对应「`episode_features` 跳过了缺 caliber 的 episode」。
    let broken = |seed: u64| -> fm_engine::observation::DiagnosticMatch {
        let mut dm = real(seed);
        if seed == GATE_SEEDS.0 + 1 {
            // 让 `episode_features` 给出比 `possession_episodes` 少一条的结果：
            // 做法是砍掉最后一个 episode 的**起点事实**，使 `caliber_of` 返回 `None`。
            // （`episode_features` 跳过它 → 少一条；而 `possession_episodes` 仍是原长。）
            if let Some(last) = dm.possession_episodes.last() {
                let lo = last.event_indexes.first().copied().unwrap_or(usize::MAX);
                dm.control_facts.retain(|f| {
                    !(f.kind == fm_engine::observation::ControlFactKind::ControlEstablished)
                        || f.source_event_index.map(|j| j < lo).unwrap_or(true)
                });
            }
        }
        dm
    };
    let caught = std::panic::catch_unwind(|| {
        crate::probe::pool_episodes((GATE_SEEDS.0, GATE_SEEDS.0 + 1), broken)
    });
    assert!(
        caught.is_err(),
        "`pool_episodes` 放过了「特征条数 != episode 条数」的错位形态——\
         那正是 P16 join bug 的入口（`all_refs` 用全局下标而 `all_feats` 用本地下标，\
         seed 1 之后逐 seed 全错，AUC 被摊平到 0.5）。这条断言必须拦住它。"
    );
}

// ============================== Slice 2：意图信号的接出 ==============================

/// **意图快照与位置快照逐拍对齐**——这是下游按拍取用两条通道的前提。
///
/// ⚠️ **为什么单独立一条**：P16 的 join bug（参考集用全局下标、特征用逐场本地下标）
/// 的形态就是「两个集合的下标空间不同步」。本 change 又加了一条**平行**的逐拍通道
/// （`intent_snapshots`），风险同型：两条通道各自 push，只要提交点的顺序/条件有一处
/// 不同，`intent_snapshots[i]` 就不再指 `state_snapshots[i]` 那一拍——而**任何一侧单独看
/// 都自洽**。故这里逐拍断言 `t` 相同 + 条数相同。
#[test]
fn intent_export_is_tick_aligned_with_positions() {
    for seed in [1u64, 2, 7] {
        let dm = observe(seed);
        assert!(
            !dm.state_snapshots.is_empty(),
            "seed {seed}：opt-in 路径应产位置快照（否则本测试两侧都空，无判别力）"
        );
        assert_eq!(
            dm.intent_snapshots.len(),
            dm.state_snapshots.len(),
            "seed {seed}：意图快照 {} 条 != 位置快照 {} 条——两条通道必须同拍\
             （同一 tick 循环、同一 `t`）",
            dm.intent_snapshots.len(),
            dm.state_snapshots.len()
        );
        for (i, (si, ss)) in dm
            .intent_snapshots
            .iter()
            .zip(dm.state_snapshots.iter())
            .enumerate()
        {
            assert_eq!(
                si.t.value, ss.t.value,
                "seed {seed}：第 {i} 拍的两条通道时间不同（意图 {:?} vs 位置 {:?}）——\
                 下标空间已错位（P16 join bug 的同型）",
                si.t.value, ss.t.value
            );
            assert_eq!(
                si.t.basis, ss.t.basis,
                "seed {seed}：第 {i} 拍的两条通道 basis 不同——逐拍数据不得混时间基准"
            );
        }
    }
}

/// **意图观测不进入正式路径**——三条互补判据（逐字节一致 / 空操作契约 + 反证 / 输出无痕迹）。
///
/// 与 P16 的 `formal_path_produces_no_snapshots_and_is_byte_identical` 同形。
/// ⚠️ 白盒说明：`simulate()` **丢弃** recorder，故「逐字节一致」对「删掉 `observe_intent`
/// 的 `if !self.enabled`」这个变异**看不见**——那由空操作契约那条（公开 API 直接构造
/// `disabled()`）抓。两条分工，缺一不可。
#[test]
fn intent_export_never_enters_the_formal_path() {
    // ① opt-in 路径**真的**产意图数据（否则下面的比对无判别力）。
    let dm = observe(1);
    assert!(
        !dm.intent_snapshots.is_empty(),
        "opt-in 路径应产意图快照——空的话本测试无判别力"
    );
    assert!(
        dm.defensive_intents.iter().any(|d| d.kind.as_str() != "none"),
        "opt-in 路径应至少有一个非 `none` 的防守意图——空的话防守通道无判别力"
    );
    // ② 正式路径与 opt-in 路径的事件流**逐字节相同**（意图采集没有改变决策/RNG/事件）。
    let formal = fm_engine::simulate(1, cfg());
    assert_eq!(
        formal,
        dm.events_json(),
        "正式路径与 opt-in 路径的事件流必须**逐字节相同**——不同说明意图采集漏进了决策路径"
    );
    // ③ 正式路径的输出里没有任何意图观测痕迹（事件流协议未被改动）。
    assert!(
        !formal.contains("intent") && !formal.contains("shot_setup"),
        "正式路径的事件流里出现了意图字段——事件流协议被改动了（本 change 明禁）"
    );
    // ④ **关闭的 recorder 必须是空操作**（可观测形态；见测试 doc 的白盒说明）。
    let mut off = BehaviorObservationRecorder::disabled();
    let st = IntentState {
        has_shot_setup: true,
        in_window: true,
        window_ticks: 3,
        drive_ticks_left: 5,
        committed: false,
        entry_pressure_bucket: 1,
        pressure_state_ticks: 4,
    };
    off.observe_intent(ObservedTime::state_commit(1.0), st);
    off.observe_defensive_intent(
        ObservedTime::state_commit(1.0),
        DefensiveIntentKind::Tackle,
        Some(7),
    );
    assert!(
        off.intent_snapshots().is_empty() && off.defensive_intents().is_empty(),
        "**关闭的 recorder 上意图命令必须是空操作**——它若写入，正式路径\
         （`simulate()` 传 `disabled()`）就会在结构上持有意图数据"
    );
    // 反证条：同样的命令在**启用**的 recorder 上必须写入（否则上面的断言恒真）。
    let mut on = BehaviorObservationRecorder::enabled();
    on.observe_intent(ObservedTime::state_commit(1.0), st);
    on.observe_defensive_intent(
        ObservedTime::state_commit(1.0),
        DefensiveIntentKind::Tackle,
        Some(7),
    );
    assert_eq!(
        on.intent_snapshots().len(),
        1,
        "反证条：启用的 recorder 上 `observe_intent` 必须真的写入——否则「空操作」断言恒真"
    );
    assert_eq!(
        on.defensive_intents().len(),
        1,
        "反证条：启用的 recorder 上 `observe_defensive_intent` 必须真的写入"
    );
}

/// **意图语义被钉住**：`no_shot_setup` 是「无序列」的唯一编码；有序列时字段逐字取自引擎。
///
/// 判别力：把 `has_shot_setup` 与 `in_window` 混为一谈（例如让无序列也置 `in_window`）
/// 会让下游的「窗口开启」特征把**没有起脚序列**的拍也算进去。
///
/// ⚠️ **不用生产不可达的取值**（本仓 P15/P17A 教训）：这里构造的是引擎**真会**产生的
/// 组合——无序列 / 推进相 / 窗口相三态，逐条对应 `ShotSetup` 的字段。
#[test]
fn intent_semantics_are_pinned() {
    // 「无序列」的编码：判别位 false，其余字段归零（不得留下上次的寄生值）。
    let none = IntentState::no_shot_setup(4);
    assert!(!none.has_shot_setup, "无序列时判别位必须为 false");
    assert!(
        !none.in_window && none.window_ticks == 0 && none.drive_ticks_left == 0 && !none.committed,
        "无序列时其余起脚字段必须归零——留下寄生值会让下游把「无序列」读成「窗口内」"
    );
    assert_eq!(
        none.pressure_state_ticks, 4,
        "`pressure_state_ticks` 与起脚序列**无关**（压迫状态可以独立于序列存在）——\
         无序列时它仍须如实传递"
    );
    // 生产路径上真的是这三态，不只是构造出来的。
    let dm = observe(1);
    let n_setup = dm.intent_snapshots.iter().filter(|s| s.state.has_shot_setup).count();
    let n_window = dm
        .intent_snapshots
        .iter()
        .filter(|s| s.state.has_shot_setup && s.state.in_window)
        .count();
    assert!(n_setup > 0, "seed 1 整场没有一拍处于起脚序列——接出没生效或谓词错了");
    assert!(n_window > 0, "seed 1 整场没有一拍处于起脚窗口——窗口相未被观测到");
    assert!(
        dm.intent_snapshots
            .iter()
            .any(|s| s.state.has_shot_setup && !s.state.in_window),
        "seed 1 从未观测到「有序列但未进窗口」（推进相）——两相状态机只观测到一相"
    );
    // 无序列的拍必须**不**满足「有序列」谓词（判别位真的在起作用）。
    assert!(
        dm.intent_snapshots.iter().any(|s| !s.state.has_shot_setup),
        "seed 1 每一拍都有起脚序列？——判别位失效（`shot_setup` 是单例，全场只该有少数几拍）"
    );
}

/// **防守意图是稀疏的、有分母的、且 `defender` 语义如实**。
///
/// 三条：
/// ① 稀疏——条数远小于 tick 数（它是事件，不是逐拍通道）；
/// ② 有分母——每个被执行的计划恰好一条，故条数与「非 `none` + `none`」之和自洽；
/// ③ `defender` 只在引擎绑定接触动作主体时给出（`tackle` / `foul`），
///    其余为 `None`——**不是**「防守者未知」，故不得反推。
#[test]
fn defensive_intents_are_sparse_and_well_formed() {
    let dm = observe(1);
    let di = &dm.defensive_intents;
    assert!(!di.is_empty(), "seed 1 没有任何防守意图事件——接出没生效");
    assert!(
        di.len() < dm.intent_snapshots.len() / 5,
        "防守意图 {} 条 vs 逐拍 {} 条——它应是**稀疏事件**（每个机会点一条），\
         接近逐拍说明记错了通道",
        di.len(),
        dm.intent_snapshots.len()
    );
    // 归因靠 `t`：每条都须落在本场的 `[1.0, 5400.0]` 内（同位置快照的时间轴）。
    let (t_min, t_max) = (
        dm.intent_snapshots.first().unwrap().t.value,
        dm.intent_snapshots.last().unwrap().t.value,
    );
    for d in di {
        assert!(
            d.t.value + 1e-9 >= t_min && d.t.value - 1e-9 <= t_max,
            "防守意图的时刻 {:?} 落在逐拍通道的时间轴 [{t_min}, {t_max}] 之外——\
             两条通道不同源，归因会错",
            d.t.value
        );
    }
    // ② `defender` 语义：接触动作（tackle/foul）**都**带防守者；无事件防守**都**不带。
    for d in di {
        match d.kind {
            DefensiveIntentKind::Tackle | DefensiveIntentKind::Foul => assert!(
                d.defender.is_some(),
                "`{}` 是接触动作，引擎必然绑定了防守者 id——记成 `None` 说明映射漏了",
                d.kind.as_str()
            ),
            DefensiveIntentKind::Contain
            | DefensiveIntentKind::Jockey
            | DefensiveIntentKind::None => assert!(
                d.defender.is_none(),
                "`{}` 是无事件防守 / 无动作，决策层不绑定防守者——\
                 这里记成 `Some` 就是从位置反推了（P16 已证不足的做法）",
                d.kind.as_str()
            ),
        }
    }
    // ③ 分母：四类动作 + none 的计数必须等于总条数（每个被执行的计划恰好一条）。
    let mut counts = std::collections::BTreeMap::new();
    for d in di {
        *counts.entry(d.kind.as_str()).or_insert(0usize) += 1;
    }
    let total: usize = counts.values().sum();
    assert_eq!(
        total,
        di.len(),
        "分类计数之和 {total} != 事件条数 {}——有动作未被归入闭集",
        di.len()
    );
    println!("seed 1 防守意图分布（{} 条，逐拍 {} 条）：{:?}", di.len(), dm.intent_snapshots.len(), counts);
}

/// **`committed` 在逐拍采样点上不可观测**——这是本 change 的**已知缺口**，须记录。
///
/// ## 机制（读代码 + 实测，不是猜测）
///
/// `shot_window_plan` 的提交分支是 `st.shot_setup = None;` **紧接** `execute_action_resolution`——
/// 即「提交射门」与「序列销毁」发生在**同一个 tick**。采样点在 `tick()` **返回之后**，
/// 那时 `shot_setup` 已是 `None` ⇒ `committed == true` 永远观测不到。
///
/// 实测（seed 1/2/3）：`committed` 计数都是 **0**，而 `in_window` / `has_shot_setup` 都非 0。
///
/// ⇒ 下游**不得**用 `committed` 构造意图特征（它是死字段）。本测试把它**钉住**：
/// 若哪天它变成非 0，说明引擎改了提交时序——那时这个「缺口」的记录必须一起更新，
/// 而不是让一条无人知晓的陈旧说明留在文档里。
///
/// ⚠️ 本断言**会**在引擎改动时变红，那是**预期的**：它守的不是「永远为 0」，
/// 而是「文档与代码一致」。
#[test]
fn committed_is_not_observable_at_the_per_tick_sampling_point() {
    let mut total_committed = 0usize;
    for seed in 1u64..=5 {
        let dm = observe(seed);
        let c = dm.intent_snapshots.iter().filter(|s| s.state.committed).count();
        total_committed += c;
        // 反证条：同一批快照里 `in_window` 必须非 0——否则「committed 为 0」可能只是
        // 「窗口根本没被观测到」，而不是「提交即销毁」。
        let w = dm.intent_snapshots.iter().filter(|s| s.state.in_window).count();
        assert!(
            w > 0,
            "seed {seed} 没观测到起脚窗口——此时「committed 为 0」无判别力\
             （分不清「提交即销毁」与「窗口压根没进」）"
        );
    }
    assert_eq!(
        total_committed, 0,
        "seed 1..=5 观测到 {total_committed} 拍 `committed == true`——这与「提交射门与序列销毁\
         同一 tick」的机制不符。若引擎改了提交时序，请**同时**更新本测试与\
         `intent.rs` 里关于 `committed` 的已知缺口记录。"
    );
}

/// **接触类意图与事件流交叉核对**——独立来源的验证，抓「映射被悄悄改掉」。
///
/// ## 为什么需要这条（判别力论证）
///
/// 上面那条测试只证明了「分类是自洽的闭集 + `defender` 语义如实」，它**抓不到**
/// 「`Contain` 与 `Jockey` 的映射互换」或「`Tackle`/`Foul` 接反」——
/// 那种变异下分类依然穷尽、`defender` 语义依然成立。
///
/// 但 `Tackle` / `Foul` 是**接触动作**：引擎为它们产事件（`tackle` / `foul`），
/// 且**每个**被执行的接触意图必然产一条事件（断球成败都产 `tackle`；犯规必产 `foul`）。
/// 故「接触意图计数」与「事件流里的接触事件计数」**逐条相等**——这是一条独立来源的
/// 交叉核对（本仓 P16 的教训：自查抓不到，要靠独立证据）。
///
/// 实测（seed 1/2/3）：`tackle` 29/28/33 与事件 29/28/33 相等；`foul` 19/10/24 与事件相等。
///
/// ⚠️ **不断言 `contain`/`jockey` 与事件的对应**——它们**不产事件**（P30 D5：
/// 「只调压力状态」），结构上无从与事件流核对，只能靠上面的闭集自洽 + `defender` 语义守。
#[test]
fn contact_intents_match_the_event_stream() {
    for seed in [1u64, 2, 3] {
        let dm = observe(seed);
        let count_kind = |k: DefensiveIntentKind| {
            dm.defensive_intents.iter().filter(|d| d.kind == k).count()
        };
        let count_ev = |ty: fm_engine::EventType| {
            dm.events.iter().filter(|e| e.type_ == ty).count()
        };
        assert_eq!(
            count_kind(DefensiveIntentKind::Tackle),
            count_ev(fm_engine::EventType::Tackle),
            "seed {seed}：`tackle` 意图数 != 事件流里的 `tackle` 事件数——\
             意图通道的接触动作分类与事件流**不同源**（映射被改掉？）"
        );
        assert_eq!(
            count_kind(DefensiveIntentKind::Foul),
            count_ev(fm_engine::EventType::Foul),
            "seed {seed}：`foul` 意图数 != 事件流里的 `foul` 事件数——同上"
        );
        // 反证条：接触意图必须**真的存在**（否则上面的等式在 0 == 0 上恒真）。
        assert!(
            count_kind(DefensiveIntentKind::Tackle) > 0,
            "seed {seed} 没有任何 `tackle` 意图——上面的等式在 0==0 上恒真，无判别力"
        );
    }
}

// ============================== Slice 3：意图类特征 ==============================

/// 抽一场比赛的意图特征（**与 `episode_features` 同一下标空间**）。
///
/// ⚠️ **类型隔离的调用姿态**：只从 `dm` 里取**三个无位置通道**（意图快照 / 保守事件 /
/// episode 列表），**绝不把 `dm` 本身**传进意图模块——位置（`state_snapshots`）
/// 因此结构上到不了特征计算（见 `intent.rs` 的 `match_intents` doc）。
fn intents_of(dm: &DiagnosticMatch) -> Vec<crate::intent::EpisodeIntent> {
    crate::intent::match_intents(&dm.intent_snapshots, &dm.defensive_intents, &dm.possession_episodes)
}

/// **意图特征的下标空间与 P16 的口径特征逐位对齐**——P16 join bug 的直接防线。
///
/// P16 的裁决测试断言 `episode_features(&dm).len() == dm.possession_episodes.len()`；
/// 本 change 又加了一条平行数组（意图特征）。**两条数组必须同长同序**，否则
/// 「用意图特征解释某个 episode」时会把标签套到别的 episode 上——而**两侧各自看都自洽**。
#[test]
fn intent_features_share_the_index_space_with_calibers() {
    for seed in [1u64, 2, 7] {
        let dm = observe(seed);
        let feats = crate::gate::episode_features(&dm);
        let intents = intents_of(&dm);
        assert_eq!(
            feats.len(),
            dm.possession_episodes.len(),
            "seed {seed}：口径特征数 != episode 数（P16 已守的口径）"
        );
        assert_eq!(
            intents.len(),
            dm.possession_episodes.len(),
            "seed {seed}：意图特征数 {} != episode 数 {}——意图通道静默跳过了一些 episode，\
             下标空间已与本地下标错位（P16 join bug 的同型）",
            intents.len(),
            dm.possession_episodes.len()
        );
        // 逐位核对：第 i 条意图特征对应的 episode 时间窗，必须与该 episode 的 start_t 一致。
        for (i, (it, ep)) in intents.iter().zip(dm.possession_episodes.iter()).enumerate() {
            let end = ep.end_t.map(|t| t.value).unwrap_or(
                dm.intent_snapshots.last().map(|s| s.t.value).unwrap_or(0.0),
            );
            assert_eq!(
                it.duration_s,
                ep.end_t.map(|t| t.value - ep.start_t.value),
                "seed {seed}：第 {i} 条意图特征的时长与该 episode 的不符——下标空间不同步"
            );
            // `valid_ticks` 与直接按窗过滤的结果一致（本条独立复算，不采信上面的构造）。
            let direct = dm
                .intent_snapshots
                .iter()
                .filter(|s| s.t.value + 1e-9 >= ep.start_t.value && s.t.value <= end + 1e-9)
                .count();
            assert_eq!(
                it.valid_ticks, direct,
                "seed {seed}：第 {i} 条意图特征的 `valid_ticks`（{}）与直接按窗过滤（{direct}）不一致",
                it.valid_ticks
            );
        }
    }
}

/// **意图模块结构上够不着位置**——铁律「不得从位置反推意图」的落点。
///
/// 两条判据：
/// ① `intent.rs` **源码里没有**任何位置 token（`state_snapshots` / `pos` / `ball` / `.x` …）；
/// ② `match_intents` 的签名**不接收 `DiagnosticMatch`**（唯一的构造侧，故类型隔离完整）。
///
/// ⚠️ **判据 ①（文本扫描）单独不够**：P16 实测「把位置读取放进别的文件的 helper 再 `use`
/// 进来」可绕过扫描。故真正的保证是 ②（类型隔离）——① 只是回归下限。
/// 两者合起来才覆盖「本文件里写位置」与「本文件外借位置」。
#[test]
fn intent_features_cannot_reach_positions() {
    let src = include_str!("p124/intent.rs");
    let prod = src.split("#[cfg(test)]").next().expect("源文件应有测试段");
    // ⚠️ **先剥注释**（本仓 P15 守卫同法）：本文件的文档里**必须**写「不得读
    // `state_snapshots` / `StateSnapshot`」来解释这条纪律——不剥注释的话，
    // **解释规则的注释**会被当成违规代码（实测：首版即被 `StateSnapshot` 误报）。
    // 剥的是每行 `//` 之后的全部内容（覆盖 `//` / `//!` / `///`），保留行结构。
    let code: String = prod
        .lines()
        .map(|l| &l[..l.find("//").unwrap_or(l.len())])
        .collect::<Vec<_>>()
        .join("\n");
    // ⚠️ token 必须**无歧义**：`.pos` 会命中 `Iter::position(`（实测首版即被误报），
    // 故位置字段用 `pos[` / `.ball`（后者在代码里只会是位置字段，不会撞别的方法名）。
    for token in [
        "state_snapshots",
        "StateSnapshot",
        "DiagnosticMatch",
        "pos[",
        ".ball",
        "PITCH_LENGTH",
        "attack_dir",
        "progress(",
    ] {
        assert!(
            !code.contains(token),
            "`intent.rs` 的**代码**里出现位置 token `{token}`——意图特征不得读位置\
             （P16 已证空间量不足）。注释里提到这些名字是允许的（那是纪律说明），\
             但代码里出现即违规。"
        );
    }
    // ② 类型隔离：签名只收三个无位置通道。
    assert!(
        prod.contains("pub fn match_intents(\n    snaps: &[IntentSnapshot],\n    defensive: &[DefensiveIntent],\n    episodes: &[PossessionEpisode],\n)"),
        "`match_intents` 的签名变了——它必须**只**收三个无位置通道（意图快照 / 保守事件 / episode 列表），\
         不得接收 `DiagnosticMatch`（那会让位置结构上可达）。当前签名见 `intent.rs`。"
    );
}

/// **意图特征的覆盖率与缺失分类**（Slice 3 的交付物之一）。
///
/// 断言：① 每条特征都有**可算的** episode（不是全缺）；② 缺失原因都落在闭集里；
/// ③ 「没有观测」与「有观测但值缺」分开记账（`valid_ticks == 0` vs 特征 `None`）。
#[test]
fn intent_feature_coverage_is_reported() {
    let mut cov = crate::intent::IntentCoverage::default();
    let mut all: Vec<crate::intent::EpisodeIntent> = Vec::new();
    for seed in GATE_SEEDS.0..=GATE_SEEDS.1 {
        let dm = observe(seed);
        for it in intents_of(&dm) {
            cov.observe(&it);
        }
        all.extend(intents_of(&dm));
    }
    assert_eq!(cov.episodes, all.len(), "覆盖率分母 != 样本数");
    println!(
        "意图特征覆盖率（{} seed / {} episode）：",
        GATE_SEEDS.1 - GATE_SEEDS.0 + 1,
        cov.episodes
    );
    for (k, c) in &cov.computed {
        println!("  可算 {k}: {c}（{:.3}）", *c as f64 / cov.episodes as f64);
    }
    for (k, c) in &cov.missing {
        println!("  缺失 {k}: {c}");
    }
    // ① 每条特征至少在一部分 episode 上可算（否则该特征无信息）。
    for name in [
        "window_share",
        "setup_share",
        "pressure_share",
        "pressure_mean",
        "def_per_s",
    ] {
        let c = cov.computed.get(name).copied().unwrap_or(0);
        assert!(
            c > cov.episodes / 2,
            "意图特征 `{name}` 只在 {c}/{} episode 上可算——覆盖率过低，该特征不承载信息",
            cov.episodes
        );
    }
    // ② `first_window_frac` / `max_window_ticks` 只在**开窗**的 episode 上可算——
    //    覆盖少是**预期的**（窗口稀疏），但要 >0（否则该特征恒缺）。
    for name in ["first_window_frac", "max_window_ticks"] {
        let c = cov.computed.get(name).copied().unwrap_or(0);
        assert!(
            c > 0,
            "意图特征 `{name}` 一个 episode 都算不出来——窗口从未被观测到？"
        );
    }
    // ③ 控制条：三档的窗口开启率必须**显著不同**——这是意图信号携带 phase 信息的**直接证据**
    //    （P16 的 final_third 空间特征 0.855 之所以可能，正因为射门与三档强相关）。
    let mut open_by_zone: std::collections::BTreeMap<&str, (usize, usize)> = Default::default();
    let mut idx = 0usize;
    for seed in GATE_SEEDS.0..=GATE_SEEDS.1 {
        let dm = observe(seed);
        let facts = crate::gate::action_facts(&dm);
        let intents = intents_of(&dm);
        for (i, f) in facts.iter().enumerate() {
            let Some(f) = f else { continue };
            let zone = if f.ends_shot {
                "final_third"
            } else if f.from_restart && f.open_success_passes >= 3 && !f.has_shot {
                "build_up"
            } else if !f.from_restart && f.open_success_passes >= 1 && !f.has_shot {
                "progression"
            } else {
                continue;
            };
            let e = open_by_zone.entry(zone).or_insert((0, 0));
            e.0 += 1;
            if intents[i].window_opened {
                e.1 += 1;
            }
        }
        idx += 1;
    }
    for (zone, (n, opened)) in &open_by_zone {
        println!(
            "  {zone}: {opened}/{n} = {:.3} 开窗",
            *opened as f64 / *n as f64
        );
    }
    let rate = |z: &str| {
        let (n, o) = open_by_zone[z];
        o as f64 / n as f64
    };
    assert!(
        rate("final_third") > rate("progression") + 0.2,
        "final_third 的开窗率（{:.3}）必须显著高于 progression（{:.3}）——\
         否则「起脚窗口」这条意图信号不承载 phase 信息，整个 Slice 2 的接出白做",
        rate("final_third"),
        rate("progression")
    );
    assert!(
        rate("build_up") < 0.5,
        "build_up 的开窗率 {:.3} 过高——build_up 是「未进入射门」的档，不该大量开窗",
        rate("build_up")
    );
    let _ = idx;
}

/// **`def_share` 无机会时是 `None` 而不是 0**——缺失语义的判别力测试。
///
/// 用**手工 fixture**（生产可达形态：一个无防守机会的 episode）验证。
/// ⚠️ 不用生产不可达的取值（本仓 P15/P17A 教训）：「无防守机会」在真实数据里确实出现
/// （实测 30 seed 有 94 个 episode）。
#[test]
fn def_share_is_none_when_there_was_no_opportunity() {
    // 一个只含 1 拍的 episode，窗口内**没有**防守事件。
    let snaps = vec![IntentSnapshot {
        t: ObservedTime::state_commit(1.0),
        state: IntentState::no_shot_setup(0),
    }];
    let it = crate::intent::episode_intent(&snaps, &[], 1.0, 1.0, Some(1.0));
    assert_eq!(it.def_opportunities, 0);
    for k in fm_engine::observation::DefensiveIntentKind::ALL {
        assert!(
            it.def_share_of(*k).is_none(),
            "无防守机会时 `{}` 的比例必须记 `None`——记 0 会把「没机会」读成「全是别的动作」",
            k.as_str()
        );
    }
    // 反证条：同一个构造，**加一条**防守事件后比例必须变成 `Some`（否则上面是恒真）。
    let with_one = vec![DefensiveIntent {
        t: ObservedTime::state_commit(1.0),
        kind: fm_engine::observation::DefensiveIntentKind::Contain,
        defender: None,
    }];
    let it2 = crate::intent::episode_intent(&snaps, &with_one, 1.0, 1.0, Some(1.0));
    assert_eq!(it2.def_opportunities, 1);
    assert_eq!(
        it2.def_share_of(fm_engine::observation::DefensiveIntentKind::Contain),
        Some(1.0),
        "反证条：有 1 条 contain 机会时，contain 比例必须是 1.0——否则上面「全 None」恒真"
    );
}

/// **稀疏防守通道按「时间窗」归因，不按下标**——定向变异抓出来的缺口守卫。
///
/// ## 来由（**这条是被变异测试逼出来的，不是先想到的**）
///
/// 我最初以为 `def_share_is_none_when_there_was_no_opportunity` + 下标空间测试
/// 覆盖了防守通道。**定向变异显示没有**：把 `episode_intent` 里防守事件的
/// `if d.t.value ∈ [start, end]` 换成任一**不按时间**的过滤（实测用 `i % 3`），
/// **全套 16 条仍绿**——因为既有的两条测试要么用空防守列表、要么只核对逐 tick 通道。
///
/// ⇒ 本测试用**手工 fixture** 直接钉住时间窗语义：三条防守事件，两条落在窗内、
/// 一条落在窗外。判据是**窗外那条不计入**。
///
/// ⚠️ fixture 取值**生产可达**（本仓 P15/P17A 教训）：episode 窗 `[10, 20]` 与
/// 相邻窗的防守事件都是真实形态（事件时间恒等于某个 tick 的 `t`）。
#[test]
fn defensive_intents_are_attributed_by_time_window_not_by_index() {
    let def = |t: f64, k: DefensiveIntentKind| DefensiveIntent {
        t: ObservedTime::state_commit(t),
        kind: k,
        defender: None,
    };
    let defensive = vec![
        def(5.0, DefensiveIntentKind::Foul),    // 窗**前**（属上一个 episode）
        def(12.0, DefensiveIntentKind::Contain), // 窗内
        def(18.0, DefensiveIntentKind::Jockey),  // 窗内
        def(25.0, DefensiveIntentKind::Tackle),  // 窗**后**（属下一个 episode）
    ];
    let snaps = vec![IntentSnapshot {
        t: ObservedTime::state_commit(10.0),
        state: IntentState::no_shot_setup(0),
    }];
    let it = crate::intent::episode_intent(&snaps, &defensive, 10.0, 20.0, Some(10.0));
    assert_eq!(
        it.def_opportunities, 2,
        "窗 [10,20] 内应只有 2 条防守事件（12.0 与 18.0）——\
         实测 {} 条，说明归因**不是按时间窗**（按了下标？）",
        it.def_opportunities
    );
    assert_eq!(
        it.def_share_of(DefensiveIntentKind::Contain),
        Some(0.5),
        "contain 应占 1/2"
    );
    assert_eq!(
        it.def_share_of(DefensiveIntentKind::Jockey),
        Some(0.5),
        "jockey 应占 1/2"
    );
    // ⚠️ 窗外的动作必须表现为 **`Some(0.0)`**（「本 episode 有 2 次机会，其中 0 次是 foul」），
    // **不是** `None`——`None` 在本模块是「**没有机会**」的语义（见 `def_share` 的 doc）。
    // 首版我写成了 `None`，被本测试自己判红：那会把「窗外的 foul」与「没有观测」混为一谈。
    assert_eq!(
        it.def_share_of(DefensiveIntentKind::Foul),
        Some(0.0),
        "窗前的 foul **不得**计入本 episode（应为 0/2）——若为 0.5 说明归因漏了时间下界"
    );
    assert_eq!(
        it.def_share_of(DefensiveIntentKind::Tackle),
        Some(0.0),
        "窗后的 tackle **不得**计入本 episode（应为 0/2）——若为 0.5 说明归因漏了时间上界"
    );
    // 边界（闭区间）：恰好落在 start / end 上的事件**计入**（与 P16 的帧过滤同口径）。
    let edge = vec![def(10.0, DefensiveIntentKind::Foul), def(20.0, DefensiveIntentKind::Foul)];
    let it_edge = crate::intent::episode_intent(&snaps, &edge, 10.0, 20.0, Some(10.0));
    assert_eq!(
        it_edge.def_opportunities, 2,
        "闭区间 `[start, end]` 的边界事件应计入（与 P16 帧过滤同口径）"
    );
}
