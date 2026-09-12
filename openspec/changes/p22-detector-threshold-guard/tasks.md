# Tasks: detector 阈值算子守卫

## P1. 边界测试

- [ ] P1.1 unforced_out：`nearest_defender_distance` 恰等于 8.0 → 不产 realism_warning（严格大于）
- [ ] P1.2 inactive_responsibility 分割：位移恰等于 stationary_epsilon 0.5 → 视为移动（≥）
- [ ] P1.3 inactive_responsibility 时长：static_duration 恰等于 3.0 → 告警（< 才 continue 跳过）
- [ ] P1.4 ignored_interception：`defenderArrival + margin` 恰等于 `ballArrival` → 不产机会（严格小于）
- [ ] P1.5 pass_outcomes：`nearest_defender_distance` 恰等于 8.0 → pressured 桶（严格大于才 unpressured）

## P2. golden finding 签名

- [ ] P2.1 记录 7 真实窗口 finding 集合（label + detector_id + severity + event_index + entity_id）
- [ ] P2.2 断言逐条一致（签名写死，fixture 不变则签名不变）

## P3. 收尾

- [ ] P3.1 `verify.sh` 全绿 + `npx openspec validate --all --strict`
- [ ] P3.2 mutation 验证：注入 `>`→`>=` / 删分支，确认新测试变红（守卫有效）
- [ ] P3.3 独立 subagent 审阅闭环

## 关联

- 修复 #38；从 P21 审阅 r10 拆出；不改 detectors.mjs 生产逻辑
