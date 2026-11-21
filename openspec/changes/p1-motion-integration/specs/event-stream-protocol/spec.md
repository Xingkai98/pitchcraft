# Spec: event-stream-protocol

## ADDED Requirements

### Requirement: beat 段与切段

beat SHALL 描述一个**段**（segment），不是固定 1s 的 tick。段边界是 beat 名义网格 `{0.5 + 0.2k}`、决策时刻 `{0.5 + 0.5m}`、全部非 beat 事件发射时刻三者的并集。`beat.t` SHALL 是段起点，`beat.dt` SHALL 是段长（∈ {0.1,0.2} 秒），`from`/`to` SHALL 分别是 `beat.t` 与 `beat.t + beat.dt` 时刻的状态。同时间戳排序 SHALL 为非 beat 事件先、beat 最后；beat SHALL 描述这些事件之后的段。前导期 `[0,0.5)` 不积分、不产 beat，由 `lineup`/`kickoff` 描述。

#### Scenario: 首拍与相位

- **GIVEN** 一场开放比赛从 `t=0` 开始
- **WHEN** 引擎产出前 1s 的 beat 序列
- **THEN** 首条 beat 的 `t` SHALL = 0.5；其后名义 beat 在 0.7、0.9、1.1、1.3 出现；决策在 0.5、1.0、1.5 发生；`[0,0.5)` 不产 beat

#### Scenario: 决策点切段

- **GIVEN** 决策在 `t=1.0` 发生，beat 名义网格为 0.9、1.1
- **WHEN** 引擎产出 1.0 前后的 beat
- **THEN** 0.9 的 beat `dt` SHALL = 0.1（段 [0.9,1.0]）；1.0 的 beat `dt` SHALL = 0.1（段 [1.0,1.1]）；不得用一条 [0.9,1.1] 的 beat 跨过决策

#### Scenario: 同时间戳排序

- **GIVEN** 同一 `t` 上有一条 pass/tackle/shot 事件与一条 beat
- **WHEN** 消费方读取事件流
- **THEN** 非 beat 事件 SHALL 排在 beat 之前；beat 的 `from` SHALL 是事件执行后的状态，不得描述事件前的段

#### Scenario: 段长字段

- **WHEN** 引擎产出一条 beat
- **THEN** 它 SHALL 携带 `dt` ∈ {0.1, 0.2}；`t + dt` SHALL 等于下一条段边界的 `t`（下一条 beat 或切段事件的 `t`）

#### Scenario: 跨表示连续

- **GIVEN** 一名球员从 `main`（carrier）切换为 `movers`（无球），或从 `movers` 切换为 `main`
- **WHEN** 检查切换边界的位置
- **THEN** `main.x2/y2`、`movers.to_x/to_y`、事件终点与引擎状态位置 SHALL 一致；`from(N+1) == to(N)` 对同一实体在跨表示时仍成立

### Requirement: beat 的死球与终场边界

死球窗口可以不产 beat，但从死球前最后一条 beat 到重开后第一条 beat 的 gap SHALL ≤ 2.0s；若死球窗口 > 2.0s，引擎 SHALL 至少每 2.0s 发一条静态 `ball` beat。终场排空期（`t ≥ dur`）SHALL NOT 产 beat；同一 `dur` 上的链式 finalize SHALL 只保留一个段。

#### Scenario: 死球 gap 上界

- **GIVEN** 一次死球持续 3s，期间无 beat
- **WHEN** 引擎产出死球窗口的 beat
- **THEN** 死球前最后一条 beat 与重开后第一条 beat 的 gap 可 > 0.2s，但 SHALL ≤ 2.0s；3s 窗口内 SHALL 至少有一条静态 `ball` beat（每 2.0s 一条）

#### Scenario: 终场不产 beat

- **GIVEN** 比赛在 `dur` 结束且仍有悬空高亮
- **WHEN** 终场 finalize 执行
- **THEN** SHALL NOT 产 `t ≥ dur` 的 beat；同一 `dur` 上的链式 finalize 只保留一个段

### Requirement: 稀疏 main/ball 的携带与状态失效

`main` SHALL 在**每个 carrier 有非零位移的段**携带；零位移段可以省略，viewer SHALL 保持上一状态。无持球者时，`ball` SHALL 在**每个球有非零位移的段**携带；静止松散球段可以省略，viewer SHALL 保持上一状态。高亮进行中，参与者 SHALL 被排除出 `movers`，球由事件锚点驱动，`main` / `ball` SHALL NOT 携带。`pass` / `shot` / `tackle` / `out` / `whistle` / `foul` 事件 SHALL 在其 `t` 时刻使其前的 `main` 记忆失效；只带 `movers` 的 beat SHALL NOT 使状态失效。

#### Scenario: 连续带球每段携带 main

- **GIVEN** carrier 在 1s 内以 2.5 m/s 持续向 +x 移动
- **WHEN** 引擎产出该 1s 的 beat
- **THEN** 每个有非零位移的段 SHALL 携带 `main`（含 `x/y → x2/y2` 与 `speed`）；下一段的 `x/y` SHALL 等于上一段的 `x2/y2`

#### Scenario: 零位移段省略 main

- **GIVEN** carrier 在两个 0.2s 段内原地持球（位移为 0）
- **WHEN** 引擎产出这两段
- **THEN** 两段可以省略 `main`；viewer SHALL 保持上一段的 carrier 位置与身份；下一段重新移动时 `from` SHALL 等于停点

#### Scenario: 松散球滚动

- **GIVEN** 无持球者，球以 6 m/s 滚动
- **WHEN** 引擎产出滚动期间的 beat
- **THEN** 每个有非零位移的段 SHALL 携带 `ball`（`loose:true`）；球停下后可省略，viewer 保持最后位置

#### Scenario: 状态失效

- **GIVEN** 一条 `tackle` 事件在 `t=1.0` 改变了球权
- **WHEN** 消费方在 1.0–1.4 之间寻找当前 carrier
- **THEN** 它 SHALL NOT 回退到 1.0 之前的 `main`；失效事件之后的 movers-only beat 不提供 carrier；新的 carrier 只能来自下一条 `main`

#### Scenario: seek 重建

- **GIVEN** 播放器 seek 到一条 movers-only beat 的中间时刻
- **WHEN** 重建画面状态
- **THEN** 它 SHALL 向前找最近的主状态来源：当前活跃高亮的事件锚点优先，其次最近 `main` / `ball`，再其次最近 beat 的 mover；高亮结束后 SHALL 从事件终点续接，不得跳回高亮前的 `main`

## MODIFIED Requirements

### Requirement: beat 节拍事件字段

beat 节拍事件 SHALL 描述一个**段**内所有在移动球员的并行动作，顶层不携带 subject/x/y（主体与位置嵌套在 main/movers/ball 内）。beat SHALL 携带：`dt`（段长，∈ {0.1,0.2}）；`movers`（并行跑位数组，增量——只含该段有非零位移的球员，`{id, from_x, from_y, to_x, to_y, speed, action}`）；持球者带球/控球时，若 carrier 在该段有非零位移则携带 `main`（`{type:'dribble', subject, x, y, x2, y2, speed, touch_freq}`，球轨迹由 main 驱动）；无持球者时，若球在该段有非零位移则携带 `ball`（`{x, y, x2, y2, speed, loose:true}`，球由 beat.ball 驱动）。零位移段可以省略 `main` / `ball`，viewer 保持上一状态。beat SHALL NOT 同时携带 main 与 ball（任意开放比赛时刻球有唯一驱动者）。高亮进行中，参与者不出现在 movers，也不由 `main` / `ball` 驱动（球由事件锚点驱动）。

#### Scenario: 节拍含并行跑位
- **GIVEN** 一个段时刻
- **WHEN** 引擎产出一条 beat 事件
- **THEN** 携带 `movers`（只含该段有非零位移的球员，静止球员不在其中）；持球者不出现在 movers（其移动只由 main 表达）

#### Scenario: 持球者带球由 main 表达
- **GIVEN** 持球者在带球/控球（无高亮事件）
- **WHEN** 引擎产出一条 beat 事件
- **THEN** 若该段 carrier 有非零位移，携带 `main`（球轨迹 x/y→x2/y2 + speed 驱动）；若该段零位移，可以省略，viewer 保持上一状态

#### Scenario: 松散球由 ball 表达
- **GIVEN** 无持球者（抢断弹开等）
- **WHEN** 引擎产出一条 beat 事件
- **THEN** 若该段球有非零位移，携带 `ball`（`loose:true`，含滚动轨迹），球由 beat.ball 驱动；静止松散球段可以省略，viewer 保持最后位置

#### Scenario: main 与 ball 互斥
- **WHEN** 引擎产出一条 beat 事件
- **THEN** 不同时含 main 与 ball（唯一驱动者）

### Requirement: 重开准备期球锚点

角球/界外球发球准备期（RestartPrep，**指判定段之后、发球之前的每个准备段**——判定段本身不产 beat，见 match-engine 的 beat 段边界不变量）SHALL 产 beat 事件表达球停在固定点等待发球：**准备期的第一条 beat** SHALL 携带静止锚点 `beat.ball`（x==x2 且 y==y2，loose=true），坐标=角旗区/出界点；其后零位移的段可以省略 `ball`，viewer 保持该锚点。`movers` 含发球者/掷球者走向固定点的走位（**受速度/加速度/制动约束，不再有 dead-zone「位移 < 2m 不移动」语义**；发球者已在固定点、其余球员的目标都在到达半径内时该段 movers 可以为空）。发球高亮起点=同一固定点，viewer 连续播放无球瞬移。

#### Scenario: 准备期球停固定点
- **GIVEN** 一次角球/界外球发球准备期（判定段之后的准备段）
- **THEN** 准备期第一条 beat 的 `ball` 静止在角旗区/出界点（x==x2、y==y2），发球者/掷球者 mover 走向固定点；其后零位移段可省略；发球 pass 起点=同一固定点
