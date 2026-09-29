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

- [ ] 逐 episode 定义意图特征（如：起脚窗口是否开启/开启时刻/窗口内犹豫时长；防守方式分布；受压程度）
- [ ] 每条：定义 + 覆盖率 + 缺失原因分类
- [ ] **不得从位置反推意图**（那是 P16 已证不足的做法）

## Slice 4 — 重跑 phaseability gate

- [ ] 用「P16 空间特征 + 本 change 意图特征」重跑三档 AUC
- [ ] **与 P16 基线并列对照**（哪些改善了、哪些没有）
- [ ] **再净化一次混淆**（带反证条）
- [ ] 硬约束检查：不得把区域/坐标当阶段；几何代理须命名为证据

## Slice 5 — 裁决与产物

- [ ] **明确裁决**：够（三档谓词）或不够（点名缺什么 + 15B 处置）
- [ ] 产物：JSON + Markdown + provenance（沿用 P16 形态）
- [ ] 确定性测试（同输入两次逐字节相同）
- [ ] **代码审阅闭环**：独立只读 subagent 审阅 → 修复 → 再审阅 → 全过
      （⚠️ P16 的教训：**自查抓不到**——6 条假覆盖、3 条 P0 **无一条**由自查在提交前发现）

## 停止条件

- 新信号已接出且有守卫；
- 意图特征有定义/覆盖率/缺失分类；
- **gate 有明确裁决**（与 P16 基线对照）；
- 未越界（不改跑位/决策、不实现 15B、不碰 viewer/事件流协议）。
