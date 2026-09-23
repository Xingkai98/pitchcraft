# #15A/#15B：比赛行为观察设计

状态：Approved for implementation

日期：2026-09-22；审阅通过：2026-09-23

## 1. 目标

在不改变现有比赛生成决策、不改变正式 `Event` 演绎协议的前提下，由引擎记录比赛过程中已经确认的控制权事实，并输出独立的行为诊断 sidecar。

本设计使用领域名 **Match Behavior Observation**，避免与现有页面诊断队列 `match-observation` 混淆。

## 2. 非目标

- 不重写 `MatchState.possession` 的现有含义；
- 不从最终 `MatchState` 事后重建整场过程；
- 不把 `tackle success`、`pass lost`、`shot` 等动作结果直接等价为控球事实；
- 不在 #15A 定义战术 phase；
- 不改变 viewer 正式播放输入；
- 不引入 RNG。

## 3. 架构

```text
MatchState 状态变化提交点
        │
        ▼
BehaviorObservationRecorder
        │  append-only facts，零 RNG
        ▼
DiagnosticMatch {
  events,
  control_facts,
  possession_episodes,
  restart_sequences,
  phase_segments       // #15B，第一版可为空
}
```

`simulate()` 保持现有返回和行为不变。新增 opt-in API：

```text
simulate_with_behavior_observations(seed, config) -> DiagnosticMatch
```

第一版仅 Rust/native 诊断使用；WASM/viewer 是否暴露由后续票据决定。

## 4. 事实记录，而不是复制状态机

Recorder 不成为第二个比赛状态机，不参与决策。它只在生产状态已经提交后记录事实：

```text
ControlFact {
  t
  kind
  team?
  player?
  location?
  source_event_index?
  basis                // engine_state | finalized_outcome | restart_rule
}
```

第一版 `kind`（仅为阅读示意，完整实现以紧随其后的闭集定义为准）：

```text
match_started
control_established
control_released
contest_started
dead_ball_started
restart_preparation_started
restart_taken
match_ended
```

闭集定义：

```text
ControlFactKind = match_started | control_established | control_released |
  contest_started | contest_ended | dead_ball_started |
  restart_preparation_started | restart_taken | open_play_resumed |
  observation_gap | match_ended

ControlFactBasis = engine_state | finalized_outcome | restart_rule | stream_boundary
```

Recorder 不读取事件文本反推事实；事实发生后可绑定产生它的 event index。

## 5. 行为观察状态

这是 sidecar 的派生状态，不替换 `MatchState.possession`：

```text
BehaviorControlState =
  Uninitialized
  Controlled { team, carrier? }
  Contested { previous_team?, location }
  BallInFlight { originating_team, action }
  DeadBall { reason, restart_team? }
  RestartPreparation { team, kind }
  Ended
```

`BallInFlight` 用于传球、射门、解围和定位球发出后、结果 finalize 前的时段。它不自动终止 possession episode；最终结果决定原 episode 延续、终止或转为 contest。

### 5.1 完整状态转换表

| 当前状态 | 确认事实 | 下一状态 | episode/restart 语义 |
|---|---|---|---|
| `Uninitialized` | `match_started` | `RestartPreparation(kickoff)` | 创建开球 `RestartSequence`，不创建开放 episode |
| `RestartPreparation` | `restart_taken` | `BallInFlight` | 记录 `restart_taken`，等待球被控制 |
| `BallInFlight` | restart 后同队控制建立 | `Controlled` | 关闭 `RestartSequence(open_play_resumed)`，开启新 episode |
| `Controlled` | 成功接球/继续控制 | `Controlled` | 当前 episode 延续，更新 carrier |
| `Controlled` | pass/dribble/shot/restart 出球 | `BallInFlight` | 不立即关闭 episode；记录动作与来源 |
| `BallInFlight` | 同队控制建立 | `Controlled` | 当前 episode 延续或建立新 episode |
| `BallInFlight` | 对手明确控制建立 | `Controlled` | `control_released`，关闭旧 episode，开启新 episode |
| `BallInFlight` | 进入 loose/二点争抢 | `Contested` | `control_released`，关闭旧 episode，等待 pickup |
| `Contested` | 某队 pickup/控制建立 | `Controlled` | 开启 pickup 队新 episode |
| `Controlled`/`Contested` | 已确认出界 | `DeadBall` | 关闭 episode/contest，创建对应 `RestartSequence` |
| `Controlled`/`BallInFlight` | 犯规判罚确认 | `RestartPreparation` | 关闭开放 episode；创建犯规重开 sequence |
| `Controlled`/`BallInFlight` | 半场哨 | `DeadBall(half_time)` | 关闭/挂起当前段；不创建 restart sequence |
| 任意非 `Ended` 状态 | 终场哨 | `Ended` | 关闭所有 episode/contest；未完成 flight/restart 记录 `observation_gap` |
| `DeadBall` | 有重开安排 | `RestartPreparation` | 进入已有 restart sequence |
| `DeadBall` | 无重开安排（半场/终场） | `DeadBall` 或 `Ended` | 不创建 sequence |

补充规则：下表覆盖每个稳定状态的控制、死球和哨声出口；未列动作视为矛盾输入，记录 `observation_gap`，不自行推进状态。

| 当前状态 | 控制建立 | 死球确认 | 半场哨 | 终场哨 |
|---|---|---|---|---|
| `Uninitialized` | 非法，gap | 非法，gap | `DeadBall(half_time)` | `Ended` |
| `Controlled` | 延续/更新 carrier | `DeadBall(reason)`，关闭 episode，按矩阵创建 sequence | 关闭 episode，`DeadBall(half_time)` | 关闭 episode，`Ended` |
| `BallInFlight` | 按来源进入同队/对手 `Controlled` 或 `Contested` | finalize 后按结果处理 | 记录 gap fact，episode=`whistle_interrupt`，`DeadBall(half_time)` | 记录 gap fact，episode=`whistle_interrupt`，`Ended` |
| `Contested` | pickup 队 `Controlled`，开启 episode | 关闭 contest，`DeadBall(reason)`，按矩阵创建 sequence | 关闭 contest，`DeadBall(half_time)` | 关闭 contest，`Ended` |
| `DeadBall` | 仅允许 restart taken | 新死球终止旧 sequence，按最新结果重建 | 保持 `DeadBall(half_time)` | `Ended` |
| `RestartPreparation` | 必须先 taken | 终止旧 sequence，按最新结果重建 | sequence=`terminated_by_whistle`，`DeadBall(half_time)` | sequence=`match_end`，`Ended` |
| `Ended` | 非法 | 非法 | 保持 | 保持 |

`match_started` 唯一负责 `Uninitialized → RestartPreparation(kickoff)`；`restart_taken` 统一负责 `RestartPreparation → BallInFlight`；首次明确控制统一负责进入 `Controlled`。

`half_time` 使用 `DeadBall(half_time)` 而不是 `Ended`；下半场重新进入 `RestartPreparation(kickoff)`。`full_time` 才进入 `Ended`。

## 6. 两种分析对象

### 6.1 PossessionEpisode

球队在开放比赛中已经建立控制的连续片段：

```text
PossessionEpisode {
  id
  team
  start_t
  end_t?
  start_reason
  end_reason?
  control_fact_indexes[]
  event_indexes[]
}
```

### 6.2 RestartSequence

死球判定到重新进入开放比赛的片段：

```text
RestartSequence {
  id
  team
  kind
  start_t
  taken_t?
  open_play_resumed_t?
  event_indexes[]
  end_reason?
}
```

所有死球来源统一走以下生命周期：

```text
dead_ball_started
→ restart_preparation_started
→ restart_taken
→ BallInFlight
→ open_play_resumed（首次明确控制）
```

例外：半场、终场、重开未完成就被终止。此时 sequence 可以没有 `taken_t`，以 `terminated_by_whistle` 或 `match_end` 结束。定位球不会伪装成普通开放比赛 possession；重开发出并由某队明确控制后，才开启新的 `PossessionEpisode`。

### 6.3 死球来源矩阵

| 来源 | `dead_ball_started` | 是否创建 sequence | sequence team/kind | 正常结束 |
|---|---|---|---|---|
| goal | goal finalize | 是 | 对方队 / kickoff | kickoff 后首次明确控制 |
| out sideline | out finalize | 是 | 规则决定的掷球队 / throw_in | 界外球后首次明确控制 |
| out goal line | out finalize | 是 | 防守方 / goal_kick 或进攻方 / corner | 重开后首次明确控制 |
| foul | foul 判罚提交 | 是 | 被犯规方 / free_kick | 任意球后首次明确控制 |
| half time | half-time whistle | 否 | — | 下半场重新创建 kickoff sequence |
| full time | full-time whistle | 否 | — | 直接 `Ended` |
| shot off target | finalize 确认出界 | 是 | 规则决定 / goal_kick 或 corner | 重开后首次明确控制 |
| saved caught | shot finalize | 否 | — | 门将控制建立，开启新 episode |
| saved rebound | shot finalize | 否 | — | `Contested`，等待 pickup |

shot emit、pass emit、tackle emit 本身不创建 `RestartSequence`；只有死球结果确认后才创建。

`RestartSequence.team` 规则：goal 取对方队；sideline 取最后触球对方队；goal line 取防守方（goal kick）或进攻方（corner）；foul 取被犯规方；无法确定时为 `unknown`，不猜。

## 7. 控制权确认规则

原则：**动作成功不等于控制建立；只有生产状态提交点能确认控制。**

| 路径 | 记录时机 | 结果 |
|---|---|---|
| kickoff / 成功传球 | 高亮 finalize、receiver 已成为 `carrier` | 同队则延续 episode；无开放 episode 则建立控制 |
| `pass intercepted` | 高亮 finalize 后进入 loose/明确控制 | 明确控制才切换；否则 `Contested` |
| `pass lost` | 高亮 finalize、启动 loose ball | `Contested`，不立即给对手 |
| tackle success | tackle finalize | 若启动 loose ball则 `Contested`；只有后续 pickup 才建立控制 |
| tackle fail | finalize 后原 carrier 仍控制 | 原 episode 延续 |
| loose-ball pickup | `advance_loose` 提交新 `carrier/possession` | pickup 队建立控制；必要时关闭旧 episode |
| shot in flight | shot emit | `BallInFlight`，暂不决定 episode 结局 |
| goal | shot finalize | 原 episode 以 `goal` 结束，进入 `DeadBall` |
| saved caught | shot finalize、门将成为 carrier | 原 episode 以 `saved_caught` 结束；门将队建立新控制 episode |
| saved rebound | shot finalize、启动 loose | 原 episode 以 `shot_rebound` 结束，进入 `Contested` |
| off target | shot finalize | 以实际重开/出界结果进入 `DeadBall`；不能仅凭 shot emit 判断 |
| pass/clearance out | 越界 outcome finalize | episode 以 `out` 结束；按规则记录 restart team/kind |
| foul | 犯规已判、`restart_prep` 创建 | 开放 episode 以 `foul` 结束，进入 `RestartPreparation`；受益队不被记为已开放控球 |
| restart taken | corner/throw/free-kick/kickoff emit | 记录 `restart_taken`；球在 flight 时仍未建立开放控制 |
| whistle | whistle 提交 | 关闭当前 episode/restart/contest，进入 `Ended` 或半场死球 |

## 8. 时间语义

不输出伪精确 `confidence` 小数。每个时间字段携带来源：

```text
ObservedTime {
  value
  basis: state_commit | event_emit | deterministic_flight_end | unknown
}
```

- `event.t`：动作/高亮开始；
- 高亮 `t_end`：确定性飞行结束，可记录 `deterministic_flight_end`；
- `control_established.t`：引擎提交 `carrier/possession` 的时刻；
- 不从 viewer 插值倒推引擎事实。

## 9. Episode 结束原因

固定枚举：

```text
goal
saved_caught
shot_rebound
out
foul
control_lost
whistle_interrupt
half_time
full_time
observation_gap
```

`tackle_won`、`intercepted` 是动作/来源，不一定是 episode 结束原因；只有 `control_lost` 或进入 contest/dead ball 后才结束。

### 9.1 释放控制与关闭 episode

- `pass lost`：在 loose 启动的同一提交点记录 `control_released`，立即关闭旧 episode，原因 `control_lost`，进入 `Contested`。
- `pass intercepted`：若 finalize 同时确认拦截者控制，记录释放并关闭旧 episode，原因 `control_lost`，开启拦截者 episode；若只是进入 loose，按 `pass lost` 处理。
- `tackle success`：记录抢断动作，不自动释放；若 carrier 仍控制，episode 延续；若球进入 loose，记录释放并关闭旧 episode，进入 `Contested`；pickup 时开新 episode。
- `shot`：出球时记录 `control_released`，但暂不关闭 episode；episode 处于 `pending_outcome`，直到 shot finalize 再以 `goal`、`saved_caught`、`shot_rebound` 或 `out` 关闭。这样不会把 shot emit 误当成最终死球事实。
- `foul`：判罚确认时记录释放并关闭旧 episode，原因 `foul`，创建 restart sequence。
- `whistle`：若有未决 `BallInFlight`，记录 `observation_gap` + `whistle_interrupt`；不伪造动作结果。若是 `Controlled`，按 `half_time`/`full_time` 正常关闭。

## 10. 不确定性和一致性保护

- Recorder 接收到矛盾事实时不猜测，记录 `observation_gap` 并关闭当前 episode；
- 不允许 `Contested` 永久悬空：必须被 pickup、dead ball、whistle 或 match end 收束；
- 不设置人为秒数超时来改变足球事实；测试只断言最终一定被后续引擎路径收束；
- 每个时刻最多一个开放 `PossessionEpisode`；
- `RestartSequence` 与开放 `PossessionEpisode` 不重叠；
- recorder 不可写入影响模拟决策的字段。

`observation_gap` 是一个独立的 `ControlFact.kind`，表示引擎在比赛结束/哨声时没有提供足够结果确认；它不是正常的控制权转换，也不伪造 `control_lost`。规则是：未决 flight 被哨声打断时，记录 `observation_gap` fact，但 episode 结束原因固定为 `whistle_interrupt`；只有 recorder 收到矛盾输入或流提前截断时，episode 才使用 `observation_gap` 结束原因。`RestartSequence` 则独立使用 `terminated_by_whistle` 或 `match_end`。

## 10.1 固定枚举

```text
RestartKind = kickoff | free_kick | corner | throw_in | goal_kick | unknown

DeadBallReason = goal | out_sideline | out_goal_line | foul | half_time | full_time | unknown

FlightAction = pass | clearance | shot | corner | throw_in | free_kick | goal_kick | unknown

RestartEndReason = open_play_resumed | terminated_by_whistle | match_end | unknown

EpisodeStartReason = kickoff | pickup | successful_receive | restart_control | control_change | unknown

EpisodeEndReason = goal | saved_caught | shot_rebound | out | foul | control_lost |
  whistle_interrupt | half_time | full_time | observation_gap

ContestStartReason = pass_lost | interception_loose | tackle_loose | shot_rebound | unknown

ContestEndReason = pickup | dead_ball | whistle | match_end | observation_gap | unknown
```

`unknown` 只用于输入证据不足或旧事件流无法区分的情况；不允许把 `unknown` 当作默认正常路径。进入 `Contested` 时，若此前存在 controlled episode，必须同时记录 `control_released` 和 `contest_started`；离开时必须记录 `contest_ended`，除非因矛盾输入只能记录 `observation_gap`。

## 11. #15B Phase 标注器

Phase 是 `PossessionEpisode` 上的独立派生层，不反向影响 possession：

```text
PhaseAnnotator(
  possession_episode,
  control_facts,
  engine snapshots/hints,
  spatial_features
) -> PhaseSegment[]
```

第一版枚举：

```text
build_up
progression
final_third
attacking_transition
unknown
```

说明：

- `defensive_transition` 属于失去球权球队的团队状态，不应伪装成当前控球队 possession phase；留给后续 team-state observation。
- 定位球发出到首次控制之间不属于 `PossessionEpisode`，因此不标注 phase；其语义只存在于 `RestartSequence.kind` 和 flight facts 中。
- 每个 segment 输出离散 provenance：`engine_hint | geometry | event | inherited | unknown`。
- `phase_segments` 只能挂在一个已关闭或当前明确归属的 `PossessionEpisode` 内；不得跨越 episode、`RestartSequence` 或 `DeadBall`。无法确定边界时拆段并标记 `unknown`，不跨边界继承。
- #15B 不在 #15A 第一批实现中；#15A 的 sidecar schema 为其预留空数组即可。

## 12. 实现切片

### Slice 1：Recorder 骨架与不变量

- 新增 recorder 和 sidecar 数据结构；
- `simulate()` 字节级输出不变；
- opt-in API 能输出空/最小事实；
- 测试 recorder 零 RNG、只追加、不影响 golden。

### Slice 2：开放比赛控制路径

- kickoff/success pass；
- lost/intercepted；
- tackle + loose pickup；
- 对应 fixture 测试。

### Slice 3：射门与死球路径

- goal/saved caught/rebound/off target；
- out/foul/restart/whistle；
- 完整 episode/restart invariants。

### Slice 4：报告与基线

- JSON sidecar；
- 30 seed baseline；
- 与 tools 原型进行一次差异报告后删除或降级原型。

### Slice 5：#15B Phase

- phase segment 规则；
- provenance；
- baseline 仅作诊断，不设真实性阈值。

## 13. 测试门槛

- 手写状态路径 fixture 覆盖第 7 节所有路径；
- 固定 seed 集成测试验证所有 episode/restart/contest 最终闭合；
- `simulate()` 与当前 golden 完全不变；
- recorder on/off 的正式 `events` 完全一致；
- 同 seed 诊断 sidecar 完全确定；
- 任意 sidecar 错误不得改变比赛结果。

## 14. Slice 1 实现 addendum（2026-09-23）

本节是 Slice 1 实现相对 §1–§13 的**增量权威记录**。与前文冲突时以本节为准（前文保持原样以留痕）。
对应实现：`engine/src/observation.rs`、`engine/src/lib.rs`（`match_events` 抽取 +
`simulate_with_behavior_observations`）。

### A1. `ControlFact.detail` 是类型安全的闭集联合（不是自由字符串）

§4 的 `ControlFact` 没有承载 `DeadBallReason` / `ContestStartReason` / `ContestEndReason` / 缺口原因
的字段，而这些闭集枚举必须有落点（`PossessionEpisode` / `RestartSequence` 只覆盖 episode/restart）。

决定：`detail: Option<ControlFactDetail>`，其中

```text
ControlFactDetail = DeadBall(DeadBallReason)
                  | ContestStart(ContestStartReason)
                  | ContestEnd(ContestEndReason)
                  | Gap(ObservationGapReason)

ObservationGapReason = half_time_during_ball_in_flight | full_time_during_ball_in_flight
                     | missing_stream_end_boundary | event_index_out_of_stable_range
                     | illegal_fact_index
                     | IllegalInput(IllegalInput)

IllegalInput = 引擎提交点发出的、当前状态不允许的输入（11 个成员，见 §5 / §5 第二张表）
```

**不用 `Option<&'static str>`**：自由字符串等于在 gap / detail 路径上放弃「不猜」——
任意文本都能塞进任意 kind，基线无法按原因聚合，也无法守护枚举完整性。
不变量 10 强制 `detail` 与 `kind` 配对；`ObservationGapReason::ALL` 与 `IllegalInput::ALL` 是闭集全成员，
供按原因聚合使用。守护能力有明确边界：**从 `ALL` 漏掉成员会被测试抓到；给枚举新增成员却未列入
`ALL` 则抓不到**（Rust 无法反射枚举成员，两侧会一起漏）——新增成员时唯一的强制点是 `as_str`
的穷尽 `match`（编译错误）。残余后果仅是 `gap_reason_counts()` 少一个计数位（诊断字段）。

### A2. `BallInFlight.originating_team: TeamRef`（§5 写作裸 team）

§6.3 自己要求「无法确定时为 `unknown`，不猜」，故用 `TeamRef` 表达同一规则，而不是让裸 `TeamId` 逼调用方猜。

### A3. `match_started` 同时创建开球 restart preparation

§5.1 只写「创建开球 `RestartSequence`」，但 §6.2 要求所有重开统一走
`dead_ball_started → restart_preparation_started → restart_taken → open_play_resumed`。
开球同属重开，故 `match_started` 产出**两条**事实（`match_started` + `restart_preparation_started`）。
已知副作用：开球处没有 `dead_ball_started`（开球不是死球结果）——与半场/终场同类，属 §6.2
统一生命周期的例外之一（不是唯一：A9 记的门球没有准备期是另一处结构性例外）。

### A3.1 `match_started` 的时间 basis = `event_emit(0.0)`（Slice 2 若改 `state_commit` 须同步更新）

`match_started` 当前调用的时间是 `ObservedTime::event_emit(0.0)`——依据是 `match_events` 起手就
`events.push(Kickoff)`（t = 0.0，引擎开球恒主队），开赛事实与该事件同刻。

**为什么不是 `state_commit`**：`MatchState::new` 本身不产事件、也没有独立的「状态已提交」提交点；
opt-in 路径在调 `match_started` 时尚未跑 `match_events`（拿不到任何事件），0.0 是已知的确定值，
故用 `event_emit` 表达「该事实的时刻 = 流首事件的时刻」。

**Slice 2 若把提交点移到 `MatchState::new` 之后并改用 `state_commit(0.0)`，必须同步更新**：
① 该调用点、② 模块头接入对照表的「`simulate` 起点」行、
③ 测试 `match_started_time_basis_is_event_emit_at_zero`（它钉的就是这两个字段）。
`ControlFactBasis` 一侧恒为 `EngineState`（两侧互不影响）。

### A4. 事件下标绑定规则（`source_event_index` / `event_indexes`）

下标一律指 `DiagnosticMatch.events` 的**最终**下标。`match_events` 在循环结束后对
`events[drain_start..]` 做 `drain` → `filter`（同时间戳 beat 去重）→ `extend` 回填，
**该区间内的下标会被重排**；`drain_start` 之前的元素位置不变。

- 循环体内的提交点绑定 `events.len() - 1` 安全；
- 排空期（`while st.highlight.is_some()` 里的 `finalize_highlight`）绑定**不安全**：应传 `None`
  （事实仍有 `t` 与 `detail` 可定位），或在压缩完成后补绑定；
- 绑定必须经 `BehaviorObservationRecorder::bind_event_index`；下标落在压缩区间内时**拒绝绑定**
  并记 `ObservationGapReason::EventIndexOutOfStableRange`（静默错位比不绑定更糟）；
  目标 fact 下标越界记 `IllegalFactIndex`（与压缩无关，分开报以便按原因定位）；
- **当前接线范围**：`bind_event_index` 只写 `ControlFact.source_event_index`；
  `PossessionEpisode.event_indexes` / `RestartSequence.event_indexes` 仍为空，Slice 2 为它们接线时
  须扩展该接口，**不得**绕过它直接入数组。

#### A4.1 压缩边界**尚未真的登记到 recorder**（Slice 2 勿误以为 guard 已生效）

`match_events` 里的 `events_note_compaction_boundary(drain_start)` 当前是**无副作用空函数**——
`match_events` 拿不到 recorder 句柄，边界值被接收后即丢弃。后果：

- 生产 opt-in 路径上 `recorder.stable_event_prefix` **永远是 `None`**（=「全部下标稳定」），
  因此 `bind_event_index` 的拒绝逻辑在生产路径上**一次也不会触发**；
- 该 guard 目前只在测试里被真边界验证过
  （`event_index_binding_is_guarded_against_tail_compaction` 手工调
  `note_event_stream_compaction`），**不代表生产路径已受保护**；
- Slice 2 若要在排空期绑定事件下标，**必须先**把 recorder 接进 `match_events`
  （或让 `match_events` 返回「事件 + 压缩边界」），在此处真正调用
  `BehaviorObservationRecorder::note_event_stream_compaction`；**在那之前，排空期的提交点不得绑定
  事件下标**（传 `None`，靠 `t` + `detail` 定位）。

### A5. sidecar 自带质量信息

`DiagnosticMatch` 除 facts/观察对象外还携带：

- `state: BehaviorControlState`——终态观察状态（`Ended` 才算流收束；demo 模式为 `Uninitialized`）；
- `invariant_violations: Vec<String>`——在 `into_diagnostic_match` 消费 recorder **之前**求值保存。

理由：不变量 9 的交叉校验以 `state` 为客体，而 `state` 原本只活在 recorder 里；sidecar 不带它，
调用方就只能看到违规列表而看不到被检查的对象，无法自行判断终态是否可信。

### A6. 终场时间来自正式事件流

opt-in 路径的 `full_time` 时间取自事件流里**最后一条 whistle**（`stream_end_boundary`），
不另读 `config.match_duration_seconds`：后者只是引擎推哨时恰好用的同一个值，一旦漂移
（将来改为补时后推哨）sidecar 的终场时间就会与它自己输出的事件流对不上。流里找不到 whistle 时
**不硬编码**时间，改记 `ObservationGapReason::MissingStreamEndBoundary`。

**实现方式（审阅修订，2026-09-23）**：该约束**不能靠测试区分**——本引擎恰好在
`config.match_duration_seconds` 处推尾哨，故 `whistle.t == config` 恒成立，正确接线与旧实现
`recorder.full_time(config.match_duration_seconds)` 在真实路径上观测等价（旧测试的
`assert_eq!(whistle_t, dur)` 只是把这个巧合再钉一遍，对来源**没有判别力**）。因此：

- 提交收敛到 `commit_stream_end_boundary(recorder, events)`——它**只收 `events`**，
  调用方结构上递不进任何时长参数；
- 判别力由**手工构造的流**提供（observation.rs
  `full_time_time_comes_from_the_formal_whistle_not_config`）：`whistle@123.0` + 若干
  不等于 123.0 的对照时长，同时断言「等于流里的哨」与「不等于另一个来源」；
- 接线层另有源码守卫（lib.rs `p15_full_time_source_is_the_stream_not_the_config_duration`）：
  扫 `simulate_with_behavior_observations` 函数体，禁止 `.full_time(` 与
  `match_duration_seconds`、要求出现 `commit_stream_end_boundary`。
- 真实比赛路径仍保留集成断言（`stream_end_boundary_takes_the_last_whistle_and_full_time_uses_it`），
  但它只钉「接到了流末边界」，**不再**断言 `whistle_t == config`（那会随补时失效）。

### A7. 矛盾输入的免检边界（修订 §5 补充规则在检查器上的落地）

§5 补充规则要求矛盾输入「记 gap、不自行推进状态」，因此 `reject` 之后 `state` 与记录不一致
是**正确**行为。实现用一个显式快照表达这个窗口：

```text
reject() → stale_state_snapshot = Some(当前 state)   // 明确不推进 state
set_state() → stale_state_snapshot = None            // 任何成功转场都清掉
```

抑制的判定是**按值**的（`state == 快照`）而不是靠字符串前缀猜；一旦 `state` 被任何路径改写，
快照立刻失配 → 恢复全量校验。在快照仍然匹配时，只抑制**由 gap 必然造成**的子句：

- `Contested` 且争抢已收束（`reject` 按 §10 关了 contest）；
- `RestartPreparation` 的 kind 降级（已由 `reject` 的 pre-gap 校验抓到）；
- `Controlled` 但无开放 episode，**且**最近收束的 episode 确实死在 `observation_gap` 上
  （`reject` 只以 `ObservationGap` 关 episode，故这是它的必然结果）。

**不抑制**其余一切：`Controlled` 队别/持球员别与记录不符、开放 restart 与 `state` 归属不符、
`RestartPreparation` 无开放 restart、`Controlled` 无开放 episode 而 episode 以**非 gap** 原因关闭
——这些**不可能**由 gap 造成（gap 只关闭记录侧对象，不会凭空造出开放对象却让 `state` 不指着它）。

反例记录（Slice 1 首版实现被审出的两处逃逸，均已有测试 `reject_does_not_exempt_ill_formed_state`）：

1. 旧实现用 `bool` 整体跳过、又用字符串前缀抑制，于是「gap 之后把 `state` 换成任意损坏值」免检；
2. 「`Controlled` 无开放 episode」被整体抑制，导致同队/持球员别的损坏一并被放过。

`reject` 在置快照**之前**跑一次 pre-gap 交叉校验并把违规存进 `deferred_violations`（只增不减），
故「缺陷出现在 gap 之前」不会因为窗口豁免而丢失。

### A8. 时间不可得 vs 算错

`TimeBasis::Unknown` 显式表达 design §8 的「时间不可得」，此时事实的 `t` 允许非有限值
（例如「流里没有终场哨」这条 gap 没有时间可取）。非有限 `t` + **已知** `basis` 仍判违规——
豁免绑定在 basis 上，不是无条件放行 NaN。

### A9. 仍待设计确认的缺口（Slice 2 前必须解决，勿临时选一条）

- **进球路径的重开准备记在哪一次**：`ShotGoal` finalize 只记 `dead_ball_started`，准备期由
  `kickoff_again` whistle 记**一次**；若两处都记，第二次会因 `state` 已是 `RestartPreparation`
  被判非法（每个进球白送一条 gap）。犯规路径**必须**在 `emit_foul_and_free_kick` 处显式补 prep
  （引擎没有对应哨声/事件提交点）。
- **门球（`start_goal_kick`）没有准备期**：引擎同步发 pass 高亮、不设 `restart_prep`，
  因此没有 `restart_taken` 提交点，与 §6.2 的统一生命周期冲突。§6.2 已为半场/终场开例外先例，
  需明确门球是否同理例外。
- **`FlightAction` 闭集没有 kickoff 成员**：开球拨球在语义上是最短传出球，但 recorder 不代设计
  做等价映射（不猜），记为 `unknown`。
- **`RestartEndReason` 闭集没有「被新死球顶掉」成员**：该路径（§5 第二张表列为正常转场）以
  `RestartEndReason::Unknown` 结束。代价是 `gap_count() == 0` **不蕴含**所有 restart 都有明确
  结束原因——判断重开闭合质量须同时看 `restart_sequences` 的 `end_reason`。

## 15. Slice 2 实现 addendum（2026-09-23）

本节是 Slice 2（引擎提交点接入）相对 §1–§14 的**增量权威记录**。与前文冲突时以本节为准。
对应实现：`engine/src/lib.rs`（接线）、`engine/src/observation.rs`（命令集扩展）。

### 15.1 §14 A9 的缺口全部解决

**A9-1 `FlightAction` 补 `Kickoff` 成员。** 开球拨球**不是** `Pass`（recorder 不代设计做等价映射），
但它是一种确定的出球方式，不该退化成「证据不足」。`flight_action_for(Kickoff) = Kickoff`。
`Unknown` 恢复原义：只剩「未知重开方式」映射到它。

**A9-2 `RestartEndReason` 补 `SupersededByDeadBall`（= recorder 层契约，当前引擎不可达）。**
新死球顶掉未完成重开是 §5 第二张表列的**正常**转场，Slice 1 因闭集缺成员只能用 `Unknown`，
代价是 `Unknown` 同时表示「正常转场」与「证据不足」两类。补成员后该路径以
`SupersededByDeadBall` 结束、**不记 gap**，`Unknown` 恢复原义。

**可达性结论（2026-09-23 实测，取代此前的「生产已覆盖」表述）**：该路径**当前生产引擎不可达**，
成员是**防御性契约**，据此仍应保留（它划清 `Unknown` 的语义，且是 §5 第二张表的正式表达）。
不可达的两条**结构性**理由：

1. 引擎的每个死球结果都在**同一 tick 内**建立对应重开——goal 由 `advance_dead_ball` 推进到
   kickoff、out 在 `finalize_highlight` 里立刻 `start_throw_in` / `start_corner`、foul 在
   `emit_foul_and_free_kick` 里立刻建 `restart_prep`、shot off target / out goal line 由
   `start_goal_kick` **同步**发球；
2. **每个死球结果都在其自身 tick 内闭环，两次死球之间必有一次控制建立或流结束。**
   ⚠️ 不要写成「一个 tick 至多 `finalize_highlight` 一次」——那是**错的**（尾部排空循环会在
   `t = dur` 反复 finalize，见 §15 A9-11 第 3 条）。

**与 `emit_foul_and_free_kick` 的赋值行序无关**（2026-09-24 mutation 实测）：`st.restart_prep`
的赋值无论在两次 `obs.*` 之前还是之后，全量 `cargo test` 均全绿——本票结论只由上面两条结构
理由支撑。曾有一版文档把该行序写成「否则 `SupersededByDeadBall` 会在引擎里永不出现」，属**错误
因果**，已随 §15 A9-6 第 2 条的更正一并删除。

实测口径：seed 1..=400 × dur {120, 300, 600, 1200, 2700, 5400, 9000} = **2800 场 / 69,320 条
restart**，`SupersededByDeadBall` **0 例**、`end_reason == Unknown` **0 例**；并核验两条更强的
结构不变量全部成立——`restart 数 == dead_ball_started 事实数 + 1`、每条 restart 的
`end_reason ∈ {open_play_resumed, match_end}`。行为守卫见
`superseded_by_dead_ball_is_a_recorder_level_contract_not_engine_reachable`：它把这个 0 固定
成口径，并在引擎将来真的引入「重开中途再死球」时**变红提醒**（届时才可升级为「生产已覆盖」
并补针对性断言；已验证「多报一条死球」这类改动会让它红）。**不得**用「手写 recorder 测试
覆盖了该分支」来声称生产路径已覆盖。

**A9-3 门球是 §6.2 生命周期的结构性例外。** 引擎 `start_goal_kick` 同步发 pass 高亮、
**不设** `restart_prep`，因此路径上不存在 `restart_preparation_started` 的提交点。两条路都不能靠猜：
补记零长度的 prep = 发明引擎里不存在的阶段；只记 `dead_ball_started` 再等控制 = 门球后 `state`
仍是 `DeadBall`，控制声明被判非法。故新增专用入口
`BehaviorObservationRecorder::goal_kick_started`：一次提交记 `dead_ball_started` + `restart_taken`
（门将开大脚同刻把球交出，事实为真），**刻意没有** prep。与半场/终场同类，属例外而非缺陷。
`taken_t` 必须落上——否则门球交付后的首次控制会造出「有 `open_play_resumed_t` 但无 `taken_t`」，
直接违反不变量 5。

**A9-4 进球路径的准备期归 `kickoff_again` whistle 一次。** `ShotGoal` finalize **只**记
`dead_ball_started`（此时庆祝阶段球还在原地，不是准备起点）；准备期由 `advance_dead_ball` 的
`kickoff_again` whistle（`preparing = true` 的同一刻）记一次。犯规路径**必须**在
`emit_foul_and_free_kick` 处显式补 prep（引擎没有对应哨声/事件提交点）；
corner / throw-in 的准备期由调用它们的 `finalize_highlight` 分支在 `start_corner` /
`start_throw_in` **之后**提交（那两个函数自己只建 `restart_prep`，不推进观察状态）。

**A9-5 本引擎无中场休息。** 单段循环 `while t < dur` 只有正式终场 whistle；`half_time()` 在
可预见的将来**无调用点**。§5.1 的「下半场重新进入 `RestartPreparation(kickoff)`」没有对应提交点，
不得按它想象一个。

**A9-6 统一重开生命周期（2026-09-23 定案；2026-09-24 第 2 条更正）。**
§6.2 的首环节是 `dead_ball_started`，`RestartSequence` 由**死球来源矩阵（§6.3）在那一刻**创建。
由此定下面的规则：

1. **【硬规则】`restart_preparation_started` 必须有先行 `dead_ball_started`。** recorder 侧不再
   提供「没有开放 sequence 时凭空造一条」的兜底（那是猜：给没有死球来源的重开补出 `start_t`，
   把首环节悄悄抹掉）；改为记 `IllegalInput(RestartPreparationWithoutScheduledRestart)` gap。
   Slice 2 首版在 `CornerAward` 路径上有真实的缺口——它直接 `start_corner`、**没有**
   `dead_ball_started`，正是靠那条兜底被掩盖的；现已改为在 `finalize_highlight` 的
   `CornerAward` / 出界 `OutRestart::Corner` 分支显式先报死球。**这条有行为判别力**
   （gap 会当场产出）。
2. **【书写约定，非硬规则】`emit_foul_and_free_kick` 里观察提交写在 `st.restart_prep` 赋值
   之前。** 2026-09-23 曾把它写成「提交顺序 = 生产状态提交顺序」的第二条硬规则，并声称反过来
   （先赋值）会走成 `RestartPreparation → DeadBall → RestartPreparation`、且让 A9-2 那条转场
   永不出现。**该因果是错的，2026-09-24 mutation 已否定**：

   - 把 `st.restart_prep = Some(..)` 整体提到两次 `obs.*` **之前**，全量 `cargo test`
     （211 + 7 + 4）**仍全绿**——行序不可观测；
   - 机制：两次 `obs.*` 与赋值之间没有任何代码读 `restart_prep`，且 tick 顶部的 1b 分支
     （`if st.restart_prep.is_some() { advance_restart_prep(..); return }`）**在本函数被调用之前**
     就已判定——`restart_prep` 存在时接管发生在**下一 tick**，本拍落在哪一行都无差异。

   故降级为**书写约定**：按领域事实顺序书写（`dead_ball_started` → `restart_preparation_started`
   → 状态赋值），与 §6.2 生命周期表同序、便于阅读与后续演进。**明确记录：它没有行为判别力**，
   因此**不**为它添加源码顺序守卫（守卫只会钉住一个无判别力的字符串位置，却让重排注释/合并
   语句这类无害改动变红——见任务「窄范围修复轮」的取舍记录）。`SupersededByDeadBall` 生产不可达
   的依据**只**是 A9-2 的两条结构理由，与本节行序无关。
3. **一个死球事实 ⟺ 一条 restart sequence（+ 首开球那条）**。核验见 A9-2 的
   `restart 数 == dead_ball_started 事实数 + 1` 结构不变量（2800 场全成立）。

**A9-7 决策路径 guard 是「回归下限」，不是结构证明（2026-09-23 明确）。**
`p15_recorder_stays_out_of_the_decision_path` 的核心是**封闭字符串清单**
（`RECORDER_READS`，11 个读方法的**文本**），它能守住「清单里的这些读方法没被 `lib.rs` 读到」，
**不能**证明「将来新增的读方法也会被抓到」。为此已加一层**反向覆盖**：从
`impl BehaviorObservationRecorder` 里按名字/签名启发式枚举「读状态」的 `pub fn`，逐个要求在
清单里——它把「新增读方法忘了登记」这一类变成当场红，但**启发式本身不是类型隔离**：
一个返回 `Vec<usize>` 且名字不沾 `is_` / `_count` / `violations` 的新读方法仍会漏过。
**接口级隔离是未决事项**（例如把「读状态」收进一个不对比赛逻辑可见的 view 类型），
本票不做；在那之前，本守卫的定位就是**回归下限**，文档与 tasks 均不得声称它证明
「所有未来 read 方法都被捕获」。

### 15.2 事件下标归属：`Highlight::obs_event` + `UnattributedFacts` 水位

**归属判据是两半的，测试必须同时守**（只守一半会漏掉整个错误类）：

- 「不晚于事实」（`every_bound_fact_event_index_is_not_after_the_fact`）；
- 「不能绑到更早的无关事件、动作型事实不得绑移动 beat」
  （`action_facts_never_bind_to_a_beat`）。

实测教训：第一版只守了前半，于是**抢断的 `contest_started` 绑到了上一拍 beat**
（`Highlight.obs_event` 在动作事件 `push` **之前**取值）而全部测试全绿。
修法：tackle 的高亮在构造时 `obs_event: None`，`events.push(event)` 之后再回填。

**队别不能猜，也不能读错源**：`control_established` 的 `team` 与该事实的 `player` 必须同队
（`control_facts_never_contradict_their_own_player` 逐条断言）。实测抓到两处：

- `obs_contest_pickup` 曾在 battle 分支**之前**读 `st.possession`（那时还是争抢前的旧值），
  120 seed 里 100 条事实的 `team` 与 `player` 矛盾，并沿 `PossessionEpisode.team` 污染 episode；
- 门球的 `taking` 曾用 `1 - st.possession` 在 `start_goal_kick` **之前**反推——今天恰好等价，
  但改成不取反也全绿（突变存活）。现改为在提交之后读权威 `st.possession`
  （`goal_kick_sequence_team_is_the_taking_side` 钉住）。

**排空期的两道防线（行为门 + 源码门都有）**：排空循环**之前**先
`note_event_stream_compaction(drain_start)` 登记边界、再 `suspend_event_index_binding(true)`。
顺序很重要：边界登记推迟到循环之后（第一版）等于装饰——排空期不受保护，且此后没有任何绑定会查它。
删掉暂停会在 seed 33 上产出 2 条 `event_index_out_of_stable_range` gap
（`drain_period_bindings_are_suspended_not_gap_reported` 覆盖；**seed 33 是必需的**，
1/5/97/11/544 在排空期恰好不产绑定，漏掉它该测试即空转）。

**观察层状态不得进入比赛逻辑**（`p15_recorder_stays_out_of_the_decision_path`）：
`lib.rs` 里除 `obs_bind*`（纯写入）外**没有任何函数读 recorder 状态**，判据是显式写入白名单
而不是 `obs_` 前缀——前缀豁免曾放过 `obs_restart_open`（读 `obs.restarts()`、被
`finalize_highlight` 调用来决定 `start_reason`）。需要「按观察状态决定记录什么」的逻辑
一律搬进 recorder 自己（如 `EventIndexTarget::LastFactOfKind`）。
`Highlight::restart_delivery` 就是把「这是不是定位球交付」从「反查 recorder」改成
「发出交付的 emit 直接写下」的结果。

§14 A4 只给了绑定**入口**与压缩守卫，没有解决「绑定谁」的问题。Slice 2 实测踩了三轮：

- 动作事件（pass / shot / tackle / 交付）在 emit 时入流，结果要等**若干 tick** 后的
  `finalize_highlight` 才提交。此时 `events.len() - 1` 已是飞行期的 beat——用它绑事实会
  **静默错位**（实测把 `control_established` t=10 绑到 t=18 的传球事件）。
- 用 `MatchState` 上的标记两版都失败：标记要么被 `tick()` 顶部提前清掉，要么跨 tick 存活到
  落点争抢，把 `contest_ended` 绑到更晚的事件上。

**决定**：动作事件下标存进 `Highlight::obs_event`——它的生命周期与「一次高亮 = 一条动作事件」
天然吻合（创建于 emit、`take` 于 finalize）。落点类高亮（`CornerKick` / `GoalKick` /
`Clearance`）的 `obs_event` 就是**它自己那记交付事件**，因此「交付落点争抢与交付同源」也由
同一字段表达，不需要第二个标记。

**同一提交点的多条事实**：`dead_ball_started` 会顺带记 `control_released` / `contest_ended`，
`control_established` 会顺带记 `open_play_resumed`，它们同刻同源。故新增
`EventIndexTarget::UnattributedFacts`——recorder 自己维护水位 `attributed_upto`，一次扫描把
`[水位, facts.len())` 全部绑到该事件。水位**只在成功绑定后推进**（被压缩拒绝时不推进，
避免把待归属事实静默丢给下一个事件）。实测覆盖率从 47%（只绑最后一条）提升到 ~100%。

### 15.3 尾哨与流截断（§14 A6 / 模块头坑 7 的收尾）

`stream_end_boundary` 取**最后一条** whistle 的判别力由手工双哨流测试保证
（`[150.0, 123.0]` → 取 123.0）。在真实流里「最后一条 whistle 恰是 `kickoff_again` 转场哨」
**当前不可达**：庆祝期 + 准备期 + kickoff 飞行都在 `dur` 之前完成，且截断只可能发生在
死球/高亮中途，此时尾哨尚未产出。这条推理若将来失效（例如引入补时），必须改成按 `detail`
区分转场哨与终场哨。

**A9-8 `half_time()` 零生产调用点（一行 reconciliation）。** §5.1 与 §5 第二张表都给了
「半场哨」列，但本引擎**没有中场休息**（单段循环 `while t < dur`），`half_time()` 至今
**无任何生产调用点**——它是留给引擎将来真正实现中场哨时的骨架，reconciliation 如下：

- **保留**该命令与它的两个 `IllegalInput` / `ObservationGapReason` 成员
  （`HalfTimeDuringBallInFlight` 等）：§5.1 的状态转换表是设计的正式组成部分，删除会让
  将来实现中场哨时重新推导一遍「未决飞行怎么收束」；
- **不接线**、**不为它编造提交点**：`match_events` 循环后推的那条 `detail = "half_time"`
  的 whistle 是**流边界**（映射为 `full_time`），不是中场哨——把两者混同会直接终止整场比赛
  的观察（模块头坑 5 / 开球专线 3）；
- 因此它在观察层是**未使用但已测试**的契约（`half_time_closes_contest_and_terminates_restart_without_sequencing`）。

**A9-9 观测开销口径（软化「零成本」）。** 「零成本」是**结构性**说法
（`simulate()` 不构造 recorder 语义上就是「不观察」，观察命令一次也不被调用），**不是性能
承诺**。观测**开启**路径的实测口径（可复现，见 lib.rs 的 ignored 测试
`p15_observation_overhead_caliber`——它直接比 `match_events` 在 `disabled()` / `enabled()`
下的**纯引擎**耗时）：

- release，seed 1..=20，dur 5400：关闭 913ms / 开启 936ms → **比值 ~1.03（+3%）**，产出
  19,280 条事实；
- **口径陷阱**：不要拿 `simulate()`（含 JSON 序列化）与 opt-in 路径比——序列化 47MB 事件
  JSON 是耗时大头，那样量出来的比值会反过来（实测 ~0.55），与 recorder 开销无关；
- **结论按「正式行为 / 事件流不变 + 观测关闭路径实测开销近零」表述**；不写「开启路径必然
  < X%」这种绝对承诺，也没把任何百分比写成测试门槛（那会在别的机器/编译选项上红）。

**A9-10 空 `event_indexes` 的唯一例外 = 「流截断时刻才创建的对象」。**
`match_events` 出循环后立刻登记压缩边界并**暂停**事件下标绑定（§15.2），因此 `t == dur`
时刻新建的 episode / restart 拿不到下标——这是设计后果，不是遗漏。实测（seed 1..=400 ×
dur {120,300,600,1200,2700,5400,9000} = 2800 场）共 22 条空 restart + 55 条空 episode，
**全部**满足「`start_t == 尾哨 t`」，零反例。它统一覆盖三种形态：① 终场哨开启的 episode；
② `dur` 时刻创建、未 taken 就被 `match_end` 收束的 restart；③ `dur` 时刻由射门 off-target
触发、**已 taken** 的门球 restart。

⚠️ **踩坑记录（本会话自审发现）**：覆盖门的第一版按 `end_reason == MatchEnd &&
taken_t.is_none()` 判例外，**漏掉形态 ③**；而当时自选的 seed 集（1/5/15/33/86/97/100/120）
恰好一条形态 ③ 都没有，测试全绿——即「只在自选 seed 上闭合」。现已改为单一谓词
`start_t == 尾哨 t`，并在防空转断言里要求**三种形态都被覆盖**（形态 ③ 的 seed 157 / 317 已入集）。

**A9-11 第三轮独立审阅的发现与修复（2026-09-24）。**
审阅结论：无 P0/P1 缺陷；下列 4 条 P2/nit 已就地修复。

1. **`SuccessfulReceive` 不可达的**原因**写错了**（结论对、机制错）。原文称「开放比赛的接球控制
   经 `advance_loose` pickup 取得、传的也是 `Pickup`」——**错**：开放比赛 `PassCaught` 确实
   传 `SuccessfulReceive`（lib.rs 该提交点），它只是**不被消费**：接球方与当前 episode 同队
   （传球不切 possession）→ 走 `same_team_open` 分支**延续** episode，而只有 `open_new_episode`
   才读 `start_reason`。反证：临时把 `same_team_open` 强制为 `false`，1600 场立刻产出 23 万条
   `successful_receive`。已改写 `EpisodeStartReason` 的文档。
2. **「真实路径 0 gap」被当成全称命题**。实测 `seed 147 @ dur 120` 合法产 1 条
   `full_time_during_ball_in_flight`（kickoff 飞行被 t=120 终场哨截断）。
   已把各处 `gap_count() == 0` 断言的文案限定到各自样本，并新增
   `truncated_stream_produces_a_full_time_gap_by_design` 把这个**合法缺口来源**钉成正式行为。
   ⚠️ 本轮修复又发现**这次修复自己带了一条错误全称**：原文写「dur ≥ 300 时 0 例」——**假**，
   见 §15.5。
3. **P1 测试的「结构性理由 2」是错的**。原文称「一个 tick 至多 `finalize_highlight` 一次」——
   **错**：尾部排空循环会在同一 `t = dur` 反复 finalize（链式高亮），这正是截断 regime。
   已改为正确表述「一次 `finalize_highlight` 至多产一个死球结果，且两次死球之间必有控制建立
   或流结束」，并就地写明「不要退回那句错的」。
4. **`source_event_index` 并非 write-once**：`Fact` / `LastFactOfKind` 会覆写，而当前接线
   **依赖**覆写总发生在更晚的下标上（门球 taken 从死球事件改绑到更晚的交付事件）。已加
   `event_index_regressed` 守卫：重绑到更小下标时拒绝并记 gap；同值/更大下标放行。新测试
   `rebinding_a_fact_event_index_must_not_move_it_backwards`（删守卫即红）。连带修正既有
   `event_index_binding_is_guarded_against_tail_compaction`——它原先在同一 fact 上做倒退重绑，
   两条规则混在一起会互相遮蔽，现改用未绑定 fact 验证压缩规则。

### 15.4 事实覆盖率与归属正确性的验收

真实 seed（1 / 5 / 97，dur 300 / 5400 / 9000）实测：`gap_count == 0`、`invariant_violations` 为空、
所有 episode / restart 闭合、事件下标非空且严格递增、事实绑定率 ~100%。
归属正确性由 `every_bound_fact_event_index_is_not_after_the_fact` 守：
非 `DeterministicFlightEnd` 的事实绑的事件**不得晚于**事实时刻；
`DeterministicFlightEnd`（引擎自算的飞行结束，tick 中间小数）允许绑到**其后第一条**事件，
但不得跨过一个 tick 或跳过中间的 beat。

### 15.5 更正：`full_time_during_ball_in_flight` 不是「短时长特例」

§15 A9-11 第 2 条修掉了「真实路径 0 gap」的全称命题，但**修法本身又引入了一条错误全称**：
「dur ≥ 300 时 0 例」。**该全称已被证伪**（2026-09-24 窄范围修复轮实测）。

- **正确口径**：该 gap 的触发条件与时长**无关**——只要某 tick 以飞行中（`Pass` / `Shot` 等、
  球尚未落地）结束、而下一 tick 就是终场哨，即产 gap。短时长让**开球飞行**容易撞哨
  （`dur 120`），长时长则需要尾段恰有一脚未落地的球：罕见，但**会发生**。
- **已复核示例**：`seed 147 @ dur 120`（开球 t=119 发出、被 t=120 哨截断）与
  `seed 368 @ dur 400`（t=399 的 kickoff **飞行中**撞上 t=400 哨）。前者在 400 seed 内唯一，
  后者在 `dur 400` × 1500 seed 内亦唯一——**稀有 ≠ 不可能**。
- **表述纪律**：`engine/src/observation.rs` 的
  `truncated_stream_produces_a_full_time_gap_by_design` 文档已改为**机制描述 + 已复核示例**，
  不再作「更长时长 0 例」这类未经覆盖的全称断言。测试仍取 `dur 120`，但那只是**稳定复现**的
  样本选择，不是「只有短时长才会产」的论据。

### 15.6 sidecar event index 的时间口径（下游不得要求事件落在对象时间窗内）

**结论**：`event_indexes` / `source_event_index` 里的**事件时间可以早于**它所属对象的时间起点。

- **机制**：同一 tick 内 `event_emit(t)` 早于 `state_commit(t)`。两类时间 basis 取值可能同时
  落在整数 tick 上，但代表不同语义——事件发射时刻 vs 状态提交时刻。死球类 restart 的
  `start_t` 走 `state_commit`，而**因果事件**（`Pass` / `Shot`）是 `event_emit`，故因果事件
  可**早于** `start_t`（典型：球在 t=212 踢出、落地/出界在 t=213 提交 → `GoalKick.start_t = 213`
  绑定 `Pass@212`）。
- **实测口径**（2026-09-24，80 场 `dur 5400`）：3879 条 restart 的 7749 条绑定事件中 **1923 条**
  时间早于各自 `restart.start_t`；涉及 `GoalKick` 941 / `ThrowIn` 760 / `Corner` 148 /
  `Kickoff` 74 条 restart 至少含一条这样的绑定。**不是边角，是常见形态。**
- **下游约束**：**不得**写「restart 的全部 `event_indexes` 事件时间必须 ≥ `start_t`」这类断言，
  也**不得**据此把「早于窗口」判为数据损坏。这与 §15.2 的事件下标归属判据并不冲突——
  那条判据是「**事实**不得晚于其绑定的事件」（`every_bound_fact_event_index_is_not_after_the_fact`），
  方向相反、客体不同：约束的是 fact 与其 event 的关系，**不是** event 与 restart 窗口的关系。
