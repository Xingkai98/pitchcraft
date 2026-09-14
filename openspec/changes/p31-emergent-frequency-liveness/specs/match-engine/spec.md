# Spec: match-engine

## MODIFIED Requirements

### Requirement: 持球行动机会驱动开放比赛行动评估

引擎 SHALL 以「持球行动机会」驱动开放比赛的行动评估：持球段内每次 `deadline_ticks` 到期 SHALL 开启一次行动机会，由持球者候选动作与防守者候选动作按结算优先级决定行动。deadline SHALL 由几何量公式计算（危险度 / 压迫 / 出球空间，钳制到 [3,12] tick），并 SHALL 受 liveness guard 的 `deadline_pressure` 缩短。引擎 SHALL 无任何事件类型配额或固定评估节拍——事件频率完全由状态涌现。

出界 SHALL 由**受 `pass_risk` 调制的出界通道**涌现，而非槽位硬造：开放比赛普通传球按 `open_play_out_probability(pass_risk)` 判定是否出界（`pass_risk` 含传球距离 / 压迫 / liveness 加成），命中后按 `out_side_for_intended` 定方向、落点沿该轴推过边界，并按 `out_side` + 最后触球方判重开（`out_restart_for`：NormalPass+goal_line→门球、NormalPass+sideline→界外球、Clearance+goal_line→角球、Clearance+sideline→界外球）。纯函数 `sample_pass_landing`（落点 = 意图 + 确定性误差）SHALL 保留并参与落点采样。发球重开（角球/界外球/任意球/门球/头球 battle）SHALL NOT 走出界通道。

防守侧 SHALL 由统一防守动作竞争选择。liveness guard SHALL 为三层递进（停滞 8/12/16s 逐档调前插倾向/传球风险/deadline），**且 SHALL 在停滞达二档且持球者无压时使持球决策选择「出球」候选**；guard 本身 SHALL NOT 直接生成事件——事件仍由既有传球/射门生产者产出。

#### Scenario: 无事件类型配额
- **GIVEN** 引擎模拟一场比赛
- **THEN** 不存在 `HIGHLIGHTS_PER_MATCH` / `roll_fallback_situation` / `FallbackSituation` 按固定比例决定事件类型；射门/抢断/犯规/传球频率由状态涌现

#### Scenario: 出界由 pass_risk 调制通道涌现
- **GIVEN** 一条开放比赛普通传球
- **WHEN** 引擎判定出界
- **THEN** 由 `open_play_out_probability(pass_risk)` 通道决定是否出界、`out_side_for_intended` 定方向，且按 `out_side` + 最后触球方判重开（NormalPass+goal_line→门球、Clearance+goal_line→角球、任意 sideline→界外球）；`out_pos` 记真实越界值、`x2/y2` 记场内投影；发球重开不走出界通道

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

### Requirement: 涌现频率带的经验体量守卫

删槽位后事件频率由状态涌现，各类事件的经验体量带 SHALL 按**涌现实测值**重新标定并记录依据（原槽位配额是虚高来源，不作为频率目标）；带 SHALL 只守「某类事件塌缩/爆炸」，SHALL NOT 退化为配额断言。方向性（而非固定数量）的断言 SHALL 优先。

#### Scenario: 射门/抢断体量带
- **GIVEN** 引擎以多 seed 模拟 90 分钟比赛
- **THEN** 普通射门/场 SHALL 落在声明带内；抢断/场 SHALL 落在按涌现实测值重标定后的带内；两者均为「量级相当」的经验体量守卫，比值不再由槽位配额决定

#### Scenario: 角球派生带按涌现重标定
- **GIVEN** 引擎以多 seed 模拟 90 分钟比赛
- **THEN** `detail="corner"` 的 pass 场均 SHALL 落在按涌现实测值重标定后的带内（原 12% 角球槽来源已删，不作为频率目标）
