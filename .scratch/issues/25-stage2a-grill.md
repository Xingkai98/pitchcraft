# Grill Design: 阶段 2A 持球行动机会模型（action-opportunity-core）

> batch-grill-me：按轮次采访用户，敲定 #25 阶段 2A 的设计细节。
> 用户在 Open Questions 全部确认前，不写实现代码。
> 定稿后随 change 立项把本文件迁入 `openspec/changes/<id>/reviews/grill-design.md`。

## 背景（facts，已从代码确认）

- `roll_highlight_slot`（lib.rs:491）固定比例抽签 Shot 35%/Corner 12%/ThrowIn 18%/Tackle 22%/Pass 13%。
- `tick` 主循环（lib.rs:838-880）：开放比赛中 `slot_clock` 到点 → `roll_highlight`；`PASS_BREAK_TICKS`(12s) 防 carrier 停滞；`maybe_open_foul` 是已有的涌现式犯规判定。
- `shot_setup`：Shot 槽命中后采样射程 → 不够近则带球推进到射程再射（半涌现骨架，入口是槽位）。
- 抢断：Tackle 槽「总是产 tackle」，`same_pair` 强制 fail、`far` 降成功率是补丁。
- 已拍板方向：频率走 C 路（离线校准 + 运行时纯涌现 + 非事件护栏）；比赛时长=真实物理时间（只调 5 分钟）。
- codex 建议把阶段 2 拆 2A（行动机会核心）/ 2B（射门）/ 2C（防守接触）。本 grill 只覆盖 2A。

## Round 1: 2A 设计树 frontier

### Q1: 行动机会的生命周期

一个「持球行动机会」什么时候开启、什么时候结束？

- **A（推荐）deadline 到期可重复**：持球段内每次 deadline 到期就评估一次行动；若选了「继续带球」，重置 deadline 再等下一次。持球段 = 球权不变的一段连续时间。
- **B 每持球段一次**：每次球权到手只评估一次行动，这个行动一直执行到球权改变。
- **C 混合**：持球段开始评估一次定大方向，deadline 到期只做微调。

理由：A 最接近真实（持球者不断做小决策），与现有 tick 模型兼容；B 带球过度单调（一次决定带到底）；C 复杂。

### Q2: 行动机会的 deadline 怎么算

- **A（推荐）几何量公式**：`clamp(BASE(7) - DANGER_URGENCY*danger - PRESSURE_URGENCY*pressure + ESCAPE_BONUS*escape_space, 3, 12)`；danger=距球门、pressure=防守者距离、escape_space=出球空间。
- **B 固定时长**：所有机会统一 deadline（如 7 tick）。
- **C 只按压力**：只看最近防守者距离。

理由：A 是 codex 给的初始形状，几何量已有（nearest_defender 距离等）；B 太简单；C 丢了「越接近球门越该快点做决定」的语义。

### Q3: 攻守竞争结算顺序

- **A（推荐）先 carrier 计划、后 defender 竞争、按优先级结算**：carrier 先决定打算射/传/带，贴身 defender 再决定抢断/犯规/跟防；结算优先级「死球 > 防守中断 > 持球终结 > 持球普通 > 无事件防守 > beat」。
- **B 先 defender**：defender 先决定抢不抢，抢了 carrier 就不行动。
- **C 同时掷互斥**：carrier 和 defender 同时掷，按概率互斥。

理由：A 是 codex 建议，语义清晰（「我本来要射，但他先抢断了」）；B 防守过度主动；C 互斥概率难调。

### Q4: 2A 里槽位怎么过渡（fallback 契约）

- **A（推荐）槽位降级为 fallback deadline**：槽位到期不再抽签选类型，而是触发一次统一行动评估（若自然 deadline 还没到）。保证旧引擎「最低节奏」但不指定事件类型。
- **B 2A 直接删槽位**：只靠 action deadline。
- **C 建模块不接线**：先建行动机会模块，不接进 tick。

理由：A 是 codex 建议——保留确定性 + 最低节奏，但不引入隐性配额；B 把「删调度器」提前到 2A（风险变大）；C 建了不接线 = 空转（重蹈 P27 model_version 空转覆辙）。

## User Confirmation（2026-09-13，batch-grill-me Round 1）

- **Q1 机会生命周期**：用户答复 **deadline 到期可重复**（持球段内每次 deadline 到期评估一次；选「继续带球」重置 deadline）。
- **Q2 deadline 计算**：用户委托 codex 推荐 → **几何量公式**（`clamp(BASE(7) - DANGER_URGENCY*danger - PRESSURE_URGENCY*pressure + ESCAPE_BONUS*escape_space, 3, 12)`；danger=距球门、pressure=最近+第二防守者、escape_space=最佳出球空间；门将/后场持球允许更长）。
- **Q3 攻守竞争**：用户答复 **先 carrier 后 defender**（carrier 计划 → defender 竞争 → 结算优先级「死球>防守中断>持球终结>持球普通>无事件防守>beat」）。
- **Q4 槽位过渡**：用户委托 codex 推荐 → **降级为 fallback deadline**（槽位到期只触发一次统一行动评估，不再 `roll_highlight_slot` 选类型；`OpportunityTrigger::NaturalDeadline | FallbackDeadline`）。

## Open Questions

无。2A 四个核心决策已收敛。Shot 提交点（2B）、cooldown 作用域（2C）属后续 change，不在 2A 范围。可立项。
