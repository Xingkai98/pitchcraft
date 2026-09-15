# Grill Design: #63 主场优势断言三层重构

> batch-grill-me：codex 已标推荐（全 A）。用户确认前不写实现代码。

## 背景（facts，已从代码确认）

- **第 1 层机制测试已存在**：`engine/src/lib.rs:4960` `home_advantage_channel_semantics` 纯函数断言已直接测系数方向——home goal_lo=17（CLINICAL_GOAL_PP_HOME=2）、away=15 不压、saved 宽恒 30、争顶 home≥away 且都 >50 且 sum=110。**这层抓「系数失效/符号反」最快最准，已完成。**
- **第 2/3 层现状**：`engine/tests/realism.rs:834` `l1_home_away_goal_asymmetry`（#[ignore]，verify.sh 第 5 步跑）用 SEEDS_HA=600（seed 401..=1000 预注册冻结），断言 `gh > ga*1.08`（病灶）+ 体积带 + 客队下限。
- **统计事实**：引擎真实 H/A ~1.11；1.08 阈值与真实效应差 3pp；600 场 ratio 95% CI 半宽 ~0.10；相邻 200 场窗口 ratio 波动 0.96–1.27；**可靠分辨 1.08 vs 1.11 需数万场**。故 1.08 只能是「回归护栏」不是「精确下界」。
- 引擎无 Poisson/Skellam/bootstrap 依赖（纯 std）；单场进球低计数（主客各 ~0.4-0.6/场）。

## Grill 决策树（codex 全 A 推荐）

### Q1 第 2 层短窗口门槛

- **A（推荐）纯方向 `gh > ga`**：删 1.08，保留 gh≥60/ga≥40/体积带/客队下限。600 场只负责「发现主场优势消失/反向」，不承担区分 1.08 vs 1.11。
- B 保留 1.08 只加注释：改动最小但语义仍混（真实效应 1.11 vs 硬阈值 1.08），只配作临时方案。
- C 放宽到 1.0（gh>=ga）：宽松但相等时不表达严格方向。

**结论：A。**

### Q2 第 3 层统计方法

- **A（推荐）log(H/A) 正态近似**：`log_ratio ± 1.96·sqrt(1/H + 1/A)`，CI_ratio = exp(CI_log)。主客进球近似独立 Poisson，实现简单、只依赖 std、解释清楚。
- B Skellam 精确 CI：更贴合差值分布，但描述的是 H-A 差值而非 H/A ratio，转 ratio CI 增加复杂度。
- C 按比赛 bootstrap：最 robust 但实现最重（重采样次数/种子/百分位/运行时）。
- D 只报点估计 + 独立 Poisson CI：最简单但回答不了「ratio 不确定性」，正是 #63 要解决的问题。

**结论：A。**

### Q3 第 3 层窗口/载体

- A 2000 场 #[ignore]：CI 更窄但 verify.sh 会跑所有 #[ignore]（需改 verify.sh，超范围）。
- B 独立脚本 tools/：需新增脚本/改 verify.sh，超范围。
- **C（推荐）realism.rs 独立 #[ignore] report-only 测试**：复用 ha_stats() 的 600 场固定窗口，println 点估计+CI，无 assert。改动最小、与短窗口门分离。

**结论：C。**（600 场仍非精细校准，定位是「可重复的校准观察报告」非「显著性证明」；真要稳定估计 3pp 差异需另开任务引入数万场窗口。）

### Q4 第 3 层要不要硬门

- **A（推荐）report-only，不设硬门**：600 场设 ratio/CI 下限会把抽样噪声误报成回归；短窗口方向门已负责发现明显反向。
- B 设宽门（CI 下界 >0.95）：仍是单窗口硬判断，可能因 seed 波动失败，收益有限。

**结论：A。**

### Q5 第 1 层是否补常量断言

- **A（推荐）保持现状**：现有 `h_lo==17` 已覆盖 +2 结果，不再加 `CLINICAL_GOAL_PP_HOME==2` 等 exact-value 锁定，避免把调参值永久冻结（未来合法调参 +1/+3 应不被阻断）。
- B 加显式常量断言：直接锁 spec 数值，但把调参值与机制语义绑定。
- C 全面锁通道常量：最强防漂移，但测试退化成配置快照，与三层拆分目标相反。

**结论：A。**

## 若按推荐走，最小改动集

只改 `engine/tests/realism.rs`：

1. `l1_home_away_goal_asymmetry`：`gh > ga*1.08` → `gh > ga`，注释改为「短窗口方向 sanity，非 ratio 校准」；保留 gh≥60/ga≥40/体积带/客队下限/固定 seed 窗口。
2. 新增 `l3_home_away_goal_calibration`（#[test] #[ignore] report-only）：复用 ha_stats()，汇总 H/A → H/A 点估计 + log(H/A) + SE + 95% CI，仅 println，无 ratio 断言（保留 log(0) 零样本保护但不作 gate）。

**不改**：`engine/src/lib.rs`（机制测试已够）、`verify.sh`（新增 report-only 即使被 verify 跑也不失败）、引擎事件流/RNG/golden（纯测试改动，canary seed 1..=10 与 stream_hash 逻辑不变）。

## golden 影响

**不变，不重基线**：只改测试断言/统计/报告输出，不碰 simulate/RNG 消费顺序/事件 JSON/golden 生成逻辑。

## User Confirmation（2026-09-15，batch-grill-me）

- **Q1-Q5 全按 codex 推荐（全 A）**：短窗口删 1.08 改纯方向 `gh > ga`；长期校准用 log(H/A) 正态近似 CI；载体为 realism.rs 独立 #[ignore] report-only 测试复用 600 场；长期层不设硬门；机制层保持现状不补常量断言。

## Open Questions

无。方向已收敛，可立项（OpenSpec change）。
