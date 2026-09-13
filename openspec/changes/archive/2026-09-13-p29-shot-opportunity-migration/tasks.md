# Tasks: 射门机会迁移（#25 阶段 2B）

## P1. hazard 打分纯函数

- [x] P1.1 `ShotOpportunityFeatures`（distance/angle/space/pressure/cooldown 几何量）
- [x] P1.2 `compute_shot_score(features) -> f64`（五因子）
- [x] P1.3 `shot_hazard_probability(score, window) -> f64`

## P2. ShotSetup 起脚窗口 + committed

- [x] P2.1 `ShotSetup` 增 `committed: bool`
- [x] P2.2 推进到射程 → 起脚窗口（不立即射）
- [x] P2.3 hazard 判定射门 → `committed=true` → 产 Shot

## P3. 被抢断打断

- [x] P3.1 起脚窗口内被抢断 → `canceled → tackle → loose ball`（不产 Shot）

## P4. golden v3 + 频率断言

- [x] P4.1 golden v3 新目录重基线，v1/v2 保留
- [x] P4.2 频率断言改方向性（Shot ≠ 槽数量）

## P5. 测试 + 收尾

- [x] P5.1 hazard 五因子方向测试（近门/正对/无压 → 高）
- [x] P5.2 起脚窗口 + committed + 被抢断测试
- [x] P5.3 `./verify.sh` 全绿 + `npx openspec validate --all --strict`
- [x] P5.4 独立 subagent 审阅闭环

## 关联

- #25 阶段 2B；不碰事件协议/viewer；2C 后续
