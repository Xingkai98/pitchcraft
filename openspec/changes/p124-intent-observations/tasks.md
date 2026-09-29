# P124 任务

## Slice 1 — 前置：重新净化 motif 混淆（**先于任何新信号**）

- [x] 在 P16 的 gate 上重跑净化（30 seed，`forward_m/s`）：抽掉「是否重开」/「抽掉传球数」/ 空对照
- [x] **带反证条**：同管线先跑 `final_third`（已知 ≈0.855），证明探针没坏
- [x] 记录：P16 的裁决在净化下是否仍成立（预期 0.437 / 0.490 / 0.500）
- [x] 遵守探针纪律（design §4）：NaN 判红 / 报跳过数 / **不 `flatten`**（索引空间一致）

### Slice 1 实测（30 seed / 3075 episode，`forward_m/s`；见 `tests/p124/`）

| 臂 | 抽掉了什么 | 实测 AUC | build / prog | 集内跳过 |
|---|---|---|---|---|
| `current`（P16 原定义） | — | **0.461** | 476 / 851 | 0 |
| `drop_restart` | 是否重开 | **0.469** | 903 / 1784 | 0 |
| `drop_passcount` | 传球数 | **0.490** | 1232 / 1017 | 1 |
| `empty_control` | 两个都抽 | **0.500**(+1.2e-5) | 2249 / 2249 | 1 |
| **反证条** `final_third` vs 其余 | — | **0.855** | 541 / 2531 | 3 |

⇒ **P16 的裁决在净化下仍成立**：抽掉「是否重开」后 0.469、抽掉「传球数」后 0.490，
两者都仍在 `[0.44, 0.56]` 内 ⇒ **「分不开」不是这两个混淆造成的假象**。
本 change 的数字与 P16 tasks.md 记的主 session 复现（0.437 / 0.490 / 0.500）同向、
**不是逐位相同**（那次未落成可复跑断言，口径细节不可考；本表是本 change 的权威值）。

### 探针纪律的落点（design §4，逐条）

| 纪律 | 落在哪 | 判别力怎么证的 |
|---|---|---|
| NaN/非有限**显式判红** | `probe.rs::require_finite`（**逐值**挂在 `rate_auc` 上） | `probe_rejects_non_finite_and_never_hides_skips` 喂 NaN/Inf 必须 panic；正常值不 panic |
| 报「跳过几个 / 比较几个」 | `RateAuc{pos_n,neg_n,skipped_missing,skipped_in_set}` | 同上测试逐项打印；`require_clean` 断言集内跳过为 0 |
| **参考集与特征同一索引空间**（**禁 `flatten`**） | `probe.rs::Pooled`：`feats`/`facts` 同长同索引 + 构造断言 | `pool_rejects_index_space_mismatch` 喂错位形态必须 panic |
| **反证条** | `counter_proof_final_third` | `counter_proof_confirms_the_probe_is_intact`（复现 0.855 ±0.05） |
| 谓词不得与 P16 分叉 | `purify.rs::motif_pred` | `motif_predicates_agree_with_the_p16_reference_set` 逐位比对 |

### ⚠️ 探针实测发现（**本 change 的探针在 Slice 1 抓到的东西**）

**空对照的 AUC 不是「恰好 0.5」，是 0.5 + 1.2e-5**：P16 的 `auc` 带一个
**不对称的并列容差**（`|p−n| < 1e-12` 记 0.5，否则记 1/0）——两个**不同** episode 的
取值相差 `< 1e-12` 时，`(x,y)` 判胜、`(y,x)` 判并列，对称对的抵消被打破。
实测验算：`gt = 2525528`、`lt = 2525405`（差 **123** = 无序近并列对数）、
`n = 2248` ⇒ 残差 `0.5 × 123 / 2248² = 1.22e-5`。近并列值来自
`forward_m / duration_s` 的浮点除法。

⇒ 判据因此**不是**「恰好 0.5」，而是**结构性的「两侧取值逐位相等」**（不受容差影响）
+ 数值性兜底 `|AUC−0.5| ≤ 1e-3`。**若当初照抄「必须恰好 0.5」，
这条守卫会因一个与偏置无关的浮点细节永久变红**——那是把探针的口径当成了被检验的偏置。

## Slice 2 — 接出意图信号

- [x] 读代码定死 `pressure_state` 的语义（design §6.2）
- [x] 决策粒度（design §6.1）：逐 tick 全记 vs 变化时记——写进 design 并给理由
- [x] recorder 新增只读命令（传值语义，保持「不引用 `MatchState`」）
- [x] 接出：`shot_setup` 的 `in_window`/`window_ticks`/`drive_ticks_left`/`committed`/`entry_pressure_bucket`
- [x] 接出：`DefensiveAction` 类型 + 持球者压迫
- [x] 守卫：`simulate()` 逐字节一致门仍绿；不改 `ControlFact` 闭集；无调试桩

### Slice 2 落地形态（`observation.rs` 新增，`lib.rs` 只加提交点）

| 新增 | 粒度 | 内容 |
|---|---|---|
| `IntentState` / `IntentSnapshot` | 逐 tick（与 `StateSnapshot` 同拍） | `has_shot_setup` / `in_window` / `window_ticks` / `drive_ticks_left` / `committed` / `entry_pressure_bucket` / `pressure_state_ticks` |
| `DefensiveIntentKind` / `DefensiveIntent` | **稀疏**（每个被执行的机会一条） | `Tackle`/`Foul`/`Contain`/`Jockey`/`None` + `defender: Option<i32>` |

- **`DefensiveIntentKind` 是新的公开闭集**，不是复用引擎私有的 `DefensiveAction`
  （后者是决策层实现细节，直接暴露会让改名破 sidecar 契约）。
  映射函数 `defensive_kind_of` 用**穷尽 `match`**（无 `_ =>`）⇒ 决策层加成员即编译失败。
- **`IntentState` 不在此归一** `pressure_state_ticks`（原始倒计时 tick 数传出去，见 design §6.2）。
- **`RECORDER_READS` 同步登记** `.intent_snapshots()` / `.defensive_intents()`
  （12 → 14），否则 P15 的「lib.rs 不得读观察状态」反向覆盖守卫会漏抓新读方法。

### Slice 2 的守卫与定向变异（**实跑均红**）

| 定向变异 | 抓它的测试 |
|---|---|
| 删掉 `observe_intent` 的 `if !self.enabled { return; }` | `intent_export_never_enters_the_formal_path`（空操作契约条） |
| 只在有起脚序列时提交意图快照（两通道错位） | `intent_export_is_tick_aligned_with_positions` + `intent_semantics_are_pinned` + `defensive_intents_are_sparse_and_well_formed` |
| `Tackle`/`Foul` 映射互换 | `contact_intents_match_the_event_stream`（**独立来源**交叉核对） |
| `no_shot_setup` 置 `in_window = true`（混判别位） | `intent_semantics_are_pinned` |

⚠️ **`contact_intents_match_the_event_stream` 的来由**：前三类测试对「闭集内部互换」无感
（分类仍穷尽、`defender` 语义仍成立）。接触动作**必产事件**（`tackle`/`foul`），
故用**事件流这一独立来源**核对计数——实测 seed 1/2/3 逐条相等（29/28/33、19/10/24）。
`contain`/`jockey` **不产事件**（P30 D5），结构上无从与事件流核对，如实记录不冒充。

### Slice 2 实测发现（**已知缺口，记录在案**）

**`committed` 在逐拍采样点上不可观测**（seed 1..=5 全 0）。机制：`shot_window_plan` 的
提交分支是 `st.shot_setup = None;` **紧接** `execute_action_resolution`——提交与序列销毁
**同一 tick**，而采样点在 `tick()` 返回之后。⇒ 下游**不得**用它构造意图特征。
由 `committed_is_not_observable_at_the_per_tick_sampling_point` 钉住（引擎若改提交时序
它会红，届时须同步更新文档）。

## Slice 3 — 意图类特征

- [x] 逐 episode 定义意图特征（如：起脚窗口是否开启/开启时刻/窗口内犹豫时长；防守方式分布；受压程度）
- [x] 每条：定义 + 覆盖率 + 缺失原因分类
- [x] **不得从位置反推意图**（那是 P16 已证不足的做法）

### Slice 3 特征清单（`tests/p124/intent.rs`，30 seed / 3075 episode）

| 特征 | 定义 | 覆盖率 | 缺失原因 |
|---|---|---|---|
| `window_opened` | episode 内是否出现过起脚窗口（`in_window` ≥1 拍） | 全可算 | 无（bool；判别力前提 = 有有效拍） |
| `window_share` | `in_window` 拍数 / 有效拍数 | **1.000** | 无有效拍（4 例） |
| `setup_share` | `has_shot_setup` 拍数 / 有效拍数 | **1.000** | 无有效拍（4 例） |
| `first_window_frac` | 首次进窗的归一化时刻 `(t−start)/(end−start)` | 0.171 | 未开窗或时长为 0（2550 例） |
| `max_window_ticks` | `window_ticks` 最大值（窗口内**犹豫**时长） | 0.171 | 未开窗（2550 例） |
| `pressure_share` | `pressure_state_ticks > 0` 拍数 / 有效拍数 | **1.000** | 无有效拍（4 例） |
| `pressure_mean` | `pressure_state_ticks` 逐拍均值（**未归一**） | **1.000** | 无有效拍（4 例） |
| `def_per_s` | 防守机会数 / 时长（**累计量须归一**） | 1.000 | 时长不可得或为 0（1 例） |
| `def_share[*]` | 五类防守动作占该 episode 机会的比例 | 0.969 | **无机会（94 例）→ `None` 不是 0** |

### Slice 3 的**类型隔离**（铁律的落点，不是风格选择）

`match_intents` **不接收 `DiagnosticMatch`**，只收三个无位置切片
（`&[IntentSnapshot]` / `&[DefensiveIntent]` / `&[PossessionEpisode]`）——
position 只活在 `dm.state_snapshots`，故意图特征及其**任何** helper（无论定义在哪）
**结构上够不着位置**。这是 P16 最终采用的类型隔离做法（文本扫描做不到——见
`p16/reference.rs`）。文本扫描（`intent_features_cannot_reach_positions`）只作回归下限。

### Slice 3 的定向变异（**实跑均红**）

| 定向变异 | 抓它的测试 |
|---|---|
| `match_intents` 改收 `DiagnosticMatch`（破类型隔离） | `intent_features_cannot_reach_positions` |
| 逐 tick 通道去掉时间下界 `>= start` | `intent_features_share_the_index_space_with_calibers` + `intent_feature_coverage_is_reported` |
| 稀疏通道改为**按下标**过滤（`i % 3`） | `defensive_intents_are_attributed_by_time_window_not_by_index` |

⚠️ **第 3 条是变异测试逼出来的缺口**：最初我以为「无机会 → None」+ 下标空间两条测试
覆盖了防守通道——**实测该变异全套 16 条仍绿**。⇒ 补写按时间窗归因的守卫
（含闭区间边界与**窗外动作 = `Some(0.0)` 而非 `None`** 的语义区分）。

### ⚠️ 首版守卫被自己判红两次（记录，不掩盖）

1. `intent_features_cannot_reach_positions` 的文本扫描**没剥注释** ⇒
   `intent.rs` 文档里为解释纪律而写的 `StateSnapshot` 被当成违规代码。
   （修：先剥 `//` 之后的全部内容——与 P15 守卫同法。）
2. 同一条扫描用 `.pos` 作 token ⇒ **命中 `Iter::position(`**（实测 2 处误报）。
   （修：改用无歧义的 `pos[`。）
3. `defensive_intents_are_attributed_by_time_window_not_by_index` 首版把窗外动作
   期望成 `None` ⇒ 被自己判红。正确语义是 **`Some(0.0)`**（「有机会但 0 次是该动作」）；
   `None` 在本模块专表「**没有机会**」。这条区分本身是缺失语义的一部分，已写进断言。

## Slice 4 — 重跑 phaseability gate

- [x] 用「P16 空间特征 + 本 change 意图特征」重跑三档 AUC
- [x] **与 P16 基线并列对照**（哪些改善了、哪些没有）
- [x] **再净化一次混淆**（带反证条）
- [x] 硬约束检查：不得把区域/坐标当阶段；几何代理须命名为证据

### 重跑结果（30 seed / 3075 episode；`tests/p124/phasegate.rs`）

**`final_third` vs 其余**（P16 基线 `forward_m/s` = 0.855 已复现）：

| 特征 | AUC | 种类 |
|---|---|---|
| `forward_m/s[空间]`（P16 最强） | **0.855** | 空间 |
| `window_opened` / `window_share` / `setup_share` | **0.966** | 意图 |
| `first_window_frac` | 0.850 | 意图 |
| `def_none[循环·仅对照]` | 0.934 | **循环**（见下） |
| `def_per_s` | 0.694 | 意图 |
| 其余意图特征 | 0.28–0.69 | 意图 |

**`build_up` vs `progression`**（P16 基线 `forward_m/s` = 0.461 已复现）：

| 特征 | AUC | 样本 |
|---|---|---|
| `forward_m/s[空间]`（P16 基线） | 0.461 | 476 / 851 |
| **全部样本充足的意图特征** | **0.449–0.546**（\|Δ\| ≤ **0.06**） | 476 / 851 |
| `first_window_frac` / `max_window_ticks` | 0.281 / 0.375 | **pos=4 neg=8 → 不作证据** |

⇒ **意图信号救不了 `build_up` / `progression`**。这是本 change 对 P16 裁决的**确认**（非推翻）。

### ⚠️ 循环性发现（本 change 实测，**必须读**）

`def_none`（防守方「无动作」比例）对 `final_third` 的 AUC 高达 **0.934**——
**但它是循环的**：起脚窗口内 `committed` 的 tick，`evaluate_defensive_action` 的
不可回溯守卫直接返回 `DefensiveAction::None`。实测 seed 1/2/3：**射门 tick 上的防守意图
21/21、21/21、14/14 全是 `none`**。⇒ `def_none` 与参考集谓词 `ends_shot` **机制同源**，
AUC 是同义反复。已标注 `[循环·仅对照]`，**不得**作为判别力证据。
由 `def_none_signal_is_mechanically_tied_to_shots` 钉住机制。

### ⚠️ 一次**假发现**被样本量门槛拦下（本 change 的关键纪律）

`first_window_frac` 在 build_up vs progression 上算出 AUC = **0.281**（\|Δ\|=0.219），
看着像「意图特征分开了这两档」。**但 pos=4 / neg=8 只有 12 个样本**——
AUC 标准误差 ≈0.184，0.219 不到 1.2σ，**纯噪声**。
根因：该特征只在**开窗**的 episode 上可算，而这两档定义就含 `!has_shot`，几乎从不开窗。

⇒ 新增**逐行**样本量门槛（`MIN_SIDE_FOR_SEPARABILITY = 50`，`GateRow::is_adequately_sampled`）：
不足的行**不作证据，但必须打印**（不静默跳过）。定向变异证明它承载判据
（门槛设 0 ⇒ 两条测试当场红）。

⚠️ **与 P16 的「小样本不可信」教训不同，别混**：P16 的 v2 是**用「小样本」解释一个 join bug
的症状**（AUC 其实稳定在 0.6–0.86，根本没「塌回 0.5」）。本条不是在解释异常，
而是**在断言之前先问样本够不够**——结论是「这条特征在两档间几乎没有样本，
故它**两种结论都得不出**」。

### Slice 4 的定向变异（**实跑均红**）

| 定向变异 | 抓它的测试 |
|---|---|
| intent 数组与 feats 下标错位（`+1`） | `gate_rerun_and_p16_baseline_side_by_side` + `purification_over_intent_features_reproduces_the_verdict` |
| 样本量门槛设 0（取消门槛） | 同上两条（**门槛本身承载判据**） |

### 硬约束检查

- **不得把区域/坐标当阶段**：本 change **不产出任何** `Phase`；意图特征命名均为
  观测语义（`window_*` / `pressure_*` / `def_*`），空间侧沿用 P16 的 `[空间]` / `[区域量·仅对照]` 标注；
- **几何代理须命名为证据**：本 change 未新增任何几何代理；
- 空间侧的 8 条与 P16 的 `separability` **逐条同输出**（`spatial_rows_match_the_p16_separability` 守）。

## Slice 5 — 裁决与产物

- [x] **明确裁决**：够（三档谓词）或不够（点名缺什么 + 15B 处置）
- [x] 产物：JSON + Markdown + provenance（沿用 P16 形态）
- [x] 确定性测试（同输入两次逐字节相同）
- [ ] **代码审阅闭环**：独立只读 subagent 审阅 → 修复 → 再审阅 → 全过
      （⚠️ P16 的教训：**自查抓不到**——6 条假覆盖、3 条 P0 **无一条**由自查在提交前发现）

### 裁决（**不够** —— 意图信号未能判 `build_up` / `progression`）

| 档 | 裁决 | 依据 |
|---|---|---|
| `final_third` | 可判（**仍是几何证据**） | P16 的 `forward_m/s` = 0.855 复现；意图侧 `window_opened`/`setup_share` 0.966（但见循环条），`first_window_frac` 0.850 |
| `build_up` / `progression` | **不够** | 全部**样本充足**的非循环意图特征落在 **0.449–0.546**（\|Δ\|≤0.06）⇒ 与随机无异 |

**给 15B 的处置**：
- `final_third`：有候选判据（`forward_m/s`），但它是**几何证据不是战术意图**。
  若 15B 用它，须命名为**证据**（如 `GoalwardProgressEvidence`），**不得复用 `Phase`**；
- `build_up` / `progression`：**保留 `unknown`**。空间 + 意图**都**不足——
  本 change 的裁决是 P16「部分够」的**确认**（补了意图维度后仍不够），不是推翻。

### 产物（`target/p124-intent/`，`#[ignore]` 门产出；gitignored）

- `canary.{md,json}`（30 seed，`p124_canary`）/ `baseline.{md,json}`（300 seed，`p124_baseline`）；
- provenance（**沿用 P16 形态**）：`source_commit` / `engine_source_fingerprint` /
  `sidecar_schema_fingerprint` / `has_intent_snapshots`（**活探测**）/ seed 集 / 口径常量快照 /
  **`test_source_fingerprint`**（哈希本 change 的源码 + 只读复用的 P16 模块）；
- ⚠️ **P16 的教训逐条继承**：`strip_suffix('}')`（不是 `trim_end_matches`）+
  `merge_into_object` 的 base 断言 + 落盘 JSON 结构校验 + `source_commit` **不要求 == HEAD**
  （那是自失效的），只断言「40 位 hex 且是 HEAD 的祖先」并**显式 match git 的三种退出码**。

### Slice 5 的定向变异（**实跑均红**）

| 定向变异 | 抓它的测试 |
|---|---|
| `merge_into_object` 换回 `trim_end_matches('}')`（P16 缺陷 1 形态） | `merge_into_object_strips_exactly_one_brace` |
| `best_intent_for_build_vs_prog` 去掉样本量过滤 | `verdict_best_intent_row_is_adequately_sampled`（**变异逼出的缺口**，见下） |

⚠️ **第 2 条是变异测试逼出来的缺口**：我最初以为样本量门槛 + 裁决测试已覆盖产物里的裁决行。
**实测删掉 `best_intent` 的过滤后，全套 27 条只有一条偶然变红**（落盘产物陈旧——是副作用，
干净树上会**静默通过**）。而该变异会让产物写出**自相矛盾的裁决行**：
「最强意图特征 AUC = 0.281 —— 落在 [0.44,0.56] 内」（0.281 那条只有 12 个样本）。
⇒ 补写 `verdict_best_intent_row_is_adequately_sampled` 直接钉住「最强行必须样本充足」。

## 停止条件

- 新信号已接出且有守卫；
- 意图特征有定义/覆盖率/缺失分类；
- **gate 有明确裁决**（与 P16 基线对照）；
- 未越界（不改跑位/决策、不实现 15B、不碰 viewer/事件流协议）。
