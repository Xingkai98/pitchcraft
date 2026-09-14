# Spec: match-engine

## ADDED Requirements

### Requirement: 拦截概率自洽硬门（L1 规格一致性的拦截分支）

引擎 SHALL 在开放比赛拦截判定点记账进入拦截 roll 的传球样本数、逐距离桶的预期拦截数与实际拦截数，并由引擎原生测试断言「实际拦截数落在预期拦截数的统计置信区间内」。预期拦截数 SHALL 按整数 roll 命中宽度累加（`ceil(interception_p)`，例如 `interception_p=7.5` → 记 8，不是 7.5），不得拿浮点概率常量直接除以 100。该记账 SHALL NOT 消耗额外 RNG、SHALL NOT 改变事件流（`golden-v5` 不变）。

#### Scenario: 记账点精确覆盖开放比赛拦截分母
- **GIVEN** 引擎产出一场完整比赛
- **THEN** 拦截记账样本数 > 0、实际拦截数 > 0；向前推进传球（`emit_forward_pass_highlight`）与重开传球（角球/界外球/任意球/门球）不进入记账分母（它们不走该判定点）

#### Scenario: 逐桶自洽
- **GIVEN** 引擎以多 seed 模拟，拦截样本按落点距离分桶（≤6m / 6-12m / >12m）
- **THEN** 每个主要桶的实际拦截数落在预期拦截数的 95% 置信区间内；样本不足（< 200）的桶记 `insufficient_sample` 而非失败

#### Scenario: 长传加成接线
- **GIVEN** 拦截样本按传球距离分层（>22m、>35m）
- **THEN** 同距离桶内长传层预期拦截宽度高于非长传层，且实际拦截数与预期自洽（守护 `LONG_PASS_INTERCEPT_BONUS` / `VERY_LONG_PASS_INTERCEPT_BONUS` 不被误删——逐常量杀死，防互相遮蔽）

#### Scenario: 拦截概率 cap 的整数 roll 量化
- **GIVEN** 合成概率输入 `interception_p = 60.0`（cap 值；真实开放比赛传球的档位上界是 22.5 = 贴防 7.5 + 长传 7 + 超长 8，`cap` 是防御性上限、生产上不可达）
- **THEN** 预期拦截数记 60（整数 roll 命中宽度 `ceil`），不因浮点漂移破坏自洽

#### Scenario: 事件流不变
- **WHEN** 加入拦截记账后运行 golden canary seed
- **THEN** 事件流哈希与 `engine/tests/golden-v5` 完全一致（记账只写内部 tally，不进事件流、不调 RNG）
