# Tasks: spacing-sweep 逐窗复用静态索引（#154）

## 1. OpenSpec 工件

- [x] 1.1 `proposal.md` / `design.md` / `tasks.md` / `specs/{pitch-viewer,match-audit}/spec.md`（delta，ADDED）
- [x] 1.2 `openspec validate p154-game-index-cache --strict` → valid（用**全局** `openspec` 二进制；
      `npx openspec` 在本 worktree 不可用——`node_modules` 是自指 symlink，见 #152 design §D7 边界）

## 2. profile（先量再改，读数落盘）

- [x] 2.1 本 worktree 从源码重建 wasm（不拷旧实验产物；`git status` 自查 `viewer/engine.wasm` 不入库）
- [x] 2.2 探针 `tools/zz-profile-sweep.mjs` 分阶段计时（seed 42 / t∈[5,605] 的 241 窗）→ design §D1：
      复现 #152 的「`new Game(...)` = 91.x%」，并**拆开**构造：`buildTimeline` / `_buildAnchorIndex` /
      `_computeEventEnds` / `_buildHighlightIndex`
- [x] 2.3 探针用完即删（读数已固化进 design §D1/§D6）

## 3. 实现

- [x] 3.1 `viewer/game.js`：抽 `buildGameIndex(events, lineup, mode)`（与 `t` 无关的静态索引）；
      `Game(opts.index)` 复用；不同源 → **报错**；不传索引 = 原路径
- [x] 3.2 `tools/spacing-sweep-core.mjs`：`runSeed` 每 seed 建一次索引、逐窗传入；逐窗仍**新建** Game；
      抽 `simulateEvents` 以便守卫测试共用同一份事件流
- [x] 3.3 `viewer/index.html` 前端缓存版本号更新（改了 `viewer/` 下 JS，CLAUDE.md §4）
- [x] 3.4 SHALL NOT 自查：`DUR`/`STEP`/默认 seed 集/detector 阈值/profile 未动；`engine/` 零改动；
      `ci.yml` 未动（`git status --porcelain` 自查）

## 4. 等价守卫 + 定向变异

- [x] 4.1 `tools/spacing-sweep.test.mjs`：真实 wasm、production `DUR`、事件流与索引规模真实
      （`STEP` 调粗以少跑窗口）——逐窗比 `captureObservation` **整包**；并用 `detect` 注入点比
      **生产路径 `runSeed`** 每窗喂给 detector 的**输入**与输出（只比输出会恒真：本 seed 集
      finding 恒空）
- [x] 4.1b **审阅 P1-1 修复**：加 `buildIndex` 注入点 + 篡改式接线断言——「生产路径真的在用缓存
      索引」对等价判据**不可观测**（第一版实测：删掉 `{ index }` → 20/20 全绿）
- [x] 4.2 结构性用例：`buildGameIndex` 是确定性纯函数 + **全部 2157 窗**（生产 STEP）的
      构造/`seekTo`/`step` 后索引逐字节未变 + 22 窗抽样的采集/detector 管线；摘要**必须显式展开
      Map**（`JSON.stringify` 会把 Map 序列化成 `{}`，那样「分组被就地改写」在摘要里看不见）
- [x] 4.2b **审阅 P1-2 修复**：第一版把「摘要用例覆盖全部窗口」写成事实，实则 step=250（22 窗）
      ——声明与断言体不符（兜底与被兜底抽样相同 ⇒ 兜底不存在）。现构造层改成真全窗，管线层如实标注抽样
- [x] 4.3 反证条：判据不得空转——相邻窗口的观测包与 detector 输入都必须不同；索引摘要对
      「锚点增删改 / 分组 Map 改写（含组内删锚点）/ 结束时刻改 / 总时长改」都有区分度
- [x] 4.4 缓存失效条件用例：同源放行、跨事件流 / 跨 lineup / 跨 mode 报错；`buildIndex` 注入 +
      并发 > 1 报错（不得静默忽略注入）
- [x] 4.5 定向变异（单点替换 + 命中数必须为 1）：就地改写共享 Map（M1）、削弱同源守卫（M2）、
      就地累加每事件结束时刻（M3）、naive 复用同一实例（M4）、生产路径索引不同源（M5）、
      **摘掉优化（M6，审阅证明曾 20/20 存活）**、**索引挪回窗口循环（M7）**
- [x] 4.6 变异结果如实记录（含**存活**的 M4 及其解释 + **变异 hunk 原文**，供复核）；
      跑完逐字节还原（脚本比对整文件字节，无 `MUTANT` 残留）

## 5. 生产口径全量复验（人工，读数落盘）

- [x] 5.1 全 **8 seed × 2157 窗**：逐窗比 `captureObservation` 整包 + detector 输出（复用 vs 重建），
      记 sha256 与不同窗数 → design §D6
- [x] 5.2 `node tools/spacing-sweep.mjs`（默认 8 seed）与改前**同结果、更快**；贴两组读数与耗时
- [x] 5.3 `node --test tools/*.test.mjs` 全绿；`cd viewer && node --test *.test.js` 全绿
      （含 `app.test.js` DOM = App 侧语义未变的证据）
- [x] 5.4 `cd viewer && node e2e-v2.mjs` 绿；`cargo test` 绿（本 change 不该动 Rust）

## 6. 独立审阅 → PR

- [x] 6.1 零上下文 paseo agent 审 diff（重点：`viewer/` 共享文件的语义影响、缓存失效条件、
      有无共享状态/竞态）→ `reviews/independent-review-claude-2026-10-12.md`
      （P0×0 / **P1×2** / P2×5 / NIT×3；行为侧未构造出任何反例，两条 P1 都是「假覆盖声明」）
- [x] 6.2 第一轮审阅问题修复：
      P1-1 → `buildIndex` 注入点 + 篡改式接线断言（复变异 M6 **红**）；
      P1-2 → 摘要用例构造层改真全窗 + 声明如实标注；
      P2-3 → `game.test.js` 摘要显式展开 Map + 反证条；
      P2-4 → 「只依赖 (events, lineup, mode)」订正为「+ 建索引时刻的 config 常量」，并记入
      spec / design §D3-§D4 / `game.js` 注释（**机制表述错**，本仓历史反复出现的缺陷类型）；
      P2-5 → 探针 `git rm`；P2-6 → `app.js` 的 `game.js?v=` 已 bump；
      P2-7 → fixture 加「在 lineup 里但不在 lineup 事件 players 里」的球员，让回落分支**真的**被走到；
      NIT-2/NIT-3 → design §D8/§D7 记录隐式 API 变更与新增用例的 CI 成本
- [x] 6.2b 第二轮独立审阅（复审修复）→ `reviews/independent-review-round2-claude-2026-10-12.md`：**通过**
      （第一轮 15 条逐条独立复跑确认修掉；新发现 6 条**全是 NIT**，已修入 `1fe69c4`）
- [x] 6.3 push → PR [#155](https://github.com/Xingkai98/pitchcraft/pull/155)（base `main`）→ **两次 run 都 success**；
      **CI 读数**（机型波动大，用 step 1 `cargo test` 当代理）：
      #150（改前）7m12s / **17m45s（串行）** / 26m52s；#153 9m31s / 12m01s / 24m03s 与 5m30s / 9m06s / 16m12s；
      本 PR 7m58s / **36.2 s** / **10m47s** 与 9m39s / **43.1 s** / **13m34s**。
      ⇒ **step 5 提速 ≈17×–20×**，job 离 30 分钟上限 **16–19 分钟余量**；目标（~1.5–2 分钟）达成并超出
- [x] 6.4 `REPORT-to-main-session.md` 已落盘（含 profile / 守卫 / 两轮审阅 / CI 读数）；
      **未自行 merge** —— 按约定等主 session
