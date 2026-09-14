# Grill Design: 阶段 2C 防守接触竞争（defensive-contact-migration）

> batch-grill-me：敲定 #25 阶段 2C 的设计细节。用户在 Open Questions 全部确认前，不写实现代码。

## 背景（facts，已从代码确认）

- 抢断现在由 fallback 情境（原 Tackle 槽）强制产生，`same_pair`（连续同对强制失败）、`far`（超阈值降成功率 15%）是**事后补丁式成功率修正**，不是「资格判定」。
- 犯规 `maybe_open_foul` 是**独立的涌现判定**（贴身 + 概率 + `foul_cooldown_ticks`），和抢断**各自独立**，没有统一的「防守动作竞争」。
- `last_tackle_pair: Option<(i32,i32)>` 只有一个全局 pair，不区分「刚发生 vs 很久以前」、不区分抢断成败、无 defender 级 cooldown。
- 2A 已建 `DefensiveAction { Tackle, Foul, Contain, Jockey, None }` 枚举（但 2A 内只用了 Tackle/None，其余是占位）；2B 已建起脚窗口 + hazard。
- 2C 是 #25 里**防守侧对称重构**：抢断/犯规统一进「每个机会点选一个防守动作」的竞争，删 same_pair/far 补丁 → 显式 cooldown 状态。

## Round 1: 2C 设计树 frontier

### Q1: cooldown 作用域（codex 列为必 grill）

- **A（推荐）defender 级 + pair 级 + 全局 foul 三层**：`tackle_cooldown[22]`（defender 级 3-5s）、`last_contact_pair`（pair 级 5-8s 内降低再次接触）、`foul_cooldown_ticks`（全局 foul 保留 11s）。
- **B 只 pair 级**：只保留 `last_contact_pair` 扩展 age，不做 defender 级 cooldown。
- **C 只 defender 级**：只做 `tackle_cooldown[22]`，删 pair 级。

理由：A 是 codex 建议——不同防守者轮流抢同一持球者不该被 pair 级全锁死，同一防守者不该连抢；B 会让「换一个防守者」立刻又能抢（防守过密）；C 会让「同一对」换 tick 又抢。

### Q2: 防守动作打分 vs 独立概率

- **A（推荐）打分选一**：`score_tackle = base + closeness + approach - cooldown - bad_angle` 等，在 tackle/foul/contain/jockey 里取最高分。
- **B 独立概率依次掷**：tackle 先掷、foul 再掷、否则 contain。简单但抢断和犯规可能「都过线」需要额外互斥规则。

理由：A 是 codex 建议——每个机会点只选一个防守动作，语义清晰；B 的互斥规则难调。

### Q3: contain/jockey 是否产事件

- **A（推荐）不产事件、只调状态**：contain/jockey 是「持续逼抢/卡位」的状态，不产高亮事件，只影响持球者压力（供 2B 的 hazard 用）。
- **B 产独立事件**：contain/jockey 也产事件。会刷屏。

理由：A 是 codex 建议——contain/jockey 是「状态」不是「事件」，产事件会刷屏。

### Q4: 犯规并入防守竞争的时机

- **A（推荐）抢断/犯规同窗口竞争**：每个防守机会点，抢断和犯规一起打分选一（犯规只在禁区外、有贴身、冷却过）。
- **B 犯规保持独立**：犯规继续 `maybe_open_foul` 独立判定，只有抢断进竞争。

理由：A 是 codex 建议——抢断和犯规本就是同一「防守动作选择」的两个选项，分开会「先抢断掷、再犯规掷」导致同一 tick 可能既抢又犯。

## User Confirmation（2026-09-14，batch-grill-me Round 1）

- **Q1 cooldown 作用域**：用户答复 **三层**（defender 级 `tackle_cooldown[22]` 3-5s + pair 级 `last_contact_pair` 5-8s + 全局 `foul_cooldown` 11s）。
- **Q2 防守动作选择**：用户答复 **打分选一**（tackle/foul/contain/jockey 各算 score 取最高，每个机会点只选一个）。
- **Q3 contain/jockey**：用户答复 **不产事件只调状态**（只影响持球者压力供 2B hazard 用）。
- **Q4 犯规并入**：用户答复 **同窗口竞争**（抢断/犯规一起打分选一；犯规只在禁区外+贴身+冷却过）。

## Open Questions

无。2C 四个核心决策已收敛，可立项。
