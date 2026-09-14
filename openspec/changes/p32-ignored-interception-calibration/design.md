# Design: ignored_interception 假阳性治理

## 决策背景（grill 已定稿，全按 codex 推荐）

issue #36 的原始诉求是「校准走廊语义 + 收紧阈值 + 标定假阳性率」，但 grill 判定**调参救不了**——detector 的「确定性可达」前提与 post-#25 概率拦截引擎根本错位。定稿方向（见 `.scratch/issues/36-ignored-interception-calibration-grill.md`）：

- **Q1 重定位**：逐事件 realism_warning → 分布级自洽校准。
- **Q10 迁移**：detector 并入 `pass_outcomes`，停发旧 finding（不是降级壳）。

## 关键约束：audit 层无法精确重建拦截分母

引擎有**两个**开放比赛传球路径，事件流里不可区分：

| 路径 | 函数 | 走拦截 roll？ | 事件形状 |
|---|---|---|---|
| 普通传球 | `emit_pass_highlight_inner`（`engine/src/lib.rs:2701`） | ✅ 出界通道未命中后走拦截 → 传失 → 成功 | `result: success/intercepted/lost/out` |
| 向前推进传球 | `emit_forward_pass_highlight`（`engine/src/lib.rs:3137`） | ❌ 从不走拦截 roll | `result:"success"`，**与普通成功传球逐字段一致** |

`Event` struct（`engine/src/lib.rs:93`）无 `pass_kind`，ForwardPass 的 `shot_pending_after_pass` 是引擎内部状态、不进事件流。因此 audit 层（只读事件流）**无法**构造「进入拦截 roll 的无偏分母」：把 forward pass 混入会给它算一个非零 expected interception，却永远 +0 actual → 系统性下偏 → 假 out_of_band。

**决策：拦截自洽硬门放引擎侧**（判定点记账，原生全可见），audit 层只做软参考分层。这是本 design 的锚。

## D1：引擎侧拦截自洽硬门

### 记账点

在 `emit_pass_highlight_inner` 的拦截判定处（`engine/src/lib.rs:2806-2823`）记账。该点已拿到全部判定输入：`def_dist_m`（落点距离）、`meters`（传球距离）、`interception_p`（含长传加成、cap 60%）、`fail_roll`。ForwardPass 与重开传球（corner/throw_in/free_kick/goal_kick）**不走此函数**，天然被排除——记账点 = 精确的「进入开放比赛拦截 roll 的分母」。

### 精确整数 roll 量化（codex 复核发现）

引擎判定是 `fail_roll = rng.next_u64() % 100; if (fail_roll as f64) < interception_p`。`interception_p = 7.5` 时命中 `fail_roll ∈ {0..7}` = **8%**，不是 7.5%。故预期拦截数必须用**整数 roll 命中宽度** `ceil(interception_p)`（以「roll 值个数」为单位）累加，不得直接拿浮点常量 ÷ 100：

- 7.5 → 8；4.5 → 5；2.0 → 2；7.5+7=14.5 → 15；… cap 60.0 → 60。

### 分桶

按引擎自身的拦截距离分档（与 `INTERCEPT_D_TIGHT_M=6.0` / `INTERCEPT_D_MID_M=12.0` 一致）：`≤6m` / `6-12m` / `>12m`。长传加成（`>22m` +7、`>35m` +8）作为交叉分层，或直接并入「落点距离桶 × 长传档」的组合桶（实施时定，须覆盖 60% cap 边界）。

### tally 字段（`OpportunityTally` 扩展）

```rust
// 拦截自洽硬门（#36）：只统计进入开放比赛拦截 roll 的 pass（emit_pass_highlight_inner 判定点）
intercept_roll_samples: u64,                    // 进入 roll 的 pass 总数
intercept_roll_expected: u64,                   // Σ ceil(interception_p)（roll 值个数单位）
intercept_roll_actual: u64,                     // 实际 intercepted 数（roll 值个数单位）
// 分桶（落点距离）
intercept_bucket_samples: [u64; 3],             // ≤6m / 6-12m / >12m
intercept_bucket_expected: [u64; 3],
intercept_bucket_actual: [u64; 3],
// 长传加成交叉分层（>22m / >35m），用于守护长传加成接线
intercept_long_expected: u64,
intercept_long_actual: u64,
intercept_very_long_expected: u64,
intercept_very_long_actual: u64,
```

### 自洽测试（`mod tests` 内，紧邻 `p28_action_opportunity_is_live`）

`#[test] fn p32_interception_self_consistency()`（跑 20 seed × 5400s，或 200 seed 若需样本量——按实测拦截样本定，贴防桶需 N 足够）：

1. **接线守卫**：`intercept_roll_samples > 0`、`intercept_roll_actual > 0`、各桶 samples > 0（换回旧路径 / 记账被删 → 归零 → 红）。
2. **逐桶自洽**：每个距离桶 actual 落在 expected 的 95% 置信区间内（Poisson-binomial 用正态近似：`expected ± 1.96·sqrt(expected·(1−p̄))`，或更稳的 Wilson/精确区间，实施时定公式并注释）。样本不足桶记 `insufficient_sample` 而非失败，但主要桶（≤6m）必须达到最小样本。
3. **长传加成接线**：`>22m` 桶 expected 相对「无加成」基线更高，且 actual 与 expected 自洽——守护 `LONG_PASS_INTERCEPT_BONUS` 不被误删。
4. **cap 边界**：极端贴近场景 `interception_p` 达到 60 时 expected 记 60（不是 60.0 浮点漂移）——用单元级构造（直接调判定纯函数或断言 `ceil` 语义）钉死。

### golden 不变的理由

记账只写 `OpportunityTally`（不进事件流、不调 `rng.next_*`），故事件流逐字节不变 → `golden-v5` 不变。插入位置**必须**在 `fail_roll = rng.next_u64() % 100` 之后（记账读 `interception_p` 与 `fail_roll`，自身零 RNG），且不得改变任何 `rng` 调用顺序。

## D2：detector 侧彻底删除（不是降级）

删除清单（codex 复核结论「彻底删，不留 deprecated 壳」）：

1. `tools/detectors.mjs`：
   - `detectIgnoredInterception` 函数（line 690-743）
   - `DEFAULT_AUDIT_PROFILE.ignored_interception` 块（line 32-40）
   - `DEFAULT_AUDIT_PROFILE.aggregation.reference_bands.ignored_interception_opportunity`（line 74）
   - `DETECTOR_PROFILE_KEY.ignored_interception_opportunity`（line 100）
   - `runAudit` 里 `interceptionFindings` 集成（line 855, 862-864, 885-888）
2. `tools/detector-field-contract.mjs`：`ignored_interception_opportunity` 条目（line 86-109）
3. `tools/detectors.test.mjs` / `tools/detector-field-contract.test.mjs`：所有 `ignored_interception` 相关用例（含 `defender_moved_toward_corridor` 探测器测试）

**保留**（不改 viewer 生产）：
- `viewer/derive-audit-features.js` 的 `corridor_distance` / `defender_moved_toward_corridor` 派生（可观测几何事实，未来防守反应研究用；无 detector 消费 ≠ 契约断裂，契约只断言「detector 读的字段有生产者」）。
- `viewer/observation.test.js` / `viewer/derived-audit.test.js` 的 corridor 断言（它们测 derive 层生产，不测 detector 消费）。

## D3：pass_outcomes 分层扩展（软参考，不升级告警）

`computePassOutcomes`（`tools/detectors.mjs:764`）在现有 pressure×outcome 分桶外，增加**软分层**（用于复现/否定「高球标记率 85%」，不进 `aggregateAudit` 的 band 升级）：

- 高球分层：`h > 0`（引擎 `pass_h`：>20m 才 h>0，`engine/src/lib.rs:2923`）vs `h == 0`
- 长传分层：`pass_distance > LONG_PASS_M`（22m）
- 重开类型分层：`detail ∈ {corner, throw_in, free_kick, goal_kick, clearance}`（复用 `exclusionTokensOf` 的排除契约）

输出形状：现有 `{unpressured, pressured, unknown_pressure, excluded}` 保持兼容（`mergePassOutcomes` 只 sum 已知键），新增 `strata: { high_ball: {...}, long_pass: {...}, restart_type: {...} }`，各层只记 sample/out/success/intercepted 计数。**不改** `mergePassOutcomes` 的现有键、不改 band 逻辑、不产生 finding。

## D4：主 spec 同步

- `match-engine` ADDED：拦截概率自洽硬门 requirement（含「整数 roll 量化」「分桶自洽」「长传加成接线」「golden 不变」scenario）。
- `diagnosis-runner` MODIFIED：「未标定 detector 告警降级」scenario 的 GIVEN 从 `ignored_interception` 改 `player_overlap`（同为 `calibrated:false`，机制测试不再绑定已删 detector）。

注意（issue #57 教训）：主 spec `diagnosis-runner` 里**不存在**「检测可拦截传球」requirement（它在 p10 未归档的 match-audit delta 里），故**不需要** REMOVED delta——避免 phantom header。

## 验证

- `cargo test`（引擎侧新自洽测试 + 既有全套，golden-v5 不变）
- `cd viewer && node --test *.test.js` + `node --test ../tools/*.test.mjs`（detector/契约/derive 全绿）
- `npx openspec validate --all --strict`
- `./verify.sh` 全绿（含 WASM e2e + realism 套件）
- 审阅闭环：独立零记忆 subagent 审阅 → 修复 → 再审至无遗留
