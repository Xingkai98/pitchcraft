# Spec: pitch-viewer

## MODIFIED Requirements

### Requirement: 连续播放比赛

画面层 SHALL 支持整场连续播放：从第一个事件播到最后一个事件，事件间自动衔接，无瞬移。事件之间由 `off_ball_run`（无球跑位）锚点填满，画面持续有动作。

#### Scenario: 整场连续播放
- **WHEN** 用户启动连续播放
- **THEN** 画面从事件流开头连续推进到结尾，播完当前事件自动切下一个，直至 whistle

#### Scenario: 事件间无球跑位
- **WHEN** 两个事件之间存在时间空档
- **THEN** 球员按 `off_ball_run` 事件持续小步移动（短距离碎步），画面不静止；事件边界位移小于阈值（不 snap）

#### Scenario: 整场重播
- **WHEN** 用户点击重播
- **THEN** 画面回到事件流开头并连续播放（固定种子 → 同场可重放）

#### Scenario: 连续边界无瞬移
- **WHEN** 整场连续播放
- **THEN** 每个事件边界处，球/球员位移不超过配置阈值（端到端断言）

#### Scenario: 事件驱动时间一致性
- **WHEN** 连续播放
- **THEN** 引擎事件 t 间隔 ≈ 画面演绎时长（动作一个接一个，播完一个恰好接下一个，无空档、无重叠）

#### Scenario: 整场进度条
- **WHEN** 用户查看播放进度
- **THEN** 显示整场时间轴/进度条（可拖动到任意时刻），并显示当前比赛时间/总时长

### Requirement: off_ball_run 演绎

画面层 SHALL 将 `off_ball_run`（无球跑位）事件演绎为短距离碎步移动：球员从起点向终点移动，时长由距离÷跑速计算。

#### Scenario: 碎步移动
- **GIVEN** 一条 off_ball_run 事件，带 subject/x/y/x2/y2/speed
- **WHEN** 画面层演绎该事件
- **THEN** 球员从 (x,y) 移动到 (x2,y2)，时长 = 距离÷speed，画面呈现"碎步调整"

### Requirement: 连续模式重复段处理

画面层 SHALL 在连续模式下避免重复演绎同一段带球：若 tackle 前正好是同一被铲者的 dribble（`carrier_from` 与上一事件终态一致），丢弃 carry-beat 起点，被铲者直接从接触点开始（不重现带球段）。

#### Scenario: 丢弃 carry-beat
- **GIVEN** 连续模式下，tackle 的 `carrier_from` 等于上一 dribble 的终点（同一被铲者）
- **WHEN** 画面层演绎该 tackle
- **THEN** 被铲者起点设为接触点，不重现带球段；只在 tackle 内演"逼近→碰撞→弹开→捡球"
