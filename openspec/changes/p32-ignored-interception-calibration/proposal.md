# Proposal: ignored_interception 假阳性治理（detector 删除 + 引擎自洽硬门）

## Why

`ignored_interception_opportunity` detector 实测 **45% 假阳性**（issue #36），作为 realism_warning 已失去判别力。根因不是参数不准，而是**语义前提已过时**：post-#25 引擎拦截是**概率 roll**（贴防 7.5%、中距 4.5%、远距 2.0%，长传加成，cap 60%），而 detector 仍停在「防守者能跑到走廊就该拦」的**确定性可达**旧前提上——于是在绝大多数「防守者近、但引擎按真实足球没拦」的传球上报警。

更致命的是**可观测性缺口**（本 change 新增核实）：引擎有第二个开放比赛传球路径 `emit_forward_pass_highlight`（`CarrierExecution::ForwardPass`，`engine/src/lib.rs:3137`），它产 `result:"success"` 但**从不走拦截 roll**，且事件形状与普通成功传球**完全一致**（无 `pass_kind`、无 `detail`、无区分字段）。detector 无法从事件流区分「进入拦截 roll」与「从未 roll」的 pass——任何 audit 层的「预期 vs 实际拦截率」重建都会把 forward pass 混入分母，产生**结构性下偏**，在 N≥200 的 95% 置信区间下必假 `out_of_band`。

结论（grill 定稿，见 `.scratch/issues/36-ignored-interception-calibration-grill.md`）：**彻底删除 detector 的逐事件 warning**，把「预期 vs 实际拦截率」自洽硬门做进**引擎侧**（`engine/src/lib.rs` 的判定点记账 + `mod tests` 原生测试），audit 层只保留 pass_outcomes 的轻量分层（高球/长传/重开类型）作 L3 软参考。

## What Changes

- **删 detector**：`detectIgnoredInterception` + 旧 finding + `DEFAULT_AUDIT_PROFILE.ignored_interception` 块 + `reference_bands.ignored_interception_opportunity` + 字段契约 `ignored_interception_opportunity` 条目 + `DETECTOR_PROFILE_KEY` 映射 + `runAudit` 集成 + stats 条目全删。
- **引擎侧拦截自洽硬门**：在 `emit_pass_highlight_inner` 的拦截判定点记账（进入拦截 roll 的 pass 样本数、按距离桶的预期拦截数、实际拦截数），`mod tests` 原生断言 expected vs actual 落在统计置信区间内。不碰事件流、不耗额外 RNG、**golden-v5 不变**。
- **pass_outcomes 分层扩展（软门）**：`computePassOutcomes` 增加高球（`h`）/ 长传（`pass_distance`）/ 重开类型（`detail`）分层计数，用于复现或否定 issue body 的「高球标记率 85%」，不参与告警升级。
- **主 spec 同步**：diagnosis-runner 的「未标定 detector 告警降级」scenario 从 ignored_interception 改引用 player_overlap（同为 `calibrated:false`，避免引用已删除 detector）。
- **保留 derive 层字段**：`corridor_distance` / `defender_moved_toward_corridor` 作为可观测几何事实保留在 derive 层（未来防守反应研究用），仅删除 detector 的**消费**，不改 viewer 生产。

## Capabilities

### Modified Capabilities

- `match-engine`: 新增「拦截概率自洽硬门」——引擎侧逐桶 expected/actual 拦截率自洽（L1 规格一致性的拦截分支）。
- `diagnosis-runner`: 删除 `ignored_interception_opportunity` detector 的逐事件 warning；pass_outcomes 增加高球/长传/重开分层（软参考）；「未标定 detector 告警降级」scenario 引用改 player_overlap。

## Impact

- `engine/src/lib.rs`（`OpportunityTally` 加拦截记账字段 + `emit_pass_highlight_inner` 判定点记账 + `mod tests` 新自洽测试）
- `tools/detectors.mjs`（删 detector + `runAudit`/`aggregateAudit` 集成 + `computePassOutcomes` 分层）
- `tools/detectors.test.mjs`（删旧 detector 测试 + 新增分层测试）
- `tools/detector-field-contract.mjs`（删 `ignored_interception_opportunity` 条目）
- `tools/detector-field-contract.test.mjs`（删相关契约断言）
- 不碰 `viewer/`（corridor 字段保留）、不碰事件协议、**golden-v5 不变**

## 关联

- 修复 issue #36（ignored_interception_opportunity 45% 假阳性标定）
- grill 全稿：`.scratch/issues/36-ignored-interception-calibration-grill.md`（Q1 重定位 + Q2-Q10 全按 codex 推荐）
- 依赖 #29（字段契约权威）已定稿；本 change 不再依赖逐事件真值标注
