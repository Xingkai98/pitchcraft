# C1/sub-tick 可行性原型（2026-10-28）

> **性质**：throwaway 可行性探测，不是最终实现。分支 `c1-subtick-prototype/2026-10-28`
> （base = `0cb4ae5`，= `feat/in-box-shot-priority/2026-10-28` 的 R4 终态；引擎在本分支**未合入**任何主分支）。
> **纪律**：L1/golden 红是预期，本原型**不做带拟合**——只回答「提高决策节拍后，球程能到多少、
> 事件混合同时守到什么程度、耦合是否解除」。
>
> 动机（RECORD R4 的结构结论）：剩余可判别线索 = 球的世界空间行进量（引擎 67–110 vs 真实
> 129–194 m/24s 盲测窗，全语料 77.5 vs 107.3）；8 个事件层常数机制全部撞 L1 体量带
> （球程与射门/抢断反向耦合）。最后一条未探的路 = **事件层节拍重构（C1/sub-tick）**。

---

## 0. 结论（可拍板的一段）

1. **节拍能抬球程，但抬不满。** 事件锚 24s 口径：base 77.5 → **D2（2Hz 决策密度）96.3（+24%）**、
   **D3（3Hz）101.5（+31%）**；真实全语料 107.3。帧口径（0.2s 采样、12s 窗）：43.5 → 53.0/54.4
   （真实 60.7）。**盲测包同窗口径（12 个 24s 窗）：71.5 → 107.7/107.9（真实 164.6，0.65–0.66×，
   逐窗仍无重叠）**。快段首次接近真实（D3 帧口径 39.6 vs 真实 40.6，0.97×）；慢段在 D2 达标
   （19.6 vs 20.1），D3 反而回落（14.9）。
2. **事件混合不能同时进带；射门随球程同向上升。** base shot 39–47/90min → D2 53–58 → D3 51–64
   （真实锚 16.5，带 [14,29]）；增量**全是禁区内射门**（D2 seed42：61 脚中 54 在禁区；base：47 中 35）。
   斜率 ≈ **+1 脚射门 / +1 m 球程（24s 口径）**。抢断 14–32、犯规 16–26（各自在带沿波动，未随球程
   系统性补偿）；传球成功率 0.808–0.831（S/D2l 部分种子进带，D2/D3 不稳健）。
3. **可行性裁决：提高决策节拍没有解除「球程↔事件混合」耦合——它把墙平移了约 +25% 球程，同时把
   射门推得更高。** 机制上没有新自由度：射门/int-box 优先级是**每机会**掷定（机会率按秒保持），
   带球推进率↑ ⇒ 禁区停留时间↑ ⇒ 掷定次数↑。L1 量级复核见 §5。
4. **一个非对称收益（与 carrier 密度无关）**：C3「传球飞行填满一拍」的填充时长原为 0.95s，
   2Hz 下按 tick 缩到 0.475s ⇒ 每次传球占用的死时间减半 ⇒ **传球量 785 → 900–980/90min
   （接近真实 ~1100）**，L1 传球成功率由红转绿（2Hz/D2l：`l1_pass_completion_rate` ok）。
   这是「S 档（carrier 秒语义保持）单独也出现」的效应，明确归因于填充语义而非带球密度。
5. **方向实验（D2l：横向带球）** 把前向推进压回基线（0.945 m/s），球程只 +0.6m/24s，射门 34–42
   （比 S 少约 6 脚）——耦合对方向**不是零敏感，但也没有解除**（仍 ~0.5–1 脚/米）。
6. **真实现不是「改 TICK_SECONDS」，而是一次全表重标定**：13 个 tick 常量 + 3 个 deadline 调制系数 +
   ~6 处函数内 tick 秒语义 + L1/ratchet/golden/observation/viewer 契约（爆炸半径见 §6）。
   其中射门带必须重锚、golden 必须重基线、L2 的 beat 间隙契约与 pass speed 契约需改口径；
   事件流体积 ×2（7.7MB → 15.7MB/90min）。

---

## 1. 方法（口径先行）

- **分支/构建**：本 worktree、本分支；wasm 一律**现构建**
  （`cargo build --target wasm32-unknown-unknown --release` → `viewer/engine.wasm`）。

| 配置 | TICK/TPF | 带球变体 | wasm sha256（前 8） | 备注 |
|---|---|---|---:|---|
| base（1Hz，C3+C5 树） | 1.0 / 1 | 原版 0.03/拍 | `61a5bc43` | = R2/R3 记录值；lib `3eea2084` |
| **S**（2Hz 秒语义保持） | 0.5 / 2 | 0.03×dt（1.575m/拍） | `4d0b4cfd` | 对照组：carrier 每秒位移不变 |
| **D2**（2Hz 决策密度） | 0.5 / 2 | 0.03/拍（被 5m/s 截到 2.5m） | `7ca08092` | **最终原型态 = 当前树** |
| **D2l**（2Hz 密度+横向） | 0.5 / 2 | 前向 0.015/拍 + 横向 ±0.012 | `e8cfc6f0` | 方向实验（前向速率压回基线） |
| **D3**（3Hz 决策密度） | 1/3 / 3 | 0.03/拍（截到 1.667m） | `c55393e9` | 3Hz 档 |

  ⚠️ wasm 文件哈希随注释行号变化（#104）：中途重建的同一行为构建哈希不同
  （如 D2 曾为 `d0920d90`/`0bd25272`），已用 seed42 事件口径读数逐位复核行为一致。
  ⚠️ L1 官方套件跑在**修正 deadline 系数之前**的 D2l 构建 `a6dfe936`（见 §5 口径注记）。

- **三套口径**（同一段代码，两侧同法）：
  1. **事件锚口径**：R4 `fast-ballprobe.mjs`（事件流 ball 锚点、整场 5400s、折 24s），seeds **42/7/23/11**。
  2. **帧口径**：`tools/visual-review/ball-travel.mjs`（`game.js` 0.2s 采样、12s 窗、逐窗算再均值），
     like-football 默认 5 seed 集 × 2250 窗；真实 = Metrica 2 场 953 窗。
  3. **盲测包同窗口径**：`replay-goal-loop/base/windows.json` 的 **12 个引擎窗（seeds 5…173，t0≈2700）**，
     0.2s 采样 + `smoothSamples:5`（`replay-blind-core` 同法），重算 `stats.ballPathM`；
     对照：包内真实 12 窗 136.5–192.6（均值 164.6），包内 base 引擎 59.2–92.0（均值 71.5）。
     ⚠️ 换流后同一时刻窗**不再「锚匹配」**，只当 12 个固定 24s 窗看；n=12 方差大（min 64–87，max 139–165）。
- **先看后量**：每档先渲 90s 轨迹图（seed 42，t∈[1800,1890]，左引擎/右真实 Metrica game1）：
  - base：长直折角网、红蓝按半场分区；真实 = 短弧回环。图 `traj-base.png`。
  - S/D2/D2l/D3：**长直段 + 硬折角全部仍在**；D2/D3 覆盖更满、线更密；
    90s 图上球（黄）两侧都几乎不可辨（本轮只读形态，不读球墨水量）。图 `traj-S.png` / `traj-D2-final.png` /
    `traj-D2l.png` / `traj-D3.png`（S/D2l 图为修正 deadline 系数前所渲，形态差异可忽略）。
  - 一句话：**视觉纹理问题（铁轨/折角）不会被拍频修好**——它由 0.5s 锚点间距和跨拍目标跳变决定，
    不是采样密度决定（与 R3 的“锚点几何固定每拍总转角”结论同源）。
- **静止占比的口径警告（本轮实测）**：`ball-travel` 的「静止」被 **carrier hold 抖动在 0.5 m/s 阈值
  上下摆动**主导（0.1s vs 0.2s 采样差 6pp；静止时间几乎全部落在「传球成功后的持球段」）⇒
  **不作为本轮证据**，只如实列数。真正的「球停」问题是 hold 占比（每拍 70%），拍频不改变它。

---

## 2. 重标清单（「正确重标」到底改了什么）

**原则**：物理速度（m/s）自动 ×TICK_SECONDS 不用动；**秒语义的 tick 数**一律 `秒数 × TPF`
（TPF = 1/TICK_SECONDS，本原型手工同步，真实现应 derive 并加编译期断言）。

| 位置 | 原值（1Hz） | 2Hz / 3Hz 处置 | 说明 |
|---|---|---|---|
| `TICK_SECONDS` | 1.0 | 0.5 / 0.3333 | + `TPF` 常量 |
| `LOOSE_MAX_TICKS` | 2 | ×TPF | 松散球滚动时长 |
| `SHOT_DRIVE_MAX_TICKS` | 8 | ×TPF | 推进相步数（步长 m/s 自动） |
| `SHOT_WINDOW_TICKS` | 2 | ×TPF | 起脚窗口 |
| `SHOT_COOLDOWN_TICKS` | 8 | ×TPF | 射门冷却（赔率分子分母同比例，语义不变） |
| `CORNER_SETUP_MIN_TICKS` / `TRANSITION_TICKS` | 8 / 4 | ×TPF | 准备期 / 转换窗 |
| `LIVENESS_STAGE_{1,2,3}_TICKS` | 2/4/7 | ×TPF | 停滞三档（秒） |
| `LIVENESS_STAGE_DEADLINE` | [1,2,3] | ×TPF | 停滞压缩 |
| `BASE/MIN/MAX_ACTION_DEADLINE_TICKS` | 2/2/12 | ×TPF | 决策节拍的主体 |
| `GK_DEADLINE_BONUS_TICKS` | 3 | ×TPF | 门将放宽 |
| `DANGER_URGENCY / PRESSURE_URGENCY / ESCAPE_BONUS` | 4/3/5 | **×TPF** | ⚠ 初版漏了这三个：它们是**以 tick 计**的 deadline 调制，不 scale 会让安全局面 deadline 变短、决策次数虚增（本轮自查发现并修正） |
| `TACKLE_COOLDOWN / CONTACT_PAIR_COOLDOWN / PRESSURE_STATE_HOLD / FOUL_MIN_GAP` | 4/6/8/11 | ×TPF | 冷却族 |
| 进球庆祝 `remaining: 2` | 2 | ×TPF | 死球计时 |
| `tick_filling_flight` 的 `0.95` | 0.95s | **0.95 × TICK_SECONDS** | ⚠ 见 §4.2：这是「填满一拍」的语义，改法有两种，选哪种直接决定传球量 |
| `carrier_move` 抖动幅度 ±0.01 | ±0.01/拍 | **×TICK_SECONDS** | 不 scale = 抖动速度随拍频上升 → 假墨水（E2 教训） |
| `advance_loose` 球速阻尼 ×0.5/拍 | 0.5/拍 | **0.5^TICK_SECONDS** | 保持每秒衰减 |
| `formation_target` 个体相位用 `ticks_since…` | 按秒 | **×TICK_SECONDS** | 原代码把 tick 当秒用 |
| `shot_hazard_hits` 的 window | 1.0 | **TICK_SECONDS** | 起脚窗口内每 tick 掷一次；不 scale = 每窗口提交概率翻倍 |
| `open_play_shot_engage_hits` 的 window | 1.0 | 保持 | 每**机会**掷一次；机会率按秒保持 |
| carrier 带球步进 0.03（x 归一化） | 3.15m/拍 | **决策密度：不动**（被 `CARRIER_SPEED_MS×dt` 截流）| 本原型的主杠杆；S 档改为 ×dt 作对照 |
| viewer `interpretBeat` 的 `t1 = t0 + 1` | 硬编码 1s | **`t0 + config.interpretation.tickSeconds`** | ⚠ 不改 = 相邻拍锚点交错、帧口径全污染（首轮实测静止 51.8% 假读数） |

**填拍语义二选一（本原型选 A，需在真实现里重新拍板）**：
A. **fill-to-tick**（0.95×dt）：保持「每个 tick 内无死等」的原意；代价 = 传球飞行秒数减半
（12m 传球从 ~0.95s 变 ~0.475s，显示球速 ~2×），并派生 §6 的短传速度契约问题。
B. **fill-to-second**（保持 0.95s，跨 2 拍）：传球量/成功率回落到基线水平，但球程增益只剩带球部分。

---

## 3. 结果

### 3.1 球程（三口径，逐配置）

| 配置 | 事件锚 24s（4 seed 均值） | 帧口径 12s：总/快/慢/静止% | 盲测包同窗 24s（均值，min–max） | 短传违例/场 |
|---|---:|---|---|---:|
| **base 1Hz** | **77.5** | 43.5 / 26.6 / 16.9 / 22.8% | 71.5（59.2–92.0） | 0 |
| S 2Hz 秒保持 | 87.2 | 47.4 / 31.8 / 15.6 / 21.5% | 94.4（65.2–164.5） | 59 |
| **D2 2Hz 密度** | **96.3** | **53.0 / 33.4 / 19.6 / 24.0%** | **107.7（86.7–139.4）** | 53 |
| D2l 2Hz 横向 | 88.1 | 48.0 / 32.3 / 15.7 / 22.1% | 95.6（64.2–142.9） | 48 |
| **D3 3Hz 密度** | **101.5** | **54.4 / 39.6 / 14.9 / 31.2%** | **107.9（82.5–140.7）** | 21 |
| **真实** | **107.3**（多滞后 0.2s，全语料） | **60.7 / 40.6 / 20.1 / 15.6%**（Metrica 2 场） | **164.6（136.5–192.6）** | — |

读法：
- **全语料事件口径**：D3 到真实的 0.95×；**盲测包同窗口径仍只有 0.65×**——两套口径的真实锚差 1.5×，
  原因见 R4 注记（盲测窗是活跃段选窗）。裁决时不要混用。
- **快段**（传球/射门）：S +20%（传球量效应）、D2 +26%、D3 **+49%**（39.6 = 真实 0.97×）。
- **慢段**（带球/滚球）：D2 到真实 0.97×（带球密度的直接结果）；D3 回落到 0.74×——
  3Hz 下带球被 `max_step` 截得更碎 + 静止占比上升，慢段反而被吃掉。
- **静止%**：口径警告见 §1——hold 抖动主导，不解读；hold 占比（每拍 70%）不随拍频变化。

### 3.2 事件混合（per 90min，4 seeds，事件锚口径）

| 配置 | pass | shot（带 [14,29]） | tackle（带 [24,50]） | foul（带 [16,30]） | passSucc（带 [.82,.90]） |
|---|---:|---:|---:|---:|---:|
| base 1Hz | 785–812 | 39–47 | 14–27 | 21–28 | .810–.828 |
| S 2Hz | 936–965 | 42–48 | 22–28 | 20–25 | .810–.831 |
| D2 2Hz | 902–932 | **53–58** | 14–28 | 17–24 | .808–.825 |
| D2l 2Hz | 929–980 | **34–42** | 15–32 | 17–25 | .808–.843 |
| D3 3Hz | 953–973 | **51–64** | 20–32 | 16–26 | .809–.826 |
| 真实锚 | ~1100（R4 E8：1110–1137） | 16.5 | ~35 | ~22 | .82–.90 |

- **射门是唯一随球程系统性恶化的带**：base 已超带（39–47 vs ≤29，这是 R4 之前就存在的校准债），
  sub-tick 在其上再加 +10–17。
- 传球量/成功率向真实移动（S 即出现，见 §4.2）；抢断/犯规在带沿振荡（与 R4「贴着带沿站」一致）。
- D2l（横向带球）是唯一让射门回到 34–42 的档位，代价是球程只 +0.6m/24s。

### 3.3 射门增量来源（实测分解）

`shotbuckets.mjs`（seed 42/7）：D2 = 61/62 脚，其中 **54/52 在禁区**（≤16.5m），禁区弧 7/7，远射 0/3，
头球 8/5；base = 47/44 脚，禁区 **35/39**。⇒ 增量 ≈ 全是**禁区内射门**，与「带球推进率↑ → 禁区停留↑
→ `OPEN_BOX_SHOT_P`（每机会 0.30）与射门推进 hazard 掷定次数↑」的链路一致。
（**注记**：这是分桶归因 + S/D2/D2l 对比的证据；未做 `opportunity_tally` 级归因
——wasm 未导出 tally，`exec_shoot` vs engage 的份额未单独核。）

---

## 4. 耦合分析

### 4.1 「球程 ↔ 射门」的斜率与方向

同轮同口径配对：S（87.2, 44.5）→ D2（96.3, 56.5）= **+9.1m / +12.0 脚 ≈ 1.3 脚/米**；
D2l（88.1, 38）→ D2 = **+8.2m / +18.5 脚 ≈ 2.3 脚/米**；
D2 → D3（+5.2m, +2 脚）≈ 0.4 脚/米。跨度 0.4–2.3，方向一致：**球程每涨 1m/24s，射门涨约 0.4–2 脚**
（样本小、RNG 换流方差大，但四个种子方向一致）。

⇒ 与 R4 的结论同型：**L1 射门带是在「低球程」基线上标定的**；sub-tick 不提供新的自由度来打破它。
唯一的非速度杠杆（D2l 横向）只把斜率压到 ~0.5 脚/米，没有归零。

### 4.2 传球量上升的归因（S 档单独复现）

S 档 carrier 每秒位移与原版相同（步进 ×dt），唯一变化是填拍时长 0.95→0.475s：
传球量 785–812 → **936–965（+20%）**，passSucc .810–.828 → .810–.831。
机制：一次传球在引擎里占住高亮 ≥1 拍（`t_end` 后到下一拍边界 finalize），填充时长减半 ⇒
每脚传球少占 ~0.5s 开放比赛时间 ⇒ 机会点变多。修正 deadline 调制系数（§2）前后 S 档传球只差 −2%，
**排除「deadline 漏洞」解释**。
这解释了 D2/D3 的传球量也停在 900–980 而不是基线水平。

### 4.3 3Hz 的边际收益

D2→D3：事件球程 +5.2m（+5%）、快段帧口径 33.4→39.6（+19%）、但慢段 19.6→14.9、静止 24→31%、
射门 56.5→58.5、passSucc 均值持平。**3Hz 不是 2Hz 的线性外推**：拍越细，带球的 `max_step` 截流越强
（1.667m/拍），而 hold 占比不变 ⇒ 带球慢段被压缩、快段（多出来的传球）占主导。

---

## 5. L1 官方裁决（口径注记：跑在 **2Hz/D2l 修正前**构建 `a6dfe936` 上；9 tests）

- **通关**：`l1_pass_completion_rate`（**基线红 → 绿**）、`l1_fouls_and_cards`、
  `p13_side_effect_snapshot`、`p31_frequency_5min_directional`、`l3_home_away_goal_calibration`。
- **判红 4 项**：
  - `l1_shot_result_distributions`：禁区内 goal 0.064 ∉ [0.10,0.20]（射门多而转化低）。
  - `l3_shot_ratios`：射正率 **0.494** ∉ [0.28,0.39]（shots=8289 goals=521 conv=0.0629）。
  - `l1_tackle_dilution_and_slot_mix`：**场均角球 12.84** ∉ [1,7]——⚠ 该带是**护栏带不是真实拟合带**
    （真实 ~10.3；12.84 比带心更接近真实，按「护栏带 ≠ 真实拟合带」记录，不当退化读）。
  - `l1_home_away_goal_asymmetry`：主队转化 0.06739 ≤ 客队 0.06828（方向反向）——该门已知无分辨力
    （见记忆「主场优势门没有分辨力」）。
- 对照 RECORD R3：base 的 L1 是 **5 红**（含 pass_completion / shot_result / tackle_dilution /
  l3_shot_ratios 等）。⇒ 2Hz 下**红集从 5 缩到 4**（传球成功率修好），但**射门三项仍是红且指标在恶化**
  （射正率/禁区转化）。这与 §3.2 的非官方读数一致。
- **未跑**：ratchet（引擎改了必动）、benchmark-baseline 指纹哨兵、p18/p16 产物门（需 source commit）、
  盲测渲染/裁判（预算外；画面结论只到轨迹图目读）。

---

## 6. 爆炸半径清单（真实现要动什么）

### 6.1 Rust 默认套件（本分支 **2Hz/D2l 树、修正 deadline 系数前**实测：`cargo test --release --no-fail-fast`）
**195 pass / 6 fail（lib）+ p124 6 / p15 5 / p16 2 / p17b 2 / realism 默认 3 / L1 4**。
分类（★ = 基线已知红，其余为 sub-tick 新增）：

1. **契约常量断言**（直接断言 1Hz 数值）：`p31_liveness_profile_three_stages_monotone`（断言 2/4/7）。★应改为按 TPF 断言。
2. **时间网格契约**：`l2_cross_event_invariants`（相邻 beat 间隙 ∈ {1,2}s）、`l2_sent_off_kickoff_seeds`
   （顺手：seed 33 不再产生红牌 → 定向 seed 失效）、`realism::gm_canary_seeds`（golden 比分漂移 1→4）。
3. **golden / 流哈希**：`gm_canary_seeds`、`p15 recorder_on_and_off_reproduce_the_golden_canary_stream`
   （“seed 1 正式路径偏离 golden 基线”）——所有 golden fixture 需重基线（ACCEPT_GOLDEN）。
4. **统计闸锚在 1Hz 采样上**：`p124` ×6（intent 特征 AUC；P16 基线 0.764 复现不了，实测 0.546）、
   `p16` ×2（rust 形状与 JS 标尺同域、phaseability）、`p17b` ×2（零时长争抢占比 53.4% 等）。
   这些是「每拍采样」的统计量，节拍一变全部重锚。
5. **P15 观测层**：×5——除 golden 外，还有事件下标/间隙不变量的样本形态漂移（`gaps=0` 等）。
6. **既有行为红**：`p31_liveness_stages_reachable_and_pulls_back` / `p31_meaningful_action_resets_counter`
   （停滞上限 58–59 tick vs 三档 14）——★基线同族红，sub-tick 未修好；`observation::tests` ×2 ★。
7. **速度契约（新发现）**：L2 `pass speed ∈ [10,25)` 被 **2.5–4.5m 短传**破（seed 1 每场：
   S 59 / D2 53 / D2l 48 / D3 21 例；**base 918c773 复测 = 0 例**，且 R2 记录 1Hz+C3 的 L2 为绿
   ⇒ 1Hz 下无短传）。短传本身是 2Hz 动力学的新产物（fill 0.475s ⇒ dist/0.475 < 10 m/s）；
   真实现须决定：放宽契约 / 不给短传做填充 / fill-to-second。

### 6.2 Viewer
- `interpretBeat` 硬编码 `t1=t0+1`（**已改为 config `tickSeconds`，必须与引擎同步**）；
  不改 = 相邻拍锚点交错，帧口径假读数（首轮实测静止 51.8% 伪影）。
- viewer 单测：398 项中 **3 红**——`beat: movers 铺满整拍 [t,t+1]` ×2、`buildTimeline 跨 beat 连续`。
- **cache-busting 链**：改 config 值必须同时 bump `index.html` 的 `app.js?v=`、`app.js` 的
  `config.js?v=`/`game.js?v=`、以及子模块 import 串；本轮实测该改动会打断
  `debug.test.js` 的模块实例假设（裸 `config.js` vs `?v=` 是两个实例）——已按 `app.test.js` 的
  「从源码抠说明符」法修复。真实现需要一条 `TICK_SECONDS → viewer config` 的同步机制（构建注入）。

### 6.3 数据/协议/性能
- 事件流：seed42 全场 **6236 → 11744 events（×1.88）、beats ×2.01、JSON 7.7MB → 15.7MB**；
  P16 观测快照（每拍一条）×2–3。
- `observation` 导出的 `expected_ticks` 会自适应，但报告/产物门（p16/p17a/p17b/p124 report）里的
  `tick_seconds` 字段与全部统计闸需重出。
- ratchet 22 项、like-football/panel 全部需要在新节拍下重生成基线（引擎行为逐位改变）。

---

## 7. 边界与没做的事（如实）

- **没有跑盲测渲染/裁判**（预算是原型）；画面结论只有 90s 轨迹图目读：纹理问题不会因拍频改善。
- 盲测包同窗口径 = **固定 12 窗**（不再锚匹配），n 小；两口径真实锚（107.3 全语料 vs 164.6 盲测窗）
  差 1.5×，裁决时必须带口径。
- 射门增量的归因到「禁区分桶 + 三档对比」为止，未做 tally 级归因。
- **静止占比**口径被 hold 抖动污染（0.1s/0.2s 采样差 6pp），只列数不解读。
- 未尝试任何「恢复事件带」的带拟合（按纪律）；§5 的红是**如实读数**，不是要修的目标。
- 3Hz 只跑了一档 TPF=3；未扫 4Hz（边际收益在 D2→D3 已转负：慢段↓、静止↑、射门↑）。

---

## 8. 复现

```bash
# 构建（本分支当前态 = D2, 2Hz）
(cd engine && cargo build --target wasm32-unknown-unknown --release \
  && cp target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/engine.wasm)

# 三口径
node .scratch/notes/goal-loop-r4/fast-ballprobe.mjs 42,7,23,11                  # 事件锚 24s
node tools/visual-review/ball-travel.mjs viewer/engine.wasm 5 12               # 帧口径 12s
node .scratch/notes/c1-subtick-prototype-2026-10-28/probes/packet-windows.mjs  # 盲测包同窗
node .scratch/notes/c1-subtick-prototype-2026-10-28/probes/shotbuckets.mjs     # 射门分桶
node .scratch/notes/c1-subtick-prototype-2026-10-28/probes/shortpass.mjs       # 短传速度违例

# 轨迹图（先看后量）
node tools/visual-review/trajectory.mjs viewer/engine.wasm /tmp/traj.png 42 1800 90

# 档位扫描（S/D2/D2l/D3 的补丁+构建+三口径，约 20 min）
python3 .scratch/notes/c1-subtick-prototype-2026-10-28/probes/driver.py

# 地板
(cd engine && cargo test --release --no-fail-fast)          # 日志：cargo-default-suite-2hz.log
(cd engine && cargo test --release --test realism -- --ignored)  # 日志：l1-2hz.log
(cd viewer && node --test *.test.js)
```

原始日志：`tiers.log`（四档三口径）、`l1-2hz.log`、`cargo-default-suite-2hz.log`（同目录）。
