# Spec: match-engine

## ADDED Requirements

### Requirement: 抢断触发决策（距离感知 + 抢断积极性）

引擎 SHALL 不固定概率必抢，而是由防守者基于情境自行判断是否抢断：存在距持球者 ≤ 阈值的对方球员时，以低概率（抢断积极性）决定是否真的去抢；超阈值或无积极性则不产 tackle。参数为引擎内常量 + `should_tackle()` 决策函数。

#### Scenario: 就近防守
- **GIVEN** 一个事件点
- **THEN** 引擎找离持球者最近的对方球员（用实时 pos[]）；最近距离超过阈值（约 10m）时不产 tackle

#### Scenario: 超阈值落回进攻
- **GIVEN** 最近防守者距离超过阈值
- **THEN** 不产 tackle，该次机会重掷落回 pass/dribble/shot（当作普通进攻事件处理）

#### Scenario: 抢断积极性
- **GIVEN** 最近防守者距离 ≤ 阈值
- **THEN** 以低概率（抢断积极性，标定约 0.09，目标每场 8-15 次）决定是否真的去抢；概率不中则继续进攻

#### Scenario: 抢断频率目标
- **WHEN** 一整场比赛（2700s）模拟
- **THEN** tackle 事件总数落在约 8-15 次（用户确认目标）

#### Scenario: 抢断可失败
- **WHEN** 引擎产出一条 tackle 事件
- **THEN** `result` 为 `success`（约 50%）或 `fail`（约 50%）

#### Scenario: 抢断成功状态更新
- **GIVEN** tackle `result=success`
- **THEN** 球权归防守者，持球者变为防守者，且防守者位置更新到弹开点 `(loose_x, loose_y)`（下一事件从 loose 出发，不 snap）

#### Scenario: 抢断失败状态更新
- **GIVEN** tackle `result=fail`
- **THEN** 球权保留原持球者，被铲者位置更新到弹开点（追回球），防守者停在接触点——两端状态一致，下一事件不 snap

### Requirement: 抢断事件携带完整坐标语义

tackle 事件 SHALL 携带：防守者起点 `x/y`、被铲者带球起点 `carrier_from_x/carrier_from_y`、接触点 `x2/y2`、弹开点 `loose_x/loose_y`。

#### Scenario: 带球起点
- **WHEN** 引擎产出一条 tackle 事件
- **THEN** `carrier_from_x/carrier_from_y` 等于被铲者（持球者）上一位置，`x2/y2` 等于被铲者当前位置（接触点）

#### Scenario: 弹开点（success/fail 都发）
- **WHEN** 引擎产出一条 tackle 事件
- **THEN** `loose_x/loose_y` 为确定性弹开点：逼近方向垂线 × 弹开距离，优先场内、越界钳制、零距离退化——与画面层 `deflectPoint` 同规则；success 与 fail 均携带

#### Scenario: 确定性
- **WHEN** 同 seed 同 config 两次模拟
- **THEN** tackle 事件的选择、结果、弹开点全部一致
