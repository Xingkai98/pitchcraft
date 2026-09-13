# Proposal: 射门机会迁移（#25 阶段 2B）

## Why

2A（P28）建好了「持球行动机会」深模块 + fallback trigger，但射门**仍然由 fallback 情境（原 Shot 槽）强制产生**——`shot_setup` 推进到射程后「到即射」，没有任何 hazard 打分、没有「起脚前可被抢断」的窗口。

本 change 是 #25 阶段 2B：**射门真正改由 hazard 打分涌现**。这是 #25 里第一个改变可观测行为的 change——射门不再由槽强制，事件流会变、golden 重基线、频率变。

4 个设计决策已 grill 定稿（见 `reviews/grill-design.md`）：
- Q1 起脚窗口 + committed（推进到射程 → 1-2 tick 窗口内 hazard 决定，`committed=true` 才产 Shot）
- Q2 完整五因子 hazard 公式
- Q3 被抢断产 `canceled → tackle → loose ball`（不产 Shot）
- Q4 golden v3 新基线保留旧

## What Changes

- **hazard 打分**：`score = base_tendency + distance_quality + angle_quality + space_available - defensive_pressure - cooldown_penalty`；`hazard = exp(score)`；`p_shot = 1 - exp(-hazard * window)`。距离用分段（复用 shot_bucket 分桶但不再强制射门）。
- **ShotSetup 改起脚窗口**：推进到射程 → 进入起脚窗口（`committed: false`），窗口内 hazard 打分决定射/转/被抢断；`committed: true` 才产 Shot 事件，不可回溯。
- **被抢断打断**：`shot_setup` 推进中被抢断 → `canceled → tackle → loose ball`（不产 Shot）。
- **golden v3**：新目录 `golden-v3`，v1/v2 保留；频率断言改方向性（Shot 不再等于槽数量）。

## Capabilities

### Modified Capabilities

- `match-engine`: 射门由 hazard 打分涌现（非槽强制）；`shot_setup` 可被抢断打断。

## Impact

- `engine/src/lib.rs`（hazard 打分 + ShotSetup 起脚窗口 + 被抢断打断 + 频率逻辑）
- `engine/tests/realism.rs`（频率断言改方向性 + golden v3）
- `engine/tests/golden-v3/`（新基线）
- 不改事件协议（shot 事件字段不变）、不改 viewer

## 关联

- #25 阶段 2B；2A（P28）已就位；2C（防守接触）后续
