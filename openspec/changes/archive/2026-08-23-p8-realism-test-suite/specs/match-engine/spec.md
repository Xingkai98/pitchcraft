# Spec: match-engine

## ADDED Requirements

### Requirement: 引擎统计分布符合声明概率（L1 规格一致性）

引擎 SHALL 把硬编码概率实现为事件流的统计分布；多 seed（≥200）聚合后，观测比例 SHALL 落在声明的容忍带内。

#### Scenario: 普通射门结果分布
- **GIVEN** 引擎以 200 个 seed × 90 分钟模拟
- **THEN** 非头球 shot 事件（无 `detail` 字段）的 result 比例 SHALL 落在：goal ∈ [11%, 19%]、saved ∈ [29%, 41%]、off_target ∈ [44%, 56%]（声明 15/35/50 ± 3σ，n≈1200 时 σ≈1-1.4pp，带取更宽以保证 CI 门不 flaky、仍捕获分布翻转）

#### Scenario: 头球射门结果分布
- **GIVEN** 引擎以 200 个 seed 模拟且聚合到足够头球射门（`detail:"header"` 的 shot，200 场 ~240）
- **THEN** 头球射门 result 分布 SHALL 通过 chi-square 拟合优度（声明 12/38/50，df=2，chi-sq < 13.82 即 α=0.001）——n≈124 时比例带过脆（固定 seed 1..=100 的 2.9σ 偏样本 chi-sq=12.94 距阈值仅 0.88），200 场实测 chi-sq≈6.3；用联合检验容采样波动、抓分布翻转等大偏差

#### Scenario: 抢断成功率的稀释模型
- **GIVEN** 引擎多 seed 模拟聚合出足够 tackle 事件
- **THEN** 全部 tackle 的 success 比例 SHALL ∈ [20%, 45%]；近距离（def→victim ≤ 12m）tackle 的 success 比例 SHALL ∈ [24%, 46%]（贴防首抢 50% 被 not-eager 15%、same_pair 0% 与 `!should_tackle` 稀释；实测 close≈28%）。不做 close>far 单调性断言——tackle 槽总是取最近防守者，事件内 dist>12m 的 far 恒为 0（引擎内部 far 的另一来源 `!should_tackle` 无事件内代理）。overall/close 带只捕获整体大偏差（成功率崩塌/暴涨）；**分支间 15%↔50% 互换因 `TACKLE_EAGERNESS=0.5` 的 50/50 加权均值不变而不可见，由 golden master 全流哈希守护**（success/fail 结果改变会级联改变后续事件流）

#### Scenario: 槽位相对 mix
- **GIVEN** 引擎多 seed 模拟
- **THEN** 普通射门（非头球）事件总数 / tackle 事件总数 SHALL ∈ [1.0, 1.8]（声明槽位 30% / 22% ≈ 1.36；排除角球派生头球避免灌水）；普通射门总数 SHALL ≥ 800（保证射门分布断言的样本量）

#### Scenario: 角球派生带
- **GIVEN** 引擎多 seed 模拟
- **THEN** `detail:"corner"` 的 pass 事件数 SHALL 场均 ∈ [2, 9]（200 场均值；0 角球场次正常），单场 ≤ 12（数量级漂移硬上界）。来源 = 角球槽 12% + 扑出越线 90% 派生 + 解围出底线派生

### Requirement: 事件流过程真实性不变量（L2）

引擎 SHALL 使事件流满足以下跨事件不变量，任意 seed 都成立。

#### Scenario: 比分与进球计数一致
- **WHEN** 引擎产出一场完整比赛
- **THEN** whistle 事件 score（`"{home}-{away}"`）SHALL 精确等于事件流中 shot[result="goal"] 的计数

#### Scenario: 射门落点在球门矩形内
- **WHEN** 引擎产出一条 shot 事件
- **THEN** goal/saved 的 y2 SHALL ∈ [0.455, 0.545]，x2 SHALL = 攻方门线（home 射 0.98 / away 射 0.02）；off_target 的 y2 SHALL ∈ [0.40, 0.445] ∪ [0.555, 0.60]（贴柱偏出）

#### Scenario: beat 节拍固定
- **WHEN** 引擎产出 beat 事件序列
- **THEN** 相邻 beat 的 t 差 SHALL ∈ {1.0, 2.0} ± 0.001（1.0 = 每 tick 一拍；2.0 出现在重开准备 tick——角球/界外球判定 tick 与进球后 kickoff 发球 tick 均不产 beat），且任意相邻 beat 间隙 ≤ 2.0

#### Scenario: 速度不超物理量
- **WHEN** 引擎产出带 speed 的事件
- **THEN** 普通射门 speed ∈ [22, 30)；头球射门 speed ∈ [15, 20)；pass 事件 speed ∈ [10, 25)；beat main.speed ≤ 5.1；beat mover.speed ≤ 8.1（重开走位 8 m/s 例外上限）

#### Scenario: 门将贴门线
- **WHEN** 引擎产出 shot 事件
- **THEN** keeper_x SHALL < 0.15 或 > 0.85（门将不离开门线区域）

#### Scenario: 事件时间范围
- **WHEN** 引擎产出一场时长 dur 的比赛
- **THEN** 全部事件 t SHALL ∈ [-0.001, dur+0.001]

### Requirement: 确定性 golden master 防漂移

引擎 SHALL 使 10 个 canary seed（1..=10）的整场事件流可复现为提交的 golden 基线；任何改动导致的流差异 SHALL 使测试失败。统计层未覆盖的概率（扑出 caught/rebound 40/60、槽位 corner/throw_in/pass 比例、出界率等）SHALL 由 golden master 全流哈希守护。

#### Scenario: canary seed 全流比对
- **WHEN** 测试对 seed 1..=10 各模拟一场并计算统计摘要 + 事件流哈希
- **THEN** 结果 SHALL 与 `engine/tests/golden/seed-<n>.json` 完全一致

#### Scenario: 显式重基线
- **WHEN** 设置环境变量 `ACCEPT_GOLDEN=1` 运行 golden 测试
- **THEN** 测试 SHALL 覆盖写当前结果为新基线（打印待审查提示，供人工审查 git diff 后提交），而非失败
