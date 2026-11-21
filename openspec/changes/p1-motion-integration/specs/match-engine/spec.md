# Spec: match-engine

## ADDED Requirements

### Requirement: 每球员连续运动状态

引擎 SHALL 为每名球员维护连续运动状态（位置、速度、朝向），并 SHALL 在内部米制坐标中按固定仿真步长积分。球员速度变化 SHALL 受加速度上限约束；转向 SHALL 受侧向加速度/角速度上限约束。引擎 SHALL NOT 使用「距目标小于固定 dead-zone 即整拍不移动」的冻结语义；到达目标 SHALL 用制动曲线/到达半径表达。

#### Scenario: 加速与制动

- **GIVEN** 一名球员静止，目标在其前方 30m
- **WHEN** 连续仿真 2s
- **THEN** 速度从 0 单调增加且不超过 `V_MAX`，位置连续变化；接近目标时速度下降而非瞬停

#### Scenario: 转向受限

- **GIVEN** 一名球员以 6 m/s 向 +x 移动，目标突然出现在 -x
- **WHEN** 下一个仿真子步
- **THEN** 朝向变化不超过 `MAX_TURN_RATE × SIM_DT`，速度方向不会瞬时反转

#### Scenario: 同队分离不绕过加速度约束

- **GIVEN** 同队两名球员的路径将进入 2.2m 内
- **WHEN** 分离约束触发
- **THEN** 位置修正 SHALL 同时更新速度/朝向，且下一子步仍满足加速度上限；SHALL NOT 只改端点而跳过速度修正

### Requirement: 三层仿真 cadence

引擎 SHALL 区分仿真积分步长 `SIM_DT`、决策/概率掷定间隔 `DECISION_DT` 与 beat 输出间隔 `BEAT_DT`；仿真子步 SHALL NOT 新增随机抽样，决策/概率事件的频率 SHALL 只由 `DECISION_DT` 决定。

#### Scenario: 仿真是子步而不是新决策

- **GIVEN** 一个 `DECISION_DT` 内包含 5 个 `SIM_DT`
- **WHEN** 5 个仿真子步执行完毕
- **THEN** 只发生一次决策/概率掷定；仿真子步只更新位置、速度、朝向

#### Scenario: beat 与决策解耦

- **GIVEN** `BEAT_DT=0.2s`、`DECISION_DT=0.5s`
- **WHEN** 开放比赛连续运行 1s
- **THEN** beat 按 0.2s 输出，决策只在 0.5s 边界发生；beat 不改变决策状态，决策不强制 beat 对齐

### Requirement: 运动目标的决策拍保持

无球/持球目标 SHALL 在 `DECISION_DT` 边界更新，并在仿真子步内保持；仿真子步 SHALL NOT 重新采样目标或随机扰动目标点。

#### Scenario: 子步内目标稳定

- **GIVEN** 一个 `DECISION_DT` 内的 5 个仿真子步
- **WHEN** 子步逐个执行
- **THEN** 该球员的目标点在同一 `DECISION_DT` 内保持不变
