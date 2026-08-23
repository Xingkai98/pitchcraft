# Tasks: 真实性统计测试套件（realism-test-suite）

## P1. `engine/tests/realism.rs`：helpers + 聚合

- [x] P1.1 手写 JSON 提取器（深度感知 split_events + 顶层 type/字段提取 + beat main/movers 子字段提取），复用 lib.rs tests 风格，零依赖
- [x] P1.2 `MatchStats` 聚合结构 + `aggregate(seed)`：跑一场 90 分钟比赛，统计 shot/goal/saved/off/header/tackle/corner_kick/out_goal_line/out_sideline/pass/beat 计数、比分、事件流哈希；可批量多 seed

## P2. L1 统计分布断言

- [x] P2.1 普通射门结果分布（goal/saved/off ≈ 15/35/50，detail=header 分流，N=200 seed，3σ 带）
- [x] P2.2 头球射门结果分布（≈ 12/38/50，chi-square GOF，df=2 阈值 13.82）
- [x] P2.3 tackle 成功率稀释模型（overall ∈ [20%,45%]；close ∈ [24%,46%]；不做 close>far——far 恒为 0 死代码）
- [x] P2.4 槽位相对 mix（普通射门:tackle ∈ [1.0,1.8]，普通射门总数 ≥ 800）
- [x] P2.5 corner 派生带（场均 ∈ [2,9]，单场 ≤ 12）

## P3. L2 不变量断言

- [x] P3.1 比分 == goal 计数（whistle score 解析）
- [x] P3.2 射门落点球门矩形（goal/saved y2∈[0.455,0.545]、x2 攻方门线；off_target 贴柱偏出）
- [x] P3.3 beat 节拍固定（相邻间隙 ∈ {1,2}s ±0.001，最大间隙 ≤ 2.0；2s = 角球/界外判定与 kickoff 发球 tick）
- [x] P3.4 速度上界（shot/pass/main/mover，见 design D7）
- [x] P3.5 门将贴门线（keeper_x < 0.15 或 > 0.85）
- [x] P3.6 事件时间范围（t ∈ [-0.001, dur+0.001]）

## P4. Golden master

- [x] P4.1 10 canary seed（1..=10）统计摘要 + 事件流哈希，存 `engine/tests/golden/seed-<n>.json`（`env!("CARGO_MANIFEST_DIR")` 定位）
- [x] P4.2 `ACCEPT_GOLDEN=1` 显式重基线（覆盖写文件）
- [x] P4.3 首次生成基线并人工审查后提交

## P5. 验证收尾

- [x] P5.1 `verify.sh` 加第 4 步（`cargo test --test realism --release -- --ignored`，L1 统计 release 显式跑）
- [x] P5.2 全量 `./verify.sh` 跑通，按实测校准 band（不留拍脑袋带）
- [x] P5.3 代码审阅闭环（subagent 审阅 → 修复 → 再审阅直到通过）
