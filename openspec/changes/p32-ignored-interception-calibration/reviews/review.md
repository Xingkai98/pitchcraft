# Review: P32 ignored_interception 假阳性治理（#36）

按 CLAUDE.md「代码审阅闭环」执行：实现完成 → 独立零记忆 subagent 审阅 → 修复 → 再审，直到无遗留。

## 审阅轮次

- **R1（2026-09-14）**：独立零记忆 subagent（Opus）审阅全部实现 + 12 条核心声明，真跑全套测试 + 4 组变异。
- **R2（2026-09-14）**：修复后复审（同 agent 续跑），确认修复到位、无遗留。

## R1 结论

**无 P1 阻断项。12 条核心声明全部被独立验证为真**（含 3 种变异红、golden 绿、样本量实测吻合、
主 spec/delta 逐字对齐）。发现 2 条 P2 + 7 条 P3。总体结论「暂不可归档，但已接近」，阻断项为
流程/文档缺口而非代码正确性。

### R1 验证为真的声明（摘要）

| 声明 | 验证方式 | 结论 |
|---|---|---|
| 1 detector 彻底删 | 全仓 grep（排除历史目录）+ 逐行 diff | ✅ 无 deprecated 壳 |
| 2 整数 roll 量化 | 读 `interception_roll_width`/判定点，逐字比对 `<` | ✅ |
| 3 记账零 RNG/零事件流 | 逐行 diff `emit_pass_highlight_inner` | ✅ RNG 序列未变、字段未改 |
| 4 golden-v5 不变 | 自跑 `cargo test --test realism` | ✅ `gm_canary_seeds` 绿 |
| 5 分桶/常量同源 | 读代码 | ✅（R1 建议见 P3-6，已修） |
| 6 CI 量纲 | 手算 + 实测不贴边 | ✅ 无量纲错（旧版 100× 错未复现） |
| 7 变异可杀死接线 | 独立复现 4 种变异 | ✅ 删记账/删 LONG/ceil→截断/契约删 h 皆红 |
| 8 viewer 生产不动 | `git diff` | ✅ derive 文件 diff 为空 |
| 9 strata 软参考 | 读 `mergePassOutcomes`/band 逻辑 | ✅ 既有四桶+total 不变、不产 finding |
| 10 主 spec 同步 | 逐字比对 delta vs 主 spec | ✅ header/scenario 全量复制（archive 盲区专项通过） |
| 11 字段契约自洽 | 契约测试 + 删 `h` 变异 | ✅ 生产者真实、守卫可见 |
| 12 空转守卫 | 临时打印实测样本 | ✅ 23955/45536/1229 与声明吻合 |

### R1 发现的问题与处置

| ID | 严重度 | 问题 | 处置 |
|---|---|---|---|
| P2-1 | 应修 | `tasks.md` 引用不存在的 `reviews/review.md` | ✅ 本文件即补齐该交付物 |
| P2-2 | 应修 | `tasks.md` P4 三项未勾选、状态自称未完成 | ✅ 已在 R2 前如实勾选并补记录 |
| P3-1 | 建议 | Poisson-binomial 方差注释数学不精确（`E(1−p̄)` 是**上界**，非等式） | ✅ 已改注释：明确为上界、方向保守、给实测偏差（0.8%） |
| P3-2 | 建议 | `tight_very_long_n` 赋值后未使用（编译告警） | ✅ 已用于「贴防桶超长样本 ≤ 全距离档超长总数」断言 |
| P3-3 | 建议 | `intercept_long_actual`/`intercept_very_long_actual` 只写不读 | ✅ 已加活性断言（actual ≤ 样本数、very ⊆ long） |
| P3-4 | 建议 | spec 的 `insufficient_sample` 无处落地（实现是静默 return） | ✅ 改为返回 `Err("insufficient_sample")` 并由测试 eprintln 落盘（非静默） |
| P3-5 | 建议 | spec 的 cap scenario 在生产上不可达 | ✅ delta spec + design 明说 cap 是防御性上限、真实上界 22.5 |
| P3-6 | 建议 | `RESTART_DETAILS` 字面量拷贝 + 与 design 的 `goal_kick` 冲突 | ✅ 改为 `= EXCLUSION_DETAILS`（引用同源）；design 记录偏离理由 |
| P3-7 | 建议 | 缺失 `h` 并入 `low_ball`（会让 high_ball 率偏低） | ✅ 新增 `unknown_h` 层（不伪造，与 `unknown_pressure` 同原则） |

### R1 设计层面盲区（已记录并处置）

1. **design D3 重开清单含 `goal_kick`，引擎不产** → 实现沿 `EXCLUSION_DETAILS`；已在 design.md D3 记录偏离。
2. **design D1 的 `insufficient_sample` 无承载物** → 实现用 `Err` 返回值 + eprintln 承载，spec 措辞与实现对齐；design D1 已注明。
3. 其余（记账点/分母定义、彻底删 vs 降级壳、桶边界同源、golden 不变理由、D4 用 player_overlap 替代）与实现一致，无内部矛盾。

## R2 复审结论

修复 2 条 P2 + 7 条 P3 后，独立复审确认：

- 9 条修复**逐条**验证到位，无回归；`cargo test --lib p32_` 2/2、`cargo test --test realism` 4/4、
  `viewer` 303/303、`tools` 404/404、`openspec validate --all --strict` 17/17、`verify.sh` 五步全绿。
- 变异守卫仍绑住接线（审阅者独立把 `intercept_long_actual += 1` 改空操作 → 断言红）。
- 两个重点复核无回归：**A** `hits_long_pass` 替代内联比较逐字等价、RNG 序列未变、golden 绿；
  **B** `unknown_h` 不误分类（探针实测真实引擎 8359 条 pass 的 missing_h=0；fixture 里 2 条缺 h
  的 out pass 经 git 取证确认是 P27 时点无 h 发射点的陈旧快照，P31 删槽位后生产链路恒带 h）。
- R2 新发现 3 条 P3（见下），全部处置完毕。

### R2 新发现问题与处置（第三轮修复）

| ID | 严重度 | 问题 | 处置 |
|---|---|---|---|
| N-1 | 建议 | `insufficient_sample` 走 eprintln，默认 `cargo test` 下被框架捕获、不可见 | ✅ 改为：先硬断言三桶样本 ≥ 200，再 `assert!(... .is_ok())`；`insufficient_sample` 就此**不可达**（不是被捕获的 stderr 噪音） |
| N-2 | 建议 | 只有贴防桶有最小样本断言，中距/远距桶可能静默退化 | ✅ 三桶统一硬断言 `samples[b] >= P32_MIN_BUCKET_SAMPLES` |
| N-3 | 建议 | tasks.md 把两条命令写成一条，易误读 | ✅ 措辞修正为「两条命令分开跑」 |

**最终：审阅通过，可归档。**

## 遗留风险（不阻断归档，登记为后续）

- **「高球标记率 85%」未复现/否定**：真实 fixture 仅 6 条 pass（h>0 者 1 条），样本远不足以判定。
  本轮交付的是**分层机制**与对照口径；复现/否定需真实多 seed 全 90min bundle（登记为 #36 后续标定）。
- **`pass_outcomes.strata` 的 `h` 生产者是引擎直出 + derive 直传**（`{...e}`），契约登记为 `engine`；
  若将来 derive 层改为不透传 `h`，契约测试会红（守卫已覆盖）。
