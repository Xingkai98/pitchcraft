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
- [ ] 编码保持 `[(f64,f64); 22]`——**不得**改 `f32`/量化（那会破坏「逐位恒等」这条 G1 的立身之本）
- [x] 报告每项的可算帧占比与 `unknown` 占比（`ShapeCoverage`：引擎侧实测 **100% 可算、0 缺失**）
- [x] 明确记录：`includeExtrapolated` / `MIN_OUTFIELD_PLAYERS` 在**引擎侧是空操作**
      （`shape.rs` 模块头 + 测试 `engine_shape_coverage_is_total_and_missing_reasons_stay_empty`）

## 产物纪律（本 change 新增）

- [ ] **探针比较函数须对「比较失败」有区分度**（`NaN` 显式判红）+ **每张表写明对照两端**。
      来由：本 change 曾用 `.x`/`.y` 误用数组得 `NaN`，而 `NaN > max` 恒假 ⇒ 打出
      「`max|Δ| = 0.000000`」的**假证据**。可复现探针：`notes/probes/position-fidelity.mjs`

## Slice 3 — 时间关系特征（本 change 的实际工作量）

- [ ] **球门向净推进**（按进攻方向归一化）
- [ ] **推进 / 回撤 / 横向转移**（纵向横向分开；须定窗口长度）
- [ ] **线间距变化**
- [ ] **接应是否形成**（距离/角度阈值待定）
- [ ] 每条：定义 + 覆盖率 + 缺失原因分类
- [ ] 遵守时间基准纪律（同一特征不混 basis），跨 basis 的显式标注

## Slice 4 — phaseability gate（验收）

- [ ] 构造可判定性参考集（**不得只用区域构造**，否则循环论证）
- [ ] 用特征跑三档可分性检验
- [ ] 产出**裁决**：够（给谓词）或不够（明确缺什么 + 15B 的降级路径）
- [ ] 硬约束检查：**不得**把区域/坐标当阶段；若只能用几何代理，命名须为证据而非 `Phase`

## Slice 5 — 产物与审阅

- [ ] 特征定义文档 + 覆盖率报告 + 裁决（含证据与回放定位）
- [ ] 产物自带 provenance（口径版本 + 引擎源码指纹 + seed 集）
- [ ] 确定性测试（同输入两次运行逐字节相同）
- [ ] **代码审阅闭环**：独立只读 subagent 审阅 → 修复 → 再审阅 → 全过

## 停止条件

满足即止，不无限扩展：

- 口径已定且有守卫；
- 四类时间关系特征有定义、有覆盖率、有缺失分类；
- **phaseability 有明确裁决**（够或不够，均须证据）；
- 未越界（不改跑位/决策、不实现 15B、不新增生成行为）。
