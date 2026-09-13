# Spec: diagnosis-runner

## ADDED Requirements

### Requirement: player_overlap 同队间距 detector

确定性审计 SHALL 新增 `player_overlap` detector：对观察窗口内的球员快照，按 id 范围判定同队（0-10 home / 11-21 away），SHALL 对「同队两球员任一时点间距 < `min_distance`（默认 2.0m）」产出一条 `realism_warning` finding，并按球员对聚合（同 pair 多采样点重叠只报一条）。

#### Scenario: 同队重叠产出告警
- **GIVEN** 观察窗口内同队两球员某时刻间距 < 2.0m
- **WHEN** 运行审计
- **THEN** 产出一条 `player_overlap` realism_warning，match_time 为首次越界时刻，features 携带最小间距

#### Scenario: 阈值边界严格小于
- **GIVEN** 同队两球员间距恰等于 `min_distance`（2.0m）
- **WHEN** 运行审计
- **THEN** 不产 finding（严格 `<` 才算重叠）

#### Scenario: 同一球员对多采样点重叠只报一条
- **GIVEN** 同一同队球员对在窗口内多个采样点都 < 阈值
- **WHEN** 运行审计
- **THEN** 该 pair 只产出一条 finding，不逐采样点刷屏
