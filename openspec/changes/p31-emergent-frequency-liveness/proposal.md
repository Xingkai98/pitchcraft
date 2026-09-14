# Proposal: 删槽位 + 涌现频率 + liveness guard（#25 阶段 3 收官）

## Why

#25 的 2A-2C 已把射门/抢断/犯规改成涌现，但**槽位层仍是节拍源**：`HIGHLIGHTS_PER_MATCH=24` + `slot_clock`/`slot_interval` + `roll_fallback_situation`（35/12/18/22/13 固定比例抽签）仍在 tick 里强制触发评估，`FallbackSituation::Corner/ThrowIn` 仍在硬造出界。

本 change 是 #25 **收官**：删掉槽位层，让比赛完全由「自然 deadline + 状态涌现」驱动，出界由「传球落点误差」涌现，引入「非事件型 liveness guard」防塌缩，按真实 5 分钟重新校准统计。

4 个设计决策已 grill 定稿（见 reviews/grill-design.md，全选 codex 推荐 A）。

## What Changes

- **删槽位层**：`HIGHLIGHTS_PER_MATCH` / `slot_clock` / `slot_interval` / `slot_hold_max` / `roll_fallback_situation` / `FallbackSituation` / `emit_pass_out_play_slot` 全删。
- **出界涌现**：普通传球落点加 `pass_risk` 相关的确定性误差（`sample_pass_landing`），raw 越界 → 按 `out_side` + 最后触球方判角球/界外球/门球。重开发球不走出界误差。
- **liveness guard 三层递进**：`ticks_since_meaningful_action` 8/12/16 三档，逐档调 `forward_intent_bonus` / `pass_risk_bonus` / `deadline_pressure`，只改行为状态不直接造事件。
- **PASS_BREAK_TICKS 并入 guard**：删独立的「固定必传球」语义。
- **5 分钟统计方向性**：删「5分钟≥90分钟 53%」槽位式断言；~1000 场 cohort 做方向性护栏；90 分钟带保留、阶段 3 后重新离线校准。

## Capabilities

### Modified Capabilities

- `match-engine`: 事件频率完全由状态涌现（无槽位配额）；出界由落点误差涌现；liveness guard 非事件型护栏。

## Impact

- `engine/src/lib.rs`（删槽位层 + sample_pass_landing + liveness guard + tick 重构）
- `engine/tests/realism.rs`（5 分钟方向性断言 + 90 分钟带重新校准）
- `engine/tests/golden-v5/`（新基线）
- 不改事件协议、不改 viewer

## 关联

- #25 阶段 3（收官）；2A/2B/2C 已就位
