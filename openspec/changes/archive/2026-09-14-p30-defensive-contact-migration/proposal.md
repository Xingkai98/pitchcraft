# Proposal: 防守接触竞争迁移（#25 阶段 2C）

## Why

2B（P29）已让射门 hazard 涌现，但**防守侧还是旧补丁**：抢断由 fallback 情境（原 Tackle 槽）强制产生，`same_pair`（连续同对强制失败）、`far`（超阈值降成功率 15%）是「事后补丁式成功率修正」，不是「资格判定」。犯规 `maybe_open_foul` 和抢断**各自独立判定**，没有统一的「防守动作竞争」——同一 tick 可能既抢又犯。

本 change 是 #25 阶段 2C：**抢断/犯规统一进「每个防守机会点打分选一个防守动作」的竞争**，删 `same_pair`/`far` 补丁 → 显式三层 cooldown 状态。这是防守侧对称重构，配合 2B 的射门侧，让「攻守双方都涌现」。

4 个设计决策已 grill 定稿（见 reviews/grill-design.md）：
- Q1 三层 cooldown（defender 级 + pair 级 + 全局 foul）
- Q2 打分选一（tackle/foul/contain/jockey）
- Q3 contain/jockey 不产事件只调状态
- Q4 犯规同窗口竞争

## What Changes

- **三层 cooldown**：`tackle_cooldown[22]`（defender 级 3-5s）、`last_contact_pair`（pair 级 5-8s）、`foul_cooldown_ticks`（全局 11s）。
- **防守动作打分选一**：`score_tackle = base + closeness + approach - cooldown - bad_angle` 等，tackle/foul/contain/jockey 取最高分。
- **删 same_pair/far**：`emit_tackle_highlight_impl` 的 `same_pair`/`far` 参数删掉，改为「资格在打分阶段判定，结果只有成功/失败两态」。
- **犯规并入竞争**：`maybe_open_foul` 并入防守动作打分，与抢断同窗口竞争（犯规只在禁区外 + 贴身 + 冷却过）。
- **contain/jockey 只调状态**：不产事件，只更新持球者压力（供 2B hazard 用）。

## Capabilities

### Modified Capabilities

- `match-engine`: 抢断/犯规由「独立判定 + 补丁式成功率」改为「统一防守动作竞争 + 三层 cooldown」。

## Impact

- `engine/src/lib.rs`（三层 cooldown 状态 + 防守动作打分 + 删 same_pair/far + 犯规并入）
- `engine/tests/realism.rs`（频率断言改方向性 + golden v4）
- `engine/tests/golden-v4/`（新基线）
- 不改事件协议（tackle/foul 事件字段不变）、不改 viewer

## 关联

- #25 阶段 2C；2B（P29）已就位；阶段 3 后续
