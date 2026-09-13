# Proposal: 退化态选择器 total 化（emit_forward_pass_highlight + nearest_any 越界）

## Why

P24 修复了 `nearest_in_team` 退化态越界（#43），审阅顺藤摸瓜发现两个同族但触发门槛不同的既有越界 bug：

- **#45** `emit_forward_pass_highlight` 内联选择器（`engine/src/lib.rs` ~1622）：`let mut best = -1` → 循环跳过 `sent_off` 和 `id == from` → `let to = best` 直接 `st.pos[to]`。**一队 9 红即可触发**（仅存的那名外场持球且距球门 > `SHOT_PASS_ADVANCE_M`，此时无合法向前传球目标）。P23 补漏时只加了「循环内跳过 sent_off」没做 total 化，留下此洞。
- **#46** `nearest_any`（`engine/src/lib.rs` ~531）：`best = -1` 原样返回，唯一调用点 `start_loose_ball` 的 `winning_team: None` 分支把结果存进 `st.loose.chaser`，随后 `advance_loose` 第一句 `st.pos[chaser]` 越界。**两队外场全罚下（20 红）触发**——因为 `nearest_any` 循环对全部 22 人扫描、不区分队伍。

两者都是「罚下后的退化态」越界 panic，与 #43/#34 同族。

## What Changes

- **#45**：`emit_forward_pass_highlight` 内联选择器退化态（无合法外场队友）回退该队门将，且保证 `to != from`（避免自传）。
- **#46**：`nearest_any` 退化态（两队外场全空）回退 home 门将 0（无队别语义，任取一名恒未被罚下的门将）。

正常态行为零变化（`nearest_any` 仍排除门将、仍排除罚下球员；`emit_forward_pass_highlight` 仍选最靠前外场队友）。golden 不受影响（退化态需 9+ 红，canary seed 最多 1 红）。

## Capabilities

### Modified Capabilities

- `match-engine`: 纪律牌 requirement 的退化态语义——「全队罚下」时所有选择器 total 化（回退门将），不再越界。

## Impact

- `engine/src/lib.rs`（`emit_forward_pass_highlight` 内联选择器 + `nearest_any` + 单元测试）
- 不碰 viewer、tools、golden

## 关联

- 修复 #45、#46；从 P24（#43）审阅拆出
