# Spec: match-engine

## MODIFIED Requirements

### Requirement: 持球行动机会驱动开放比赛行动评估

引擎 SHALL 以「持球行动机会」驱动开放比赛的行动评估：持球段内每次 `deadline_ticks` 到期 SHALL 开启一次行动机会，由持球者候选动作与防守者候选动作按结算优先级决定行动。deadline SHALL 由几何量公式计算（危险度 / 压迫 / 出球空间，钳制到 [3,12] tick），并 SHALL 受 liveness guard 的 `deadline_pressure` 缩短。引擎 SHALL 无任何事件类型配额或固定评估节拍——事件频率完全由状态涌现。出界 SHALL 由普通传球落点误差涌现（落点加 `pass_risk` 相关的确定性误差，raw 越界 → 按 `out_side` + 最后触球方判角球/界外球/门球），而非槽位硬造。防守侧 SHALL 由统一防守动作竞争选择。liveness guard SHALL 为三层递进（停滞 8/12/16s 逐档调前插倾向/传球风险/deadline），只改行为状态、不直接生成事件。

#### Scenario: 无事件类型配额
- **GIVEN** 引擎模拟一场比赛
- **THEN** 不存在 `HIGHLIGHTS_PER_MATCH` / `roll_fallback_situation` / `FallbackSituation` 按固定比例决定事件类型；射门/抢断/犯规/传球频率由状态涌现

#### Scenario: 出界由落点误差涌现
- **GIVEN** 一条开放比赛普通传球，落点误差导致 raw 越过边界
- **WHEN** 引擎判定出界
- **THEN** 按 `out_side` + 最后触球方判重开（NormalPass+goal_line→门球、Clearance+goal_line→角球、任意 sideline→界外球）；发球重开不走出界误差

#### Scenario: liveness guard 非事件型
- **GIVEN** 比赛停滞（无 meaningful action）达 8/12/16s
- **WHEN** liveness guard 逐档生效
- **THEN** 只调 `forward_intent_bonus` / `pass_risk_bonus` / `deadline_pressure`，不直接调用事件生成函数

#### Scenario: 5 分钟统计方向性
- **GIVEN** 引擎以 ≥1000 场 5 分钟（300s）比赛聚合
- **THEN** 累计射门 > 0、重开（角球+界外球+门球）> 0、犯规在宽带内、进球 ≥ 0；不存在「5分钟事件量 ≥ 90分钟的固定比例」断言
