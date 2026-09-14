# Tasks: 删槽位 + 涌现频率 + liveness guard（#25 阶段 3）

## P1. 删槽位层

- [ ] P1.1 删 `HIGHLIGHTS_PER_MATCH` / `slot_clock` / `slot_interval` / `slot_hold_max` / `roll_fallback_situation` / `FallbackSituation` / `emit_pass_out_play_slot` / `OpportunityTrigger::FallbackDeadline`
- [ ] P1.2 tick 开放比赛分支改为纯自然 deadline 驱动

## P2. 出界涌现（落点误差）

- [ ] P2.1 `sample_pass_landing(from, intended, pass_risk, rng)` 纯函数
- [ ] P2.2 raw 越界 → out_side + 最后触球方 → 重开映射
- [ ] P2.3 删 `PassOutSource::CornerDirect`；重开发球不走出界误差

## P3. liveness guard

- [ ] P3.1 `ticks_since_meaningful_action` + 三层常量 + `liveness_profile`
- [ ] P3.2 接入 deadline / 前插倾向 / pass_risk
- [ ] P3.3 PASS_BREAK_TICKS 独立语义并入 guard

## P4. 5 分钟统计方向性

- [ ] P4.1 删槽位式「5分钟≥90分钟 53%」断言
- [ ] P4.2 1000 场 cohort 方向性护栏
- [ ] P4.3 90 分钟带重新校准

## P5. golden v5 + 收尾

- [ ] P5.1 golden v5 重基线，v1-v4 保留
- [ ] P5.2 `./verify.sh` 全绿 + `npx openspec validate --all --strict`
- [ ] P5.3 独立 subagent 审阅闭环

## 关联

- #25 阶段 3 收官；不碰事件协议/viewer
