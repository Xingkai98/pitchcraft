# Spec: match-engine

## MODIFIED Requirements

### Requirement: 事件驱动时间推进

引擎 SHALL 用事件驱动时间推进：事件 t 的增量 = 当前动作的实际时长（距离÷速度）+ 决策停顿，而非固定时间间隔。事件流 = 动作一个接一个。

#### Scenario: 动作时长决定时间间隔
- **GIVEN** 一次传球（距离 d 米、球速 s m/s）
- **THEN** 下一事件 t ≥ 当前事件 t + d/s + 决策停顿

#### Scenario: 事件 t 单调递增
- **WHEN** 引擎产出一场事件流
- **THEN** 事件 t 严格单调递增，且间隔与动作内容一致

### Requirement: 无球跑位事件（off_ball_run）

引擎 SHALL 在有球事件间穿插 `off_ball_run` 事件：球员做短距离碎步移动（1-2m），从当前 pos 向战术位置/球附近移动。事件带 subject/x/y/x2/y2/speed。

#### Scenario: 无球跑位
- **WHEN** 引擎在两个有球事件之间
- **THEN** 产出一条或多条 off_ball_run 事件，球员小步移动，时长 = 距离÷跑速

#### Scenario: 无球跑位确定性
- **WHEN** 同 seed 同 config 两次模拟
- **THEN** off_ball_run 事件序列（哪些球员、何时、跑多远）一致

### Requirement: 进球时间偏移

引擎 SHALL 在进球后给 whistle/kickoff 加时间偏移：shot 进球 → whistle +2s → kickoff +5s（球先飞进球门、哨响、再开球），避免同刻导致球瞬移回中圈。

#### Scenario: 进球后时间错开
- **GIVEN** 一次射门进球
- **THEN** whistle 的 t = shot 的 t + 2s；kickoff 的 t = shot 的 t + 5s

### Requirement: carrier_from 对称刷新

引擎 SHALL 在 shot 分支"持球者不在进攻半场"（静默迭代）时也刷新 `carrier_from = pos_p`，与产事件分支对称，避免后续 tackle 携带过期的带球起点。

#### Scenario: 静默迭代刷新 carrier_from
- **GIVEN** 持球者不在进攻半场（shot 分支 guard 不满足，不产事件）
- **THEN** `carrier_from` 仍更新为持球者当前 pos（不残留旧值）
