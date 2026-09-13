# Spec: match-engine

## ADDED Requirements

### Requirement: 持球行动机会驱动开放比赛行动评估

引擎 SHALL 以「持球行动机会」驱动开放比赛的行动评估：持球段内每次 `deadline_ticks` 到期 SHALL 开启一次行动机会，由持球者候选动作与防守者候选动作按结算优先级（死球/重开 > 防守中断 > 持球终结 > 持球普通 > 无事件防守 > beat）决定行动。deadline SHALL 由几何量公式计算（危险度 / 压迫 / 出球空间，钳制到 [3,12] tick）。机会 SHALL 在球权改变 / 死球 / 犯规 / 重开 / 持球段被打断时失效。槽位时钟 SHALL 降级为 fallback 触发——只触发一次统一行动评估，不再决定事件类型。

#### Scenario: deadline 到期开启行动机会
- **GIVEN** 开放比赛中一个持球段，`deadline_ticks` 到期
- **WHEN** 引擎 tick 推进
- **THEN** 开启一次行动机会（`OpportunityTrigger::NaturalDeadline`），评估持球者/防守者行动

#### Scenario: 槽位 fallback 只触发评估不选类型
- **GIVEN** 槽位时钟到期
- **WHEN** 引擎 tick 推进
- **THEN** 触发一次行动机会（`OpportunityTrigger::FallbackDeadline`），由统一评估决定候选行动与结算，而非由槽位直接决定产出的事件类型

#### Scenario: deadline 按几何量计算
- **GIVEN** 持球者接近对方球门且受压
- **WHEN** 计算 `deadline_ticks`
- **THEN** deadline 短于后场无压持球（危险度/压迫降低 deadline，出球空间提高 deadline），且在 [3,12] 内

#### Scenario: 机会在持球段边界失效
- **GIVEN** 一个存活的行动机会，随后球权改变 / 进入死球 / 犯规 / 重开 / 持球段被打断
- **WHEN** 引擎 tick 推进
- **THEN** 该机会失效，不在新的持球段里被沿用
