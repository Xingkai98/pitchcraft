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

### Requirement: 高亮事件叠加播放

画面层 SHALL 在 beat 节拍流背景上叠加播放 v1 高亮事件（pass/shot/tackle），球轨迹由高亮事件驱动。

#### Scenario: 传球叠加在节拍上
- **GIVEN** 一条 pass 高亮事件跨越多个 beat 节拍
- **WHEN** 画面层播放该段
- **THEN** 球按 pass 事件时序飞行，同时背景节拍中其他球员并行跑位

### Requirement: 连续播放适配

画面层 SHALL 连续播放 beat 节拍流 + 高亮事件，事件边界无瞬移。

#### Scenario: 连续无瞬移
- **WHEN** 整场连续播放
- **THEN** 每个 beat/高亮事件边界处，球/球员位移不超过阈值（无 snap）
