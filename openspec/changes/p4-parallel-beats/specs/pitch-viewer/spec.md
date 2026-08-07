# Spec: pitch-viewer

## ADDED Requirements

### Requirement: beat 节拍演绎

画面层 SHALL 将 `beat` 节拍事件演绎为并行移动：movers 数组中的每个球员从 from 位置移动到 to 位置（时长由距离÷speed 决定），同拍内多个球员同时移动；静止球员（不在 movers）保持原位。

#### Scenario: 多球员并行移动
- **GIVEN** 一条 beat 事件，movers 含多个球员
- **WHEN** 画面层演绎该事件
- **THEN** 所有 movers 中的球员同时移动（并行），静止球员 hold

#### Scenario: 焦点 main 叠加
- **GIVEN** 一条 beat 事件，main 描述持球者焦点动作
- **WHEN** 画面层演绎该事件
- **THEN** main 描述的焦点（带球/传球/射门）按事件时序演绎，与 movers 并行共存

### Requirement: 高亮事件叠加播放（两层合成）

画面层 SHALL 在 beat 节拍流背景上叠加播放 v1 高亮事件（pass/shot/tackle），球轨迹由高亮事件驱动。高亮期间其参与者（接球者/门将/防守者）以高亮为准，忽略重叠的 beat movers。

#### Scenario: 传球叠加在节拍上
- **GIVEN** 一条 pass 高亮事件跨越多个 beat 节拍
- **WHEN** 画面层播放该段
- **THEN** 球按 pass 事件时序飞行；接球者/传球者按高亮演绎（忽略同拍 beat movers）；背景节拍中其他球员并行跑位

#### Scenario: 节拍带球可见
- **GIVEN** 持球者带球（无高亮）
- **WHEN** 画面层播放该段
- **THEN** 球随 main 带球轨迹移动，始终可见（持球者脚下/前方），不冻结

#### Scenario: 松散球可见
- **GIVEN** beat 携带 ball（loose:true）
- **WHEN** 画面层播放该段
- **THEN** 球按 ball 坐标移动（松散球追逐），不冻结

### Requirement: 连续播放适配

画面层 SHALL 连续播放 beat 节拍流 + 高亮事件，事件边界无瞬移；跨 beat 连续移动（from(N+1)==to(N)）时平滑衔接。

#### Scenario: 连续无瞬移
- **WHEN** 整场连续播放
- **THEN** 每个 beat/高亮事件边界处，球/球员位移不超过阈值（无 snap）

#### Scenario: 跨 beat 连续
- **GIVEN** 一名球员连续多拍移动
- **THEN** 后拍 from == 前拍 to（精确衔接），无 hold-then-jump
