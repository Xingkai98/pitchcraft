# Tasks: ignored_interception 假阳性治理

## P1. 引擎侧拦截自洽硬门

- [x] P1.1 `OpportunityTally` 加拦截记账字段（样本/预期/实际 + 距离桶 3 + 长传 2 层 + 桶×长传交叉分层）
      — 新增 `intercept_roll_{samples,expected,actual}`、`intercept_bucket_{samples,expected,actual}[3]`、
      `intercept_long_*`、`intercept_very_long_*`、`intercept_bucket_long_*[3]`、`intercept_bucket_very_long_*[3]`。
- [x] P1.2 `emit_pass_highlight_inner` 判定点记账（`fail_roll` 之后，零 RNG，整数 roll 宽度 `ceil(interception_p)`）
      — 抽出纯函数 `open_play_interception_p`（值不变）+ `interception_roll_width`（`ceil`）+ 
      `interception_distance_bucket`；记账 `note_interception_roll` 严格在 `fail_roll` 之后、分支之前，
      零 `rng.next_*`、零事件流写入。新增具名常量 `INTERCEPT_P_CAP = 60.0`（替换 `min(60.0)` 字面量）。
- [x] P1.3 `mod tests` 新增 `p32_interception_self_consistency`（接线守卫 + 逐桶 95% CI + 长传加成接线 + cap 边界）
      — 另加纯函数测试 `p32_interception_roll_width_quantizes_by_ceil`（7.5→8/4.5→5/2.0→2/cap 60→60）。
      200 seed：三桶样本 23955/45536/1229（均 ≥ 200），逐桶 95% CI 全过；长传加成逐常量杀死
      （MUT2 删 LONG → 红、MUT3 删 VERY_LONG → 红、MUT1 ceil→truncation → 红、MUT4 删记账 → 红）。
- [x] P1.4 确认 golden-v5 不变（事件流零变化）— `cargo test --test realism` 全绿（`gm_canary_seeds` 哈希一致）。

## P2. detector 彻底删除

- [x] P2.1 `tools/detectors.mjs` 删 `detectIgnoredInterception` + profile 块 + band + 映射 + runAudit 集成 + stats
      — 另删 `DEFAULT_AUDIT_PROFILE.ignored_interception`、`reference_bands.ignored_interception_opportunity`、
      `DETECTOR_PROFILE_KEY.ignored_interception_opportunity`、`runAudit` 的 `interceptionFindings`
      集成与 stats 条目。`detectIgnoredInterception` 无其他消费者（grep 确认）。
- [x] P2.2 `tools/detector-field-contract.mjs` 删 `ignored_interception_opportunity` 条目
      — 同时把 `pass_outcomes` 的 reads 补上 `h` / `pass_distance`（P3 软分层读的字段）。
- [x] P2.3 删 `tools/detectors.test.mjs` / `tools/detector-field-contract.test.mjs` 相关用例
      — 未标定降级机制的回归样本改用 player_overlap；`ignored_interception` 严格 `<` 方向守卫
      换成新分层的 `LONG_PASS_M` 严格 `>` 方向守卫；golden 签名删 6 行 `ignored_interception_opportunity`；
      扫描器自检的 `corridor_distance` 锚点换成现存解构读取；新增「删了不再产 finding」守卫。
      **保留**（不变）：无。
- [x] P2.4 确认 viewer derive 层 `corridor_distance`/`defender_moved_toward_corridor` 生产保留、测试保留
      — `viewer/derive-audit-features.js` 未改（生产保留）；`derived-audit.test.js` 的 derive 层
      corridor 断言保留，只删了 detector 端到端消费用例；`observation.test.js` 全绿。

## P3. pass_outcomes 分层扩展（软参考）

- [x] P3.1 `computePassOutcomes` 加 strata：高球（h）/ 长传（pass_distance>22m）/ 重开类型（detail）
      — `strata: { high_ball, low_ball, long_pass, short_pass, restart_type, open_play }`，
      分层在排除判定**之前**累计（否则 restart_type 层在排除后为空）。`LONG_PASS_M = 22.0`
      与引擎常量同值。
- [x] P3.2 各层记 sample/out/success/intercepted，不进 band 升级
      — 每层记 sample/out/success/**intercepted**/lost/unknown_outcome；`classifyPassOutcome`
      新增识别 `intercepted`/`lost`（此前落 unknown_outcome）。`mergePassOutcomes` 只**加** strata
      键（既有四桶 + total 不变），缺失 strata 按零计（旧 report 兼容）。分层不产 finding、不进 band。
- [x] P3.3 新增分层测试（含「高球 85%」复现与否的对照数据）
      — 新增 5 个用例（分层归类 / 缺失字段不伪造 / 不影响 pressure 桶与 finding / 跨 seed 合并
      确定性 / 旧 report 无 strata 兼容）。**「高球 85%」复现结论**：真实 fixture 仅 6 条 pass
      （h>0 者 1 条），样本远不足以复现或否定 85%——登记为后续标定任务（需真实多 seed 全 90min
      bundle），本轮只提供分层机制与对照口径。见 reviews/review.md。

## P4. 主 spec 同步 + 收尾

- [x] P4.1 主 spec 同步：diagnosis-runner「未标定 detector 告警降级」scenario GIVEN 改 player_overlap
      — 同 commit 一并修：delta `specs/match-engine/spec.md` 的「逐桶自洽」「长传加成」「cap」scenario
      措辞与实现对齐（insufficient_sample 承载物、逐常量杀死、cap 是防御性上限）。主 spec
      `openspec/specs/diagnosis-runner/spec.md` 的 MODIFIED requirement header 与 delta 逐字一致、
      scenario 全量复制（archive 盲区专项复查通过）。
- [x] P4.2 `cargo test` + viewer/tools node tests + `npx openspec validate --all --strict` + `./verify.sh` 全绿
      — 实测：`cargo test --lib p32_` 2/2（含 golden 走 `--test realism` 4/4）、`viewer` 303/303、
      `tools` 404/404、`openspec validate --all --strict` 17 passed 0 failed、`./verify.sh` 五步全绿
      （含 WASM e2e 5817 事件 + realism release 套件 8/8）。
- [x] P4.3 独立零记忆 subagent 审阅闭环（发现问题→修复→再审至无遗留）
      — R1 无 P1、12 条声明全验真、2 P2 + 7 P3；全部修复后 R2 复审确认无遗留。记录见
      `reviews/review.md`。

## 关联

- 修复 issue #36；grill 全稿 `.scratch/issues/36-ignored-interception-calibration-grill.md`
- golden-v5 不变、事件协议不变、viewer 生产不变
