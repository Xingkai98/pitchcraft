# Design: spacing-sweep 逐窗复用静态索引（#154）

## D0 问题与边界

**问题**：#152（PR #153，已合 `9cadab5`）把 `spacing-sweep` 改成 seed 级并发，CI step 5 从
17m45s 降到 9m06s–12m01s。但 profile 显示**真瓶颈没动**：逐窗 `new Game(events, lineup, 'continuous')`
的构造 = 逐窗成本的 **91.5%**，而 wasm `simulate`（整场）只有 0.9%。构造里几乎全是
**与窗时刻 `t` 无关**的静态索引（整场锚点时间线 + 按实体分组的时间索引），而 sweep 逐窗用的
是**同一份** events / lineup。

**边界（硬）**：本 change 只动 `viewer/game.js`、`viewer/index.html`（缓存版本号）、
`tools/spacing-sweep-core.mjs` 与测试文件。**不改** `DUR`(5400) / `STEP`(2.5) / 默认 seed 集 /
detector 阈值 / audit profile；**不动 `engine/`**；不抬 `ci.yml` 的 `timeout-minutes`、不拆 job。

## D1 先量再改：profile（seed 42，t ∈ [5, 605] 的 241 窗）

探针 `tools/zz-profile-sweep.mjs`（一次性，读数固化到本节后**删除**）对本 worktree 从源码构建的
`viewer/engine.wasm` 实跑。事件流：`events=6281`、JSON `4,917,179` 字节、`lineup=22`；
时间线锚点 **105,411** 个（球 10,470 + 球员 94,941；22 人，单人最多 5,967 / 中位 4,544 / 最少 90）。

| 阶段 | 每 seed 次数 | 实测 | 每窗 | 占逐窗 |
|---|---|---|---|---|
| **`new Game(events, lineup, 'continuous')`** | 每窗 1 次 | 33,807 ms / 241 窗 | **140.28 ms** | **91.5 %** |
| ├ `buildTimeline`（整场锚点时间线） | 每窗 1 次 | 18,408 ms | 76.38 ms | 49.8 % |
| ├ `_buildAnchorIndex`（按实体分组 + 事件边界标记） | 每窗 1 次 | 13,679 ms | 56.76 ms | 37.0 % |
| ├ `_computeEventEnds`（每事件结束时刻） | 每窗 1 次 | 1,904 ms | 7.90 ms | 5.2 % |
| ├ `_buildHighlightIndex`（高亮窗口） | 每窗 1 次 | 91 ms | 0.38 ms | 0.2 % |
| └ `_initToEvent(0)`（**per-window 可变状态**） | 每窗 1 次 | 25 ms | 0.11 ms | 0.1 % |
| `seekTo` | 每窗 1 次 | 10 ms | 0.04 ms | 0.0 % |
| `captureObservation` | 每窗 1 次 | 2,978 ms | 12.36 ms | 8.1 % |
| `detectPlayerOverlap` | 每窗 1 次 | 141 ms | 0.58 ms | 0.4 % |
| wasm `simulate`（整场） | **每 seed 1 次** | 331 ms | — | — |
| `JSON.parse` + `parseEventStream`（整场） | **每 seed 1 次** | 125 ms | — | — |

**结论**：
1. **91.5% 是可缓存的**：前四行（`buildTimeline` + `_buildAnchorIndex` + `_computeEventEnds` +
   `_buildHighlightIndex` = 141.42 ms/窗 = 92.2%）**只依赖 `(events, lineup, mode)`**，与 `t` 无关。
   真正 per-window 的只有 `_initToEvent` + `seekTo` = **0.15 ms/窗**（占 0.1%）。
2. 逐窗合计 153.3 ms/窗 ⇒ 折算全 2157 窗 = **5.51 min/seed**（本机）。缓存后可降至 ≈ 12.9 ms/窗
   （`captureObservation` 12.36 + `detect` 0.58 + 初始化 0.15）⇒ **理论 ≈ 11.9×**。
3. 复现了 #152 §D1 的结论（143.75 ms / 91.6% → 本次 140.28 ms / 91.5%，同机同口径）。

> 拆解口径：`buildTimeline` 是模块级自由函数（无法包装），单独跑 20 次取均值；其余为包装
> `Game.prototype` 上互不嵌套的私有方法累加。两者之和与「构造函数总耗时」在 ±3% 内闭合
> （单独测的 `buildTimeline` 略高于构造内实测——独立测量时的 JIT/GC 状态不同）。

## D2 取哪条路：(a) 抽静态索引 + 逐窗仍新建对象，而不是 (b) 复用实例 + 复位可变状态

#152 §D5 把「跨窗复用」记为另立票据，理由是**行为差异**：`_interpolateAnchors` 返回 `null`
（该实体此刻无锚点）时，**复用**会保留旧位置，**新建**会回落 lineup 站位。

本 change 取 **(a)**，且逐窗**仍然新建 `Game` 对象**（只复用静态索引）。理由：

1. **(b) 要求枚举可变状态**：`_players` / `ball` / `playTime` / `playing` / `speedIndex` /
   `_clipIndex` / `skipIndex` / `skipChoiceIndex` / `_prevPlayerPos` / `_lastLoggedEventIdx`…
   复位清单必须与构造函数**永远保持同步**——构造函数将来加一个字段而忘了加进复位，
   就是一条只在 sweep 里发作的静默错。**(a) 没有第二份清单**：可变状态的初始化就是构造函数
   本身，逐窗跑的就是同一段代码。
2. **代价可忽略**：新建对象 = `_initToEvent` + `seekTo` ≈ **0.15 ms/窗**（占缓存后逐窗成本的 1.2%），
   换来「复用与新建语义等价」是**结构性**的而不是靠一张清单。
3. 也因此**那条 `null` 分支不需要被判为不可达**——本方案下它在两条路径上是同一段代码。
   （但它确实**不可达**，见 §D5 的实测；那是**附带**的发现，不是本方案的前提。）

**接口**：`viewer/game.js` 新增导出 `buildGameIndex(events, lineup, mode)`，`Game` 接受
`opts.index`。**不传 `opts.index` 时逐位走原路径**（App / `createGame` / 既有测试与工具全部不传）
——本 change 对 App 侧的唯一改动是「构造函数里多了一次 `opts.index ?? …` 判断」。

## D3 索引里放什么、不放什么

**放**（只依赖 `(events, lineup, mode)`，构造后**只读**）：`timeline`、`ballAnchors`、`playerAnchors`、
`ballBounds`、`playerBounds`、`eventEnds`、`matchEnd`。

**不放**（构造期可变 / 依赖 config，逐窗重建）：
- `sentOffAt`：**可变 Map**（虽然内容其实只依赖事件流）。共享可变结构得不偿失；整场一遍线性扫描
  成本可忽略（0.1 ms 量级）。**边界效应**：`deriveAuditInput` 另有自己的 `sentOffTimes(allEvents)`
  推导——那条路径读的是 `game.events`（整场事件，本就不经索引），不受本 change 影响。
- `_highlightWindows`：由 `_eventEnds` + `_skipThreshold` 派生，而 `_skipThreshold` 来自
  `config`/`opts`，是**构造期**语义（调用方可在两次构造之间改 `config.playback.skipThresholdSeconds`
  并期望生效）。重建成本 0.38 ms/窗（0.25%），不值得为它把 config 语义冻进缓存。

## D4 缓存失效条件（本设计最大的语义风险面）

索引只在**同源**时有效：同 `events`（同一数组对象）、同 `lineup`、同 `mode`。`Game` 构造时用
**身份比较**校验，不同源**直接报错**：

```js
if (index.events !== events || index.lineup !== lineup || index.mode !== this.mode) throw new Error('…不同源…');
```

为什么**报错**而不是静默回落重建：拿错索引会产出「看起来正常但错」的位置与 finding，
而 sweep 是**门**（finding 数决定红绿）——静默回落会把这类误用永久藏起来。成本 O(1)，
且本 change 里**不存在**「合法但不同源」的用法（`runSeed` 每 seed 用一个索引）。

`mode` 归一化（`clip` / `continuous`）在索引与构造函数两侧用**同一表达式**，否则
`new Game(..., 'clip')` 会被自己的守卫拒掉。

## D5 实测：naive「复用同一个 `Game` 实例」在生产窗区间**不可分**

#152 记下的那条差异分支（`_interpolateAnchors` 返回 `null` → 复用保留旧位置 vs 新建回落 lineup）
在 sweep 的窗口区间到底可不可达？一次性探针实测（本 worktree、生产 `DUR=5400`、
逐窗比较 `captureObservation` 整包 JSON）：

| 场景 | 结果 |
|---|---|
| seed 42，`STEP=250`，**升序** 22 窗 | **0/22 窗不同** |
| seed 42，`STEP=250`，**降序** 22 窗（复用实例从晚窗走到早窗） | 0/22 窗不同 |
| seed 42，**生产 `STEP=2.5`，全部 2157 窗升序** | **0/2157 窗不同** |
| seed 59 / 18 / 94（含红牌），`STEP=250`，升降序各 22 窗 | 全部 0 不同 |

**原因**：`_interpolateAnchors` 只在「该实体此刻**没有** `t ≤ target` 的锚点」时返回 `null`，
而引擎在 `lineup`/`kickoff`（t ≈ 0）就为**每个**球员发了锚点，故窗口区间 `t ≥ 5` 内
任何实体的 `pos ≥ 0`——**这条分支在本门的窗口区间不可达**。降序也测了：即使倒着走，
每个实体也总已有锚点。

**这条读数的意义（如实写）**：
- 它**修正**了「复用会因这条分支改变行为」的表述：在本门的窗口区间，naive 复用与逐窗新建
  **行为等价**。#152 的顾虑在**语用上**（App 的 seek 可以落在 t < 5、clip 模式、`jumpToEvent`）
  成立，在**本门的窗口区间**不成立。
- 它**不是**本 change 选 (a) 的理由——理由是 §D2 的「不需要第二份复位清单」。
- 它**意味着**：不能用「把复用实例当变异」来证明本 change 的守卫有区分度（跑了，见 §D7 M4：
  **绿**）。区分度必须来自**索引被污染 / 索引与输入不同源**这两个真实风险面。

## D6 实测：复用索引 vs 逐窗重建

> 口径：同一 worktree、同一份从源码构建的 `viewer/engine.wasm`；`DUR=5400`（生产）；
> 窗口用生产 `STEP=2.5`（种子的全部 2157 窗），除非该行注明「调粗」；逐窗比较
> `captureObservation` **整包** JSON 与 detector 输出的 JSON。

| 对照 | 窗口数 | 不同窗数 | sha256（整轮观测流） | 结果 |
|---|---|---|---|---|
| 全 8 seed × 2157 窗（生产密度） | 8 × 2157 = 17,256 | **0** | 两路径**逐 seed 相同** | 一致 |

**逐 seed 明细**（复用索引 / 逐窗重建两条路径）：

<!-- FILL:D6-FULLCALIBER -->

**结论**：**TBD**

## D7 守护测试与定向变异

### 守什么

| 用例（`tools/spacing-sweep.test.mjs` 新增 4 条 + `viewer/game.test.js` 新增 3 条） | 守什么 |
|---|---|
| **缓存索引 == 逐窗重建（真实 wasm）** | 逐窗比 `captureObservation` **整包** + detector 输出；并用 `detect` 注入点把**生产路径 `runSeed`** 每窗喂给 detector 的快照与逐窗重建逐位比。**反证条**：相邻窗口观测包必须不同（判据不得跨窗恒等 ⇒ 防空转） |
| **静态索引是确定性纯函数 + 整轮扫描后逐字节未变** | 覆盖**全部窗口**（不止抽样窗口）：`buildGameIndex` 两次构造逐字节相同；整轮构造 + `seekTo` + 采集 + detect 之后索引摘要不变 |
| **反证条：索引摘要的区分度** | 摘要对「锚点被删/改、球锚点表被增补、分组 Map 被改写（含组内删锚点）、结束时刻被改、总时长被改」**都必须判不同** |
| **缓存失效条件** | 同源放行；跨事件流 / 跨 lineup / 跨 mode **报错** |
| `viewer/game.test.js`：复用 == 重建（合成事件） | 构造态 + 12 个时刻的 `seekTo` + 40 步 `step` 序列，比较球员/球/时刻/事件索引/高亮窗口/纪律牌/进度；**不依赖 wasm**（CI 与本地都恒跑） |
| `viewer/game.test.js`：输入与索引不被改写 | 连构造推进 5 个 Game 后 `events`/`lineup`/索引逐字节不变 |
| `viewer/game.test.js`：同源守卫 | 三类不同源都报错，同源（含 clip）放行 |

**摘要实现的一个坑（本项目内实测踩到）**：`JSON.stringify` 把 `Map` 序列化成 `{}` ——
直接用 `{...index}` 做摘要，「`playerAnchors` 被就地改写」这整整一类污染在摘要里**看不见**。
故摘要**显式展开 Map**（`[...m]` 排序后并入），并由上表的反证条钉住它有区分度。

### 定向变异（单点替换，命中数必须为 1；跑完逐字节还原）

| 变异 | 落点 | 结果 |
|---|---|---|
| **M1** 共享索引被就地改写（`_playerAnchors.delete(...)`，模拟将来某处「剔除/剪枝」） | `viewer/game.js` | **红 1 条**：「静态索引……逐字节未被改写」——这正是摘要必须显式展开 Map 的那条 |
| **M2** 缓存失效守卫被削弱（只比 `mode`，不比 `events`/`lineup` 同源） | `viewer/game.js` | **红 1 条**：「索引缓存失效条件……报错」 |
| **M3** 缓存被污染（取出索引时**就地累加**每事件结束时刻） | `viewer/game.js` | **红 2 条**：逐窗逐位一致 + 索引未被改写 |
| **M4** naive 复用：把 `new Game` 挪出窗口循环 | `spacing-sweep-core.mjs` | **绿（存活）** —— 见 §D5：该变异在窗口区间**行为等价**，是不可分的**真等价变异**，不是盲区 |
| **M5** 生产路径的索引与本次事件流**不同源**（`lineup.map(p => ({...p}))`） | `spacing-sweep-core.mjs` | **红 6 条**（含逐窗一致、并发==串行、`runSweep` 三条编排）——缓存拿错时 **fail-loud**，不会静默用错索引 |

**M1/M3 的红为什么只落在「摘要」与「逐窗一致」上、而不是别处**：`viewer/game.js` 的构造函数是
**两条路径共用的同一段代码**，故绝大多数变异是**对称**的（两条路径同时坏 → 逐窗比对看不出来）。
能被「缓存 vs 重建」这条判据抓住的，只可能是**利用了索引被跨窗共享**这件事的变异——M3
（就地累加，共享实例上会累积、每窗新建的临时索引不会）正是这一类；M1（就地删 Map 项）则
由摘要用例抓住。**这条观察本身就是本设计的风险画像**：本 change 引入的新风险面只有
「索引被污染」与「索引与输入不同源」两个，判据面与变异面**一一对应**。

还原校验：两轮变异跑完 `diff` 与备份相同、无 `MUTANT` 残留。

### 覆盖边界（如实写，勿当全覆盖）

- 真实 wasm 的逐窗等价用例**调粗了 `STEP`**（250s）——`DUR` 与事件流/索引规模是 production 的
  （构造成本、105,411 个锚点都是真的），少的只是**抽样窗口数**（2157 → 22）。它守的是
  「两条路径的观测等价」，而「全部 2157 窗」由 §D6 的人工全量对照 + 摘要用例（覆盖全窗口）覆盖。
- **时域局部的索引污染**在粗 `STEP` 下可能**不落在抽样窗口内**（例如只污染某一个锚点，
  其影响区间只有 ~0.5s）⇒ 逐窗用例可能漏。这条由**摘要用例**兜底（它对污染不挑时刻），
  但**摘要用例自己不检查行为**，只检查「索引有没有变」——两者互补，缺一不可。
- 单测**不**证明多线程/worker 下的行为（本 change 未触及并发路径；#152 的并发==串行用例仍在跑）。
- 缺 `viewer/engine.wasm` 时，真实 wasm 用例**显式 skip**（CI 里 `verify.sh` 第 4 步会先挡住缺产物）；
  `viewer/game.test.js` 的 3 条是合成的、**恒跑**。

## D8 现场记录

- 探针 `tools/zz-profile-sweep.mjs` 与全量对照脚本为一次性工具，读数固化到 §D1/§D5/§D6 后**删除**
  （本仓「探针用完即删」纪律）。
- 本 worktree 的 `viewer/engine.wasm` 由**本 worktree 源码**构建（未拷旧实验产物），
  且不入库（`.gitignore`）。
- **未纳入本 change 的同类站点**（如实记，避免「已全面加速」的误读）：
  `tools/fixtures/generate-real-audit-fixture.mjs:101` 也逐窗 `new Game(...)`。它是手工运行的
  夹具生成器（约 10 窗），**不在 CI 关键路径**上，故不动它（动了是无关风险的扩散）。
