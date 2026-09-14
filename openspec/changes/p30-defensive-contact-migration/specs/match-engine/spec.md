# Spec: match-engine

## MODIFIED Requirements

### Requirement: 持球行动机会驱动开放比赛行动评估

引擎 SHALL 以「持球行动机会」驱动开放比赛的行动评估：持球段内每次 `deadline_ticks` 到期 SHALL 开启一次行动机会，由持球者候选动作与防守者候选动作按结算优先级（死球/重开 > 防守中断 > 持球终结 > 持球普通 > 无事件防守 > beat）决定行动。deadline SHALL 由几何量公式计算（危险度 / 压迫 / 出球空间，钳制到 [3,12] tick）。机会 SHALL 在球权改变 / 死球 / 犯规 / 重开 / 持球段被打断时失效。槽位时钟 SHALL 降级为 fallback 触发——只触发一次统一行动评估，不再决定事件类型。

射门 SHALL 由 hazard 五因子打分**涌现**（非槽强制、非「到射程即射」）：`score = base_tendency + gain * (distance_quality + angle_quality + space_available - defensive_pressure - cooldown_penalty)`（`gain` 是标定常数，把因子和映射到 hazard 的 log 尺度；见 design/`.p29-progress.md`），`hazard = exp(score)`，`p_shot = 1 - exp(-hazard * window)`。距离因子 SHALL 分段复用射门分桶边界（6-16.5m→0.9-1.0、16.5-25m→0.45-0.9、25-35m→0.05-0.45、>35m→0-0.05）；`angle_quality = clamp01(cos(angle_to_goal_center).max(0))`，背向球门（`cos ≤ 0`）SHALL 禁止 Shoot 候选；`space_available = 0.65*nearest + 0.35*second`（≤2m→0、2-8m 线性、≥8m→1）；`cooldown_penalty` SHALL 源自**局部**冷却倒计时（射门后重置、每 tick 衰减），SHALL NOT 读「本场已射多少次」。

`shot_setup` SHALL 为两相状态机：**推进相**向球门带球（最后一步精确落到 `target_dist`），到达射程或步数耗尽 → **起脚窗口**（`committed=false`），窗口内每 tick 由 hazard 判定射 / 转（放弃射门继续带球）/ 被抢断。`committed=true`（hazard 判定射门）后 SHALL 立即产 Shot 事件且**不可回溯**（防守者不再把已提交的射门改写为 tackle）。射门 SHALL 有**唯一生产者**：普通 `shot` 事件只由起脚窗口的 hazard 提交产生。

防守侧 SHALL 由**统一防守动作竞争**选择（P30/#25 阶段 2C）：在每个防守机会点，对候选防守者按 `score_tackle = base + closeness + approach - cooldown - bad_angle`、`score_foul = base + danger + closeness - yellow_penalty - foul_cooldown`（仅禁区外 + 贴身 + 全局犯规冷却已过）、`score_contain = base + pressure_without_contact`、`score_jockey = base + distance_fit` 算出四个 score，取最高分对应**一个** `DefensiveAction`（抢断 / 犯规 / 封堵 / 跟防 / 无），每个机会点**只选一个**（不既抢又犯）。防守动作打分 SHALL 为纯函数（几何 + 局部冷却进、score 出，零 RNG）。抢断/犯规 SHALL 用**三层 cooldown**（defender 级 `tackle_cooldown` / pair 级 `last_contact_pair` + 接触年龄 / 全局 `foul_cooldown_ticks`）取代补丁式成功率修正（`same_pair` / `far`），cooldown 只降低对应 score、SHALL NOT 直接禁止事件。抢断结果 SHALL 只有 `success` / `fail` 两态（`TACKLE_SUCCESS_RATE` 掷定）。犯规 SHALL 并入同一竞争（与抢断同窗口选择，取代独立的 `maybe_open_foul` 判定）。封堵 / 跟防 SHALL 不产事件，只更新持球者压力状态（供射门 hazard 的 `defensive_pressure` 因子读）。

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

#### Scenario: 射门由 hazard 涌现
- **GIVEN** 持球者推进到射程、进入起脚窗口
- **WHEN** 计算 hazard 打分
- **THEN** 近门/正对球门/无压时 `p_shot` 高；远射/边路/贴身时低；射门不再由槽位强制产生，也不再「到射程即射」

#### Scenario: 起脚窗口内可被抢断
- **GIVEN** 持球者进入起脚窗口（`committed=false`）
- **WHEN** 防守者抢断
- **THEN** 射门序列取消（`shot_setup` 清空，内部 canceled），产 tackle 事件，**不产 Shot 事件**；抢断成功时球进入松散球（`TackleSuccess`），抢断失败时球留在原持球者（`TackleFail`）——成败都取消射门序列

#### Scenario: committed 后不可回溯
- **GIVEN** 持球者 hazard 判定射门（`committed=true`）
- **WHEN** 产 Shot 事件
- **THEN** 该 Shot 不可被抢断回溯（防守者不再把它改成 tackle）

#### Scenario: 到射程不立即射
- **GIVEN** 持球者推进到 `target_dist` 之内
- **WHEN** 引擎 tick 推进
- **THEN** 进入起脚窗口（本 tick 只带球一拍、不产 Shot），射门与否由窗口内 hazard 判定

#### Scenario: 防守动作打分选一
- **GIVEN** 一个防守机会点，贴身防守者
- **WHEN** 计算 tackle / foul / contain / jockey 四类 score
- **THEN** 取最高分对应防守动作，每个机会点只选一个（不既抢又犯）；打分为纯函数、零 RNG

#### Scenario: 三层 cooldown 取代 same_pair/far
- **GIVEN** 同一防守者（defender 级冷却内）或同一接触对（pair 级冷却内）
- **WHEN** 计算防守动作 score
- **THEN** 对应 score 降低（冷却到期后恢复），不再用「连续同对强制失败」的补丁；抢断结果只有 success/fail 两态

#### Scenario: 犯规并入防守竞争
- **GIVEN** 一个防守机会点，禁区外、贴身、全局犯规冷却已过
- **WHEN** 计算防守动作 score
- **THEN** 犯规与抢断在同一竞争里被选出（每个机会点至多一个防守中断事件，不会既抢又犯）；吃黄球员的犯规 score 被折扣

#### Scenario: contain/jockey 只调状态
- **GIVEN** 防守动作结算为 contain 或 jockey
- **WHEN** 更新引擎状态
- **THEN** 不产事件，只更新持球者压力状态（供射门 hazard 的 `defensive_pressure` 因子读）

### Requirement: 射门槽频率（L1）

引擎 SHALL 使普通射门与抢断两类核心事件的数量级相当（防某一类塌缩/爆炸）。**P30 起语义更新**：射门由 hazard 涌现（2B，非槽强制）、抢断由防守接触竞争涌现（2C，非槽强制），两者的比值不再由槽位配额决定，而是「两类涌现事件量级相当」的经验体量带。

#### Scenario: 射门 / 抢断体量比
- **GIVEN** 引擎以多 seed 模拟
- **THEN** 普通射门事件总数 / tackle 事件总数 SHALL ∈ [1.0, 1.8]（P30 实测 1.12；非槽位配额，为两类事件量级相当的 sanity 带）

### Requirement: 抢断触发决策（距离感知 + 防守动作竞争）

引擎 SHALL 不固定概率必抢，而是由防守者基于情境（几何 + 冷却）自行判断是否抢断：每个防守机会点对候选防守者按统一防守动作打分选中抢断时才产 `tackle`。抢断的**资格与倾向**完全由打分阶段判定（`select_defensive_action`），取代旧的「贴身阈值 + 抢断积极性低概率掷定」二元判定：超出就近阈值（约 12m）的防守者无任何防守动作资格（不产 tackle/contain/jockey）；距离越近（`closeness`）、越正面（`approach`）→ 抢断分越高；身后回追（`bad_angle`）→ 抢断分被压低（犯规由此接管）。判据为引擎内常量 + 几何/冷却量，`SHALL NOT` 消耗 RNG 决定「是否去抢」。

#### Scenario: 就近防守
- **GIVEN** 一个防守机会点
- **THEN** 引擎找离持球者最近的对方球员（用实时 pos[]）；最近距离超过阈值（约 12m）时无防守动作（不产 tackle，也不产 contain/jockey）

#### Scenario: 超阈值落回进攻
- **GIVEN** 最近防守者距离超过阈值
- **THEN** 不产 tackle，该次机会落回 pass/dribble/shot（当作普通进攻事件处理）

#### Scenario: 抢断资格由打分判定
- **GIVEN** 最近防守者距离 ≤ 阈值
- **THEN** 由 `select_defensive_action` 对 tackle/foul/contain/jockey 四类 score 取最高决定是否抢断——贴身且正面时抢断胜出，中距时 contain/jockey 胜出，近身但失位时犯规胜出；**不消耗 RNG 决定是否去抢**

#### Scenario: 抢断频率由涌现决定
- **WHEN** 一整场比赛模拟
- **THEN** tackle 事件总数由开放比赛的防守机会点数量与几何分布涌现（不再由槽位数量或固定积极性概率决定），且与比赛时长同向缩放（长比赛机会点多 → 抢断多）

#### Scenario: 抢断可失败
- **WHEN** 引擎产出一条 tackle 事件
- **THEN** `result` 为 `success`（约 50%）或 `fail`（约 50%）；只有这两态，不再有 `same_pair`/`far` 的第三种成功率档

#### Scenario: 抢断成功状态更新
- **GIVEN** tackle `result=success`
- **THEN** 球权归防守者（防守者随后争抢弹开的松散球 `loose_x/loose_y`）；抢断者与被抢者结算到分离终点 `(subject_end, carrier_end)`——两球员间距 ≥ 最小间隔（约 0.03，观感不重合），下一事件不 snap

#### Scenario: 抢断失败状态更新
- **GIVEN** tackle `result=fail`
- **THEN** 球权保留原持球者，被抢者留接触点继续持球；抢断者停在被抢者外侧 `(subject_end)`——两球员间距 ≥ 最小间隔（约 0.03，不贴身），下一事件不 snap
