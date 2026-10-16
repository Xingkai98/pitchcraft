# 任务

## 第 0 步：把「尺子」与「引擎」分开量

- [x] 确认门判「禁区内」= `(1−sx)·105 ≤ 16.5`（`realism.rs` 的 `aggregate`），**不看 y**
- [x] 同批比赛上两种口径各算一遍（只读探针 `zz_probe_geo_caliber`，`#[ignore]`）：门禁窗 **0.7211 / 0.6825**
- [x] 确认 `shot_bucket` 禁区外两档 = `(7,22)` / `(4,11)`；聚合实测 **7.53%** vs 真实 4.2%
- [x] `M5-PREDICTION.md`（**改代码之前**落盘：分步预测 + 预期会动/不会动的量 + 预期会破的带 + 反证设计）

## 第 1 步(a)：校尺子

- [x] `MatchStats` 增 `n_goal_in_slab` / `n_goal_in_rect`（几何、含头球、用 shot 自身 x/y）
- [x] `l3_shot_ratios` 的 `inside_r` 改矩形口径；**板条口径与旧口径并列打印**（证据不删）
- [x] 断言带 `[0.72,0.92]` → **`[0.80,0.91]`**（两端只由**直接**真实读数定；对称规则），逐字写明「这不是为了过关」（换口径立刻变差 0.721→0.683）

## 第 1 步(b)：压禁区外两档转化

- [x] `shot_bucket`：禁区弧 `(7,22)`→`(3,22)`、远射 `(4,11)`→`(2,11)`；注释写推导与 `(4,2)` 被否的理由
- [x] **落地补齐（判据镜点名）**：`spec` 补两条理由——(a) 单调性的**实测**依据（弧 4.18% > 远射 3.49%；反例 8/10 块违规）；
      (b) **「取 2 不取 1」的显式理由**（`(3,1)` 3.55% 同样带内且单调 ⇒ 靠「同比例缩放」这条建模选择）
- [x] **落地补齐**：spec 写清**只动远射档是死路**（rect 只到 0.7432 破带）⇒ 禁区弧那一档承担几乎全部效果
- [x] **落地补齐**：余量改为**最坏块**口径（单独 +0.0075 @ 801..1000；叠 M1b +0.0152），不再引用 +0.0177
- [x] **落地补齐**：登记已知债——`sot [0.28,0.39]` 在块 `201..400` 破上沿（M5 0.3921）
- [x] 校准自证探针（`zz_probe_bucket_calib`）：逐桶「声明概率和 vs 实测进球」
      ⇒ **禁区内 445.0 / 445 逐位命中**、主客错位 0 ⇒ 抽签与主场通道按声明工作

## 第 1 步(c)：耦合 —— 禁区内体量

- [x] `sample_shot_target`：58/27/15 → 70/20/10（两个互斥真实锚取中点 0.624，按兑现率定标）
- [x] 验证 `goals/场` 回到真实量级（**2.88**，真实 2.75；改动前 2.85）
- [x] 验证 `box_shot_share` 不越既有带 `[0.45,0.65]`（实测 0.6226）

## 第 1 步(d)：订正陈旧因果注释

- [x] `BASE_DEF_TACKLE` 上方注释（取值不动，只订正因果 + 指向 9 块配对检验）

## 第 2 步：验收

- [x] L1 全套（`--ignored`）：**12 passed / 0 failed**
- [x] 逐带实测值 + 余量落盘（`M5-READINGS.md`）
- [x] 三桶声明带判定（`l1_shot_result_distributions` 全过；最小余量 0.019 —— 判定**不需重标**）
- [x] 跨窗块扫描（多 200 场窗的矩形占比，验余量不是单窗运气）
- [x] `cargo test --release` 全量：**基线全绿 → M5 8 条红**（6 条定点样本/golden，2 条统计断言临界；逐条分类见 `M5-REPORT.md` §2.1）
- [ ] **落地必做**：golden 重基线（`ACCEPT_GOLDEN=1`）+ 重扫 4 个定点 seed 列表（`l2_sent_off_kickoff_seeds` / `observation.rs` 三形态 / p15 三形态 / p15 gap 样本）——**换样本不换判据**
- [ ] **落地必做**：两条统计门（`p32_interception_self_consistency` 越界 0.16%；`p16::phaseability` AUC 差 0.003）**逐条分类**为流重掷型或真语义破
- [x] `spacing-sweep` **0 findings**（8 seed × 2157 窗）/ `e2e-v2` **OK**（6293 事件、无 snap）
- [x] 面板（PR #168 那份；收工途中已合入 main `9f5fa5d`，合入版与所跑那份 sha256 逐位相同）——引擎侧**只有流重掷级漂移**
- [x] 出图（`png/M5-trajectory-seed42-t1800.png` / `png/M5-contact-sheet.png`；**已注明对事件层改动是盲的**）
- [x] 反证 R1–R4：**R1 ✅ / R4 ✅ / R2 半证伪 / R3 证伪** ⇒ 机制叙述已订正（进球从禁区外搬进禁区内，总进球几乎没变）
- [x] **M1 叠加**：`/tmp/m5-m1` = M1 patch + M5 patch，L1 **12/0 全绿**，矩形 **0.8163 ∈ [0.80,0.91]** ⇒ **这条带不破了**

- [ ] **落地必做**：`MODEL_VERSION` 8 → 9 + `golden_dir()` 加 `9 => "tests/golden-v9"` + 新建 `tests/golden-v9/`（仓惯例；**不覆写 `golden-v8`**）

## 第 3 步：规格

- [x] `openspec/changes/m5-inside-shot-ratio-caliber/`（proposal + tasks + spec delta）
- [x] `openspec validate m5-inside-shot-ratio-caliber --strict` 通过
- [x] proposal 写明与 `p104-volume-recalibration` 的归档顺序（其 `## Unchanged` 节把 `inside [0.72,0.92]` 与九条桶带列为「不动」，与本 change 直接冲突 ⇒ 先归档本 change，归档 p104 时同步修订该节）

## 纪律

- [x] 未改任何**现有测试的断言**（`realism.rs` 的 L3 断言只按 (a) 换**口径**，已在正文逐字说明）
- [x] 未 push / 未 merge / 未开 PR；未派 subagent；未当裁判
- [x] 仓库只留 notes 与 spec delta（引擎改动落在 `M5-lib.rs.patch`）
- [ ] **落地必做**：文档债 A 档（`lib.rs` 的 `BASE_DEF_TACKLE` 依据链 / `SWEPT_LIGHT_SHARE` 的旧口径读数 / `.p31-progress.md` 的旧带）
- [ ] **落地必做**：`openspec/specs/match-engine/spec.md` 与 delta 逐字对齐（防 archive 漂移）
- [ ] **落地必做**：`openspec validate m5-inside-shot-ratio-caliber --strict` 通过
