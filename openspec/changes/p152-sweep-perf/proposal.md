# Proposal: spacing-sweep 的 seed 级并发（CI 贴着 30 分钟超时，GitHub #152）

## Why

`main` 的 CI（`.github/workflows/ci.yml`，`timeout-minutes: 30`）在 P143r-v4 合入后贴边：

| 时点 | run | 耗时 | 结果 |
|---|---|---|---|
| v4 之前 main | 37594055621 / 37588262386 / 37267656506 | 9m0s / 11m36s / **14m16s** | success |
| v4 合入后 main | 38186370613 | **29m29s** | failure（红在 step 5 的 seed 2——**3 个 seed 就退出**了） |
| 修 #149 的 PR #150 | 38211181679 | 26m55s | success（**跑满 8 个 seed**） |

**风险不是「慢」，是「与代码对错无关的红」**：step 5 一旦通过（如 #150），后面还有
step 6–9（含很慢的 `realism --ignored` L1）⇒ 总计可能越过 30 分钟 ⇒ job 超时红。

**归因（本 change 实测，非猜测）**：全在 `tools/spacing-sweep.mjs` 的每窗开销，且**几乎全在
`new Game(...)` 的构造**（每窗重建整场锚点索引）。seed 42 的 600s 切片实测（239 窗）：

| 阶段 | 每窗 | 占 sweep |
|---|---|---|
| `new Game(events, lineup, 'continuous')` | **143.7 ms** | **91.6 %** |
| `captureObservation`（含 `seekTo` 0.04ms） | 11.8 ms | 7.5 % |
| `detectPlayerOverlap` | 0.48 ms | 0.3 % |
| wasm `simulate`（整场，**每 seed 一次**） | 337 ms/seed | 0.9 % |
| `parseEventStream`（整场，**每 seed 一次**） | 131 ms/seed | 0.3 % |

即：**每 seed 的绝大部分时间 = 2157 窗 × 143.7ms ≈ 5.2 分钟**（本机读数；CI runner 更快）。

## What Changes

**1. `tools/spacing-sweep.mjs` 改为 seed 级并发（worker_threads）**

- 每 seed 的计算**逐字不变**（同一份 `runSeed` 函数、同一 `DUR=5400`、同一 `STEP=2.5`、
  同一 detector、同一 profile）；
- 并发**只用 `worker_threads`**：wasm 实例是**有状态**的（`simulate` 写线性内存 →
  `get_json_ptr`/`get_json_length` 读回），同一实例不可跨 seed 共享 ⇒ **每个 worker
  自行 `WebAssembly.instantiate` 一个独立实例**（各自读同一份 `viewer/engine.wasm` 字节）；
- 并发度默认 `min(4, os.availableParallelism(), seed 数)`（ubuntu-latest 公开仓 = 4 vCPU），
  可用 `SWEEP_CONCURRENCY` 覆盖（`1` = 串行、进程内，供等价性测试与本地调试）；
- **输出顺序与退出码语义不变**：结果按**入参 seed 序**（不是完成序）打印；
  `totalFindings > 0 → exit 1`、缺 wasm `→ exit 2`、否则 `0`；worker 崩溃**必须**非零退出
  （不得静默当成通过）。

**2. 拆出 `tools/spacing-sweep-core.mjs`**（纯逻辑、可注入）：`parseSeeds` /
`resolveConcurrency` / `runSeed` / `runPool` / `formatSeedLine` / 退出码判定。CLI 与
worker、测试三方共用同一份实现——**并发与串行跑的是同一个 `runSeed`**，等价性是结构性
的，不是靠对齐两份代码。

**3. sweep 编排抽成可 import 的 `runSweep` + `runSeed` 加 `detect` 注入点**

第一轮独立审阅用定向变异证明：**旧套件守不住「门自己」**——`sweepExitCode` 改成恒 0、detector 调用
换成 `[]`、CLI 失败分支改成 `exit 0`、`STEP` 改成 25、`DUR` 改成 2700，旧套件**全绿**（门会永久
通过且无人察觉）。修法：把「跑 → 打印 → 退出码」抽成 `runSweep({ … , log, logError })`（**返回**
退出码，`process.exit` 只留在 CLI），并让 `runSeed` 接受 `detect` 注入——于是「打印顺序 / OK·FAIL
文案 / 退出码 0·1·2 / detector 每窗被调用且传生产 profile / 常量未被放宽」都能在单测里被**真正执行**。
（注入点与仓内既有风格一致：`captureObservation` 的 `opts.idFactory/now`、`runPool` 的注入 `runSeed`。）

**4. SHALL NOT（本 change 的硬边界）**

- 不动 `DUR` / `STEP`（= 不改采样密度）、不动 detector 阈值 / profile、不动 seed 默认集；
  **降 `DUR` / 升 `STEP` 是「放宽验收」，本 change 明确不做**；
- 不动 `engine/`、不动 `viewer/`（引擎与演绎层零改动）；
- 不动 `ci.yml` 的 `timeout-minutes`（治标：抬上限不解决贴边，且掩盖真回归）。

## Impact

- **CI**：step 5 的 `spacing-sweep` 从 ~8 seed 串行降至 ~2 波（4 并发），预期总耗时
  从 26m55s 档降到 ~12–15 分钟，回到安全区（设计 D6 记实测）。
- **判据本身零变化**：同一 seed 集合、同一窗口集合 → 同一 finding 集合；等价性由
  `tools/spacing-sweep.test.mjs` 守护（并发 vs 串行逐位一致）+ 定向变异自证区分度。
- 不涉及引擎 / 协议 / 指标口径 → 基线哨兵、`match-metrics` 无关，无需重生成基线。

## 关联

- 票据：GitHub #152；上游触发：#148（v4 合入）/ #149。
- 参照纪律：CLAUDE.md「先量再改」——本 change 的 profile 读数落在 `design.md` §D1。
