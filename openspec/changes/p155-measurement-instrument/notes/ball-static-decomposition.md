# ballStaticFrac 来源分解（P155 / B 工作流）

日期：2026-11-19
工具：`tools/visual-review/motion-census.mjs` 的 `phaseTimeline` / `classifyBallIntervals` /
`aggregateDecomposition` / `decomposeWindows`（测试见 `motion-census.test.mjs`）。

证据：
- **主口径（A frozen engine 24 窗 + R7i 同锚点 real 24 窗）**：
  `notes/motion-census-frozen-anchors.{json,log}`
- **稳健性（宽扫 1125/476 窗、active 465/107 窗）**：
  `notes/motion-census-{all,active}-windows.{json,log}`

本 note 的所有引擎数字都可用 `motion-census.md` §7 的命令复算；不是历史转述。

## 1. 口径（与 motion-census 同源）

- 球速：相邻**原始球帧**（`ball` 非空、`ballFill == null`）的米制位移 / Δt；
  <0.5 m/s 记为静止（与 `ball-travel`、旧 `ballStaticFrac` 同帧口径）。
- 来源由**引擎事件流**分类；静止率由**渲染帧**测量。两者分开，避免「用事件语义假装测量」。
- 窗：24s @5Hz、121 帧；步长 = 窗长；相邻窗共享边界帧（步不重复计）。
- 主口径 = A 的 12 seed × 2 anchor = 24 窗（wasm/事件流与 A 的 `stimulus.json` 逐位一致）。
- 稳健性 = 宽扫 seeds 42/1/7/99/123 的 1125 窗；active 用 `evaluateWindow` 预注册阈值筛到 465。

### 1.1 五类判定

| 来源 | 判定 | 备注 |
|---|---|---|
| `carrier_hold` | `beat.main` 的米制位移 < **1.0 m** | 引擎 hold 分支抖幅：x ≤0.58m、y ≤0.37m、合成 ≤0.69m；普通带球被 `CARRIER_SPEED_MS × TICK_SECONDS`(=2.5m) 截流 ⇒ d≥2.5m。1.0m 在两簇之间。 |
| `carrier_dribble` | `beat.main` 位移 ≥ 1.0 m | transition 同样落此（≥2.5m）。 |
| `highlight_flight` | pass / shot / tackle / kickoff 的飞行与高亮段 | 含**落点单帧停驻**（见 §4）。 |
| `loose` | `beat.ball`（松散球）段 | |
| `restart_dead` | 出界 / 犯规 / 进球后的死球与重开准备，以及预开球 | 出界 pass 先按飞行计时，飞行结束才转入死球。 |

⚠️ 这不是「球停在谁脚下」的物理归因，而是「事件状态 × 球速」的联合表。

## 2. 主口径：A frozen engine 24 窗

| 来源 | 时间权重 | 条件静止率 | 对总静止贡献 | 窗级贡献 p10/p50/p90 |
|---|---:|---:|---:|---|
| `carrier_hold` | 22.3% | 32.7% | **51.4%** | 0 / 60.7% / 82.5% |
| `carrier_dribble` | 34.7% | 0.0% | 0.0% | 0 / 0 / 0 |
| `highlight_flight` | 26.5% | 8.7% | **15.3%** | 2.1% / 14.3% / 26.7% |
| `loose` | 15.1% | 64.2% | **30.5%** | 0 / 20.0% / 73.7% |
| `restart_dead` | 1.3% | 81.3% | 2.8% | 0 / 0 / 6.4% |
| **合计** | 100% | — | 100% | `ballStaticFrac` = **21.6%** |

（点估计与窗级分布都来自 frozen 24 窗，见 `notes/motion-census-frozen-anchors.json` 的
`summary.engineDecomposition` 与 `engineDecomposition[]`。）

**真实对照（R7i 同锚点 24 窗）**：`ballStaticFrac` <0.5 = **2.15%**；
frozen 引擎 **21.6%** ⇒ **10.0×**。这与历史转述的 21.6% vs 2.2%（10×）**精确一致**。

## 3. 稳健性：宽扫 active（465 窗，逐场先平均）

| 来源 | 时间权重 | 条件静止率 | 对总静止贡献 |
|---|---:|---:|---:|
| `carrier_hold` | 25.9% | 25.6% | **59.0%** |
| `carrier_dribble` | 41.2% | 0.0% | 0.1% |
| `highlight_flight` | 26.9% | 8.8% | **23.9%** |
| `loose` | 5.6% | 34.4% | 14.3% |
| `restart_dead` | 0.5% | 56.6% | 2.8% |
| **合计** | 100% | — | `ballStaticFrac` = **11.7%** |

宽扫 all-windows（1125 窗）：hold 59.7%、highlight 18.7%、loose 17.2%、restart 4.4%、
dribble 0.0%，`ballStaticFrac` = **16.5%**。

## 4. highlight_flight 的静止是什么

一次性探针（seed42/5400s；命令在 `motion-census.md` §7）：

- 高亮静止段 **740 段**，合计 **134.5s**；每段时长 p50 = p90 = max = **0.20s**（单帧）。
- 从最近的动作事件（pass/shot/tackle/kickoff）到静止起点：p10/p50/p90 =
  **0.70 / 1.30 / 2.30s**（≈ 飞行时长）。
- 静止结束到下一次 `beat.main/ball` 的间隔：p10/p50 = **0 / 0**，p90 = 0.20s，max 5.20s。

⇒ 高亮静止主要是**球到落点后、下一拍 main 开始前的单帧停驻**，不是长时间死球。
这也解释了为什么旧 R2 的「pass tick 余量」与本工具的 `highlight_flight` 不可直接比：
R2 只算飞行 tick，本工具把落点停驻也算在同一类里。A 的同流消融可以回答这单帧停驻
有多少来自 viewer 插值（本 note 不下结论）。

## 5. 为什么 R2 旧比例不能套给 main 2Hz

R2（RECORD.md，分支 `c1-trajectory-morphology/2026-10-29`，R2 节）的 12 选窗口径：

> 静止总占比 **25.7%**；构成 `carrier_hold 44.6% + carrier_slow 18.9% + pass tick 余量 14.6%
> + loose_static 13.5% + 死球系 8.4%`（0.2s 采样帧、<0.5 m/s、逐窗不跨场拼接）。

同一页的验收摘要又写「carrier 62% / loose 23% / 死球系 12% / **pass ~0**」——
与上面表格的 `pass tick 余量 14.6%` **不一致**（R2 笔记内部记录冲突，引用时须标明用哪一行）。

本树的两个口径：

| 类别 | R2 旧（12 选窗，旧树） | main frozen（24 窗） | main active（465 窗） |
|---|---:|---:|---:|
| carrier 系 | 63.5%（hold+slow） | 51.4%（hold+dribble） | 59.1%（hold+dribble） |
| highlight/pass | 14.6% | 15.3% | 23.9% |
| loose | 13.5% | 30.5% | 14.3% |
| 死球系 | 8.4% | 2.8% | 2.8% |
| **总球静止** | **25.7%** | **21.6%** | **11.7%** |

三个不可跨越的差异：
1. **引擎树不同**：R2 在 R6 前（1Hz 决策、不同移动层）；本树是 main 2Hz。
2. **窗口集不同**：R2 是 seed42 的 12 个盲测选窗；本 note 是 A frozen 24 窗 / 宽扫 465 窗。
3. **类别定义不同**：`pass tick 余量` vs `highlight_flight`（后者含落点单帧停驻）。

⇒ **R2 的 25.7% 与类别比例都不能当 main 的当前值**；本 note 的 21.6%（frozen）/ 11.7%（active）
是本次复算。R2 的 carrier 系 ~63% 与本树 51–59% 同量级，说明「carrier 是主源」这一**排序**
稳定；但具体份额与 loose/highlight 的分配随窗口移动，不能照抄。

## 6. 交叉核对与已知局限

- **同尺子上的真实对照**（全部只用原始球帧，`ballFill == null`）：
  - frozen：engine 21.6% vs real 2.15% = **10.0×**
  - 宽扫 active（Metrica 2 场）：11.7% vs 4.5% = **2.6×**
  - 宽扫 all（Metrica 2 场，476 窗）：16.5% vs **4.3%** = **3.8×**
  ⇒ **历史 10× 在 frozen 锚点上成立，但不是跨窗口常数**：frozen/active/all 分别 10.0/2.6/3.8×，
  方向不变（引擎始终更静止）。差异来自数据集/锚点：frozen real 20 个 SkillCorner 窗
  ballStatic 2.38%、4 个 Metrica 窗 1.04%；宽扫 active Metrica 107 窗 4.5%。
- ⚠️ **不要用补全球帧算 ballStatic**：Metrica 约 40% 帧带 `ballFill`；算进来会把 all-window
  real 抬到 ~15.5%，制造「无差」假象。`notes/motion-census-diagnostics.json` 记录：
  real 476 窗里 97 个球程 <30m，但只有 35 个有原始球步（均值 18.9%）；其余是补全帧，无球指标。
  引擎 1125 窗球程最小 66.2m，没有等价死球窗。
- 真实 frozen 24 窗 = 4 Metrica + 20 SkillCorner；SkillCorner 的 ballStatic 2.38%、
  Metrica 1.04%（本 note 的 `engineWindows`/`realWindows` 可按 framesKey 分组复算）。
  宽扫 active 的 Metrica 107 窗均值 4.5%——**锚点/数据集选择能把 real 的 ballStatic 从 1% 拉到 4.5%**。
- `carrier_hold` 的时间权重 22–28% ≠ `CARRIER_HOLD_PP=45`：45 是每拍抽样概率，不是时间占比。
- `restart_dead` 的静止率很高（57–81%）但时间权重很小（0.5–1.3%）：引擎重开很快。
- 球速由 5Hz 采样；真实 tracking 的平滑会压低高速度尾部，但本 note 的引擎结论只在
  同帧口径内使用。
- 本分解**没有**区分「真实控球」与「控球代理」；它读的是引擎事件状态，不是真实比赛语义。

## 7. 复现

```bash
# 主口径（A frozen engine + R7i real 同锚点；窗口表存档在 notes/r7i-windows.json）
node tools/visual-review/motion-census.mjs viewer/engine.wasm \
  --windows openspec/changes/p155-measurement-instrument/notes/r7i-windows.json \
  --out /tmp/mc-frozen.json
# 宽扫 active
node tools/visual-review/motion-census.mjs viewer/engine.wasm \
  --seeds 42,1,7,99,123 --active-only --out /tmp/mc-active.json
```
