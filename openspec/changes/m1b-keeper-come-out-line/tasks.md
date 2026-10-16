# 任务

## 第 0 步：先看 → 候选 → 对抗（`adversarial-explore` 回路）

- [x] 判别测试：零上下文裁判 3/3 判对，头号判据 =「两名门将 12 s 内一毫米不动」
- [x] 定位根因：`compute_mover_candidates` 门将支目标恒为 `(0.02 | 0.98, 0.5)` ⇒ 距门线恒 2.10 m
- [x] 真实锚：22 场（Metrica 2 + SkillCorner 20）门将槽位逐帧，8 分箱中位 `2.18 … 21.86`
- [x] `M1b-PREDICTION.md`（**改代码之前**落盘：分步预测 + 反证设计）
- [x] 独立判据镜复核（`M1b-JUDGE.md`）：P4 进带、两条直线都进带 ⇒ **节点表必要性证伪**

## 第 1 步：实现（`engine/src/lib.rs`）

- [x] `GK_COME_OUT_SLOPE = 0.2440` / `GK_COME_OUT_INTERCEPT_M = -0.4632`（最小二乘，复算一致）
- [x] `GK_COME_OUT_FLOOR_M = 2.0`（真实 q10 之下取保守值）
- [x] `GK_TRACK_Y = 0.10`（Metrica 0.09 靠上沿；SkillCorner 0.14 疑平滑放大，不采信）
- [x] 纯函数 `keeper_line_dist_m`（直线 + 地板）
- [x] 门将支改走直线 + 横向跟球；`formation_target` 陈旧注释订正（**函数体一字未动**）
- [x] **边界**：`GK_SPEED_MS` / `DEAD_ZONE_METERS` / action 名 / 间距分离 / 其它常量 **一个没动**；无 `pub const` 增删改
- [x] `git diff --stat` = **1 file changed, 57 insertions(+), 3 deletions(-)**

## 第 2 步：落地前必修（`M1b-JUDGE.md` §10，逐条）

### A. 报告订正（不影响结论方向，影响下游引用）

- [x] **A1** §4 的 L2 余量比较**换同口径**：M1 补 300-seed 的 **8.84 m / 1.78×**；结论句改「**1.78× → 1.65×**」（原文 2.20× vs 1.65× **混了扫描面**）
- [x] **A2** §2 的「效应大 4 倍」**加限定**：(a) 只在 legacy slab 上显著；(b) rect 口径 **−0.0115（t=−1.75, n.s.）**；(c) **叠 M5 后 +0.0000（t=+0.01）**
- [x] **A3** §5.1 的「100 seed」列**统一口径**（base/M1b 用累计 1..=100；M1 用 10 个 10-seed 块均值 ⇒ 同一列两种口径）

### B. 落地 change 必须做的

- [x] **B4** 重写两条**真语义破**的断言：`p5_press_up_and_gk_exempt`、`p23_sent_off_keeper_produces_no_keeper_return`
      —— 二者断言的正是本改动删掉的「门将不受球位置影响」不变量。**只改判据**：
      - `p5`：保留压上断言；门将部分由「恒回门线」改为**「球贴本方门线 ⇒ 回退 / 球在对面半场 ⇒ 出击」**
        （不再断言「恒回门线」——那会让 `dead_zone` 吃掉 mover，断言变成空转）；
      - `p23`：**判据（罚下门将零 mover）未动**，只把对照组门将起点 `0.2 → 0.10`（原起点离 M1b 的
        新目标仅 0.0092 < `DEAD_ZONE_METERS`，对照组会空转）。
- [x] **B5** golden 重基线：`realism::gm_canary_seeds` + `p15::recorder_on_and_off_reproduce_the_golden_canary_stream`
      （两个 commit 共用 `MODEL_VERSION=9`；本 commit 把 `tests/golden-v9/` **更新到 M5+M1b 的流**，
      故单独 revert 本 commit 会回到 M5-only 的 v9，仍自洽）
- [x] **B6** 补齐覆盖守卫的 seed 集（**换样本不换判据**；失效 seed 从 M1 的 21 变 M1b 的 239 ⇒ **巧合命中面**，不去「解释」那个 seed）：
      - `realism::l2_sent_off_kickoff_seeds`：`33/187/189/239` → **`33/187/246/269`**（重扫 1..=1600，命中 33 个）
      - `observation.rs` 三形态 `SEEDS`：`[74,89,100,124,43,61,174,13,188]` → **`[61,68,73,91,79,401,462,102,337]`**（计数 4/3/2）
      - `p15` `TRUNCATION_FORM_SEEDS`：`[74,43,13]` → **`[61,79,102]`**
      - `p15` gap 样本：`562@120 / 441@700` **复扫仍命中，无需再换**
      - （**本 commit 新暴露**的两条同族空转）`p15` `CONTEST_SEEDS` **追加 18/38**（重扫 1..=600，
        `ContestEnd(match_end)` 命中 53 个）；`p17b` `FALLBACK_WINDOW_SEEDS` `225/278` → **`79/84`**
        （重扫 1..=400，11 个全为 `stream_end` 档）
- [x] **B7** `p16::goal_kick_amplifier`：`GOAL_KICK_RESTART_SHARE` `0.317 → **0.352**`（100 seed 实测 2767/7857）
      + 守护窗 `10 → 100`（新增 `AMPLIFIER_SEEDS`，不动 `QUICK_SEEDS` 的其它用途）
      + **重写它想抓什么**：旧 10-seed 窗的块间跨度（≈0.042）与 ±5pp 带同宽 ⇒ 判别力本就不成立、
      且旧常量在未改的基线上就有 4/10 块会红；新口径下 ±5pp ≈ 12× 抖动，**对小幅漂移不敏感是设计如此**
      （本条是记录、不是判据），**真正承重的是两条结构断言**（落点恒过半场 + 落在 `goal_kick_land` 钉死的区间内）。
- [x] **B8** `l3_shot_ratios` 那条带：**先修口径（M5），没有放宽**
- [x] **B9** ★ **M5+M1b 的余量按最坏窗报**：`801..1000` 的 **0.8152（+0.0152）**，不报门禁窗的 0.8390
- [x] **B10** `sot_r` 薄余量跟着记：M1b+M5 门禁窗 **0.3837**（+0.0063）；M5 单独 0.3778、M1+M5 0.3859

### C. 流程

- [x] **C11** 全量红用 `--no-fail-fast`（M1 那轮被 fail-fast 少报一半）

## 第 3 步：进账三条代价（**不是否决票**）

- [x] L2 余量 **1.65×**（比 M1 的 1.78× 薄）
- [x] 门将↔队友 `<5 m` 频次 **29×/32×/28×** 基线
- [x] `<2.2 m` 对数 **2/12/61**——**未跨分离线**，机制是**未消融的解释**，如实写

## 第 4 步：验收

- [x] 面板 P4（`--dataset engine` + `--dataset real`）四项进带，头条项比节点表更贴真实
- [x] `cargo test --release --no-fail-fast`：**M5+M1b 全绿（0 红）**；逐条分类见落地报告
- [x] L1 全套 `--ignored`：**M5+M1b 9 passed / 0 failed**（门禁窗）
- [x] `spacing-sweep` **0 findings** / `e2e-v2` **OK**
- [x] 多窗轨迹图（`png/M1b-gk-linedist-trajectory.png`）
- [x] 预注册反证对账（`M1b-PREDICTION.md`）

## 第 5 步：规格

- [x] `openspec/changes/m1b-keeper-come-out-line/`（proposal + design + tasks + spec delta）
- [x] `openspec validate m1b-keeper-come-out-line --strict` 通过

## 纪律

- [x] **未放宽任何带**；**未为过关调参数**；**未删断言**（只重写点名的两条语义断言）
- [x] **未改判据本体**（`DUR` / `TICK_SECONDS` / seed 集口径 / detector）
- [x] 未 push / 未 merge / 未开 PR 前未派 subagent / 未当裁判
