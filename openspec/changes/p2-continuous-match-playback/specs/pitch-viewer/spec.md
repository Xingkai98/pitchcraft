# Spec: pitch-viewer

## MODIFIED Requirements

### Requirement: 事件演绎遵循剧本

画面层 SHALL 按演绎剧本渲染动作，实现人球解耦——人不是和球一起平移。

#### Scenario: 抢断演绎（五段式，带球中被抢）
- **GIVEN** 一条 tackle 事件，带 `subject`（防守者）、`to`（被铲者）、`x/y`（防守者起点）、`carrier_from_x/y`（被铲者带球起点）、`x2/y2`（接触点）、可选 `loose_x/y`（弹开点）、`result`
- **WHEN** 画面层演绎该事件
- **THEN** 被铲者从 `carrier_from` 带球到接触点，防守者同时从 `x/y` 逼近到接触点，碰撞后球向弹开点（优先引擎 `loose_x/y`，缺失则画面自算）弹出，按 `result` 决定捡球者（success=防守者 / fail=原持球人）

### Requirement: 连续播放比赛

画面层 SHALL 支持整场连续播放：从第一个事件播到最后一个事件，事件间自动衔接，无瞬移。

#### Scenario: 整场连续播放
- **WHEN** 用户启动连续播放
- **THEN** 画面从事件流开头连续推进到结尾，播完当前事件自动切下一个，直至 whistle

#### Scenario: 事件间 hold
- **WHEN** 两个事件之间存在时间空档
- **THEN** 球员与球保持上一事件终态（球停在持球者脚下），事件边界位移小于阈值（不 snap）

#### Scenario: 整场重播
- **WHEN** 用户点击重播
- **THEN** 画面回到事件流开头并连续播放（固定种子 → 同场可重放）

#### Scenario: 连续边界无瞬移
- **WHEN** 整场连续播放
- **THEN** 每个事件边界处，球/球员位移不超过配置阈值（端到端断言）
