//! P15（#15A）Slice 3 集成门：把「观察 sidecar 在真实比赛路径上是否可信」这件事变成
//! **仓库内可重复**的验证。
//!
//! 背景：Slice 1/2 的关键证据此前只存在于**临时审阅 harness**（一次性脚本、跑完即删），
//! 因此每次改动都要重新搭一遍、口径也容易漂。本文件把那些证据固定成常跑的门。
//!
//! 分层（对齐 `CLAUDE.md` 的「分层验证」表）：
//!
//! | 本文件的测试 | 判据层 | 默认跑? |
//! |---|---|---|
//! | [`plain_and_opt_in_paths_agree_byte_for_byte`] | 事件流协议 | ✅ |
//! | [`sidecar_is_deterministic_for_the_same_seed_and_config`] | 事件流协议 | ✅ |
//! | [`recorder_on_and_off_reproduce_the_golden_v6_canary_stream`] | golden master | ✅ |
//! | [`terminal_state_invariants_and_closure_hold_on_the_canary_seeds`] | 观察对象不变量 | ✅ |
//! | [`restart_kind_decides_the_delivered_episode_start_reason`] | 观察对象耦合 | ✅ |
//! | [`contest_reasons_and_settlements_are_bound_to_their_own_engine_events`] | 争抢事实 ↔ 引擎事件（**接线层**） | ✅ |
//! | [`kickoff_flight_basis_separates_first_kickoff_from_a_goal_restart`] | 时间 basis ↔ 引擎飞行段（**接线层**） | ✅ |
//! | [`event_indexes_are_non_empty_monotonic_and_in_range`] | 观察对象不变量 | ✅ |
//! | [`gap_is_a_classified_outcome_not_a_failure`] | 观察对象不变量 | ✅ |
//! | [`every_gap_on_the_canary_streams_is_a_designed_truncation_not_a_defect`] | 观察对象不变量 | ✅ |
//! | [`restart_end_reasons_stay_within_the_two_reachable_ones`] | 观察对象不变量 | ✅ |
//! | [`l3_300_seed_90min_calibration_lands_evidence_on_disk`] | 校准证据 | ❌ `#[ignore]` |
//!
//! 跑法：
//!
//! ```text
//! # 默认门（cargo test 的一部分）
//! cargo test --test p15_behavior_observation
//! # 300 seed × 90 分钟校准门（debug 实测 ~110s，故不进默认路径）
//! cargo test --release --test p15_behavior_observation -- --ignored --nocapture
//! ```
//!
//! **口径纪律**（来自 design §15，勿退回）：
//!
//! - `gap_count() == 0` **只对本样本成立**，不是全称命题。终场哨落在未决飞行中途时会**合法**
//!   产 `full_time_during_ball_in_flight`（实测 seed 147 @ dur 120、seed 368 @ dur 400，
//!   触发与时长无关）。故本文件**不写**「所有 duration 均为 0」这类断言，而按**分类**断言
//!   （见 [`gap_is_a_classified_outcome_not_a_failure`]）。
//! - `event_indexes` 是**对象↔事件**的归属；因果事件的时间**可以早于** `object.start_t`
//!   （`event_emit` 早于 `state_commit`，design §15.6）。**不得**断言「事件时间落在对象时间窗内」。
//! - 事件下标允许为空**且仅允许**在「对象于流截断时刻才被创建」这一条例外上
//!   （design §15 A9-10）。
//! - 本引擎**没有中场休息**（`half_time()` 零生产调用点，design §15 A9-5）：不为它编造 fixture。
//! - **「recorder on/off 不改变 RNG」只有间接证据**（design §13 门 3 的 RNG 面）：正式事件流
//!   与 golden-v6 基线逐字节相同是**强间接**证据——决策全由 RNG 驱动，消费点一变决策就变、
//!   事件流随即不等。但**没有**任何直接观察 raw RNG 游标 / 序列的工件：比赛自己的 rng 是
//!   `match_events` 的**局部变量、函数返回即丢弃**，外部拿不到消费位置。（`SeededRng`
//!   **是**导出的——`lib.rs` 有 `pub use rng::SeededRng;`——所以「类型拿不到」**不是**理由；
//!   即使拿到类型，也只能新建一个从头开始的序列，与那场比赛无关。）**不得**把这条写成
//!   「已用 raw RNG 序列直接证明」，也不得再引入「beat 序列是 RNG 消费满射代理」这类
//!   看起来更强、实际与逐字节门完全重复的代理断言（2026-09-24 已删）。
//!
//! 与既有测试的分工：`src/observation.rs` 的单测负责**逐命令**的语义与反证；
//! 本文件负责**真实比赛路径**上的端到端形状。两者不重复断言同一件事。
//!
//! **为什么必须在这里钉「争抢原因 / 时间 basis」**（2026-09-24 补，起因见下）：
//! `src/observation.rs` 的 Slice 3 手写 fixture 是**纯 recorder 单元测试**——它们直接调用
//! `contest_started(..)` / `goal_kick_started(..)`，**从不经过 `lib.rs`**。因此 `lib.rs` 的
//! **接线变异**（提交点把 reason 传错、或换掉整条命令）对它们**完全不可见**：曾有一轮把
//! 「改 `lib.rs` 某提交点 → 某 fixture 必红」写进 fixture 的文档注释，实测为**假**（那些变异
//! 下 fixture 全绿）。真实接线只能由本文件的 opt-in 路径断言覆盖，故新增两条门：
//!
//! - [`contest_reasons_and_settlements_are_bound_to_their_own_engine_events`]：**全部 5 个**引擎
//!   可达的争抢原因（`interception_loose` / `pass_lost` / `tackle_loose` / `shot_rebound` /
//!   `delivery_loose`）各自的**引擎事件来源**（`Pass/intercepted`、`Pass/lost`、
//!   `Tackle/success`、`Shot/saved`、`Pass/contested`）、**被它关闭的 episode 的 `end_reason`**、
//!   以及**收束它的 `ContestEndReason`**（取紧邻下一条事实，避免读到别人的收束）；
//! - [`kickoff_flight_basis_separates_first_kickoff_from_a_goal_restart`]：首开球**无飞行**
//!   （`taken_t` / `open_play_resumed_t` 都是 `EventEmit` 且同刻，首个 episode 整段无
//!   `DeterministicFlightEnd`）vs 进球后开球**等飞行结束**
//!   （`open_play_resumed_t.basis == DeterministicFlightEnd`，且恢复时刻晚于 taken）。

use fm_engine::observation::{
    BehaviorControlState, ContestEndReason, ContestStartReason, ControlFactBasis,
    ControlFactDetail, ControlFactKind, DiagnosticMatch, EpisodeEndReason, EpisodeStartReason,
    RestartEndReason, RestartKind, TimeBasis,
};
use fm_engine::{
    simulate, simulate_with_behavior_observations, EventType, MatchConfig, MODEL_VERSION,
};

/// 与 `tests/realism.rs` 的 L2/golden 保持同一时长（90 分钟），使跨文件口径一致。
const DUR: f64 = 5400.0;

/// 默认门的 canary seed 集（覆盖 5 种重开方式 + 三种截断形态，见各测试注释）。
///
/// 这些 seed **不是**随便挑的：`corner` 需要 seed 1 就出现、`goal_kick` 需要 5、形态 ③
/// （`dur` 时刻已 taken 的门球）需要 157 / 317。改动本集合会让 coverage 防空转断言失效。
const CANARY_SEEDS: [u64; 10] = [1, 5, 15, 33, 86, 97, 100, 120, 157, 317];

/// 「争抢原因 ↔ 引擎事件」门的 seed 集：canary + 5 个**只为 `shot_rebound` 而加**的 seed。
///
/// `shot_rebound` 是全部 5 类被钉住的争抢原因里最稀疏的（90 分钟 300 seed 仅 35 条，canary 里
/// **只有 seed 15 出现 1 条**）。只靠那一条会让本门对「该路径整体消失」几近空转，故显式补
/// 24 / 38 / 49 / 80 / 84——它们在 300 seed 扫描里各含 1 条（实测：`shot_rebound` 出现在
/// 15, 24, 38, 49, 80, 84, …）。补到 5 个（种子集合上共 6 条）是为了给防空转下限留余量：
/// 只补 3 个的话下限会**恰好等于**实测值，任何良性缩水都会以误导性消息报红。
/// 不把 35 个 seed 全加进来，是为了把默认门的引擎模拟次数压住。
const CONTEST_SEEDS: [u64; 15] = [1, 5, 15, 33, 86, 97, 100, 120, 157, 317, 24, 38, 49, 80, 84];

/// golden-v6 的 canary seed 集，与 `tests/realism.rs::GOLDEN_SEEDS` **必须一致**
/// （那条门把当前引擎与磁盘基线绑死；本文件复用它来证明观察开关不改变正式事件流）。
const GOLDEN_SEEDS: std::ops::RangeInclusive<u64> = 1..=10;

fn cfg(dur: f64) -> MatchConfig {
    MatchConfig {
        match_duration_seconds: dur,
        demo_mode: false,
        off_ball_movement_demo: false,
        model_version: MODEL_VERSION,
    }
}

fn observed(seed: u64) -> DiagnosticMatch {
    simulate_with_behavior_observations(seed, cfg(DUR))
}

/// 正式流的尾哨时刻（流末那条 `whistle`）。多个门用它表达「流边界」。
fn tail_whistle_t(dm: &DiagnosticMatch) -> f64 {
    dm.events
        .iter()
        .rev()
        .find(|e| e.type_ == EventType::Whistle)
        .map(|e| e.t)
        .expect("正式事件流必须有尾哨（引擎循环结束后唯一一条）")
}

// ============================== 1. 逐字节一致 + 确定性 ==============================

/// **design §13 门 1**：`simulate()` 与 opt-in `events_json()` 逐字节一致。
///
/// 为什么比「字段相等」更强：`events_json` 是走 recorder 的那条路径**自己**序列化出来的流，
/// 若观察开关有任何一处改了路由（哪怕只是少 push 一条 beat），字符串立刻不等。
///
/// 判别力（目标变异必红）：在 opt-in 路径里改任何一个事件字段（如 beat 的 `speed`）→ 红。
#[test]
fn plain_and_opt_in_paths_agree_byte_for_byte() {
    for seed in [1u64, 42, 97, 544] {
        // 默认 90 分钟 + 一个短时长：短时长会走到「终场哨撞上未决飞行」的截断 regime，
        // 那是事件流形状最不一样的地方，必须也在门内。
        for dur in [DUR, 120.0] {
            let plain = simulate(seed, cfg(dur));
            let dm = simulate_with_behavior_observations(seed, cfg(dur));
            assert_eq!(
                dm.events_json(),
                plain,
                "seed {} dur {}：带观察的模拟必须与 simulate() 逐字节相同",
                seed,
                dur
            );
            // 防空转：`events_json` 必须真的序列化了事件（空流会让上面的 assert_eq 变成
            // 「两个空串相等」）。
            assert!(
                !dm.events.is_empty(),
                "seed {} dur {}：事件流为空，上面的逐字节比较是空转",
                seed,
                dur
            );
        }
    }
}

/// **design §13 门 4**：同 seed 同 config 的 sidecar 完全确定（含事实、对象、事件下标、
/// 违规列表）。
///
/// 覆盖 `events` 而不只是三个对象数组：事件下标是**指进 events 的下标**，两边 events 若不同
/// 长，只比下标数组会双双通过而掩盖错位。
#[test]
fn sidecar_is_deterministic_for_the_same_seed_and_config() {
    for seed in CANARY_SEEDS {
        let a = observed(seed);
        let b = observed(seed);
        assert_eq!(a.events_json(), b.events_json(), "seed {}：事件流", seed);
        assert_eq!(a.control_facts, b.control_facts, "seed {}：事实", seed);
        assert_eq!(
            a.possession_episodes, b.possession_episodes,
            "seed {}：episode（含事件下标）",
            seed
        );
        assert_eq!(
            a.restart_sequences, b.restart_sequences,
            "seed {}：restart（含事件下标）",
            seed
        );
        assert_eq!(a.state, b.state, "seed {}：终态", seed);
        assert_eq!(
            a.invariant_violations, b.invariant_violations,
            "seed {}：违规列表",
            seed
        );
    }
}

/// **design §13 门 3**：观察开关**不改变正式事件流**——用 golden-v6 的正式基线做外部锚。
///
/// 与 [`plain_and_opt_in_paths_agree_byte_for_byte`] 的分工：那条是「两条路径互相比」，
/// 理论上可以被「两边都错成一样」骗过；这条把结果**锚到磁盘上的 golden**（`tests/golden-v6/`，
/// 由 `tests/realism.rs::gm_canary_seeds` 维护），因此是独立来源的对照。
///
/// golden 的 `stream_hash` 是 FNV-1a(事件流 JSON)，与 `events_json()` 同一份字符串，
/// 故这里用同一个哈希函数复算，断言与基线一致。
fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    h
}

fn golden_hash(seed: u64) -> u64 {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("tests/golden-v{MODEL_VERSION}/seed-{}.json", seed));
    let content = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("读不到 golden 基线 {}：{}", path.display(), e));
    // 手写提取，避免为测试引入 JSON 依赖（与 realism.rs 同风格）。
    let key = "\"stream_hash\":";
    let at = content
        .find(key)
        .unwrap_or_else(|| panic!("golden {} 缺少 stream_hash 字段", path.display()));
    content[at + key.len()..]
        .trim_start()
        .split(|c: char| !c.is_ascii_digit())
        .next()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or_else(|| panic!("golden {} 的 stream_hash 解析失败", path.display()))
}

#[test]
fn recorder_on_and_off_reproduce_the_golden_v6_canary_stream() {
    for seed in GOLDEN_SEEDS {
        let expected = golden_hash(seed);
        let plain = simulate(seed, cfg(DUR));
        assert_eq!(
            fnv1a(&plain),
            expected,
            "seed {}：正式路径偏离 golden-v6 基线（引擎行为变了，不是 P15 的锅——先查这一条）",
            seed
        );
        let dm = simulate_with_behavior_observations(seed, cfg(DUR));
        assert_eq!(
            fnv1a(&dm.events_json()),
            expected,
            "seed {}：开启 recorder 后事件流偏离 golden-v6 基线——观察层改变了正式行为",
            seed
        );
        assert_eq!(
            dm.events_json(),
            plain,
            "seed {}：两条路径的流必须一致",
            seed
        );
    }
}

// 注：此处的 「recorder on/off 不改变 RNG」**没有**独立门，也**不应**造一条。
//
// 曾经有一条 `recorder_on_and_off_consume_the_same_rng_sequence`：把 beat 的 `(t, type)` 序列
// 当作「RNG 消费的满射代理」与正式路径比对。2026-09-24 复核后删除，理由有二：
//
// 1. **与逐字节门完全重复**：它比的是 `simulate(seed)` 与 `observed(seed).events_json()`——正是
//    [`plain_and_opt_in_paths_agree_byte_for_byte`] 断言的东西。前者不弱于后者（逐字节比对已
//    覆盖「决策分叉」这一后果），却把结论写成「RNG 消费被证明一致」，是**误导性叙事**；
// 2. **「满射代理」的说法不成立**：它只在「beat 序列是 rng 消费的单射投影」时才蕴含 RNG 结论，
//    而这不是本引擎的性质——RNG 消费可以在不改变 beat 序列的位置发生。
//
// RNG 面的**间接**证据留在 [`recorder_on_and_off_reproduce_the_golden_v6_canary_stream`]
// （外部锚）与 [`plain_and_opt_in_paths_agree_byte_for_byte`]（互比）；raw rng 游标 / 序列
// **没有**可观察工件（见模块头「口径纪律」）。若将来真的需要直接比 raw 序列，得让
// `match_events` 接受外部注入的 rng（改生产签名）——那要先有真实需求，**不是**为测试放宽可见性。

// ============================== 2. 不变量 / 闭合 / 重叠 ==============================

/// **design §13 门 2**：终态、不变量、对象闭合、无重叠——在 canary seed 上逐条断言。
///
/// 覆盖的任务清单项：`Assert episode/contest/restart closure and no overlapping active objects`。
#[test]
fn terminal_state_invariants_and_closure_hold_on_the_canary_seeds() {
    let mut episodes = 0usize;
    let mut restarts = 0usize;
    for seed in CANARY_SEEDS {
        let dm = observed(seed);
        // **一条**断言，不用两条。`is_coherent()` 的实现就是
        // `self.invariant_violations.is_empty()`（`observation.rs`），所以
        // 「先断言 `invariant_violations.is_empty()`、再断言 `is_coherent()`」里的第二条**恒真**
        // ——它是同一个谓词的第二次求值，却被读成「第二条独立证据」（2026-09-24 审阅指出的
        // construction tautology，已删）。这里直接用 `is_coherent()`：它既是「观察是否自洽」的
        // 公开判据，也在失败时把违规明细打出来。
        //
        // `is_coherent()` 自身的判别力（非空违规时返回 false）不靠本条证明——它由
        // `observation.rs::opt_in_sidecar_carries_invariant_violations_and_terminal_state`
        // 的损坏 recorder 反证固定。本条的独立信号是**对象层**的：终态、闭合、下标、不重叠。
        assert!(
            dm.is_coherent(),
            "seed {}：观察层不变量违规 = {:#?}",
            seed,
            dm.invariant_violations
        );
        assert_eq!(
            dm.state,
            BehaviorControlState::Ended,
            "seed {}：完整比赛必须以 Ended 收束（其它终态 = 观察没跑完，例如停在 Contested）",
            seed
        );

        // ① 每个 episode 闭合且结束原因齐备。
        assert!(
            !dm.possession_episodes.is_empty(),
            "seed {}：无 episode",
            seed
        );
        for e in &dm.possession_episodes {
            assert!(e.end_t.is_some(), "seed {}：episode {} 未闭合", seed, e.id);
            assert!(
                e.end_reason.is_some(),
                "seed {}：episode {} 无结束原因",
                seed,
                e.id
            );
            assert!(
                e.end_t.value_or_min() >= e.start_t.value,
                "seed {}：episode {} 的 end_t < start_t",
                seed,
                e.id
            );
            assert!(
                !e.control_fact_indexes.is_empty(),
                "seed {}：episode {} 没有任何事实",
                seed,
                e.id
            );
        }
        // ② 每个 restart 闭合。
        assert!(
            !dm.restart_sequences.is_empty(),
            "seed {}：无 restart",
            seed
        );
        for r in &dm.restart_sequences {
            assert!(
                r.end_reason.is_some(),
                "seed {}：restart {}（{:?}）未闭合",
                seed,
                r.id,
                r.kind
            );
        }
        // ③ **无重叠的活跃对象**：episode 之间不重叠（`(start_t, id)` 严格递增，且前一条的
        //    end_t 不晚于后一条的 start_t）。这正是「至少两个同时活跃的 episode」的否定——
        //    不变量 1 在 recorder 内部查，这里在 sidecar 上独立复算一遍（sidecar 是下游看到的
        //    唯一客体，它必须自带这个性质）。
        //
        //    用 `(start_t, id)` 而不是只比 `start_t`：`restart.open_play_resumed_t` 与
        //    episode 的 `start_t` 由**同一次 `control_established`** 提交，因此不同对象的
        //    时刻可以相等（同刻转场）；同刻时由 id 决定次序。实测 150 seed 里同刻 restart
        //    0 例、同刻 episode 0 例，但断言不依赖这个巧合。
        for w in dm.possession_episodes.windows(2) {
            let (a, b) = (&w[0], &w[1]);
            assert!(
                (a.start_t.value, a.id) < (b.start_t.value, b.id),
                "seed {}：episode 顺序与 (start_t, id) 不一致：{} vs {}",
                seed,
                a.id,
                b.id
            );
            assert!(
                a.end_t.value_or_min() <= b.start_t.value,
                "seed {}：episode {} 与 {} 重叠（end_t {} > start_t {}）",
                seed,
                a.id,
                b.id,
                a.end_t.value_or_min(),
                b.start_t.value
            );
        }
        for w in dm.restart_sequences.windows(2) {
            let (a, b) = (&w[0], &w[1]);
            assert!(
                (a.start_t.value, a.id) < (b.start_t.value, b.id),
                "seed {}：restart 顺序与 (start_t, id) 不一致：{} vs {}",
                seed,
                a.id,
                b.id
            );
        }
        // ④ **episode 与 restart 不重叠**：restart 覆盖的是「死球 → 首次控制」这段窗口，
        //    episode 只存在于该窗口**之外**。用「episode 起点严格落在未收束 restart 的内部」
        //    来表达——实测 40 seed（1962 条 restart / ~3000 条 episode）零反例。
        //
        //    ⚠️ **判据是单向的（覆盖边界，审阅指出）**：它只抓「episode 在 restart 窗口**内部
        //    开始**」这一形态；「episode 在 restart 开始**之前**就存在、却延续到窗口内部结束」
        //    这一形态**抓不到**。今天不可达（`dead_ball_started` 会在同一个 `t` 上关闭开放
        //    episode），故这不是漏洞而是**判据边界**；若将来引擎允许「死球开启时仍有开放
        //    episode」，须把本判据补成双向（同时检查 `end_t` 落点）。**不要**据此声称本门
        //    证明了「任意形态的重叠都不存在」。
        let whistle_t = tail_whistle_t(&dm);
        for b in &dm.possession_episodes {
            for r in &dm.restart_sequences {
                let window_end = r.open_play_resumed_t.map(|t| t.value).unwrap_or(whistle_t);
                assert!(
                    !(b.start_t.value > r.start_t.value + 1e-9
                        && b.start_t.value < window_end - 1e-9),
                    "seed {}：episode {}（start_t={}）落在 restart {}（{:?}，{}..{}）的活跃窗口内",
                    seed,
                    b.id,
                    b.start_t.value,
                    r.id,
                    r.kind,
                    r.start_t.value,
                    window_end
                );
            }
        }
        // ⑤ 首开球专线：第一条 episode 以 kickoff 开，事件下标**非空**（它是唯一曾被系统性
        //    漏绑的对象——旧接线的唯一一次扫描发生在 restart 收束之后）。
        let first_kickoff_ep = dm
            .possession_episodes
            .iter()
            .find(|e| e.start_reason == EpisodeStartReason::Kickoff)
            .unwrap_or_else(|| panic!("seed {}：没有任何以 Kickoff 开启的 episode", seed));
        assert_eq!(
            first_kickoff_ep.start_t.basis,
            TimeBasis::EventEmit,
            "seed {}：首开球的时间 basis 必须是 event_emit（模块头 A3.1 / 开球专线 1）",
            seed
        );
        assert!(
            !dm.restart_sequences[0].event_indexes.is_empty(),
            "seed {}：首开球 sequence 无事件下标",
            seed
        );

        episodes += dm.possession_episodes.len();
        restarts += dm.restart_sequences.len();
    }
    // 防空转：canary 集合必须真的产出足够多的对象，否则上面的逐条断言接近空转。
    assert!(
        episodes >= 200 && restarts >= 100,
        "canary 样本过少（episode {} / restart {}），闭合断言接近空转",
        episodes,
        restarts
    );
}

/// 覆盖 `Option<ObservedTime>` 的「未收束时取 -inf」比较辅助（`end_t` 在已闭合对象上恒 `Some`，
/// 这里的兜底只是让比较表达式不为 `None` 崩，不改变判定）。
trait ValueOrMin {
    fn value_or_min(&self) -> f64;
}
impl ValueOrMin for Option<fm_engine::observation::ObservedTime> {
    fn value_or_min(&self) -> f64 {
        self.map(|t| t.value).unwrap_or(f64::NEG_INFINITY)
    }
}

// ============================== 3. restart kind → episode start_reason ==============================

/// **P0 耦合门（固定 seed 集成版）**：重开交付后的首次控制，episode 的 `start_reason` 必须与
/// **重开类型**一致——首开球是 `Kickoff`，其余（角球 / 门球 / 界外球 / 任意球）一律
/// `RestartControl`。
///
/// 耦合方式（**不靠对象顺序**）：restart 的 `open_play_resumed_t` 与 episode 的 `start_t`
/// 相等 ⟺ 那条 episode 由这次交付开出。
///
/// 与 `src/observation.rs::restart_delivery_start_reason_matches_the_restart_kind_on_real_matches`
/// 的分工：那条是**生产路径的多 seed 行为门**；这条把同一耦合放进集成门，并额外要求
/// **五种重开方式都被覆盖**（防空转），使 tasks.md 的「restart kind → episode start_reason
/// 关系」在集成层独立可查。
///
/// 判别力（目标变异必红）：
/// - 把 `control_established` 里的归一删掉 → 角球 / 门球两行红（它们原始值是 `Pickup`）；
/// - 把归一硬编码成 `Pickup` → 界外球 / 任意球 / 进球后开球三行红；
/// - 删掉首开球的 `Kickoff` 豁免 → 首开球一行红。
#[test]
fn restart_kind_decides_the_delivered_episode_start_reason() {
    let mut seen_kinds: Vec<RestartKind> = Vec::new();
    let mut checked = 0usize;
    for seed in CANARY_SEEDS {
        let dm = observed(seed);
        for r in &dm.restart_sequences {
            seen_kinds.push(r.kind);
            let Some(resumed) = r.open_play_resumed_t else {
                continue; // 未完成的重开（流末截断 / match_end）没有交付控制可查
            };
            let ep = dm
                .possession_episodes
                .iter()
                .find(|e| (e.start_t.value - resumed.value).abs() < 1e-9)
                .unwrap_or_else(|| {
                    panic!(
                        "seed {}：restart {}（{:?}）在 t={} 标记 open_play_resumed，\
                         却找不到同一时刻开启的 episode",
                        seed, r.id, r.kind, resumed.value
                    )
                });
            // 首开球是唯一以 `Kickoff` 开 episode 的路径（它同样有开放 restart，故必须显式
            // 豁免，否则会被归一吞成 RestartControl）。
            let first_kickoff = r.kind == RestartKind::Kickoff && r.start_t.value == 0.0;
            let expected = if first_kickoff {
                EpisodeStartReason::Kickoff
            } else {
                EpisodeStartReason::RestartControl
            };
            assert_eq!(
                ep.start_reason,
                expected,
                "seed {}：restart {}（{:?}，t={}）交付后的 episode {} start_reason = {}（期望 {}）",
                seed,
                r.id,
                r.kind,
                r.start_t.value,
                ep.id,
                ep.start_reason.as_str(),
                expected.as_str()
            );
            checked += 1;
        }
    }
    // 防空转：五种重开方式都必须在本 canary 集合里出现（实测 seed 1 单场即全出）。
    for kind in [
        RestartKind::Corner,
        RestartKind::GoalKick,
        RestartKind::ThrowIn,
        RestartKind::FreeKick,
        RestartKind::Kickoff,
    ] {
        assert!(
            seen_kinds.contains(&kind),
            "canary 集合没有覆盖 {:?}（该行断言变成空转）；实际 = {:?}",
            kind,
            seen_kinds.iter().map(|k| k.as_str()).collect::<Vec<_>>()
        );
    }
    assert!(
        checked >= 100,
        "交付控制样本过少（{}），耦合断言接近空转",
        checked
    );
}

// ============================== 3b. 争抢原因 / 时间 basis ↔ 引擎接线 ==============================

/// 真实 opt-in 路径上，**每一类** `ContestStartReason` 与它的**引擎事件来源**、**它关闭的
/// episode 的 `end_reason`**（若该 reason 的语义如此）、**收束它的 `ContestEndReason`** 对上。
///
/// **这是本文件唯一覆盖 `lib.rs` 争抢接线的门。** `src/observation.rs` 的 Slice 3 fixture 是
/// 纯 recorder 单测（自己调 `contest_started`），对 `lib.rs` 的 reason 传参**不可见**——
/// 曾有一轮把「改 `lib.rs` → fixture 必红」写进那些 fixture 的注释，实测为假。这条门把那一面
/// 补上：它走 `simulate_with_behavior_observations`，读的是**引擎自己提交**的事实。
///
/// **覆盖全部 5 个引擎可达的 `ContestStartReason`**（不是只挑几个）。下表全部来自实测
/// （`CONTEST_SEEDS`，共 15 场；括号内为该组样本上的条数）：
///
/// | 争抢 `reason` | 引擎事件（`source_event_index` 指向） | 同刻关闭的 episode `end_reason` |
/// |---|---|---|
/// | `interception_loose` | `Pass` / `result="intercepted"` | 恰好 1 条，`ControlLost` |
/// | `pass_lost` | `Pass` / `result="lost"` | 恰好 1 条，`ControlLost` |
/// | `tackle_loose` | `Tackle` / `result="success"` | 恰好 1 条，`ControlLost` |
/// | `shot_rebound` | `Shot` / `result="saved"` | 恰好 1 条，`ShotRebound`（**同名不同义**） |
/// | `delivery_loose` | `Pass` / `result="contested"`（= 角球 / 门球 / 解围三类交付落点） | **不约束**——见下 |
///
/// `delivery_loose` 的「同刻关闭的 episode」形态**本来就不同**：交付落点争抢开启时原 episode
/// 通常已在出球提交点关闭（实测 204 条里 194 条同刻 0 条关闭、7 条 1 条 `ControlLost`、
/// 2 条 1 条出界类、1 条 `FullTime`）。故对它只断言**绑定事件 + 收束原因 + 下一条事实**，
/// 不硬套「恰好一条」——那会测出一个引擎不产生的形状。（它曾经被本门用一句注释「转交」
/// 给 `restart_kind_decides_the_delivered_episode_start_reason`，而**那条门根本不读
/// `control_facts`、对 `delivery_loose` 零断言**——那是一次假的覆盖转交，已改为真正覆盖。）
///
/// 收束：全部 5 类都以 `ContestEndReason::Pickup` 收束，**唯一**例外是流末被终场哨打断的
/// （`StreamBoundary` → `MatchEnd`）。故「争抢开启 → 谁收束」也在这条门内，而不是无人过问。
///
/// 判别力（目标变异必红，均已实测；变异施加在 `lib.rs` 的提交点上）：
///
/// - `lib.rs` `TackleSuccess` 分支的 `TackleLoose` 改成 `ShotRebound` → 事件断言红
///   （`"shot_rebound" 绑定到了 Tackle 事件，期望 Shot`）；计数断言同时清零，但测试在事件
///   断言处先 panic，故**实际报出的是一条**（两条都是红信号，不是两条独立消息）；
/// - `lib.rs` `PassIntercepted` 分支的 `InterceptionLoose` 改成 `PassLost` → 事件断言红
///   （`"pass_lost" 绑定的 Pass 事件 result = intercepted，期望 lost`）；
/// - `lib.rs` `ShotSavedRebound` 分支的 `episode_end` 从 `ShotRebound` 改成 `ControlLost`
///   → `shot_rebound` 行的 episode `end_reason` 断言红。
///
/// **为什么 `ShotRebound` 要单独看**：`ContestStartReason::ShotRebound` 与
/// `EpisodeEndReason::ShotRebound` 是**两个不同闭集的同名成员**（一个是「争抢开启原因」、
/// 一个是「episode 收束原因」）。配错不会让任何枚举完整性测试变红，只会污染按原因聚合——
/// 故这里**分别**断言两者，而不是只查一个。
#[test]
fn contest_reasons_and_settlements_are_bound_to_their_own_engine_events() {
    /// 同刻关闭的 episode 的期望形态。
    #[derive(Debug)]
    enum Closing {
        /// 恰好一条，且 `end_reason` 等于给定值。
        ExactlyOne(EpisodeEndReason),
        /// `delivery_loose` 专用：条数**不约束**（交付落点争抢开启时，原 episode 通常已在出球
        /// 提交点关闭——实测 204 条里 194 条同刻 0 条关闭），但**凡是有同刻关闭的**，其 `end_reason`
        /// 必须是给定值。这样既不硬套引擎不产生的「恰好一条」，又不把「`end_reason` 被改错」
        /// 放过去（实测：三个交付点一起把 `ControlLost` 改成别的值时，7 条 episode 全部漂移）。
        AnyCountButReason(EpisodeEndReason),
    }

    struct Expect {
        reason: ContestStartReason,
        event_type: EventType,
        result: &'static str,
        closing: Closing,
    }

    const EXPECTED: [Expect; 5] = [
        Expect {
            reason: ContestStartReason::InterceptionLoose,
            event_type: EventType::Pass,
            result: "intercepted",
            closing: Closing::ExactlyOne(EpisodeEndReason::ControlLost),
        },
        Expect {
            reason: ContestStartReason::PassLost,
            event_type: EventType::Pass,
            result: "lost",
            closing: Closing::ExactlyOne(EpisodeEndReason::ControlLost),
        },
        Expect {
            reason: ContestStartReason::TackleLoose,
            event_type: EventType::Tackle,
            result: "success",
            closing: Closing::ExactlyOne(EpisodeEndReason::ControlLost),
        },
        Expect {
            reason: ContestStartReason::ShotRebound,
            event_type: EventType::Shot,
            result: "saved",
            closing: Closing::ExactlyOne(EpisodeEndReason::ShotRebound),
        },
        Expect {
            reason: ContestStartReason::DeliveryLoose,
            event_type: EventType::Pass,
            result: "contested",
            closing: Closing::AnyCountButReason(EpisodeEndReason::ControlLost),
        },
    ];

    let mut seen: std::collections::BTreeMap<&'static str, usize> = Default::default();
    let mut settled_by: std::collections::BTreeMap<&'static str, usize> = Default::default();
    // ② 里**非末刻**的同刻关闭计数（防空转：`delivery_loose` 的 `end_reason` 断言若一条都没
    // 落在非末刻分支上，那条断言就是空转——实测 7 条，全为 `ControlLost`）。
    let mut non_tail_closes: std::collections::BTreeMap<&'static str, usize> = Default::default();

    for seed in CONTEST_SEEDS {
        let dm = observed(seed);
        let whistle_t = tail_whistle_t(&dm);
        for (fi, f) in dm.control_facts.iter().enumerate() {
            let Some(ControlFactDetail::ContestStart(reason)) = f.detail else {
                continue;
            };
            let expect = EXPECTED
                .iter()
                .find(|e| e.reason == reason)
                .unwrap_or_else(|| {
                    panic!(
                        "seed {}：出现了一个 `EXPECTED` 表里没有的 `ContestStartReason::{:?}`\
                         ——本门要求**覆盖全部**引擎可达的争抢原因，新增原因必须补进表里",
                        seed, reason
                    )
                });
            *seen.entry(reason.as_str()).or_insert(0) += 1;

            // ① 事实绑定到**产生它的那条引擎事件**上。
            //
            //    唯一的合法例外是「对象于流截断时刻才被创建」：`dur` 时刻的高亮 finalize 落在
            //    排空期，此时 `lib.rs` 已 `suspend_event_index_binding(true)`，事实**有意**不带
            //    下标（design §15 A9-10）。实测 300 seed 里未绑定 9 例（全部 5 类），全部 `t == 尾哨`。故此处按
            //    同一豁免判据放行，而不是把断言放松成「有下标就不错」。
            match f.source_event_index {
                Some(idx) => {
                    let ev = &dm.events[idx];
                    assert_eq!(
                        ev.type_,
                        expect.event_type,
                        "seed {}：{:?} 绑定到了 {:?} 事件，期望 {:?}（t={}）",
                        seed,
                        reason.as_str(),
                        ev.type_,
                        expect.event_type,
                        f.t.value
                    );
                    assert_eq!(
                        ev.result.as_deref(),
                        Some(expect.result),
                        "seed {}：{:?} 绑定的 {:?} 事件 result = {:?}，期望 {:?}",
                        seed,
                        reason.as_str(),
                        expect.event_type,
                        ev.result.as_deref(),
                        expect.result
                    );
                }
                None => assert!(
                    (f.t.value - whistle_t).abs() < 1e-9,
                    "seed {}：{:?}（t={}）没有绑定事件，且不在流截断时刻（尾哨 t={}）\
                     ——这是接线缺陷信号，不是设计豁免",
                    seed,
                    reason.as_str(),
                    f.t.value,
                    whistle_t
                ),
            }

            // ② 被它关闭的 episode。两条判据分工：
            //    - `ExactlyOne`：条数**恰好 1**（末刻与终场哨同刻的截断例外除外）+ `end_reason`；
            //    - `AnyCountButReason`（`delivery_loose`）：**条数不约束**，但凡有同刻关闭的，
            //      `end_reason` 必须对——这样既不为「引擎既然会 0 条关闭」编造「恰好 1 条」的
            //      假形状，也不放过「`end_reason` 被改错」（实测三个交付点一起改 `ControlLost`
            //      → 7 条 episode 漂移）。
            let want_end: Option<&EpisodeEndReason> = match &expect.closing {
                Closing::ExactlyOne(e) => Some(e),
                Closing::AnyCountButReason(e) => Some(e),
            };
            let exactly_one = matches!(expect.closing, Closing::ExactlyOne(_));
            let at_tail = (f.t.value - whistle_t).abs() < 1e-9;
            if let Some(want_end) = want_end {
                let closing: Vec<_> = dm
                    .possession_episodes
                    .iter()
                    .filter(|e| {
                        e.end_t
                            .map(|t| (t.value - f.t.value).abs() < 1e-9)
                            .unwrap_or(false)
                    })
                    .collect();
                if exactly_one && closing.len() != 1 {
                    // 同截断例外：末刻的争抢可能与终场哨同刻关闭多条（实测 300 seed 3 例，
                    // 全部 `t == 尾哨`）。
                    assert!(
                        at_tail,
                        "seed {}：{:?}（t={}）同刻关闭了 {} 条 episode（期望恰好 1 条）",
                        seed,
                        reason.as_str(),
                        f.t.value,
                        closing.len()
                    );
                } else if at_tail {
                    // 末刻：终场哨（`MatchEnd`/`FullTime`）与出界类收束都会与争抢同刻，
                    // 是已记录的**截断 regime**，不约束 `end_reason`（判据边界如实记录）。
                    // 非末刻的同刻关闭才是接线缺陷信号，由下面 `else` 分支判。
                } else if closing.len() == 1 {
                    assert_eq!(
                        closing[0].end_reason,
                        Some(*want_end),
                        "seed {}：{:?} 关闭的 episode {} end_reason = {:?}，期望 {:?}",
                        seed,
                        reason.as_str(),
                        closing[0].id,
                        closing[0].end_reason,
                        want_end
                    );
                    *non_tail_closes.entry(reason.as_str()).or_insert(0) += 1;
                } else {
                    assert!(
                        closing.is_empty(),
                        "seed {}：{:?}（t={}）同刻关闭了 {} 条 episode——条数不约束的 reason \
                         只允许 0 或 1 条（多条的形态尚未被观察，出现了须复核）",
                        seed,
                        reason.as_str(),
                        f.t.value,
                        closing.len()
                    );
                }
            }

            // ③ 收束这次争抢的 `ContestEndReason`。
            //
            //    取**紧邻的下一条事实**而不是「其后第一条 `contest_ended`」：后者在「本次争抢
            //    没收束、但更晚的某次争抢收束了」时会让 `and_then` 拿到**别人的**收束事实，
            //    从而把「争抢悬空」这条缺陷静默吞掉（审阅指出的可掩盖路径）。
            //
            //    「紧邻下一条必为 `contest_ended`」是 recorder 状态机性质：争抢开启后 `state`
            //    为 `Contested`，此后**每个**收束入口（`control_established` 的 pickup、
            //    `dead_ball_started` / `full_time` 的 `settle_contest`）都在推进状态**之前**
            //    先记 `contest_ended`（`observation.rs`）；实测 300 seed / 15,743 条争抢零反例。
            //    若将来引擎改成允许争抢中夹入其它事实，本断言会**先**红——那是 fail-closed 的
            //    正确行为，届时须重新评估 ③ 的取法。
            let next = dm.control_facts.get(fi + 1).unwrap_or_else(|| {
                panic!(
                    "seed {}：{:?}（t={}）之后没有事实——争抢悬空",
                    seed,
                    reason.as_str(),
                    f.t.value
                )
            });
            assert_eq!(
                next.kind,
                ControlFactKind::ContestEnded,
                "seed {}：{:?}（t={}）的下一条事实是 {}，期望 contest_ended——\
                 争抢开启后必须先收束再推进新状态（否则本次争抢的收束原因会被读成别人的）",
                seed,
                reason.as_str(),
                f.t.value,
                next.kind.as_str()
            );
            let Some(ControlFactDetail::ContestEnd(ce)) = next.detail else {
                panic!(
                    "seed {}：{:?} 的收束事实 detail = {:?}，必须是具名的 ContestEnd",
                    seed,
                    reason.as_str(),
                    next.detail
                );
            };
            *settled_by.entry(ce.as_str()).or_insert(0) += 1;
            // 收束原因由 basis 决定（`observation.rs` 的两处 `settle_contest` 调用点）：
            // `StreamBoundary` → `MatchEnd`（`full_time`，唯一的流边界哨）；其余 → `Pickup`
            // （`control_established` 里的拾取收束）。`half_time` 也会用 `StreamBoundary`
            // + `ContestEndReason::Whistle`，但它在生产路径上**零调用点**（design §15 A9-5），
            // 故这里不把 `Whistle` 写进期望值——真出现了应让本断言红，而不是被静默接受。
            let expected_reason = if next.basis == ControlFactBasis::StreamBoundary {
                ContestEndReason::MatchEnd
            } else {
                ContestEndReason::Pickup
            };
            assert_eq!(
                ce,
                expected_reason,
                "seed {}：{:?} 被{}收束——期望 {}（basis = {:?}）",
                seed,
                reason.as_str(),
                ce.as_str(),
                expected_reason.as_str(),
                next.basis
            );
        }
    }

    // 防空转：5 类争抢**都**必须真的出现在这组 seed 上，且样本量足以让逐条断言不空转。
    for e in &EXPECTED {
        let n = seen.get(e.reason.as_str()).copied().unwrap_or(0);
        assert!(
            n > 0,
            "目标 seed 集合没有覆盖 {:?}（该行断言空转）；实际 = {:?}",
            e.reason.as_str(),
            seen
        );
    }
    // 稀疏的两类各给一个**留有余量**的下限（不是「恰好等于实测值」，那样任何良性缩水都会
    // 以误导性的消息报红）。实测：`shot_rebound` 6 / `pass_lost` 96。
    assert!(
        seen.get("shot_rebound").copied().unwrap_or(0) >= 4,
        "shot_rebound 样本过少（{:?}）——CONTEST_SEEDS 的补种子失效了？",
        seen
    );
    assert!(
        seen.get("pass_lost").copied().unwrap_or(0) >= 50,
        "pass_lost 样本过少（{:?}）",
        seen
    );
    let total: usize = seen.values().sum();
    assert!(
        total >= 500,
        "争抢样本总量过少（{}），逐条绑定断言接近空转",
        total
    );
    // 收束面同等的防空转：两个收束原因都必须真的被扫到。`match_end` 只在流末打断时出现
    // （实测 2 条，都属 `delivery_loose`），故它的下限就是 1——这条同时把上面那条
    // `StreamBoundary → MatchEnd` 分支从「休眠代码」变成**被真正执行**的分支。
    assert!(
        settled_by.get("pickup").copied().unwrap_or(0) >= 500,
        "pickup 收束样本过少（{:?}）",
        settled_by
    );
    assert!(
        settled_by.get("match_end").copied().unwrap_or(0) >= 1,
        "没有扫到任何 `match_end` 收束（{:?}）——`StreamBoundary → MatchEnd` 分支变成休眠代码",
        settled_by
    );
    // ② 的防空转：`delivery_loose` 的 `end_reason` 断言必须真的在**非末刻**分支上执行过
    // （实测 7 条；末刻那 3 条走豁免、不判原因）。没有这条，上面 ② 对 `delivery_loose`
    // 就退化成「只在末刻被豁免」——即等于没有断言。
    assert!(
        non_tail_closes.get("delivery_loose").copied().unwrap_or(0) >= 1,
        "`delivery_loose` 没有任何**非末刻**的同刻关闭 episode（{:?}）——\
         它的 `end_reason` 断言变成空转（全被末刻豁免吃掉）",
        non_tail_closes
    );
}

/// 真实 opt-in 路径上，**首开球与进球后开球的时间 basis 形状不同**——这是检验
/// `lib.rs` 开球专线接线（模块头专线 1/2）的门。
///
/// 两条专线的区别（`observation.rs` 模块头）：
///
/// - **首开球**：引擎在 `MatchState::new` 就把 `carrier = 10` 提交好了，**从未进入飞行态**
///   → `restart_taken` 与 `control_established` 同在 t=0，两条时间都是 `EventEmit`；
/// - **进球后开球**：`advance_dead_ball` 真的等 `kickoff_end`（`t + 距离/12.0`），恢复时刻的
///   basis 是 `DeterministicFlightEnd`。
///
/// 判别力（目标变异必红，均已实测）：把 `lib.rs` 里开球 `kickoff_end` 那处
/// `ObservedTime::flight_end(kickoff_end)` 改成 `state_commit(kickoff_end)` → 第 ② 段的 basis
/// 断言红。`src/observation.rs` 的同名手写 fixture **抓不到这个变异**（它自己传 basis，
/// 与 `lib.rs` 无关），这正是本门存在的理由。
#[test]
fn kickoff_flight_basis_separates_first_kickoff_from_a_goal_restart() {
    let mut first_checked = 0usize;
    let mut goal_kickoff_checked = 0usize;

    for seed in CANARY_SEEDS {
        let dm = observed(seed);

        // ① 首开球：sequence #0，`restart_taken` 与恢复同在 t=0，都是事件时间。
        let first = &dm.restart_sequences[0];
        assert_eq!(
            first.kind,
            RestartKind::Kickoff,
            "seed {}：sequence #0 是开球",
            seed
        );
        assert_eq!(first.start_t.value, 0.0, "seed {}：首开球在 t=0", seed);
        let taken = first.taken_t.expect("首开球必须已 taken");
        assert_eq!(
            taken.value, 0.0,
            "seed {}：首开球 taken 在 t=0（引擎开赛已持有球）",
            seed
        );
        assert_eq!(
            taken.basis,
            TimeBasis::EventEmit,
            "seed {}：首开球 taken 的 basis 是 event_emit",
            seed
        );
        let resumed = first.open_play_resumed_t.expect("首开球必须已恢复开放比赛");
        assert_eq!(
            resumed.basis,
            TimeBasis::EventEmit,
            "seed {}：首开球的恢复时刻 basis 必须是 event_emit（**不是** deterministic_flight_end\
             ——引擎里没有这段飞行）",
            seed
        );
        // 余下 pin：恢复也在 t=0（`taken` 已在上面钉成 0.0，故不必再比一次 `resumed == taken`
        // ——那是同一件事的第二次表述，会读起来像两条独立证据）。
        assert_eq!(
            resumed.value, 0.0,
            "seed {}：首开球的恢复也在 t=0——中间隔着飞行时间就不再是「引擎开赛已持球、\
             从未进入飞行态」的专线 1 接线",
            seed
        );
        // 首开球**那一整段比赛**（episode #0）内不得出现 `DeterministicFlightEnd` 事实：那是
        // 「引擎真的等过飞行」的痕迹。判据窗口取**整条首个 episode**（实测 canary 16–144s），
        // 不是「`t <= 恢复时刻`」——后者在首开球上恒为 `t <= 0`，只有一条事实能落进去，是空转判据
        // （审阅指出）。首个 episode 内确实可能发生传接，但那些控制建立走 `FinalizedOutcome`；
        // 「等飞行」只出现在死球重开（此时 episode 已关闭），故窗内应为 0 条。
        let ep0 = &dm.possession_episodes[0];
        assert_eq!(ep0.start_reason, EpisodeStartReason::Kickoff);
        let ep0_end = ep0.end_t.expect("episode #0 必须闭合").value;
        let stray: Vec<_> = dm
            .control_facts
            .iter()
            .filter(|f| {
                f.t.basis == TimeBasis::DeterministicFlightEnd
                    && f.t.value >= ep0.start_t.value - 1e-9
                    && f.t.value <= ep0_end + 1e-9
            })
            .map(|f| format!("{}@{}", f.kind.as_str(), f.t.value))
            .collect();
        assert!(
            stray.is_empty(),
            "seed {}：首个 episode（{:.1}s..{:.1}s，由首开球开出）内出现了 deterministic_flight_end\
             时间：{:?}——首开球路径上没有「等飞行」的控制建立（模块头专线 1）",
            seed,
            ep0.start_t.value,
            ep0_end,
            stray
        );
        first_checked += 1;

        // ② 进球后开球：`start_t > 0` 的 kickoff sequence，恢复必须等引擎自算的飞行结束。
        for r in &dm.restart_sequences {
            if r.kind != RestartKind::Kickoff || r.start_t.value == 0.0 {
                continue;
            }
            let Some(resumed) = r.open_play_resumed_t else {
                continue; // 流末截断在开球前的重开，没有恢复时刻可查
            };
            assert_eq!(
                resumed.basis,
                TimeBasis::DeterministicFlightEnd,
                "seed {}：进球后开球（sequence {}，start_t={}）的恢复 basis = {:?}，\
                 期望 deterministic_flight_end——引擎在 kickoff_end 才 `dead_ball = None`，\
                 恢复时刻由引擎自算而非事件时间（模块头专线 2）",
                seed,
                r.id,
                r.start_t.value,
                resumed.basis
            );
            // 恢复时刻必须**晚于** emit 时刻：那正是「球已交出 ≠ 比赛已恢复」的可观测后果。
            let taken = r.taken_t.expect("进球后开球恢复前必已 taken");
            assert!(
                resumed.value > taken.value,
                "seed {}：进球后开球的恢复时刻 {} 不晚于 taken {}——若两者同刻，说明引擎\
                 接了「球已交出即恢复」，那是专线 2 明确否定的接线",
                seed,
                resumed.value,
                taken.value
            );
            goal_kickoff_checked += 1;
        }
    }

    // 防空转：canary 集合必须真的覆盖两条专线。
    assert!(first_checked == CANARY_SEEDS.len(), "首开球样本数不符");
    assert!(
        goal_kickoff_checked > 0,
        "canary 集合没有任何进球后开球（该分支空转）"
    );
}

// ============================== 4. 事件下标 ==============================

/// **事件下标门**：非空 / 单调 / 范围合法，**并显式只豁免尾哨时创建的对象**。
///
/// 三条断言（对应 tasks 清单的 `event_indexes 非空/单调/范围合法，允许并明确仅尾哨时创建
/// 对象的例外`）：
///
/// 1. **单调**：每个对象的 `event_indexes` 严格递增（append-only 的产物）；
/// 2. **范围合法**：每个下标 `< events.len()`；
/// 3. **非空，或唯一例外**：对象**在流截断时刻 `dur` 才被创建**（`start_t == 尾哨 t`）。
///    其原因是 `match_events` 出循环后立刻 `notify_event_stream_compaction(drain_start)` +
///    `suspend_event_index_binding(true)`——排空期的提交点**不绑定**事件下标
///    （design §14 A4.1 / §15.2 / §15 A9-10）。三种实际形态（终场哨开的 episode、
///    未 taken 就被 `match_end` 收束的 restart、`dur` 时刻已 taken 的门球）由单一谓词统一覆盖。
///
/// ⚠️ **不得**在此断言「事件时间落在对象时间窗内」——因果事件可以**早于** `object.start_t`
/// （`event_emit` 早于 `state_commit`，design §15.6；实测 80 场里 1923/7749 条绑定事件如此）。
///
/// 判别力（目标变异必红）：把「首开球收束前的那次绑定」删掉 → 第 3 条的非空断言红。
#[test]
fn event_indexes_are_non_empty_monotonic_and_in_range() {
    // 三种截断形态的覆盖计数器（防空转——第一版曾漏掉形态 ③ 还照样全绿）。
    let mut truncated_episode = 0usize;
    let mut truncated_restart_untaken = 0usize;
    let mut truncated_restart_taken = 0usize;
    // 命中形态 ③（`dur` 时刻已 taken 的门球）的 seed 157 / 317 **已经在** `CANARY_SEEDS` 里
    // （见模块头注释），故这里直接用 canary 集合——不要再 chain 一遍，那会重复跑同一批 seed
    // 而让样本数看起来更大（防空转计数器也会被灌水）。
    for seed in CANARY_SEEDS {
        let dm = observed(seed);
        let whistle_t = tail_whistle_t(&dm);
        for e in &dm.possession_episodes {
            check_index_list("episode", e.id, &e.event_indexes, dm.events.len(), seed);
            if e.event_indexes.is_empty() {
                assert!(
                    (e.start_t.value - whistle_t).abs() < 1e-9,
                    "seed {}：episode {}（start_t={}）无事件下标，且不在流截断时刻（尾哨 t={}）\
                     ——只有「截断时刻才创建」的对象允许缺少可归属事件",
                    seed,
                    e.id,
                    e.start_t.value,
                    whistle_t
                );
                truncated_episode += 1;
            }
        }
        for r in &dm.restart_sequences {
            check_index_list("restart", r.id, &r.event_indexes, dm.events.len(), seed);
            if r.event_indexes.is_empty() {
                assert!(
                    (r.start_t.value - whistle_t).abs() < 1e-9,
                    "seed {}：restart {}（{:?}，start_t={}）无事件下标，且不在流截断时刻\
                     （尾哨 t={}）",
                    seed,
                    r.id,
                    r.kind,
                    r.start_t.value,
                    whistle_t
                );
                if r.taken_t.is_none() {
                    truncated_restart_untaken += 1;
                } else {
                    truncated_restart_taken += 1;
                }
            }
        }
        // 事实层：绑定的下标也必须在范围内（事实的 `source_event_index` 与对象的
        // `event_indexes` 走同一个 guard）。
        for (i, f) in dm.control_facts.iter().enumerate() {
            if let Some(idx) = f.source_event_index {
                assert!(
                    idx < dm.events.len(),
                    "seed {}：fact[{}]（{}）的 source_event_index {} 越界（events={}）",
                    seed,
                    i,
                    f.kind.as_str(),
                    idx,
                    dm.events.len()
                );
            }
        }
        // 首开球 sequence 必须在**每个** seed 上都有下标（唯一曾被系统性漏绑的对象）。
        assert!(
            !dm.restart_sequences[0].event_indexes.is_empty(),
            "seed {}：首开球 sequence 无事件下标（收束前的那次绑定是否还在？）",
            seed
        );
    }
    // 防空转：三种截断形态都必须真的出现，否则豁免分支有分支是空转的。
    assert!(
        truncated_episode > 0 && truncated_restart_untaken > 0 && truncated_restart_taken > 0,
        "canary 集合没有覆盖全部三种截断形态（episode {} / restart 未 taken {} / restart 已 taken {}）\
         ——豁免条款有分支是空转的",
        truncated_episode,
        truncated_restart_untaken,
        truncated_restart_taken
    );
}

fn check_index_list(what: &str, id: u64, idxs: &[usize], n_events: usize, seed: u64) {
    assert!(
        idxs.windows(2).all(|w| w[0] < w[1]),
        "seed {}：{} {} 的事件下标非严格递增：{:?}",
        seed,
        what,
        id,
        idxs
    );
    for i in idxs {
        assert!(
            *i < n_events,
            "seed {}：{} {} 的事件下标 {} 越界（events={}）",
            seed,
            what,
            id,
            i,
            n_events
        );
    }
}

// ============================== 5. gap 分类 ==============================

/// **gap 分类门**：gap 是**被分类的结果**，不是「应该为 0 的失败计数器」。
///
/// 这条测试的存在理由：`gap_count() == 0` 曾被当成全称命题写进多处断言，而**它是错的**——
/// 终场哨落在未决飞行的中途时会**合法**产 `full_time_during_ball_in_flight`
/// （design §15.5：触发与时长**无关**；已复核 seed 147 @ dur 120、seed 368 @ dur 400）。
///
/// 因此本门不写「所有 duration 均为 0」，而是：
///
/// 1. 90 分钟 canary 上：0 gap（并**明说这 0 只对本样本成立**）；
/// 2. 截断样本上：≥1 gap，且**每一条** gap 的原因都属于设计允许的分类
///    （`full_time_during_ball_in_flight`）——这才是「合法」的判据；
/// 3. 未分类的 gap（`IllegalInput` / `EventIndexOutOfStableRange` / `MissingStreamEndBoundary`）
///    在两条样本上都必须为 0：这些是**接线的缺陷信号**，出现即为真缺陷。
#[test]
fn gap_is_a_classified_outcome_not_a_failure() {
    use fm_engine::observation::{ControlFactDetail, ObservationGapReason};

    // ① 干净样本：90 分钟 canary 上没有任何 gap。
    for seed in CANARY_SEEDS {
        let dm = observed(seed);
        assert_eq!(
            dm.gap_count(),
            0,
            "seed {} @ dur {}：本样本不该产 gap（**这个 0 只对本样本成立**——终场哨落在未决飞行\
             中途时会合法产 full_time_during_ball_in_flight；见本测试下半段）。实际 gaps = {:?}",
            seed,
            DUR,
            dm.control_facts
                .iter()
                .filter(|f| f.kind == ControlFactKind::ObservationGap)
                .map(|f| format!("{:?}@{}", f.detail, f.t.value))
                .collect::<Vec<_>>()
        );
    }

    // ② 截断样本：合法产 gap，且原因**必须**属于设计允许的分类。
    //    两个样本都来自 design §15.5 的已复核记录（不是自选样本）：
    //    seed 147 @ dur 120（开球在 t=119 发出、被 t=120 哨截断）与
    //    seed 368 @ dur 400（t=399 的 kickoff 飞行中撞哨——**更长时长同样产**）。
    let mut classified = 0usize;
    for (seed, dur) in [(147u64, 120.0), (368u64, 400.0)] {
        let dm = simulate_with_behavior_observations(seed, cfg(dur));
        assert!(
            dm.gap_count() >= 1,
            "seed {} @ dur {}：该样本必须复现截断 gap；实际 0（样本失效了？）",
            seed,
            dur
        );
        for f in dm
            .control_facts
            .iter()
            .filter(|f| f.kind == ControlFactKind::ObservationGap)
        {
            assert_eq!(
                f.detail,
                Some(ControlFactDetail::Gap(
                    ObservationGapReason::FullTimeDuringBallInFlight
                )),
                "seed {} @ dur {}：截断 gap 的原因必须是 full_time_during_ball_in_flight；\
                 其它原因（IllegalInput / EventIndexOutOfStableRange / MissingStreamEndBoundary）\
                 是接线缺陷信号，不是合法截断",
                seed,
                dur
            );
            classified += 1;
        }
        // 截断仍是**收束的**：终态 Ended、不变量干净、gap 原因聚合对得上总数。
        assert_eq!(
            dm.state,
            BehaviorControlState::Ended,
            "seed {} @ dur {}",
            seed,
            dur
        );
        assert!(
            dm.invariant_violations.is_empty(),
            "seed {} @ dur {}：{:?}",
            seed,
            dur,
            dm.invariant_violations
        );
        // 聚合核对（**判据必须对聚合函数有区分度**）：曾经这里还断言
        // `counts.len() == ObservationGapReason::ALL.len()`——已删，那是**构造使然**的空转
        // （`gap_reason_counts` 就是 `ALL.iter().map(..)`，长度恒等）。
        // 留下的两条都有判别力：`sum == gap_count` 抓「有 gap 事实的 detail 为 None / 不属于
        // 任何闭集成员」（那些事实进了 `gap_count` 却不进任何桶）；下面那条抓「原因错配」。
        let counts = dm.gap_reason_counts();
        let sum: usize = counts.iter().map(|(_, n)| n).sum();
        assert_eq!(
            sum,
            dm.gap_count(),
            "gap 原因聚合的总数必须等于 gap_count（按原因定位缺口的前提）"
        );
        let full_time = counts
            .iter()
            .find(|(r, _)| *r == ObservationGapReason::FullTimeDuringBallInFlight)
            .map(|(_, n)| *n)
            .unwrap_or(0);
        assert_eq!(
            full_time,
            dm.gap_count(),
            "本截断样本的**全部** gap 都必须归到 full_time_during_ball_in_flight；\
             落在别的桶说明原因错配（聚合会指错缺口）"
        );
    }
    assert!(
        classified >= 2,
        "截断样本没有真的产出 gap（{}），上面的分类断言是空转",
        classified
    );
}

/// **未分类 gap 的全称门**：任何样本上的**每一条** gap 都必须属于「设计允许的截断类」。
///
/// 与 [`gap_is_a_classified_outcome_not_a_failure`] 的分工：那条证明**合法 gap 被分类**；
/// 这条证明**没有任何 gap 落在允许集之外**。两者合起来才排除「gap 全是缺陷」和「gap 全是
/// 合法」两种误读——只看总数会被任一方向骗过。
///
/// **允许集**由 [`allowed_gap_details`] 单点定义，本门与 300-seed release 校准门共用它；
/// 判据是 `allowed.contains(detail)` 而非「逐个 `assert_ne` 几个坏值」，见该函数文档。
///
/// **单点范围如实说明**：本文件另有一处**字面**写 `FullTimeDuringBallInFlight`
/// （[`gap_is_a_classified_outcome_not_a_failure`] 对两个已知截断样本的断言）。那是**更严**的
/// 检查（要求恰好这一种），**不是**允许集的副本——若将来放宽 `allowed_gap_details`，那处会
/// **红**（fail-closed）而不是静默放行，故不构成缺陷信号被漏掉的风险；但它确实是一个漂移面，
/// 改允许集时要连它一起看。
///
/// **样本含已知产 gap 的流**（`seed 147 @ 120`、`seed 368 @ 400`，design §15.5 已复核），
/// 因此不是在空集上空转；末尾的防空转断言把这一点钉死。
#[test]
fn every_gap_on_the_canary_streams_is_a_designed_truncation_not_a_defect() {
    let allowed = allowed_gap_details();

    // 防空转**只**用 `observed_gaps > 0`（由**运行产物**得来）。曾经还有一条
    // `assert_eq!(samples, CANARY_SEEDS.len() * 3 + truncated.len())`——已删：`samples` 与
    // 右侧由**同一组循环边界**数出来，恒等，对任何变异都没有区分度（把循环边界改错它也照样绿），
    // 属自我确认断言。
    let mut observed_gaps = 0usize;
    // canary（含短时长） + 两个已复核的截断样本（保证本门真的扫到 gap）。
    let truncated: [(u64, f64); 2] = [(147, 120.0), (368, 400.0)];
    for seed in CANARY_SEEDS {
        for dur in [DUR, 300.0, 120.0] {
            let dm = simulate_with_behavior_observations(seed, cfg(dur));
            observed_gaps += check_gaps_are_allowed(&dm, seed, dur, &allowed);
        }
    }
    for (seed, dur) in truncated {
        let dm = simulate_with_behavior_observations(seed, cfg(dur));
        observed_gaps += check_gaps_are_allowed(&dm, seed, dur, &allowed);
    }
    assert!(
        observed_gaps > 0,
        "所有样本一条 gap 都没产——本门没有真的验证过分类逻辑（允许集是空转的）"
    );
}

/// 设计允许的 gap 原因**闭集**（design §10：**哨声打断未决飞行**）。
///
/// 除这两条外的**每一个** [`fm_engine::observation::ObservationGapReason`]（`MissingStreamEndBoundary`、
/// `EventIndexOutOfStableRange`、`IllegalFactIndex`、`EventIndexRegressed`、12 个 `IllegalInput`）
/// 都是接线 / 流解析缺陷信号，出现即真缺陷。
///
/// 抽成函数而不是在每个调用点各写一份：本切片有**两**条门要按同一闭集判（canary 清扫门与
/// 300-seed release 校准门），各写一份必然漂移——一处收窄后另一处仍放行缺陷 gap。
fn allowed_gap_details() -> [fm_engine::observation::ControlFactDetail; 2] {
    use fm_engine::observation::{ControlFactDetail, ObservationGapReason};
    [
        ControlFactDetail::Gap(ObservationGapReason::FullTimeDuringBallInFlight),
        ControlFactDetail::Gap(ObservationGapReason::HalfTimeDuringBallInFlight),
    ]
}

/// 逐条 gap 检查「原因落在允许集内」，返回扫到的 gap 数（供防空转断言累加）。
///
/// 判据写成 `allowed.contains(...)` 而不是「逐个 `assert_ne` 几个坏值」：后者每加一个 gap 原因
/// 就要补一行，漏补即静默放行——而缺陷信号恰恰最容易出现在新加的原因上。
fn check_gaps_are_allowed(
    dm: &DiagnosticMatch,
    seed: u64,
    dur: f64,
    allowed: &[fm_engine::observation::ControlFactDetail],
) -> usize {
    let gaps: Vec<_> = dm
        .control_facts
        .iter()
        .filter(|f| f.kind == ControlFactKind::ObservationGap)
        .collect();
    for f in &gaps {
        assert!(
            f.detail.map(|d| allowed.contains(&d)).unwrap_or(false),
            "seed {} @ dur {}：gap 原因 {:?} 不在允许集（只有「哨声打断未决飞行」两类是合法截断；\
             其余都是接线 / 流解析缺陷信号——出现在任何一条 seed 上都必须让所在的门变红，\
             包括 300-seed release 校准门）。本样本全部 gaps = {:?}",
            seed,
            dur,
            f.detail,
            gaps.iter()
                .map(|g| format!("{:?}@{:.1}", g.detail, g.t.value))
                .collect::<Vec<_>>()
        );
    }
    gaps.len()
}

/// **restart 结束原因门**：`SupersededByDeadBall` 是 recorder 层契约，当前生产引擎**不可达**。
///
/// 这条把 design §15 A9-2 的口径固定在集成层：每条 restart 的结束原因 ∈
/// {`OpenPlayResumed`, `MatchEnd`}。它同时是**行为守卫**——引擎将来若真的引入
/// 「重开中途再死球」，本测试变红并提醒把该原因升级为「生产已覆盖」。
///
/// 判别力（目标变异必红，已实测）：把 `advance_restart_prep` 的发球点改成「先报一条新死球、
/// 再 taken」→ 立刻红（`end_reason = Some(SupersededByDeadBall)`）。
#[test]
fn restart_end_reasons_stay_within_the_two_reachable_ones() {
    let mut restarts = 0usize;
    for seed in CANARY_SEEDS {
        let dm = observed(seed);
        for r in &dm.restart_sequences {
            assert!(
                matches!(
                    r.end_reason,
                    Some(RestartEndReason::OpenPlayResumed) | Some(RestartEndReason::MatchEnd)
                ),
                "seed {}：restart {}（{:?}）以 {:?} 结束——`SupersededByDeadBall` /\n\
                 `TerminatedByWhistle` / `Unknown` 都是当前引擎不可达的结束原因；若真的出现了，\
                 说明引擎新引入了对应路径，须同步升级本断言与 design §15 A9-2",
                seed,
                r.id,
                r.kind,
                r.end_reason
            );
            restarts += 1;
        }
    }
    assert!(
        restarts >= 100,
        "restart 样本过少（{}），断言接近空转",
        restarts
    );
}

// ============================== 6. 300 seed 校准门（ignored） ==============================

/// **release 校准门**：300 seed × 90 分钟，把体量与口径落盘。
///
/// 为什么 `#[ignore]`：debug 实测 **~110s**（300 场 × 5400s 的纯引擎模拟，无 I/O），
/// 放进默认 `cargo test` 会让每次本地循环多等两分钟。它与 `tests/realism.rs` 的
/// `l2_cross_event_invariants`（同日历尺度的统计门）同级，按同样的方式显式跑。
///
/// 跑法：
///
/// ```text
/// cargo test --release --test p15_behavior_observation -- --ignored --nocapture
/// ```
///
/// 落盘：`target/p15-calibration/300-seed-90min.json`（**不进版本库**——它是可复现的运行产物，
/// 权威口径是脚本本身 + 本测试的断言；把它提交进仓库只会制造一份会漂的副本）。
///
/// 除体量落盘外，本门同时是**每条 seed 的结构门**：不变量为空、终态 `Ended`、每个对象闭合、
/// 空事件下标**仅**允许出现在流截断时刻、`restart 数 = 死球事实数 + 1`，以及
/// **每条 gap 的原因都落在 [`allowed_gap_details`] 闭集内**（`gaps <= 5` 只是次级量级守卫，
/// 不代替原因校验——见循环内注释）。
///
/// 覆盖的任务清单项：`multi-seed 校准门：把 300 seed × 90 分钟证据落盘`，以及 gap **分类**
/// 面（属「观察对象不变量」，**不是**「recorder on/off 不变」那条——本门只跑 observed 路径，
/// 从不比较两条路径，故与 on/off-RNG 清单项无关；见模块头「RNG 面没有独立门」）。
#[test]
#[ignore = "300 场 × 90 分钟：debug 实测 ~110s；用 --release -- --ignored --nocapture 显式跑"]
fn l3_300_seed_90min_calibration_lands_evidence_on_disk() {
    const SEEDS: std::ops::RangeInclusive<u64> = 1..=300;
    let started = std::time::Instant::now();

    let mut episodes = 0usize;
    let mut restarts = 0usize;
    let mut facts = 0usize;
    let mut gaps = 0usize;
    let mut gap_seeds: Vec<(u64, usize)> = Vec::new();
    let mut episodes_without_indexes = 0usize;
    let mut restarts_without_indexes = 0usize;
    // 每种 start_reason → 条数（校准形状：交付控制应当占绝对多数）。
    let mut start_reasons: std::collections::BTreeMap<&'static str, usize> =
        std::collections::BTreeMap::new();
    let mut restart_kinds: std::collections::BTreeMap<&'static str, usize> =
        std::collections::BTreeMap::new();

    for seed in SEEDS {
        let dm = observed(seed);
        assert!(
            dm.invariant_violations.is_empty(),
            "seed {}：{:#?}",
            seed,
            dm.invariant_violations
        );
        assert_eq!(
            dm.state,
            BehaviorControlState::Ended,
            "seed {} 未收束",
            seed
        );
        // 逐 seed 的闭合（不是只在总数上查）。
        let whistle_t = tail_whistle_t(&dm);
        for e in &dm.possession_episodes {
            assert!(
                e.end_reason.is_some(),
                "seed {}：episode {} 未闭合",
                seed,
                e.id
            );
            *start_reasons.entry(e.start_reason.as_str()).or_insert(0) += 1;
            if e.event_indexes.is_empty() {
                // 空下标**唯一**允许的理由：对象在流截断时刻才被创建（design §15 A9-10）。
                assert!(
                    (e.start_t.value - whistle_t).abs() < 1e-9,
                    "seed {}：episode {}（start_t={}）无事件下标且不在截断时刻（尾哨 {}）",
                    seed,
                    e.id,
                    e.start_t.value,
                    whistle_t
                );
                episodes_without_indexes += 1;
            }
        }
        for r in &dm.restart_sequences {
            assert!(
                r.end_reason.is_some(),
                "seed {}：restart {} 未闭合",
                seed,
                r.id
            );
            *restart_kinds.entry(r.kind.as_str()).or_insert(0) += 1;
            if r.event_indexes.is_empty() {
                assert!(
                    (r.start_t.value - whistle_t).abs() < 1e-9,
                    "seed {}：restart {}（{:?}，start_t={}）无事件下标且不在截断时刻（尾哨 {}）",
                    seed,
                    r.id,
                    r.kind,
                    r.start_t.value,
                    whistle_t
                );
                restarts_without_indexes += 1;
            }
        }
        // **结构不变量（design §15 A9-6 第 3 条）**：一个死球事实 ⟺ 一条 restart sequence
        // （+ `match_started` 创建的首开球那条）。这条证明 recorder **不会凭空造 restart**——
        // 也就是 §6.2「重开一律由死球创建」在真实路径上的机器化表述。
        let dead_balls = dm
            .control_facts
            .iter()
            .filter(|f| f.kind == ControlFactKind::DeadBallStarted)
            .count();
        assert_eq!(
            dm.restart_sequences.len(),
            dead_balls + 1,
            "seed {}：restart 数 {} ≠ 死球事实数 {} + 1（recorder 凭空造了 restart）",
            seed,
            dm.restart_sequences.len(),
            dead_balls
        );
        // **gap 逐条按原因分类**（不是只看总数）：任何落在 [`allowed_gap_details`] 之外的 gap
        // 都是接线 / 流解析缺陷，必须让本 release gate **变红**——即使它只出现在一个非 canary
        // seed 上（例如 seed 250 的 `MissingStreamEndBoundary`）。总数守卫（`gaps <= 5`，见下）
        // **不能**代替这一步：一条缺陷 gap 完全可能落在 5 以内而静默通过。
        //
        // 口径如实记录：90 分钟样本实测 0 gap（`seed 147 @ 120` / `seed 368 @ 400` 才产），
        // 故**在无缺陷的输入上**这条分类分支是休眠的——它的判别力由「注入缺陷 gap 必红」
        // 证明（2026-09-24 实测：seed 250 注入 `MissingStreamEndBoundary` → 本门红，而
        // `gaps <= 5` 仍绿）。允许集**正向**被扫到的覆盖在
        // [`every_gap_on_the_canary_streams_is_a_designed_truncation_not_a_defect`]（它真的看到 gap）。
        let allowed = allowed_gap_details();
        // 单一来源：`gaps` 与 `gap_seeds` 都由分类谓词的返回值记账（不再另调 `gap_count()`
        // 复算一遍，避免谓词将来收窄后两处账目描述不同的事实）。
        let seed_gaps = check_gaps_are_allowed(&dm, seed, DUR, &allowed);
        if seed_gaps > 0 {
            gap_seeds.push((seed, seed_gaps));
        }
        gaps += seed_gaps;
        episodes += dm.possession_episodes.len();
        restarts += dm.restart_sequences.len();
        facts += dm.control_facts.len();
    }

    let elapsed_s = started.elapsed().as_secs_f64();
    // 防空转：口径声明「300 seed × 90 分钟」，样本量不达标就没资格叫校准。
    assert!(
        episodes >= 20_000 && restarts >= 10_000 && facts >= 100_000,
        "样本量不符（episode {} / restart {} / fact {}）：校准口径没跑满",
        episodes,
        restarts,
        facts
    );
    // **次级量级守卫（不代替原因校验）**：原因校验在循环内对每一条 gap 做过
    // （`check_gaps_are_allowed`），这里只额外钉「即使全是合法截断，90 分钟样本上也不该成群出现」
    // ——终场哨只截断**一条**未决飞行。故本断言**不能**被当成分类检查：数量之内混进一条
    // 缺陷 gap（如 seed 250 的 `MissingStreamEndBoundary`）时它照样绿。
    //
    // 默认时长下没有合法截断来源（终场哨恰在 dur，且尾段没有未落地的球时），
    // 实测 300 seed 全 0——但**这不是全称命题**：dur 更短或尾段恰有未落地球时会产
    // （seed 147 @ 120、seed 368 @ 400）。故这里只记录、不把它当通行证。
    assert!(
        gaps <= 5,
        "300 seed × 90min 出现 {} 条 gap（{:?}）——超出「罕见截断」的量级，须逐条查原因",
        gaps,
        gap_seeds
    );

    // 落盘（可复现产物；不进版本库）。
    let out_dir =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/p15-calibration");
    std::fs::create_dir_all(&out_dir).expect("建 target/p15-calibration 失败");
    let out_path = out_dir.join("300-seed-90min.json");
    let mut body = String::new();
    body.push_str("{\n");
    body.push_str(&format!("  \"model_version\": {},\n", MODEL_VERSION));
    body.push_str(&format!("  \"match_duration_seconds\": {},\n", DUR));
    body.push_str("  \"seeds\": [1, 300],\n");
    body.push_str(&format!("  \"matches\": {},\n", SEEDS.count()));
    body.push_str(&format!("  \"elapsed_seconds\": {:.3},\n", elapsed_s));
    body.push_str(&format!("  \"control_facts\": {},\n", facts));
    body.push_str(&format!("  \"possession_episodes\": {},\n", episodes));
    body.push_str(&format!("  \"restart_sequences\": {},\n", restarts));
    body.push_str(&format!("  \"gap_count\": {},\n", gaps));
    body.push_str(&format!("  \"gap_seeds\": {:?},\n", gap_seeds));
    body.push_str(&format!(
        "  \"episodes_without_event_indexes\": {},\n",
        episodes_without_indexes
    ));
    body.push_str(&format!(
        "  \"restarts_without_event_indexes\": {},\n",
        restarts_without_indexes
    ));
    body.push_str(&format!(
        "  \"episode_start_reasons\": {:?},\n",
        start_reasons
    ));
    body.push_str(&format!("  \"restart_kinds\": {:?}\n", restart_kinds));
    body.push_str("}\n");
    std::fs::write(&out_path, &body).expect("写校准证据失败");

    eprintln!(
        "P15 校准（{} 场 × {}s）：{:.1}s；facts={} episodes={} restarts={} gaps={} {:?}",
        SEEDS.count(),
        DUR,
        elapsed_s,
        facts,
        episodes,
        restarts,
        gaps,
        gap_seeds
    );
    eprintln!(
        "  episode start_reasons = {:?}\n  restart kinds = {:?}\n  episode 无下标 {} / restart 无下标 {}（应全部落在流截断时刻）",
        start_reasons, restart_kinds, episodes_without_indexes, restarts_without_indexes
    );
    eprintln!("  证据落盘：{}", out_path.display());
}
