# 独立审阅报告（第二轮）：p152-sweep-perf（spacing-sweep seed 级并发）

- 审阅者：第二轮零上下文独立审阅 agent（Claude）
- 日期：2026-10-12
- 审阅对象：第一轮报告 `reviews/independent-review-claude-2026-10-12.md` 的修复成果 + 首轮之后新增的
  `runSweep` 编排 / `detect` 注入 / `existsSync`→try/catch 三处新代码的正确性
- 基线：branch `p152-sweep-perf/2026-10-12`，`viewer/engine.wasm` 为本 worktree 从源码构建
- 方法：读第一轮报告 → 重做 6 条曾被证明「存活」的定向变异（生产代码改坏 → 跑套件 → 逐字节还原）
  → 再审首轮之后的新代码 → 核对文档 vs 代码 → 独立真实 wasm 等价探针

## 0 结论摘要

**第一轮的 P1×2 / P2×2 修复全部真实堵上（6 条定向变异全部变红，我逐字节还原并核验 sha256），
新代码未发现正确性缺陷。可合入，仅剩两条 P2 级收尾：① design §D7 第二轮变异表的计数陈旧（与
15 用例套件实测不符）；② 全量复验 5.1–5.5 仍未完成（第一轮 P2-3 未闭环，后台 8 seed 实跑进行中）。**

计数：**P0 × 0，P1 × 0，P2 × 2，NIT × 2**。

---

## 1 Findings

### P2-1 design §D7 / tasks 4.4 的「第二轮变异表」计数陈旧，与当前 15 用例套件的实测不符

- 文件：`design.md:141-148`、`tasks.md:36-38`
- 现象：design §D7「定向变异证据（第二轮，审阅缺口的复变异验收——『修复 = 复变异全红』）」表格写
  `sweepExitCode→恒 0`＝用例 **8/11 红**、detector→`[]`＝**9/11 红**、`toFixed(2)`＝**9/11 红**、
  `runSweep` 失败分支→0＝**12 红**、`STEP→25`＝**7 红**、`DUR→2700`＝**7 红**；tasks 4.4 原样照抄。
  这些计数显然是在某个**只有 11 条用例的中间态**记录的（分母「11」），而当前套件已是 **15 用例**
  （design 同页 line 107/151 也自认「15 用例」「15/15 绿」）。同一份文档里分母自相矛盾。
- 复现/证据（我重做的 6 条变异，全部**逐字节还原**后 sha256 核验通过）：

  | 变异（生产代码，单点替换、命中数=1） | 期望 | 实测（15 用例套件） | 失败用例 |
  |---|---|---|---|
  | `sweepExitCode` → `return 0;` | 红 | **fail=2** | 8「退出码判定」、11「runSweep 出现 finding」 |
  | detector 调用 → `const f = [];` | 红 | **fail=2** | 9「detector 接线」、11 |
  | `worst.toFixed(3)` → `toFixed(2)` | 红 | **fail=2** | 9、11 |
  | `runSweep` 失败分支 `return 1` → `return 0` | 红 | **fail=1** | 12「执行失败」 |
  | `DEFAULT_STEP = 2.5` → `25` | 红 | **fail=1** | 7「门被悄悄放宽」 |
  | `DEFAULT_DUR = 5400` → `2700` | 红 | **fail=1** | 7 |

  **结论（「复变异全红」）完全成立**——6 条曾存活的缺口现在全部有测试会响，方向正确。
  但**表格里的具体数字与事实不符**：我实测是 2/2/2/1/1/1 条红，不是 8/11、9/11、12、7。
  这与本仓反复出现的「doc 声称的数字与事实不符」同族——作为「证据表」，错的计数会误导后来者
  （比如据此推断「sweepExitCode 变异会红 8 条」）。
- 建议：用当前 15 用例套件重跑一次第二轮变异，把表格改成实测计数（例如上表），并把分母统一为
  15；tasks 4.4 同步。结论句「复变异全红」可保留。

### P2-2 全量复验 5.1–5.5 仍未完成，design §D6 仍是占位符（第一轮 P2-3 未闭环）

- 文件：`tasks.md:41-47`（5.1–5.5 全 `[ ]`）、`design.md:97-103`（§D6）
- 现象：§D6 正文仍只有读数口径，结尾仍是「（见 change 报告的『复验』一节：串行总耗时 / 并发总耗时 /
  两组 stdout 是否逐字一致 / RSS 峰值。）」——change 目录里仍无报告文件，数字没填。
  即第一轮 P2-3 的三件事（8 seed×2157 窗的串行/并发 stdout 逐字对照、真实耗时读数、8 seed finding 数
  与改前 main 一致）**在代码审阅层面仍无证据**。
- 影响：**#152 的全部目的（真实提速读数）与「生产密度下等价」这两件事没有落盘证据**。我（与第一轮）
  用缩小窗口的探针覆盖了等价性的**代码路径**，但生产密度（`STEP=2.5`、每 seed 2157 窗、8 seed）的
  逐字等价与 wall 提速仍只有外推。
- 建议：合并前补跑 5.1/5.2（当前后台 8 seed 实跑应即为此）、5.5（与改前 main 对照 finding 数），
  把 §D6 数字填上，或明确写「待 5.x」。这是第一轮的遗留、非本轮新发现，但仍是合并前的未闭环项。

### NIT-1 design §D7「三条真 wasm 用例显式 skip」应为「四条」

- 文件：`design.md:158`；对应 `spacing-sweep.test.mjs:120/170/188/210`
- 现象：§D7 覆盖边界写「缺 `viewer/engine.wasm` 时，**三条**真 wasm 用例显式 skip」。实际
  `skip: !existsSync(WASM_PATH)` 出现了 **4 次**（用例 6「并发==串行」、9「detector 接线」、
  10「runSweep 干净」、11「runSweep 出现 finding」）。
- 建议：改「三条」为「四条」。

### NIT-2 `runSweep` 的 detect 注入守卫自身无守护，且触发时是裸 stack trace 而非干净文案

- 文件：`tools/spacing-sweep-core.mjs:282-284`
- 现象：`if (concurrency > 1 && detect !== detectPlayerOverlap) throw new Error(...)` 这条守卫**没有
  任何测试会触发它**（全套件没有任何用例同时传 `concurrency>1` + 非默认 `detect`）。若将来有人删掉
  它，并发路径会**静默忽略**注入的 `detect`（worker 恒用生产 detector），注入的 spy 永不调用——这类
  「测试用了注入但生产路径没接」的误用不会被任何测试红。此外该 throw 位于 `runSweep` 的 try/catch
  **之外**，一旦触发是 unhandled rejection 的裸 stack trace（exit 1），而非「执行失败：…」的干净文案。
- 影响：仅测试人体工学 / 防御性，**无生产影响**（CLI 永不传 detect，守卫在生产路径恒不触发）。
- 建议：加一条 2 行用例 `assert.rejects(runSweep({seeds:[1], concurrency:2, detect: ()=>[], ...}), /只支持串行/)`
  钉住守卫；或把该 throw 移进 try/catch 统一走「执行失败 → return 1」。

---

## 2 首轮 P1/P2 修复逐条核验（附我的变异证据）

| 首轮结论 | 修复手段（本轮代码） | 我的复变异 | 判定 |
|---|---|---|---|
| **P1-1** `sweepExitCode` 恒 0 存活 | 用例「退出码判定」断言 `(0)=0/(1)=1/(7)=1` | 恒 0 → **fail=2**（用例 8、11 红） | ✅ 堵上 |
| **P1-1** detector 调用换成 `[]` 存活 | 用例「detector 接线」注入 spy 断言每窗调用 + 传生产 profile | `const f=[]` → **fail=2**（用例 9、11 红） | ✅ 堵上 |
| **P1-2** CLI 失败分支 `exit(0)` 存活 | 编排抽成 `runSweep` 返回退出码 + 用例「执行失败」用**损坏 wasm** 驱动真实实例化失败 | `return 1→return 0` → **fail=1**（用例 12 红） | ✅ 堵上 |
| **P2-1** `STEP→25` / `DUR→2700` 存活 | 用例「门被悄悄放宽」钉死 `DEFAULT_DUR=5400`/`DEFAULT_STEP=2.5`/默认集/窗口数 | 各 → **fail=1**（用例 7 红） | ✅ 堵上 |
| **P2-1**（连带）§D7 归因「cargo test + sweep 门自己守」 | §D7 已改写：`cargo test` 看不到 JS 常量、门守不了自己的密度 | — | ✅ 已改对 |
| **P2-2** §D3「串行逐 seed 打印」与代码不符 | §D3 已订正为「两条路径都先算完全部再打印」 | — | ✅ 已改对 |
| **P2-3** 全量复验未做 | 5.1–5.5 仍 `[ ]`，§D6 仍占位 | — | ⚠️ **仍开放**（见 P2-2） |

**还原核验**：6 条变异全部用「单点替换 + 命中数必须 =1」脚本施加，跑完逐字节还原；
`sha256sum -c /tmp/p152-r2/PRISTINE.sha256` → 4 文件全部 `OK`；`git status --porcelain` 与审阅开始时
逐行相同；还原后 `node --test tools/spacing-sweep.test.mjs` = **15/15 绿**。

## 3 新代码自身的正确性（首轮之后新增的部分）

1. **`runSweep` 编排（core.mjs:261-305）**：三个退出码 2/1/0 全部保住、语义与 spec 一致。
   - 缺/不可读 wasm → 预检 `readFileSync` try/catch → **2**（含「存在但是目录」→ 2，与改前 try/catch
     口径一致，用例 13 覆盖）。
   - 执行失败（worker 崩 / 实例化失败 / 损坏 wasm）→ catch → **1**（用例 12 用「可读但字节非法」的
     损坏 wasm 驱动真实实例化失败，断言非零且不打印 OK）。
   - finding → 1、干净 → 0（用例 10/11 覆盖；打印顺序＝入参 seed 序）。
   - `process.exit` 只在 CLI（`spacing-sweep.mjs:45`），`runSweep` 只**返回**退出码——正是 P1-2 要求
     的「可 import 编排」。
2. **`detect` 注入（core.mjs:83,109）**：`runSeed` 默认参 `detect = detectPlayerOverlap`；并发 + 非默认
   detect 报错（core.mjs:282-284）——生产路径 detect 恒默认，守卫不触发；串行路径注入生效（用例 9/11）。
   函数无法跨 worker 传递这一点判断正确。
3. **`existsSync` 换回 try/catch（core.mjs:271-281）**：修复了 NIT-2 的语义边界——「存在但不可读/是目录」
   重新落入 exit 2（用例 13 断言目录→2）。已核验：预检只读不校验字节，损坏 wasm 落到实例化抛错→1
   （与改前「可读但非法 → 崩溃非零」同义，spec「缺失→2」不受损）。
4. **worker 生命周期 / 拒绝路径**：`ready` 先于派活（worker.mjs:16-17 先 postMessage ready 再 on message），
   无「消息早于监听器」竞态；`fail()` 里 `_rejectReady` + `pending.reject`，error→exit 双事件幂等（第二个
   no-op）；`ready.catch(()=>{})` 消掉「池整体失败早于任何 `run()`」时的 unhandledRejection。**实测**
   `worker.terminate()` 对「已 exit code 1 的失败 worker」**resolve**（不 reject），故 `runConcurrent`
   的 finally `Promise.all(close())` 不会覆盖/污染原始错误、也不会 unhandledRejection。
5. **`process.exit(await runSweep(...))` 不丢输出**：原脚本成功路径自然结束、显式 `process.exit` 是新增——
   我实测 Node 22 下 stdout 走 pipe 时 `process.exit(0)` 不截断（3 行 ≈40B、50 行 ≈2.4KB 均完整）。
   sweep 输出恒为 `seeds.length + 1` 行（每 seed 一行 + OK/FAIL 一行，约几百字节），远在安全区内；
   且门靠退出码（verify.sh `set -e`），即使未来 stdout 被截断也不影响红/绿。非问题。
6. **并发 == 串行等价**：除套件用例外，我另用**独立探针**（seed `[42,18,94,7]`，含红牌 seed 18/94、
   `dur=5400`、`step=2000`，3 worker）实跑真实 wasm：`runSerial` vs `runConcurrent` JSON **IDENTICAL:true**、
   输出行逐字相同、退出码 0=0、顺序 `42,18,94,7` 保持入参序。
7. **`runPool` 取号 / `runConcurrent` 空闲表**：`next++` 在 await 前同步完成；空闲表不变式
   「`waiting` 非空 ⟹ `idle` 空」（acquire 只在 idle 空时入队、release 直接交接给 waiter）成立；
   一 worker 同时只有一条 in-flight，`pending` 不被覆盖。`seeds.length===0` 时 `size` 下限 1，不 0 worker。
   无重入、无丢唤醒、无双发、无永不 settle（worker 死时 `run()` 经 `ready` 拒绝级联到所有等待者）。
8. **崩溃不静默变绿**：实例化失败 → `ready` 拒绝 → `run()` 拒绝 → `Promise.all` 拒绝 → `runConcurrent`
   抛 → `runSweep` catch → 1；worker 意外 exit（含 OOM）走 `exit` 监听 → `fail`（core.mjs:187-190）。
   用例 12/14 覆盖。

## 4 已核验无问题清单

1. 硬约束：`git status --porcelain` 改动面 = `M tools/spacing-sweep.mjs` + 3 个新 tools 文件 + 新 change
   目录；`engine/`、`viewer/`、`ci.yml` **零改动**（`git diff --stat` 空）。`DUR=5400`/`STEP=2.5`/默认集
   `[42,1,2,3,7,59,18,94]`/`DEFAULT_AUDIT_PROFILE`（`min_distance=2.0` 等）与改前逐字一致。
2. `openspec validate p152-sweep-perf --strict` → **「Change 'p152-sweep-perf' is valid」**（全局 openspec
   二进制，本机可用）——design §D7 与 tasks 1.2 的该条声明属实。
3. 首轮 NIT-1（§D2 措辞）已改：§D2 现含「实例含线性内存/模块全局**根本无法跨线程共享**」精确措辞 +
   「引擎跨调用无残留状态（独立审阅实测）」这条等价性论据。
4. 首轮 NIT-2（existsSync→try/catch）已改，见 §3.3。
5. 首轮 NIT-3（formatSeedLine 耦合）已断言：用例 9 断言 `findings>0` 分支的精确输出 `worst=1.400m`，
   且 design §D7 如实记录「约定非类型强制」。
6. 首轮 NIT-4/5/6：NIT-4（无超时）已如实记录；NIT-5（缺 wasm skip）已记录（但「三条」应为「四条」，见 NIT-1）；
   NIT-6（npx 不可用）已订正为「全局 openspec 可用」，且我实测通过。
7. `tools/zz-*` 无残留（§D8 探针用完即删属实）。
8. detector 写 `features.min_distance` 恒为有限数（`detectors.mjs` `round3(minDistance)`），
   `formatSeedLine` 的 `findings>0 ⟹ worst 有限` 约定在生产路径成立。

## 5 未能核验的盲区

1. **生产密度全量对照（8 seed × 2157 窗串行 vs 并发 stdout 逐字 + 耗时）**：即 tasks 5.1/5.2，仍是 `[ ]`。
   后台正有一个完整 8 seed 并发实跑（按约定未干扰）；我的等价探针（step 2000/3 窗）与套件用例
   （step 1200/5 窗）覆盖了同一代码路径，但生产密度下的等价与真实提速读数仍待落盘（见 P2-2）。
2. **tasks 5.5**（8 seed finding 数与改前 main 一致）：需与改前 main 的产物对照，我未跑（需 checkout main
   重建 wasm，超出本轮范围）。
3. **RSS 峰值（5.2 列项）**：未测生产全量；第一轮小规模外推 ~700MB，runner 内存无压力，但非实测。
4. **CI 实测（tasks 6.3）**：未跑 CI，「总耗时降到 ~12–15 分钟」仍是预期而非实测。
5. **`worker_threads` 在非 Linux 平台**：本仓 CI 只跑 ubuntu-latest，Windows/macOS 启动差异未测（影响面小）。

---

## 附录 A 变异施加与还原核验

- 备份：`/tmp/p152-r2/` 下 4 文件 + `PRISTINE.sha256`。
- 施加：Python 脚本「单点替换 + `str.count(old)!=1` 即拒绝执行」，每条变异独立施加→跑套件→还原。
- 还原核验：`sha256sum -c /tmp/p152-r2/PRISTINE.sha256` → `spacing-sweep-core.mjs: OK` /
  `spacing-sweep-worker.mjs: OK` / `spacing-sweep.mjs: OK` / `spacing-sweep.test.mjs: OK`；
  `git status --porcelain` 与审阅开始逐行相同；还原后套件 15/15 绿。

## 附录 B 环境事实

- 本机 4 vCPU、高 load（后台有完整 8 seed 并发实跑 + 外部长任务），wall-time 读数不可信；
  测试套件单次全跑实测 ~20s（design 写「≈10s」，为负载所致，非缺陷）。
- `node_modules` 自指 symlink，`npx openspec` 不可用，但**全局 `openspec` 二进制可用**（已用其
  `validate --strict` 通过）。
- 未跑：完整 8 seed sweep、`verify.sh`（第 2 步需 jsdom）、任何 CI。
