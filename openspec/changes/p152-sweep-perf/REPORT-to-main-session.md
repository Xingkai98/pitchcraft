# REPORT → 主 session：p152-sweep-perf（GitHub #152）

**状态**：实现 + profile + 全量复验 + 独立审阅（2 轮）+ 定向变异完成，**待 CI**（未 merge）。
分支 `p152-sweep-perf/2026-10-12`（base main `15929ad`）。

## TL;DR

- **目的**：CI（`timeout-minutes: 30`）被 `tools/spacing-sweep.mjs` 顶到贴边（跑满 8 seed = 26m55s），
  本 change 给 sweep 做 **seed 级并发**（worker_threads）把 CI 拉回安全区。
- **判据零改动**：`DUR`(5400) / `STEP`(2.5) / 默认 seed 集 / detector 阈值 / profile **逐字未动**；
  `engine/`、`viewer/`、`ci.yml` **零改动**。
- **并发 == 串行**：同一 worktree、生产口径（8 seed × 2157 窗）下，**三份 stdout 逐字相同**
  （改前原实现 == 新串行 == 新并发）。
- **本机提速 2.01×**（43m21s → 21m32s，空闲 4 核）；**cpu/wall = 3.2** 证明 worker 真并行。
- **独立审阅 2 轮**：第 1 轮 P0=0 / **P1×2** / P2×3 / NIT×6；第 2 轮（修复后）P0=0 / P1=0 / P2×2（均已闭环）。
  第 1 轮的 P1 是**真缺口**（门的失败语义无守护，变异可让它永久变绿），已修 + 复变异全红。

## 1. Profile（先量再改；读数固化在 design §D1，探针用完即删）

seed 42 / 600s 切片 / 239 窗：**`new Game(events, lineup, 'continuous')` = 143.75 ms/窗 = 91.6 %**；
`captureObservation` 11.8 ms（7.5 %）；detector 0.48 ms（0.3 %）；wasm `simulate` 整场仅 **337 ms/seed（0.9 %）**。

⇒ 贵的在**逐窗重建整场锚点索引**，不在 `simulate` ⇒ **降 `DUR` 既省不到又属改门**（见 design §D5）。
独立审阅用实物复现了这组读数（JSON 4,917,179 字节 / 6281 事件 / 2157 窗 / 占比 91.0 %）。

## 2. 改动（仅 `tools/`）

| 文件 | 作用 |
|---|---|
| `tools/spacing-sweep-core.mjs` | **新增**：`runSeed`（唯一实现）+ `runPool` / `runSerial` / `runConcurrent` + `runSweep`（编排） |
| `tools/spacing-sweep-worker.mjs` | **新增**：worker 入口，**每 worker 自建一个 wasm 实例** |
| `tools/spacing-sweep.mjs` | **改写为薄壳**：解析 argv/env → `runSweep` → `process.exit` |
| `tools/spacing-sweep.test.mjs` | **新增**：16 条守护测试 |

**为什么并发必须每 worker 一个实例**：引擎 exports 有状态（`simulate` 写线性内存 → `get_json_ptr`
读回），而 `WebAssembly.Instance` **根本无法跨线程共享**（design §D2）。每 worker 在**自己实例上顺序**
跑分到的 seed —— 与原脚本「一个实例顺序跑 8 个 seed」是同一用法。

## 3. 全量复验（生产口径：默认 8 seed、`DUR=5400`、`STEP=2.5`、2157 窗/seed）

| 跑法 | 总耗时 | 峰值 RSS | exit | stdout |
|---|---|---|---|---|
| 串行（`SWEEP_CONCURRENCY=1`） | **43m21s** | 374 MiB | 0 | 9 行 |
| **并发（默认 4 worker）** | **21m32s** | 1.26 GiB | 0 | 9 行（**与串行逐字相同**） |
| 改前原实现（8 seed） | 48m49s | — | 0 | 9 行（**与上面两份逐字相同**） |

**提速 2.01×**（低于 4×：每 worker 各持一份进程内存 ⇒ 用 CPU 换内存，4 份并发时 GC/内存带宽成瓶颈 +
收尾负载不均 + 本机有外部负载）。**CI runner 独占 4 vCPU、无外部负载 ⇒ 预期优于本机读数**，
sweep 从 ~20 min 降到 ~10 min 量级 ⇒ 总时长从 26m55s 档降到 ~17 min 档（**以 CI 实测为准**，见 §6）。

其余门槛：`node --test tools/*.test.mjs` **521/521 pass（0 fail / 0 skip）**；
`cd viewer && node e2e-v2.mjs` **OK**；`openspec validate p152-sweep-perf --strict` **valid**。

## 4. 独立审阅（2 轮，零上下文 paseo agent）

**第 1 轮（Claude Fable 5）**：P0=0 / **P1×2** / P2×3 / NIT×6 →
`reviews/independent-review-claude-2026-10-12.md`。两条 P1 都是**门自身的失败语义没有守护**，
靠定向变异坐实（**变异存活即全绿**）：

- `sweepExitCode` 改成恒 `0`、或把 detector 调用摘掉 → 旧套件 **8/8 全绿**（门会永久通过且无人察觉）；
- CLI 失败分支改成 `exit 0` → 同样全绿（CLI 只被跑到一条 `exit 2` 分支，快乐路径/打印序/exit 0·1 从未执行）；
- P2：`DUR`/`STEP`/默认集无任何断言钉住（`STEP→25`、`DUR→2700` 全绿），而 design §D7 把这件事**归因错了**
  （「`cargo test` + sweep 门自己守」两条都不成立）；§D3 的「已知差异」与代码不符；§D6 是空壳。

**修复**：把编排抽成可 import 的 `runSweep`（打印/OK·FAIL/退出码可被单测执行）、`runSeed` 加 `detect`
注入点、常量钉死、`existsSync` 换回 try/catch（「存在但不可读」仍 exit 2）。

**第 2 轮（Claude Opus 5，对修复后的代码）**：P0=0 / **P1=0** / P2×2 / NIT×2 →
`reviews/independent-review-round2-2026-10-12.md`。**6 条曾被证明「存活」的缺口，独立复变异全部变红**
（用例 7/8/9/11/12）；两条 P2 是「变异表计数记号有歧义」与「全量复验未闭环」——均已处理。

**定向变异（两轮，均逐字节还原、无 `MUTANT` 残留）**：
`runPool` 少跑一 seed（用例 3/4/6 红）、按完成序填（3/6 红）、`sweepExitCode` 恒 0（8、11 红）、
detector→`[]`（9、11 红）、`toFixed(2)`（9、11 红）、`runSweep` 失败分支→`return 0`（12 红）、
`STEP`→25 / `DUR`→2700（7 红）。

## 5. 硬约束自查

- `git status --porcelain` = `M tools/spacing-sweep.mjs` + 3 个新 `tools/*.mjs` + 新 change 目录
  ⇒ **`engine/`、`viewer/`、`ci.yml` 零改动**；`DUR`/`STEP`/默认集/detector/profile 逐字未动。
- **未**降采样密度、**未**抬 `timeout-minutes`、**未**拆 job（design §D5 记了为何不采用这三条）。
- `viewer/engine.wasm` 由**本 worktree 从源码**构建（非旧实验产物）。

## 6. 待办 / 下一步

- **CI 实测**：push → PR（base main）→ 报 **CI 总耗时**（对比 26m55s / 29m29s）。
- **本 change 的验收缺口**（如实写）：本机 2.01× 是**受外部负载压制的下界**；CI 独占 4 核的真实提速
  只有 CI 跑完才知道。若 CI 仍未离开危险区，下一根杠杆是 design §D5 记的「复用同一个 `Game` 跨窗」
  （D1 的 91.6 %，但涉及 viewer 层语义，需另立 change）。
- **本 change 已知盲区**（design §D7）：worker「活着但不回消息」无超时（挂到 CI job timeout 才红，fail-closed）；
  缺 wasm 时 4 条真 wasm 用例显式 skip（CI 侧由 `verify.sh` 第 4 步挡住）；`npx openspec` 在本 worktree 不可用
  （`node_modules` 自指 symlink），用了**全局 `openspec` 二进制**。
- **不自行 merge**，等主 session 转达用户确认。
