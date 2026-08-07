# Spec: event-stream-protocol

## ADDED Requirements

### Requirement: beat 节拍事件（协议 v2）

事件流 SHALL 支持 `beat` 节拍事件：每个固定时间间隔（1s）产一条，描述该时刻所有在移动球员的并行动作。beat 携带 `movers`（并行跑位数组，增量——只含移动的球员）；持球者带球/控球时携带 `main`（带球轨迹）；松散球时携带 `ball`（loose）。

#### Scenario: 节拍含并行跑位
- **GIVEN** 一个 tick 时刻
- **WHEN** 引擎产出一条 beat 事件
- **THEN** 携带 `movers: [{id, from_x, from_y, to_x, to_y, speed, action}]`，列出正在移动的球员；静止球员不在 movers 中；`to` = tick 步进终点（pos after ≤1s movement at speed）

#### Scenario: 节拍含带球 main
- **GIVEN** 持球者在带球/控球（无高亮事件）
- **WHEN** 引擎产出一条 beat 事件
- **THEN** 携带 `main`（如 `{type:'dribble', subject, x, y, x2, y2, speed}`），球轨迹由 main 驱动；每个持球 tick 都发 main（含零位移控球）；main 每拍推进 ≤ speed×1s（约 5-7m）

#### Scenario: carrier 不进 movers（main-only）
- **GIVEN** 持球者在带球/控球
- **WHEN** 引擎产出一条 beat 事件
- **THEN** 持球者不出现在 movers 中（其移动只由 main 表达）；movers 只含无球跑位球员

#### Scenario: 松散球
- **GIVEN** 无持球者（抢断弹开等）
- **WHEN** 引擎产出一条 beat 事件
- **THEN** 携带 `ball: {x, y, loose:true}`，球由 beat.ball 驱动

#### Scenario: 向后兼容
- **WHEN** viewer 收到 v1 事件（pass/shot/tackle 等）
- **THEN** 仍能解析演绎（与 beat 共存，高亮事件叠加）；demo_mode 保持 v1 事件驱动

### Requirement: 球位置驱动

球的位置 SHALL 在任意开放比赛时刻由唯一驱动者决定，优先级链：高亮 > main(带球) > beat.ball(松散) > hold(死球)。

#### Scenario: 高亮驱动球
- **GIVEN** 一条 pass 事件跨多个 tick
- **THEN** 球位置由 pass 事件的 x/y→x2/y2 + speed 在飞行时序内插值（高亮驱动），beat 不重复驱动球

#### Scenario: main 驱动球
- **GIVEN** 持球者带球（无高亮）
- **THEN** beat 的 main 携带球轨迹（x/y→x2/y2+speed），球由 main 驱动

#### Scenario: 松散球驱动
- **GIVEN** 无持球者
- **THEN** beat 携带 ball 坐标（loose:true），球由 beat.ball 驱动

### Requirement: 高亮事件锚点对齐

pass/shot/tackle 高亮事件 SHALL 起点对齐整数 tick（量化到 1s 边界），并携带参与者精确起点；覆盖区间为 [t_start, t_end)（t_end = 自然飞行终点，可非整数）；任意时刻至多一条飞行中高亮。

#### Scenario: 高亮起点对齐
- **GIVEN** 一条高亮事件
- **THEN** 其 t 为整数（1s tick 边界），高亮 tick 不产 main

#### Scenario: 高亮覆盖区间
- **GIVEN** 一条高亮事件的起点 t_start 为整数 tick
- **THEN** 覆盖区间为 [t_start, t_end)，t_end = 自然飞行终点（可非整数）；main 从接球者持球后的首个 tick 边界恢复（该恢复规则在 viewer 两层合成中生效）

#### Scenario: 至多一条飞行中高亮
- **WHEN** 一条高亮事件在飞行中
- **THEN** 引擎不产新的高亮事件（球优先级链在任意时刻定义明确）

#### Scenario: 参与者起点精确
- **GIVEN** 一条 pass/shot/tackle 高亮事件
- **THEN** 携带参与者精确起点（pass: passer_x/y+receiver_x/y；shot: shooter_x/y+keeper_x/y；tackle: carrier_from+tackler_x/y），无 fallback

### Requirement: movers/main/ball 互斥

beat 事件 SHALL NOT 同时携带 main 与 ball（唯一驱动者）；movers 的 id 唯一且在 0-21；坐标在 [0,1]。

#### Scenario: 唯一驱动校验
- **WHEN** 引擎产出一条 beat 事件
- **THEN** 不同时含 main 和 ball；movers id 唯一且在 0-21；坐标在 [0,1]
