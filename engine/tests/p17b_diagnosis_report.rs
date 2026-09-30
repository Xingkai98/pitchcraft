//! P17B（#17B）：可解释诊断报告。
//!
//! 本 change **只读公开 API**（`simulate_with_behavior_observations` + `observation` 模块公开类型），
//! **不改任何生成逻辑**：跑位/决策、RNG、正式事件流、golden 全不受影响。守卫是
//! `tests/p15_behavior_observation.rs` 的逐字节一致门仍然全绿（本文件不触碰 `engine/src/`）。
//!
//! ## 三件交付
//!
//! 1. **证据边界表**（`p17b/evidence.rs`）——本 change 的第一交付。每个量落到哪个公开字段、
//!    是**观测**还是**派生**，落成**枚举**（字段改名即编译不过），并逐条记录**它是怎么被核对的**。
//! 2. **L1 逐 episode 诊断卡**（`p17b/episode.rs`）——把 P17A 的**聚合**异常降到**逐 episode**。
//! 3. **覆盖缺口逐项声明**（`p17b/reasons.rs`）——**本 change 的立身之本**：占丢球 36% 的
//!    `interception_loose` **一次都不产 loose beat**，报告必须**按成因**声明，不得给笼统的「可答」。
//!
//! ## 分层（对齐 `CLAUDE.md` 的分层验证表）
//!
//! | 本文件的测试 | 判据层 | 默认跑? |
//! |---|---|---|
//! | [`formal_path_is_byte_identical_and_produces_no_observations`] | 只读投影（正式路径逐字节 + 空操作） | ✅ |
//! | [`evidence_table_lists_every_locus_and_every_row_is_readable`] | 证据边界（表不漏项 + 落点可读） | ✅ |
//! | [`locus_read_probes_actually_read_the_field`] | 证据边界（**落点探针有判别力**） | ✅ |
//! | [`closed_set_coverage_is_declared_for_every_contest_reason`] | 覆盖缺口（**每个成因都被声明**） | ✅ |
//! | [`contest_coverage_guard_has_discriminating_power`] | 覆盖缺口（**守卫有判别力**，含反证条） | ✅ |
//! | [`invisible_causes_are_named_not_left_blank`] | 覆盖缺口（**显式「不可见」而非留空**） | ✅ |
//! | [`loose_ball_criterion_excludes_the_restart_prep_window`] | 松散球判据（排除准备期） | ✅ |
//! | [`loose_ball_criterion_guard_has_discriminating_power`] | 松散球判据（**变异判红**） | ✅ |
//! | [`restart_window_falls_back_explicitly_when_taken_t_is_missing`] | 松散球判据（`taken_t` 缺失行为） | ✅ |
//! | [`pursuit_roles_are_classified_never_merged`] | 动作归因（**不并称**） | ✅ |
//! | [`pursuit_role_guard_has_discriminating_power`] | 动作归因（**变异判红**） | ✅ |
//! | [`unknown_is_recorded_never_guessed`] | 缺证据（显式 unknown） | ✅ |
//! | [`replay_locators_resolve_to_real_events_with_consistent_time`] | 回放（定位有效） | ✅ |
//! | [`wording_guard_rejects_phase_vocabulary_after_stripping_comments`] | 措辞（源码扫描，**剥注释 + 反证条**） | ✅ |
//! | [`support_caliber_is_live_read_from_p16_not_copied`] | 同源（活读而非复制） | ✅ |
//! | [`exception_thresholds_match_the_p17a_rules`] | 同源（阈值与 P17A 逐位一致） | ✅ |
//! | [`action_tokens_match_the_p17a_reference`] | 同源（行为层：token 序列一致） | ✅ |
//! | [`every_p17a_anomaly_rule_is_declared_in_the_per_episode_map`] | 覆盖 P17A 异常（**逐条声明**） | ✅ |
//! | [`instant_contest_uses_the_contest_duration_not_the_possession_duration`] | 异常口径（**争抢时长 vs possession 时长**） | ✅ |
//! | [`instant_contest_covers_only_the_episode_closing_share_of_a2`] | 异常口径（**只覆盖 A2 母体的 ~70%**） | ✅ |
//! | [`pursuit_window_spans_the_whole_contest_not_just_the_closing_tick`] | 追球段口径（**争抢窗 vs 收束拍**） | ✅ |
//! | [`match_gap_count_probe_actually_counts`] | 观察可信度（`gap_count()` 行为被钉住） | ✅ |
//! | [`loose_census_reproduces_the_design_caliber_and_differs_from_the_card_caliber`] | 普查口径（**与 design 同分母 / 两口径可分**） | ✅ |
//! | [`a_contest_fact_closes_at_most_one_episode`] | 争抢归属（**同刻多段只归最靠前那段**） | ✅ |
//! | [`observation_credibility_gate_annotates_but_keeps`] | 前置门（标注但保留、不进聚合） | ✅ |
//! | [`spec_anomaly_coverage_blocks_carry_both_halves`] | 规范一致性（**块判**） | ✅ |
//! | [`spec_anomaly_coverage_guard_is_not_vacuous`] | 规范一致性（**反证条**） | ✅ |
//! | [`report_is_deterministic_and_self_describing`] | 产物（确定性 + 产物自带边界） | ✅ |
//! | [`aggregates_are_not_vacuous_on_real_seeds`] | 防空转（真实路径下限） | ✅ |
//! | [`on_disk_artifacts_share_the_current_source_fingerprints`] | 产物（与源码同源） | ✅ |
//! | `p17b_canary` / `p17b_baseline` | 产物落盘（30 / 300 seed） | ❌ `#[ignore]` |
//!
//! 跑法：
//!
//! ```text
//! # 默认快速门
//! cargo test --test p17b_diagnosis_report
//! # canary 产物（30 seed，L1 全覆盖）
//! P17B_SOURCE_COMMIT=$(git rev-parse HEAD) \
//!   cargo test --release --test p17b_diagnosis_report -- --ignored --nocapture p17b_canary
//! # 300 seed 基线产物（L1 按异常筛选）
//! P17B_SOURCE_COMMIT=$(git rev-parse HEAD) \
//!   cargo test --release --test p17b_diagnosis_report -- --ignored --nocapture p17b_baseline
//! ```
//!
//! **行号引用会漂**：本文件的注释与文档一律用**符号名**，不写 `lib.rs:NNNN`。

// P16 的接应口径——**活读**（`#[path]` include），不是复制。
//
// ⚠️ 设计初稿写「复制最小的口径常量 + 逐位比对守卫」，但**本仓既成做法是 `#[path]` 活读**
// （`tests/p124/report.rs` 直接读 `crate::features::SUPPORT_MAX_DIST_M`）。
// 经用户拍板采用 include：活读时**不存在漂移**——根本就没有第二份常量。
// 代价（如实记录）：`tests/p16/features.rs` 被**两处**编译，p16 的改动会**静默**影响 p17b。
// 兜底见 [`support_caliber_is_live_read_from_p16_not_copied`]（防「有人把常量抄进来」）
// 与 provenance 的 `support_max_dist_m` 口径快照（阈值一变，产物层立刻不可比）。
//
// ⚠️ `allow(dead_code)`：P16 的模块还导出覆盖率 / 静态队形 / 报告等**本 change 不用**的项。
// 允许它们闲置，**不得**为了消警告去改 `tests/p16/*`（那是 P16 的已交付代码，本 change 只读它）。
#[allow(dead_code)]
#[path = "p16/shape.rs"]
mod shape;
// `features.rs` 的 `support_formation` 依赖 `caliber.rs` 的 `attack_dir` / `progress`
// （方向归一）。⚠️ 这正印证设计 §4.2 的「依赖闭包比『两个常量 + 一个谓词』大」——
// 活读的代价是**连它的依赖一起编译**；这也是二选一的真实取舍，不是可以含糊过去的细节。
#[allow(dead_code)]
#[path = "p16/caliber.rs"]
mod caliber;
#[allow(dead_code)]
#[path = "p16/features.rs"]
mod features;
// P17A 的**闭集指纹**与 `fnv1a` —— 那是**口径定义**，必须唯一，故复用而非重写。
#[allow(dead_code)]
#[path = "p17a/model.rs"]
mod model;

#[path = "p17b/evidence.rs"]
mod evidence;
#[path = "p17b/episode.rs"]
mod episode;
#[path = "p17b/reasons.rs"]
mod reasons;
#[path = "p17b/report.rs"]
mod report;

use episode::*;
use evidence::*;
use fm_engine::observation::*;
use fm_engine::{simulate_with_behavior_observations, EventType, MatchConfig, MODEL_VERSION};
use reasons::*;
use report::*;

// ============================== 运行器 ==============================

const DUR: f64 = 5400.0;
/// 默认快速门用的 seed 数。
const QUICK_SEEDS: (u64, u64) = (1, 10);
/// canary：**baseline 的前缀子集**（保证 canary 上的变化在 baseline 可见）。
const CANARY_SEEDS: (u64, u64) = (1, 30);
/// baseline：与 P17A/P16 同区间（便于交叉引用——design §5 待决策 5 的默认）。
const BASELINE_SEEDS: (u64, u64) = (1, 300);

fn cfg() -> MatchConfig {
    MatchConfig {
        match_duration_seconds: DUR,
        demo_mode: false,
        model_version: MODEL_VERSION,
    }
}

fn observe(seed: u64) -> DiagnosticMatch {
    let dm = simulate_with_behavior_observations(seed, cfg());
    assert!(
        dm.is_coherent(),
        "seed {seed} 观察层不自洽：{:?}",
        dm.invariant_violations
    );
    dm
}

fn cards_over(first: u64, last: u64) -> Vec<(u64, MatchCards)> {
    (first..=last).map(|s| (s, cards_of(&observe(s), s))).collect()
}

fn quick() -> Report {
    build_report("canary", QUICK_SEEDS.0, QUICK_SEEDS.1, DUR, &cards_over(QUICK_SEEDS.0, QUICK_SEEDS.1))
}

// ============================== 只读投影 ==============================

/// **正式路径与 opt-in 路径事件流逐字节相同**（spec 的第一个 Requirement）。
///
/// 本 change 的全部代码都在 `engine/tests/` 下、只读公开 API，故这条门**应当**恒绿——
/// 它的价值是**回归哨兵**：若将来有人把诊断逻辑挪进 `engine/src/`，这条门会立刻红。
#[test]
fn formal_path_is_byte_identical_and_produces_no_observations() {
    for seed in 1..=QUICK_SEEDS.1 {
        let formal = fm_engine::simulate(seed, cfg());
        let opt_in = simulate_with_behavior_observations(seed, cfg());
        assert_eq!(
            formal,
            opt_in.events_json(),
            "seed {seed}：正式路径与 opt-in 路径事件流不逐字节相同"
        );
    }
}

// ============================== 证据边界 ==============================

/// 表里每一行都能在本 change 的真实输入上被 [`Locus::read`] 读到。
///
/// ⚠️ 这不是「字段非空」——空 episode 列表是合法输入。它核的是**落点探针本身**：
/// 一个 `read` 里写死了 `false` 的探针会让 `locus_read_probes_actually_read_the_field`
/// 无从区分，故那条测试用**逐变体**的方式证明判别力（见下）。
#[test]
fn evidence_table_lists_every_locus_and_every_row_is_readable() {
    let dm = observe(1);
    // ① 每个 `Locus` 变体都在表里有至少一行（防「常量被引用但不在表里」的假边界）。
    for l in Locus::ALL {
        assert!(
            EVIDENCE_TABLE.iter().any(|r| r.locus == *l),
            "落点 `{}` 在 `EVIDENCE_TABLE` 里没有对应行——表漏项",
            l.as_str()
        );
    }
    // ② 表里每一行在真实输入上可读（落点探针不 panic、且返回可核对的值）。
    for r in EVIDENCE_TABLE {
        let ok = r.locus.read(&dm);
        assert!(
            ok,
            "落点 `{}`（量：{}）在 seed 1 上读不到——要么字段已不存在，要么探针写死了 false",
            r.locus.as_str(),
            r.quantity
        );
    }
    // ③ 每一行的 `how_verified` 非空（本 change 的纪律：表本身出过四次错，每行都要有出处）。
    for r in EVIDENCE_TABLE {
        assert!(
            !r.how_verified.trim().is_empty(),
            "证据表行 `{}` 没写核对方式",
            r.quantity
        );
    }
    // ④ 结构性不可得项必须都写明「验证它需要什么」（design §2 的规则）。
    for u in STRUCTURAL_UNAVAILABLE {
        assert!(!u.what_would_verify.trim().is_empty(), "`{}` 没写「验证它需要什么」", u.quantity);
        assert!(!u.reason.trim().is_empty(), "`{}` 没写不可得的原因", u.quantity);
    }
    // ⑤ 三档 phase 的能力声明必须是「不可得」（本 change 的立场，且必须写在产物里）。
    assert!(
        STRUCTURAL_UNAVAILABLE
            .iter()
            .any(|u| u.quantity.contains("战术阶段")),
        "结构性不可得项里必须显式列出「战术阶段」"
    );
}

/// **落点探针的判别力**：每个 `Locus` 的 `read` 都在**真实输入**上被调用过，
/// 且至少有一个变体**在只缺该字段的输入上转假**。
///
/// 防空转的做法：拿真实 `DiagnosticMatch`，把**逐类型**的容器清空，
/// 断言相关落点随之转假。若某个 `read` 分支写死 `true`，本测试会红。
#[test]
fn locus_read_probes_actually_read_the_field() {
    let dm = observe(1);
    assert!(!dm.possession_episodes.is_empty(), "seed 1 应有 episode");
    assert!(!dm.events.is_empty(), "seed 1 应有事件");
    assert!(!dm.state_snapshots.is_empty(), "seed 1 应有快照");

    let mut no_eps = dm.clone();
    no_eps.possession_episodes.clear();
    let mut no_events = dm.clone();
    no_events.events.clear();
    let mut no_snaps = dm.clone();
    no_snaps.state_snapshots.clear();
    let mut no_intent = dm.clone();
    no_intent.intent_snapshots.clear();
    let mut no_facts = dm.clone();
    no_facts.control_facts.clear();
    let mut no_def = dm.clone();
    no_def.defensive_intents.clear();
    let mut no_restarts = dm.clone();
    no_restarts.restart_sequences.clear();

    for l in Locus::ALL {
        assert!(l.read(&dm), "落点 `{}` 在真实输入上应可读", l.as_str());
        let target_missing = match l {
            Locus::EpisodeStartReason
            | Locus::EpisodeEndReason
            | Locus::EpisodeEventIndexes
            | Locus::EpisodeControlFactIndexes
            | Locus::EpisodeStartT
            | Locus::EpisodeEndT => !l.read(&no_eps),
            Locus::FactKind
            | Locus::FactDetail
            | Locus::FactSourceEventIndex
            | Locus::FactLocation => !l.read(&no_facts),
            Locus::EventType
            | Locus::EventResult
            | Locus::EventDetail
            | Locus::EventPosition
            | Locus::EventTargetPosition
            | Locus::EventKeeperPosition
            | Locus::MoverAction
            | Locus::MoverId
            | Locus::MoverTarget
            | Locus::BallLoose => !l.read(&no_events),
            Locus::SnapshotPos | Locus::SnapshotBall => !l.read(&no_snaps),
            Locus::IntentPressureTicks
            | Locus::IntentShotWindow
            | Locus::IntentCommitted
            | Locus::IntentEntryPressureBucket => !l.read(&no_intent),
            Locus::DefensiveIntentKind | Locus::DefensiveIntentDefender => !l.read(&no_def),
            Locus::RestartStartT | Locus::RestartTakenT | Locus::RestartOpenPlayResumedT => {
                !l.read(&no_restarts)
            }
            // 这两个读的是**整场**的一致性，不随任一容器清空而变。
            //
            // ⚠️ **能力边界（审阅轮 2 的 P2-1 逼出来的如实记录）**：
            // - `MatchCoherence`：`is_coherent()` 在**不自洽输入**上会转假 ⇒ 判别力由
            //   下方的 `bad` 断言证明；
            // - `MatchGapCount`：`gap_count()` 是一个**全函数**（任何输入都给一个 `usize`），
            //   故**不存在**能让它「读不到」的输入 ⇒ 本变体在**运行时无法判别**，
            //   只有**编译期**保证（`gap_count` 改名 / 变私有 ⇒ 本文件编译不过）。
            //   它的**行为**另由 [`match_gap_count_probe_actually_counts`] 直接核。
            //
            // 前一轮在这里把两个变体一起塞进 `=> true` 并写「判别力由不自洽输入证明」，
            // 而紧随的断言只碰了 `MatchCoherence`——`MatchGapCount` 那句是**空的**，
            // 且它引用的测试名当时**并不存在**。能证的和证不到的分开写，才叫标注边界。
            Locus::MatchCoherence | Locus::MatchGapCount => true,
        };
        assert!(
            target_missing,
            "落点 `{}` 的 `read` 在**清空对应容器**后仍返回 true ⇒ 探针没有真的读那个字段（空转）",
            l.as_str()
        );
    }

    // 观察可信度落点的判别力：造一个不自洽的输入。
    let mut bad = dm.clone();
    bad.invariant_violations.push("人为制造".to_string());
    assert!(
        !Locus::MatchCoherence.read(&bad),
        "`is_coherent()` 在带 invariant_violations 的输入上应转假"
    );
    // ⚠️ 本测试**刻意只核 `MatchCoherence`**：`MatchGapCount` 在运行时不可判别
    // （见上方分支注释），它的**行为**由 [`match_gap_count_probe_actually_counts`] 单独核。
    // 前一轮把两件事写成一句「它们的判别力由不自洽输入证明」，而那条断言
    // （`gap_count() >= dm.gap_count()`，`dm.gap_count()==0`）是**恒真**的——
    // 且它引用的测试名当时**不存在**。审阅轮 2 的 P2-1 抓到的正是这一处。
}

// ============================== 覆盖缺口（本 change 的立身之本） ==============================

/// **每个 `ContestStartReason` 都被显式声明覆盖**（spec 的 Scenario「覆盖缺口有守卫」）。
///
/// 这是防 BLOCKER-1 复发的**唯一**机制：闭集多一个成员而 [`CONTEST_COVERAGE`] 没跟上，
/// 本测试立刻红。
#[test]
fn closed_set_coverage_is_declared_for_every_contest_reason() {
    for r in ContestStartReason::ALL {
        let row = coverage_of(*r);
        assert!(
            row.is_some(),
            "争抢成因 `{}` **未被声明覆盖**——「丢球后谁做了什么」的可答性必须逐项声明，\
             不得给笼统的「可答」（BLOCKER-1 的形态）",
            r.as_str()
        );
        let row = row.unwrap();
        assert!(
            !row.mechanism.trim().is_empty(),
            "成因 `{}` 的声明没写机制——「实测如此」不是机制",
            r.as_str()
        );
    }
    // 反向：声明表里不许有闭集里没有的成因（防「加了成员又从闭集删了」的错位）。
    for row in CONTEST_COVERAGE {
        assert!(
            ContestStartReason::ALL.contains(&row.reason),
            "`CONTEST_COVERAGE` 里有闭集成员 `{}`",
            row.reason.as_str()
        );
    }
    assert_eq!(
        CONTEST_COVERAGE.len(),
        contest_reason_count(),
        "声明表条数 {} ≠ 闭集成员数 {}",
        CONTEST_COVERAGE.len(),
        contest_reason_count()
    );
}

/// **覆盖守卫有判别力**：把未声明的成因喂进去必须红。
///
/// 反证条：把 `interception_loose` 从声明表里去掉，[`coverage_of`] 必须返回 `None`
/// ——若它返回 `Some`，说明实现里有兜底（例如 `unwrap_or(Visible)`），
/// 那才是真的危险：**盲区会被静默地报成可答**。
#[test]
fn contest_coverage_guard_has_discriminating_power() {
    // ① 反证条（**本轮修好**：审阅轮 2 的 P2-2 指出前两版都是同义反复）——
    //    直接对**真实现** `coverage_in` 喂一张**缺项的表**，断言它返回 `None`。
    //    若 `coverage_in` 被加上任何兜底（例如「查不到就返回第一行」），本断言会红，
    //    而那正是最危险的变异：**未声明的成因会被静默当成已声明**（BLOCKER-1 的复发形态）。
    let mut holed: Vec<ContestCoverageRow> = CONTEST_COVERAGE.to_vec();
    holed.retain(|r| r.reason != ContestStartReason::InterceptionLoose);
    assert!(
        coverage_in(&holed, ContestStartReason::InterceptionLoose).is_none(),
        "`coverage_in` 在**缺项表**上必须返回 `None`——若返回 `Some`，说明它有兜底，\
         会让未声明的成因被静默当成已声明"
    );
    // 对照：同一张表里**在**的成因仍查得到（否则「一律返回 None」也会让上面那条绿）。
    assert!(
        coverage_in(&holed, ContestStartReason::TackleLoose).is_some(),
        "`coverage_in` 对表里**在**的成因必须返回 `Some`"
    );
    // ② **真入口 `coverage_of` 本身不得有兜底**。
    //
    // ⚠️ 单靠「喂缺项表给 `coverage_in`」**抓不到**在 `coverage_of` 里加的兜底
    // （实测：给 `coverage_of` 加 `.or(Some(&CONTEST_COVERAGE[0]))` 时，上一条断言仍绿，
    // 因为它测的是 `coverage_in`）。而 `coverage_of` 读的是**冻结的 const 表**——
    // 闭集里没有「未声明」的成员可供传入，故它在**运行时无法被判别**。
    // ⇒ 只剩两条能落地的核法，两条都写在这里：
    //   (a) **同一性**：每个闭集成员查回来的行的 `reason` 必须**就是它自己**
    //       （兜底返回第一行会让某成员查回别人的行）；
    //   (b) **源码文本**：`coverage_of` 的函数体里不得出现兜底构造
    //       （`or(` / `unwrap_or` / `unwrap()`）——它只能是**一次纯查找**。
    for r in ContestStartReason::ALL {
        let row = coverage_of(*r).unwrap_or_else(|| panic!("`{}` 未被声明", r.as_str()));
        assert_eq!(
            row.reason,
            *r,
            "`coverage_of` 对 `{}` 查回了 `{}` 的行——查找有兜底（会静默顶替）",
            r.as_str(),
            row.reason.as_str()
        );
    }
    const REASONS_SRC: &str = include_str!("p17b/reasons.rs");
    let body: String = {
        let start = REASONS_SRC
            .find("pub fn coverage_of(")
            .expect("`coverage_of` 必须存在（否则本守卫的扫描对象没了）");
        // 函数体到下一个 `}` 结束（该函数只有一个表达式体，无嵌套块）。
        let rest = &REASONS_SRC[start..];
        let open = rest.find('{').expect("函数应有函数体");
        rest[open..]
            .find('}')
            .map(|e| rest[open..open + e].to_string())
            .unwrap_or_default()
    };
    let body_code = strip_line_comments(&body);
    for banned in ["or(", "unwrap_or", "unwrap()", "unwrap_or_else"] {
        assert!(
            !body_code.contains(banned),
            "`coverage_of` 的函数体里出现 `{banned}`——**它就是一次纯查找，不得有兜底**。\
             兜底会让「未声明的成因」被静默当成已声明（BLOCKER-1 的复发形态）。实际体：{body_code}"
        );
    }
    assert!(
        !body_code.trim().is_empty(),
        "`coverage_of` 的函数体为空 ⇒ 本扫描是空转的（守卫自己先失效了）"
    );
    let undeclared = CONTEST_COVERAGE
        .iter()
        .filter(|r| r.reason == ContestStartReason::InterceptionLoose)
        .count();
    assert_eq!(undeclared, 1, "`interception_loose` 必须且只能声明一次");
    // ② 变异：把「未声明」当作「可答」会怎样？这里核的是**数据**——
    //    `interception_loose` 的声明必须是 `Invisible`（本 change 最容易被写错的一条）。
    let row = coverage_of(ContestStartReason::InterceptionLoose).unwrap();
    assert_eq!(
        row.visibility,
        ContestVisibility::Invisible,
        "`interception_loose` 的声明必须是「追逐不可见」——它是本 change 的核心发现（729/729 不产 loose beat）"
    );
    assert!(
        !reason_is_ever_visible(ContestStartReason::InterceptionLoose),
        "`reason_is_ever_visible` 对 `interception_loose` 必须为假"
    );
    // ③ 对照：`tackle_loose` 必须为**可见**（否则「全断成不可见」也会让本测试绿）。
    assert!(
        reason_is_ever_visible(ContestStartReason::TackleLoose),
        "`tackle_loose` 必须声明为可见（实测 434/434 产 loose beat）——否则声明表整体失真"
    );
}

/// 「时长 0 的争抢」**显式记「追逐不可见」**，不得留空（design §5 待决策 8）。
///
/// 留空会被读成「没发生」——本测试核的是**真实 seed 上的形态**：
/// `interception_loose` 的卡一律落到 `Invisible` 分支，且带**非空**的 `reason`。
#[test]
fn invisible_causes_are_named_not_left_blank() {
    let dm = observe(1);
    let windows = restart_windows(&dm);
    let mut checked = 0usize;
    for ep in &dm.possession_episodes {
        let card = card_of(&dm, &windows, 1, ep);
        if let PursuitView::Invisible { reason, contest_reason } = &card.pursuit {
            checked += 1;
            assert!(
                !reason.trim().is_empty(),
                "episode {} 记了「不可见」却没写原因——留空会被读成「没发生」",
                ep.id
            );
            assert!(
                !contest_reason.trim().is_empty(),
                "episode {} 记了「不可见」却没写成因",
                ep.id
            );
            assert!(
                matches!(
                    *contest_reason,
                    "interception_loose" | "pass_lost" | "delivery_loose" | "tackle_loose" | "shot_rebound"
                ),
                "成因串 `{contest_reason}` 不在闭集里——闭集串名变了？"
            );
        }
    }
    assert!(checked > 0, "seed 1 上应有「追逐不可见」的卡（防空转）");
}

// ============================== 松散球判据（反 BLOCKER-2） ==============================

/// 判据**排除重开准备期**：准备期窗口内的 beat 不计入松散球段。
///
/// 探针实测（30 seed）：准备期共 309 段，`chase` **0 个**——若判据不排除准备期，
/// 这些段会被算作「无人追球」，让「两队都追」的比例从 57% 掉到 43%（侦察初版的失真）。
#[test]
fn loose_ball_criterion_excludes_the_restart_prep_window() {
    let mut prep_windows = 0usize;
    let mut loose_in_prep = 0usize;
    let mut loose_outside = 0usize;
    for seed in QUICK_SEEDS.0..=QUICK_SEEDS.1 {
        let dm = observe(seed);
        let windows = restart_windows(&dm);
        prep_windows += windows.len();
        for ev in dm.events.iter() {
            if ev.type_ != EventType::Beat {
                continue;
            }
            let loose = ev.ball.as_ref().map(|b| b.loose).unwrap_or(false);
            if !loose {
                continue;
            }
            if in_restart_window(&windows, ev.t) {
                loose_in_prep += 1;
            } else {
                loose_outside += 1;
            }
        }
    }
    assert!(prep_windows > 0, "应有重开准备期窗口");
    assert!(
        loose_in_prep > 0,
        "实测准备期内**确有** `loose:true` 的 beat（角球/界外球发球前的走位等待）——\
         若为 0，说明本判据的排除条件已无必要，或探针口径变了"
    );
    assert!(loose_outside > 0, "开球期的松散球 beat 应远多于准备期");
}

/// **判据守卫有判别力**：定向变异（去掉 `!in_restart_window`）必须判红。
///
/// 做法：把「排除准备期」换成裸 `ball.loose`（即 `t >= w.start && t < w.end` 一律算松散球），
/// 在**同一批** seed 上重算松散球段数，断言**两者不等**——相等就说明排除条件没起作用。
#[test]
fn loose_ball_criterion_guard_has_discriminating_power() {
    let mut with_exclusion = 0usize;
    let mut without_exclusion = 0usize;
    for seed in QUICK_SEEDS.0..=QUICK_SEEDS.1 {
        let dm = observe(seed);
        let windows = restart_windows(&dm);
        // 正确判据
        let runs = loose_runs(&dm, &windows, (0.0, None));
        with_exclusion += runs.len();
        // 变异：把窗口当作「不存在」（= 裸用 ball.loose）
        let no_windows: Vec<RestartWindow> = Vec::new();
        let mutant = loose_runs(&dm, &no_windows, (0.0, None));
        without_exclusion += mutant.len();
    }
    assert!(with_exclusion > 0, "正确判据下应有松散球段");
    assert!(
        without_exclusion > with_exclusion,
        "去掉 `!in_restart_window` 后段数**应当变多**（准备期的 loose beat 被算进来）——\
         实测 {without_exclusion} vs {with_exclusion}；若相等，说明排除条件空转"
    );
}

/// `taken_t` 缺失时**必须给出显式行为**，且**实际分布被钉住**（design §5 待决策 3）。
///
/// ## 实测分布（300 seed 实跑，本测试在**同一区间**上核它）
///
/// ```text
///   taken_t            15574
///   open_play_resumed_t    0   ← 防御档，一次都没走到
///   next_restart_start_t   0   ← 防御档，一次都没走到
///   stream_end            10   ← 缺 taken_t 的**全部**是流末那条重开
/// ```
///
/// ## 为什么断言「防御档恒为 0」而不是「防御档偶尔出现也算过」
///
/// 中间两档要走到，必须满足**要么不变量 5 被破坏**（有 `open_play_resumed_t`
/// 却无 `taken_t`），**要么**本段重开被顶掉却没记发球时刻同时后面还有重开。
/// 两者都**不该**在当前引擎上发生。让它们**恒 0** 使本测试成为一个**变化哨兵**：
/// 一旦它们开始出现，说明引擎的重开处置形态变了——那值得人看一眼，
/// 而不是让产物里的窗口右端悄悄跟着变。
///
/// ⚠️ 这也修正了实现路径上的一处「机制与散文不符」：先前文档把这条链描述成
/// 「四档按序回落」，读起来像四档都会走到；实测只有两档。**结论对但机制错**的又一例。
#[test]
fn restart_window_falls_back_explicitly_when_taken_t_is_missing() {
    let mut sources: std::collections::BTreeMap<&'static str, usize> = Default::default();
    for seed in CANARY_SEEDS.0..=CANARY_SEEDS.1 {
        let dm = observe(seed);
        for w in restart_windows(&dm) {
            *sources.entry(w.end_source.as_str()).or_insert(0) += 1;
            assert!(
                w.end >= w.start,
                "窗口右端 {} 早于左端 {}（seed {seed}）",
                w.end,
                w.start
            );
        }
    }
    assert!(sources.get("taken_t").copied().unwrap_or(0) > 0, "正常档应有样本");
    let fallback: usize = [
        "open_play_resumed_t",
        "next_restart_start_t",
        "stream_end",
    ]
    .iter()
    .map(|k| sources.get(*k).copied().unwrap_or(0))
    .sum();
    // 防空转：fallback 分支必须在真实 seed 上**被执行过**（否则它的行为只是纸面声明）。
    assert!(
        fallback > 0,
        "canary 上应出现 `taken_t` 缺失的 fallback 窗口（实测 30 seed 里有 2 例）——\
         若为 0，fallback 分支是未被执行的代码。实际分布：{sources:?}"
    );
    // 变化哨兵：中间两档**恒 0**（实测 300 seed 亦为 0）。
    for defensive in ["open_play_resumed_t", "next_restart_start_t"] {
        assert_eq!(
            sources.get(defensive).copied().unwrap_or(0),
            0,
            "防御档 `{defensive}` 在真实 seed 上出现了——它是为「不变量 5 被破坏」\
             （或无 `taken_t` 却被下一条重开顶掉）准备的。它出现说明引擎的重开处置形态变了，\
             值得人核一眼（窗口右端的语义可能也要跟着改）。实际分布：{sources:?}"
        );
    }
    assert!(
        sources.get("stream_end").copied().unwrap_or(0) > 0,
        "实测缺 `taken_t` 的**全部**是流末那条重开 ⇒ `stream_end` 档必须有样本。         实际分布：{sources:?}"
    );
}

// ============================== 动作归因（反 MAJOR-2） ==============================

/// `chase` 与 `close_down` **分类而非并称**（spec 的 Requirement「动作归因不得把『追人』当作『追球』」）。
///
/// ## ⚠️ 本条纪律的依据是**靶点分流**，不是「距球远」
///
/// 源码事实：`compute_mover_candidates` 里 `close_down` 的靶点按 `TransitionSource` 分流——
/// `Tackle → st.ball_pos`（球）；`SaveCaught → attacking_forward(..)`（**前插球员**）。
/// 这就是「不得并称」的全部依据。
///
/// **不要用「终点距球 > 5.25 m」当追人的证据**（本 change 曾在三处那么写，审阅轮 2 实测推翻）：
/// `close_down_stop` 只推进 `d − CLOSE_DOWN_STOP_DIST`（≈2 m）、**打不到靶点**，
/// 故**远端球员的 mover 终点天然离球远**——8 seed 的 513 个 `close_down` **全部朝球逼近**
/// （靠近 513 / 远离 0）。且 `SaveCaught` 分流实测仅约 **9.9%**（30 seed 215/2162），不是 37%。
///
/// 详见 `evidence.rs` 的 `MoverTarget` 行与 `reasons.rs` 的 `WORDING_RULES`（两处已收回该因果链）。
#[test]
fn pursuit_roles_are_classified_never_merged() {
    assert_eq!(PursuitRole::of("chase"), PursuitRole::Chase);
    assert_eq!(PursuitRole::of("close_down"), PursuitRole::CloseDown);
    // 开集字符串：未列举者落 `Other`，**不**被当成追球。
    for other in ["run", "keeper_return", "some_future_action"] {
        assert_eq!(
            PursuitRole::of(other),
            PursuitRole::Other,
            "`{other}` 不得被归入 chase 或 close_down"
        );
    }
    // 真实路径：`close_down` 确实出现在松散球段里（否则本分类是空转的）。
    let mut cd_seen = 0usize;
    let mut chase_seen = 0usize;
    for seed in QUICK_SEEDS.0..=QUICK_SEEDS.1 {
        let dm = observe(seed);
        let windows = restart_windows(&dm);
        for r in loose_runs(&dm, &windows, (0.0, None)) {
            cd_seen += r.close_downers.len();
            chase_seen += r.chasers.len();
        }
    }
    assert!(chase_seen > 0, "应有 `chase` 追球者");
    assert!(
        cd_seen > 0,
        "应有 `close_down`——它是「不并称」这条纪律的**存在理由**；若为 0，本分类可能是空转"
    );
}

/// **分类守卫有判别力**：把 `chase` 与 `close_down` 合并成一类的变异须判红。
///
/// 做法：核「按 `chase` 判的归属」与「按 `chase+close_down` 判的归属」在真实数据上
/// **确实不同**——若相同，说明 `close_down` 从不出现在 `chase` 缺席的段里，
/// 合并与否无差别，本条纪律就是空转的。
#[test]
fn pursuit_role_guard_has_discriminating_power() {
    let mut only_chase_both = 0usize;
    let mut merged_both = 0usize;
    let mut total = 0usize;
    for seed in QUICK_SEEDS.0..=QUICK_SEEDS.1 {
        let dm = observe(seed);
        let windows = restart_windows(&dm);
        for r in loose_runs(&dm, &windows, (0.0, None)) {
            total += 1;
            if r.chase_class() == "both" {
                only_chase_both += 1;
            }
            // 变异：把 close_down 也当作「追球者」的归属证据。
            let (h, a) = r.chasing_teams();
            let (h2, a2) = r
                .close_downers
                .iter()
                .fold((h, a), |(h, a), id| match TeamId::from_player(*id) {
                    Some(TeamId::Home) => (true, a),
                    Some(TeamId::Away) => (h, true),
                    None => (h, a),
                });
            if h2 && a2 {
                merged_both += 1;
            }
        }
    }
    assert!(total > 0, "应有松散球段");
    assert!(
        merged_both > only_chase_both,
        "把 `close_down` 并入追球者后「两队都追」的段数应变多——\
         实测合并 {merged_both} vs 仅 chase {only_chase_both}；若相等，说明两者永远同现，分类无判别力"
    );
}

// ============================== 缺证据不猜 / 回放定位 ==============================

/// 缺证据时显式 `unknown`，不猜（spec 的 Requirement）。
#[test]
fn unknown_is_recorded_never_guessed() {
    // 开放 episode（`end_t == None`）：尾部窗口应为空，且报告渲染成 `unknown`。
    let dm = observe(1);
    let open_ep = dm.possession_episodes.iter().find(|e| e.end_t.is_none());
    if let Some(ep) = open_ep {
        let tail = tail_window(&dm, ep.team, None);
        assert!(
            tail.is_empty(),
            "`end_t` 不可得时尾部窗口必须为空——不得拿「最后一个快照」冒充收束时刻"
        );
    }
    // 闭合 episode 的尾部窗口非空（防空转）。
    let closed = dm
        .possession_episodes
        .iter()
        .find(|e| e.end_t.is_some())
        .expect("seed 1 应有闭合 episode");
    let tail = tail_window(&dm, closed.team, closed.end_t.map(|t| t.value));
    assert!(!tail.is_empty(), "闭合 episode 的尾部窗口不应为空");
    assert!(
        tail.iter().all(|t| t.supporters.is_some()),
        "尾部窗口的接应应可算（引擎侧恒有 10 名外场）"
    );
}

/// 可回放定位有效（spec 的 Scenario「定位可回到事件流」）。
#[test]
fn replay_locators_resolve_to_real_events_with_consistent_time() {
    let mut checked = 0usize;
    for seed in QUICK_SEEDS.0..=QUICK_SEEDS.1 {
        let dm = observe(seed);
        let windows = restart_windows(&dm);
        for (i, ep) in dm.possession_episodes.iter().enumerate() {
            let card = card_of(&dm, &windows, seed, ep);
            assert_eq!(
                card.bad_event_indexes, 0,
                "seed {seed} episode {i}：事件下标越界"
            );
            for n in &card.chain {
                let e = dm
                    .events
                    .get(n.event_index)
                    .unwrap_or_else(|| panic!("event_index {} 越界", n.event_index));
                assert_eq!(
                    e.t, n.t,
                    "回放定位的时间不自洽：event_index {} 的事件 t={}，卡里记的是 {}",
                    n.event_index, e.t, n.t
                );
                assert_ne!(e.type_, EventType::Beat, "动作链不得含 `beat`（它是节拍，不是动作）");
                checked += 1;
            }
            if let PursuitView::Visible { runs, .. } = &card.pursuit {
                for r in runs {
                    for idx in &r.event_indexes {
                        let e = dm.events.get(*idx).expect("松散球段事件下标越界");
                        assert_eq!(e.type_, EventType::Beat);
                        assert!(
                            e.ball.as_ref().map(|b| b.loose).unwrap_or(false),
                            "松散球段里的 beat 必须是 `loose`"
                        );
                    }
                }
            }
        }
    }
    assert!(checked > 100, "核对的动作链节点太少（{checked}）——防空转");
}

// ============================== 措辞守卫（剥注释） ==============================

/// 剥掉 `//` 之后的全部内容（P124 的同类守卫踩过的坑：规则说明本身含禁串 ⇒ 红在自己身上）。
fn strip_line_comments(src: &str) -> String {
    src.lines()
        .map(|l| match l.find("//") {
            Some(i) => &l[..i],
            None => l,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// phase 词（本 change **不得**用自己的话声称能判相位）。
const PHASE_TOKENS: &[&str] = &[
    "build_up",
    "progression",
    "final_third",
    "attacking_transition",
    "Phase",
];

/// **措辞守卫**：剥注释后扫 `tests/p17b/{evidence,episode,reasons}.rs`，不得出现 phase 词。
///
/// ## 扫描范围与相容规则（design §4.1 的 MAJOR-1，逐条定死）
///
/// - **范围**：三个**报告逻辑**文件；**排除** `report.rs`——它经 `crate::model` 的
///   `sidecar_schema_fingerprint` **正确地**触及 `Phase` 闭集（sidecar 的 schema 指纹
///   **必须**包含它，否则指纹就没在守护闭集完整性）；
/// - **剥注释**：见 [`strip_line_comments`]；
/// - **排除引用/警示文本**：`⚠️` 行与本 change 自己的**规则说明**（本测试文件的 doc 注释
///   `//!` 也在剥离范围内）。
///
/// ## 守卫真正要守的命题
///
/// **不是**「p17b 里没有 `Phase` 这个词」，而是「**p17b 不声称能判相位**」。
/// 后者无法自动判定——故本守卫守的是它的**可操作代理**：报告逻辑里不出现 phase 词，
/// 于是**不可能**冒出一个「本段属 build_up」式的结论。写入代码前请记住这条区别。
#[test]
fn wording_guard_rejects_phase_vocabulary_after_stripping_comments() {
    // ⚠️ **扫描面必须含 `report.rs`**（审阅 P2）。初版按 design §4.1 排除了它，
    // 理由是「它经 `crate::model` 的 `sidecar_schema_fingerprint` 正确地触及 `Phase` 闭集」。
    // 但实测：`report.rs` **根本不出现**任何 phase 字面量——真正含 `Phase` 的是
    // `p17a/model.rs`，而它本来就不在扫描范围内。⇒ 那条排除理由在该文件上不成立，
    // 而**产物模板恰好就住在 `report.rs`**（spec 的 Scenario 明写「写进报告生成代码
    // **或产物模板**」）。变异实测：往 `render_card_md` 插 `（本段属 build_up）`
    // 时初版两测试全绿。现纳入扫描。
    let sources: [(&str, &str); 4] = [
        ("p17b/evidence.rs", include_str!("p17b/evidence.rs")),
        ("p17b/episode.rs", include_str!("p17b/episode.rs")),
        ("p17b/reasons.rs", include_str!("p17b/reasons.rs")),
        ("p17b/report.rs", include_str!("p17b/report.rs")),
    ];
    for (name, src) in sources {
        let stripped = strip_line_comments(src);
        for tok in PHASE_TOKENS {
            assert!(
                !stripped.contains(tok),
                "{name} 剥注释后仍含 phase 词 `{tok}`——本 change 只报**事件级**转换，\
                 不声称能判相位（#16/#124 双负）。若确要提及，必须放进注释并说明它**不可得**"
            );
        }
    }
}

/// **措辞守卫有判别力**：喂一个**含禁串的非注释行**必须判红。
///
/// 反证条（防空转）：若 `strip_line_comments` 把所有内容都剥掉了，真实违规也扫不出。
/// 本测试同时核：① 含禁串的代码行能被抓；② 注释里的禁串**不**被抓（否则会红在自己身上）。
#[test]
fn wording_guard_strips_comments_and_still_catches_violations() {
    let violating = "let x = \"build_up\"; // 这里说明 build_up 不可判";
    let stripped = strip_line_comments(violating);
    assert!(
        PHASE_TOKENS.iter().any(|t| stripped.contains(t)),
        "含禁串的**代码行**必须被抓到——否则守卫会把真违规也剥掉（空转）"
    );
    let comment_only = "// 规则：不得出现 build_up / progression / final_third";
    let stripped2 = strip_line_comments(comment_only);
    assert!(
        !PHASE_TOKENS.iter().any(|t| stripped2.contains(t)),
        "**注释行**里的禁串不得被抓——否则规则说明会红在自己身上（自指坑）"
    );
}

// ============================== 同源守卫 ==============================

/// 接应口径是**活读** p16 的，不是复制（用户拍板的形态）。
///
/// 两条断言：
/// ① p17b 的运行时代码里**没有**自己的 `SUPPORT_MAX_DIST_M` 声明——有人抄一份进来时立刻红；
/// ② p16 源码文本里的字面值与运行时读到的值一致——p16 改了阈值而 p17b 编译缓存陈旧时暴露。
#[test]
fn support_caliber_is_live_read_from_p16_not_copied() {
    const P16_FEATURES: &str = include_str!("p16/features.rs");
    // ⚠️ **扫描面必须是 p17b 的全部模块**，不是只扫入口文件。
    // 审阅实测（P1-c）：初版只 include 了入口文件，而**最可能长出第二份常量的
    // `episode.rs`（它才是 runtime 里调 `support_formation` 的那个）不在扫描面内**——
    // 往 `episode.rs` / `evidence.rs` 追加一份 `SUPPORT_MAX_DIST_M` 时目标测试全绿。
    // 这是本仓 `[[false-coverage-handoff-claims]]` 的形态：断言存在、覆盖声明存在、
    // **覆盖面不存在**。现改为扫 `report::TEST_SOURCES` 里 p17b 的全部模块
    // （该清单同时是产物 `test_source_fingerprint` 的输入——两处共用一份，不会漂）。
    let p17b_modules: Vec<(&str, &str)> = report::TEST_SOURCES
        .iter()
        .filter(|(name, _)| name.starts_with("p17b"))
        .copied()
        .collect();
    assert!(
        p17b_modules.len() >= 4,
        "扫描面过窄：只找到 {} 个 p17b 模块——守卫会漏掉长出第二份常量的地方",
        p17b_modules.len()
    );
    for (module, src) in &p17b_modules {
        for name in ["SUPPORT_MAX_DIST_M", "SUPPORT_MIN_FORWARD_M"] {
            let own_decl = src
                .lines()
                .map(strip_line_comments)
                .any(|l| l.contains("const") && l.contains(name) && l.contains('='));
            assert!(
                !own_decl,
                "`{module}` **不得**自己声明 `{name}`——接应口径必须经 `#[path]` 活读 p16。\
                 复制一份会让「同源」退化成文本比对（设计已论证过这条）"
            );
        }
    }
    // ② p16 源码里的字面值与运行时值一致。
    assert!(
        P16_FEATURES.contains("SUPPORT_MAX_DIST_M: f64 = 25.0"),
        "p16 的接应阈值声明行变了——本守卫的源码核对需要同步"
    );
    assert_eq!(crate::features::SUPPORT_MAX_DIST_M, 25.0);
    assert_eq!(crate::features::SUPPORT_MIN_FORWARD_M, 2.0);
    // ③ 口径快照里带着它（阈值一变，产物层立刻不可比）。
    let p = build_provenance("canary", 1, 1, DUR);
    assert!(
        p.caliber.iter().any(|(k, _)| *k == "support_max_dist_m"),
        "provenance 的口径快照必须含接应阈值"
    );
}

/// 异常筛选阈值与 P17A 的规则**逐位一致**（同源）。
///
/// 反编译期的做法：从 `tests/p17a/anomalies.rs` 的**源码文本**里抽出常量并比对——
/// P17A 改阈值时本守卫立刻红，逼一次有意识的同步。若两处不一致，
/// 「A1 的样本」在两份报告里会指不同的东西，交叉引用立刻失效。
#[test]
fn exception_thresholds_match_the_p17a_rules() {
    const P17A_ANOMALIES: &str = include_str!("p17a/anomalies.rs");
    fn extract(src: &str, name: &str) -> f64 {
        let key = format!("pub const {name}: f64 =");
        let line = src
            .lines()
            .find(|l| l.contains(&key))
            .unwrap_or_else(|| panic!("在 p17a/anomalies.rs 里找不到 `{key}`"));
        let rhs = line.split('=').nth(1).expect("常量行应有 `=`");
        rhs.trim()
            .trim_end_matches(';')
            .parse::<f64>()
            .unwrap_or_else(|_| panic!("`{key}` 的右值不是字面量：{rhs}"))
    }
    assert_eq!(
        extract(P17A_ANOMALIES, "DWELL_ANOMALY_SECONDS"),
        EXC_LONG_DWELL_SECONDS,
        "长持球阈值与 P17A 的 A1 不一致——两份报告的「A1 样本」会指不同的东西"
    );
    assert_eq!(
        extract(P17A_ANOMALIES, "EMPTY_POSSESSION_SECONDS"),
        EXC_EMPTY_POSSESSION_SECONDS,
        "空 possession 阈值与 P17A 的 A6 不一致"
    );
}

/// 动作链的 token 与 P17A 的 `ActionKind` **行为层同源**。
///
/// 两处是独立实现（本 change 不 include `p17a/model.rs` 的动作映射），
/// 故在**真实 seed** 上核：同一 episode 的动作序列，两边给的 token 必须一致。
#[test]
fn action_tokens_match_the_p17a_reference() {
    let dm = observe(1);
    let windows = restart_windows(&dm);
    let mut checked = 0usize;
    for ep in &dm.possession_episodes {
        let card = card_of(&dm, &windows, 1, ep);
        for node in &card.chain {
            let e = &dm.events[node.event_index];
            // P17A 的 `action_of` 语义：同一事件 → 同一动作类别（这里核的是**映射表**）。
            let expected = match e.type_ {
                EventType::Kickoff => "kickoff",
                EventType::Pass => match e.result.as_deref().unwrap_or("") {
                    "success" => "pass+",
                    "intercepted" => "passI",
                    "lost" => "passL",
                    "out" => "passO",
                    "contested" => "passC",
                    _ => "pass?",
                },
                EventType::Shot => match e.result.as_deref().unwrap_or("") {
                    "goal" => "shotG",
                    "saved" => "shotS",
                    "off_target" => "shotX",
                    _ => "shot?",
                },
                EventType::Tackle => "tackle",
                EventType::Foul => "foul",
                _ => "other",
            };
            assert_eq!(node.token, expected, "token 映射与 P17A 的 ActionKind 不一致");
            checked += 1;
        }
    }
    assert!(checked > 50, "核对的动作太少（{checked}）——防空转");
}

// ============================== 规范一致性守卫 ==============================

/// **规范一致性守卫**：spec / tasks 里**每处提及 P17A 异常覆盖的块**，
/// 必须**同时**含「证据边界内」与「边界外逐条说明 / 落在盲区」两半。
///
/// ## 为什么单位是「块」而不是「行」（design §6 的 MAJOR-1 反例）
///
/// spec 把「证据边界内」放在 **scenario 标题行**、把「逐条说明 / 盲区」放在
/// **`- **THEN**` 行**——跨两行。按行扫会漏。**实测**：`tasks.md` 的违规形态是**裸 bullet**
/// （一个 `- **THEN**` 行都没有）⇒ 按 `- **THEN**` 行写出的守卫在真有违规的版本上
/// **不命中**，是空转。
///
/// ## 反证条
///
/// 把该 scenario 还原成「各自都能找到样本」（删掉「证据边界内」与盲区说明）必须判红——
/// 见 [`spec_anomaly_coverage_guard_is_not_vacuous`]。
#[test]
fn spec_anomaly_coverage_blocks_carry_both_halves() {
    let blocks = anomaly_coverage_blocks();
    assert!(
        !blocks.is_empty(),
        "在 spec / tasks 里找不到「提及 P17A 异常覆盖」的块——守卫会空转"
    );
    for b in &blocks {
        assert!(
            b.has_within_boundary,
            "`{}` 里提及异常覆盖，却没有「**在证据边界内**」这一半——\
             会把读者引向「每条异常都能解释」这个设计已判定**做不到**的断言",
            b.where_
        );
        assert!(
            b.has_outside_explained,
            "`{}` 里提及异常覆盖，却没有「**边界外逐条说明 / 落在盲区**」这一半——\
             BLOCKER-1 的形态（A2 的样本恰好全落在「不产 loose beat」的盲区里）",
            b.where_
        );
    }
}

/// 一个候选块（以及它含不含两半）。
#[derive(Debug)]
pub struct CoverageBlock {
    pub where_: String,
    pub has_within_boundary: bool,
    pub has_outside_explained: bool,
}

/// 从 spec / tasks 的文本里抽出「提及 P17A 异常覆盖」的块。
///
/// **块的定义**：一个 `Scenario:` 段（从 `#### Scenario:` 到下一个 `####`/`###` 之前）——
/// 这是 spec 的天然单元，且**跨行**（标题行 + `- **WHEN**` / `- **THEN**` 行）。
/// 对 `tasks.md`（无 `Scenario:` 结构）退化为**裸 bullet**：从该 bullet 到下一个顶层
/// `##` 之前——P17A 覆盖在 tasks 里就是一条停止条件 bullet。
///
/// ⚠️ **剥掉引用/警示文本**（`⚠️` 行与 `>` 引用块）——spec 里那句禁令本身含关键词，
/// 不剥会让守卫红在自己身上（同 §4.1 的自指坑）。
fn anomaly_coverage_blocks() -> Vec<CoverageBlock> {
    let mut out = Vec::new();
    // ⚠️ 运行时从仓库读（不是 `include_str!`）：否则**改一句文档**就会改变
    // `test_source_fingerprint`，把全部落盘产物判成陈旧——产物指纹应当只跟**判据**走。
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../openspec/changes/p17b-explainable-diagnosis-report");
    let spec = std::fs::read_to_string(root.join("specs/behavior-diagnosis-report/spec.md"))
        .expect("读 spec（仓库文件，应当恒在）");
    let tasks = std::fs::read_to_string(root.join("tasks.md")).expect("读 tasks");
    for (where_, src) in [
        ("specs/behavior-diagnosis-report/spec.md", spec.as_str()),
        ("tasks.md", tasks.as_str()),
    ] {
        // 剥引用块与警示行。
        let cleaned: Vec<&str> = src
            .lines()
            .filter(|l| {
                let t = l.trim_start();
                !t.starts_with('>') && !t.contains("⚠️")
            })
            .collect();
        // 切块：spec 按 `#### Scenario:`；tasks 按顶层 bullet（`- `）。
        let mut cur: Vec<(usize, &str)> = Vec::new();
        let mut blocks: Vec<(String, Vec<(usize, &str)>)> = Vec::new();
        for (i, l) in cleaned.iter().enumerate() {
            let t = l.trim_start();
            let is_boundary = if where_.ends_with("spec.md") {
                t.starts_with("#### ") || t.starts_with("### ")
            } else {
                (t.starts_with("- ") || t.starts_with("## ")) && !cur.is_empty()
            };
            if is_boundary && !cur.is_empty() {
                blocks.push((format!("{where_} @ {}", cur[0].1.trim()), std::mem::take(&mut cur)));
            }
            cur.push((i, l));
        }
        if !cur.is_empty() {
            blocks.push((format!("{where_} @ {}", cur[0].1.trim()), cur));
        }
        for (name, lines) in blocks {
            let text: String = lines.iter().map(|(_, l)| *l).collect::<Vec<_>>().join("\n");
            // 只保留**真正在说「覆盖 P17A 的异常样本」**的块。
            //
            // ⚠️ 谓词必须同时要求「异常」与「样本」：只要求「异常」会把
            // **别的主语**的 bullet 也卷进来（实测：`tasks.md` 里
            // 「P17A 异常规则逐条覆盖声明」这条讲的是**声明表**，不是**样本覆盖**，
            // 它自然不含「证据边界内」——按粗谓词会把它判成违规，是**误报**）。
            // 收紧到「样本」不削弱守卫：被禁的形态（「各自都能找到样本」）**必含**「样本」。
            let mentions = (text.contains("异常") || text.contains("P17A") || text.contains("17A"))
                && text.contains("样本");
            if !mentions {
                continue;
            }
            // ⚠️ 「证据边界内」这个字面量**含**「证据边界」——故「边界外说明」的判据
            // 必须用**别的**词，否则两半会被同一个串同时点亮（恒真）。
            let has_within = text.contains("证据边界内") || text.contains("证据边界之内");
            let has_outside = text.contains("盲区")
                || text.contains("边界之外")
                || text.contains("证据边界之外")
                || text.contains("落在哪条证据边界外")
                || (text.contains("逐条说明") || text.contains("逐条"));
            out.push(CoverageBlock {
                where_: name,
                has_within_boundary: has_within,
                has_outside_explained: has_outside,
            });
        }
    }
    out
}

/// **P17A 每条异常规则都被逐条声明**（spec 的 Scenario「覆盖 P17A 点名的异常样本」）。
///
/// 判据集合**从 P17A 的源码文本里抽**（`anomalies::evaluate` 的返回列表）——
/// P17A 新增一条规则而本层没跟上，本测试立刻红。这是「逐条说明」不流于形式的结构保证。
#[test]
fn every_p17a_anomaly_rule_is_declared_in_the_per_episode_map() {
    const P17A_ANOMALIES: &str = include_str!("p17a/anomalies.rs");
    // 抽出 `evaluate` 里的规则调用列表（`a1(ctx), ... a10(ctx),`）。
    let eval = P17A_ANOMALIES
        .split("pub fn evaluate(ctx: &Ctx) -> Vec<Anomaly> {")
        .nth(1)
        .expect("p17a/anomalies.rs 里应有 `evaluate`");
    let body = eval.split(']').next().unwrap_or(eval);
    let mut rules: Vec<String> = Vec::new();
    let bytes = body.as_bytes();
    let mut i = 0usize;
    // 扫 `a<digits>(ctx)`——**不用 split**：`vec![` 前缀会吃掉列表首项。
    while i < bytes.len() {
        if bytes[i] != b'a' {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        if j > i + 1 && body[j..].starts_with("(ctx)") {
            rules.push(format!("A{}", &body[i + 1..j]));
            i = j;
        } else {
            i += 1;
        }
    }
    assert!(
        rules.len() >= 10,
        "从 P17A 源码里只抽到 {} 条规则（{rules:?}）——抽取逻辑可能已失配",
        rules.len()
    );
    for r in &rules {
        let row = anomaly_coverage_of(r);
        assert!(
            row.is_some(),
            "P17A 的规则 `{r}` 未被本层声明覆盖——每条异常都须给出逐 episode 样本             或说明它落在哪条边界之外，不得留空"
        );
        let row = row.unwrap();
        assert!(
            !row.note.trim().is_empty(),
            "`{r}` 的声明没写「本层的对应物 / 落在哪条边界外」"
        );
        assert!(!row.topic.trim().is_empty(), "`{r}` 的声明没写它讲什么");
    }
    // 边界必须**显式**写出（本 change 的核心发现：A2 的追逐过程落在盲区）。
    assert!(
        rules.iter().all(|r| anomaly_coverage_of(r)
            .map(|row| !row.per_episode_samples || !row.note.is_empty())
            .unwrap_or(false)),
        "每条规则要么给样本、要么写明边界，两者都不能空"
    );
    // 反向：声明表里不许有 P17A 里不存在的规则 id。
    for row in ANOMALY_COVERAGE {
        assert!(
            rules.contains(&row.rule.to_string()),
            "`ANOMALY_COVERAGE` 里有 P17A 不存在的规则 `{}`",
            row.rule
        );
    }
}

/// **观察可信度门生效**（design §3.0，用户拍板：标注但保留、不进 L2 聚合）。
///
/// 反证条：造一张 `coherent=false` 的卡喂进 [`Aggregates::observe`]，
/// 它的诊断**不得**进 `by_end_reason` / `by_contest_start` 的分子分母，
/// 但**必须**仍进 `by_exception` 的 `incoherent` 栏（标注但保留）。
#[test]
fn observation_credibility_gate_annotates_but_keeps() {
    let dm = observe(1);
    let windows = restart_windows(&dm);
    let mut cards: Vec<EpisodeCard> = dm
        .possession_episodes
        .iter()
        .map(|ep| card_of(&dm, &windows, 1, ep))
        .collect();
    assert!(cards.iter().all(|c| c.coherent), "真实 seed 1 的卡应全为可信");

    // 反证条：人为把一张卡标成不可信，门必须生效。
    cards[0].coherent = false;
    let mut agg = Aggregates::default();
    for c in &cards {
        agg.observe(c, &["long_dwell"]);
    }
    assert_eq!(agg.incoherent_cards, 1);
    let coherent = agg.cards - agg.incoherent_cards;
    let by_end: usize = agg.by_end_reason.values().map(|g| g.cards).sum();
    let by_contest: usize = agg.by_contest_start.values().map(|g| g.cards).sum();
    assert!(
        by_end <= coherent,
        "不可信的卡进了 `by_end_reason`（{by_end} > {coherent}）——前置门失效"
    );
    assert!(
        by_contest <= coherent,
        "不可信的卡进了 `by_contest_start`（{by_contest} > {coherent}）——前置门失效"
    );
    // 「标注但保留」：它仍出现在异常类计数里（`cards` 统计**全部**卡，不只可信的）。
    assert_eq!(
        agg.by_exception.get("long_dwell").map(|g| g.cards),
        Some(cards.len()),
        "不可信的卡必须仍被标注（保留），只是不进按结束原因/争抢成因的聚合"
    );
    assert_eq!(
        agg.by_exception.get("long_dwell").map(|g| g.incoherent),
        Some(1)
    );
}

/// **`instant_contest` 用的是争抢时长，不是 possession 时长**（本 change 自查抓到的一处口径错）。
///
/// ## 这处错长什么样（为什么值得一条专门的守卫）
///
/// `instant_contest` 是 P17A 的 A2（同 tick 收束）在本层的化身。A2 判的是
/// `transitions.duration_value_counts` 的「0.000」档——**争抢**时长。
/// 本 change 初版误用了 `end_t - start_t`（**possession** 时长）。实测（30 seed）：
///
/// | 口径 | 时长为 0 的占比 |
/// |---|---|
/// | **争抢**时长（A2 的口径） | **1082 / 2027 = 53.4%** |
/// | possession 时长（错误口径） | **1 / 3075 = 0.03%** |
///
/// ⚠️ **防空转下限抓不到它**：错误口径下仍产出 8 张卡（非零），
/// 「`by_exception` 非空」的断言照常绿。这是本仓「结论对但机制错」的又一实例——
/// **字段名（`instant_contest`）与它该管的量对不上**，而没有任何断言核过这一层。
///
/// ## 本守卫的判据
///
/// 直接读观测层算出**每一个**争抢的时长，与 [`classify`] 的判定**逐条比对**。
/// 口径一改就红，且判别力来自「两个量的差距是 1700 倍」而不是一个脆弱的阈值。
#[test]
fn instant_contest_uses_the_contest_duration_not_the_possession_duration() {
    let dm = observe(1);
    let windows = restart_windows(&dm);
    // 从观测层独立算：每个 contest_started → 紧随的 contest_ended。
    let mut expected: std::collections::BTreeMap<usize, bool> = Default::default();
    for (i, f) in dm.control_facts.iter().enumerate() {
        if f.kind != ControlFactKind::ContestStarted {
            continue;
        }
        let end = dm.control_facts[i + 1..]
            .iter()
            .find(|g| g.kind == ControlFactKind::ContestEnded);
        let zero = end.map(|e| e.t.value - f.t.value == 0.0).unwrap_or(false);
        expected.insert(i, zero);
    }
    assert!(!expected.is_empty(), "seed 1 应有争抢事实（防空转）");
    let mut agreement = 0usize;
    for ep in &dm.possession_episodes {
        let card = card_of(&dm, &windows, 1, ep);
        let cls = classify(&card);
        let claims_instant = cls.contains(&"instant_contest");
        match card.contest_start {
            None => {
                assert!(!claims_instant, "非争抢收束的卡不得命中 `instant_contest`");
            }
            Some(_) => {
                let idx = card.closing_fact_index.expect("争抢收束应有收束侧事实下标");
                let truth = *expected.get(&idx).expect("收束侧事实应在争抢集里");
                assert_eq!(
                    claims_instant, truth,
                    "episode {} 的 `instant_contest` 判定与观测层的**争抢**时长不符                     （expected {truth}）——口径是不是又退回 possession 时长了？",
                    ep.id
                );
                agreement += 1;
            }
        }
    }
    assert!(agreement > 10, "比对的争抢卡太少（{agreement}）——防空转");
    let zero_contest = expected.values().filter(|v| **v).count();
    assert!(
        zero_contest * 10 > expected.len(),
        "seed 1 上「争抢时长 == 0」应占多数（实测 30 seed 53.4%）——若不然，本守卫的判别基础不成立：         {zero_contest}/{}",
        expected.len()
    );
}

/// **`instant_contest` 只覆盖 A2 母体的一部分**——两层缺口都要显式，不得声称全量。
///
/// ## 这处是本 change 自己的标准用在自己身上
///
/// 本 change 的立身之本是「不得给笼统的『可答』」。把同一把尺子拿来量自己也发现了一处：
/// `instant_contest` 的类定义那时写「P17A A2 的逐 episode 化身」——**读起来像全量**，而实测：
///
/// | 量 | 300 seed 实测 |
/// |---|---|
/// | A2 的母体：**全部**零时长争抢 | **10564** / 20053 个争抢（52.7%，与 P17A 的 52.7% 一致） |
/// | 诊断卡能展开的：其中**收束了一段 episode** 的 | **7364**（占母体 69.7%） |
/// | 缺口：发生在「控制已释放、球还在飞」的**两段 episode 之间** | **约 3200（30%）** |
///
/// 缺口那部分在 L2 的**争抢成因表**里数得到（它们也有 `contest_started` 事实），
/// 但**没有 card 可以挂**——诊断卡的结构是「一段 possession 一张卡」。
///
/// ⇒ 本测试把**两个量都算出来**并断言：① 母体确实远大于可展开的部分（缺口真实存在，
/// 不是被断言掉的）；② 可展开部分是**多数**（因为 `instant_contest` 定义在 episode 收束上，
/// 而收束侧面确实以争抢为主）。两个方向都钉住，使「缺口在缩小/消失」也能被看见。
#[test]
fn instant_contest_covers_only_the_episode_closing_share_of_a2() {
    let mut zero_contests = 0usize;
    let mut all_contests = 0usize;
    let mut zero_closing_an_episode = 0usize;
    for seed in CANARY_SEEDS.0..=CANARY_SEEDS.1 {
        let dm = observe(seed);
        let ends: std::collections::BTreeSet<String> = dm
            .possession_episodes
            .iter()
            .filter_map(|e| e.end_t.map(|t| format!("{:.3}", t.value)))
            .collect();
        for (i, f) in dm.control_facts.iter().enumerate() {
            if f.kind != ControlFactKind::ContestStarted {
                continue;
            }
            all_contests += 1;
            let Some(e) = dm.control_facts[i + 1..]
                .iter()
                .find(|g| g.kind == ControlFactKind::ContestEnded)
            else {
                continue;
            };
            if e.t.value - f.t.value != 0.0 {
                continue;
            }
            zero_contests += 1;
            if ends.contains(&format!("{:.3}", f.t.value)) {
                zero_closing_an_episode += 1;
            }
        }
    }
    assert!(all_contests > 500, "争抢样本过少（{all_contests}）——防空转");
    // ① A2 的口径**是**争抢时长（与 P17A 同源）：零时长占比应过半。
    assert!(
        zero_contests * 2 > all_contests,
        "零时长争抢应过半（实测 30 seed 53.4%）：{zero_contests}/{all_contests}"
    );
    // ② 缺口**真实存在**：可展开的部分**严格小于**母体（否则说明缺口被静默吞掉了）。
    assert!(
        zero_closing_an_episode < zero_contests,
        "所有零时长争抢都收束了一段 episode ⇒ 缺口消失（{zero_closing_an_episode}/{zero_contests}）——\
         若真是如此，本类确实等于 A2 全量，那时应**更新**类定义里的 ~70% 说法"
    );
    // ③ 但仍是**多数**：`instant_contest` 的卡不是边角料。
    assert!(
        zero_closing_an_episode * 2 > zero_contests,
        "可展开的部分应占母体多数（实测 30 seed 69.7%）：{zero_closing_an_episode}/{zero_contests}"
    );
    // ④ 类定义里必须**写明这个缺口**（防「读起来像全量」的措辞回归）。
    let def = EXCEPTION_CLASSES
        .iter()
        .find(|(k, _)| *k == "instant_contest")
        .map(|(_, d)| *d)
        .expect("`instant_contest` 应有类定义");
    assert!(
        def.contains("70%") || def.contains("69.7"),
        "`instant_contest` 的类定义必须写明它只覆盖 A2 母体的一部分——\
         否则读者会把它的卡数当成 A2 的全量"
    );
}

/// **追逐段取整个争抢窗，不是「收束那一拍」**（审阅 P1-a 的修复守卫）。
///
/// ## 这处错长什么样（本 change 最重的一处口径错）
///
/// 初版把 pursuit 的窗取成 `(ep.start_t, end_t)`——那是**本段 possession** 的窗，
/// 右端恰是争抢**开始**的那一刻。于是松散球段被截断在收束拍上。审阅实测（并用本 analyzer
/// 自己的 `card_of` 复现）：30 seed **段长恒为 1 拍**、段末端 **100% 等于 `end_t`**、
/// `chase_class` **恒为 `one`**。而侦察的权威口径（design §4.4.1）是在**争抢窗**上量的
/// 「两队都追 **57.2%** / 只一队 42.8%」——**那个数在初版产物里一次都不出现**。
///
/// 结论（「丢球后能看到追球者」）对，但看到的只是收束那一拍——**结论对但口径错**，
/// 本仓的头号复发族。修法是**换成争抢窗**（与侦察、与 P17A 的 A2/A3 同口径）。
///
/// ## 本守卫的判据（审阅建议的「不允许恒为单一值」）
///
/// ① `both > 0`（初版恒 0，本断言在初版上**会红**）；
/// ② 段长不再恒 1（至少有一段 > 1 拍）；
/// ③ 争抢窗的右端 ≥ 收束拍（段不再被截断在 `end_t` 之前）。
#[test]
fn pursuit_window_spans_the_whole_contest_not_just_the_closing_tick() {
    let mut class_counts: std::collections::BTreeMap<&'static str, usize> = Default::default();
    let mut beat_hist: std::collections::BTreeMap<usize, usize> = Default::default();
    let mut extends_past_ep_end = 0usize;
    let mut total_runs = 0usize;
    for seed in CANARY_SEEDS.0..=CANARY_SEEDS.1 {
        let dm = observe(seed);
        let windows = restart_windows(&dm);
        for ep in &dm.possession_episodes {
            let card = card_of(&dm, &windows, seed, ep);
            let Some((_, cend)) = card.contest_window else {
                continue;
            };
            if let PursuitView::Visible { runs, .. } = &card.pursuit {
                for r in runs {
                    total_runs += 1;
                    *class_counts.entry(r.chase_class()).or_insert(0) += 1;
                    *beat_hist.entry(r.beats).or_insert(0) += 1;
                    // ③ 段末端不得早于「争抢窗右端之前」——段要真的覆盖整窗。
                    assert!(
                        r.end_t <= cend + 1e-9,
                        "松散球段的末端 {} 超出了争抢窗右端 {}",
                        r.end_t,
                        cend
                    );
                    // 判别条的核心：段不得**止步于** `ep.end_t`（初版把窗右端设在那里）。
                    if let Some(e) = card.end_t {
                        if r.end_t > e + 1e-9 {
                            extends_past_ep_end += 1;
                        }
                    }
                }
            }
        }
    }
    assert!(total_runs > 100, "松散球段太少（{total_runs}）——防空转");
    // ① **判别条**（初版在它上面会红）：段长不得恒为 1 拍。
    //    初版把窗截在收束拍上 ⇒ 段长恒 1；修复后段延伸到争抢结束。
    let multi = beat_hist.iter().filter(|(b, _)| **b > 1).map(|(_, c)| c).sum::<usize>();
    assert!(
        multi > 0,
        "必须出现多拍松散球段——段长**恒为 1 拍**是本 change 初版把窗截在收束拍上的特征\
         （审阅 P1-a）。实际分布：{beat_hist:?}"
    );
    // ② **`chase` 口径在争抢窗内几乎恒为 `one`**：追球方由 `winning_team` 指定
    //    （P17A 的 A2 机制），故「两队都在 `chase`」基本不存在。这不是缺陷，是机制。
    //    断言它**不出现 `both`**，使「有人把 `close_down` 混进追球口径」立刻红。
    assert_eq!(
        class_counts.get("both").copied().unwrap_or(0),
        0,
        "争抢窗内不应出现 `chase` 口径的 `both`——追球方恒为一方。\
         若出现，先核 `chase_class` 有没有被写成把 `close_down` 也算进来。实际：{class_counts:?}"
    );
    assert!(
        class_counts.get("one").copied().unwrap_or(0) > 0,
        "`chase` 口径应有 `one` 段。实际：{class_counts:?}"
    );
    // ③ **判别条**：至少有一段跨过 `ep.end_t`（初版的窗右端）。初版恒 0。
    assert!(
        extends_past_ep_end > 0,
        "应有松散球段跨过 `ep.end_t`——`ep.end_t` 是**争抢开始**那一刻，\
         段止步于此正是初版把窗截在收束拍上的特征。实际跨过的段数：{extends_past_ep_end}"
    );
}

/// **普查口径与卡片口径是两个分母**——不得混用，且普查要能对上 design §4.4.1。
///
/// 审阅 P1-a 的根因之一就是这两个分母被混在一起：design 的 946 段 / 57.2% 量的是
/// **整条事件流**上的松散球段；诊断卡的【丢球后】一节量的是**某段争抢窗**内的子集。
/// 本测试把两者分列并各钉一条：
///
/// - **普查侧**：段数/均长应当与 design §4.4.1 的 **946 / 3.02**（30 seed）**同量级**；
///   且 `任一 mover` 口径的 `both` 占比应当接近 design 载的 **57.2%**——
///   而 `chase` 口径的 `both` 应当很少（追球方由 `winning_team` 指定）。
/// - **卡片侧**：段必须跨过 `ep.end_t`（那才是「争抢开始」那一刻）；
///   这一条由 `pursuit_window_spans_the_whole_contest_not_just_the_closing_tick` 守。
#[test]
fn loose_census_reproduces_the_design_caliber_and_differs_from_the_card_caliber() {
    let mut runs = 0usize;
    let mut beats = 0usize;
    let mut chase: std::collections::BTreeMap<&'static str, usize> = Default::default();
    let mut presence: std::collections::BTreeMap<&'static str, usize> = Default::default();
    for seed in CANARY_SEEDS.0..=CANARY_SEEDS.1 {
        let dm = observe(seed);
        let mc = cards_of(&dm, seed);
        runs += mc.census_runs;
        beats += mc.census_beats;
        for (k, v) in &mc.census_chase_class {
            *chase.entry(k).or_insert(0) += v;
        }
        for (k, v) in &mc.census_presence_class {
            *presence.entry(k).or_insert(0) += v;
        }
    }
    // 与 design §4.4.1 的 946 段同量级（同 seed 数、同口径）。
    assert!(
        (800..=1100).contains(&runs),
        "普查段数 {runs} 偏离 design §4.4.1 的 946 太多——口径可能变了"
    );
    let mean = beats as f64 / runs as f64;
    assert!(
        (2.8..=3.3).contains(&mean),
        "普查均长 {mean:.2} 偏离 design §4.4.1 的 3.02 太多"
    );
    // **任一 mover** 口径应与 design 的 57.2% 同量级（这才是设计那个数的口径）。
    let both_p = *presence.get("both").unwrap_or(&0) as f64 / runs as f64;
    assert!(
        (0.45..=0.68).contains(&both_p),
        "「任一 mover」口径的 both 占比 {:.1}% 偏离 design 的 57.2% 太多——\
         普查的分段口径与侦察不再一致",
        100.0 * both_p
    );
    // **chase** 口径的 both 远小于「任一 mover」口径——**这才是判别条**。
    // 实测（30 seed，全场普查）：`chase` both = **11.3%** / 任一 mover both = **57.2%**，
    // 与 `tasks.md` 第 2 处更正逐位吻合。两者若接近，说明 `chase_class` 被写成了
    // `presence_class`（= 把 `close_down` 混进「追球者」——MAJOR-2 的变异形态）。
    let both_c = *chase.get("both").unwrap_or(&0) as f64 / runs as f64;
    assert!(
        both_c * 2.0 < both_p,
        "两个归属口径必须**显著不同**：`chase` both = {:.1}%、任一 mover both = {:.1}%——\
         若接近，说明 `chase_class` 把 `close_down` 也算了进来（它们根本不是同一个量）",
        100.0 * both_c,
        100.0 * both_p
    );
    // `chase` 的 both 存在但不高（11.3%）：完全为 0 也不对——那说明它在全场尺度上被误算。
    assert!(
        both_c > 0.02 && both_c < 0.25,
        "`chase` 口径的 both 占比 {:.1}% 落在实测 11.3% 之外太远",
        100.0 * both_c
    );
    assert!(
        *chase.get("one").unwrap_or(&0) > 0,
        "`chase` 口径应有 `one` 段"
    );
}

/// **同一 `end_t` 收束多段时，争抢事实只归最靠前的那段**（防空转 / 防错挂）。
///
/// 实测 30 seed 恰好 1 例（seed 24 的 t=5400）：episode 102 `control_lost` 与
/// episode 103 `full_time` 同刻收束。初版让**两段都认领**那条争抢事实 ⇒ ep 103
/// 会继承 ep 102 的成因，报告说「这段以 `interception_loose` 收束」，
/// 而它其实以 `full_time` 收束——**值看起来合理，但指的是另一段的过程**。
///
/// 本测试断言：① 归属**不重复**（每个争抢事实最多被一张卡认领）；
/// ② `full_time` / `half_time` 这类**流边界**结束原因不得带争抢成因。
#[test]
fn a_contest_fact_closes_at_most_one_episode() {
    let mut total_facts = 0usize;
    let mut total_claims = 0usize;
    let mut boundary_with_contest = 0usize;
    for seed in CANARY_SEEDS.0..=CANARY_SEEDS.1 {
        let dm = observe(seed);
        let windows = restart_windows(&dm);
        let facts: std::collections::BTreeSet<usize> = dm
            .control_facts
            .iter()
            .enumerate()
            .filter(|(_, f)| f.kind == ControlFactKind::ContestStarted)
            .map(|(i, _)| i)
            .collect();
        total_facts += facts.len();
        let mut claimed: std::collections::BTreeSet<usize> = Default::default();
        for ep in &dm.possession_episodes {
            let card = card_of(&dm, &windows, seed, ep);
            if let Some(i) = card.closing_fact_index {
                assert!(
                    claimed.insert(i),
                    "seed {seed}：争抢事实 #{i} 被**两张卡**认领（episode {}）——                     同刻收束多段时应只归最靠前的那段",
                    ep.id
                );
                total_claims += 1;
            }
            if matches!(
                card.end_reason,
                Some(EpisodeEndReason::FullTime) | Some(EpisodeEndReason::HalfTime)
            ) {
                assert!(
                    card.contest_start.is_none(),
                    "seed {seed} episode {}：以 {:?}（**流边界**）收束的段不得带争抢成因 {:?}——                     那是同刻另一段的成因",
                    ep.id,
                    card.end_reason,
                    card.contest_start
                );
                if card.contest_start.is_some() {
                    boundary_with_contest += 1;
                }
            }
        }
    }
    assert!(total_facts > 500, "争抢事实太少（{total_facts}）——防空转");
    assert!(
        total_claims > 500,
        "被认领的争抢事实太少（{total_claims}）——防空转"
    );
    // 不重复地把每个事实最多认领一次 ⇒ 认领数 ≤ 事实数。
    assert!(
        total_claims <= total_facts,
        "认领数 {total_claims} 超过事实数 {total_facts}——有事实被重复认领"
    );
    let _ = boundary_with_contest;
}

/// **`gap_count()` 的行为被直接钉住**（`Locus::MatchGapCount` 在运行时不可判别，
/// 故它的判别力只能落在「这个方法到底数什么」上）。
///
/// ⚠️ **本测试的名字曾被前一轮的注释引用而当时并不存在**（审阅轮 2 的 P2-1）——
/// 那是本仓点名的 `[[false-coverage-handoff-claims]]`：**断言存在、覆盖声明存在、
/// 覆盖面不存在**，而且它出现在「声称已修复该族缺陷」的那一笔提交里。
/// 现在这个名字**真的有对应的函数**了（本文件里可 `grep` 到它的定义）。
///
/// 判据（都能被真实变异打红）：
/// ① 把一条事实改成 `ObservationGap` ⇒ 计数**严格 +1**（不是 `>=`——那是恒真断言）；
/// ② 去掉一条 gap ⇒ 计数**严格 −1**；
/// ③ `gap_reason_counts()` 的合计恒等于 `gap_count()`（两个口径不得分叉）。
#[test]
fn match_gap_count_probe_actually_counts() {
    let dm = observe(1);
    let base = dm.gap_count();
    assert_eq!(base, 0, "seed 1 的观察层应为自洽（无 gap）——否则下面的 +1 判据要换锚点");

    let mut with_gap = dm.clone();
    with_gap.control_facts[0].kind = ControlFactKind::ObservationGap;
    with_gap.control_facts[0].detail = Some(ControlFactDetail::Gap(ObservationGapReason::ALL[0]));
    assert_eq!(
        with_gap.gap_count(),
        base + 1,
        "把一条事实改成 `observation_gap` 后 `gap_count()` 必须**严格 +1**——\
         若不变，说明它数的不是 `ObservationGap`；写成 `>=` 则是恒真断言（前一轮的形态）"
    );

    let mut two = dm.clone();
    two.control_facts[0].kind = ControlFactKind::ObservationGap;
    two.control_facts[1].kind = ControlFactKind::ObservationGap;
    assert_eq!(two.gap_count(), base + 2, "两条 gap 应为 base+2");
    two.control_facts[1].kind = ControlFactKind::MatchStarted;
    assert_eq!(
        two.gap_count(),
        base + 1,
        "去掉一条 gap 后 `gap_count()` 必须**严格 −1**"
    );

    let total: usize = with_gap.gap_reason_counts().iter().map(|(_, n)| *n).sum();
    assert_eq!(
        total,
        with_gap.gap_count(),
        "`gap_reason_counts()` 的合计必须等于 `gap_count()`"
    );
}

/// **`ANOMALY_COVERAGE` 的 note 只准引用产物里真有的字段**（审阅轮 2 的 MINOR M-2）。
///
/// ## 这处错长什么样
///
/// 四条 note 声称的落点在产物里**不存在**：A7 说「本层的重开窗逐条给出 `[start,end)` 与
/// 右端来源」（产物没有 `RestartWindow` 结构）、A8 说「位置须读 `ControlFact.location`」
/// （产物没有 `location` 字段，读者据此**拿不到位置**）、A10 说「下一段的 `start_reason`／队」
/// （卡里**没有下一段字段**，且「单段内」与「下一段」自相矛盾）。A4 同类。
/// 这与本 change 的立身之本是**同一把尺子**：**不得声称能给出它给不出的东西**。
///
/// 守卫只核「note 里的反引号标识符要么是产物的键、要么在**显式声明的源侧清单**里」——
/// 后者是「须由消费方拿下标回原对象读」的那些字段（它们**故意**不进产物）。
#[test]
fn anomaly_coverage_notes_only_cite_fields_the_product_carries() {
    // 源侧字段：**故意**不进产物，note 里可以提，但必须说明「须回原对象读」。
    const SOURCE_SIDE_OK: &[&str] = &[
        "ControlFact.location",
        "ControlFact.team/player",
        "PossessionEpisode.start_t,end_t",
        "Event.x,y",
        "Event.x",
        "Event.y",
    ];
    let r = quick();
    let json = to_json(&r);
    let mut keys: std::collections::BTreeSet<String> = Default::default();
    for (i, _) in json.match_indices('"') {
        let rest = &json[i + 1..];
        if let Some(e) = rest.find('"') {
            let k = &rest[..e];
            if !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                keys.insert(k.to_string());
            }
        }
    }
    assert!(keys.len() > 50, "产物键集合过小（{}）——抓取逻辑可能失效", keys.len());
    // ⚠️ **两个可绕路径**（审阅轮 3 的 N-3 实测出逃逸，现已堵）：
    //   (a) 反引号内**含空格**（如 `` `逐条 RestartWindow 的起止` ``）时初版**整段跳过**——
    //       而那恰好是最自然的写法。现改为：**按空白切成词**逐个核（长于 1 字的、像标识符的词）。
    //   (b) 「产物里出现过的**值**」档：值集是用**裸引号**扫出来的，故 `kickoff` 这类
    //       「值」会被当成合法——只要它是产物的某个值，**任何**词都能蒙混过关。
    //       现改为：该档只放行**闭集 token 形态**（全小写 + 下划线 + 可带 `+`/`?`/`-`），
    //       即 `pass+` / `kickoff` 这类**取值枚举**；`RestartWindow` 这类 CamelCase
    //       **类型名**不再被当成值放行。
    // ⚠️ **本守卫迭代了三轮，每一轮都被下一轮证明「更弱」**（审阅轮 2 的空转、
    //    轮 3 的三处逃逸、轮 4 抓到的**判别力回退**）——故这里把设计一次说清，
    //    并把「放行」收敛成**只能显式加白名单**这一条路。
    //
    // ## 反面教材（都实测过，别再走回去）
    //
    // - 只扫**反引号内**：不带反引号地提到类型名就完全不被检查（轮 3 的第三处逃逸）；
    // - 用 **CamelCase/snake_case 筛候选**：全小写字段名（`location`）直接跳过，
    //   而它**正是本守卫要抓的东西**（轮 4 实测 OLD 判红、NEW 判绿——判别力**回退**）；
    // - 点号路径只核 head/tail：`chain.fake_field` 因 `chain` 是真键而放行；
    // - **「产物里出现过的取值」档**：键集是拿**裸引号**扫的，值也在其中，
    //   于是 `kickoff` 这类**值**被当成键命中，该档形同虚设（轮 3 声称堵了，轮 4 实测没有）。
    //
    // ## 现在的设计（**两条硬规则**）
    //
    // 1. **候选 = note 全文里任何「英文标识符形态」的词**（≥3 个字母，允许 `.`/`_`），
    //    **不做形态筛选**——筛选本身就会变成豁免。
    // 2. **放行只有一条路：显式名单**。共**四张**，性质分两类：
    //
    //    | 名单 | 维护 | 内容 |
    //    |---|---|---|
    //    | `json_keys` | **自动**（[`json_object_keys`] 从 JSON 抽，只认 `"k":` ⇒ 键值分离） | 产物真有的**键** |
    //    | `SOURCE_SIDE_OK` | 人工 | 须回原对象读的字段（**故意**不进产物） |
    //    | `PROSE_OK` | 人工 | 散文词 / 引用名（**只放词，不放取值**） |
    //    | `VALUE_OK` | 人工 | 产物里会出现的**取值** |
    //
    //    ⇒ 想让一个词过，只能**显式加**到某一张名单——那是一次有意识的动作，
    //    而不是碰巧逃逸（轮 4 的教训：**形态筛选 = 豁免**）。
    //
    //    ⚠️ **`VALUE_OK` 的坑**（轮 3 的 `M-NOTE-VALUE` → 轮 5 的 P2-3）：初版把它塞进
    //    `PROSE_OK`（注释还写「闭集取值」），于是 `「本层给 kickoff 字段」` 这种
    //    **把取值当字段**的写法被**成文允许**。拆成独立名单还不够——**断言必须真的区分键值**：
    //    只写 `json.contains("\"v\"")` 的话，一个**键**（`duration_s`）也能混进来。
    //    故下面逐词断言**两条**：真在产物里，**且不是键**。
    let json_keys = json_object_keys(&json);
    assert!(
        json_keys.len() > 50,
        "从产物里只抽到 {} 个键——键抽取逻辑失效，本守卫会假绿",
        json_keys.len()
    );
    const PROSE_OK: &[&str] = &[
        // 引用（其它 change / 规则号 / 章节）——它们不是落点。
        "P17A", "P16", "P124", "P17B",
        "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10",
        // 散文里的英文技术词（不是字段名）。
        "episode", "episodes", "chain", "card", "cards", "note", "notes",
        "raw", "in", "the", "and", "of",
        // `ControlFact` 的队/人字段（须回原对象读，与 `ControlFact.location` 同族）。
        "ControlFact.team", "ControlFact.player", "player",
        // 观测层的对象名（在 `SOURCE_SIDE_OK` 里已有其字段路径）。
        "PossessionEpisode.start_t", "PossessionEpisode.end_t",
        // 松散球判据里的两个概念词（不是产物字段）。
        "loose", "beat", "beats",
    ];
    // 产物里会出现的**取值**（note 可引用，但**必须真的在产物里**——否则是后门）。
    // ⚠️ **这一档实测得出**：把十行 note 里所有反引号 token 抽出来、与产物 JSON 的
    // **取值**集合求交，得到的正是下面这 **7** 个（其余的 `chain` / `closing_fact_index`
    // / `duration_s` / `event_indexes` / `start_reason` / `contest_start` / `contest_window`
    // 是**键**，走 `json_keys` 那一档）。每个都断言「真在产物里 **且** 不是键」。
    const VALUE_OK: &[&str] = &[
        "empty_possession",   // 异常类取值
        "instant_contest",
        "long_dwell",
        "shot_rebound_end",
        "interception_loose", // 争抢成因取值
        "restart_control",    // EpisodeStartReason 取值
        "pass+",              // 动作链 token
    ];
    for v in VALUE_OK {
        assert!(
            json.contains(&format!("\"{v}\"")),
            "`VALUE_OK` 里的 `{v}` **不在产物中**——这一档的**全部意义**是「核过它真在产物里」，\
             名不副实的条目就是豁免后门。要么从名单删掉，要么改 note"
        );
        // ⚠️ **本断言只核「该串在产物里存在」，不核它在 note 里被当成取值还是字段。**
        // 轮 5 的 P2-3 想堵的是「把取值当字段引用」（`「本层给 kickoff 字段」`）。
        // 实测**做不到**纯自动判别：`empty_possession` 既是取值（`by_exception` 的键名
        // 同一批串）又是键，故「值 ⇒ 非键」这条不成立。
        // ⇒ 如实声明能力边界：**同一个串按哪种身份被引用，本守卫判不了**；
        // 它保证的是「note 引用的每个标识符都真实存在于产物」。
        // 那半个后门由**人读 note** 兜——`ANOMALY_COVERAGE` 的 `note` 只有十行。
    }
    let mut checked = 0usize;
    let mut violations: Vec<String> = Vec::new();
    for row in ANOMALY_COVERAGE {
        for t in identifier_words(row.note) {
            checked += 1;
            let ok = json_keys.contains(&t)
                || SOURCE_SIDE_OK.contains(&t.as_str())
                || PROSE_OK.contains(&t.as_str())
                || VALUE_OK.contains(&t.as_str());
            if !ok {
                violations.push(format!("{} → `{}`", row.rule, t));
            }
        }
    }
    assert!(
        violations.is_empty(),
        "`ANOMALY_COVERAGE` 的 note 里出现了**未白名单化**的标识符：{violations:?}\n\
         它们既不是本产物真有的键、也不在源侧清单、也不在散文白名单里——\
         即**声称了产物给不出的东西**（或只是没登记）。若是前者，改 note；\
         若是后者，把它**显式加进** `PROSE_OK` / `SOURCE_SIDE_OK`（有意识的动作，\
         而不是靠某个形态筛选碰巧逃逸）。"
    );
    // 防空转：候选数必须够多，否则「一个词都没扫到」也会让上面判绿。
    // 实测当前十行 note 上有 **32** 个候选（轮 5 核过；A7 的 note 一个候选都没有，
    // 因为它只写中文说明与已登记的字段）。下限取 **25**（留 22% 余量）：
    // 它要挡的是「扫描面塌成空」，不是「略少几个词就红」。
    assert!(
        checked > 25,
        "核对到的 identifier 太少（{checked}）——扫描面可能已塌成空（本仓的空转形态）"
    );
}

/// **被推翻的 `close_down` 归因：结构化条目里不得无注记地复述它**。
///
/// ## ⚠️ 本守卫的设计经过（**6 轮，5 次被证伪**——读前必看，别退回那条路）
///
/// 这处归因（「`close_down` 终点距球远 ⇒ 在追人」）曾有四份拷贝，收干净后我写了
/// 几版**跨文件模糊扫描**守卫去防复发，**每版都被独立审阅证伪**：
///
/// | 版 | 判据 | 被证伪的形态 |
/// |---|---|---|
/// | v1 | 单行合取（`"188/513"` && `"追人"`） | 中文散文**折行** ⇒ 侦察 note 与 `tasks.md` 的原文都漏 |
/// | v2 | 按空行切**段落块** | **两个方向都错**：`EVIDENCE_TABLE` 是 235 行无空行巨块 ⇒ 插进去的旧结论被 150 行外的标记词「自动注记」（**比 v1 更弱**）；同时 `5.25` 入集后**误红合法纪律句** |
/// | v3 | 加词表 / 加窗口 | 审阅给出七种绕过；**每一版修复都制造下一版的问题**（v2 为堵漏把 `5.25` 入集，正是它引出误红） |
///
/// **教训：文本扫描**判不出**散文有没有讲错机制**——
/// 「断言」与「禁止」共用同一批词（`5.25` + `追人` 既可能是在讲错，也可能是在**禁止**讲错），
/// 任何词表/窗口的取舍都会在「漏」与「误红」之间来回摆，**不收敛**。
///
/// ## 现在守什么（**窄而真**：0 误报，覆盖「在结构化条目里复述旧结论」）
///
/// 只扫**结构化条目**——`evidence.rs` 的 `EvidenceRow`、`reasons.rs` 的 `WordingRule`——
/// 的**字段字面量**。这些是**会喂进产物**的地方，也是「又抄一份旧结论」真正危险的落点。
/// 判据：条目里若出现**距离证据**（`5.25` / `188/513` / `168/513`）**且**出现 `追人`，
/// 该条目必须带**收回标记**。
///
/// - ✅ **零误报**：自由散文（纪律句、无关两句话）**不扫** ⇒ `E8`/`E13` 那类不再误红；
/// - ✅ **抓得住 `E10`**：插进 `EVIDENCE_TABLE` 的**新条目**只要复述旧结论就红
///   （v2 的巨块问题在这里不存在——单位是**条目的字段**，不是空行切出来的块）。
///
/// ## ❌ 已知残余风险（**如实记录，不假装已机制化**）
///
/// 本守卫**抓不住**在**自由散文**里用**新措辞 / 新单位 / 新同义词**重新写下这处归因：
/// - 空行隔开距离与推论（E1）；只留推论语（E2）；
/// - 换距离写法（`5.3 m` / `逾五米` / `>5m` / `525 cm`，E3–E5）；
/// - 把收回词用在**无关**处（E6）或**反向**否认收回（E15）；
/// - 逐字还原旧句而旧句本身含某个标记词（E12）。
/// 这些**文本启发式天然抓不住**——6 轮实测证明，继续加判据只会换一个新的失败面。
/// **本 change 不追求该族缺陷的全覆盖机制化**（本仓先例：P124 如实放弃
/// `doc_referenced_symbols_exist` 并写明「只靠人工」）。
/// 残余风险的防线是**人**：`ANOMALY_COVERAGE` 的 note 只有十行、
/// 本处归因的权威叙述**只有一份**（`evidence.rs` 的 `MoverTarget` 行 + §4.4.3），
/// 改动它们是显眼的。
#[test]
fn retracted_close_down_claim_sites_carry_their_retraction() {
    /// 收回注记的标记（条目内出现任一即可）。
    const RETRACTION_MARKERS: &[&str] =
        &["推翻", "更正", "不成立", "打不到靶点", "归一化", "单位混用", "被证伪"];
    /// 被推翻推断的**距离证据**。
    const DISTANCE_EVIDENCE: &[&str] = &["5.25", "188/513", "168/513"];
    /// 被推翻推断的**推论语**。
    const INFERENCE: &str = "追人";

    /// 从源文本里切出**结构化条目**：以 `opener` 起、到 `\n    },` 止。
    ///
    /// ⚠️ 单位是**条目**（结构），不是行、不是空行切出的段落——这是 6 轮实测的结论。
    fn units<'a>(src: &'a str, opener: &str) -> Vec<(usize, &'a str)> {
        let mut out = Vec::new();
        let mut from = 0usize;
        while let Some(i) = src[from..].find(opener) {
            let at = from + i;
            let rest = &src[at..];
            let len = rest.find("\n    },").map(|e| e + 7).unwrap_or(rest.len());
            let line = src[..at].lines().count() + 1;
            out.push((line, &rest[..len]));
            from = at + len;
        }
        out
    }

    // 四个会喂进产物的结构化条目族（`evidence.rs` 两张表 + `reasons.rs` 两张表）。
    // ⚠️ opener 带**缩进**（`\n    `）：不带缩进会先匹配到**类型定义**
    // （`pub struct EvidenceRow {` / `pub struct ContestCoverageRow {`），
    // 于是「条目」从类型定义一路吃到第一个 `\n    },`——把类型与常量之间的
    // **无关注释**也卷进来（实测：E8 纪律句因此被误红）。
    let targets: [(&str, &str, &str); 4] = [
        ("p17b/evidence.rs", "\n    EvidenceRow {", "证据边界表条目"),
        ("p17b/evidence.rs", "\n    UnavailableItem {", "结构性不可得条目"),
        ("p17b/reasons.rs", "\n    ContestCoverageRow {", "争抢成因覆盖条目"),
        ("p17b/reasons.rs", "\n    WordingRule {", "措辞规则条目"),
    ];
    let mut units_checked = 0usize;
    let mut claim_units = 0usize;
    for (file, opener, what) in targets {
        let src = match file {
            "p17b/evidence.rs" => include_str!("p17b/evidence.rs"),
            "p17b/reasons.rs" => include_str!("p17b/reasons.rs"),
            _ => unreachable!(),
        };
        for (line, unit) in units(src, opener) {
            units_checked += 1;
            let has_evidence = DISTANCE_EVIDENCE.iter().any(|m| unit.contains(m));
            if !(has_evidence && unit.contains(INFERENCE)) {
                continue;
            }
            claim_units += 1;
            assert!(
                RETRACTION_MARKERS.iter().any(|m| unit.contains(m)),
                "`{file}` 第 {line} 行的{what}**同时**出现距离证据（5.25 / 188/513 / 168/513）\
                 与「追人」推论，却没有收回标记——这正是那处被推翻的归因\
                 （`close_down_stop` 只推进 ≈2 m、打不到靶点 ⇒ 远端球员终点**天然离球远**，\
                 与「追的是不是人」无关）。可以保留历史记录，但**必须带着它的更正**。\n\
                 条目：{}",
                unit.trim()
            );
        }
    }
    // 防空转：**扫描面必须有材料**（条目数）与**至少一处带注记的 claim 单元**。
    //
    // ⚠️ 前一版的防空转断言（`incidents > 0`）**太弱**——守卫自己的 doc 就能满足它。
    // 这里改为核**两个有意义的下限**：① 真的扫到了条目；② 真的存在「带注记的 claim」
    // （否则判据可能在空跑：一个 claim 单元都没扫到也会绿）。
    assert!(
        units_checked > 40,
        "只扫到 {units_checked} 个结构化条目——条目切分规则可能已失效（本仓的空转形态）"
    );
    assert!(
        claim_units > 0,
        "没有扫到任何「距离证据 + 追人」的条目——若这处归因确实已无留存，\
         请把本守卫连同其设计说明一起删掉（而不是让它空转）；\
         否则说明条目切分漏掉了承载它的那个条目"
    );
}

/// **规范一致性守卫的反证条**：喂一个「缺一半」的块必须判红。
///
/// 防空转：本测试证明 [`anomaly_coverage_blocks`] 抽出的**真实**块确实有一个
/// **不是恒真**——若某个块的 `has_within_boundary` / `has_outside_explained` 恒 `true`
/// （例如判据串写成了空串），本测试会红。
#[test]
fn spec_anomaly_coverage_guard_is_not_vacuous() {
    let blocks = anomaly_coverage_blocks();
    assert!(!blocks.is_empty(), "抽不到块 ⇒ 守卫空转");
    // 块里必须**至少有一个**是「两半都由真实文本点亮」的——而不是两半都恒真。
    // 判据：把两半的开闭各自独立核一遍（用一个确定缺一半的文本走同一条逻辑）。
    fn halves(text: &str) -> (bool, bool) {
        (
            text.contains("证据边界内") || text.contains("证据边界之内"),
            text.contains("盲区") || text.contains("边界之外") || text.contains("逐条"),
        )
    }
    let full = "scenario 覆盖 P17A 点名的异常样本（在证据边界内）\n- **THEN** 或逐条说明它落在哪条证据边界之外";
    assert_eq!(halves(full), (true, true), "两半都有的文本应点亮两半");
    let half = "scenario 覆盖 P17A 点名的异常样本\n- **THEN** 各自都能找到样本";
    assert_eq!(
        halves(half),
        (false, false),
        "「各自都能找到样本」这种被禁的形态必须**两半都不点亮**（否则守卫恒真）"
    );
    // 真实块也必须至少有一个两半齐全（防空转：说明本仓当前文档是合规的）。
    assert!(
        blocks.iter().any(|b| b.has_within_boundary && b.has_outside_explained),
        "真实文档里应至少有一个「两半齐全」的块——若一个都没有，守卫在空转或文档已违规：{blocks:#?}"
    );
}

// ============================== 产物自述 / 确定性 / 防空转 ==============================

/// 产物**自带能力边界**（spec 的 Scenario「已知不可得项被如实声明」）+ 确定性。
#[test]
fn report_is_deterministic_and_self_describing() {
    let r1 = quick();
    let r2 = quick();
    assert_eq!(to_json(&r1), to_json(&r2), "同输入两次运行应逐字节相同");
    assert_eq!(to_markdown(&r1), to_markdown(&r2));

    let j = to_json(&r1);
    // 产物必须自带三张边界表。
    for key in [
        "\"evidence_table\"",
        "\"structural_unavailable\"",
        "\"contest_coverage\"",
        "\"wording_rules\"",
        "\"coverage_claims\"",
    ] {
        assert!(j.contains(key), "产物缺少 `{key}`——边界必须随产物走，不能只在源码注释里");
    }
    let md = to_markdown(&r1);
    for key in ["结构性不可得", "追逐不可见", "措辞规则", "证据边界表"] {
        assert!(md.contains(key), "Markdown 产物缺少「{key}」一节");
    }
    // ⚠️ 产物不得出现 pass/fail 或好坏标签（本 change 不产生判据）。
    for banned in ["PASS", "FAIL", "通过率", "好/坏", "合格"] {
        assert!(
            !md.contains(banned),
            "Markdown 产物出现 `{banned}`——本 change **不产生 pass/fail**（行为门归 #18）"
        );
    }
}

/// 防空转：真实 seed 上的聚合非空（阈值有理由，不是 0）。
#[test]
fn aggregates_are_not_vacuous_on_real_seeds() {
    let cards = cards_over(QUICK_SEEDS.0, QUICK_SEEDS.1);
    let r = build_report("canary", QUICK_SEEDS.0, QUICK_SEEDS.1, DUR, &cards);
    let episodes: usize = cards.iter().map(|(_, c)| c.cards.len()).sum();
    let loose_runs: usize = cards.iter().map(|(_, c)| c.loose_runs).sum();
    assert!(episodes > 500, "episode 总数过少：{episodes}");
    assert_eq!(r.cards.len(), episodes, "canary 模式下 L1 应全覆盖（无省略）");
    assert_eq!(r.cards_omitted, 0, "canary 不得省略任何卡");
    // 覆盖率下限（**实测值，不是估计**）：10 seed 的 `loose_runs` = **209**
    // （`QUICK_SEEDS` 区间逐场相加；30 seed 是 674）。下限取 **200**（留 ~4.5% 余量）
    // ——它挡的是「管道接错导致一条都不产」这类空转，不是「略低于常态就红」。
    // 余量刻意留窄：这条断言的价值在**判别力**，余量放大反而会让它变钝。
    assert!(
        loose_runs > 200,
        "松散球段数过少（{loose_runs}）——实测 10 seed = 209（30 seed = 674）"
    );
    assert!(r.mover_counts.get("chasers").copied().unwrap_or(0) > 100, "`chase` 计数过少");
    assert!(
        r.mover_counts.get("close_downers").copied().unwrap_or(0) > 0,
        "`close_down` 计数为 0——分类纪律失去存在理由"
    );
    // L2 至少覆盖两个结束原因与两个争抢成因（否则「分组」是空话）。
    assert!(r.aggregates.by_end_reason.len() >= 2, "按结束原因的分组太少");
    assert!(r.aggregates.by_contest_start.len() >= 2, "按争抢成因的分组太少");
    // 每个争抢成因分组的可见/不可见之和必须等于卡数（不得漏计 NotApplicable 之外的项）。
    for (k, g) in &r.aggregates.by_contest_start {
        assert_eq!(
            g.pursuit_visible + g.pursuit_invisible,
            g.cards,
            "成因 `{k}` 的可见+不可见 ≠ 卡数（有卡既没算可见也没算不可见）"
        );
    }
    // 观察不可信门：每一张不可信的卡都不进 by_end_reason 的分母。
    let coherent_cards = r.aggregates.cards - r.aggregates.incoherent_cards;
    let by_end: usize = r.aggregates.by_end_reason.values().map(|g| g.cards).sum();
    assert!(
        by_end <= coherent_cards,
        "按结束原因的聚合卡数（{by_end}）不得超过可信卡数（{coherent_cards}）——观察不可信门失效"
    );
}

/// 落盘产物与**当前源码**同源（改 `tests/p17b/*` 后没重跑产物门即红）。
#[test]
fn on_disk_artifacts_share_the_current_source_fingerprints() {
    let dir = out_dir();
    let engine = engine_source_fingerprint();
    let test = test_source_fingerprint();
    let mut checked = 0usize;
    for mode in ["canary", "baseline"] {
        let path = dir.join(format!("{mode}.md"));
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue; // 未跑过产物门 → 跳过（同 P16/P17A 的形状）
        };
        assert!(
            text.contains(&engine),
            "落盘产物 `{}` 的 `engine_source_fingerprint` 与当前源码不符——产物是陈旧的",
            path.display()
        );
        assert!(
            text.contains(&test),
            "落盘产物 `{}` 的 `test_source_fingerprint` 与当前源码不符——\
             改了 `tests/p17b/*` 之后没重跑产物门。重跑：\
             `P17B_SOURCE_COMMIT=$(git rev-parse HEAD) cargo test --release \
             --test p17b_diagnosis_report -- --ignored --nocapture`",
            path.display()
        );
        // `source_commit` 合理性：不得是 `unknown`（自失效的 `== HEAD` 断言见 P16 的记录）。
        assert!(
            !text.contains("| `source_commit` | `unknown` |"),
            "落盘产物 `{}` 的 `source_commit` 是 unknown——产物门须传 `P17B_SOURCE_COMMIT`",
            path.display()
        );
        checked += 1;
    }
    // 没跑过产物门时本测试不做任何断言（CI 上不会红；产物由 `#[ignore]` 门生成）。
    let _ = checked;
}

// ============================== 产物落盘门（`#[ignore]`） ==============================

/// 跑一个 seed 区间，落盘 JSON + Markdown。
pub fn run_and_write(
    mode: &str,
    first: u64,
    last: u64,
) -> (std::path::PathBuf, Report) {
    let cards = cards_over(first, last);
    let r = build_report(mode, first, last, DUR, &cards);
    let dir = out_dir();
    std::fs::create_dir_all(&dir).expect("建产物目录");
    let json_path = dir.join(format!("{mode}.json"));
    let md_path = dir.join(format!("{mode}.md"));
    std::fs::write(&json_path, to_json(&r)).expect("写 JSON");
    std::fs::write(&md_path, to_markdown(&r)).expect("写 Markdown");
    (md_path, r)
}

/// **`#[ignore]` 门：30 seed canary 产物**（L1 **全覆盖**——逐 episode 都有卡，便于人眼核对口径）。
#[test]
#[ignore = "30 seed × 90 分钟；显式跑：--release -- --ignored --nocapture p17b_canary"]
fn p17b_canary() {
    let (path, r) = run_and_write("canary", CANARY_SEEDS.0, CANARY_SEEDS.1);
    assert_ne!(
        r.provenance.source_commit, "unknown",
        "产物门须传 `P17B_SOURCE_COMMIT=$(git rev-parse HEAD)`"
    );
    assert_eq!(r.cards_omitted, 0, "canary 必须 L1 全覆盖");
    assert!(r.cards.len() > 1000, "canary 卡数过少：{}", r.cards.len());
    // 覆盖缺口的**存在性**：canary 上必须真的出现「追逐不可见」的卡。
    let invisible: usize = r
        .aggregates
        .by_contest_start
        .values()
        .map(|g| g.pursuit_invisible)
        .sum();
    assert!(
        invisible > 0,
        "canary 上必须出现「追逐不可见」的卡（`interception_loose` 恒不可见）——\
         否则本 change 的核心发现在真实数据上不存在"
    );
    println!("[p17b:canary] {} → {}", path.display(), r.cards.len());
    println!("[p17b:canary] agg = {:?}", r.aggregates.by_contest_start);
}

/// **`#[ignore]` 门：300 seed baseline 产物**（L1 **按异常筛选**——与 P17A 同 seed 区间）。
#[test]
#[ignore = "300 seed × 90 分钟；显式跑：--release -- --ignored --nocapture p17b_baseline"]
fn p17b_baseline() {
    let (path, r) = run_and_write("baseline", BASELINE_SEEDS.0, BASELINE_SEEDS.1);
    assert_ne!(r.provenance.source_commit, "unknown");
    assert!(
        r.cards_omitted > 0,
        "baseline 必须按异常筛选（省略数应 > 0）——否则 3 万张卡无法阅读"
    );
    assert!(!r.cards.is_empty(), "筛选后不应为空");
    println!(
        "[p17b:baseline] {} 收录 {} / 省略 {}",
        path.display(),
        r.cards.len(),
        r.cards_omitted
    );
}

// ============================== 守卫用的小工具 ==============================

/// 从 JSON 文本里抽出**对象的键**（只抽键，不抽值——用 `"k":` 形态界定）。
///
/// ⚠️ 这是 [`anomaly_coverage_notes_only_cite_fields_the_product_carries`] 的关键：
/// 前几版拿**裸引号**扫，把**值**（`kickoff` / `pass+`）也当成键收进来，
/// 于是「产物里出现过的取值」那一档形同虚设。只抽 `"k":` 形态即可把两者分开。
fn json_object_keys(json: &str) -> std::collections::BTreeSet<String> {
    let mut out = std::collections::BTreeSet::new();
    let bytes = json.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'"' {
            i += 1;
            continue;
        }
        // 找闭引号（JSON 里键不含需要转义的引号以外内容；简单扫即可）。
        let start = i + 1;
        let mut j = start;
        while j < bytes.len() && bytes[j] != b'"' {
            j += 1;
        }
        if j >= bytes.len() {
            break;
        }
        let cand = &json[start..j];
        // 键的判据：闭引号之后（跳过空白）紧跟 `:`。
        let mut k = j + 1;
        while k < bytes.len() && (bytes[k] as char).is_ascii_whitespace() {
            k += 1;
        }
        if k < bytes.len() && bytes[k] == b':' {
            out.insert(cand.to_string());
        }
        i = j + 1;
    }
    out
}

/// 抽出一段文本里**全部英文标识符形态的词**（≥3 个字母，允许 `.`、`_`、`+`、`?`）。
///
/// ⚠️ `+` / `?` 必须在字符集里：动作链 token 是 `pass+` / `passI` / `pass?` 这类形态，
/// 若只收 `[A-Za-z0-9_.]`，`pass+` 会被截成 `pass`——而 `pass` **不是**产物里的取值，
/// 于是**合法**的 note 会被误判（实测撞到过），而真正要抓的 `pass` 又形同虚设。
///
/// **刻意不做形态筛选**（不区分 CamelCase / snake_case / 全小写）——轮 4 实测：
/// 用形态筛候选会让**全小写字段名**（`location`，正是本守卫的动机）被跳过，
/// 判别力比前一版**更弱**。筛选 = 豁免，故这里一律收，能不能过交给白名单。
fn identifier_words(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if !(c.is_ascii_alphabetic() || c == '_') {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() {
            let c = bytes[i] as char;
            if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '+' || c == '?' {
                i += 1;
            } else {
                break;
            }
        }
        // 只裁**句末的 `.`**：`.` 是句读、不属于标识符；而 `+` / `?` 是**动作 token 的一部分**
        // （`pass+`），裁掉它会把 token 截成不存在的 `pass`（实测撞到过）。
        let t = text[start..i].trim_end_matches('.');
        // 至少 3 个字母（`in` / `of` / `s` 这类太短，散文高频，不值当核）。
        if t.chars().filter(|c| c.is_ascii_alphabetic()).count() >= 3 {
            out.push(t.to_string());
        }
    }
    out
}
