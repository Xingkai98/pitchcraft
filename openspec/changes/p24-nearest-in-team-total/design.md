# Design: nearest_in_team 退化态 total 化

## Context

`nearest_in_team` 在「该队外场全罚下」时返回 `-1`，12 个调用点后续 `st.pos[-1 as usize]` 越界 panic。P23 已把同退化态下 `nearest_defender`/`nearest_teammate`/`kickoff_pick` total 化（回退门将），本函数是漏网的同类。

## Goals / Non-Goals

**Goals:**
- `nearest_in_team` 永不返回 `-1`，退化态回退该队门将（恒不被罚下）。

**Non-Goals:**
- 不做「少一人」战术（归 #11）。
- 不改调用点逐个加守卫（函数 total 化后调用点天然安全）。

## Decisions

### D1: 退化回退门将

与 P23 的 `nearest_defender`/`nearest_teammate` 一致：无合法外场候选时返回该队门将（home 0 / away 21）。门将在退化态下「被迫顶上」是兜底行为，非正常语义——仅在该队外场 10 人全罚下的规则可达边界触发。

### D2: 正常态零变化

`nearest_in_team` 正常态（有合法外场候选）行为不变：仍排除门将（`id == 0 || id == 21`）、仍排除罚下球员。golden 不受影响（canary seed 最多 1 张红牌，远达不到全队罚下）。

### D3: 测试

- 单测（lib.rs `mod tests`）：构造 `MatchState`，把 team 所有外场（10 人）`sent_off` 置位，断言 `nearest_in_team` 返回该队门将 id（home 0 / away 21），不返回 `-1`。
- 对照组：未全罚下时返回最近外场、不返回门将。
