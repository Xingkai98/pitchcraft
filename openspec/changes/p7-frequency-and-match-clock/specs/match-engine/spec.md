# Spec: match-engine

## MODIFIED Requirements

### Requirement: 比赛默认时长

引擎 SHALL 默认模拟 90 分钟比赛（`match_duration_seconds` 默认 5400），调用方可为 5/10/45/90 分钟（300/600/2700/5400s）——事件流时间范围随参数。

#### Scenario: 默认 90 分钟
- **GIVEN** 未显式指定时长
- **THEN** `MatchConfig::default_()` 的 `match_duration_seconds` = 5400

#### Scenario: 5 分钟比赛
- **GIVEN** match_duration_seconds=300
- **THEN** 事件流末尾 whistle 的 t=300（05:00）

## ADDED Requirements

### Requirement: 精彩事件固定产出

引擎 SHALL 固定每场核心精彩事件数量（`HIGHLIGHTS_PER_MATCH` ~40），不随时长漂移：5 分钟与 90 分钟比赛产出相同数量级的射门/角球/界外球/头球/抢断。实现为槽位驱动（比赛时间均匀划分 N 槽，每槽必产一个高亮）。

#### Scenario: 时长不影响精彩事件数
- **GIVEN** 一场 5 分钟比赛与一场 90 分钟比赛
- **THEN** 两者核心精彩事件总数（shot + 角球 + 界外球 + 头球 + tackle）落在同一区间（±20%）

#### Scenario: 槽位驱动
- **GIVEN** 比赛时长 T、高亮总数 N
- **THEN** 高亮事件近似均匀分布在时间轴（相邻高亮间距 ≈ T/N），非高亮段只有 beat（稀疏节拍，无高亮）

### Requirement: 派生概率固定

引擎 SHALL 固定派生事件概率（保证精彩事件数量稳定）：pass 出界率 8-10%（边线 65%）、射门 saved 扑出 60% + 越线 90%、射门 goal 9%、头球 goal 8%。

#### Scenario: 界外球数量稳定
- **GIVEN** 多场不同时长比赛
- **THEN** 每场界外球（pass detail=out_sideline）数量落在稳定区间（~8±3）
