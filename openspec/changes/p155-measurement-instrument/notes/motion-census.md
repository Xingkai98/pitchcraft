# 运动普查：条件 turn120 + 静止分布（P155 / B 工作流）

日期：2026-11-19
分支：`p155-measurement-instrument/2026-11-19`（基于 `d339b29`，引擎与 `main=16dfaa0` 行为一致）
工具：`tools/visual-review/motion-census.mjs`（新文件；**未改** `motion-metrics.mjs`，理由见 §1）
测试：`tools/visual-review/motion-census.test.mjs`（**20/20** 全绿；零步反证条做过定向变异，见 §6）

证据：
- **主口径（A 冻结刺激集 + R7i 同锚点真实窗）**：`notes/motion-census-frozen-anchors.{json,log}`
- **A engine 侧硬校验**：`notes/motion-census-stimulus-engine.{json,log}`（逐 seed 打印/校验事件流 SHA）
- **稳健性（宽扫）**：`notes/motion-census-{all,active}-windows.{json,log}`
- A 的刺激集：分支 `p155-ablation/2026-11-19` 的 `notes/stimulus.json`（commit `6affb4b`；
  本 change 在 `notes/stimulus-A.json` 存档了该文件，便于离线复算）
- R7i 窗口表：`notes/r7i-windows.json`（存档自
  `git show c5a5584:.scratch/notes/c1-trajectory-morphology-2026-10-30/acceptance-r7d48/windows.json`）

---

## 1. 为什么新建工具而不是扩 `motion-metrics.mjs`

`motion-metrics.mjs` 的 `windowStats` 被 `discriminator-census.mjs` / `like-football.mjs`
当稳定 API 消费；改它的口径会静默改写历史读数。本工具是**新增纯函数模块**，旧文件一行未动。
二选一的决定与理由写在这里，满足 design D8「实现时定并写注释」的要求。

## 2. 口径（逐条写死；报告已带 n / seed / 窗长 / 采样率）

- 输入：viewer 渲染帧（5Hz，`loadEngineFrames` / `loadRealFrames`）；x/y 归一化，米制 105×68。
  剔门将（id 0/21）。
- 窗：24s、5Hz、121 帧；步长 = 窗长。121 帧含两端点 ⇒ 相邻窗**共享边界帧**
  （该帧在左窗是终点、在前一窗是起点）；**步不重复计**，按帧计数的方向对称性会多约 1/121≈0.8%。
  逐窗算指标 → 对窗取分布；**不跨窗拼接、不池化步**。
- 旧 `turn120`：相邻两步方向差 >120° 即计，**零步也调用 `atan2`**（JS `atan2(0,0)=0`，历史口径）。
- 条件 `turn120`：**相邻两步步速都 ≥ 门限**才计；主口径 0.5 m/s，另报 0.3 / 1.0。
- 分母并列：有效步对（`effectivePairs`）、有效步（`effectiveSteps`）、有效米制路径
  （`effectivePathM`），并报 `turnsPerEffectivePair` / `turnsPerEffectiveStep` / `turnsPerMeter`。
- 静止：`staticFrac` 档 0.2 / 0.5 / 1.0；`ballStaticFrac` 档 0.2 / 0.5 / 2.0。
  球相关主口径只用**原始球帧**（`ballFill == null`），与 `match-metrics` / `ball-travel` 同口径。
- **外推点**：真实侧跳过转换器标记的 `extrapolated` 球员点（按缺帧处理：断开步/步对、不进对称性样本），
  这是 design D3 的主口径。`includeExtrapolated: true` 只用于复算旧口径。SkillCorner 的球员点
  有相当比例带该标记 ⇒ 真实 frozen 24 窗里 20 个（SkillCorner 窗）数值会变；引擎帧无此标记。
- 转移：按 0.5 m/s 分 move/stop，计 move→stop / stop→move / move→move / stop→stop。
- 速度分位 p50/p90/p99（R type-7）；加速度尾部 = |Δv 矢量| / **平均 Δt（秒）**，报 p95/p99。
- 方向对称性：底/顶边各 8m 带、左/右半场的有符号使用率差（按帧计）。
- 采样缺口：Δt≤0 或 >1.0s 断开，不跨缺口求方向差。
- **headline 的聚合**：frozen 是 24 窗等权；宽扫的 headline 是
  **逐场先平均再跨场平均（每场等权）**。active 口径每场窗数不等（引擎 93/97/87/93/95、
  真实 57/50），所以「每场等权」与「窗池化」不是同一个数：引擎条件 turn120 差 **0.09%**，
  真实 active 差 **−3.0%**（0.0275 vs 0.0266，第 4 位不同＝不是舍入）。本 note 的宽扫数字
  一律用**逐场等权**（log/JSON 同源）；凡引用旧稿的窗池化值都会标明。

## 3. 输入集与可复现身份

### 3.1 主口径：A 的冻结刺激集（engine）+ R7i 同锚点真实窗（real）

- **Engine**：A 的 `stimulus.json`：12 seed（1201,1204,…,1237）× 2 anchor = **24 窗**，
  24s @5Hz = 121 帧；wasm `f6a9f9ec7a5effaa…`，与本 worktree 现构建**逐位相同**；
  每个 seed 的事件流 SHA256 与 A 记录**全部一致**（工具内硬校验，不一致即抛错；
  读数见 `notes/motion-census-stimulus-engine.log`）。
  主口径的 `--windows` 路径同样用这份 stimulus 校验；R7i 窗口表里 engine item 的
  `eventHash` 是**旧树**（`c1-trajectory-morphology-2026-10-29`）口径，**不是当前身份**。
- **Real**：R7i 的 24 个真实窗（同一批 anchor：4 个 Metrica + 20 个 SkillCorner 偶数场），
  窗口表来自 `git show c5a5584:.../acceptance-r7d48/windows.json`；
  数据文件在旧 worktree
  `/home/shared/.../.claude/worktrees/c1-trajectory-morphology-2026-10-29/viewer/data/`
  （gitignored；本 note 只记录来源与窗口计数，不复制数据）。
  ⚠️ A 的 `stimulus.json` 把 SkillCorner 标为 `n/a`（未下载）；本节用 R7i 已入库的窗口表
  + 旧 worktree 的同一批数据补齐真实侧。**这不是 A 的 stimulus.json 内容**，是同一批 anchor 的
  真实对照；两者不可混成「A 的 frozen real」。
  **该旧 worktree 路径是历史路径，不要求可复现**：窗口表（`notes/r7i-windows.json`）在 git 里，
  数据文件 gitignored；换机器时按窗口表重新下载/生成即可。
- **交叉验证**：本工具在 A 的 24 个 engine 窗上复现 A 的 `current` 列：
  旧 turn120 **5.885**、条件@0.5 **0.829**、staticFrac **0.239**、ballStaticFrac **0.216**
  （与 A 的 `notes/ablation.md` §2 逐位一致）。在 R7i 的 24 个真实窗上（**跳过外推点**）：
  旧 turn120 **0.221**、staticFrac **0.0369**、ballStaticFrac **0.0215**。
  R7i 原文是 **0.244 / 0.040 / 0.022**（出处
  `fix/formation-jitter-dc-bias/2026-11-01:openspec/changes/fix-formation-jitter-dc-bias/notes/probes/DISCRIMINATOR-CENSUS.md`）：
  它是**含外推点**的旧口径，跳过外推后球员量下降、球指标不变（球帧无 `extrapolated` 标记）。
  比较 R7i 时须带这个口径差。

### 3.2 稳健性：宽扫（不是 A 的冻结集）

- **Engine**：seeds `42,1,7,99,123`，各 5400s；每场 225 个 24s 窗，合计 **1125 窗**。
- **Real**：Metrica 2 场（`viewer/data/real-game-{1,2}.json`），合计 **476 窗**。
  ⚠️ 这两份数据 gitignored，本 worktree 初始不含；本次从旧 worktree 软链/拷贝后重跑。
  缺文件时工具会把真实列标 n/a（退出码 0），**不会静默填 0**——报告必须写明用的是哪份数据。
- **active-only**：用 `replay-blind-core.evaluateWindow` 的同一批预注册阈值穷举筛选
  （引擎 465/1125、真实 107/476）。
- 宽扫**不是** A 的冻结集，只用来回答「换窗口/换数据集，结论是否稳定」。
  它的事件流 SHA 在 `notes/motion-census-{all,active}-windows.json`。

## 4. 结果

### 4.1 旧 / 条件 turn120（每球员每窗；frozen 为主口径）

| 口径 | 窗 | 旧 turn120 | 条件 @0.3 | 条件 @0.5 | 条件 @1.0 |
|---|---|---:|---:|---:|---:|
| **Engine（A frozen）** | 24 | **5.885** | 0.908 | **0.829** | 0.692 |
| **Real（R7i 同锚点）** | 24 | **0.221** | 0.025 | **0.0104** | 0.0083 |
| E/R | — | **26.6×** | **35.8×** | **79.6×** | **83.0×** |
| Engine（宽扫 all） | 1125 | 5.417 | 0.953 | 0.870 | 0.695 |
| Real（宽扫 all） | 476 | 0.752 | 0.116 | 0.0781 | 0.050 |
| Engine（宽扫 active） | 465 | 5.738 | 0.917 | 0.841 | 0.660 |
| Real（宽扫 active，逐场等权） | 107 | 0.254 | 0.046 | 0.0275 | 0.022 |

**读法一：零步伪角确实存在，而且很大。** 条件口径把 engine 旧值压到 14.1%（5.885→0.829），
把 real 压到 4.7%（0.221→0.0104）。Astra 指出的 `atan2(0,0)=0` 机制在两侧都成立。

**读法二：条件化没有缩小引擎/真实差，反而把比值放大。**
frozen：旧 26.6× → 条件@0.5 **79.6×**（每球员）、**107.3×**（每有效步对）、**63.6×**（每有效米）。
真实被伪角抬高的比例（21.2×）远大于引擎（7.1×）：real 的旧 turn120 绝大部分是零步伪角；
引擎的旧值里仍有大量「真的在 ≥0.5 m/s 下反向」的步。⇒ **「24× 是伪角造出来的」不成立**；
伪角只是让两侧一起膨胀，并把真实侧膨胀得更多。

**分母（frozen；Engine 每窗 20 名非门将、n=2380 步对/窗；Real 跳过外推点后每窗有效步对均值 1811.8）**：
- Engine：有效步对 **1698.3**、每有效步对 **0.0100**、每有效米 **0.0112**
- Real：有效步对 **1724.1**、每有效步对 **0.0000934**、每有效米 **0.000175**
  （`effectivePairs @0.5` 与 §4.3 的 `move→move` 计数是**同一个量**——都定义为相邻两步都 ≥0.5；
  两处出现 1698.3 是恒等，不是抄错。）
- 窗级分布（frozen）：
  - Engine 旧 turn120 p10/p50/p90 = **1.60 / 6.53 / 10.09**；条件@0.5 = **0.43 / 0.80 / 1.24**
  - Real 旧 = **0.05 / 0.20 / 0.40**；条件@0.5 = **0 / 0 / 0.05**
  （R type-7，`notes/motion-census-frozen-anchors.json` 的窗级行；Real 值为跳过外推点后。）
- real 的 20 个 SkillCorner 窗条件@0.5 = **0.0025**；4 个 Metrica 窗 = **0.050**。
  ⇒ 真实侧的条件转向在 SkillCorner 上更低；E/R 比值主要由数据集组成决定，报告必须带数据集。

### 4.2 静止与球静止

> ⚠️ **`ballStaticFrac` 行是 viewer 链读数（P1-1）**：引擎侧球位来自 `loadEngineFrames` →
> `viewer/game.js` 的插值/演绎，不是引擎 raw 球位；viewer 贡献未分离。不要把它当纯引擎运动层靶。

| 指标 | 档 | Engine frozen | Real frozen | E/R | Engine all | Real all | Engine active | Real active |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `staticFrac` | <0.2 | 23.5% | 0.70% | 33.6× | 24.1% | 5.6% | 21.1% | 1.2% |
| `staticFrac` | <0.5 | **23.9%** | **3.69%** | **6.5×** | 24.6% | 13.2% | 21.4% | 4.5% |
| `staticFrac` | <1.0 | 24.8% | 12.6% | 2.0× | 25.6% | 29.8% | 22.3% | 14.6% |
| `ballStaticFrac` | <0.2 | 15.8% | 0.4% | 41.3× | 9.6% | 2.4% | 6.0% | 2.1% |
| `ballStaticFrac` | <0.5 | **21.6%** | **2.15%** | **10.0×** | 16.5% | 4.3% | 11.7% | 4.5% |
| `ballStaticFrac` | <2.0 | 37.8% | 16.2% | 2.3× | 35.5% | 17.4% | 30.8% | 19.1% |

**球员 `staticFrac`（frozen）**：引擎 **23.9%** vs 真实 **3.69%** = **6.5×**；
档位敏感性 <0.2 → 33.6×、<0.5 → 6.5×、<1.0 → 2.0×。真实值比含外推点的旧口径（4.0%/6.0×）低，
因为外推点被按缺帧处理（球员位置的连续性下降，伪静止步减少）。缺口仍集中在「逐比特/近零静止」。

**这是本文最重要的订正：历史「球静止 10×」在 frozen 锚点上复现（21.6% vs 2.15%；
与 R7i 转述的 21.6% vs 2.2% 一致到 0.05pp），但它不是跨窗口常数：**
- 宽扫 all（raw ball 口径）：16.5% vs **4.3%** = **3.8×**。
- 宽扫 active（Metrica 2 场）：11.7% vs **4.5%** = **2.6×**。
- frozen（A engine + R7i 同锚点 real）：21.6% vs **2.15%** = **10.0×**。
- 真实侧的 2.15–4.5% 由数据集/锚点决定：frozen real 20 个 SkillCorner 窗 ballStatic **2.38%**、
  4 个 Metrica 窗 **1.04%**；宽扫 active 的 Metrica 107 窗 **4.5%**；宽扫 all 的 Metrica 476 窗
  **4.3%**。引擎侧 11.7–21.6%，始终高于 real。
- ⚠️ **球相关量必须只用原始球帧**：Metrica 的 `frames` 约 40% 带 `ballFill`（转换器补全）。
  把补全帧算进来会把 real 的 all-window ballStatic 抬到 ~15.5%，制造「all-window 无差」的假象；
  本工具按 `match-metrics` / `ball-travel` 的口径剔除 `ballFill`，得到 4.3%。
  **分母**：real 476 窗里只有 **414 窗**有原始球步（ballStatic 的 n=414；其余 62 窗无原始球步）。
  `notes/motion-census-diagnostics.json` 记录：real 97 个球程 <30m 的窗里只有 35 个有原始球步
  （均值 18.9%）；其余是补全帧，无球指标。死球窗确实更静止，但它们在 raw-ball 口径下不占比。
⇒ 正确表述：**10× 在 R7i/A 的冻结锚点上成立；换窗口/数据集会落到 2.6–3.8×，但方向不变
（引擎始终更静止）。不要把 10× 当全语料常数，也不要用补全帧把 real 抬到 15.5% 再说「无差」。**

### 4.3 转移、速度、加速度、对称性（frozen；括号内为宽扫 active 对照）

**聚合口径（逐行标明）**：
- `Engine frozen` / `Real frozen` = 24 窗**等权**（逐窗算、对窗取均值）；Real 已跳过外推点，
  因此每窗有效步对均值从 2380 降到 1811.8。
- `宽扫 active` = **逐场先平均再跨场平均（每场等权）**，不是窗池化；引擎 5 场、真实 2 场。
  它与窗池化的差别：真实条件 turn120 约 −3.0%（见 §2），转移占比 <0.1%。旧稿此列混用了
  「seed 42 单场」与「real-game-1 单场」，本版全部替换为逐场等权。

| 指标 | Engine frozen | Real frozen | Engine 占比 | Real 占比 | 宽扫 active（E/R 占比，逐场等权） |
|---|---:|---:|---:|---:|---|
| move→stop | 111.5 | 19.5 | 4.69% | 1.07% | 5.31% / 1.00% |
| stop→move | 113.5 | 19.8 | 4.77% | 1.08% | 5.26% / 1.01% |
| move→move | 1698.3 | 1724.1 | 71.36% | 95.29% | 73.29% / 94.54% |
| stop→stop | 456.7 | 48.4 | 19.19% | 2.57% | 16.15% / 3.45% |

| 指标 | Engine frozen | Real frozen | E/R | 宽扫 active（E / R，逐场等权） |
|---|---:|---:|---:|---|
| 速度 p50 | 3.66 m/s | 2.44 m/s | 1.50× | 3.89 / 2.17 |
| 速度 p90 | 5.88 m/s | 4.57 m/s | 1.29× | 5.97 / 4.19 |
| 速度 p99 | 7.31 m/s | 6.25 m/s | 1.17× | 7.44 / 6.02 |
| 加速度 p95 | **21.68 m/s²** | **3.44 m/s²** | **6.3×** | 23.71 / 2.99 |
| 加速度 p99 | **29.98 m/s²** | **4.72 m/s²** | **6.4×** | 30.57 / 4.34 |
| 底-顶使用率差 | −1.5pp | +2.8pp | — | −4.6 / +1.0 |
| 左-右使用率差 | +14.3pp | −2.1pp | — | +2.2 / +2.0 |

**加速度尾部是比 turn120 更干净的「不连续」信号**：引擎每拍在 0 与 4–6.8 m/s 之间跳变，
Δv/Δt ≈ 20–34 m/s²；真实 tracking 同口径 p95 只有 ~3.4 m/s²。它不依赖「方向」定义，
也不受零步伪角影响；Change 1 的验收应把它作为预注册指标之一。

### 4.4 球静止来源分解（Engine frozen；宽扫 active 对照）

条件静止率 = 该类时间内球速 <0.5 m/s 的时间占比；贡献 = 该类静止时间 / 总静止时间。

| 来源 | frozen 时间 | frozen 静止率 | frozen 贡献 | 宽扫 active 贡献 |
|---|---:|---:|---:|---:|
| `carrier_hold` | 22.3% | 32.7% | **51.4%** | **59.0%** |
| `carrier_dribble` | 34.7% | 0.0% | 0.0% | **<0.01%** |
| `highlight_flight` | 26.5% | 8.7% | **15.3%** | **23.9%** |
| `loose` | 15.1% | 64.2% | **30.5%** | 14.3% |
| `restart_dead` | 1.3% | 81.3% | 2.8% | 2.8% |
| **合计** | 100% | — | 100% | — |
| 窗级 `ballStaticFrac` | — | — | **21.6%** | 11.7% |

- `carrier_hold` 的**时间权重 ≠ `CARRIER_HOLD_PP=45`**：45 是每拍抽样概率，不是全场 hold
  时间占比，更不是静止率（Astra 的订正成立）。
- frozen 的 `loose` 贡献 30.5%（宽扫 active 14.3%）：冻结锚点里 loose 的时间权重 15.1%，
  条件静止率 64.2%。这与 R7i/A 的选窗（高活动、含松散球）一致；宽扫 Metrica active 里 loose
  时间权重只有 5.6%。⇒ **来源分解也是窗选敏感的**，报告必须带窗口集。
- `highlight_flight` 的静止不是飞行本身：一次性探针（seed42/5400s）里高亮静止段
  共 740 段、合计 134.5s，**每段时长 p50=p90=max=0.20s**（单帧），从动作事件到静止起点
  p10/p50/p90 = 0.70/1.30/2.30s，静止结束到下一次 `beat.main/ball` 的间隔 p50=0。
  ⇒ 它主要是**传球/射门落点的单帧停驻**，不是长时间死球。A 的消融可以验证它有多少来自
  viewer 插值（本工具不下结论）。
  ⚠️ **该一次性探针脚本未入库**：740/134.5/0.20 在本树内不可独立复现，只作量级参考；
  frozen 的同口径读数以上表（`notes/motion-census-frozen-anchors.json`）为准。

**R2 旧比例不能直接套给 main 2Hz。** R2 的 12 选窗表（RECORD.md R2，分支
`c1-trajectory-morphology/2026-10-29`）为：静止 25.7%，构成 `carrier_hold 44.6% +
carrier_slow 18.9% + pass tick 余量 14.6% + loose 13.5% + 死球系 8.4%`。
本树 frozen 分解是 `carrier_hold 51.4% + dribble 0.0% + highlight 15.3% +
loose 30.5% + restart 2.8%`；宽扫 active 是 `59.0 / 0.1 / 23.9 / 14.3 / 2.8`。
差异来源：① 引擎树不同（R2 是 R6 前）；② 窗口集不同；③ **类别定义不同**——
R2 的 `pass tick 余量` 只算飞行 tick，本工具的 `highlight_flight` 含落点单帧停驻。
R2 笔记内部还有一处不一致：同页验收摘要写「pass ~0」，而表格写 `pass tick 余量 14.6%`
——引用时以表格口径为准，并标为「旧树/旧窗，不可套用」。

## 5. A 的同流消融（引用，不重算）

A 的 `notes/ablation.md`（分支 `p155-ablation/2026-11-19`）在同一事件流上做了 linear/catmull/t1/
direct/current/movers 六种路径。其结论（转述 A 的读数）：

- 现行 viewer 全链对旧 turn120 的贡献 **−0.098/球员/窗**（区间 [−0.191, −0.005]），
  对条件 turn120 **−0.079**（[−0.148, −0.010]），对 staticFrac **−0.008**（[−0.009, −0.006]）——
  方向是**略降**，量级 1–3%。⇒ **turn120/staticFrac 的缺口不在 viewer**。
- viewer 主要增加的是**连续自转**（rotationTurns +0.985，[+0.931,+1.038]），不是 >120° 折返。
- mover 端点本身旧 turn120 5.983、条件 0.908，仍远高于真实 0.221（B 复算，跳过外推点；
  A 原文的转述值 0.244 是含外推点的旧口径）。
- `direct`（零阶保持）把旧 turn120 放大到 23.798、staticFrac 0.705、条件 turn120 压到 0——
  这定量复现了 `atan2(0,0)=0` 的零步夸大机制；**任何步进/保持采样都必须避开它**。

本 note 的 frozen 读数（5.885/0.829/0.239/0.216）与 A 的 `current` 列逐位一致；
A 的 `movers` 列说明「即使去掉 viewer，条件 turn120 仍是 0.908」。
两边的共同结论：**条件 turn120 的缺口在引擎运动执行层，不在 viewer。**

## 6. 测试与定向变异

`node --test tools/visual-review/motion-census.test.mjs` → **20/20 pass**（含 ballFill 主口径反证条、
外推点默认跳过的反证条）。

定向变异（已验证并还原）：把条件转向的
`if (a.speed >= g && b.speed >= g)` 改成 `if (true)`（取消门限），
**「零步反证条」与「门限边界」两条立即变红**；还原后 20/20 复绿。
⇒ 反证条真的绑定了门限逻辑，不是空转断言。

## 7. 复现命令

```bash
# 引擎 wasm（本 worktree 源码）
(cd engine && cargo build --target wasm32-unknown-unknown --release \
  && cp target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/engine.wasm)

N=openspec/changes/p155-measurement-instrument/notes

# 主口径：A 的冻结刺激集（engine）+ R7i 同锚点真实窗
# （窗口表已存档在 notes/r7i-windows.json；原始出处 c5a5584）
# `--windows` 现在必须带 stimulus 做源身份校验；省略时默认读 notes/stimulus.json。
# Real 侧跳过 `extrapolated` 点（design D3 主口径）。
node tools/visual-review/motion-census.mjs viewer/engine.wasm \
  --windows $N/r7i-windows.json --stimulus $N/stimulus.json \
  --out $N/motion-census-frozen-anchors.json
# 只跑 A 的 engine 侧（硬校验 event SHA + viewer 源码哈希；stimulus 已存档在 notes/stimulus-A.json）
node tools/visual-review/motion-census.mjs viewer/engine.wasm \
  --stimulus $N/stimulus-A.json --out $N/motion-census-stimulus-engine.json

# 稳健性：宽扫（真实侧读 viewer/data/real-game-{1,2}.json；数据 gitignored，缺则真实列 n/a）
node tools/visual-review/motion-census.mjs viewer/engine.wasm \
  --seeds 42,1,7,99,123 --out $N/motion-census-all-windows.json
node tools/visual-review/motion-census.mjs viewer/engine.wasm \
  --seeds 42,1,7,99,123 --active-only --out $N/motion-census-active-windows.json
```

身份校验的**实际行为**（与代码一致）：
- `--stimulus` 路径：`viewer.sourceHashes`（engine/src/lib.rs + viewer/*.js）不匹配 → **抛错**；
  某 seed 的事件流 SHA 不匹配 → **抛错**；**wasm 不匹配只 WARN**（打印 `!= stimulus (WARN:
  事件流才是行为哨兵)`，不中断）——因为 wasm 文件哈希随注释行号变化，不是行为哨兵。
- `--windows` 路径：必须带 `--stimulus`（默认 `notes/stimulus.json`），并**硬校验**源码哈希、
  wasm SHA、逐 seed 事件流 SHA，任一不符即抛错。payload 记录 `windowsPath` / `stimulusPath`
  （相对路径）与 `wasmSha256` / `eventShaBySeed`。
- R7i 的 `r7i-windows.json` 里 engine item 的 `eventHash` 是**旧树**
  （`c1-trajectory-morphology-2026-10-29`）口径，**不能当当前身份**；工具会对每个 seed 打印
  旧/新哈希差异警告，但身份以 `stimulus.perSeed` 为准。
- ⚠️ `--windows` 的**默认 stimulus 路径**（`openspec/changes/p155-measurement-instrument/notes/stimulus.json`）
  在 change 归档/搬目录后会失效。**复现时请显式传 `--stimulus`**（如上），不要依赖默认值。

## 8. 未完成 / 不确定

- A 的 `stimulus.json` 只含 engine 窗；真实侧用 R7i 的 24 窗补齐（4 Metrica + 20 SkillCorner）。
  SkillCorner 文件来自旧 worktree（gitignored），**本树内不可独立重建**；窗口表在 git 里
  （`c5a5584`），数据文件需从旧 worktree 或重新下载。
- 宽扫的真实侧只有 Metrica 2 场；SkillCorner 20 场没有复制进本树。
- **外推点跳过后**，真实 frozen 窗的有效步对从 2380/窗降到 1811.8/窗；这是 design D3 的口径，
  不是「数据变少」的缺陷。`includeExtrapolated: true` 只是**函数选项**（`censusOfWindow`），
  **CLI 未暴露 flag**；要对照旧口径请在 Node 里直接调用函数。
- 宽扫 all/active 的真实值受 Metrica 2 场组成影响（尤其速度 p50 1.59 m/s 的 all 读数），
  不能与 frozen 的 SkillCorner 主导值混表。
- 加速度的「真实」值受 tracking 平滑/采样影响；本文只报同帧口径，不声明真实足球的物理上界。
- viewer 贡献引用 A 的消融（§5），本文不重算。
- 未跑 200 场 L1；本 note 不涉及 L1 当前值的复测。
