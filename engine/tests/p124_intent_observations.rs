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
//! | [`intent_feature_coverage_is_reported`] | 意图特征（覆盖率 + 缺失分类 + **防守通道端到端**） | ✅ |
//! | [`def_share_is_none_when_there_was_no_opportunity`] | 意图特征（缺失语义） | ✅ |
//! | [`defensive_intents_are_attributed_by_time_window_not_by_index`] | 意图特征（**时间窗归因**，变异逼出） | ✅ |
//! | [`intent_feature_definitions_are_pinned`] | 意图特征（**定义被钉住**：首个/最后一拍、压迫恒真、判别位） | ✅ |
//! | [`spatial_rows_match_the_p16_separability`] | gate（空间侧对照基线**逐条**同输出） | ✅ |
//! | [`def_none_signal_is_mechanically_tied_to_shots`] | gate（**循环性**：`def_none`） | ✅ |
//! | [`window_features_are_mechanically_tied_to_shots`] | gate（**循环性**：窗口三条，P0-1） | ✅ |
//! | [`gate_rerun_and_p16_baseline_side_by_side`] | gate（重跑 + 基线并列） | ✅ |
//! | [`purification_over_intent_features_reproduces_the_verdict`] | gate（**再净化一次**） | ✅ |
//! | [`verdict_best_intent_row_is_adequately_sampled`] | 裁决（最强行样本充足 + 方向） | ✅ |
//! | [`identical_inputs_produce_byte_identical_output`] | 产物（确定性） | ✅ |
//! | [`rendered_json_is_structurally_valid`] | 产物（JSON 结构合法） | ✅ |
//! | [`json_validator_rejects_the_known_bad_shapes`] | 产物（校验器判别力） | ✅ |
//! | [`merge_into_object_strips_exactly_one_brace`] | 产物（剥一个 `}`） | ✅ |
//! | [`provenance_carries_the_comparability_triple`] | 产物（可比性三件套） | ✅ |
//! | [`provenance_records_worktree_state`] | 产物（工作树状态，P1-2） | ✅ |
//! | [`on_disk_artifacts_share_the_current_source_fingerprint`] | 产物（与源码同源） | ✅ |
//! | [`artifact_write_guard_has_discriminating_power`] | 产物（**落盘门有判别力**，第 2 轮 P1） | ✅ |
//! | [`p124_fingerprint_covers_its_own_sources`] | 产物（指纹覆盖自己的源码） | ✅ |
//! | `p124_canary` / `p124_baseline` | 产物落盘 | ❌ `#[ignore]` |
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
#[path = "p124/phasegate.rs"]
mod phasegate;
#[path = "p124/report.rs"]
mod report;

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
    // ②b **防守通道的端到端守卫**（独立审阅抓到的 P1-1）。
    //
    // ⚠️ 为什么需要它：上面 ① 只断言 `def_per_s`「可算 > episodes/2」——而**丢掉整条
    // 防守通道**后，`def_opportunities` 恒 0 ⇒ `def_per_s = Some(0/d)` **仍算「可算」**，
    // 断言照过。实测：把 `match_intents` 里防守事件换成 `&[]`，**全套 27 条测试全绿**，
    // 而 5 条 `def_*` 特征全部失效。这是本 change 的核心交付之一，**必须端到端守**。
    //
    // 三条互补判据：
    //  (a) `def_share[*]` 必须在一部分 episode 上真的可算（丢失通道 → 恒缺）；
    //  (b) 「无防守机会」的 episode 数必须**远小于**全部（丢失通道 → 等于全部）；
    //  (c) `def_per_s` 不得是常量（丢失通道 → 恒 0.0）。
    let def_share_computed = cov.computed.get("def_share[*]").copied().unwrap_or(0);
    assert!(
        def_share_computed > cov.episodes / 2,
        "`def_share[*]` 只在 {def_share_computed}/{} episode 上可算——防守通道可能整条失效\
         （丢失后此数恒 0）",
        cov.episodes
    );
    assert!(
        cov.episodes_without_def_opportunities < cov.episodes / 4,
        "「无防守机会」的 episode 有 {}/{}——占超过 1/4，防守通道可能整条失效\
         （丢失后此数 == episodes）",
        cov.episodes_without_def_opportunities,
        cov.episodes
    );
    let def_rates: std::collections::BTreeSet<u64> = all
        .iter()
        .filter_map(|e| e.def_per_s())
        .map(|v| (v * 1e6).round() as u64)
        .collect();
    assert!(
        def_rates.len() > 10,
        "`def_per_s` 只有 {} 个不同取值（可能恒为常量 0.0）——防守通道失效？",
        def_rates.len()
    );
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

// ============================== Slice 4：重跑 phaseability gate ==============================

/// **空间侧的行必须与 P16 的 `separability` 同输出**——防止本 change 悄悄换掉对照基线。
///
/// 判据：同一池化空间、同一参考集，`phasegate::rate_auc_spatial`（本模块另写的等价实现）
/// 与 P16 的 `gate::separability`（原实现）对**每一条空间特征**给出**同一个** AUC。
/// 若不同，说明本 change 的对照列与 P16 的基线不可比——那整张对照表就是废的。
#[test]
fn spatial_rows_match_the_p16_separability() {
    let p = pool_gate_seeds();
    let sets = crate::phasegate::zone_sets(&p);
    let get = |name: &str| -> Vec<usize> {
        sets.iter().find(|(n, _)| *n == name).map(|(_, v)| v.clone()).unwrap_or_default()
    };
    let mut compared = 0usize;
    for zone in ["final_third_candidate", "build_up_candidate", "progression_candidate"] {
        let set = get(zone);
        let p16_rows = crate::gate::separability(&set, &p.feats);
        let mine = crate::phasegate::gate_rows(&p, &vec![Default::default(); p.feats.len()], &set, &crate::probe::complement(&p, &set), "x");
        // ⚠️ **按下标比对，不按名字 find**（独立审阅抓到的 P0）：
        // 两侧特征名**不同**（本模块带 `[空间]` 后缀），`find(|m| m.feature == r16.feature)`
        // 会**永不命中**——7 条里只有 `start_progress[区域量·仅对照]`（两侧同名的唯一一条）
        // 真被比较，其余 6 条**静默跳过**。实测：把 `net_progress` 改读 `backward_m`
        // （AUC 0.666→0.462）**全套测试仍绿**。
        assert_eq!(
            p16_rows.len(),
            crate::phasegate::P16_SEPARABILITY_ROWS,
            "P16 的 `separability` 表条数变了（本模块按下标比对，条数不同即错位）——\
             请同步 `SPATIAL_FEATURES` 的前 {} 条",
            crate::phasegate::P16_SEPARABILITY_ROWS
        );
        for (i, r16) in p16_rows.iter().enumerate() {
            // 下标对齐：本模块的 `SPATIAL_FEATURES[i]` 与 P16 的第 `i` 条必须**同名**。
            let mine_name = crate::phasegate::SPATIAL_FEATURES[i].0;
            assert_eq!(
                mine_name.trim_end_matches("[空间]"),
                r16.feature,
                "第 {i} 条空间特征两侧**不同源**：P16=`{}`，本模块=`{mine_name}`——\
                 `SPATIAL_FEATURES` 的顺序/取值被改动了（对照基线不可比）",
                r16.feature
            );
            let mine_row = mine
                .iter()
                .find(|m| m.feature == mine_name)
                .unwrap_or_else(|| panic!("本模块应产出特征 `{mine_name}`"));
            match (r16.auc, mine_row.auc) {
                (Some(a), Some(b)) => assert!(
                    (a - b).abs() < 1e-12,
                    "空间特征 `{}` 在档 `{zone}`：P16 `separability` 给 {a:.6}，\
                     本模块给 {b:.6}——对照基线被换掉了，两侧不可比",
                    r16.feature
                ),
                (None, None) => {}
                (x, y) => panic!(
                    "空间特征 `{}` 在档 `{zone}`：一侧可算一侧不可算（P16={x:?} vs 本模块={y:?}）",
                    r16.feature
                ),
            }
            compared += 1;
        }
    }
    // **防空转**：实际比较到的条数必须 = 表条数 × 档数（不是 1）。独立审阅实测旧版只有 3 条
    // （1 条 × 3 档），而 doc 声称「每一条空间特征」。
    assert_eq!(
        compared,
        crate::phasegate::P16_SEPARABILITY_ROWS * 3,
        "只比较了 {compared} 条——旧版按名字 `find` 会静默漏掉（名字带后缀）。\
         本守卫必须比较 **{} 条**（{} 条 × 3 档）",
        crate::phasegate::P16_SEPARABILITY_ROWS * 3,
        crate::phasegate::P16_SEPARABILITY_ROWS
    );
    println!("空间侧 3 档 × {} 条，与 P16 的 `separability` 按下标逐条同输出（比较 {compared} 条）", crate::phasegate::P16_SEPARABILITY_ROWS);
}

/// **`def_none` 的信号与射门机制同源**——循环性防护的判别力测试。
///
/// 机制（读代码 + 实测）：起脚窗口内 `committed` 的 tick，`evaluate_defensive_action`
/// 的不可回溯守卫直接返回 `DefensiveAction::None`。⇒ 射门 tick 上的防守意图**必然是
/// `none`**。实测 seed 1/2/3：射门 tick 上的防守意图 **21/21、21/21、14/14** 全是 `none`。
///
/// 因此 `def_none` 对 `final_third`（参考集谓词 = `ends_shot`）的 AUC 是**循环的**，
/// 已被标注 `[循环·仅对照]`，不得作为证据。
///
/// ⚠️ 本测试**钉住这条机制**：若哪天引擎改了（提交后防守侧不再被强制 `None`），
/// 本测试变红，那条「循环」标注必须一起更新——不让一条陈旧的解释留在产物里。
#[test]
fn def_none_signal_is_mechanically_tied_to_shots() {
    for seed in [1u64, 2, 3] {
        let dm = observe(seed);
        let shot_ts: std::collections::BTreeSet<u64> = dm
            .events
            .iter()
            .filter(|e| e.type_ == fm_engine::EventType::Shot)
            .map(|e| (e.t * 1000.0).round() as u64)
            .collect();
        assert!(!shot_ts.is_empty(), "seed {seed} 无射门事件——本测试无判别力");
        let mut on_shot = 0usize;
        let mut on_shot_none = 0usize;
        for d in &dm.defensive_intents {
            if shot_ts.contains(&((d.t.value * 1000.0).round() as u64)) {
                on_shot += 1;
                if d.kind == DefensiveIntentKind::None {
                    on_shot_none += 1;
                }
            }
        }
        assert!(on_shot > 0, "seed {seed}：没有一个防守机会落在射门 tick 上——样本异常");
        assert_eq!(
            on_shot_none, on_shot,
            "seed {seed}：射门 tick 上的防守意图 {on_shot_none}/{on_shot} 是 `none`，\
             但守卫要求**全部**为 `none`（`committed` 不可回溯）。\
             若引擎改了这条时序，`def_none` 的「循环」标注须一起更新。"
        );
    }
    println!("射门 tick 上的防守意图恒为 `none`（不可回溯守卫）——`def_none` 与 `ends_shot` 机制同源");
}

/// **重跑 gate：与 P16 基线并列对照**（Slice 4 的主产出）。
///
/// 断言三件事：
/// ① **P16 基线复现**——`forward_m/s` 对 `final_third` 仍 ≈0.855、
///    对 `build_up` vs `progression` 仍 ≈0.461（否则对照表不可比）；
/// ② **意图特征不足以分开 `build_up` / `progression`**——所有**非循环**意图特征的
///    `|AUC−0.5|` 都 ≤ 0.15（干净战场：两档都含 `!has_shot`，不受 `def_none` 循环影响）；
/// ③ **`final_third` 的意图信号**：`window_opened` / `setup_share` 应强
///    （起脚窗口是射门的前置），但 `def_none` 除外（`[循环·仅对照]`）。
///
/// ⚠️ 容差 0.15 的依据：P16 的空间侧最强非循环量 0.634（`|Δ|=0.134`），
/// 故 0.15 是「不比 P16 已知的最强空间量更弱」的**同尺度**门槛。
/// 越出即「意图特征分开了这两档」——那是一个**新发现**，裁决须相应改写。
#[test]
fn gate_rerun_and_p16_baseline_side_by_side() {
    let pw = pool_gate_seeds_with_intents();
    let t = crate::phasegate::verdict_table(&pw.pool, &pw.intents);
    println!("phaseability gate 重跑（{}）：", pw.pool.caliber_line());
    println!("-- final_third vs 其余 --");
    for r in &t.final_vs_rest {
        if r.auc.is_some() {
            println!("   {:<34} AUC={:.3} [{:?}]", r.feature, r.auc.unwrap(), r.provenance);
        }
    }
    println!("-- build_up vs progression --");
    for r in &t.build_vs_prog {
        if r.auc.is_some() {
            println!("   {:<34} AUC={:.3} [{:?}]", r.feature, r.auc.unwrap(), r.provenance);
        }
    }
    // ① P16 基线复现。
    let p16_final = t
        .final_vs_rest
        .iter()
        .find(|r| r.feature == "forward_m/s[空间]")
        .and_then(|r| r.auc)
        .expect("final_third 的 forward_m/s AUC 应可算");
    assert!(
        (p16_final - 0.855).abs() <= 0.05,
        "P16 基线未复现：forward_m/s 对 final_third AUC = {p16_final:.3}（P16 实测 0.855）——\
         对照表不可比，先查池化/参考集是否与 P16 同源"
    );
    let p16_bp = t.p16_baseline_build_vs_prog().expect("P16 的 build vs prog AUC 应可算");
    assert!(
        (p16_bp - 0.461).abs() <= 0.06,
        "P16 基线未复现：forward_m/s 对 build_up vs progression AUC = {p16_bp:.3}（P16 实测 0.461）"
    );
    // ② 干净战场：非循环意图特征分不开 build_up / progression。
    //    ⚠️ **样本量门槛先于断言**（见 `MIN_SIDE_FOR_SEPARABILITY` 的 doc）：
    //    本 change 实测到一次**假发现**——`first_window_frac` 在 pos=4/neg=8 上算出
    //    AUC 0.281，看着像「意图分开了两档」，实为 12 个样本上的噪声。
    //    样本不足的行**不参与断言**，但**必须打印**（不得静默跳过）。
    let mut undersized: Vec<&str> = Vec::new();
    for r in &t.build_vs_prog {
        if r.provenance != crate::phasegate::Provenance::Intent {
            continue; // 空间量另有 P16 的结论；循环量另有标注
        }
        let Some(a) = r.auc else { continue };
        if !r.is_adequately_sampled() {
            println!(
                "   [样本不足·不作证据] {}：AUC={a:.3} {}",
                r.feature,
                r.undersized_note().unwrap_or_default()
            );
            undersized.push(r.feature);
            continue;
        }
        assert!(
            (a - 0.5).abs() <= 0.15,
            "意图特征 `{}` 把 build_up 与 progression 分开了（AUC = {a:.3}，|Δ| = {:.3} > 0.15，\
             pos={} neg={} 样本充足）——这是**新发现**，裁决必须改写（当前裁决建立在「分不开」上）。\
             ⚠️ 先排除循环/混淆（两档 motif 都含 `!has_shot`，理论上不受 `def_none` 影响）。",
            r.feature,
            (a - 0.5).abs(),
            r.pos_n,
            r.neg_n
        );
    }
    assert!(
        !undersized.is_empty(),
        "本测试**期望**至少有一条意图特征在两档间样本不足（`first_window_frac` / `max_window_ticks`：\
         两档几乎从不开窗）。若一条都没有，说明样本量门槛已失效（或数据变了）——\
         届时须重新核对「哪些行算证据」，不要让一条空的分支留在测试里。"
    );
    // ③ **`final_third` 的意图侧没有可用证据**（独立审阅抓到 P0-1 后的更正）。
    //
    // ⚠️ **本断言曾经写反了**：旧版要求 `window_opened`/`setup_share` 的 AUC **> 0.9**
    // ——而它们恰恰是**同义反复**（见 `window_features_are_mechanically_tied_to_shots`），
    // 于是那条断言在**保护一个坏结论**。现在改为断言相反的事实：
    // **剔除循环行后，final_third 上没有任何样本充足的、非循环的意图证据**。
    let final_intent_evidence: Vec<&crate::phasegate::GateRow> = t
        .final_vs_rest
        .iter()
        .filter(|r| r.provenance == crate::phasegate::Provenance::Intent)
        .filter(|r| r.is_adequately_sampled())
        .collect();
    for r in &final_intent_evidence {
        let a = r.auc.expect("样本充足的行应可算 AUC");
        println!(
            "   [final_third 意图·非循环·样本充足] {}：AUC={a:.3}（pos={} neg={}）",
            r.feature, r.pos_n, r.neg_n
        );
        // ⚠️ 这里**曾有一条恒真断言** `assert!((a-0.5).abs() < 0.9)`——AUC ∈ [0,1]
        // ⇒ `|AUC−0.5| ≤ 0.5 < 0.9` 恒成立，阈值永不触发（独立审阅第 2 轮抓到）。
        // 真正生效的判据是下面紧跟的 `… < 0.25`（它经定向变异验证有区分度）。
        let _ = a;
    }
    assert!(
        final_intent_evidence.is_empty()
            || final_intent_evidence.iter().all(|r| {
                // 允许弱信号（>0.5 但不足 0.75），不允许「强判据」。
                r.auc.map(|a| (a - 0.5).abs() < 0.25).unwrap_or(true)
            }),
        "final_third 的**非循环样本充足**意图特征中出现了强判据（|Δ|≥0.25）——\
         裁决的「意图侧无证据」表述须更新（先查它是否也是循环量）"
    );
    // ④ 循环性必须**在表里可见**：窗口三条 + `def_none`（共 4 条），全部标 `[循环·仅对照]`。
    //    它们的高 AUC 是 `ends_shot` 的同义反复，读者不得当判别力证据。
    let circular_rows: Vec<&str> = t
        .final_vs_rest
        .iter()
        .filter(|r| r.provenance == crate::phasegate::Provenance::Circular)
        .map(|r| r.feature)
        .collect();
    assert_eq!(
        circular_rows.len(),
        4,
        "final_third 表应有 **4** 条循环行（`window_opened`/`window_share`/`setup_share`/`def_none`），\
         实际 {circular_rows:?}——独立审阅抓到旧版只标了 1 条，漏掉了 AUC 最高（0.966）的三条窗口特征"
    );
    for name in ["window_opened", "window_share", "setup_share", "def_none"] {
        assert!(
            circular_rows.iter().any(|f| f.starts_with(name)),
            "`{name}` 必须标为循环（它在 final_third 上与 `ends_shot` 机制同源）"
        );
    }
}

/// **再净化一次**——接入意图信号后，重新做一次 motif 混淆净化（design §3 的要求）。
///
/// 判据：在三个净化臂（current / drop_restart / drop_passcount）下，
/// **所有非循环意图特征**对 `build_up` vs `progression` 的 AUC 都仍 ≤0.15 偏离 0.5。
///
/// ⚠️ 这条**只覆盖意图特征**：空间侧的净化已在 `purification_reproduces_the_p16_verdict`
/// 里做（同管线、同反证条）。本测试是它在意图侧的**对应物**——「接入新信号后必须再净化
/// 一次，否则分不清分开是因为意图还是因为传球数/重开」。
#[test]
fn purification_over_intent_features_reproduces_the_verdict() {
    let pw = pool_gate_seeds_with_intents();
    let rows = crate::phasegate::purification_over_intent(&pw.pool, &pw.intents);
    println!("意图特征的净化（{}）：build_up vs progression", pw.pool.caliber_line());
    for (arm, feats) in &rows {
        println!("-- {arm} --");
        for r in feats {
            println!(
                "   {:<34} AUC={:?}  [pos={} neg={} skip={}]",
                r.feature,
                r.auc.map(|a| (a * 1000.0).round() / 1000.0),
                r.pos_n,
                r.neg_n,
                r.skipped
            );
        }
    }
    // 每个臂下，非循环意图特征都不得分开两档。
    //
    // ⚠️ **样本量门槛同样适用**（`MIN_SIDE_FOR_SEPARABILITY`）：`purification_over_intent`
    // 返回的只有 AUC，故这里另查一遍每侧的样本量——做法是**复算**同一对集合的规模，
    // 而不是猜。这是与 `gate_rerun_and_p16_baseline_side_by_side` 相同的判据，不是另立一套。
    let circular: Vec<&str> = crate::phasegate::INTENT_FEATURES
        .iter()
        .filter(|s| s.provenance == crate::phasegate::Provenance::Circular)
        .map(|s| s.name)
        .collect();
    let _ = &circular;
    let mut undersized_seen = 0usize;
    for (arm, feats) in &rows {
        for r in feats {
            if r.provenance == crate::phasegate::Provenance::Circular {
                continue;
            }
            let Some(a) = r.auc else { continue };
            // ⚠️ **逐行**判样本量（不是按臂）：臂的集合可能很大，但这条特征可能只在
            // 少数 episode 上可算（实测 `first_window_frac` 在两档间 pos=4 / neg=8）。
            if !r.is_adequately_sampled() {
                println!(
                    "   [样本不足·不作证据] {arm}/{}：AUC={a:.3} {}",
                    r.feature,
                    r.undersized_note().unwrap_or_default()
                );
                undersized_seen += 1;
                continue;
            }
            assert!(
                (a - 0.5).abs() <= 0.15,
                "净化臂 `{arm}` 下意图特征 `{}` 的 AUC = {a:.3}（|Δ| = {:.3}，pos={} neg={}）——\
                 它把 build_up / progression 分开了。裁决须改写。",
                r.feature,
                (a - 0.5).abs(),
                r.pos_n,
                r.neg_n
            );
        }
    }
    assert!(
        undersized_seen > 0,
        "本测试**期望**有若干行因样本不足而不作证据（`first_window_frac` 等只在小部分 episode 上可算）\
         ——一条都没有说明样本量门槛失效"
    );
    println!("三臂净化下，样本充足的意图特征均分不开 build_up / progression");
}

// ============================== Slice 5：产物 + 裁决 ==============================

/// 把一次 gate 运行渲染成 Markdown + JSON（**纯函数**，便于确定性与落盘测试共用）。
fn render_artifacts(mode: &str) -> (String, String) {
    let pw = pool_gate_seeds_with_intents();
    let t = crate::phasegate::verdict_table(&pw.pool, &pw.intents);
    let p = crate::report::build_provenance(mode, GATE_SEEDS.0, GATE_SEEDS.1, DUR);

    // ── Markdown ──
    let mut md = String::new();
    md.push_str(&format!("# P124 意图观测与 phaseability 裁决（{mode}）\n\n"));
    md.push_str("## provenance\n\n");
    md.push_str(&crate::report::provenance_markdown(&p));
    md.push_str("\n## Slice 1：motif 混淆净化（30 seed，forward_m/s）\n\n");
    md.push_str("| 臂 | 抽掉了什么 | AUC |\n|---|---|---|\n");
    for arm in crate::purify::PURIFY_ARMS {
        let r = crate::purify::arm_auc(&pw.pool, arm);
        md.push_str(&format!(
            "| `{}` | {} | {} |\n",
            arm.name,
            arm.removes,
            r.auc.map(|a| format!("{a:.3}")).unwrap_or_else(|| "N/A".into())
        ));
    }
    let cp = crate::purify::counter_proof_final_third(&pw.pool);
    md.push_str(&format!(
        "\n反证条 `final_third`（forward_m/s）：AUC = {:.3}（期望 {:.3} ± {:.2}）\n\n",
        cp.auc.unwrap_or(f64::NAN),
        crate::purify::COUNTER_PROOF_EXPECTED,
        crate::purify::COUNTER_PROOF_TOL
    ));

    // ── Slice 3 覆盖率 ──
    let mut cov = crate::intent::IntentCoverage::default();
    for it in &pw.intents {
        cov.observe(it);
    }
    md.push_str("## Slice 3：意图特征覆盖率\n\n| 特征 | 可算 / episode | 覆盖率 |\n|---|---|---|\n");
    for (k, c) in &cov.computed {
        md.push_str(&format!(
            "| `{k}` | {c} / {} | {:.3} |\n",
            cov.episodes,
            *c as f64 / cov.episodes as f64
        ));
    }
    md.push_str("\n缺失原因分类：\n\n| 原因 | 计数 |\n|---|---|\n");
    for (k, c) in &cov.missing {
        md.push_str(&format!("| {k} | {c} |\n"));
    }

    // ── Slice 4 gate 表 ──
    for (title, rows) in [
        ("## Slice 4：final_third vs 其余", &t.final_vs_rest),
        ("## Slice 4：build_up vs progression", &t.build_vs_prog),
    ] {
        md.push_str(&format!("\n{title}\n\n| 特征 | AUC | 种类 | pos / neg | 证据 |\n|---|---|---|---|---|\n"));
        for r in rows {
            let judge = if r.provenance == crate::phasegate::Provenance::Circular {
                "循环·不作证据".to_string()
            } else if let Some(note) = r.undersized_note() {
                format!("**不作证据**：{note}")
            } else {
                "样本充足".to_string()
            };
            md.push_str(&format!(
                "| `{}` | {} | {:?} | {} / {} | {judge} |\n",
                r.feature,
                r.auc.map(|a| format!("{a:.3}")).unwrap_or_else(|| "N/A".into()),
                r.provenance,
                r.pos_n,
                r.neg_n
            ));
        }
    }
    // ── 裁决 ──
    let best = t.best_intent_for_build_vs_prog();
    md.push_str("\n## 裁决\n\n");
    md.push_str("**不够**（对 `build_up` / `progression`）：意图信号未能分开这两档。\n\n");
    match best {
        Some(b) => md.push_str(&format!(
            "- 最强**样本充足**的非循环意图特征：`{}` AUC = {:.3}（pos={} neg={}）——落在 [0.44, 0.56] 内，             即与随机无异。\n",
            b.feature,
            b.auc.unwrap_or(f64::NAN),
            b.pos_n,
            b.neg_n
        )),
        None => md.push_str("- **没有任何样本充足的意图特征**可算——样本量门槛把全部行挡在证据之外。\n"),
    }
    // ⚠️ 明确点出被排除的行（否则读者会把它们的极端 AUC 当信号）。
    let undersized: Vec<&str> = t
        .build_vs_prog
        .iter()
        .filter(|r| r.provenance == crate::phasegate::Provenance::Intent && !r.is_adequately_sampled())
        .map(|r| r.feature)
        .collect();
    if !undersized.is_empty() {
        md.push_str(&format!(
            "- **不作证据**（样本不足，两档都几乎不开窗）：{}。它们的 AUC 偏离 0.5 是噪声，             不是信号——见 `MIN_SIDE_FOR_SEPARABILITY` 的 doc。\n",
            undersized.join(" / ")
        ));
    }
    md.push_str(&format!(
        "- P16 基线 `forward_m/s` = {:.3}（复现）。\n",
        t.p16_baseline_build_vs_prog().unwrap_or(f64::NAN)
    ));
    md.push_str("\n### 15B 的处置\n\n");
    md.push_str("- `final_third`：有候选判据，但它是**几何证据**（`forward_m/s`），\
                若 15B 用它须命名 `GoalwardProgressEvidence`，**不得**复用 `Phase`。\n");
    md.push_str("- `build_up` / `progression`：**保留 `unknown`**。空间 + 意图仍不足。\n");

    // ── JSON ──
    let mut rows_json: Vec<String> = Vec::new();
    for (label, rows) in [("final_vs_rest", &t.final_vs_rest), ("build_vs_prog", &t.build_vs_prog)] {
        for r in rows {
            rows_json.push(crate::report::obj(&[
                ("pair", crate::report::J::S(label.to_string())),
                ("feature", crate::report::J::S(r.feature.to_string())),
                ("provenance", crate::report::J::S(format!("{:?}", r.provenance))),
                ("auc", r.auc.map(crate::report::J::F).unwrap_or(crate::report::J::Null)),
                ("pos_n", crate::report::J::Int(r.pos_n as i64)),
                ("neg_n", crate::report::J::Int(r.neg_n as i64)),
                ("adequately_sampled", crate::report::J::S(r.is_adequately_sampled().to_string())),
            ]));
        }
    }
    let features_array = format!("[{}]", rows_json.join(","));
    let (fingerprint, _) = {
        // P17A 的闭集指纹（本模块只作交叉引用）。
        (crate::report::p16_sidecar_schema_fingerprint(), ())
    };
    let _ = fingerprint;
    let json = {
        let with_rows = crate::report::merge_into_object(
            &crate::report::provenance_json(&p),
            &[("rows", features_array.clone())],
        );
        with_rows
    };
    (md, json)
}

/// **确定性**：同输入两次运行**逐字节相同**（产物可复现的前提）。
#[test]
fn identical_inputs_produce_byte_identical_output() {
    let (md1, json1) = render_artifacts("test");
    let (md2, json2) = render_artifacts("test");
    assert_eq!(md1, md2, "同输入的 Markdown 两次不同——产物不可复现");
    assert_eq!(json1, json2, "同输入的 JSON 两次不同——产物不可复现");
    assert!(!md1.is_empty() && !json1.is_empty());
}

/// **落盘 JSON 必须结构合法**（P16 缺陷 1/2 的直接防线）。
#[test]
fn rendered_json_is_structurally_valid() {
    let (_, json) = render_artifacts("test");
    crate::report::json_looks_well_formed(&json)
        .unwrap_or_else(|e| panic!("渲染出的 JSON 结构非法：{e}\n---\n{json}"));
    // 关键字段存在（键名与 provenance 逐字一致）。
    for key in [
        "\"caliber_version\"",
        "\"test_source_fingerprint\"",
        "\"has_intent_snapshots\"",
        "\"rows\"",
    ] {
        assert!(json.contains(key), "JSON 缺关键字段 {key}");
    }
}

/// **校验器自身有判别力**：喂它 P16 缺陷 1 的坏形态（少一个 `}`）必须报错。
#[test]
fn json_validator_rejects_the_known_bad_shapes() {
    let (_, good) = render_artifacts("test");
    assert!(crate::report::json_looks_well_formed(&good).is_ok(), "合法 JSON 被误判为坏");
    // 缺陷 1 的形态：`trim_end_matches` 剥多字符 ⇒ **少一个 `}`**。
    //
    // ⚠️ 构造必须**真的坏**：渲染出的 JSON 顶层以**单个** `}` 收尾，
    // 故 `trim_end_matches('}') + "}"` 会**原样还原**（首版就这么写，本测试当场红）。
    // 真正的缺陷形态是「**嵌套对象**少一个括号」——把第 2 个 `}` 删掉：
    // `{"a":{"b":1}` 这类。故这里直接删内部那个 `}`。
    let bad = &good[..good.len() - 1]; // 删掉最外层收尾的 `}`
    assert!(
        crate::report::json_looks_well_formed(bad).is_err(),
        "少最外层 `}}` 的坏形态被放过——校验器无判别力"
    );
    // 嵌套层少一个括号（缺陷 1 的形态：内部子对象未闭合）。
    let inner_bad = good.replacen('}', "", 1);
    assert!(
        crate::report::json_looks_well_formed(&inner_bad).is_err(),
        "内部少一个 `}}` 的坏形态被放过"
    );
    // 括号不平衡的另一形态：多一个 `}`。
    let bad2 = format!("{good}}}");
    assert!(crate::report::json_looks_well_formed(&bad2).is_err(), "多一个 `}}` 被放过");
    // 空文档。
    assert!(crate::report::json_looks_well_formed("").is_err(), "空文档被放过");
}

/// **`merge_into_object` 必须只剥一个 `}`**——P16 缺陷 1 的回归守卫。
///
/// 定向变异：把 `strip_suffix('}')` 换回 `trim_end_matches('}')` ⇒ 本测试红。
#[test]
fn merge_into_object_strips_exactly_one_brace() {
    let base = "{\"a\":{\"b\":1}}"; // 结尾是 `}}`
    let merged = crate::report::merge_into_object(base, &[("c", "2".to_string())]);
    crate::report::json_looks_well_formed(&merged)
        .unwrap_or_else(|e| panic!("合并后 JSON 非法（多半是剥多了 `}}`）：{e}\n{merged}"));
    assert!(merged.contains("\"c\":2"), "合并未加入新键：{merged}");
    // 反证条：坏 base（不以 `}` 结尾）必须 panic 而非静默拼坏。
    let caught = std::panic::catch_unwind(|| {
        crate::report::merge_into_object("{\"a\":1", &[("c", "2".to_string())])
    });
    assert!(caught.is_err(), "不以 `}}` 结尾的 base 被静默接受——坏 JSON 会溜过去");
}

/// **产物与源码同源**（补 `engine_source_fingerprint` 对测试文件的盲区）——
/// 落盘产物存在时，其 `test_source_fingerprint` 必须等于**当前源码**算出的值。
///
/// ⚠️ **不断言 `source_commit == HEAD`**（P16 缺陷 4 的教训：那是**自失效**的——
/// 产物是 gitignored 的本地文件，任何一次提交都会把 HEAD 推过它记录的 commit，
/// 于是「提交修复」这个动作本身就让测试红）。判据是**内容**不是**标签**。
#[test]
fn on_disk_artifacts_share_the_current_source_fingerprint() {
    let dir = crate::report::out_dir();
    let current = crate::report::test_source_fingerprint();
    let mut checked = 0usize;
    for mode in ["canary", "baseline"] {
        let md_path = dir.join(format!("{mode}.md"));
        let json_path = dir.join(format!("{mode}.json"));
        let Ok(text) = std::fs::read_to_string(&md_path) else {
            continue;
        };
        assert!(
            text.contains(&current),
            "落盘产物 `{}` 的 `test_source_fingerprint` 与**当前源码**不符——产物陈旧\
             （改了 `tests/p124/*` 后没重跑产物门）。当前源码指纹 = {current}\n\
             重跑：`P124_SOURCE_COMMIT=$(git rev-parse HEAD) cargo test --release \
             --test p124_intent_observations -- --ignored --nocapture`",
            md_path.display()
        );
        // 落盘 JSON 必须结构合法。
        let jtext = std::fs::read_to_string(&json_path)
            .unwrap_or_else(|_| panic!("有 `{mode}.md` 却无 `{mode}.json`——产物不成对"));
        crate::report::json_looks_well_formed(&jtext)
            .unwrap_or_else(|e| panic!("落盘 JSON `{}` 结构非法：{e}", json_path.display()));
        // ⚠️ **纯内容不变量**（第 3 轮 P1 的处置，**默认套件执行**）：
        // 「产物不得声称自己在脏树上产出，除非明确 override」。
        // 这条在**干净树**上也能跑（读产物内容，不需造脏）：若落盘门被绕过、在脏树上写了
        // 产物，产物会记 `worktree_dirty=true` 而 `worktree_override=false` ⇒ 当场红。
        let recorded_dirty = text.lines().any(|l| l.contains("| `worktree_dirty` | `true` |"));
        let recorded_override = text.lines().any(|l| l.contains("| `worktree_override` | `true` |"));
        let real_dirty = crate::report::worktree_is_dirty();
        assert_eq!(
            recorded_dirty, real_dirty,
            "产物 `{}` 记的 `worktree_dirty={recorded_dirty}`，而真跑 `git status --porcelain` \
             得 `{real_dirty}`——provenance 的这栏撒了谎（记录值必须来自真跑，不得是常量）",
            md_path.display()
        );
        assert!(
            !(recorded_dirty && !recorded_override),
            "产物 `{}` 声称自己在**脏树**上产出（`worktree_dirty=true`）却没有 `worktree_override` \
             ——落盘门被绕过了（它本该拒绝在脏树上写）。这是第 3 轮审阅点名的 P1 形态：\
             门可以在干净树测试里被摘掉而无人察觉。",
            md_path.display()
        );
        // `source_commit` 标签合理性：40 位 hex 且是 HEAD 的祖先（**不要求 == HEAD**）。
        let recorded = text
            .lines()
            .find(|l| l.contains("`source_commit`"))
            .and_then(|l| {
                l.split('`')
                    .filter(|t| t.len() == 40 && t.chars().all(|c| c.is_ascii_hexdigit()))
                    .next_back()
            })
            .map(|s| s.to_string());
        let rec = recorded.unwrap_or_else(|| {
            panic!("落盘产物 `{}` 找不到 40 位 hex 的 `source_commit`", md_path.display())
        });
        assert_ne!(rec, "unknown", "产物 `source_commit` 是 unknown——产物门须传 `P124_SOURCE_COMMIT`");
        // ⚠️ 显式 match 三种退出码（P16 缺陷 4 第二版的教训：`.ok().map(success)` 会把
        // 「ref 不存在(128)」静默放行——那是假守卫）。
        let out = std::process::Command::new("git")
            .args(["merge-base", "--is-ancestor", &rec, "HEAD"])
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .status();
        match out {
            Ok(st) if st.success() => {}
            Ok(st) if st.code() == Some(1) => panic!(
                "产物 `source_commit`（{rec}）不是 HEAD 的祖先——来自别的分支/fork"
            ),
            Ok(st) if st.code() == Some(128) => {
                panic!("产物 `source_commit`（{rec}）在本仓库不存在（git 退出 128）——标签是编的")
            }
            Ok(st) => panic!("`git merge-base --is-ancestor` 意外退出码 {:?}", st.code()),
            Err(_) => println!("无 git，跳过祖先检查"),
        }
        checked += 1;
    }
    if checked == 0 {
        println!("未发现落盘产物 → 跳过（新 worktree 的正常状态）");
    } else {
        println!("核过 {checked} 份产物：内容指纹 == 当前源码，且 source_commit 是 HEAD 的祖先");
    }
}

/// 写一份产物到盘（`{name}.md` + `{name}.json`）——落盘测试共用。
///
/// ⚠️ **工作树脏时拒绝落盘**（独立审阅 P1-2 的处置）：产物记的是**产出时的 HEAD**，
/// 若工作树有未提交改动，产物内容与 commit 标签就**说不通**（实测：`canary.json` 记
/// `3baff0f`，而内嵌指纹对应当前工作树源码）。**内容绑定**靠 `test_source_fingerprint`
/// （硬门），本检查补的是**标签语义**——让「产物来自哪份源码」不再有歧义。
///
/// 要**故意**在脏树上落盘（例如本地调试），设 `P124_ALLOW_DIRTY=1`——此时 provenance
/// 的 `worktree_dirty` 记 `true`，读者可据此判断。
fn write_artifacts(name: &str) -> String {
    // ⚠️ 判断走**纯函数**（见 `report::artifact_write_guard` 的 doc：内联版本无默认测试保护，
    // 独立审阅第 2 轮实测 no-op 变异可存活整套）。
    let dirty = crate::report::worktree_is_dirty();
    let allow = std::env::var("P124_ALLOW_DIRTY").is_ok();
    if let Err(why) = crate::report::artifact_write_guard(dirty, allow) {
        panic!("{why}\ngit status --porcelain:\n{}", crate::report::worktree_status_porcelain());
    }
    let (md, json) = render_artifacts(name);
    let dir = crate::report::out_dir();
    std::fs::create_dir_all(&dir).unwrap_or_else(|e| panic!("建目录 {} 失败：{e}", dir.display()));
    std::fs::write(dir.join(format!("{name}.md")), &md).expect("写 md 失败");
    std::fs::write(dir.join(format!("{name}.json")), &json).expect("写 json 失败");
    dir.display().to_string()
}

/// **`#[ignore]` 门：canary 产物**（30 seed，与 `GATE_SEEDS` 同区间）。
///
/// 跑法：`P124_SOURCE_COMMIT=$(git rev-parse HEAD) cargo test --release \
/// --test p124_intent_observations -- --ignored --nocapture p124_canary`
#[test]
#[ignore = "30 seed × 90 分钟；显式跑：--release -- --ignored --nocapture p124_canary"]
fn p124_canary() {
    let dir = write_artifacts("canary");
    let p = crate::report::build_provenance("canary", GATE_SEEDS.0, GATE_SEEDS.1, DUR);
    assert_ne!(
        p.source_commit, "unknown",
        "产物门须传 `P124_SOURCE_COMMIT=$(git rev-parse HEAD)`——否则 provenance 的 commit 无意义"
    );
    // 落盘后立刻自检（落盘门不该产出坏 JSON）。
    let json = std::fs::read_to_string(crate::report::out_dir().join("canary.json")).unwrap();
    crate::report::json_looks_well_formed(&json).expect("落盘 JSON 结构非法");
    println!("[p124:canary] 产物写入 {dir}（caliber_version={}）", p.caliber_version);
}

/// **`#[ignore]` 门：baseline 产物**（300 seed，与 P16 的 300 seed 基线同区间，
/// 供「两组数字不可跨 seed 数互换」的对照——见 P16 的 `0.855 / 0.862` 教训）。
///
/// 跑法：`P124_SOURCE_COMMIT=$(git rev-parse HEAD) cargo test --release \
/// --test p124_intent_observations -- --ignored --nocapture p124_baseline`
#[test]
#[ignore = "300 seed × 90 分钟；显式跑：--release -- --ignored --nocapture p124_baseline"]
fn p124_baseline() {
    // ⚠️ **本门用 300 seed**，与默认套件的 30 seed **是两个口径**——产物 provenance 记了
    // seed 区间，故两组数字在产物层可区分（P16 的教训：数字不可跨口径互换）。
    let pw = {
        let mut feats: Vec<(usize, crate::gate::EpisodeFeature)> = Vec::new();
        let mut facts: Vec<Option<crate::reference::ActionFacts>> = Vec::new();
        let mut intents: Vec<crate::intent::EpisodeIntent> = Vec::new();
        let mut offset = 0usize;
        for seed in 1u64..=300 {
            let dm = observe(seed);
            let n = dm.possession_episodes.len();
            let f = crate::gate::episode_features(&dm);
            let a = crate::gate::action_facts(&dm);
            let i = crate::intent::match_intents(
                &dm.intent_snapshots,
                &dm.defensive_intents,
                &dm.possession_episodes,
            );
            assert_eq!(f.len(), n);
            assert_eq!(a.len(), n);
            assert_eq!(i.len(), n);
            feats.extend(f.into_iter().map(|(k, e)| (k + offset, e)));
            facts.extend(a);
            intents.extend(i);
            offset += n;
        }
        crate::pool::PooledWithIntent {
            pool: crate::probe::Pooled { feats, facts, seeds: (1, 300) },
            intents,
        }
    };
    let t = crate::phasegate::verdict_table(&pw.pool, &pw.intents);
    let p16_bp = t.p16_baseline_build_vs_prog().expect("应可算");
    println!(
        "[p124:baseline] 300 seed / {} episode：P16 forward_m/s 对 build_up vs progression = {p16_bp:.3}",
        pw.pool.len()
    );
    // 与 30 seed 口径的对照（**两条都在，别互相替代**）。
    assert!(
        (p16_bp - 0.431).abs() <= 0.06,
        "300 seed 的 P16 基线应 ≈0.431（P16 记录值）——实测 {p16_bp:.3}"
    );
    let dir = write_artifacts("baseline");
    println!("[p124:baseline] 产物写入 {dir}");
}

/// **provenance 携带可比性三件套**——两次运行可比的前提（同 P16 的形态）。
#[test]
fn provenance_carries_the_comparability_triple() {
    let p = crate::report::build_provenance("test", 1, 1, DUR);
    assert!(!p.engine_source_fingerprint.is_empty());
    assert!(!p.test_source_fingerprint.is_empty());
    assert!(!p.caliber_version.is_empty());
    assert!(
        p.engine_source_fingerprint.starts_with("fnv1a64:")
            && p.test_source_fingerprint.starts_with("fnv1a64:"),
        "指纹应形如 fnv1a64:…"
    );
    // `has_intent_snapshots` 是**活探测**（不是硬编码）——它必须与真跑一场的结果一致。
    let dm = observe(1);
    assert!(!dm.intent_snapshots.is_empty(), "真跑一场应有意图快照");
    assert!(
        p.has_intent_snapshots,
        "provenance 的 `has_intent_snapshots` 应为 true（真跑有快照）——硬编码/探测失效"
    );
    // 口径快照必须列出驱动判据的活常量（否则 reviewer 得读源码才能核对）。
    let names: Vec<&str> = p.caliber.iter().map(|(k, _)| *k).collect();
    for need in [
        "window_seconds",
        "min_side_for_separability",
        "counter_proof_expected",
        "gate_seed_first",
        "gate_seed_last",
    ] {
        assert!(
            names.contains(&need),
            "口径快照缺 `{need}`（它是驱动判据的活常量）——当前：{names:?}"
        );
    }
}

/// **落盘门有判别力**——独立审阅第 2 轮 P1 的处置。
///
/// ## 为什么单独测纯函数
///
/// 落盘门（`write_artifacts`）只在两个 `#[ignore]` 产物门里被调用，**默认套件从不执行它**。
/// 实测：把 `worktree_is_dirty()` 改成恒 `false`，**整套 32 条仍绿**，
/// 而脏树上产物门照写、写出 `worktree_dirty=false`——**正是 P1-2 要消灭的缺陷被原样复活**。
/// ⇒ 本测试直接喂三种组合给纯函数 [`crate::report::artifact_write_guard`]。
///
/// ⚠️ **不能用「字段 == 它的来源函数」当判据**（那是把函数与自己比，对任何桩恒真）——
/// 独立审阅第 2 轮指出的原版缺陷。本测试断言的是**决策行为**。
#[test]
fn artifact_write_guard_has_discriminating_power() {
    use crate::report::artifact_write_guard;
    // ① 脏 + 不允许 ⇒ **拒绝**（这是 P1-2 的核心：脏树不得静默落盘）。
    assert!(
        artifact_write_guard(true, false).is_err(),
        "脏树 + 未设 `P124_ALLOW_DIRTY` 时必须**拒绝**落盘——否则产物会记一个与内容不符的 commit"
    );
    // ② 脏 + 显式允许 ⇒ 放行（且 provenance 会记 `worktree_dirty=true`）。
    assert!(
        artifact_write_guard(true, true).is_ok(),
        "显式设 `P124_ALLOW_DIRTY=1` 时应放行（本地调试用途）"
    );
    // ③ 干净 ⇒ 放行。
    assert!(
        artifact_write_guard(false, false).is_ok(),
        "干净树必须放行"
    );
    // 反证条：① 与 ③ 必须**结果不同**——否则本函数对 `dirty` 无区分度（恒 Err 或恒 Ok）。
    assert_ne!(
        artifact_write_guard(true, false).is_err(),
        artifact_write_guard(false, false).is_err(),
        "本函数对 `dirty` 无区分度（恒 Err 或恒 Ok）——不是守卫"
    );
    // 而 `worktree_is_dirty` 本身必须反映真实的 `git status`（两者都调同一个 porcelain）。
    let real = !crate::report::worktree_status_porcelain().is_empty();
    assert_eq!(
        crate::report::worktree_is_dirty(),
        real,
        "`worktree_is_dirty()` 与真跑 `git status --porcelain` 不一致"
    );
}

/// **provenance 记录工作树状态**（P1-2 的处置）——内容绑定之外的**标签语义补充**。
#[test]
fn provenance_records_worktree_state() {
    let p = crate::report::build_provenance("test", 1, 1, DUR);
    // 本栏**必须**与真跑的 `git status --porcelain` 一致（不是硬编码）。
    let dirty = crate::report::worktree_is_dirty();
    assert_eq!(
        p.worktree_dirty, dirty,
        "provenance 的 `worktree_dirty`（{}）与真跑的 `git status --porcelain`（{dirty}）不符",
        p.worktree_dirty
    );
    // 反证条：本栏**能被观测到为 true**——在本测试进程里无法可靠造脏（会改仓库），
    // 故改为断言「字段存在且类型正确、且 MD/JSON 都有它」（内容活性由落盘门覆盖）。
    let md = crate::report::provenance_markdown(&p);
    let json = crate::report::provenance_json(&p);
    assert!(md.contains("`worktree_dirty`"), "MD provenance 缺 `worktree_dirty`");
    assert!(json.contains("\"worktree_dirty\""), "JSON provenance 缺 `worktree_dirty`");
    // 键名在两份产物里**逐字一致**（P16 的教训：别名会让交叉 grep 失效）。
    assert!(md.contains(&format!("| `worktree_dirty` | `{}` |", p.worktree_dirty)));
}

/// **本 change 不使 P16 的产物指纹陈旧**——`test_source_fingerprint` 覆盖本 change 的源码，
/// 而 **engine 侧指纹**（`engine_source_fingerprint`）与 P16 是**同一清单**：
/// 本 change 改了 `engine/src/*`（接了意图观测），故 P16 的落盘产物会陈旧——**那是预期的**
/// （P16 的守卫会提示重生成 P16 产物）。本测试只钉住「本 change 的指纹确实覆盖了自己的源码」。
#[test]
fn p124_fingerprint_covers_its_own_sources() {
    let p = crate::report::build_provenance("test", 1, 1, DUR);
    // 本 change 的测试源码清单必须**含自己的入口与全部模块**。
    let names: Vec<&str> = crate::report::TEST_SOURCES_P124.iter().map(|(n, _)| *n).collect();
    for need in [
        "p124_intent_observations.rs",
        "p124/probe.rs",
        "p124/purify.rs",
        "p124/pool.rs",
        "p124/intent.rs",
        "p124/phasegate.rs",
        "p124/report.rs",
        // 只读复用的 P16 模块也必须被哈希（改了它们本 change 的数字就变）。
        "p16/gate.rs",
        "p16/reference.rs",
    ] {
        assert!(names.contains(&need), "测试源码指纹清单缺 `{need}`：{names:?}");
    }
    // 引擎侧与 P16 同清单（改 `engine/src/*` 会同时反映在两处）。
    let eng: Vec<&str> = crate::report::ENGINE_SOURCES.iter().map(|(n, _)| *n).collect();
    assert_eq!(eng, vec!["lib.rs", "observation.rs", "rng.rs"]);
    let _ = p;
}

/// **裁决的「最强意图特征」必须只从「样本充足」的行里选**——定向变异抓出来的缺口守卫。
///
/// ## 来由（**变异逼出，不是先想到的**）
///
/// 我最初以为「样本量门槛」+「裁决测试」两条已覆盖产物里的裁决行。**定向变异显示没有**：
/// 把 `best_intent_for_build_vs_prog` 的 `is_adequately_sampled()` 过滤**删掉**，
/// 全套 27 条里**只有一条偶然变红**（落盘产物陈旧——那是**副作用**，因为我刚改过源码；
/// 若在干净树上跑，它会**静默通过**）。
///
/// 而该变异让产物写出「最强意图特征 AUC = 0.281（`first_window_frac`）——
/// 落在 [0.44,0.56] 内」——**自相矛盾的裁决行**：0.281 的两个样本才 12 个，
/// 却被呈现为「最强信号」。这正是本仓「结论对但机制错」的同型：数字没错，
/// 但**读者会得到相反的结论**。
///
/// ⇒ 本测试直接钉住：`best_intent_for_build_vs_prog()` 返回的行必须
/// `is_adequately_sampled()`，且**不得**是 `first_window_frac`（那条恰恰是样本不足的）。
#[test]
fn verdict_best_intent_row_is_adequately_sampled() {
    let pw = pool_gate_seeds_with_intents();
    let t = crate::phasegate::verdict_table(&pw.pool, &pw.intents);
    // 反证条：本 change 确实存在**样本不足**的意图行（否则本测试无判别力）。
    let undersized: Vec<&str> = t
        .build_vs_prog
        .iter()
        .filter(|r| r.provenance == crate::phasegate::Provenance::Intent)
        .filter(|r| !r.is_adequately_sampled())
        .map(|r| r.feature)
        .collect();
    assert!(
        !undersized.is_empty(),
        "本测试期望存在样本不足的意图行（`first_window_frac` / `max_window_ticks`）——\
         一条都没有说明判据失效"
    );
    // 主断言：选中的「最强」行必须样本充足，且不是那几条样本不足的。
    let best = t
        .best_intent_for_build_vs_prog()
        .expect("应选出一行「最强意图特征」（30 seed 下确有样本充足的意图行）");
    assert!(
        best.is_adequately_sampled(),
        "裁决选出的「最强意图特征」`{}` 的 pos={} neg={} **样本不足**——\
         产物会把它呈现为「最强信号」，而它其实是 12 个样本上的噪声（本仓「结论对但机制错」同型）",
        best.feature,
        best.pos_n,
        best.neg_n
    );
    assert!(
        !undersized.contains(&best.feature),
        "裁决选出的「最强」不允许是样本不足行 `{}`",
        best.feature
    );
    // **方向也钉住**（独立审阅实测：把 `max_by` 换成 `min_by` 方向反转后全套仍绿）。
    // 「最强」的定义是 **|AUC − 0.5| 最大**——反转会选出最弱的那条（如 `setup_share` 0.500），
    // 产物就会写「最强意图特征：X，AUC=0.500」，标签假而裁决文字仍真 ⇒ 静默误导。
    let expect_max = t
        .build_vs_prog
        .iter()
        .filter(|r| r.provenance == crate::phasegate::Provenance::Intent)
        .filter(|r| r.is_adequately_sampled())
        .filter_map(|r| r.auc)
        .map(|a| (a - 0.5).abs())
        .fold(f64::NEG_INFINITY, f64::max);
    let got = (best.auc.unwrap() - 0.5).abs();
    assert!(
        (got - expect_max).abs() < 1e-12,
        "裁决的「最强」选的是 `{}`（|Δ|={got:.4}），但样本充足的非循环意图行里 |Δ| 最大是          {expect_max:.4}——`max_by` 的**方向**被改动了（应选 |AUC−0.5| 最大者）",
        best.feature
    );
}

/// **窗口三条特征与射门机制同源**——P0-1 的机制守卫（与 `def_none` 那条同形）。
///
/// ## 机制（读代码 + 实测，**独立审阅抓到，比 `def_none` 更强**）
///
/// **非头球射门只能由起脚窗口产出**（`CarrierExecution::Shoot` 是唯一生产者），
/// 且窗口的时长预算只有 ~1 拍——**那一拍就是射门前一拍**。实测 30 seed：
/// `final_third` episode 的 `in_window` 拍数分布 `{0: 33, 1: 493, 2: 15}`，
/// **493/541 的窗口拍恰好落在「射门前一拍」**。
/// ⇒ `window_opened` 在 `final_third` 上 ≈「本 episode 以射门收尾」的另一写法，
/// 而参考集谓词 `ends_shot` 的**定义就是这个**。
///
/// ## 本测试钉住两件事
///
/// ① **机制**：`final_third` episode 的窗口拍，绝大多数是射门前一拍（≥0.85）；
/// ② **判别力**：窗口三条在 `final_third` 表里必须标 `[循环·仅对照]`。
///
/// ⚠️ 若哪天引擎改了（例如窗口能开很久、或射门能从别的路径产生），本测试变红，
/// 那条「循环」标注必须一起更新——不让一条陈旧的解释留在产物里（同 `def_none` 的处置）。
#[test]
fn window_features_are_mechanically_tied_to_shots() {
    let mut hist: std::collections::BTreeMap<usize, usize> = Default::default();
    let mut total = 0usize;
    let mut pre_shot = 0usize;
    for seed in GATE_SEEDS.0..=GATE_SEEDS.1 {
        let dm = observe(seed);
        let shot_ts: std::collections::BTreeSet<i64> = dm
            .events
            .iter()
            .filter(|e| e.type_ == fm_engine::EventType::Shot)
            .map(|e| (e.t * 1000.0).round() as i64)
            .collect();
        let facts = crate::gate::action_facts(&dm);
        for (i, f) in facts.iter().enumerate() {
            let Some(f) = f else { continue };
            if !f.ends_shot {
                continue;
            }
            let ep = &dm.possession_episodes[i];
            let end = ep
                .end_t
                .map(|t| t.value)
                .unwrap_or(dm.intent_snapshots.last().map(|s| s.t.value).unwrap_or(0.0));
            let ticks: Vec<i64> = dm
                .intent_snapshots
                .iter()
                .filter(|s| {
                    s.t.value + 1e-9 >= ep.start_t.value && s.t.value <= end + 1e-9
                })
                .filter(|s| s.state.in_window)
                .map(|s| (s.t.value * 1000.0).round() as i64)
                .collect();
            *hist.entry(ticks.len()).or_insert(0) += 1;
            total += 1;
            // 「全部窗口拍都是射门前一拍」（`t + 1s` 是某个射门时刻）。
            if !ticks.is_empty() && ticks.iter().all(|t| shot_ts.contains(&(*t + 1000))) {
                pre_shot += 1;
            }
        }
    }
    println!("final_third={total} in_window 拍数分布={hist:?}；窗口拍全为射门前一拍 = {pre_shot}/{total}");
    assert!(total > 100, "final_third 样本过少：{total}");
    // ① 时长预算 ~1 拍：绝大多数 episode 只有 1 个窗口拍。
    let one = *hist.get(&1).unwrap_or(&0);
    assert!(
        one * 2 > total,
        "窗口拍数为 1 的 episode 只有 {one}/{total}——窗口的「1 拍预算」前提不成立，\
         本条「机制同源」的理由须重写"
    );
    // ② 那些窗口拍就是射门前一拍。
    let share = pre_shot as f64 / total as f64;
    assert!(
        share >= 0.85,
        "窗口拍落在「射门前一拍」的比例只有 {share:.3}（{pre_shot}/{total}）——\
         低于 0.85 说明窗口与射门的机制耦合已松动，`[循环·仅对照]` 的标注须复核"
    );
}

/// **意图特征的「定义」被钉住**——P2 批（独立审阅：4 个语义漂移变异全部存活）。
///
/// ## 为什么需要（每条都对应一个**实测存活**的变异）
///
/// | 变异 | 后果 | 本测试的判据 |
/// |---|---|---|
/// | `first_window_frac` 改取**最后**一个 `in_window` 拍 | AUC 0.850→0.312 | 断言它 = **首个** `in_window` 拍的归一化时刻 |
/// | `pressure_share` 用 `>= 0`（恒真） | AUC 0.372→0.500 | 断言「无压迫拍」**不计入** |
/// | `window_opened` 改用 `has_shot_setup` | 判别位混用 | 断言「有序列但未进窗口」的拍**不算**开窗 |
///
/// ⚠️ **fixture 取值生产可达**（本仓 P15/P17A 教训）：三种拍都在真实数据里出现——
/// 无序列 / 有序列未进窗口（推进相）/ 已进窗口（`intent_semantics_are_pinned` 已实测三者
/// 都非空）。构造的是「这些拍在窗内的相对顺序」，不是生产不可达的组合。
#[test]
fn intent_feature_definitions_are_pinned() {
    let snap = |t: f64, st: IntentState| IntentSnapshot {
        t: ObservedTime::state_commit(t),
        state: st,
    };
    // 推进相：有序列、未进窗口、无压迫。
    let driving = IntentState {
        has_shot_setup: true,
        in_window: false,
        window_ticks: 0,
        drive_ticks_left: 7,
        committed: false,
        entry_pressure_bucket: 0,
        pressure_state_ticks: 0,
    };
    // 窗口相：已进窗口（第 3 个决策 tick）。
    let in_win = IntentState {
        has_shot_setup: true,
        in_window: true,
        window_ticks: 3,
        drive_ticks_left: 7,
        committed: false,
        entry_pressure_bucket: 0,
        pressure_state_ticks: 2, // 有压迫
    };
    // 窗 `[10, 20]`，时长 10s。第 12s 进窗（首个 in_window 拍），第 18s 仍在窗口。
    let snaps = vec![
        snap(10.0, IntentState::no_shot_setup(0)), // 无序列
        snap(12.0, in_win),                        // 首个 in_window
        snap(14.0, driving),                       // 有序列未进窗口（推进相）
        snap(18.0, in_win),                        // 又一个 in_window
    ];
    let it = crate::intent::episode_intent(&snaps, &[], 10.0, 20.0, Some(10.0));

    // ① `window_opened` 来自 `in_window`（不是 `has_shot_setup`）：
    //    本 episode 既有「有序列未进窗口」的拍（14s），也有 `in_window` 拍 ⇒ 两者都成立，
    //    故这里改用**另一个只有推进相**的 episode 来分辨。
    let only_driving = vec![snap(10.0, driving), snap(12.0, driving)];
    let it_drive = crate::intent::episode_intent(&only_driving, &[], 10.0, 12.0, Some(2.0));
    assert!(
        it_drive.setup_share == Some(1.0),
        "该 episode 每拍都有起脚序列 ⇒ `setup_share` 应为 1.0"
    );
    assert!(
        !it_drive.window_opened,
        "**有起脚序列但从未进窗口**（推进相）的 episode，`window_opened` 必须为 `false`\
         ——它若为 `true`，说明这个特征读的是 `has_shot_setup` 而不是 `in_window`\
         （独立审阅实测该变异全套测试仍绿）"
    );
    assert_eq!(
        it_drive.window_share,
        Some(0.0),
        "从未进窗口 ⇒ `window_share` 应为 0.0（不是 None：本 episode 有有效拍）"
    );

    // ② `first_window_frac` = **首个** `in_window` 拍（12.0 → (12−10)/10 = 0.2），
    //    不是最后一个（18.0 → 0.8）。
    assert_eq!(
        it.first_window_frac,
        Some(0.2),
        "`first_window_frac` 必须是**首个** `in_window` 拍的归一化时刻（0.2），\
         实测 {:?}——若是 0.8 说明取的是最后一拍（独立审阅实测该变异存活）",
        it.first_window_frac
    );

    // ③ `pressure_share` 只数**有压迫**的拍（`12.0` 与 `18.0` 两拍有压迫、10.0/14.0 无）⇒ 2/4。
    assert_eq!(
        it.pressure_share,
        Some(0.5),
        "`pressure_share` 应是「压迫 tick 数 > 0」的拍占比（2/4=0.5）——\
         实测 {:?}；若是 1.0 说明条件写成了恒真（`>= 0`）",
        it.pressure_share
    );
    assert_eq!(
        it.pressure_mean,
        Some(1.0),
        "`pressure_mean` 应是逐拍均值 (0+2+0+2)/4 = 1.0（**含无压迫拍**，不是只对有压迫的拍取均值）\
         ——实测 {:?}；若为 2.0 说明分母只数了有压迫的拍",
        it.pressure_mean
    );
    // ④ `max_window_ticks` = 该 episode 内 `window_ticks` 的最大值（3）。
    assert_eq!(
        it.max_window_ticks,
        Some(3),
        "`max_window_ticks` 应是窗口内已消耗决策 tick 的最大值（3）"
    );
}
