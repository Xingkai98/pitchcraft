# Spec: event-stream-protocol

## ADDED Requirements

### Requirement: beat 段与切段

beat SHALL 描述一个**段**（segment），不是固定 1s 的 tick。段边界是 beat 名义网格 `{0.5 + 0.2k}`、决策时刻 `{0.5 + 0.5m}`、全部非 beat 事件发射时刻三者的并集。`beat.t` SHALL 是段起点，`beat.dt` SHALL 是段长（∈ {0.1,0.2} 秒；**终场末段例外**，见下），`from`/`to` SHALL 分别是 `beat.t` 与 `beat.t + beat.dt` 时刻的状态。同时间戳排序 SHALL 为非 beat 事件先、beat 最后；beat SHALL 在段起点、处理完该边界的事件/决策后发出，`to` 是预积分到段终点的状态。前导期 `[0,0.5)` 不积分、不产 beat，由 `lineup`/`kickoff` 描述。除**重开准备判定段**与死球窗口外，每个段 SHALL 产一条 beat；终场最后一段 SHALL 允许 `dt = dur − t_last`（`0 < dt ≤ 0.2`）。

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
- **THEN** 非 beat 事件 SHALL 排在 beat 之前；beat 在段起点、处理完该边界的事件/决策后发出；beat 的 `from` SHALL 是事件执行后的状态，`to` SHALL 是预积分到段终点的状态

#### Scenario: 段长字段

- **WHEN** 引擎产出一条 beat
- **THEN** 它 SHALL 携带 `dt` ∈ {0.1, 0.2}（终场末段例外，可为 `dur − t_last`）；`t + dt` SHALL 等于下一条段边界的 `t`（下一条 beat、切段事件或 `dur`）

#### Scenario: 重开准备判定段例外

- **GIVEN** 一次角球/界外球判定在 `t` 发生，随后进入 RestartPrep
- **WHEN** 引擎产出判定段与其后的准备段
- **THEN** 判定段 SHALL NOT 产 beat；其后的每个准备段 SHALL 按段规则产 beat（首段携带静止 `ball` 锚点）

#### Scenario: 跨表示连续

- **GIVEN** 一名球员从 `main`（carrier）切换为 `movers`（无球），或从 `movers` 切换为 `main`
- **WHEN** 检查切换边界的位置
- **THEN** `main.x2/y2`、`movers.to_x/to_y`、事件终点与引擎状态位置 SHALL 一致；`from(N+1) == to(N)` 对同一实体在跨表示时仍成立

### Requirement: 非网格状态转移

非终场状态转移 SHALL 只在 `SIM_DT=0.1s` 网格边界确认：连续停点/减速在段内轨迹表现（宿主段 `to` 为该网格边界状态），SHALL NOT 新增任意短 dt（非末段 `dt` 只能是 0.1 或 0.2；终场末段短 dt 是唯一例外）。

#### Scenario: 非网格停点不切短段

- **GIVEN** 球在 `[0.5,0.7)` 段内的 `0.63` 连续减速停下
- **WHEN** 引擎产出该段与其后的 beat
- **THEN** 状态转移 SHALL 在下一个 0.1s 网格边界（0.7）确认；SHALL NOT 在 0.63 切出一个非终场短段（`dt=0.13`）；宿主段 `to` 为 0.7 时刻状态，停点的连续轨迹在段内表现

### Requirement: beat 的死球与终场边界

死球窗口可以不产 beat，约束对象是**相邻已发 beat**：任意一对相邻已发 beat 的 `t` 差 SHALL ≤ 2.0s。若死球窗口 > 2.0s，引擎 SHALL 至少每 2.0s 发一条静态 `ball` beat，使每一对相邻已发 beat 都满足上界；死球总时长本身可以 > 2.0s。终场排空期（`t ≥ dur`）SHALL NOT 产 beat；同一 `dur` 上的链式 finalize SHALL 只保留**一个终态事件**，不新增段；终场前最后一段 SHALL 以 `dur` 结束，允许 `dt = dur − t_last`（0 < dt ≤ 0.2）。

#### Scenario: 死球 gap 上界

- **GIVEN** 一次死球从 10.0 持续到 13.0，期间不产常规 beat
- **WHEN** 引擎产出死球窗口的 beat
- **THEN** 已发 beat SHALL 在 10.0、12.0（静态锚点）、13.0（重开）等位置，使**每一对相邻已发 beat** 的 gap ≤ 2.0s（10.0→12.0 = 2.0，12.0→13.0 = 1.0）；不要求 10.0 与 13.0 的差 ≤ 2.0s

#### Scenario: 终场不产 beat

- **GIVEN** 比赛在 `dur` 结束且仍有悬空高亮
- **WHEN** 终场 finalize 执行
- **THEN** SHALL NOT 产 `t ≥ dur` 的 beat；同一 `dur` 上的链式 finalize 只保留一个终态事件，不新增段；终场前最后一段以 `dur` 结束

#### Scenario: 终场末段短 dt

- **GIVEN** `dur = 1.05`，且 1.0 是强制 decision 边界
- **WHEN** 引擎产出终场前最后两段
- **THEN** 最后两段 SHALL 为 `0.9 → 1.0`（`dt=0.1`，非末段 ∈ {0.1,0.2}）与 `1.0 → 1.05`（`dt=0.05`，末段允许 `0 < dt ≤ 0.2` 且 `t+dt = dur`）；SHALL NOT 把 0.9→1.05 写成一段 dt=0.15（那会跨过 1.0 决策边界）；`t ≥ dur` 不产 beat

### Requirement: 稀疏 main/ball 的携带

事件流 SHALL 只有四种驱动状态：`controlled`（carrier 用 `main`）、`loose`（球用 `ball`）、`highlight`（球用事件锚点、参与者用 `movers`）、`restart`（球停固定点）。`controlled` 下 `main` SHALL 在**每个 carrier 位移 > `ε_move` 的段**携带，且**进入 controlled 的首段即使零位移也携带**；稳定静止段可省。`loose` 下 `ball` SHALL 在**每个球位移 > `ε_move` 的段**携带，且**进入 loose 的首段即使零位移也携带**（新 loose 球、球停下后的首个静止段）；稳定静止段可省。`ε_move = 1e-3 m/段`；`movers` 同样只含位移 > `ε_move` 的球员。

#### Scenario: 连续带球每段携带 main

- **GIVEN** carrier 在 1s 内以 2.5 m/s 持续向 +x 移动
- **WHEN** 引擎产出该 1s 的 beat
- **THEN** 每个有非零位移的段 SHALL 携带 `main`（含 `x/y → x2/y2` 与 `speed`）；下一段的 `x/y` SHALL 等于上一段的 `x2/y2`

#### Scenario: 稳定静止段省略 main

- **GIVEN** carrier 在**同一状态**下连续 0.4s 原地持球（位移为 0）
- **WHEN** 引擎产出这两段
- **THEN** 首段 SHALL 携带 `main`（新状态/移动段；若状态未变但前一状态首段已发，则稳定段可省略）；稳定静止段可以省略；viewer SHALL 保持上一段的 carrier 位置与身份；下一段重新移动时 `from` SHALL 等于停点

#### Scenario: 松散球滚动

- **GIVEN** 无持球者，球以 6 m/s 滚动
- **WHEN** 引擎产出滚动期间的 beat
- **THEN** 每个有非零位移的段 SHALL 携带 `ball`（`loose:true`）；球停下后的**新状态首段**仍 SHALL 携带静止 `ball`，其后稳定静止段可省略，viewer 保持最后位置

#### Scenario: 微位移不产 mover

- **GIVEN** 一段内球员位移 < `ε_move`（如残余 0.02m）
- **WHEN** 引擎产出该段 beat
- **THEN** 该球员 SHALL NOT 进入 `movers`；`main`/`ball` 同样按 `ε_move` 判据；不得因浮点残差让 22 人每段都进 movers

### Requirement: 高亮与重开驱动状态

`highlight` 下 **`main` / `ball` SHALL NOT 携带**：**高亮事件本身 = 新状态首锚点**，并清除旧 `main`；参与者在有非零位移的段 SHALL 出现在 `movers`（`action:"highlight"`），球由事件锚点驱动。高亮结束后的**首个 controlled/loose 段** SHALL 携带 `main`/`ball`，即使零位移。`restart` 下首个准备段 SHALL 携带静止 `ball`，其后稳定可省。

#### Scenario: 高亮期间禁 main/ball

- **GIVEN** 一条 pass/shot/tackle 在 `t=1.0` 开始、`t_end=1.5` 结束
- **WHEN** 引擎产出 1.0–1.5 的 beat
- **THEN** 这些 beat SHALL NOT 携带 `main`/`ball`；1.0 的事件本身是首锚点；1.5 后的首个 controlled/loose 段 SHALL 携带 `main`/`ball`（即使零位移）

### Requirement: 新状态首段与状态失效

**非高亮状态转移**的新状态键（任一变化即触发首段）SHALL 包含：球权变化、carrier id 变化、球 `controlled ↔ loose`、carrier mode 变化（`dribble ↔ hold`）、重开、`save-caught`（`shot result=saved` 的内部 outcome）。`pass` / `shot` / `tackle` / `out` / `whistle` / `foul` 事件 SHALL 在其 `t` 时刻使其前的 `main` 记忆失效；只带 `movers` 的 beat SHALL NOT 使状态失效。失效后若进入 `highlight`，**事件本身是首锚点**（禁 `main`/`ball`）；若进入 `restart` / `controlled` / `loose`，第一段 SHALL 按状态首段规则发 `main` 或 `ball`。随机 seek SHALL 能回扫到该状态的首锚点。

#### Scenario: 状态失效

- **GIVEN** 一条 `tackle` 事件在 `t=1.0` 改变了球权，且高亮持续到 1.5
- **WHEN** 消费方在 1.0–1.4 之间寻找当前 carrier
- **THEN** 它 SHALL NOT 回退到 1.0 之前的 `main`；1.0–1.5 是 `highlight` 状态（禁 `main`/`ball`，事件本身是首锚点）；**1.5 之后的第一个 controlled/loose 段**才发新的 `main` 或 `ball`；新的 carrier 只能来自该段或后续 `main`

#### Scenario: 高亮首段与结束首锚点

- **GIVEN** 一条 pass/shot/tackle 在 `t=1.0` 开始、`t_end=1.5` 结束
- **WHEN** 引擎产出 1.0–1.5 与其后的 beat
- **THEN** 1.0 的**事件本身** SHALL 是高亮状态的首锚点；1.0–1.5 的 beat SHALL NOT 携带 `main`/`ball`；1.5 后的第一个 controlled/loose 段（如 [1.5,1.7)）SHALL 携带 `main`/`ball`，即使零位移；SHALL NOT 在 1.0 强制发 `main`/`ball`

#### Scenario: 新状态首段即使零位移也发 main/ball

- **GIVEN** 三种零位移状态变化之一：① `shot result=saved` 的内部 caught 转移（门将零速持球；不是独立事件类型）；② 松散球原地被拾取（内部 loose→controlled 转移）；③ 新 loose 球立即静止
- **WHEN** 引擎产出状态变化后的第一段
- **THEN** ① / ② SHALL 携带 `main {subject, x=x2, speed=0}`；③ SHALL 携带 `ball {x=x2, y=y2, speed=0, loose:true}`；不得因位移为零而省略

#### Scenario: seek 重建

- **GIVEN** 播放器 seek 到一条 movers-only beat 的中间时刻
- **WHEN** 重建画面状态
- **THEN** 球 SHALL 向前找最近的主状态来源：当前活跃高亮的事件锚点优先，其次最近 `main` / `ball`，再其次最近 beat 的 mover；球员（含高亮参与者）用最近 mover / `main` 端点；高亮结束后球 SHALL 从事件终点续接，不得跳回高亮前的 `main`；稳定静止段的回扫 SHALL 命中该状态首段强制发出的 `main` / `ball`

### Requirement: 射门扑救字段（save_x/save_y/save_t）

`result=saved` 的 shot 事件 SHALL 携带 `save_x/save_y`（扑救点归一化坐标）与 `save_t`（扑救时刻，秒；可早于射门 `t_end`）。扑救点 SHALL 是门将可达集与球路径的最早交点，**可以不在门线上**；`x2/y2` SHALL 仍保持门线语义（L2 不变）。finalize SHALL 在 `save_t`，不是射门 `t_end`。该字段是协议 bump（随 `MODEL_VERSION 11→12`）。

#### Scenario: saved shot 携带扑救点/时刻

- **GIVEN** 一条 `result=saved` 的 shot 事件
- **WHEN** 引擎发射该事件
- **THEN** 事件含 `save_x/save_y/save_t`；`x2` 仍是攻方门线；`save_t` 可早于 `t_end`；finalize 在 `save_t`

#### Scenario: 非 saved shot 不带扑救字段

- **GIVEN** 一条 `goal` 或 `off_target` 的 shot 事件
- **WHEN** 引擎发射该事件
- **THEN** SHALL NOT 携带 `save_x/save_y/save_t`（或为 null）；不得用扑救字段改 L2 的 `x2/y2` 语义

## MODIFIED Requirements

### Requirement: 事件字段定义

每条事件 SHALL 包含：t（比赛时间秒）、type（事件类型）、subject（主球员 id）、x/y（发生位置归一化坐标）。可选的派生字段（from/to、x2/y2、result、speed、touch_freq、lead、score、detail、note、interceptor、receiver_x/receiver_y、loose_x/loose_y、carrier_from_x/carrier_from_y、keeper_x/keeper_y、**save_x/save_y/save_t**、h、card）按事件类型使用（card 仅 foul 用：`yellow`/`red`）。出界 pass（`result="out"`）SHALL 额外携带 `out_side`（`goal_line`/`sideline`）与 `out_pos`（真实越界坐标，可越界）；`x2/y2` 保留场内投影点（∈[0,1]）。

#### Scenario: 出界 pass 携带显式出界字段
- **GIVEN** 一条出界 pass 事件
- **THEN** 事件含 `result="out"`、`out_side`（goal_line/sideline）、`out_pos`（真实越界坐标）；`x2/y2` 为场内投影点（∈[0,1]）

### Requirement: beat 节拍事件字段

beat 节拍事件 SHALL 描述一个**段**内所有在移动球员的并行动作，顶层不携带 subject/x/y（主体与位置嵌套在 main/movers/ball 内）。beat SHALL 携带：`dt`（段长，∈ {0.1,0.2}；终场末段例外）；`movers`（并行跑位数组，增量——只含该段有非零位移的球员，`{id, from_x, from_y, to_x, to_y, speed, action}`）；持球者带球/控球时，若 carrier 在该段有非零位移则携带 `main`（`{type:'dribble', subject, x, y, x2, y2, speed, touch_freq}`，球轨迹由 main 驱动）；无持球者时，若球在该段有非零位移则携带 `ball`（`{x, y, x2, y2, speed, loose:true}`，球由 beat.ball 驱动）。**每个非高亮新状态（`controlled`/`loose`/`restart`）的首段即使零位移也 SHALL 携带 `main` / `ball`**；**高亮状态例外**：高亮事件本身 = 首锚点，`main`/`ball` SHALL NOT 携带，高亮结束后的首个 `controlled`/`loose` 段才强制携带。稳定静止段可以省略，viewer 保持上一状态。beat SHALL NOT 同时携带 main 与 ball（任意开放比赛时刻球有唯一驱动者）。高亮进行中，参与者在**有非零位移的段** SHALL 出现在 `movers`（`action:"highlight"`），零位移段保持上一位置；球由事件锚点驱动。

#### Scenario: 节拍含并行跑位
- **GIVEN** 一个段时刻
- **WHEN** 引擎产出一条 beat 事件
- **THEN** 携带 `movers`（只含该段有非零位移的球员，静止球员不在其中）；开放比赛无高亮时，持球者不出现在 movers（其移动只由 main 表达）；高亮进行中，参与者在**有非零位移的段** SHALL 出现在 movers（`action:"highlight"`），零位移段保持上一位置

#### Scenario: 持球者带球由 main 表达
- **GIVEN** 持球者在带球/控球（无高亮事件）
- **WHEN** 引擎产出一条 beat 事件
- **THEN** 若该段 carrier 有非零位移，携带 `main`（球轨迹 x/y→x2/y2 + speed 驱动）；**若该段是新状态首段，即使零位移也携带**；稳定静止段可以省略，viewer 保持上一状态

#### Scenario: 松散球由 ball 表达
- **GIVEN** 无持球者（抢断弹开等）
- **WHEN** 引擎产出一条 beat 事件
- **THEN** 若该段球有非零位移，携带 `ball`（`loose:true`，含滚动轨迹），球由 beat.ball 驱动；**新状态首段即使零位移也携带**；稳定静止段可以省略，viewer 保持最后位置

#### Scenario: main 与 ball 互斥
- **WHEN** 引擎产出一条 beat 事件
- **THEN** 不同时含 main 与 ball（唯一驱动者）

### Requirement: 重开准备期球锚点

角球/界外球发球准备期（RestartPrep，**指判定段之后、发球之前的每个准备段**——判定段本身不产 beat，见 match-engine 的 beat 段边界不变量）SHALL 产 beat 事件表达球停在固定点等待发球：**准备期的第一条 beat** SHALL 携带静止锚点 `beat.ball`（x==x2 且 y==y2，loose=true），坐标=角旗区/出界点；其后零位移的段可以省略 `ball`，viewer 保持该锚点。`movers` 含发球者/掷球者走向固定点的走位（**受速度/加速度/制动约束，不再有 dead-zone「位移 < 2m 不移动」语义**；发球者已在固定点、其余球员的目标都在到达半径内时该段 movers 可以为空）。发球高亮起点 = 发球者积分位置（目标=固定点，在 `REACH_TOL_M` 内；不要求精确等于固定点），viewer 连续播放无球瞬移。

#### Scenario: 准备期球停固定点
- **GIVEN** 一次角球/界外球发球准备期（判定段之后的准备段）
- **THEN** 准备期第一条 beat 的 `ball` 静止在角旗区/出界点（x==x2、y==y2），发球者/掷球者 mover 走向固定点；其后零位移段可省略；发球 pass 起点 = 发球者积分位置（与固定点差 ≤ `REACH_TOL_M`）
