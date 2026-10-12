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

**改后（同一探针、同一窗口集、同一机）**：

| | 改前 | 改后 | |
|---|---|---|---|
| `new Game(...)` | 148.05 ms/窗 | **0.51 ms/窗**（只做可变状态初始化） | 索引只算一次 = 202 ms/seed |
| `captureObservation` | 11.98 ms/窗 | 13.42 ms/窗 | 未动（含测量噪声） |
| `detectPlayerOverlap` | 0.55 ms/窗 | 0.49 ms/窗 | 未动 |
| `seekTo` | 0.04 ms/窗 | 0.03 ms/窗 | 未动 |
| **逐窗合计** | **160.61 ms/窗** → 5.77 min/seed | **14.46 ms/窗** → **0.52 min/seed** | **11.11×** |

> 口径说明：两个读数在同一次探针运行内前后相接测出（机器当时 load ≈ 3.7，仍非空闲机），
> 故**绝对值不可与 §D1 的 140.28 ms 直接比**（§D1 是另一次运行）；**比值 11.11× ≈ 理论 11.9×**
> 不受机型影响。独立审阅者在另一台更慢的机器上复现得到 14.78×（同向结论）。

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

**放**（只依赖 `(events, lineup, mode)` 与**建索引时刻的 `config` 常量**，构造后**只读**）：
`timeline`、`ballAnchors`、`playerAnchors`、`ballBounds`、`playerBounds`、`eventEnds`、`matchEnd`。

**不放**（构造期可变 / 依赖逐次构造的入参，逐窗重建）：
- `sentOffAt`：**可变 Map**（虽然内容其实只依赖事件流）。共享可变结构得不偿失；整场一遍线性扫描
  成本可忽略（0.1 ms 量级）。**边界效应**：`deriveAuditInput` 另有自己的 `sentOffTimes(allEvents)`
  推导——那条路径读的是 `game.events`（整场事件，本就不经索引），不受本 change 影响。
- `_highlightWindows`：由 `_eventEnds`（静态）**加上 `this._skipThreshold`** 派生，而
  `_skipThreshold = opts.skipThreshold ?? config.playback.skipThresholdSeconds` —— 它依赖
  **逐次构造的入参 `opts`**，而索引在构造时**看不到 `opts`**。把它冻进索引就等于让同一次
  缓存复用无视调用方传的 `skipThreshold`（`viewer/*.test.js` 大量用 `skipThreshold: Infinity`
  关跳过），是**语义变化**。重建成本 0.38 ms/窗（0.25%），不值得。
  （⚠️ 先前的表述把理由写成「它依赖 config」——**机制说错了**：`eventEnds` 同样是 config 相关的
  产物；真正的理由是「依赖逐次构造的 `opts`」。#154 审阅 P2-4 指出。）

**索引依赖 `config`（如实写）**：`buildTimeline` 在**建索引时**读 `config`（实测活读取 5 个叶子：
`interpretation.shot.keeperReactDelay`、`interpretation.tackle.deflectSpeed`、`defaults.runSpeed`、
`pitch.lengthMeters`、`pitch.widthMeters`），这些值被烘进索引。因此「索引只依赖 `(events, lineup,
mode)`」**不准确**，正确表述是「只依赖这三个入参 + 建索引时刻的 config 常量」。同源守卫
（身份比较）**看不见 config 变化**——见 §D4 的边界条。

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

**守卫的第一个边界：config（#154 审阅 P2-4 独立实测）**。索引把建索引时刻的 config 常量烘了进去，
而守卫只比 `events`/`lineup`/`mode` 的身份——**在「建索引」与「构造 Game」之间改 config，守卫放行，
但索引已陈旧**。审阅者实测：改 `config.interpretation.shot.keeperReactDelay` 后，用旧索引构造的
`Game` 在 `t=120` 的观测包与「用新 config 重建」**不同**。
**当前不可达**：唯一传索引的调用方 `tools/spacing-sweep-core.mjs` 在模块加载时设定 config
（`debug.enabled=false` / `skipThresholdSeconds=Infinity`）后再不改动，且整个 `runSeed` 里 config
是常量；App 侧不传索引。故记为**已知边界**：将来若出现「运行中改 config + 复用索引」的用法，
需要把 config 指纹并入索引（或让守卫比它）。

**守卫的第二个边界：内容**。身份比较**看得见「换了一个数组」，看不见「原地改了同一个数组的内容」**
——若某调用方在「建索引」与「构造 Game」之间**就地修改** `events` 或 `lineup`，守卫会放行而索引
已陈旧。本 change 的用法不触碰这条边界（`runSeed` 在 `parseEventStream` 之后立刻建索引，
两者之间没有任何写入；`events`/`lineup` 在整个 seed 内是只读的，且由 `viewer/game.test.js` 的
「输入与索引不被改写」用例钉住）。把它**做实**（深比较整场事件流）会让每次构造多付一次 O(事件数)
——那是把守卫的成本提到与它要防的问题同量级，故不做。这是**已知且被记录**的盲区，不是无意的缺口。

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

**独立审阅者复现并加强了这条**（#154 审阅 §3.4）：8 个默认 seed 全部满足「23 个实体（球 + 22 人）
的**最早锚点 `t` 都 = 0**」、`lineup` 里无锚点的球员 = 0，且以 step 12.7 s 逐点调用
`_interpolateAnchors` 扫过整个窗口区间 → **null 次数 = 0**；结论与机制都成立，且**比本文写的更强**
（连 `t = 0` 都不可达，不只是 `t ≥ 5`）。
⚠️ 反过来说：**这条分支在合成 fixture 里是可以被走到的**（`lineup` 里有、`lineup` 事件的
`players` 里没有的球员），故 `viewer/game.test.js` 靠这种方式把它**真的**覆盖住（见 §D7）。

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

**逐 seed 明细**（两条路径各自的**整轮观测流 sha256**，以及 detector 汇总）：

| seed | 窗口数 | 不同窗数 | sha256（复用索引） | sha256（逐窗重建） | findings | worst |
|---|---|---|---|---|---|---|
| 42 | 2157 | **0** | `c9a7fb84…` | `c9a7fb84…` | 0 / 0 | null / null |
| 1 | 2157 | **0** | `fc48256a…` | `fc48256a…` | 0 / 0 | null / null |
| 2 | 2157 | **0** | `eacc60c6…` | `eacc60c6…` | 0 / 0 | null / null |
| 3 | 2157 | **0** | `ad224f16…` | `ad224f16…` | 0 / 0 | null / null |
| 7 | 2157 | **0** | `1a2ea9b3…` | `1a2ea9b3…` | 0 / 0 | null / null |
| 59 | 2157 | **0** | `d34c916b…` | `d34c916b…` | 0 / 0 | null / null |
| 18 | 2157 | **0** | `17deb132…` | `17deb132…` | 0 / 0 | null / null |
| 94 | 2157 | **0** | `acdc2ed5…` | `acdc2ed5…` | 0 / 0 | null / null |

（sha256 为完整 64 位十六进制，此处截断显示；签名的定义 = 每窗 `captureObservation` **整包**
JSON 依次喂进哈希。seed 59 / 18 / 94 = 红牌 seed，覆盖罚下路径下的窗口。）

**结论**：**17,256 窗逐窗逐位相同（不同窗数 = 0）**，detector 汇总（finding 数 / 最恶劣间距）也相同。
全量跑在本机（load ≈ 4-20，非空闲）耗时约 **16 分钟/seed**（两条路径合跑），4 进程并行确实跑完。

**改后端到端（生产 CLI）**：

| 跑法 | 本 change 之后 | #152 记录的改前（本机、空闲机） |
|---|---|---|
| `node tools/spacing-sweep.mjs`（默认 8 seed，并发 4，**本机**） | **2m28s**（`user 3m54s`；机器当时还在跑 `cargo test` + 别的会话） | **21m32s**（并发） |
| `SWEEP_CONCURRENCY=1 node tools/spacing-sweep.mjs 42 59`（2 seed 串行） | 1m41s | —（折算串行 **43m21s** / 8 seed = 5m25s/seed） |
| 默认 8 seed（**独立审阅者的机器**） | 3m18.7s | — |

三组 stdout 均为 8×2157 窗、`findings=0`、末行 `OK`、exit 0 —— **与改前逐字相同**。
⇒ 端到端 **≈ 8.7×**（21m32s → 2m28s，且这次机器更忙）；逐窗成本 **11.11×**（§D1）。
**目标「~1.5–2 分钟」在 CI 机型上的最终读数见 §D9**（CI 机型波动大，以 CI 为准）。

## D7 守护测试与定向变异

### 守什么

| 用例（`tools/spacing-sweep.test.mjs` 新增 4 条 + `viewer/game.test.js` 新增 4 条） | 守什么 |
|---|---|
| **缓存索引 == 逐窗重建（真实 wasm）** | 逐窗比 `captureObservation` **整包**；并用 `detect` 注入点把**生产路径 `runSeed`** 每窗喂给 detector 的**输入**与输出与逐窗重建逐位比（**比输入**：本 seed 集 finding 恒空，只比输出会恒真）。**反证条**：相邻窗口的观测包与 detector 输入都必须不同（判据不得跨窗恒等 ⇒ 防空转） |
| **注入守卫**（同一条用例内 ②b） | 「生产路径真的在用这份缓存索引」**只能靠注入判**：断言 `buildIndex` **每 seed 恰好调用 1 次**（挪回窗口循环 → 变 2157），并**篡改式验证接线**——把注入索引的 `timeline` 掏空，逐窗 detector 输入必须随之与重建路径**不同**（拿掉 `{ index }` 则篡改无效 ⇒ 变红） |
| **静态索引是确定性纯函数 + 全窗扫描后逐字节未变** | `buildGameIndex` 两次构造逐字节相同；**全部 2157 窗**（生产 `STEP=2.5`）的**构造/`seekTo`/`step`** 之后索引摘要不变；另跑 22 个抽样窗口的**采集 + detector 管线**（全窗管线对照见 §D6，代价所限） |
| **反证条：索引摘要的区分度** | 摘要对「锚点被删/改、球锚点表被增补、分组 Map 被改写（含组内删锚点）、结束时刻被改、总时长被改」**都必须判不同** |
| **缓存失效条件** | 同源放行；跨事件流 / 跨 lineup / 跨 mode **报错** |
| `viewer/game.test.js`：复用 == 重建（合成事件） | 构造态 + 12 个时刻的 `seekTo` + 40 步 `step` 序列，比较球员/球/时刻/事件索引/高亮窗口/纪律牌/进度；**不依赖 wasm**（CI 与本地都恒跑）。**前提自证**：断言 fixture 里那个无锚点球员的插值**真的**返回 `null`（否则「覆盖了回落分支」是空话——审阅 P2-7 实测旧 fixture null 命中 0 次） |
| `viewer/game.test.js`：输入与索引不被改写 | 连构造推进 5 个 Game 后 `events`/`lineup`/索引逐字节不变；摘要**显式展开 Map**（审阅 P2-3 实测：裸 `JSON.stringify` 对分组污染全盲） |
| `viewer/game.test.js`：摘要反证条 | 分组 Map 整组删 / 组内删锚点 / 锚点被改 / 结束时刻被改 → 摘要**都必须判不同** |
| `viewer/game.test.js`：同源守卫 | 三类不同源都报错，同源（含 clip）放行 |

**摘要实现的一个坑（本项目内实测踩到）**：`JSON.stringify` 把 `Map` 序列化成 `{}` ——
直接用 `{...index}` 做摘要，「`playerAnchors` 被就地改写」这整整一类污染在摘要里**看不见**。
故摘要**显式展开 Map**（`[...m]` 排序后并入），并由上表的反证条钉住它有区分度。

### 定向变异（单点替换，命中数必须为 1；跑完逐字节还原）

变异施加脚本对每个变异**打印命中数并要求恰好为 1**，跑完立即用备份还原，最后比对整文件字节。
**变异 hunk 原文一并记录**（第一轮审阅 §4.1 指出：只写文字描述则取证不可复核）。
表的「结果」列**口径 = `tools/spacing-sweep.test.mjs` 内**；仓库级红数见每行的括注。

> ⚠️ **一处记录订正（第二轮审阅 NIT-1）**：第一版这里把「审阅者复现 M1 得 2 红 vs 表里的 1 红」
> 归因为「表里没写清删的是哪个键」。**机制说错了**：两个 hunk 删的是**同一个键**（seed 42 下
> `playerAnchors` 首个键 = `_players[0].id` = `0`）。真正的差异是**该 hunk 是否被 `opts.index` 守卫**：
> 审阅者的 hunk 写成 `if (opts.index && …)` ⇒ **只在复用路径删**、逐窗重建路径不删 ⇒ 两条路径分岔
> ⇒ 连「逐窗一致」用例也红（2 红）；本表 M1 的 hunk 是**无条件**删 ⇒ 两条路径同样删 ⇒ 逐窗一致绿、
> 只有摘要红（1 红）。两个 hunk 审阅者都实跑过，与上述解释吻合。

| # | 变异（单点替换的 `to` 片段；`// MUTANT` 为标记） | 落点 | 结果 |
|---|---|---|---|
| **M1** | 在 `this._playerAnchors = index.playerAnchors;` 后插 `if (this._players.length) this._playerAnchors.delete(this._players[0].id); // MUTANT` | `viewer/game.js` | tools 套件内**红 1 条**：「静态索引……逐字节未被改写」。**仓库级 4 条红**（另加 `viewer/game.test.js` 的「索引复用不改变外部输入」+ tackle 那两条连带——因为该 hunk 是**无条件**的，连默认路径的行为一起改了）。**为什么 tools 内是 1 条而不是 2 条**：构造函数是两条路径共用的同一段代码，无条件删锚点对「逐窗重建」路径同样生效（它每次只有一窗的生命周期）⇒ 两条路径的观测仍等价 |
| **M2** | `if (index.events !== events \|\| index.lineup !== lineup \|\| index.mode !== this.mode) {` → `if (index.mode !== this.mode) { // MUTANT` | `viewer/game.js` | **红 1 条**：「索引缓存失效条件……报错」（`viewer/game.test.js` 侧另有 1 条） |
| **M3** | 在 `this._eventEnds = index.eventEnds;` 后插 `for (let i = 0; i < this._eventEnds.length; i += 2) this._eventEnds[i] += 0.5; // MUTANT` | `viewer/game.js` | **红 2 条**：逐窗逐位一致 + 索引未被改写。**这是唯一一条能同时打红「逐窗一致」的**——它是**就地累加**：共享索引上跨窗累积，而逐窗重建每次拿到的是只活一窗的新数组 |
| **M4** | 把 `const game = new Game(events, lineup, 'continuous', { index });` 从循环内提到循环外（`game.seekTo(t)` 照旧） | `spacing-sweep-core.mjs` | **绿（存活）** —— 见 §D5：该变异在生产窗口区间**行为等价**，是**真等价变异**，不是判据盲区 |
| **M5** | `const index = buildIndex(events, lineup, 'continuous');` → `buildIndex(events, lineup.map((p) => ({ ...p })), 'continuous'); // MUTANT` | `spacing-sweep-core.mjs` | **红 6 条** = 并发==串行 / 门被悄悄放宽（判据面被连带打红）/ detector 接线 / `runSweep` **两条**编排（干净路径、finding 路径；崩溃路径那条绿）/ 逐窗一致——缓存与输入不同源时 **fail-loud**。⚠️ 第一版这里把清单写成「`runSweep` 三条」并漏了「门被悄悄放宽」；第二轮审阅逐条实跑订正 |
| **M6** | `const game = new Game(events, lineup, 'continuous', { index });` → `new Game(events, lineup, 'continuous'); // MUTANT`（**把优化整个摘掉**） | `spacing-sweep-core.mjs` | **红 1 条**（逐窗一致用例里的注入守卫）。⚠️ **这条是本 change 第一版审阅实测「20/20 全绿」的存活变异**（审阅 P1-1）——第一版套件的等价判据对「优化被摘掉」不可观测（摘掉后两条路径仍等价）。修法是加 `buildIndex` 注入点 + 篡改式接线断言 |
| **M7** | 在窗口循环内再插一行 `const idx2 = buildIndex(events, lineup, 'continuous'); // MUTANT` 并改用它 | `spacing-sweep-core.mjs` | **红 1 条**（注入守卫的「每 seed 恰好 1 次」断言）。实测计数 = **23**（= 循环外 1 次 + 该用例的 22 窗各 1 次；那条用例的 step 是 250）。⚠️ 第一版这里记「2158 次」——那是按生产密度（`step=2.5`）算出来的，与该用例的 `step=250` **不自洽**；第二轮审阅实跑订正 |

**为什么 M1 只红「摘要」、M3 才能红「逐窗一致」**：构造函数是两条路径共用的同一段代码，故绝大多数
变异是**对称**的（两条路径同时坏 ⇒ 逐窗比对看不出来）。能被「缓存 vs 重建」抓住的，只可能是
**利用了索引被跨窗共享**这件事的变异（M3 的累加）。**这条观察就是本设计的风险画像**：本 change
引入的新风险面只有三个——「索引被污染」（M1/M3）、「索引与输入不同源」（M5）、「优化被悄悄摘掉」
（M6/M7）——判据面与变异面**一一对应**，且 M6 的存活是**第一版漏掉的那一面**。

**还原校验**：脚本对每个变异立即还原并在末尾逐文件比对字节，输出「逐字节相同 ✅」；工作树无
`MUTANT` 残留（`grep -rn MUTANT` 为空）。

### 覆盖边界（如实写，勿当全覆盖）

- 真实 wasm 的**逐窗等价用例**调粗了 `STEP`（250s）——`DUR` 与事件流/索引规模是 production 的
  （构造成本、105,411 个锚点都是真的），少的只是**抽样窗口数**（2157 → 22）。
- **时域局部的索引污染**在粗 `STEP` 下可能**不落在抽样窗口内**（例如只污染某一个锚点，
  其影响区间只有 ~0.5s）⇒ 逐窗等价用例可能漏。兜底的是**摘要用例**——它对污染不挑时刻；
  而摘要用例的**构造/`seekTo`/`step` 部分已覆盖全部 2157 窗**（生产密度，成本 ~0.2 ms/窗），
  只有**采集 + detector 管线**部分是 22 窗抽样（全窗 ≈ 26 s，不进 CI 预算）。
  ⚠️ **第一版这里写的是「摘要用例覆盖全部窗口」，而代码用的是 step=250（22 窗）——声明与断言
  体不符**（#154 审阅 P1-2 实测：被兜底者与兜底者抽样完全相同 ⇒ 兜底**不存在**）。现已把构造层
  改成真全窗，管线层如实标注为抽样。
- 摘要用例**自己不检查行为**，只检查「索引有没有变」——与逐窗等价用例互补，缺一不可。
- **「生产路径真的在用缓存索引」不能靠等价性证明**（等价性对它不可观测，见 M6），只能靠**注入**：
  本套件用 `buildIndex` 注入点 + 篡改式接线断言。审阅者另指出：任何**未来**新增的、绕过
  `runSeed` 直接构造 `Game` 的加速路径不受本套件保护——本 change 未新增这类路径。
- 单测**不**证明多线程/worker 下的行为（本 change 未触及并发路径；#152 的并发==串行用例仍在跑）。
- 缺 `viewer/engine.wasm` 时，真实 wasm 用例**显式 skip**（CI 里 `verify.sh` 第 4 步会先挡住缺产物）；
  `viewer/game.test.js` 的 4 条是合成的、**恒跑**。

### 新增用例的 CI 成本（如实记，本仓有「CI 预算债」前科）

`tools/spacing-sweep.test.mjs` 从 16 条 / 16 例 → **20 条**；改后整文件在本机**空闲时 ≈ 18–23 s**
（其中 #154 的 4 条 ≈ 12 s）。⚠️ **不可当上界读**：同一文件在**负载高**的机器上量到过 **167 s**
（#17 单条 43 s）——同一台机器差 7×，与仓内「CI 机型速度波动大」那条教训一致。
相对本 change 在 step 5 上省下的 7–10 分钟，这笔账是划算的；`viewer/game.test.js` 的新用例是纯合成的（毫秒级）。

## D8 现场记录

- 探针 `tools/zz-profile-sweep.mjs` 与全量对照脚本为一次性工具，读数固化到 §D1/§D5/§D6 后
  **删除**（本仓「探针用完即删」纪律；`git rm` 见提交历史）。全量对照脚本落在 `/tmp`，未入库。
- **隐式 API 变更（如实记）**：`Game.prototype._buildAnchorIndex` / `_computeEventEnds` 两个方法
  被删除，其函数体移入模块级 `buildGameIndex` / `computeEventEnds`。全仓（含 `openspec/`）grep
  过：除本 change 那个已删的探针外**无** monkey-patcher 依赖这两个 prototype 方法。被删探针当时
  在 `Game.prototype` 上包装它们，删除后包装成空壳（打印 0）——那是探针的一次性问题，随探针一起消失。
- **构造函数的字段赋值顺序变了**（`_eventEnds` / `_matchEnd` 现在先于 `sentOffAt` / `_clipIndex`
  赋值；独立审阅者逐条核过无语义差异：被前移的三段都不读 `sentOffAt` / `_clipIndex`，
  `_buildHighlightIndex` 仍在 `_eventEnds` 之后、`_initToEvent(0)` 仍在最后）。**记在这里，
  免得日后的 diff 把它误判为可疑改动。**
- 本 worktree 的 `viewer/engine.wasm` 由**本 worktree 源码**构建（未拷旧实验产物），
  且不入库（`.gitignore`）。
- **未纳入本 change 的同类站点**（如实记，避免「已全面加速」的误读）：
  `tools/fixtures/generate-real-audit-fixture.mjs:101` 也逐窗 `new Game(...)`。它是手工运行的
  夹具生成器（约 10 窗），**不在 CI 关键路径**上，故不动它（动了是无关风险的扩散）。
- **本 worktree 的 `node_modules` 是入库的自指 symlink**（指向主仓库的 `node_modules`，而后者
  本身断成自指环）。为本地跑 `app.test.js`（jsdom）曾在本 worktree 临时 `npm ci` 出真实目录，
  用完已还原 symlink（见提交前自查）。CI 走 `npm ci`，不受影响。
