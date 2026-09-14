# Design: 防守接触竞争迁移（#25 阶段 2C）

## Context

#25 阶段 2C。4 决策已 grill 定稿（reviews/grill-design.md）。配合 2B 射门侧，让防守侧也涌现。

## Goals / Non-Goals

**Goals:**
- 抢断/犯规统一进「防守动作打分选一」。
- 删 `same_pair`/`far` 补丁 → 三层 cooldown 状态。
- contain/jockey 只调状态不产事件。

**Non-Goals:**
- 不改事件协议（tackle/foul 字段不变）、不改 viewer。
- 不删槽位（阶段 3）。

## Decisions

### D1: 三层 cooldown（用户拍板）

- `tackle_cooldown[22]`：defender 级，3-5 tick。同一防守者不连抢。
- `last_contact_pair: Option<(i32,i32)>` + `contact_age_ticks`：pair 级，5-8 tick 内降低再次接触。
- `foul_cooldown_ticks`：全局 foul 保留 11 tick（现有 `FOUL_MIN_GAP_TICKS`）。
- cooldown 只改变「下一次防守动作打分」，不直接禁止事件。

### D2: 防守动作打分选一（用户拍板）

每个防守机会点，对候选防守者算 4 个 score：
- `score_tackle = base + closeness + approach - tackle_cooldown - pair_cooldown - bad_angle`
- `score_foul = base + danger + closeness - yellow_penalty - foul_cooldown`（仅禁区外 + 贴身 + 冷却过）
- `score_contain = base + pressure_without_contact`
- `score_jockey = base + distance_fit`

取最高分 → 对应 `DefensiveAction`。

### D3: 删 same_pair/far（用户拍板）

`emit_tackle_highlight_impl(st, rng, events, t)` 删 `same_pair`/`far` 参数。资格在打分阶段判定（cooldown/距离/积极性），结果只有 success/fail 两态（`TACKLE_SUCCESS_RATE`）。

### D4: 犯规并入竞争（用户拍板）

`maybe_open_foul` 并入防守动作打分，与抢断同窗口竞争。犯规资格：禁区外（`dist_to_goal > BOX_DIST_M`）+ 贴身（`≤ FOUL_PRESS_DIST_M`）+ 冷却过（`foul_cooldown_ticks == 0`）。吃黄球员 foul 分数打折（`FOUL_YELLOWED_DETERRENCE`）。

### D5: contain/jockey 只调状态（用户拍板）

contain/jockey 不产事件，只更新持球者压力状态（`pressure_state`），供 2B hazard 的 `defensive_pressure` 因子读。

### D6: golden v4

- 新目录 `golden-v4`，v1/v2/v3 保留。
- 频率断言改方向性（tackle 不再等于 Tackle 槽数量）。

## 验收

- 纯决策测试：cooldown 到期前后 score 变化、同 pair 接触后不立即重复、吃黄犯规 score 打折。
- 三层 cooldown 行为测试：defender 级 / pair 级 / 全局 foul 各自生效。
- 删 same_pair/far 后结果仍两态（success/fail）。
- golden v4 重基线，v1/v2/v3 保留且回归绿。
- `./verify.sh` 全绿 + `openspec validate` 通过。
