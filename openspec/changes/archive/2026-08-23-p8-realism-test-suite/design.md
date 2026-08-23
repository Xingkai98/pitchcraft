# Design: 真实性统计测试套件（realism-test-suite）

## Context

分层验证只覆盖正确性，真实性缺口 = 引擎硬编码概率无测试守护。确定性引擎（同 seed 同事件流）+ 种子 RNG → 多 seed 统计分布测试可复现、永不 flaky（比大多数游戏项目的统计验证条件都好）。

研究报告（`research/2026-08-23-match-realism-testability/`）把真实性分成三层：
- **L1 规格一致性**：引擎声明的概率（15/35/50 等）是否忠实实现——最高价值、最便宜。
- **L2 过程真实性**：事件流跨事件不变量（比分一致、落点在球门内、节拍固定、速度不超物理量）。
- **L3 真实数据参考带**：对真实联赛均值区间——当前集锦模型会大面积不过，另立 gate（本 change 不做）。

本 change 落地 A 档的 L1 + L2 + golden master。

## Goals / Non-Goals

**Goals:**
- `engine/tests/realism.rs`：L1 统计分布断言 + L2 不变量断言 + 10 canary seed golden master。
- 进 `verify.sh` 第 4 步，日常全自动跑。
- 全部零新依赖（手写 JSON 提取器，沿用 lib.rs tests 风格）。

**Non-Goals:**
- L3 真实数据参考带（场均进球/射门对真实区间）——当前会红，等目标档位决策后另立 gate。
- 事件级复现验证（公开数据只有聚合统计）。
- viewer 层真实性测试（动画纯函数已有 interpretation 测试覆盖）。
- 引擎逻辑改动（不改 `lib.rs` 行为）。

## Decisions

### D1: 测试形态 = `engine/tests/realism.rs` 集成测试

- 用公开 API（`simulate`、`MatchConfig`、`default_lineup_json`、常量）+ 自写 JSON 提取器（深度感知 split + 顶层字段提取，复制 lib.rs tests 已有 helper 风格）。
- 不把 helper 提到 lib 公共层（避免引擎 API 膨胀；集成测试自带解析器）。
- crate 名 `fm-engine` → `use fm_engine::{simulate, MatchConfig, ...}`。

### D2: 样本量与容忍带

- L1 统计：N=200 seed × 90 分钟，聚合计数按二项模型带断言。两个 L1 测试用 `OnceLock` 共享同一批模拟（`l1_stats()`），避免重复跑。
- 期望量级：24 槽/场（死球/重开占用使实际 ~20-23），普通射门 ~7/场 → 200 场 n≈1200；头球 ~1.2/场 → n≈240。
- 容忍带 = p0 ± 3σ（n≈1200 时 goal σ≈1pp / saved σ≈1.4pp / off σ≈1.4pp）。用 3σ 而非 95% CI 是刻意选择：3 条带并行断言时 95% CI 的联合假红率 ≈ 14%，3σ 降到 ≈1%，CI 门才不 flaky。实测校准后确认。
- **N=200 由头球样本量决定**：N=100 时固定 seed 1..=100 的头球 chi-sq=12.94 距阈值 13.82 仅 0.88（2.9σ 偏样本）；200 场实测 chi-sq≈6.3，余量充足。
- L2 不变量：循环 15 seed，任何 seed 违反即失败（不变量应处处成立）；L2/golden 不 `#[ignore]`（默认 `cargo test` 就跑，debug 实测 ~9s），L1 才 `#[ignore]` + verify.sh 第 4 步 release 显式跑。

### D3: 射门结果分流（regular vs header）

- regular shot（无 `detail` 字段）：goal 15 / saved 35 / off 50，speed ∈ [22, 30)。
- header shot（`detail:"header"`）：goal 12 / saved 38 / off 50，speed ∈ [15, 20)，h=0。
- 混在一起会污染分布断言 → 必须按 detail 分流。

### D4: tackle 成功率 = 稀释模型断言

- 事件流不可见 `same_pair`/`far`/`should_tackle` 内部标志 → 无法直接隔离「贴防首抢 50%」。
- 可观测模型：tackle 事件带 def pos(x,y) 与 victim pos(x2,y2) → 距离可重建。
  - close（dist ≤ 12m）的成功期望 = (1−sp)×(0.5×0.5 + 0.5×0.15) + sp×0，其中 sp = same_pair 占比：
    - 贴防且 eager（一半的贴防）→ normal 50% 成功；
    - 贴防但 not-eager（另一半）→ 按 far 语义 15% 成功；
    - same_pair → 强制 fail 0%。
    - 实测 close≈28%（sp≈14%），与模型吻合。
  - far（dist > 12m）：15% 成功；实测恒为 0（tackle 槽总是取最近防守者）。
- 断言：overall success ∈ [20%, 45%]、close success ∈ [24%, 46%]——只捕获整体大偏差（成功率崩塌/暴涨）。**不做 close>far 单调性断言**——far 恒为 0 使该断言是死代码。**分支间 15%↔50% 互换因 `TACKLE_EAGERNESS=0.5` 的 50/50 加权均值不变而不可见，由 golden master 全流哈希守护**（success/fail 结果改变会级联改变后续事件流）。

### D5: 槽位 mix = 相对比例而非绝对数

- 死球/重开占用时间使每场实际槽位数不固定（~20-23）→ 绝对槽位数断言脆弱。
- 断言相对 mix：**普通射门**（非头球）/ tackle ∈ [1.0, 1.8]（声明 30/22 ≈ 1.36）。用普通射门而非全部射门（排除角球派生头球灌水），并设普通射门总数 ≥ 800。
- corner 数（`detail:"corner"` 的 pass）= 角球槽 + 扑出越线派生 + 解围派生 → 断言**场均** ∈ [2, 9]（0 角球场次正常），单场硬上界 ≤ 12（数量级漂移兜底）。

### D6: Golden master

- 10 canary seed（1..=10）各存：比分、事件数、beat 数、shot/goal/saved/off/header/tackle/pass/corner_kick/out_goal_line/out_sideline 计数、**事件流哈希**（FNV-1a over 完整 JSON）。
- 存储：`engine/tests/golden/seed-<n>.json`，`env!("CARGO_MANIFEST_DIR")` 定位。
- 运行：re-simulate → 比对，任何差异即失败（含哈希）。
- 重基线：`ACCEPT_GOLDEN=1 cargo test --test realism gm_` 覆盖写文件（accept 分支打印「已重基线 seed N，请审查 git diff」）；**提交前必须人工审查 diff**（防「洗白」回归）。
- **统计层未覆盖的概率由 golden 守护**：扑出 caught/rebound 40/60、槽位 corner/throw_in/pass 比例、出界率等没有统计带，但任何改动都会改变 seed 1..=10 的事件流 → 哈希不一致 → 测试红。
- 与统计测试互补：统计说「分布还对」，golden 说「没有任何静默漂移」。

### D7: L2 不变量清单（实现范围）

| 不变量 | 断言 | 期望 |
|---|---|---|
| 比分一致性 | whistle score == shot[result=goal] 计数 | 精确相等 |
| 射门落点 | goal/saved: y2 ∈ [0.455,0.545]，x2 = 攻方门线(0.98/0.02)；off_target: y2 ∈ [0.40,0.445]∪[0.555,0.60] | 精确 |
| beat 节拍 | 相邻 beat 间隙 ∈ {1.0, 2.0}s（2.0 出现在重开准备 tick——角球/界外判定 tick 与进球后 kickoff 发球 tick 均不产 beat），最大 ≤ 2.0 | 精确 |
| 速度上界 | shot speed ∈ [22,30) regular / [15,20) header；pass speed ∈ [10,25)；mover.speed ≤ 8.1；main.speed ≤ 5.1 | 上界 |
| 门将位置 | shot.keeper_x < 0.15 或 > 0.85（门将贴门线） | 上界 |
| 时间范围 | 全部事件 t ∈ [-ε, dur+ε] | 上界 |

## Risks / Trade-offs

- **[统计测试 band 校准]**：band 太宽 → 测不出漂移；太窄 → 假红。缓解：二项模型给初始带 + 实测校准 + 注释声明推导。
- **[golden master 误伤]**：任何观感微调都触发全流哈希失败。缓解：`ACCEPT_GOLDEN=1` 显式重基线 + 提交前人工审查（golden 的 discipline 本身就是防漂移的闸门）。
- **[debug 慢]**：L1 200 场统计聚合 debug 下 ~40s。缓解：L1 `#[ignore]` + verify.sh 第 4 步 release 显式跑（实测 ~16s）；L2/golden（25 场）默认 debug 跑（实测 ~9s）。
- **[event 解析重复]**：与 lib.rs tests 的 helper 重复。缓解：刻意独立（集成测试不应依赖 lib 私有 helper），保持风格一致。

## Migration Plan

1. 写 `engine/tests/realism.rs`（helpers + 聚合 + L1 + L2 + golden）。
2. 首次运行 `ACCEPT_GOLDEN=1` 生成 golden 基线，人工审查后提交。
3. `verify.sh` 加第 4 步。
4. 全量 `./verify.sh` 跑通，校准 band。

## Open Questions

- ~~100 seed 在 debug 下的实际耗时~~：已解决——L1 统计聚合 `#[ignore]`，verify.sh 第 4 步以 release 显式跑（200 seed 实测 ~16s）；L2/golden 默认 debug 跑（25 场实测 ~9s，verify.sh 第 1 步全量 cargo test ~28s）。
- ~~corner 数 band 的实测分布~~：已解决——200 场场均实测 4.18，单场最大实测 ≤12，带定为场均 [2,9] + 单场 ≤12。
