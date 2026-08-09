# Spec: match-engine

## MODIFIED Requirements

### Requirement: 比赛默认时长

引擎 SHALL 默认模拟 90 分钟比赛（`match_duration_seconds` 默认 5400），调用方仍可覆盖为任意时长（比赛内容与观看时长解耦）。

#### Scenario: 默认 90 分钟
- **GIVEN** 未显式指定时长
- **THEN** `MatchConfig::default_()` 的 `match_duration_seconds` = 5400

## ADDED Requirements

### Requirement: 死球重开频率

引擎 SHALL 使角球/界外球/头球频率接近真实比赛（90 分钟基准）：角球 ~6-9 次、界外球 ~17-21 次、头球动作 ~8-12 次。

#### Scenario: 角球频率
- **GIVEN** 一场 90 分钟比赛
- **THEN** 角球发球（pass detail=corner）6-9 次——saved-rebound 越线概率 80%、扑出率 50%

#### Scenario: 界外球频率
- **GIVEN** 一场 90 分钟比赛
- **THEN** 传球出边线（pass detail=out_sideline）17-21 次——出界率 8-10%、出界以边线为主（65%）

#### Scenario: 头球频率
- **GIVEN** 一场 90 分钟比赛
- **THEN** 头球动作（shot detail=header + pass detail=clearance + 禁区摆渡）8-12 次，随角球争抢自然产生

#### Scenario: 进球频率
- **GIVEN** 一场 90 分钟比赛
- **THEN** 进球（shot result=goal）3-3.5 次——普通射门 goal 率 9%、头球射门 8%
