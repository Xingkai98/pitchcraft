# #154 交付报告（spacing-sweep 逐窗复用静态索引）

- 分支 `p154-game-index-cache/2026-10-12`，PR **[#155](https://github.com/Xingkai98/pitchcraft/pull/155)**（base `main`）
- 提交：`39155c4`（实现）→ `0d089f1`（第一轮审阅修复）→ `1fe69c4`（第二轮 NIT 修复）
- **未自行 merge**，等主 session。

## 一句话

`spacing-sweep` 逐窗 `new Game(...)` 里**与窗时刻无关**的静态索引（占逐窗成本 **91.5%**）改成
**每 seed 算一次、逐窗复用**（逐窗仍新建 Game 对象）；生产口径 **17,256 窗逐位等价**，
**CI step 5：12m01s → 36–43 s（≈17×–20×）**，job 总时长 **10m47s–13m34s**（离 30 分钟上限 16–19 分钟余量）。
判据面（`DUR`/`STEP`/默认 seed 集/detector 阈值/profile）**逐字未动**，`engine/` **零改动**。

## 1. 先量再改（profile，读数固化在 `design.md` §D1）

seed 42、`DUR=5400`、`t ∈ [5,605]` 的 241 窗（事件流 6281 事件 / 4,917,179 字节 / 时间线 **105,411** 锚点）：

| 阶段 | 每窗 | 占逐窗 |
|---|---|---|
| **`new Game(events, lineup, 'continuous')`** | **140.28 ms** | **91.5 %** |
| ├ `buildTimeline` | 76.38 ms | 49.8 % |
| ├ `_buildAnchorIndex` | 56.76 ms | 37.0 % |
| ├ `_computeEventEnds` + `_buildHighlightIndex` | 8.28 ms | 5.4 % |
| └ `_initToEvent`（**真·per-window 可变状态**） | 0.11 ms | 0.1 % |
| `captureObservation` + `detect` | 12.94 ms | 8.4 % |

⇒ 逐窗 153.3 ms/窗 = 5.51 min/seed。**改后同机同窗口集 14.46 ms/窗 ⇒ 11.11×**。

## 2. 改法（design §D2）

取 **(a) 抽静态索引 + 逐窗仍新建对象**，不是 (b)「复用同一个 `Game` 实例 + 复位可变状态」：

- `viewer/game.js`：新增 `buildGameIndex(events, lineup, mode)`；`Game` 接受 `opts.index`。
  **不传 `opts.index` = 原路径**（App / `createGame` / 既有测试与工具全部不传，行为逐位不变）；
  与本次 `(events, lineup, mode)` **不同源 → 构造报错**（fail-loud，不静默回落重建）。
- `tools/spacing-sweep-core.mjs`：`runSeed` 每 seed 建一次索引、逐窗传给 `new Game(...)`；
  **逐窗仍独立新建 Game 对象**。

**为什么不用 (b)**：(b) 要枚举全部可变状态并写一份复位清单，而清单必须与构造函数**永远同步**
——构造函数将来加一个字段而忘了加进复位，就是一条只在 sweep 里发作的静默错。(a) **没有第二份
清单**，代价只有 **0.51 ms/窗**（缓存后逐窗成本的 3.5%）。

**顺带订正了一条记录**（design §D5 实测）：#152 把「复用实例」记为**行为差异**而搁置，
但实测那条差异分支（`_interpolateAnchors` 返回 `null` → 复用保留旧位置 vs 新建回落 lineup）
在本门的窗口区间**不可达**——seed 42 全部 2157 窗 + 4 个 seed 升降序各 22 窗，naive 复用与逐窗
新建**0 窗不同**（机制：引擎在 `lineup`/`kickoff` 就为每个球员发了锚点）。独立审阅者复现并加强
（连 `t=0` 都不可达）。⇒ 选 (a) 的理由是**结构安全**，不是「复用会错」；这条已如实写进 design。

## 3. 等价守卫（核心不变量，design §D7）

| 用例 | 守什么 |
|---|---|
| 缓存索引 == 逐窗重建（真实 wasm） | 逐窗比 `captureObservation` **整包**；再用 `detect` 注入点比**生产路径 `runSeed`** 每窗喂给 detector 的**输入**与输出 |
| **注入守卫** | `buildIndex` 注入点：每 seed **恰好构造 1 次** + **篡改式接线断言**（把注入索引的 timeline 掏空，逐窗输入必须随之与重建路径不同） |
| 索引纯函数性 + 全窗不可改写 | **全部 2157 窗**（生产 STEP）的构造/`seekTo`/`step` 后索引摘要逐字节不变；摘要**显式展开 Map** |
| 反证条 ×3 | 判据不得空转：相邻窗口的观测包与 detector 输入必须不同；摘要区分度；fixture 必须真的走到 `null` 回落分支 |

**定向变异**（hunk 原文 + 结果记在 §D7）：M1 就地改写共享 Map → 红；M2 削弱同源守卫 → 红；
M3 就地累加 `eventEnds`（跨窗累积）→ 红 2；**M4 naive 复用 → 绿（真等价变异，非盲区）**；
M5 索引与输入不同源 → 红 6；**M6 摘掉优化 → 红（第一版这里是 20/20 全绿）**；M7 索引挪回循环 → 红。

## 4. 复验（生产口径）

| 项 | 结果 |
|---|---|
| 全 8 seed × 2157 窗逐窗对照（复用 vs 重建） | **17,256 窗 0 不同**；每 seed 整轮观测流 sha256 两路径相同；findings 0/0 |
| 默认 8 seed（本机，并发 4） | **2m28s**（vs #152 记录 21m32s）⇒ ≈8.7× |
| `node --test tools/*.test.mjs` | **525 / 525 pass，0 fail，0 skip** |
| `cd viewer && node --test *.test.js` | **394 tests / 388 pass / 0 fail / 6 skip**（含 `app.test.js` 38/38 DOM） |
| `cd viewer && node e2e-v2.mjs` | **OK**（6281 事件、无 snap） |
| `cargo test` | **绿**（exit 0；本 change 不动 Rust） |
| `openspec validate p154-game-index-cache --strict` | **valid** |

## 5. 独立审阅（零上下文 paseo agent，两轮）

- 第一轮 `reviews/independent-review-claude-2026-10-12.md`：P0×0 / **P1×2** / P2×5 / NIT×3。
  **行为侧未能构造出任何反例**；两条 P1 都是**假覆盖声明**，且恰好是本 change 支撑「可以复用」的论据：
  1. 「生产路径真的在用缓存索引」**没有任何断言**——删掉 `runSeed` 的 `{ index }` → **20/20 全绿**
     （等价判据对「优化被摘掉」不可观测）。⇒ 本 change 的唯一交付物可以被人一次重构悄悄摘掉而
     CI 全绿、step 5 回到 9–12 分钟。**已修**：`buildIndex` 注入点 + 篡改式接线断言。
  2. 「摘要用例覆盖全部窗口」与代码不符（实为 22/2157 = 1.0%，而它点名要兜底的正是抽样窗口）。**已修**。
  另修 P2×5（`game.test.js` 摘要对 Map 全盲 / 「索引只依赖三个入参」是**机制表述错** / 探针入库且已坏 /
  `app.js` 的 `game.js?v=` 未随 / 「覆盖了 `null` 回落分支」在旧 fixture 上命中 0 次）与 NIT×3。
- 第二轮 `reviews/independent-review-round2-claude-2026-10-12.md`：**通过**。第一轮 15 条**逐条独立复跑
  确认修掉**；本轮新发现 6 条**全是 NIT**（5 条是记录读数/归属不准、1 条断言加固），已全部修入 `1fe69c4`。

## 6. CI（三次 run 都 success）

| run | 机型（step 1 `cargo test` 当代理） | **step 5 `spacing-sweep`** | job 总时长 |
|---|---|---|---|
| #150（改前，串行） | 7m12s | **17m45s** | 26m52s |
| #153 run A（#152 合入后） | 9m31s（偏慢） | 12m01s | 24m03s |
| #153 run B（#152 合入后） | 5m30s（偏快） | 9m06s | 16m12s |
| **#154** `38264260625`（push） | 7m58s | **36.2 s** | **10m47s** |
| **#154** `38264265432`（PR） | 9m39s（偏慢） | **43.1 s** | **13m34s** |
| **#154** `38266537770`（push，最终 HEAD `16498b0`） | **5m22s**（偏快） | **28.6 s** | **7m45s** |

- **step 5：12m01s → 28.6–43.1 s（≈17×–25×）**；相对 #150 的 17m45s 是 **≈25×–37×**。
- **目标「~1.5–2 分钟」达成并超出**。job 总时长 **7m45s–13m34s**，**离 30 分钟上限有 16–22 分钟余量**
  （快机上 job 只有 7m45s = 本 change 前的 **1/3.5**）。
- 三次 run 的 step 5 stdout 与改前**逐字相同**：8 × 2157 窗、`findings=0`、末行 `OK`、exit 0。
- step 5 随机型单调变化（28.6 / 36.2 / 43.1 s），与「省下的是机型无关的每 seed 固定成本」一致。

## 7. 需要主 session / 用户知道的事

1. **未 merge**，按约定等主 session。
2. **`viewer/game.js` 是 App 与 tools 共用**：本 change 对 App 的唯一改动是构造函数里多了一次
   `opts.index ?? …` 判断 + 静态索引改由 `buildGameIndex` 产出（**默认路径逐行同构**）。
   证据：`app.test.js` DOM 38/38、viewer 全量 388 pass / 0 fail、`e2e-v2.mjs` OK。
3. **`viewer/index.html` 与 `viewer/app.js` 的 `?v=` 都 bump 到 `20261012-2`**（CLAUDE.md §4）。
   ⚠️ 顺带发现：本仓的缓存版本号实践其实有坑——`game.js` 的版本串挂在 **`app.js` 的 import
   specifier** 上（模块 URL 不继承 `index.html` 的查询串），而 CLAUDE.md §4 只写了 `index.html`
   的 script 标签。本 change 两处都改了；**是否要把这条写进 CLAUDE.md §4 由用户定**（PR 里没改文档）。
4. **已知边界（如实记，非缺口）**：
   - 索引把**建索引时刻的 config 常量**烘了进去（`buildTimeline` 读 5 个 config 叶子），
     而同源守卫**看不见 config 变化**。当前调用方不可达（sweep 在模块加载时设一次 config）。
   - 同源守卫用**身份比较**：看得见「换了数组」，看不见「原地改了同一个数组的内容」。
   - `tools/fixtures/generate-real-audit-fixture.mjs` 也逐窗 `new Game(...)`，**不在 CI 关键路径**，
     本 change 未动（记在 §D8）。
5. **下一步（若用户要）**：本 change 与 #152 都已合入后，可跑一次 `openspec archive`
   （#152 与 #154 的 delta 都还没归档）。
