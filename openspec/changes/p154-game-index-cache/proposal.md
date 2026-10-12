# Proposal: spacing-sweep 逐窗复用静态索引（#152 的下半场，GitHub #154）

## Why

#152（PR #153，已合 `9cadab5`）给 `tools/spacing-sweep.mjs` 做了 **seed 级并发**：CI step 5
从 17m45s 降到 **9m06s–12m01s**，job 从 26m52s 降到 16m12s–24m03s。但它**没有动真瓶颈**——
`openspec/changes/p152-sweep-perf/design.md` §D1 的分阶段 profile 已定位：逐窗成本的
**91.5%** 是 `new Game(events, lineup, 'continuous')` 的构造（每窗重建整场锚点时间线 +
按实体分组的时间索引，seed 42 有 **105,411** 个锚点）。而 `simulate` 整场只占 0.9%、
detector 0.3%。

**关键事实**：这些构造产物（timeline / 锚点索引 / 每事件结束时刻 / 比赛总时长）只依赖
`(events, lineup, mode)`，**与窗时刻 `t` 完全无关**；而同一个 seed 的 sweep 里，
events / lineup **逐窗逐字不变**。每窗重建它是纯重复劳动（2157 窗 × 141 ms ≈ 5.5 min/seed，本机）。

⇒ 本 change 是 #152 的**下半场**：把这块算一次、逐窗复用。目标：逐窗成本 ≈ 1/10，
sweep step 再从 ~9–12 分钟降到 **~1.5–2 分钟**。

**为什么 #152 没做**（§D5 记的未采纳方案）：当时把它记为「需要另立票据」，理由是**行为差异**
——若直接复用同一个 `Game` 实例，`viewer/game.js` 的 `_interpolateAnchors` 返回 `null`
（该球员此刻无锚点）时会**保留旧位置**，而新建 `Game` 会**回落 lineup 站位**。
本 change 取「抽静态索引 + 逐窗仍新建对象」而非「复用实例」，并把那条差异分支**实测**清楚
（见 design §D5：它在生产窗区间**不可达**，但这不是选择本方案的理由——理由是不必枚举可变状态）。

## What Changes

1. **`viewer/game.js`（App 与 tools 共用）**：把「与 `t` 无关」的构造产物抽成可复用的纯计算结果
   `buildGameIndex(events, lineup, mode)`；`Game` 接受 `opts.index` 并跳过重算。**不传索引时
   行为逐位不变**（App / `createGame` / 既有测试与工具全部走这条路）。索引与本次
   `(events, lineup, mode)` **不同源时构造报错**（fail-loud，不静默回落重建）。
2. **`tools/spacing-sweep-core.mjs`**：`runSeed` 每 seed 构造一次索引，逐窗传给
   `new Game(..., { index })` 并照常 `seekTo(t)`——**逐窗仍独立构造播放器对象**，不复用可变状态。
3. **等价守卫（核心不变量）**：复用索引 vs 逐窗重建，逐窗比较 `captureObservation` 整包与
   detector 产出（finding 集合 / 顺序 / `min_distance`），落到真实 wasm 的守护用例；配套
   **定向变异**证明判据有区分度。判据面（`DUR`/`STEP`/默认 seed 集/detector 阈值/profile）**不动**。
4. **`viewer/index.html`** 的前端缓存版本号随之更新（改了 `viewer/` 下的 JS）。

**不做什么**：不动 `engine/`（零 Rust 改动）；不改判据、不降采样密度；不抬 CI `timeout-minutes`、
不拆 job；不把 sweep 的串行/并发等价面重做（#152 已覆盖，本 change 保持其全绿）。

## Impact

- 受影响 specs：`pitch-viewer`（静态索引可复用 + 复用不改语义）、`match-audit`（滑窗门逐窗复用索引）
- 受影响代码：`viewer/game.js`、`viewer/index.html`、`tools/spacing-sweep-core.mjs`、
  `tools/spacing-sweep.test.mjs`、`viewer/game.test.js`
- 风险面：`viewer/game.js` 是 **App 与 tools 共用**——App 侧行为必须逐位不变（本 change 最大风险面，
  由「不传索引 = 原路径」的结构 + 既有 40 条 `game.test.js` + `app.test.js` DOM 用例 + `e2e-v2.mjs` 钉住）
- CI：step 5 预计从 ~9–12 min 降到 ~1.5–2 min（待 CI 实测读数）
