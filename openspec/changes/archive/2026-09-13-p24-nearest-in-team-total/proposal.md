# Proposal: nearest_in_team 退化态 total 化（修复越界 panic）

## Why

`nearest_in_team(st, target, team)` 在「该队外场球员全部罚下」这一退化态下返回 `-1`。其 11 个生产调用点（另有 1 处函数定义）把返回值存进状态（`st.restart_prep.player` / `st.loose.chaser` / 角球 battle 等），后续以 `st.pos[player as usize]` 索引 —— `player == -1` 时越界 panic。

这是 P23 之前就存在的既有行为（`537f2ac` 引入），触发条件是「某队外场 10 人全部罚下」（规则可达但极罕见：每队最多 10 张红牌、门将不产犯规）。P23 已把同退化态下其它选择器（`nearest_defender`/`nearest_teammate`/`kickoff_pick`）total 化（退化回退门将），唯独 `nearest_in_team` 漏了——两个独立审阅者均确认 P23 未扩大此触发面，建议单开处理（issue #43）。

## What Changes

`nearest_in_team` 在无合法候选（该队外场全罚下）时，不再返回 `-1`，改为**回退该队门将**（门将恒不被罚下），保持函数 total。

- 正常态行为不变：仍排除门将、仍排除罚下球员。
- 退化态：回退门将作为兜底（与 P23 对 `nearest_defender`/`nearest_teammate` 的 total 化一致）。

此修法让 11 个生产调用点不再收到 `-1`，无需逐个加守卫。

## Capabilities

### Modified Capabilities

- `match-engine`: 纪律牌 requirement 的退化态语义——「某队外场全罚下」时选择器 total 化（回退门将），不再越界。

## Impact

- `engine/src/lib.rs`（`nearest_in_team` 退化回退 + 单元测试）
- 不碰 viewer、tools、golden（退化态在 canary seed 不触发：最多 1 张红牌，远达不到全队罚下）

## 关联

- 修复 issue #43；从 P23（#34）审阅闭环拆出
