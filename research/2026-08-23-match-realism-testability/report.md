---
title: 比赛效果真实性的可测试性（不靠人眼）
date: 2026-08-23
question: 看下当前这个，除了人用肉眼看画面之外，怎么维护它的比赛效果真实性的可测试性
status: completed
stability: slow
last_verified: 2026-08-23
based_on: research/2026-08-04-football-manager-match-engine/
model: claude-fable-5[1m]
sources: 33
tags: [football-manager, testing, realism, game-ai, verification]
---

# 比赛效果真实性的可测试性（不靠人眼）

## TL;DR

可以。而且对这个项目来说，「真实性的自动化测试」不止可行，还是**确定性引擎 + 事件流架构白送的**：引擎同 seed 必产同事件流，所以"多 seed 统计分布测试"是确定性的、可复现的、永不 flaky——这比大多数游戏项目做统计验证的条件都好。

具体分三层，前两层全部可以自动化，第三层留给眼睛：

1. **L1 规格一致性**（当前价值最高、最便宜）：引擎里所有硬编码概率（射门 15/35/50、tackle 50/50、槽位 30/12/18/22/18、扑出率 40/60……）目前只写死在代码里，没有任何测试。用 `simulate(seed)` 跑 N=100 个 seed、聚合事件流统计、按 Wilson 置信区间断言观测比例落在声明概率 ±3-5pp 内。这是「实现 vs 规格」的验证。
2. **L2 过程真实性 / 不变量**（多数已有雏形，扩充即可）：事件流与动画纯函数的物理/时空不变量——比分一致、射门落点在球门内、射门起脚在进攻半场、beat 节拍固定 1s、carrier/无球跑位速度不超过常量、传球飞行时间 = 距离/速度、门将不出禁区。这是「机制 vs 物理现实」的验证。
3. **L3 真实数据参考带**（远期、需要先做目标决策）：把引擎聚合统计对真实联赛均值区间（场均进球 2.0-3.6、射门 18-32、射正≈1/3 射门、角球 6-14、控球 35-65%、禁区内进球 ~85%）。**当前引擎会大面积不过**——因为它是「槽位集锦」模型（24 高亮/场，射门仅 ~7/场），目标本来就不是复现全场比赛统计。这一步的价值是先把目标档位定清楚。

黄金法则（来自仿真验证文献，Sargent 框架）：**视觉验收只是主观校验，不是验证**；「把参数调到看起来对」不算校准验证。真实性的自动化闸门 + 偶尔的视觉抽查，才是可持续的维护方式。FM 官方（data benchmarking）和社区 mod 团队（FMTweak 统计+视觉双轨）都是这么干的。

---

## 1. 项目现状 → 缺口在哪

现有测试（`verify.sh`：引擎 9 项 + viewer 52 项 + WASM e2e）非常扎实，但全部验证的是**正确性**，不是**真实性**：

| 现有测试 | 验证什么 | 真实性覆盖 |
|---|---|---|
| `simulate_same_seed_deterministic` | 确定性 | 无 |
| `coordinates_in_range` | 坐标在 0-1 | 无 |
| `simulate_produces_minimal_match` | 事件类型齐全 | 无 |
| `tackle_events_carry_loose_and_carrier_from` 等（多 seed 扫） | 语义字段 | 无 |
| viewer protocol 测试 | 事件 schema | 无 |
| interpretation 测试 | 动画时序正确性 | 部分（锚点递增/不产 NaN） |
| renderer 像素断言 | 画对位置 | 无 |
| e2e 无 snap | 播放连续 | 部分（无瞬移） |

真实性的缺口正好落在引擎里**大量「标定注释」所在的常量**上：

```rust
// shot: goal <15 → 15%, saved <50 → 35%, off_target 50%（emit_shot_highlight）
// tackle: TACKLE_SUCCESS_RATE = 0.5
// 槽位: Shot 30% / Corner 12% / ThrowIn 18% / Tackle 22% / Pass 18%
// "P7：goal 率 15%（5min 集锦也要有进球）"
// "贴防率 ≈ 目标 8-15 次/场 → 阈值 12m"
```

这些数字是「真实性规格」，但**没有一条测试验证实现真的产出这个分布**。改错一个概率、或重构时弄反一个分支，人眼要盯几百场才可能发现。这就是 L1 测试要补的洞。

---

## 2. 关键区分：哪些「真实性」能量化，哪些必然留在视觉层

不是所有真实性都能自动化，先划清边界（避免把「自动化测试」做成伪客观）：

| 真实性维度 | 能否自动断言 | 说明 |
|---|---|---|
| 分布统计（进球率、射门数、控球时长、射正比例、角球数、位置分布） | ✅ 能 | 多 seed 聚合 + 参考带 |
| 物理/时序合理性（速度上限、飞行时间=距离/速度、节拍固定、无瞬移） | ✅ 能 | 纯函数/事件流不变量 |
| 结构合理性（比分与射门一致、射门起脚半场、门将位置、球权与事件一致） | ✅ 能 | 跨事件不变量 |
| 场景/剧情合理性（落后队压上、角球后攻方包抄、扑出后补射） | ⚠️ 部分能 | 目前引擎无属性/战术差异，只能断言「出现」不出现，不能断言「因为落后所以压上」；等属性系统出现后可做条件统计 |
| 观感（节奏好不好看、动线流不流畅、集锦刺激程度） | ❌ 不能 | 必须人眼；但可以**结构化**（固定 seed + 固定检查清单）让抽查可复现 |
| 「像不像真实球队」（风格差异、强弱分化、联赛间差异） | ❌ 当前不能 | 引擎还没有队/球员属性差异，无法验证它不存在的东西 |

结论：**引擎当前的真实性目标 = 「5 分钟集锦也要有合理事件密度」的集锦真实性**（常量注释反复出现这句话）。可自动化的部分（分布+物理+结构）覆盖了这个目标的大头；视觉层负责「好不好看」这个最后 5%。

---

## 3. 方法论框架（为什么这样做是对的）

仿真验证领域对此有成熟框架，正好给本项目的分层找到学术位置：

- **Sargent 框架**：*verification*（"building the model right"——模型是否正确实现）与 *validation*（"building the right model"——模型是否代表真实系统）分开。客观验证手段 = 统计检验（置信区间、chi-square、KS、ANOVA 等）。**内部有效性（internal validity）**：随机仿真必须多次重复运行并用统计技术检验一致性——"单次运行不能代表模型"[1][2]。本项目确定性引擎 + 多 seed 正是这一条的直接实现。
- **校准 ≠ 验证**：Sargent 明确把 calibration 与 validation 分开——只把参数调到"看起来对"不算验证 [1]。视觉验收是主观校验，不可作为唯一依据。
- **ABM 三种 validity**（replicative / structural / predictive）：能复现已观测数据 = replicative；因果机制正确 = structural；预测未见数据 = predictive。三者不一定一致 [3]。对本项目：L1+L3 是分布级的 replicative 验证；L2 是 structural 验证；predictive 验证需要属性/战术系统后才谈得上。
- **Pattern-Oriented Modeling（POM，Grimm et al.）**：只匹配单一输出变量不够，要**同时复现多个尺度多个模式**才能过滤掉结构错误模型 [4][5]。→ 不要只断言场均进球；进球、射门、射正、角球、控球、射门位置一起断言，多模式同时匹配。

对单人从零项目，这框架落到实践就是一句话：**统计分布断言（多 seed）+ 不变量断言（事件流）+ 少量 golden master（防漂移）三件套，视觉抽查兜底**。

---

## 4. FM / SI 怎么做，哪些能迁移

### SI 官方：data benchmarking
SI 的比赛引擎由专责 Match 团队维护，真实性的官方方法是 **data benchmarking**——把引擎产出的模拟数据对真实足球数据做 min/max/mean/standard deviation 对比（Analytics FC Podcast 访谈引擎工程师 Elliott Stapley，主题即 "how Sports Interactive use data benchmarking to guarantee the realism"）[6]。引擎机制是每 1/6 秒每个球员做一次决策的 slice 循环，无剧本，结果涌现 [7]，所以统计分布是引擎行为的自然输出，可以直接对数据。

### 社区 mod 团队：小团队双轨校准（对本项目最有参考价值）
- **FM Tweak / FM Match Lab** 自述校准 = **double pivot of testing**：① 统计测试——模拟多个联赛到至少 2050 年，逐赛季对比真实数据，防止结果 "wildly off-piste"；② 视觉测试——几百场 highlights/full match 逐场看有没有 weird 行为 [8][9]（原站 WebFetch 被网络策略拦，此处为搜索结果摘要）。
- **TrueSim（FM24 引擎 mod）** 给出了可量化的校准例子：场均射门每队 ~10.5-17.2（均 ~13.5-13.8）、射门转化率 9-15.6%、每队场均犯规 11-13、黄牌每队 2.1-2.4、角球/任意球进球率等，逐项对照真实值微调 [10]。
- **FM21 起内建 SciSports xG 模型**：按距离/角度/防守者距离/球高评估机会质量，是第一个这么做的主机游戏 [11]。

### 可迁移 vs 不成立
- **可迁移**：TrueSim 式「把引擎常量产出统计对真实区间」；FM Match Lab 式「统计闸门 + 视觉抽查双轨」；SI 式「对分布做 min/max/mean/std」。
- **不成立（对单人从零项目）**：SI 完整 data benchmarking 需要数据团队 + 授权数据（本项目用公开联赛均值 + 自定目标区间即可）；xG 内建需要高质量射门位置/质量建模（可以先做「按落点位置的分桶 xG 近似」）；slice 级引擎机制是 FM 的架构选择，本项目用事件槽 + beat 节拍，统计验证的粒度到事件层即可。

---

## 5. 学术上的验证方法：Poisson / 分布对比

足球比分建模的学术主线是 **Poisson / negative binomial 分布 + goodness-of-fit**：Maher (1982) 发现独立 Poisson 模型（每队攻防强度参数）对足球比分 "reasonably accurate"，但有小系统性偏差 [12]；FIFA 世界杯 1938-2006 的数据分析则发现高比分过量、**negative binomial 拟合更好**（NB = Gamma 混合 Poisson），且两队比分间无相关性、支持独立 Poisson 假设 [13]。验证方法学上的共同范式是：**模拟 N 场 → 统计分布 → 与观测频数对比（chi-square / 似然比 / 概率评分）** [12][13][14]。

对本项目的三条推论：
1. 「进球数/场」这类宏观分布对**验证引擎整体产出像不像足球**有用，但需要先有足够的射门事件量（当前引擎 ~7 射门/场，N=100 场也只有 ~700 射门，分布拟合的统计力有限）。
2. 对**验证硬编码概率实现是否正确**（L1），用**二项分布置信区间**（每射门独立同概率）而不是 Poisson——更精确且零依赖。
3. 上述两篇文献在「Poisson 是否够好」上有分歧（Maher 支持、世界杯研究反对），但对本项目目标不构成影响：我们不做分布拟合假设检验，只做「观测比例 vs 声明概率」的带容忍带断言。

---

## 6. 真实足球数据参考区间（L3 的目标，带来源）

下表是 EPL 为主的公开可引用均值。**注意**：各赛季/联赛波动明显（见「12.9 vs 13.8 射门/队」这类数值差异），报告引用时标注赛季，测试用区间不用精确值。

| 指标（每场） | 参考值 | 来源 |
|---|---|---|
| 总进球 | **2.75**（主 1.53 / 客 1.22）；多数顶级联赛 2.4-3.0 | Kopacak 赛季统计 [15]、StatMuse [16] |
| 总 xG | **2.88**（每队典型 1.2-1.5） | [15][16] |
| 总射门 | **24.97-27.6**（每队 ~12.5-13.8） | Kopacak [15]；The Athletic 2023-24 [17] |
| 总射正 | **8.37** ≈ 射门 1/3 | [15] |
| 射门转化率 | 全部 ~10%；射正 ~30%；禁区内 2024-25 14.7%（近十年 15.2%）；禁区外 4.2%（近十年 3.5%） | PL 官方 [18]、Opta Analyst [19] |
| 进球来源 | **~85-88% 来自禁区内**（禁区外进球 2024-25 11.7%） | [18]、StatsBomb [20] |
| xG 按位置 | 6 码区 ~0.80；点球 ~0.75-0.79；禁区内 ~0.10-0.30；禁区弧 ~0.05-0.10；禁区外 ~0.02-0.05 | [21][22][23][24] |
| 传球成功率 | 队级 78.7%（下游）~ **89.9%**（曼城）；联赛均值 ~80%+ | FotMob [25]、BBC/Opta [26] |
| 控球率 | 主 50.8 / 客 49.2；队级 42%-64.5% | [15][16][26] |
| 抢断 | ~15-17/队 | WhoScored 队档案 [27] |
| 角球 | ~10（双方） | [15] |
| 犯规 / 黄牌 | ~21 / ~3.8（双方） | [15] |

物理量参考（动画层真实性目标）：人类无球冲刺 ~9-10 m/s，带球跑 ~7 m/s；本项目 `CARRIER_SPEED_MS=5.0`、`RUN_SPEED_MS=4.0` 偏保守但合理；射门速度本项目 22-29.9 m/s（`22.0 + rng%80/10`），现实职业硬射 ~30 m/s，区间合理；传球短传 15-25 m/s、长传可达 30 m/s。全场跑动 ~10-12 km/人。

---

## 7. 映射到本项目架构：五类具体技术

### 7.1 多 seed 统计分布测试（L1，引擎层，最高性价比）

引擎 `simulate(seed, config)` 确定性 → 跑 N 个 seed，把事件流解析成比赛统计，断言与声明概率一致。**完全确定性，永不 flaky**——这是本架构最大的测试红利。

- 射门结果分布：goal 15% / saved 35% / off_target 50%（`emit_shot_highlight`）
- 扑出细分：caught 40% / rebound 60%；rebound 后 corner 90% / 场内松散 10%
- tackle 结果：success 50% / fail 50%（`TACKLE_SUCCESS_RATE`）
- 槽位比例：Shot 30 / Corner 12 / ThrowIn 18 / Tackle 22 / Pass 18（`roll_highlight_slot`）
- 出界比例：普通传球落点出界 3-5%（`emit_pass_highlight_inner`）

做法：解析事件流（引擎测试里已有 `json_events` + 字段提取器），对每个 seed 统计计数，最后用 Wilson 置信区间断言 `p_hat ∈ p0 ± tol`。N=100 seed × 24 高亮 = 2400 槽，goal 率 15% 的 95% CI 约 ±2.6pp → 断言 12-18% 带即可。

### 7.2 事件流不变量 / 性质测试（L2a，跨事件，扩充 protocol.test.js）

现有 protocol 测试只验**单条事件 schema**；补**跨事件不变量**（对任意 seed 都成立，for 循环 1..100 seed 跑）：

- **比分一致性**：whistle `score` == 事件流中 `shot result=goal` 计数
- **射门落点**：goal 事件 `x2/y2` 落在球门矩形内（home 攻 `x=0.98`、`y∈[0.455,0.545]`，`shot_target` 逻辑）
- **射门起脚半场**：shot 事件起点 `x` 应在进攻半场——**当前会被违犯**（射门槽注释明说"非门将无论位置都射"，5min 比赛 carrier 没推进到前场也射门）。需决策：改引擎 push 射门槽到前场，或把该断言标为 known-gap + 容忍带
- **节拍**：beat 事件 `t` 严格按 `TICK_SECONDS=1.0` 推进、无 >2s 间隙（防播放卡顿）
- **门将位置**：GK（id 0/21）`pos` 始终在己方禁区内
- **球权一致性**：`beat.main.subject` 的队 == 当前 possession 方；`tackle success` 后 possession 立即易主
- **无死球越界**：任意事件 `t` ∈ [0, dur]

### 7.3 物理/时序现实性边界（L2b，动画纯函数 + 事件速度）

引擎/interpretation 层全是纯函数，速度与现实量的关系可以直接断言：

- **飞行时间 = 距离 / 速度**：pass/shot 事件 `flight = distance_meters(from, to) / speed`，可断言 `|t_end - t - flight| < ε`
- **速度上限**：carrier `main.speed ≤ CARRIER_SPEED_MS`；movers `speed ≤ RUN_SPEED_MS`；`GK ≤ GK_SPEED_MS`
- **射门速度区间**：`speed ∈ [22, 30]` m/s（引擎常量）
- **传球高度语义**（`pass_h`）：短传 ≤20m `h=0`、长传 >20m `h∈[0.2,0.4]`——已有 interpretation 测试覆盖 h 优先级，可补「h>0 ⇔ 距离>20m」的跨事件断言
- **锚点时长**（viewer interpretation）：带球段时长 = 距离/带球速度；tackle 五段式锚点递增已测，补「各段时长与距离/速度一致」

### 7.4 Golden master / 特征测试（防漂移，引擎层）

选 10 个 canary seed（固定），存每 seed 的**统计摘要 JSON**（进球/射门/抢断/角球/界外球/控球率 + 事件流哈希）。改引擎后对比——任何差异即回归信号，需人工审查后**刻意 re-baseline**。与统计测试互补：统计测试说"分布还对"，golden master 说"没有任何静默漂移" [28][29]。注意 discipline：**绝不自动接受新基线**，否则会「洗白」回归 [28]。

### 7.5 Common Random Numbers（调参工具，不是 pass/fail）

调一个常量（如 `TACKLE_SUCCESS_RATE` 0.5→0.6）时，用**同一组 seed 跑前后对比**，逐 seed diff 目标统计——把「参数变化效应」与「seed 噪声」隔离，单人调参时用几十个 seed 就能回答「这次改动到底把抢断率抬了多少」[2]。实现为 `#[test] #[ignore]` 工具或 `cargo test -- --nocapture` 打印 diff。

---

## 8. 一套「真实性测试套件」设计

建议落地为 `engine/tests/realism.rs`（Rust 集成测试）+ verify.sh 第 4 步。全部零新依赖（解析器复用现有 JSON 拆分工具）。

### 参数
- **场数**：CI 默认 N=100 seed（90 分钟），深调参时 `--seeds 500`。N=100 对 15% 级比例已能检出 ±3-4pp 偏差（见 §5 统计力），且引擎单场模拟为毫秒级，100 场 < 1s（debug 模式数秒）。
- **容忍带**：全部用 **Wilson 置信区间** 计算（α=0.05），不拍脑袋。示例带：
  - 射门 goal 率：p0=15%，N_shots≈720 → 带 [12%, 18%]
  - tackle success 率：声明贴防首抢 50%，但叠加 far(15%)/same_pair(强制 0%) 稀释后整体会低于 50%。L1 断言分两类：① 近距首抢 success ≈ 50%（N≈500 → 带 [45%, 55%]）；② 单调性——far 抢断 success 显著低于近距（可由事件坐标重建距离分类）
  - 槽位 shot 比例：p0=30%，N_slots=2400 → 带 [28%, 32%]
- **固定 seed 集**：1..N（确定性，无 flaky）。加一个 `--shuffle` 变体验证「带不依赖特定 seed 子集」——防止对 canary seed 过拟合。

### 断言清单（按层）
| 层 | 断言 | 当前预期 |
|---|---|---|
| L1 | 射门 goal/saved/off_target ≈ 15/35/50 | ✅ 应通过 |
| L1 | 扑出 caught/rebound ≈ 40/60；rebound→corner ≈ 90% | ✅ 应通过 |
| L1 | tackle success ≈ 50% | ✅ 应通过 |
| L1 | 槽位 mix ≈ 30/12/18/22/18 | ✅ 应通过 |
| L2 | 比分 == goal 计数 | ✅ 应通过 |
| L2 | 射门落点在球门内（goal/saved） | ✅ 应通过 |
| L2 | 射门起脚在进攻半场 | ❌ **已知违犯**（见 §7.2） |
| L2 | beat 节拍固定、无 >2s 间隙 | ✅ 应通过 |
| L2 | 速度不超常量；飞行时间=距离/速度 | ✅ 应通过 |
| L2 | 传球成功率 ~80-90%（vs 真实带） | ❌ 当前 ~95-97%（集锦模型） |
| L3 | 场均进球 ∈ [2.0, 3.6] | ❌ 当前 ~1.1（~7 射门 × 15%） |
| L3 | 场均射门 ∈ [18, 32]（双方） | ❌ 当前 ~7 |
| L3 | 射正 ≈ 1/3 射门 | ⚠️ 结构上射正 = goal+saved = 50%（引擎声明 15+35），真实 ~33%——L3 目标差异 |
| L3 | 禁区内进球占比 ~85% | ⚠️ 落点语义需对齐 |

### CI / verify.sh
```
=== 4/4 真实性统计套件（引擎 multi-seed）===
(cd engine && cargo test --test realism --release 2>&1 | tail -8)
```
- 日常 `verify.sh`：N=100，全部 L1+L2（几秒内）。
- L3 作为 **separate gate**（`cargo test --test realism --features target-L3` 或 `--ignored`），因为当前会红——先定目标档位再启用。
- Golden master：`cargo test --test realism gm_`，re-baseline 用 `--accept-golden` 旗标（写文件前必须过人工审查）。

---

## 9. 对抗式自查（关键论断的边界与分歧）

1. **「FM 用 data benchmarking 校准」**：仅来自 Analytics FC Podcast（Elliott Stapley）[6] 单一访谈，无官方书面文档；Prima 评测与 FM 社区多源印证其存在 [7][10]。SI 社区对引擎平衡性长期有争议（"只有 Pace 起作用"）[7]。→ 采用但标注为「多源印证、非官方文档」，作为方法参考而非事实断言。
2. **「Poisson 拟合进球数」**：Maher 支持 [12]，世界杯数据研究反对（NB 更好）[13]——文献分歧真实存在。本项目 L1 用二项分布绕开该分歧；L3 若做进球数分布拟合，推荐 NB 作为更稳基线 [13]。
3. **场均射门数值**：初稿用「12.9/队」被证伪——2023-24 实为 27.6 双方（13.8/队）[17]，Kopacak 某季 24.97（12.5/队）[15]。赛季间波动 ±1.5 射门/队。→ 测试带必须用区间，别信单一数字。
4. **Golden master 陷阱**：golden master 只检测「变了」不验证「对不对」[28]。re-baseline 必须人工审查；配合统计带（说"对"）才完整。固定 seed 集可能对 canary seed 过拟合——用 `--shuffle` 变体验证。
5. **统计测试 RNG 的经典警告**：均匀直方图 ≠ 随机 [30]。但本项目测的是「引擎按声明概率掷骰」的实现正确性（采样器测试范式，Apache Commons RNG 同样用法）[31]，不是测 RNG 质量；RNG 质量已有 same-seed 确定性测试兜底。
6. **校准 ≠ 验证**（Sargent）[1]：本报告所有「自动断言」都是对**声明规格**或**外部参考带**的验证；视觉抽查是主观校验。二者不能互相替代。

### 对「单人从零项目、无外部数据」不成立的移植
- FM 完整 data benchmarking / SciSports xG 内建：需要数据团队 + 授权数据 → 用公开联赛均值 + 简化分桶 xG。
- RL / LLM 自动化 playtesting（UBCL、RuleSmith）[32][33]：引擎无属性/战术空间，属于杀鸡用牛刀 → 多 seed 引擎本身就是 playtester。
- 事件级 replicative 验证：公开数据只有聚合统计，没有逐事件流 → 只能做到分布级复现。
- 分布拟合假设检验（Poisson/NB 正式拟合 + 显著性）：样本量（~700 射门）撑不起 → 先用计数带。

---

## 10. 分优先级路线图（便宜高价值优先）

**P0（本周可做，纯 Rust，零依赖，最高价值）**
- `engine/tests/realism.rs`：L1 全部统计分布断言（§8 清单）+ L2 比分/落点/节拍不变量。N=100，几秒跑完。
- Golden master：10 个 canary seed 的统计摘要。
- 进 verify.sh 第 4 步。
- **预期收益**：目前所有硬编码概率（15/35/50、50/50、槽位 mix）从「没人管」变成「每次提交守护」。

**P1（物理/时序真实性）**
- L2b 速度/飞行时间/节拍断言；viewer interpretation 锚点时长现实性测试（带球、传球、射门、抢断五段式时长 vs 距离/速度）。
- 门将禁区、球权一致性跨事件断言。
- 射门起脚半场问题：决策「改引擎 push 前场」或「标 known-gap」。

**P2（目标档位决策 + L3 参考带）**
- 用 L3 参考带先跑一版「现状报告」（不设 pass/fail），看清楚当前集锦模型与全场比赛统计的差距（射门 ~7 vs 27、进球 ~1.1 vs 2.75、传球成功率 ~96% vs ~82%）。
- 决定真实性目标档位：A=集锦真实性（保持 24 槽，L3 只查比率类指标）；B=全场比赛统计真实性（提高事件密度，射门/传球/控球要够量）。
- 决策后把对应带设为 gate。这个决策影响引擎事件量级，必须在写实现前定。

**P3（结构化视觉抽查）**
- `tools/visual-smoke.md`：固定 seed 清单（1 号产 goal、某号产 corner、某号产 tackle fail、某号产 off_target）+ 每次抽查必须看/不能出现的事项清单。把「人眼验收」从「随便看几场」变成「固定剧本 + 清单」。

**P4（等属性/战术系统出现后）**
- 强弱差异测试：强队 vs 弱队多 seed 胜率/射门差（POM 多模式）；场景测试（落后 3 球 vs 领先 3 球的压上差异）；球队风格统计指纹（控球队 vs 反击队的传球/射门分布差异）。

---

## 11. 结论

对本项目，比赛效果真实性**不需要人眼来维护**——至少前两层（规格一致性 + 过程真实性）可以完全自动化，且因为引擎确定性强，自动化比大多数游戏项目更可靠。核心动因是：引擎已经把「真实性规格」写进了常量注释，现在缺的只是让测试把这些规格变成断言。

要现在就做的三件事：
1. 写 `engine/tests/realism.rs`（L1 统计分布 + L2 不变量），进 verify.sh；
2. 存 10 个 canary seed 的 golden master；
3. 跑一版 L3「现状报告」，决定集锦真实性 vs 全场比赛统计真实性——这是唯一需要人工决策的点。

剩下（视觉层的「好不好看」）保留人眼，但用固定剧本 + 清单把它结构化，让它从「唯一真实性检查」降级为「统计闸门之上的最后一道抽查」。

---

## 来源

1. Sargent, "Verification and Validation of Simulation Models"（讲义摘要版）：https://people.cs.nott.ac.uk/pszps/biss2013/resources/BISS_Lec28.pdf ；相关综述 https://pmc.ncbi.nlm.nih.gov/articles/PMC9560613/
2. Balci & Sargent (1984)，同步置信区间多响应验证，经 Sargent 框架综述转引（同上）
3. Stanford Encyclopedia of Philosophy, "Agent-Based Modeling in the Philosophy of Science": https://plato.stanford.edu/archives/Win2023/entries/agent-modeling-philscience/
4. Pampas Model validation 案例：https://bdu.siu.edu.ar/bdu/Record/B-22-47031
5. Troitzsch, "Using Empirical Data for Designing, Calibrating and Validating Simulation Models": https://www.semanticscholar.org/paper/Using-Empirical-Data-for-Designing%2C-Calibrating-and-Troitzsch/f5c55efea2b05a9e115fb2384a1d82190bd385d3
6. Analytics FC Podcast, Episode 45: Elliott Stapley, Sports Interactive and Football Manager: https://podcasts.apple.com/us/podcast/episode-45-elliott-stapley-sports-interactive-and/id991610009?i=1000558151151
7. SI 社区 "When will the match engine be made more realistic": https://community.sports-interactive.com/forums/topic/596466-when-will-the-match-engine-be-made-more-realistic/
8. FM Tweak Dev Blog: https://fmtweak.com/how-to-change-a-match-engine-fmtweak-dev-blog/（WebFetch 被拦，用搜索摘要）
9. FM Match Lab About: https://fmmatchlab.co.uk/about/（同上）
10. TrueSim FM24 mod: https://www.fmscout.com/a-truesim-fm24-match-engine-mod.html
11. SciSports × SI FM22 合作：https://www.scisports.com/scisports-continues-innovative-partnership-with-sports-interactive-in-fm22/
12. Maher (1982), "Modelling association football scores", Statistica Neerlandica（经搜索结果转引）
13. "Are soccer matches badly designed experiments?"（World Cup 1938-2006，NB 拟合更好）: https://ar5iv.labs.arxiv.org/html/0909.4555
14. Champions League 格式研究（Poisson 模拟 + train/validation 验证）: https://ar5iv.labs.arxiv.org/html/2508.08290
15. Kopacak Premier League 赛季统计: https://kopacak.com/soutez/statistiky-souteze?id=287&soutez=premier-league
16. StatMuse 2025-26 各队场均: https://www.statmuse.com/fc/ask?q=premier+league+teams+average+corners%2C+average+goals%2C+average+sot%2C+average+shots...
17. The Athletic, "Why winning the Premier League shots battle is not as important as it's made out to be"（2023-24 场均 27.6 射门）: https://www.nytimes.com/athletic/5728926/2024/08/30/more-shots-more-victories-premier-league/
18. Premier League 官方, "Why are players shooting less from long range this season?"（转化率/禁区外进球占比）: https://www.premierleague.com/en/news/4272809
19. Opta Analyst, "Finding Their Range: Where Premier League Teams Are Shooting From in 2024-25": https://theanalyst.com/articles/premier-league-2024-25-shot-data
20. StatsBomb, "Premier League Shot Benchmarks": https://blogarchive.statsbomb.com/articles/soccer/premier-league-shot-benchmarks/
21. Liverpool.com xG 值: https://www.liverpool.com/liverpool-fc-news/features/liverpool-jurgen-klopp-goals-shots-17696491
22. Kiqiq 射门图: https://kiqiq.com/blog/football-shot-maps
23. Tactiq xG deep-dive: https://www.tactiq.club/en/blog/xg-calculator-shot-types-deep-dive/
24. PSSA Understanding xG: https://thepssa.us/blog/understanding-expected-goals-xg-in-soccer
25. FotMob 2024/25 传球成功率: https://www.fotmob.com/leagues/47/stats/season/23685/teams/accurate_pass_team/team
26. BBC, "Premier League 2024 stats breakdown": https://www.bbc.com/sport/football/articles/c4g3yp9j80go
27. WhoScored 队档案（抢断/控球/传球）: https://www.whoscored.com/
28. Golden Master Testing / Characterization Testing: https://github.com/chicio/Golden-Master-Testing-Characterization-Test ；https://deepwiki.com/franiglesias/golden/3.3-golden-master-testing
29. "Tests that (Almost) Write Themselves"（EuroPython 2020）: https://ep2020.europython.eu/talks/4ALvmfv-tests-that-almost-write-themselves/
30. Software Engineering SE, "单元测试与随机性" 讨论（Diehard/ENT/KS）: https://softwareengineering.stackexchange.com/
31. Apache Commons RNG 采样器 chi-square 测试: https://commons.apache.org/proper/commons-rng/commons-rng-sampling/xref-test/org/apache/commons/rng/sampling/MarsagliaTsangWangDiscreteSamplerTest.html
32. UBCL（RL 自动化 playtesting 背景）: https://ar5iv.labs.arxiv.org/html/2512.10835
33. RuleSmith（LLM 多代理游戏平衡）: https://arxiv.org/pdf/2602.06232
