# 候选任务书：站位表压缩轴（`default_lineup` 的 `base.x`）· 2026-10-14

**流程**：`adversarial-explore` ② 候选层。你是**候选 agent**，一条轴、一个 worktree。
对抗镜（画面盲测 + 判据镜）由主 session 另派**零上下文** agent——**你不要自己建对抗镜**，
也不要 push / merge / 开 PR。

---

## 0. 一句话任务

`default_lineup()` 的静态 x 站位表（`engine/src/lib.rs:522`）是「机械分边」四轴全否后
**唯一剩下的非 rail 入口**。把它按一个旋钮 `c` 向中线压缩（门将豁免），扫 ≥4 个点，
回答：**分边/纵深能不能落进真实带？代价是什么（L1 9 带 / spacing / 画面 / 机制）？**

## 0.5 主 session 先看的图（step ① 必须的「先看」，不是指标）

- `base-traj-seed42.png`（左引擎 / 右真实 Metrica）、`base-sheet-seed42.png`（3 窗 × 6 帧，上引擎下真实）
- **看到的两句话**：
  1. 引擎两队的轨迹是**两条颜色分离的竖带**（红占左、蓝占右，互不越界）；真实是**两色纠缠成一团**
     （轨迹弧线互相穿插、终点 id 17/18/19/20/21 与红色混在同一片）。
  2. 引擎球员**摊满全场**（后卫钉在自家禁区、前锋钉在前场 → 一队 x 跨 ~50 m）；真实**20 人挤在球周围
     一小团**（多窗都是这个形态，不是单窗巧合）。

⇒ 这两个形态差**都是静态站位表造的**：表把同一队的人按 x 摊开 0.14→0.62（47 m），
且与球无关。**本轴就是冲这个去的**。

## 1. 环境与口径（本仓纪律：口径不全 = 读数不可比）

| 项 | 值 |
|---|---|
| worktree | `/tmp/table-axis`（分支 `table-ball-relative/2026-10-13`，**= origin/main `2a6473b`，tracked pristine**） |
| 已备 | `node_modules` → 主仓库 symlink；`viewer/data/real-game-{1,2}.json`（Metrica 帧，gitignored）已拷入 |
| 基线指纹（主 session 已建，核对用） | `engine/src/lib.rs` sha16 = `75190e51f5b28876`；`viewer/engine.wasm` sha16 = `b0bc479678af53aa` |
| **wasm** | 每点**从本 worktree 源码重建**（`cargo build --target wasm32-unknown-unknown --release`，`PATH=$HOME/.cargo/bin:$PATH`），**不许拷旧产物** |
| 门禁 | **一律不改**：`DUR=5400`/`STEP=2.5`/默认 seed 集/detector 阈值/L1 统计带/`tools/*.test.mjs` |
| 面板 | `like-football`（距离 + 9 行）、L1 **逐带实测值**（不是只报 9/9）、`spacing-sweep`、轨迹 png（**多窗**） |

**真实锚（committed 基线 `viewer/data/benchmark-baseline.json`）**——注意两个数据集差 1.4–1.6×，
**真实是带不是点**（primary = skillcorner）：

| 量 | skillcorner | metrica | 引擎基线 |
|---|---|---|---|
| **分边 gap** | **5.24** | **8.32** | 19.20 |
| 纵深 hd / ad | 18.31 / 18.45 | 25.94 / 26.79 | 39.10 / 36.67 |
| 紧凑度 spread | 12.76 | 15.24 | 20.83 |
| 宽度 width | 35.96 | 39.58 | 49.73 |
| 球距 ballDist | 14.97 | 18.36 | 17.93 |

## 2. 轴定义

`default_lineup()` 的 18 名外场球员（门将 id 0 / 21 **豁免**，必须留在门线）：

```
x' = 0.5 + (x - 0.5) * c          // c ∈ (0, 1]，基线 c = 1.0
```

**变体 C（主口径，自洽）**：同时把 `center0` 改成**新表的队均**——
`FORM_CENTER_HOME/AWAY`（`:3417-3418`）本来就是 `default_lineup` 队均的**硬编码副本**
（注释自己写着「default_lineup 基准」）。表中立时 `center0 = 0.5 ∓ 0.142c`。
理由：`block_tx = block_cx + (base.0 − center0)·FORM_SPREAD_X`（`:3482`）里
`(base.0 − center0)` 的**语义**是「该球员离本方块心的偏差」，只有 center0 = 队均时才成立。

**变体 A（对照，只跑一个点）**：压缩表、`FORM_CENTER_*` 保持 0.358/0.642 不动。
二者不等价——A 会让 `(base.0 − center0)` 凭空多出一个**全队同向推力** `0.8·0.284·(1−c)`。
若你实测 A/C 差异显著，**在报告里写明**（这是「常数副本」这个设计债的量化代价）。

**只动这两处**：`default_lineup()` 的表 + `center0` 的取法。其余常量一律不动。

## 3. 主 session 的解析模型（**请独立复核，我很可能算错**——C1 就在这点上错过一次）

设 `Δb = base_home − base_away`（队均）、`Δc = center_home − center_away`，`T = FORM_TRACK_X = 0.5`、
`S = FORM_SPREAD_X = 0.8`、`M = FORM_MIX_X = 0.5`。逐球员目标
`tx2 = (1−M)·tx + M·block_tx`，`tx = base.0 + shift + attack_dir·press`，
`block_tx = center0 + T(ball−center0) + ±offset + S(base.0−center0) + ix`。

- `press` 与 `offset` 在一队攻一队守时**对两队的绝对 x 同向** ⇒ 在**差**里抵消；
  `shift` 也同向抵消 ⇒ **与球无关**。⇒ 队均目标间距（x）：

```
间距_target = (1−M)·Δb + M·[Δc·(1−T) + S·(Δb − Δc)]
```

- **变体 C**（`Δb = Δc = −0.284c`）⇒ `间距 = −0.213c` ⇒ **×105 = 22.37·c m**
- **变体 A**（`Δb = −0.284c`, `Δc = −0.284`，取绝对值）⇒ `间距 = 4.47 + 26.84·(1−c)`…（自己复核符号）
- 基线实测/目标 = 19.20/22.37 = **0.858** ⇒ **预测实测 gap ≈ 19.2·c**
- 纵深：外场 `base.x` 的 **q10–q90 静态跨距** = 0.444（46.6 m）⇒ 压缩后 `= 0.444c`，
  基线实测/静态 = 39.10/46.6 = 0.839 ⇒ **预测 hd ≈ 39.1·c**（⚠️ 0.839 是**拟合比值**，
  别当定值外推——`fitted-ratio-constant-only-holds-in-scan-region`；每点**实测**，不要只算）
- **`width`（y）预测不变**（49.7）——本轴不碰 y ⇒ **这是个内置对照**，若 width 动了，说明你改错了东西

## 4. 预注册（**先写 `PREDICTION.md` 再跑第二点**）

预测（变体 C）：

| c | gap 预测 | hd 预测 |
|---|---|---|
| **1.00** | 19.2（实测锚） | 39.1（实测锚） |
| 0.70 | 13.4 | 27.3 |
| 0.55 | 10.6 | 21.5 |
| 0.45 | 8.6  | 17.6 |
| 0.30 | 5.8  | 11.7 |

**两个真实带不可能同时满足**（gap 带 [5.24, 8.32] ⇒ c ∈ [0.27, 0.43]；hd 带 [18.31, 25.94] ⇒ c ∈ [0.47, 0.67]，
**交集为空**）。⇒ **预注册的结论形态**：本轴能吃掉「静态 29.8 m 表间距」这一半，
c* ≈ 0.45 落点「两根杆各擦到对面数据集的带沿、但都不严格在带内」。
**若你实测出现「两根杆同时稳落带内」⇒ 我的线性模型错了，照实报。**

**反证条件（我承诺照实报，你也一样）**：
1. gap **不随 c 线性**（如 0.45 处仍 > 11 m）⇒ 模型错（clamp / 防线 push / 位置滞后在起作用）
2. `width` 随 c 变 ⇒ 改动溢出到 y 轴，实现有 bug
3. L1 在 c=0.45 破带 ⇒ **报代价，不许悄悄放宽带**；带破了就是破了
4. `spacing-sweep` 出现同队重叠 ⇒ 压缩把人挤到 2.14 m 内，报读数
5. 盲测图判「比基线更不像足球」⇒ **数字变好、画面变差**（本仓飞轮三版的老坑）

## 5. 机制判据（★ 本轴最容易「数字对、机制错」的地方）

**分边小有两条互不相干的机制**：
- (a) **球相对紧凑**（真实）：两队块心都跟着球走 ⇒ 球在哪两队就在哪 ⇒ 块心自然靠得近；
- (b) **静态中线停车**（退化）：两队都钉在中线附近 ⇒ 块心也靠得近。**本轴按构造实现的是 (b)。**

⇒ 必须给**机制探针**（`viewer/zz_table_probe.mjs`，用完即删）：

1. **跟球斜率**：逐帧 `corr/slope(队均 x , ball.x)`，**引擎各 c 与真实帧（`viewer/data/real-game-*.json`）
   用同一段代码算**。解析预测：引擎斜率 **不变**（= `(1−M)·0.06 + M·T = 0.28`，压缩只改 `base.x`）。
   若实测斜率不随 c 变而真实斜率显著更高 ⇒ **本轴治不了机制**，只能在报告里写「结构量进了带、机制没进」。
2. **分箱**：按 `ball.x` 分箱看队均 x（球在前场/后场时队在哪）。真实应整体跟随；停车式应几乎不动。
3. **初始状态副作用**：`ball_pos=(0.55,0.5)`、`carrier=10`（home 前锋，表里 x=0.62）。
   c 小时前锋基准被拉到 ~0.52 ⇒ **开局前若干 tick 与基线不同**（球在球员身后）。
   查开局 1–2 秒事件是否合理（别出现莫名其妙的第一个事件）。

## 6. 爆炸半径 / 必跑清单

`base`（`st.lineup[id]`）**只有两个读取点**：`formation_target`（`:3440`）与 `is_defender`（`:3434`，
用 `MatchState::new` 预排序的 4 人，**单调压缩下不变**——但你要验，别只信）。

- [ ] `cargo test` 全量 —— **预期会红一片**：`p15_behavior_observation` 把行为观察流锚到
      `tests/golden-v{MODEL_VERSION}/seed-*.json`（当前 `MODEL_VERSION = 8`，`lib.rs:238`）。
      **约定做法：`MODEL_VERSION 8→9` + 落 `tests/golden-v9/`，旧目录保留不覆盖**
      （见 `realism.rs:1230-1237` 的版本→目录表；p143r-v4 就是这么做的 7→8）。
      **逐个 red 判定：哪些是真被表改动影响（→ 合法重锚），哪些是你 bug。逐条写进报告。**
- [ ] L1 9 带（`cd engine && cargo test --test realism --release -- --ignored`）**逐带实测值**。
      已知最薄的余量：`禁区内进球占比 [0.72,0.92]`（余量 0.15%）、**主客方向**、`shot/tackle`（6.4%）、
      传球成功率下界 `0.82`（分母口径含发球重开）、犯规贴 16。
- [ ] `node tools/spacing-sweep.mjs`（CI 第 5 步，默认 8 seed）
- [ ] `node tools/benchmark-compare.mjs`（报告期）
- [ ] `node tools/visual-review/like-football.mjs viewer/engine.wasm`（距离 + 9 行，含 `disp/lat/mix` 三颗★）
- [ ] `cd viewer && node e2e-v2.mjs`（初始站位事件变了，看有没有 snap/断言）
- [ ] **轨迹图：多窗**（`trajectory.mjs` 多 `t0` + `contact-sheet.mjs`）——
      单窗是高方差判据（C3 判据镜实测跨窗波动 20×）

## 7. 交付物（落在 `.scratch/notes/p-table-compress-2026-10-14/`）

1. `PREDICTION.md`——**跑第二点之前**写（含：你的预测、反证条件、你对我 §3 模型的独立复核结论）
2. 读数表：每点 `{c, lib.rs sha16, wasm sha16, gap/hd/ad/spread/width/ballDist/disp/lat/mix/dir, 距离}`
3. `L1-<c>.txt`：9 带逐带值 + 与带沿的余量
4. 轨迹 png（≥3 窗）× c + 机制探针输出（斜率、分箱表）
5. `REPORT-table-c.md`：结论 + **你声称的因果机制**（供对抗镜打）+ 代价 + 反证结果 + 未知
6. 结束时 **tracked 文件 pristine（除轴本身改动）**、worktree 里不留探针残留

**别做的事**：别改门/带；别用主仓库那棵树跑实验（它不在 main）；别自己派对抗镜；
别把推测写成结论（本仓反复栽在 `conclusion-right-mechanism-wrong`——**「因为/原因是」也要能被核**）。
