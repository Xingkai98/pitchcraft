# Spec: match-engine

## MODIFIED Requirements

### Requirement: 抢断语义（就近防守 + 可失败 + 带球中被抢）

引擎 SHALL 让防守者对持球者发起抢断：防守者必须是**离持球者最近的对方球员**（且距离不超过阈值，约 10m；超过则不产 tackle 事件），抢断结果按概率 success/fail，事件携带抢断所需完整坐标语义。

#### Scenario: 就近防守
- **GIVEN** 一次抢断决策
- **THEN** 引擎选择离持球者最近的对方球员作为防守者；距离超过阈值（约 10m 归一化）时不产 tackle，落回其他事件类型

#### Scenario: 抢断可失败
- **WHEN** 引擎产出一条 tackle 事件
- **THEN** `result` 为 `success`（约 70%）或 `fail`（约 30%）

#### Scenario: 抢断成功状态更新
- **GIVEN** tackle `result=success`
- **THEN** 球权归防守者，持球者变为防守者，且防守者位置更新到弹开点 `(loose_x, loose_y)`

#### Scenario: 抢断失败状态更新
- **GIVEN** tackle `result=fail`
- **THEN** 球权保留原持球者，持球者留在接触点附近

### Requirement: 抢断事件携带完整坐标语义

tackle 事件 SHALL 携带：防守者起点 `x/y`、被铲者带球起点 `carrier_from_x/carrier_from_y`、接触点 `x2/y2`、弹开点 `loose_x/loose_y`。

#### Scenario: 带球起点
- **WHEN** 引擎产出一条 tackle 事件
- **THEN** `carrier_from_x/carrier_from_y` 等于被铲者（持球者）上一位置，`x2/y2` 等于被铲者当前位置（接触点）

#### Scenario: 弹开点
- **WHEN** 引擎产出一条 tackle 事件
- **THEN** `loose_x/loose_y` 为确定性弹开点：逼近方向垂线 × 弹开距离，优先场内、越界钳制、零距离退化——与画面层 `deflectPoint` 同规则

#### Scenario: 确定性
- **WHEN** 同 seed 同 config 两次模拟
- **THEN** tackle 事件的选择、结果、弹开点全部一致
