# Spec: match-engine

## MODIFIED Requirements

### Requirement: 引擎统计分布符合声明概率（L1 规格一致性）

引擎 SHALL 把硬编码概率实现为事件流的统计分布；多 seed（≥200）聚合后，观测比例 SHALL 落在声明的容忍带内。射门结果概率 SHALL 按起脚位置三桶（禁区内 / 禁区弧 / 远射）。

#### Scenario: 禁区内射门结果分布
- **GIVEN** 引擎以 200 个 seed × 90 分钟模拟，且起脚点在禁区内（≤ 16.5m）
- **THEN** 禁区内普通射门（无 `detail` 字段）的 result 比例 SHALL 落在：goal ∈ [10%, 20%]、saved ∈ [24%, 36%]、off_target ∈ [48%, 60%]（声明 15/30/55，校准带）

#### Scenario: 禁区弧射门结果分布
- **GIVEN** 引擎以 200 个 seed 模拟，且起脚点在禁区弧（16.5-25m）
- **THEN** 禁区弧普通射门的 result 比例 SHALL 落在：goal ∈ [3%, 12%]、saved ∈ [14%, 30%]、off_target ∈ [61%, 75%]（声明 7/22/71，对齐真实禁区弧 xG 5-10%）

#### Scenario: 远射结果分布
- **GIVEN** 引擎以 200 个 seed 模拟，且起脚点在 25m 外
- **THEN** 远射普通射门的 result 比例 SHALL 落在：goal ∈ [0%, 8%]、saved ∈ [4%, 18%]、off_target ∈ [78%, 92%]（声明 4/11/85，对齐真实禁区外转化 ~4.2%）

#### Scenario: 头球射门结果分布
- **GIVEN** 引擎以多 seed 模拟且聚合到足够头球射门（`detail:"header"`，全部在禁区）
- **THEN** 头球射门 result 分布 SHALL 通过 chi-square 拟合优度（声明 15/30/55，df=2，chi-sq < 13.82 即 α=0.001）——头球全在禁区，对齐禁区内桶

## ADDED Requirements

### Requirement: 射门起脚位置分布（L1）

引擎 SHALL 使射门起脚位置对齐真实分布：禁区内（≤ 16.5m）射门占比 SHALL ∈ [45%, 65%]，且无距对方球门 > 45m 的射门（消除自家半场/中圈远射）。

#### Scenario: 禁区内射门占比
- **GIVEN** 引擎以 200 个 seed 模拟
- **THEN** 禁区内起脚射门数 / 总射门数 SHALL ∈ [45%, 65%]（真实 ~55-58%）

#### Scenario: 无自家半场射门
- **GIVEN** 引擎产出一条 shot 事件
- **THEN** 起脚点距对方球门 SHALL ≤ 45m（归一化：home 攻 x ≥ 0.571 / away 攻 x ≤ 0.429）

### Requirement: 射门槽频率（L1）

引擎 SHALL 使射门槽位占比为 35%（shot 槽 roll 30%→35%），保证对齐转化率后集锦仍有进球。

#### Scenario: 射门槽占比
- **GIVEN** 引擎以多 seed 模拟
- **THEN** 普通射门事件总数 / tackle 事件总数 SHALL ∈ [1.0, 1.8]（声明 shot 35% / tackle 22% ≈ 1.59）

### Requirement: 射门比率对齐真实（L3 参考带，射门相关）

引擎 SHALL 使射门相关的聚合比率对齐真实联赛参考带（多 seed ≥200 聚合）。

#### Scenario: 射正率
- **THEN**（goal+saved）/ 射门 SHALL ∈ [28%, 39%]（真实 ~33%；实测 38.3%）

#### Scenario: 射门转化率
- **THEN** goal / 射门 SHALL ∈ [8%, 14%]（真实 ~10%；实测 13.1%）

#### Scenario: 禁区内进球占比
- **THEN** 禁区内进球 / 总进球 SHALL ∈ [72%, 92%]（真实 ~85%；实测 86.9%）
