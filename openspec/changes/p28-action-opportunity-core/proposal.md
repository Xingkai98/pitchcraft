# Proposal: 持球行动机会核心模块（#25 阶段 2A）

## Why

引擎现在靠 `roll_highlight_slot`（固定比例抽签 Shot 35%/Corner 12%/ThrowIn 18%/Tackle 22%/Pass 13%）**先决定事件类型、再反推场上动作**——因果倒置（#25）。射门/抢断/传球不是从「持球者 + 局部状态」涌现，而是「配额抽到什么类型」。

本 change 是 #25 阶段 2A：**先建「持球行动机会」这个深模块**（谁在什么局部状态、决定什么行动），把「行动评估」从「事件类型配额」里解耦出来。槽位时钟降级为「fallback 触发」（只触发一次统一行动评估，不再选类型）。**不动事件协议、不动统计**——纯内部模型重构，为阶段 2B（射门 hazard）/2C（防守接触竞争）/3（删槽位 + C 路护栏）铺地基。

## What Changes

新增内部模型（`engine/src/lib.rs`）：

- `ActionOpportunity`：持球行动机会（carrier、age_ticks、deadline_ticks、reason）。
- `CarrierAction`：持球者候选动作（Dribble / Pass{target} / Shoot）。
- `DefensiveAction`：防守者候选动作（Tackle / Foul / Contain / Jockey / None）。
- `ActionResolution`：结算结果（CarrierAction / InterruptedByTackle / InterruptedByFoul / DefensiveContainment / DefensiveJockey / NoAction）。
- deadline 计算：几何量公式（danger + pressure + escape_space）。
- 槽位时钟降级：`OpportunityTrigger::NaturalDeadline | FallbackDeadline`，fallback 只触发评估、不选类型。

## Capabilities

### Modified Capabilities

- `match-engine`: 开放比赛的行动评估由「持球行动机会」驱动，槽位时钟降级为 fallback 触发（不再决定事件类型）。

## Impact

- `engine/src/lib.rs`（新模块 + tick 接线 + slot_clock 降级）
- 纯决策函数测试
- **不改事件协议**（event-stream-protocol 无 delta）、**不改统计/频率**（golden v1 语义不变——行为暂不变，见设计 D5）

## 关联

- #25 阶段 2A；方向已拍板（C 路 + 真实 5 分钟）；grill 定稿见 `reviews/grill-design.md`
