# Tasks: 持球行动机会核心模块

## P1. 模型定义

- [ ] P1.1 `ActionOpportunity`（carrier/age_ticks/deadline_ticks/reason）+ `OpportunityReason` + `OpportunityTrigger`
- [ ] P1.2 `CarrierAction` / `DefensiveAction` / `ActionResolution` 枚举
- [ ] P1.3 `compute_action_deadline(st)` 几何量公式纯函数

## P2. 决策函数骨架

- [ ] P2.1 `evaluate_carrier_action(st) -> CarrierAction`（纯决策，2A 先映射旧逻辑）
- [ ] P2.2 `evaluate_defensive_action(st, candidate) -> DefensiveAction`（2A 先返回 None/占位）
- [ ] P2.3 `resolve_action_opportunity(...) -> ActionResolution`（结算优先级）

## P3. 接线（行为等价）

- [ ] P3.1 tick 里 slot_clock 到期 → 改触发 `open_action_opportunity(FallbackDeadline)`
- [ ] P3.2 `roll_highlight` 的 Shot/Tackle/Pass 分支 → 映射到 CarrierAction → 原 emit 函数
- [ ] P3.3 机会在球权改变/死球/重开时失效

## P4. 测试

- [ ] P4.1 deadline 公式纯函数测试（近门/受压→短，后场→长）
- [ ] P4.2 结算优先级纯函数测试
- [ ] P4.3 接线后事件流逐 seed 与接线前一致（golden v1 全绿、stream_hash 不变）
- [ ] P4.4 「删除旧路径会红」守卫（证明新模块真的被调用，非 dead code）

## P5. 收尾

- [ ] P5.1 `./verify.sh` 全绿 + `npx openspec validate --all --strict`
- [ ] P5.2 独立 subagent 审阅闭环

## 关联

- #25 阶段 2A；不碰事件协议/统计/viewer；2B/2C/阶段 3 后续
