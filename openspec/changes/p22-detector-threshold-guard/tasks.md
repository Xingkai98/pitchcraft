# Tasks: detector 阈值算子守卫

## P1. 边界测试

- [x] P1.1 unforced_out：`nearest_defender_distance` 恰等于 8.0 → 不产 realism_warning（严格大于）
- [x] P1.2 inactive_responsibility 分割：位移恰等于 stationary_epsilon 0.5 → 视为移动（≥）
- [x] P1.3 inactive_responsibility 时长：static_duration 恰等于 3.0 → 告警（< 才 continue 跳过）
- [x] P1.4 ignored_interception：`defenderArrival + margin` 恰等于 `ballArrival` → 不产机会（严格小于）
- [x] P1.5 pass_outcomes：`nearest_defender_distance` 恰等于 8.0 → pressured 桶（严格大于才 unpressured）
- [x] P1.6 aggregateAudit band：`rate` 恰等于 `band.max`（baseline_invariant max=0）→ 不升级 failure（严格大于）
- [x] P1.7 unforced_out 几何出界：`x2` 恰等于 pitch.width（105）→ 不算几何出界（严格大于）
- [x] P1.8 unforced_out near-boundary：`distanceToBoundary` 恰等于 boundary_margin 3.0 → 不算 near（严格小于）

## P2. golden finding 签名

- [x] P2.1 记录 7 真实窗口 finding 集合（label + detector_id + severity + event_index + entity_id）
- [x] P2.2 断言逐条一致（签名写死，fixture 不变则签名不变）

## P3. 收尾

- [x] P3.1 `verify.sh` 全绿 + `npx openspec validate --all --strict`
- [x] P3.2 mutation 验证：注入 `>`→`>=` / `<`→`<=` / 删分支，确认新测试变红（守卫有效）
- [x] P3.3 独立 subagent 审阅闭环（F1 测试未提交 / F2 漏 3 算子 / F3 措辞 / F4 勾选，均已修）

## 关联

- 修复 #38；从 P21 审阅 r10 拆出；不改 detectors.mjs 生产逻辑
