# Tasks: 射门质量模型（shot-quality）

## P1. 引擎：三桶概率 + 混合推进 + 射门槽 35%

- [x] P1.1 `emit_shot_highlight` 概率改三桶：禁区内 15/30/55、禁区弧 7/22/71、远射 4/11/85（校准后，见 design D1）；`shot_target` 保持落点逻辑
- [x] P1.2 射门推进（shot setup）：`MatchState` 加 shot_setup（drive_ticks_left + target_dist）；射门槽采样目标射门距离（box 58%/arc 27%/far 15%），carrier 已在目标内直接射，>40m 向前传球推进，否则带球精确落点推进（步长 min(5m, 剩余)，≤5 tick）；推进期间 slot 时钟暂停；超上限强射
- [x] P1.3 `emit_header_shot` 概率对齐禁区桶（goal 15 / saved 30 / off 55）
- [x] P1.4 `roll_highlight` shot 槽占比 30% → 35%（`roll_highlight_slot`）
- [x] P1.5 `tick()` 增加 shot_setup 分支（对齐 restart_prep/transition 状态机模式）；`goal_kick_land` 避开球员落点（门球应为争抢球）

## P2. 测试更新

- [x] P2.1 L1 射门断言改三桶：禁区内 ≈15/30/55、禁区弧 ≈7/22/71、远射 ≈4/11/85（各桶样本 ≥150，校准带）；头球 chi-square 期望改 15/30/55
- [x] P2.2 L1 新增禁区内射门占比断言 ∈ [45%, 65%] + 无 >45m 射门断言（起脚位置从 known-gap 变正式，落在 L1）
- [x] P2.3 L1 槽位 mix 期望改 shot 35%（shot:tackle ≈1.59，带 [1.0,1.8]）
- [x] P2.4 L3 gate 启用（射门相关）：射正率 [28%,39%]、转化率 [8%,14%]、禁区内进球占比 [72%,92%]（实测 38.3%/13.1%/86.9%）
- [x] P2.5 golden 10 canary seed re-baseline（ACCEPT_GOLDEN=1 + 人工审查 diff 后提交）

## P3. 验证收尾

- [x] P3.1 跑 verify.sh（含 realism L1 release），校准分桶带/起脚分布
- [x] P3.2 代码审阅闭环（subagent 审阅 → 修复 → 再审阅直到通过）
