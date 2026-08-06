# Spec: pitch-viewer

## MODIFIED Requirements

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
