# 独立审阅报告：p152-sweep-perf（spacing-sweep seed 级并发）

- 审阅者：零上下文独立审阅 agent（Claude）
- 日期：2026-10-12
- 审阅对象：`tools/spacing-sweep.mjs`（重写）＋ `tools/spacing-sweep-core.mjs` / `spacing-sweep-worker.mjs` /
  `spacing-sweep.test.mjs`（新增，untracked）＋ `openspec/changes/p152-sweep-perf/**`
- 基线：branch `p152-sweep-perf/2026-10-12`，从 `main = 15929ad` 切出；`viewer/engine.wasm` 为本 worktree 从源码构建
- 工作目录：`/home/happy/.paseo/worktrees/1g1x3st4/p152-sweep-perf-2026-10-12`

## 0 结论摘要

**核心机制成立，未发现正确性缺陷；但「门自身的失败语义」这一面没有守护，两条 P1 必须在合并前补齐（每条 3–5 行断言）。**

已独立核验成立的（详见 §3）：并发与串行**逐位等价**（4 种执行形态 × 3 seed × 90 窗，sha256 全同）；
worker 与主线程无共享 wasm / 无共享模块状态、4 个 worker 不会污染 stdout；`runPool` 取号与空闲表
无双发、无丢唤醒、无永不 settle；worker 崩溃**不会**静默变绿；D1 的 profile 归因与读数与实物一致；
proposal 的 5 个 CI run 数字逐个核实；**并发确实带来真并行**（cpu/wall 2.37–2.80）且硬约束（不动
`DUR`/`STEP`/默认集/detector/profile/`engine/`/`viewer/`/`ci.yml`）在当前代码里确实遵守。

计数：**P0 × 0，P1 × 2，P2 × 3，NIT × 6**。

---

## 1 Findings

### P1-1 门的「finding ⇒ exit 1」语义没有任何守护；变异可让整条 spacing 门永久变绿

- 文件：`tools/spacing-sweep-core.mjs:240-242`（`sweepExitCode`）、`tools/spacing-sweep-core.mjs:102`（detector 调用）
- 连带：spec delta `specs/match-audit/spec.md:30-33`（Scenario「finding 仍使退出码为 1」）无对应用例
- 现象：把 `sweepExitCode` 改成恒返回 `0`，**8/8 用例全绿**；把 detector 调用换成 `const f = []`
  （findings 永远 0），**8/8 用例全绿**。前者让 CI 的 spacing 门永久通过；后者让门失去「能找到重叠」的能力
  且同样全绿。两者都没有任何测试会响。

  `tools/spacing-sweep.test.mjs:122` 那条退出码断言是**自比**：
  `assert.equal(sweepExitCode(totalFindings(concurrent)), sweepExitCode(totalFindings(serial)))`
  ——两边同时被改坏时恒真，不能替代对 `sweepExitCode` 本身的断言；全套里没有任何一处调用
  `sweepExitCode` 并断言它返回什么（`grep -n sweepExitCode tools/*.test.mjs` 只有这一行自比）。

- 复现/证据（定向变异，见附录 A 的 M4/M9）：

  | 变异 | 结果 |
  |---|---|
  | `sweepExitCode` → `return 0;` | `# tests 8 / pass 8 / fail 0`（**绿**） |
  | `const f = detectPlayerOverlap(...)` → `const f = [];` | `# tests 8 / pass 8 / fail 0`（**绿**） |

  注意：`verify.sh:65` 是全仓**唯一**执行 CLI 的地方，而它本身就是那条门——门恒绿时没有任何下游会红。
  这与本仓「假覆盖声明 / 定向变异存活即坐实缺口」的既有纪律（P15 一轮抓 4 例）同族。

- 建议（廉价）：
  1. 钉住退出码判定：`assert.equal(sweepExitCode(0), 0); assert.equal(sweepExitCode(1), 1); assert.equal(sweepExitCode(7), 1);`
  2. 让 detector 可注入并断言它真被调用、调用次数 = 窗数、且传的是 `DEFAULT_AUDIT_PROFILE`：
     `runSeed({ wasm, seed, dur, step, detect = detectPlayerOverlap })`（与本 change 给 `runPool` 注入
     `runSeed` 的风格一致），测试传 spy。这条同时关掉「detector 被摘掉」与「profile 被换掉」两个口子。
  3. 顺带覆盖 `formatSeedLine` 的 `findings>0` 分支（见 NIT-3）——该分支目前**从未被执行**（M6 变异存活）。

### P1-2 CLI 的失败路径与输出序没有守护；CLI 整体只被一条用例跑到，且只走 exit 2 分支

- 文件：`tools/spacing-sweep.mjs:61-65`（worker/实例化失败的 catch）、`:67`（按入参序打印）
- 连带：spec delta `specs/match-audit/spec.md:13`「并发单元的异常退出或失败 SHALL 导致**非零**退出码，
  SHALL NOT 被静默当作「门通过」」、`:20-23`（Scenario「结果按入参 seed 序输出」）
- 现象：
  1. 把 CLI 的失败分支改成 `process.exit(0)`（即「worker 崩了当成门通过」），**8/8 全绿**。单元测试覆盖的是
     `runConcurrent` **抛出**（`test.mjs:125`），没有覆盖 CLI **把抛出映射成非零退出**这一步；
  2. CLI 的可执行文件在整个测试套件里只被执行一次（`test.mjs:132`），且那条用例设
     `SWEEP_CONCURRENCY=0`，在 `existsSync` 之前就以 2 退出（`spacing-sweep.mjs:38-44` 早于 `:46`）
     ——**CLI 的快乐路径、打印顺序、exit 0/1 从未被执行过**；
  3. `test.mjs:121` 的「输出行必须一致」是 `formatSeedLine` 对同一组（已被上行断言判定相等的）值再映射
     一次，属近恒真，不构成对 CLI stdout 顺序的守护。
- 复现/证据：

  | 变异 | 结果 |
  |---|---|
  | CLI catch 里 `process.exit(1)` → `process.exit(0)` | `# tests 8 / pass 8 / fail 0`（**绿**） |

- 建议：把 CLI 的决策逻辑做成可 import 的纯函数/可注入 `main(argv, env, { runSerial, runConcurrent })`，
  `spacing-sweep.mjs` 只做 `process.exitCode = await main(...)`；测试注入一个「必抛」的 runner，断言
  返回码非零、且没有打印 `OK`。或者在临时目录里用硬链接搭一份 `viewer/`（只把 `engine.wasm` 换成坏字节）
  再 `spawnSync` CLI，断言非零退出——后者更贴 CI 口径，但需要同文件系统的 temp 目录，成本更高。
  （不建议为此给 `WASM_PATH` 加环境变量开关：D4 已明确反对给 CI 留「悄悄换被测产物」的旋钮。）

### P2-1 `DUR`/`STEP`/默认 seed 集/detector 调用没有被任何断言钉住，而 design §D7 的归因与事实不符

- 文件：`tools/spacing-sweep-core.mjs:33-34`（`DEFAULT_DUR`/`DEFAULT_STEP`）、`:41`（`DEFAULT_SEEDS`）；
  归因文字在 `design.md:120-124`
- 现象：design §D7 的覆盖边界写「判据/采样密度/阈值（它们本 change 未动，**且由 `cargo test` + sweep 门自己守**）」。
  这两条都不成立：
  - `grep -rn "sweep\|spacing" engine/ --include=*.rs` 在 Rust 测试里**零命中**（唯一命中是无关的
    `line_spacing_*`，见 `engine/tests/p16_spatial_features.rs`）——`cargo test` 看不到 JS 侧的 `DUR`/`STEP`；
  - sweep 门在**所有** seed 上 finding 恒为 0（我已实测 3 seed × 90 窗、D1 默认集在 main 上也是绿的），
    所以**放宽采样密度恰好是唯一会让门更容易变绿的改法**——门不能守护自己的采样密度。
- 复现/证据（定向变异）：

  | 变异 | 结果 |
  |---|---|
  | `DEFAULT_STEP = 2.5` → `25`（密度降到 1/10） | `pass 8 / fail 0`（**绿**） |
  | `DEFAULT_DUR = 5400` → `2700`（只扫半场） | `pass 8 / fail 0`（**绿**） |

  根因：等价用例显式传 `dur: 5400, step: 1200`（`test.mjs:112`），**从不使用默认值**；其余用例也不碰。
- 建议：加 3 行 `assert.equal(DEFAULT_DUR, 5400)` / `assert.equal(DEFAULT_STEP, 2.5)` /
  `assert.deepEqual(DEFAULT_SEEDS, [...])`；再钉一条窗口数（`step=1200, dur=5400 → windows === 5`），
  可以抓采样循环被改粗/改细/边界漂移。同时把 §D7 那句归因改对（`cargo test` 守不到 JS 常量；门守不了自己）。

### P2-2 design §D3「已知差异」描述的行为在代码里不存在（串行路径也不逐 seed 打印）

- 文件：`design.md:63-65`；对应实现 `tools/spacing-sweep-core.mjs:132-135` 与 `tools/spacing-sweep.mjs:67`
- 现象：§D3 写「已知差异（如实写）：**串行路径逐 seed 打印**，中途崩溃时会留下已打印的前几行；并发路径
  等全部结果才打印，崩溃时不留部分行」。但新代码里 `runSerial` 是 `seeds.map(seed => runSeed(...))`
  ——先算完再返回；CLI 也只在 `for (const r of results) console.log(...)` 一次性打印。**两条路径都缓冲**，
  崩溃时都不留部分行。那句「串行路径逐 seed 打印」是**改前脚本**的行为残留（原脚本在 for 循环里直接
  `console.log`）。这正是本仓反复出现的「doc 声称的机制代码里不存在」。
- 影响：仅文档/判断口径（正常路径的输出确实逐字相同，结论没错），但会误导后来者以为串行分支有增量输出、
  进而据此推断崩溃时的可观测性差异。
- 建议：改写为「两条路径都在全部 seed 完成后才打印（与改动前不同：原脚本边算边打印）；崩溃时都不留部分行」。

### P2-3 生产口径的全量复验（tasks 5.1–5.5）未做，design §D6「实测」是空壳且指向不存在的报告

- 文件：`design.md:90-96`（§D6）、`tasks.md:31-37`（5.1–5.5 全未勾）
- 现象：§D6 的正文只有读数口径，正文最后一句是「（见 change 报告的「复验」一节：串行总耗时 / 并发总耗时 /
  两组 stdout 是否逐字一致 / RSS 峰值。）」——但 change 目录里没有任何报告文件
  （`openspec/changes/p152-sweep-perf/` 只有 `.openspec.yaml` / `proposal.md` / `design.md` / `tasks.md` /
  `specs/`）。同时 tasks §5 排在 §6（独立审阅）**之前**，实际却是先送审、5.x 未做。
- 影响：**最需要生产口径证据的三件事没有证据**——(a) 8 seed × 2157 窗的串行/并发 stdout 逐字对照、
  (b) 真实耗时读数（这是 #152 的全部目的）、(c)「8 seed 的 finding 数与本 change 前的 main 一致」（未引入/
  掩盖 finding）。我用更密的等价探针替代覆盖了 (a) 的执行路径（§3.1），但 (b)/(c) 只有作者能补。
- 建议：合并前补跑 5.1/5.2（并把 §D6 的数字填上）、5.3/5.4，以及 5.5（与本 change 前的 main 对照 finding 数）；
  §D6 要么填数字，要么明确写「待 5.x」。另外 tasks 1.2 见 NIT-6。

### 其余：NIT

- **NIT-1** `design.md:36-47`（§D2）与 `spacing-sweep-worker.mjs:3-5` 的措辞不精确：「同一实例**不可跨 seed
  并发**共享」听起来像「跨线程顺序用就行」。实际是 **wasm 实例（含其线性内存与模块全局）根本无法跨线程
  共享**（除非用 SharedArrayBuffer/shared memory），与是否并发无关。结论（每 worker 自己实例化）正确，
  且我还实测了引擎在**同一实例上跨调用无残留状态**（附录 A 的 P1 探针：8 个默认 seed 在「每次新实例 /
  顺序复用 / 逆序复用」三种调用历史下 JSON sha256 全同；同一 seed 连跑 3 次也全同）——**这才是 §D2/§D3
  真正需要的等价性论据**，比现有措辞结实得多，建议把这条实测补进 §D2（否则后来者可能据现有措辞推出
  「实例可以跨线程顺序共享」）。
- **NIT-2** `tools/spacing-sweep.mjs:46`：用 `existsSync(WASM_PATH)` 取代原来的 `readFileSync` try/catch。
  文件**存在但不可读/损坏**时，原来 exit 2（「缺 wasm」语义），现在会走到实例化抛错 → exit 1。CI 两者都红，
  影响小，但 spec 写的「引擎产物缺失 ⇒ 2」的语义边界被削弱。建议保留 try/catch 读文件。
- **NIT-3** `tools/spacing-sweep-core.mjs:231`：`formatSeedLine` 里 `r.worst.toFixed(3)` 只在
  `r.findings` 为真时执行，而 `worst` 由 `Number.isFinite` 判定为 `null`（`:109`）——「findings>0 ⟹ worst
  有限」这个耦合没有任何断言；若 detector 某天给出没有 `min_distance` 的 finding，CLI 会在打印阶段抛
  TypeError，**丢掉所有已算出的即时空打印**（退出码仍非零，所以不是静默通过）。原脚本同样脆弱（非本 change
  引入），但本 change 把它搬进了「共用纯函数」，正是顺手加断言的位置（M6 证明这条分支从未被执行）。
- **NIT-4** 无超时：worker 若「活着但不回消息」，`await w.run(seed)` 永不 settle → 进程挂起 → 只能靠 CI
  的 30 分钟 job timeout 变红（fail-closed，可接受）。若想更快失败，可在 client 侧加超时或 `worker.unref()`。
  当前**不是**缺陷，只是失败模式的形状。
- **NIT-5** `tools/spacing-sweep.test.mjs:107`：真实 wasm 等价用例在缺 wasm 时**静默 skip**。CI 有 wasm
  （`verify.sh` 第 4 步会挡），所以是本地盲区而非 CI 盲区。可接受，但建议在报告/文档里点明。
- **NIT-6** `tasks.md:6` 的「（本环境有 CLI，须实跑）」在本 worktree **不成立**：`node_modules` 是**自指
  symlink**（`node_modules -> …/football-manager-clone/node_modules`，而该路径自身也指向自己），
  `npx openspec` 无任何输出且 `validate` 退出码 216；`node_modules/openspec` 不可达。所以 1.2 不只是「没勾」，
  在此环境是**跑不了**（需先 `npm ci` 还原）。我无法代跑（见 §4 盲区 4）。

---

## 2 已核验无问题的重点项（附实际跑过的验证）

1. **并发 == 串行逐位等价（可复现、多形态）**——自写探针在**真实** wasm、`DUR=5400`、`STEP=60`（每 seed
   90 窗）、seed `[42, 59, 1]` 下对比四种执行形态，结果 sha256 **完全相同**：
   进程内串行 `dcd990fd24f2e8dc` / 2-worker `dcd990fd24f2e8dc` / 3-worker `dcd990fd24f2e8dc` /
   1-worker `dcd990fd24f2e8dc`（`ALL IDENTICAL: true`；结果体为 3×`{"windows":90,"findings":0,"worst":null}`）。
   另在 4 seed × 22 窗下按「串行→并发」与「并发→串行」两种顺序各跑一遍，两次都 `identical: true`。
   官方守护套件 `node --test tools/spacing-sweep.test.mjs` = **8/8 pass**（15.1s）。
2. **引擎跨调用无残留状态 ⇒ seed 分组不可能改变结果**（design §D2/§D3 依赖它但没写）：8 个默认 seed 在
   「每 seed 新实例 / 单实例顺序跑 / 单实例逆序跑」三种调用历史下，同一 seed 的 JSON sha256 全同；同一 seed
   连续跑 3 次也全同。（这解释了为什么「4 个 worker 各自的分组」与「1 个实例跑 8 个 seed」必然同结果。）
3. **无共享 wasm、无跨线程共享模块状态**：`SweepWorker` 每实例自建；`worker_threads` 各自独立模块表，
   `spacing-sweep-core.mjs:28-29` 对 `config` 的改写是**模块加载期一次性**、在每个线程/进程里各改各的。
4. **4 个 worker 不会污染 stdout**（这是「stdout 逐字一致」最容易被破的一环）：`viewer/game.js` 的 3 处
   `console.log` 全在 `config.debug.enabled` 之后（闸门在 `viewer/game.js:247`），而 core 在模块加载期就把它
   置 false；`observation.js` / `protocol.js` / `config.js` / `derive-audit-features.js` / `detectors.mjs`
   **零** `console.*`。故 worker 不会往 stdout 写任何东西。
5. **`runPool` 取号与空闲表无竞态/无双发/无丢唤醒**：`const i = next++` 在 await **之前**同步完成；空闲表满足
   不变式「`waiting` 非空 ⟹ `idle` 空」（`acquire` 只在 `idle` 空时入队；`release` 直接交接给 waiter），
   故一个 worker 同时只有一条 in-flight，`this.pending` 不会被覆盖。`seeds.length === 0` 时 `size` 下限
   为 1（不会 0 worker），所有下标必被取到 ⟹ `results` 不会留 `null`。
6. **失败面 fail-closed，没有「崩溃变通过」的路径**：实例化失败 → `ready` 拒绝 → `run()` 拒绝 →
   `Promise.all` 拒绝 → `runConcurrent` 抛出 → CLI catch → exit 1（`test.mjs:125` 覆盖）；worker 意外 exit
   （含 OOM 被杀）走同一路径（`spacing-sweep-core.mjs:173-176`）。`ready` 的无人认领拒绝已挂空 handler
   （`:152`），不会有 unhandledRejection 盖掉真错误。被 `terminate()` 打断的在飞请求只是「不再 settle」，
   而 `Promise.all` 已拒绝、进程随即 exit，不构成挂起。
7. **D1 的 profile 读数与实物一致**：seed 42 / `DUR=5400` 的 JSON = **4,917,179 字节**、`events = 6281`、
   窗数 = **2157**（`for(t=5;t<=5395;t+=2.5)`）——与 §D1/proposal 表格逐位相同。本机 30 窗实测
   `new Game` 281ms / `captureObservation` 26ms / detector 1.7ms（本机 load≈8.6，绝对值约 2× 膨胀），
   **占比 91.0% / 8.4% / 0.6% vs §D1 的 91.6% / 7.5% / 0.3%** ——归因成立（贵在逐窗重建 Game，不在 `simulate`）。
8. **proposal 的 CI 前提逐个核实（`gh run view`）**：9.0m / 11.6m / 14.3m（success，v4 前）、**29.5m failure**、
   **26.9m success**（PR #150）——与表格的 9m0s / 11m36s / 14m16s / 29m29s / 26m55s 一致；仓库
   `isPrivate: false`（→ ubuntu-latest 4 vCPU，与 §D4 一致）。
9. **并发确实带来真并行（本 change 的全部目的）**：本机 4 核、外部 load≈12.8 的恶劣条件下，4 worker 的
   `cpu/wall = 2.37`（串行→并发）/ `2.80`（并发→串行），而串行为 1.19–1.24 ⟹ **真多线程并行**；
   wall 12.4s / 10.9s vs 串行 19.4s / 20.9s ⟹ **≥1.7× 提速（受外部负载压制）**，空闲 4 vCPU runner 上应更高，
   proposal 的「~12–15 分钟」量级可信。
   ⚠️ 我**第一次**测到的是 `speedup=1.08x`——那是**测量伪像**（先跑的串行恰好赶上 load 从 5.8 爬升，
   并发跑时 load 已 15.3）；反序复测即恢复。教训：这类机器上单次 wall 读数不可信，要看 `cpu/wall`。
10. **硬约束在当前代码里确实遵守**：`git status --porcelain` = `M tools/spacing-sweep.mjs` + 3 个新 tools 文件
    + 新 change 目录，**`engine/`、`viewer/`、`ci.yml` 零改动**；逐行比对 `runSeed` 与原脚本 body：
    `DUR=5400` / `STEP=2.5` / 默认集 `[42,1,2,3,7,59,18,94]` / `SCRATCH=1024` / `t=5; t<=dur-5; t+=step` /
    `detectPlayerOverlap(..., DEFAULT_AUDIT_PROFILE)` / `sourceRevision:'<spacing-sweep>'` / `opts:{idFactory,now}`
    全部逐字保持；`worst`/`windows`/`findings` 的聚合与输出格式与原脚本等价（findings=0 时省略 tail）。
11. **输出序**：`runPool` 按下标写入 `results`（`core.mjs:124`）+ CLI 顺序打印（`spacing-sweep.mjs:67`）
    ⟹ 恒等于入参 seed 序；fake-runner 用例（完成序刻意颠倒）覆盖了调度层（`test.mjs:57-78`）。
12. **改动面与归档卫生**：`ls tools/zz-*` 无文件（§D8 声称 profile 探针已删 ✓，且 `tools/zz-*` 未被 gitignore，
    若残留会出现在 `git status` 里——没有）；新 change 的四件套齐全，`.openspec.yaml` 的 `schema: spec-driven`
    与其它 change 一致；主 spec `openspec/specs/match-audit/spec.md` 里**无**同名/同题 requirement
    （现有 6 条都是 audit 语义，不涉 sweep），故本 change 用 `ADDED Requirements` 不会造成 MODIFIED header
    漂移式的归档回退（参见 memory「openspec archive validate 盲区」）。
13. **守护测试的变异区分度（与 §D7 表格一致）**：M1（`runPool` 少跑最后一 seed）→ 用例 **3/4/6 红**；
    M2b（真按完成序填结果）→ 用例 **3/6 红**。与 design §D7 表格逐条吻合。

---

## 3 未能核验的盲区（如实列出）

1. **生产口径全量对照未跑**（8 seed × 2157 窗的串行 vs 并发 stdout 逐字 + 耗时）：本机 load≈13/4 核，
   单 seed 全量约 10 分钟（作者在空载机测 5.2 分钟），且后台有长任务争抢，按审阅约定未跑。
   我用 90 窗/seed 的密探针替代覆盖了同一条代码路径（§2.1），但**生产密度下的等价与耗时仍未经实测**。
2. **CLI 可执行文件本身**（快乐路径 / 打印顺序 / exit 0·1）从未被任何测试执行，我也没实跑全量 CLI；
   其顺序正确性是我**读代码**（3 行）推出来的，不是跑出来的。
3. **RSS 峰值（tasks 5.2 列的项）**：我只测了小规模——3 worker 5 窗/seed 峰值 **530MB** vs 进程内串行
   **347MB**（≈ +90MB/worker，Node 基线含在内）。生产全量 4 worker 的峰值未测（按此推算 ~700MB，
   runner 16GB 无压力，但这是外推而非实测）。
4. **`npx openspec validate`（tasks 1.2）在本 worktree 跑不了**：`node_modules` 自指 symlink →
   openspec CLI 不可用（`npx openspec validate …` 无输出、exit 216）。我改为人工核验 delta 结构
   （`## ADDED Requirements` + `### Requirement:` + `#### Scenario:` 层级、每个 Requirement 下都有 Scenario、
   主 spec 无同名 requirement）——格式面无冲突，但 **`validate --strict` 的机器判定未过**。
5. **CI 实测（tasks 6.3）**：未跑 CI，故「总耗时降到 ~12–15 分钟」仍是预期而非实测（我只证明了加速方向
   与并行度真实）。
6. **极限下的 worker 隔离**（design §D7 自认的盲区）：内存增长/OOM 时 worker 实例互不干扰，我未构造。
7. **非 Linux 平台**：`worker_threads` 在 Windows/macOS 上的启动差异未测（本仓 CI 只跑 ubuntu-latest，
   影响面小）。

---

## 附录 A 定向变异总表（每条均**逐字节还原**并核验）

还原核验（全部变异跑完后执行）：
`sha256sum -c /tmp/p152bak/PRISTINE.sha256` → `spacing-sweep-core.mjs: OK` / `spacing-sweep.mjs: OK` /
`spacing-sweep-worker.mjs: OK`；`diff /tmp/p152bak/spacing-sweep.mjs tools/spacing-sweep.mjs` → 空；
`git status --porcelain` = 审阅开始时的同一行集合；套件 8/8 绿。

| # | 变异（生产代码） | 期望 | 实得 | 结论 |
|---|---|---|---|---|
| M1 | `core.mjs:123` `if (i >= seeds.length)` → `seeds.length - 1`（并发路径少跑最后一个 seed） | 红 | 用例 **3/4/6 红** | 与 §D7 表格一致 ✓ |
| M2 | `core.mjs:124` `results[i] = await run(...)` → `results[done++] = await run(...)`（下标在 await 前求值） | 红 | **全绿** | ⚠️ **无效变异**：赋值目标的下标表达式在 `await` **之前**求值，仍是入参序（已用探针确认 `results.map(r=>r.seed) === [42,1,2,3,7]`）。**不作为缺口证据** |
| M2b | 同 M2，但下标在 await **之后**求值（`const r = await run(...); results[done++] = r;`） | 红 | 用例 **3/6 红** | 与 §D7 表格一致 ✓（探针确认该变异真把顺序变成 `[1,2,3,7,42]`） |
| M3 | `runConcurrent` 传给 worker 的 `step` 变成 `step * 2`（workerData 串线/参数错） | 红 | 用例 **6 红** | workerData 管道被真实驱动 ✓ |
| M4 | `core.mjs:241` `sweepExitCode` → `return 0;` | 红 | **全绿** | **缺口 → P1-1** |
| M5 | `spacing-sweep.mjs:64` CLI 失败分支 `process.exit(1)` → `process.exit(0)` | 红 | **全绿** | **缺口 → P1-2** |
| M6 | `core.mjs:231` `worst.toFixed(3)` → `toFixed(2)` | 红 | **全绿** | 缺口（findings>0 分支从未执行）→ NIT-3 |
| M7 | `core.mjs:34` `DEFAULT_STEP = 2.5` → `25`（采样密度 ×1/10） | 红 | **全绿** | **缺口 → P2-1**（且直接违反本 change 的 SHALL NOT） |
| M8 | `core.mjs:33` `DEFAULT_DUR = 5400` → `2700`（只扫半场） | 红 | **全绿** | **缺口 → P2-1**（同上） |
| M9 | `core.mjs:102` detector 调用 → `const f = [];`（门永不失能） | 红 | **全绿** | **缺口 → P1-1** |
| P1(探针) | 非变异：8 seed × 三种调用历史（新实例/顺序复用/逆序复用）+ 同 seed 连跑 3 次，比 JSON sha256 | 全同 | 全同 | 引擎跨调用无残留状态 ✓（§2.2） |

所有变异都用「精确单点替换 + 命中数必须为 1」的脚本施加（`MATCH COUNT != 1` 即拒绝执行），避免误改。

## 附录 B 环境事实（影响本次审阅的可复现性）

- 本机：4 vCPU，内存 7GB（审阅时可用 ~1GB），`load average` 5.8→15.3 波动（有外部长任务）。
  **任何 wall-time 读数都不可信**；内存读数与 `cpu/wall` 比值可用。
- `node_modules` → 自指 symlink（`npm ci` 未跑），故 `npx openspec` / `jsdom` 不可用；
  `viewer/engine.wasm` 为本 worktree 从源码构建（我用它复现了 §D1 的 JSON 字节数 4,917,179 与事件数 6281，
  说明 profile 读数与当前产物同源）。
- 未跑：完整 8 seed sweep、`verify.sh`（第 2 步要求 `node_modules/jsdom`，本环境缺）、任何 CI。
