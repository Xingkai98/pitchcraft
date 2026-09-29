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
