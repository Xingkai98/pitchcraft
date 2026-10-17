---
title: C1–C5 已知问题清单（两轮盲审汇总，冻结存档）
date: 2026-10-17
status: closed
---

# C1–C5 已知问题清单（证据索引）

> **状态：已闭环。** 两轮盲审（6 个零上下文审查员）的每一条发现，都已在对应票据的
> **「审查闭环」**段里给出处置（已修 / 已裁决 / 实现时执行）：
> [#170](https://github.com/Xingkai98/pitchcraft/issues/170) ·
> [#171](https://github.com/Xingkai98/pitchcraft/issues/171) ·
> [#172](https://github.com/Xingkai98/pitchcraft/issues/172) ·
> [#173](https://github.com/Xingkai98/pitchcraft/issues/173) ·
> [#174](https://github.com/Xingkai98/pitchcraft/issues/174) ·
> [#175](https://github.com/Xingkai98/pitchcraft/issues/175)
>
> 本文件保留为**证据索引**：每条发现对应的 `文件:行号` 与实测值在这里，
> 处置结论在票据里（一事实一出处，避免两处维护）。

## 怎么用

- 写 design 时，先看票据的「审查闭环」段（结论），需要核证据时回这里查 `文件:行号`。
- `[票]` = 票据/文档已有的约束；`[坑]` = 会在实现时反噬的具体位置。
- 下面各条**都已处置**，不是待办。

---

## #170 C1 运动学

- `[坑]` **19 个 `*_TICKS` 里至少 2 个是死常量**：`HOLD_MIN_TICKS`(`lib.rs:678`)、`HOLD_MAX_TICKS`(`:679`)
  除声明外零引用（`grep -c` = 1；`tests/p17a/anomalies.rs:130` 也写「机制不是 HOLD_MIN_TICKS」）。
  ⇒ 「19 个都必须换域」应改成「17 个换域 + 2 个删除」。
- `[坑]` **`lib.rs:4591` 是 tackle 高亮时长**（`t_end = t + TICK_SECONDS`），**不是 beat 间隔**。
  同文件其它高亮全是 `t + flight`；`match-engine:763` 明写它就该 1 tick。按 0.2 s 改会让 tackle 高亮短 5×。
- `[坑]` **P16/P124 的逐拍快照契约**：`p16_spatial_features.rs:360-410` 断言快照数 ==
  `ceil(DUR/TICK_SECONDS)-1`、首拍 `t == TICK_SECONDS`；`p124_intent_observations.rs:460-478` 断言 1:1。
  两条都在**默认套件**（verify.sh 第 1 步）。「快照降到决策拍」会同时打红它们 + 改两个既有 change 的契约。
- `[坑]` **`viewer/e2e-v2.mjs:65`** 断言首拍 `t ∈ [1,2]`；beat 改 5 Hz 后从 0.2 起拍会红。
  **beat 起拍相位 spec 里没有规定**，design 必须写。
- `[坑]` 改 `viewer/` 下 JS 必须 bump `viewer/index.html` 的 `?v=`（当前 `20261012-2`）——`CLAUDE.md` 硬规。
- `[坑]` `realism.rs:1355` 的 `golden_dir()` 是穷举 match + `other => panic!`；
  不加新版本分支，**`ACCEPT_GOLDEN=1` 自己就 panic**。
- `[坑]` `p18_behavior_gates.rs:103` 把 `model_version` 写进 canary provenance；`p16/p17a/p17b` 的 report 写
  `tick_seconds`。这些 `--ignored` 产物门要同一 commit 重跑（`CLAUDE.md:97`）。
- `[坑]` **外部引用错位**：PMC6132493 的 17.5°–34.9° 是**意图 45°** 切入的实测；
  90° 意图的实测量是 33.0°/40.5°/75.6°。该文正文与表 1–4 里**没有** `a_lat ≈ 6–8 m/s²` 的陈述。
- `[坑]` 「平均冲刺 5.9 m / 57 次」**不在** PMC11474994（该文是 160 ± 89 m/场、PS 9.53）；
  A0 原文区间是 **6.39–7.81**（票里写 6.3–7.6）。
- `[流程]` `openspec validate` 对 delta 的 `### Requirement:` 头写错**仍 exit 0**，
  只有 `archive` 会拒。⇒ 别把 validate 绿当成 delta 对。

## #171 C2 站位表

- `[票]` **spec 已把当前公式写成规范性 Requirement**：`match-engine:705/711/715/719/750/759`。
  换查表就是规格违约，必须 delta。
- `[坑]` **`pitch-viewer:359` 说纵深估计量 SHALL 为 trim1**，而实测与 P37 用户拍板都是 q10–q90；
  `viewer/match-metrics.test.js:216/241/254` 三条守护测试锁住 q10–q90。改口径会打红，改回则所有「现状」数字变。
- `[坑]` 目标 `hd ≤ 31`（带 [23.385, 28.385]）与 `spread ≤ 19`（带 [13.41, 17.01]）——
  **达标后仍在带外 2.6 m / 2.0 m**。票面别写成「达标 = 进带」。
- `[坑]` 跨 source 不可比：`p38.hd`（criteria·10 seed）与 `lf.ad`（like-football·5 seed）同一张表都给 ≤31。
- `[坑]` `engine/Cargo.toml` 明写**零依赖**：Delaunay 自己写还是引 crate，必须定。
- `[坑]` `default_lineup()` 只有固定 4-4-2；要第二阵型 = `MatchConfig` 级接口变更，票面没提。
- `[坑]` 会红的测试：`p5_ball_side_shift`(`lib.rs:8492`)、`p5_press_up_and_gk_exempt`(`:8506`)、
  `p5_formation_and_transition`(`:8426`)——都直接断言当前公式行为。
- `[坑]` **L1 八条统计带**（`realism.rs:669-1188`）是 `verify.sh` 第 7 步的真门，票面早先漏列。

## #172 C3 盯人

- `[坑]` **与 #173 同段无球分支，归属未解**：两票都改防守方的「该站哪」；
  `OPEN_PRESS_N` 保留 / 删除 / 被 mark 取代，两票说法相反。
- `[坑]` 「只替换防守方」的**「哪些人」未定**：4 名后卫（`home_defenders`，`lib.rs:2527`）还是 10 名外场？
  未匹配的防守者去哪（回表 / 原地）？carrier 可不可被 mark？
- `[坑]` **mark 的 cadence 未定**：1 Hz 决策拍还是 5 Hz beat？换人惩罚频率差 5 倍。
- `[坑]` **repulsion 冲突**：`match-engine:755` 要求所有 mover 目标先经同队 2.2 m 分离；
  mark 的停点会被二次推开，可能把 marker 推离盯人点。参与否、停距量到哪，未定。
- `[坑]` 会红：`p5_formation_and_transition`、`p5_press_up_and_gk_exempt`、`p23_sent_off_produces_no_mover`。
- `[坑]` **机制论证不完整**：攻方仍走 `formation_target`（票面不许碰），所以 mark 只能**复制**攻方已有的横向运动，
  不能产生它。`latSd 3.219 → 5.5`（+71%）缺少估算。
- `[坑]` Tanaka 2015 的论文是 **set-play** 盯人分配，用于开放局属跨场景外推，票面未标。
- `[注]` 「每拍 8.2 个 mover」实为 **7.199 movers + 1 carrier**；`movers` 不含 carrier（`event-stream-protocol:28`）。
- `[注]` 30 seed = **seeds 1..30**（0..29 会有 ~0.1% 偏差）。

## #173 C4 压迫场

- `[坑]` **B4 的口径有四个版本**：`ratchet` 已改 `lower`；`gates-spec.json:84-87` 仍只有 `minRatio 0.5`
  且 note 写「引擎现为 0.10×」（0.0581 时代，现状 0.6458）；`plan.md` 的 0.56±0.1 已作废。
  ⇒ **`gates-spec.json` 的 B4 段还没改**，开工前要对齐一次。
- `[坑]` **「每拍压迫人数」没有任何观测量**：B4 只量「有没有人逼近 >0.3 m/拍」，不量几个。
  票面要求「人数上限」，但没有验收能看到它被突破。
- `[坑]` **`p_ij` 的 j 是谁**：取持球者会退化成「最近的 N 人」（`p_ij` 单调于距离）。
- `[坑]` **「控制差」全票未定义**：在哪个点、对谁取差、max 还是 sum、替换还是叠加。
- `[坑]` **改点悬空**：票面早先写「替换防守站位里『该站哪』那一项」，而 #171 已把整条公式换成查表。
  已改为「在 `compute_mover_candidates` 里查表之后覆盖」，但 design 要写清与 #172 的仲裁。
- `[坑]` **spec delta 要在 live spec 新增 requirement**，不能改 `p143r-v4` 的 change delta
  （那是别人未归档的 change；live spec 里本来就没有这条）。
- `[坑]` **性能**：10 Hz × 5400 s = **54,000 帧**；1 m 网格 ≈ 59 s/场；
  但 L1 是 200 seed、canary 300 seed ⇒ 1 m 网格一轮 L1 ≈ 3.3 h。**网格分辨率要由 seed 乘数倒推。**
- `[坑]` 继承 p143r 的不变量：`OPEN_PLAY_PASS_PRESSURE_M`(4.0, `lib.rs:736`) **必须小于**逼抢停距，
  否则持球者恒判被逼抢、射门推进档永久不可达。
- `[坑]` 网格换算：1 m = 7,140 格、2 m = 1,802、10 m = **77**（93× 便宜）。

## #174 C5 持球者搜索

- `[坑]` **A3/C1 在工具里恒判过**（`check-behavior-gates.mjs:55-64` 的 `ok: true` 是硬编码）；
  且 C1 的 `denominatorComparable` 明写「占比栏不可比」，**可比栏是 `C_shotLastChains`（数/场）**。
- `[坑]` **引擎没有前向模型**（无 `PredictState`、无球物理预测；`sample_pass_landing` 全靠 RNG）。
  链搜索需要动作结果预测，票面没说要用什么替代。
- `[坑]` **改造面不止 `evaluate_carrier_action`**：射门唯一来源是 `shot_window_plan`(`lib.rs:4420`)；
  `p29_shot_window_is_live_and_only_shot_path` 断言「窗口提交数 == shot 数」；
  带球档刻意不承诺动作（`lib.rs:2180-2192`）以保 contain/jockey，`p28_action_opportunity_is_live` 守着。
- `[注]` FRA-UNIted 的「84–113 学生·小时」**未核到原文**（环境不能解析 PDF），引用时标「二手/未复核」。

## 地图 #175 / 工具

- `[坑]` **ratchet 只判「不比基线差」**，不判专项目标（`disp ≥ 10.77` 等）。写 PR 时要单列数字。
- `[坑]` `check-criteria.mjs` 恒 `exit 0`；缺真实数据时打印「跳过」并 exit 0（ratchet 会把它当失败）。
- `[坑]` P18 canary 的 provenance **不记脏树**；`verify.sh` 生成时用 `P18_SOURCE_COMMIT=$(git rev-parse HEAD)`，
  ⇒ **「改后」那次必须在 commit 之后生成**，否则指纹与 HEAD 不符。
- `[坑]` 五张票的依赖只是文字，**没有 native sub-issue / blocked-by**。
- `[注]` `gates.test.mjs` 的陈旧哨兵在 `verify.sh` 末步，管不到 ratchet 路径；
  ratchet 自己现在有 wasm 陈旧守卫（lib.rs 变而 wasm 没变 → exit 2）。

---

## 两轮盲审的结论（供下次接手判断）

1. **票据的事实层已经很扎实**：行号、常量、spec 命中、基线数字，两轮抽检基本全对。
2. **票据不能替代 design**：审查员在第二轮之后仍在提「谁来画表 / j 是谁 / 哪些人 / 什么 cadence」——
   这些是设计决策，不是票据缺陷。
3. **真正的机器门只有三个**：`verify.sh` 的 cargo 套件（golden / 确定性 / L1 统计带 / spacing）、
   `ratchet diff`（不许退化）、`openspec archive`（delta 头必须对）。其余都是报告。
