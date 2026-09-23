//! #15A 比赛行为观察（Match Behavior Observation）
//!
//! 语义来源：`.scratch/notes/match-behavior-observation-design.md`（Approved for implementation，2026-09-23）。
//! 本模块**只**交付 Slice 1 的范围：闭集类型、recorder 骨架、opt-in 构造路径与不变量。
//! 引擎状态提交点的接入（kickoff/传球/抢断/射门 finalize/犯规/出界/哨声）属于 Slice 2，
//! 本文件不引用 `MatchState`、不读取事件文本、不做任何推断。
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
//! 另有两处**设计缺口**已在代码中就地标注（未自行发明语义）：
//!
//! - `FlightAction` 闭集（§10.1）没有 kickoff 成员 → [`flight_action_for`] 记 `Unknown`。
//! - `RestartEndReason` 闭集（§10.1）没有「被新死球顶掉」成员 → `dead_ball_started` 顶掉未完成的
//!   旧 sequence 时以 `RestartEndReason::Unknown` 结束。这是**正常**引擎路径（§5 第二张表），
//!   故不记 `observation_gap`；代价是 `gap_count() == 0` **不蕴含**所有 restart 都有明确结束原因
//!   （须看 `restart_sequences` 的 `end_reason`）。见 [`BehaviorObservationRecorder::dead_ball_started`]。
//!
//! # Slice 2 的接入对照表（本模块已就绪，Slice 2 只需在引擎提交点调用）
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
//!   所以这里应记 `restart_taken(EngineState)` **紧跟** `control_established(Home, 10, Kickoff)`
//!   （同一提交点 t=0），basis 用 `EngineState`（不是 `FinalizedOutcome`——没有高亮 finalize）。
//!   **不要**为它等 `kickoff_end`、也不要记 `BallInFlight`：那会记录一个引擎里不存在的飞行段。
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
//! | 引擎提交点（`lib.rs`） | 调用的命令 | 关键参数 |
//! |---|---|---|
//! | `simulate` 起点 | [`BehaviorObservationRecorder::match_started`] | `kicking = Home`（引擎开球恒主队）；时间当前为 `event_emit(0.0)`——Slice 2 若改在 `MatchState::new` 后按 `state_commit` 提交，须同步改本行、调用点与 `match_started_time_basis_is_event_emit_at_zero`（见 design §14 A3.1） |
//! | — | — | **本引擎没有中场休息**，无「下半场重新开球」提交点（见疑问 5） |
//! | 首开球 kickoff emit（t=0.0） | `restart_taken` **+ `control_established`** | 同在 t=0：`EngineState`（引擎已在 `MatchState::new` 提交 `carrier=10`）；**没有飞行等待**（见开球专线 1） |
//! | `advance_dead_ball` 的 `kickoff_again` whistle | `restart_preparation_started` | `(对方队, Kickoff)` + `RestartRule`；**不是哨声边界**（见开球专线 3） |
//! | `advance_dead_ball` 的 kickoff 段（emit） | `restart_taken` | `RestartRule` |
//! | `advance_dead_ball` 的 kickoff `kickoff_end` 时刻 | `control_established` | 开球接收者 + `Kickoff`；basis `EngineState`，时间 `DeterministicFlightEnd`（**只此一处等飞行**） |
//! | `advance_restart_prep` 的发球高亮 | `restart_taken` | `RestartRule`；准备期由 `start_corner` / `start_throw_in` 的 `restart_prep` 设立 |
//! | `finalize_highlight` `PassCaught` | `control_established` | 同队 → 延续；异队 → `prior_episode_end = Some(ControlLost)` |
//! | ~~`finalize_highlight` `PassIntercepted`（明确控制）~~ | **不存在该分支** | 引擎的 `PassIntercepted` 只启动松散球（`st.carrier = -1`）；拦截者控制一律经 `advance_loose` pickup 提交 → 按下一行处理 |
//! | `finalize_highlight` `PassIntercepted` | `contest_started` | `InterceptionLoose` + `ControlLost` |
//! | `finalize_highlight` `PassLost` | `contest_started` | `PassLost` + `ControlLost` |
//! | `finalize_highlight` `ShotGoal` | `dead_ball_started`（**只此一条**） | `Goal` + (对方, `Kickoff`) + `Goal`；准备期由后面的 `kickoff_again` whistle 记（见开球专线 3），此处**不得**再补 prep |
//! | `finalize_highlight` `ShotSavedCaught` | `control_established` | 门将队 + `SavedCaught`（无重开） |
//! | `finalize_highlight` `ShotSavedRebound` | `contest_started` | `ShotRebound` + `ShotRebound` |
//! | `finalize_highlight` `ShotOffTarget` | `dead_ball_started` | `Unknown` 或按重开结果，`Out` |
//! | `finalize_highlight` `PassOutOfPlay` | `dead_ball_started` | `OutSideline` / `OutGoalLine` + `out_restart_for` |
//! | `finalize_highlight` `CornerAward`（射门扑出越线） | `dead_ball_started` | 引擎在 `start_corner` 内隐式进重开 → 需**补报** `dead_ball_started(OutGoalLine/Goal, (进攻方, Corner), Out)` |
//! | `finalize_highlight` `TackleSuccess` | `contest_started` | `TackleLoose` + `ControlLost` |
//! | `finalize_highlight` `TackleFail` | 不调用（episode 延续） | — |
//! | `advance_loose` 拾取 | `control_established` | `Pickup` / `RestartControl` |
//! | `emit_shot_highlight` / 各类 pass 高亮 | `control_released_into_flight` | 对应 `FlightAction` |
//! | `advance_restart_prep` 触发的发球 | `restart_taken` | 已在重开准备期，直接 taken |
//! | `emit_foul_and_free_kick` | `dead_ball_started` **+ `restart_preparation_started`** | `Foul` + (被犯规方, `FreeKick`) + `Foul`；引擎随后进入 `restart_prep`，必须显式准备 |
//! | `start_corner` / `start_throw_in` | `restart_preparation_started` | 二者都设 `restart_prep`（有准备期）；归属可 `Unknown`，后续细化。**若此前没过 `dead_ball_started`，先补一条** |
//! | `start_goal_kick` | **待设计确认**，见下方疑问 | 引擎**没有准备期**（同步产 pass 高亮，不设 `restart_prep`），见疑问 4 |
//! | 流末 whistle（`detail = "half_time"`，`lib.rs` 循环结束后唯一一条尾推哨） | [`commit_stream_end_boundary`]（内部调 `full_time`） | `t` **取自该 whistle 事件本身**（[`stream_end_boundary`]）；该提交函数**不接收任何时长参数**，`config.match_duration_seconds` 结构上成不了第二来源（见坑 6）；**该 whistle 是流边界，不是中场哨**（见疑问 5） |
//!
//! ## 事件下标绑定规则（`source_event_index` / `event_indexes`）
//!
//! 下标一律指 [`DiagnosticMatch::events`] 的**最终**下标（不是记录时刻的临时长度）。绑定必须经
//! [`BehaviorObservationRecorder::bind_event_index`]，它会拒绝落在尾部压缩区间内的下标。
//!
//! **Slice 1 现状**：`bind_event_index` 只写 `ControlFact.source_event_index`；
//! `PossessionEpisode.event_indexes` / `RestartSequence.event_indexes` **还没有绑定入口**
//! （保持空数组）。Slice 2 为它们接线时需扩展本接口——**不得**绕过它直接下标入数组，
//! 否则尾部压缩的错位会静默进入 episode/restart 分析对象。
//!
//! **边界登记尚未生效（勿读成 guard 已在生产路径上生效）**：生产 opt-in 路径上
//! `stable_event_prefix` 恒为 `None`（= 全部下标视为稳定），因为 `match_events` 拿不到 recorder
//! 句柄，`events_note_compaction_boundary` 目前是空实现。所以 `bind_event_index` 的拒绝分支在生产
//! 路径上一次也不会触发——它只在测试里被真边界验证过。Slice 2 要在排空期绑定下标，**必须先接通
//! 那个登记点**；在那之前排空期提交点一律传 `None`（靠 `t` + `detail` 定位事实）。
//!
//! 原因：`match_events` 在循环结束后对 `events[drain_start..]` 做 `drain` → `filter`（同时间戳
//! beat 去重）→ `extend` 回填，**该区间内的下标会被重排**；`drain_start` 之前的元素位置不变。
//! 所以：
//!
//! - 循环体内（`tick` / `advance_*` 提交点）绑定 `events.len() - 1` 是安全的；
//! - 排空期（`while st.highlight.is_some()` 里的 `finalize_highlight`）绑定**不安全**——该区间的
//!   beat 可能被去重丢弃，下标会前移。Slice 2 在这些提交点上应传 `None`（事实仍有 `t` 与
//!   `detail` 可定位），或在压缩完成后再补绑定；
//! - 引擎在压缩点调用 `events_note_compaction_boundary(drain_start)` 登记边界（**Slice 1 是
//!   无副作用占位**：`match_events` 没有 recorder 句柄，见 `lib.rs` 该函数的文档）；
//!   recorder 侧 [`BehaviorObservationRecorder::note_event_stream_compaction`] 据此拒绝
//!   越界绑定并记 `observation_gap`（不静默错位）。
//!
//! 未登记边界时（如 demo 路径、无尾部压缩）视为「全部下标稳定」。
//!
//! 易踩的坑（Round 4/5/6 审阅对 `lib.rs` 控制流实测；编号沿用历史，第 3 条已并入疑问 5）：
//!
//! 1. **`dead_ball_started` 之后必须进入准备期**再 `restart_taken`，但**谁来记 prep 取决于路径**：
//!    goal 由 `kickoff_again` whistle 记一次（庆祝结束、`preparing = true` 的同一刻，见开球专线 3）；
//!    foul 没有对应提交点，必须在 `emit_foul_and_free_kick` 处显式补一条。
//!    两条路径都缺 prep 时 `restart_taken` 会被判非法（记 gap）；但 goal 路径**多记一次**同样错
//!    （见开球专线 3 的告警）。（**例外见疑问 4**：门球连准备期都没有。）
//! 2. **`CornerAward` 没有 `dead_ball_started`**（引擎在 `finalize_highlight` 里直接 `start_corner`）→
//!    必须补报死球，否则重开序列缺死球来源。
//! 3. （已并入疑问 5：本引擎没有中场休息，无可接线的半场提交点。）
//! 4. **门球（`start_goal_kick`）与 design §6.2 的统一生命周期冲突——待设计确认，本 slice 不擅自决定。**
//!    引擎 `start_goal_kick` 同步发 pass 高亮、**不设 `restart_prep`**，因此没有 `restart_taken`
//!    提交点；而 §6.2 要求所有重开走 `dead_ball_started → restart_preparation_started →
//!    restart_taken → open_play_resumed`。两条路径都不能靠猜：
//!    (a) 补记一个零长度的 `restart_preparation_started` + `restart_taken` = 记录一个引擎里
//!        不存在的阶段（发明事实）；
//!    (b) 直接 `control_established` 收束 = 门球后 `state` 仍是 `DeadBall`，该调用会被判非法
//!        （记 gap），sequence 的 `taken_t` / `open_play_resumed_t` 都留 `None`、`end_reason` 留空。
//!    纯从 recorder 侧无法两全 → 需要设计明确「门球是否属于 §6.2 的例外」§6.2 已为半场/终场开了
//!    例外先例。**Slice 2 遇到门球前先解决此疑问**，不要临时选一条。
//!
//!    Round 6 实测两条（别按想象接线）：选项 (b) 只是**让该 sequence 一直悬着**，直到
//!    `full_time()`（或后续合法的 `dead_ball_started`）才补上 `end_reason`——它**不会**触发
//!    不变量 5（`taken_t == None` 且 `open_play_resumed_t == Some` 这个组合经公开 API 不可达）。
//!    不要指望不变量 5 替你兜住门球路径。
//! 5. **本引擎没有中场休息——design §5.1 的「下半场重新进入 `RestartPreparation(kickoff)`」没有对应提交点。**
//!    `match_events` 是单段循环 `while t < dur`，结束后只在 `dur` 推一条 `detail = "half_time"`
//!    的 whistle（lib.rs）；没有中场哨复位、没有第二段循环、没有下半场开球。那条 whistle 是
//!    **流边界**，opt-in 路径因此把它映射为 `full_time`。`half_time()` 在 Slice 1 无调用点，
//!    是留给引擎将来真正实现中场休息时的骨架。**Slice 2 不得按本表想象一个中场提交点。**
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
//! `kickoff_again` whistle（坑外的第三条专线，见上文）：**不调用任何 whistle 命令**。它既不是
//! 半场也不是终场，而是进球庆祝结束、开球准备开始的转场（同一条 kickoff `RestartSequence`
//! 仍在进行中）。
//!
//! 未列动作（design §5「未列动作视为冲突输入」）走 [`BehaviorObservationRecorder::note_gap`]，
//! **不要**自己猜测一个 team / kind / 时间填进去。
//!
//! 本表是**候选映射**：每一行在 Slice 2 接线时都必须对照 `lib.rs` 的实际控制流复核一遍
//! （Round 4/5 两轮都在本表里查到过错行）。

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
}

impl ObservationGapReason {
    pub const ALL: &'static [ObservationGapReason] = &[
        ObservationGapReason::HalfTimeDuringBallInFlight,
        ObservationGapReason::FullTimeDuringBallInFlight,
        ObservationGapReason::MissingStreamEndBoundary,
        ObservationGapReason::EventIndexOutOfStableRange,
        ObservationGapReason::IllegalFactIndex,
        ObservationGapReason::IllegalInput(IllegalInput::MatchStartedOutsideUninitialized),
        ObservationGapReason::IllegalInput(IllegalInput::DeadBallStartedInIllegalState),
        ObservationGapReason::IllegalInput(IllegalInput::RestartPreparationOutsideDeadBall),
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

/// 球在飞行中的出球类型（design §10.1、§5）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FlightAction {
    Pass,
    Clearance,
    Shot,
    Corner,
    ThrowIn,
    FreeKick,
    GoalKick,
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
            FlightAction::Unknown => "unknown",
        }
    }
}

/// 重开片段的结束方式（design §10.1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RestartEndReason {
    OpenPlayResumed,
    TerminatedByWhistle,
    MatchEnd,
    Unknown,
}

impl RestartEndReason {
    /// 闭集全成员（守护「闭集完整性」：新增成员时串名/单调性测试会因漏列而红）。
    pub const ALL: &'static [RestartEndReason] = &[
        Self::OpenPlayResumed,
        Self::TerminatedByWhistle,
        Self::MatchEnd,
        Self::Unknown,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            RestartEndReason::OpenPlayResumed => "open_play_resumed",
            RestartEndReason::TerminatedByWhistle => "terminated_by_whistle",
            RestartEndReason::MatchEnd => "match_end",
            RestartEndReason::Unknown => "unknown",
        }
    }
}

/// 开放 episode 的开启原因（design §10.1）。
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

/// 进入争抢的原因（design §10.1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ContestStartReason {
    PassLost,
    InterceptionLoose,
    TackleLoose,
    ShotRebound,
    Unknown,
}

impl ContestStartReason {
    /// 闭集全成员（守护「闭集完整性」：新增成员时串名/单调性测试会因漏列而红）。
    pub const ALL: &'static [ContestStartReason] = &[
        Self::PassLost,
        Self::InterceptionLoose,
        Self::TackleLoose,
        Self::ShotRebound,
        Self::Unknown,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            ContestStartReason::PassLost => "pass_lost",
            ContestStartReason::InterceptionLoose => "interception_loose",
            ContestStartReason::TackleLoose => "tackle_loose",
            ContestStartReason::ShotRebound => "shot_rebound",
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
    /// **0 不等于「一切都有明确证据」**：`RestartSequence` 被新死球顶掉时以
    /// `RestartEndReason::Unknown` 结束（闭集无对应成员，属 §10.1 允许的「证据不足」），
    /// 该路径不产 gap。判断重开闭合质量须同时看 `restart_sequences` 的 `end_reason`。
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

/// 只读观察器：接收引擎状态提交点提交的事实，维护 episode / restart / contest 的开闭。
///
/// **它不是第二个比赛状态机**：不参与决策、不持有 RNG、不读写 `MatchState`。
///
/// `enabled == false` 时所有命令都是空操作，且不分配任何事实。
/// **现状（Slice 1，勿按计划读）**：`simulate()` 目前根本不构造 recorder——它直接走
/// `match_events` + `events_to_json`，因此正式路径的零成本是**结构性的**（没有被观察代码调用），
/// 不是靠这里的分支做到的。`disabled()` 是为 Slice 2 准备的：届时若把 recorder 接进
/// `match_events` 的公共路径，用 `disabled()` 就能保住正式路径零成本。
/// `disabled_recorder_is_a_no_op` 只验证「关闭时命令无效」这一个契约，**不**证明正式路径已用它。
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
    /// `RestartEndReason::Unknown` 结束（§10.1 闭集没有对应成员，属「证据不足」），
    /// **不**记 `observation_gap`——正常路径上记 gap 会把该信号稀释成噪声。
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
        // 该表把它列为**正常**转场）。§6.2 只为重开给了 `open_play_resumed` /
        // `terminated_by_whistle` / `match_end` 三种结束方式，没有「被新死球顶掉」这一成员 →
        // 结束原因只能用 `RestartEndReason::Unknown`。这属于 §10.1 允许的用法（「输入证据不足」：
        // 闭集里根本没有对应成员），故**不**记 `observation_gap`——gap 表示 recorder 遇到未覆盖
        // 或矛盾输入，而在引擎正常路径上记 gap 会把该信号稀释成噪声。
        //
        // 该重开状态可由记录本身区分：`end_reason == Some(Unknown)` 且没有 `open_play_resumed_t`
        // 的 sequence 就是被顶掉的那条。**因此 `gap_count() == 0` 不蕴含所有 restart 都有明确的
        // 结束原因**——Slice 4 的基线若要断言重开闭合质量，须同时看 `restart_sequences`。
        self.close_restart(t, RestartEndReason::Unknown);
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
        match self.open_restart {
            Some(i) => {
                let (have_team, have_kind) = (self.restarts[i].team, self.restarts[i].kind);
                // 只有「两边都已确定却互不相同」才是矛盾。任一侧为 `Unknown` 时不拒绝——
                // spec 的「未知重开归属」场景要求**继续等待可确认的状态提交**（不推断具体球队），
                // 在此细化类型/归属正是该要求；若直接拒绝，该 sequence 会永久卡在 unknown。
                let kind_conflict = have_kind != RestartKind::Unknown
                    && kind != RestartKind::Unknown
                    && have_kind != kind;
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
            }
            None => {
                self.open_new_restart(team, kind, t);
            }
        }
        // 事实与派生状态都取**细化后**的权威值：本次调用可能带着 `Unknown` 来，而记录里已有
        // 更明确的证据（或反之）。若把调用参数直接写进 `state`，`state.kind` 会**比记录更差**，
        // 后续 `restart_taken` 就会把已知的重开方式降级成 `Unknown`（「不猜」的反面：丢掉已知事实）。
        let (team, kind) = match self.open_restart {
            Some(i) => (self.restarts[i].team, self.restarts[i].kind),
            // `open_new_restart` 刚创建，记录即本次传参。
            None => (team, kind),
        };
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

    /// 首次明确控制（design §5：`match_started`/`restart_taken` 之后的唯一入口）。
    ///
    /// - 有开放 restart 且球在飞行 → 记 `open_play_resumed` 并关闭该 sequence；
    /// - 有开放 episode 且同队 → **延续**（不关闭、不改 start_reason）；
    /// - 有开放 episode 且异队 → 关闭旧 episode（`prior_episode_end`，`None` 时按 `control_lost`）
    ///   并开启新 episode；
    /// - 无开放 episode（重开后的首次控制 / pickup）→ 开启新 episode。
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
        start_reason: EpisodeStartReason,
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

    /// 给最后一条 fact 绑定正式事件下标（见模块头「事件下标绑定规则」）。
    ///
    /// 下标落在压缩区间内时**不绑定**并记一条 `observation_gap`
    /// （[`ObservationGapReason::EventIndexOutOfStableRange`]）——静默错位比不绑定更糟，
    /// 因为下游无法察觉。返回是否绑定成功。
    ///
    /// `t` 是失败时那条 gap 事实的时间（调用方知道当前时刻，故不需要 `Unknown` 兜底）。
    pub fn bind_event_index(
        &mut self,
        t: ObservedTime,
        fact_index: usize,
        event_index: usize,
    ) -> bool {
        if !self.enabled {
            return false;
        }
        // 先校验下标本身，再校验目标 fact 存在——失败时不留半个绑定。
        if fact_index >= self.facts.len() {
            self.note_gap(
                t,
                ObservationGapReason::IllegalFactIndex,
                ControlFactBasis::EngineState,
            );
            return false;
        }
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
        self.facts[fact_index].source_event_index = Some(event_index);
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
/// `Kickoff` 在 `FlightAction` 闭集中没有对应项——开球拨球在语义上是最短传出球，但 recorder 不代
/// 设计做等价映射（不猜），记为 `unknown`。这是一处**待设计确认的缺口**（见模块头注释）。
fn flight_action_for(kind: RestartKind) -> FlightAction {
    match kind {
        RestartKind::Corner => FlightAction::Corner,
        RestartKind::ThrowIn => FlightAction::ThrowIn,
        RestartKind::FreeKick => FlightAction::FreeKick,
        RestartKind::GoalKick => FlightAction::GoalKick,
        RestartKind::Kickoff | RestartKind::Unknown => FlightAction::Unknown,
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
                FlightAction::Unknown.as_str(),
            ],
        );
        check(
            "RestartEndReason",
            &[
                RestartEndReason::OpenPlayResumed.as_str(),
                RestartEndReason::TerminatedByWhistle.as_str(),
                RestartEndReason::MatchEnd.as_str(),
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
        // design §5 第二张表把「新死球终止旧 sequence」列为**正常**转场；`RestartEndReason` 闭集
        // 没有对应成员，故以 `Unknown` 结束（§10.1 允许的「证据不足」），**不**记 gap
        // ——在正常路径上记 gap 会把该信号稀释成噪声。
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
        assert_eq!(superseded.end_reason, Some(RestartEndReason::Unknown));
        assert_eq!(rec.gap_count(), 0, "被顶掉的重开是正常转场，不得记 gap");
        // 代价明示：gap_count == 0 不蕴含重开都有明确结束原因——这是本测试要钉住的语义，
        // 防止 Slice 4 把 gap_count==0 当成「重开闭合质量」的充分证据。
        assert!(rec
            .restarts()
            .iter()
            .any(|r| r.end_reason == Some(RestartEndReason::Unknown)));
        assert!(
            rec.invariant_violations().is_empty(),
            "{:?}",
            rec.invariant_violations()
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
        assert_eq!(a.gap_count(), 0, "Slice 1 的最小事实路径不产 gap");
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
    fn slice1_lifecycle_facts_start_and_close_the_match() {
        // **Slice 1 生命周期占位**（不是「完整比赛已被观察」的承诺）：opt-in API 此刻只提交
        // 比赛生命周期端点（match_started / match_ended，加上开球自身的
        // restart_preparation_started）。引擎各状态提交点的接入是 Slice 2 的工作。
        // 此处钉死该最小契约，防止 Slice 2 前误以为已接入；Slice 2 完成后本测试必须改写成
        // 真实比赛路径断言（否则会挡住新事实）。
        // 旧名 `minimal_slice1_facts_start_and_close_the_match` 读起来像「比赛已被完整观察」，
        // 属于虚假承诺，故改名。
        let cfg = MatchConfig::default_();
        let dm = simulate_with_behavior_observations(1, cfg);
        let kinds: Vec<&str> = dm.control_facts.iter().map(|f| f.kind.as_str()).collect();
        assert_eq!(
            kinds,
            vec![
                "match_started",
                "restart_preparation_started",
                "match_ended"
            ]
        );
        // 开球重开未 taken 就被终场哨终止（design §6.2 的例外路径）。
        assert_eq!(dm.restart_sequences.len(), 1);
        assert_eq!(dm.restart_sequences[0].kind, RestartKind::Kickoff);
        assert_eq!(dm.restart_sequences[0].taken_t, None);
        assert_eq!(
            dm.restart_sequences[0].end_reason,
            Some(RestartEndReason::MatchEnd)
        );
        assert!(dm
            .events
            .iter()
            .any(|e| e.type_ == crate::EventType::Whistle));
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
                ObservationGapReason::IllegalInput(IllegalInput::MatchStartedOutsideUninitialized),
                ObservationGapReason::IllegalInput(IllegalInput::DeadBallStartedInIllegalState),
                ObservationGapReason::IllegalInput(IllegalInput::RestartPreparationOutsideDeadBall),
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
            11,
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
        assert!(rec.bind_event_index(tc(0.5), last, 0));
        assert_eq!(rec.facts()[last].source_event_index, Some(0));
        assert_eq!(rec.gap_count(), 0);
        // 登记边界：`[0, 5)` 稳定，`[5, ..)` 会被重排。
        rec.note_event_stream_compaction(5);
        assert!(
            rec.bind_event_index(tc(0.6), last, 4),
            "稳定区间内必须可绑定"
        );
        // 目标 fact 的绑定必须更新（而不是绑到别的 fact 上——接口按 fact 下标寻址）。
        assert_eq!(rec.facts()[last].source_event_index, Some(4));
        assert_eq!(rec.facts().last().unwrap().source_event_index, Some(4));
        assert!(
            !rec.bind_event_index(tc(0.7), last, 5),
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
        assert!(!rec.bind_event_index(tc(0.75), 9999, 0));
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
            !rec.bind_event_index(tc(0.8), last, 7),
            "取最小边界后 [5,..) 仍应被拒绝"
        );
        rec.note_event_stream_compaction(2); // 2 < 5 → 边界收紧
        assert!(
            !rec.bind_event_index(tc(0.9), last, 4),
            "新登记的更早边界 2 会波及 4 → 应拒绝"
        );
        assert!(
            rec.bind_event_index(tc(1.0), last, 1),
            "边界 2 内的 1 仍可绑定"
        );
        assert_eq!(rec.facts()[last].source_event_index, Some(1));
        assert_eq!(rec.gap_count(), 4);
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
