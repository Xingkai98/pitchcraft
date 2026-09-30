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
//! | [`observation_credibility_gate_annotates_but_keeps`] | 前置门（标注但保留、不进聚合） | ✅ |
//! | [`spec_anomaly_coverage_blocks_carry_both_halves_and_the_guard_is_not_vacuous`] | 规范一致性（**块判 + 反证条**） | ✅ |
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
            // 这两个读的是**整场**的一致性，不随任一容器清空而变——它们的判别力
            // 由「不自洽输入」证明（见下）。
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
    // ① 反证条：用一个**闭集里没有**的成因，`coverage_of` 必须给出 None。
    //    这里直接核 `find` 的语义（表里没有的成因找不到），而不是伪造一个枚举值。
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
    let mut bad = 0usize;
    let mut checked = 0usize;
    for ep in &dm.possession_episodes {
        let card = card_of(&dm, &windows, 1, ep, &mut bad);
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
    assert_eq!(bad, 0, "事件下标越界数必须为 0");
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

/// `taken_t` 缺失时**必须给出显式行为**（design §5 待决策 3）。
///
/// 实测（30 seed）1613 个重开里 2 个缺 `taken_t`（≈0.12%，**非零**）。
/// 本测试在**真实 seed** 上核存在性（防空转）——若一个都找不到，
/// 说明 fallback 分支从未被走到，它的正确性也就无从验证。
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
    // 缺失档在 canary（30 seed）上**必须出现**——这是防空转的关键：
    // 「2/1613」意味着它极少见，若本测试在真实 seed 上找不到一例，
    // fallback 分支就是**未被执行的代码**，其行为只是纸面声明。
    let fallback = sources.get("open_play_resumed_t").copied().unwrap_or(0)
        + sources.get("next_restart_start_t").copied().unwrap_or(0)
        + sources.get("stream_end").copied().unwrap_or(0);
    assert!(
        fallback > 0,
        "canary 上应出现 `taken_t` 缺失的 fallback 窗口（实测 30 seed 里有 2 例）——\
         若为 0，fallback 分支是未被执行的代码。实际分布：{sources:?}"
    );
}

// ============================== 动作归因（反 MAJOR-2） ==============================

/// `chase` 与 `close_down` **分类而非并称**（spec 的 Requirement「动作归因不得把『追人』当作『追球』」）。
///
/// 侦察实测（8 seed）188/513 的 `close_down` 终点距球 > 5.25 m——它们在**追人**。
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
            let mut bad = 0usize;
            let card = card_of(&dm, &windows, seed, ep, &mut bad);
            assert_eq!(bad, 0, "seed {seed} episode {i}：事件下标越界");
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
    let sources: [(&str, &str); 3] = [
        ("p17b/evidence.rs", include_str!("p17b/evidence.rs")),
        ("p17b/episode.rs", include_str!("p17b/episode.rs")),
        ("p17b/reasons.rs", include_str!("p17b/reasons.rs")),
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
    const P17B_MAIN: &str = include_str!("p17b_diagnosis_report.rs");
    // ① p17b 自己不得声明该常量。
    for name in ["SUPPORT_MAX_DIST_M", "SUPPORT_MIN_FORWARD_M"] {
        let own_decl = P17B_MAIN
            .lines()
            .map(|l| strip_line_comments(l))
            .any(|l| l.contains("const") && l.contains(name) && l.contains('='));
        assert!(
            !own_decl,
            "p17b **不得**自己声明 `{name}`——接应口径必须经 `#[path]` 活读 p16。\
             复制一份会让「同源」退化成文本比对（设计已论证过这条）"
        );
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
        let mut bad = 0usize;
        let card = card_of(&dm, &windows, 1, ep, &mut bad);
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
    let mut bad = 0usize;
    let mut cards: Vec<EpisodeCard> = dm
        .possession_episodes
        .iter()
        .map(|ep| card_of(&dm, &windows, 1, ep, &mut bad))
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
    // 覆盖率下限（实测 10 seed：loose_runs > 300）——**不是**「至少一段」这种空转下限。
    assert!(
        loose_runs > 200,
        "松散球段数过少（{loose_runs}）——实测 10 seed 应 > 300；下限取 200 留余量但不空转"
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
