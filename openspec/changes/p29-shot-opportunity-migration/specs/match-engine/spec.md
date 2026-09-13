# Spec: match-engine

## MODIFIED Requirements

### Requirement: 持球行动机会驱动开放比赛行动评估

引擎 SHALL 以「持球行动机会」驱动开放比赛的行动评估：持球段内每次 `deadline_ticks` 到期 SHALL 开启一次行动机会，由持球者候选动作与防守者候选动作按结算优先级决定行动。deadline SHALL 由几何量公式计算（危险度 / 压迫 / 出球空间，钳制到 [3,12] tick）。槽位时钟 SHALL 降级为 fallback 触发——只触发一次统一行动评估，不决定事件类型。

射门 SHALL 由 hazard 五因子打分**涌现**（非槽强制、非「到射程即射」）：`score = base_tendency + distance_quality + angle_quality + space_available - defensive_pressure - cooldown_penalty`，`hazard = exp(score)`，`p_shot = 1 - exp(-hazard * window)`。距离因子 SHALL 分段复用射门分桶边界（6-16.5m→0.9-1.0、16.5-25m→0.45-0.9、25-35m→0.05-0.45、>35m→0-0.05）；`angle_quality = clamp01(cos(angle_to_goal_center).max(0))`，背向球门（`cos ≤ 0`）SHALL 禁止 Shoot 候选；`space_available = 0.65*nearest + 0.35*second`（≤2m→0、2-8m 线性、≥8m→1）；`cooldown_penalty = shot_cooldown_ticks / SHOT_COOLDOWN_TICKS`，SHALL 只读**局部**冷却计时器，不读「本场已射多少次」。

`shot_setup` SHALL 为两相状态机：**推进相**向球门带球（最后一步精确落到 `target_dist`），到达射程或步数耗尽 → **起脚窗口**（`committed=false`），窗口内每 tick 由 hazard 判定射 / 转（放弃射门继续带球）/ 被抢断。`committed=true`（hazard 判定射门）后 SHALL 立即产 Shot 事件且**不可回溯**（防守者不再把已提交的射门改写为 tackle）。射门 SHALL 有**唯一生产者**：普通 `shot` 事件只由起脚窗口的 hazard 提交产生。

#### Scenario: 射门由 hazard 涌现
- **GIVEN** 持球者推进到射程、进入起脚窗口
- **WHEN** 计算 hazard 打分
- **THEN** 近门/正对球门/无压时 `p_shot` 高；远射/边路/贴身时低；射门不再由槽位强制产生，也不再「到射程即射」

#### Scenario: 起脚窗口内可被抢断
- **GIVEN** 持球者进入起脚窗口（`committed=false`）
- **WHEN** 防守者抢断
- **THEN** 射门序列取消（`shot_setup` 清空，内部 canceled），产 tackle 事件 → 松散球，**不产 Shot 事件**

#### Scenario: committed 后不可回溯
- **GIVEN** 持球者 hazard 判定射门（`committed=true`）
- **WHEN** 产 Shot 事件
- **THEN** 该 Shot 不可被抢断回溯（防守者不再把它改成 tackle）

#### Scenario: 到射程不立即射
- **GIVEN** 持球者推进到 `target_dist` 之内
- **WHEN** 引擎 tick 推进
- **THEN** 进入起脚窗口（本 tick 只带球一拍、不产 Shot），射门与否由窗口内 hazard 判定
