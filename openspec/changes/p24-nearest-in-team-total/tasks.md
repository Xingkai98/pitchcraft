# Tasks: nearest_in_team 退化态 total 化

## P1. 修复

- [ ] P1.1 `nearest_in_team` 无合法候选时回退该队门将（不返回 -1）

## P2. 测试

- [ ] P2.1 单测：全队外场罚下 → 返回门将（home 0 / away 21），非 -1
- [ ] P2.2 对照组：未全罚下 → 返回最近外场、不返回门将

## P3. 收尾

- [ ] P3.1 `verify.sh` 全绿 + `npx openspec validate --all --strict`
- [ ] P3.2 独立 subagent 审阅闭环

## 关联

- 修复 #43；从 P23（#34）拆出；golden 不变（退化态 canary 不触发）
