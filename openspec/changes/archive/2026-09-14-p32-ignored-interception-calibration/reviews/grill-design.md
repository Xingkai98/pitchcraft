# Grill Design: #36 ignored_interception_opportunity 假阳性标定

> batch-grill-me：敲定 #36 的设计方向。codex 已标推荐答案（多为 C）。用户确认前不写实现代码。

## 背景（facts，已从代码确认）

- detector `ignored_interception_opportunity` 实测 **45% 假阳性**（issue #36），作为 realism_warning 已失去判别力。
- 当前 detector（`tools/detectors.mjs:690`）：对每条 pass 算 `ballArrival = pass_distance/pass_speed`、`defenderArrival = corridor_distance/defender_speed`；命中当且仅当 `defenderArrival + arrival_margin < ballArrival` 且未朝走廊移动。语义 = **确定性可达**（能跑到就该拦）。
- 引擎拦截（`engine/src/lib.rs:2803`，P13 fix）：拦截者 = 离**落点**最近对方外场球员；概率按「拦截者到落点距离」分档 7.5/4.5/2.0（+长传 7/8，cap 60%），**概率 roll**。语义 = **概率拦截**。
- post-#25 引擎已全概率化 → detector 的确定性前提过时 = 45% 假阳性根因。
- 几何不一致：detector 用「线段垂直距离」，引擎用「落点距离」；垂直距离 ≤ 落点距离 → detector 系统性高估可达性。

### codex 复核新增的关键事实

1. **拦截事件的落点语义**：`result==='intercepted'` 时 `x2/y2` 是**实际拦截者位置**，不是意图落点。引擎算拦截概率用的是**原始意图落点**（`lead_point`）。derive 层重建风险时不能对所有 result 直接复用 x2/y2——拦截事件须用 `receiver_x/receiver_y + lead` 重建同一 `lead_point`。
2. **整数 roll 量化**：引擎 `7.5/4.5/2.0%` 用整数 `fail_roll ∈ [0,99]` 比较 → 实际命中率是 **8% / 5% / 2%**，不能直接拿常量÷100。
3. **分母污染**：当前 detector 扫所有 `type==='pass'`，未排除角球/门球/界外球/任意球/头球争顶等**不经过拦截 roll** 的重开事件（contested）。
4. **高球 85% 是 stale**：detector 契约不读 `h`（球高度），实现也无高球条件。若指「现有 findings 85% 恰是高球」则可能由长传/重开间接放大，需重新分层复现，不能当作当前输入契约事实。
5. **现有 bundle 无人工真值**：`.scratch/tasks` bundle 能验证字段/几何，但无「这球本应被断」的标签，不能单独算逐事件 precision/recall。

## Grill 决策树（codex 已标推荐）

### Q1（最关键）post-#25 后这检查到底标什么？

- A 保留「防守者本可跑到走廊却没行动」：需重造加速/反应/朝向/球高模型，且已非引擎自洽检查。
- B 改成「高风险传球成功穿过防区」：概率事件成功本身正常，单次成功推不出 defect。
- **C（推荐）分布级拦截概率校准**：按引擎风险分桶累计「预期拦截数 vs 实际拦截数」，样本充足时查自洽，不把单次未命中当异常。直接消除「正常随机成功被判假阳性」的根因。
- D 原 finding 降级并入 pass_outcomes：只存风险桶/结果/样例，不产逐事件 warning。**建议作 C 的数据落点**。

**结论：C + D。** 不再作逐事件真实性裁决器，变成 pass_outcomes 下的拦截概率自洽统计。

### Q2 几何语义

- **A（推荐）与引擎对齐：防守者到「风险评估落点」的距离**（重建引擎当时的意图落点）。成功/传失用意图 x2/y2；拦截事件用 receiver_x/receiver_y+lead 重建。
- B 保留线段垂直距离：只能作诊断特征，不能参与 expected-rate 计算。
- C 建「到走廊交点时间 vs 球到交点时间」模型：更真实但需引擎协议没有的事实，会再造「两套真相」。

**结论：A。**

### Q3 defender_speed 怎么办

- A 用引擎无球跑位速度：1-2m 碎步非稳定冲刺，仍是伪精确。
- B 从快照回归速度分布：窗口插值/hold 污染，只适合未来防守反应研究。
- **C（推荐）从判定路径删除 defender_speed 与 arrival_margin**：引擎不用可达时间决定拦截，detector 也不该靠调这两个参数拟合报警率。过渡期可留 deprecated 字段一版。

**结论：C。**

### Q4 defender_moved_toward_corridor 是否参与裁决

- A 继续作硬条件：缺失值被当「没移动」，窗口边界/锚点不足直接转告警，最脆。
- **B（推荐）仅作辅助诊断特征**：起止可靠则输出 toward/stable/away，证据不足输出 unknown；**undefined 必须保持 unknown，不能等价 false**。
- C 完全删除：能消脆弱依赖，但丢掉排查「防守球员视觉不响应」的辅助证据。

**结论：B。**

### Q5 band 锚点

- A 只用真实足球拦截率：不同供应商分类不同，分母/事件定义易打架。
- B 只查引擎预期 vs 实际：能查接线/RNG 漂移，但不能判断拦截率本身是否贴近现实。
- **C（推荐）双 band，职责不对称**：硬门 = 引擎自洽（同桶实际率落离散 RNG 的统计置信区间）；软门 = 真实足球 sanity（总拦截数量级，初期仅 L3 参考，不直接升 failure）。

**结论：C。**

### Q6 哪些 pass 进校准分母

- A 所有 pass：混入角球/门球/界外球/任意球/头球争顶，污染分母。
- B 只 success：看不到拦截结果，不能查漏报。
- **C（推荐）只统计真正进入引擎拦截判定阶段的开放比赛 pass**：纳入 success/lost/intercepted；排除出界通道已命中 pass、所有重开/战术排除、contested。分母契约须与引擎「出界判定之后、拦截 roll 之前」控制流一致。

**结论：C（比调 defender_speed 更优先的假阳性治理）。**

### Q7 高球 h 怎么处理

- A 高球直接排除：引擎拦截概率不读 h，单方面排除破坏自洽镜像。
- B 高球独立拦截概率：等于在 detector 发明引擎不存在的规则，再造双重语义。
- **C（推荐）只用于标定分层 + stale 假设验证**：分别报告低/高球、短/长传、开放/重开的样本与结果，验证「85%」是历史数据/重开污染/长传相关；h 不进入裁决公式。

**结论：C。issue body 的「高球标记率 85%」改写为待复现的经验症状，不是当前输入契约事实。**

### Q8 假阳性/漏报怎么定义

- A 「成功但模型认为高风险」= 假阳性：概率模型里高风险成功不说明引擎错，无法建可信真值。
- B 人工逐事件标注「本应被断」：需双人标注+分歧裁决，标签主观性高于 detector 差异。
- **C（推荐）分布 detector 改用 calibration error + 异常检出**：「假阳性」= 正常基线 bundle 被误判超 band；「漏报」= 对拦截结果/风险桶/概率接线做已知扰动后聚合未检出。逐事件只留解释样例，不算 precision/recall。

**结论：C。**（若坚持逐事件 warning 则另建人工标注集，验收 ≥15% 假阳 / ≤25% 漏报——但不作为推荐路径主门。）

### Q9 band 用固定百分比还是样本量感知区间

- A 固定 min/max：小窗口 0/1 次拦截就造成巨大比例波动，不能单 bundle 判。
- **B（推荐）二项置信区间 + 最小样本量**：逐桶累计 `expected = Σ effective_probability`，比较实际拦截数与 Poisson-binomial/近似二项 95% 区间；样本不足 → `insufficient_sample`，不得 failure；全局及主要桶 `N ≥ 200`。
- C 只比全局：可能掩盖「贴防桶偏低、远距桶偏高、总数碰巧抵消」的接线错误。

**结论：B。** 保留全局汇总 + 分桶（≤6m / 6-12m / >12m，长传加成作交叉分层）。

### Q10 旧 detector 名称与输出怎么迁移

- A 保留旧名只换算法：名称仍暗示「被忽略的机会」，与分布语义冲突。
- B 新建独立 `pass_interception_calibration`：语义清楚但需扩 finding/aggregation 模型支持预期概率与 insufficient_sample。
- **C（推荐）并入 `pass_outcomes.interception_calibration`，停发旧 finding**：pass_outcomes 已承担传球结果/压力分桶，分母最接近。聚合报告产 `ok / insufficient_sample / out_of_band` 状态；旧 detector ID 从默认列表与 reference band 移除。

**结论：C。** 兼容期旧 ID 只输出 deprecated 摘要，不再输出 realism_warning。

## 若按推荐走，#36 最小改动集（codex 整理）

1. **`viewer/derive-audit-features.js`** `derivePassEvent`：新增「拦截风险评估落点」派生字段（成功/传失用意图 x2/y2；intercepted 用 x/y + receiver_x/receiver_y + lead 重建同一 lead_point）；按该落点选最近对方外场球员 → `interception_defender_id` + `interception_target_distance`；保留 corridor_distance 与 defender_moved_toward_corridor 作诊断特征（后者缺失保持 unknown）。
2. **`tools/detector-field-contract.mjs`**：旧 detector 主裁决读取集移除 corridor_distance/pass_speed/defender_moved_toward_corridor；为 `pass_outcomes.interception_calibration` 声明新读取字段；h 仅作可选分层字段；notes 明确 intercepted 的 x2/y2 是实际拦截点非风险评估落点。
3. **`tools/detectors.mjs`**：`computePassOutcomes` 只收进入开放比赛拦截阶段的 pass，镜像引擎距离桶/长传加成/60% cap/整数 roll 量化算 `effective_interception_probability`；聚合输出各桶 sample/expected/actual/observed_rate/样例；删 defender_speed/arrival_margin 对结果影响；停发逐事件 warning；多 seed 算置信区间，样本不足 insufficient_sample。
4. **`tools/detectors.test.mjs`**：删旧语义测试（可达性/移动条件/calibrated:false 专属断言）；新增意图落点重建（成功/传失/拦截三态）、距离桶边界、长传加成、60% cap、整数量化（7.5→8%、4.5→5%）、重开/contested/出界不进分母、正常多 seed 落置信区间、mutation 检出、小样本 insufficient_sample。
5. **`viewer` derive 测试**：线段距离 vs 落点距离并存语义不同；intercepted 重建意图落点；锚点不足 → 移动方向 unknown 而非 false；最近落点防守者与最近走廊防守者可能不同、ID 不得混用。
6. **真实 bundle 标定集**：用稳定基准生成多 seed 完整 90min bundle（非 ±5s 观察窗口）；冻结 engine revision/schema/profile/seed 清单；主要桶 N≥200；按 h/距离/重开类型输出对照表复现或否定「85% 高球」；mutation fixture 必须被检出。
7. **Reference band + profile**：删旧 `ignored_interception_opportunity` band；新增 `pass_outcomes.interception_calibration` 统计配置（置信度/最小样本量/桶边界/概率常量版本）；`calibrated:true` 只在稳定多 seed bundle 通过后设置，此前保持 uncalibrated/insufficient_sample。
8. **Golden 更新范围**：**无需更新 `engine/tests/golden-v5`**（不改引擎行为/事件输出）；更新 detector/audit 预期 JSON（不含旧逐事件 warning、含新拦截校准汇总）。若发现无法从现有权威字段无歧义重建风险评估落点，再单独提协议字段变更（届时才更新 engine event tests + golden）。

## User Confirmation（2026-09-14，batch-grill-me Round 1）

- **Q1 方向**：用户答复 **按推荐重定位**——detector 从「逐事件 realism_warning」重定位为
  `pass_outcomes.interception_calibration` 分布级自洽校准（逐桶预期 vs 实际拦截数 + 二项置信区间
  + 最小样本 N≥200）。
- 其余 9 问（Q2-Q10）随 Q1 耦合，**默认按 codex 推荐**：Q2 A（落点距离对齐引擎）、
  Q3 C（删 defender_speed/arrival_margin）、Q4 B（移动方向仅作诊断特征、缺失保持 unknown）、
  Q5 C（双 band：引擎自洽硬门 + 真实足球 sanity 软门）、Q6 C（只收开放比赛拦截判定分母）、
  Q7 C（h 仅作分层）、Q8 C（calibration error + mutation 异常检出）、Q9 B（二项置信区间 +
  N≥200）、Q10 C（并入 pass_outcomes、停发旧 finding）。

## Open Questions

无。方向与 9 个细节决策已收敛，可立项（OpenSpec change）。
