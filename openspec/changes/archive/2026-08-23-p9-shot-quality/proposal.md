# Proposal: 射门质量模型（按起脚位置分桶 + 射门起脚位置修正）

## Why

L3 现状报告（`research/2026-08-23-match-realism-testability/l3-gap-analysis.md`）实测 200 场发现两个相关缺陷：

1. **射门质量无位置依赖**：`emit_shot_highlight` 硬编码 goal 15% / saved 35% / off 50%，远射和禁区内射门同概率 → 射正率 50%（真实 ~33%）、射门转化 14.9%（真实 ~10%）。
2. **射门起脚位置不真实（更严重）**：射门槽触发时 carrier 在哪就哪射 → **50% 射门从中场 25-35m 起脚、13% 从自家半场**，禁区内射门仅占 14.5%（真实 ~55-58%），禁区内进球占比仅 **12%**（真实 ~85%）。

这是 A 档（集锦真实性）比率失真的第一项：射门模型从「无位置」变成「按位置」，且起脚位置本身要对齐真实分布——否则分桶概率没意义（中场射门按禁区外 3.5% 转化 → 进球趋零，破坏「集锦也要有进球」）。

## What Changes

- **射门质量模型**：按起脚点到球门距离分桶给 goal/saved/off 概率（三桶：禁区内 / 禁区弧 / 远射，概率对齐真实转化率与射正率）。
- **射门起脚位置修正**：射门槽触发且 carrier 距球门过远时，先执行「推进后射门」——向前推进（传球/带球）到射程内再起脚，目标起脚分布对齐真实（禁区内射门 ~55-58%）。
- **头球射门对齐禁区口径**：头球全部在禁区内，概率对齐禁区内桶。
- **测试**：L1 加按位置分桶的分布断言 + 禁区内进球占比；L2 把「射门起脚半场」从 known-gap 变为断言；L3 gate 草案（转化率/射正率/禁区内进球占比参考带）；golden master re-baseline。

## Capabilities

### New Capabilities

- **射门质量位置依赖**：射门结果概率按起脚位置分桶（禁区内/禁区弧/远射），对齐真实射正率 ~33%、转化率 ~10%、禁区内进球占比 ~85%。
- **射门起脚位置真实**：射门起脚分布对齐真实（禁区内 ~55-58%），消除中场/自家半场射门。

### Modified Capabilities

- `match-engine`：`emit_shot_highlight` 概率改分桶、新增射门推进（shot setup）状态、`emit_header_shot` 概率对齐禁区桶。
- 测试：`realism.rs` L1/L2 更新，golden 基线 re-baseline。

## Impact

- 引擎：`emit_shot_highlight` / `emit_header_shot` / `shot_target` / `roll_highlight`（shot 槽）概率与推进逻辑；新增 MatchState 字段（shot setup）。
- 测试：`realism.rs` 射门结果断言改分桶断言 + 起脚位置断言；golden 10 seed re-baseline。
- **观感**：进球数预计从 1.06/场 降到 ~0.7/场（转化率对齐真实 10%）；射门将更多出现在禁区附近。需要用户确认进球数取舍（见 grill Q5）。
