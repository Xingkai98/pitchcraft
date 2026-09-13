# Design: 退化态选择器 total 化（#45/#46）

## Context

P24 修了 `nearest_in_team`，审阅发现两个同族越界：#45（`emit_forward_pass_highlight` 内联选择器，9 红触发）、#46（`nearest_any`，20 红触发）。都是「罚下后的退化态」选择器返回 `-1` → 调用点 `st.pos[-1]` 越界。

## Goals / Non-Goals

**Goals:**
- `emit_forward_pass_highlight` 与 `nearest_any` 永不返回 `-1`，退化态回退门将。

**Non-Goals:**
- 不做「少一人」战术（归 #11）。
- 不改调用点逐个加守卫（函数 total 化后调用点天然安全）。

## Decisions

### D1: #45 `emit_forward_pass_highlight` 内联选择器回退该队门将

- 内联选择器无合法外场队友时（该队外场全罚下，或仅存 carrier 本人被 `id == from` 排除）→ 回退该队门将（home 0 / away 21）。
- 需保证 `to != from`：`from` 是持球者本人，若 from 恰是门将（门将持球时本函数不会进入——`roll_highlight` 的 shot 槽有「门将不射」守卫改普通传球，但防御性保证 `to != from`），回退门将等于 from 时，改退对方门将？——**不**。更简单：回退门将后若 `to == from`，则此 forward pass 无意义，直接退化为「最靠前的非门将队友」无解，此时返回 `from` 的当前位置不动（球权保留，不产 pass）。但为避免复杂化，本 change 采用：门将持球不会进入本函数（上游守卫），故回退门将恒 `!= from`，加 `debug_assert!(to != from)` 防御。

### D2: #46 `nearest_any` 回退 home 门将 0

- `nearest_any` 无队别语义（对全部 22 人扫描），退化到「双方外场全空」时回退 home 门将 0（恒未被罚下）。不照搬 `nearest_in_team` 的 `if team == 0 { 0 } else { 21 }`（会引入「门将无谓偏好」——但 `nearest_any` 本就无队别，任取一名门将皆可，取 0 最简）。

### D3: 正常态零变化 + golden 不变

- 两函数正常态（有合法候选）行为不变。退化态需 9+/20 红，canary seed 最多 1 红，golden 不变。

### D4: 测试

- 单测（lib.rs `mod tests`）：构造退化态（`emit_forward_pass_highlight` 场景：该队外场全罚下 → 不 panic、to=门将；`nearest_any`：两队外场全罚下 → 返回 0 非 -1）。
- 对照组：正常态行为不变。
