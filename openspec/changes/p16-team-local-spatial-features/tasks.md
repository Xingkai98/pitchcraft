# P16 任务

## Slice 1 — 口径定死（先于任何数字）

- [x] 定义**位置口径**模块：episode 起点取 `control_established.location`；
      终点取同源的收束侧字段（**已定**：`t == end_t` 且带 `location` 的**最早**一条；
      回退取窗内最后一条带位置事实。见 `engine/tests/p16/caliber.rs` 的 `closing_fact`
      与 `OPEN-QUESTIONS.md` Q2）
- [x] 加**守卫**：断言不混用「决策动作 `Event.x`」当位置
      （`caliber_start_comes_from_control_fact_not_action_position` +
      `caliber_guard_has_discriminating_power`：在 `EpisodeCaliber` 上造变异体，
      断言两口径落在**不同推进带**——对目标变异有区分度）
- [x] 记录**门球放大器**：`goal_kick_land` 的落点区间（归一后 `[0.50, 0.82]`）
      + 门球占重开比例（`GOAL_KICK_RESTART_SHARE = 0.317`，本轮 100 seed 复现 1666/5258）
- [x] 口径写进产物 provenance（`CALIBER_VERSION`；完整 provenance 随 Slice 5 的产物落地）
- [x] 测试：口径守卫 + 反证条（**3 条定向变异实跑均红**，证据记在
      `engine/tests/p16/caliber.rs` 模块头）

**实测（100 seed / 10102 episodes）**：起点位置 100% 可得；终点位置 **86.8%** 可得
（不可得的 13.2% 按 `end_reason` 分解在 `CaliberCoverage.end_missing_by_reason`）；
两口径推进带分歧率 **25.7%**（复现侦察报告 §2 的 3 倍差）。

## Slice 2 — 静态特征接入（G1 已批准：引擎导出位置）

- [x] 引擎侧新增 `observe_state` 命令 + `DiagnosticMatch.state_snapshots` 字段
      （**只加字段/命令，不改 `ControlFact` 闭集、不改正式事件流**）
- [x] 采样点 = **`match_events` 的 `while t < dur { tick(...); }` 循环体内、`tick` 返回之后**
      （⚠️ **不是** `emit_beat_with_main`——实测 ≥16.7% 的拍不经它，且 34/5399 个 tick
      根本不产 beat，见 `POSITION-EXPORT-DESIGN.md` §2.4）。**拍 = tick，不是 beat**
- [x] `frozen` 取自 `st.highlight` 的 `participants`（**取 id 列**），语义 = 「本拍结束时
      仍活跃的高亮参与者」——在 **`tick` 返回之后**取（= finalize 之后，§2.4）
- [x] 实测：飞行期冻结者的位置由高亮**钉住**（结构保证：`commit_beat_positions_ex` 跳过
      其 `st.pos` 写回），故 `frozen` 的用途是「标记进行中的量」，**不是**「防陈旧」；
      成本 ≈ 0（全 5399 拍摊薄 0.233 人/拍；有高亮的 713 拍上 ≈1.76 人/拍）
- [x] 守卫：① `simulate()` 逐字节一致门仍绿（recorder 空操作）；
      ② **快照 = `st.pos` 逐位恒等**（G1 的核心承诺，须定向变异可红）；
      ③ **快照数 == tick 数**（≠ beat 数，seed 1：5399 vs 5365）；
      ④ `DiagnosticMatch` 三处构造点（`into_diagnostic_match` / P16 fixture / P17A `empty_dm`）
      同步更新（全字段字面量 → 漏改是编译错，非静默）
      —— 另有两处源码扫描守卫被本改动触发并已按其要求登记/改写：
      `RECORDER_READS` 加 `.state_snapshots()`、`p15_compaction_boundary_is_actually_registered`
      的锚点字符串不得出现在注释里（本 change 的注释一度含它，已改写）
- [x] 接入 `depth` / `width` / `cx`,`cy` / `spread` / `n`（Rust 侧 `tests/p16/shape.rs`，
      口径逐条对齐 `match-metrics.js`：剔门将 / 逐帧算再均值 / q10–q90 / 未排序配对）
- [x] 编码保持 `[(f64,f64); 22]`——**不得**改 `f32`/量化。
      **由两条守卫保证**：① `engine/src/observation.rs` 的 `StateSnapshot.pos` 类型即
      `[(f64,f64); 22]`（改 `f32` 是编译错）；② 逐位恒等由
      `state_snapshot_positions_match_the_beat_projection_bit_for_bit` 守——
      实测把 `observe_state` 的位置量化到 0.1 m → 该测试**红**。
      （`state_snapshots_are_per_tick_and_bit_identical` 只查条数/值域/时间轴，
      **不**抓有损编码——其 doc 已注明，避免误认覆盖。）
- [x] 报告每项的可算帧占比与 `unknown` 占比（`ShapeCoverage`：引擎侧实测 **100% 可算、0 缺失**）
- [x] 明确记录：`includeExtrapolated` / `MIN_OUTFIELD_PLAYERS` 在**引擎侧是空操作**
      （`shape.rs` 模块头 + 测试 `engine_shape_coverage_is_total_and_missing_reasons_stay_empty`）

## 产物纪律（本 change 新增）

- [x] **探针比较函数须对「比较失败」有区分度**（`NaN` 显式判红）+ **每张表写明对照两端**。
      来由：本 change 曾用 `.x`/`.y` 误用数组得 `NaN`，而 `NaN > max` 恒假 ⇒ 打出
      「`max|Δ| = 0.000000`」的**假证据**。
      - **NaN 判红**：`notes/probes/position-fidelity.mjs` 的 `compareFrames`
        对非有限距离 `throw`（逐点判，不是只判最大值）；
      - **跳过数与被比较数并列报**：探针现在明报四类跳过
        （非整秒帧 / 超 limitT / 重放侧无该时刻 / 单侧缺点），
        实测 seed 1：比 19668 点、跳过 21600+4500+7+0——「N 点通过」不再会被读成
        「大部分点通过了」；
      - **对照两端写明**：探针头注释与输出行都标 `A = beat-only 重放` /
        `B = viewer 渲染路径`；设计文档 §1 另把「vs 渲染路径」（可复现）
        与「vs 引擎真值 `st.pos`」（需插桩）**分列两栏**，并注明不可混引。

## Slice 3 — 时间关系特征（本 change 的实际工作量）

- [x] **球门向净推进**（按进攻方向归一化）——直接复用位置口径 `EpisodeCaliber::net_progress`
- [x] **推进 / 回撤 / 横向转移**（纵向横向分开；窗口 `WINDOW_SECONDS = 5.0`，
      以**球位**为参考点——为此 Slice 2 的快照补了 `ball` 字段）
- [x] **线间距变化**（`depth`/`spread` 的**最小二乘斜率**，非末减首）
- [x] **接应是否形成**（以**球位**为参考点，`≤25 m` 且进攻方向前方 `≥2 m`；见下缺口）
- [x] 每条：定义 + 覆盖率 + 缺失原因分类（`FeatureCoverage`；seed 1 实测窗口 >100、四条皆 >50% 覆盖）
- [x] 遵守时间基准纪律（同一特征不混 basis）：快照恒 `StateCommit`；
      **⚠️ 实测发现 episode 边界混 basis**（105 个 episode 里 `start_t`：
      `state_commit` 102 / `deterministic_flight_end` 2 / `event_emit` 1），
      已在测试里**显式打印并单独列出**（design §2.3 的处置），不是忽略

**已知缺口（记录在案，不冒充）**：见 `tests/p16/features.rs` 的 `FEATURE_LIMITATIONS`——
① `ball_pos` 在死球/重开期是**约定点**不是球位；② 接应判据纯几何，
不含「线路是否通畅」⇒ 它是**证据**（`SupportFormation`）不是战术意图判定；
③ `WINDOW_SECONDS` 是可调参数不是判据。

## Slice 4 — phaseability gate（验收）

- [x] 构造可判定性参考集（**不得只用区域构造**，否则循环论证）——
      三档纯动作链 motif（`final_third` / `build_up` / `progression`），
      每条子句逐条标注「是否用位置」；`reference_set` 的**源码扫描**守卫证明它不碰位置
- [x] 用特征跑三档可分性检验（秩基 AUC，**30 seed / 3075 episode**）
- [x] 产出**裁决**：**部分够**——只能判 `final_third`；`build_up`/`progression` 判不了。
      （⚠️ 初版「不够」建立在 join bug 上，已由独立审阅推翻并重算；详见下方「裁决」小节）
- [x] 硬约束检查：**不得**把区域/坐标当阶段——本 change **不产出任何** `Phase`，
      特征命名均为几何/证据（`TeamShape` / `DisplacementDecomposition` /
      `SupportFormation` / `LineSpacingChange`）

### 裁决：**部分够** —— 只能判 `final_third`

⚠️ **本裁决经两版作废，两版都错、原因不同**（第一轮审阅抓到 P0）：

| 版本 | 结论 | 错在哪 |
|---|---|---|
| v1 | 不够（AUC ≈0.5） | **join bug**：`all_refs` 用全局下标，`all_feats` 用逐场**本地**下标——seed 1 之后归属随机，AUC 被摊平到 0.5 |
| v2 | 不够 + 「1 seed 0.7–0.84 是**小样本误导**，30 seed 塌回 0.5」 | **机制讲反了**：根本没有「塌回」，逐 seed AUC 稳定在 0.6–0.86。0.5 是 join bug 的产物，v2 把 bug 的症状写成了统计学教训 |

**教训**：v2 的解释比 v1 的结论危害更大——它会把一个可修的 bug 固化成一条「小样本不可信」的方法论。

#### 修正 join 后的实测（30 seed / 3075 episode；300 seed 基线复现同向）

- **时长混淆必须先去掉**：`backward_m`/`forward_m` 是**累计**位移，随 episode 时长增长；
  各档时长中位数 `build_up` 78 s / `progression` 45 s / `final_third` 40 s。
- 去掉后（`forward_m/s`）：
  - `final_third` vs 其余 `forward_m/s` AUC **0.855**（30 seed）/ **0.862**（300 seed 基线）；
  - `build_up` vs `progression` `forward_m/s` AUC **0.461**（30 seed）/ **0.431**（300 seed 基线）。

  ⚠️ **两组数字的差别是 seed 数，不是文档漂移**（一度被我误标为「漂移」，已更正）：
  审计口径不同（30 seed vs 300 seed），**各自都对**。
  但**必须标明口径**——`gate.rs` 的裁决测试跑 **30 seed**、容差带 `|auc-0.5| ≤ 0.06`
  = `[0.44, 0.56]`；而 **300 seed 的 0.431 落在那条带之外**。
  故：**把产物里的 300 seed 数字抄进 30 seed 的测试期望值会红**——
  两个数字不可互换引用（本仓「口径必须先写明」的又一例）。

#### 给 15B 的处置

- **`final_third`**：有可执行判据的**候选**——但它是**几何证据，不是战术意图**。
  按契约，若 15B 用它，须命名为**证据**（如 `GoalwardProgressEvidence`），
  **不得复用 `Phase`**。
- **`build_up` / `progression`**：**保留 `unknown`**。当前观测不足以分开它们。
- **补什么**：需要能表达**意图**的观测（如射门窗口开启信号、防守方位置/线路），
  且须**去除 motif 定义里「传球次数」的混淆**（否则分开了也说不清是空间还是传球数）。



## Slice 5 — 产物与审阅

- [x] 特征定义文档 + 覆盖率报告 + 裁决（`tests/p16/report.rs` → `target/p16-baseline/*.md|json`；
      含四段：口径覆盖率 / 静态队形 / 时间关系 / phaseability 裁决 + 已知缺口清单）
- [x] 产物自带 provenance（`caliber_version` + `engine_source_fingerprint` +
      `sidecar_schema_fingerprint` + **`has_state_snapshots`** + seed 集 + 口径常量快照）
- [x] 确定性测试（`identical_inputs_produce_byte_identical_output`：同输入两次逐字节相同）
- [x] 产物落盘门（`p16_canary` 30 seed / `p16_baseline` 300 seed，均 `#[ignore]`）
- [x] **代码审阅闭环**：独立只读 subagent 审阅 → 修复 → 再审阅 → 全过。
      **7 个审阅轮次**（设计层 3 + 实现层 4），审阅者均为**新起的零上下文 subagent**
      （或同一 agent 续问、保留其自身上文）；另加**主 session 交付核验** 1 轮。
      抓到并修复：**3 条 P0**（采样点漏拍 / **join bug 使裁决算错、两版结论作废** /
      **参考集被位置污染**）、**6 条假覆盖**、1 条**错误机制**、1 条**过强保证**。
      完整记录（含 agent id 留痕）：`REVIEW.md`。

⚠️ **裁决因此改为「部分够」**（v1 的「不够」建立在 join bug 上，已作废）——
详见下节与 `REVIEW.md`。

## 交付前检查（本仓要求）

- [x] `cargo test` 全绿（199 / 11 / 36 / 24 / 4，另 14 ignored）
- [x] `openspec validate --all --strict` 13/13
- [x] `git diff --check` 干净
- [x] 未改 `viewer/`（`git diff main..HEAD -- viewer/` 为空）、未改事件流协议
- [x] `engine/src/` 无调试插桩（无 `DEBUG_`、无测试模块外的临时 `println!`）
- [x] 产物自带 provenance（含 `test_source_fingerprint` 补测试源码盲区）

## 停止条件

满足即止，不无限扩展：

- 口径已定且有守卫；
- 四类时间关系特征有定义、有覆盖率、有缺失分类；
- **phaseability 有明确裁决**（够或不够，均须证据）；
- 未越界（不改跑位/决策、不实现 15B、不新增生成行为）。
