# Grill Design: 阶段 3 删槽位 + liveness guard（#25 收官）

> batch-grill-me：敲定 #25 阶段 3 的设计细节。用户在 Open Questions 全部确认前，不写实现代码。

## 背景（facts，已从代码确认）

- 槽位层还在：`HIGHLIGHTS_PER_MATCH=24` + `slot_clock`/`slot_interval` + `roll_fallback_situation`（35/12/18/22/13）+ `FallbackSituation`。
- `FallbackSituation::Corner/ThrowIn` 仍硬造出界（`emit_pass_out_play_slot`）。
- 2A-2C 已建：自然 deadline、射门 hazard、防守打分选一。
- 出界协议（P27）已铺 `result=out`/`out_side`/`out_pos`，但「落点误差产生出界」的涌现逻辑还没做（现在还是独立的 8-10% out_roll）。
- `PASS_BREAK_TICKS=12` 仍是固定持球超时强制传球点（潜在的第二槽位）。

## Round 1: 阶段 3 设计树（codex 已标推荐，均为 A）

### Q1: 删槽位后，比赛节拍怎么驱动？

- **A（codex 推荐）纯自然 deadline + liveness guard**：删槽位，只靠自然 deadline；停滞时 liveness guard 调状态。同时删 `PASS_BREAK_TICKS` 的独立「必传球」语义，并入 liveness guard。
- **B 保留固定评估节拍但不抽类型**：删类型抽签，保留 slot_interval 作纯节拍。仍是隐性「机会点配额」。
- **C 连 guard 都不做**：赌不塌缩，风险大。

### Q2: 出界（角球/界外球/门球）怎么涌现？

- **A（codex 推荐，且是阶段 3 必要闭环）普通传球落点误差→越界**：`sample_pass_landing` 纯函数，落点加 pass_risk 相关的确定性误差，raw 越界→按 out_side 判角球/界外球/门球（按最后触球方 source：NormalPass+goal_line→门球，Clearance+goal_line→角球）。重开发球不走出界误差。
- **B 保留独立出界 roll**：传球判定里加独立出界概率，简单但「出界」和「落点误差」两张皮。
- **C 阶段 3 暂不做涌现出界**：只删 Shot/Tackle/Pass 槽，Corner/ThrowIn 硬造保留。codex 明确反对（角球/界外球失去来源）。

### Q3: liveness guard 设计

- **A（codex 推荐）三层递进**：`ticks_since_meaningful_action` 8/12/16 三档，逐档调 `forward_intent_bonus`/`pass_risk_bonus`/`deadline_pressure`，只改行为状态不直接造事件。meaningful action = 射门/传球/抢断/犯规/球权变化/重开（普通 beat、contain/jockey 不重置）。
- **B 单层**：超阈值一次性调强，行为跳变。
- **C 不做护栏**：赌不塌缩。

### Q4: 5 分钟统计目标

- **A（codex 推荐）方向性护栏 + 宽体量带 + cohort 断言**：删「5 分钟≥90 分钟 53%」的槽位式断言；5 分钟用 ~1000 场 cohort 做「射门>0、重开>0、犯规宽带、进球≥0」的方向性护栏；90 分钟带保留但阶段 3 后重新离线校准。
- **B 精确对标真实 5 分钟分布**：方差大需大样本。
- **C 保留 90 分钟带 + 5 分钟缩放假设**：与「真实物理时间」冲突。

## User Confirmation（2026-09-14，batch-grill-me Round 1）

- **Q1 节拍驱动**：用户答复 **自然 deadline + guard**（删槽位，只靠自然 deadline；PASS_BREAK_TICKS 独立语义并入 liveness guard）。
- **Q2 出界涌现**：用户答复 **落点误差涌现**（普通传球落点加误差→越界→按 out_side + 最后触球方判重开；阶段 3 必要闭环）。
- **Q3 liveness guard**：用户答复 **三层递进**（8/12/16 三档，只改行为状态不直接造事件）。
- **Q4 5 分钟统计**：用户答复 **方向性+宽带**（删槽位式断言；~1000 场 cohort 方向性护栏；90 分钟带阶段 3 后重新校准）。

## Open Questions

无。阶段 3 四个核心决策已收敛，可立项。
