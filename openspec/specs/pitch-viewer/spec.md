# pitch-viewer Specification

## Purpose
TBD - created by archiving change p0-event-to-pitch. Update Purpose after archive.
## Requirements
### Requirement: Canvas 渲染圆点球场

画面层 SHALL 使用 JS + Canvas 渲染俯视球场，球员画为圆点（两队不同颜色，门将可区分），球画为小圆点。

#### Scenario: 渲染球场
- **WHEN** 画面层初始化
- **THEN** 在 Canvas 上绘制草地与球场白线（边线、中线、中圈、禁区）

#### Scenario: 渲染球员与球
- **WHEN** 画面层收到事件流
- **THEN** 按事件位置渲染 22 个球员圆点与球，主客队颜色不同

### Requirement: 消费事件流播放比赛

画面层 SHALL 按事件流的 t 推进播放时刻，把事件演绎成动画，形成连续比赛画面。

#### Scenario: 播放事件流
- **WHEN** 画面层收到一条事件流
- **THEN** 按时间顺序播放，画面随时间推进显示球员移动、传球、射门等动作

### Requirement: 事件演绎遵循剧本

画面层 SHALL 按演绎剧本渲染动作，实现人球解耦——人不是和球一起平移。

#### Scenario: 抢断演绎（五段式，带球中被抢）
- **GIVEN** 一条 tackle 事件，带 `subject`（防守者）、`to`（被铲者）、`x/y`（防守者起点）、`carrier_from_x/y`（被铲者带球起点）、`x2/y2`（接触点）、可选 `loose_x/y`（弹开点）、`result`
- **WHEN** 画面层演绎该事件
- **THEN** 被铲者从 `carrier_from` 带球到接触点，防守者同时从 `x/y` 逼近到接触点，碰撞后球向弹开点（优先引擎 `loose_x/y`，缺失则画面自算）弹出，按 `result` 决定捡球者（success=防守者 / fail=原持球人）

### Requirement: 演绎节奏配置化（S4 边界明确）

演绎节奏参数（phase 时长、人球分离量）SHALL 放在配置文件，便于调参。**参数分工**：per-event 速度/提前量/触球频率 SHALL 来自事件载荷（事件值优先）；config SHALL 只放动画时序（phase 时长、人球分离量），不覆盖事件的速度/提前量/触球频率。

#### Scenario: 调整演绎节奏
- **WHEN** 开发者修改演绎节奏配置文件
- **THEN** 画面层的动作节奏随之变化，无需改代码

### Requirement: 第一版做简单演绎

P0 画面层 SHALL 只做简单演绎：带球不变向、传球直线（不做外弧），先验证链路。

#### Scenario: 直线直传
- **WHEN** 画面层演绎传球/带球
- **THEN** 球沿直线移动，不做外弧/变向（第一版）

