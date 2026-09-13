# Tasks: player_overlap 同队间距 detector

## P1. detector 实现

- [x] P1.1 `detectPlayerOverlap(players, profile)`：按 t 对齐、team 按 id 范围、按 pair 聚合
- [x] P1.2 profile 增 `player_overlap: { min_distance: 2.0, calibrated: false }`
- [x] P1.3 runAudit 集成 + statsFor 计数（样本口径 = 同队球员对数）

## P2. 契约登记

- [x] P2.1 contract 增 player_overlap 条目（reads t/x/y，producer viewer/derive）

## P3. 测试

- [x] P3.1 真实 fixture：现状有告警（引擎未修）
- [x] P3.2 阈值边界：=2.0 不报 / <2.0 报
- [x] P3.3 聚合：同 pair 多采样点只报一条
- [x] P3.4 discoverability 守卫通过

## P4. 收尾

- [x] P4.1 `verify.sh` 全绿 + `npx openspec validate --all --strict`
- [ ] P4.2 独立 subagent 审阅闭环

## 关联

- 修复 #35 detector 部分；引擎侧归 #53（等 #25）
