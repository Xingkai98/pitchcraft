# Spec: pitch-viewer

## ADDED Requirements

### Requirement: beat 节拍演绎

画面层 SHALL 将 `beat` 节拍事件演绎为并行移动：movers 数组中的每个球员从 from 位置移动到 to 位置，动画铺满整拍（1s tick 窗口内缓动到位；speed 决定缓动节奏，非动画时长），同拍内多个球员同时移动；静止球员（不在 movers）保持原位。

#### Scenario: 多球员并行移动
- **GIVEN** 一条 beat 事件，movers 含多个球员
- **WHEN** 画面层演绎该事件
- **THEN** 所有 movers 中的球员同时移动（并行），静止球员 hold；movers 动画铺满整拍（缓动到位，非动 0.3s 停 0.7s）

#### Scenario: 跨 beat 连续
- **GIVEN** 一名球员连续多拍移动（或中途缺席后重新出现）
- **THEN** 后拍 from == 前拍 to（引擎 last-emitted-pos 保证，跨缺席也精确衔接），无 hold-then-jump

### Requirement: 两层合成（高亮覆盖 beat）

画面层 SHALL 在 beat 节拍流背景上叠加 v1 高亮事件（pass/shot/tackle）。高亮期间其参与者（接球者/门将/防守者）以高亮为准，忽略重叠的 beat movers。合成在 buildTimeline 层面以纯函数完成（可单测）。

#### Scenario: 传球叠加在节拍上
- **GIVEN** 一条 pass 高亮事件跨越多个 beat 节拍
- **WHEN** 画面层播放该段
- **THEN** 球按 pass 事件时序飞行；接球者/传球者按高亮演绎（忽略同拍 beat movers）；背景节拍中其他球员并行跑位

#### Scenario: 高亮起点整数 tick
- **GIVEN** 一条高亮事件起点在整数 tick
- **WHEN** 画面层播放该段
- **THEN** 该 tick 不产 main，高亮从该 tick 起是唯一驱动者（无双重驱动）

#### Scenario: 高亮覆盖区间与 main 恢复
- **GIVEN** 一条高亮事件覆盖 [t_start, t_end)，t_end 为自然飞行终点（可非整数）
- **WHEN** 画面层播放该段
- **THEN** 高亮期间以高亮为准；t_end 到下一整数 tick 边界之间在各自高亮结束位置 hold（球与参与者）；从下一 tick 边界起按 D12 交接（main/beat.ball/hold 恢复，球驱动平滑切换，无瞬移）

#### Scenario: 高亮参与者回归无回弹
- **GIVEN** 一名高亮参与者退出高亮
- **WHEN** 画面层播放该段
- **THEN** 该参与者从高亮结束位置继续（viewer 用高亮结束位置衔接 beat movers，不回弹）

#### Scenario: v2 tackle 零长度 carry
- **GIVEN** 一条 v2 tackle 高亮事件（carrier_from == x2/y2，接触点）
- **WHEN** 画面层演绎该事件
- **THEN** 跳过被铲者带球段（carry-beat 归零，无零长度带球动画），直接从接触点起演绎逼近/碰撞/弹开

### Requirement: 球可见性

画面层 SHALL 保证球在任意开放时刻可见并移动：main 带球时球随 main 轨迹；高亮时球随高亮轨迹；松散球时球随 beat.ball 坐标。

#### Scenario: 节拍带球可见
- **GIVEN** 持球者带球（无高亮）
- **WHEN** 画面层播放该段
- **THEN** 球随 main 带球轨迹移动，始终可见（持球者脚下/前方），不冻结

#### Scenario: 松散球可见
- **GIVEN** beat 携带 ball（loose:true）
- **WHEN** 画面层播放该段
- **THEN** 球按 ball 坐标移动（松散球追逐），不冻结

#### Scenario: 死球 hold
- **GIVEN** 进球庆祝/开球准备（无 main/高亮/松散球）
- **WHEN** 画面层播放该段
- **THEN** 球在最后已知位置 hold（不冻结成驱动者）

### Requirement: 连续播放适配

画面层 SHALL 连续播放 beat 节拍流 + 高亮事件，事件边界无瞬移。

#### Scenario: 连续无瞬移
- **WHEN** 整场连续播放
- **THEN** 每个 beat/高亮事件边界处，球/球员位移不超过阈值（无 snap）

#### Scenario: 死球→kickoff 例外
- **GIVEN** 进球庆祝结束、kickoff 重开
- **WHEN** 画面层播放该段
- **THEN** 允许球从最后已知位置跳变到中圈（kickoff 重开为显式例外，不计入无 snap 判定）

#### Scenario: 高亮参与者排除无双重驱动
- **WHEN** 高亮事件与 beat 重叠
- **THEN** 高亮参与者不出现在 beat movers 中（buildTimeline 纯函数排除），无同一球员双重渲染
