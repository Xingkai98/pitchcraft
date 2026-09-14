# Spec: match-engine

## MODIFIED Requirements

### Requirement: 持球行动机会驱动开放比赛行动评估

引擎 SHALL 以「持球行动机会」驱动开放比赛的行动评估：持球段内每次 `deadline_ticks` 到期 SHALL 开启一次行动机会，由持球者候选动作与防守者候选动作按结算优先级（防守中断 > 持球终结 > 持球普通 > 无事件防守 > beat）决定行动。deadline SHALL 由几何量公式计算（危险度 / 压迫 / 出球空间，钳制到 [3,12] tick），并 SHALL 受 liveness guard 的 `deadline_pressure` 缩短。机会 SHALL 在球权改变 / 死球 / 犯规 / 重开 / 持球段被打断时失效。引擎 SHALL 无任何事件类型配额或固定评估节拍——事件频率完全由状态涌现（P31：槽位时钟 / 固定评估节拍 / 事件类型配额已全删）。出界 SHALL 由**受 `pass_risk` 调制的出界通道**涌现：开放比赛普通传球按 `open_play_out_probability(pass_risk)` 判定是否出界（`pass_risk` 含传球距离 / 压迫 / liveness 加成），命中后由 `out_side_for_intended` 定方向（含「己方/对方底线」）与越界点，并按 `out_side` + 越过的是哪条底线 + 最后触球方判重开（`out_restart_for`：NormalPass+对方底线→门球、NormalPass+己方底线→角球、任一 sideline→界外球、Clearance+底线→角球）。纯函数 `sample_pass_landing`（落点 = 意图 + 确定性误差）SHALL 保留并参与落点采样。发球重开（角球/界外球/任意球/门球/头球 battle）SHALL NOT 走出界通道。

射门 SHALL 由 hazard 五因子打分**涌现**（非槽强制、非「到射程即射」）：`score = base_tendency + gain * (distance_quality + angle_quality + space_available - defensive_pressure - cooldown_penalty)`（`gain` 是标定常数，把因子和映射到 hazard 的 log 尺度；见 design/`.p29-progress.md`），`hazard = exp(score)`，`p_shot = 1 - exp(-hazard * window)`。距离因子 SHALL 分段复用射门分桶边界（6-16.5m→0.9-1.0、16.5-25m→0.45-0.9、25-35m→0.05-0.45、>35m→0-0.05）；`angle_quality = clamp01(cos(angle_to_goal_center).max(0))`，背向球门（`cos ≤ 0`）SHALL 禁止 Shoot 候选；`space_available = 0.65*nearest + 0.35*second`（≤2m→0、2-8m 线性、≥8m→1）；`cooldown_penalty` SHALL 源自**局部**冷却倒计时（射门后重置、每 tick 衰减），SHALL NOT 读「本场已射多少次」。

`shot_setup` SHALL 为两相状态机：**推进相**向球门带球（最后一步精确落到 `target_dist`），到达射程或步数耗尽 → **起脚窗口**（`committed=false`），窗口内每 tick 由 hazard 判定射 / 转（放弃射门继续带球）/ 被抢断。`committed=true`（hazard 判定射门）后 SHALL 立即产 Shot 事件且**不可回溯**（防守者不再把已提交的射门改写为 tackle）。射门 SHALL 有**唯一生产者**：普通 `shot` 事件只由起脚窗口的 hazard 提交产生。

防守侧 SHALL 由**统一防守动作竞争**选择（P30/#25 阶段 2C）：在每个防守机会点，对候选防守者按 `score_tackle = base + closeness + approach - cooldown - bad_angle`、`score_foul = base + danger + closeness - yellow_penalty - foul_cooldown`（仅禁区外 + 贴身 + 全局犯规冷却已过）、`score_contain = base + pressure_without_contact`、`score_jockey = base + distance_fit` 算出四个 score，取最高分对应**一个** `DefensiveAction`（抢断 / 犯规 / 封堵 / 跟防 / 无），每个机会点**只选一个**（不既抢又犯）。防守动作打分 SHALL 为纯函数（几何 + 局部冷却进、score 出，零 RNG）。抢断/犯规 SHALL 用**三层 cooldown**（defender 级 `tackle_cooldown` / pair 级 `last_contact_pair` + 接触年龄 / 全局 `foul_cooldown_ticks`）取代补丁式成功率修正（`same_pair` / `far`），cooldown 只降低对应 score、SHALL NOT 直接禁止事件。抢断结果 SHALL 只有 `success` / `fail` 两态（`TACKLE_SUCCESS_RATE` 掷定）。犯规 SHALL 并入同一竞争（与抢断同窗口选择，取代独立的 `maybe_open_foul` 判定）。封堵 / 跟防 SHALL 不产事件，只更新持球者压力状态（供射门 hazard 的 `defensive_pressure` 因子读）。

liveness guard SHALL 为**三层递进**的非事件型护栏：以 `ticks_since_meaningful_action` 为唯一输入，停滞 8/12/16s 逐档调 `forward_intent_bonus` / `pass_risk_bonus` / `deadline_pressure`，**且 SHALL 在停滞达二档且持球者无压时使持球决策选择「出球」候选**。guard 本身 SHALL NOT 直接生成事件——事件仍由既有传球 / 射门生产者产出。meaningful action = 射门 / 传球（含发球重开、拦截、传失）/ 抢断 / 犯规 / 球权变化 / 出界重开 / 松散球拾取；普通带球 beat、contain/jockey、单纯跑位 SHALL NOT 重置计时。

#### Scenario: deadline 到期开启行动机会
- **GIVEN** 开放比赛中一个持球段，`deadline_ticks` 到期
- **WHEN** 引擎 tick 推进
- **THEN** 开启一次行动机会（`OpportunityTrigger::NaturalDeadline`），评估持球者/防守者行动

#### Scenario: 无事件类型配额
- **GIVEN** 引擎模拟一场比赛
- **THEN** 不存在 `HIGHLIGHTS_PER_MATCH` / `roll_fallback_situation` / `FallbackSituation` 按固定比例决定事件类型；射门/抢断/犯规/传球频率由状态涌现

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

#### Scenario: 出界由 pass_risk 调制通道涌现
- **GIVEN** 一条开放比赛普通传球
- **WHEN** 引擎判定出界
- **THEN** 由 `open_play_out_probability(pass_risk)` 通道决定是否出界、`out_side_for_intended` 定方向与「己方/对方底线」，且按 `out_side` + `own_goal_line` + 最后触球方判重开（NormalPass+对方底线→门球、NormalPass+己方底线→角球、任意 sideline→界外球、Clearance+底线→角球）；`out_pos` 记真实越界值、`x2/y2` 记场内投影；发球重开不走出界通道

#### Scenario: 落点误差纯函数保留
- **GIVEN** 一次传球落点采样
- **WHEN** 计算 `sample_pass_landing(from, intended, pass_risk, rng)`
- **THEN** 返回 `raw`（意图 + 确定性误差，可越界）、`projected`（钳回 [0,1]²）与 `out_side`；同 seed 同结果

#### Scenario: liveness guard 非事件型
- **GIVEN** 比赛停滞（无 meaningful action）达 8/12/16s
- **WHEN** liveness guard 逐档生效
- **THEN** 只调 `forward_intent_bonus` / `pass_risk_bonus` / `deadline_pressure`，不直接调用事件生成函数

#### Scenario: 无压久持由持球决策出球
- **GIVEN** 持球者在无压迫下停滞达 `LIVENESS_STAGE_2_TICKS`
- **WHEN** 引擎评估开放比赛持球行动
- **THEN** 持球决策选择「出球」候选（普通传球），事件仍由既有 `emit_pass_highlight_inner` 产出；guard 本身不 emit

#### Scenario: 5 分钟统计方向性
- **GIVEN** 引擎以 ≥1000 场 5 分钟（300s）比赛聚合
- **THEN** 累计射门 > 0、重开（角球+界外球+门球）> 0、犯规在宽带内、进球 ≥ 0；不存在「5分钟事件量 ≥ 90分钟的固定比例」断言

### Requirement: 射门槽频率（L1）

引擎 SHALL 使普通射门与抢断两类核心事件的数量级相当（防某一类塌缩/爆炸）。**P30 起语义更新**：射门由 hazard 涌现（2B，非槽强制）、抢断由防守接触竞争涌现（2C，非槽强制），两者的比值不再由槽位配额决定。**P31（D6）起**：删槽位后防守竞争在每个自然 deadline 机会点评估（~994 机会点/场）且 liveness 出球档使 pass 候选近乎翻倍 → 抢断实测 9.40/场（P30 基线 5.60）；射门实测 7.85/场 → 比值重新标定为 [0.5, 1.5]。此带为「两类涌现事件量级相当」的经验体量带，SHALL NOT 退化为配额断言。

#### Scenario: 射门槽占比
- **GIVEN** 引擎以多 seed 模拟 90 分钟比赛
- **THEN** 普通射门事件总数 / tackle 事件总数 SHALL ∈ [0.5, 1.5]（P31 实测 0.835；真实比赛射门 ~13/场、抢断 ~25/场 → ~0.52。旧带 [1.0,1.8] 是槽位配额 35%/22%≈1.59 的产物，偏虚高）

## ADDED Requirements

### Requirement: 涌现频率带的经验体量守卫

删槽位后事件频率由状态涌现，各类事件的经验体量带 SHALL 按**涌现实测值**重新标定并记录依据（原槽位配额是虚高来源，SHALL NOT 作为频率目标）；带 SHALL 只守「某类事件塌缩/爆炸」，SHALL NOT 退化为配额断言。方向性（而非固定数量）的断言 SHALL 优先。

#### Scenario: 出界通道承重守卫
- **GIVEN** 引擎以多 seed 模拟 90 分钟比赛
- **THEN** 场均界外球（`detail="out_sideline"`，由 pass_risk 出界通道产出的界外球重开）SHALL 落在声明带内——该带是出界通道的**承重守卫**（通道失效时界外球由 9.5/场 崩至 ~0.06/场）

#### Scenario: 角球派生带按涌现重标定
- **GIVEN** 引擎以多 seed 模拟 90 分钟比赛
- **THEN** `detail="corner"` 的 pass 场均 SHALL 落在按涌现实测值重标定后的带内（原 12% 角球槽来源已删，实测 3.71 → 2.00，不作为频率目标）
