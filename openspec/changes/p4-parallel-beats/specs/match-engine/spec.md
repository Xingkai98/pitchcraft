# Spec: match-engine

## ADDED Requirements

### Requirement: 固定 tick 时间推进

引擎 SHALL 按固定时间间隔（1s）推进比赛时间，每个 tick 更新全部 22 名球员的位置/动作状态，并产出一条 beat 节拍事件。

#### Scenario: 固定 tick 产节拍
- **WHEN** 引擎模拟一场比赛
- **THEN** 每 1s 产一条 beat 事件，覆盖整场（约 2700 条），事件 t 严格单调递增

#### Scenario: 关键时刻仍产高亮事件
- **WHEN** 传球/射门/抢断发生
- **THEN** 引擎仍产出 v1 高亮事件（pass/shot/tackle），叠加在 beat 节拍流上，按自己的时序（动作时长）呈现

### Requirement: 全员状态逐 tick 更新

引擎 SHALL 维护 22 名球员的实时位置 `pos[22]`，每 tick 为每个球员决策目标位置：持球者带球、队友向角色基准点跑位/卡位、门将回位，更新 pos[] 并反映在 beat 的 movers 中。

#### Scenario: 持球者带球
- **GIVEN** 持球者在带球
- **THEN** beat 的 main 描述带球，movers 含持球者当前位置更新

#### Scenario: 队友向基准点跑位
- **GIVEN** 一名无球球员偏离角色基准点
- **THEN** beat 的 movers 含该球员向基准点调整/回位的移动

#### Scenario: 门将回位
- **GIVEN** 门将偏离门线
- **THEN** beat 的 movers 含门将向门线回位的移动

### Requirement: 角色基准点

引擎 SHALL 为每名球员定义角色站位基准（GK/DF/MF/FW 的 home 位置），无球跑位向基准点附近调整，偏离时回位。

#### Scenario: 无球跑位有方向
- **WHEN** 一名无球球员需要调整位置
- **THEN** 其移动目标由角色基准点决定（回位/拉开/压上），而非随机小幅移动

### Requirement: 确定性

引擎 SHALL 保持种子确定性：同 seed 同 config → 同事件流（含 beat 节拍与高亮事件）。

#### Scenario: 节拍确定性
- **WHEN** 同 seed 两次模拟
- **THEN** beat 节拍序列（movers/main）与高亮事件完全一致
