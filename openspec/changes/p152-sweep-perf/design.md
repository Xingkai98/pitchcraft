# Design: spacing-sweep 的 seed 级并发（#152）

## D0 问题与边界

**问题**：CI job `timeout-minutes: 30`；`spacing-sweep`（step 5）在 v4 后把总耗时顶到
26–29 分钟档（#150 跑满 8 seed = 26m55s）。step 5 通过后仍有 step 6–9（含 `realism --ignored`
L1）⇒ 可能越界成**与代码对错无关的红**。

**边界（硬）**：本 change 只动 `tools/spacing-sweep*.mjs` 与新增测试。
**不改** `DUR`(5400) / `STEP`(2.5) / seed 默认集 / detector 阈值 / profile / `engine/` /
`viewer/` / `ci.yml` 的 `timeout-minutes`。理由见 §D5 的未采纳方案。

## D1 先量再改：profile（seed 42，前 600s 的 239 窗）

探针：`tools/zz-profile-sweep.mjs`（一次性，见 §D8 的现场记录），对本 worktree 从源码构建的
`viewer/engine.wasm`（`cargo build --target wasm32-unknown-unknown --release`）实跑。

事件流规模：`events=6281`、JSON `4,917,179` 字节、`lineup=22`。

| 阶段 | 每 seed 次数 | 实测 | 每窗 | 占 sweep |
|---|---|---|---|---|
| `new Game(events, lineup, 'continuous')` | 每窗 1 次 | 34,356 ms / 239 窗 | **143.75 ms** | **91.6 %** |
| `captureObservation`（含 `game.seekTo` 0.04ms） | 每窗 1 次 | 2,818 ms | 11.79 ms | 7.5 % |
| `detectPlayerOverlap` | 每窗 1 次 | 115 ms | 0.48 ms | 0.3 % |
| wasm `simulate`（整场） | **每 seed 1 次** | 337 ms | — | 0.9 % |
| `JSON.parse` + `parseEventStream`（整场） | **每 seed 1 次** | 131 + 3 ms | — | 0.4 % |

**结论**：
1. 每 seed 的昂贵部分是**逐窗**的，不是整场的——`simulate` 只占 0.9 %（**改 `DUR` 省不到**）。
2. 逐窗里 **91.6 % 是 `new Game(...)`**：构造函数每次重建整场锚点索引
   （`buildTimeline` + `_buildAnchorIndex` + `_computeEventEnds` + `_buildHighlightIndex`），
   而这些**与窗时刻 `t` 无关**。2157 窗（实测） × 143.75 ms ≈ 310 s ≈ 5.2 min/seed（本机）。
3. 因此**逐窗优化**（复用 Game）与**并行化**都瞄准同一块；本 change 取并行化，理由见 §D5。

## D2 为什么并发必须「每 worker 一个 wasm 实例」

引擎 exports 是**有状态**的：`simulate(seed, ptr, len)` 把事件流写进**线性内存**，随后由
`get_json_ptr()` / `get_json_length()` 读回同一块内存，再 `free_json()`。`WebAssembly.Memory`
与模块全局量都**绑定在实例上**（`WebAssembly.instantiate` 的产物），不是绑定在模块字节上。

⇒ `WebAssembly.Instance`（含其 `Memory`）**根本无法跨线程共享**——这不是「并发才不安全」，
而是**任何**跨线程使用都不成立（除非走 SharedArrayBuffer/shared memory，本项目不用）；
`worker_threads` 也**不**复制主线程的模块实例，故每个 worker 只能**自行 `instantiateWasm`**
一份（各自读同一份 `viewer/engine.wasm` 字节），在**本 worker 内顺序**处理分到的 seed。

**关键等价性论据（两条，缺一不可）**：

1. **结构性**：原脚本就是「一个实例顺序跑 8 个 seed」。并发路径只是把这条**同样的**「一个实例
   顺序跑若干个 seed」切成若干份，每份仍在自己的实例上顺序执行 ⇒ 单 seed 的计算序列逐字未变
   （同一函数 `runSeed`、同一参数、同一 detector），变的只是「在哪个线程里跑」。
2. **引擎跨调用无残留状态**（独立审阅实测，本条是第一条的**前提**，否则「切成几份」就可能改变
   结果）：8 个默认 seed 在「每 seed 新实例 / 单实例顺序复用 / 单实例**逆序**复用」三种调用历史下，
   同一 seed 的 JSON **sha256 全同**；同一 seed 连跑 3 次也全同。

## D3 结构性等价（而不是「对齐两份实现」）

拆出 `tools/spacing-sweep-core.mjs`：`runSeed` 是**唯一**实现，三条路径共用 ——

- 串行：`runSerial` = 本进程一个实例，`seeds.map(runSeed)`（= 原脚本逐字等价）；
- 并发：`runConcurrent` = N 个 worker，各持独立实例，`runPool` 按空闲分发；
- worker：`tools/spacing-sweep-worker.mjs` 只负责「实例化 + 收 seed + 回结果」。

**保证**：
- 结果按**入参 seed 序**返回（`runPool` 用下标写入，与完成序无关）；
- 每个 seed **恰好跑一次**（同步取号 `next++`，await 之前完成，无竞态）；
- 退出码语义不变（`totalFindings>0 → 1`、缺 wasm `→ 2`、否则 `0`）；
- worker 崩溃/被杀 → 等待者**失败**（不是静默挂起），CLI 非零退出——**绝不能把崩溃当通过**。

**已知差异（如实写，已按审阅 P2-2 订正）**：新实现里**两条路径都是「先算完全部 seed 再打印」**
（`runSerial` 是 `seeds.map(runSeed)`、CLI 只在拿到 results 后 `for … log()`），故中途崩溃时
**都不留部分行**。与**改动前**不同：原脚本在 for 循环里边算边 `console.log`，崩在第 3 个 seed
会留下前 2 行。正常路径（含 findings>0）输出**逐字相同**；退出码语义与「红/绿」判定不变。

## D4 并发度与开关

- 默认 `min(4, availableParallelism(), seed 数)`：`ubuntu-latest` **公开仓 = 4 vCPU**（本仓
  `isPrivate:false`，已核）。本机（4 核）实测默认 4。
- `SWEEP_CONCURRENCY=1` → **串行、进程内**（等价性测试与本地调试用）。
- 非法值（`0` / `-1` / `1.5` / `abc`）→ **报错退出 2**，**不静默回落**：静默回落会让
  「以为开了并发、其实没有」不被察觉（同 P37 `benchmark-crossvalidate` 的「工具自身在已知
  缺失路径返回 0、不加 `|| true`」纪律）。
- **不提供 `DUR`/`STEP` 的环境变量开关**：那等于给 CI 留一个「悄悄放宽采样密度」的旋钮。
  测试之所以能便宜地跑，是因为 `runSeed`/`runSerial`/`runConcurrent` 把 `dur`/`step` 作为
  普通参数，测试直接传参——**production 的 CLI 里这两个值写死**。

## D5 未采纳的方案（与理由）

| 方案 | 为何不采纳 |
|---|---|
| 降 `DUR` / 升 `STEP` | **这是改门**（放宽验收），不是提速。`simulate` 只占 0.9 %，降 `DUR` 也省不到大头。 |
| 抬 `ci.yml` 的 `timeout-minutes` | 治标：把「贴边」变成「更靠边」，且掩盖真回归；#152 票据明确列它只是备选。 |
| 把 step 5 拆成独立 job | 多一个 job 的固定开销（checkout + 装 Rust + 编 wasm）≈ 数分钟，且 step 5 本身仍然慢。 |
| **复用同一个 `Game` 跨窗**（不重建） | 直接命中 D1 的 91.6 %，理论上是更大的杠杆，但 `Game` 的可变状态（`_players` 位置、`playTime`）跨窗复用会改 viewer 层语义：`_interpolateAnchors` 返回 `null`（该球员此刻无锚点）时**保留旧位置**，而新建 Game 会回落到 lineup 站位——是**行为差异**，不是纯提速。**本 change 不动它**（记为后续可立的独立票据：需先证明该分支不可达或改成显式回退）。 |
| 子进程替代 worker_threads | `worker_threads` 更轻（无进程启动 + 无 argv/模块重放），且本任务无隔离崩溃的需求。 |
| 窗级并行（把 2157 窗分片） | 每窗都要一个**独立** Game（见上），分片后仍需每 worker 一个实例；细粒度调度收益不抵复杂度，且输出聚合面更大。 |

## D6 实测（并发 vs 串行）

> 读数口径：同一 worktree、同一份从源码构建的 `viewer/engine.wasm`、默认 seed 集
> `42 1 2 3 7 59 18 94`、`DUR=5400`、`STEP=2.5`；**串行与并发各跑一次完整 8 seed**，
> stdout 逐字对照。本机 4 核（与 CI runner 同量级），机器**空闲**时测得。

| 跑法 | 总耗时 | 峰值 RSS（`VmHWM`，worker_threads 与主线程同进程） | 退出码 | stdout |
|---|---|---|---|---|
| `SWEEP_CONCURRENCY=1`（串行） | **43m21s**（2601 s） | **374 MiB**（382,888 kB） | 0 | 9 行 |
| 默认（并发 4 worker） | **21m32s**（1292 s） | **1.26 GiB**（1,325,724 kB） | 0 | 9 行 |
| **改前原实现**（同一 worktree 的旧 `spacing-sweep.mjs`，8 seed） | 48m49s（2929 s） | 未测 | 0 | 9 行 |

**对照结论**：
- **三份 stdout 逐字相同**（`diff` 为空）：`改前原实现 == 新串行 == 新并发` ⇒ 既证「重构未改行为」，
  也证「并发 == 串行」（本 change 的核心不变量在生产口径、生产密度（2157 窗/seed）下成立）。
- **提速 2.01×**（2601 s → 1292 s）。**低于核数（4×）**，原因：① 每个 worker 各持一份进程内存
  （4.9 MB JSON + 解析后事件 + 整场锚点索引）⇒ 用 CPU 换内存，4 份并发时 GC/内存带宽成为瓶颈；
  ② 负载不均（8 seed / 4 worker 收尾时只有 1 个 worker 在跑）；③ 本机有外部负载。
  另一次在审阅 agent 占 CPU 时跑的并发读数是 23m6s / **user 74m1s ⇒ cpu/wall = 3.2**（对照串行
  1.2）——**证明 worker 确实在并行**，缺口不是「没并发起来」。
- **CI 预期**：CI runner 是**独占** 4 vCPU（无外部负载），sweep 从 ~20 min（8 seed 串行）降到
  ~10 min 量级 ⇒ 总时长从 26m55s 档降到 ~17 min 档，回到 30 分钟安全区（**以 6.4 的 CI 实测为准**）。
- 代价：峰值内存 374 MiB → 1.26 GiB（+3.4×）。CI runner 16 GiB，**无压力**；本机 7 GiB 亦通过。

## D7 守护测试与变异自证

`tools/spacing-sweep.test.mjs`（node:test，进 verify.sh 第 3 步 `tools/*.test.mjs`，本机 **16 用例** ≈ 17 s）：

| 用例 | 守什么 |
|---|---|
| `parseSeeds` / `resolveConcurrency` | 默认集顺序、env=1 串行、非法值报错、按 seed 数收窄 |
| **门被悄悄放宽** | **钉死 `DUR=5400` / `STEP=2.5` / 默认 seed 集 / 窗口数（1200 步 → 5 窗，2.5 步 → 2157 窗）** |
| **退出码判定** | `sweepExitCode(0)=0`、`(1)=1`、`(7)=1`（不是恒 0）；`totalFindings` 求和 |
| **detector 接线** | 每窗**调用一次**、传的是 `DEFAULT_AUDIT_PROFILE`、**拿到的是本窗球员快照**、finding 计入 `worst`、`formatSeedLine` 的 `findings>0` 分支格式 |
| `runPool`（注入假 runner） | 结果**按入参序**（完成序刻意颠倒）、每 seed **恰好一次**、并发**不超上限** |
| 反证条 | 等价判据对「少一个 seed / 顺序颠倒 / findings 少一条 / worst 变 0.001」**都有区分度**（防判据空转） |
| 真实 wasm 等价 | `runSerial` vs `runConcurrent` **逐位一致**（结果 + 输出行 + 退出码）；seed 数(3) > worker 数(2) 覆盖多轮分发 |
| **`runSweep` 编排** | 干净 → **退出码 0** + 按入参序打印 + 末行 `OK`；**有 finding → 1** + `FAIL` 且**不打印 OK**；**执行失败（损坏 wasm）→ 非零** 且不打印 OK；**产物缺失/不可读（含目录）→ 2** |
| CLI 集成 | 非法 `SWEEP_CONCURRENCY` → 退出 2 |
| `detect` 注入守卫 | `concurrency>1` + 非默认 `detect` → **报错**（不得静默忽略注入：否则「测试以为在测注入的 detector、其实没测」）|

> 为什么有「门被悄悄放宽」「退出码判定」「detector 接线」「`runSweep` 编排」这四组：**第一轮
> 独立审阅（`reviews/independent-review-claude-2026-10-12.md`）用定向变异证明它们原本全部缺口**
> ——`sweepExitCode` 改成恒 0、detector 调用换成 `[]`、CLI 失败分支改成 `exit 0`、`STEP` 改成 25、
> `DUR` 改成 2700，**旧套件 8/8 全绿**。归因：判据面（常量/退出码/detector/profile）当时**没有
> 任何断言**，唯一的退出码断言是「并发 vs 串行自比」（两边同时坏掉时恒真），且 CLI 只被跑到
> 一条 `exit 2` 分支。**门的判据面必须由自己钉死**：`cargo test` 看不到 JS 常量，而 sweep 门在
> 所有 seed 上 finding 恒 0 ⇒ 放宽采样密度只会让门**更绿**——门守不了自己的密度（审阅 P2-1）。

**定向变异证据（第一轮，等价性面）**：

| 变异 | 结果 |
|---|---|
| `runPool` 少跑最后一个 seed（`i >= seeds.length - 1`） | 用例 3 / 4 / 6 **红** |
| `runPool` 按**完成序**填结果（而非入参下标） | 用例 3 / 6 **红** |

变异只落在**并发路径**（`runPool` 只被 `runConcurrent` 用；`runSerial` 不经它）⇒ 证明红的是
「并发与串行不一致」这条断言本身，不是别的副作用。

**定向变异证据（第二轮，审阅缺口的复变异验收——「修复 = 复变异全红」）**：

| 变异（均为审阅证明**曾存活**者） | 复变异结果 |
|---|---|
| `sweepExitCode` → `return 0;` | 用例 **8、11** 红 |
| detector 调用 → `const f = [];` | 用例 **9、11** 红 |
| `worst.toFixed(3)` → `toFixed(2)` | 用例 **9、11** 红 |
| `runSweep` 失败分支 `return 1` → `return 0` | 用例 **12** 红 |
| `DEFAULT_STEP = 2.5` → `25` | 用例 **7** 红 |
| `DEFAULT_DUR = 5400` → `2700` | 用例 **7** 红 |

两轮变异均用「单点替换 + 命中数必须为 1」脚本施加，跑完**逐字节还原**（`diff` 与备份相同、
无 `MUTANT` 残留），还原后 16/16 绿。

> `detect` 注入守卫故意用 **throw**（而非 `return 1`）：它是**误用**（只可能来自测试写错，CLI 恒不传
> `detect`），不是运行期失败——混进「执行失败」的返回码会让「注入没生效」看起来像一次正常的红。
> 第二轮审阅（Opus 5）指出该守卫自身原先无守护，已改用例 16 钉住。

**覆盖边界（如实写，勿当全覆盖）**：
- 真实 wasm 的等价用例为控成本**调粗了 `STEP`**（`DUR` 保持 production 的 5400，事件流与
  `Game` 构造是真实规模）——它守的是**调度/隔离**，不是判据面；判据面（默认 `STEP=2.5` 的
  完整 8 seed）由 D6 的**人工全量对照**覆盖，**不在单测里**（一次全量在本机 ≈ 50 分钟）。
- 单测**不**证明「worker 实例互不干扰」在极限（内存增长/OOM）下的行为；只证明正常路径逐位一致。
- **缺 `viewer/engine.wasm` 时**，四条真 wasm 用例**显式 skip**（CI 里 `verify.sh` 第 4 步会先
  挡住缺产物，故这是本地盲区而非 CI 盲区）：跳过的是「真实产物下的等价性」，不是调度面。
- **worker「活着但不回消息」没有超时**（审阅 NIT-4）：`await w.run(seed)` 会一直等 ⇒ 进程挂到
  CI job 的 30 分钟 timeout 才红（fail-closed，方向正确但不快）。本 change 不加超时（避免引入
  「超时阈值」这个新的可调参数）；如实记录为失败模式的形状。
- **`npx openspec validate` 在本 worktree 不可用**（`node_modules` 是自指 symlink）——但**全局
  `openspec` 二进制可用**，`openspec validate p152-sweep-perf --strict` 实测 **valid**。
- **`formatSeedLine` 的 `findings>0 ⟹ worst 有限` 是约定，不是类型强制**（审阅 NIT-3）：
  `player_overlap` detector 无条件写 `features.min_distance`（`tools/detectors.mjs`），故生产路径
  成立，单测也断言了这条耦合；但若**将来**某 detector 产出无 `min_distance` 的 finding，打印阶段
  会抛 TypeError（**退出码仍非零**，不是静默通过）。原脚本同样如此——本 change 保持输出逐字等价，
  不在这里改造 detector 契约（要点名也是 detector/审计层的变更）。

## D8 现场记录

- profile 探针 `tools/zz-profile-sweep.mjs` 为一次性工具，读数已固化到 §D1 后**删除**（本仓
  「探针用完即删」纪律）。
- 本 worktree 的 `viewer/engine.wasm` 由**本 worktree 源码**构建（未拷旧实验产物）。
