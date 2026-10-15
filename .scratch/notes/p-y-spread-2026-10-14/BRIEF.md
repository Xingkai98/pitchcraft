# 候选任务书：y 轴 / 宽度轴（`FORM_SPREAD_Y`）· 2026-10-14

**流程**：`adversarial-explore` ② 候选层。你是**候选 agent**，一条轴、一个 worktree。
对抗镜（画面盲测 + 判据镜）由主 session 另派**零上下文** agent——**你不要自己建对抗镜**，
不要 push / merge / 开 PR。

---

## 0. 一句话任务

前五条轴（`FORM_TRACK_X` / `FORM_MIX_X` / `FORM_SPREAD_X` / `FORM_CENTER_*` / **站位表 x 压缩**）
全部死掉。**本轴换靶子**：不再攻「机械分边」（那条路的入口已被证明要么是 rail、要么结构性破门），
改攻**「太宽 / 太散」**——这是标尺里**第二大**的缺口，而且 **y 家族（`FORM_SPREAD_Y`/`FORM_TRACK_Y`/`FORM_MIX_Y`）
一条都没试过**。

**注意本轴与分边正交**（不解决用户一号抱怨）——如果它能进带而不破门，它是**第一条可落地的轴**，
意义是给后来者一个「可以安全动的量」；做不到就照实报。

## 0.5 主 session 先看的图（step ① 的「先看」，不是指标）

`base-traj-seed42.png`（左引擎 / 右真实，同一 90 s 窗）与 `base-sheet-seed42.png`（3 窗 × 6 帧）。**看到的一句话**：

> **引擎的人贴到两条边线、纵向铺满整个面板；真实的人挤在中路一条带上，上下各约两成是空的。**

零上下文盲测镜（C5 轮）独立量到的同一件事：**真实瞬时阵型 36×35 m（近各向同性），引擎基线 56×47 m**。

## 1. 环境与口径

| 项 | 值 |
|---|---|
| worktree | `/tmp/y-axis`（分支 `p-y-spread/2026-10-14`，**= origin/main `3db023f`，tracked pristine**） |
| 已备 | `node_modules` → 主仓库 symlink；`viewer/data/real-game-{1,2}.json`（Metrica 帧，gitignored）已拷入 |
| **wasm** | 每点**从本 worktree 源码重建**（`export PATH=$HOME/.cargo/bin:$PATH; cd engine && cargo build --target wasm32-unknown-unknown --release && cp target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/engine.wasm`），**不许拷旧产物** |
| 门禁 | **一律不改**：`DUR=5400`/`STEP=2.5`/默认 seed 集/detector 阈值/L1 统计带/`tools/*.test.mjs` |
| 面板 | `like-football`（距离 + 9 行）、L1 **逐带实测值**、`spacing-sweep`、轨迹 png（**多窗**）、机制探针 |

**真实锚（committed 基线 `viewer/data/benchmark-baseline.json`）**——**真实是带不是点**（两数据集差 1.2–1.6×）：

| 量 | skillcorner(primary) | metrica | 引擎基线 | 倍数 |
|---|---|---|---|---|
| **宽度 width** | **35.96** | **39.58** | **49.73** | 1.38× / 1.26× |
| **紧凑度 spread** | **12.76** | **15.24** | **20.83** | 1.63× / 1.37× |
| 纵深 hd / ad | 18.31 / 18.45 | 25.94 / 26.79 | 39.10 / 36.67 | 2.14× |
| 分边 gap | 5.24 | 8.32 | 19.20 | 3.67× |
| 球距 ballDist | 14.97 | 18.36 | 17.93 | 1.20× |
| 位移/窗 disp★ | 13.46 | — | 6.00 | 0.45× |
| 横向占比 lat★ | 0.43 | — | 0.38 | — |
| 混队度 mix★ | 0.80 | — | 0.80 | — |

## 2. 轴定义

**变体 P（主口径，最简解：一个常数）**：`engine/src/lib.rs:3415` 的 `FORM_SPREAD_Y: f64 = 1.3` → `S_Y`。

**变体 Q（对照，只跑一个点）**：压缩**站位表**的 y（`default_lineup()` 的门将除外 18 人：
`y' = 0.5 + (y−0.5)·c_y`），`FORM_SPREAD_Y` 不动。跑到与 P 某个点**等宽**的那一档（`c_y ≈ 0.77`），
用来对照「改常数」与「改表」哪个更干净（C5 证明改表会连带初始站位事件与 spacing 余量，代价更大）。

**只动这一处**（P 口径下）。其余常量一律不动。

## 3. 主 session 的解析模型（**请独立复核，我很可能算错**——C1/C5 都在这点上错过）

目标 y（`lib.rs:3471/3483/3485`）：

```
ty   = base.1 + (ball.1 − 0.5)·SIDE_SHIFT_FACTOR·0.6          // 旧式
blk  = 0.5 + (ball.1 − 0.5)·FORM_TRACK_Y + (base.1 − 0.5)·S_Y + iy
ty_f = ty·(1 − FORM_MIX_Y) + blk·FORM_MIX_Y                   // M_Y = 0.7
```

球的横向项在**队内跨距**里抵消（对全队是同一个平移）⇒ **队内 y 跨距只由站位表与系数决定**：

```
span(归一化) = 0.6·[(1 − M_Y) + M_Y·S_Y] = 0.6·(0.3 + 0.7·S_Y)
width(m) ≈ 68·span + iy 贡献(≈0.5 m)
```

| S_Y | width 预测 | 备注 |
|---|---|---|
| **1.3** | **49.7**（实测锚 49.73） | 基线 |
| 1.1 | 44.2 | |
| 0.95 | 39.9 | 真实带上沿附近 |
| **0.9** | **38.4** | **真实带内** |
| **0.85** | **37.0** | **真实带内** |
| 0.6 | 29.9 | 退化侧（窄走廊） |

⇒ 真实带 [35.96, 39.58] 对应 **S_Y ∈ [0.81, 0.94]**。
**预测：三点（0.95 / 0.9 / 0.85）连续落在带内或带沿**——与 C5 的「刀锋 headline」不同，本轴应有一条**成片**的可行窗。

**内置对照（若这两个动了，说明你改错了东西或模型错了）**：
- `hd`/`ad`（x 纵深）**预测不变**（39.10 / 36.67）——本轴不碰 x；
- `gap`（分边）**预测不变**（19.20）——本轴与分边正交。

## 4. 预注册（**先写 `PREDICTION.md` 再跑第二点**）

除上表外，预先写下：

1. **`spread`（紧凑度）会改善但到不了真实**：估 `20.83 → ~17.4`（真实 12.76，仍 1.36×）——
   均匀矩形近似 `spread ≈ 0.383·√(a²+b²)`，本轴只压 b（y），x 仍是 39 m。
2. **运动量有反向风险**：`lat`（横向占比，真实 0.43 / 基线 0.38 / C5 压缩后 0.32）**可能进一步下降**——
   目标 y 变窄 ⇒ 横向行程变小。**照实报，不要藏。**
3. **L1 应该是五条轴里最干净的**：射门/抢断是 x 主导的几何 ⇒ 预测破 ≤1 条。
   ⚠️ 但**角球 / 界外球是 y 相关的带**，最可能动，方向不定。
4. **spacing 门风险最高**：基线整场同队最小间距实测只剩 **2.137 m**（引擎自己的扫掠地板 2.14 m、
   detector 阈值 2.0），**离门只有 0.137 m（6.9%）**（C5 判据镜实测）。y 变窄会把**同车道**队友挤近
   ⇒ **每点都要跑 `spacing-sweep`**，破了照实报。
5. **退化方向**：`S_Y → 0` 仍有 **12.2 m** 残留宽度（旧式 `ty` 那 0.3 权重的表跨度），
   所以不会完全塌；但 `S_Y ≤ 0.6` 就是「全员一句中路窄走廊」——**必须配盲测图判**。

**反证条件（我承诺照实报，你也一样）**：
- `width` 不随 S_Y 线性变（如 0.9 处仍 > 42 m）⇒ 模型错（clamp / 位置滞后 / iy 在起作用）
- `hd`/`ad`/`gap` 随 S_Y 变 ⇒ 改动溢到 x 轴，实现有 bug
- L1 破 ≥3 条 ⇒ 「y 轴与事件层解耦」这个前提错，报代价
- 盲测图判「比基线更不像足球」⇒ 数字变好、画面变差

## 5. 爆炸半径 / 必跑清单

- [ ] `cargo test` 全量。**预期会红一片**——`p15_behavior_observation` 把行为观察流锚到
      `tests/golden-v{MODEL_VERSION}/seed-*.json`（当前 `MODEL_VERSION = 8`，`lib.rs:238`）。
      **本轮只报不改**（哪几条红、红的机制、重锚是否机械）；`MODEL_VERSION 8→9` + 落 `golden-v9`
      是**落地决策**，不在探索阶段做。逐个 red 判定「真被 y 影响」vs「你 bug」vs「fixture 硬编码旧表数值」。
- [ ] L1 9 带（`cd engine && cargo test --test realism --release -- --ignored`）**逐带实测值 + 余量**
- [ ] `node tools/spacing-sweep.mjs`（每点）
- [ ] `node tools/benchmark-compare.mjs`（报告期）
- [ ] `node tools/visual-review/like-football.mjs viewer/engine.wasm`（距离 + 9 行）
- [ ] `cd viewer && node e2e-v2.mjs`
- [ ] **轨迹图多窗**（`trajectory.mjs` 多 `t0` + `contact-sheet.mjs`）——单窗高方差
- [ ] **机制探针**：y 向的「球员到最近边线的距离分布」引擎各点 vs 真实帧（**同一段代码**），
      验证「窄在中路」而非「整体平移」。⚠️ 自写探针**按 `p.id` 取人**——`Game.players` 会**过滤已罚下者**，
      **下标 ≠ id**（C5 判据镜踩过）。

## 6. 交付物（落 `.scratch/notes/p-y-spread-2026-10-14/`）

1. `PREDICTION.md`（**跑第二点之前**写，含你对 §3 模型的独立复核）
2. 读数表：每点 `{S_Y, lib.rs sha16, wasm sha16, width/spread/hd/ad/gap/ballDist/disp/lat/mix/dir, 距离}`
3. `L1-<点>.txt`（9 带逐带值 + 余量）+ `cargo-<点>.txt`（红的名单与归类）
4. 轨迹 png（≥3 窗）× 点 + contact sheet + 机制探针输出
5. `REPORT-y-spread.md`：结论 + 你声称的因果机制 + 代价 + 反证结果 + 未知
6. 结束态：**tracked 文件 pristine（除轴本身那一处）**、探针全删

**别做的事**：别改门/带；别用主仓库那棵树跑实验（它不在 main）；别自己派对抗镜；
别把推测写成结论（本仓反复栽在 `conclusion-right-mechanism-wrong`）。
