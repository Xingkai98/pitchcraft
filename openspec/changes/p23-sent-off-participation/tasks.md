# Tasks: 罚下球员不得再参与比赛

## P1. 引擎侧修复

- [x] P1.1 `compute_movers` 第一遍目标循环排除 `sent_off`
- [x] P1.2 `compute_movers` 第三遍门将分支排除 `sent_off`（罚下门将不产 keeper_return）
- [x] P1.3 `pick_close_down_players` 排除 `sent_off`
- [x] P1.4 `nearest_defender`（抢断）排除 `sent_off`

## P2. 引擎单元测试（lib.rs）

- [x] P2.1 `compute_movers` 罚下球员不产 mover（构造 sent_off 场景）
- [x] P2.2 `nearest_defender` / `pick_close_down_players` 罚下球员不被选中

## P3. L2 不变量测试（realism.rs）

- [x] P3.1 `MatchStats` 增 `n_sent_off_participation`
- [x] P3.2 聚合扫描：从 `foul[card=red]` 重建罚下集合，断言此后不出现于 subject/movers/carrier/interceptor
- [x] P3.3 `l2_cross_event_invariants` 断言为零

## P4. golden 重基线

- [x] P4.1 人工核对统计摘要只有「罚下球员不再参与」预期变化
- [x] P4.2 `ACCEPT_GOLDEN=1` 重基线 10 个 canary seed

## P6. 审阅暴露的补漏（design D1 三条之外的第五、六条路径）

- [x] P6.1 `nearest_teammate`（传球/发球目标）+ `emit_forward_pass_highlight` 向前传球目标排除 `sent_off`
- [x] P6.2 进球后开球者/接球者（硬编码 id）改用 `kickoff_pick`，排除 `sent_off`；接球者额外排除开球者（防自传）
- [x] P6.3 L2 不变量参与者字段补 `to`；新增 `kickoff_self_pass` 断言
- [x] P6.4 `SEEDS_L2` 15 → 300（原窗口守不到最早出问题的 seed 260，门假绿）
- [x] P6.5 选择器退化态（某队外场全罚下）total 化：不 panic、不返回罚下者，回退门将

## P5. 收尾

- [x] P5.1 `verify.sh` 全绿（引擎单测 + L2 不变量 + golden）
- [ ] P5.2 独立 subagent 审阅闭环

## 关联

- 修复 #34；不碰 viewer/tools/detectors.mjs；不做少一人战术（归 #11）
