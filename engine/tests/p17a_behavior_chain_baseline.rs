//! P17A（#17A）行为链基线分析：把「当前模型重复产生哪些不像足球的过程」变成**仓库内可复现**的
//! 诊断产物。
//!
//! 分层（对齐 `CLAUDE.md` 的分层验证表）：
//!
//! | 本文件的测试 | 判据层 | 默认跑? |
//! |---|---|---|
//! | [`per_episode_action_chain_uses_only_decision_events`] | 分析器语义（动作口径） | ✅ |
//! | [`action_mapping_covers_the_engine_vocabulary`] | 分析器语义（事件→动作） | ✅ |
//! | [`contest_pairing_uses_the_adjacent_ended_fact`] | 分析器语义（争抢配对/夺回率） | ✅ |
//! | [`restart_first_control_uses_the_next_episode`] | 分析器语义（重开→首次控制） | ✅ |
//! | [`named_motif_matchers_hold_on_constructed_chains`] | 分析器语义（motif 判定 + 反例） | ✅ |
//! | [`statistics_are_per_match_then_cross_match`] | 口径纪律（不池化原始观测） | ✅ |
//! | [`sidecar_schema_fingerprint_is_stable_and_content_sensitive`] | 口径纪律（可比性） | ✅ |
//! | [`engine_source_fingerprint_covers_all_simulation_sources`] | 口径纪律（指纹覆盖 rng.rs 等全部仿真源码） | ✅ |
//! | [`anomaly_rules_degrade_when_sample_is_insufficient`] | 口径纪律（防空转降级） | ✅ |
//! | [`baseline_and_canary_seed_ranges_are_pinned_and_nested`] | 口径纪律（seed 集被钉住） | ✅ |
//! | [`zero_count_closed_set_members_are_present_not_omitted`] | 口径纪律（闭集 0 计数不缺行） | ✅ |
//! | [`by_kind_stats_group_per_match_not_per_observation`] | 口径纪律（池化回归守卫） | ✅ |
//! | [`a7_reports_the_per_match_statistic_not_the_pooled_mean`] | 异常规则口径（A7 报数不池化） | ✅ |
//! | [`a7_title_is_interpolated_and_evidence_covers_the_control_channel`] | 异常规则口径（A7 插值 + 对照证据） | ✅ |
//! | [`a5_evidence_comes_from_the_statistic_population`] | 异常规则口径（A5 证据母体） | ✅ |
//! | [`multi_pass_share_counts_open_play_passes_only`] | 异常规则口径（A9 排除交付） | ✅ |
//! | [`anomaly_expectations_are_tagged_uncalibrated`] | 口径纪律（期望未标定标签） | ✅ |
//! | [`mechanism_prose_carries_no_frozen_statistical_ratios`] | 口径纪律（机制文本不含冻结比例） | ✅ |
//! | [`markdown_states_the_missing_real_match_dataset`] | 口径纪律（产物声明数据缺口） | ✅ |
//! | [`identical_inputs_produce_byte_identical_output`] | 确定性 | ✅ |
//! | [`aggregates_are_not_vacuous_on_real_seeds`] | 防空转（真实路径下限） | ✅ |
//! | [`on_disk_artifacts_share_one_provenance_block`] | 同源（两产物 provenance 一致） | ✅ |
//! | [`first_control_delay_equals_delivery_flight_on_real_path`] | 已知冗余（两列恒等） | ✅ |
//! | [`p17a_canary`] | 产物落盘（30 seed） | ❌ `#[ignore]` |
//! | [`p17a_baseline`] | 产物落盘（300 seed） | ❌ `#[ignore]` |
//!
//! 实测条数：**23 passed / 2 ignored**（2026-09-24 第四轮审阅修复后）。
//!
//! 跑法：
//!
//! ```text
//! # 默认快速门
//! cargo test --test p17a_behavior_chain_baseline
//! # canary 产物（先跑这个确认口径）
//! cargo test --release --test p17a_behavior_chain_baseline -- --ignored --nocapture p17a_canary
//! # 300 seed 基线产物（前后对比的权威基线）
//! P17A_SOURCE_COMMIT=$(git rev-parse HEAD) \
//!   cargo test --release --test p17a_behavior_chain_baseline -- --ignored --nocapture p17a_baseline
//! ```
//!
//! **本 change 不改生成逻辑**：分析器只读公开 API（`simulate_with_behavior_observations` +
//! `observation` 模块公开类型）。守卫：`tests/p15_behavior_observation.rs` 的逐字节一致门仍然
//! 必须全绿（本文件不触碰 `engine/src/`）。

#[path = "p17a/model.rs"]
mod model;
#[path = "p17a/metrics.rs"]
mod metrics;
#[path = "p17a/motifs.rs"]
mod motifs;
#[path = "p17a/anomalies.rs"]
mod anomalies;
#[path = "p17a/report.rs"]
mod report;

use anomalies::Ctx;
use fm_engine::observation::*;
use fm_engine::{simulate_with_behavior_observations, Event, EventType, MatchConfig, MODEL_VERSION};
use model::MatchRecord;
use report::Report;

// ============================== 运行器 ==============================

const DUR: f64 = 5400.0;
/// baseline 默认 seed 区间（前后对比的固定集合）。
const BASELINE_SEEDS: (u64, u64) = (1, 300);
/// canary 默认 seed 区间：**baseline 的前缀子集**，保证 canary 上的变化在 baseline 可见。
const CANARY_SEEDS: (u64, u64) = (1, 30);

fn cfg(dur: f64) -> MatchConfig {
    MatchConfig {
        match_duration_seconds: dur,
        demo_mode: false,
        model_version: MODEL_VERSION,
    }
}

fn observed(seed: u64) -> DiagnosticMatch {
    simulate_with_behavior_observations(seed, cfg(DUR))
}

/// seed 区间 → 逐场记录。按 seed 升序，因此下游一切样本顺序都是确定的。
fn derive_seeds(first: u64, last: u64) -> Vec<MatchRecord> {
    (first..=last)
        .map(|seed| model::derive_match(seed, &observed(seed)))
        .collect()
}

/// 从逐场记录构建完整报告（指标 + motif + 异常规则）。
pub fn build_report(
    mode: &str,
    first: u64,
    last: u64,
    duration: f64,
    per_match: &[MatchRecord],
) -> Report {
    let possession_shape = metrics::possession_shape(per_match);
    let transitions = metrics::control_transitions(per_match);
    let restarts = metrics::restart_quality(per_match);
    let motif_report = motifs::mine(per_match);
    let samples = metrics::sample_totals(per_match);
    // `samples` 不进 `Ctx`：异常规则的样本量各自取自它所依赖的指标（防空转由
    // `aggregates_are_not_vacuous_on_real_seeds` 另行核验全局分母）。
    let anomalies = anomalies::evaluate(&Ctx {
        per_match,
        possession: &possession_shape,
        transitions: &transitions,
        restarts: &restarts,
        motifs: &motif_report,
    });
    Report {
        provenance: report::build_provenance(mode, first, last, duration, MODEL_VERSION),
        samples,
        possession_shape,
        transitions,
        restarts,
        motifs: motif_report,
        anomalies,
        pooled_start_reasons: report::pooled_counts(per_match, |m| {
            m.episode_start_reason_counts
                .iter()
                .map(|(k, v)| (k.to_string(), *v))
                .collect()
        }),
        pooled_end_reasons: report::pooled_counts(per_match, |m| {
            m.episode_end_reason_counts
                .iter()
                .map(|(k, v)| (k.to_string(), *v))
                .collect()
        }),
        pooled_event_types: report::pooled_counts(per_match, |m| {
            m.event_type_counts
                .iter()
                .map(|(k, v)| (k.to_string(), *v))
                .collect()
        }),
        pooled_fact_kinds: report::pooled_counts(per_match, |m| m.fact_kind_counts.clone()),
    }
}

fn out_dir() -> std::path::PathBuf {
    std::env::var("P17A_OUT_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("target/p17a-baseline"))
}

/// 跑一个模式并把 JSON + Markdown 落盘，返回产物路径与分析摘要。
fn run_and_write(mode: &str, first: u64, last: u64) -> (std::path::PathBuf, Report) {
    let started = std::time::Instant::now();
    let per_match = derive_seeds(first, last);
    let r = build_report(mode, first, last, DUR, &per_match);
    let dir = out_dir();
    std::fs::create_dir_all(&dir).expect("创建产物目录失败");
    let json_path = dir.join(format!("{}.json", mode));
    let md_path = dir.join(format!("{}.md", mode));
    std::fs::write(&json_path, report::to_json(&r)).expect("写 JSON 失败");
    std::fs::write(&md_path, report::to_markdown(&r)).expect("写 Markdown 失败");

    let s = &r.samples;
    println!(
        "[p17a:{}] {} 场 / {} 事件 / {} facts / {} episodes / {} restarts / {} contests / {} gaps / {} 违规 | {:.1}s",
        mode,
        s.matches,
        s.events,
        s.facts,
        s.episodes,
        s.restarts,
        s.contests,
        s.gaps,
        s.invariant_violations,
        started.elapsed().as_secs_f64()
    );
    println!(
        "[p17a:{}] 落盘：{} / {}",
        mode,
        json_path.display(),
        md_path.display()
    );
    let fired = r
        .anomalies
        .iter()
        .filter(|a| a.status == anomalies::Status::Anomaly)
        .count();
    println!("[p17a:{}] 异常触发 {} / {} 条规则", mode, fired, r.anomalies.len());
    (json_path, r)
}

/// `#[ignore]` 门：canary 产物（默认 1..=30）。
///
/// 为什么 `#[ignore]`：本门要跑 30 场 90 分钟模拟（release ~15 s），与 #15A 的 300-seed 校准门
/// 同款约定——重活显式跑，不拖慢默认 `cargo test`。
#[test]
#[ignore = "30 场 × 90 分钟；用 --release -- --ignored --nocapture p17a_canary 显式跑"]
fn p17a_canary() {
    let (_, r) = run_and_write("canary", CANARY_SEEDS.0, CANARY_SEEDS.1);
    assert_eq!(
        r.samples.invariant_violations, 0,
        "sidecar 不变量违规 → 分析输入不可信，先修观察层"
    );
    assert_eq!(r.samples.unclosed_episodes, 0, "存在未闭合 episode，口径不可用");
    assert!(r.samples.matches == (CANARY_SEEDS.1 - CANARY_SEEDS.0 + 1) as usize);
}

/// `#[ignore]` 门：baseline 产物（默认 1..=300，前后对比用）。
#[test]
#[ignore = "300 场 × 90 分钟；用 --release -- --ignored --nocapture p17a_baseline 显式跑"]
fn p17a_baseline() {
    let (_, r) = run_and_write("baseline", BASELINE_SEEDS.0, BASELINE_SEEDS.1);
    assert_eq!(
        r.samples.invariant_violations, 0,
        "sidecar 不变量违规 → 分析输入不可信，先修观察层"
    );
    assert_eq!(r.samples.unclosed_episodes, 0, "存在未闭合 episode，口径不可用");
    assert!(r.samples.matches == (BASELINE_SEEDS.1 - BASELINE_SEEDS.0 + 1) as usize);
}

// ============================== fixture 构造 ==============================
//
// 下列 fixture 的字段取值**照真实路径观测到的形状**构造（见 change design.md §6 的 recon 实测：
// `pass.result ∈ {success, intercepted, lost, out, contested}`、`detail ∈ {free_kick, throw_in,
// corner, goal_kick, header}`、争抢时长 `{0, 3}`、`ObservedTime` basis 用 state_commit/event_emit）。
// 不构造生产不可达的取值——否则断言会变成恒真（P15/P36 的教训）。

fn ev(t: f64, ty: EventType, subject: i32, result: Option<&str>, detail: Option<&str>) -> Event {
    Event {
        t,
        type_: ty,
        subject,
        x: 0.5,
        y: 0.5,
        result: result.map(|s| s.to_string()),
        detail: detail.map(|s| s.to_string()),
        ..Event::default()
    }
}

fn fact(
    t: f64,
    kind: ControlFactKind,
    team: Option<TeamId>,
    detail: Option<ControlFactDetail>,
) -> ControlFact {
    ControlFact {
        t: ObservedTime::state_commit(t),
        kind,
        team,
        player: None,
        location: Some((0.5, 0.5)),
        source_event_index: None,
        basis: ControlFactBasis::EngineState,
        detail,
    }
}

fn episode_fixture(
    id: u64,
    team: TeamId,
    start_t: f64,
    end_t: f64,
    start_reason: EpisodeStartReason,
    end_reason: EpisodeEndReason,
    event_indexes: Vec<usize>,
) -> PossessionEpisode {
    PossessionEpisode {
        id,
        team,
        start_t: ObservedTime::state_commit(start_t),
        end_t: Some(ObservedTime::state_commit(end_t)),
        start_reason,
        end_reason: Some(end_reason),
        control_fact_indexes: Vec::new(),
        event_indexes,
    }
}

fn empty_dm(events: Vec<Event>) -> DiagnosticMatch {
    DiagnosticMatch {
        events,
        control_facts: Vec::new(),
        possession_episodes: Vec::new(),
        restart_sequences: Vec::new(),
        phase_segments: Vec::new(),
        state: BehaviorControlState::Ended,
        invariant_violations: Vec::new(),
    }
}

/// 构造一条动作步（motif 单测用）。
fn act(event_index: usize, t: f64, kind: model::ActionKind, delivery: bool) -> model::Action {
    model::Action {
        event_index,
        t,
        kind,
        team: Some(TeamId::Home),
        is_delivery: delivery,
        detail: None,
        x: 0.5,
        y: 0.5,
    }
}

fn ep_rec(
    start_reason: &'static str,
    end_reason: Option<&'static str>,
    start_t: f64,
    end_t: Option<f64>,
    actions: Vec<model::Action>,
) -> model::EpisodeRecord {
    let mut gaps = Vec::new();
    for w in actions.windows(2) {
        gaps.push(w[1].t - w[0].t);
    }
    let first_shot_index = actions.iter().position(|a| a.kind.is_shot());
    let has_goal = actions.iter().any(|a| a.kind == model::ActionKind::ShotGoal);
    model::EpisodeRecord {
        id: 0,
        team: TeamId::Home,
        start_t,
        end_t,
        duration: end_t.map(|e| e - start_t),
        start_reason,
        end_reason,
        actions,
        beat_bindings: 0,
        action_gaps: gaps,
        first_shot_index,
        has_goal,
    }
}

fn empty_match(seed: u64) -> MatchRecord {
    MatchRecord {
        seed,
        events_len: 0,
        facts_len: 0,
        gap_count: 0,
        invariant_violations: 0,
        episodes: Vec::new(),
        contests: Vec::new(),
        restarts: Vec::new(),
        action_counts: Default::default(),
        event_type_counts: Default::default(),
        fact_kind_counts: Default::default(),
        restart_kind_counts: Default::default(),
        episode_end_reason_counts: Default::default(),
        episode_start_reason_counts: Default::default(),
        final_score: None,
    }
}

/// 构造一条 restart 记录（准备期是 `prep_duration`，只填异常规则会用到的字段）。
fn restart_rec(id: u64, kind: &'static str, prep_duration: Option<f64>) -> model::RestartRecord {
    model::RestartRecord {
        id,
        kind,
        team: "home",
        start_t: 0.0,
        prep_duration,
        flight_duration: Some(4.0),
        end_reason: Some("open_play_resumed"),
        taken_t: prep_duration,
        first_episode: None,
        first_control_delay: None,
        event_indexes: Vec::new(),
    }
}

/// 构造逐场记录（异常规则单测用：只填异常规则会读的字段）。
fn match_with(
    seed: u64,
    episodes: Vec<model::EpisodeRecord>,
    restarts: Vec<model::RestartRecord>,
) -> MatchRecord {
    let mut m = empty_match(seed);
    m.episodes = episodes;
    m.restarts = restarts;
    m
}

/// 对给定逐场记录跑全部异常规则。
fn evaluate_all(per_match: &[MatchRecord]) -> Vec<anomalies::Anomaly> {
    let possession = metrics::possession_shape(per_match);
    let transitions = metrics::control_transitions(per_match);
    let restarts = metrics::restart_quality(per_match);
    let motif_report = motifs::mine(per_match);
    anomalies::evaluate(&Ctx {
        per_match,
        possession: &possession,
        transitions: &transitions,
        restarts: &restarts,
        motifs: &motif_report,
    })
}

fn rule<'a>(rules: &'a [anomalies::Anomaly], id: &str) -> &'a anomalies::Anomaly {
    rules
        .iter()
        .find(|a| a.id == id)
        .unwrap_or_else(|| panic!("没有规则 {}", id))
}

// ============================== 1. 分析器语义 ==============================

/// 动作链只含**决策事件**：`beat` 不入链，但它的绑定数单独记（归属完整性交叉检查）。
#[test]
fn per_episode_action_chain_uses_only_decision_events() {
    let events = vec![
        ev(0.0, EventType::Kickoff, 9, Some("success"), None),
        ev(11.0, EventType::Pass, 10, Some("success"), None),
        ev(12.0, EventType::Beat, 0, None, None),
        ev(13.0, EventType::Beat, 0, None, None),
        ev(22.0, EventType::Shot, 10, Some("off_target"), None),
    ];
    let mut dm = empty_dm(events);
    dm.possession_episodes.push(episode_fixture(
        0,
        TeamId::Home,
        0.0,
        25.0,
        EpisodeStartReason::Kickoff,
        EpisodeEndReason::Out,
        vec![0, 1, 2, 3, 4],
    ));
    let m = model::derive_match(7, &dm);
    let ep = &m.episodes[0];
    assert_eq!(
        ep.tokens(),
        vec!["kickoff", "pass+", "shotX"],
        "beat 不得进入动作链"
    );
    assert_eq!(ep.beat_bindings, 2, "beat 绑定数必须单独记录");
    assert_eq!(ep.pass_count(), 1);
    assert_eq!(ep.first_shot_index, Some(2), "射门在链中序号 = 它之前有几个动作");
    // 动作在 t = 0 / 11 / 22：间隔按**动作事件**时间算（beat 在 12/13 不参与）。
    assert_eq!(ep.action_gaps, vec![11.0, 11.0], "间隔按动作事件时间算");
    assert_eq!(m.event_type_counts.get("beat"), Some(&2));
}

/// 事件 → 动作的映射覆盖引擎词表，且**不吞**未知 result（落 `pass?` / `shot?` 而不是静默丢弃）。
#[test]
fn action_mapping_covers_the_engine_vocabulary() {
    let cases: Vec<(Event, Option<model::ActionKind>)> = vec![
        (
            ev(0.0, EventType::Pass, 1, Some("success"), None),
            Some(model::ActionKind::PassSuccess),
        ),
        (
            ev(0.0, EventType::Pass, 1, Some("intercepted"), None),
            Some(model::ActionKind::PassIntercepted),
        ),
        (
            ev(0.0, EventType::Pass, 1, Some("lost"), None),
            Some(model::ActionKind::PassLost),
        ),
        (
            // detail 取真实值 `out_goal_line`（lib.rs 出界 pass 的实际编码），
            // 不是 `goal_line`——本文件的 fixture 纪律是"不构造生产不可达的取值"。
            ev(0.0, EventType::Pass, 1, Some("out"), Some("out_goal_line")),
            Some(model::ActionKind::PassOut),
        ),
        (
            ev(0.0, EventType::Pass, 1, Some("contested"), None),
            Some(model::ActionKind::PassContested),
        ),
        (
            ev(0.0, EventType::Pass, 1, None, None),
            Some(model::ActionKind::PassOther),
        ),
        (
            ev(0.0, EventType::Shot, 1, Some("goal"), None),
            Some(model::ActionKind::ShotGoal),
        ),
        (
            ev(0.0, EventType::Shot, 1, Some("saved"), None),
            Some(model::ActionKind::ShotSaved),
        ),
        (
            ev(0.0, EventType::Shot, 1, Some("off_target"), None),
            Some(model::ActionKind::ShotOffTarget),
        ),
        (
            ev(0.0, EventType::Tackle, 1, Some("success"), None),
            Some(model::ActionKind::Tackle),
        ),
        (
            ev(0.0, EventType::Foul, 1, None, Some("foul_trip")),
            Some(model::ActionKind::Foul),
        ),
        (ev(0.0, EventType::Beat, 1, None, None), None),
        (ev(0.0, EventType::Whistle, 0, None, Some("full_time")), None),
        (ev(0.0, EventType::Lineup, 0, None, None), None),
    ];
    for (e, want) in cases {
        assert_eq!(model::action_of(&e), want, "事件 {:?} 映射错误", e.type_);
    }

    // 交付判定：定位球 detail 必须被标成 delivery（重开口径依赖它）。
    let mut dm = empty_dm(vec![
        ev(0.0, EventType::Pass, 12, Some("success"), Some("free_kick")),
        ev(5.0, EventType::Pass, 4, Some("success"), None),
    ]);
    dm.possession_episodes.push(episode_fixture(
        0,
        TeamId::Away,
        0.0,
        20.0,
        EpisodeStartReason::RestartControl,
        EpisodeEndReason::ControlLost,
        vec![0, 1],
    ));
    let m = model::derive_match(8, &dm);
    let ep = &m.episodes[0];
    assert!(ep.actions[0].is_delivery, "free_kick 交付必须标记");
    assert!(!ep.actions[1].is_delivery);
    assert_eq!(ep.open_play_actions().count(), 1, "交付不计入开放动作");
}

/// 争抢配对用**紧邻**的 `contest_ended`；夺回率以 `contest_started.team`（丢球方）为基准。
#[test]
fn contest_pairing_uses_the_adjacent_ended_fact() {
    let mut dm = empty_dm(vec![ev(10.0, EventType::Pass, 3, Some("intercepted"), None)]);
    dm.control_facts = vec![
        fact(
            10.0,
            ControlFactKind::ContestStarted,
            Some(TeamId::Home),
            Some(ControlFactDetail::ContestStart(ContestStartReason::InterceptionLoose)),
        ),
        fact(
            13.0,
            ControlFactKind::ContestEnded,
            None,
            Some(ControlFactDetail::ContestEnd(ContestEndReason::Pickup)),
        ),
        fact(13.0, ControlFactKind::ControlEstablished, Some(TeamId::Away), None),
    ];
    dm.possession_episodes.push(episode_fixture(
        0,
        TeamId::Away,
        13.0,
        40.0,
        EpisodeStartReason::Pickup,
        EpisodeEndReason::ControlLost,
        vec![0],
    ));
    let m = model::derive_match(11, &dm);
    let c = &m.contests[0];
    assert_eq!(c.duration, Some(3.0), "时长 = ended - started");
    assert_eq!(c.losing_team, Some(TeamId::Home));
    assert_eq!(c.pickup_team, Some(TeamId::Away));
    assert_eq!(
        c.regained_by_loser,
        Some(false),
        "对手拾回 = 未夺回；基准是 contest_started.team（丢球方）"
    );
    assert_eq!(c.next_episode, Some(0));

    // 反例：`contest_ended` 不紧邻（中间夹了别的 kind）→ 时长必须留 None，不得向前搜到别人的收束。
    let mut dm2 = empty_dm(vec![]);
    dm2.control_facts = vec![
        fact(
            10.0,
            ControlFactKind::ContestStarted,
            Some(TeamId::Home),
            Some(ControlFactDetail::ContestStart(ContestStartReason::TackleLoose)),
        ),
        fact(11.0, ControlFactKind::ControlEstablished, Some(TeamId::Home), None),
        fact(
            12.0,
            ControlFactKind::ContestEnded,
            None,
            Some(ControlFactDetail::ContestEnd(ContestEndReason::Pickup)),
        ),
    ];
    let m2 = model::derive_match(12, &dm2);
    assert_eq!(
        m2.contests[0].duration, None,
        "非紧邻的 contest_ended 不得被当成自己的收束（向前搜会读到别人的收束）"
    );

    // 原队夺回的正例（同一支球队拾回）。
    let mut dm3 = empty_dm(vec![]);
    dm3.control_facts = vec![
        fact(
            20.0,
            ControlFactKind::ContestStarted,
            Some(TeamId::Away),
            Some(ControlFactDetail::ContestStart(ContestStartReason::TackleLoose)),
        ),
        fact(
            20.0,
            ControlFactKind::ContestEnded,
            None,
            Some(ControlFactDetail::ContestEnd(ContestEndReason::Pickup)),
        ),
        fact(20.0, ControlFactKind::ControlEstablished, Some(TeamId::Away), None),
    ];
    let m3 = model::derive_match(13, &dm3);
    assert_eq!(m3.contests[0].regained_by_loser, Some(true));
    assert_eq!(m3.contests[0].duration, Some(0.0), "同 tick 收束是实测可达形状");

    // **对称反例（审阅补，防空转）**：争抢以死球收束时，之后另一段进攻的 `control_established`
    // 不得被当成这次争抢的拾回方——必须留 None，而不是向前读到一个无关球队。
    let mut dm4 = empty_dm(vec![]);
    dm4.control_facts = vec![
        fact(
            30.0,
            ControlFactKind::ContestStarted,
            Some(TeamId::Home),
            Some(ControlFactDetail::ContestStart(ContestStartReason::ShotRebound)),
        ),
        fact(
            33.0,
            ControlFactKind::ContestEnded,
            None,
            Some(ControlFactDetail::ContestEnd(ContestEndReason::DeadBall)),
        ),
        fact(
            34.0,
            ControlFactKind::DeadBallStarted,
            Some(TeamId::Away),
            Some(ControlFactDetail::DeadBall(DeadBallReason::OutGoalLine)),
        ),
        // 很久之后另一段进攻的控制——**不属于本次争抢**。
        fact(200.0, ControlFactKind::ControlEstablished, Some(TeamId::Away), None),
    ];
    let m4 = model::derive_match(14, &dm4);
    assert_eq!(
        m4.contests[0].pickup_team, None,
        "死球收束的争抢不得向前读到 200 s 后另一次进攻的 control_established"
    );
    assert_eq!(m4.contests[0].regained_by_loser, None);
    assert_eq!(
        m4.contests[0].end_reason,
        Some("dead_ball"),
        "收束原因照旧可读；只有拾回方为 None"
    );
}

/// 重开 → 首次明确控制：取 `taken_t` 之后**最早**的 episode。
#[test]
fn restart_first_control_uses_the_next_episode() {
    let mut dm = empty_dm(vec![ev(100.0, EventType::Pass, 5, Some("success"), Some("throw_in"))]);
    dm.restart_sequences.push(RestartSequence {
        id: 3,
        team: TeamRef::Home,
        kind: RestartKind::ThrowIn,
        start_t: ObservedTime::state_commit(98.0),
        taken_t: Some(ObservedTime::state_commit(100.0)),
        open_play_resumed_t: Some(ObservedTime::state_commit(101.0)),
        event_indexes: vec![0],
        end_reason: Some(RestartEndReason::OpenPlayResumed),
    });
    // 一个**早于**发出的 episode（属于上一个球权）+ 一个发出后的（重开交付控制）。
    dm.possession_episodes.push(episode_fixture(
        0,
        TeamId::Away,
        50.0,
        97.0,
        EpisodeStartReason::Pickup,
        EpisodeEndReason::Out,
        vec![],
    ));
    dm.possession_episodes.push(episode_fixture(
        1,
        TeamId::Home,
        101.0,
        140.0,
        EpisodeStartReason::RestartControl,
        EpisodeEndReason::ControlLost,
        vec![0],
    ));
    let m = model::derive_match(21, &dm);
    let r = &m.restarts[0];
    assert_eq!(r.first_episode, Some(1), "必须取发出之后最早的 episode");
    assert_eq!(r.first_control_delay, Some(1.0));
    assert_eq!(r.prep_duration, Some(2.0));
    assert_eq!(r.flight_duration, Some(1.0));

    // 反例：发出之后没有 episode（流截断）→ 留 None，不猜。
    let mut dm2 = empty_dm(vec![]);
    dm2.restart_sequences.push(RestartSequence {
        id: 4,
        team: TeamRef::Away,
        kind: RestartKind::GoalKick,
        start_t: ObservedTime::state_commit(5300.0),
        taken_t: Some(ObservedTime::state_commit(5301.0)),
        open_play_resumed_t: None,
        event_indexes: vec![],
        end_reason: Some(RestartEndReason::TerminatedByWhistle),
    });
    let m2 = model::derive_match(22, &dm2);
    assert_eq!(m2.restarts[0].first_episode, None);
    assert_eq!(m2.restarts[0].first_control_delay, None);
}

/// 四个具名 motif 的判定与**反例**（反例比正例重要：它证明判据不是恒真）。
#[test]
fn named_motif_matchers_hold_on_constructed_chains() {
    use model::ActionKind::*;

    // pickup → pass → lost 正例
    let pos = ep_rec(
        "pickup",
        Some("control_lost"),
        0.0,
        Some(30.0),
        vec![act(0, 0.0, PassSuccess, false), act(1, 11.0, PassIntercepted, false)],
    );
    assert!(motifs::matches_pickup_pass_lost(&pos));
    // 反例：两次成功传球后丢（不是"传一次就丢"）
    let two_ok = ep_rec(
        "pickup",
        Some("control_lost"),
        0.0,
        Some(30.0),
        vec![
            act(0, 0.0, PassSuccess, false),
            act(1, 11.0, PassSuccess, false),
            act(2, 22.0, PassLost, false),
        ],
    );
    assert!(!motifs::matches_pickup_pass_lost(&two_ok));
    // 反例：没有失败传球
    let no_fail = ep_rec(
        "pickup",
        Some("out"),
        0.0,
        Some(30.0),
        vec![act(0, 0.0, PassSuccess, false)],
    );
    assert!(!motifs::matches_pickup_pass_lost(&no_fail));
    // 反例：失败传球在成功传球之前（不是"接球后传一次再丢"）
    let bad_first = ep_rec(
        "pickup",
        Some("control_lost"),
        0.0,
        Some(30.0),
        vec![act(0, 0.0, PassIntercepted, false), act(1, 11.0, PassSuccess, false)],
    );
    assert!(!motifs::matches_pickup_pass_lost(&bad_first));
    // 反例：开始原因不是 pickup
    let bukan_pickup = ep_rec(
        "restart_control",
        Some("control_lost"),
        0.0,
        Some(30.0),
        vec![act(0, 0.0, PassSuccess, false), act(1, 11.0, PassLost, false)],
    );
    assert!(!motifs::matches_pickup_pass_lost(&bukan_pickup));
    // 边界（2026-09-24 审阅定死）：1 次成功传球之后**连续两次**失败传球仍算命中——
    // 文档曾写"恰有一次失败传球"而实现取 `bad >= 1`，两者必须一致（此处钉住 `>= 1` 这一边）。
    let two_fail = ep_rec(
        "pickup",
        Some("control_lost"),
        0.0,
        Some(30.0),
        vec![
            act(0, 0.0, PassSuccess, false),
            act(1, 11.0, PassIntercepted, false),
            act(2, 13.0, PassLost, false),
        ],
    );
    assert_eq!(two_fail.pass_success_count(), 1);
    assert!(
        motifs::matches_pickup_pass_lost(&two_fail),
        "恰 1 次成功传球 + ≥1 次失败传球（且首次失败在其后）应命中"
    );
    // 边界反例：1 次成功传球 + 失败传球**先于**成功传球 → 不命中（"传一次再丢"的反面）。
    let fail_before = ep_rec(
        "pickup",
        Some("control_lost"),
        0.0,
        Some(30.0),
        vec![
            act(0, 0.0, PassLost, false),
            act(1, 11.0, PassIntercepted, false),
            act(2, 22.0, PassSuccess, false),
        ],
    );
    assert!(!motifs::matches_pickup_pass_lost(&fail_before));

    // restart → receive → immediate loss：通路 ①（首个开放动作即失败传球）
    let r1 = ep_rec(
        "restart_control",
        Some("control_lost"),
        0.0,
        Some(9.0),
        vec![
            act(0, 0.0, PassSuccess, true),
            act(1, 1.0, PassIntercepted, false),
        ],
    );
    assert!(motifs::matches_restart_immediate_loss(&r1));
    // 通路 ②（交付后没有任何开放动作就丢了）
    let r2 = ep_rec(
        "restart_control",
        Some("control_lost"),
        0.0,
        Some(2.0),
        vec![act(0, 0.0, PassSuccess, true)],
    );
    assert!(motifs::matches_restart_immediate_loss(&r2));
    // 反例：开放动作成功、且结束远晚于交付
    let r3 = ep_rec(
        "restart_control",
        Some("control_lost"),
        0.0,
        Some(40.0),
        vec![
            act(0, 0.0, PassSuccess, true),
            act(1, 3.0, PassSuccess, false),
            act(2, 14.0, PassLost, false),
        ],
    );
    assert!(!motifs::matches_restart_immediate_loss(&r3));
    // 反例：开始原因不是 restart_control
    assert!(!motifs::matches_restart_immediate_loss(&pos));
    // **边界（通路 ② 的时长分支）**：交付之后没有任何开放动作、以 `control_lost` 结束——
    // 无论 episode 持续多久都算命中。口径说明：通路 ② 不是"交付后 ≤3 s 内丢失"，
    // 而是"交付后**没出球就丢**"；`IMMEDIATE_LOSS_SECONDS` 那个窗口只用于**已经有开放动作
    // 之后**才丢的情形（通路 ③，见下面 delay 一例）。此处刻意用 60 s 的长 episode 钉住这点：
    // 若有人把 3 s 窗口错误地套到通路 ② 上，本断言会红。
    let delivery_only_long = ep_rec(
        "restart_control",
        Some("control_lost"),
        0.0,
        Some(60.0),
        vec![act(0, 0.0, PassSuccess, true)],
    );
    assert!(
        motifs::matches_restart_immediate_loss(&delivery_only_long),
        "交付-only（无任何开放动作）以 control_lost 收场时，通路 ② 不设时长上限"
    );
    // 反向边界：交付-only 但 episode 没闭合（end_reason 缺失）→ 不命中（无从判定"丢失"）。
    let delivery_only_unclosed = ep_rec(
        "restart_control",
        None,
        0.0,
        None,
        vec![act(0, 0.0, PassSuccess, true)],
    );
    assert!(!motifs::matches_restart_immediate_loss(&delivery_only_unclosed));
    // 通路 ③ 的时长窗口：有开放动作且成功、但交付后 > 3 s 才 control_lost → 不命中。
    let delayed = ep_rec(
        "restart_control",
        Some("control_lost"),
        0.0,
        Some(20.0),
        vec![
            act(0, 0.0, PassSuccess, true),
            act(1, 4.0, PassSuccess, false),
        ],
    );
    assert!(
        !motifs::matches_restart_immediate_loss(&delayed),
        "有开放动作之后才丢球时，交付后 > IMLOSS 窗口（{} s）不算立即丢失",
        motifs::IMMEDIATE_LOSS_SECONDS
    );

    // control → pass* → shot：链长口径
    let shot_chain = ep_rec(
        "pickup",
        Some("goal"),
        0.0,
        Some(40.0),
        vec![
            act(0, 0.0, PassSuccess, false),
            act(1, 11.0, PassSuccess, false),
            act(2, 22.0, PassIntercepted, false),
            act(3, 24.0, ShotGoal, false),
        ],
    );
    assert_eq!(motifs::successful_passes_before_shot(&shot_chain), Some(2));
    assert_eq!(shot_chain.first_shot_index, Some(3));
    assert!(motifs::is_shot_ending(&shot_chain));
    let no_shot = ep_rec("pickup", Some("out"), 0.0, Some(20.0), vec![act(0, 0.0, PassOut, false)]);
    assert_eq!(motifs::successful_passes_before_shot(&no_shot), None);
    assert!(!motifs::is_shot_ending(&no_shot));

    // tackle → loose → 原队拾回
    let mut c = model::ContestRecord {
        start_t: 0.0,
        end_t: Some(3.0),
        duration: Some(3.0),
        reason: "tackle_loose",
        end_reason: Some("pickup"),
        losing_team: Some(TeamId::Home),
        pickup_team: Some(TeamId::Home),
        regained_by_loser: Some(true),
        location: Some((0.5, 0.5)),
        source_event_index: Some(1),
        next_episode: Some(0),
    };
    assert!(motifs::matches_tackle_regain(&c));
    c.regained_by_loser = Some(false);
    c.pickup_team = Some(TeamId::Away);
    assert!(!motifs::matches_tackle_regain(&c));
    c.reason = "interception_loose";
    c.regained_by_loser = Some(true);
    c.pickup_team = Some(TeamId::Home);
    assert!(!motifs::matches_tackle_regain(&c), "非抢断来源不算本 motif");
}

// ============================== 2. 口径纪律 ==============================

/// **每场先算，再跨场聚合**：`mean_of_means` 必须等于"逐场均值的平均"，而不是池化均值。
///
/// 两场数据刻意取不同规模（4 个 1 vs 1 个 10）：池化均值 = 14/5 = 2.8，逐场均值再平均 = 5.5。
/// 若实现退回池化，本断言必红——这正是 P38 那条"别跨场池化"纪律的机器守卫。
#[test]
fn statistics_are_per_match_then_cross_match() {
    let per_match: Vec<Vec<f64>> = vec![vec![1.0, 1.0, 1.0, 1.0], vec![10.0]];
    let s = model::Stat::from_observations(&per_match);
    assert_eq!(s.matches, 2);
    assert_eq!(s.observations, 5);
    assert!(
        (s.mean_of_means - 5.5).abs() < 1e-12,
        "逐场均值再平均应为 5.5（池化会得到 2.8），实际 {}",
        s.mean_of_means
    );
    assert!(
        (s.p50_of_p50 - 5.5).abs() < 1e-12,
        "P50 也是逐场分位再平均：场A P50=1、场B P50=10 → 5.5；实际 {}",
        s.p50_of_p50
    );
    assert_eq!(s.max_of_max, 10.0);
    // 场间 sd 是"逐场均值之间的**样本** sd（n-1 分母）"，不是场内方差、也不是总体 sd。
    // 逐场均值 = [1, 10] → 均值 5.5、偏差平方和 40.5、样本方差 40.5 → sd = sqrt(40.5)。
    let expect_sd = 40.5f64.sqrt();
    assert!(
        (s.cross_match_mean_sd - expect_sd).abs() < 1e-9,
        "场间 sd 口径错误：期望 {}（n-1 分母），实际 {}",
        expect_sd,
        s.cross_match_mean_sd
    );

    // 空输入不得产出 -inf / NaN（那会序列化成 null，被读成"观测到无穷大"）。
    let empty = model::Stat::from_observations(&[]);
    assert_eq!(empty.matches, 0);
    assert!(empty.max_of_max.is_finite() && empty.mean_of_means.is_finite());

    // 分位实现（R type-7）：[1,2,3,4] 的 P50 = 2.5、P90 = 3.7。
    let q = model::quantile(&[1.0, 2.0, 3.0, 4.0], 0.5);
    assert!((q - 2.5).abs() < 1e-12);
    let q90 = model::quantile(&[1.0, 2.0, 3.0, 4.0], 0.9);
    assert!((q90 - 3.7).abs() < 1e-12, "P90 应为 3.7，实际 {}", q90);
}

/// sidecar schema 指纹：对同一次运行稳定、对不同闭集内容敏感，且**枚举清单完整**。
///
/// 判别力（目标变异必红）：
/// - 删掉 `sidecar_schema_fingerprint` 里任意一条 `add!(..)`（例如 `Phase`）→ 本测试红
///   （下方断言了全部 17 个枚举都在，且与各自的 `ALL.len()` 一致）；
/// - 把返回值换成常数（或让某个枚举的成员串名不进哈希）→ 红：本测试**用 `ALL` 独立重建**
///   期望指纹并与实现比对。「独立重建」是关键——只断言实现自己算了两遍相等，常数也能通过。
#[test]
fn sidecar_schema_fingerprint_is_stable_and_content_sensitive() {
    let (a, sizes) = model::sidecar_schema_fingerprint();
    let (b, sizes2) = model::sidecar_schema_fingerprint();
    assert_eq!(a, b, "同一二进制内两次求值必须一致");
    assert!(a.starts_with("fnv1a64:"));
    assert_eq!(sizes, sizes2);

    // 清单：**逐个**枚举列出它自己 `ALL` 里的成员串名（不是只列个数）。
    let expect: Vec<(&str, Vec<&'static str>)> = vec![
        ("TeamId", TeamId::ALL.iter().map(|x| x.as_str()).collect()),
        ("TeamRef", TeamRef::ALL.iter().map(|x| x.as_str()).collect()),
        ("TimeBasis", TimeBasis::ALL.iter().map(|x| x.as_str()).collect()),
        ("ControlFactKind", ControlFactKind::ALL.iter().map(|x| x.as_str()).collect()),
        ("ControlFactBasis", ControlFactBasis::ALL.iter().map(|x| x.as_str()).collect()),
        ("ObservationGapReason", ObservationGapReason::ALL.iter().map(|x| x.as_str()).collect()),
        ("IllegalInput", IllegalInput::ALL.iter().map(|x| x.as_str()).collect()),
        ("RestartKind", RestartKind::ALL.iter().map(|x| x.as_str()).collect()),
        ("DeadBallReason", DeadBallReason::ALL.iter().map(|x| x.as_str()).collect()),
        ("FlightAction", FlightAction::ALL.iter().map(|x| x.as_str()).collect()),
        ("RestartEndReason", RestartEndReason::ALL.iter().map(|x| x.as_str()).collect()),
        ("EpisodeStartReason", EpisodeStartReason::ALL.iter().map(|x| x.as_str()).collect()),
        ("EpisodeEndReason", EpisodeEndReason::ALL.iter().map(|x| x.as_str()).collect()),
        ("ContestStartReason", ContestStartReason::ALL.iter().map(|x| x.as_str()).collect()),
        ("ContestEndReason", ContestEndReason::ALL.iter().map(|x| x.as_str()).collect()),
        ("Phase", Phase::ALL.iter().map(|x| x.as_str()).collect()),
        ("PhaseProvenance", PhaseProvenance::ALL.iter().map(|x| x.as_str()).collect()),
    ];
    assert_eq!(sizes.len(), expect.len(), "闭集枚举条数变化：{:?}", sizes);
    let mut parts: Vec<String> = Vec::new();
    for (name, members) in &expect {
        let got = sizes
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| *v)
            .unwrap_or_else(|| panic!("指纹漏了闭集 `{}`（闭集清单不完整）", name));
        assert!(got > 0, "`{}` 的成员数为 0（ALL 未列全）", name);
        assert_eq!(got, members.len(), "`{}` 成员数与 ALL 不一致", name);
        // 与实现同一配方（`name|m1|m2..`，按行排序后 fnv1a）——但输入来自**这里的** `ALL` 枚举。
        let mut line = String::from(*name);
        for m in members {
            line.push('|');
            line.push_str(m);
        }
        parts.push(line);
    }
    parts.sort();
    let expected = format!("fnv1a64:{:016x}", model::fnv1a(&parts.join("\n")));
    assert_eq!(
        a, expected,
        "指纹与「用 ALL 独立重建」的结果不一致 → 有枚举的成员串名没有进入被哈希的文本（或返回值是常数）"
    );

    // 判别力自证：成员串名真的影响哈希（不是只把名字拼进 parts 就完事——配方本身必须对增删敏感）。
    assert_ne!(model::fnv1a("a|b"), model::fnv1a("a|c"));
    assert_ne!(model::fnv1a("ab"), model::fnv1a("ba"));
    // 指纹对「新增一个成员」敏感——用两个只差一个成员名的输入直接验证。
    assert_ne!(
        model::fnv1a("ControlFactKind|match_started|control_established"),
        model::fnv1a("ControlFactKind|match_started|control_established|control_released"),
        "指纹必须对闭集成员增删敏感"
    );
}

/// **基线/canary seed 集口径必须被钉住**（spec「默认基线与 canary 两种模式」）：
/// canary ⊆ baseline，且两者都固定 90 分钟。若有人改动区间（例如 canary 变 1..=31 而 baseline
/// 不变），canary 上的观察就不再保证能在 baseline 里复现，前后对比失效——故在默认路径断言。
#[test]
fn baseline_and_canary_seed_ranges_are_pinned_and_nested() {
    assert_eq!(BASELINE_SEEDS, (1, 300));
    assert_eq!(CANARY_SEEDS, (1, 30));
    assert_eq!(
        DUR, 5400.0,
        "两种模式都必须是 90 分钟，否则跨模式比较口径不同"
    );
    assert!(
        CANARY_SEEDS.0 >= BASELINE_SEEDS.0 && CANARY_SEEDS.1 <= BASELINE_SEEDS.1,
        "canary {:?} 必须是 baseline {:?} 的子集（前缀）",
        CANARY_SEEDS,
        BASELINE_SEEDS
    );
}

/// **闭集 0 计数必须显式出现**（spec「条件分布按开始原因分解」）：
/// `successful_receive` / `unknown` 等在生产路径上不可达的成员，报告里必须是 0 而不是缺行——
/// 否则"某成员消失了"与"该成员本来就是 0"在产物上无法区分。
#[test]
fn zero_count_closed_set_members_are_present_not_omitted() {
    let per_match = derive_seeds(1, 2);
    let ps = metrics::possession_shape(&per_match);
    for r in EpisodeStartReason::ALL {
        assert!(
            ps.start_reason_counts.contains_key(r.as_str()),
            "start_reason `{}` 缺行（0 计数必须显式出现）",
            r.as_str()
        );
    }
    for r in EpisodeEndReason::ALL {
        assert!(
            ps.end_reason_counts.contains_key(r.as_str()),
            "end_reason `{}` 缺行",
            r.as_str()
        );
    }
    // 交叉验证：`successful_receive` 在生产路径不可达（`observation.rs` 已文档化），
    // 因此这里必须恰好是 0 —— 若哪天它非 0，说明接线变了，本断言提醒更新文档。
    assert_eq!(
        ps.start_reason_counts.get("successful_receive"),
        Some(&0),
        "`successful_receive` 的注释声明它在生产路径不可达；若此处非 0，需更新 observation.rs 的说明"
    );
    assert_eq!(ps.start_reason_counts.get("unknown"), Some(&0));
}

/// 异常规则在样本不足时**降级而不是静默**：空输入下每条规则都必须是 `insufficient_sample`。
#[test]
fn anomaly_rules_degrade_when_sample_is_insufficient() {
    let per_match: Vec<MatchRecord> = vec![empty_match(1)];
    let possession = metrics::possession_shape(&per_match);
    let transitions = metrics::control_transitions(&per_match);
    let restarts = metrics::restart_quality(&per_match);
    let motif_report = motifs::mine(&per_match);
    let got = anomalies::evaluate(&Ctx {
        per_match: &per_match,
        possession: &possession,
        transitions: &transitions,
        restarts: &restarts,
        motifs: &motif_report,
    });
    assert_eq!(got.len(), 10, "规则条数变化时请同步更新本断言与 design §3.7");
    for a in &got {
        assert_eq!(
            a.status,
            anomalies::Status::InsufficientSample,
            "{} 在零样本下必须降级，而不是判异常或消失",
            a.id
        );
        assert!(
            a.sample_size < a.min_sample_size,
            "{} 的样本量声明与实际不符",
            a.id
        );
    }
}

// ============================== 3. 真实路径：确定性 + 防空转 ==============================

/// **产物同源守卫**（2026-09-24 二审事故的回归）：落盘的两个产物必须由**同一份源码 + 同一分析器**
/// 产出，即除 `mode`/`seed_range` 外 provenance 逐字段相同。
///
/// 为什么需要（真实事故）：二审实测发现 `canary.json` 曾被一次**临时改过引擎源码**的运行覆盖，
/// 而它的 `source_commit` / `analyzer_version` / `schema_fingerprint` 与干净的 `baseline.json`
/// **完全一致**——产物层无法察觉两文件不可比。故：
/// ① 新增 `engine_source_fingerprint`（哈希编译进二进制的 `lib.rs`+`observation.rs` 文本），
/// 使"工作树脏但 commit 未变"也能被识别；
/// ② 本测试在落盘后直接比对两份产物的 provenance（除 mode/seed 区间外的全部字段），
/// 把"必须同源重跑"从一句约定变成会变红的断言。
///
/// 注：本测试要求**两个产物都已存在**（即先跑过两个 `#[ignore]` 运行器）。缺失时跳过并给出指引，
/// 而不是失败——CI 的默认路径不跑 300 场。
#[test]
fn on_disk_artifacts_share_one_provenance_block() {
    let dir = out_dir();
    let (bp, cp) = (dir.join("baseline.json"), dir.join("canary.json"));
    if !bp.exists() || !cp.exists() {
        eprintln!(
            "跳过：{}/{} 尚不存在。先分别运行 `p17a_baseline` 与 `p17a_canary`（见文件头注释）。",
            bp.display(),
            cp.display()
        );
        return;
    }
    let read = |p: &std::path::Path| -> serde_free_provenance::Prov {
        serde_free_provenance::parse(&std::fs::read_to_string(p).expect("读产物失败"))
    };
    let b = read(&bp);
    let c = read(&cp);
    // 允许不同的只有 mode 与 seed 区间；其余（含两个指纹与 commit）必须一致。
    assert_eq!(b.source_commit, c.source_commit, "两产物来自不同 commit");
    assert_eq!(
        b.analyzer_version, c.analyzer_version,
        "两产物来自不同 analyzer 版本——请同源重跑两个模式"
    );
    assert_eq!(
        b.engine_source_fingerprint, c.engine_source_fingerprint,
        "两产物的**引擎源码指纹**不同 → 其中一个是在引擎源码被改动（工作树脏）时跑出来的。\
         这种不可比性 `source_commit` 看不出来，必须同源重跑。"
    );
    assert_eq!(
        b.sidecar_schema_fingerprint, c.sidecar_schema_fingerprint,
        "两产物的 sidecar schema 指纹不同"
    );
    assert_eq!(b.model_version, c.model_version);
    assert!(b.engine_source_fingerprint.starts_with("fnv1a64:"));
}

/// 极简 provenance 抽取（只为上面那条同源门服务，避免为测试引入 JSON 依赖）。
mod serde_free_provenance {
    #[derive(Debug, Default)]
    pub struct Prov {
        pub source_commit: String,
        pub analyzer_version: String,
        pub engine_source_fingerprint: String,
        pub sidecar_schema_fingerprint: String,
        pub model_version: String,
    }

    /// 从 JSON 文本里抽取 `provenance` 下的若干字符串/数字字段。
    ///
    /// 实现故意"笨"：`provenance` 块是产物里第一个出现的对象，且这些键名在全文只出现一次
    /// （`metrics` / `anomalies` 里没有同名键）。用 `find` 而不是递归解析——本门只关心相等性，
    /// 不需要通用 JSON 能力；若哪天键名重复，`assert_eq` 会因取错而失败，不会静默通过。
    pub fn parse(text: &str) -> Prov {
        let mut p = Prov::default();
        for (key, slot) in [
            ("\"source_commit\"", 0usize),
            ("\"analyzer_version\"", 1),
            ("\"engine_source_fingerprint\"", 2),
            ("\"sidecar_schema_fingerprint\"", 3),
            ("\"model_version\"", 4),
        ] {
            let val = extract(text, key);
            match slot {
                0 => p.source_commit = val,
                1 => p.analyzer_version = val,
                2 => p.engine_source_fingerprint = val,
                3 => p.sidecar_schema_fingerprint = val,
                _ => p.model_version = val,
            }
        }
        p
    }

    fn extract(text: &str, key: &str) -> String {
        let at = text
            .find(key)
            .unwrap_or_else(|| panic!("产物里找不到 `{}`", key));
        let rest = &text[at + key.len()..];
        let rest = rest.trim_start().trim_start_matches(':').trim_start();
        if let Some(s) = rest.strip_prefix('"') {
            s[..s.find('"').expect("字符串未闭合")].to_string()
        } else {
            rest.chars()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect()
        }
    }
}

/// **池化守卫**：所有 by-kind / by-reason 的 `Stat` 必须按「每场一个观测向量」分组。
///
/// 判别法：`matches` 必须等于参与的比赛数（此处 6），**不得**等于观测数。
/// 若实现退回「每条观测 push 一个单元素向量」，`matches` 会等于观测数（例如 restart 的
/// `prep_seconds_by_kind` 变成 3405 而不是 6），P50/P90 随即退化成均值、
/// `cross_match_mean_sd` 变成混入场间差异的膨胀值——正是设计 §3.1 禁止的池化。
///
/// 判别力（目标变异必红）：把 `stat_by_match_and_key` 换成逐条 `push(vec![v])` → 本测试红。
/// 实测该变异曾真实发生（by-kind 表 `matches == observations`），本测试即为它的回归守卫。
#[test]
fn by_kind_stats_group_per_match_not_per_observation() {
    let per_match = derive_seeds(1, 6);
    let n = per_match.len();
    let ps = metrics::possession_shape(&per_match);
    let t = metrics::control_transitions(&per_match);
    let q = metrics::restart_quality(&per_match);

    let mut checked = 0usize;
    let mut check = |label: &str, s: &model::Stat| {
        assert!(
            s.observations > 0,
            "{} 没有观测，断言接近空转",
            label
        );
        // 真正的判别式：逐场聚合下"参与的比赛数"不可能超过 seed 数。
        // `matches` **可以**小于 n（某场没有该键的观测，例如 `control_change` 只出现在部分场次），
        // 也可以等于 `observations`（例如 kickoff 每场恰好 1 次）——这两种都合法，不能拿来判红。
        // 但 `matches > n` 只可能来自"每条观测各算一场"，即池化：实测该缺陷下
        // `prep_seconds_by_kind/goal_kick` 的 matches 是 3405（观测数）而不是 ≤ n。
        assert!(
            s.matches <= n,
            "{}：matches={} > seed 数 {}（观测数 {}）→ 逐条观测各算一场 = 池化，不是逐场聚合",
            label, s.matches, n, s.observations
        );
        checked += 1;
    };
    for (k, s) in &q.prep_seconds_by_kind {
        check(&format!("prep_seconds_by_kind/{}", k), s);
    }
    for (k, s) in &q.flight_seconds_by_kind {
        check(&format!("flight_seconds_by_kind/{}", k), s);
    }
    for (k, s) in &q.first_control_delay_by_kind {
        check(&format!("first_control_delay_by_kind/{}", k), s);
    }
    for (k, s) in &q.first_possession_duration_by_kind {
        check(&format!("first_possession_duration_by_kind/{}", k), s);
    }
    for (k, s) in &q.first_possession_actions_by_kind {
        check(&format!("first_possession_actions_by_kind/{}", k), s);
    }
    for (k, s) in &t.duration_by_reason {
        check(&format!("duration_by_reason/{}", k), s);
    }
    for (k, s) in &ps.duration_by_start_reason {
        check(&format!("duration_by_start_reason/{}", k), s);
    }
    assert!(checked >= 15, "只检查了 {} 张表，覆盖不足", checked);

    // 反向证据：**同一个原因**的争抢时长在各场里取值不同，因此逐场 P50 不应等于全局均值。
    // `delivery_loose` 在 300 场实测里同时含 0 s（角球/解围/门球落点）与 3 s（落点争抢）两族，
    // 逐场分布与全局混合分布必然不同——用它证明"逐场再聚合"真的发生了。
    let dl = &t.duration_by_reason["delivery_loose"];
    let pooled = t.duration_value_counts.get("0.000").cloned().unwrap_or(0) as f64
        / t.duration_value_counts.values().sum::<usize>() as f64;
    assert!(
        dl.matches == n && dl.observations > dl.matches,
        "delivery_loose 每场应有多个观测（matches {} / obs {}）",
        dl.matches,
        dl.observations
    );
    assert!(
        pooled > 0.0 && pooled < 1.0,
        "pooled 0s 占比 {} 应在 (0,1) 内，否则反向证据空转",
        pooled
    );
}

/// 同 seed 集 + 同 config 两次运行，JSON 输出**逐字节**相同（design §5 确定性要求）。
#[test]
fn identical_inputs_produce_byte_identical_output() {
    let first = derive_seeds(1, 3);
    let second = derive_seeds(1, 3);
    let r1 = build_report("det", 1, 3, DUR, &first);
    let r2 = build_report("det", 1, 3, DUR, &second);
    let j1 = report::to_json(&r1);
    let j2 = report::to_json(&r2);
    assert_eq!(j1, j2, "同输入两次运行的 JSON 必须逐字节相同");
    assert_eq!(
        report::to_markdown(&r1),
        report::to_markdown(&r2),
        "Markdown 同理"
    );
    // 产物里不得有承载"本次运行时刻"的字段（那会破坏逐字节可比性）。
    // 注意：不能按子串 `now` 判——`source_commit` 的缺省值 `unknown` 合法地含 `now`。
    for forbidden in ["generated_at", "timestamp", "run_date", "collected_at"] {
        assert!(
            !j1.contains(forbidden),
            "产物不得写入时间戳字段 `{}`",
            forbidden
        );
    }
    // 逐场派生本身也必须确定。
    let a: Vec<u64> = first.iter().map(|m| m.seed).collect();
    let b: Vec<u64> = second.iter().map(|m| m.seed).collect();
    assert_eq!(a, b);
    assert_eq!(
        first[0].episodes.len(),
        second[0].episodes.len(),
        "同 seed 的 episode 数必须一致"
    );
}

/// **已知冗余的守卫**：`first_control_delay`（重开→首次明确控制）与 `flight_duration`
/// （发出→恢复开放）在本引擎上恒等——重开的首个 episode 恰好在 `open_play_resumed` 时刻开启。
///
/// 为什么要钉住这件事：报告的 M3 有两张表，读者会自然地当成两个独立证据。若将来重开接管
/// 接线变化（例如首次控制在航班结束**之后**才提交），两列不再相等，本测试变红，报告里的
/// 冗余提示就必须同步改口径——避免留下一条"看起来是第二次观测"的假证据。
///
/// 反证（防空转）：先断言样本量足够，否则"两列相等"在空样本上恒真。
#[test]
fn first_control_delay_equals_delivery_flight_on_real_path() {
    // 15 场：角球是最稀疏的方式（canary 实测 2/场），15 场 ≈ 30 个，足以越过 15 的下限。
    let per_match = derive_seeds(1, 15);
    let q = metrics::restart_quality(&per_match);
    let mut compared = 0usize;
    for (kind, flight) in &q.flight_seconds_by_kind {
        let Some(delay) = q.first_control_delay_by_kind.get(kind) else {
            continue;
        };
        assert!(
            flight.observations >= 15 && delay.observations >= 15,
            "{}：样本过少（flight {} / delay {}），本条断言接近空转",
            kind,
            flight.observations,
            delay.observations
        );
        assert_eq!(
            flight.observations, delay.observations,
            "{}：两列观测数应一致",
            kind
        );
        assert!(
            (flight.mean_of_means - delay.mean_of_means).abs() < 1e-9,
            "{}：交付飞行 ({}) 与重开→首次控制 ({}) 不再相等 → 必须更新报告里的冗余提示",
            kind,
            flight.mean_of_means,
            delay.mean_of_means
        );
        compared += 1;
    }
    assert!(compared >= 3, "只有 {} 种重开方式参与比对，覆盖不足", compared);
}

/// 防空转：真实路径上关键分母必须达到下限，否则本文件的所有聚合断言都在空转。
///
/// 下限按 recon 实测（canary 实测 30 场：2604 episode / 1456 restart / 1530 contest /
/// 13867 动作）取保守值。
#[test]
fn aggregates_are_not_vacuous_on_real_seeds() {
    let per_match = derive_seeds(1, 6);
    let s = metrics::sample_totals(&per_match);
    assert_eq!(s.matches, 6);
    assert!(s.episodes >= 300, "episode 样本过少：{}", s.episodes);
    assert!(s.restarts >= 120, "restart 样本过少：{}", s.restarts);
    assert!(s.contests >= 150, "contest 样本过少：{}", s.contests);
    assert!(s.actions >= 1500, "决策动作样本过少：{}", s.actions);
    assert!(s.beats > s.actions * 5, "beat 应远多于决策动作：{} vs {}", s.beats, s.actions);
    assert_eq!(s.gaps, 0, "canary seed 段内不应有 observation_gap");
    assert_eq!(s.invariant_violations, 0, "sidecar 不变量必须为空");
    assert_eq!(s.unclosed_episodes, 0, "episode 必须全部闭合");

    // 口径交叉检查：episode 的动作数必须**不**等于 beat 数（证明动作口径真的排除了 beat）。
    let r = build_report("vac", 1, 6, DUR, &per_match);
    assert!(
        r.possession_shape.action_count.mean_of_means < 10.0,
        "episode 动作数应在个位数（若含 beat 会飙到 60+），实际 {}",
        r.possession_shape.action_count.mean_of_means
    );
    assert!(
        r.possession_shape.beat_bindings_per_episode.mean_of_means
            < r.possession_shape.action_count.mean_of_means,
        "beat 绑定数不应超过动作数（否则口径写反了）"
    );
    // 每条异常规则都必须真的拿到了样本（否则 5–10 条的清单会变成空清单）。
    let with_samples = r.anomalies.iter().filter(|a| a.sample_size > 0).count();
    assert_eq!(with_samples, r.anomalies.len(), "有规则完全没拿到样本");
}

// ====================== 4. 异常规则口径（2026-09-24 审阅修复的回归守卫） ======================

/// **A7 的报数必须与报告表同口径**（审阅 finding 1 的回归守卫）。
///
/// 事故形态：A7 原先自己算**池化** `model::mean(vals)` 写进 `criterion`，而报告 M3 的表来自
/// `prep_seconds_by_kind`（逐场先算再跨场平均）。两个数在 baseline 上分别是 kickoff 3.58 s 与
/// 2.58 s——同一个 kind 在一份产物里出现两个值，读者无法判断哪个是判据。
///
/// 判别设计：构造一个 kind，使池化值与逐场值**明显不同**——
/// 场 1 有 60 次准备期 0 s、场 2 有 240 次准备期 10 s；
/// 池化 = (0×60 + 10×240)/300 = **8.0 s**，逐场再平均 = (0 + 10)/2 = **5.0 s**。
/// 断言 criterion 里必须是 5.0 s，且**不得**出现 8.0 s。
///
/// 判别力（目标变异必红）：把报数改回 `crate::model::mean(vals)` → `criterion` 出现
/// `free_kick=8.0s`，第一条断言红。
#[test]
fn a7_reports_the_per_match_statistic_not_the_pooled_mean() {
    let split = |seed: u64, n: usize, prep: f64| {
        let restarts = (0..n)
            .map(|i| restart_rec(i as u64, "free_kick", Some(prep)))
            .collect();
        match_with(seed, Vec::new(), restarts)
    };
    let per_match = vec![split(1, 60, 0.0), split(2, 240, 10.0)];

    // 反证（防空转）：两口径必须真的不同，否则本测试没有区分度。
    let q = metrics::restart_quality(&per_match);
    let stat = &q.prep_seconds_by_kind["free_kick"];
    let pooled = (0.0 * 60.0 + 10.0 * 240.0) / 300.0;
    assert_eq!(stat.observations, 300);
    assert_eq!(stat.matches, 2);
    assert!(
        (stat.mean_of_means - 5.0).abs() < 1e-9,
        "逐场口径应为 (0+10)/2 = 5.0，实际 {}",
        stat.mean_of_means
    );
    assert!(
        (pooled - stat.mean_of_means).abs() > 2.0,
        "两口径差异不足（池化 {} vs 逐场 {}），测试失去区分度",
        pooled,
        stat.mean_of_means
    );

    let rules = evaluate_all(&per_match);
    let a7 = rule(&rules, "A7");
    assert!(
        a7.criterion.contains("free_kick=5.0s"),
        "A7 报数必须取自 restarts.prep_seconds_by_kind（逐场 5.0 s）。实际 criterion：{}",
        a7.criterion
    );
    assert!(
        !a7.criterion.contains("8.0s"),
        "A7 不得把池化均值（8.0 s）写进判据——同一产物里同一 kind 只能有一个数。实际：{}",
        a7.criterion
    );
    // 零方差判定同步走逐场 Stat 路径：free_kick 跨场取值 {0, 10} → 不是常数通道。
    assert!(
        !a7.title.contains("free_kick"),
        "free_kick 不是零方差通道，不应出现在 title：{}",
        a7.title
    );
}

/// A7 的 `title` / `evidence` 必须**由指标插值**且**覆盖对照通道**（审阅 finding 3 + 证据配额）。
///
/// 两件事一起钉：
/// ① title 不得写死（旧形态是静态字符串"任意球恒定 1 s、门球根本没有准备期"，canary 与 baseline
///    共用一句话，一旦数字不同就自相矛盾）；
/// ② evidence 不得被"先到先得"的 6 条额度填满早期 seed 的任意球，而把角球（本引擎唯一有真实
///    准备期的方式）挤掉——`why_not_football` 正是拿角球作对照。
///
/// 判别力：title 改回静态字符串 → ① 红；evidence 改回单一 6 条先到先得 → ② 红。
#[test]
fn a7_title_is_interpolated_and_evidence_covers_the_control_channel() {
    let kind = |seed: u64, k: &'static str, n: usize, prep: f64| {
        let restarts = (0..n)
            .map(|i| restart_rec(i as u64, k, Some(prep)))
            .collect();
        match_with(seed, Vec::new(), restarts)
    };
    // 两个零方差通道（→ 判异常）+ 一个有真实准备期的对照通道（free_kick，均值最大）。
    let per_match = vec![
        {
            let mut m = kind(1, "goal_kick", 200, 0.0);
            m.restarts.extend(kind(1, "throw_in", 200, 7.0).restarts);
            m.restarts.extend(kind(1, "free_kick", 200, 4.0).restarts);
            m
        },
        {
            let mut m = kind(2, "goal_kick", 200, 0.0);
            m.restarts.extend(kind(2, "throw_in", 200, 7.0).restarts);
            m.restarts.extend(kind(2, "free_kick", 200, 6.0).restarts);
            m
        },
    ];

    let rules = evaluate_all(&per_match);
    let a7 = rule(&rules, "A7");
    assert_eq!(
        a7.status,
        anomalies::Status::Anomaly,
        "2 条零方差通道应判异常"
    );
    assert_eq!(a7.value, 2.0);
    assert!(
        a7.title.contains("goal_kick=0.0s(n 400)") && a7.title.contains("throw_in=7.0s(n 400)"),
        "title 必须由零方差通道插值（含取值与样本量）。实际：{}",
        a7.title
    );
    assert!(
        a7.evidence
            .iter()
            .any(|e| e.note.contains("free_kick") && e.note.contains("对照")),
        "证据必须包含对照通道（free_kick，有真实准备期），否则机制解释里的对照无法回放。实际证据：{:?}",
        a7.evidence.iter().map(|e| e.note.clone()).collect::<Vec<_>>()
    );
    assert!(
        a7.evidence.len() <= 3 * 3,
        "证据数应受每通道上限约束，实际 {}",
        a7.evidence.len()
    );
}

/// **A5 的证据必须取自统计量自己的母体**（审阅 finding 2 的回归守卫）。
///
/// 统计量 `pre_shot_successful_passes` 的分母是「动作链里含 shot 的 episode」
/// （`first_shot_index.is_some()`）；旧实现用 `is_shot_ending`
/// （`end_reason ∈ {goal, saved_caught, shot_rebound}`）选样本。300 场实测两者是 2760 vs 572，
/// 差 4.8 倍：射门后以 `out`/`foul` 收场、以及被扑出后由对手控制的 episode 全被排除——
/// 而它们恰恰是"射门没进"的主要形态。
///
/// 判别设计：构造 2 个含射门的 episode，其中 1 个**不属于** `is_shot_ending`。
/// 断言 `sample_size == 2`（母体口径）且证据里出现那个非 shot_ending 的样本。
///
/// 判别力：证据选择改回 `motifs::is_shot_ending(ep)` → 那个样本消失，第二条断言红。
#[test]
fn a5_evidence_comes_from_the_statistic_population() {
    use model::ActionKind::*;
    // 射门但以 out 收场：含射门 → 属于统计量母体；不是 shot_ending → 旧证据口径会漏掉。
    let shot_then_out = ep_rec(
        "pickup",
        Some("out"),
        0.0,
        Some(30.0),
        vec![
            act(0, 0.0, PassSuccess, false),
            act(1, 11.0, ShotOffTarget, false),
        ],
    );
    // 对照：真正 is_shot_ending 的 episode（两种口径都覆盖）。
    let saved = ep_rec(
        "pickup",
        Some("saved_caught"),
        5.0,
        Some(40.0),
        vec![
            act(0, 5.0, PassSuccess, false),
            act(1, 16.0, ShotSaved, false),
        ],
    );
    assert!(shot_then_out.first_shot_index.is_some());
    assert!(
        !motifs::is_shot_ending(&shot_then_out),
        "反证：该 episode 不属于旧的证据母体，否则本测试没有区分度"
    );
    assert!(motifs::is_shot_ending(&saved));

    let per_match = vec![match_with(1, vec![shot_then_out, saved], Vec::new())];
    let rules = evaluate_all(&per_match);
    let a5 = rule(&rules, "A5");
    assert_eq!(
        a5.sample_size, 2,
        "A5 分母必须是「动作链里含 shot 的 episode」数（2），不是 is_shot_ending 数（1）"
    );
    assert!(
        a5.evidence.iter().any(|e| e.note.contains("end=out")),
        "证据必须包含含射门但 end_reason=out 的样本（统计量母体成员）。实际：{:?}",
        a5.evidence
            .iter()
            .map(|e| e.note.clone())
            .collect::<Vec<_>>()
    );
    assert!(
        a5.evidence
            .iter()
            .any(|e| e.note.contains("end=saved_caught")),
        "证据也应覆盖 is_shot_ending 的样本"
    );
}

/// **A9 只计开放比赛的成功传球**（审阅 finding 5 的回归守卫）。
///
/// 定位球**交付**是重开片段的第一步，不是开放比赛的推进。旧实现用 `pass_success_count()`
/// （含交付），会把「1 次交付 + 1 次开放传球」记成多脚传递。实测 300 场有 2063 个 episode
/// 属于这种口径差异（比例 65.7% → 57.9%）。
///
/// 判别设计：den = 2，其中 1 个 episode 是「交付 + 1 次开放传球」（旧口径算 ≥2，本条不算），
/// 另 1 个是真正的「2 次开放传球」。正确的 `value` = 1/2 = 0.5；旧口径 = 2/2 = 1.0。
///
/// 判别力：改回 `ep.pass_success_count()` → `value` 变 1.0，第一条断言红。
#[test]
fn multi_pass_share_counts_open_play_passes_only() {
    use model::ActionKind::*;
    let delivery_plus_one = ep_rec(
        "restart_control",
        Some("foul"),
        0.0,
        Some(20.0),
        vec![
            act(0, 0.0, PassSuccess, true),
            act(1, 5.0, PassSuccess, false),
        ],
    );
    let two_open = ep_rec(
        "pickup",
        Some("control_lost"),
        30.0,
        Some(60.0),
        vec![
            act(0, 30.0, PassSuccess, false),
            act(1, 41.0, PassSuccess, false),
        ],
    );
    // 反证：交付那条在两种口径下**不同**，否则没有区分度。
    assert_eq!(delivery_plus_one.pass_success_count(), 2);
    assert_eq!(delivery_plus_one.open_play_pass_success_count(), 1);
    assert_eq!(two_open.pass_success_count(), 2);
    assert_eq!(two_open.open_play_pass_success_count(), 2);

    let per_match = vec![match_with(1, vec![delivery_plus_one, two_open], Vec::new())];
    let rules = evaluate_all(&per_match);
    let a9 = rule(&rules, "A9");
    assert!(
        (a9.value - 0.5).abs() < 1e-12,
        "A9 只应把「2 次开放传球」那条算作多脚传递（1/2 = 0.5）；含交付会得到 1.0。实际 {}",
        a9.value
    );
    assert!(
        a9.criterion.contains("排除定位球交付") && a9.criterion.contains("仅靠交付"),
        "A9 判据必须显式声明口径（排除交付）并报告口径差异数。实际：{}",
        a9.criterion
    );
    assert_eq!(
        a9.sample_size, 2,
        "A9 分母仍是全部已闭合 episode（口径变化不改变分母）"
    );
}

/// **未标定的期望必须被标记**（审阅 finding 8 的回归守卫）。
///
/// 本 change 没有用任何真实比赛数据集，因此 `baseline_expectation` 里的"期望值"是领域假设，
/// 不是实测参照。若有人新加一条规则忘了打标签，本测试红——避免"1–3 s / 20 s"这类数字
/// 被读者当成 measured real-match facts。
#[test]
fn anomaly_expectations_are_tagged_uncalibrated() {
    // 真实路径 + 零样本两条路径都要查（规则文本与样本量无关）。
    let real = derive_seeds(1, 2);
    let empty = vec![empty_match(1)];
    for per_match in [real, empty] {
        let rules = evaluate_all(&per_match);
        assert_eq!(rules.len(), 10, "规则条数变化时请同步本测试与 design §3.7");
        for a in &rules {
            assert!(
                a.baseline_expectation
                    .starts_with(anomalies::UNCALIBRATED_TAG),
                "{} 的 baseline_expectation 未标 `{}`（会被读成实测参照值）：{}",
                a.id,
                anomalies::UNCALIBRATED_TAG,
                a.baseline_expectation
            );
            assert!(
                !a.title.contains("远超真实足球"),
                "{} 的 title 不得把未标定的期望表述成已确认事实：{}",
                a.id,
                a.title
            );
            // 判据必须自述它是**内部诊断阈值**（而不是实测偏差量）。
            assert!(
                a.criterion.contains("判异常"),
                "{} 的 criterion 应显式给出内部诊断阈值：{}",
                a.id,
                a.criterion
            );
        }
    }
}

/// **机制假设不得携带冻结的统计比例**（2026-09-24 第四轮审阅 P1 的回归守卫）。
///
/// 事故形态：`mechanism_hypothesis` 是 `&'static str`，有人把「本 seed 集上实测的占比」写死进去——
/// A1 写「（约占 73%）」、A2 写「`delivery_loose` 的 26.3%」。canary 与 baseline **共用同一句静态文本**，
/// 于是这句话必然与其中一份产物自相矛盾；而这类量本该只在 `criterion` 里由指标插值。
///
/// 判别设计（两条腿，同一缺陷的两种写法都要拦）：
/// ① **冻结字面量**：扫全部规则的 `mechanism_hypothesis` / `why_not_football` 里所有 `N%` / `N.N%`
///    token，只放行 **0% / 100%**（"必然/从不"是语义极端，不是测量值）。其余一律红。这里刻意不扫
///    无 `%` 的数字：源码常量（`BASE_ACTION_DEADLINE_TICKS=7`）与 `file.rs:NNNN` 行号都是合法内容。
/// ② **动态化回归**：若有人把机制文本改成嵌指标的 `format!`（同一缺陷的另一写法），同一条规则在
///    两份**指标明显不同**的输入上会产出不同文本。故对 A1/A2 断言两种输入下机制文本逐字节相同，
///    并先断言两份输入的指标确实不同（否则该断言空转）。
///
/// 判别力：把 A1 的「（约占 73%）」加回 → ①红；把 A1 机制文本改成含 `{:.0}%` 的 `format!` → ②红。
#[test]
fn mechanism_prose_carries_no_frozen_statistical_ratios() {
    /// 扫出文本中**非结构性**的 `N%` token（0%/100% 视为结构性极端，放行）。
    fn frozen_ratio_tokens(text: &str) -> Vec<String> {
        let cs: Vec<char> = text.chars().collect();
        let mut out = Vec::new();
        let mut i = 0usize;
        while i < cs.len() {
            if !cs[i].is_ascii_digit() {
                i += 1;
                continue;
            }
            let start = i;
            let mut j = i;
            while j < cs.len() && (cs[j].is_ascii_digit() || cs[j] == '.') {
                j += 1;
            }
            if j < cs.len() && cs[j] == '%' {
                let token: String = cs[start..j].iter().collect();
                let num: f64 = token.parse().unwrap_or(f64::NAN);
                if num != 0.0 && num != 100.0 {
                    out.push(token);
                }
            }
            i = j;
        }
        out
    }

    // 反证（防空转）：扫描器必须真的抓得住比例 token，且 0%/100% 这一结构性例外必须放行——
    // 否则"真实文本为空"可能只是因为扫描器什么都抓不到。
    assert_eq!(
        frozen_ratio_tokens("假设约占 73% 由 deadline 轮次决定"),
        vec!["73"],
        "扫描器应抓住 `73%`"
    );
    assert_eq!(
        frozen_ratio_tokens("实测 26.3% 归原队"),
        vec!["26.3"],
        "扫描器应抓住小数比例 `26.3%`"
    );
    assert!(
        frozen_ratio_tokens("归属必然 100%，从不 0%").is_empty(),
        "0%/100% 是结构性极端（必然/从不），不属于被禁的统计比例"
    );
    assert!(frozen_ratio_tokens("零方差，无数字").is_empty());

    // 真实路径 + 零样本两条路径都查（机制文本与样本量无关）。
    for per_match in [derive_seeds(1, 2), vec![empty_match(1)]] {
        let rules = evaluate_all(&per_match);
        assert_eq!(rules.len(), 10, "规则条数变化时请同步本测试与 design §3.7");
        for a in &rules {
            for (field, text) in [
                ("mechanism_hypothesis", a.mechanism_hypothesis),
                ("why_not_football", a.why_not_football),
            ] {
                let bad = frozen_ratio_tokens(text);
                assert!(
                    bad.is_empty(),
                    "{} 的 `{}` 携带冻结的统计比例 {:?}：该量随 seed 集变化，canary 与 baseline 共用一句\
                     静态文本必然与其中一份产物矛盾；必须只在 criterion 里由指标插值。文本：{}",
                    a.id,
                    field,
                    bad,
                    text
                );
            }
        }
    }

    // 腿 ②：机制文本必须在**指标明显不同**的输入上保持不变（防「改成 format! 嵌指标」这种写法）。
    let real = derive_seeds(1, 2);
    let mut synthetic = empty_match(1);
    synthetic.episodes.push(ep_rec(
        "pickup",
        Some("control_lost"),
        0.0,
        Some(60.0),
        vec![
            act(0, 0.0, model::ActionKind::PassSuccess, false),
            act(1, 30.0, model::ActionKind::PassSuccess, false),
        ],
    ));
    // 争抢时长全部取 3 s（无 0 s 档）→ A2 的"同 tick 拾回占比"为 0。
    for i in 0..200u64 {
        synthetic.contests.push(model::ContestRecord {
            start_t: i as f64,
            end_t: Some(i as f64 + 3.0),
            duration: Some(3.0),
            reason: "pass_lost",
            end_reason: Some("pickup"),
            losing_team: Some(TeamId::Away),
            pickup_team: Some(TeamId::Home),
            regained_by_loser: Some(true),
            location: Some((0.5, 0.5)),
            source_event_index: Some(i as usize),
            next_episode: None,
        });
    }
    let synthetic = vec![synthetic];
    let (ra, rb) = (evaluate_all(&real), evaluate_all(&synthetic));
    for id in ["A1", "A2"] {
        let (a, b) = (rule(&ra, id), rule(&rb, id));
        // 反证（防空转）：两份输入的指标必须真的不同，否则"文本相同"是恒真断言。
        assert!(
            (a.value - b.value).abs() > 1e-9,
            "{} 在两份输入上的 value 相同（{} vs {}）→ 腿 ② 失去区分度",
            id,
            a.value,
            b.value
        );
        assert_eq!(
            a.mechanism_hypothesis, b.mechanism_hypothesis,
            "{} 的 mechanism_hypothesis 随指标变化 → 它把运行时数值写进了机制文本",
            id
        );
        assert_eq!(a.why_not_football, b.why_not_football, "{} 的 why_not_football 同理", id);
    }
}

/// **Markdown 产物必须显式声明"没有用真实比赛数据集"**（审阅 finding 3 的产物级守卫）。
///
/// 只看代码不够：结论页才是读者会读的东西。断言 §6 标题是"异常候选"、§7 局限里有数据缺口声明。
#[test]
fn markdown_states_the_missing_real_match_dataset() {
    let per_match = derive_seeds(1, 3);
    let r = build_report("md", 1, 3, DUR, &per_match);
    let md = report::to_markdown(&r);
    assert!(
        md.contains("本轮没有使用任何真实比赛数据集"),
        "§7 必须显式声明没有真实比赛数据集"
    );
    assert!(md.contains("[未标定]"), "§7 必须解释 `[未标定]` 标签的含义");
    assert!(
        md.contains("## 6. 异常候选"),
        "异常清单必须标为「候选」（待 #15B/#16 与真实数据确认），而不是已确认异常"
    );
    assert!(
        md.contains("内部诊断阈值"),
        "§7 必须区分「内部诊断阈值」与真实足球参照值"
    );
    // 阈值示例必须是**由常量插值**的当前值（守卫防止有人手写死数字而与常量漂移）。
    assert!(
        md.contains(&format!(
            "相邻动作间隔 > {:.1}s",
            anomalies::DWELL_ANOMALY_SECONDS
        )),
        "§7 的阈值示例应由 `DWELL_ANOMALY_SECONDS` 插值（当前 {}）",
        anomalies::DWELL_ANOMALY_SECONDS
    );
    assert!(
        md.contains(&format!(
            "多脚传递占比 < {:.2}",
            anomalies::MULTI_PASS_SHARE_MIN
        )),
        "§7 的阈值示例应由 `MULTI_PASS_SHARE_MIN` 插值（当前 {}）",
        anomalies::MULTI_PASS_SHARE_MIN
    );
    // 写死数值的守卫：角球准备期的旧硬编码值不得出现在任何产物里。
    assert!(
        !md.contains("15.25"),
        "产物不得包含写死的角球准备期数值（应由指标插值）"
    );
    // §7 说明"异常 = 待验证假设"，与 §6 标题语义一致。
    assert!(
        md.contains("待验证的假设"),
        "§7 必须明确「异常」在本报告中是待验证的假设"
    );
}

/// **引擎源码指纹必须覆盖全部影响仿真的源码**（审阅 finding 6 的回归守卫）。
///
/// 旧实现只哈希 `lib.rs` + `observation.rs`，漏了 `rng.rs`——`SeededRng` 决定每一次随机分支，
/// 只改它时产物层看不出两产物不可比。
///
/// 判别设计（对**文件系统**断言，不是对实现自己的清单断言）：
/// ① 列出 `engine/src/*.rs`，除平台垫片 `wasm.rs`（`#[cfg(target_arch = "wasm32")]`，不进本测试的
///    编译单元）外，每个文件都必须在 `report::ENGINE_SOURCES` 里——将来新增仿真源文件而忘了纳入
///    指纹时本测试会红；
/// ② **独立重建**：本测试**自己从磁盘读** `ENGINE_SOURCES` 列出的每个文件、自己拼哈希输入，
///    期望指纹必须等于实现返回的指纹。这一步是关键——只把实现的清单再拼一遍、断言实现的两遍结果
///    相等，常数返回也能通过；从磁盘独立重建才能钉住「每个文件的内容真的进了哈希」。
/// ③ 逐个文件做内容变异（追加一行注释）后重新独立重建，指纹必须**每次都变**——证明该文件的
///    **磁盘内容**（尤其 `rng.rs`）真的参与哈希输入。
#[test]
fn engine_source_fingerprint_covers_all_simulation_sources() {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut on_disk: Vec<String> = std::fs::read_dir(&src)
        .expect("读 engine/src 失败")
        .filter_map(|e| {
            let name = e.ok()?.file_name().to_string_lossy().to_string();
            name.ends_with(".rs").then_some(name)
        })
        .collect();
    on_disk.sort();
    assert!(
        on_disk.iter().any(|n| n == "rng.rs"),
        "engine/src/rng.rs 不存在？仿真源文件清单已变，请复核本测试"
    );

    // ① 覆盖性：`wasm.rs` 是唯一允许缺席的平台垫片（wasm32-only，不进本测试的编译单元）。
    let platform_shim = "wasm.rs";
    let covered: Vec<&str> = report::ENGINE_SOURCES.iter().map(|(n, _)| *n).collect();
    for f in &on_disk {
        if f == platform_shim {
            continue;
        }
        assert!(
            covered.contains(&f.as_str()),
            "`engine/src/{}` 影响仿真却不在 engine_source_fingerprint 的覆盖清单里 → \
             改它时两产物会静默不可比。清单当前：{:?}",
            f,
            covered
        );
    }
    assert!(
        covered.contains(&"rng.rs"),
        "指纹必须覆盖 rng.rs（SeededRng 决定随机分支）"
    );

    // ② **独立重建**：本测试自己从磁盘读文件、自己拼哈希输入（与 report 的 include_str! 配方同源，
    // 但输入来自文件系统而非实现的常量）。若实现返回常数、或某个文件没进哈希，这一步就红。
    let read = |name: &str| {
        std::fs::read_to_string(src.join(name))
            .unwrap_or_else(|e| panic!("读 `engine/src/{}` 失败：{}", name, e))
    };
    let rebuild = |probe: Option<&str>| -> String {
        let mut combined = String::new();
        for (name, _) in report::ENGINE_SOURCES {
            combined.push_str(name);
            combined.push('\n');
            combined.push_str(&read(name));
            combined.push('\n');
            if probe == Some(*name) {
                // 内容变异：只改这一个文件的文本。
                combined.push_str("// fingerprint probe\n");
            }
        }
        format!("fnv1a64:{:016x}", model::fnv1a(&combined))
    };

    let base = report::engine_source_fingerprint();
    assert!(base.starts_with("fnv1a64:"));
    let from_disk = rebuild(None);
    assert_eq!(
        base, from_disk,
        "实现指纹与「从磁盘独立重建」不一致 → 有文件的内容没有真正进入哈希输入（或返回值是常数）。\
         清单：{:?}",
        covered
    );

    // ③ 内容敏感性：逐个文件变异（追加一行注释）后重新独立重建，指纹必须变。
    //    `rng.rs`（`SeededRng` 决定每次随机分支）是审阅点名的盲区，这里对每个文件一视同仁。
    for (name, _) in report::ENGINE_SOURCES {
        let mutated = rebuild(Some(name));
        assert_ne!(
            base, mutated,
            "改动 `engine/src/{}` 后指纹不变 → 该文件的磁盘内容没有真正进入哈希输入",
            name
        );
    }
    // 同一次运行内稳定（重算一遍，含从磁盘重读）。
    assert_eq!(
        base,
        report::engine_source_fingerprint(),
        "同一次运行内必须稳定"
    );
}
