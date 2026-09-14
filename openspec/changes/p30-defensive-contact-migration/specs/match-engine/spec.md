# Spec: match-engine

## MODIFIED Requirements

### Requirement: 持球行动机会驱动开放比赛行动评估

引擎 SHALL 以「持球行动机会」驱动开放比赛的行动评估：持球段内每次 `deadline_ticks` 到期 SHALL 开启一次行动机会，由持球者候选动作与防守者候选动作按结算优先级决定行动。deadline SHALL 由几何量公式计算（危险度 / 压迫 / 出球空间，钳制到 [3,12] tick）。槽位时钟 SHALL 降级为 fallback 触发——只触发一次统一行动评估，不决定事件类型。射门 SHALL 由 hazard 五因子打分涌现（非槽强制）。防守侧 SHALL 由统一防守动作竞争选择：抢断/犯规/跟防/卡位各算 score 取最高，每个防守机会点只选一个；抢断/犯规 SHALL 用三层 cooldown（defender 级 / pair 级 / 全局 foul）取代补丁式成功率修正（same_pair/far）；跟防/卡位 SHALL 只调状态不产事件。

#### Scenario: 防守动作打分选一
- **GIVEN** 一个防守机会点，贴身防守者
- **WHEN** 计算 tackle/foul/contain/jockey 四类 score
- **THEN** 取最高分对应防守动作，每个机会点只选一个（不既抢又犯）

#### Scenario: 三层 cooldown 取代 same_pair/far
- **GIVEN** 同一防守者（defender 级冷却内）或同一接触对（pair 级冷却内）
- **WHEN** 计算防守动作 score
- **THEN** 对应 score 降低（冷却到期后恢复），不再用「连续同对强制失败」的补丁

#### Scenario: contain/jockey 只调状态
- **GIVEN** 防守动作结算为 contain 或 jockey
- **WHEN** 更新引擎状态
- **THEN** 不产事件，只更新持球者压力状态（供射门 hazard 的 defensive_pressure 因子读）
