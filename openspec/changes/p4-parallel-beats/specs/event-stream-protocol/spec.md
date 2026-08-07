# Spec: event-stream-protocol

## ADDED Requirements

### Requirement: beat 节拍事件（协议 v2）

事件流 SHALL 支持 `beat` 节拍事件：每个固定时间间隔（1s）产一条，描述该时刻所有在移动球员的并行动作。beat 携带 `movers`（并行跑位数组，增量——只含移动的球员）；持球者有焦点动作时携带 `main`（焦点事件描述）。

#### Scenario: 节拍含并行跑位
- **GIVEN** 一个 tick 时刻
- **WHEN** 引擎产出一条 beat 事件
- **THEN** 携带 `movers: [{id, from_x, from_y, to_x, to_y, speed, action}]`，列出正在移动的球员（带球/跑位/门将移动等）；静止球员不在 movers 中

#### Scenario: 节拍含焦点 main
- **GIVEN** 持球者在带球/控球（无高亮事件）
- **WHEN** 引擎产出一条 beat 事件
- **THEN** 携带 `main` 描述带球（如 `{type:'dribble', subject, x, y, x2, y2, speed}`），与 movers 并存，球轨迹由 main 驱动
- **注**：pass/shot/tackle 不进入 main（只走高亮事件，避免双播）

#### Scenario: 向后兼容
- **WHEN** viewer 收到 v1 事件（pass/dribble/shot/tackle 等）
- **THEN** 仍能解析演绎（与 beat 共存，高亮事件叠加）

### Requirement: 球位置驱动

球的位置 SHALL 在任意开放比赛时刻由唯一驱动者决定：节拍 stretch 由 main 带球驱动，高亮期间由高亮事件驱动，松散球由 beat 携带 ball 坐标。

#### Scenario: 传球球轨迹
- **GIVEN** 一条 pass 事件跨多个 tick
- **THEN** 球位置由 pass 事件的 x/y→x2/y2 + speed 在飞行时序内插值（高亮驱动），beat 不重复驱动球

#### Scenario: 节拍带球
- **GIVEN** 持球者带球（无高亮）
- **THEN** beat 的 main 携带球轨迹（x/y→x2/y2+speed），球由 main 驱动

#### Scenario: 松散球
- **GIVEN** 无持球者（抢断弹开等）
- **THEN** beat 携带 ball 坐标（loose:true），viewer 可读松散球
