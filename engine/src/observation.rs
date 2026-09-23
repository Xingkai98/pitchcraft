//! #15A 比赛行为观察（Match Behavior Observation）
//!
//! 语义来源：`.scratch/notes/match-behavior-observation-design.md`（Approved for implementation，2026-09-23，
//! 实现增量见 §14 = Slice 1、§15 = Slice 2）。
//! 本模块交付闭集类型、recorder 骨架、opt-in 构造路径与不变量（Slice 1），以及引擎状态提交点
//! 的接入所依赖的命令集（Slice 2：`goal_kick_started` / `EventIndexTarget` /
//! `suspend_event_index_binding`）。**本文件不引用 `MatchState`**——提交点在 `lib.rs` 调用，
//! 本模块不读取事件文本、不做任何推断。
//!
//! 硬约束（本模块的设计边界，逐条可审计）：
//!
//! - **零 RNG、零副作用**：recorder 不持有 `SeededRng`，也不持有 `&mut MatchState`。
//!   它只接收调用方（引擎提交点）提交的事实，因此结构上不可能改变模拟决策或事件流。
//! - **只追加**：`facts` 单调增长；任何路径都不删除或改写已记录的 fact。
//! - **不猜**：证据不足时记 `observation_gap` 或保留闭集里的 `Unknown`，不回填 team/player/kind/时间。
//! - **不 panic**：一致性由 [`BehaviorObservationRecorder::invariant_violations`] 事后检查并返回，
//!   不在模拟过程中断言——sidecar 的错误不得改变比赛结果（design §13）。
//!
//! Slice 1 相对 design 文本的增量（**已同步进 design §14 addendum**，那节是权威表述；
//! 均为附加、不改已有语义）：
//!
//! 1. `ControlFact.detail` 用**类型安全的闭集联合** [`ControlFactDetail`]（不是自由字符串）承载
//!    `DeadBallReason` / `ContestStartReason` / `ContestEndReason` / 缺口原因——design §4 的事实结构
//!    没有这些字段，而闭集枚举必须有落点（`PossessionEpisode` / `RestartSequence` 只覆盖
//!    episode/restart）。缺口原因自身也是闭集（[`ObservationGapReason`] / [`IllegalInput`]），
//!    没有 `&str` 旁路。
//! 2. `BehaviorControlState::BallInFlight.originating_team: TeamRef`（design 写作裸 team）——
//!    design §6.3 自己要求「无法确定时为 unknown，不猜」，故用 `TeamRef` 表达同一规则。
//! 3. `match_started` 在创建开球 sequence 的同时记一条 `restart_preparation_started`——
//!    design §5.1 只写了「创建开球 RestartSequence」，但 §6.2 要求所有重开统一走
//!    `dead_ball_started → restart_preparation_started → restart_taken → open_play_resumed`，
//!    开球同属重开，故按 §6.2 记全。副作用：该 fact 之前没有 `dead_ball_started`（开球处没有死球）。
//! 4. 事件下标绑定规则 + 尾部压缩边界（`source_event_index` / `event_indexes`），见下文
//!    「事件下标绑定规则」。
//!
//! Slice 1 记录的两处**设计缺口**已按 §15 A9 补齐（见 design §15）：
//!
//! - `FlightAction` 闭集补上 `Kickoff` 成员 → 开球拨球不再退化成 `Unknown`（§15 A9-1）；
//! - `RestartEndReason` 闭集补上 `SupersededByDeadBall` → 被新死球顶掉的重开有了具名结束原因，
//!   `Unknown` 恢复原义「证据不足」（§15 A9-2）。该路径**不**记 `observation_gap`
//!   （§5 第二张表列为正常转场）。见 [`BehaviorObservationRecorder::dead_ball_started`]。
//!
//! # Slice 2 的接入对照表（**已接线**，2026-09-23）
//!
//! 下表是 `lib.rs` 各提交点**实际**调用的命令。接线原理：`match_events` 接收一个
//! `&mut BehaviorObservationRecorder`（正式路径传
//! [`BehaviorObservationRecorder::disabled`]，全部命令空操作 → `simulate()` 行为不变、
//! 开销近零（**不作绝对性能承诺**，见 §15 A9-9）），
//! 并把它按值透传给 `tick` / `finalize_highlight` / `advance_*` 一族。**recorder 只被调用，
//! 不参与任何判定**：没有任何分支读它的状态来决定产什么事件。
//!
//! 三条**开球专线**（发动机把「球已交出」和「比赛已恢复」分在不同时刻，最容易接错）：
//!
//! - **首开球**（`lib.rs` `match_events` 起手 `events.push(Kickoff)`，t=0.0，subject 9 → to 10）：
//!   引擎**没有**为它建立高亮或飞行。`MatchState::new` 已经把 `st.carrier = 10`、
//!   `st.possession = 0`、`st.ball_pos = (0.55,0.5)` 提交好了，`match_events` 又把
//!   `st.pos[10] = (0.55,0.5)`（球与接收者同位），**首个 tick 的 beat 就直接给 10 号 `main`**
//!   （实测：`t=1.0 Beat main.subject=10`）。该事件的 `speed = 14.0` 只是装饰——拨球距离
//!   `distance_meters((0.5,0.5),(0.55,0.5)) = 5.25m`，除以 `speed` 得 0.375s < `TICK_SECONDS`(1s)，
//!   引擎从未进入飞行态。
//!   所以这里记 `restart_taken(EngineState)` **紧跟** `control_established(Home, 10, Kickoff)`
//!   （同一提交点 t=0），basis 用 `EngineState`（不是 `FinalizedOutcome`——没有高亮 finalize）。
//!   **不要**为它等 `kickoff_end`、也不要记 `BallInFlight`：那会记录一个引擎里不存在的飞行段。
//!   ⚠️ 这里 `restart_taken` 会把 `state` 置成 `BallInFlight`，随后 `control_established`
//!   立刻收束 restart 并开 episode——**同一个 t 上两条事实、三次状态转场**是设计允许的
//!   （`control_established` 是唯一负责「进入 `Controlled`」的入口，见 §5）。
//! - **进球后的开球**（`advance_dead_ball` 的 `kicked` 段，`lib.rs`）：**与首开球不同，这里真有飞行**。
//!   `restart_taken(RestartRule)` 在 kickoff emit 处；`control_established` 必须等 `kickoff_end`
//!   ——引擎在 `t >= kickoff_end` 才 `st.dead_ball = None` 并产 `main`（`emit_beat_with_main`），
//!   那才是比赛恢复的提交点，时间 basis 用 [`TimeBasis::DeterministicFlightEnd`]（design §8）。
//!   该 `kickoff_end` 由引擎自己算：
//!   `kickoff_end = t + distance_meters((0.5,0.5),(kx2,ky2)) / 12.0`（`speed = 12.0` 硬编码在事件里）。
//!   注意此处的 `st.carrier = receiver` 虽在 kickoff emit 处就提交，但 `dead_ball` 仍在
//!   ——「球已交出」≠「比赛已恢复」，这正是容易接错的地方。
//! - **`kickoff_again` whistle**（`advance_dead_ball` 庆祝结束，`lib.rs`
//!   `whistle_event(t, ..., "kickoff_again")`）：**不调用 `half_time` / `full_time`**。
//!   它不是流边界，而是「进球庆祝 → 开球准备」的转场哨：同一条 kickoff `RestartSequence`
//!   早在 goal finalize 的 `dead_ball_started` 就创建了，这里对应的是
//!   `restart_preparation_started`（紧跟其后的 `preparing = true` 就是准备期开始）。
//!   把这条 whistle 当终场处理会直接终止整场比赛的观察。
//!
//!   **进球路径的重开准备只在这里记一次**——`ShotGoal` finalize 处**不要**再补
//!   `restart_preparation_started`（见下表 `ShotGoal` 行）：那不是它真正的准备起点
//!   （庆祝阶段球还在原地），且第二次调用会因 `state` 已是 `RestartPreparation` 而被判非法、
//!   每个进球白送一条 `IllegalInput(RestartPreparationOutsideDeadBall)` gap。
//!   **犯规路径不同**：`emit_foul_and_free_kick` 之后引擎走 `restart_prep`，没有对应的哨声或
//!   事件提交点，所以那里必须显式补一次（见下表该行与坑 1）。
//!
//! **统一生命周期规则（§15 A9-6，2026-09-23 定案；2026-09-24 更正第 2 条）**：所有重开
//! **一律**在真实的 award / foul / out finalize 提交点先记 `dead_ball_started`（由它创建
//! `RestartSequence`），再由准备期提交点记 `restart_preparation_started`。recorder 侧对应
//! **一条硬规则 + 一条书写约定**：
//!
//! - **【硬规则】** `restart_preparation_started` 要求**已有开放 sequence**，否则记
//!   `IllegalInput(RestartPreparationWithoutScheduledRestart)` gap——**不**凭空造一条
//!   （「没有死球来源的重开」在 §6.2 下没有合法入口，补出来就是猜）；
//! - **【书写约定】** 犯规路径的观察提交（`dead_ball_started` + prep）按**领域事实顺序**写在
//!   `MatchState.restart_prep = Some(..)` 赋值之前——这是**书写约定，没有行为判别力**
//!   （2026-09-24 mutation：调换该行序全量测试仍全绿，因为 tick 顶部的 1b 分支在本函数被调用
//!   **之前**就已判定 `restart_prep`，接管恒发生在下一 tick；见 design §15 A9-6 第 2 条）。
//!   ⚠️ **不要**把该行序写成「反过来会让『未完成重开被新死球顶掉』这条转场在引擎里永不出现、
//!   把设计缺口掩盖掉」——那是**错误因果**。
//!
//! `RestartEndReason::SupersededByDeadBall` 是**recorder 层契约，当前生产引擎不可达**，依据是
//! **结构理由**（不是上面那条行序）：引擎的每个死球结果都在同一 tick 内建立对应重开、且每次
//! 死球之间必有一次控制建立或流结束。见 §15 A9-2 与测试
//! `superseded_by_dead_ball_is_a_recorder_level_contract_not_engine_reachable`（两条结构性
//! 理由 + 2800 场 0 例）。
//!
//! | 引擎提交点（`lib.rs`） | 调用的命令 | 关键参数 |
//! |---|---|---|
//! | `simulate_with_behavior_observations` 起点 | [`BehaviorObservationRecorder::match_started`] | `kicking = Home`（引擎开球恒主队）；时间为 `event_emit(0.0)`（design §14 A3.1 的要求未变——引擎开赛没有独立状态提交点） |
//! | — | — | **本引擎没有中场休息**，无「下半场重新开球」提交点（见坑 5） |
//! | 首开球 kickoff emit（t=0.0） | `restart_taken` **+ `control_established`** | 同在 t=0：`EngineState`（引擎已在 `MatchState::new` 提交 `carrier=10`）；**没有飞行等待**（见开球专线 1） |
//! | `advance_dead_ball` 的 `kickoff_again` whistle | `restart_preparation_started` | `(对方队, Kickoff)` + `RestartRule`；**不是哨声边界**（见开球专线 3） |
//! | `advance_dead_ball` 的 kickoff 段（emit） | `restart_taken` | `RestartRule` |
//! | `advance_dead_ball` 的 kickoff `kickoff_end` 时刻 | `control_established` | 开球接收者 + `Kickoff`；basis `EngineState`，时间 `DeterministicFlightEnd`（**只此一处等飞行**） |
//! | `advance_restart_prep` 的发球高亮（角球/界外球/任意球） | `restart_taken` | `RestartRule`；准备期由 `start_corner` / `start_throw_in` / `emit_foul_and_free_kick` 的 `restart_prep` 设立 |
//! | `finalize_highlight` `PassCaught` | `control_established` | 同队 → 延续；异队 → `prior_episode_end = Some(ControlLost)`；basis `FinalizedOutcome`。start_reason 恒传 `SuccessfulReceive`（开放比赛传接语义），**交付控制由 recorder 按开放 restart 归一**——原先靠 `Highlight::restart_delivery` 在调用点分流，只覆盖了 throw-in/free-kick 那一半 |
//! | ~~`finalize_highlight` `PassIntercepted`（明确控制）~~ | **不存在该分支** | 引擎的 `PassIntercepted` 只启动松散球（`st.carrier = -1`）；拦截者控制一律经 `advance_loose` pickup 提交 → 按 `advance_loose` 行处理 |
//! | `finalize_highlight` `PassIntercepted` | `contest_started` | `InterceptionLoose` + `ControlLost`；随后同刻 `advance_loose` |
//! | `finalize_highlight` `PassLost` | `contest_started` | `PassLost` + `ControlLost`；随后同刻 `advance_loose` |
//! | `finalize_highlight` `ShotGoal` | `dead_ball_started`（**只此一条**） | `Goal` + (对方, `Kickoff`) + `Goal`；准备期由后面的 `kickoff_again` whistle 记（见开球专线 3），此处**不得**再补 prep |
//! | `finalize_highlight` `ShotSavedCaught` | `control_established` | 门将队 + `SavedCaught`（无重开） |
//! | `finalize_highlight` `ShotSavedRebound` | `contest_started` | `ShotRebound` + `ShotRebound` |
//! | `finalize_highlight` `ShotOffTarget` | `start_goal_kick`（= `dead_ball_started` + `restart_taken`） | `OutGoalLine` + (对方, `GoalKick`) + `Out`；门球**无准备期**（见坑 4 / §15 A9-3） |
//! | `finalize_highlight` `PassOutOfPlay` | `dead_ball_started`（门球走 `goal_kick_started`） | `OutSideline` / `OutGoalLine` + `out_restart_for`；按重开类型分派 |
//! | `finalize_highlight` `CornerAward`（射门扑出越线） | `dead_ball_started` | 引擎在 `start_corner` 内隐式进重开 → 在 `start_corner` 处**补报** `dead_ball_started(OutGoalLine, (进攻方, Corner), Out)` |
//! | `finalize_highlight` `TackleSuccess` | `contest_started` | `TackleLoose` + `ControlLost`；随后同刻 `advance_loose` |
//! | `finalize_highlight` `TackleFail` | 不调用（episode 延续） | — |
//! | `advance_loose` 拾取（含 battle 落点） | `control_established` | 恒传 `Pickup`；**开放重开存在**时 recorder 归一为 `RestartControl`（交付控制），否则保留 `Pickup`（真 loose 拾取） |
//! | `emit_shot_highlight` / 各类 pass 高亮 / 开球 | `control_released_into_flight` | 对应 `FlightAction`（开球走 `restart_taken` 而非本命令） |
//! | `emit_foul_and_free_kick` | `dead_ball_started` **+ `restart_preparation_started`** | `Foul` + (被犯规方, `FreeKick`) + `Foul`；引擎随后进入 `restart_prep`，必须显式准备（无哨声提交点）。**观察提交早于 `st.restart_prep = Some(..)` 的赋值**（见 §15 A9-6） |
//! | 出界 `OutRestart::{ThrowIn,Corner}` / `CornerAward` | `dead_ball_started` **+ `restart_preparation_started`** | 二者都设 `restart_prep`（有准备期）；**先记死球再记 prep**（`dead_ball_started` 才是 sequence 的创建点——`CornerAward` 路径原先漏了死球、靠 prep 侧的兜底补，已按 §15 A9-6 改正） |
//! | `start_goal_kick` | `goal_kick_started` | 一次提交完成 `dead_ball_started` + `restart_taken`；**刻意没有** `restart_preparation_started`（引擎里没有准备期），见 §15 A9-3 |
//! | 流末 whistle（`detail = "half_time"`，`lib.rs` 循环结束后唯一一条尾推哨） | [`commit_stream_end_boundary`]（内部调 `full_time`） | `t` **取自该 whistle 事件本身**（[`stream_end_boundary`]）；该提交函数**不接收任何时长参数**，`config.match_duration_seconds` 结构上成不了第二来源（见坑 6）；**该 whistle 是流边界，不是中场哨**（见坑 5） |
//!
//! ## 事件下标绑定规则（`source_event_index` / `event_indexes`）
//!
//! 下标一律指 [`DiagnosticMatch::events`] 的**最终**下标（不是记录时刻的临时长度）。绑定必须经
//! [`BehaviorObservationRecorder::bind_event_index`]，它按 [`EventIndexTarget`] 寻址：
//! `Fact(i)` / `OpenEpisode` / `OpenRestart` / `UnattributedFacts`（水位：本提交点新产出的
//! **全部**事实）/ `LastFactOfKind(k)`（按 kind 找最近一条），并拒绝落在尾部压缩区间内的下标。
//! **不得**绕过它直接往 `episode.event_indexes` / `restart.event_indexes` 里下标。
//! 后两个 target 是**为「接线层不读观察状态」而存在**的：把「本提交点新产出了哪些事实」与
//! 「按 kind 找最近一条」这两类查找都收敛进 recorder，`lib.rs` 侧就不必调 `.facts()`。
//!
//! **归属正确性**（「绑到哪条事件」）与「能不能绑」是两件事，前者由接线层的
//! `Highlight::obs_event` 负责：动作事件在 emit 时入流、结果在若干 tick 后的 `finalize_highlight`
//! 才提交，那时最后一条事件已是飞行期的 beat。故每条高亮在创建时把**产生它的那条事件**
//! 记进 `obs_event`（落点类高亮记的就是它自己的**交付**事件），finalize 与落点争抢都读它。
//! 一个提交点常同时产出多条事实（`dead_ball_started` 顺带 `control_released` / `contest_ended`），
//! 它们同刻同源 → 用 `UnattributedFacts` 水位一次绑完，而不是只绑「最后一条」。
//!
//! 原因：`match_events` 在循环结束后对 `events[drain_start..]` 做 `drain` → `filter`（同时间戳
//! beat 去重）→ `extend` 回填，**该区间内的下标会被重排**；`drain_start` 之前的元素位置不变。
//! 所以：
//!
//! - 循环体内（`tick` / `advance_*` 提交点）绑定 `events.len() - 1` 是安全的；
//! - 排空期（`while st.highlight.is_some()` 里的 `finalize_highlight`）绑定**不安全**——该区间的
//!   beat 会被去重丢弃、下标前移，而**全部**排空完成前无法确定任何最终下标。故接线层在进入排空
//!   循环**之前**先登记边界、再 [`BehaviorObservationRecorder::suspend_event_index_binding`]`(true)`：
//!   暂停期内 `bind_event_index` 一律不生效且**不记 gap**（事实仍有 `t` 与 `detail` 可定位）。
//! - 登记边界也要**在排空循环之前**（`note_event_stream_compaction(drain_start)`）：
//!   此后落在 `[drain_start, ..)` 的绑定被拒绝并记 `observation_gap`（不静默错位）。
//!   把登记推迟到循环之后（Slice 2 的第一版）等于装饰——排空期不受保护，且此后没有任何绑定
//!   会去查该边界。两道防线的分工：**暂停管排空期的正确性、边界管更晚/将来引入的绑定**。
//!
//! 未登记边界时（如 demo 路径、无尾部压缩）视为「全部下标稳定」。
//!
//! 易踩的坑（Round 4/5/6 审阅对 `lib.rs` 控制流实测；编号沿用历史，第 3 条已并入坑 5）：
//!
//! 1. **`dead_ball_started` 之后必须进入准备期**再 `restart_taken`，但**谁来记 prep 取决于路径**：
//!    goal 由 `kickoff_again` whistle 记一次（庆祝结束、`preparing = true` 的同一刻，见开球专线 3）；
//!    foul 没有对应提交点，必须在 `emit_foul_and_free_kick` 处显式补一条；
//!    corner / throw-in 由 `start_corner` / `start_throw_in` 记（它们自己建 `restart_prep`）。
//!    缺 prep 时 `restart_taken` 会被判非法（记 gap）；但 goal 路径**多记一次**同样错
//!    （见开球专线 3 的告警）。（**例外见坑 4**：门球连准备期都没有。）
//! 2. **角球的死球来源不在 `start_corner` 里**：`start_corner` 只设 `restart_prep`，不产事件、
//!    不推进观察状态。死球与 prep 两条事实都由**调用它的 `finalize_highlight` 分支**
//!    （`CornerAward` / 出界 `OutRestart::Corner`）提交，顺序是
//!    `dead_ball_started` → `start_corner` → `restart_preparation_started`（§15 A9-6）。
//!    若只报 prep 不报死球，prep 会被 `RestartPreparationWithoutScheduledRestart` 拒掉。
//! 3. （已并入坑 5：本引擎没有中场休息，无可接线的半场提交点。）
//! 4. **门球（`start_goal_kick`）没有准备期**——按 §15 A9-3 定为 §6.2 统一生命周期的**结构性例外**
//!    （与半场/终场同类）。引擎 `start_goal_kick` 同步发 pass 高亮、**不设** `restart_prep`，
//!    因此没有 `restart_preparation_started` 提交点。处理：走专用入口
//!    [`BehaviorObservationRecorder::goal_kick_started`]（`dead_ball_started` + `restart_taken`
//!    同刻），**不**补记 prep——补记等于发明一个引擎里不存在的阶段。
//!    门球的 `taken_t` 必须落上：否则门球交付后的首次明确控制会造出「有 `open_play_resumed_t`
//!    但无 `taken_t`」，直接违反不变量 5。
//! 5. **本引擎没有中场休息——design §5.1 的「下半场重新进入 `RestartPreparation(kickoff)`」没有对应提交点。**
//!    `match_events` 是单段循环 `while t < dur`，结束后只在 `dur` 推一条 `detail = "half_time"`
//!    的 whistle（lib.rs）；没有中场哨复位、没有第二段循环、没有下半场开球。那条 whistle 是
//!    **流边界**，opt-in 路径因此把它映射为 `full_time`。`half_time()` 至今**无调用点**，
//!    是留给引擎将来真正实现中场休息时的骨架。**不得按本表想象一个中场提交点。**
//! 6. **终场时间只有一个来源：正式事件流里的那条尾哨。** opt-in 路径从事件流本身取
//!    （[`stream_end_boundary`]），与 `simulate()` 看到的 `events` 同源；若改成在读 config 的
//!    `match_duration_seconds`（引擎恰好也用它推哨），两个来源一旦漂移（例如将来引擎改为在
//!    真实补时后推哨）就会静默错位——观察 sidecar 的终场时间会对不上它自己输出的那条 whistle。
//!    流里找不到 whistle 时**不硬编码**时间，改记 `observation_gap`（见
//!    [`ObservationGapReason::MissingStreamEndBoundary`]）。
//!
//!    **这条约束靠结构保证，不靠测试区分**：本引擎恰好在 `config.match_duration_seconds` 处推尾哨，
//!    故 `whistle.t == config` 恒成立，正确接线与旧实现 `full_time(config.match_duration_seconds)`
//!    在真实路径上**观测等价**。因此提交收敛到 [`commit_stream_end_boundary`]——它只收 `events`，
//!    调用方结构上递不进任何时长；判别力则由**手工构造的 `whistle@123.0`** 流提供
//!    （见 `full_time_time_comes_from_the_formal_whistle_not_config`），
//!    接线层另有源码守卫（`lib.rs` `p15_full_time_source_is_the_stream_not_the_config_duration`）。
//!
//! 7. **哨声打断的边界：`kickoff_again` 不是流边界。** `advance_dead_ball` 会在流中间产
//!    `detail = "kickoff_again"` 的 whistle（进球庆祝结束的转场），它**不得**触发
//!    `full_time` / `half_time`。`stream_end_boundary` 取**最后一条** whistle，其判别力由
//!    observation.rs 的手工双哨流测试提供（`[150.0, 123.0]` → 取 123.0）。
//!    在真实流里，若整场比赛恰好在某次 `kickoff_again` 之后被 `dur` 截断（循环条件 `t < dur`），
//!    则「最后一条 whistle」可能是那条**转场哨**而非终场哨——**本引擎当前不可达**：
//!    庆祝期（`remaining` 2 tick）+ 准备期（开球者走向中圈）+ kickoff 飞行都在 `dur` 之前完成，
//!    且截断只可能发生在死球/高亮中途，此时尾哨尚未产出。这条推理若将来失效（例如引入补时），
//!    `stream_end_boundary` 必须改成按 `detail` 区分转场哨与终场哨。
//!
//! 未列动作（design §5「未列动作视为冲突输入」）走 [`BehaviorObservationRecorder::note_gap`]，
//! **不要**自己猜测一个 team / kind / 时间填进去。
//!
//! 接线层另有源码守卫（`lib.rs` 的 `p15_...` 系列测试）扫描函数体，防止 recorder 被写进
//! 决策路径（例如 `simulate()` / `match_events` 出现 `.is_enabled()` 分支）或终场时间第二来源。

use crate::Event;

// ============================== 队伍身份 ==============================

/// 球队身份。0-10 = home，11-21 = away（引擎的 id 方案，见 design §2 与 `default_lineup`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TeamId {
    Home,
    Away,
}

impl TeamId {
    /// 闭集全成员（守护「闭集完整性」：新增成员时串名/单调性测试会因漏列而红）。
    pub const ALL: &'static [TeamId] = &[Self::Home, Self::Away];

    pub const fn as_str(self) -> &'static str {
        match self {
            TeamId::Home => "home",
            TeamId::Away => "away",
        }
    }

    /// 球员 id → 球队。非法 id（< 0 / > 21）返回 `None`，不猜。
    pub fn from_player(id: i32) -> Option<TeamId> {
        match id {
            0..=10 => Some(TeamId::Home),
            11..=21 => Some(TeamId::Away),
            _ => None,
        }
    }

    pub const fn opponent(self) -> TeamId {
        match self {
            TeamId::Home => TeamId::Away,
            TeamId::Away => TeamId::Home,
        }
    }
}

/// 允许 `unknown` 的队伍归属（design §10.1：`unknown` 只在证据不足时使用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TeamRef {
    Home,
    Away,
    Unknown,
}

impl TeamRef {
    /// 闭集全成员（守护「闭集完整性」：新增成员时串名/单调性测试会因漏列而红）。
    pub const ALL: &'static [TeamRef] = &[Self::Home, Self::Away, Self::Unknown];

    pub const fn as_str(self) -> &'static str {
        match self {
            TeamRef::Home => "home",
            TeamRef::Away => "away",
            TeamRef::Unknown => "unknown",
        }
    }

    pub const fn known(self) -> Option<TeamId> {
        match self {
            TeamRef::Home => Some(TeamId::Home),
            TeamRef::Away => Some(TeamId::Away),
            TeamRef::Unknown => None,
        }
    }
}

impl From<TeamId> for TeamRef {
    fn from(team: TeamId) -> Self {
        match team {
            TeamId::Home => TeamRef::Home,
            TeamId::Away => TeamRef::Away,
        }
    }
}

impl From<Option<TeamId>> for TeamRef {
    fn from(team: Option<TeamId>) -> Self {
        match team {
            Some(t) => TeamRef::from(t),
            None => TeamRef::Unknown,
        }
    }
}

// ============================== 时间语义（design §8） ==============================

/// 时间字段的来源（不输出伪精确 `confidence`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TimeBasis {
    /// 引擎提交 `carrier` / `possession` 的时刻。
    StateCommit,
    /// 动作 / 高亮开始（`event.t`）。
    EventEmit,
    /// 高亮 `t_end`：确定性飞行结束。
    DeterministicFlightEnd,
    /// 时间不可得（不从 viewer 插值倒推引擎事实）。
    Unknown,
}

impl TimeBasis {
    /// 闭集全成员（守护「闭集完整性」：新增成员时串名/单调性测试会因漏列而红）。
    pub const ALL: &'static [TimeBasis] = &[
        Self::StateCommit,
        Self::EventEmit,
        Self::DeterministicFlightEnd,
        Self::Unknown,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            TimeBasis::StateCommit => "state_commit",
            TimeBasis::EventEmit => "event_emit",
            TimeBasis::DeterministicFlightEnd => "deterministic_flight_end",
            TimeBasis::Unknown => "unknown",
        }
    }
}

/// 带来源的比赛时间（秒）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ObservedTime {
    pub value: f64,
    pub basis: TimeBasis,
}

impl ObservedTime {
    pub const fn new(value: f64, basis: TimeBasis) -> Self {
        ObservedTime { value, basis }
    }

    pub const fn state_commit(value: f64) -> Self {
        ObservedTime::new(value, TimeBasis::StateCommit)
    }

    pub const fn event_emit(value: f64) -> Self {
        ObservedTime::new(value, TimeBasis::EventEmit)
    }

    pub const fn flight_end(value: f64) -> Self {
        ObservedTime::new(value, TimeBasis::DeterministicFlightEnd)
    }

    /// 时间不可得（design §8：不从 viewer 插值倒推引擎事实）。值为 `NaN`，
    /// [`Self::is_finite`] 为 `false`——只有**不携带时间语义的缺口事实**才可用它。
    pub const fn unknown() -> Self {
        ObservedTime::new(f64::NAN, TimeBasis::Unknown)
    }

    pub fn is_finite(&self) -> bool {
        self.value.is_finite()
    }
}

// ============================== 事实闭集（design §4） ==============================

/// 事实类型闭集（design §4）。`unknown` 不在其中：事实只表达「已确认发生了什么」。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ControlFactKind {
    MatchStarted,
    ControlEstablished,
    ControlReleased,
    ContestStarted,
    ContestEnded,
    DeadBallStarted,
    RestartPreparationStarted,
    RestartTaken,
    OpenPlayResumed,
    ObservationGap,
    MatchEnded,
}

impl ControlFactKind {
    /// 闭集全成员（守护「闭集完整性」：新增成员时串名/单调性测试会因漏列而红）。
    pub const ALL: &'static [ControlFactKind] = &[
        Self::MatchStarted,
        Self::ControlEstablished,
        Self::ControlReleased,
        Self::ContestStarted,
        Self::ContestEnded,
        Self::DeadBallStarted,
        Self::RestartPreparationStarted,
        Self::RestartTaken,
        Self::OpenPlayResumed,
        Self::ObservationGap,
        Self::MatchEnded,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            ControlFactKind::MatchStarted => "match_started",
            ControlFactKind::ControlEstablished => "control_established",
            ControlFactKind::ControlReleased => "control_released",
            ControlFactKind::ContestStarted => "contest_started",
            ControlFactKind::ContestEnded => "contest_ended",
            ControlFactKind::DeadBallStarted => "dead_ball_started",
            ControlFactKind::RestartPreparationStarted => "restart_preparation_started",
            ControlFactKind::RestartTaken => "restart_taken",
            ControlFactKind::OpenPlayResumed => "open_play_resumed",
            ControlFactKind::ObservationGap => "observation_gap",
            ControlFactKind::MatchEnded => "match_ended",
        }
    }
}

/// 事实的确认依据（design §4）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ControlFactBasis {
    /// 引擎状态已提交（`carrier` / `possession` / `dead_ball` 等）。
    EngineState,
    /// 高亮 finalize 的既定结果。
    FinalizedOutcome,
    /// 规则决定的重开（不依赖具体动作结果）。
    RestartRule,
    /// 事件流边界（哨声 / 流提前截断）。
    StreamBoundary,
}

impl ControlFactBasis {
    /// 闭集全成员（守护「闭集完整性」：新增成员时串名/单调性测试会因漏列而红）。
    pub const ALL: &'static [ControlFactBasis] = &[
        Self::EngineState,
        Self::FinalizedOutcome,
        Self::RestartRule,
        Self::StreamBoundary,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            ControlFactBasis::EngineState => "engine_state",
            ControlFactBasis::FinalizedOutcome => "finalized_outcome",
            ControlFactBasis::RestartRule => "restart_rule",
            ControlFactBasis::StreamBoundary => "stream_boundary",
        }
    }
}

/// 一条已确认的控制权事实（design §4）。
///
/// `detail` 承载 kind 相关的闭集限定符（Slice 1 增量，见模块头注释与 design §14 A1）：
/// `dead_ball_started` → `DeadBallReason`；`contest_started` → `ContestStartReason`；
/// `contest_ended` → `ContestEndReason`；`observation_gap` → 缺口原因。其余 kind 恒 `None`
/// （episode 的起止原因在 [`PossessionEpisode`]，重开的 kind/结束原因在 [`RestartSequence`]）。
/// 不变量 10 强制 `detail` 与 `kind` 配对（见
/// [`BehaviorObservationRecorder::invariant_violations`]），因此不存在「用错误 kind 塞 detail」的余地。
#[derive(Debug, Clone, PartialEq)]
pub struct ControlFact {
    pub t: ObservedTime,
    pub kind: ControlFactKind,
    /// 该事实归属的球队。语义**随 kind 而定**（design §10.1 各事实的主语不同）：
    /// - `control_established` / `control_released` / `restart_taken` / `match_started` /
    ///   `open_play_resumed`：该事实的主队（建立/释放/发出/开赛/恢复控制的一方）；
    /// - `dead_ball_started` / `restart_preparation_started`：**重开的受益方**（可 `None` = unknown）；
    /// - `contest_started`：失去控制的一方（= `Contested.previous_team`）；
    /// - `contest_ended` / `observation_gap` / `match_ended`：恒 `None`。
    pub team: Option<TeamId>,
    pub player: Option<i32>,
    /// 事件位置（归一化 0-1；出界点可越界，与正式协议 `out_pos` 同）。
    pub location: Option<(f64, f64)>,
    /// 产生该事实的正式事件下标（在 `DiagnosticMatch.events` 的**最终**下标空间里）；
    /// 无对应事件时为 `None`。绑定必须经
    /// [`BehaviorObservationRecorder::bind_event_index`]（见模块头「事件下标绑定规则」）。
    pub source_event_index: Option<usize>,
    pub basis: ControlFactBasis,
    pub detail: Option<ControlFactDetail>,
}

/// `ControlFact` 的 kind 相关限定符（design §4 的事实结构 + Slice 1 增量 A1）。
///
/// 这是一个**封闭联合**：每个成员绑定一个 `ControlFactKind`（见 [`Self::fact_kind`]），
/// 且各成员的载荷都是另一个闭集枚举——不存在自由字符串旁路，JSON 序列化时按 `as_str` 输出。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ControlFactDetail {
    DeadBall(DeadBallReason),
    ContestStart(ContestStartReason),
    ContestEnd(ContestEndReason),
    Gap(ObservationGapReason),
}

impl ControlFactDetail {
    /// 该 detail 只允许出现在这个 kind 上（不变量 10）。
    pub const fn fact_kind(self) -> ControlFactKind {
        match self {
            ControlFactDetail::DeadBall(_) => ControlFactKind::DeadBallStarted,
            ControlFactDetail::ContestStart(_) => ControlFactKind::ContestStarted,
            ControlFactDetail::ContestEnd(_) => ControlFactKind::ContestEnded,
            ControlFactDetail::Gap(_) => ControlFactKind::ObservationGap,
        }
    }

    /// 载荷的闭集串名（JSON / 断言用）。
    pub const fn as_str(self) -> &'static str {
        match self {
            ControlFactDetail::DeadBall(r) => r.as_str(),
            ControlFactDetail::ContestStart(r) => r.as_str(),
            ControlFactDetail::ContestEnd(r) => r.as_str(),
            ControlFactDetail::Gap(r) => r.as_str(),
        }
    }
}

/// `observation_gap` 的原因闭集（design §10：矛盾输入或流边界打断）。
///
/// 只用闭集成员表达原因——**不留自由字符串**，否则「不猜」这条硬约束在 gap 路径上会失效
/// （任意文本都能塞进来，基线无法按原因聚合，也无法守护枚举完整性）。
///
/// **`ALL` 必须列全每个 [`IllegalInput`] 成员**（每个成员单独包装成一条 gap 原因）：
/// 只列一个代表成员会让其余 10 个在 [`BehaviorObservationRecorder::gap_reason_counts`] 里
/// 永远显示 0 条，按原因聚合的基线会静默漏掉整个 `illegal_input` 族。
/// 守护见 `every_closed_set_enum_lists_all_members` 与
/// `gap_reason_counts_aggregate_by_reason_not_just_total`；前者注释里写明了守护的**能力边界**
/// （漏列能抓、新增变体未列入 `ALL` 抓不到）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ObservationGapReason {
    /// 半场哨打断未决飞行（design §5 第二张表）。
    HalfTimeDuringBallInFlight,
    /// 终场哨打断未决飞行（design §5 第二张表）。
    FullTimeDuringBallInFlight,
    /// 引擎提交点发出了当前状态不允许的输入（design §5 补充规则）。
    IllegalInput(IllegalInput),
    /// 正式事件流里找不到终场 whistle，无法确定观察终点（不硬编码时间，见模块头坑 6）。
    MissingStreamEndBoundary,
    /// 事件下标绑定落在尾部压缩区间内，无法定位原始事件（见模块头「事件下标绑定规则」）。
    EventIndexOutOfStableRange,
    /// 绑定目标 fact 下标越界（调用方传错），与压缩无关——分开报以便按原因定位。
    IllegalFactIndex,
    /// 重绑把某条事实的 `source_event_index` **改小**（来源倒退）。见
    /// [`BehaviorObservationRecorder::bind_event_index`] 第 ③ 步：当前接线依赖「覆写总是发生在
    /// 更晚的下标上」（门球的 taken 从死球事件改绑到更晚的交付事件），倒退会让来源错位。
    EventIndexRegressed,
}

impl ObservationGapReason {
    pub const ALL: &'static [ObservationGapReason] = &[
        ObservationGapReason::HalfTimeDuringBallInFlight,
        ObservationGapReason::FullTimeDuringBallInFlight,
        ObservationGapReason::MissingStreamEndBoundary,
        ObservationGapReason::EventIndexOutOfStableRange,
        ObservationGapReason::IllegalFactIndex,
        ObservationGapReason::EventIndexRegressed,
        ObservationGapReason::IllegalInput(IllegalInput::MatchStartedOutsideUninitialized),
        ObservationGapReason::IllegalInput(IllegalInput::DeadBallStartedInIllegalState),
        ObservationGapReason::IllegalInput(IllegalInput::RestartPreparationOutsideDeadBall),
        ObservationGapReason::IllegalInput(
            IllegalInput::RestartPreparationWithoutScheduledRestart,
        ),
        ObservationGapReason::IllegalInput(
            IllegalInput::RestartPreparationContradictsScheduledRestart,
        ),
        ObservationGapReason::IllegalInput(IllegalInput::RestartTakenOutsideRestartPreparation),
        ObservationGapReason::IllegalInput(IllegalInput::ControlEstablishedInIllegalState),
        ObservationGapReason::IllegalInput(IllegalInput::ControlEstablishedBeforeRestartTaken),
        ObservationGapReason::IllegalInput(
            IllegalInput::ControlEstablishedByOpponentWhileControlled,
        ),
        ObservationGapReason::IllegalInput(
            IllegalInput::ControlReleasedIntoFlightOutsideControlled,
        ),
        ObservationGapReason::IllegalInput(IllegalInput::ContestStartedWhileContested),
        ObservationGapReason::IllegalInput(IllegalInput::ContestStartedInIllegalState),
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            ObservationGapReason::HalfTimeDuringBallInFlight => "half_time_during_ball_in_flight",
            ObservationGapReason::FullTimeDuringBallInFlight => "full_time_during_ball_in_flight",
            ObservationGapReason::IllegalInput(r) => r.as_str(),
            ObservationGapReason::MissingStreamEndBoundary => "missing_stream_end_boundary",
            ObservationGapReason::EventIndexOutOfStableRange => "event_index_out_of_stable_range",
            ObservationGapReason::IllegalFactIndex => "illegal_fact_index",
            ObservationGapReason::EventIndexRegressed => "event_index_regressed",
        }
    }
}

/// 被 [`BehaviorObservationRecorder::reject`] 收束的非法引擎输入（闭集）。
///
/// 成员名就是引擎提交点的调用语境——`reject` 只接收这个枚举，因此 gap 原因永远是有限可枚举的。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum IllegalInput {
    MatchStartedOutsideUninitialized,
    DeadBallStartedInIllegalState,
    RestartPreparationOutsideDeadBall,
    RestartPreparationWithoutScheduledRestart,
    RestartPreparationContradictsScheduledRestart,
    RestartTakenOutsideRestartPreparation,
    ControlEstablishedInIllegalState,
    ControlEstablishedBeforeRestartTaken,
    ControlEstablishedByOpponentWhileControlled,
    ControlReleasedIntoFlightOutsideControlled,
    ContestStartedWhileContested,
    ContestStartedInIllegalState,
}

impl IllegalInput {
    pub const ALL: &'static [IllegalInput] = &[
        IllegalInput::MatchStartedOutsideUninitialized,
        IllegalInput::DeadBallStartedInIllegalState,
        IllegalInput::RestartPreparationOutsideDeadBall,
        IllegalInput::RestartPreparationWithoutScheduledRestart,
        IllegalInput::RestartPreparationContradictsScheduledRestart,
        IllegalInput::RestartTakenOutsideRestartPreparation,
        IllegalInput::ControlEstablishedInIllegalState,
        IllegalInput::ControlEstablishedBeforeRestartTaken,
        IllegalInput::ControlEstablishedByOpponentWhileControlled,
        IllegalInput::ControlReleasedIntoFlightOutsideControlled,
        IllegalInput::ContestStartedWhileContested,
        IllegalInput::ContestStartedInIllegalState,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            IllegalInput::MatchStartedOutsideUninitialized => "match_started_outside_uninitialized",
            IllegalInput::DeadBallStartedInIllegalState => "dead_ball_started_in_illegal_state",
            IllegalInput::RestartPreparationOutsideDeadBall => {
                "restart_preparation_outside_dead_ball"
            }
            IllegalInput::RestartPreparationWithoutScheduledRestart => {
                "restart_preparation_without_scheduled_restart"
            }
            IllegalInput::RestartPreparationContradictsScheduledRestart => {
                "restart_preparation_contradicts_scheduled_restart"
            }
            IllegalInput::RestartTakenOutsideRestartPreparation => {
                "restart_taken_outside_restart_preparation"
            }
            IllegalInput::ControlEstablishedInIllegalState => {
                "control_established_in_illegal_state"
            }
            IllegalInput::ControlEstablishedBeforeRestartTaken => {
                "control_established_before_restart_taken"
            }
            IllegalInput::ControlEstablishedByOpponentWhileControlled => {
                "control_established_by_opponent_while_controlled"
            }
            IllegalInput::ControlReleasedIntoFlightOutsideControlled => {
                "control_released_into_flight_outside_controlled"
            }
            IllegalInput::ContestStartedWhileContested => "contest_started_while_contested",
            IllegalInput::ContestStartedInIllegalState => "contest_started_in_illegal_state",
        }
    }
}

// ============================== 死球 / 重开 / 飞行的闭集（design §10.1） ==============================

/// 重开方式（design §10.1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RestartKind {
    Kickoff,
    FreeKick,
    Corner,
    ThrowIn,
    GoalKick,
    Unknown,
}

impl RestartKind {
    /// 闭集全成员（守护「闭集完整性」：新增成员时串名/单调性测试会因漏列而红）。
    pub const ALL: &'static [RestartKind] = &[
        Self::Kickoff,
        Self::FreeKick,
        Self::Corner,
        Self::ThrowIn,
        Self::GoalKick,
        Self::Unknown,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            RestartKind::Kickoff => "kickoff",
            RestartKind::FreeKick => "free_kick",
            RestartKind::Corner => "corner",
            RestartKind::ThrowIn => "throw_in",
            RestartKind::GoalKick => "goal_kick",
            RestartKind::Unknown => "unknown",
        }
    }
}

/// 死球来源（design §10.1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DeadBallReason {
    Goal,
    OutSideline,
    OutGoalLine,
    Foul,
    HalfTime,
    FullTime,
    Unknown,
}

impl DeadBallReason {
    /// 闭集全成员（守护「闭集完整性」：新增成员时串名/单调性测试会因漏列而红）。
    pub const ALL: &'static [DeadBallReason] = &[
        Self::Goal,
        Self::OutSideline,
        Self::OutGoalLine,
        Self::Foul,
        Self::HalfTime,
        Self::FullTime,
        Self::Unknown,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            DeadBallReason::Goal => "goal",
            DeadBallReason::OutSideline => "out_sideline",
            DeadBallReason::OutGoalLine => "out_goal_line",
            DeadBallReason::Foul => "foul",
            DeadBallReason::HalfTime => "half_time",
            DeadBallReason::FullTime => "full_time",
            DeadBallReason::Unknown => "unknown",
        }
    }
}

/// 球在飞行中的出球类型（design §10.1、§5；`Kickoff` 为 Slice 2 增量，见 §15 A9-1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FlightAction {
    Pass,
    Clearance,
    Shot,
    Corner,
    ThrowIn,
    FreeKick,
    GoalKick,
    /// 开球（中圈拨球）。§10.1 初版闭集没有该成员，Slice 1 把开球记成 `Unknown`；
    /// Slice 2 按 §15 A9-1 补上——开球拨球**不是** `Pass`（不代设计做等价映射），
    /// 但它确实是一种确定的出球方式，不该退化成「证据不足」。
    Kickoff,
    Unknown,
}

impl FlightAction {
    /// 闭集全成员（守护「闭集完整性」：新增成员时串名/单调性测试会因漏列而红）。
    pub const ALL: &'static [FlightAction] = &[
        Self::Pass,
        Self::Clearance,
        Self::Shot,
        Self::Corner,
        Self::ThrowIn,
        Self::FreeKick,
        Self::GoalKick,
        Self::Kickoff,
        Self::Unknown,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            FlightAction::Pass => "pass",
            FlightAction::Clearance => "clearance",
            FlightAction::Shot => "shot",
            FlightAction::Corner => "corner",
            FlightAction::ThrowIn => "throw_in",
            FlightAction::FreeKick => "free_kick",
            FlightAction::GoalKick => "goal_kick",
            FlightAction::Kickoff => "kickoff",
            FlightAction::Unknown => "unknown",
        }
    }
}

/// 重开片段的结束方式（design §10.1；`SupersededByDeadBall` 为 Slice 2 增量，见 §15 A9-2）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RestartEndReason {
    OpenPlayResumed,
    TerminatedByWhistle,
    MatchEnd,
    /// 重开尚未完成就被**新的死球**顶掉（design §5 第二张表列为**正常**转场）。
    ///
    /// §10.1 初版闭集没有该成员，Slice 1 只能以 `Unknown` 结束这类 sequence——代价是
    /// `gap_count() == 0` **不蕴含**所有 restart 都有明确结束原因，且把「正常转场」与
    /// 「证据不足」混成同一个值。Slice 2 按 §15 A9-2 补上，使 `Unknown` 恢复其原义
    /// （仅表示输入证据不足）。
    SupersededByDeadBall,
    Unknown,
}

impl RestartEndReason {
    /// 闭集全成员（守护「闭集完整性」：新增成员时串名/单调性测试会因漏列而红）。
    pub const ALL: &'static [RestartEndReason] = &[
        Self::OpenPlayResumed,
        Self::TerminatedByWhistle,
        Self::MatchEnd,
        Self::SupersededByDeadBall,
        Self::Unknown,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            RestartEndReason::OpenPlayResumed => "open_play_resumed",
            RestartEndReason::TerminatedByWhistle => "terminated_by_whistle",
            RestartEndReason::MatchEnd => "match_end",
            RestartEndReason::SupersededByDeadBall => "superseded_by_dead_ball",
            RestartEndReason::Unknown => "unknown",
        }
    }
}

/// 开放 episode 的开启原因（design §10.1）。
///
/// **各成员在生产接线里的归属**（只写事实，避免「成员存在 = 生产可达」的误读）：
///
/// - `Kickoff`：**只**由首开球路径传（`lib.rs` 首开球提交点，t=0）。有开放 restart，但 recorder
///   的交付归一显式排除它（开赛 ≠ 重开交付），故它是唯一能以 `Kickoff` 开 episode 的路径。
/// - `Pickup`：`advance_loose` 普通拾取与 battle 落点胜方**传入**的值。开放比赛里即为真
///   loose 拾取；存在开放重启时被归一为 `RestartControl`。
/// - `RestartControl`：**交付控制的最终值**——所有「开放 restart 存在时的首次明确控制」都归一
///   到它（角球/门球落点 pickup、界外球/任意球 `PassCaught`、进球后开球恢复）。因此它同时是
///   调用方传入值（进球后开球那处显式传）与归一结果。
/// - `SuccessfulReceive`：**开放比赛传球接住**（`PassCaught`）的语义值；**当前生产路径上不可达**
///   ——原因在 `control_established` 内部：开放比赛的 `PassCaught` 确实**传入**该值
///   （`lib.rs` 的 `PassCaught` 提交点），且它不属 throw-in / free-kick 交付（那两者有开放
///   restart → 归一为 `RestartControl`）；但接球方与当前 episode 同队（传球不切 possession），
///   于是走 `same_team_open`分支**延续** episode、`start_reason` 根本不被消费
///   （只有 `open_new_episode` 读它）。实测：1600 场里 0 条；在临时副本里把 `same_team_open`
///   强制为 `false` 会立刻产出 23 万条——证明「抑制点是同队延续」，不是「接球控制走了
///   `advance_loose` pickup」。
///   保留该成员是因为它是 design §10.1 的闭集成员且语义明确（「开放比赛成功接球但**不**新建
///   episode」这一情形将来若接线就落到它），但**不得**据此声称生产路径已产出该值。
/// - `ControlChange`：门将扑救接住（`ShotSavedCaught`）开启新 episode（无重开安排）。
/// - `Unknown`：证据不足，生产路径不用。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EpisodeStartReason {
    Kickoff,
    Pickup,
    SuccessfulReceive,
    RestartControl,
    ControlChange,
    Unknown,
}

impl EpisodeStartReason {
    /// 闭集全成员（守护「闭集完整性」：新增成员时串名/单调性测试会因漏列而红）。
    pub const ALL: &'static [EpisodeStartReason] = &[
        Self::Kickoff,
        Self::Pickup,
        Self::SuccessfulReceive,
        Self::RestartControl,
        Self::ControlChange,
        Self::Unknown,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            EpisodeStartReason::Kickoff => "kickoff",
            EpisodeStartReason::Pickup => "pickup",
            EpisodeStartReason::SuccessfulReceive => "successful_receive",
            EpisodeStartReason::RestartControl => "restart_control",
            EpisodeStartReason::ControlChange => "control_change",
            EpisodeStartReason::Unknown => "unknown",
        }
    }
}

/// 开放 episode 的结束原因（design §9、§10.1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EpisodeEndReason {
    Goal,
    SavedCaught,
    ShotRebound,
    Out,
    Foul,
    ControlLost,
    WhistleInterrupt,
    HalfTime,
    FullTime,
    ObservationGap,
}

impl EpisodeEndReason {
    /// 闭集全成员（守护「闭集完整性」：新增成员时串名/单调性测试会因漏列而红）。
    pub const ALL: &'static [EpisodeEndReason] = &[
        Self::Goal,
        Self::SavedCaught,
        Self::ShotRebound,
        Self::Out,
        Self::Foul,
        Self::ControlLost,
        Self::WhistleInterrupt,
        Self::HalfTime,
        Self::FullTime,
        Self::ObservationGap,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            EpisodeEndReason::Goal => "goal",
            EpisodeEndReason::SavedCaught => "saved_caught",
            EpisodeEndReason::ShotRebound => "shot_rebound",
            EpisodeEndReason::Out => "out",
            EpisodeEndReason::Foul => "foul",
            EpisodeEndReason::ControlLost => "control_lost",
            EpisodeEndReason::WhistleInterrupt => "whistle_interrupt",
            EpisodeEndReason::HalfTime => "half_time",
            EpisodeEndReason::FullTime => "full_time",
            EpisodeEndReason::ObservationGap => "observation_gap",
        }
    }
}

/// 进入争抢的原因（design §10.1；`DeliveryLoose` 为 Slice 2 增量，见 §15 A9-3）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ContestStartReason {
    PassLost,
    InterceptionLoose,
    TackleLoose,
    ShotRebound,
    /// **定位球 / 解围发出后落点变松散球**（角球落点 battle、门球落点、解围落点）。
    ///
    /// §10.1 初版闭集没有该成员：这几种落地争抢既不是 `pass_lost`（开放比赛传球失准），
    /// 也不是其余任何一项，若强行套用会把「定位球交付的落点争抢」伪装成开放比赛事实
    /// （与 §6.2「定位球不伪装成普通开放比赛 possession」同一条原则）。故补一个具名成员。
    DeliveryLoose,
    Unknown,
}

impl ContestStartReason {
    /// 闭集全成员（守护「闭集完整性」：新增成员时串名/单调性测试会因漏列而红）。
    pub const ALL: &'static [ContestStartReason] = &[
        Self::PassLost,
        Self::InterceptionLoose,
        Self::TackleLoose,
        Self::ShotRebound,
        Self::DeliveryLoose,
        Self::Unknown,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            ContestStartReason::PassLost => "pass_lost",
            ContestStartReason::InterceptionLoose => "interception_loose",
            ContestStartReason::TackleLoose => "tackle_loose",
            ContestStartReason::ShotRebound => "shot_rebound",
            ContestStartReason::DeliveryLoose => "delivery_loose",
            ContestStartReason::Unknown => "unknown",
        }
    }
}

/// 离开争抢的原因（design §10.1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ContestEndReason {
    Pickup,
    DeadBall,
    Whistle,
    MatchEnd,
    ObservationGap,
    Unknown,
}

impl ContestEndReason {
    /// 闭集全成员（守护「闭集完整性」：新增成员时串名/单调性测试会因漏列而红）。
    pub const ALL: &'static [ContestEndReason] = &[
        Self::Pickup,
        Self::DeadBall,
        Self::Whistle,
        Self::MatchEnd,
        Self::ObservationGap,
        Self::Unknown,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            ContestEndReason::Pickup => "pickup",
            ContestEndReason::DeadBall => "dead_ball",
            ContestEndReason::Whistle => "whistle",
            ContestEndReason::MatchEnd => "match_end",
            ContestEndReason::ObservationGap => "observation_gap",
            ContestEndReason::Unknown => "unknown",
        }
    }
}

// ============================== 行为观察状态（design §5，sidecar 派生状态） ==============================

/// 行为观察状态。**不替换** `MatchState.possession`——它只是 recorder 自己维护的派生状态。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BehaviorControlState {
    /// 尚未开赛（无控制、无死球）。
    Uninitialized,
    /// 某队已建立控制（含门将持球）。
    Controlled { team: TeamId, carrier: Option<i32> },
    /// 松散球 / 二点争抢：尚无球队建立控制。
    Contested {
        previous_team: Option<TeamId>,
        location: Option<(f64, f64)>,
    },
    /// 传球 / 射门 / 解围 / 定位球发出后、结果 finalize 前。
    BallInFlight {
        originating_team: TeamRef,
        action: FlightAction,
    },
    /// 已确认死球。`restart_team` 为规则决定的重开归属（无重开安排时为 `Unknown`）。
    DeadBall {
        reason: DeadBallReason,
        restart_team: TeamRef,
    },
    /// 重开准备期（发球者走位中）。
    RestartPreparation { team: TeamRef, kind: RestartKind },
    /// 终场。
    Ended,
}

impl BehaviorControlState {
    pub const fn as_str(&self) -> &'static str {
        match self {
            BehaviorControlState::Uninitialized => "uninitialized",
            BehaviorControlState::Controlled { .. } => "controlled",
            BehaviorControlState::Contested { .. } => "contested",
            BehaviorControlState::BallInFlight { .. } => "ball_in_flight",
            BehaviorControlState::DeadBall { .. } => "dead_ball",
            BehaviorControlState::RestartPreparation { .. } => "restart_preparation",
            BehaviorControlState::Ended => "ended",
        }
    }
}

// ============================== 分析对象（design §6） ==============================

/// 开放比赛中球队已建立控制的连续片段（design §6.1）。
#[derive(Debug, Clone, PartialEq)]
pub struct PossessionEpisode {
    pub id: u64,
    pub team: TeamId,
    pub start_t: ObservedTime,
    pub end_t: Option<ObservedTime>,
    pub start_reason: EpisodeStartReason,
    pub end_reason: Option<EpisodeEndReason>,
    /// 归属本 episode 的 `control_facts` 下标（严格递增）。
    pub control_fact_indexes: Vec<usize>,
    /// 归属本 episode 的正式事件下标（Slice 2 接入后填充）。
    pub event_indexes: Vec<usize>,
}

/// 死球判定到重新进入开放比赛的片段（design §6.2）。
#[derive(Debug, Clone, PartialEq)]
pub struct RestartSequence {
    pub id: u64,
    pub team: TeamRef,
    pub kind: RestartKind,
    pub start_t: ObservedTime,
    pub taken_t: Option<ObservedTime>,
    pub open_play_resumed_t: Option<ObservedTime>,
    pub event_indexes: Vec<usize>,
    pub end_reason: Option<RestartEndReason>,
}

// ============================== #15B phase 预留（design §11，Slice 1 不实现标注器） ==============================

/// #15B 的 phase 闭集（design §11）。Slice 1 只保留 schema，不产出任何 segment。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Phase {
    BuildUp,
    Progression,
    FinalThird,
    AttackingTransition,
    Unknown,
}

impl Phase {
    /// 闭集全成员（守护「闭集完整性」：新增成员时串名/单调性测试会因漏列而红）。
    pub const ALL: &'static [Phase] = &[
        Self::BuildUp,
        Self::Progression,
        Self::FinalThird,
        Self::AttackingTransition,
        Self::Unknown,
    ];

    /// 串名按 design §11 的字面值（`build_up` 等）。
    pub const fn as_str(self) -> &'static str {
        match self {
            Phase::BuildUp => "build_up",
            Phase::Progression => "progression",
            Phase::FinalThird => "final_third",
            Phase::AttackingTransition => "attacking_transition",
            Phase::Unknown => "unknown",
        }
    }
}

/// phase segment 的离散 provenance（design §11）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PhaseProvenance {
    EngineHint,
    Geometry,
    Event,
    Inherited,
    Unknown,
}

impl PhaseProvenance {
    /// 闭集全成员（守护「闭集完整性」：新增成员时串名/单调性测试会因漏列而红）。
    pub const ALL: &'static [PhaseProvenance] = &[
        Self::EngineHint,
        Self::Geometry,
        Self::Event,
        Self::Inherited,
        Self::Unknown,
    ];

    /// 串名按 design §11 的字面值（`engine_hint` 等）。
    pub const fn as_str(self) -> &'static str {
        match self {
            PhaseProvenance::EngineHint => "engine_hint",
            PhaseProvenance::Geometry => "geometry",
            PhaseProvenance::Event => "event",
            PhaseProvenance::Inherited => "inherited",
            PhaseProvenance::Unknown => "unknown",
        }
    }
}

/// #15B 的 phase 片段（design §11）。Slice 1 恒为空数组；#15B 实现前不得填充。
#[derive(Debug, Clone, PartialEq)]
pub struct PhaseSegment {
    pub episode_id: u64,
    pub start_t: ObservedTime,
    pub end_t: Option<ObservedTime>,
    pub phase: Phase,
    pub provenance: PhaseProvenance,
}

// ============================== sidecar（design §3） ==============================

/// 独立的行为诊断 sidecar。`events` 与正式 `simulate()` 的事件流逐字节同源。
///
/// 除了 facts / 观察对象，sidecar 还**自带质量信息**：不变量违规列表与终态。
/// 这样 opt-in API 返回后调用方无需再持有 recorder 就能检查「这次观察本身是否可信」
/// （Slice 1 之前只能拿到已消费掉的 recorder 的副本，实测中很容易漏检）。
#[derive(Debug, Clone)]
pub struct DiagnosticMatch {
    pub events: Vec<Event>,
    pub control_facts: Vec<ControlFact>,
    pub possession_episodes: Vec<PossessionEpisode>,
    pub restart_sequences: Vec<RestartSequence>,
    /// 恒为空数组（Slice 1）；#15B 的 phase 标注器落地前不得填充。
    pub phase_segments: Vec<PhaseSegment>,
    /// 终态观察状态（design §5）。`Ended` 表示事件流收束；`Uninitialized` 出现在 demo 模式
    /// （不为固定动作序列伪造事实）。
    ///
    /// **为何带上它**：不变量 9 的交叉校验是「`state` 与记录必须一致」，而 `state` 原先只活在
    /// recorder 里。sidecar 若不带 `state`，调用方就只能看到**违规列表**而看不到被检查的客体，
    /// 无法自行判断终态是否可信（例如「比赛跑完却停在 `Contested`」）。`state` 是 `Copy` 的
    /// 小枚举，不破坏 API 简洁性。
    pub state: BehaviorControlState,
    /// 产出该 sidecar 时的不变量违规项（[`BehaviorObservationRecorder::invariant_violations`] 的
    /// 输出，在 `into_diagnostic_match` 消费 recorder **之前**求值并保存）。
    ///
    /// 空表示观察记录自洽。**非空不等于比赛结果有问题**——按 design §10 / §13，sidecar 的缺陷
    /// 不得影响模拟；它只说明观察层需要修。
    pub invariant_violations: Vec<String>,
}

impl DiagnosticMatch {
    /// 与 `simulate()` 相同格式的事件流 JSON——供「recorder on/off 事件流完全一致」这条门直接比对。
    pub fn events_json(&self) -> String {
        let json: Vec<String> = self.events.iter().map(|e| e.to_json()).collect();
        format!("[{}]", json.join(","))
    }

    /// `observation_gap` 事实数量。非 0 说明 recorder 遇到了未覆盖或矛盾输入。
    ///
    /// **0 不等于「一切都有明确证据」**：`RestartSequence` 可以合法地以 `SupersededByDeadBall`
    /// 结束（新死球顶掉未完成的重开，§15 A9-2），该路径不产 gap。判断重开闭合质量须同时看
    /// `restart_sequences` 的 `end_reason`。
    pub fn gap_count(&self) -> usize {
        self.control_facts
            .iter()
            .filter(|f| f.kind == ControlFactKind::ObservationGap)
            .count()
    }

    /// 每种 gap 原因 → 条数（含 0 计数），见 [`BehaviorObservationRecorder::gap_reason_counts`]。
    pub fn gap_reason_counts(&self) -> Vec<(ObservationGapReason, usize)> {
        ObservationGapReason::ALL
            .iter()
            .map(|reason| {
                let count = self
                    .control_facts
                    .iter()
                    .filter(|f| f.detail == Some(ControlFactDetail::Gap(*reason)))
                    .count();
                (*reason, count)
            })
            .collect()
    }

    /// 不变量违规是否为空——「这次观察本身是否可信」的单点判断。
    pub fn is_coherent(&self) -> bool {
        self.invariant_violations.is_empty()
    }
}

/// 正式事件流 → 流边界时间（终场哨的 `t`）。
///
/// opt-in 路径用**事件流本身**确定观察终点，而不是另读 `config.match_duration_seconds`：
/// 两个来源一旦漂移（例如引擎改为补时后推哨），sidecar 的终场时间就会对不上它自己输出的那条
/// whistle（见模块头坑 6）。找不到时返回 `None`——调用方据此记
/// [`ObservationGapReason::MissingStreamEndBoundary`]，**不硬编码**时间。
///
/// 判定规则：**最后一条** `Whistle` 事件的 `t`。`match_events` 在循环后补推的那条终场哨
/// （`detail = "half_time"`，P15 已知本引擎无中场休息）位于流末，故「最后一条 whistle」
/// 就是流边界。`kickoff_again`（进球后的转场哨）不是流边界，因此若它在末尾出现则说明流提前
/// 截断——此时返回的仍是该 whistle，调用方须结合 `detail` 自行判断；Slice 2 接线时应对
/// `kickoff_again` 单独处理（见模块头开球专线 3），不要把本条当作「任意 whistle 皆边界」。
pub fn stream_end_boundary(events: &[Event]) -> Option<ObservedTime> {
    events
        .iter()
        .rev()
        .find(|e| e.type_ == crate::EventType::Whistle)
        .map(|e| ObservedTime::new(e.t, TimeBasis::EventEmit))
}

/// 把「流末尾 = 观察终点」这条规则收敛成**唯一**的提交函数（见模块头坑 6）。
///
/// 它只消费 [`stream_end_boundary`] 的结果，**不接收** `config` / 时长参数——因此调用方
/// 结构上无法把 `config.match_duration_seconds` 或任何别的时长偷偷传进来当终场时间
/// （旧实现 `recorder.full_time(config.match_duration_seconds)` 在正式 whistle 的 `t`
/// 恰好等于 config 时长的今天观测不到差异，一旦引擎改为补时后推哨就会静默错位）。
/// 流里没有 whistle 时**不硬编码**时间，改记 [`ObservationGapReason::MissingStreamEndBoundary`]。
///
/// 返回是否把流末边界交给了 recorder（`true` = `full_time`，`false` = 记 gap）。
/// 该返回值让「绑定的是正式 whistle 还是别的来源」这条契约可在**手工构造的流**上验证：
/// 构造一条虚构的 `whistle@123.0`（与任何真实 `config` 时长都不同）即可证明终点取自流本身。
pub fn commit_stream_end_boundary(
    recorder: &mut BehaviorObservationRecorder,
    events: &[Event],
) -> bool {
    match stream_end_boundary(events) {
        Some(t) => {
            recorder.full_time(t);
            true
        }
        None => {
            recorder.note_gap(
                ObservedTime::unknown(),
                ObservationGapReason::MissingStreamEndBoundary,
                ControlFactBasis::StreamBoundary,
            );
            false
        }
    }
}

// ============================== recorder ==============================

/// 事件下标绑定的**目标**（[`BehaviorObservationRecorder::bind_event_index`] 的入参）。
///
/// 三种目标共用一个入口，是为了让「尾部压缩区间内不得绑定」这条守卫**只写一次**——
/// §14 A4 明令禁止绕开该接口直接往 `episode.event_indexes` / `restart.event_indexes` 里
/// 下标（否则 drain/filter/extend 的重排会静默进入 episode/restart 分析对象）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventIndexTarget {
    /// 指定事实下标（越界 = 调用方传错 → `IllegalFactIndex` gap）。
    Fact(usize),
    /// 当前开放的 [`PossessionEpisode`]。**无开放 episode 时是合法空操作**：
    /// 并非每个正式事件都归属某个 episode（死球、哨声、重开交付期间的事件就没有），
    /// 把「此刻没有归属对象」当成错误会逼调用方到处预判，反而更容易漏绑或错绑。
    OpenEpisode,
    /// 当前开放的 [`RestartSequence`]。无开放 restart 时同样是合法空操作。
    OpenRestart,
    /// **最近一条该 kind 的事实**（按 `facts` 顺序取最后一条）。
    ///
    /// 给「同一提交点产出多条事实，其中**只有某一条**要绑到别的事件」的场合用
    /// （门球：一次提交记 `dead_ball_started` + `restart_taken`，前者归死球来源事件、
    /// 后者归门球交付事件）。让 recorder 自己按 kind 查找，调用方就不必读 `facts()`
    /// ——比赛逻辑函数读观察层状态正是 `p15_recorder_stays_out_of_the_decision_path` 要禁的形态。
    ///
    /// 该 kind 一条都没有时是合法空操作（返回 `false`）。
    LastFactOfKind(ControlFactKind),
    /// **自上次归属扫描以来新增的全部事实**（水位由 recorder 自己维护）。
    ///
    /// 一个引擎提交点往往一次产出多条事实（`dead_ball_started` 顺带记 `control_released`、
    /// `contest_ended`；`control_established` 顺带记 `open_play_resumed`），它们同刻、同源。
    /// 让调用方逐个传事实下标既啰嗦又容易漏（实测只绑「最后一条」时覆盖率仅 47%）。
    ///
    /// 水位语义：只有**尚未经历过一次归属扫描**的事实会被绑定。因此「这个提交点没有任何
    /// 可归属事件」不会把事实永久留成待绑——它会在下一次扫描时被绑到**那个**事件上，
    /// 所以调用方**只在确实有事件来源时**才发起扫描（`None` 时走 `Open*` 两个目标即可）。
    UnattributedFacts,
}

/// 只读观察器：接收引擎状态提交点提交的事实，维护 episode / restart / contest 的开闭。
///
/// **它不是第二个比赛状态机**：不参与决策、不持有 RNG、不读写 `MatchState`。
///
/// `enabled == false` 时所有命令都是空操作，且不分配任何事实。
///
/// **正式路径的开销是结构性的**：`simulate()` 虽然把 recorder 传进 `match_events`（公共路径
/// 共用），但传的是 `disabled()`——每条命令都在第一个分支返回，因此正式事件流与 `simulate()`
/// 行为逐字节不变、开销近零。**这不是性能承诺**（不作绝对百分比保证，见 design §15 A9-9）；
/// `disabled_recorder_is_a_no_op` 验证「关闭时命令无效」这个契约，
/// `observation_api_leaves_formal_events_byte_identical` 验证两条路径事件流完全相同。
#[derive(Debug, Clone)]
pub struct BehaviorObservationRecorder {
    enabled: bool,
    facts: Vec<ControlFact>,
    episodes: Vec<PossessionEpisode>,
    restarts: Vec<RestartSequence>,
    state: BehaviorControlState,
    /// 开放 episode 的下标（design §10：每个时刻最多一个）。
    open_episode: Option<usize>,
    /// 开放 restart 的下标（与开放 episode 不重叠）。
    open_restart: Option<usize>,
    /// 争抢是否仍开放。与 `state` 解耦：矛盾输入被 `reject` 收束后，state 可能仍是 `Contested`，
    /// 但 contest 已经关闭——后续转场不得重复记录 `contest_ended`。
    contest_open: bool,
    /// 最近一次矛盾输入（[`BehaviorObservationRecorder::reject`] 收束）**之后**此刻的
    /// `state` 快照。
    ///
    /// design §5 补充规则要求矛盾输入「记 gap、**不自行推进状态**」，因此 `state` 与观察对象
    /// 在这一刻**按设计**不一致。这个快照把「此刻 state 长什么样」显式记下来，使不变量 9 的
    /// `state` ↔ 记录交叉校验只在状态**未被改写**时抑制特定子句——按**值**相等比较，而不是
    /// 靠字符串前缀猜（旧实现用 `bool` + 前缀匹配，已实测出两处逃逸：
    /// ① 陈旧窗口内把 `state` 换成任何损坏值都免检；② 「`Controlled` 无开放 episode」在最近
    /// episode 因 gap 收束时被整体抑制，同队/持球员别的损坏也一并被放过）。
    /// 任何**成功推进状态**的命令都会清掉它（`set_state`）；也正因如此，一旦某次转场改写了
    /// `state`，快照不再相等 → 校验立刻恢复。
    stale_state_snapshot: Option<BehaviorControlState>,
    /// `reject` 在收束记录**之前**发现的 `state` ↔ 记录违规项（见 `invariant_violations` 第 9 条）。
    /// 只增不减：一次矛盾输入造成的违规不能被后续成功转场「洗掉」。
    deferred_violations: Vec<String>,
    /// 尾部压缩边界（见模块头「事件下标绑定规则」）：`[0, n)` 的最终下标稳定，`[n, ..)` 会被
    /// drain/filter/extend 重排。`None` = 全部稳定。
    stable_event_prefix: Option<usize>,
    /// 尾部压缩**排空期**开关：本期间的提交点一律不绑定事件下标
    /// （见 [`BehaviorObservationRecorder::suspend_event_index_binding`]）。
    event_index_binding_suspended: bool,
    /// 事件归属水位：`[0, attributed_upto)` 的事实已经历过一次归属扫描
    /// （见 [`EventIndexTarget::UnattributedFacts`]）。
    attributed_upto: usize,
    next_episode_id: u64,
    next_restart_id: u64,
}

impl BehaviorObservationRecorder {
    /// 关闭的 recorder：命令全部空操作，`facts` 恒空。正式 `simulate()` 走这条路径。
    pub fn disabled() -> Self {
        BehaviorObservationRecorder {
            enabled: false,
            facts: Vec::new(),
            episodes: Vec::new(),
            restarts: Vec::new(),
            state: BehaviorControlState::Uninitialized,
            open_episode: None,
            open_restart: None,
            contest_open: false,
            stale_state_snapshot: None,
            deferred_violations: Vec::new(),
            stable_event_prefix: None,
            event_index_binding_suspended: false,
            attributed_upto: 0,
            next_episode_id: 0,
            next_restart_id: 0,
        }
    }

    pub fn enabled() -> Self {
        BehaviorObservationRecorder {
            enabled: true,
            ..BehaviorObservationRecorder::disabled()
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    // ---- 读取（append-only 视图） ----

    pub fn facts(&self) -> &[ControlFact] {
        &self.facts
    }

    pub fn episodes(&self) -> &[PossessionEpisode] {
        &self.episodes
    }

    pub fn restarts(&self) -> &[RestartSequence] {
        &self.restarts
    }

    pub fn state(&self) -> &BehaviorControlState {
        &self.state
    }

    pub fn gap_count(&self) -> usize {
        self.facts
            .iter()
            .filter(|f| f.kind == ControlFactKind::ObservationGap)
            .count()
    }

    /// 终态观察状态（消费 recorder **之前**读取，design §5）。
    pub fn terminal_state(&self) -> BehaviorControlState {
        self.state
    }

    /// 消费 recorder，产出 sidecar。调用方传入与正式路径同源的 `events`。
    ///
    /// 不变量违规与终态在**消费之前**求值并写进 sidecar（见 [`DiagnosticMatch`]）——
    /// 否则调用方拿不到 recorder，就无法检查这次观察本身是否自洽。
    pub fn into_diagnostic_match(self, events: Vec<Event>) -> DiagnosticMatch {
        let invariant_violations = self.invariant_violations();
        DiagnosticMatch {
            events,
            control_facts: self.facts,
            possession_episodes: self.episodes,
            restart_sequences: self.restarts,
            phase_segments: Vec::new(),
            state: self.state,
            invariant_violations,
        }
    }

    /// 一致性检查（design §10、§13）。**返回**违规列表而不是断言——sidecar 缺陷不得中断模拟。
    pub fn invariant_violations(&self) -> Vec<String> {
        let mut v = Vec::new();

        // 1. 每个时刻最多一个开放 episode。
        let open_episodes = self.episodes.iter().filter(|e| e.end_t.is_none()).count();
        if open_episodes > 1 {
            v.push(format!("开放 episode 数量 {} > 1", open_episodes));
        }
        if self.open_episode.is_some() != (open_episodes == 1) {
            v.push("open_episode 指针与 episodes 的 end_t 不一致".to_string());
        }

        // 2. RestartSequence 与开放 episode 不重叠。
        let open_restarts = self
            .restarts
            .iter()
            .filter(|r| r.end_reason.is_none())
            .count();
        if open_restarts > 1 {
            v.push(format!("开放 restart 数量 {} > 1", open_restarts));
        }
        if self.open_restart.is_some() != (open_restarts == 1) {
            v.push("open_restart 指针与 restarts 的 end_reason 不一致".to_string());
        }
        if open_episodes > 0 && open_restarts > 0 {
            v.push("开放 episode 与开放 restart 重叠".to_string());
        }

        // 3. id 与下标一一对应（append-only 的 id 方案）。
        for (i, e) in self.episodes.iter().enumerate() {
            if e.id != i as u64 {
                v.push(format!("episode[{}].id = {} 与下标不符", i, e.id));
            }
        }
        for (i, r) in self.restarts.iter().enumerate() {
            if r.id != i as u64 {
                v.push(format!("restart[{}].id = {} 与下标不符", i, r.id));
            }
        }

        // 4. episode 的时间与事实下标。
        for e in &self.episodes {
            if !e.start_t.is_finite() {
                v.push(format!("episode {} start_t 非有限值", e.id));
            }
            if let Some(end) = e.end_t {
                if !end.is_finite() {
                    v.push(format!("episode {} end_t 非有限值", e.id));
                } else if end.value < e.start_t.value {
                    v.push(format!("episode {} end_t < start_t", e.id));
                }
            }
            if e.end_t.is_some() != e.end_reason.is_some() {
                v.push(format!("episode {} end_t 与 end_reason 不同现", e.id));
            }
            if e.control_fact_indexes.is_empty() {
                v.push(format!("episode {} 没有任何 control_fact", e.id));
            }
            let mut last: Option<usize> = None;
            for idx in &e.control_fact_indexes {
                if *idx >= self.facts.len() {
                    v.push(format!("episode {} 引用越界 fact {}", e.id, idx));
                }
                if let Some(prev) = last {
                    if *idx <= prev {
                        v.push(format!(
                            "episode {} 的 control_fact_indexes 非严格递增",
                            e.id
                        ));
                        break;
                    }
                }
                last = Some(*idx);
            }
        }

        // 5. restart 的时间顺序、有限性与结束原因自洽。
        for r in &self.restarts {
            if !r.start_t.is_finite() {
                v.push(format!("restart {} start_t 非有限值", r.id));
            }
            if let Some(taken) = r.taken_t {
                if !taken.is_finite() {
                    v.push(format!("restart {} taken_t 非有限值", r.id));
                } else if taken.value < r.start_t.value {
                    v.push(format!("restart {} taken_t < start_t", r.id));
                }
            }
            if let Some(resumed) = r.open_play_resumed_t {
                if !resumed.is_finite() {
                    v.push(format!("restart {} open_play_resumed_t 非有限值", r.id));
                }
                match r.taken_t {
                    Some(taken) if resumed.value < taken.value => {
                        v.push(format!("restart {} open_play_resumed_t < taken_t", r.id))
                    }
                    None => v.push(format!("restart {} 未 taken 却已 open_play_resumed", r.id)),
                    _ => {}
                }
                if r.end_reason != Some(RestartEndReason::OpenPlayResumed) {
                    v.push(format!(
                        "restart {} 有 open_play_resumed_t 但 end_reason = {:?}",
                        r.id, r.end_reason
                    ));
                }
            }
        }

        // 6. 事实的时间与位置必须是有限值（NaN/Inf 一定是算错）。
        //    观察对象的时间字段（episode / restart）在检查 4、5 里各自覆盖。
        //
        //    例外：`basis == Unknown` 的事实**按 design §8 明确表达「时间不可得」**，
        //    此时非有限值是合法值而不是算错（例如「流里没有终场哨」这条 gap 没有时间可取）。
        //    区分依据是 `basis`——闭集里的 `Unknown` 是显式的，`NaN + 已知 basis` 才是算错。
        for (i, f) in self.facts.iter().enumerate() {
            if !f.t.is_finite() && f.t.basis != TimeBasis::Unknown {
                v.push(format!("fact[{}] 的 t 非有限值", i));
            }
            if let Some((x, y)) = f.location {
                if !x.is_finite() || !y.is_finite() {
                    v.push(format!("fact[{}] 的 location 非有限值", i));
                }
            }
        }

        // 7. 争抢在事实层必须成对收束（design §10：不允许 Contested 永久悬空）。
        let mut contest_open = false;
        for (i, f) in self.facts.iter().enumerate() {
            match f.kind {
                ControlFactKind::ContestStarted => {
                    if contest_open {
                        v.push(format!("fact[{}] 重复 contest_started", i));
                    }
                    contest_open = true;
                }
                ControlFactKind::ContestEnded => {
                    if !contest_open {
                        v.push(format!("fact[{}] contest_ended 无对应 contest_started", i));
                    }
                    contest_open = false;
                }
                _ => {}
            }
        }
        if contest_open != self.contest_open {
            v.push("contest_open 与事实层的成对性不一致".to_string());
        }
        if matches!(self.state, BehaviorControlState::Ended) && contest_open {
            v.push("终场后仍有未收束的争抢".to_string());
        }

        // 8. 流结束（`match_ended`）后所有观察对象必须关闭。
        let match_ended = self
            .facts
            .iter()
            .any(|f| f.kind == ControlFactKind::MatchEnded);
        if match_ended {
            if open_episodes > 0 {
                v.push("match_ended 后仍有开放 episode".to_string());
            }
            if open_restarts > 0 {
                v.push("match_ended 后仍有开放 restart".to_string());
            }
            if contest_open {
                v.push("match_ended 后仍有未收束的争抢".to_string());
            }
        }

        // 9. 派生 `state` 必须与观察对象一致。`state` 是 Slice 2 各提交点的判定依据，
        //    它若比记录「更差」（例如 kind 被调用参数降级成 Unknown）而无人察觉，
        //    后续所有转场都会基于错误状态推进。
        //
        //    例外：矛盾输入被 `reject` 收束后，`state` **按 design §5 补充规则刻意保持不推进**，
        //    此时它与记录不一致是正确行为。但这个例外**不能让真正的缺陷逃逸**——`reject` 在
        //    收束记录**之前**就在原记录上跑过同一套交叉校验，违规项存进 `deferred_violations`，
        //    在此照常上报（见 `reject`）。因此覆盖情况是：
        //    - 缺陷出现在矛盾输入之前 → 由 `deferred_violations` 在 gap 时刻抓到；
        //    - 缺陷出现在 gap 之后 → 见 `state_record_violations_gap_aware`：**只**在 `state`
        //      仍等于 `reject` 留下的那份快照时才抑制「gap 必然造成」的子句。任何对 `state` 的
        //      改写都会让快照失配 → 恢复全量校验。旧实现用 `bool` + 字符串前缀推断，实测有两处
        //      逃逸（陈旧窗口内的终态损坏、`Controlled` 无开放 episode 的队别/持球员别损坏），
        //      见测试 `reject_does_not_exempt_ill_formed_state`。
        if self.stale_state_snapshot.is_some()
            && !self
                .facts
                .iter()
                .any(|f| f.kind == ControlFactKind::ObservationGap)
        {
            v.push("state 标记为矛盾输入后陈旧，但事实流里没有任何 observation_gap".to_string());
        }
        v.extend(self.deferred_violations.iter().cloned());
        v.extend(self.state_record_violations_gap_aware(&self.state));

        // 10. `detail` 必须与 `kind` 配对（闭集联合的守护）：错误的组合会让下游按错的语义解读事实。
        for (i, f) in self.facts.iter().enumerate() {
            if let Some(detail) = f.detail {
                if detail.fact_kind() != f.kind {
                    v.push(format!(
                        "fact[{}] kind = {} 与 detail {:?}（属于 {}）不配对",
                        i,
                        f.kind.as_str(),
                        detail,
                        detail.fact_kind().as_str()
                    ));
                }
            }
        }

        v
    }

    /// 每种 gap 原因 → 条数（含 0 计数）。给基线/诊断按原因聚合用。
    ///
    /// 旧实现只有 [`Self::gap_count`] 一个总数，「哪种缺口最多」无从查起——而不同缺口原因的
    /// 处置完全不同（`illegal_input_*` 要修接线，`missing_stream_end_boundary` 要修流解析）。
    pub fn gap_reason_counts(&self) -> Vec<(ObservationGapReason, usize)> {
        ObservationGapReason::ALL
            .iter()
            .map(|reason| {
                let count = self
                    .facts
                    .iter()
                    .filter(|f| f.detail == Some(ControlFactDetail::Gap(*reason)))
                    .count();
                (*reason, count)
            })
            .collect()
    }

    /// [`Self::state_record_violations`] 的「矛盾输入后」版本：只抑制**由 gap 必然造成**的子句。
    ///
    /// 详见 `invariant_violations` 第 9 条的说明。被抑制的两类：
    ///
    /// - `Contested` 且争抢已收束：`reject` 按设计关了 contest，state 保留 `Contested`；
    /// - `RestartPreparation` 但没有开放 restart：不可能由 gap 造成——gap 不关 restart——
    ///   所以这一条**不**抑制；
    /// - `RestartPreparation` 的 team/kind 降级比较：kind 降级本身就是 gap 之前注入的缺陷，
    ///   已由 `deferred_violations` 在 gap 时刻抓到，这里重报会是假阳性；
    /// - `Controlled` 但没有开放 episode：同样由 gap 造成（`reject` 按 §10 关了 episode）。
    ///
    /// **抑制按值相等**（`state == 快照`）而不是按字符串/历史推断：任何对 `state` 的改写都会
    /// 让快照失配 → 校验立刻恢复。这堵住了旧实现的两处逃逸（见 `stale_state_snapshot` 的文档）。
    fn state_record_violations_gap_aware(&self, state: &BehaviorControlState) -> Vec<String> {
        // 未被 gap 陈旧的 `state` 一律全量校验（正常路径）。
        let Some(snapshot) = self.stale_state_snapshot else {
            return self.state_record_violations(state);
        };
        if *state != snapshot {
            // 快照之后 `state` 被改写过（`reject` 明确不推进状态，故只可能是某次转场写的）：
            // 陈旧豁免**不再适用**，全量校验。
            return self.state_record_violations(state);
        }
        let mut v = self.state_record_violations(state);
        let stale_contested = "state = Contested 但争抢已收束";
        let stale_downgrade_marker = "已知事实被降级";
        let stale_controlled_prefix = "state Controlled team = ";
        let stale_controlled_suffix = " 但没有开放 episode";
        // 「`Controlled` 却无开放 episode」还要看**记录侧**：只有最近收束的 episode 确实死在
        // `observation_gap` 上（即真由 `reject` 关闭），这个组合才是 gap 的必然结果。否则
        // （例如 episode 以 `control_lost` 关闭）是损坏——`reject` 只会用 `ObservationGap`
        // 关 episode，快照相等并不足以证明「记录侧没被改过」。
        let gap_closed = self.last_episode_closed_by_gap();
        v.retain(|m| {
            if m.starts_with(stale_contested) || m.contains(stale_downgrade_marker) {
                return false;
            }
            if m.starts_with(stale_controlled_prefix) && m.ends_with(stale_controlled_suffix) {
                return !gap_closed;
            }
            true
        });
        v
    }

    /// **最近一次**收束的 episode 是否由 `observation_gap` 关闭（即由 `reject` 造成）。
    ///
    /// 用 `last()` 而非「历史上有过」：只有紧邻的这次收束才能解释当前的陈旧 `state`。
    /// 实测该区分**当前不可观测**——任何后续合法 episode 收束都会经 `set_state` 清掉快照，
    /// 于是 `last()` 与 `any()` 在可到达的状态里同值（变异 `last()`→`any()` 不使任何测试变红）。
    /// 保留 `last()` 是因为它语义上更贴合「解释当下」，且若将来出现绕过 `set_state` 的收束路径，
    /// 它就是正确的那一侧。
    fn last_episode_closed_by_gap(&self) -> bool {
        self.episodes
            .last()
            .map(|e| e.end_reason == Some(EpisodeEndReason::ObservationGap))
            .unwrap_or(false)
    }

    /// `state` 与观察对象（开放 episode / 开放 restart / 争抢）的交叉校验。
    /// 抽成独立方法是为了让 `reject` 能在**收束记录之前**跑同一套检查（见 `invariant_violations` 第 9 条）。
    fn state_record_violations(&self, state: &BehaviorControlState) -> Vec<String> {
        let mut v = Vec::new();
        match state {
            BehaviorControlState::Contested { .. } => {
                if !self.contest_open {
                    v.push("state = Contested 但争抢已收束".to_string());
                }
            }
            BehaviorControlState::RestartPreparation { team, kind } => match self.open_restart {
                Some(i) => {
                    let (rec_team, rec_kind) = (self.restarts[i].team, self.restarts[i].kind);
                    if rec_team.known().is_some() && *team != rec_team {
                        v.push(format!(
                            "state RestartPreparation team = {:?} 与 restart {} 的 {:?} 不一致",
                            team, self.restarts[i].id, rec_team
                        ));
                    }
                    if rec_kind != RestartKind::Unknown && *kind != rec_kind {
                        v.push(format!(
                            "state RestartPreparation kind = {:?} 低于 restart {} 的 {:?}（已知事实被降级）",
                            kind, self.restarts[i].id, rec_kind
                        ));
                    }
                }
                None => v.push("state = RestartPreparation 但没有开放 restart".to_string()),
            },
            BehaviorControlState::DeadBall { restart_team, .. } => {
                if let Some(i) = self.open_restart {
                    let rec_team = self.restarts[i].team;
                    if rec_team.known().is_some()
                        && restart_team.known().is_some()
                        && *restart_team != rec_team
                    {
                        v.push(format!(
                            "state DeadBall restart_team = {:?} 与 restart {} 的 {:?} 不一致",
                            restart_team, self.restarts[i].id, rec_team
                        ));
                    }
                }
            }
            BehaviorControlState::BallInFlight {
                originating_team, ..
            } => {
                // 有开放 episode 时，飞行来源必须就是那个 episode 的球队（design §5：出球不关闭
                // episode，episode 处于 pending_outcome）——这是矛盾输入会造成的**真实**错误。
                //
                // **不**检查「既无开放 episode 也无开放 restart」：gap（§5 补充规则）会关闭
                // episode，其后一次**合法**的 `control_released_into_flight` 就会落到这个组合上。
                // 那是已记录 gap 的后果，不是新缺陷——把 gap 的必然下游报成违规会让「无违规」
                // 这条门在 Slice 2 真实 gap 路径上失效。gap 本身由 `gap_count()` 反映。
                if let Some(i) = self.open_episode {
                    let ep_team = self.episodes[i].team;
                    if let Some(known) = originating_team.known() {
                        if known != ep_team {
                            v.push(format!(
                                "state BallInFlight 来源 {:?} 与开放 episode {} 的 {:?} 不一致",
                                known, self.episodes[i].id, ep_team
                            ));
                        }
                    }
                }
            }
            BehaviorControlState::Controlled { team, .. } => match self.open_episode {
                Some(i) => {
                    if self.episodes[i].team != *team {
                        v.push(format!(
                            "state Controlled team = {:?} 与 episode {} 的 {:?} 不一致",
                            team, self.episodes[i].id, self.episodes[i].team
                        ));
                    }
                }
                // 持球却没有开放 episode：`control_established` 的唯一出口就是开/续 episode，
                // 所以这是损坏（例如 gap 之后某次转场把 state 写错）。P15 前这条子句只覆盖
                // 「有 episode 但队不符」，无 episode 时静默通过——终态损坏因此免检。
                None => v.push(format!(
                    "state Controlled team = {:?} 但没有开放 episode",
                    team
                )),
            },
            BehaviorControlState::Uninitialized => {
                // 只看**非 gap** 事实：`note_gap` / `reject` 都可在 `match_started` 之前合法记录
                // （二者的契约都是「不改状态」），只有 gap 事实不等于「状态该推进却没推进」。
                // 用 `!facts.is_empty()` 会把 `note_gap` 的合法前置用法误报成违规。
                if self
                    .facts
                    .iter()
                    .any(|f| f.kind != ControlFactKind::ObservationGap)
                {
                    v.push("state = Uninitialized 但有非 gap 事实".to_string());
                }
            }
            BehaviorControlState::Ended => {}
        }
        v
    }

    // ---- 命令：由引擎状态提交点调用（Slice 2 接入） ----

    /// `Uninitialized` + `match_started` → `RestartPreparation(kickoff)`，创建开球 `RestartSequence`
    /// （不创建开放 episode）。开球同属重开，按 design §6.2 的统一生命周期一并记
    /// `restart_preparation_started`——因此本方法产出 **两条**事实（见模块头的增量 3）。
    pub fn match_started(&mut self, t: ObservedTime, kicking: TeamRef) {
        if !self.enabled {
            return;
        }
        if self.state != BehaviorControlState::Uninitialized {
            self.reject(t, IllegalInput::MatchStartedOutsideUninitialized);
            return;
        }
        self.push(
            ControlFactKind::MatchStarted,
            t,
            kicking.known(),
            None,
            None,
            ControlFactBasis::EngineState,
            None,
        );
        self.open_new_restart(kicking, RestartKind::Kickoff, t);
        self.push(
            ControlFactKind::RestartPreparationStarted,
            t,
            kicking.known(),
            None,
            None,
            ControlFactBasis::RestartRule,
            None,
        );
        self.set_state(BehaviorControlState::RestartPreparation {
            team: kicking,
            kind: RestartKind::Kickoff,
        });
    }

    /// 死球确认（design §5 第二张表）。`reason` 承载死球来源；`restart` 为规则决定的重开安排
    /// （`None` = 半场/终场这类无重开安排的死球）。
    ///
    /// `episode_end` 由**死球来源**决定（goal→`Goal`、出界→`Out`、犯规→`Foul`），不由「恰好有
    /// 开放 episode」决定；无开放 episode 时（例如重开准备期又出死球）该值不被消费。
    ///
    /// 顶掉未完成的旧 restart 是 §5 第二张表列的**正常**转场：该 sequence 以
    /// `RestartEndReason::SupersededByDeadBall` 结束（Slice 2 按 §15 A9-2 补的具名成员；
    /// Slice 1 因闭集缺该成员只能用 `Unknown`），**不**记 `observation_gap`
    /// ——正常路径上记 gap 会把该信号稀释成噪声。
    pub fn dead_ball_started(
        &mut self,
        t: ObservedTime,
        reason: DeadBallReason,
        restart: Option<(TeamRef, RestartKind)>,
        episode_end: EpisodeEndReason,
        basis: ControlFactBasis,
    ) {
        if !self.enabled {
            return;
        }
        match self.state {
            BehaviorControlState::Ended | BehaviorControlState::Uninitialized => {
                self.reject(t, IllegalInput::DeadBallStartedInIllegalState);
                return;
            }
            _ => {}
        }
        // 新死球终止旧 sequence（design §5 第二张表 `DeadBall` / `RestartPreparation` 行，
        // 该表把它列为**正常**转场）。结束原因用 `SupersededByDeadBall`（§15 A9-2），
        // 故**不**记 `observation_gap`——gap 表示 recorder 遇到未覆盖或矛盾输入，
        // 而在引擎正常路径上记 gap 会把该信号稀释成噪声。
        //
        // 该重开状态可由记录本身区分：`end_reason == Some(SupersededByDeadBall)` 且没有
        // `open_play_resumed_t` 的 sequence 就是被顶掉的那条。
        self.close_restart(t, RestartEndReason::SupersededByDeadBall);
        // 离开持球：释放事实只在「当前确实持有控制」时记录，避免与出球时的释放重复。
        if matches!(self.state, BehaviorControlState::Controlled { .. }) {
            let team = match self.state {
                BehaviorControlState::Controlled { team, .. } => Some(team),
                _ => None,
            };
            self.push(
                ControlFactKind::ControlReleased,
                t,
                team,
                None,
                None,
                basis,
                None,
            );
        }
        self.settle_contest(t, ContestEndReason::DeadBall, basis);
        self.close_episode(t, episode_end);
        self.push(
            ControlFactKind::DeadBallStarted,
            t,
            restart.map(|(team, _)| team).and_then(|team| team.known()),
            None,
            None,
            basis,
            Some(ControlFactDetail::DeadBall(reason)),
        );
        if let Some((team, kind)) = restart {
            self.open_new_restart(team, kind, t);
        }
        let restart_team = match restart {
            Some((team, _)) => team,
            None => TeamRef::Unknown,
        };
        self.set_state(BehaviorControlState::DeadBall {
            reason,
            restart_team,
        });
    }

    /// `DeadBall` → `RestartPreparation`（design §5 第二张表 `DeadBall` 行）。
    /// 已存在重开安排时 `team`/`kind` 必须与之一致（`Unknown` 可被细化）；否则记 gap 不猜。
    ///
    /// **必须已有重开安排**（`open_restart.is_some()`）：design §6.2 的统一生命周期是
    /// `dead_ball_started → restart_preparation_started → …`，而 sequence 由**死球来源矩阵**
    /// （§6.3）在 `dead_ball_started` 时创建（无重开安排的死球——半场/终场——`restart` 为
    /// `None`）。因此「进了准备期却没有 sequence」在 §6.2 下没有合法入口，是 §5「未列动作视为
    /// 矛盾输入」。
    ///
    /// 早先版本在这里**凭空造一条 sequence**（`None => open_new_restart(...)`）。那是「猜」：
    /// 它给一个没有死球来源的重开补出 `start_t`（= prep 时刻），把 §6.2 的首环节悄悄抹掉，
    /// 且让规则「**重开一律先在真实提交点记 `dead_ball_started`**」变成可选——生产接线若漏了
    /// 死球提交，观察层会安静地自愈而不是当场记 gap（实测该分支从未被生产路径触达，
    /// 是纯兜底代码）。
    pub fn restart_preparation_started(
        &mut self,
        t: ObservedTime,
        team: TeamRef,
        kind: RestartKind,
        basis: ControlFactBasis,
    ) {
        if !self.enabled {
            return;
        }
        if !matches!(self.state, BehaviorControlState::DeadBall { .. }) {
            self.reject(t, IllegalInput::RestartPreparationOutsideDeadBall);
            return;
        }
        if self.open_restart.is_none() {
            self.reject(t, IllegalInput::RestartPreparationWithoutScheduledRestart);
            return;
        }
        // 上面的 `is_none()` 提前返回后，这里一定有开放 sequence（`expect` 不是兜底）。
        let i = self.open_restart.expect("前面已确认存在开放 restart");
        let (have_team, have_kind) = (self.restarts[i].team, self.restarts[i].kind);
        // 只有「两边都已确定却互不相同」才是矛盾。任一侧为 `Unknown` 时不拒绝——
        // spec 的「未知重开归属」场景要求**继续等待可确认的状态提交**（不推断具体球队），
        // 在此细化类型/归属正是该要求；若直接拒绝，该 sequence 会永久卡在 unknown。
        let kind_conflict =
            have_kind != RestartKind::Unknown && kind != RestartKind::Unknown && have_kind != kind;
        let team_conflict =
            have_team.known().is_some() && team.known().is_some() && have_team != team;
        if kind_conflict || team_conflict {
            self.reject(
                t,
                IllegalInput::RestartPreparationContradictsScheduledRestart,
            );
            return;
        }
        if have_team.known().is_none() {
            self.restarts[i].team = team;
        }
        if have_kind == RestartKind::Unknown {
            self.restarts[i].kind = kind;
        }
        // 事实与派生状态都取**细化后**的权威值：本次调用可能带着 `Unknown` 来，而记录里已有
        // 更明确的证据（或反之）。若把调用参数直接写进 `state`，`state.kind` 会**比记录更差**，
        // 后续 `restart_taken` 就会把已知的重开方式降级成 `Unknown`（「不猜」的反面：丢掉已知事实）。
        let (team, kind) = (self.restarts[i].team, self.restarts[i].kind);
        self.push(
            ControlFactKind::RestartPreparationStarted,
            t,
            team.known(),
            None,
            None,
            basis,
            None,
        );
        self.set_state(BehaviorControlState::RestartPreparation { team, kind });
    }

    /// `RestartPreparation` → `BallInFlight`（design §5：`restart_taken` 统一负责该转移）。
    pub fn restart_taken(&mut self, t: ObservedTime, basis: ControlFactBasis) {
        if !self.enabled {
            return;
        }
        let (team, kind) = match self.state {
            BehaviorControlState::RestartPreparation { team, kind } => (team, kind),
            _ => {
                self.reject(t, IllegalInput::RestartTakenOutsideRestartPreparation);
                return;
            }
        };
        self.push(
            ControlFactKind::RestartTaken,
            t,
            team.known(),
            None,
            None,
            basis,
            None,
        );
        if let Some(i) = self.open_restart {
            self.restarts[i].taken_t = Some(t);
        }
        self.set_state(BehaviorControlState::BallInFlight {
            originating_team: team,
            action: flight_action_for(kind),
        });
    }

    /// **门球专线**（design §15 A9-3）：一次提交完成死球 → 重开 → 发出的全生命周期。
    ///
    /// 引擎的 `start_goal_kick` **同步**产 pass 高亮、**不设** `restart_prep`（对比角球/界外球/
    /// 任意球都经 `RestartPrep` 走位后再发）——因此门球路径上**不存在** `restart_preparation_started`
    /// 与 `restart_taken` 的独立提交点。§6.2 的统一生命周期为半场/终场开过例外先例，
    /// 门球按 A9-3 同属**结构性例外**：这一段引擎里没有准备期，两条路都不能靠猜：
    ///
    /// - 补记零长度的 `restart_preparation_started` + `restart_taken` = 发明一个引擎里不存在的阶段；
    /// - 只记 `dead_ball_started` 然后等 `control_established` = 门球后 `state` 仍是 `DeadBall`，
    ///   该控制声明会被判非法（记 gap），sequence 的 `taken_t` / `open_play_resumed_t` 全留 `None`。
    ///
    /// 故新增本入口：记 `dead_ball_started` + sequence，**紧接**同刻记 `restart_taken`
    /// （门将开大脚在同一刻把球交出——同「首开球」的 `restart_taken` + `control_established`
    /// 同刻情形，事实本身是真的），然后进入 `BallInFlight`。刻意**缺**的是
    /// `restart_preparation_started`：引擎里没有准备期，不补记。
    ///
    /// 不变量 5 要求「有 `open_play_resumed_t` 就必须先有 `taken_t`」，故这里的 `taken_t`
    /// 必须落上（否则门球交付后的首次明确控制会造出一条无法区分真假的违规）。
    pub fn goal_kick_started(
        &mut self,
        t: ObservedTime,
        reason: DeadBallReason,
        restart: (TeamRef, RestartKind),
        episode_end: EpisodeEndReason,
        basis: ControlFactBasis,
    ) {
        self.dead_ball_started(t, reason, Some(restart), episode_end, basis);
        if !self.enabled {
            return;
        }
        // `dead_ball_started` 若被判非法（`state` = Ended/Uninitialized）则不推进——门球事实
        // 仍以 gap 收束，不在这里复用已被拒绝的输入（诊断上 gap 比「照记事实」有用）。
        if !matches!(self.state, BehaviorControlState::DeadBall { .. }) {
            return;
        }
        let (team, kind) = restart;
        self.push(
            ControlFactKind::RestartTaken,
            t,
            team.known(),
            None,
            None,
            ControlFactBasis::RestartRule,
            None,
        );
        if let Some(i) = self.open_restart {
            self.restarts[i].taken_t = Some(t);
        }
        self.set_state(BehaviorControlState::BallInFlight {
            originating_team: team,
            action: flight_action_for(kind),
        });
    }

    /// 首次明确控制（design §5：`match_started`/`restart_taken` 之后的唯一入口）。
    ///
    /// - 有开放 restart 且球在飞行 → 记 `open_play_resumed` 并关闭该 sequence；
    /// - 有开放 episode 且同队 → **延续**（不关闭、不改 start_reason）；
    /// - 有开放 episode 且异队 → 关闭旧 episode（`prior_episode_end`，`None` 时按 `control_lost`）
    ///   并开启新 episode；
    /// - 无开放 episode（重开后的首次控制 / pickup）→ 开启新 episode。
    ///
    /// **`start_reason` 是调用方的语义声明，不是最终值**：存在开放 restart 时（除首开球的
    /// `Kickoff`）本命令一律归一为 [`EpisodeStartReason::RestartControl`]——判定放这里而不是
    /// 调用点，见函数体内「交付控制归一」的说明。
    ///
    /// `ControlEstablished` 从 `Controlled` 状态跨队建立属于表中未列的矛盾输入 → 记 gap，不自行推进。
    // 参数对应 design §4 的 `ControlFact` 字段，逐个显式传递以保证调用点可读（同 lib.rs 既有先例）。
    #[allow(clippy::too_many_arguments)]
    pub fn control_established(
        &mut self,
        t: ObservedTime,
        team: TeamId,
        player: Option<i32>,
        location: Option<(f64, f64)>,
        mut start_reason: EpisodeStartReason,
        prior_episode_end: Option<EpisodeEndReason>,
        basis: ControlFactBasis,
    ) {
        if !self.enabled {
            return;
        }
        match self.state {
            BehaviorControlState::Ended
            | BehaviorControlState::Uninitialized
            | BehaviorControlState::DeadBall { .. } => {
                self.reject(t, IllegalInput::ControlEstablishedInIllegalState);
                return;
            }
            BehaviorControlState::RestartPreparation { .. } => {
                self.reject(t, IllegalInput::ControlEstablishedBeforeRestartTaken);
                return;
            }
            BehaviorControlState::Controlled { team: held, .. } if held != team => {
                self.reject(t, IllegalInput::ControlEstablishedByOpponentWhileControlled);
                return;
            }
            _ => {}
        }
        // **交付控制归一**：本次控制是否在收束一个开放重开——必须在 `close_restart` **之前**判定。
        //
        // 判据是**记录侧的事实**（此刻是否有开放 restart），不是调用方声明的 `start_reason`。
        // 理由：同一个 `control_established` 入口被三类路径共用，其中「重开交付后的首次控制」
        // 在引擎里是**三种不同的落点形态**（角球/门球的落点 pickup 走 `advance_loose` 与
        // battle 分支、界外球/任意球走 `PassCaught`），调用方无法用一个参数把它们统一标成
        // 交付控制——早先版本靠 `Highlight::restart_delivery` 只覆盖了 `PassCaught` 那一半，
        // 角球与门球因此被标成 `Pickup`（实测 120 seed：角球 229 条、门球 1397 条错标）。
        //
        // 规则：
        // - 有开放 restart 且调用方**未**显式声明 `Kickoff` → `RestartControl`
        //   （首开球是唯一以 `Kickoff` 开 episode 的路径，它的语义是「开赛」而非「重开交付」，
        //   而它同样有开放 restart，故必须显式区分，否则会被这里吞成 `RestartControl`）；
        // - 无开放 restart → 保留调用方声明（开放比赛接球 / 真 loose pickup / 门将接球）。
        if self.open_restart.is_some() && start_reason != EpisodeStartReason::Kickoff {
            start_reason = EpisodeStartReason::RestartControl;
        }
        // 争抢收束（pickup）。
        self.settle_contest(t, ContestEndReason::Pickup, basis);
        // 重开交付完成 → 关闭 restart。
        if self.open_restart.is_some() {
            self.push(
                ControlFactKind::OpenPlayResumed,
                t,
                Some(team),
                player,
                location,
                basis,
                None,
            );
            self.close_restart(t, RestartEndReason::OpenPlayResumed);
        }
        let same_team_open = self
            .open_episode
            .map(|i| self.episodes[i].team == team)
            .unwrap_or(false);
        let idx = self.push(
            ControlFactKind::ControlEstablished,
            t,
            Some(team),
            player,
            location,
            basis,
            None,
        );
        if same_team_open {
            // 当前 episode 延续：只追加事实引用，不改 episode 边界（design §5 表 `Controlled` 行）。
            let i = self.open_episode.expect("same_team_open 蕴含 open_episode");
            self.episodes[i].control_fact_indexes.push(idx);
        } else {
            if self.open_episode.is_some() {
                self.close_episode(
                    t,
                    prior_episode_end.unwrap_or(EpisodeEndReason::ControlLost),
                );
            }
            self.open_new_episode(team, t, start_reason, idx);
        }
        self.set_state(BehaviorControlState::Controlled {
            team,
            carrier: player,
        });
    }

    /// 持球者出球（pass/clearance/shot/restart 发出）：记 `control_released`，进入 `BallInFlight`
    /// （design §5 表 `Controlled` 行、§9.1）。**不关闭 episode**——结局由 finalize 提交点决定。
    pub fn control_released_into_flight(
        &mut self,
        t: ObservedTime,
        action: FlightAction,
        basis: ControlFactBasis,
    ) {
        if !self.enabled {
            return;
        }
        let team = match self.state {
            BehaviorControlState::Controlled { team, .. } => team,
            _ => {
                self.reject(t, IllegalInput::ControlReleasedIntoFlightOutsideControlled);
                return;
            }
        };
        self.push(
            ControlFactKind::ControlReleased,
            t,
            Some(team),
            None,
            None,
            basis,
            None,
        );
        self.set_state(BehaviorControlState::BallInFlight {
            originating_team: TeamRef::from(team),
            action,
        });
    }

    /// 进入松散球 / 二点争抢（design §5 表、§10.1）。
    ///
    /// `episode_end` 是本 episode 的最终结局原因（`pass lost` → `control_lost`；射门扑出反弹 →
    /// `shot_rebound`）。存在开放 episode 时**必须**同时留下 `control_released` 与 `contest_started`
    /// 两条事实（design §10.1）；`control_released` 只在「当前仍持球」时补记，避免与出球时的释放重复。
    pub fn contest_started(
        &mut self,
        t: ObservedTime,
        reason: ContestStartReason,
        location: Option<(f64, f64)>,
        episode_end: EpisodeEndReason,
        basis: ControlFactBasis,
    ) {
        if !self.enabled {
            return;
        }
        if self.contest_open {
            self.reject(t, IllegalInput::ContestStartedWhileContested);
            return;
        }
        // 释放方 = 刚刚失去控制的一方。权威来源是**即将关闭的开放 episode**——从 `BallInFlight`
        // 进入 loose 时（`pass lost` / 抢断 / 射门扑出反弹）当前状态只记得 originating_team，
        // 取 episode 的 team 才能保住 design §10.1 的 `previous_team`。
        let episode_team = self.open_episode.map(|i| self.episodes[i].team);
        // `already_released`：控球状态下进入争抢需补记 `control_released`；从 `BallInFlight`
        // 进入的路径在出球提交点已记过，重复记录会污染事实流（design §9.1）。
        let (releasing_team, already_released) = match self.state {
            BehaviorControlState::Controlled { team, .. } => (Some(team), false),
            BehaviorControlState::BallInFlight {
                originating_team, ..
            } => (originating_team.known().or(episode_team), true),
            // 悬空的 Contested（争抢已被收束但状态未推进）：允许新争抢接管，不再补释放事实。
            BehaviorControlState::Contested { .. } => (episode_team, true),
            _ => {
                self.reject(t, IllegalInput::ContestStartedInIllegalState);
                return;
            }
        };
        if !already_released {
            if let Some(team) = releasing_team {
                self.push(
                    ControlFactKind::ControlReleased,
                    t,
                    Some(team),
                    None,
                    location,
                    basis,
                    None,
                );
            }
        }
        self.close_episode(t, episode_end);
        self.push(
            ControlFactKind::ContestStarted,
            t,
            releasing_team,
            None,
            location,
            basis,
            Some(ControlFactDetail::ContestStart(reason)),
        );
        self.contest_open = true;
        self.set_state(BehaviorControlState::Contested {
            previous_team: releasing_team,
            location,
        });
    }

    /// 半场哨（design §5 第二张表 `半场哨` 列）。
    pub fn half_time(&mut self, t: ObservedTime) {
        if !self.enabled {
            return;
        }
        if matches!(self.state, BehaviorControlState::Ended) {
            return;
        }
        if matches!(self.state, BehaviorControlState::BallInFlight { .. }) {
            // 未决飞行被哨声打断：记 gap，但 episode 结束原因固定为 whistle_interrupt（design §10）。
            self.push(
                ControlFactKind::ObservationGap,
                t,
                None,
                None,
                None,
                ControlFactBasis::StreamBoundary,
                Some(ControlFactDetail::Gap(
                    ObservationGapReason::HalfTimeDuringBallInFlight,
                )),
            );
            self.close_episode(t, EpisodeEndReason::WhistleInterrupt);
        } else {
            self.close_episode(t, EpisodeEndReason::HalfTime);
        }
        self.settle_contest(
            t,
            ContestEndReason::Whistle,
            ControlFactBasis::StreamBoundary,
        );
        self.close_restart(t, RestartEndReason::TerminatedByWhistle);
        self.push(
            ControlFactKind::DeadBallStarted,
            t,
            None,
            None,
            None,
            ControlFactBasis::StreamBoundary,
            Some(ControlFactDetail::DeadBall(DeadBallReason::HalfTime)),
        );
        self.set_state(BehaviorControlState::DeadBall {
            reason: DeadBallReason::HalfTime,
            restart_team: TeamRef::Unknown,
        });
    }

    /// 终场哨（design §5 第二张表 `终场哨` 列）：关闭所有观察对象，未完成飞行记 gap。
    pub fn full_time(&mut self, t: ObservedTime) {
        if !self.enabled {
            return;
        }
        if matches!(self.state, BehaviorControlState::Ended) {
            return;
        }
        let in_flight = matches!(self.state, BehaviorControlState::BallInFlight { .. });
        if in_flight {
            self.push(
                ControlFactKind::ObservationGap,
                t,
                None,
                None,
                None,
                ControlFactBasis::StreamBoundary,
                Some(ControlFactDetail::Gap(
                    ObservationGapReason::FullTimeDuringBallInFlight,
                )),
            );
        }
        self.close_episode(
            t,
            if in_flight {
                EpisodeEndReason::WhistleInterrupt
            } else {
                EpisodeEndReason::FullTime
            },
        );
        self.settle_contest(
            t,
            ContestEndReason::MatchEnd,
            ControlFactBasis::StreamBoundary,
        );
        self.close_restart(t, RestartEndReason::MatchEnd);
        self.push(
            ControlFactKind::MatchEnded,
            t,
            None,
            None,
            None,
            ControlFactBasis::StreamBoundary,
            None,
        );
        self.set_state(BehaviorControlState::Ended);
    }

    /// 引擎明确无法确认某事实时上报（design §10.1 的 `unknown` 路径）。
    /// **只记事实、不改状态、不关闭任何对象**——它不代表控制权转换。
    ///
    /// `reason` 是闭集（[`ObservationGapReason`]）：不接受自由字符串，否则「不猜」在 gap 路径上失效。
    pub fn note_gap(
        &mut self,
        t: ObservedTime,
        reason: ObservationGapReason,
        basis: ControlFactBasis,
    ) {
        if !self.enabled {
            return;
        }
        self.push(
            ControlFactKind::ObservationGap,
            t,
            None,
            None,
            None,
            basis,
            Some(ControlFactDetail::Gap(reason)),
        );
    }

    /// 登记尾部压缩边界（见模块头「事件下标绑定规则」）。
    ///
    /// `stabilized_prefix_len` = 压缩开始的下标（`drain_start`）：`[0, n)` 的**最终**下标不变，
    /// `[n, ..)` 会被 drain/filter/extend 重排。引擎在尾部压缩之后调用一次；未调用时视为全部稳定。
    pub fn note_event_stream_compaction(&mut self, stabilized_prefix_len: usize) {
        if !self.enabled {
            return;
        }
        self.stable_event_prefix = Some(match self.stable_event_prefix {
            // 多次压缩取**最小**边界：更早的边界会波及更长的区间。
            Some(prev) => prev.min(stabilized_prefix_len),
            None => stabilized_prefix_len,
        });
    }

    /// 暂停 / 恢复事件下标绑定（`true` = 暂停）。
    ///
    /// `match_events` 在**尾部压缩排空期**（`while st.highlight.is_some()` 里反复
    /// `finalize_highlight`）打开暂停：该区间内产出的 beat 会被随后的 drain/filter 去重丢弃，
    /// 下标**在全部排空完成前无法确定**。此时绑定真实下标（`events.len() - 1`）并不等于最终
    /// 下标，绑定它是**静默错位**；而绑定 `[0, drain_start)` 里的假下标更糟。
    ///
    /// 因此暂停期内的 [`Self::bind_event_index`] 一律**不绑定且不记 gap**（合法空操作，返回
    /// `false`）——事实仍有 `t` 与 `detail` 可定位，而排空期的事实本来就无法可靠归属事件
    /// （`note_event_stream_compaction` 的越界拒绝才是「不该出现的绑定」）。
    ///
    /// 只影响下标绑定，不影响事实记录本身：排空期仍照常产出 `dead_ball_started` /
    /// `control_established` 等事实（否则 episode/restart 会缺收束点）。
    pub fn suspend_event_index_binding(&mut self, suspended: bool) {
        if !self.enabled {
            return;
        }
        self.event_index_binding_suspended = suspended;
    }

    pub fn event_index_binding_suspended(&self) -> bool {
        self.event_index_binding_suspended
    }

    /// 给**指定目标**绑定正式事件下标（见模块头「事件下标绑定规则」）。
    ///
    /// 三种目标（`ControlFact.source_event_index` / `PossessionEpisode.event_indexes` /
    /// `RestartSequence.event_indexes`）共用本入口——下标一律指
    /// [`DiagnosticMatch::events`] 的**最终**下标，落在尾部压缩区间内时**不绑定**并记一条
    /// `observation_gap`（[`ObservationGapReason::EventIndexOutOfStableRange`]）：
    /// 静默错位比不绑定更糟，因为下游无法察觉。返回是否绑定成功。
    ///
    /// 空操作（返回 `false` 且**不记 gap**）的两种情况——都是「此刻无法归属」而非缺陷：
    /// ① `OpenEpisode` / `OpenRestart` 而当前没有对应开放对象；
    /// ② 处于排空期暂停（见 [`Self::suspend_event_index_binding`]）。
    ///
    /// `t` 是失败时那条 gap 事实的时间（调用方知道当前时刻，故不需要 `Unknown` 兜底）。
    pub fn bind_event_index(
        &mut self,
        t: ObservedTime,
        target: EventIndexTarget,
        event_index: usize,
    ) -> bool {
        if !self.enabled || self.event_index_binding_suspended {
            return false;
        }
        // ① 目标存在性：`Fact` 下标越界 = 调用方传错（记 gap）；`Open*` 当前无归属对象 =
        //    合法空操作（见方法文档）。必须在压缩校验**之前**判定，否则越界 fact 会被
        //    误报成压缩问题（两种原因在诊断上必须可区分）。
        let unattributed: Option<(usize, usize)> = match target {
            EventIndexTarget::Fact(i) if i < self.facts.len() => None,
            EventIndexTarget::Fact(_) => {
                self.note_gap(
                    t,
                    ObservationGapReason::IllegalFactIndex,
                    ControlFactBasis::EngineState,
                );
                return false;
            }
            EventIndexTarget::OpenEpisode if self.open_episode.is_none() => return false,
            EventIndexTarget::OpenRestart if self.open_restart.is_none() => return false,
            EventIndexTarget::LastFactOfKind(kind)
                if !self.facts.iter().any(|f| f.kind == kind) =>
            {
                return false
            }
            EventIndexTarget::UnattributedFacts => {
                let range = (self.attributed_upto, self.facts.len());
                if range.0 == range.1 {
                    return false; // 没有待归属的事实：合法空操作
                }
                Some(range)
            }
            EventIndexTarget::LastFactOfKind(_) => None,
            _ => None,
        };
        // ② 尾部压缩区间内不绑定（静默错位比不绑定更糟）。失败不留半个绑定。
        if let Some(bound) = self.stable_event_prefix {
            if event_index >= bound {
                self.note_gap(
                    t,
                    ObservationGapReason::EventIndexOutOfStableRange,
                    ControlFactBasis::EngineState,
                );
                return false;
            }
        }
        // ③ 写入。同一下标只入一次：同一提交点或相邻提交点重复报告同一个事件时不该重复入数组。
        //
        // **重绑不得让来源倒退**：`Fact` / `LastFactOfKind` 会**覆写**已有的
        // `source_event_index`，而当前接线依赖「覆写总是发生在更晚（更大）的下标上」——
        // `obs_goal_kick_delivered` 先用 `UnattributedFacts` 把死球类事实绑到**产生死球的**
        // 事件，再用 `LastFactOfKind(RestartTaken)` 把 taken 改绑到**更晚的**门球交付事件。
        // 若将来调用顺序被调换，事实的来源会静默倒退到更早的事件，而所有现有断言（都只查
        // 「不晚于事实时刻」）仍全绿——所以这个守卫必须在这里、而不是靠调用方自律。
        // 拒绝时记 gap（不静默忽略）：倒退本身是接线错误，应当可见。
        if let Some(prev) = match target {
            EventIndexTarget::Fact(i) => self.facts[i].source_event_index,
            EventIndexTarget::LastFactOfKind(kind) => self
                .facts
                .iter()
                .rposition(|f| f.kind == kind)
                .and_then(|i| self.facts[i].source_event_index),
            _ => None,
        } {
            if event_index < prev {
                self.note_gap(
                    t,
                    ObservationGapReason::EventIndexRegressed,
                    ControlFactBasis::EngineState,
                );
                return false;
            }
        }
        match target {
            EventIndexTarget::Fact(i) => {
                self.facts[i].source_event_index = Some(event_index);
            }
            EventIndexTarget::LastFactOfKind(kind) => {
                let i = self
                    .facts
                    .iter()
                    .rposition(|f| f.kind == kind)
                    .expect("①已确认存在该 kind");
                self.facts[i].source_event_index = Some(event_index);
            }
            EventIndexTarget::UnattributedFacts => {
                let (from, to) = unattributed.expect("①已确认非空");
                for f in from..to {
                    self.facts[f].source_event_index = Some(event_index);
                }
                // 水位只在**成功绑定**后推进：被压缩拒绝时不推进，避免把待归属事实静默丢给
                // 下一个事件（那会让来源张冠李戴）。
                self.attributed_upto = self.attributed_upto.max(to);
            }
            EventIndexTarget::OpenEpisode => {
                let i = self.open_episode.expect("①已确认存在开放 episode");
                if !self.episodes[i].event_indexes.contains(&event_index) {
                    self.episodes[i].event_indexes.push(event_index);
                }
            }
            EventIndexTarget::OpenRestart => {
                let i = self.open_restart.expect("①已确认存在开放 restart");
                if !self.restarts[i].event_indexes.contains(&event_index) {
                    self.restarts[i].event_indexes.push(event_index);
                }
            }
        }
        true
    }

    // ---- 内部：事实追加与对象开闭 ----

    #[allow(clippy::too_many_arguments)]
    fn push(
        &mut self,
        kind: ControlFactKind,
        t: ObservedTime,
        team: Option<TeamId>,
        player: Option<i32>,
        location: Option<(f64, f64)>,
        basis: ControlFactBasis,
        detail: Option<ControlFactDetail>,
    ) -> usize {
        let idx = self.facts.len();
        self.facts.push(ControlFact {
            t,
            kind,
            team,
            player,
            location,
            source_event_index: None,
            basis,
            detail,
        });
        idx
    }

    /// 矛盾输入：记 `observation_gap` 并收束**开放 episode / 争抢**（design §10 第一条）。
    ///
    /// **不改 `state`**——矛盾输入没有可推进的目标状态；下一次合法提交仍按原状态判定。
    /// **不动开放 restart**：design §6.2 只给了三种重开结束方式（`open_play_resumed` /
    /// `terminated_by_whistle` / `match_end`），矛盾输入不在其中。例如「重开未 taken 就报控制建立」
    /// 时，被判非法的是那条控制声明，重开本身仍在合法准备中——为记 gap 而关掉它会丢掉真实足球事实。
    fn reject(&mut self, t: ObservedTime, reason: IllegalInput) {
        // **先**在原记录上跑交叉校验并留存违规项：`close_episode` / `settle_contest` 之后
        // `state` 与记录必然不一致（按 design 这是正确行为），届时再校验就无法区分
        // 「gap 造成的陈旧」与「本来就有缺陷的 state」。
        //
        // 只在 `state` **尚未**因上一次 gap 陈旧时才校验：连续矛盾输入（reject 链）里，
        // 第二次 reject 面对的 `Contested` 状态已被第一次 reject 关掉了 contest，
        // 此时再校验必然报「争抢已收束」——那是**上一个 gap 的必然结果**，不是缺陷。
        // 该窗口（gap 之后、下一次成功转场之前）正是设计认可的「state 应当陈旧」区间。
        if self.stale_state_snapshot.is_none() {
            let pre_gap = self.state_record_violations(&self.state);
            self.deferred_violations.extend(pre_gap);
        }
        self.push(
            ControlFactKind::ObservationGap,
            t,
            None,
            None,
            None,
            ControlFactBasis::EngineState,
            Some(ControlFactDetail::Gap(ObservationGapReason::IllegalInput(
                reason,
            ))),
        );
        self.close_episode(t, EpisodeEndReason::ObservationGap);
        self.settle_contest(
            t,
            ContestEndReason::ObservationGap,
            ControlFactBasis::EngineState,
        );
        // `state` 按 design 保持不推进（没有可推进的目标状态）→ 记下此刻的 `state` 快照，
        // 供不变量 9 按值判断「陈旧豁免是否仍然适用」。
        self.stale_state_snapshot = Some(self.state);
    }

    /// 推进派生状态并**清掉「矛盾输入后陈旧」标记**（恢复不变量 9 的实时交叉校验）。
    /// 所有成功推进状态的命令都必须经此——若有命令绕过它直接写 `self.state`，
    /// 不变量 9 会在那之后停止校验（测试 `gap_does_not_mask_a_later_state_downgrade` 守这一点）。
    fn set_state(&mut self, next: BehaviorControlState) {
        self.state = next;
        self.stale_state_snapshot = None;
    }

    fn open_new_episode(
        &mut self,
        team: TeamId,
        start_t: ObservedTime,
        start_reason: EpisodeStartReason,
        fact_index: usize,
    ) {
        let id = self.next_episode_id;
        self.next_episode_id += 1;
        self.episodes.push(PossessionEpisode {
            id,
            team,
            start_t,
            end_t: None,
            start_reason,
            end_reason: None,
            control_fact_indexes: vec![fact_index],
            event_indexes: Vec::new(),
        });
        self.open_episode = Some(self.episodes.len() - 1);
    }

    fn close_episode(&mut self, end_t: ObservedTime, reason: EpisodeEndReason) {
        if let Some(i) = self.open_episode.take() {
            self.episodes[i].end_t = Some(end_t);
            self.episodes[i].end_reason = Some(reason);
        }
    }

    fn open_new_restart(
        &mut self,
        team: TeamRef,
        kind: RestartKind,
        start_t: ObservedTime,
    ) -> usize {
        let id = self.next_restart_id;
        self.next_restart_id += 1;
        self.restarts.push(RestartSequence {
            id,
            team,
            kind,
            start_t,
            taken_t: None,
            open_play_resumed_t: None,
            event_indexes: Vec::new(),
            end_reason: None,
        });
        self.open_restart = Some(self.restarts.len() - 1);
        self.restarts.len() - 1
    }

    fn close_restart(&mut self, at: ObservedTime, reason: RestartEndReason) {
        if let Some(i) = self.open_restart.take() {
            self.restarts[i].end_reason = Some(reason);
            if reason == RestartEndReason::OpenPlayResumed {
                self.restarts[i].open_play_resumed_t = Some(at);
            }
        }
    }

    /// 离开争抢：只在争抢确实开放时留下 `contest_ended`（design §10.1：离开时必须记录）。
    fn settle_contest(
        &mut self,
        t: ObservedTime,
        reason: ContestEndReason,
        basis: ControlFactBasis,
    ) {
        if !self.contest_open {
            return;
        }
        self.push(
            ControlFactKind::ContestEnded,
            t,
            None,
            None,
            None,
            basis,
            Some(ControlFactDetail::ContestEnd(reason)),
        );
        self.contest_open = false;
    }
}

/// 重开方式 → 飞行出球类型（design §10.1 的 `FlightAction` 闭集）。
///
/// `Kickoff` 在 §10.1 的初版闭集里没有对应项，故 Slice 1 记成 `unknown` 并标注为待确认缺口。
/// Slice 2 按 §15 A9-1 补了具名成员 `FlightAction::Kickoff`——开球拨球**不是** `Pass`
/// （不代设计做等价映射），但它是一种确定的出球方式，不该退化成「证据不足」。
/// 只剩 `RestartKind::Unknown` 映射到 `FlightAction::Unknown`（真正的证据不足）。
fn flight_action_for(kind: RestartKind) -> FlightAction {
    match kind {
        RestartKind::Corner => FlightAction::Corner,
        RestartKind::ThrowIn => FlightAction::ThrowIn,
        RestartKind::FreeKick => FlightAction::FreeKick,
        RestartKind::GoalKick => FlightAction::GoalKick,
        RestartKind::Kickoff => FlightAction::Kickoff,
        RestartKind::Unknown => FlightAction::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{simulate, simulate_with_behavior_observations, MatchConfig};

    fn t0() -> ObservedTime {
        ObservedTime::event_emit(0.0)
    }

    fn tc(value: f64) -> ObservedTime {
        ObservedTime::state_commit(value)
    }

    /// 走一遍「开球 → 首次控制」的最短合法路径，返回 recorder。
    fn kicked_off() -> BehaviorObservationRecorder {
        let mut rec = BehaviorObservationRecorder::enabled();
        rec.match_started(t0(), TeamRef::Home);
        rec.restart_taken(tc(0.0), ControlFactBasis::RestartRule);
        rec.control_established(
            tc(0.5),
            TeamId::Home,
            Some(10),
            Some((0.55, 0.5)),
            EpisodeStartReason::Kickoff,
            None,
            ControlFactBasis::EngineState,
        );
        rec
    }

    /// 枚举串名唯一性守护。Slice 1 里多数 `as_str` 尚无调用点（Slice 2/4 才会读），
    /// 复制粘贴写错一个串要等到那时才暴露；这个 collar 让它当场红。
    #[test]
    fn closed_set_string_names_are_unique_and_snake_case() {
        fn check(what: &str, names: &[&str]) {
            let mut seen = Vec::new();
            for n in names {
                assert!(!n.is_empty(), "{} 有空串名", what);
                assert!(
                    n.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
                    "{} 的 {:?} 不是 snake_case",
                    what,
                    n
                );
                assert!(!seen.contains(n), "{} 的串名 {:?} 重复", what, n);
                seen.push(*n);
            }
        }
        check(
            "ControlFactKind",
            &[
                ControlFactKind::MatchStarted.as_str(),
                ControlFactKind::ControlEstablished.as_str(),
                ControlFactKind::ControlReleased.as_str(),
                ControlFactKind::ContestStarted.as_str(),
                ControlFactKind::ContestEnded.as_str(),
                ControlFactKind::DeadBallStarted.as_str(),
                ControlFactKind::RestartPreparationStarted.as_str(),
                ControlFactKind::RestartTaken.as_str(),
                ControlFactKind::OpenPlayResumed.as_str(),
                ControlFactKind::ObservationGap.as_str(),
                ControlFactKind::MatchEnded.as_str(),
            ],
        );
        check(
            "ControlFactBasis",
            &[
                ControlFactBasis::EngineState.as_str(),
                ControlFactBasis::FinalizedOutcome.as_str(),
                ControlFactBasis::RestartRule.as_str(),
                ControlFactBasis::StreamBoundary.as_str(),
            ],
        );
        check(
            "TimeBasis",
            &[
                TimeBasis::StateCommit.as_str(),
                TimeBasis::EventEmit.as_str(),
                TimeBasis::DeterministicFlightEnd.as_str(),
                TimeBasis::Unknown.as_str(),
            ],
        );
        check(
            "RestartKind",
            &[
                RestartKind::Kickoff.as_str(),
                RestartKind::FreeKick.as_str(),
                RestartKind::Corner.as_str(),
                RestartKind::ThrowIn.as_str(),
                RestartKind::GoalKick.as_str(),
                RestartKind::Unknown.as_str(),
            ],
        );
        check(
            "DeadBallReason",
            &[
                DeadBallReason::Goal.as_str(),
                DeadBallReason::OutSideline.as_str(),
                DeadBallReason::OutGoalLine.as_str(),
                DeadBallReason::Foul.as_str(),
                DeadBallReason::HalfTime.as_str(),
                DeadBallReason::FullTime.as_str(),
                DeadBallReason::Unknown.as_str(),
            ],
        );
        check(
            "FlightAction",
            &[
                FlightAction::Pass.as_str(),
                FlightAction::Clearance.as_str(),
                FlightAction::Shot.as_str(),
                FlightAction::Corner.as_str(),
                FlightAction::ThrowIn.as_str(),
                FlightAction::FreeKick.as_str(),
                FlightAction::GoalKick.as_str(),
                FlightAction::Kickoff.as_str(),
                FlightAction::Unknown.as_str(),
            ],
        );
        check(
            "RestartEndReason",
            &[
                RestartEndReason::OpenPlayResumed.as_str(),
                RestartEndReason::TerminatedByWhistle.as_str(),
                RestartEndReason::MatchEnd.as_str(),
                RestartEndReason::SupersededByDeadBall.as_str(),
                RestartEndReason::Unknown.as_str(),
            ],
        );
        check(
            "EpisodeStartReason",
            &[
                EpisodeStartReason::Kickoff.as_str(),
                EpisodeStartReason::Pickup.as_str(),
                EpisodeStartReason::SuccessfulReceive.as_str(),
                EpisodeStartReason::RestartControl.as_str(),
                EpisodeStartReason::ControlChange.as_str(),
                EpisodeStartReason::Unknown.as_str(),
            ],
        );
        check(
            "EpisodeEndReason",
            &[
                EpisodeEndReason::Goal.as_str(),
                EpisodeEndReason::SavedCaught.as_str(),
                EpisodeEndReason::ShotRebound.as_str(),
                EpisodeEndReason::Out.as_str(),
                EpisodeEndReason::Foul.as_str(),
                EpisodeEndReason::ControlLost.as_str(),
                EpisodeEndReason::WhistleInterrupt.as_str(),
                EpisodeEndReason::HalfTime.as_str(),
                EpisodeEndReason::FullTime.as_str(),
                EpisodeEndReason::ObservationGap.as_str(),
            ],
        );
        check(
            "ContestStartReason",
            &[
                ContestStartReason::PassLost.as_str(),
                ContestStartReason::InterceptionLoose.as_str(),
                ContestStartReason::TackleLoose.as_str(),
                ContestStartReason::ShotRebound.as_str(),
                ContestStartReason::DeliveryLoose.as_str(),
                ContestStartReason::Unknown.as_str(),
            ],
        );
        check(
            "ContestEndReason",
            &[
                ContestEndReason::Pickup.as_str(),
                ContestEndReason::DeadBall.as_str(),
                ContestEndReason::Whistle.as_str(),
                ContestEndReason::MatchEnd.as_str(),
                ContestEndReason::ObservationGap.as_str(),
                ContestEndReason::Unknown.as_str(),
            ],
        );
        check("TeamId", &[TeamId::Home.as_str(), TeamId::Away.as_str()]);
        check(
            "TeamRef",
            &[
                TeamRef::Home.as_str(),
                TeamRef::Away.as_str(),
                TeamRef::Unknown.as_str(),
            ],
        );
        check(
            "Phase",
            &[
                Phase::BuildUp.as_str(),
                Phase::Progression.as_str(),
                Phase::FinalThird.as_str(),
                Phase::AttackingTransition.as_str(),
                Phase::Unknown.as_str(),
            ],
        );
        check(
            "PhaseProvenance",
            &[
                PhaseProvenance::EngineHint.as_str(),
                PhaseProvenance::Geometry.as_str(),
                PhaseProvenance::Event.as_str(),
                PhaseProvenance::Inherited.as_str(),
                PhaseProvenance::Unknown.as_str(),
            ],
        );
        check(
            "IllegalInput",
            &[
                IllegalInput::MatchStartedOutsideUninitialized.as_str(),
                IllegalInput::DeadBallStartedInIllegalState.as_str(),
                IllegalInput::RestartPreparationOutsideDeadBall.as_str(),
                IllegalInput::RestartPreparationWithoutScheduledRestart.as_str(),
                IllegalInput::RestartPreparationContradictsScheduledRestart.as_str(),
                IllegalInput::RestartTakenOutsideRestartPreparation.as_str(),
                IllegalInput::ControlEstablishedInIllegalState.as_str(),
                IllegalInput::ControlEstablishedBeforeRestartTaken.as_str(),
                IllegalInput::ControlEstablishedByOpponentWhileControlled.as_str(),
                IllegalInput::ControlReleasedIntoFlightOutsideControlled.as_str(),
                IllegalInput::ContestStartedWhileContested.as_str(),
                IllegalInput::ContestStartedInIllegalState.as_str(),
            ],
        );
        check(
            "ObservationGapReason",
            &[
                ObservationGapReason::HalfTimeDuringBallInFlight.as_str(),
                ObservationGapReason::FullTimeDuringBallInFlight.as_str(),
                ObservationGapReason::IllegalInput(IllegalInput::MatchStartedOutsideUninitialized)
                    .as_str(),
                ObservationGapReason::MissingStreamEndBoundary.as_str(),
                ObservationGapReason::EventIndexOutOfStableRange.as_str(),
                ObservationGapReason::IllegalFactIndex.as_str(),
                ObservationGapReason::EventIndexRegressed.as_str(),
            ],
        );
        // design §9.1 的两条 episode 结束原因不得与 `EpisodeStartReason` 的串名混淆。
        assert_eq!(EpisodeEndReason::ObservationGap.as_str(), "observation_gap");
        assert_eq!(
            EpisodeEndReason::WhistleInterrupt.as_str(),
            "whistle_interrupt"
        );
        assert_eq!(ControlFactKind::ObservationGap.as_str(), "observation_gap");
        // `BehaviorControlState` 是单串（带字段变体），只查其状态名可读。
        for s in [
            BehaviorControlState::Uninitialized.as_str(),
            BehaviorControlState::Controlled {
                team: TeamId::Home,
                carrier: None,
            }
            .as_str(),
            BehaviorControlState::Contested {
                previous_team: None,
                location: None,
            }
            .as_str(),
            BehaviorControlState::BallInFlight {
                originating_team: TeamRef::Unknown,
                action: FlightAction::Unknown,
            }
            .as_str(),
            BehaviorControlState::DeadBall {
                reason: DeadBallReason::Unknown,
                restart_team: TeamRef::Unknown,
            }
            .as_str(),
            BehaviorControlState::RestartPreparation {
                team: TeamRef::Unknown,
                kind: RestartKind::Unknown,
            }
            .as_str(),
            BehaviorControlState::Ended.as_str(),
        ] {
            assert!(
                s.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
                "{:?} 不是 snake_case",
                s
            );
        }
    }

    #[test]
    fn disabled_recorder_is_a_no_op() {
        // 注意：这只是**契约测试**（关闭 → 命令无效），不证明 `simulate()` 已走这条路径——
        // 目前 `simulate()` 压根不建 recorder（见 `BehaviorObservationRecorder` 的文档）。
        let mut rec = BehaviorObservationRecorder::disabled();
        rec.match_started(t0(), TeamRef::Home);
        rec.restart_taken(tc(0.0), ControlFactBasis::RestartRule);
        rec.control_established(
            tc(1.0),
            TeamId::Home,
            Some(10),
            None,
            EpisodeStartReason::Kickoff,
            None,
            ControlFactBasis::EngineState,
        );
        rec.full_time(tc(5400.0));
        assert!(rec.facts().is_empty(), "关闭的 recorder 不得记录任何事实");
        assert_eq!(*rec.state(), BehaviorControlState::Uninitialized);
        let dm = rec.into_diagnostic_match(Vec::new());
        assert!(dm.control_facts.is_empty());
        assert!(dm.possession_episodes.is_empty());
        assert!(dm.restart_sequences.is_empty());
        assert!(dm.phase_segments.is_empty());
    }

    #[test]
    fn minimal_path_closes_kickoff_sequence_and_opens_episode() {
        let rec = kicked_off();
        assert!(
            rec.invariant_violations().is_empty(),
            "{:?}",
            rec.invariant_violations()
        );
        // 开球重开在首次明确控制时以 open_play_resumed 收束。
        assert_eq!(rec.restarts().len(), 1);
        assert_eq!(rec.restarts()[0].kind, RestartKind::Kickoff);
        assert_eq!(rec.restarts()[0].team, TeamRef::Home);
        assert_eq!(rec.restarts()[0].taken_t, Some(tc(0.0)));
        assert_eq!(rec.restarts()[0].open_play_resumed_t, Some(tc(0.5)));
        assert_eq!(
            rec.restarts()[0].end_reason,
            Some(RestartEndReason::OpenPlayResumed)
        );
        // episode 已开启但未关闭。
        assert_eq!(rec.episodes().len(), 1);
        assert_eq!(rec.episodes()[0].team, TeamId::Home);
        assert_eq!(rec.episodes()[0].start_reason, EpisodeStartReason::Kickoff);
        assert_eq!(rec.episodes()[0].end_t, None);
        // 事实顺序：match_started → restart_preparation_started → restart_taken →
        //           open_play_resumed → control_established。
        let kinds: Vec<&str> = rec.facts().iter().map(|f| f.kind.as_str()).collect();
        assert_eq!(
            kinds,
            vec![
                "match_started",
                "restart_preparation_started",
                "restart_taken",
                "open_play_resumed",
                "control_established"
            ]
        );
        assert_eq!(
            *rec.state(),
            BehaviorControlState::Controlled {
                team: TeamId::Home,
                carrier: Some(10)
            }
        );
    }

    #[test]
    fn same_team_receive_continues_episode_without_new_boundary() {
        let mut rec = kicked_off();
        rec.control_released_into_flight(
            tc(1.0),
            FlightAction::Pass,
            ControlFactBasis::EngineState,
        );
        rec.control_established(
            tc(2.0),
            TeamId::Home,
            Some(7),
            Some((0.7, 0.5)),
            EpisodeStartReason::SuccessfulReceive,
            None,
            ControlFactBasis::FinalizedOutcome,
        );
        assert_eq!(rec.episodes().len(), 1, "同队接球必须延续同一 episode");
        assert_eq!(rec.episodes()[0].end_t, None);
        assert_eq!(rec.episodes()[0].control_fact_indexes.len(), 2);
        assert!(rec.invariant_violations().is_empty());
    }

    #[test]
    fn lost_pass_closes_episode_and_enters_contest() {
        let mut rec = kicked_off();
        rec.control_released_into_flight(
            tc(1.0),
            FlightAction::Pass,
            ControlFactBasis::EngineState,
        );
        rec.contest_started(
            tc(2.0),
            ContestStartReason::PassLost,
            Some((0.6, 0.5)),
            EpisodeEndReason::ControlLost,
            ControlFactBasis::FinalizedOutcome,
        );
        // 旧 episode 以 control_lost 关闭；未建立对手 episode。
        assert_eq!(rec.episodes().len(), 1);
        assert_eq!(
            rec.episodes()[0].end_reason,
            Some(EpisodeEndReason::ControlLost)
        );
        assert_eq!(
            *rec.state(),
            BehaviorControlState::Contested {
                previous_team: Some(TeamId::Home),
                location: Some((0.6, 0.5))
            }
        );
        // 出球时已记过 control_released，争抢入口不得重复记录。
        let released = rec
            .facts()
            .iter()
            .filter(|f| f.kind == ControlFactKind::ControlReleased)
            .count();
        assert_eq!(released, 1, "control_released 不得重复记录");
        // pickup → 新 episode。
        rec.control_established(
            tc(3.0),
            TeamId::Away,
            Some(11),
            Some((0.6, 0.5)),
            EpisodeStartReason::Pickup,
            None,
            ControlFactBasis::EngineState,
        );
        assert_eq!(rec.episodes().len(), 2, "pickup 必须开启新 episode");
        assert_eq!(rec.episodes()[1].team, TeamId::Away);
        assert_eq!(rec.episodes()[1].start_reason, EpisodeStartReason::Pickup);
        assert!(
            rec.invariant_violations().is_empty(),
            "{:?}",
            rec.invariant_violations()
        );
    }

    #[test]
    fn shot_outcome_closes_episode_with_its_own_reason() {
        // 射门 → 进球：episode 以 goal 结束，死球创建对方开球 sequence。
        let mut rec = kicked_off();
        rec.control_released_into_flight(
            tc(1.0),
            FlightAction::Shot,
            ControlFactBasis::EngineState,
        );
        assert_eq!(
            rec.episodes()[0].end_t,
            None,
            "shot emit 不得提前决定 episode 结局"
        );
        rec.dead_ball_started(
            tc(2.0),
            DeadBallReason::Goal,
            Some((TeamRef::Away, RestartKind::Kickoff)),
            EpisodeEndReason::Goal,
            ControlFactBasis::FinalizedOutcome,
        );
        assert_eq!(rec.episodes()[0].end_reason, Some(EpisodeEndReason::Goal));
        assert_eq!(rec.restarts().len(), 2);
        assert_eq!(rec.restarts()[1].team, TeamRef::Away);
        assert_eq!(rec.restarts()[1].kind, RestartKind::Kickoff);
        assert!(
            rec.invariant_violations().is_empty(),
            "{:?}",
            rec.invariant_violations()
        );

        // 射门 → 门将扑住：episode 以 saved_caught 结束，门将队开启新 episode（不创建重开）。
        let mut rec = kicked_off();
        rec.control_released_into_flight(
            tc(1.0),
            FlightAction::Shot,
            ControlFactBasis::EngineState,
        );
        rec.control_established(
            tc(2.0),
            TeamId::Away,
            Some(21),
            Some((0.05, 0.5)),
            EpisodeStartReason::ControlChange,
            Some(EpisodeEndReason::SavedCaught),
            ControlFactBasis::FinalizedOutcome,
        );
        assert_eq!(
            rec.episodes()[0].end_reason,
            Some(EpisodeEndReason::SavedCaught)
        );
        assert_eq!(rec.episodes()[1].team, TeamId::Away);
        assert!(
            rec.invariant_violations().is_empty(),
            "{:?}",
            rec.invariant_violations()
        );
    }

    #[test]
    fn dead_ball_lifecycle_requires_preparation_then_taken() {
        let mut rec = kicked_off();
        rec.dead_ball_started(
            tc(10.0),
            DeadBallReason::OutSideline,
            Some((TeamRef::Unknown, RestartKind::ThrowIn)),
            EpisodeEndReason::Out,
            ControlFactBasis::FinalizedOutcome,
        );
        let throws = rec.restarts().len() - 1;
        assert_eq!(rec.restarts()[throws].team, TeamRef::Unknown);
        // 归属可被后续证据细化，不猜也不丢证据。
        rec.restart_preparation_started(
            tc(12.0),
            TeamRef::Away,
            RestartKind::ThrowIn,
            ControlFactBasis::RestartRule,
        );
        assert_eq!(rec.restarts()[throws].team, TeamRef::Away);
        // taken 之前不得建立控制（design §5：RestartPreparation 必须先 taken）。
        rec.control_established(
            tc(12.5),
            TeamId::Away,
            Some(15),
            None,
            EpisodeStartReason::RestartControl,
            None,
            ControlFactBasis::EngineState,
        );
        assert_eq!(rec.gap_count(), 1, "restart 未 taken 就建立控制必须记 gap");
        // 合法路径：taken → 首次控制 → open_play_resumed。
        rec.restart_taken(tc(13.0), ControlFactBasis::RestartRule);
        rec.control_established(
            tc(14.0),
            TeamId::Away,
            Some(15),
            Some((0.5, 0.98)),
            EpisodeStartReason::RestartControl,
            None,
            ControlFactBasis::EngineState,
        );
        assert_eq!(
            rec.restarts()[throws].end_reason,
            Some(RestartEndReason::OpenPlayResumed)
        );
        assert_eq!(rec.restarts()[throws].open_play_resumed_t, Some(tc(14.0)));
        assert_eq!(rec.episodes().last().unwrap().team, TeamId::Away);
        assert!(
            rec.invariant_violations().is_empty(),
            "{:?}",
            rec.invariant_violations()
        );
    }

    /// §6.2 一致性规则：**「进了准备期却没有重开安排」是矛盾输入，不凭空造 sequence。**
    ///
    /// 生命周期首环节是 `dead_ball_started`（sequence 由 §6.3 死球来源矩阵在那一刻创建），
    /// 故「没有 sequence 的 prep」没有合法入口。旧实现在这里 `open_new_restart` 补一条——
    /// 那是「猜」：给没有死球来源的重开造出 `start_t`，把首环节抹掉，并让「生产接线漏记
    /// `dead_ball_started`」这件事**静默自愈**而不是当场记 gap。
    ///
    /// 判别力（目标变异必红）：把 `is_none()` 分支改回 `open_new_restart` → 第 1 条断言
    /// （期望 1 条 gap）红、第 3 条（期望无开放 restart）红。
    #[test]
    fn restart_preparation_without_a_scheduled_restart_is_rejected_not_invented() {
        // 直接构造「半场哨造成的无重开安排死球」（§6.3 half time 行：不创建 sequence）。
        let mut rec = kicked_off();
        rec.half_time(tc(50.0));
        assert_eq!(
            *rec.state(),
            BehaviorControlState::DeadBall {
                reason: DeadBallReason::HalfTime,
                restart_team: TeamRef::Unknown,
            },
            "半场哨后应停在无重开安排的死球"
        );
        assert_eq!(rec.restarts().len(), 1, "半场哨不得创建 sequence（只有首开球那条）");
        rec.restart_preparation_started(
            tc(51.0),
            TeamRef::Home,
            RestartKind::Kickoff,
            ControlFactBasis::RestartRule,
        );
        assert_eq!(
            rec.gap_count(),
            1,
            "没有重开安排却报准备期 = 矛盾输入，必须记 gap 而不是补一条 sequence"
        );
        assert!(
            rec.facts()
                .last()
                .map(|f| f.detail == Some(ControlFactDetail::Gap(
                    ObservationGapReason::IllegalInput(
                        IllegalInput::RestartPreparationWithoutScheduledRestart
                    )
                )))
                .unwrap_or(false),
            "gap 原因必须是具名的 `restart_preparation_without_scheduled_restart`：{:?}",
            rec.facts().last()
        );
        assert_eq!(
            rec.restarts().len(),
            1,
            "被拒绝的 prep 不得凭空造出第二条 sequence"
        );
        assert!(
            !rec.restarts().iter().any(|r| r.end_reason.is_none()),
            "不得留下悬空（开放）的 restart：{:?}",
            rec.restarts()
        );
    }

    /// **P0 回归门**：重开交付后的首次明确控制，episode `start_reason` 必须由**开放 restart 的
    /// 事实**决定，与调用方传进来的原始值无关。
    ///
    /// 为什么这是 P0：`control_established` 被三类落点形态共用，调用方能声明的只是「这是接球 /
    /// 这是拾取」，声明不了「这是交付」——早先版本靠 `Highlight::restart_delivery` 在**调用点**
    /// 分流，只覆盖 `PassCaught` 那一半，角球（`advance_loose` / battle 分支）与门球
    /// （`advance_loose`）因此被标成 `Pickup`。实测 120 seed：角球 229 条、门球 1397 条错标。
    ///
    /// 判别力：本测试对每种 restart kind 传**生产实际会传的那个原始值**（角球/门球传
    /// `Pickup`、界外球/任意球传 `SuccessfulReceive`），因此「把归一逻辑硬编码成 `Pickup`」
    /// 会让界外球/任意球那两行变红，「删掉归一逻辑」会让角球/门球那两行变红。
    #[test]
    fn restart_delivery_control_start_reason_is_decided_by_the_open_restart() {
        // (restart kind, 是否走门球专线, 生产实际传的原始 start_reason)
        let cases = [
            (RestartKind::Corner, false, EpisodeStartReason::Pickup),
            (RestartKind::GoalKick, true, EpisodeStartReason::Pickup),
            (RestartKind::ThrowIn, false, EpisodeStartReason::SuccessfulReceive),
            (RestartKind::FreeKick, false, EpisodeStartReason::SuccessfulReceive),
        ];
        for (kind, goal_kick_line, raw_reason) in cases {
            let mut rec = kicked_off();
            let t_dead = tc(100.0);
            if goal_kick_line {
                // 门球：dead ball + taken 同刻（§15 A9-3，无准备期）。
                rec.goal_kick_started(
                    t_dead,
                    DeadBallReason::OutGoalLine,
                    (TeamRef::Away, kind),
                    EpisodeEndReason::Out,
                    ControlFactBasis::FinalizedOutcome,
                );
            } else {
                rec.dead_ball_started(
                    t_dead,
                    if kind == RestartKind::Corner {
                        DeadBallReason::OutGoalLine
                    } else {
                        DeadBallReason::OutSideline
                    },
                    Some((TeamRef::Away, kind)),
                    EpisodeEndReason::Out,
                    ControlFactBasis::FinalizedOutcome,
                );
                rec.restart_preparation_started(
                    tc(101.0),
                    TeamRef::Away,
                    kind,
                    ControlFactBasis::RestartRule,
                );
                rec.restart_taken(tc(102.0), ControlFactBasis::RestartRule);
            }
            rec.control_established(
                tc(105.0),
                TeamId::Away,
                Some(15),
                Some((0.4, 0.5)),
                raw_reason,
                None,
                ControlFactBasis::EngineState,
            );
            let ep = rec.episodes().last().unwrap();
            assert_eq!(
                ep.start_reason,
                EpisodeStartReason::RestartControl,
                "{:?} 交付后的首次控制必须记为交付控制（调用方原始值 {:?} 不得直接落到 episode）",
                kind,
                raw_reason
            );
            assert_eq!(
                rec.restarts().last().unwrap().end_reason,
                Some(RestartEndReason::OpenPlayResumed),
                "{:?} 交付后 open_play_resumed 收束",
                kind
            );
            assert!(
                rec.invariant_violations().is_empty(),
                "{:?}: {:?}",
                kind,
                rec.invariant_violations()
            );
        }
    }

    /// **P0 的反证面**：没有开放 restart 时，`start_reason` 必须**保留调用方的语义声明**——
    /// 归一不得把开放比赛的成功接球 / 真 loose 拾取也吞成 `RestartControl`。
    ///
    /// 同时钉住首开球的**明确语义**：它也有开放 restart，但 `Kickoff` 是「开赛」而不是
    /// 「重开交付」，故必须被显式豁免（否则 120 个 seed 的第一条 episode 全变 `RestartControl`）。
    #[test]
    fn open_play_control_keeps_its_declared_start_reason() {
        // ① 开放比赛传接（无开放 restart）：声明什么就是什么。
        for raw in [
            EpisodeStartReason::SuccessfulReceive,
            EpisodeStartReason::Pickup,
            EpisodeStartReason::ControlChange,
        ] {
            let mut rec = kicked_off();
            // 先让当前 episode 收束，才能观察「新开 episode 的 start_reason」。
            rec.contest_started(
                tc(10.0),
                ContestStartReason::PassLost,
                Some((0.5, 0.5)),
                EpisodeEndReason::ControlLost,
                ControlFactBasis::EngineState,
            );
            rec.control_established(
                tc(11.0),
                TeamId::Away,
                Some(15),
                Some((0.5, 0.5)),
                raw,
                None,
                ControlFactBasis::EngineState,
            );
            assert_eq!(
                rec.episodes().last().unwrap().start_reason,
                raw,
                "无开放 restart 时不得改写调用方声明（{:?}）",
                raw
            );
            assert!(
                rec.invariant_violations().is_empty(),
                "{:?}",
                rec.invariant_violations()
            );
        }
        // ② 首开球：有开放 restart，但 `Kickoff` 豁免归一。
        let rec = kicked_off();
        assert_eq!(
            rec.episodes()[0].start_reason,
            EpisodeStartReason::Kickoff,
            "首开球必须以 `Kickoff` 开 episode（开赛 ≠ 重开交付）"
        );
        assert_eq!(rec.episodes()[0].start_t, tc(0.5), "首开球 episode 起于首次控制提交那刻");
    }

    #[test]
    fn full_time_closes_every_open_object_including_unfinished_flight() {
        // 未决飞行被终场哨打断：gap 事实 + episode 结束原因固定为 whistle_interrupt（design §10）。
        let mut rec = kicked_off();
        rec.control_released_into_flight(
            tc(5399.0),
            FlightAction::Shot,
            ControlFactBasis::EngineState,
        );
        rec.full_time(tc(5400.0));
        assert_eq!(rec.gap_count(), 1);
        assert_eq!(
            rec.episodes()[0].end_reason,
            Some(EpisodeEndReason::WhistleInterrupt)
        );
        assert_eq!(*rec.state(), BehaviorControlState::Ended);
        assert_eq!(
            rec.facts().last().unwrap().kind,
            ControlFactKind::MatchEnded
        );
        assert!(
            rec.invariant_violations().is_empty(),
            "{:?}",
            rec.invariant_violations()
        );

        // 持球状态下终场：正常以 full_time 关闭，不产 gap。
        let mut rec = kicked_off();
        rec.full_time(tc(5400.0));
        assert_eq!(rec.gap_count(), 0);
        assert_eq!(
            rec.episodes()[0].end_reason,
            Some(EpisodeEndReason::FullTime)
        );
        assert!(
            rec.invariant_violations().is_empty(),
            "{:?}",
            rec.invariant_violations()
        );
    }

    #[test]
    fn half_time_closes_contest_and_terminates_restart_without_sequencing() {
        let mut rec = kicked_off();
        rec.control_released_into_flight(
            tc(2700.0),
            FlightAction::Pass,
            ControlFactBasis::EngineState,
        );
        rec.contest_started(
            tc(2701.0),
            ContestStartReason::TackleLoose,
            Some((0.4, 0.5)),
            EpisodeEndReason::ControlLost,
            ControlFactBasis::EngineState,
        );
        rec.half_time(tc(2702.0));
        assert_eq!(rec.gap_count(), 0, "争抢中哨响不是未决飞行");
        assert_eq!(
            rec.state(),
            &BehaviorControlState::DeadBall {
                reason: DeadBallReason::HalfTime,
                restart_team: TeamRef::Unknown
            }
        );
        // 争抢必须收束（不允许 Contested 永久悬空）。
        let ends = rec
            .facts()
            .iter()
            .filter(|f| f.kind == ControlFactKind::ContestEnded)
            .count();
        assert_eq!(ends, 1);
        // 半场不创建重开 sequence：只有开球那一条，且它已正常收束。
        assert_eq!(rec.restarts().len(), 1);
        assert!(
            rec.invariant_violations().is_empty(),
            "{:?}",
            rec.invariant_violations()
        );
    }

    #[test]
    fn contradictory_input_records_gap_and_does_not_guess() {
        let mut rec = BehaviorObservationRecorder::enabled();
        rec.match_started(t0(), TeamRef::Home);
        // 开球还没 taken 就建立控制 = 表外输入。
        rec.control_established(
            tc(1.0),
            TeamId::Home,
            Some(10),
            None,
            EpisodeStartReason::Kickoff,
            None,
            ControlFactBasis::EngineState,
        );
        assert_eq!(rec.gap_count(), 1);
        let gap = rec
            .facts()
            .iter()
            .find(|f| f.kind == ControlFactKind::ObservationGap)
            .unwrap();
        assert_eq!(gap.team, None, "gap 不得回填球队");
        assert_eq!(gap.player, None, "gap 不得回填球员");
        assert!(gap.detail.is_some(), "gap 必须带 provenance");
        // 持球状态下的跨队控制建立 = 表外输入。
        let mut rec = kicked_off();
        rec.control_established(
            tc(3.0),
            TeamId::Away,
            Some(11),
            None,
            EpisodeStartReason::ControlChange,
            None,
            ControlFactBasis::EngineState,
        );
        assert_eq!(rec.gap_count(), 1);
        assert_eq!(
            rec.episodes()[0].end_reason,
            Some(EpisodeEndReason::ObservationGap)
        );
        assert_eq!(
            *rec.state(),
            BehaviorControlState::Controlled {
                team: TeamId::Home,
                carrier: Some(10)
            }
        );
        assert!(
            rec.invariant_violations().is_empty(),
            "{:?}",
            rec.invariant_violations()
        );
    }

    #[test]
    fn note_gap_before_match_started_is_not_a_violation() {
        // `note_gap` 的契约就是「只记事实、不改状态」，可在 `match_started` 之前合法调用；
        // 不得因此把 `Uninitialized` 报成违规（那会让「无违规」这条门在合法用法上失效）。
        let mut rec = BehaviorObservationRecorder::enabled();
        rec.note_gap(
            t0(),
            ObservationGapReason::MissingStreamEndBoundary,
            ControlFactBasis::EngineState,
        );
        assert!(
            rec.invariant_violations().is_empty(),
            "kickoff 前的合法 note_gap 不得误报；实际 = {:?}",
            rec.invariant_violations()
        );
        // 但「Uninitialized 却已有非 gap 事实」仍是违规（用损坏状态反证该子句没被废掉）。
        let mut rec = BehaviorObservationRecorder::enabled();
        rec.push(
            ControlFactKind::MatchEnded,
            t0(),
            None,
            None,
            None,
            ControlFactBasis::StreamBoundary,
            None,
        );
        let v = rec.invariant_violations();
        assert!(
            v.iter().any(|m| m.contains("但有非 gap 事实")),
            "Uninitialized + 非 gap 事实必须被判违规；实际 = {:?}",
            v
        );
    }

    #[test]
    fn note_gap_records_fact_without_touching_objects() {
        let mut rec = kicked_off();
        rec.note_gap(
            tc(5.0),
            ObservationGapReason::IllegalInput(IllegalInput::RestartTakenOutsideRestartPreparation),
            ControlFactBasis::RestartRule,
        );
        assert_eq!(rec.gap_count(), 1);
        assert_eq!(rec.episodes()[0].end_t, None, "note_gap 不得关闭 episode");
        assert_eq!(
            rec.restarts()[0].end_reason,
            Some(RestartEndReason::OpenPlayResumed)
        );
        assert!(rec.invariant_violations().is_empty());
    }

    #[test]
    fn invariant_checker_rejects_corrupted_recorders() {
        // 守护的反证：故意破坏每个不变量，检查器必须报出来——否则「全绿」可能只是空转。
        let mut corrupted = kicked_off();
        corrupted.episodes[0].end_t = Some(tc(0.1)); // end_t 早于 start_t
        corrupted.episodes[0].end_reason = None; // end_t 与 end_reason 不同现
        corrupted.episodes[0].control_fact_indexes = vec![99]; // 越界 fact 引用
        corrupted.episodes[0].id = 7;
        corrupted.restarts[0].open_play_resumed_t = Some(tc(-1.0));
        corrupted.restarts[0].end_reason = Some(RestartEndReason::MatchEnd);
        // NaN + **已知 basis** = 算错。注意不能用 `TimeBasis::Unknown`：那时 NaN 是 design §8
        // 明示的合法「时间不可得」（该豁免由下面 `unknown_basis_allows_non_finite_fact_time` 守护）。
        corrupted.facts[0].t = ObservedTime::new(f64::NAN, TimeBasis::StateCommit);
        corrupted.facts.push(ControlFact {
            t: tc(0.0),
            kind: ControlFactKind::ContestEnded,
            team: None,
            player: None,
            location: None,
            source_event_index: None,
            basis: ControlFactBasis::EngineState,
            detail: None,
        });
        corrupted.contest_open = true; // 与事实层的成对性不一致
        let v = corrupted.invariant_violations();
        assert!(!v.is_empty(), "检查器必须对损坏的 recorder 报违规");
        for needle in [
            "end_t < start_t",
            "end_t 与 end_reason 不同现",
            "引用越界 fact",
            "id = 7 与下标不符",
            "open_play_resumed_t < taken_t",
            "非有限值",
            "contest_ended 无对应 contest_started",
            "contest_open 与事实层的成对性不一致",
        ] {
            assert!(
                v.iter().any(|msg| msg.contains(needle)),
                "缺少违规项 {:?}；实际 = {:?}",
                needle,
                v
            );
        }
    }

    #[test]
    fn invariant_checker_rejects_non_finite_restart_times() {
        // 时间有限性必须**覆盖观察对象**，而不只是 facts（否则 NaN 会从 restart 字段溜过去）。
        // basis 用 `EventEmit` 而不是 `Unknown`：后者是 design §8 明示的合法「时间不可得」
        // （见 `unknown_basis_allows_non_finite_fact_time`），会把这批断言整体豁免掉。
        let mut rec = BehaviorObservationRecorder::enabled();
        rec.match_started(
            ObservedTime::new(f64::NAN, TimeBasis::EventEmit),
            TeamRef::Home,
        );
        rec.restart_taken(
            ObservedTime::new(f64::INFINITY, TimeBasis::EventEmit),
            ControlFactBasis::RestartRule,
        );
        let v = rec.invariant_violations();
        for needle in [
            "start_t 非有限值",
            "taken_t 非有限值",
            "fact[0] 的 t 非有限值",
        ] {
            assert!(
                v.iter().any(|m| m.contains(needle)),
                "缺少 {:?}；实际 = {:?}",
                needle,
                v
            );
        }
    }

    #[test]
    fn invariant_checker_rejects_open_objects_after_match_ended() {
        // 「流结束后所有观察对象必须关闭」这条不变量要能被证明有区分度：
        // 公开 API 不会违反它（`full_time` 先关后推），故直接构造违规状态验证检查器会红。
        let mut rec = BehaviorObservationRecorder::enabled();
        rec.match_started(t0(), TeamRef::Home); // 留下一个 open restart、无 episode
        rec.push(
            ControlFactKind::MatchEnded,
            tc(1.0),
            None,
            None,
            None,
            ControlFactBasis::StreamBoundary,
            None,
        );
        let v = rec.invariant_violations();
        assert!(
            v.iter()
                .any(|m| m.contains("match_ended 后仍有开放 restart")),
            "必须检出流结束后的开放 restart；实际 = {:?}",
            v
        );
    }

    #[test]
    fn unknown_restart_kind_and_team_are_refinable_not_rejected() {
        // spec「未知重开归属」：不足的证据保留 unknown 并**继续等待可确认的状态提交**，
        // 后续更明确的证据应细化而非被判矛盾。
        let mut rec = kicked_off();
        rec.dead_ball_started(
            tc(10.0),
            DeadBallReason::OutGoalLine,
            Some((TeamRef::Unknown, RestartKind::Unknown)),
            EpisodeEndReason::Out,
            ControlFactBasis::FinalizedOutcome,
        );
        let i = rec.restarts().len() - 1;
        rec.restart_preparation_started(
            tc(11.0),
            TeamRef::Home,
            RestartKind::Corner,
            ControlFactBasis::RestartRule,
        );
        assert_eq!(rec.gap_count(), 0, "unknown 被细化不得记 gap");
        assert_eq!(rec.restarts()[i].team, TeamRef::Home);
        assert_eq!(rec.restarts()[i].kind, RestartKind::Corner);
        // 两边都已确定却互不相同 → 这才是矛盾。
        rec.restart_preparation_started(
            tc(11.5),
            TeamRef::Home,
            RestartKind::GoalKick,
            ControlFactBasis::RestartRule,
        );
        assert_eq!(rec.gap_count(), 1, "已确定的 kind 冲突必须记 gap");
        assert_eq!(
            *rec.state(),
            BehaviorControlState::RestartPreparation {
                team: TeamRef::Home,
                kind: RestartKind::Corner
            }
        );
        assert!(
            rec.invariant_violations().is_empty(),
            "{:?}",
            rec.invariant_violations()
        );
    }

    #[test]
    fn superseding_an_unfinished_restart_is_normal_and_records_no_gap() {
        // design §5 第二张表把「新死球终止旧 sequence」列为**正常**转场。Slice 1 因闭集缺
        // 「被顶掉」成员只能用 `Unknown`；Slice 2 按 §15 A9-2 补了 `SupersededByDeadBall`，
        // 使 `Unknown` 恢复原义（仅表示证据不足），且该路径**不**记 gap。
        let mut rec = kicked_off();
        rec.dead_ball_started(
            tc(10.0),
            DeadBallReason::OutSideline,
            Some((TeamRef::Away, RestartKind::ThrowIn)),
            EpisodeEndReason::Out,
            ControlFactBasis::FinalizedOutcome,
        );
        rec.restart_preparation_started(
            tc(11.0),
            TeamRef::Away,
            RestartKind::ThrowIn,
            ControlFactBasis::RestartRule,
        );
        // 界外球还没发出，又出现新死球（犯规）。此时无开放 episode，`episode_end` 不被消费，
        // 但仍按死球来源填（`episode_end` 由死球来源决定，不由「恰好有 episode」决定）。
        rec.dead_ball_started(
            tc(12.0),
            DeadBallReason::Foul,
            Some((TeamRef::Home, RestartKind::FreeKick)),
            EpisodeEndReason::Foul,
            ControlFactBasis::EngineState,
        );
        let superseded = &rec.restarts()[1];
        assert_eq!(superseded.kind, RestartKind::ThrowIn);
        assert_eq!(superseded.taken_t, None);
        assert_eq!(
            superseded.end_reason,
            Some(RestartEndReason::SupersededByDeadBall),
            "被新死球顶掉的 sequence 必须有具名结束原因（不再退化成 Unknown）"
        );
        assert_eq!(rec.gap_count(), 0, "被顶掉的重开是正常转场，不得记 gap");
        // `Unknown` 现在只留给真正的「证据不足」——被顶掉的路径不得再产出它，
        // 否则「end_reason == Unknown」这条诊断线索会重新变成两类混一起。
        assert!(
            !rec.restarts()
                .iter()
                .any(|r| r.end_reason == Some(RestartEndReason::Unknown)),
            "正常转场不得以 Unknown 结束重开：{:?}",
            rec.restarts()
                .iter()
                .map(|r| r.end_reason)
                .collect::<Vec<_>>()
        );
        assert!(
            rec.invariant_violations().is_empty(),
            "{:?}",
            rec.invariant_violations()
        );
    }

    #[test]
    fn goal_kick_has_no_preparation_phase_and_binds_taken_at_delivery() {
        // §15 A9-3：门球路径在引擎里**没有**准备期（`start_goal_kick` 同步发高亮，不设
        // `restart_prep`）。事实层的如实表达 = `dead_ball_started` + `restart_taken`
        // **同刻**，**没有** `restart_preparation_started`。
        //
        // 反证：若接线层误用统一生命周期（补记 prep），本测试第一条断言就红；
        // 若只记 `dead_ball_started` 而不记 taken，则交付后的首次控制会被不变量 5 拦下。
        let mut rec = kicked_off();
        rec.goal_kick_started(
            tc(100.0),
            DeadBallReason::OutGoalLine,
            (TeamRef::Away, RestartKind::GoalKick),
            EpisodeEndReason::Out,
            ControlFactBasis::FinalizedOutcome,
        );
        let kinds: Vec<&str> = rec.facts().iter().map(|f| f.kind.as_str()).collect();
        assert_eq!(
            kinds[kinds.len() - 2..],
            ["dead_ball_started", "restart_taken"]
        );
        // 只在**门球这一段**里查准备期：`kicked_off()` 的开球本身有
        // `restart_preparation_started`（开球专线 1），扫全表会把它误当成门球的准备期。
        let gk_segment = kinds[kinds.len() - 2..].to_vec();
        assert!(
            !gk_segment.contains(&"restart_preparation_started"),
            "门球路径不得记准备期（引擎里没有这一刻）；实际分段 = {:?}",
            gk_segment
        );
        assert_eq!(
            *rec.state(),
            BehaviorControlState::BallInFlight {
                originating_team: TeamRef::Away,
                action: FlightAction::GoalKick,
            }
        );
        let gk = &rec.restarts()[1];
        assert_eq!(gk.kind, RestartKind::GoalKick);
        assert_eq!(gk.taken_t, Some(tc(100.0)));
        assert_eq!(gk.end_reason, None, "交付后仍在飞行，sequence 未收束");
        // 门球交付后首次明确控制 → open_play_resumed 收束（不变量 5 要求的 taken_t 已落上）。
        rec.control_established(
            tc(104.0),
            TeamId::Away,
            Some(15),
            Some((0.4, 0.5)),
            EpisodeStartReason::RestartControl,
            None,
            ControlFactBasis::EngineState,
        );
        assert_eq!(
            rec.restarts()[1].end_reason,
            Some(RestartEndReason::OpenPlayResumed)
        );
        assert_eq!(rec.restarts()[1].open_play_resumed_t, Some(tc(104.0)));
        assert!(
            rec.invariant_violations().is_empty(),
            "{:?}",
            rec.invariant_violations()
        );
    }

    #[test]
    fn kickoff_flight_action_is_named_not_unknown() {
        // §15 A9-1：开球拨球是**确定**的出球方式，不得退化成 Unknown。
        let mut rec = BehaviorObservationRecorder::enabled();
        rec.match_started(t0(), TeamRef::Home);
        rec.restart_taken(tc(0.0), ControlFactBasis::RestartRule);
        assert_eq!(
            *rec.state(),
            BehaviorControlState::BallInFlight {
                originating_team: TeamRef::Home,
                action: FlightAction::Kickoff,
            },
            "开球 taken 后的飞行动作必须是具名的 kickoff"
        );
        // 反证另一侧：真正的证据不足（未知重开方式）仍必须落到 Unknown。
        let mut rec = BehaviorObservationRecorder::enabled();
        rec.match_started(t0(), TeamRef::Home);
        rec.dead_ball_started(
            tc(5.0),
            DeadBallReason::OutSideline,
            Some((TeamRef::Unknown, RestartKind::Unknown)),
            EpisodeEndReason::Out,
            ControlFactBasis::FinalizedOutcome,
        );
        rec.restart_preparation_started(
            tc(6.0),
            TeamRef::Unknown,
            RestartKind::Unknown,
            ControlFactBasis::RestartRule,
        );
        rec.restart_taken(tc(7.0), ControlFactBasis::RestartRule);
        assert_eq!(
            *rec.state(),
            BehaviorControlState::BallInFlight {
                originating_team: TeamRef::Unknown,
                action: FlightAction::Unknown,
            },
            "未知重开方式仍必须表达为 Unknown（不得被具名成员掩盖）"
        );
    }

    #[test]
    fn unknown_kind_never_downgrades_known_restart_kind() {
        // 反证 N1：带 `Unknown` 参数调用不得把**已知**的 kind/team 降级——state 必须取自
        // 细化后的权威记录，否则后续 `restart_taken` 会把已知重开方式变成 `Unknown`。
        let mut rec = kicked_off();
        rec.dead_ball_started(
            tc(10.0),
            DeadBallReason::OutSideline,
            Some((TeamRef::Away, RestartKind::ThrowIn)),
            EpisodeEndReason::Out,
            ControlFactBasis::FinalizedOutcome,
        );
        rec.restart_preparation_started(
            tc(11.0),
            TeamRef::Unknown,
            RestartKind::Unknown,
            ControlFactBasis::RestartRule,
        );
        assert_eq!(
            *rec.state(),
            BehaviorControlState::RestartPreparation {
                team: TeamRef::Away,
                kind: RestartKind::ThrowIn
            },
            "已知 kind/team 不得被 Unknown 参数降级"
        );
        assert_eq!(rec.gap_count(), 0, "细化（而非矛盾）不得记 gap");
        rec.restart_taken(tc(12.0), ControlFactBasis::RestartRule);
        assert_eq!(
            *rec.state(),
            BehaviorControlState::BallInFlight {
                originating_team: TeamRef::Away,
                action: FlightAction::ThrowIn
            },
            "taken 后飞行动作必须是已知的 throw_in，而不是 Unknown"
        );
        assert!(
            rec.invariant_violations().is_empty(),
            "{:?}",
            rec.invariant_violations()
        );
    }

    #[test]
    fn rejected_input_leaves_no_false_positive_violation() {
        // design §5 补充规则要求矛盾输入「记 gap、**不自行推进状态**」，因此 `reject` 之后
        // `state` 与观察对象按设计不一致。检查器必须识别这是正确行为，否则 Slice 2 接上真实
        // gap 路径后，「无违规」就不再可用作干净路径的门。
        // 三条不同状态下的 reject 路径逐一验证（Round 3 审阅实测的三例）。
        // (a) BallInFlight 时 restart_taken → 非法。
        let mut rec = kicked_off();
        rec.control_released_into_flight(
            tc(1.0),
            FlightAction::Pass,
            ControlFactBasis::EngineState,
        );
        rec.restart_taken(tc(2.0), ControlFactBasis::RestartRule);
        assert_eq!(rec.gap_count(), 1);
        assert!(
            rec.invariant_violations().is_empty(),
            "BallInFlight 下的 gap 路径不得误报；实际 = {:?}",
            rec.invariant_violations()
        );

        // (b) Contested 时重复 contest_started → 非法。
        let mut rec = BehaviorObservationRecorder::enabled();
        rec.match_started(t0(), TeamRef::Home);
        rec.restart_taken(tc(0.1), ControlFactBasis::RestartRule);
        rec.control_established(
            tc(1.0),
            TeamId::Home,
            Some(10),
            None,
            EpisodeStartReason::Kickoff,
            None,
            ControlFactBasis::EngineState,
        );
        rec.control_released_into_flight(
            tc(2.0),
            FlightAction::Pass,
            ControlFactBasis::EngineState,
        );
        rec.contest_started(
            tc(3.0),
            ContestStartReason::PassLost,
            None,
            EpisodeEndReason::ControlLost,
            ControlFactBasis::FinalizedOutcome,
        );
        rec.contest_started(
            tc(4.0),
            ContestStartReason::PassLost,
            None,
            EpisodeEndReason::ControlLost,
            ControlFactBasis::FinalizedOutcome,
        );
        assert_eq!(rec.gap_count(), 1, "重复争抢必须记 gap");
        assert!(
            rec.invariant_violations().is_empty(),
            "Contested 下的 gap 路径不得误报；实际 = {:?}",
            rec.invariant_violations()
        );

        // (c) Uninitialized 时 dead_ball_started → 非法。
        let mut rec = BehaviorObservationRecorder::enabled();
        rec.dead_ball_started(
            tc(1.0),
            DeadBallReason::Goal,
            None,
            EpisodeEndReason::Goal,
            ControlFactBasis::EngineState,
        );
        assert_eq!(rec.gap_count(), 1);
        assert!(
            rec.invariant_violations().is_empty(),
            "Uninitialized 下的 gap 路径不得误报；实际 = {:?}",
            rec.invariant_violations()
        );

        // 合法路径重新推进状态后，陈旧标记必须被清掉，交叉校验恢复生效。
        let mut rec = kicked_off();
        rec.restart_taken(tc(9.0), ControlFactBasis::RestartRule); // 非法：已在 Controlled
        assert_eq!(rec.gap_count(), 1);
        rec.full_time(tc(10.0));
        assert!(
            rec.invariant_violations().is_empty(),
            "{:?}",
            rec.invariant_violations()
        );

        // 反向：陈旧标记不能凭空出现（没有 gap 事实却自称陈旧）。
        let mut rec = kicked_off();
        rec.stale_state_snapshot = Some(rec.state);
        let v = rec.invariant_violations();
        assert!(
            v.iter().any(|m| m.contains("没有任何 observation_gap")),
            "必须检出无 gap 事实的虚假陈旧标记；实际 = {:?}",
            v
        );
    }

    #[test]
    fn gap_does_not_mask_a_later_state_downgrade() {
        // 反证：陈旧豁免不得成为「永久免检」。两种逃逸都要堵住：
        // (a) 缺陷出现在 gap **之前** → 由 `reject` 的 pre-gap 交叉校验在 gap 时刻抓到；
        // (b) 缺陷出现在 gap **之后** → 下一次成功转场经 `set_state` 清标记，实时校验恢复。
        // (c) 若某命令绕过 `set_state` 直接写 `self.state`，标记永不清理 → 本测试变红。
        //
        // (a) gap 之前就有降级：判 gap 时即须上报。
        let mut rec = BehaviorObservationRecorder::enabled();
        rec.match_started(t0(), TeamRef::Home);
        rec.dead_ball_started(
            tc(10.0),
            DeadBallReason::OutSideline,
            Some((TeamRef::Away, RestartKind::ThrowIn)),
            EpisodeEndReason::Out,
            ControlFactBasis::FinalizedOutcome,
        );
        rec.restart_preparation_started(
            tc(11.0),
            TeamRef::Away,
            RestartKind::ThrowIn,
            ControlFactBasis::RestartRule,
        );
        rec.state = BehaviorControlState::RestartPreparation {
            team: TeamRef::Away,
            kind: RestartKind::Unknown,
        }; // 注入降级
        rec.control_established(
            tc(12.0),
            TeamId::Home,
            Some(10),
            None,
            EpisodeStartReason::Kickoff,
            None,
            ControlFactBasis::EngineState,
        ); // 触发 reject
        assert_eq!(rec.gap_count(), 1);
        let v = rec.invariant_violations();
        assert!(
            v.iter().any(|m| m.contains("已知事实被降级")),
            "gap 之前注入的降级必须被 reject 的 pre-gap 校验抓到；实际 = {:?}",
            v
        );

        // (b) 快照生命周期：reject 置快照 → 成功转场清除。若 `set_state` 忘了清快照，
        //     下面第 3 个断言变红（这正是 Round 4 审稿变异的存活点）。
        let mut rec = kicked_off();
        assert!(rec.stale_state_snapshot.is_none());
        rec.restart_taken(tc(9.0), ControlFactBasis::RestartRule); // 非法 → reject
        assert_eq!(rec.gap_count(), 1);
        assert!(
            rec.stale_state_snapshot.is_some(),
            "reject 必须留下 state 快照"
        );
        assert!(
            rec.invariant_violations().is_empty(),
            "reject 当下不应误报；实际 = {:?}",
            rec.invariant_violations()
        );
        rec.control_released_into_flight(
            tc(10.0),
            FlightAction::Pass,
            ControlFactBasis::EngineState,
        ); // 成功转场
        assert!(
            rec.stale_state_snapshot.is_none(),
            "成功转场必须清掉 state 快照"
        );

        // (c) gap 之后实时校验必须恢复：注入降级 → 必须被上报。
        rec.state = BehaviorControlState::RestartPreparation {
            team: TeamRef::Home,
            kind: RestartKind::ThrowIn,
        };
        let v = rec.invariant_violations();
        assert!(
            v.iter().any(|m| m.contains("但没有开放 restart")),
            "gap 之后的降级必须被实时校验抓到（标记已清）；实际 = {:?}",
            v
        );

        // (d) 飞行来源与开放 episode 矛盾 → 实时校验必须抓到（且无 gap 时也不该漏）。
        // 断言串取该检查**独有**的前缀：用笼统的「不一致」会命中别的检查的措辞而空转（实测变异存活）。
        let mut rec = kicked_off();
        rec.control_released_into_flight(
            tc(1.0),
            FlightAction::Pass,
            ControlFactBasis::EngineState,
        );
        rec.state = BehaviorControlState::BallInFlight {
            originating_team: TeamRef::Away,
            action: FlightAction::Pass,
        };
        let v = rec.invariant_violations();
        assert!(
            v.iter().any(|m| m.contains("state BallInFlight 来源")),
            "飞行来源与开放 episode 矛盾必须被抓到；实际 = {:?}",
            v
        );
    }

    #[test]
    fn consecutive_rejects_do_not_accumulate_false_violations() {
        // 连续矛盾输入（reject 链）：第二个 reject 面对的 `Contested` 已被第一个 reject 关掉
        // contest，此时若照常交叉校验就会把「上一个 gap 的必然结果」报成违规，且
        // `deferred_violations` 只增不减 → 「无违规」这条门在真实 gap 路径上永久失效。
        let mut rec = BehaviorObservationRecorder::enabled();
        rec.match_started(t0(), TeamRef::Home);
        rec.restart_taken(tc(0.1), ControlFactBasis::RestartRule);
        rec.control_established(
            tc(1.0),
            TeamId::Home,
            Some(10),
            None,
            EpisodeStartReason::Kickoff,
            None,
            ControlFactBasis::EngineState,
        );
        rec.control_released_into_flight(
            tc(2.0),
            FlightAction::Pass,
            ControlFactBasis::EngineState,
        );
        rec.contest_started(
            tc(3.0),
            ContestStartReason::PassLost,
            None,
            EpisodeEndReason::ControlLost,
            ControlFactBasis::FinalizedOutcome,
        );
        // Contested 状态下出球两次 → 两次 reject。
        rec.control_released_into_flight(
            tc(4.0),
            FlightAction::Pass,
            ControlFactBasis::EngineState,
        );
        rec.control_released_into_flight(
            tc(5.0),
            FlightAction::Pass,
            ControlFactBasis::EngineState,
        );
        assert_eq!(rec.gap_count(), 2, "两次矛盾输入记两条 gap");
        assert!(
            rec.invariant_violations().is_empty(),
            "reject 链不得累积假违规；实际 = {:?}",
            rec.invariant_violations()
        );
        // 随后的**合法** pickup 也不得让假违规冒出来。
        rec.control_established(
            tc(6.0),
            TeamId::Away,
            Some(11),
            None,
            EpisodeStartReason::Pickup,
            None,
            ControlFactBasis::EngineState,
        );
        assert!(
            rec.invariant_violations().is_empty(),
            "合法 pickup 之后仍不得有假违规；实际 = {:?}",
            rec.invariant_violations()
        );
    }

    #[test]
    fn deferred_violations_are_never_cleared() {
        // `deferred_violations` 只增不减：一旦允许清除，「先注入降级、再走一次成功转场」
        // 就能把已发现的违规洗掉（Round 4 的变异 G 正是这个洞）。
        let mut rec = BehaviorObservationRecorder::enabled();
        rec.match_started(t0(), TeamRef::Home);
        rec.dead_ball_started(
            tc(10.0),
            DeadBallReason::OutSideline,
            Some((TeamRef::Away, RestartKind::ThrowIn)),
            EpisodeEndReason::Out,
            ControlFactBasis::FinalizedOutcome,
        );
        rec.restart_preparation_started(
            tc(11.0),
            TeamRef::Away,
            RestartKind::ThrowIn,
            ControlFactBasis::RestartRule,
        );
        rec.state = BehaviorControlState::RestartPreparation {
            team: TeamRef::Away,
            kind: RestartKind::Unknown,
        };
        // `RestartPreparation` 下建立控制是非法输入 → reject 会在收束前抓到注入的降级。
        rec.control_established(
            tc(12.0),
            TeamId::Home,
            Some(10),
            None,
            EpisodeStartReason::Kickoff,
            None,
            ControlFactBasis::EngineState,
        );
        let before = rec.invariant_violations();
        assert!(
            before.iter().any(|m| m.contains("已知事实被降级")),
            "{:?}",
            before
        );
        // 走**成功**转场（`restart_taken` 在 `RestartPreparation` 下合法 → 经 `set_state`），
        // deferred 违规必须仍在。若 `set_state` 顺手清了它，本断言变红（变异 G）。
        rec.restart_taken(tc(13.0), ControlFactBasis::RestartRule);
        let after = rec.invariant_violations();
        assert!(
            after.iter().any(|m| m.contains("已知事实被降级")),
            "成功转场不得洗掉已发现的违规；实际 = {:?}",
            after
        );
    }

    #[test]
    fn invariant_checker_catches_state_downgraded_below_records() {
        // 不变量 9 的反证：直接构造「state 比记录更差」的状态，检查器必须报出。
        let mut rec = BehaviorObservationRecorder::enabled();
        rec.match_started(t0(), TeamRef::Home);
        rec.dead_ball_started(
            tc(10.0),
            DeadBallReason::OutSideline,
            Some((TeamRef::Away, RestartKind::ThrowIn)),
            EpisodeEndReason::Out,
            ControlFactBasis::FinalizedOutcome,
        );
        rec.state = BehaviorControlState::RestartPreparation {
            team: TeamRef::Away,
            kind: RestartKind::Unknown,
        };
        let v = rec.invariant_violations();
        assert!(
            v.iter().any(|m| m.contains("已知事实被降级")),
            "必须检出 state kind 低于记录；实际 = {:?}",
            v
        );
        // 同时构造「state = Contested 但争抢已收束」。
        let mut rec = BehaviorObservationRecorder::enabled();
        rec.match_started(t0(), TeamRef::Home);
        rec.state = BehaviorControlState::Contested {
            previous_team: None,
            location: None,
        };
        let v = rec.invariant_violations();
        assert!(
            v.iter().any(|m| m.contains("争抢已收束")),
            "必须检出悬空 Contested；实际 = {:?}",
            v
        );
    }

    #[test]
    fn invariant_checker_catches_each_state_record_mismatch() {
        // `state_record_violations` 的各子句经公开 API 不可达（纯防御），故直接注入 `state`
        // 逐一反证——否则将来重构删掉某个比较，没有任何测试会红。
        //
        // 基座一：开球已 taken、home 已建立控制 → 有开放 episode(Home)、无开放 restart。
        // 基座二：在其上再加一个死球（Away / ThrowIn）→ 有开放 restart(Away/ThrowIn)、无开放 episode。
        let open_restart_base = || {
            let mut rec = kicked_off();
            rec.dead_ball_started(
                tc(10.0),
                DeadBallReason::OutSideline,
                Some((TeamRef::Away, RestartKind::ThrowIn)),
                EpisodeEndReason::Out,
                ControlFactBasis::FinalizedOutcome,
            );
            rec
        };
        type Case = (
            &'static str,
            Box<dyn Fn() -> BehaviorObservationRecorder>,
            BehaviorControlState,
        );
        let cases: Vec<Case> = vec![
            (
                "state Controlled team",
                Box::new(kicked_off),
                BehaviorControlState::Controlled {
                    team: TeamId::Away,
                    carrier: Some(11),
                },
            ),
            (
                "state DeadBall restart_team",
                Box::new(open_restart_base),
                BehaviorControlState::DeadBall {
                    reason: DeadBallReason::Goal,
                    restart_team: TeamRef::Home,
                },
            ),
            (
                "state RestartPreparation team",
                Box::new(open_restart_base),
                BehaviorControlState::RestartPreparation {
                    team: TeamRef::Home,
                    kind: RestartKind::ThrowIn,
                },
            ),
            (
                "RestartPreparation 但没有开放 restart",
                Box::new(kicked_off),
                BehaviorControlState::RestartPreparation {
                    team: TeamRef::Away,
                    kind: RestartKind::ThrowIn,
                },
            ),
        ];
        for (needle, make, injected) in cases {
            let mut rec = make();
            rec.state = injected;
            rec.stale_state_snapshot = None;
            let v = rec.invariant_violations();
            assert!(
                v.iter().any(|m| m.contains(needle)),
                "缺少 {:?}；注入 = {:?}，实际 = {:?}",
                needle,
                rec.state(),
                v
            );
        }
    }

    #[test]
    fn invariant_checker_catches_overlapping_open_objects() {
        // 开放 episode 与开放 restart 重叠：design §10 明令禁止。
        let mut rec = kicked_off();
        rec.control_released_into_flight(
            tc(1.0),
            FlightAction::Pass,
            ControlFactBasis::EngineState,
        );
        rec.control_established(
            tc(2.0),
            TeamId::Away,
            Some(11),
            None,
            EpisodeStartReason::ControlChange,
            Some(EpisodeEndReason::ControlLost),
            ControlFactBasis::FinalizedOutcome,
        );
        assert!(rec.open_episode.is_some());
        rec.open_new_restart(TeamRef::Away, RestartKind::ThrowIn, tc(3.0));
        let v = rec.invariant_violations();
        assert!(
            v.iter().any(|m| m.contains("重叠")),
            "必须检出开放 episode 与开放 restart 重叠；实际 = {:?}",
            v
        );
    }

    // ---- 与正式路径的一致性门（design §13） ----

    #[test]
    fn observation_api_leaves_formal_events_byte_identical() {
        for seed in [1u64, 42, 544] {
            for dur in [120.0, 5400.0] {
                let cfg = MatchConfig {
                    match_duration_seconds: dur,
                    ..MatchConfig::default_()
                };
                let plain = simulate(seed, cfg);
                let observed = simulate_with_behavior_observations(seed, cfg);
                assert_eq!(
                    observed.events_json(),
                    plain,
                    "seed {} dur {}：带观察的模拟必须与 simulate() 逐字节相同",
                    seed,
                    dur
                );
            }
        }
    }

    #[test]
    fn recorder_on_off_consumes_identical_rng() {
        // design §13「recorder on/off 的正式 events 完全一致」的**更强**版本。
        //
        // 上面那条比的是 JSON 字符串，理论上可以被「两边都错成一样」骗过。这里改比 RNG 的
        // **原始输出**：把同一 seed 前 N 个数抽出来，分别在「跑过一场带观察的比赛」与
        // 「跑过一场 simulate()」之后抽一次——recorder 若在任一路径上多/少消费了 RNG
        // （或改了消费顺序），后续序列必然分叉。
        //
        // 判别力来源：事件流是**下游产物**（路由变化会同时改事件与 RNG），而 RNG 序列只反映
        // 消费点，是「决策与 RNG 都没被观察层影响」的直接证据。
        fn draw(seed: u64, skip: usize) -> Vec<u64> {
            let mut r = crate::rng::SeededRng::new(seed);
            for _ in 0..skip {
                r.next_u64();
            }
            (0..16).map(|_| r.next_u64()).collect()
        }
        for seed in [1u64, 42, 97] {
            let cfg = MatchConfig {
                match_duration_seconds: 600.0,
                ..MatchConfig::default_()
            };
            let _ = simulate(seed, cfg);
            let after_plain = draw(seed, 0);
            let _ = simulate_with_behavior_observations(seed, cfg);
            let after_observed = draw(seed, 0);
            assert_eq!(
                after_plain, after_observed,
                "seed {}：抽取序列必须与观察开关无关",
                seed
            );
            // 反证（防空转）：`skip` 必须真的生效，否则两边的 `draw` 都返回同一串常量。
            assert_ne!(
                draw(seed, 0),
                draw(seed, 1),
                "反证失败：skip 参数没有生效，上面的断言是空转"
            );
        }
    }

    #[test]
    fn observation_sidecar_is_deterministic_and_has_no_gaps_on_a_full_match() {
        let cfg = MatchConfig::default_();
        let a = simulate_with_behavior_observations(97, cfg);
        let b = simulate_with_behavior_observations(97, cfg);
        assert_eq!(
            a.control_facts, b.control_facts,
            "同 seed 的 sidecar 事实必须完全确定"
        );
        assert_eq!(a.possession_episodes, b.possession_episodes);
        assert_eq!(a.restart_sequences, b.restart_sequences);
        assert_eq!(a.gap_count(), 0, "本 seed（默认时长）不该产 gap；\n                 注意：这只是**本样本内**的 0，不是「任何真实路径都无 gap」的全称命题——\n                 终场哨落在未决飞行中途时会合法产 `full_time_during_ball_in_flight`\n                 （实测 seed 470 @ dur 120、seed 1228 @ dur 400；触发与时长无关，见\n                 truncated_stream_produces_a_full_time_gap_by_design 的文档）");
        assert!(
            a.phase_segments.is_empty(),
            "#15B 之前 phase_segments 必须为空"
        );
        // sidecar 自带质量信息：报告本身可被检查（旧实现只能在 recorder 被消费前读，易漏检）。
        assert!(
            a.invariant_violations.is_empty(),
            "Slice 1 的最小事实路径必须自带空违规列表；实际 = {:?}",
            a.invariant_violations
        );
        assert!(a.is_coherent());
        assert_eq!(a.state, BehaviorControlState::Ended);
        // gap 原因聚合在 sidecar 上也可用（不是只有 recorder 才有）。
        let counts = a.gap_reason_counts();
        assert_eq!(counts.len(), ObservationGapReason::ALL.len());
        assert_eq!(counts.iter().map(|(_, n)| n).sum::<usize>(), a.gap_count());
    }

    #[test]
    fn opt_in_sidecar_carries_invariant_violations_and_terminal_state() {
        // 需求（#2）：production opt-in 返回后必须能**直接**检查不变量与终态，而不是只剩 facts。
        let dm = simulate_with_behavior_observations(11, MatchConfig::default_());
        assert_eq!(
            dm.state,
            BehaviorControlState::Ended,
            "完整比赛必须以 Ended 收束"
        );
        assert!(dm.is_coherent(), "{:?}", dm.invariant_violations);
        // 反证：`into_diagnostic_match` 若忘了在消费前求值（例如先 field-move 再调
        // `invariant_violations`，或干脆不调），下面这个损坏 recorder 就会交出空列表。
        let mut broken = kicked_off();
        broken.episodes[0].id = 9; // id 与下标不符
        let events = vec![];
        let dm = broken.into_diagnostic_match(events);
        assert!(
            dm.invariant_violations
                .iter()
                .any(|m| m.contains("id = 9 与下标不符")),
            "损坏 recorder 的违规必须在 sidecar 里可见；实际 = {:?}",
            dm.invariant_violations
        );
        assert!(!dm.is_coherent());
        // 终态是 `Controlled`，不是 `Ended`——调用方据此判断「观察没跑完」。
        assert_eq!(
            dm.state,
            BehaviorControlState::Controlled {
                team: TeamId::Home,
                carrier: Some(10)
            }
        );
    }

    /// 手工构造的正式事件流：没有 lineup / kickoff，只有若干条 whistle（按传入顺序）。
    /// `t` 与任何真实 `MatchConfig` 时长都无关——这正是判别两个时间来源的关键。
    fn stream_with_whistles_at(ts: &[f64]) -> Vec<Event> {
        ts.iter()
            .map(|t| Event {
                t: *t,
                type_: crate::EventType::Whistle,
                detail: Some("half_time".to_string()),
                score: Some("0-0".to_string()),
                ..Event::default()
            })
            .collect()
    }

    fn stream_with_whistle_at(t: f64) -> Vec<Event> {
        stream_with_whistles_at(&[t])
    }

    #[test]
    fn full_time_time_comes_from_the_formal_whistle_not_config() {
        // #8：终点时间必须与流里那条哨同源。**判别力来源**：手工构造 `whistle@123.0`，
        // 并显式取若干**不等于 123.0** 的「config 时长」做对照。旧实现
        // `recorder.full_time(config.match_duration_seconds)` 会把 5400.0 写进 `match_ended`
        // → 下面的断言当场红。
        //
        // 为什么真实比赛测不出来：本引擎恰好在 `config.match_duration_seconds` 处推尾哨，
        // 于是 `whistle.t == config` 恒成立，两个来源在真实路径上**不可区分**（旧测试的
        // `assert_eq!(whistle_t, dur)` 只是把这个巧合再钉一遍，对来源没有任何判别力）。
        for wrong_duration in [5400.0, 300.0, 0.0] {
            assert_ne!(
                wrong_duration, 123.0,
                "前提：对照组时长必须与流里的 whistle 时间不同，否则本测试失去判别力"
            );
            let mut rec = BehaviorObservationRecorder::enabled();
            rec.match_started(t0(), TeamRef::Home);
            let events = stream_with_whistle_at(123.0);
            assert!(
                commit_stream_end_boundary(&mut rec, &events),
                "流里有 whistle 时必须走 full_time 分支"
            );
            let ended = rec
                .facts()
                .iter()
                .find(|f| f.kind == ControlFactKind::MatchEnded)
                .expect("必须有 match_ended");
            // 这两条断言互为补集：既断言「等于流里的哨」，也断言「不等于另一个来源」。
            assert_eq!(
                ended.t.value, 123.0,
                "终场时间必须取自正式 whistle 事件本身"
            );
            assert_ne!(
                ended.t.value, wrong_duration,
                "终场时间不得等于 config 时长 {}（旧实现会把 duration 传进 full_time）",
                wrong_duration
            );
            assert_eq!(ended.t.basis, TimeBasis::EventEmit);
            assert!(rec.invariant_violations().is_empty());
        }

        // 「**最后一条** whistle 才是流边界」也必须被钉住：取首条（或任意中间条）同样是对
        // 「流边界」的误读——`kickoff_again` 这类转场哨会出现在流中间，而终场哨恒在末尾
        // （见模块头开球专线 3）。这里用一条转场哨 + 一条终场哨证明选的是末尾那条。
        let mut rec = BehaviorObservationRecorder::enabled();
        rec.match_started(t0(), TeamRef::Home);
        rec.dead_ball_started(
            tc(100.0),
            DeadBallReason::Goal,
            Some((TeamRef::Away, RestartKind::Kickoff)),
            EpisodeEndReason::Goal,
            ControlFactBasis::FinalizedOutcome,
        );
        let events = stream_with_whistles_at(&[150.0, 123.0]);
        assert!(commit_stream_end_boundary(&mut rec, &events));
        let ended = rec
            .facts()
            .iter()
            .find(|f| f.kind == ControlFactKind::MatchEnded)
            .expect("必须有 match_ended");
        assert_eq!(
            ended.t.value, 123.0,
            "多个 whistle 时必须取**最后一条**（首条 150.0 是转场哨，不是流边界）"
        );
        assert_ne!(ended.t.value, 150.0);

        // 流里没有 whistle 时不得硬编码时间：记 gap，且**不产 match_ended**（不假称已收束）。
        // 旧实现在这条路径上无哨也要给 `full_time(dur)` 一个具体时间——这里连终场事实都不得出现。
        let mut rec = BehaviorObservationRecorder::enabled();
        rec.match_started(t0(), TeamRef::Home);
        assert!(stream_end_boundary(&[]).is_none());
        assert!(!commit_stream_end_boundary(&mut rec, &[]));
        assert_eq!(rec.gap_count(), 1);
        assert_eq!(
            rec.facts().last().unwrap().detail,
            Some(ControlFactDetail::Gap(
                ObservationGapReason::MissingStreamEndBoundary
            ))
        );
        assert!(
            !rec.facts()
                .iter()
                .any(|f| f.kind == ControlFactKind::MatchEnded),
            "找不到哨时不得伪造终场时间（旧实现会拿 config 时长凑一个）"
        );
        assert_eq!(
            rec.terminal_state(),
            BehaviorControlState::RestartPreparation {
                team: TeamRef::Home,
                kind: RestartKind::Kickoff
            },
            "终场未确认时观察必须停在原状，而不是 Ended"
        );
    }

    #[test]
    fn stream_end_boundary_takes_the_last_whistle_and_full_time_uses_it() {
        // 集成面：真实比赛流 → 终点就是那条尾哨的 `t`。这里**不再**断言 `whistle_t == config`
        // （那只是本引擎当前的巧合，对「来源」没有判别力，且未来补时会打破它）；判别来源的
        // 工作交给上面手工流的测试。本测试只钉住「真实路径确实接到了流末边界」。
        for dur in [300.0, 5400.0, 9000.0] {
            let cfg = MatchConfig {
                match_duration_seconds: dur,
                ..MatchConfig::default_()
            };
            let dm = simulate_with_behavior_observations(5, cfg);
            let whistle_t = stream_end_boundary(&dm.events)
                .expect("流末必有 whistle")
                .value;
            let ended = dm
                .control_facts
                .iter()
                .find(|f| f.kind == ControlFactKind::MatchEnded)
                .expect("必须有 match_ended");
            assert_eq!(
                ended.t.value, whistle_t,
                "dur {}：match_ended 的时间必须取自正式 whistle 事件",
                dur
            );
            assert_eq!(ended.t.basis, TimeBasis::EventEmit);
            assert_eq!(dm.gap_count(), 0, "真实路径不该把有哨的流报成缺边界");
            assert!(dm.is_coherent(), "{:?}", dm.invariant_violations);
        }
    }

    #[test]
    fn match_started_time_basis_is_event_emit_at_zero() {
        // #9（Slice 1 就地说明）：`match_started` 的当前 basis = `event_emit(0.0)`——开赛事实没有
        // 对应的引擎状态提交事件（引擎在 `match_events` 起手就 push 了 kickoff 事件，t = 0.0），
        // 故取事件发射时刻。**Slice 2 若改为在 `MatchState::new` 之后按 `state_commit` 提交，
        // 必须同步改这条断言与模块头对照表的「`simulate` 起点」行**——否则两处会静默不一致。
        let dm = simulate_with_behavior_observations(4, MatchConfig::default_());
        let started = dm
            .control_facts
            .iter()
            .find(|f| f.kind == ControlFactKind::MatchStarted)
            .expect("真实路径必须有 match_started");
        assert_eq!(started.t.value, 0.0);
        assert_eq!(started.t.basis, TimeBasis::EventEmit);
        assert_eq!(started.basis, ControlFactBasis::EngineState);
        assert_eq!(started.team, Some(TeamId::Home), "引擎开球恒主队");
    }

    #[test]
    fn real_match_sidecar_has_control_facts_and_closes_all_objects() {
        // **Slice 2 的门**（旧 `slice1_lifecycle_facts_start_and_close_the_match` 只钉了
        // 三条生命周期占位事实，Slice 2 接上引擎提交点后必须改写成真实路径断言，
        // 否则它会挡住所有新事实——正是那个测试自己的注释预警的情形）。
        //
        // 本测试证明 opt-in sidecar 在真实 seed 上是**非占位**的：控制事实覆盖了传球/争抢/
        // 死球/重开，且所有 episode / restart 都被收束。
        let cfg = MatchConfig::default_();
        let dm = simulate_with_behavior_observations(1, cfg);
        let kinds: Vec<&str> = dm.control_facts.iter().map(|f| f.kind.as_str()).collect();

        // 起点仍是那三条（match_started + 开球自身 prep），终点是 match_ended。
        assert_eq!(
            &kinds[..3],
            [
                "match_started",
                "restart_preparation_started",
                "restart_taken"
            ]
        );
        assert_eq!(*kinds.last().unwrap(), "match_ended");
        assert!(
            dm.control_facts.len() > 100,
            "真实比赛应有大量事实；实际 {}",
            dm.control_facts.len()
        );

        // **非占位**：各类控制事实都出现过（每一项都由不同的引擎提交点产出）。
        for required in [
            "control_established",
            "control_released",
            "dead_ball_started",
            "restart_preparation_started",
            "restart_taken",
            "open_play_resumed",
        ] {
            assert!(
                kinds.contains(&required),
                "真实比赛路径应产出 {:?}；实际 kinds = {:?}",
                required,
                kinds
            );
        }
        // episode / restart 都是**可闭合**的：没有 end_t/end_reason 为空的残留。
        assert!(
            !dm.possession_episodes.is_empty(),
            "应有 possession episode"
        );
        assert!(!dm.restart_sequences.is_empty(), "应有 restart sequence");
        for e in &dm.possession_episodes {
            assert!(e.end_t.is_some(), "episode {} 未闭合", e.id);
            assert!(e.end_reason.is_some(), "episode {} 无结束原因", e.id);
        }
        for r in &dm.restart_sequences {
            assert!(r.end_reason.is_some(), "restart {} 未闭合", r.id);
        }
        // 开球那条 sequence 被正常交付并恢复开放比赛。
        assert_eq!(dm.restart_sequences[0].kind, RestartKind::Kickoff);
        assert_eq!(
            dm.restart_sequences[0].end_reason,
            Some(RestartEndReason::OpenPlayResumed)
        );
        assert!(dm
            .events
            .iter()
            .any(|e| e.type_ == crate::EventType::Whistle));
    }

    #[test]
    fn fixed_seed_sidecar_binds_event_indexes_and_leaves_no_gaps() {
        // 需求：固定 seed 集成测试，证明 opt-in sidecar 有非占位控制事实、episode/restart
        // 可闭合或明确记录 gap，且**事件下标真的绑上了**（不是永远空数组）。
        for seed in [1u64, 5, 97] {
            let dm = simulate_with_behavior_observations(seed, MatchConfig::default_());
            assert_eq!(dm.gap_count(), 0, "seed {}：本样本不该产 gap（0 只对本样本成立：终场哨落在未决飞行中途时会合法产 full_time_during_ball_in_flight，见 truncated_stream_produces_a_full_time_gap_by_design）", seed);
            assert!(
                dm.is_coherent(),
                "seed {}：{:?}",
                seed,
                dm.invariant_violations
            );
            assert_eq!(dm.state, BehaviorControlState::Ended, "seed {}", seed);

            // 下标必须真的入数组（Slice 1 里这两个字段恒空——那正是本测试要证伪的占位）。
            let ep_with_events = dm
                .possession_episodes
                .iter()
                .filter(|e| !e.event_indexes.is_empty())
                .count();
            assert!(
                ep_with_events > 0,
                "seed {}：没有任何 episode 绑上事件下标（占位未接线）",
                seed
            );
            let rs_with_events = dm
                .restart_sequences
                .iter()
                .filter(|r| !r.event_indexes.is_empty())
                .count();
            assert!(
                rs_with_events > 0,
                "seed {}：没有任何 restart 绑上事件下标（占位未接线）",
                seed
            );
            // 绑定的下标必须在范围内、严格递增（append-only 的产物），且不与事实冲突。
            for e in &dm.possession_episodes {
                assert!(
                    e.event_indexes.windows(2).all(|w| w[0] < w[1]),
                    "seed {}：episode {} 的事件下标非严格递增：{:?}",
                    seed,
                    e.id,
                    e.event_indexes
                );
                assert!(
                    e.event_indexes.iter().all(|i| *i < dm.events.len()),
                    "seed {}：episode {} 的事件下标越界",
                    seed,
                    e.id
                );
            }
            for r in &dm.restart_sequences {
                assert!(
                    r.event_indexes.windows(2).all(|w| w[0] < w[1]),
                    "seed {}：restart {} 的事件下标非严格递增：{:?}",
                    seed,
                    r.id,
                    r.event_indexes
                );
            }
            // 事实层的绑定：绝大多数事实应有事件来源（没有的靠 `t` + `detail` 定位，
            // 例如 prep-start 这类引擎不产事件的提交点）。
            let bound = dm
                .control_facts
                .iter()
                .filter(|f| f.source_event_index.is_some())
                .count();
            assert!(
                bound * 2 > dm.control_facts.len(),
                "seed {}：绑定事件下标的事实过少（{}/{}）",
                seed,
                bound,
                dm.control_facts.len()
            );
        }
    }

    /// **P0 的生产路径门**（多 seed、按 restart kind 断言）：重开交付后的首次控制
    /// `start_reason` 必须是 `RestartControl`，**唯一例外**是首开球（`Kickoff`）。
    ///
    /// 耦合方式：一条 restart 的 `open_play_resumed_t` 与某条 episode 的 `start_t` 相等，
    /// ⟺ 那条 episode 就是这次交付开出来的。用这个关系把 kind 与 start_reason 对上，
    /// 不依赖对象顺序。
    ///
    /// 需要的 kind 覆盖：实测 seed 1 单场就产出全部 5 种（corner / free_kick / goal_kick /
    /// kickoff / throw_in，各 ≥ 一次），且 120 seed 全覆盖；断言里用**集合包含**而不是
    /// 「恰好等于」，避免将来某 seed 少一种时变成脆弱断言。
    ///
    /// 判别力（目标变异必红）：把 `control_established` 里的归一去掉 → corner / goal_kick
    /// 两行变红（它们是 `Pickup`）；把归一写成硬编码 `Pickup` → free_kick / throw_in /
    /// kickoff-after-goal 三行变红。
    #[test]
    fn restart_delivery_start_reason_matches_the_restart_kind_on_real_matches() {
        const SEEDS: [u64; 6] = [1, 5, 33, 86, 97, 120];
        let mut seen_kinds: Vec<RestartKind> = Vec::new();
        let mut checked = 0usize;
        for seed in SEEDS {
            let dm = simulate_with_behavior_observations(seed, MatchConfig::default_());
            assert_eq!(dm.gap_count(), 0, "seed {}：本样本不该产 gap（0 只对本样本成立：终场哨落在未决飞行中途时会合法产 full_time_during_ball_in_flight，见 truncated_stream_produces_a_full_time_gap_by_design）", seed);
            assert!(dm.is_coherent(), "seed {}：{:?}", seed, dm.invariant_violations);
            for r in &dm.restart_sequences {
                seen_kinds.push(r.kind);
                let Some(resumed) = r.open_play_resumed_t else {
                    continue; // 未完成的重开（流末截断）没有交付控制可查
                };
                let ep = dm
                    .possession_episodes
                    .iter()
                    .find(|e| (e.start_t.value - resumed.value).abs() < 1e-9)
                    .unwrap_or_else(|| {
                        panic!(
                            "seed {}：restart {}（{:?}）在 t={} 标记 open_play_resumed，\
                             却找不到同一时刻开启的 episode",
                            seed,
                            r.id,
                            r.kind,
                            resumed.value
                        )
                    });
                // 首开球是唯一以 `Kickoff` 开 episode 的路径；其余重开交付一律 `RestartControl`。
                let first_kickoff = r.kind == RestartKind::Kickoff && r.start_t.value == 0.0;
                let expected = if first_kickoff {
                    EpisodeStartReason::Kickoff
                } else {
                    EpisodeStartReason::RestartControl
                };
                assert_eq!(
                    ep.start_reason, expected,
                    "seed {}：restart {}（{:?}，t={}）交付后的 episode {} start_reason = {} \
                     （期望 {}；P0 回归：角球/门球曾错标 pickup）",
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
        for kind in [
            RestartKind::Corner,
            RestartKind::GoalKick,
            RestartKind::ThrowIn,
            RestartKind::FreeKick,
            RestartKind::Kickoff,
        ] {
            assert!(
                seen_kinds.contains(&kind),
                "seed 集合没有覆盖 {:?}（本测试对它的断言变成空转）；实际 kinds = {:?}",
                kind,
                seen_kinds
                    .iter()
                    .map(|k| k.as_str())
                    .collect::<Vec<_>>()
            );
        }
        assert!(
            checked >= 100,
            "交付控制样本过少（{}），断言接近空转",
            checked
        );
    }

    /// **终场哨可能打断未决飞行 → 合法产 gap**（把「真实路径 0 gap」这条说法的**边界**钉住）。
    ///
    /// 本引擎的循环是 `while t < dur`，于是**可能**在未决飞行中途到点推终场哨——此时按
    /// design §5 第二张表与 §10，必须记 `full_time_during_ball_in_flight` gap，并把 episode
    /// 结束原因固定为 `whistle_interrupt`（**不**伪造动作结果）。
    ///
    /// 触发机制与时长**无关**：只要「某一 tick 以飞行中（`Pass` / `Shot` 等）结束、球尚未落地」
    /// 而 `t + 1 == dur`，终场哨就落在飞行中途。短时长只是让**开球飞行**更容易撞上哨（`dur 120`
    /// 时开球刚发出就被截），长时长则需要比赛尾段恰有一脚未落地的球——**罕见，但会发生**。
    ///
    /// 已复核示例（旧表述曾断言「dur ≥ 300 时 0 例」，**该全称已被证伪**，勿退回）：
    ///
    /// - `seed 470 @ dur 120`：kickoff restart 在 t=119 发出、飞行被 t=120 的终场哨截断；
    /// - `seed 1228 @ dur 400`：t=399 的 kickoff **飞行中**撞上 t=400 终场哨——**更长时长同样产 gap**。
    ///
    /// 所以「真实路径 0 gap」**只在**未被截断的干净比赛上成立，不是全称命题——
    /// `gap_count() == 0` 的几处断言各自限定了样本（本测试用 `dur 120` 只是取一个**稳定复现**的
    /// 样本，不表示更长时长不会产）。
    ///
    /// 判别力（防空转）：若把 `full_time` 里的未决飞行分支删掉，本测试第 2 条断言红。
    #[test]
    fn truncated_stream_produces_a_full_time_gap_by_design() {
        let config = MatchConfig {
            match_duration_seconds: 120.0,
            ..MatchConfig::default_()
        };
        let dm = simulate_with_behavior_observations(470, config);
        assert_eq!(
            dm.gap_count(),
            1,
            "该样本必须在终场哨上截断一条未决飞行；实际 gaps = {}",
            dm.gap_count()
        );
        assert!(
            dm.control_facts.iter().any(|f| {
                f.kind == ControlFactKind::ObservationGap
                    && f.detail
                        == Some(ControlFactDetail::Gap(
                            ObservationGapReason::FullTimeDuringBallInFlight,
                        ))
            }),
            "gap 原因必须是具名的 `full_time_during_ball_in_flight`：{:?}",
            dm.control_facts
                .iter()
                .filter(|f| f.kind == ControlFactKind::ObservationGap)
                .collect::<Vec<_>>()
        );
        // 该样本的形态是「进球 → 开球 → 开球飞行被终场哨截断」：episode 早在进球时就以
        // `goal` 收束，故**没有**开放 episode 可被 `whistle_interrupt` 关闭——这正说明
        // 「未决飞行被哨声打断」不一定伴随一条 episode 收束，判定必须看 gap 本身而不是
        // episode 的 end_reason（早先我按 `whistle_interrupt` 断言，实测红：episodes =
        // [Out, Goal]）。这里改为钉住真正该成立的形态：
        // ① 被截断的 restart 以 `match_end` 收束且**没有** `open_play_resumed_t`；
        // ② 比赛终态是 `Ended`（哨声确实把观察收束了）。
        assert_eq!(dm.state, BehaviorControlState::Ended, "终场哨后应进入 Ended");
        let truncated_restart = dm
            .restart_sequences
            .iter()
            .find(|r| r.end_reason == Some(RestartEndReason::MatchEnd))
            .expect("应有被 match_end 收束的 restart（截断的那条）");
        assert!(
            truncated_restart.open_play_resumed_t.is_none(),
            "被截断的重开不得有 open_play_resumed_t（比赛没恢复）：{:#?}",
            truncated_restart
        );
    }

    /// **P1 事实核查门**：`SupersededByDeadBall` 是 **recorder 层契约**，当前**生产引擎不可达**。
    ///
    /// 这不是「功能缺失」而是如实记录模型边界。不可达的机制（两条，都是**结构性**的）：
    ///
    /// 1. 引擎的每个死球结果都在**同一 tick 内**建立对应重开——goal 由 `advance_dead_ball`
    ///    推进到 kickoff、out 在 `finalize_highlight` 里立刻 `start_throw_in` / `start_corner`、
    ///    foul 在 `emit_foul_and_free_kick` 里立刻建 `restart_prep`、shot off target /
    ///    out goal line 由 `start_goal_kick` **同步**发球；
    /// 2. **一次 `finalize_highlight` 至多产一个死球结果**（`match h.outcome` 的每个分支各产
    ///    一个），而两次死球之间必有一次控制建立或流结束——即：`tick` 体内每个分支都提前
    ///    `return`，同一 tick 不可能在 `dead_ball` / `restart_prep` / `highlight` 三条路里
    ///    各产一个死球。
    ///
    ///    ⚠️ **不要**把这条写成「一个 tick 至多 `finalize_highlight` 一次」——那是**错的**：
    ///    尾部排空循环（`while st.highlight.is_some()`）会在同一 `t = dur` 上**反复**
    ///    `finalize_highlight`（链式高亮），且 `truncated_stream_produces_a_full_time_gap_by_design`
    ///    实测它确实在 `dur` 上产事实。正确的表述是「每个死球结果都在其自身 tick 内闭环，
    ///    且排空链上的死球之间必然隔着一次控制建立」。
    ///
    /// 于是「上一个重开还没完成就被新死球顶掉」没有可执行路径。
    ///
    /// 本测试固定**当前口径**并断言 0 条 + 两条更强的结构不变量：
    ///
    /// - ① `restart_sequences.len() == dead_ball_started 事实数 + 1`——第一条 restart 由
    ///   `match_started` 创建，其余**严格一一对应**死球事实。这证明 recorder 不会凭空造
    ///   restart（同时是 §6.2「重开一律由死球创建」在真实路径上的机器化表述）；
    /// - ② 每条 restart 的 `end_reason` ∈ {`OpenPlayResumed`, `MatchEnd`}——即：没有一条以
    ///   `SupersededByDeadBall` / `TerminatedByWhistle` / `Unknown` 结束。
    ///
    /// **这条 0 是真在测东西，还是口径没覆盖到？**（2026-09-23 实测，勿删）：
    /// 把 `advance_restart_prep` 的发球点改成「先报一条新死球、再 taken」，本测试立刻变红
    /// （`end_reason = Some(SupersededByDeadBall)`），说明死球事实一多、断言就能看见；
    /// 而当前口径下 2800 场真实比赛（seed 1..=400 × dur {120,300,600,1200,2700,5400,9000}）
    /// 一条都没有。故这是**观测结果**，不是断言写错。
    ///
    /// 将来若引擎引入「重开中途再死球」（例如犯规打断准备期），本测试会**变红并提醒**：
    /// 那时应把 `SupersededByDeadBall` 从「recorder-level contract」升级为
    /// 「生产已覆盖」，并补针对性的生产断言（见 design §15 A9-2 的同名结论）。
    #[test]
    fn superseded_by_dead_ball_is_a_recorder_level_contract_not_engine_reachable() {
        const SEEDS: [u64; 5] = [1, 5, 86, 97, 120];
        const DURATIONS: [f64; 2] = [300.0, 5400.0];
        let mut restarts = 0usize;
        for dur in DURATIONS {
            let config = MatchConfig {
                match_duration_seconds: dur,
                ..MatchConfig::default_()
            };
            for seed in SEEDS {
                let dm = simulate_with_behavior_observations(seed, config);
                assert_eq!(
                    dm.gap_count(),
                    0,
                    "seed {} dur {}：本样本不该产 gap（0 只对本样本成立——终场哨落在未决飞行\
                     中途时会合法产 `full_time_during_ball_in_flight`，且**与时长无关**：\
                     已复核 seed 470 @ dur 120、seed 1228 @ dur 400。若本行变红先查它是不是\
                     那一类合法缺口，再查 SupersededByDeadBall 口径）",
                    seed,
                    dur
                );
                assert!(
                    dm.is_coherent(),
                    "seed {} dur {}：{:?}",
                    seed,
                    dur,
                    dm.invariant_violations
                );
                // ① restart 与死球事实严格一一对应（+ 首开球那条）。
                let dead_balls = dm
                    .control_facts
                    .iter()
                    .filter(|f| f.kind == ControlFactKind::DeadBallStarted)
                    .count();
                assert_eq!(
                    dm.restart_sequences.len(),
                    dead_balls + 1,
                    "seed {} dur {}：restart 数 {} ≠ 死球事实数 {} + 1——recorder 凭空造了 \
                     restart（§6.2 要求每个 sequence 都有死球来源）",
                    seed,
                    dur,
                    dm.restart_sequences.len(),
                    dead_balls
                );
                // ② 没有任何 restart 以「被新死球顶掉」结束（当前生产引擎不可达）。
                for r in &dm.restart_sequences {
                    assert!(
                        matches!(
                            r.end_reason,
                            Some(RestartEndReason::OpenPlayResumed)
                                | Some(RestartEndReason::MatchEnd)
                        ),
                        "seed {} dur {}：restart {}（{:?}）以 {:?} 结束——`SupersededByDeadBall` \
                         是 recorder 层契约，当前引擎不可达；若它真的出现了，说明引擎新引入了\
                         「重开中途再死球」，须同步升级本断言与 design §15 A9-2",
                        seed,
                        dur,
                        r.id,
                        r.kind,
                        r.end_reason
                    );
                }
                restarts += dm.restart_sequences.len();
            }
        }
        // 防空转：真的跑了不少 restart 才敢说「一条都没有」。实测本 seed × dur 组合共 261 条
        // restart（dur=300 的短场贡献较少，dur=5400 是主力）——阈值取 200 留一点余量，
        // 但离 261 很近，故 seed 或 dur 被误删时会当场红。
        assert!(
            restarts >= 200,
            "restart 样本过少（{}），断言接近空转",
            restarts
        );
    }

    /// **P2.1**：每个 episode / restart 对象都必须有至少一条 `event_indexes`，
    /// **或**落在**唯一**一条有据可依的例外上——不能靠「别的对象有下标」蒙混（这正是旧集成
    /// 测试只看「存在至少一个非空对象」的漏洞）。
    ///
    /// **例外（唯一条）**：对象**在流截断时刻 `dur` 才被创建**（`start_t == 尾哨 t == dur`）。
    /// 其原因正是 design §14 A4.1 / §15.2 设计的行为：`match_events` 出循环后立刻
    /// `note_event_stream_compaction(drain_start)` + `suspend_event_index_binding(true)`，
    /// 排空期的提交点**不绑定**事件下标（靠 `t` + `detail` 定位）。故此刻新建的对象没有下标，
    /// 是**设计后果**而非遗漏。
    ///
    /// 为什么用「`start_t == dur`」这一个谓词而不是按对象类型列举形态：实测它**统一覆盖**了
    /// 三种实际形态，且**零反例**——2800 场（seed 1..=400 × dur {120,300,600,1200,2700,5400,9000}）
    /// 里 29 条空 restart + 63 条空 episode **全部**满足该谓词（数字为 2026-09-25 在 main 基线
    /// `MODEL_VERSION=7` 上重测；旧 v6 基线为 22 + 55，谓词本身不变）。三个形态是：
    /// ① `dur` 时刻由终场哨开启的 episode（`start_t == end_t == dur`）；
    /// ② `dur` 时刻创建、未 `taken` 就被 `match_end` 收束的 restart；
    /// ③ `dur` 时刻由射门 off-target 触发、**已 `taken`** 的门球 restart（在排空期内
    ///    `finalize_highlight` 里创建并同步 taken——`taken` 本身不豁免绑定，是排空期暂停豁免的）。
    ///
    /// ⚠️ **本测试的第一版曾漏掉形态 ③**：它按 `end_reason == MatchEnd && taken_t.is_none()`
    /// 判定例外，于是对形态 ③ 会误判为「已 taken 却无下标 = 缺陷」。当时的 seed 集合
    /// （1/5/15/33/86/97/100/120 @ 5400）恰好**没有**命中形态 ③，测试照样全绿——正是
    /// 「只在自选 seed 上闭合」的典型。现在 seed 集合里**显式**包含命中形态 ③ 的 seed
    /// （见下 `SEEDS`），且下面的防空转断言要求三种形态**都**被覆盖。
    ///
    /// **seed 集合随基线重标定（2026-09-25）**：本测试原用的 seed 是在 `MODEL_VERSION=6` 分支上
    /// 选的；P15A 移植到 main（`MODEL_VERSION=7`，含 P104 体积重标定）后，任何 seed 集合都不再命中
    /// 三种形态（防空转断言直接变红）。按同一判据在 5400 默认时长下重扫 seed 1..=400，
    /// 换用 [1, 9, 24, 36, 53, 86, 100, 317, 5]（形态①②③ 计数 1/1/2）。**换的是样本，不是判据**——
    /// 谓词、豁免条款与防空转断言都未改。
    #[test]
    fn every_episode_and_restart_object_has_event_indexes_or_a_documented_exception() {
        // 选种依据（实测）：5400 默认时长下命中三种形态的最小集合。
        // 形态 ①②③ 分别由 truncated_* 三个计数器证明覆盖。
        const SEEDS: [u64; 9] = [1, 9, 24, 36, 53, 86, 100, 317, 5];
        let mut truncated_episode = 0usize;
        let mut truncated_restart_untaken = 0usize;
        let mut truncated_restart_taken = 0usize;
        for seed in SEEDS {
            let dm = simulate_with_behavior_observations(seed, MatchConfig::default_());
            let whistle_t = dm
                .events
                .iter()
                .rev()
                .find(|e| e.type_ == crate::EventType::Whistle)
                .map(|e| e.t)
                .expect("正式流应有尾哨");
            for e in &dm.possession_episodes {
                if !e.event_indexes.is_empty() {
                    continue;
                }
                assert!(
                    (e.start_t.value - whistle_t).abs() < 1e-9,
                    "seed {}：episode {}（start_t={}）无事件下标，且不在流截断时刻（尾哨 t={}）：\
                     只有「截断时刻才创建」的对象允许没有可归属事件；{:#?}",
                    seed,
                    e.id,
                    e.start_t.value,
                    whistle_t,
                    e
                );
                truncated_episode += 1;
            }
            for r in &dm.restart_sequences {
                if !r.event_indexes.is_empty() {
                    continue;
                }
                assert!(
                    (r.start_t.value - whistle_t).abs() < 1e-9,
                    "seed {}：restart {}（{:?}，start_t={}）无事件下标，且不在流截断时刻\
                     （尾哨 t={}）：{:#?}",
                    seed,
                    r.id,
                    r.kind,
                    r.start_t.value,
                    whistle_t,
                    r
                );
                if r.taken_t.is_none() {
                    truncated_restart_untaken += 1;
                } else {
                    truncated_restart_taken += 1;
                }
            }
            // 首开球 sequence 必须在**每个** seed 上都有下标（它是唯一曾被系统性漏绑的对象：
            // 旧接线的唯一一次归属扫描在 `control_established` **之后**，那时 restart 已被
            // `open_play_resumed` 收束 → `OpenRestart` 目标落空，120/120 seed 全空）。
            // **判别力实测**：把 lib.rs 首开球那处「先绑一次」删掉（退回单次后置扫描）→ 本断言红。
            assert!(
                !dm.restart_sequences[0].event_indexes.is_empty(),
                "seed {}：首开球 sequence 无事件下标（首开球提交点缺少收束前的那次绑定？）",
                seed
            );
        }
        // 防空转：三种形态**都**必须在 seed 集合里真的出现，否则豁免条款无人验证
        // （第一版就是漏了形态 ③ 还照样全绿）。
        assert!(
            truncated_episode > 0
                && truncated_restart_untaken > 0
                && truncated_restart_taken > 0,
            "seed 集合没有覆盖全部三种截断形态（episode {} / restart 未 taken {} / \
             restart 已 taken {}）——豁免条款有分支是空转的；请在 SEEDS 里补命中该形态的 seed",
            truncated_episode,
            truncated_restart_untaken,
            truncated_restart_taken
        );
    }

    #[test]
    fn every_bound_fact_event_index_is_not_after_the_fact() {
        // 空转断言的反证面：绑定下标若全部指向「随便一条事件」，上面的覆盖门依然全绿。
        // 这里守一条**真的**归属判据——绑定的事件必须是**事实那一刻（或紧随其后第一条）**的
        // 事件，而不是事后随便一条 beat。
        //
        // **为什么不是相等**（实测被锤过两次）：design §8 明确区分「动作 / 高亮开始」
        // （`event.t`）与「引擎提交 carrier 的时刻」（`state_commit`）——传球在 t=9 发出、
        // t=10 才被接住并提交控制，两者**本来就不同**。相等断言会在所有正常传球路径上红。
        //
        // 两类基准分开判（这是本测试判别力的来源）：
        // - `DeterministicFlightEnd`：事实时刻是引擎**自己算出的飞行结束**（tick 中间的小数），
        //   报告它的那条 beat 落在**下一个 tick 边界** → 允许「不早于事实、且落在同一 tick 内」，
        //   并要求它是事实之后的第一条事件（中间不得跳过别的 beat）。
        // - 其余 basis（动作 emit / 状态提交 / 结局确认）：事件必须**不晚于**事实时刻。
        //
        // **本测试只守「不晚于」这半边**（见 `action_facts_never_bind_to_a_beat` 守另外半边：
        // 「不能绑到无关的更早事件」）。单靠本测试抓不到「绑到上一拍 beat」这类错位——
        // 实测：抢断的 `contest_started` 曾被绑到上一拍的 beat 而本测试全绿。
        // 多 seed：`deterministic_flight_end` 只出现在「进球后开球恢复」这条较罕见的路径上，
        // 单个 seed 可能一条都没有（实测 seed 1 就是），那样本测试的第二条分支会变成空转。
        let mut bound = 0;
        let mut flight_bound = 0;
        for seed in [1u64, 5, 97] {
            let dm = simulate_with_behavior_observations(seed, MatchConfig::default_());
            for (i, f) in dm.control_facts.iter().enumerate() {
                let Some(ei) = f.source_event_index else {
                    continue;
                };
                let ev = &dm.events[ei];
                if f.t.basis == TimeBasis::DeterministicFlightEnd {
                    flight_bound += 1;
                    assert!(
                    ev.t >= f.t.value - 1e-9,
                    "fact[{}] {} 的 t={} 晚于其绑定事件 events[{}].t={}（飞行结束提交不得绑更早的事件）",
                    i,
                    f.kind.as_str(),
                    f.t.value,
                    ei,
                    ev.t
                );
                    assert!(
                    ev.t - f.t.value <= 1.0 + 1e-9,
                    "fact[{}] {} 的 t={} 与绑定事件 events[{}].t={} 相距超过一个 tick（绑错事件）",
                    i,
                    f.kind.as_str(),
                    f.t.value,
                    ei,
                    ev.t
                );
                    assert!(
                        ei == 0 || dm.events[ei - 1].t < f.t.value,
                        "fact[{}] {} 的绑定事件不是其时刻之后的第一条（跳过了中间的 beat）",
                        i,
                        f.kind.as_str()
                    );
                } else {
                    assert!(
                        ev.t <= f.t.value + 1e-9,
                        "fact[{}] {} 的 t={} 早于其绑定事件 events[{}].t={}（绑到了未来的事件）",
                        i,
                        f.kind.as_str(),
                        f.t.value,
                        ei,
                        ev.t
                    );
                }
                bound += 1;
            }
            // 反面：同一条事实绑定的**必须**是它那一侧的事件——`dead_ball_started` 的来源应是
            // 射门/出界事件（而不是随后重开期里的某个 beat）。用「重开序列首事件不得早于
            // 死球事实」这层关系间接印证：重开的 `taken_t` 不可能早于它自己的死球。
            for r in &dm.restart_sequences {
                if let Some(taken) = r.taken_t {
                    assert!(
                        taken.value >= r.start_t.value,
                        "restart {} 的 taken_t={} 早于 start_t={}",
                        r.id,
                        taken.value,
                        r.start_t.value
                    );
                }
            }
        }
        assert!(bound > 0, "真实比赛应有事实绑定事件下标");
        assert!(
            flight_bound > 0,
            "三个 seed 里应有确定性飞行结束的提交（否则上面那条分支是空转）"
        );
    }

    #[test]
    fn drain_period_bindings_are_suspended_not_gap_reported() {
        // 排空期（尾部压缩）内的绑定必须被**静默暂停**，不能变成
        // `EventIndexOutOfStableRange` gap。
        //
        // 这条是 Slice 2 两个防线里的**行为**门（另一条是源码守卫
        // `p15_compaction_boundary_is_actually_registered`）：实测**删掉**排空期前的
        // `suspend_event_index_binding(true)` 后，seed 33 会产出 2 条
        // `event_index_out_of_stable_range` gap——因为边界现在真的在排空循环**之前**
        // 登记了（旧实现把它推迟到循环之后，那时没有任何绑定会去查它，删掉暂停也全绿）。
        //
        // **seed 33 是必需的**：其余常见 seed（1/5/97/11/544）在排空期恰好不产绑定，
        // 删掉暂停照样 0 gap。样本里漏掉这一个 seed，本测试就退化成空转
        // ——这正是审阅指出的「暂停只有源码守卫覆盖」的补法。
        for seed in [33u64, 1, 5, 97] {
            let dm = simulate_with_behavior_observations(seed, MatchConfig::default_());
            let unstable = dm
                .gap_reason_counts()
                .into_iter()
                .find(|(r, _)| *r == ObservationGapReason::EventIndexOutOfStableRange)
                .map(|(_, n)| n)
                .unwrap_or(0);
            assert_eq!(
                unstable, 0,
                "seed {}：排空期绑定必须是静默暂停（不产 gap）；实际 {} 条——\
                 若删了 `suspend_event_index_binding(true)` 会变成非 0",
                seed, unstable
            );
            assert_eq!(dm.gap_count(), 0, "seed {}：真实路径不该有任何 gap", seed);
        }
    }

    #[test]
    fn goal_kick_sequence_team_is_the_taking_side() {
        // 门球的重开归属必须 = **开球那一方**（`start_goal_kick` 提交 possession 之后的值），
        // 而不是产生死球那一方。
        //
        // 为什么单独测：接线层曾在 `start_goal_kick` **之前**取 `1 - st.possession` ——
        // 今天恰好等价（`start_goal_kick` 就是把 possession 切成门将所属队），但**没有任何
        // 测试区分**：把它改成 `st.possession`（不取反）也全绿（审阅实测突变存活）。
        // 现在 `goal_kick_started` 内部直接读提交后的 `st.possession`，本测试钉住这条语义。
        //
        // 判据：门球 sequence 的 `team` 必须与**门球交付事件**（那条 `result=contested` 的
        // Pass）的 `subject`（门将 id）同队——门将开的球，重开方就是门将那队。
        let mut checked = 0;
        for seed in 1u64..=40 {
            let dm = simulate_with_behavior_observations(
                seed,
                MatchConfig {
                    match_duration_seconds: 1200.0,
                    ..MatchConfig::default_()
                },
            );
            for r in &dm.restart_sequences {
                if r.kind != RestartKind::GoalKick {
                    continue;
                }
                // 门球交付事件 = 门将开大脚那条 pass：`to = None`（落点是争抢点）、
                // `result = contested`、`subject` 是门将 id（0 / 21）。
                // **不能**取 `event_indexes.first()`——那可能是**产生死球的**出界/射门事件
                // （它也属于这条 sequence，但主体不是门将）。
                let Some(ev) = r
                    .event_indexes
                    .iter()
                    .map(|i| &dm.events[*i])
                    .find(|e| {
                        e.type_ == crate::EventType::Pass
                            && e.to.is_none()
                            && e.result.as_deref() == Some("contested")
                    })
                else {
                    continue;
                };
                let Some(team) = r.team.known() else { continue };
                let gk_team = TeamId::from_player(ev.subject)
                    .unwrap_or_else(|| panic!("seed {}：门球事件 subject={} 越界", seed, ev.subject));
                assert_eq!(
                    team,
                    gk_team,
                    "seed {}：restart {} 的 team={:?} 与门将 {}（属 {:?}）不符——\
                     门球归属必须是开球那一方",
                    seed,
                    r.id,
                    r.team,
                    ev.subject,
                    gk_team
                );
                checked += 1;
            }
        }
        assert!(
            checked > 10,
            "只检查了 {} 条门球 sequence——样本太少，本测试可能空转",
            checked
        );
    }

    #[test]
    fn control_facts_never_contradict_their_own_player() {
        // 一条事实的 `team` 与 `player` **必须同队**——两者出自同一个提交点，
        // 自相矛盾就说明队别取错了源（不是「证据不足」，`Unknown` 才是那种情形）。
        //
        // 这条抓到了一个真 bug：`obs_contest_pickup` 在 battle 分支**之前**读
        // `st.possession`（那时还是争抢前的旧值），120 seed 里有 100 条事实的 team 与
        // player 矛盾，并沿 `PossessionEpisode.team` 污染整条 episode。
        // 之前的测试只看「有没有 gap / 违不违规 / t 对不对」，全都看不见队别错。
        //
        // 多 seed 是必需的：矛盾只在 battle 胜方**跨过某条球门线**时出现，
        // 单 seed 命中不到（seed 1/5/97 恰好 0 条）。
        let mut checked = 0;
        for seed in 1u64..=40 {
            let dm = simulate_with_behavior_observations(
                seed,
                MatchConfig {
                    match_duration_seconds: 1200.0,
                    ..MatchConfig::default_()
                },
            );
            for (i, f) in dm.control_facts.iter().enumerate() {
                let (Some(team), Some(player)) = (f.team, f.player) else {
                    continue;
                };
                let expected = TeamId::from_player(player)
                    .unwrap_or_else(|| panic!("player {} 越出引擎 id 方案", player));
                assert_eq!(
                    team,
                    expected,
                    "seed {}：fact[{}] {} 的 team={:?} 与其 player={}（属 {:?}）矛盾",
                    seed,
                    i,
                    f.kind.as_str(),
                    team,
                    player,
                    expected
                );
                checked += 1;
            }
            // episode 的 team 也必须与它引用的持球事实一致。
            for e in &dm.possession_episodes {
                for idx in &e.control_fact_indexes {
                    if let Some(p) = dm.control_facts[*idx].player {
                        assert_eq!(
                            e.team,
                            TeamId::from_player(p).expect("player in range"),
                            "seed {}：episode {} 的 team={:?} 与其持球 player={} 矛盾",
                            seed,
                            e.id,
                            e.team,
                            p
                        );
                    }
                }
            }
        }
        assert!(
            checked > 1000,
            "只检查了 {} 条事实——样本太少，本测试可能空转",
            checked
        );
    }

    #[test]
    fn action_facts_never_bind_to_a_beat() {
        // **归属判据的另外半边**（上一测试只守「不晚于」）。
        //
        // 事实可以合法地绑到 Beat 的只有两类，且都必须是**同一 tick** 的那记 beat：
        // ① `deterministic_flight_end`（开球飞行恢复：引擎自算的时刻落在 tick 中间，
        //    报告它的 beat 在下一个 tick 边界）；
        // ② `state_commit` 的拾取类提交（`advance_loose` 里「本拍 beat 就是拾取」）。
        //
        // 其余情形绑到 Beat 一律是错位：动作型事实（`control_released` / 死球 / 争抢）的来源
        // 必须是**产生它的动作事件**（Pass / Shot / Tackle / 传出界…），
        // 而不是随便一拍移动 beat。实测这条抓到了真 bug——抢断的 `contest_started`
        // 曾因 `Highlight.obs_event` 在动作事件 push **之前**取值而绑到上一拍 beat。
        let mut checked = 0;
        for seed in [1u64, 5, 97] {
            let dm = simulate_with_behavior_observations(seed, MatchConfig::default_());
            for (i, f) in dm.control_facts.iter().enumerate() {
                let Some(ei) = f.source_event_index else {
                    continue;
                };
                let ev = &dm.events[ei];
                if ev.type_ != crate::EventType::Beat {
                    continue;
                }
                // ① **绑定的 Beat 绝不能早于事实**——这条判据本身就杀掉了「绑到上一拍 beat」
                //    这个错误类（旧实现用 `|ev.t - f.t| < 1.0` 的对称窗口，恰好 1.0s 的
                //    上一拍 beat 能溜过去，只有靠 kind 白名单兜底；审阅实测：在拾取点注入
                //    偏移一拍的错误绑定，旧实现全绿）。
                assert!(
                    ev.t >= f.t.value - 1e-9,
                    "fact[{}] {}（t={}）绑到了 events[{}] 这条更早的 Beat（t={}）——\
                     绑定的事件不得早于事实",
                    i,
                    f.kind.as_str(),
                    f.t.value,
                    ei,
                    ev.t
                );
                // ② 允许绑 Beat 的两类：`deterministic_flight_end`（Beat 落在下一个 tick
                //    边界，晚于事实）与同一 tick 的拾取/恢复类提交。其余动作型事实必须绑
                //    动作事件。
                let same_tick = (ev.t - f.t.value).abs() < 1e-9;
                let allowed = f.t.basis == TimeBasis::DeterministicFlightEnd
                    || (same_tick
                        && matches!(
                            f.kind,
                            ControlFactKind::ControlEstablished
                                | ControlFactKind::OpenPlayResumed
                                | ControlFactKind::ContestEnded
                        ));
                assert!(
                    allowed,
                    "fact[{}] {}（t={}, basis={:?}）绑到了 events[{}] 这条 Beat（t={}）——\
                     只有飞行结束提交与同 tick 的拾取/恢复类允许绑 Beat",
                    i,
                    f.kind.as_str(),
                    f.t.value,
                    f.t.basis.as_str(),
                    ei,
                    ev.t
                );
                checked += 1;
            }
        }
        assert!(
            checked > 0,
            "三个 seed 里应有事实绑到 Beat（否则本测试是空转——判据没被执行过）"
        );
    }

    #[test]
    fn demo_mode_sequences_carry_no_facts() {
        // demo 是固定动作展示序列，不是可观察的比赛过程：Slice 1 不为其伪造事实。
        let cfg = MatchConfig {
            demo_mode: true,
            match_duration_seconds: 60.0,
            ..MatchConfig::default_()
        };
        let dm = simulate_with_behavior_observations(3, cfg);
        assert!(dm.control_facts.is_empty());
        assert_eq!(dm.events_json(), simulate(3, cfg));
        // demo 没有开赛事实，终态保持 `Uninitialized`（不是 `Ended`）——`Ended` 会假称比赛跑过。
        assert_eq!(dm.state, BehaviorControlState::Uninitialized);
        assert!(dm.is_coherent(), "{:?}", dm.invariant_violations);
    }

    #[test]
    fn reject_does_not_exempt_ill_formed_state() {
        // #4 的**失败旧实现**反证：旧实现用 `!state_stale_after_gap` 整体跳过 state 交叉校验，
        // 于是在 gap 之后把 state 注水成任何损坏值都不报错（终态免检）。修复按**值**比较
        // （state 是否仍等于 reject 留下的快照），因此任何改写都立刻恢复全量校验。
        //
        // (a0) 陈旧窗口内 state 被改写 → 豁免必须失效（旧实现的头号逃逸）。
        //      这里把 state 换成 `Controlled{Away}`：记录里开放 episode 是 Home → 队别不符。
        let mut rec = kicked_off();
        rec.restart_taken(tc(9.0), ControlFactBasis::RestartRule); // 非法（已在 Controlled）→ reject
        assert_eq!(rec.gap_count(), 1);
        assert!(
            rec.stale_state_snapshot.is_some(),
            "前提：reject 必须留下 state 快照"
        );
        rec.state = BehaviorControlState::Controlled {
            team: TeamId::Away,
            carrier: Some(11),
        };
        let v = rec.invariant_violations();
        assert!(
            v.iter().any(|m| m.contains("state Controlled team = Away")),
            "陈旧窗口内改写 state 后必须全量校验（旧实现整体跳过 → 空列表）；实际 = {:?}",
            v
        );

        // (a) 同一类逃逸的第二种改写：记 `Controlled` 但根本没有开放 episode。
        let mut rec = kicked_off();
        rec.restart_taken(tc(9.0), ControlFactBasis::RestartRule);
        assert_eq!(rec.gap_count(), 1);
        rec.episodes[0].end_t = Some(tc(9.5));
        rec.episodes[0].end_reason = Some(EpisodeEndReason::ControlLost);
        rec.open_episode = None;
        rec.state = BehaviorControlState::Controlled {
            team: TeamId::Home,
            carrier: Some(10),
        };
        let v = rec.invariant_violations();
        assert!(
            v.iter().any(|m| m.contains("但没有开放 episode")),
            "gap 之后的终态损坏必须照常上报；实际 = {:?}",
            v
        );
        assert!(
            v.iter().any(|m| m.contains("state Controlled team")),
            "损坏串必须可诊断；实际 = {:?}",
            v
        );

        // (a2) 陈旧窗口内的 `RestartPreparation` 降级改写（旧实现第二处逃逸：前缀抑制把
        //      「已知事实被降级」一并吞掉）。
        let mut rec = BehaviorObservationRecorder::enabled();
        rec.match_started(t0(), TeamRef::Home);
        rec.dead_ball_started(
            tc(10.0),
            DeadBallReason::OutSideline,
            Some((TeamRef::Away, RestartKind::ThrowIn)),
            EpisodeEndReason::Out,
            ControlFactBasis::FinalizedOutcome,
        );
        rec.restart_preparation_started(
            tc(11.0),
            TeamRef::Away,
            RestartKind::ThrowIn,
            ControlFactBasis::RestartRule,
        );
        rec.control_established(
            tc(12.0),
            TeamId::Home,
            Some(10),
            None,
            EpisodeStartReason::Kickoff,
            None,
            ControlFactBasis::EngineState,
        ); // RestartPreparation 下建控制 → reject
        assert!(rec.stale_state_snapshot.is_some());
        rec.state = BehaviorControlState::RestartPreparation {
            team: TeamRef::Away,
            kind: RestartKind::Unknown,
        }; // 降级改写
        let v = rec.invariant_violations();
        assert!(
            v.iter().any(|m| m.contains("已知事实被降级")),
            "陈旧窗口内的 kind 降级改写必须被抓到；实际 = {:?}",
            v
        );

        // (b) 开放 restart 还在，state 却指向别的队 → 同一类子句必须报出。
        let mut rec = BehaviorObservationRecorder::enabled();
        rec.match_started(t0(), TeamRef::Home);
        rec.dead_ball_started(
            tc(10.0),
            DeadBallReason::OutSideline,
            Some((TeamRef::Away, RestartKind::ThrowIn)),
            EpisodeEndReason::Out,
            ControlFactBasis::FinalizedOutcome,
        );
        rec.restart_preparation_started(
            tc(11.0),
            TeamRef::Away,
            RestartKind::ThrowIn,
            ControlFactBasis::RestartRule,
        );
        rec.control_established(
            tc(12.0),
            TeamId::Home,
            Some(10),
            None,
            EpisodeStartReason::Kickoff,
            None,
            ControlFactBasis::EngineState,
        );
        assert_eq!(rec.gap_count(), 1);
        rec.state = BehaviorControlState::RestartPreparation {
            team: TeamRef::Home,
            kind: RestartKind::ThrowIn,
        };
        rec.stale_state_snapshot = Some(rec.state);
        let v = rec.invariant_violations();
        assert!(
            v.iter()
                .any(|m| m.contains("state RestartPreparation team")),
            "gap 之后 state team 与开放 restart 不一致必须上报；实际 = {:?}",
            v
        );

        // (c) 反向：真正由 gap 造成的两例子句**仍不得**误报（否则「无违规」门在真实 gap 路径失效）。
        let mut rec = kicked_off();
        rec.control_released_into_flight(
            tc(2.0),
            FlightAction::Pass,
            ControlFactBasis::EngineState,
        );
        rec.contest_started(
            tc(3.0),
            ContestStartReason::PassLost,
            None,
            EpisodeEndReason::ControlLost,
            ControlFactBasis::FinalizedOutcome,
        );
        rec.control_released_into_flight(
            tc(4.0),
            FlightAction::Pass,
            ControlFactBasis::EngineState,
        ); // Contested → reject
        assert!(rec.stale_state_snapshot.is_some());
        assert!(
            rec.invariant_violations().is_empty(),
            "gap 必然造成的「争抢已收束」必须是假阳性；实际 = {:?}",
            rec.invariant_violations()
        );
    }

    #[test]
    fn every_closed_set_enum_lists_all_members() {
        // 「闭集 ALL 守护」：新增成员却忘了加进 `ALL` 时，这条测试红。
        // 各枚举的 `ALL` 与逐个手写成员清单必须一一对应（既不缺、也不多）。
        macro_rules! same_set {
            ($what:literal, $all:expr, [$($v:expr),* $(,)?]) => {{
                let listed: Vec<&'static str> = $all.iter().map(|x| x.as_str()).collect();
                let manual: Vec<&'static str> = vec![$($v.as_str()),*];
                assert_eq!(
                    listed.len(),
                    manual.len(),
                    "{} 的 ALL 长度 {} != 手写成员数 {}（ALL 漏列或多列）",
                    $what,
                    listed.len(),
                    manual.len()
                );
                for m in &manual {
                    assert!(listed.contains(m), "{} 的 ALL 缺少成员 {:?}", $what, m);
                }
                let mut sorted = listed.clone();
                sorted.sort_unstable();
                sorted.dedup();
                assert_eq!(sorted.len(), listed.len(), "{} 的 ALL 有重复成员", $what);
            }};
        }
        same_set!(
            "RestartKind",
            RestartKind::ALL,
            [
                RestartKind::Kickoff,
                RestartKind::FreeKick,
                RestartKind::Corner,
                RestartKind::ThrowIn,
                RestartKind::GoalKick,
                RestartKind::Unknown,
            ]
        );
        same_set!(
            "DeadBallReason",
            DeadBallReason::ALL,
            [
                DeadBallReason::Goal,
                DeadBallReason::OutSideline,
                DeadBallReason::OutGoalLine,
                DeadBallReason::Foul,
                DeadBallReason::HalfTime,
                DeadBallReason::FullTime,
                DeadBallReason::Unknown,
            ]
        );
        same_set!(
            "FlightAction",
            FlightAction::ALL,
            [
                FlightAction::Pass,
                FlightAction::Clearance,
                FlightAction::Shot,
                FlightAction::Corner,
                FlightAction::ThrowIn,
                FlightAction::FreeKick,
                FlightAction::GoalKick,
                FlightAction::Kickoff,
                FlightAction::Unknown,
            ]
        );
        same_set!(
            "RestartEndReason",
            RestartEndReason::ALL,
            [
                RestartEndReason::OpenPlayResumed,
                RestartEndReason::TerminatedByWhistle,
                RestartEndReason::MatchEnd,
                RestartEndReason::SupersededByDeadBall,
                RestartEndReason::Unknown,
            ]
        );
        same_set!(
            "EpisodeStartReason",
            EpisodeStartReason::ALL,
            [
                EpisodeStartReason::Kickoff,
                EpisodeStartReason::Pickup,
                EpisodeStartReason::SuccessfulReceive,
                EpisodeStartReason::RestartControl,
                EpisodeStartReason::ControlChange,
                EpisodeStartReason::Unknown,
            ]
        );
        same_set!(
            "EpisodeEndReason",
            EpisodeEndReason::ALL,
            [
                EpisodeEndReason::Goal,
                EpisodeEndReason::SavedCaught,
                EpisodeEndReason::ShotRebound,
                EpisodeEndReason::Out,
                EpisodeEndReason::Foul,
                EpisodeEndReason::ControlLost,
                EpisodeEndReason::WhistleInterrupt,
                EpisodeEndReason::HalfTime,
                EpisodeEndReason::FullTime,
                EpisodeEndReason::ObservationGap,
            ]
        );
        same_set!(
            "ContestStartReason",
            ContestStartReason::ALL,
            [
                ContestStartReason::PassLost,
                ContestStartReason::InterceptionLoose,
                ContestStartReason::TackleLoose,
                ContestStartReason::ShotRebound,
                ContestStartReason::DeliveryLoose,
                ContestStartReason::Unknown,
            ]
        );
        same_set!(
            "ContestEndReason",
            ContestEndReason::ALL,
            [
                ContestEndReason::Pickup,
                ContestEndReason::DeadBall,
                ContestEndReason::Whistle,
                ContestEndReason::MatchEnd,
                ContestEndReason::ObservationGap,
                ContestEndReason::Unknown,
            ]
        );
        same_set!(
            "ControlFactKind",
            ControlFactKind::ALL,
            [
                ControlFactKind::MatchStarted,
                ControlFactKind::ControlEstablished,
                ControlFactKind::ControlReleased,
                ControlFactKind::ContestStarted,
                ControlFactKind::ContestEnded,
                ControlFactKind::DeadBallStarted,
                ControlFactKind::RestartPreparationStarted,
                ControlFactKind::RestartTaken,
                ControlFactKind::OpenPlayResumed,
                ControlFactKind::ObservationGap,
                ControlFactKind::MatchEnded,
            ]
        );
        same_set!(
            "ControlFactBasis",
            ControlFactBasis::ALL,
            [
                ControlFactBasis::EngineState,
                ControlFactBasis::FinalizedOutcome,
                ControlFactBasis::RestartRule,
                ControlFactBasis::StreamBoundary,
            ]
        );
        same_set!(
            "TimeBasis",
            TimeBasis::ALL,
            [
                TimeBasis::StateCommit,
                TimeBasis::EventEmit,
                TimeBasis::DeterministicFlightEnd,
                TimeBasis::Unknown,
            ]
        );
        // `ObservationGapReason::ALL` 的守护：漏列成员会让 `gap_reason_counts` 少一个计数位，
        // 按原因聚合的基线静默漏掉整类缺口。
        //
        // **守护边界（实测，勿高估）**：
        // - 能抓：从 `ALL` 里**漏掉**一个已列成员（`same_set!` 的长度/串名对不上）→ 红；
        // - **抓不到**：给枚举**新增**一个成员却忘了加进 `ALL`。`same_set!` 比较的是 `ALL`
        //   与手写清单，两者会一起漏；`as_str` 的穷尽 `match` 只强制你补 `as_str` 那一行。
        //   实测：加一个变体 + 它的 `as_str` 分支、不动 `ALL` → 本测试仍全绿。
        //   要根除需用宏从同一份清单生成「枚举 + `ALL` + `as_str`」，代价是每个变体的文档注释
        //   要改成属性传入；对诊断字段而言不值得。
        //   残余后果：`gap_reason_counts()` 为新原因少一个计数位。
        same_set!(
            "ObservationGapReason",
            ObservationGapReason::ALL,
            [
                ObservationGapReason::HalfTimeDuringBallInFlight,
                ObservationGapReason::FullTimeDuringBallInFlight,
                ObservationGapReason::MissingStreamEndBoundary,
                ObservationGapReason::EventIndexOutOfStableRange,
                ObservationGapReason::IllegalFactIndex,
                ObservationGapReason::EventIndexRegressed,
                ObservationGapReason::IllegalInput(IllegalInput::MatchStartedOutsideUninitialized),
                ObservationGapReason::IllegalInput(IllegalInput::DeadBallStartedInIllegalState),
                ObservationGapReason::IllegalInput(IllegalInput::RestartPreparationOutsideDeadBall),
                ObservationGapReason::IllegalInput(
                    IllegalInput::RestartPreparationWithoutScheduledRestart
                ),
                ObservationGapReason::IllegalInput(
                    IllegalInput::RestartPreparationContradictsScheduledRestart
                ),
                ObservationGapReason::IllegalInput(
                    IllegalInput::RestartTakenOutsideRestartPreparation
                ),
                ObservationGapReason::IllegalInput(IllegalInput::ControlEstablishedInIllegalState),
                ObservationGapReason::IllegalInput(
                    IllegalInput::ControlEstablishedBeforeRestartTaken
                ),
                ObservationGapReason::IllegalInput(
                    IllegalInput::ControlEstablishedByOpponentWhileControlled
                ),
                ObservationGapReason::IllegalInput(
                    IllegalInput::ControlReleasedIntoFlightOutsideControlled
                ),
                ObservationGapReason::IllegalInput(IllegalInput::ContestStartedWhileContested),
                ObservationGapReason::IllegalInput(IllegalInput::ContestStartedInIllegalState),
            ]
        );
        same_set!("TeamId", TeamId::ALL, [TeamId::Home, TeamId::Away]);
        same_set!(
            "TeamRef",
            TeamRef::ALL,
            [TeamRef::Home, TeamRef::Away, TeamRef::Unknown]
        );
        same_set!(
            "Phase",
            Phase::ALL,
            [
                Phase::BuildUp,
                Phase::Progression,
                Phase::FinalThird,
                Phase::AttackingTransition,
                Phase::Unknown,
            ]
        );
        same_set!(
            "PhaseProvenance",
            PhaseProvenance::ALL,
            [
                PhaseProvenance::EngineHint,
                PhaseProvenance::Geometry,
                PhaseProvenance::Event,
                PhaseProvenance::Inherited,
                PhaseProvenance::Unknown,
            ]
        );
        // `IllegalInput::ALL` 必须覆盖 `ObservationGapReason` 里引用的那个代表成员，
        // 否则按 ALL 聚合 gap 时会漏掉 illegal_input 族。
        assert!(IllegalInput::ALL.contains(&IllegalInput::MatchStartedOutsideUninitialized));
        // 每个 `IllegalInput` 成员都非空且唯一（串名唯一性由既有测试覆盖）。
        assert_eq!(
            IllegalInput::ALL.len(),
            12,
            "IllegalInput 成员数变化时须同步本断言与真实调用点"
        );
    }

    #[test]
    fn gap_reason_counts_aggregate_by_reason_not_just_total() {
        // 「不变量/缺口覆盖要可诊断」：只有总数时无法区分「哪种缺口」——而不同原因的处置完全不同。
        let mut rec = kicked_off();
        rec.note_gap(
            tc(1.0),
            ObservationGapReason::MissingStreamEndBoundary,
            ControlFactBasis::StreamBoundary,
        );
        rec.note_gap(
            tc(2.0),
            ObservationGapReason::IllegalInput(IllegalInput::RestartTakenOutsideRestartPreparation),
            ControlFactBasis::EngineState,
        );
        rec.restart_taken(tc(3.0), ControlFactBasis::RestartRule); // 非法 → IllegalInput gap
        assert_eq!(rec.gap_count(), 3);
        let counts = rec.gap_reason_counts();
        let get = |r: ObservationGapReason| {
            counts
                .iter()
                .find(|(k, _)| *k == r)
                .map(|(_, n)| *n)
                .unwrap()
        };
        assert_eq!(get(ObservationGapReason::MissingStreamEndBoundary), 1);
        assert_eq!(
            get(ObservationGapReason::IllegalInput(
                IllegalInput::RestartTakenOutsideRestartPreparation
            )),
            2,
            "同一个 IllegalInput 成员的两条 gap（手记 + reject）必须聚合到一起"
        );
        assert_eq!(get(ObservationGapReason::HalfTimeDuringBallInFlight), 0);
        assert_eq!(counts.iter().map(|(_, n)| n).sum::<usize>(), 3);
        // ALL 必须覆盖全部 IllegalInput 成员，否则按原因聚合会静默漏掉整个 illegal_input 族。
        for member in IllegalInput::ALL {
            assert!(
                counts
                    .iter()
                    .any(|(k, _)| *k == ObservationGapReason::IllegalInput(*member)),
                "gap_reason_counts 缺少 IllegalInput::{:?} 的计数位",
                member
            );
        }
        // 手记的两条 gap 合法；最后那次 `restart_taken` 是 reject（非法输入），按 design §5
        // 保持 state 不推进 —— 但这里 episode 是被 **gap** 收束的（`reject` 关了它），
        // 所以「state Controlled 但无开放 episode」按设计是陈旧、不是缺陷。
        assert!(
            rec.invariant_violations().is_empty(),
            "{:?}",
            rec.invariant_violations()
        );
    }

    #[test]
    fn event_index_binding_is_guarded_against_tail_compaction() {
        // #3：`match_events` 尾部的 drain/filter/extend 会重排下标。绑定必须经
        // `bind_event_index`，落在压缩区间内时拒绝 + 记 gap，而不是静默错位。
        let mut rec = kicked_off();
        // 目标 fact 是最后一条 `control_established`（`kicked_off` 的最后一条事实）。
        let last = rec.facts().len() - 1;
        // 未登记边界 → 全部稳定，正常绑定。
        assert!(rec.bind_event_index(tc(0.5), EventIndexTarget::Fact(last), 0));
        assert_eq!(rec.facts()[last].source_event_index, Some(0));
        assert_eq!(rec.gap_count(), 0);
        // 登记边界：`[0, 5)` 稳定，`[5, ..)` 会被重排。
        rec.note_event_stream_compaction(5);
        assert!(
            rec.bind_event_index(tc(0.6), EventIndexTarget::Fact(last), 4),
            "稳定区间内必须可绑定"
        );
        // 目标 fact 的绑定必须更新（而不是绑到别的 fact 上——接口按 fact 下标寻址）。
        assert_eq!(rec.facts()[last].source_event_index, Some(4));
        assert_eq!(rec.facts().last().unwrap().source_event_index, Some(4));
        assert!(
            !rec.bind_event_index(tc(0.7), EventIndexTarget::Fact(last), 5),
            "压缩区间内必须拒绝绑定"
        );
        // 拒绝时**不覆盖**原来绑定的下标（失败不留半个绑定）。
        assert_eq!(
            rec.facts()[last].source_event_index,
            Some(4),
            "拒绝时不得改写绑定"
        );
        assert_eq!(rec.gap_count(), 1, "拒绝绑定必须留下可诊断的 gap");
        // 拒绝产生的 gap 自带 detail，可说明原因。
        assert!(
            rec.facts().last().unwrap().detail
                == Some(ControlFactDetail::Gap(
                    ObservationGapReason::EventIndexOutOfStableRange
                ))
        );
        // 越界 fact 下标同样拒绝（不留半个绑定、也不 panic），且原因可区分（不是压缩造成）。
        assert!(!rec.bind_event_index(tc(0.75), EventIndexTarget::Fact(9999), 0));
        assert_eq!(rec.gap_count(), 2);
        assert_eq!(
            rec.facts().last().unwrap().detail,
            Some(ControlFactDetail::Gap(
                ObservationGapReason::IllegalFactIndex
            ))
        );
        // 多次压缩取最小边界（更早的边界波及更长区间）。
        rec.note_event_stream_compaction(10); // 10 > 已登记的 5 → 仍取 5
        assert!(
            !rec.bind_event_index(tc(0.8), EventIndexTarget::Fact(last), 7),
            "取最小边界后 [5,..) 仍应被拒绝"
        );
        rec.note_event_stream_compaction(2); // 2 < 5 → 边界收紧
        assert!(
            !rec.bind_event_index(tc(0.9), EventIndexTarget::Fact(last), 4),
            "新登记的更早边界 2 会波及 4 → 应拒绝"
        );
        // 「边界 2 内的 1 仍可绑定」用一个**尚未绑定**的事实（0 号）来验：
        // `last` 当前已绑到 4，再绑 1 属**倒退重绑**，会被
        // `event_index_regressed` 守卫拦下（那是另一条规则，见
        // `rebinding_a_fact_event_index_must_not_move_it_backwards`）——两条规则混在同一个
        // fact 上会互相遮蔽，故此处换 fact。
        let unbound = 0usize;
        assert_eq!(rec.facts()[unbound].source_event_index, None);
        assert!(
            rec.bind_event_index(tc(1.0), EventIndexTarget::Fact(unbound), 1),
            "边界 2 内的 1 仍可绑定"
        );
        assert_eq!(rec.facts()[unbound].source_event_index, Some(1));
        assert_eq!(rec.gap_count(), 4);
        assert!(
            rec.invariant_violations().is_empty(),
            "{:?}",
            rec.invariant_violations()
        );
    }

    /// 重绑不得让一条事实的事件来源**倒退**（`event_index_regressed` gap）。
    ///
    /// 为什么需要：当前接线**依赖**「覆写总是发生在更晚的下标上」——
    /// `obs_goal_kick_delivered` 先用批量水位把死球类事实绑到**产生死球的**事件，再用
    /// `LastFactOfKind(RestartTaken)` 把 taken 改绑到**更晚的**门球交付事件。调用顺序若被
    /// 调换，事实来源会静默倒退，而所有现有断言都只查「不晚于事实时刻」→ 全绿。
    ///
    /// 判别力：删掉 `bind_event_index` 里的倒退检查，第 2 条断言（期望 gap）即红。
    #[test]
    fn rebinding_a_fact_event_index_must_not_move_it_backwards() {
        let mut rec = kicked_off();
        // 先绑到一个较晚的事件……（用 `Fact` 目标精确指定一条事实）
        let target = rec.facts().len() - 1;
        assert!(rec.bind_event_index(tc(0.1), EventIndexTarget::Fact(target), 9));
        assert_eq!(rec.gap_count(), 0);
        // ……再绑到更早的事件 → 必须拒绝并记 gap（不静默改写来源）。
        assert!(
            !rec.bind_event_index(tc(0.2), EventIndexTarget::Fact(target), 4),
            "倒退重绑必须被拒绝"
        );
        assert_eq!(rec.facts()[target].source_event_index, Some(9), "来源不得被改小");
        assert_eq!(rec.gap_count(), 1);
        assert_eq!(
            rec.facts().last().unwrap().detail,
            Some(ControlFactDetail::Gap(
                ObservationGapReason::EventIndexRegressed
            )),
            "gap 原因必须是具名的 `event_index_regressed`"
        );
        // 反证另一侧：**同值**重绑与**更晚**重绑都必须放行（否则正常接线会被误伤——
        // 门球那处正是「绑到更晚的交付事件」）。
        assert!(
            rec.bind_event_index(tc(0.3), EventIndexTarget::Fact(target), 9),
            "同值重绑应放行（幂等）"
        );
        assert!(
            rec.bind_event_index(tc(0.4), EventIndexTarget::Fact(target), 11),
            "绑到更晚的事件应放行"
        );
        assert_eq!(rec.gap_count(), 1, "放行的两次重绑不得再记 gap");
        assert!(
            rec.invariant_violations().is_empty(),
            "{:?}",
            rec.invariant_violations()
        );
    }

    #[test]
    fn episode_and_restart_event_indexes_go_through_the_same_guard() {
        // §14 A4：`event_indexes` 不得绕过 `bind_event_index` 直接入数组——否则尾部压缩的
        // 静默错位会进入分析对象。本测试钉住三件事：三条目标都能绑、压缩区间内一律拒绝、
        // 重复下标只入一次。
        let mut rec = kicked_off(); // 开放 episode(Home) + 已收束的 kickoff restart
                                    // kickoff sequence 已收束 → `OpenRestart` 是合法空操作（不是错误、不记 gap）。
        assert!(
            !rec.bind_event_index(tc(0.6), EventIndexTarget::OpenRestart, 3),
            "无开放 restart 时是合法空操作"
        );
        assert_eq!(rec.gap_count(), 0, "合法空操作不得记 gap");
        assert!(rec.bind_event_index(tc(0.7), EventIndexTarget::OpenEpisode, 3));
        assert!(rec.bind_event_index(tc(0.8), EventIndexTarget::OpenEpisode, 4));
        assert_eq!(rec.episodes()[0].event_indexes, vec![3, 4]);
        // 重复下标不重复入数组（同一提交点/相邻提交点重复报告同一事件）。
        assert!(rec.bind_event_index(tc(0.9), EventIndexTarget::OpenEpisode, 4));
        assert_eq!(
            rec.episodes()[0].event_indexes,
            vec![3, 4],
            "同一下标只入一次"
        );
        // 目标 fact 与 episode 各自独立：绑 fact 不写 episode 数组，反之亦然。
        assert_eq!(rec.facts().last().unwrap().source_event_index, None);

        // 开一条新 restart（界外球）→ `OpenRestart` 变成可绑目标。
        rec.dead_ball_started(
            tc(10.0),
            DeadBallReason::OutSideline,
            Some((TeamRef::Away, RestartKind::ThrowIn)),
            EpisodeEndReason::Out,
            ControlFactBasis::FinalizedOutcome,
        );
        assert!(rec.bind_event_index(tc(10.1), EventIndexTarget::OpenRestart, 5));
        assert_eq!(rec.restarts().last().unwrap().event_indexes, vec![5]);

        // 压缩边界登记后，可绑目标一律拒绝（守卫只写一次，不可能漏掉某一条）。
        // 注意 `OpenEpisode` 此刻**是**合法空操作：上面这次 `dead_ball_started` 已关闭了
        // 那个开放 episode，所以「没有开放对象」先于压缩校验生效——它不产 gap。
        rec.note_event_stream_compaction(5);
        assert!(!rec.bind_event_index(tc(11.0), EventIndexTarget::OpenEpisode, 5));
        assert!(!rec.bind_event_index(tc(11.1), EventIndexTarget::OpenRestart, 5));
        assert!(!rec.bind_event_index(tc(11.2), EventIndexTarget::Fact(rec.facts().len() - 1), 5));
        // 两条**有归属对象**的拒绝各留一条 gap，且原因都是「越出稳定区间」。
        assert_eq!(rec.gap_count(), 2, "只有目标存在的绑定才可能因压缩被拒");
        for f in rec.facts().iter().rev().take(2) {
            assert_eq!(
                f.detail,
                Some(ControlFactDetail::Gap(
                    ObservationGapReason::EventIndexOutOfStableRange
                ))
            );
        }
        assert!(
            rec.invariant_violations().is_empty(),
            "{:?}",
            rec.invariant_violations()
        );
    }

    #[test]
    fn suspended_binding_is_a_silent_no_op_not_a_gap() {
        // 排空期（尾部压缩）内下标尚未确定：绑定一律不生效，但**不记 gap**——
        // 排空期的事实本来就无法可靠归属事件，记 gap 会把正常路径稀释成噪声。
        let mut rec = kicked_off();
        rec.suspend_event_index_binding(true);
        assert!(rec.event_index_binding_suspended());
        assert!(!rec.bind_event_index(tc(1.0), EventIndexTarget::OpenEpisode, 7));
        assert!(!rec.bind_event_index(tc(1.1), EventIndexTarget::Fact(0), 7));
        assert_eq!(rec.gap_count(), 0, "暂停期绑定不得记 gap");
        assert!(rec.episodes()[0].event_indexes.is_empty());
        // 恢复后可正常绑定（暂停不是「永久关闭」）。
        rec.suspend_event_index_binding(false);
        assert!(rec.bind_event_index(tc(1.2), EventIndexTarget::OpenEpisode, 7));
        assert_eq!(rec.episodes()[0].event_indexes, vec![7]);
    }

    #[test]
    fn unattributed_facts_watermark_binds_exactly_the_new_facts() {
        // `UnattributedFacts` 的判别力：水位必须**只覆盖新增事实**，不能把已有事实刷成
        // 本次事件，也不能漏掉本批中的任何一条（一个提交点常产出多条），且**只推进一次**
        // （第二次扫描无事可做 → 合法空操作，否则会把事实反复改绑到更晚的事件上）。
        let mut rec = BehaviorObservationRecorder::enabled();
        rec.match_started(t0(), TeamRef::Home); // 2 条事实
        rec.restart_taken(tc(0.0), ControlFactBasis::RestartRule); // 1 条
                                                                   // **第一次**扫描把自开赛以来的全部事实绑到开球事件（真实路径正是这么做的：
                                                                   // `match_started` / prep / taken 都由那条 kickoff 事件触发）。
        assert!(rec.bind_event_index(tc(0.0), EventIndexTarget::UnattributedFacts, 1));
        let before = rec.facts().len();
        assert_eq!(before, 3);
        assert!(rec.facts().iter().all(|f| f.source_event_index == Some(1)));
        // 一次提交产出两条事实（`control_established` + `open_play_resumed`）。
        rec.control_established(
            tc(1.0),
            TeamId::Home,
            Some(10),
            None,
            EpisodeStartReason::Kickoff,
            None,
            ControlFactBasis::EngineState,
        );
        assert_eq!(rec.facts().len(), before + 2, "前提：这次提交产出两条事实");
        assert!(
            rec.bind_event_index(tc(1.0), EventIndexTarget::UnattributedFacts, 11),
            "有未归属事实时必须绑定"
        );
        // 本批**两条**都绑上（不是只绑最后一条——那正是覆盖率只有 47% 的旧行为）。
        for i in before..rec.facts().len() {
            assert_eq!(
                rec.facts()[i].source_event_index,
                Some(11),
                "fact[{}] 未被绑定",
                i
            );
        }
        // 早前的事实**不得**被改写（水位只覆盖新增）。
        for i in 0..before {
            assert_eq!(
                rec.facts()[i].source_event_index,
                Some(1),
                "fact[{}] 属于更早的提交点，不得被本次扫描改写",
                i
            );
        }
        // 第二次扫描：没有新事实 → 合法空操作（不返回成功、不改写任何绑定）。
        assert!(
            !rec.bind_event_index(tc(1.5), EventIndexTarget::UnattributedFacts, 12),
            "无未归属事实时必须是空操作"
        );
        assert_eq!(
            rec.facts()[before].source_event_index,
            Some(11),
            "空操作不得改绑"
        );
        assert_eq!(rec.gap_count(), 0, "空操作不得记 gap");
        assert!(
            rec.invariant_violations().is_empty(),
            "{:?}",
            rec.invariant_violations()
        );
    }

    #[test]
    fn unknown_basis_allows_non_finite_fact_time() {
        // design §8 的 `TimeBasis::Unknown` 是**显式**的「时间不可得」：此时 NaN 合法。
        // 但同一豁免不得变成 NaN 逃逸通道——NaN + 已知 basis 仍必须被判违规。
        let mut rec = BehaviorObservationRecorder::enabled();
        rec.note_gap(
            ObservedTime::unknown(),
            ObservationGapReason::MissingStreamEndBoundary,
            ControlFactBasis::StreamBoundary,
        );
        assert!(
            rec.invariant_violations().is_empty(),
            "Unknown basis 的 NaN 是合法值；实际 = {:?}",
            rec.invariant_violations()
        );
        // 反证：把 basis 换成已知的，同一个 NaN 必须立刻变红。
        let mut rec = BehaviorObservationRecorder::enabled();
        rec.match_started(
            ObservedTime::new(f64::NAN, TimeBasis::EventEmit),
            TeamRef::Home,
        );
        let v = rec.invariant_violations();
        assert!(
            v.iter().any(|m| m.contains("非有限值")),
            "NaN + 已知 basis 必须被判违规；实际 = {:?}",
            v
        );
    }

    #[test]
    fn detail_must_pair_with_its_fact_kind() {
        // 不变量 10 的反证：把 detail 塞到错的 kind 上必须被抓到（旧实现是 `Option<&str>`，
        // 任意文本可塞进任意 kind，下游按错语义解读）。现在 detail 是绑定 kind 的闭集联合。
        let mut rec = kicked_off();
        rec.facts[0].detail = Some(ControlFactDetail::DeadBall(DeadBallReason::Goal)); // kind = match_started
        let v = rec.invariant_violations();
        assert!(
            v.iter().any(|m| m.contains("不配对")),
            "kind 与 detail 不配对必须被抓到；实际 = {:?}",
            v
        );
    }
}
