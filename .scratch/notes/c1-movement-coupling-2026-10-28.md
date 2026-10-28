# C1 movement↔tackle/foul 耦合（2026-10-28，分支 `c1-movement-coupling/2026-10-28`）

> 起点 = `2732450`（C1 sub-tick：射门秒率重锚 + 2Hz fill-to-tick）。本轮唯一靶：
> **移动层提球程（carrier hold 70→45）时，抢断/犯规不跌破带**。
> 记录口径：所有引擎读数均为**本 worktree 现构建 wasm**；原生（native）读数与 wasm 读数
> **不可混用**（libm 舍入经 RNG 级联，见 §9.1.3），下文逐条标注来源。

## 0. 先看（trajectory）

`node tools/visual-review/trajectory.mjs viewer/engine.wasm <out.png> 42 1800 90`
（左=引擎，右=真实 Metrica game1；seed 42，t∈[1800,1890]s）。

- base：`base-traj.png`
- 终版（V1）：`v1-traj.png`
- **一句话读图（终版）**：引擎仍是**长直横向冲刺线**为主、两队分层（红上蓝下）明显；
  近球提速让步伐更长更直。这是 R3 验收里 C 裁判（83.3%）用「位移方向直方图」抓到的
  同类线索方向——本轮机制**没有削弱**这条纹理线索，盲测验收须重点看该维度（见 §5 残余缺口）。

## 1. 机制分解（先量后判）

探针（用后已删，源码存 `probe-snippet.rs`）：在 `build_action_plan` 的自然 deadline 评估点
重算与 `evaluate_defensive_action` 相同的纯几何特征，统计 8 seed（42/7/23/11/5/17/31/3）×

- **抢断/犯规只在最近防守者 <2 m 时被选中**（picked 距离直方图，8 seed：tackle 114 次全部落
  `[0,2)` m 桶、0 次在 2 m 外；foul 104 次在 `[0,2)`、1 次在 2–4 m；均值 0.63 / 1.27 m）
  ——2 m 之外的接触动作全部输给 jockey/contain。
- 评估点最近防守者 **75–80% 就是「开放局逼抢者」**（`OPEN_PRESS_N=1`，停距 5 m）。
- hold 70→45（原生 8 seed，其余常数不动）：
  | 量 | hold 70 | hold 45 |
  |---|---:|---:|
  | 自然 deadline 评估点 | 6690（4 seed） | 6559（4 seed） |
  | 最近防守者 <2 m 占比 | 8.2% | 5.1% |
  | 6–8 m 桶占比 | 17.3% | 23.4% |
  | 防守者「在持球者身后」（depth_lead<0）占比 | 65.8% | 76.8% |
  | 犯规资格（x-板条禁区外） | 59.9% | 45.6% |
  | tackle / foul（8 seed 均值） | 25.9 / 21.4 | 14.3 / 13.1 |
- **因为 X 所以 Y**：`CARRIER_SPEED_MS=5.0` > `RUN_SPEED_MS=4.0`，持球者带球时比所有无球
  队员快 25% ⇒ 每拍多跑 0.5 m；hold 45 下「带球跑开」的拍数增加，评估点最近防守者被拉开
  （<2 m 占比腰斩），且防守者更常处于身后（坏角度）与更深的进攻区（犯规在禁区内资格=0，
  引擎不做点球）。⇒ 接触机会减少 ⇒ 抢断/犯规体量随球程反向下跌。这就是 §9.2.4 的
  `hold 45` 探针破带（tackle 13–20 / foul 9–18）的机制。

## 2. 候选与消解（原生 8 seed；除注明外 hold=45）

| # | 机制 | T / F / shot_reg | 判定 |
|---|---|---|---|
| 0 | hold45 基线 | 14.3 / 13.1 / 21.8 | 破带（T<24、F<16） |
| A | 全局 `RUN_SPEED` 4→5 | 21.8 / 12.0 / — | F 更差（快防更常正面，拉人减少） |
| B | 逼抢者 stop 5m→4/3/2m | 14.5/19/25.8 · 15/20.8/25.8 · — | stop2m 把 T/F 拉回，但**射门塌到 6–13**（hazard 的 space/pressure 对称：最近防守者 2 m vs 5 m 差 ~1.6 nats ⇒ hazard×0.2） |
| C | 只提逼抢者速度（6/7/8） | 15.8/16/15.9 | 几乎无效——接触不只靠逼抢者一人 |
| D | **只提防守方**队形 movers 7 m/s | 28.4 / 21.5 / 20.4 | 带全绿，但**分边 6.94→8.59**（贴 8.6 上沿）、like-football 距离 0.169→0.214 |
| E | 全局对称 7 m/s | 27.6 / 16.4 / 20.2 | 分边不漂（6.86），但 `lf.disp` 16.81 **出带**（[10.1,16.8]）、F 贴下沿 |
| F | 犯规资格 8→10 m（平坦抬犯规分） | 27.4 / 23.5 / 20.6 | 可用但**不随移动耦合**（hold70 下也把犯规抬到 25.4）；且犯规增量全在 <2 m（分数竞争翻转，跳变开关） |
| G | `FOUL_BEATEN_GAIN`（犯规分 + bad_angle×g） | g=0.3: 25.5/21.4 | **随移动耦合**：持球者动得越多、后卫越常在身后，拉人倾向越高 |
| H | D 的 30 m 局部限制 | 25.8 / 17.2 / 20.0 | 分边 7.89（比 D 好），但 shotsReg 18.8 越噪声容差 |
| **V1** | **近球 30 m 内（双方）movers 7 m/s + FOUL_BEATEN_GAIN 0.15** | **25.6 / 17.8 / 16.6** | **采用**：分边 6.93 不漂、ratchet 22/22、L1 同红集 |
| — | V1 连贯版（逼抢者也冲刺 7） | 甩出 per-seed 边角 + `latSd` 6.77 出带 | 否（见代码注释） |

**机制注记（必须随报告带走）**：
- 「近球冲刺」是**速度分层**而不是全局提速：`BALL_LOCAL_SPRINT_MS=7` 只作用于距球 ≤30 m 的
  非 close_down movers；远端仍 4 m/s。对称（双方）而非只防守方——只提防守方会让两队重心
  间距（分边）漂移 +1.6 m（D 行），破坏 ratchet 的队形结构项。
- 逼抢者（close_down）**不参与**近球冲刺：它有显式停点（开放局 5 m），提速会改变接触时序
  （连贯版实测 latSd 6.77 出带、per-seed 犯规上冲 35）。
- 犯规回补用**移动耦合项** `FOUL_BEATEN_GAIN×bad_angle`（不是平坦抬分 F 行）：语义是
  「被过掉的防守者伸手拉人」，与 `score_tackle` 的 `-bad_angle` 同源。
- 不改任何 L1 带、不改射门 hazard、不改抢断/犯规的资格阈值。

## 3. 终版读数（V1）

版本：`CARRIER_HOLD_PP=45`、`BALL_LOCAL_SPRINT_MS=7.0`、`BALL_LOCAL_SPRINT_RADIUS_M=30.0`、
`FOUL_BEATEN_GAIN=0.15`；其余常数 = 2732450。wasm（现构建，行为指纹）：
`sha256 9341cfff03aecdf549153f4bac77441e3cee6c07a3c81f49452acb1264b29d9c`。
⚠️ 该哈希会随**源码行号**变化（#104 已知）；行为等价以事件读数/流为准（本轮删探针前后
fast-ballprobe 四位读数逐位相同）。

**事件锚（`fast-ballprobe.mjs`，4 seed 42/7/23/11，90 min）**

| 配置 | ball24 | shot（总） | tackle | foul | passSucc |
|---|---:|---:|---:|---:|---:|
| base（note §9.2.5） | 94.9–98.6（96.6） | 16–30 | 25–27 | 13–22 | .818–.837 |
| **V1** | **114.8 / 112.1 / 108.9 / 107.2（均值 110.75）** | 34/25/21/19 | 25/28/18/25 | 13/18/13/18 | .791/.814/.821/.817 |

**盲测包同窗（`packet-windows.mjs`，12 个冻结引擎窗）**：**113.1**（min 76.7 / max 148.1），
base = 106.8；真实 164.6（136.5–192.6）⇒ **0.69×**（base 0.65×）。

**帧口径（`tools/visual-review/ball-travel.mjs`，5 seed × 12 s 窗）**

| 量 | base | V1 | 真实 | V1 E/R |
|---|---:|---:|---:|---:|
| 球总行程(m) | 52.0 | **57.1** | 60.7 | 0.94× |
| 快段 ≥8 m/s | 31.4 | **32.3** | 40.6 | **0.80×** |
| 慢段 | 20.6 | 24.8 | 20.1 | 1.23× |
| 平均球速 | 4.33 | 4.76 | 5.06 | 0.94× |
| 球静止占比 | 21.0% | 21.2% | 15.6% | 1.36× |

⇒ 移动层杠杆主要抬高**慢段（带球）**（1.03×→1.23×，已过真实）；**快段（传球）仍 0.80×**，
是剩余球程缺口的主源（与 §9.2.5 的判断一致）。

**L1 官方裁决（200 场，`cargo test --release --test realism -- --ignored`）**：**5 绿 / 4 红**，
红集与 base（2732450）完全相同：`l1_shot_result_distributions`（禁区内 goal 0.075，base 0.060）、
`l3_shot_ratios`（射正 0.477，base 0.471）、`l1_tackle_dilution_and_slot_mix`（角球：**均值已进
[1,7]**，but 单场峰值 17 > 15 护栏）、`l1_home_away_goal_asymmetry`（0.765，base 0.743）。
抢断体量带、犯规带（`l1_fouls_and_cards`）、传球成功率带、`p13`、`p31_frequency`、
`l3_home_away_goal_calibration` 全绿。射门：4306 总/200 = 21.5，regular 3929/200 = **19.6**
（带 [14,29]）。

## 4. 地板

- **ratchet（base 快照 `ratchet-base.json`，commit 2732450 / wasm 1ba8a767）**：**22/22 无退化**。
  重点：`lf.gap 6.94→6.93`、`p38.gap 6.92→7.06`、`p38.latSd 9.14→7.44`（带 [7.015,14.015]）、
  `lf.disp 13.52→16.57`（带 [10.1,16.8]，**贴沿**）、`lf.lat 0.35→0.33`（带下限 0.32，**贴沿**）、
  `p38.shotsReg 20.90→19.40`（needs ≥19.10，**贴沿**）、`lf.distance 0.169→0.197`（报告项，**变差**）。
- **默认套件**：lib 二进制 6 红 = `observation×2 / p31_liveness_profile /
  p31_liveness_stages / p31_meaningful_action / p53_highlight`，与 base（本分支 2732450）
  逐项相同（base 由 C1 日志 `cargo-default-suite-2hz.log` + 本轮 `git checkout` 复检双重确认）。
  探针期曾因 `#[cfg(test)]` 字面量触发源码扫描自指坑（p15×3 + p31×3 额外红），改
  `#[cfg(all(test))]` 并删除探针后消失。
  **V1 全量 `cargo test --release --no-fail-fast` 逐 binary 与 base（2732450，直接 checkout 源码复测）
  逐项相同**：lib 6 / p124 6 / p15 4 / p16 3 / p17b 2 / realism 3 / p17a 0 / p18 0。
  期间抓到并修掉 **1 条真新增红**：`p17b::a_contest_fact_closes_at_most_one_episode`
  （seed 20 的 t=5400 零长度 FullTime episode 继承同刻 DeliveryLoose 成因）——
  `p17b/episode.rs::closing_contest_fact` 现在对 FullTime/HalfTime 收束段不认领争抢成因
  （报告工具归因修复，引擎事件流不变）。修后 p17b 回到 base 2 红，新增红清零。
  ⚠️ 另：`p16::goal_kick_amplifier` 在 **base 上就红**（0.408 vs 0.352±0.05），
  `cargo-default-suite-2hz.log` 早于最终 C1 树、不能当基线；本轮未改这个记录值。
- viewer 单测 **401/401**；tools 单测 1 fail = `benchmark-baseline.test.mjs` 基线指纹哨兵（**base 自带**：
  C1 改引擎未重生成 committed 基线；`git show HEAD:engine/src/lib.rs | sha256sum = 82ae6c2f…`
  vs 基线记录 `ad9c3ca5…`）；visual-review **74/74**。
- `e2e-v2`：**base 即红**（`viewer/e2e-v2.mjs:65` 把 beat 起点写死 1 Hz：`t<1` 失败于 0.5）——候选同红。
- `spacing-sweep`：候选 **4 findings**（seed 3，worst 1.775 m）；base 本分支未重测（R3 记录 80，
  8f13a5d）。仍红但**数量下降**，按「已知红、不新增」记。
- `benchmark-compare` / `benchmark-crossvalidation`：报告项正常输出（无 pass/fail）。

## 5. 残余缺口（如实）

1. **主目标未达**：盲测包球程 113.1 vs 真实 164.6（0.69×），快段 0.80×。离 R4 核算的「事件层
   天花板 ~110–125」只多走了一步；**这条轴（移动层带球）不是快段缺口的解**——快段要动传球
   量/距离，撞 L1 混合带（R4 的 C1 结论不变）。
2. **like-football 距离变差**（0.169→0.197，报告项）：`lf.disp` 13.5→16.6（1.23× 真实）——
   近球冲刺让「位移/窗」超量。若下一轮以距离为验收，这是第一个要还的账。
3. **纹理线索未改善**：终版轨迹图仍是长直横线；R3 C 裁判的方向直方图线索未被削弱（§0）。
4. **三处软带贴沿**（disp / lat / shotsReg）——再改一个常数就可能翻红，后续轮次须先扩样本
   或先重标定软带（与「引擎贴着带沿站」同型）。
5. 单 seed 边角：tackle 18（seed 23）、foul 13（seed 42/11）、passSucc .791（seed 42）在各自
   带的边角或外；L1 聚合口径全绿。**4-seed 表不能当逐场保证**。

## 6. R5b：快段（传球）杠杆复测（不落地）

在 V1 树上复测 R4 的传球杠杆（候选表与 L1 见 RECORD R5b）。要点：
- `PASS_W_LENGTH 1.0→0.3` 把事件锚球程推到 **124.7–127.1 m/24s**（+13%），但 L1 出现
  **新红集**：犯规 30.14 ∉ [16,30]、远射桶样本不足（长传 ⇒ 接球点更近 ⇒ 远射样本跌破
  统计前提）、角球均值 7.15 ∉ [1,7]、射正 0.4965。
- `CIRCULATION_PASS_P` 0.25 单独只 +1–3 m；与长传叠加反而让犯规上冲 38–40。
- ⇒ 快段缺口要动事件层「传球量×距离」，会同时推破犯规/射门位置/角球——**过约束系统**；
  要同时成立必须重标定 L1 带（范围级决定）。F1–F5 全部回退，树保持 V1。
- 探针教训：`fast-ballprobe.mjs` 恒读 `viewer/engine.wasm`、忽略参数；扫 wasm 必须先
  `cp` 到该路径。
