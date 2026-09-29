//! P16（#116）：团队与局部空间特征 + phaseability gate。
//!
//! 本 change **只读公开 API**（`simulate_with_behavior_observations` + `observation` 模块公开类型），
//! **不改任何生成逻辑**：跑位/决策、RNG、正式事件流、golden 全不受影响。守卫是
//! `tests/p15_behavior_observation.rs` 的逐字节一致门仍然全绿（本文件不触碰 `engine/src/`）。
//!
//! 分层（对齐 `CLAUDE.md` 的分层验证表）：
//!
//! | 本文件的测试 | 判据层 | 默认跑? |
//! |---|---|---|
//! | [`caliber_start_comes_from_control_fact_not_action_position`] | 口径（起点来源） | ✅ |
//! | [`caliber_guard_has_discriminating_power`] | 口径（**守卫的判别力**，含反证条） | ✅ |
//! | [`caliber_end_is_same_source_and_never_borrows_the_start`] | 口径（起止同源 / 不猜） | ✅ |
//! | [`caliber_never_reads_across_episode_boundaries`] | 口径（不跨 episode 边界） | ✅ |
//! | [`progress_normalizes_direction_per_team`] | 口径（方向归一） | ✅ |
//! | [`goal_kick_amplifier_matches_the_pinned_share`] | 口径（放大器记录） | ✅ |
//! | [`caliber_closing_fact_tie_break_names_the_episode_closing_fact`] | 口径（同刻取法的审计纪律） | ✅ |
//! | [`caliber_coverage_on_a_real_seed`] | 覆盖率（真实路径下限） | ✅ |
//! | [`state_snapshots_are_per_tick_and_bit_identical`] | 位置快照（拍 = tick / 排空拍不记） | ✅ |
//! | [`state_snapshot_positions_match_the_beat_projection_bit_for_bit`] | 位置快照（**逐位恒等**的独立交叉核对） | ✅ |
//! | [`state_snapshot_frozen_marks_active_highlight_only`] | 位置快照（`frozen` 语义） | ✅ |
//! | [`formal_path_produces_no_snapshots_and_is_byte_identical`] | 位置快照（正式路径逐字节一致 + 空操作契约） | ✅ |
//! | [`quantile_matches_the_r_type7_convention_exactly`] | 静态队形（分位口径精确值） | ✅ |
//! | [`team_shape_excludes_keeper_and_uses_quantile_span`] | 静态队形（剔门将 / q10–q90） | ✅ |
//! | [`spread_pairs_unsorted_coordinates`] | 静态队形（配对口径，历史坑） | ✅ |
//! | [`engine_shape_coverage_is_total_and_missing_reasons_stay_empty`] | 静态队形（空操作记录） | ✅ |
//! | [`rust_shape_is_in_the_same_regime_as_the_js_ruler`] | 静态队形（与 JS 标尺同量级哨兵） | ✅ |
//! | [`displacement_decomposition_normalizes_direction_and_splits_axes`] | 时间关系（方向归一 + 轴分解） | ✅ |
//! | [`line_spacing_slope_is_least_squares_not_endpoint_difference`] | 时间关系（斜率估计量） | ✅ |
//! | [`support_uses_ball_position_and_only_counts_players_ahead`] | 时间关系（接应：球位 + 前方） | ✅ |
//! | [`time_relationship_feature_coverage_on_a_real_seed`] | 时间关系（覆盖率 + 缺失分类） | ✅ |
//! | [`all_feature_times_use_a_single_basis`] | 时间关系（时间基准不混用） | ✅ |
//! | [`motifs_do_not_use_position`] | gate（**参考集不得用位置**，头号纪律） | ✅ |
//! | [`reference_sets_are_sized_and_documented`] | gate（参考集规模 + 重叠） | ✅ |
//! | [`phaseability_separability_is_measured`] | gate（可分性实测） | ✅ |
//! | [`phaseability_verdict_is_partial_and_the_evidence_is_duration_controlled`] | gate（**裁决：部分够**） | ✅ |
//! | [`reference_set_source_references_no_position_quantity`] | gate（循环性防护：**源码扫描**） | ✅ |
//! | [`reference_predicate_semantics_are_pinned`] | gate（谓词语义被钉住） | ✅ |
//! | [`identical_inputs_produce_byte_identical_output`] | 产物（确定性） | ✅ |
//! | [`provenance_carries_the_comparability_triple`] | 产物（provenance 三件套） | ✅ |
//! | [`p16_does_not_change_the_p17a_schema_fingerprint`] | 产物（不使 P17A 指纹陈旧） | ✅ |
//! | [`provenance_caliber_snapshot_lists_the_live_constants`] | 产物（口径快照活性） | ✅ |
//! | [`on_disk_artifacts_share_the_current_source_fingerprint`] | 产物（与源码同源） | ✅ |
//! | `p16_canary` | 产物落盘（30 seed） | ❌ `#[ignore]` |
//! | `p16_baseline` | 产物落盘（300 seed） | ❌ `#[ignore]` |
//!
//! **产物落盘测试（`p16_canary` / `p16_baseline`）尚未建**——属 Slice 5，随特征与裁决一并落地。
//! 届时按 P17A 的形态加 `#[ignore]` 门与 JSON/Markdown 产物。
//!
//! 跑法：
//!
//! ```text
//! cargo test --test p16_spatial_features
//! ```
//!
//! **行号引用会漂**：本文件的注释与文档一律用**符号名**（函数名 / 结构体名 / 常量名），
//! 不写 `lib.rs:NNNN`。

#[path = "p16/caliber.rs"]
mod caliber;
#[path = "p16/shape.rs"]
mod shape;
#[path = "p16/features.rs"]
mod features;
#[path = "p16/gate.rs"]
mod gate;
#[path = "p16/reference.rs"]
mod reference;
#[path = "p16/report.rs"]
mod report;

use caliber::*;
use features::*;
use gate::*;
use reference::*;
use report::*;
use shape::*;
use fm_engine::observation::*;
use fm_engine::{simulate_with_behavior_observations, EventType, MatchConfig};

// ============================== 运行器 ==============================

const DUR: f64 = 5400.0;
/// 默认快速门用的 seed 数（覆盖 90 分钟整场，含各种收束路径）。
const QUICK_SEEDS: (u64, u64) = (1, 10);

fn cfg() -> MatchConfig {
    MatchConfig {
        match_duration_seconds: DUR,
        demo_mode: false,
        model_version: fm_engine::MODEL_VERSION,
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

fn coverage_over(first: u64, last: u64) -> CaliberCoverage {
    let mut cov = CaliberCoverage::default();
    for seed in first..=last {
        cov.observe_match(&observe(seed));
    }
    cov
}

// ============================== fixture 构造 ==============================
//
// 手工 fixture 的字段取值**照真实路径观测到的形状**构造（见本 change 的 recon 实测）：
// 起点事实恒为 `control_established`、`basis ∈ {engine_state, finalized_outcome}`、
// 收束侧事实上实际有**四类**（`control_released` / `contest_started` /
// `control_established` / `open_play_resumed`，实测 100 seed）——
// 其中 `control_released` 常是「从 Controlled 进争抢」时的族首，见
// `caliber_closing_fact_tie_break_names_the_episode_closing_fact`。
// **不构造生产不可达的取值**——否则断言会变成恒真（P15/P36/P17A 的教训）。

fn ev(t: f64, ty: EventType, subject: i32, result: Option<&str>, detail: Option<&str>) -> fm_engine::Event {
    fm_engine::Event {
        t,
        type_: ty,
        subject,
        x: 0.5,
        y: 0.5,
        result: result.map(|s| s.to_string()),
        detail: detail.map(|s| s.to_string()),
        ..fm_engine::Event::default()
    }
}

fn fact(
    t: f64,
    kind: ControlFactKind,
    team: Option<TeamId>,
    location: Option<(f64, f64)>,
    basis: ControlFactBasis,
    detail: Option<ControlFactDetail>,
) -> ControlFact {
    ControlFact {
        t: ObservedTime::state_commit(t),
        kind,
        team,
        player: None,
        location,
        source_event_index: None,
        basis,
        detail,
    }
}

/// 一个 episode 事实族：起点 `control_established`(0.2,0.5) + 中途控制 + 收束侧事实。
struct Fixture {
    facts: Vec<ControlFact>,
    episodes: Vec<PossessionEpisode>,
    events: Vec<fm_engine::Event>,
}

/// 构造「起点 + 中途 + 可选收束」的 episode 事实族。
///
/// `start_loc`：起点事实位置。`mid`：中途 `control_established` 位置列表。
/// `closing`：收束侧事实（kind, location）；`None` 表示该死球路径**没有**带位置的收束事实。
fn fixture(start_loc: (f64, f64), mid: &[(f64, f64)], closing: Option<(ControlFactKind, (f64, f64))>) -> Fixture {
    let mut facts = vec![fact(
        0.0,
        ControlFactKind::MatchStarted,
        Some(TeamId::Home),
        None,
        ControlFactBasis::EngineState,
        None,
    )];
    // 首开球：restart_taken 与 control_established 同刻（真实路径如此，见 match_started 专线）
    facts.push(fact(
        0.0,
        ControlFactKind::ControlEstablished,
        Some(TeamId::Home),
        Some(start_loc),
        ControlFactBasis::EngineState,
        None,
    ));
    let mut idxs = vec![1usize];
    for (i, p) in mid.iter().enumerate() {
        idxs.push(facts.len());
        facts.push(fact(
            10.0 * (i as f64 + 1.0),
            ControlFactKind::ControlEstablished,
            Some(TeamId::Home),
            Some(*p),
            ControlFactBasis::FinalizedOutcome,
            None,
        ));
    }
    match closing {
        Some((kind, loc)) => {
            let t = 10.0 * (mid.len() as f64 + 1.0);
            facts.push(fact(
                t,
                kind,
                Some(TeamId::Home),
                Some(loc),
                ControlFactBasis::FinalizedOutcome,
                match kind {
                    ControlFactKind::ContestStarted => Some(ControlFactDetail::ContestStart(
                        ContestStartReason::PassLost,
                    )),
                    _ => None,
                },
            ));
        }
        None => {
            // 死球收束：dead_ball_started **不带位置**（真实路径如此）
            facts.push(fact(
                10.0 * (mid.len() as f64 + 1.0),
                ControlFactKind::DeadBallStarted,
                None,
                None,
                ControlFactBasis::FinalizedOutcome,
                Some(ControlFactDetail::DeadBall(DeadBallReason::OutSideline)),
            ));
        }
    }
    let end_t = facts.last().unwrap().t;
    // 起点的**对照口径**输入：episode 内首个决策动作。位置刻意取 0.5（与起点 0.2 **不同带**）
    // ——守卫要能区分「读事实位置」与「读动作位置」两种实现。事件下标 0 是 lineup，
    // 故决策动作落在下标 1（真实路径同形：`event_indexes` 里的下标指向 `dm.events`）。
    let events = vec![
        fm_engine::Event {
            t: 0.0,
            type_: EventType::Lineup,
            subject: 0,
            ..Default::default()
        },
        ev(30.0, EventType::Pass, 5, Some("success"), None),
    ];
    let episodes = vec![PossessionEpisode {
        id: 0,
        team: TeamId::Home,
        start_t: ObservedTime::state_commit(0.0),
        end_t: Some(end_t),
        start_reason: EpisodeStartReason::Kickoff,
        end_reason: Some(match closing {
            Some((ControlFactKind::ContestStarted, _)) => EpisodeEndReason::ControlLost,
            _ => EpisodeEndReason::Out,
        }),
        control_fact_indexes: idxs,
        event_indexes: vec![1],
    }];
    Fixture {
        facts,
        episodes,
        events,
    }
}

impl Fixture {
    fn dm(self) -> DiagnosticMatch {
        DiagnosticMatch {
            events: self.events,
            control_facts: self.facts,
            possession_episodes: self.episodes,
            state_snapshots: vec![],
            restart_sequences: vec![],
            phase_segments: vec![],
            state: BehaviorControlState::Ended,
            invariant_violations: vec![],
        }
    }

    /// 追加第二个 episode（起点事实位置 `loc`、时刻 `t`），返回其首条事实下标。
    fn push_episode(&mut self, id: u64, t: f64, loc: (f64, f64)) -> usize {
        self.facts.push(fact(
            t,
            ControlFactKind::ControlEstablished,
            Some(TeamId::Home),
            Some(loc),
            ControlFactBasis::FinalizedOutcome,
            None,
        ));
        let first = self.facts.len() - 1;
        self.episodes.push(PossessionEpisode {
            id,
            team: TeamId::Home,
            start_t: ObservedTime::state_commit(t),
            end_t: Some(ObservedTime::state_commit(t)),
            start_reason: EpisodeStartReason::SuccessfulReceive,
            end_reason: Some(EpisodeEndReason::ControlLost),
            control_fact_indexes: vec![first],
            event_indexes: vec![],
        });
        first
    }
}

// ============================== 定向变异证据（Slice 2，2026-09-29 实跑） ==============================
//
// 本仓的教训是「守卫可能是恒真断言」。Slice 2 的每条承诺都有定向变异，**实跑均红**：
//
// | 变异 | 改法 | 抓它的测试 |
// |---|---|---|
// | 采样点挪到出拍点 | 只在对 `t` 有 beat 时 `observe_state` | `state_snapshots_are_per_tick_and_bit_identical`（条数断言） |
// | 位置量化到 0.1 m | `observe_state` 里 round 到 1/1050 | `state_snapshot_positions_match_the_beat_projection_bit_for_bit` |
// | 终场排空拍也记 | 在排空循环里也 `observe_state` | `state_snapshots_are_per_tick_and_bit_identical`（**须用 seed 2**） |
// | `depth` 用 max−min | `quantile_span` → 首尾差 | `rust_shape_is_in_the_same_regime_as_the_js_ruler` + `team_shape_excludes_keeper_and_uses_quantile_span` |
// | 不剔门将 | 删 `KEEPER_IDS` 过滤 | `team_shape_excludes_keeper_and_uses_quantile_span` + `spread_pairs_unsorted_coordinates` |
// | `spread` 用排序 x 配未排序 y | 先 sort 再配对 | `spread_pairs_unsorted_coordinates`（**含反证条**） |
// | 位移不乘 `dir` | `along = dx_m` | `displacement_decomposition_normalizes_direction_and_splits_axes` |
// | 斜率用末减首 | `slope()` 换成端点差 | `line_spacing_slope_is_least_squares_not_endpoint_difference` |
// | 接应去掉「球前方」 | 删 `along < SUPPORT_MIN_FORWARD_M` | `support_uses_ball_position_and_only_counts_players_ahead` |
// | 接应参考点用重心 | `bx/by` 取 `team_shape.cx/cy` | 同上 |
// | 参考集塞位置量 | `reference_set` 里读 `caliber_of(..).start_progress` | `reference_set_source_references_no_position_quantity` |
// | `final_third` 用「含 shot」 | `ends_shot` → `has_shot` | `reference_predicate_semantics_are_pinned` |
//
// ⚠️ **两条 gate 守卫的第一版都是「假覆盖」**（2026-09-29 实测，本 change 第二次踩这个坑）：
// - 循环性防护初版只做**事件位置**的行为核对（改 `Event.x/y` 后断言参考集不变）；
//   往 `reference_set` 里塞读 **`ControlFact.location`** 的谓词后，**27 条全绿**。
//   ⇒ 改为**源码扫描**（`include_str!` + 逐 token 核），复验变红。
// - 没有任何测试钉住「**以** shot 结尾」与「**含** shot」的差别 ⇒ 后者也全绿。
//   ⇒ 新增 `reference_predicate_semantics_are_pinned`（逐 episode 断言归属语义），复验变红。
//
// **教训**：`reference_set` 这种事关「论证是否循环」的谓词，**行为核对守不住**——
// 因为它读的量不在被测行为的输入面上。必须扫源码。
//
// ⚠️ 两条**fixture 判别力**的教训（都是初版踩到、修复后复验）：
// - 「排空拍」变异在 **seed 1 上无区分度**（seed 1 整场不进排空循环）⇒ 该测试**必须用 seed 2**
//   （实测 60 seed 里有 8 个会进排空循环：2/22/24/32/36/40/46/53）。
// - 「spread 配对」变异在初版 fixture 上**存活**（x 与 y 同序 ⇒ 排序是空操作）⇒
//   fixture 改为 x 下标序 ≠ 大小序，并**加了一条反证条**证明两种配对不同值。

// ============================== 位置快照（G1 的核心承诺） ==============================

/// **快照 = `st.pos` 逐位恒等**——G1（引擎导出位置）相对「从 beat 重放」的**唯一**正当理由。
///
/// 三层守卫：
/// 1. **条数**：快照数 == 主 tick 循环的 tick 数（**不是** beat 数——犯规/开球等拍不产 beat）；
/// 2. **逐位恒等**：每拍位置与引擎真值**逐位相同**（无舍入/量化）；
/// 3. **时间轴**：快照的 `t` 与 beat 的 `t` 在同一时间轴上、且严格递增。
///
/// **判别力**（对着实现想「怎么改才会让本测试红」）：
/// - 采样点挪到 `emit_beat_with_main` 之后 → **条数**断言红（漏拍，§2.4 实测）；
/// - 把终场排空拍也记进来 → **条数**断言红（多出同时间戳的拍）。
///
/// ⚠️ **本测试**不**抓有损编码**（`f32`/量化）——它只查条数/值域/时间轴。
/// 「逐位恒等」由 `state_snapshot_positions_match_the_beat_projection_bit_for_bit` 守
/// （实测：量化到 0.1 m 时本测试仍绿、那条红）。
#[test]
fn state_snapshots_are_per_tick_and_bit_identical() {
    // ⚠️ **用 seed 2**，不是 seed 1：seed 1 整场**不进**终场排空循环，故「排空拍也记」
    // 这个变异在它身上无区分度（实测：排空拍变体在 seed 1 上全套仍绿）。
    // seed 2 实测会进排空循环（`)` t=dur 上仍有悬空高亮被 finalize「--- 见下 ②」）。
    let dm = observe(2);
    // ① 条数 == tick 数。tick = 主循环 `while t < dur`，t 取 1.0, 2.0, ..., dur-TICK。
    //    与 beat 数**不等**（实测 seed 1：5399 tick / 5365 beat）——本断言正是要抓这一点。
    // 主循环逐字：`let mut t = TICK_SECONDS; while t < dur { tick(..); t += TICK_SECONDS; }`
    // ⇒ 迭代的 t = TICK, 2·TICK, …, < dur。**t=0 不在其中**（首个 tick 从 TICK 起）。
    // 故条数 = ⌈dur/TICK⌉ − 1；dur=5400、TICK=1 时为 **5399**（实测一致）。
    let expected_ticks = (DUR / fm_engine::TICK_SECONDS).ceil() as usize - 1;
    assert_eq!(
        dm.state_snapshots.len(),
        expected_ticks,
        "快照数必须 == 主 tick 循环的 tick 数（{expected_ticks}）——\
         注意它 **不等于** beat 数（{}）。差集说明采样点挪错了位置（挪到出拍点会漏掉\
         犯规/开球这类不产 beat 的 tick）。",
        dm.events.iter().filter(|e| e.type_ == EventType::Beat).count()
    );

    // ② 值域：22 人齐全、位置有限且在 [0,1]。
    for (i, snap) in dm.state_snapshots.iter().enumerate() {
        assert_eq!(
            snap.pos.len(),
            22,
            "第 {i} 拍的快照必须有 22 人（引擎侧恒 22 人；`includeExtrapolated` / \
             `MIN_OUTFIELD_PLAYERS` 在引擎侧是**空操作**，不得写成「会掉帧」的理由）"
        );
        for (id, (x, y)) in snap.pos.iter().enumerate() {
            assert!(
                x.is_finite() && y.is_finite() && (0.0..=1.0).contains(x) && (0.0..=1.0).contains(y),
                "第 {i} 拍 id={id} 的位置 ({x},{y}) 越界或非有限——位置必须是归一化 [0,1]"
            );
        }
    }

    // ③ 时间轴：与 beat 同轴、严格递增、起点为 1.0（tick 从 1 开始）。
    for w in dm.state_snapshots.windows(2) {
        assert!(
            w[1].t.value > w[0].t.value,
            "快照时间必须严格递增（{} → {}）——出现相等/倒退说明把排空拍也记进来了",
            w[0].t.value,
            w[1].t.value
        );
    }
    assert_eq!(dm.state_snapshots[0].t.value, fm_engine::TICK_SECONDS);
    assert_eq!(
        dm.state_snapshots[0].t.basis,
        TimeBasis::StateCommit,
        "快照的 TimeBasis 必须是 StateCommit（引擎提交后的状态，不是事件发射时刻）"
    );
    // beat 的时间戳必须在快照时间轴上——**唯一例外是终场排空期**（`t == dur` 上的拍，
    // 比赛已结束、且会被尾哨压缩按时间戳去重丢弃，本方案刻意不记，见 §2.4）。
    // seed 2 实测正会进排空循环（60 seed 里有 8 个），故这条断言在 seed 2 上有判别力。
    let snap_ts: std::collections::BTreeSet<u64> =
        dm.state_snapshots.iter().map(|s| s.t.value.to_bits()).collect();
    let dur_bits = DUR.to_bits();
    for e in dm.events.iter().filter(|e| e.type_ == EventType::Beat) {
        let t_bits = e.t.to_bits();
        assert!(
            snap_ts.contains(&t_bits) || t_bits == dur_bits,
            "t={} 的 beat 不在快照时间轴上，且不是终场排空拍（t==dur）——两者不同轴",
            e.t
        );
    }
    // 反向：排空拍**必须不被记录**（否则「排空拍也记」这个变异会溜过）。
    assert!(
        !snap_ts.contains(&dur_bits),
        "快照里出现了 t=dur 的拍——终场排空期不属于比赛时间，不应记录（§2.4）"
    );
}

/// **逐位恒等的独立交叉核对**：快照位置 == 同一 tick 的 beat 事件字段。
///
/// 为什么需要它：上面那条测试只查值域（有限、在 [0,1]）——**有损编码（`f32`、量化到
/// 0.1m）照样通过**（已实测：把 `observe_state` 里的位置量化到 0.1 m 后，那条断言**仍绿**）。
/// 而 G1 的立身之本恰恰是「快照 = `st.pos` **逐位**」。
///
/// **判据**（独立于 `StateSnapshot` 自身）：同一 tick 的 beat 字段就是 `st.pos` 的投影——
/// `commit_beat_positions_ex` 分离后把终态回填到 `mover.to_x/to_y`，
/// `sync_main_after_commit` 再把 `main.x2/y2` 与 `st.pos[carrier]` 对齐。
/// 故对每个 beat 声明的 (id → 位置)，快照必须**逐位相等**。
/// 任何舍入/量化都会在这里变红（实测：量化到 0.1 m → 本测试红）。
#[test]
fn state_snapshot_positions_match_the_beat_projection_bit_for_bit() {
    let dm = observe(1);
    // tick → 快照
    let by_t: std::collections::BTreeMap<u64, &[(f64, f64); 22]> = dm
        .state_snapshots
        .iter()
        .map(|s| (s.t.value.to_bits(), &s.pos))
        .collect();

    let mut checked = 0usize;
    for e in &dm.events {
        if e.type_ != EventType::Beat {
            continue;
        }
        let Some(snap) = by_t.get(&e.t.to_bits()) else {
            continue;
        };
        let check = |id: i32, x: f64, y: f64| {
            let (sx, sy) = snap[id as usize];
            assert!(
                sx == x && sy == y,
                "t={} id={id}：快照 ({sx:?},{sy:?}) != beat 投影 ({x:?},{y:?})——\
                 两者必须**逐位相等**（beat 字段就是 st.pos 的投影）。不等说明快照被舍入/\
                 量化，或采样时刻与 beat 不同步。",
                e.t
            );
        };
        if let Some(m) = &e.main {
            // main.x2/y2 = carrier 终态（= st.pos[carrier]）
            check(m.subject, m.x2, m.y2);
        }
        if let Some(ms) = &e.movers {
            for m in ms {
                check(m.id, m.to_x, m.to_y);
            }
        }
        checked += 1;
    }
    // 防空转：必须真的比到足够多的 beat（否则「没比到」会被误读成「通过了」）。
    assert!(
        checked > 1000,
        "只比到 {checked} 个 beat——比对覆盖不足，本测试可能空转"
    );
}

/// **快照的`frozen` 语义**：只在有活跃高亮时非空，且参与者 id 合法。
///
/// ⚠️ **不保证 finalize 拍为空**：`finalize_highlight` 可能链式建新高亮
/// （`ShotOffTarget` / 出界 → `start_goal_kick` / `start_corner`），此时记的是**新高亮**参与者。
#[test]
fn state_snapshot_frozen_marks_active_highlight_only() {
    let dm = observe(1);
    let mut nonempty = 0usize;
    for snap in &dm.state_snapshots {
        for id in &snap.frozen {
            assert!(
                (0..22).contains(id),
                "frozen 里的 id={id} 越界（合法 id 0..=21）"
            );
        }
        if !snap.frozen.is_empty() {
            nonempty += 1;
        }
        // frozen 里不得有重复 id（参与者是集合语义）。
        let uniq: std::collections::BTreeSet<i32> = snap.frozen.iter().copied().collect();
        assert_eq!(
            uniq.len(),
            snap.frozen.len(),
            "frozen 出现重复 id（参与者应为集合语义）"
        );
    }
    // 防空转：90 分钟里总有飞行拍，`frozen` 不可能恒空。
    assert!(
        nonempty > 0,
        "全 5399 拍 frozen 恒空？——飞行拍应标记参与者，说明接线漏了"
    );
    // 且绝大多数拍没有高亮（实测有高亮的 tick 约 713/5399）。
    assert!(
        nonempty < dm.state_snapshots.len() / 4,
        "frozen 非空的拍数 {nonempty} 过多（应为少数飞行拍）——标记口径可能反了"
    );
}

/// **正式路径不产快照、且行为逐字节不变**。
///
/// ## ⚠️ 首版是**假覆盖**（审阅 P1-4 抓到）
///
/// 首版只调 `observe(1)`（**opt-in** 路径）然后断言 `frozen.len() < 22`——
/// **从没调过 `simulate()`**。实测：把 `observe_state` 的
/// `if !self.enabled { return; }` 早返回**整个删掉**，全套 32 条**仍然全绿**
/// （`p15` 的逐字节一致门也绿，因为 `events_json()` 只序列化 `events`，
/// 而 `simulate()` 本来就丢弃 recorder）。护栏声称守「正式路径空操作」，实际守不住。
///
/// ## 正确守法：真的跑 `simulate()`，并断言它不产出快照、事件流不变
///
/// 本测试直接比对 `simulate()` 与 opt-in 路径的**事件流字节**，并断言
/// `simulate()` 那条路上不可能有快照（它返回的是 `String`，结构上没有快照出口）——
/// 故用它作为「正式路径无快照副作用」的**正面证据**：
/// 事件流逐字节一致 ⇒ 快照的采集没有反向影响决策/RNG。
#[test]
fn formal_path_produces_no_snapshots_and_is_byte_identical() {
    // opt-in 路径：有快照（否则本测试两侧都空，无判别力）。
    let dm = observe(1);
    assert!(
        !dm.state_snapshots.is_empty(),
        "opt-in 路径应产快照——若这里就空，下面的比对无判别力"
    );
    // 正式路径：`simulate()` 返回事件流 JSON，**结构上无处可放快照**。
    let formal = fm_engine::simulate(1, cfg());
    let opt_in = dm.events_json();
    // ① 字节一致 ⇒ 采集快照没有改变任何决策/RNG/事件。
    assert_eq!(
        formal, opt_in,
        "正式路径与 opt-in 路径的事件流必须**逐字节相同**——不同说明快照采集漏进了决策路径"
    );
    // ② 正式路径的产物里**不含**任何快照痕迹（`simulate()` 的输出只有事件）。
    assert!(
        !formal.contains("state_snapshots") && !formal.contains("snapshot"),
        "正式路径的事件流里出现了快照字段——事件流协议被改动了（本 change 明禁）"
    );
    // ③ 快照的 `frozen` 不是「整队 22 人」的退化值。
    assert!(
        dm.state_snapshots.iter().all(|s| s.frozen.len() < 22),
        "frozen 恒等于全队 22 人？——那不是「活跃高亮参与者」的语义"
    );
    // ④ **关闭的 recorder 必须是空操作**——这是「正式路径不产快照」的**可观测形态**。
    //
    // ⚠️ 为什么单独测它：`simulate()` 丢弃 recorder，故上面 ①②③ 对「删掉
    // `observe_state` 的 `if !self.enabled { return; }`」这个变异**看不见**
    // （实测：删掉后 ①②③ 全绿）。而 `disabled()` recorder 是**公开 API**，
    // 可直接构造并断言其空操作契约——这正是 `disabled_recorder_is_a_no_op` 的形态。
    let mut off = BehaviorObservationRecorder::disabled();
    assert!(!off.is_enabled(), "disabled() 应报告未启用");
    off.observe_state(ObservedTime::state_commit(1.0), &[(0.5, 0.5); 22], (0.5, 0.5), &[3]);
    assert!(
        off.state_snapshots().is_empty(),
        "**关闭的 recorder 的 `observe_state` 必须是空操作**——它若写入，正式路径\
         （`simulate()` 传 `disabled()`）就会在结构上持有位置数据，\
         「G1 不进入正式路径」这条承诺就破了"
    );
    // 反证条：同一个命令在**启用**的 recorder 上必须写入（否则上面的断言是恒真）。
    let mut on = BehaviorObservationRecorder::enabled();
    on.observe_state(ObservedTime::state_commit(1.0), &[(0.5, 0.5); 22], (0.5, 0.5), &[3]);
    assert_eq!(
        on.state_snapshots().len(),
        1,
        "反证条：启用的 recorder 上 `observe_state` 必须真的写入——\
         否则上面那条「空操作」断言对该命令恒真，无判别力"
    );
}

// ============================== 静态队形（Slice 2） ==============================

/// **分位口径逐字对齐 `match-metrics.js`**（R type-7 / NumPy 默认）——用**精确值**断言，
/// 不是「大致范围」。这些值取自 JS 侧同名实现可手算的构造样本。
///
/// 判别力：把插值改成「最近秩」或「线性 on sorted 索引」会立刻改变这些精确值。
#[test]
fn quantile_matches_the_r_type7_convention_exactly() {
    // n=5, p=0.1: h = 4*0.1 = 0.4, i=0 → s0 + 0.4*(s1-s0) = 0 + 0.4*1 = 0.4
    assert!((quantile_sorted(&[0.0, 1.0, 2.0, 3.0, 4.0], 0.1).unwrap() - 0.4).abs() < 1e-12);
    // p=0.9: h = 3.6, i=3 → s3 + 0.6*(s4-s3) = 3 + 0.6 = 3.6
    assert!((quantile_sorted(&[0.0, 1.0, 2.0, 3.0, 4.0], 0.9).unwrap() - 3.6).abs() < 1e-12);
    // 跨度 = 3.6 - 0.4 = 3.2
    assert!((quantile_span(&[0.0, 1.0, 2.0, 3.0, 4.0]).unwrap() - 3.2).abs() < 1e-12);
    // n=1 → 该点；n=0 → None（不用 0.0 伪造）
    assert_eq!(quantile_sorted(&[7.0], 0.5), Some(7.0));
    assert_eq!(quantile_sorted(&[], 0.5), None);
    assert_eq!(quantile_span(&[1.0]), None);
    // h 落在最后一点时不越界插值：n=2, p=0.9 → h=0.9, i=0 → s0+0.9*(s1-s0)
    assert!((quantile_sorted(&[0.0, 10.0], 0.9).unwrap() - 9.0).abs() < 1e-12);
    // n=2, p=1.0 → h=1.0, i=1, i+1>=n → 取 s[n-1]（**不**越界）
    assert_eq!(quantile_sorted(&[0.0, 10.0], 1.0), Some(10.0));
}

/// 队形指标的**极端位置断言**（本仓 P36 的教训：口径守护要用能分辨的输入）。
///
/// 构造一帧：主队 10 名外场排成一条 **x 从 0.1 到 0.9 的直线**（y 全 0.5），
/// 门将放在离谱位置（x=0.02）。断言：
/// - 门将被剔除 ⇒ `cx` 不含 0.02（不剔则重心被拽偏）；
/// - `depth` == q10–q90 跨度，**不是** max−min（后者会 = 84 m）。
#[test]
fn team_shape_excludes_keeper_and_uses_quantile_span() {
    let mut pos = [(0.5, 0.5); 22];
    // 主队门将（id 0）放在极端位置——若被计入，cx/cy/depth 全变
    pos[0] = (0.02, 0.05);
    // 主队外场 id 1..=10：x 从 0.1 到 0.9 均匀
    for (k, id) in (1..=10usize).enumerate() {
        pos[id] = (0.1 + 0.8 * (k as f64) / 9.0, 0.5);
    }
    // 客队随便摆（本测试只看主队）
    for id in 11..=21usize {
        pos[id] = (0.5, 0.5);
    }
    let snap = StateSnapshot {
        t: ObservedTime::state_commit(1.0),
        ball: (0.5, 0.5),
        pos,
        frozen: vec![],
    };
    let s = team_shape(&snap, TeamId::Home).expect("10 名外场应可算");
    assert_eq!(s.n, 10, "有效外场人数应为 10（门将剔除后）");
    // cx = mean(0.1..0.9 米制) = 0.5*105 = 52.5 m。门将 (0.02) 若被计入会把它拉低。
    assert!(
        (s.cx - 52.5).abs() < 1e-9,
        "cx 应为 52.5 m（10 名外场 x 的均值）；门将 id=0 必须被剔除。实测 {}",
        s.cx
    );
    assert!((s.cy - 34.0).abs() < 1e-9, "cy 应为 34.0 m（y 全 0.5）");
    // depth：x 米制 = 10.5..94.5，跨度 84。q10–q90 会**小于** 84（掐掉两端分位）。
    let xs_m: Vec<f64> = (0..10).map(|k| (0.1 + 0.8 * k as f64 / 9.0) * 105.0).collect();
    let mut sorted = xs_m.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let expect = quantile_span(&sorted).unwrap();
    assert!(
        (s.depth - expect).abs() < 1e-9,
        "depth 必须是 q10–q90 跨度（{expect}），实测 {}",
        s.depth
    );
    assert!(
        s.depth < 84.0 - 1e-6,
        "depth 必须**小于** max−min（84 m）——若相等说明退化成了最朴素的跨度，q10–q90 没生效"
    );
    // spread > 0 且有限
    assert!(s.spread > 0.0 && s.spread.is_finite());
}

/// **`spread` 用未排序的 (x,y) 配对**——本仓踩过的历史坑（排序后的 x 配未排序的 y，
/// 差 0.1–0.2 m）。
///
/// ⚠️ **fixture 的判别力要求**：x 的**下标顺序必须与大小顺序不同**，否则「排序 x 再配对」
/// 是空操作，本测试会变成恒真（初版就踩了这个坑：x 与 y 同增，排序不改顺序 ⇒ 变异存活）。
/// 故这里把 x 安排成**交替大小**（0.9, 0.1, 0.8, 0.2, …），而 y 单独递增。
#[test]
fn spread_pairs_unsorted_coordinates() {
    let mut pos = [(0.5, 0.5); 22];
    // 主队外场 x 交替（下标序 ≠ 大小序），y 单独按另一序排列——两者配对是刻意错位的。
    let mut pts: Vec<(f64, f64)> = Vec::new();
    for k in 0..10usize {
        let x = if k % 2 == 0 { 0.9 - 0.08 * (k as f64) } else { 0.1 + 0.08 * (k as f64) };
        let y = 0.1 + 0.07 * k as f64;
        pts.push((x, y));
        pos[1 + k] = (x, y);
    }
    let snap = StateSnapshot {
        t: ObservedTime::state_commit(1.0),
        ball: (0.5, 0.5),
        pos,
        frozen: vec![],
    };
    let s = team_shape(&snap, TeamId::Home).unwrap();
    let m: Vec<(f64, f64)> = pts.iter().map(|(x, y)| (x * 105.0, y * 68.0)).collect();
    let cx = m.iter().map(|p| p.0).sum::<f64>() / 10.0;
    let cy = m.iter().map(|p| p.1).sum::<f64>() / 10.0;
    let expect = m
        .iter()
        .map(|p| ((p.0 - cx).powi(2) + (p.1 - cy).powi(2)).sqrt())
        .sum::<f64>()
        / 10.0;
    // 反证条：确认「x 排序后再配对」确实给出**不同**的值（否则本测试无判别力）。
    let mut sorted_x: Vec<f64> = m.iter().map(|p| p.0).collect();
    sorted_x.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let wrong = sorted_x
        .iter()
        .zip(m.iter().map(|p| p.1))
        .map(|(x, y)| ((x - cx).powi(2) + (y - cy).powi(2)).sqrt())
        .sum::<f64>()
        / 10.0;
    assert!(
        (wrong - expect).abs() > 1e-6,
        "反证条失败：本 fixture 下「排序 x 再配对」与「原序配对」同值（{wrong} vs {expect}）——\
         本测试对它无判别力，须换构造"
    );
    assert!(
        (s.spread - expect).abs() < 1e-9,
        "spread 必须用未排序的 (x,y) 配对（期待 {expect}，实测 {}）",
        s.spread
    );
}

/// **队形覆盖率**：引擎侧应 **100% 可算、0 缺失**（`MIN_OUTFIELD_PLAYERS` 是空操作）。
///
/// 这条正是 design §3.1 要求「明确记录」的那一点：**不得**把它写成「引擎侧会掉帧」。
#[test]
fn engine_shape_coverage_is_total_and_missing_reasons_stay_empty() {
    let dm = observe(1);
    let ms = MatchShape::observe_match(&dm);
    assert_eq!(ms.home.frames, dm.state_snapshots.len());
    assert_eq!(ms.away.frames, dm.state_snapshots.len());
    assert_eq!(
        ms.home.computable, ms.home.frames,
        "引擎侧队形可算帧必须 == 总帧数（每队恒 10 名外场，`MIN_OUTFIELD_PLAYERS` 空操作）"
    );
    assert_eq!(ms.away.computable, ms.away.frames);
    assert!(
        ms.home.missing_reasons.is_empty(),
        "引擎侧不应有缺失原因——`includeExtrapolated` / `MIN_OUTFIELD_PLAYERS` 在此为空操作。         实测缺失：{:?}",
        ms.home.missing_reasons
    );
    assert_eq!(ms.home.computable_share(), Some(1.0));
    // 防空转：必须有足够多的帧
    assert!(ms.home.frames > 5000, "快照帧数过少：{}", ms.home.frames);
}

/// **与 JS 标尺同口径的哨兵**：Rust 的队形指标必须落在 JS `match-metrics.js` 实测的
/// 同一量级。这是一条**宽哨兵**（不做逐点比对——那需要 JS 侧产物），
/// 目的是抓「口径分叉」这类沉默错误（例如 depth 误用 max−min ⇒ 会显著偏大）。
#[test]
fn rust_shape_is_in_the_same_regime_as_the_js_ruler() {
    let dm = observe(1);
    let ms = MatchShape::observe_match(&dm);
    let mean_depth = ms.home.depth_sum / ms.home.computable.max(1) as f64;
    println!(
        "Rust 侧 seed 1：可算帧 {}/{} 平均 depth={:.2} m 平均 width={:.2} m",
        ms.home.computable,
        ms.home.frames,
        mean_depth,
        ms.home.width_sum / ms.home.computable.max(1) as f64
    );
    // JS 标尺实测（P36/P37 基线）：引擎侧 depth 均值 ≈ 40.2 m、width ≈ 40.8 m。
    // 这里给宽松带（±25%）——它抓的是**口径分叉**（如 max−min 会让 depth ≈ 84 m），
    // 不是精确复现（精确比对需 JS 侧同帧产物，属 Slice 5 的产物验收）。
    assert!(
        (30.0..=50.0).contains(&mean_depth),
        "Rust 侧平均 depth {mean_depth:.2} m 明显偏离 JS 标尺的 ≈40 m 量级——口径可能分叉"
    );
}

// ============================== 时间关系特征（Slice 3） ==============================

/// **位移分解的符号口径**：进攻方向的位移计入 `forward`，反向计入 `backward`，
/// 垂直方向**无符号**计入 `lateral`。用主客两队**同一组位移**证明方向归一生效。
///
/// 判别力：把 `along = dir * dx_m` 写成 `dx_m`（不乘 dir）会让客队那半红。
#[test]
fn displacement_decomposition_normalizes_direction_and_splits_axes() {
    // 球沿 +x 走 10 m（同时 y 不动）——对主队是前插、对客队是回撤。
    let fwd = vec![(1.0, (0.0, 0.5)), (2.0, (10.0 / 105.0, 0.5))];
    let home = decompose_displacement(&fwd, TeamId::Home).unwrap();
    assert!((home.forward_m - 10.0).abs() < 1e-9, "主队：+x 应为 forward");
    assert!((home.backward_m - 0.0).abs() < 1e-9);
    let away = decompose_displacement(&fwd, TeamId::Away).unwrap();
    assert!((away.forward_m - 0.0).abs() < 1e-9, "客队：+x 应为**回撤**");
    assert!((away.backward_m - 10.0).abs() < 1e-9, "客队攻 −x，+x 位移 = backward");

    // 横向：球沿 +y 走 6.8 m，两队都应记进 lateral（无符号），不进 forward/backward。
    let lat = vec![(1.0, (0.5, 0.0)), (2.0, (0.5, 6.8 / 68.0))];
    let h2 = decompose_displacement(&lat, TeamId::Home).unwrap();
    assert!((h2.lateral_m - 6.8).abs() < 1e-9, "横向位移应进 lateral");
    assert!(h2.forward_m.abs() < 1e-9 && h2.backward_m.abs() < 1e-9);
    // 负向横向也是 lateral 正值（无符号）
    let lat_neg = vec![(1.0, (0.5, 6.8 / 68.0)), (2.0, (0.5, 0.0))];
    assert!((decompose_displacement(&lat_neg, TeamId::Home).unwrap().lateral_m - 6.8).abs() < 1e-9);

    // 单帧 / 零帧 → None（不猜 0.0）
    assert_eq!(decompose_displacement(&[(1.0, (0.5, 0.5))], TeamId::Home), None);
    assert_eq!(decompose_displacement(&[], TeamId::Home), None);
}

/// **线间距斜率**用最小二乘（不是末减首）。用一条**带噪直线**证明两者不同值，
/// 并断言取的是回归斜率。
///
/// 判别力：把 `slope()` 换成 `(last.y - first.y)/(last.t - first.t)` 会红。
#[test]
fn line_spacing_slope_is_least_squares_not_endpoint_difference() {
    // depth 随时间线性上升 +0.5 m/s，但首帧被抬高（异常值）——末减首会低估斜率。
    let frames: Vec<(f64, TeamShape)> = vec![
        (0.0, ts(70.0)),
        (1.0, ts(40.5)),
        (2.0, ts(41.0)),
        (3.0, ts(41.5)),
        (4.0, ts(42.0)),
    ];
    let c = line_spacing_change(&frames).unwrap();
    // 末减首：(42.0-70.0)/4 = -7.0；最小二乘应显著更接近 +0.5 的潜在趋势。
    let endpoint = (42.0 - 70.0) / 4.0;
    assert!(
        (c.depth_slope_m_per_s - endpoint).abs() > 1.0,
        "斜率必须**不是**末减首（末减首 = {endpoint}）——若相等说明实现退化"
    );
    // 去掉异常首帧后，纯线性段的斜率应精确 = +0.5
    let clean: Vec<(f64, TeamShape)> = vec![
        (1.0, ts(40.5)),
        (2.0, ts(41.0)),
        (3.0, ts(41.5)),
        (4.0, ts(42.0)),
    ];
    let cc = line_spacing_change(&clean).unwrap();
    assert!(
        (cc.depth_slope_m_per_s - 0.5).abs() < 1e-9,
        "纯线性段的最小二乘斜率应为 0.5，实测 {}",
        cc.depth_slope_m_per_s
    );
    assert_eq!(cc.frames, 4);
    // <2 帧 → None
    assert_eq!(line_spacing_change(&frames[..1]), None);
}

/// 构造只填 depth/spread 的 `TeamShape`（其余字段本测试不关心）。
fn ts(depth: f64) -> TeamShape {
    TeamShape {
        depth,
        width: 40.0,
        cx: 52.5,
        cy: 34.0,
        spread: 18.0,
        n: 10,
    }
}

/// **接应判据用球位、且只取球前方**——这是 design §3.2 逐字要求的
/// （「推进后**球前方**是否出现可接应队友」）。
///
/// 判别力：把参考点从 `snap.ball` 换回重心、或删掉 `along < SUPPORT_MIN_FORWARD_M`
/// 这个条件，都会让本测试红。
#[test]
fn support_uses_ball_position_and_only_counts_players_ahead() {
    let mut pos = [(0.5, 0.5); 22];
    // 球放在 x=0.5（中线）。主队外场：
    //   - id 1 在球**前方** 10 m（x=0.5+10/105）
    //   - id 2 在球**后方** 10 m（x=0.5-10/105）——不应计入
    //   - id 3 在球前方但 30 m 外 —— 超出 SUPPORT_MAX_DIST_M
    pos[1] = (0.5 + 10.0 / 105.0, 0.5);
    pos[2] = (0.5 - 10.0 / 105.0, 0.5);
    pos[3] = (0.5 + 30.0 / 105.0, 0.5);
    let snap = StateSnapshot {
        t: ObservedTime::state_commit(1.0),
        ball: (0.5, 0.5),
        pos,
        frozen: vec![],
    };
    let sup = support_formation(&snap, TeamId::Home).unwrap();
    assert_eq!(
        sup.supporters, 1,
        "只应计入「球前方且距离内」的 1 名队友（id 1）——后方(id2)与超距(id3)都不算"
    );
    assert!((sup.nearest_support_m.unwrap() - 10.0).abs() < 1e-9);
    assert!((sup.ball_progress - 0.5).abs() < 1e-9, "球的推进度应为 0.5（x=0.5 主队）");

    // 方向归一：客队视角下，x=0.5 的前方是 **−x** 方向。
    // id 11 在 x=0.5−10/105（客队的前方）应被计入；id 12/13 在主队方向则不计。
    let mut pos2 = [(0.5, 0.5); 22];
    pos2[11] = (0.5 - 10.0 / 105.0, 0.5);
    pos2[12] = (0.5 + 10.0 / 105.0, 0.5);
    let snap2 = StateSnapshot {
        t: ObservedTime::state_commit(1.0),
        ball: (0.5, 0.5),
        pos: pos2,
        frozen: vec![],
    };
    let sup2 = support_formation(&snap2, TeamId::Away).unwrap();
    assert_eq!(
        sup2.supporters, 1,
        "客队：只有 −x 方向的队友是「前方」——方向归一必须按队生效"
    );
}

/// **四条特征的覆盖率**（design 要求「每条给覆盖率 + 缺失原因分类」）。
/// 这是**报告项**（打印）加**防空转下限**（不做虚高的硬门）。
#[test]
fn time_relationship_feature_coverage_on_a_real_seed() {
    let dm = observe(1);
    let mut cov = FeatureCoverage::default();
    let mut net_progress_values: Vec<f64> = Vec::new();
    let mut depth_slopes: Vec<f64> = Vec::new();

    for ep in &dm.possession_episodes {
        let Some(c) = caliber_of(&dm, ep) else { continue };
        let end = ep.end_t.map(|t| t.value);
        // 本 episode 窗内的快照帧（用位置口径的窗）
        let frames: Vec<(f64, StateSnapshot)> = dm
            .state_snapshots
            .iter()
            .filter(|s| {
                s.t.value + 1e-9 >= ep.start_t.value && end.map(|e| s.t.value <= e + 1e-9).unwrap_or(false)
            })
            .map(|s| (s.t.value, s.clone()))
            .collect();
        for w in windows_over((ep.start_t.value, end), dm.state_snapshots.last().map(|s| s.t.value).unwrap_or(0.0)) {
            let win_frames: Vec<(f64, StateSnapshot)> = frames
                .iter()
                .filter(|(t, _)| *t + 1e-9 >= w.start && *t < w.end - 1e-9)
                .cloned()
                .collect();
            let ball_track = collect_ball_track(&win_frames);
            let shapes = collect_shapes(&win_frames, ep.team);
            let mut support_frames = 0usize;
            for (_, snap) in &win_frames {
                if let Some(s) = support_formation(snap, ep.team) {
                    if s.supporters > 0 {
                        support_frames += 1;
                    }
                }
            }
            let f = WindowFeatures {
                window: w,
                net_progress: goalward_net_progress(&c),
                displacement: decompose_displacement(&ball_track, ep.team),
                line_spacing: line_spacing_change(&shapes),
                support_frames,
                snap_frames: win_frames.len(),
            };
            if let Some(v) = f.net_progress {
                net_progress_values.push(v);
            }
            if let Some(ls) = f.line_spacing {
                depth_slopes.push(ls.depth_slope_m_per_s);
            }
            cov.observe_window(&f);
        }
    }

    println!(
        "时间关系特征覆盖率（seed 1）：windows={} 净推进={:?} 位移={:?} 线间距={:?} 接应={:?}",
        cov.windows,
        cov.share(cov.win_net_progress),
        cov.share(cov.win_displacement),
        cov.share(cov.win_line_spacing),
        cov.share(cov.win_support),
    );
    println!("缺失原因分类：{:?}", cov.missing);
    if !net_progress_values.is_empty() {
        let mut s = net_progress_values.clone();
        s.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!(
            "净推进：n={} p10={:.3} p50={:.3} p90={:.3}",
            s.len(),
            s[s.len() / 10],
            s[s.len() / 2],
            s[s.len() * 9 / 10]
        );
    }
    if !depth_slopes.is_empty() {
        let mut s = depth_slopes.clone();
        s.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!(
            "纵深斜率（米/秒）：n={} p10={:.3} p50={:.3} p90={:.3}",
            s.len(),
            s[s.len() / 10],
            s[s.len() / 2],
            s[s.len() * 9 / 10]
        );
    }

    // **防空转下限**（宽松——精确覆盖率是报告项，不设虚高硬门）
    assert!(cov.windows > 100, "窗口数过少：{}", cov.windows);
    assert!(
        cov.win_displacement as f64 / cov.windows as f64 > 0.5,
        "位移分解覆盖率过低：{}/{}",
        cov.win_displacement,
        cov.windows
    );
    assert!(
        cov.win_line_spacing as f64 / cov.windows as f64 > 0.5,
        "线间距覆盖率过低：{}/{}",
        cov.win_line_spacing,
        cov.windows
    );
    assert!(
        cov.win_support as f64 / cov.windows as f64 > 0.5,
        "接应覆盖率过低：{}/{}",
        cov.win_support,
        cov.windows
    );
}

/// **时间基准不混用**（design §2.3）：本 change 全部特征只用 `StateCommit` 一种 basis。
///
/// 判别力：若将来有特征读了 `EventEmit` 或 `DeterministicFlightEnd` 的时间，
/// 那条特征必须显式记录 basis 并单独列出——本测试守住「当前全部同 basis」这个事实。
#[test]
fn all_feature_times_use_a_single_basis() {
    let dm = observe(1);
    // 位置快照的时间 basis 全部 StateCommit（唯一进入特征的时间来源）。
    for s in &dm.state_snapshots {
        assert_eq!(
            s.t.basis,
            TimeBasis::StateCommit,
            "位置快照的 TimeBasis 必须是 StateCommit——本 change 的特征全部以它为时间来源"
        );
    }
    // ⚠️ **episode 的起止时间会混 basis**——实测（见下打印）：`start_t` 有
    // `event_emit`（首开球的 `match_started` 专线）与 `deterministic_flight_end`
    // （`kickoff_again` 后恢复），`end_t` 也有 `deterministic_flight_end`。
    // 这是**观测层既有事实**，不是本 change 引入的。
    //
    // design §2.3 的纪律是「同一特征只用同一 basis；跨 basis 的显式标注并单独列出」。
    // 故本测试**不**断言 episode 时间单一 basis（那不成立），而是：
    // ① 断言**快照**（本 change 的时间来源）单 basis；
    // ② 把 episode 边界的 basis 分布**打印出来**（= 显式标注、单独列出）。
    let mut start_bases: std::collections::BTreeMap<&'static str, usize> = Default::default();
    let mut end_bases: std::collections::BTreeMap<&'static str, usize> = Default::default();
    for ep in &dm.possession_episodes {
        *start_bases.entry(ep.start_t.basis.as_str()).or_insert(0) += 1;
        if let Some(e) = ep.end_t {
            *end_bases.entry(e.basis.as_str()).or_insert(0) += 1;
        }
    }
    println!("episode start_t basis 分布：{start_bases:?}");
    println!("episode end_t   basis 分布：{end_bases:?}");
    assert!(
        start_bases.contains_key("state_commit") && start_bases.len() >= 1,
        "start_t 至少应有 state_commit；实测 {start_bases:?}"
    );
    // 起点位置口径的 basis（`caliber.rs` 记的）也应是 StateCommit / 少数
    // finalized_outcome——**不是**未知或混用。这条打印现状、不设硬门（它随路径变化）。
    let mut bases: std::collections::BTreeMap<&'static str, usize> = Default::default();
    for ep in &dm.possession_episodes {
        if let Some(c) = caliber_of(&dm, ep) {
            *bases.entry(c.start_basis.as_str()).or_insert(0) += 1;
        }
    }
    println!("起点事实的 TimeBasis 分布：{bases:?}");
}

// ============================== phaseability gate（Slice 4，验收） ==============================

/// **头号纪律：motif 定义不得使用位置**（用户点名要防的风险）。
///
/// 若任一档的任一条子句用了位置/区域，该档参考集就失去判别力——
/// 用它检验位置特征 = 用位置验证位置（循环论证），gate 结论作废。
#[test]
fn motifs_do_not_use_position() {
    for m in REFERENCE_MOTIFS {
        assert!(
            !m.clauses.is_empty(),
            "参考 motif `{}` 没有任何子句——空谓词不可接受",
            m.name
        );
        for (clause, uses_position) in m.clauses {
            assert!(
                !*uses_position,
                "参考 motif `{}` 的子句「{clause}」**使用了位置/区域**——\
                 这会让该档参考集退化成循环论证，gate 结论不可用。\
                 要么换掉这条子句，要么把该档标为「不可判」。",
                m.name
            );
        }
    }
}

/// **循环性防护（源码扫描整个 `reference.rs`）**：构造参考集的代码**不得引用任何位置量**。
///
/// ## 为什么必须是源码扫描（而不是只做行为核对）
///
/// 初版只做了**事件位置**的行为核对（克隆一场、把 `Event.x/y/x2/y2` 改成极端值、
/// 断言参考集不变）。**那个护栏漏掉了 `ControlFact.location`**——实测往 `reference_set`
/// 里塞 `caliber_of(dm, ep).start_progress < 0.33` 后，**全套仍绿**。
///
/// ## 为什么扫描范围是**整个文件**（这是第二轮独立审阅的 P1）
///
/// 中间版本扫描的是 `reference_set` 的**函数体**（`include_str!` 切出函数体再核 token）。
/// 实测：把位置读取放进**体外 helper** 再在体内调用，**全套 32 条仍绿**，
/// 而参考集已真的用上位置（`build_up` vs `progression` 的 AUC 从 0.461 移到 0.552）。
///
/// ⇒ 第一层修复：参考集拆到独立文件 `p16/reference.rs`，本文扫描**该文件全文**。
///
/// ## ⚠️ 但「拆文件」**不足以**保证——第二层是**类型隔离**（第三轮独立审阅的 P1）
///
/// 拆文件只搬走了**现有** helper，**没有任何机制阻止**再往 `gate.rs` 加一个：
/// 实测（2026-09-29）把位置读取放进 `gate.rs` 的 `pub fn __pos_gate`、
/// 在 `reference.rs` 里 `use crate::gate::__pos_gate` 并调用——**全套仍绿**，
/// 而参考集已按位置剪裁（`build_up` 从 17 条降到 9 条）。
/// 文本扫描**结构上做不到**这件事（无调用图分析），
/// 故「任何 helper 必须在文件内 ⇒ 覆盖调用闭包」那句是**事实错误**，已删。
///
/// ⇒ 第二层修复：**类型隔离**。参考集只吃 [`ActionFacts`]（**无任何位置字段**），
/// `reference_set` 的签名**不接收观测层对象**。构造侧 `gate.rs::action_facts`
/// 读事件但**只提取动作类型/结果**。故 `reference.rs` 里**任何** helper
/// （不论定义在哪）都拿不到位置。
///
/// **两层合起来**：类型隔离挡「拿到位置」，全文扫描挡「往 `ActionFacts` 加位置字段」
/// （本测试另断言 `reference.rs` 不含 `DiagnosticMatch`——那是唯一能回推位置的入口）。
///
/// ⚠️ **剩余能力边界（如实记录）**：仍非形式化证明。若有人**同时**给 `ActionFacts`
/// 加一个改名后的位置字段、并在 `gate.rs` 填充、且该字段名不在本文的 token 表里，
/// 两层的**文本**那一层看不见（类型那一层此时也已失效——因为 `ActionFacts` 被污染了）。
/// 真正完备需要位置量在**类型系统层面**不可达（如独立的 crate 边界）。
/// 本 change 的两层防护对「防自己不小心写循环论证」够用，对「防刻意构造」不够。
#[test]
fn reference_set_source_references_no_position_quantity() {
    // 扫**整个** `reference.rs`（不是某个函数体）——这是本守卫的关键。
    const SRC: &str = include_str!("p16/reference.rs");

    // 位置量的标识符（任何一个出现在该文件里都说明参考集读了位置）。
    const FORBIDDEN: &[&str] = &[
        // 动作事件的位置（本 change 的口径明禁用它：动作主体的位置 ≠ 球位）
        ".x",
        ".y",
        ".x2",
        ".y2",
        "out_pos",
        // 观测层事实的位置
        "location",
        "start_progress",
        "end_progress",
        "net_progress",
        // 位置口径 / 空间特征的入口
        "caliber_of",
        "EpisodeCaliber",
        "calibers_of",
        "team_shape",
        "TeamShape",
        "StateSnapshot",
        "state_snapshots",
        "collect_ball_track",
        "support_formation",
        "decompose_displacement",
        "line_spacing_change",
        "progress(",
        "attack_dir",
    ];
    for tok in FORBIDDEN {
        assert!(
            !SRC.contains(tok),
            "`p16/reference.rs` 里出现了位置量 `{tok}` —— 参考集必须**只由动作链**构造\
             （契约：判别参考集不得只用区域构造，否则循环论证）。\
             若确需位置谓词，那不是参考集，是特征（应放 `features.rs` / `gate.rs`）。"
        );
    }
    // 反证的反证：扫描必须真的落在参考集代码上（不是空文件 / 扫错路径）。
    assert!(
        SRC.contains("reference_set")
            && SRC.contains("ActionFacts")
            && SRC.contains("open_success_passes")
            && SRC.contains("ends_shot"),
        "源码扫描没有落在参考集代码上——守卫失效，须修扫描目标"
    );
    assert!(SRC.len() > 500, "扫到的文件过短（{} 字节）", SRC.len());
    // **类型隔离的正面证据**：`reference.rs` 不得出现 `DiagnosticMatch`——
    // 那是**唯一**能回推位置的入口。一旦它能拿到 `DiagnosticMatch`，类型隔离就破了。
    assert!(
        !SRC.contains("DiagnosticMatch"),
        "`p16/reference.rs` 出现了 `DiagnosticMatch` —— 参考集必须只吃无位置的 `ActionFacts`"
    );
}

/// **参考集谓词语义被钉住**（防「文档说 A、实现做 B」）。
///
/// 动机：实测（2026-09-29）把 `final_third_candidate` 的实现从「**以** shot 结尾」
/// 改成「**含** shot」，全套测试仍然全绿——因为没有任何测试钉住这两者的差别。
/// 文档（[`REFERENCE_MOTIFS`]）逐字写的是「**最后一个决策动作**是 shot」，
/// 实现必须就是它。
#[test]
fn reference_predicate_semantics_are_pinned() {
    // 构造两个 episode：都以 shot 结尾 vs 中途射门后继续传球。
    // 用真实数据的分布来断言更稳（手搭 fixture 容易与实际形状不符）。
    let dm = observe(1);
    for (i, ep) in dm.possession_episodes.iter().enumerate() {
        let acts: Vec<&fm_engine::Event> = ep
            .event_indexes
            .iter()
            .filter_map(|j| dm.events.get(*j))
            .filter(|e| {
                matches!(
                    e.type_,
                    EventType::Pass | EventType::Shot | EventType::Tackle | EventType::Foul
                )
            })
            .collect();
        let Some(last) = acts.last() else { continue };
        let has_shot = acts.iter().any(|e| e.type_ == EventType::Shot);
        let ends_shot = last.type_ == EventType::Shot;
        let in_final = reference_sets(&dm)
            .iter()
            .find(|(n, _)| *n == "final_third_candidate")
            .map(|(_, v)| v.contains(&i))
            .unwrap_or(false);
        assert_eq!(
            in_final, ends_shot,
            "episode {i}: `final_third_candidate` 的归属（{in_final}）必须等于\
             「**最后**一个决策动作是 shot」（{ends_shot}），而不是「含 shot」（{has_shot}）——\
             文档逐字写的是前者"
        );
    }
}

/// **参考集的规模与互斥性**（报告项 + 防空转）。
#[test]
fn reference_sets_are_sized_and_documented() {
    let dm = observe(1);
    let sum = ReferenceSummary::build(&dm);
    println!("参考集汇总：total={}", sum.total_episodes);
    for (n, c) in &sum.by_name {
        println!(
            "  {n}: {c} ({:.1}%)",
            reference_share(
                &reference_sets(&dm)
                    .iter()
                    .find(|(nm, _)| nm == n)
                    .map(|(_, v)| v.clone())
                    .unwrap_or_default(),
                sum.total_episodes
            )
            .unwrap_or(0.0)
                * 100.0
        );
    }
    println!("两两重叠：{:?}", sum.pairwise_overlap);
    for (n, c) in &sum.by_name {
        assert!(*c > 0, "参考集 `{n}` 为空——样本或谓词有问题");
    }
    // 三档**不该互相包含**（若两档几乎重合，说明谓词没分开三档）。
    for ((a, b), ov) in &sum.pairwise_overlap {
        let na = sum.by_name[a];
        let nb = sum.by_name[b];
        let overlap_of_smaller = *ov as f64 / na.min(nb) as f64;
        println!("  {a} ∩ {b} = {ov}（占较小者 {overlap_of_smaller:.2}）");
    }
}

/// **可分性实测**（gate 的原始证据）。
///
/// 对每档参考集算各特征的 AUC，跨多 seed 池化**逐 episode 值**（**不是**先把每场聚成均值
/// 再比——那会把 n 压到 seed 数，AUC 失去分辨力）。这里池化的对象是「episode」这个
/// **同质单元**（每个 episode 是一档判定的一个样本），与 P38「位移 sd 不能跨场拼接」
/// 的教训不同——那条禁的是把**每场一个标量**的估计量跨场拼，这里是池化**样本**。
///
/// ⚠️ **注意看 `start_progress[区域量·仅对照]` 这一行**：它是**区域量**，
/// 若只有它高而空间特征低，说明可分性来自位置而非战术意图（= 契约禁的「区域 = 阶段」）。
#[test]
fn phaseability_separability_is_measured() {
    const GATE_SEEDS: (u64, u64) = (1, 30);
    let mut all_feats: Vec<(usize, EpisodeFeature)> = Vec::new();
    let mut all_refs: std::collections::BTreeMap<&'static str, Vec<usize>> = Default::default();
    let mut offset = 0usize;
    for seed in GATE_SEEDS.0..=GATE_SEEDS.1 {
        let dm = observe(seed);
        let feats = episode_features(&dm);
        // ⚠️ offset 必须走 **`possession_episodes` 的下标空间**（参考集的下标就是它），
        // 而不是「有 caliber 的 episode 数」——二者只在「每个 episode 都有 caliber」时相等。
        // 若将来有 episode 缺起点，用 `feats.len()` 会让下一 seed 的标签与本 seed 高位**重叠**
        // （正是本 change 栽过两次的同类 join bug）。故断言两者相等，不等即红。
        assert_eq!(
            feats.len(),
            dm.possession_episodes.len(),
            "`episode_features` 跳过了缺 caliber 的 episode——此时 offset 必须改成 \
             `dm.possession_episodes.len()`，否则参考集标签会跨 seed 重叠（join bug 复发）"
        );
        let local_count = dm.possession_episodes.len();
        for m in REFERENCE_MOTIFS {
            let refs = reference_sets(&dm)
                .iter()
                .find(|(nm, _)| *nm == m.name)
                .map(|(_, v)| v.clone())
                .unwrap_or_default();
            all_refs
                .entry(m.name)
                .or_default()
                .extend(refs.into_iter().map(|i| i + offset));
        }
        // ⚠️ **必须把 episode 的本地下标抬成全局下标**——`all_refs` 是全局的，
        // 若 `all_feats` 留本地下标，`separability` 的 `in_set.contains(i)` 会把
        // 「全局参考下标」与「本地特征下标」相比。seed 1 之后**逐 seed 全错**。
        // 本 change 第一版就有这个 bug（P0，审阅抓到），使裁决被算在一个错 join 上。
        all_feats.extend(feats.into_iter().map(|(i, f)| (i + offset, f)));
        offset += local_count;
    }
    assert!(!all_feats.is_empty(), "没有 episode 特征——样本或实现有问题");

    let mut report: Vec<(&str, Vec<Separability>)> = Vec::new();
    for m in REFERENCE_MOTIFS {
        let refs = all_refs.get(m.name).cloned().unwrap_or_default();
        report.push((m.name, separability(&refs, &all_feats)));
    }
    println!(
        "phaseability 可分性（{} seed，{} episode 样本）",
        GATE_SEEDS.1 - GATE_SEEDS.0 + 1,
        all_feats.len()
    );
    for (name, seps) in &report {
        println!("-- {name} --");
        for s in seps {
            println!(
                "   {:<34} AUC={:?} (pos={}, neg={})",
                s.feature,
                s.auc.map(|a| (a * 1000.0).round() / 1000.0),
                s.pos_n,
                s.neg_n
            );
        }
    }
    // 防空转：每档都必须真的算出 AUC（pos 与 neg 都非空）。
    for (name, seps) in &report {
        for s in seps {
            assert!(
                s.auc.is_some(),
                "`{name}` 的特征 `{}` 算不出 AUC（pos={}, neg={}）——空组不该静默通过",
                s.feature,
                s.pos_n,
                s.neg_n
            );
        }
    }
    // 参考集不得过大/过小（防空转：某档吃掉半个样本就无所谓「应属」了）。
    let total = all_feats.len();
    for (name, refs) in &all_refs {
        let sh = reference_share(refs, total).unwrap();
        assert!(
            (0.01..=0.5).contains(&sh),
            "参考集 `{name}` 占比 {sh:.3} 越界（应在 (0.01, 0.5]）——谓词可能过宽/过窄"
        );
    }
}

// ============================== phaseability 裁决（Slice 4 的产出） ==============================

/// **裁决：部分够 —— 只能判 `final_third`；`build_up` 与 `progression` 判不了。**
///
/// ## ⚠️ 本裁决推翻了两版先前结论，两版都错，原因不同（必须读）
///
/// | 版本 | 结论 | 错在哪 |
/// |---|---|---|
/// | v1 | 不够（AUC ≈0.5） | **join bug**：`all_refs` 用全局下标而 `all_feats` 用逐场**本地**下标，seed 1 之后归属随机 ⇒ AUC 被摊平到 0.5。审阅抓到（P0）。 |
/// | v2 | 不够 + 「1 seed 0.7–0.84 是**小样本误导**，30 seed 塌回 0.5」 | **机制讲反了**：根本没有「塌回」——逐 seed AUC 稳定在 0.6–0.86。0.5 是 join bug 的产物，不是小样本。把 bug 的症状写成了统计学教训。 |
///
/// **教训**：v2 的解释比 v1 的结论危害更大——它会把一个可修的 bug 固化成一条「小样本
/// 不可信」的方法论。**AUC 在任何 seed 数下都算不出 0.5 除非 join 断了**。
///
/// ## 修正 join 后的实测（30 seed / 3075 episode）
///
/// **一 vs 其余（one-vs-rest）：**
///
/// | 参考集 | 最强空间特征 | AUC |
/// |---|---|---|
/// | `final_third_candidate` | `forward_m` | 0.717 |
/// | `build_up_candidate` | `backward_m` | **0.862** |
/// | `progression_candidate` | `backward_m` | 0.651 |
///
/// **但 `backward_m` 有严重混淆**：它是**累计**回撤量，随 episode **时长**增长——
/// 各档时长中位数 `build_up` 78 s / `progression` 45 s / `final_third` 40 s，
/// `build_up` 是另两档的 ~1.7 倍。故「build_up 的 backward_m 大」可能只是「它更长」。
///
/// **按秒归一后（两两 AUC）**：
///
/// | 特征（/秒） | final vs build | final vs prog | build vs prog |
/// |---|---|---|---|
/// | `forward_m/s` | **0.92** | **0.88** | 0.46 |
/// | `backward_m/s` | 0.16 | 0.27 | 0.63 |
///
/// ⇒ **`final_third` 可与另两档分开**（`forward_m/s` 0.88–0.92，方向一致：
/// final_third 的**球门向推进速率**更高——与足球直觉一致）。
/// ⇒ **`build_up` 与 `progression` 分不开**（0.46）。且这一对的分开程度被
/// **motif 定义本身**污染：`build_up` 要求 ≥3 次开放成功传球、`progression` 只要求 ≥1——
/// 差异部分来自「传球次数」，不是空间形态。
///
/// ## 结论与给 15B 的处置
///
/// - **`final_third`**：有可执行判据的**候选**——`final_third` 的 `forward_m/s` 显著高于
///   另两档。但**这是几何证据，不是战术意图**：按契约，若 15B 用它，须命名为**证据**
///   （如 `GoalwardProgressEvidence`），**不得复用 `Phase`**。
/// - **`build_up` / `progression`**：**保留 `unknown`**。当前观测不足以分开它们。
/// - **补什么**：要把这两档分开，需要**能表达意图**的观测（如射门窗口开启信号、
///   防守方位置/线路），以及**去除 motif 定义里「传球次数」的混淆**（否则分开了也说不清
///   是空间还是传球数）。
///
/// ## 本测试的判别力（为什么它不会静默漂移）
///
/// 它断言**两件事**：① 逐档的最强特征 AUC **必须**在预期带内（`final_third` 高、
/// `build_up`/`progression` 互不可分）；② 样本量下限。若 join 再断（回归到本地下标），
/// 第 ① 条会因 AUC 跌回 0.5 而红——**这正是它抓住 v1/v2 的方式**。
#[test]
fn phaseability_verdict_is_partial_and_the_evidence_is_duration_controlled() {
    const GATE_SEEDS: (u64, u64) = (1, 30);
    let mut all_feats: Vec<(usize, EpisodeFeature)> = Vec::new();
    let mut all_refs: std::collections::BTreeMap<&'static str, Vec<usize>> = Default::default();
    let mut offset = 0usize;
    for seed in GATE_SEEDS.0..=GATE_SEEDS.1 {
        let dm = observe(seed);
        let feats = episode_features(&dm);
        // ⚠️ offset 必须走 **`possession_episodes` 的下标空间**（参考集的下标就是它），
        // 而不是「有 caliber 的 episode 数」——二者只在「每个 episode 都有 caliber」时相等。
        // 若将来有 episode 缺起点，用 `feats.len()` 会让下一 seed 的标签与本 seed 高位**重叠**
        // （正是本 change 栽过两次的同类 join bug）。故断言两者相等，不等即红。
        assert_eq!(
            feats.len(),
            dm.possession_episodes.len(),
            "`episode_features` 跳过了缺 caliber 的 episode——此时 offset 必须改成 \
             `dm.possession_episodes.len()`，否则参考集标签会跨 seed 重叠（join bug 复发）"
        );
        let local_count = dm.possession_episodes.len();
        for m in REFERENCE_MOTIFS {
            all_refs
                .entry(m.name)
                .or_default()
                .extend(
                    reference_sets(&dm)
                        .iter()
                        .find(|(nm, _)| *nm == m.name)
                        .map(|(_, v)| v.clone())
                        .unwrap_or_default()
                        .into_iter()
                        .map(|i| i + offset),
                );
        }
        // ⚠️ **下标必须抬成全局**（v1 的 join bug 就在这一行少写了 `i + offset`）。
        all_feats.extend(feats.into_iter().map(|(i, f)| (i + offset, f)));
        offset += local_count;
    }
    assert!(all_feats.len() > 2000, "样本过少：{}", all_feats.len());

    let vals = |set: &str, f: fn(&EpisodeFeature) -> Option<f64>| -> Vec<f64> {
        let ids: std::collections::BTreeSet<usize> = all_refs
            .get(set)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .collect();
        all_feats
            .iter()
            .filter(|(i, _)| ids.contains(i))
            .filter_map(|(_, e)| f(e))
            .collect()
    };
    // ① final_third 必须**可**与另两档分开（forward_m/s，方向一致地高）。
    let fwd_final: Vec<f64> = all_feats
        .iter()
        .filter(|(i, _)| {
            all_refs
                .get("final_third_candidate")
                .map(|v| v.contains(i))
                .unwrap_or(false)
        })
        .filter_map(|(_, e)| Some(e.forward_m? / e.duration_s?))
        .collect();
    let fwd_other: Vec<f64> = all_feats
        .iter()
        .filter(|(i, _)| {
            !all_refs
                .get("final_third_candidate")
                .map(|v| v.contains(i))
                .unwrap_or(false)
        })
        .filter_map(|(_, e)| Some(e.forward_m? / e.duration_s?))
        .collect();
    let auc_final = auc(&fwd_final, &fwd_other).expect("final_third 的 AUC 应可算");
    println!("final_third vs 其余（forward_m/s）AUC = {auc_final:.3}");
    assert!(
        auc_final > 0.75,
        "final_third 在 forward_m/s 上应与其余显著可分（实测 {auc_final:.3}）——\
         若跌回 ~0.5，先查 join（`all_feats` 是否漏了 `i + offset`），再查样本"
    );

    // ② build_up 与 progression：**看去混淆后的量**（/秒）不可分。
    //
    // ⚠️ **未归一化时是可分的（实测 0.738）**——但那是**时长混淆**：
    // `build_up` 的 motif 要求 ≥3 次开放成功传球（比 `progression` 的 ≥1 更严），
    // 传球多 ⇒ episode 长 ⇒ **累计**位移自然大。用累计量「分开」这两档，
    // 分的是「传球次数/时长」而不是空间形态——且 motif 定义本身就含传球次数，
    // 那一步是循环的。故本断言用**时长归一后的速率**，并在下方打印未归一值作对照。
    let build_raw = vals("build_up_candidate", |e| e.forward_m);
    let prog_raw = vals("progression_candidate", |e| e.forward_m);
    let auc_raw = auc(&build_raw, &prog_raw).expect("应可算");
    let by_rate = |set: &str| -> Vec<f64> {
        vals(set, |e| Some(e.forward_m? / e.duration_s?))
    };
    let auc_bp = auc(&by_rate("build_up_candidate"), &by_rate("progression_candidate"))
        .expect("build_up vs progression 的 AUC 应可算");
    println!("build_up vs progression：forward_m 未归一 AUC = {auc_raw:.3}（受时长混淆）；forward_m/s AUC = {auc_bp:.3}");
    assert!(
        auc_raw > 0.60,
        "**记录用**：未归一的 forward_m 上 build_up 与 progression 应是可分的（实测 {auc_raw:.3}）——\
         这条不是判据，是**混淆存在的证据**：若不成立，下面那条断言的理由就不对"
    );
    assert!(
        (auc_bp - 0.5).abs() <= 0.06,
        "build_up 与 progression 在**时长归一**的 forward_m/s 上应分不开（实测 {auc_bp:.3}，
         容差 ±0.06）——若越过 0.56，说明空间形态真的能分开这两档，裁决须更新（重新给谓词）"
    );
    // **方向也钉住**：实测是**反向**的（0.431→build_up 的推进速率*更低*），
    // 这条方向信息本身是证据（build_up 不是「推得更快」，恰恰相反）——不钉住会丢。
    assert!(
        auc_bp < 0.5,
        "实测 build_up 的 forward_m/s 应**低于** progression（AUC < 0.5，实测 {auc_bp:.3}）——\
         若变成 > 0.5，方向翻转了，裁决的理由须重写"
    );

    // ③ 混淆记录：各档时长必须显著不同（这是「backward_m 的一 vs 其余高」的解释）。
    let dur = |set: &str| -> f64 {
        let v = vals(set, |e| e.duration_s);
        if v.is_empty() {
            return 0.0;
        }
        let mut s = v.clone();
        s.sort_by(|a, b| a.partial_cmp(b).unwrap());
        s[s.len() / 2]
    };
    let (db, dp, df) = (
        dur("build_up_candidate"),
        dur("progression_candidate"),
        dur("final_third_candidate"),
    );
    println!("时长中位数：build_up={db:.1}s progression={dp:.1}s final_third={df:.1}s");
    assert!(
        db > dp * 1.3,
        "build_up 的时长中位数（{db:.1}s）应显著长于 progression（{dp:.1}s）——\
         这正是 `backward_m` 一 vs 其余 AUC 高的**混淆来源**，必须如实记录"
    );
}

// ============================== 产物与 provenance（Slice 5） ==============================

/// **确定性**：同输入两次运行**逐字节相同**（产物可复现的前提）。
#[test]
fn identical_inputs_produce_byte_identical_output() {
    let build = || -> String {
        let dm = observe(1);
        let cov = {
            let mut c = CaliberCoverage::default();
            c.observe_match(&dm);
            c
        };
        let ms = MatchShape::observe_match(&dm);
        let mut fc = FeatureCoverage::default();
        for ep in &dm.possession_episodes {
            let Some(cal) = caliber_of(&dm, ep) else { continue };
            let end = ep.end_t.map(|t| t.value);
            let frames: Vec<(f64, StateSnapshot)> = dm
                .state_snapshots
                .iter()
                .filter(|s| {
                    s.t.value + 1e-9 >= ep.start_t.value
                        && end.map(|e| s.t.value <= e + 1e-9).unwrap_or(false)
                })
                .map(|s| (s.t.value, s.clone()))
                .collect();
            let ball = collect_ball_track(&frames);
            let shapes = collect_shapes(&frames, ep.team);
            for w in windows_over((ep.start_t.value, end), 0.0) {
                let wf: Vec<(f64, StateSnapshot)> = frames
                    .iter()
                    .filter(|(t, _)| *t + 1e-9 >= w.start && *t < w.end - 1e-9)
                    .cloned()
                    .collect();
                fc.observe_window(&WindowFeatures {
                    window: w,
                    net_progress: goalward_net_progress(&cal),
                    displacement: decompose_displacement(&collect_ball_track(&wf), ep.team),
                    line_spacing: line_spacing_change(&collect_shapes(&wf, ep.team)),
                    support_frames: wf
                        .iter()
                        .filter(|(_, sn)| {
                            support_formation(sn, ep.team)
                                .map(|f| f.supporters > 0)
                                .unwrap_or(false)
                        })
                        .count(),
                    snap_frames: wf.len(),
                });
                let _ = (&ball, &shapes);
            }
        }
        let p = build_provenance("test", 1, 1, DUR);
        to_markdown(&p, &cov, &ms.home, &fc, &[], (0.0, 0.0, 0.0))
    };
    let a = build();
    let b = build();
    assert_eq!(a, b, "同输入两次运行必须逐字节相同");
    assert!(a.contains("P16"), "产物应含标题");
}

/// **provenance 必含可比性三件套**（design §2.3 / spec「口径写进产物」）。
///
/// - `caliber_version`（本 change 的口径版本）；
/// - `engine_source_fingerprint`（哪份源码）；
/// - `has_state_snapshots`（**G1 是否生效**——`sidecar_schema_fingerprint` 对结构体
///   字段是盲区，区分不了有无位置快照，故必须另记这一栏）。
#[test]
fn provenance_carries_the_comparability_triple() {
    let p = build_provenance("canary", 1, 30, DUR);
    let json = provenance_json(&p);
    let md = provenance_markdown(&p);
    for needle in [
        "caliber_version",
        "test_source_fingerprint",
        "engine_source_fingerprint",
        "has_state_snapshots",
        "sidecar_schema_fingerprint",
        "source_commit",
    ] {
        assert!(json.contains(needle), "provenance JSON 缺 `{needle}`：{json}");
        assert!(md.contains(needle), "provenance Markdown 缺 `{needle}`");
    }
    // `has_state_snapshots` 必须是**真**（本 change 开了 G1）。
    assert!(
        p.has_state_snapshots,
        "本 change 开了位置导出，`has_state_snapshots` 必须为真"
    );
    // JSON 里该 bool 用字符串形（极简 JSON 无 bool 变体），键与值都在。
    assert!(
        json.contains("has_state_snapshots"),
        "JSON 缺 has_state_snapshots 键：{json}"
    );
    assert!(
        json.contains("true"),
        "JSON 里 has_state_snapshots 的值应为 true：{json}"
    );
    // 引擎指纹必须覆盖 rng.rs 等全部仿真源（与 P17A 同判据）。
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut on_disk: Vec<String> = std::fs::read_dir(&src)
        .expect("读 engine/src 失败")
        .filter_map(|e| {
            let n = e.ok()?.file_name().to_string_lossy().to_string();
            n.ends_with(".rs").then_some(n)
        })
        .collect();
    on_disk.sort();
    let covered: Vec<&str> = ENGINE_SOURCES.iter().map(|(n, _)| *n).collect();
    for f in &on_disk {
        if f == "wasm.rs" {
            continue; // 平台垫片，不进本测试的编译单元（与 P17A 同处置）
        }
        assert!(
            covered.contains(&f.as_str()),
            "`engine/src/{f}` 影响仿真却不在 P16 的指纹清单里 → 改它时两产物会静默不可比"
        );
    }
    assert!(covered.contains(&"rng.rs"), "指纹必须覆盖 rng.rs");
    // **独立重建**：自己从磁盘读、自己拼哈希（防「实现返回常数」）。
    let mut combined = String::new();
    for (name, _) in ENGINE_SOURCES {
        combined.push_str(name);
        combined.push('\n');
        combined.push_str(&std::fs::read_to_string(src.join(name)).expect("读源码失败"));
        combined.push('\n');
    }
    let rebuilt = format!("fnv1a64:{:016x}", fnv1a(&combined));
    assert_eq!(
        rebuilt,
        engine_source_fingerprint(),
        "指纹必须可由「磁盘源码 + 同配方」独立重建——不符说明实现返回了常数或漏了文件"
    );
    // 且指纹**对内容敏感**（改一个字节就变）。
    let mutated = format!("{}x", combined);
    assert_ne!(
        format!("fnv1a64:{:016x}", fnv1a(&mutated)),
        engine_source_fingerprint(),
        "指纹对内容不敏感——守卫失去意义"
    );
}

/// **`sidecar_schema_fingerprint` 与 P17A 一致**——P16 只**取用**它，不改动它的语义。
///
/// ⚠️ 这条正是「新增结构体字段不进指纹」的**证据**：本 change 加了
/// `DiagnosticMatch.state_snapshots`，若指纹变了，P17A 已落盘产物会全部陈旧。
#[test]
fn p16_does_not_change_the_p17a_schema_fingerprint() {
    let p = build_provenance("test", 1, 1, DUR);
    // P17A 的冻结值：由 `tests/p17a/model.rs` 的同配方算出（闭集枚举 ALL 的顺序敏感哈希）。
    // 这里**只断言它非空且形如 fnv1a64**，并把值打印出来供与 P17A 产物人工比对——
    // 硬编码一个期望值会让「P17A 侧合法改枚举」时本测试误红（那是 P17A 的事，不是 P16 的）。
    // `source_commit` 不得是 unknown（独立审阅 P2-1：它无哨兵会漂）。
    // 落盘门里断言真值；这里断言**配方**在（`P16_SOURCE_COMMIT` 由跑法传入）。
    let _ = &p.source_commit;
    // **测试源码指纹必须有判别力**：它是补 `engine_source_fingerprint` 盲区的那一半。
    let fp = test_source_fingerprint();
    assert!(fp.starts_with("fnv1a64:"), "测试源码指纹格式不对：{fp}");
    assert_eq!(fp, p.test_source_fingerprint, "provenance 里的指纹须与当前源码一致");
    // 内容敏感：改一个字节就变。
    let mut combined = String::new();
    for (name, text) in TEST_SOURCES {
        combined.push_str(name);
        combined.push('\n');
        combined.push_str(text);
        combined.push('\n');
    }
    assert_ne!(
        format!("fnv1a64:{:016x}", fnv1a(&format!("{combined}x"))),
        fp,
        "测试源码指纹对内容不敏感——守卫失去意义"
    );
    assert!(
        p.sidecar_schema_fingerprint.starts_with("fnv1a64:"),
        "指纹格式应为 fnv1a64:…，实测 {}",
        p.sidecar_schema_fingerprint
    );
    println!(
        "P16 产物记录 sidecar_schema_fingerprint = {}（应与 P17A 产物同值——本 change 未改闭集枚举）",
        p.sidecar_schema_fingerprint
    );
}

/// **口径常量快照必须列出真正驱动判据的量**（本仓 P17A 的教训：曾把**死常量**写进快照）。
///
/// 判别力：若有人把 `WINDOW_SECONDS` 从快照里删掉，本测试红——那时 reviewer 就无法
/// 从产物核对窗口长度，而它正是 Slice 3 的唯一可调参数。
#[test]
fn provenance_caliber_snapshot_lists_the_live_constants() {
    let p = build_provenance("test", 1, 1, DUR);
    let names: Vec<&str> = p.caliber.iter().map(|(k, _)| *k).collect();
    for need in [
        "window_seconds",
        "support_max_dist_m",
        "support_min_forward_m",
        "pitch_length_m",
        "pitch_width_m",
    ] {
        assert!(
            names.contains(&need),
            "口径快照缺 `{need}`（它是驱动判据的活常量）——当前：{names:?}"
        );
    }
    // 且这些常量确实是**活**的（改它们会改变特征输出）。
    assert!(crate::features::WINDOW_SECONDS > 0.0);
    assert!(crate::features::SUPPORT_MAX_DIST_M > 0.0);
}

/// **落盘产物必须与当前源码同源**——否则产物是陈旧证据（本仓 P17A 的
/// `on_disk_artifacts_share_one_provenance_block` 同类守卫）。
///
/// 判据：`target/p16-baseline/*.md` 里的 `test_source_fingerprint` 必须等于
/// **当前源码**算出的值。产物落后于源码（改了 `tests/p16/*` 却没重跑产物门）
/// 时本测试红——这正补上 `engine_source_fingerprint` 对测试文件的盲区。
///
/// 产物不存在时**跳过**（新克隆的 worktree 未跑过产物门，不该红）——
/// 跑法见模块头（`--ignored --nocapture p16_canary`）。
#[test]
fn on_disk_artifacts_share_the_current_source_fingerprint() {
    let dir = out_dir();
    let current = test_source_fingerprint();
    let mut checked = 0usize;
    for mode in ["canary", "baseline"] {
        let path = dir.join(format!("{mode}.md"));
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue; // 未跑过产物门 → 跳过
        };
        assert!(
            text.contains(&current),
            "落盘产物 `{}` 的 `test_source_fingerprint` 与**当前源码**不符——\
             产物是陈旧的（改了 `tests/p16/*` 之后没重跑产物门）。\
             重跑：`P16_SOURCE_COMMIT=$(git rev-parse HEAD) cargo test --release \
             --test p16_spatial_features -- --ignored --nocapture`。当前源码指纹 = {current}",
            path.display()
        );
        checked += 1;
    }
    if checked == 0 {
        println!("未发现落盘产物 → 跳过（新 worktree 的正常状态）");
    } else {
        println!("核过 {checked} 份产物，均与当前源码同源（{current}）");
    }
}

/// **`#[ignore]` 门：canary 产物落盘**（30 seed）。用
/// `cargo test --release --test p16_spatial_features -- --ignored --nocapture p16_canary` 跑。
#[test]
#[ignore = "30 seed × 90 分钟；显式跑：--release -- --ignored --nocapture p16_canary"]
fn p16_canary() {
    let (_, r, p) = run_and_write("canary", 1, 30);
    assert_ne!(
        p.source_commit, "unknown",
        "产物门须传 `P16_SOURCE_COMMIT=$(git rev-parse HEAD)`——否则 provenance 里的 commit 无意义"
    );
    assert_eq!(r.episodes, r.start_available, "起点位置必须 100% 可得");
    assert!(r.windows > 500, "窗口数过少：{}", r.windows);
    println!("[p16:canary] caliber_version={}", p.caliber_version);
}

/// **`#[ignore]` 门：300 seed 基线产物**（与 P17A 同区间，供前后对比）。
#[test]
#[ignore = "300 seed × 90 分钟；显式跑：--release -- --ignored --nocapture p16_baseline"]
fn p16_baseline() {
    let (_, r, _p) = run_and_write("baseline", 1, 300);
    assert_eq!(r.episodes, r.start_available, "起点位置必须 100% 可得");
}

/// 一次产物运行的统计摘要（供上面的门断言）。
#[derive(Debug, Clone, Default)]
pub struct RunSummary {
    pub episodes: usize,
    pub start_available: usize,
    pub windows: usize,
}

/// 跑一个 seed 区间，落盘 JSON + Markdown，返回 (路径, 摘要, provenance)。
pub fn run_and_write(
    mode: &str,
    first: u64,
    last: u64,
) -> (std::path::PathBuf, RunSummary, Provenance) {
    let mut cov = CaliberCoverage::default();
    let mut shape_cov = ShapeCoverage::default();
    let mut feat_cov = FeatureCoverage::default();
    let mut all_feats: Vec<(usize, EpisodeFeature)> = Vec::new();
    let mut all_refs: std::collections::BTreeMap<&'static str, Vec<usize>> = Default::default();
    let mut offset = 0usize;
    for seed in first..=last {
        let dm = observe(seed);
        cov.observe_match(&dm);
        let ms = MatchShape::observe_match(&dm);
        // 合并主队覆盖（客队同量级，产物只列一队；两队都记在 JSON 里会更全，但摘要取主队）。
        shape_cov.frames += ms.home.frames;
        shape_cov.computable += ms.home.computable;
        for (k, v) in &ms.home.missing_reasons {
            *shape_cov.missing_reasons.entry(k).or_insert(0) += v;
        }
        for (k, v) in &ms.home.in_episode {
            *shape_cov.in_episode.entry(k).or_insert(0) += v;
        }
        let feats = episode_features(&dm);
        // ⚠️ offset 必须走 **`possession_episodes` 的下标空间**（参考集的下标就是它），
        // 而不是「有 caliber 的 episode 数」——二者只在「每个 episode 都有 caliber」时相等。
        // 若将来有 episode 缺起点，用 `feats.len()` 会让下一 seed 的标签与本 seed 高位**重叠**
        // （正是本 change 栽过两次的同类 join bug）。故断言两者相等，不等即红。
        assert_eq!(
            feats.len(),
            dm.possession_episodes.len(),
            "`episode_features` 跳过了缺 caliber 的 episode——此时 offset 必须改成 \
             `dm.possession_episodes.len()`，否则参考集标签会跨 seed 重叠（join bug 复发）"
        );
        let local_count = dm.possession_episodes.len();
        for m in REFERENCE_MOTIFS {
            all_refs
                .entry(m.name)
                .or_default()
                .extend(
                    reference_sets(&dm)
                        .iter()
                        .find(|(nm, _)| *nm == m.name)
                        .map(|(_, v)| v.clone())
                        .unwrap_or_default()
                        .into_iter()
                        .map(|i| i + offset),
                );
        }
        // 逐 episode 的特征覆盖
        for ep in &dm.possession_episodes {
            let Some(cal) = caliber_of(&dm, ep) else { continue };
            let end = ep.end_t.map(|t| t.value);
            let frames: Vec<(f64, StateSnapshot)> = dm
                .state_snapshots
                .iter()
                .filter(|s| {
                    s.t.value + 1e-9 >= ep.start_t.value
                        && end.map(|e| s.t.value <= e + 1e-9).unwrap_or(false)
                })
                .map(|s| (s.t.value, s.clone()))
                .collect();
            for w in windows_over((ep.start_t.value, end), 0.0) {
                let wf: Vec<(f64, StateSnapshot)> = frames
                    .iter()
                    .filter(|(t, _)| *t + 1e-9 >= w.start && *t < w.end - 1e-9)
                    .cloned()
                    .collect();
                feat_cov.observe_window(&WindowFeatures {
                    window: w,
                    // 净推进是**逐 episode** 的量（复用位置口径），在每个窗口里重复报告——
                    // 它是「这条 episode 净推进了多少」，不是窗口级的。
                    net_progress: goalward_net_progress(&cal),
                    displacement: decompose_displacement(&collect_ball_track(&wf), ep.team),
                    line_spacing: line_spacing_change(&collect_shapes(&wf, ep.team)),
                    support_frames: wf
                        .iter()
                        .filter(|(_, sn)| {
                            support_formation(sn, ep.team)
                                .map(|f| f.supporters > 0)
                                .unwrap_or(false)
                        })
                        .count(),
                    snap_frames: wf.len(),
                });
            }
        }
        all_feats.extend(feats.into_iter().map(|(i, f)| (i + offset, f)));
        offset += local_count;
    }

    // gate 行：**去时长混淆后的判据**（不是每档的最强「未归一」特征——那受时长混淆）。
    let by_rate = |set: &str| -> Vec<f64> {
        let ids: std::collections::BTreeSet<usize> = all_refs
            .get(set)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .collect();
        all_feats
            .iter()
            .filter(|(i, _)| ids.contains(i))
            .filter_map(|(_, e)| Some(e.forward_m? / e.duration_s?))
            .collect()
    };
    let mut gate_rows: Vec<(String, String, f64, usize, usize)> = Vec::new();
    let ft = by_rate("final_third_candidate");
    let other: Vec<f64> = all_feats
        .iter()
        .filter(|(i, _)| {
            !all_refs
                .get("final_third_candidate")
                .map(|v| v.contains(i))
                .unwrap_or(false)
        })
        .filter_map(|(_, e)| Some(e.forward_m? / e.duration_s?))
        .collect();
    if let Some(a) = auc(&ft, &other) {
        gate_rows.push((
            "final_third vs 其余".to_string(),
            "forward_m/s".to_string(),
            a,
            ft.len(),
            other.len(),
        ));
    }
    let bu = by_rate("build_up_candidate");
    let pr = by_rate("progression_candidate");
    if let Some(a) = auc(&bu, &pr) {
        gate_rows.push((
            "build_up vs progression".to_string(),
            "forward_m/s".to_string(),
            a,
            bu.len(),
            pr.len(),
        ));
    }
    // 时长混淆的**记录**（如实写进产物）。
    let med = |v: &mut Vec<f64>| -> f64 {
        if v.is_empty() {
            return 0.0;
        }
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v[v.len() / 2]
    };
    let (db, dp, df) = (
        med(&mut all_feats.iter().filter(|(i,_)| all_refs.get("build_up_candidate").map(|v| v.contains(i)).unwrap_or(false)).filter_map(|(_,e)| e.duration_s).collect()),
        med(&mut all_feats.iter().filter(|(i,_)| all_refs.get("progression_candidate").map(|v| v.contains(i)).unwrap_or(false)).filter_map(|(_,e)| e.duration_s).collect()),
        med(&mut all_feats.iter().filter(|(i,_)| all_refs.get("final_third_candidate").map(|v| v.contains(i)).unwrap_or(false)).filter_map(|(_,e)| e.duration_s).collect()),
    );

    let provenance = build_provenance(mode, first, last, DUR);
    let summary = RunSummary {
        episodes: cov.episodes,
        start_available: cov.start_available,
        windows: feat_cov.windows,
    };
    let dir = out_dir();
    std::fs::create_dir_all(&dir).expect("创建产物目录失败");
    let md = to_markdown(&provenance, &cov, &shape_cov, &feat_cov, &gate_rows, (db, dp, df));
    let json = format!(
        "{},\"caliber_coverage\":{},\"feature_coverage\":{}}}",
        provenance_json(&provenance).trim_end_matches('}'),
        obj(&[
            ("episodes", J::Int(cov.episodes as i64)),
            ("start_available", J::Int(cov.start_available as i64)),
            ("end_available", J::Int(cov.end_available as i64)),
            ("band_disagreement", J::Int(cov.band_disagreement as i64)),
            ("band_comparable", J::Int(cov.band_comparable as i64)),
        ]),
        obj(&[
            ("windows", J::Int(feat_cov.windows as i64)),
            ("win_net_progress", J::Int(feat_cov.win_net_progress as i64)),
            ("win_displacement", J::Int(feat_cov.win_displacement as i64)),
            ("win_line_spacing", J::Int(feat_cov.win_line_spacing as i64)),
            ("win_support", J::Int(feat_cov.win_support as i64)),
        ]),
    );
    let md_path = dir.join(format!("{mode}.md"));
    let json_path = dir.join(format!("{mode}.json"));
    std::fs::write(&md_path, md).expect("写 Markdown 失败");
    std::fs::write(&json_path, json).expect("写 JSON 失败");
    println!(
        "[p16:{mode}] {} seed / {} episode / {} 窗口 | 落盘 {} / {}",
        last - first + 1,
        summary.episodes,
        summary.windows,
        md_path.display(),
        json_path.display()
    );
    (md_path, summary, provenance)
}

// ============================== 口径：起点来源 ==============================

/// **起点取自 `ControlFact.location`，不取决策动作的 `Event.x`。**
///
/// 断言输入对目标变异有区分度：起点事实位置 (0.2, 0.5) 与首个决策动作位置 (0.5, 0.5)
/// **落在不同的推进带**（back vs mid）——把实现换成「读 `Event.x`」时本断言必红。
#[test]
fn caliber_start_comes_from_control_fact_not_action_position() {
    let dm = fixture((0.2, 0.5), &[], None).dm();
    let c = caliber_of(&dm, &dm.possession_episodes[0]).expect("口径应可导出");
    assert_eq!(
        c.start,
        (0.2, 0.5),
        "起点必须取 control_established.location（0.2,0.5），\
         而不是首个决策动作的 Event.x（0.5,0.5）——两者在不同推进带，本断言对该变异有区分度"
    );
    assert_eq!(c.start_progress, 0.2);
    assert_eq!(progress_band(c.start_progress), "back");

    // 反证条：对照口径（被禁的那个）确实落在**不同带**。若它恰好同带，
    // 上面那条断言就失去判别力——本反证条保证「有区分度」这个前提成立。
    let forbidden = forbidden_first_action_progress(&dm, &dm.possession_episodes[0])
        .expect("fixture 应有首个决策动作");
    assert_eq!(
        progress_band(forbidden),
        "mid",
        "反证条：被禁口径必须落在与事实口径**不同**的推进带，否则上一条断言无判别力"
    );
}

/// **守卫的判别力**：对实现的**定向变异**必须使断言变红。
///
/// 本测试不依赖源码文本，而是直接在 [`EpisodeCaliber`] 上构造变异体：
/// 把起点换成「首个决策动作的位置」后，`caliber_start_comes_from_control_fact_not_action_position`
/// 的核心断言（`c.start == (0.2,0.5)` 且 band == "back"）必然不成立。
/// 这排除了「守卫是恒真断言」的可能——本仓 P36/P17A 的教训。
#[test]
fn caliber_guard_has_discriminating_power() {
    let dm = fixture((0.2, 0.5), &[], None).dm();
    let ep = &dm.possession_episodes[0];
    let good = caliber_of(&dm, ep).expect("口径应可导出");
    let forbidden_x = forbidden_first_action_progress(&dm, ep).expect("fixture 应有首个决策动作");

    // 变异体：起点改用被禁口径。
    let mutated = EpisodeCaliber {
        start: (forbidden_x, 0.5),
        start_progress: forbidden_x,
        ..good.clone()
    };

    let good_band = progress_band(good.start_progress);
    let mutated_band = progress_band(mutated.start_progress);
    assert_ne!(
        good_band, mutated_band,
        "变异体（起点改用决策动作位置）必须落在不同推进带——否则守卫对该变异无区分度"
    );
    assert_ne!(
        good.start, mutated.start,
        "变异体与正确实现的起点位置必须不同"
    );
}

// ============================== 口径：终点的同源与「不猜」 ==============================

/// **起止同源**：终点取的是 `ControlFact` 的位置（与起点同一字段族），且**不借用起点**。
#[test]
fn caliber_end_is_same_source_and_never_borrows_the_start() {
    // ① 有收束侧事实（contest_started 带位置）→ 终点取它，**不是**起点、也不是中途位置。
    let dm = fixture(
        (0.2, 0.5),
        &[(0.4, 0.5)],
        Some((ControlFactKind::ContestStarted, (0.71, 0.3))),
    )
    .dm();
    let c = caliber_of(&dm, &dm.possession_episodes[0]).expect("口径应可导出");
    assert_eq!(
        c.end,
        Some((0.71, 0.3)),
        "终点必须取收束侧事实（contest_started）的位置，而不是起点 (0.2,0.5) \
         或中途控制 (0.4,0.5)"
    );
    assert_eq!(c.end_fact_kind, Some(ControlFactKind::ContestStarted));
    assert!(c.end_fact_at_close, "contest_started 与 end_t 同刻，应标记为收束侧事实");
    assert_eq!(c.net_progress(), Some(0.51));

    // ② 无带位置的收束侧事实（死球路径）→ **退回窗内最后一条带位置的事实**，
    //    仍与起点同源（都是 ControlFact.location），且**不退回起点本身**。
    let dm = fixture((0.2, 0.5), &[(0.62, 0.5)], None).dm();
    let c = caliber_of(&dm, &dm.possession_episodes[0]).expect("口径应可导出");
    assert_eq!(
        c.end,
        Some((0.62, 0.5)),
        "死球收束时取窗内最后一条带位置的事实（中途 control_established），不退回起点"
    );
    assert_ne!(c.end, Some(c.start), "终点不得等于起点");
    assert_eq!(c.end_fact_kind, Some(ControlFactKind::ControlEstablished));
    assert!(!c.end_fact_at_close, "该事实不在 end_t 同刻，须如实标记");

    // ③ 连中途事实都没有 + 死球收束 → 终点位置**不可得**（`None`），**不猜**。
    let dm = fixture((0.2, 0.5), &[], None).dm();
    let c = caliber_of(&dm, &dm.possession_episodes[0]).expect("口径应可导出");
    assert_eq!(
        c.end, None,
        "收束侧事实不可得时必须给 None——不得退回起点、不得取动作位置、不得插值"
    );
    assert_eq!(c.end_progress, None);
    assert_eq!(c.net_progress(), None, "终点口径不可用时净推进必须为 None，不用 0.0 伪造");
    assert_eq!(c.progress_span(), None);
    // 起点本身仍可用——口径是**逐字段**的，不因终点缺失而整体作废。
    assert_eq!(c.start, (0.2, 0.5));
    assert!(c.has_end_t, "本 fixture 的 episode 有 end_t（只是收束侧无位置）");
}

/// **不跨 episode 边界**：终点搜索的下界是本 episode 首条事实下标，不会读到上一个 episode 的位置。
///
/// 这条是「下标下界」相对「时间下界」的判别力所在：fixture 里造两个 episode，
/// 前一个的收束事实与后一个的起点事实**同刻**；若实现只按时间过滤，就会跨过去读到另一个 episode。
#[test]
fn caliber_never_reads_across_episode_boundaries() {
    // 场景 A（**生产可达形状**：死球 → 重开准备 → 更晚的首次控制）。ep0 在 t=20 以死球收束
    // （`dead_ball_started` 不带位置），下一个 episode 在 t=40 开启于 (0.9, 0.9)。
    // ep0 的终点**不得**读到 (0.9, 0.9)——那属于下一个 episode。
    //
    // 这条断言的**判别力**：把 `closing_fact` 的回退分支去掉时间上界
    // （只保留「下标 > 起点事实、有 location、取最后一条」）时，它会取到 t=40 的 (0.9,0.9) → 红。
    let mut f = fixture((0.2, 0.5), &[(0.62, 0.5)], None);
    f.push_episode(1, 40.0, (0.9, 0.9));
    let dm = f.dm();
    let c0 = caliber_of(&dm, &dm.possession_episodes[0]).expect("口径应可导出");
    assert_eq!(
        c0.end,
        Some((0.62, 0.5)),
        "ep1 的终点应取自己窗内最后一条带位置的事实，不得跨到 ep2 的起点 (0.9,0.9)"
    );
    assert_ne!(c0.end, Some((0.9, 0.9)), "终点不得读到下一个 episode 的起点事实");

    // 场景 B：**同刻交接**（生产可达：`saved_caught` / 争抢收束后 `advance_loose` 的 pickup）。
    // 上一个 episode 与下一个 episode 的边界为同一个 `t`——
    // 此刻那条 `control_established` **就是** ep1 的收束事实（引擎在同一 `t` 里
    // 先 `close_episode` 再 `open_new_episode`，见 `observation.rs`），
    // 因此它**应当**被取到。这条与场景 A 一起界定「不跨边界」的准确含义：
    // 不读**下一个 episode 的内部**，但**要**读落在 `end_t` 上的收束事实。
    let mut g = fixture((0.2, 0.5), &[], None);
    // ep1 的 end_t 是死球时刻（10.0）；把交接事实放在**同一时刻**。
    let t = 10.0;
    g.facts.push(fact(
        t,
        ControlFactKind::ControlEstablished,
        Some(TeamId::Home),
        Some((0.55, 0.4)),
        ControlFactBasis::FinalizedOutcome,
        None,
    ));
    let first = g.facts.len() - 1;
    g.episodes.push(PossessionEpisode {
        id: 1,
        team: TeamId::Home,
        start_t: ObservedTime::state_commit(t),
        end_t: Some(ObservedTime::state_commit(t)),
        start_reason: EpisodeStartReason::SuccessfulReceive,
        end_reason: Some(EpisodeEndReason::ControlLost),
        control_fact_indexes: vec![first],
        event_indexes: vec![],
    });
    let dm = g.dm();
    let c0 = caliber_of(&dm, &dm.possession_episodes[0]).expect("口径应可导出");
    assert_eq!(
        c0.end,
        Some((0.55, 0.4)),
        "同刻交接的那条事实**就是** ep1 的收束侧事实，应当取到（不跨边界 ≠ 不取同刻事实）"
    );
    assert!(c0.end_fact_at_close, "它与 end_t 同刻，须如实标记");

    // 场景 C：**没有**收束侧位置事实且窗内也没有别的带位置事实 → `None`（不猜、不退回起点）。
    let dm = fixture((0.2, 0.5), &[], None).dm();
    let c0 = caliber_of(&dm, &dm.possession_episodes[0]).expect("口径应可导出");
    assert_eq!(
        c0.end, None,
        "起点事实的下标下界使它不会被当成终点；窗内无其他带位置事实 → None"
    );
}

/// **同刻取「最早一条」的审计纪律**：`t == end_t` 上有多条带位置事实时，
/// 取**最早**那条——它是本 episode 的收束提交序列的**族首**；**最后**那条往往是
/// **下一个 episode 的开启事实**。
///
/// 这条守卫存在的理由：两种取法的**位置值实测完全一致**（`end_t` 上 4057 次并列，
/// 位置分歧 0 次），因此上面那些基于位置的断言**抓不到**这个变异（已实测：把 `find`
/// 换成 `filter(..).last()` 全套仍绿）。差异只在**审计栏** `end_fact_kind`——
/// 它决定报告里「终点取的哪类事实」这句话对不对。故本测试**直接断言 `end_fact_kind`**。
///
/// ⚠️ **fixture 必须造生产可达的序列**（本仓「fixture 入参必须生产可达」的教训）：
/// 真实路径上，从 `Controlled` 态进争抢时 `observation.rs` 的 `contest_started`
/// **必先** push `ControlReleased` **再** push `ContestStarted`（同 `t` 同 `location`），
/// 故族首是 **`control_released`** 而不是 `contest_started`（实测 100 seed：
/// `control_released` 1587 条 / `contest_started` 3103 条）。旧版 fixture 省掉了那条
/// 前置事实，是**生产不可达**的形状。
#[test]
fn caliber_closing_fact_tie_break_names_the_episode_closing_fact() {
    // 生产可达形状（从 Controlled 进争抢 → 随后 advance_loose 的 pickup 开启下一条）
    let mut f = fixture((0.2, 0.5), &[], None);
    let t = 10.0;
    // 本 episode 的收束提交序列：release 在前、contest 在后（同 t 同 location）
    f.facts.push(fact(
        t,
        ControlFactKind::ControlReleased,
        Some(TeamId::Home),
        Some((0.66, 0.33)),
        ControlFactBasis::EngineState,
        None,
    ));
    f.facts.push(fact(
        t,
        ControlFactKind::ContestStarted,
        Some(TeamId::Home),
        Some((0.66, 0.33)),
        ControlFactBasis::FinalizedOutcome,
        Some(ControlFactDetail::ContestStart(ContestStartReason::PassLost)),
    ));
    // 下一个 episode 的开启事实：**位置刻意不同**，好让「取错了」能被位置断言抓到
    f.facts.push(fact(
        t,
        ControlFactKind::ControlEstablished,
        Some(TeamId::Home),
        Some((0.95, 0.95)),
        ControlFactBasis::EngineState,
        None,
    ));
    f.episodes[0].end_reason = Some(EpisodeEndReason::ControlLost);
    let dm = f.dm();
    let c = caliber_of(&dm, &dm.possession_episodes[0]).expect("口径应可导出");

    assert_eq!(
        c.end_fact_kind,
        Some(ControlFactKind::ControlReleased),
        "同刻有多个带位置事实时必须取**最早**那条（收束提交序列的族首 = control_released），\
         而不是最后那条（下一个 episode 的开启事实 control_established）"
    );
    assert_eq!(
        c.end,
        Some((0.66, 0.33)),
        "位置取族首那条——不得是下一条 episode 的 (0.95,0.95)"
    );
    assert_ne!(c.end, Some((0.95, 0.95)), "终点不得跨到下一个 episode");
    assert!(c.end_fact_at_close);
}

// ============================== 口径：方向归一 ==============================

/// 方向归一是**跨队可比**的前提：主队攻 x=1、客队攻 x=0，不做归一就池化会得到无意义的值。
#[test]
fn progress_normalizes_direction_per_team() {
    // 主队：x 即推进度。
    assert_eq!(progress(0.0, TeamId::Home), 0.0);
    assert_eq!(progress(1.0, TeamId::Home), 1.0);
    // 客队：x=0 是客队的**对方**球门线（主队球门），故推进度 1。
    assert_eq!(progress(0.0, TeamId::Away), 1.0);
    assert_eq!(progress(1.0, TeamId::Away), 0.0);
    // 同一物理位置在两队眼里推进度相反——这正是必须归一的原因。
    assert_eq!(progress(0.2, TeamId::Home) + progress(0.2, TeamId::Away), 1.0);
    assert_eq!(attack_dir(TeamId::Home), 1.0);
    assert_eq!(attack_dir(TeamId::Away), -1.0);

    // 带的分界（1/3、2/3）在归一后的语义上一致：两队「本方后场」都落在 back。
    assert_eq!(progress_band(progress(0.1, TeamId::Home)), "back");
    assert_eq!(progress_band(progress(0.9, TeamId::Away)), "back");
    assert_eq!(progress_band(progress(0.9, TeamId::Home)), "front");
    assert_eq!(progress_band(progress(0.1, TeamId::Away)), "front");
}

// ============================== 门球放大器（记录在案） ==============================

/// 门球占比与落点区间**必须与记录在案的常量一致**。
///
/// 这不是「判据」，是**记录**（design §2.2）：门球落点恒过半场是「用首个决策动作当位置」
/// 时把后场开局记成中场开局的主要放大源。引擎改变重开分布时本门会红，
/// 那时须复核放大器还成不成立并更新常量与文档。
#[test]
fn goal_kick_amplifier_matches_the_pinned_share() {
    let mut restarts: std::collections::BTreeMap<&'static str, usize> = Default::default();
    let mut goal_kick_lands: Vec<f64> = Vec::new();
    let (first, last) = QUICK_SEEDS;
    for seed in first..=last {
        let dm = observe(seed);
        for r in &dm.restart_sequences {
            *restarts.entry(r.kind.as_str()).or_insert(0) += 1;
        }
        goal_kick_lands.extend(observe_goal_kick_lands(&dm));
    }
    let total: usize = restarts.values().sum();
    assert!(total > 0, "10 seed 内一条重开都没有？样本或口径有问题");
    let gk = *restarts.get("goal_kick").unwrap_or(&0);
    let share = gk as f64 / total as f64;
    assert!(
        (share - GOAL_KICK_RESTART_SHARE).abs() < 0.05,
        "门球占重开比例 {share:.3} 偏离记录在案的 {GOAL_KICK_RESTART_SHARE:.3} 超过 5 个百分点：\
         引擎的重开分布变了 → 须复核 design §2.2 的放大器结论并更新常量"
    );

    assert!(!goal_kick_lands.is_empty(), "应能观测到门球交付的落点");
    let lo = goal_kick_lands.iter().cloned().fold(f64::INFINITY, f64::min);
    let hi = goal_kick_lands.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    assert!(
        lo >= GOAL_KICK_LAND_PROGRESS.0 - 1e-9 && hi <= GOAL_KICK_LAND_PROGRESS.1 + 1e-9,
        "门球落点（方向归一）实测区间 [{lo:.3}, {hi:.3}] 必须落在记录在案的 \
         {GOAL_KICK_LAND_PROGRESS:?} 内——`fn goal_kick_land` 的落点钳位变了"
    );
    // 放大器机制的**直接证据**：门球落点全部 ≥ 0.5（恒过半场）。
    assert!(
        goal_kick_lands.iter().all(|p| *p >= 0.5 - 1e-9),
        "门球落点必须恒过半场（归一后 ≥ 0.5）——这正是「后场开局被记成中场开局」的放大源"
    );
}

// ============================== 覆盖率（真实路径下限） ==============================

/// 真实 seed 上的口径覆盖率：起点必须 100% 可得；终点覆盖率**如实报告**（不设虚高门槛）。
///
/// 只对**可辩护的下限**做断言（起点 100%、终点 > 0），其余作为**报告项**打印——
/// 把「报告项写成硬门」会在正常数据上误红（P37 交叉验证的教训）。
#[test]
fn caliber_coverage_on_a_real_seed() {
    let cov = coverage_over(QUICK_SEEDS.0, QUICK_SEEDS.1);
    println!(
        "口径覆盖率（seed {}..={}）：episodes={} 起点可得={} ({:.4}) 终点可得={} ({:.4}) \
         终点为收束侧事实={} 两口径带分歧={}/{} ({:.4})",
        QUICK_SEEDS.0,
        QUICK_SEEDS.1,
        cov.episodes,
        cov.start_available,
        cov.start_available as f64 / cov.episodes as f64,
        cov.end_available,
        cov.end_available as f64 / cov.episodes as f64,
        cov.end_at_close,
        cov.band_disagreement,
        cov.band_comparable,
        cov.band_disagreement as f64 / cov.band_comparable.max(1) as f64,
    );
    println!("起点推进带：{:?}", cov.start_bands);
    println!("终点推进带：{:?}", cov.end_bands);
    println!("收束侧事实类型：{:?}", cov.end_fact_kinds);
    println!("终点缺失（按 end_reason）：{:?}", cov.end_missing_by_reason);
    println!("起点事实 TimeBasis：{:?}", cov.start_bases);

    assert!(cov.episodes > 0, "10 seed 内没有 episode？样本或口径有问题");
    assert_eq!(
        cov.start_available, cov.episodes,
        "起点位置必须 100% 可得——`control_established` 恒带 location（实测）；\
         不为恒等说明输入形状变了，须重查口径"
    );
    assert!(
        cov.end_available > 0,
        "终点位置一条都拿不到？收束侧事实的选取有误"
    );
    // **防空转**：两口径必须有可观的分歧（否则守卫失去判别力——它会变成恒真断言）。
    // 实测（100 seed）分歧率 ≈ 0.257；这里只设一个宽松下限。
    assert!(
        cov.band_disagreement as f64 / cov.band_comparable.max(1) as f64 > 0.05,
        "两口径的推进带分歧率过低（{}/{}）——要么引擎变了，要么被禁口径的实现有误，\
         要么这条对照失去了判别力",
        cov.band_disagreement,
        cov.band_comparable
    );
}

