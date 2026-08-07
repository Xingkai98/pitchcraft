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

### Requirement: 球相关队形目标

引擎 SHALL 为每名球员计算目标位置 = 角色站位基准 + 队形偏移（随球位置、控球阶段、球侧变化），使球队呈现整体伸缩/平移而非独立人偶回位。

#### Scenario: 防线随球前压/回撤
- **GIVEN** 球推进到前场
- **THEN** 防守线目标位置随球前压（push up）；球回撤到后场时防线回收（drop back）

#### Scenario: 全队随球侧平移
- **GIVEN** 球在球场左半
- **THEN** 全队目标位置向左偏移（ball-side shift），保持球侧紧凑

#### Scenario: 控球阶段压上
- **GIVEN** 己方持球
- **THEN** 全队目标位置前压；对方持球时回收

### Requirement: 控球阶段与攻防转换

引擎 SHALL 维护每队 phase（attack/defend/transition）；球权易主（抢断成功/拦截/扑救）时触发短 transition 窗口，新进攻方持球者前插、全队前压，新防守方回撤并就近收缩。

#### Scenario: 抢断成功触发反击
- **GIVEN** 一次抢断成功（球权易主）
- **THEN** 触发 transition：新持球者目标前移（高速推进），新进攻方队形前压，新防守方整体回撤并就近 1-2 人向持球者收缩

### Requirement: 球所有权与合成规则

引擎 SHALL 保证每个开放比赛时刻球有且只有一个驱动者：节拍 stretch 由 main 带球驱动，高亮期间由高亮事件驱动，松散球由 beat 携带 ball 坐标。高亮事件期间其参与者（接球者/门将/防守者）从 beat movers 排除。

#### Scenario: 节拍带球驱动
- **GIVEN** 持球者带球（无高亮事件）
- **THEN** beat 的 main 携带球轨迹（x/y→x2/y2+speed），球由 main 驱动

#### Scenario: 高亮期间排除参与者
- **GIVEN** 一条 pass 高亮事件进行中
- **THEN** 接球者/传球者在该高亮时序内不在 beat movers（或与高亮精确一致）；引擎 pos[] 对账到高亮结束位置

#### Scenario: 松散球
- **GIVEN** 无持球者（抢断弹开等）
- **THEN** beat 携带 ball 坐标（loose:true），viewer 可读松散球追逐

### Requirement: 确定性

引擎 SHALL 保持种子确定性：同 seed 同 config → 同事件流（含 beat 节拍与高亮事件）。

#### Scenario: 节拍确定性
- **WHEN** 同 seed 两次模拟
- **THEN** beat 节拍序列（movers/main）与高亮事件完全一致
