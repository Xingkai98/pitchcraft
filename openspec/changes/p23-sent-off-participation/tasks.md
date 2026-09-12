# Tasks: 罚下球员不得再参与比赛

## P1. 引擎侧修复

- [ ] P1.1 `compute_movers` 第一遍目标循环排除 `sent_off`
- [ ] P1.2 `compute_movers` 第三遍门将分支排除 `sent_off`（罚下门将不产 keeper_return）
- [ ] P1.3 `pick_close_down_players` 排除 `sent_off`
- [ ] P1.4 `nearest_defender`（抢断）排除 `sent_off`

## P2. 引擎单元测试（lib.rs）

- [ ] P2.1 `compute_movers` 罚下球员不产 mover（构造 sent_off 场景）
- [ ] P2.2 `nearest_defender` / `pick_close_down_players` 罚下球员不被选中

## P3. L2 不变量测试（realism.rs）

- [ ] P3.1 `MatchStats` 增 `n_sent_off_participation`
- [ ] P3.2 聚合扫描：从 `foul[card=red]` 重建罚下集合，断言此后不出现于 subject/movers/carrier/interceptor
- [ ] P3.3 `l2_cross_event_invariants` 断言为零

## P4. golden 重基线

- [ ] P4.1 人工核对统计摘要只有「罚下球员不再参与」预期变化
- [ ] P4.2 `ACCEPT_GOLDEN=1` 重基线 10 个 canary seed

## P5. 收尾

- [ ] P5.1 `verify.sh` 全绿（引擎单测 + L2 不变量 + golden）
- [ ] P5.2 独立 subagent 审阅闭环

## 关联

- 修复 #34；不碰 viewer/tools/detectors.mjs；不做少一人战术（归 #11）
