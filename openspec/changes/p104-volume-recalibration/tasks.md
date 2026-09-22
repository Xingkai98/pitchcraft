# Tasks: 体积重标定（#104）

> 两轮用户拍板已完成（`notes/user-confirmation-2026-09-22.md`、
> `notes/user-decision-round2-2026-09-22.md`）。**无阻塞门槛。**
> 方案已按第 2 轮判定原则选定：**方案 ③（3 常量）**（依据 `design.md` §D3.4）。
>
> **当前状态**：P1–P5 全部完成，审阅已过两轮（round1 0B/3M/4m → round2 **0B/0M/7m**）。
> `./verify.sh` 9 步全绿、`cargo test` 129p/0f、L1 九门 9 绿。**只剩收尾轮审阅确认。**

## P1. 探针与证据落盘（已完成）

- [x] P1.1 `notes/probes/{l1-metrics,run-variant,sweep-tackle,sweep-fine}.mjs` + 口径对齐自检（D1）
- [x] P1.2 `notes/probes/out/FINDINGS-exploration.md`（粗扫/细扫/留出/角球长尾）
- [x] P1.3 最简竞争解试算（D2）——**第 2 轮已重做**，含 deadline 支（方案 ④）
- [x] P1.4 `notes/probes/{big-sample,compare-schemes,full-gates}.mjs` + `notes/scheme-comparison.md`
- [x] P1.5 `openspec validate p104-volume-recalibration --strict` 通过
- [x] P1.6 独立零记忆 subagent grilling（`reviews/grill-design.md`，3 BLOCKER / 6 MAJOR / 4 MINOR）
- [x] P1.7 grill 全部条目的逐条回应（`design.md` §D9）
- [x] P1.8 用户第 1 轮 + 第 2 轮拍板（`design.md` `## User Confirmation`）

## P2. 引擎常量（`engine/src/lib.rs`，方案 ③）

- [x] P2.1 `OPEN_PLAY_SHOT_ENGAGE_SHIFT` −4.3 → **−3.4**
- [x] P2.2 `BASE_DEF_TACKLE` −1.10 → **−0.65**
- [x] P2.3 `BASE_DEF_FOUL` −0.10 → **−0.06**（语义：补偿被抢断切走的份额，**不是**把犯规当缺口修）
- [x] P2.4 `MODEL_VERSION` 6 → 7
- [x] P2.5 三处常量注释补「#104 重标定依据」——含**留出窗口读数**与 wasm sha（防后人以为过拟合）
- [x] P2.6 角球长尾的**正确归因**写进相关注释（来自射门抬升本身，非抢断——§D6）

## P3. 门重标与遗留测试修复（`engine/tests/realism.rs` + `engine/src/lib.rs`）

### P3a. 三条体量带（§D5）

- [x] P3a.1 `l1_shot_result_distributions` 射门带 `[6.0,11.0]` → **`[14.0, 29.0]`**
      （注释写明推导：StatsBomb 大五 n=170 mean 21.64 sd 5.03 ±1.5sd；**并写明引擎读数在下沿**）
- [x] P3a.2 `l1_tackle_dilution_and_slot_mix` 单场角球上界 `≤12` → **`≤15`**
      （注释写明：3000 场定值、干净 main 已 max=12、语义是数量级护栏、**余量薄**）
- [x] P3a.3 `l1_home_away_goal_asymmetry` 主队带 `[0.38,0.75]` → **`[0.85,1.60]`**；
      **`gh > ga` 与 `ga_pm ≥ 0.30` 两条方向断言不动**
- [x] P3a.4 **新增抢断体量带** `[24, 50]`（原带里没有这条门——本票新立；注释写明口径对齐）

### P3b. grill 的 B1：三条**完全没预见**的既有红门

> ⚠️ **SHALL NOT 放宽断言或删测试**——必须改语义/重构造/重扫，并写明**为什么改**。

- [x] P3b.1 `v2_tackle_frequency_in_target_range`（**非 ignored**）：
      断言 `[3,14]` 是 **P7 槽位时代遗留**（注释自写「应 ~7 槽/场」，而槽位层 P31 已删）。
      改为与当前机制一致的**体量断言** `[24,50]`（与 L1 抢断带同源），注释写明「原带语义已死」+ 依据
- [x] P3b.2 `p30_window_foul_cancels_without_shot`（**非 ignored**）：
      `BASE_DEF_TACKLE` 改了打分序 → 原几何（d≈1.05m）现在选 `Tackle` 而非 `Foul` → **前置几何断言失败**。
      **重扫并重构造几何**（d≈3.15m，`0.55 vs 0.58`）使 `Foul` 重新胜出（注释写明「打分基线变更，几何需重选」）
- [x] P3b.3 `l2_sent_off_kickoff_seeds`（**非 ignored**）：钉死的 4 seed（18/59/94/95）不再含红牌。
      按该测试已有的**既定维护惯例**重扫 1..=3000 取「**红牌先于进球**」的新 seed
      （29/35/59/84——比「红牌+进球」更严，因为测试意图是「进球后开球的硬编码 id 恰为罚下者」），
      并把「RNG 重排会再次失效」写进注释

### P3c. 明确不动（补注释说明）

- [x] P3c.1 shot/tackle 带 `[0.5,1.5]`：**确认不动**（实测 0.563 在带内），
      补注释「一起抬所以不用改；只抬射门会让它到 1.925」
- [x] P3c.2 `l3_shot_ratios` 三条比率带：**确认不动**，补注释说明与 #102 的差别
- [x] P3c.3 `p31_frequency_5min_directional`：补注释「通过是因为**方向断言**，非量级未变」

## P4. golden v7

- [x] P4.1 `golden_dir` 加 `7 => "tests/golden-v7"`（`realism.rs`）
- [x] P4.2 `gm_legacy_baselines_preserved_and_differs` legacy 扩 **v1–v6**
- [x] P4.3 `ACCEPT_GOLDEN=1 cargo test --test realism gm_canary_seeds` 生成 v7；
      **人工审查每个 seed 的 diff**（比分/射门/抢断/犯规/出界不得异常漂移）
- [x] P4.4 确认 v1–v6 目录未被覆盖（`git status` 应只有新增）

## P4b. 比赛标尺基线重生成（§D6b，任务书未列）

- [x] P4b.1 把 20 场 SkillCorner 转换产物放进 `viewer/data/`——**只拷 `skillcorner-<id>.json`，
      不拷 `-phase.json`**（后者形状不同，会让脚本抛 `.map of undefined`）
- [x] P4b.2 `node tools/benchmark-baseline.mjs`（改**入库文件** `viewer/data/benchmark-baseline.json`）
- [x] P4b.3 `node --test tools/benchmark-baseline.test.mjs` 全绿（哨兵转绿）
- [x] P4b.4 `git status` 确认只多 `benchmark-baseline.json`（其余 `viewer/data/*` 仍 gitignored）

## P5. 主 spec 同步 + 验收

- [x] P5.1 `openspec/specs/match-engine/spec.md` 同步 delta 的 **4 条** requirement
      （2 条 ADDED + 2 条 MODIFIED）
      （⚠️ 按记忆 `openspec-archive-validate-gap`：MODIFIED header 须与主 spec **逐字一致**且**全量复制** scenario。
       实测：4 条 scenario 集合一致、正文**逐字相同**——`commit 01db87a`）
- [x] P5.2 `npx openspec validate --all --strict` 全绿
- [x] P5.3 **`cargo test` 全绿（默认套件）+ `cargo test --test realism` 全绿（非 ignored）**——
      **硬要求，必须真达成**（不能靠删测试或放宽）
- [x] P5.4 `./verify.sh` 全绿（9 步）
- [x] P5.5 **看图**（硬约束）：120s 轨迹图 + 并排 + 全场窗，与干净 main 对比——
      确认体积抬升**没有引入新形态**（P38 三次「数字达标但画面更差」的教训）。
      另确认**门球重开**的画面形态（门球 +49%，§D4.2）
- [x] P5.6 **判据组 8 条逐条对照并如实记录**（**不预设「不恶化」**——
      `swarm` 确实恶化：干净 main 0.488 → 本方案 **0.338**，写进报告）

## P6. 审阅闭环（强制收尾）

- [x] P6.1 独立零记忆 subagent 审阅实现（`reviews/review-round1.md`：0B/3M/4m，建议交付）
- [x] P6.2 修复轮1 发现的问题（`review-response.md`；commit `b244bab`）
- [x] P6.3 再审（`reviews/review-round2.md`：**0B/0M/7m**，建议交付）
- [x] P6.4 修复轮2 发现的问题（`review-response-round2.md`；commit `a9eb958`）——
      含 **§D0b** 记录的源码扫描陷阱（注释里的字面 `#[cfg(test)]` 会打断 3 条测试）
- [x] P6.5 收尾轮审阅确认（`reviews/review-round3.md`：**0B/0M/5m**，可以交付；
      5 条文档层 MINOR 已修，commit `4173bee`）

## 关联

- 跟踪 issue #104
- 上游依据：`openspec/changes/p38-formation-realism/notes/`（`conversion-adaptive.md` §6、
  `volume-compensation.md` §2.4、`criteria/README.md`）
- 独立审阅：`reviews/grill-design.md`（第 1 轮，已逐条回应于 `design.md` §D9）
- 后续（不在本票）：二次进攻链、队形（#89）、传球体积（396 vs ~900）、
  `far==0` 断言的容差口径、角球上界的相对界形式
