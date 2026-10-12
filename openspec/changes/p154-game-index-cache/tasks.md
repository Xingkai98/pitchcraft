# Tasks: spacing-sweep 逐窗复用静态索引（#154）

## 1. OpenSpec 工件

- [ ] 1.1 `proposal.md` / `design.md` / `tasks.md` / `specs/{pitch-viewer,match-audit}/spec.md`（delta，ADDED）
- [ ] 1.2 `openspec validate p154-game-index-cache --strict` → valid（用**全局** `openspec` 二进制；
      `npx openspec` 在本 worktree 不可用——`node_modules` 是自指 symlink，见 #152 design §D7 边界）

## 2. profile（先量再改，读数落盘）

- [ ] 2.1 本 worktree 从源码重建 wasm（不拷旧实验产物；`git status` 自查 `viewer/engine.wasm` 不入库）
- [ ] 2.2 探针 `tools/zz-profile-sweep.mjs` 分阶段计时（seed 42 / t∈[5,605] 的 241 窗）→ design §D1：
      复现 #152 的「`new Game(...)` = 91.x%」，并**拆开**构造：`buildTimeline` / `_buildAnchorIndex` /
      `_computeEventEnds` / `_buildHighlightIndex`
- [ ] 2.3 探针用完即删（读数已固化进 design §D1/§D6）

## 3. 实现

- [ ] 3.1 `viewer/game.js`：抽 `buildGameIndex(events, lineup, mode)`（与 `t` 无关的静态索引）；
      `Game(opts.index)` 复用；不同源 → **报错**；不传索引 = 原路径
- [ ] 3.2 `tools/spacing-sweep-core.mjs`：`runSeed` 每 seed 建一次索引、逐窗传入；逐窗仍**新建** Game；
      抽 `simulateEvents` 以便守卫测试共用同一份事件流
- [ ] 3.3 `viewer/index.html` 前端缓存版本号更新（改了 `viewer/` 下 JS，CLAUDE.md §4）
- [ ] 3.4 SHALL NOT 自查：`DUR`/`STEP`/默认 seed 集/detector 阈值/profile 未动；`engine/` 零改动；
      `ci.yml` 未动（`git status --porcelain` 自查）

## 4. 等价守卫 + 定向变异

- [ ] 4.1 `tools/spacing-sweep.test.mjs`：真实 wasm、production `DUR`、事件流与索引规模真实
      （`STEP` 调粗以少跑窗口）——逐窗比 `captureObservation` **整包** + detector 输出；并用
      `detect` 注入点证明**生产路径 `runSeed`** 每窗喂给 detector 的快照与逐窗重建一致
- [ ] 4.2 结构性用例：`buildGameIndex` 是确定性纯函数 + 整轮扫描后索引逐字节未变（覆盖**全部窗口**，
      而非抽样窗口）；摘要**必须显式展开 Map**（`JSON.stringify` 会把 Map 序列化成 `{}`，那样
      「分组被就地改写」这类污染在摘要里看不见）
- [ ] 4.3 反证条：判据不得空转——相邻窗口观测包必须不同（`captureObservation` 逐窗比不得跨窗恒等）；
      索引摘要对「锚点增删改 / 分组 Map 改写 / 结束时刻改 / 总时长改」都有区分度
- [ ] 4.4 缓存失效条件用例：同源放行、跨事件流 / 跨 lineup / 跨 mode 报错
- [ ] 4.5 定向变异（单点替换 + 命中数必须为 1）：就地改写共享 Map（M1）、削弱同源守卫（M2）、
      就地改写每事件结束时刻（M3）、naive 复用同一实例（M4）、生产路径索引不同源（M5）
- [ ] 4.6 变异结果如实记录（含**存活**的 M4 及其解释）；跑完逐字节还原（`diff` 为空、无 `MUTANT` 残留）

## 5. 生产口径全量复验（人工，读数落盘）

- [ ] 5.1 全 **8 seed × 2157 窗**：逐窗比 `captureObservation` 整包 + detector 输出（复用 vs 重建），
      记 sha256 与不同窗数 → design §D6
- [ ] 5.2 `node tools/spacing-sweep.mjs`（默认 8 seed）与改前**同结果、更快**；贴两组读数与耗时
- [ ] 5.3 `node --test tools/*.test.mjs` 全绿；`cd viewer && node --test *.test.js` 全绿
      （含 `app.test.js` DOM = App 侧语义未变的证据）
- [ ] 5.4 `cd viewer && node e2e-v2.mjs` 绿；`cargo test` 绿（本 change 不该动 Rust）

## 6. 独立审阅 → PR

- [ ] 6.1 零上下文 paseo agent 审 diff（重点：`viewer/` 共享文件的语义影响、缓存失效条件、
      有无共享状态/竞态）→ `reviews/`
- [ ] 6.2 审阅问题修完 → **再审**，直到全部通过
- [ ] 6.3 push → PR（base `main`）→ CI 全绿；记录 **CI step 5 与 job 总耗时**（对比 #153 的 12m01s / 24m03s）
- [ ] 6.4 `REPORT-to-main-session.md`（**不自行 merge**，等主 session）
