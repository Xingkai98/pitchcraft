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
