# Tasks: spacing-sweep 的 seed 级并发（#152）

## 1. OpenSpec 工件

- [x] 1.1 `proposal.md` / `design.md` / `tasks.md` / `specs/match-audit/spec.md`（delta，ADDED）
- [x] 1.2 `openspec validate p152-sweep-perf --strict` → **valid**（用**全局** `openspec` 二进制；
      `npx openspec` 在本 worktree 不可用——`node_modules` 是自指 symlink，见 design §D7 边界）

## 2. profile（先量再改，读数落盘）

- [x] 2.1 本 worktree 从源码重建 wasm（不拷旧实验产物）
- [x] 2.2 探针 `tools/zz-profile-sweep.mjs` 分阶段计时（seed 42 / 239 窗）→ design §D1：
      `new Game(...)` = **143.75 ms/窗 = 91.6 %**；`simulate` 仅 0.9 %（⇒ 降 `DUR` 省不到）
- [x] 2.3 探针用完即删（读数已固化进 design §D1）
- [x] 2.4 独立审阅**复现** §D1 的实物读数（JSON 4,917,179 字节 / 6281 事件 / 2157 窗；占比 91.0 %/8.4 %/0.6 %）

## 3. 实现（仅 tools/，引擎与 viewer 零改动）

- [x] 3.1 拆 `tools/spacing-sweep-core.mjs`：`runSeed` 为**唯一**实现，CLI / worker / 测试共用
- [x] 3.2 `tools/spacing-sweep-worker.mjs`：每 worker **自行实例化** wasm（实例有生命期状态）
- [x] 3.3 `tools/spacing-sweep.mjs`：默认 worker_threads 并发（`min(4, CPU)`），输出按入参 seed 序，
      退出码语义不变（finding→1 / 缺 wasm→2 / worker 失败→非零）
- [x] 3.4 SHALL NOT 自查：`DUR`/`STEP`/默认 seed 集/detector 阈值/profile 未动；`engine/`、`viewer/`、
      `ci.yml` 未动（`git status --porcelain` 自查：改动面 = `M tools/spacing-sweep.mjs` + 3 个新 tools 文件
      + 新 change 目录）
- [x] 3.5 **审阅 P1/P2 修复**：sweep 编排抽成可 import 的 `runSweep`（打印/OK·FAIL/退出码可被单测执行）；
      `runSeed` 加 `detect` 注入点（detector 接线可被断言）；`existsSync` 换回 try/catch `readFileSync`
      （存在但不可读 → 仍是 2）

## 4. 守护测试 + 定向变异

- [x] 4.1 `tools/spacing-sweep.test.mjs`：调度面（注入假 runner）+ 真实 wasm 等价面 + **门判据面**（常量/退出码/
      detector 接线/`runSweep` 编排）+ CLI 集成 + `detect` 注入守卫，共 **16 用例**
- [x] 4.2 反证条：等价判据对「少 seed / 顺序颠倒 / findings 少一条 / worst 变 0.001」有区分度
- [x] 4.3 定向变异第一轮（等价性面）：少跑最后一 seed → 用例 3/4/6 红；按完成序填 → 用例 3/6 红
- [x] 4.4 定向变异第二轮（**审阅证明曾存活**的 6 个缺口，复变异验收「修复 = 复变异全红」）：
      `sweepExitCode`→恒 0（用例 8、11 红）、detector→`[]`（用例 9、11 红）、`toFixed(2)`（用例 9、11 红）、
      `runSweep` 失败分支→`return 0`（用例 12 红）、`STEP`→25（用例 7 红）、`DUR`→2700（用例 7 红）
      ——第二轮审阅（Opus 5）**独立复变异**得到同一组红，见 `reviews/independent-review-round2-2026-10-12.md` §2
- [x] 4.5 两轮变异全部**逐字节还原**（`diff` 与备份相同、无 `MUTANT` 残留），还原后 16/16 绿
- [x] 4.6 第二轮审阅的 2 条 NIT：NIT-1（「三条」→「四条」真 wasm 用例）+ NIT-2（`detect` 注入守卫补用例 16）

## 5. 全量复验

- [x] 5.1 `SWEEP_CONCURRENCY=1 node tools/spacing-sweep.mjs`（默认 8 seed）串行：**43m21s**，
      峰值 RSS 374 MiB，exit 0，9 行 stdout
- [x] 5.2 `node tools/spacing-sweep.mjs`（默认并发 4）：**21m32s**，峰值 RSS 1.26 GiB，exit 0；
      **两组 stdout 逐字相同**（`diff` 为空）⇒ **提速 2.01×**（design §D6 记了为何 < 4× 与 CI 预期）
- [x] 5.3 `node --test tools/*.test.mjs` → **521/521 pass, 0 fail, 0 skip**
- [x] 5.4 `cd viewer && node e2e-v2.mjs` → **OK**（6281 事件 / 无 snap / 4 seed）
- [x] 5.5 改前原实现的 8 seed 实跑（同一 worktree、本 change 写文件**之前**启动的进程）：
      **8×2157 窗、全 0 findings、exit 0**，其 stdout 与新串行/新并发**逐字相同**
      ⇒ 未引入也未掩盖 finding

## 6. 独立审阅 → PR

- [x] 6.1 零上下文 paseo agent 审 diff（Claude / `claude-fable-5[1m]`）→
      `reviews/independent-review-claude-2026-10-12.md`（P0×0 / P1×2 / P2×3 / NIT×6）
- [x] 6.2 修完 P1×2 / P2×3 并**复变异全红**（4.4）；NIT 逐条落 design（§D2 措辞、§D3 已知差异、
      §D7 覆盖边界），NIT-2 已改回 try/catch，NIT-3 已断言
- [ ] 6.3 第二个跨模型审阅（GPT via opencode）到达后逐条核对 → 再审
- [x] 6.4 push → PR [#153](https://github.com/Xingkai98/pitchcraft/pull/153)（base `main`）→ **CI 全绿**。
      **CI 读数（机型波动大，三次并列；`cargo test` 当机型代理）**：
      #150（改前）`cargo test` 7m12s / sweep **17m45s（串行）** / job 26m52s；
      本 PR `38239967460` 9m31s / 12m01s / 24m03s；
      本 PR `38243256544` 5m30s / **9m06s** / **16m12s**。
      ⇒ sweep 提速 **1.48×–1.95×**；**正常机型上 job 16m12s，离 30 分钟上限 ~14 分钟余量，目标达成**
- [ ] 6.5 `REPORT-to-main-session.md`（**不自行 merge**，等主 session）
