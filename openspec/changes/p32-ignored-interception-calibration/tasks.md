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

- [ ] P2.1 `tools/detectors.mjs` 删 `detectIgnoredInterception` + profile 块 + band + 映射 + runAudit 集成 + stats
- [ ] P2.2 `tools/detector-field-contract.mjs` 删 `ignored_interception_opportunity` 条目
- [ ] P2.3 删 `tools/detectors.test.mjs` / `tools/detector-field-contract.test.mjs` 相关用例
- [ ] P2.4 确认 viewer derive 层 `corridor_distance`/`defender_moved_toward_corridor` 生产保留、测试保留

## P3. pass_outcomes 分层扩展（软参考）

- [ ] P3.1 `computePassOutcomes` 加 strata：高球（h）/ 长传（pass_distance>22m）/ 重开类型（detail）
- [ ] P3.2 各层记 sample/out/success/intercepted，不进 band 升级
- [ ] P3.3 新增分层测试（含「高球 85%」复现与否的对照数据）

## P4. 主 spec 同步 + 收尾

- [ ] P4.1 diagnosis-runner「未标定 detector 告警降级」scenario GIVEN 改 player_overlap
- [ ] P4.2 `cargo test` + viewer/tools node tests + `npx openspec validate --all --strict` + `./verify.sh` 全绿
- [ ] P4.3 独立零记忆 subagent 审阅闭环（发现问题→修复→再审至无遗留）

## 关联

- 修复 issue #36；grill 全稿 `.scratch/issues/36-ignored-interception-calibration-grill.md`
- golden-v5 不变、事件协议不变、viewer 生产不变
