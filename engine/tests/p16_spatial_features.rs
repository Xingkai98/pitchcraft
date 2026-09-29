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
//! | [`caliber_coverage_on_a_real_seed`] | 覆盖率（真实路径下限） | ✅ |
//! | `p16_canary` | 产物落盘（30 seed） | ❌ `#[ignore]` |
//! | `p16_baseline` | 产物落盘（300 seed） | ❌ `#[ignore]` |
//!
//! 跑法：
//!
//! ```text
//! # 默认快速门
//! cargo test --test p16_spatial_features
//! # canary 产物
//! cargo test --release --test p16_spatial_features -- --ignored --nocapture p16_canary
//! # 300 seed 基线产物
//! P16_SOURCE_COMMIT=$(git rev-parse HEAD) \
//!   cargo test --release --test p16_spatial_features -- --ignored --nocapture p16_baseline
//! ```
//!
//! **行号引用会漂**：本文件的注释与文档一律用**符号名**（函数名 / 结构体名 / 常量名），
//! 不写 `lib.rs:NNNN`。

#[path = "p16/caliber.rs"]
mod caliber;

use caliber::*;
use fm_engine::observation::*;
use fm_engine::{simulate_with_behavior_observations, EventType, MatchConfig};

// ============================== 运行器 ==============================

const DUR: f64 = 5400.0;
/// 默认快速门用的 seed 数（覆盖 90 分钟整场，含各种收束路径）。
const QUICK_SEEDS: (u64, u64) = (1, 10);
/// canary 产物：**baseline 的前缀子集**，保证 canary 上的变化在 baseline 可见。
const CANARY_SEEDS: (u64, u64) = (1, 30);
/// 300 seed 基线（与 P17A 同区间，供前后对比）。
const BASELINE_SEEDS: (u64, u64) = (1, 300);

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
// 收束侧事实是 `contest_started` 或 `control_established`。
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
/// 取**最早**那条——它是本 episode 的收束侧事实；**最后**那条往往是**下一个 episode 的开启事实**。
///
/// 这条守卫存在的理由：两种取法的**位置值实测完全一致**（10102 条里 0 条分歧），
/// 因此上面那些基于位置的断言**抓不到**这个变异（已实测：把 `find` 换成
/// `filter(..).last()` 全套仍绿）。差异只在**审计栏** `end_fact_kind` ——
/// 它决定报告里「终点取的哪类事实」这句话对不对。故本测试**直接断言 `end_fact_kind`**。
#[test]
fn caliber_closing_fact_tie_break_names_the_episode_closing_fact() {
    // 生产可达形状（`saved_caught` / 争抢收束）：同一 `t` 上，先本 episode 的收束事实
    // （`contest_started`，带位置），紧接下一个 episode 的开启事实（`control_established`）。
    let mut f = fixture((0.2, 0.5), &[], None);
    let t = 10.0;
    // 第一个 episode 的 end_t 此刻是死球时刻 10.0（见 fixture 的 None 分支）。
    f.facts.push(fact(
        t,
        ControlFactKind::ContestStarted,
        Some(TeamId::Home),
        Some((0.66, 0.33)),
        ControlFactBasis::FinalizedOutcome,
        Some(ControlFactDetail::ContestStart(ContestStartReason::PassLost)),
    ));
    f.facts.push(fact(
        t,
        ControlFactKind::ControlEstablished,
        Some(TeamId::Home),
        Some((0.67, 0.34)),
        ControlFactBasis::EngineState,
        None,
    ));
    // 重新设定第一个 episode 的收束原因（contest 收束）
    f.episodes[0].end_reason = Some(EpisodeEndReason::ControlLost);
    let dm = f.dm();
    let c = caliber_of(&dm, &dm.possession_episodes[0]).expect("口径应可导出");

    assert_eq!(
        c.end_fact_kind,
        Some(ControlFactKind::ContestStarted),
        "同刻有两条带位置事实时必须取**最早**那条（本 episode 的收束事实 contest_started），\
         而不是最后那条（下一个 episode 的开启事实 control_established）——\
         两种取法的位置值相同，故本条**只能**靠断言 end_fact_kind 来守"
    );
    assert_eq!(
        c.end,
        Some((0.66, 0.33)),
        "位置取最早那条的（与最后那条 0.67,0.34 不同——本 fixture 刻意让两者可分）"
    );
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

