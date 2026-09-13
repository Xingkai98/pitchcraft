# Design: 持球行动机会核心模块（#25 阶段 2A）

## Context

#25 阶段 2A。4 个核心决策已 grill 定稿（见 `reviews/grill-design.md`）：机会生命周期=deadline 到期可重复、deadline=几何量公式、竞争=先 carrier 后 defender、槽位=降级为 fallback。

本 change 只建模块 + 接线，**不改变可观测行为**（事件流字节不变、统计不变）——这是关键验收。射门 hazard（2B）、防守接触竞争（2C）、删槽位（阶段 3）都不在本 change。

## Goals / Non-Goals

**Goals:**
- 建 `ActionOpportunity` / `CarrierAction` / `DefensiveAction` / `ActionResolution` + deadline 计算纯函数。
- 槽位时钟降级为 fallback trigger（`OpportunityTrigger::NaturalDeadline | FallbackDeadline`）。
- 纯决策测试。

**Non-Goals:**
- 不改事件协议、不改统计、不改 viewer。
- 不做射门 hazard 打分（2B）、不做防守接触竞争（2C）、不删槽位（阶段 3）。
- 2A 阶段新模型可以「接线但行为等价于旧逻辑」（见 D5）——不是空转，是先把结构立起来。

## Decisions

### D1: 机会生命周期 = deadline 到期可重复（用户拍板）

- 持球段内每次 `deadline_ticks` 到期 → 开一次 `ActionOpportunity` → 评估行动。
- 若结算为「继续带球 / 无事件」，重置 deadline 再等下一次。
- 机会在「球权改变 / 死球 / 犯规 / 重开」时失效。

### D2: deadline = 几何量公式（codex 推荐）

```rust
deadline_ticks = clamp(
    BASE_ACTION_DEADLINE_TICKS                       // 7
    - DANGER_URGENCY * danger                        // 越接近球门越短
    - PRESSURE_URGENCY * pressure                    // 防守越近越短
    + ESCAPE_BONUS * escape_space,                   // 出球空间大稍长
    MIN_ACTION_DEADLINE_TICKS,                       // 3
    MAX_ACTION_DEADLINE_TICKS,                       // 12
)
```

- `danger`：距对方球门反向归一化 × 中路因子 × 向前空间因子。
- `pressure`：最近防守者距离反向 + 第二防守者。
- `escape_space`：最佳队友出球空间 + 向前空当。
- 门将 / 本方后场持球允许更长（danger 低）。

### D3: 竞争结算 = 先 carrier 后 defender（用户拍板）

- carrier 先产 `CarrierAction` 计划；贴身 defender 再产 `DefensiveAction`。
- 结算优先级：死球/重开 > 防守中断（tackle/foul）> 持球终结（shoot）> 持球普通（pass/dribble）> 无事件防守（contain/jockey）> 普通 beat。

### D4: 槽位降级为 fallback（codex 推荐）

- 删掉「槽位到期 → `roll_highlight_slot` 选类型」；改为「槽位到期 → 触发一次统一行动评估（若自然 deadline 未到）」。
- `OpportunityTrigger::NaturalDeadline`（正常 deadline 到期）与 `FallbackDeadline`（槽位兜底触发）。
- fallback 只触发评估，不指定事件类型——不引入隐性配额。

### D5: 2A 行为等价（关键验收，防空转）

2A 接线后，**事件流必须与接线前逐字节一致**（或至少 golden v1 语义不变）。做法：新模型先「包装」现有决策逻辑——`roll_highlight` 的 Shot/Tackle/Pass 分支改成「CarrierAction 枚举 → 映射回原 emit 函数」，行为不变，只是结构从「类型配额」变成「行动评估」。这样模块是真的被用到（非空转），又不改变行为（保 D6 式确定性）。

**防空转**：P27 的 `model_version` 空转教训——字段/模块若接线后行为不变，必须证明「模块真的被调用了」，而不是 dead code。用「删除旧路径会红」的测试守卫。

### D6: 不立 golden 新基线

行为不变 → golden v1 不变（不重基线）。若接线后 golden 变了，说明接线引入了行为变化，需停下查原因（不是直接 ACCEPT_GOLDEN）。

## 验收

- 纯决策测试：deadline 公式方向正确（近门/受压 → deadline 短；后场 → 长）。
- 接线后事件流逐 seed 与接线前一致（golden v1 全绿、stream_hash 不变）。
- 「删除旧路径会红」守卫：证明新模块真的被调用。
- `./verify.sh` 全绿 + `openspec validate` 通过。
