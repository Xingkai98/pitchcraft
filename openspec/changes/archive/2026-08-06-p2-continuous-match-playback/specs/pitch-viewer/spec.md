# Spec: pitch-viewer

## MODIFIED Requirements

### Requirement: 事件演绎遵循剧本

画面层 SHALL 按演绎剧本渲染动作，实现人球解耦——人不是和球一起平移。

#### Scenario: 抢断演绎（五段式，带球中被抢）
- **GIVEN** 一条 tackle 事件，带 `subject`（防守者）、`to`（被铲者）、`x/y`（防守者起点）、`carrier_from_x/y`（被铲者带球起点）、`x2/y2`（接触点）、可选 `loose_x/y`（弹开点）、`result`
- **WHEN** 画面层演绎该事件
- **THEN** 被铲者从 `carrier_from` 带球到接触点，防守者同时从 `x/y` 逼近到接触点，碰撞后球向弹开点（优先引擎 `loose_x/y`，缺失则画面自算）弹出，按 `result` 决定捡球者（success=防守者 / fail=原持球人）
