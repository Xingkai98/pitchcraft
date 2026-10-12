# 独立审阅（零上下文）：#154 滑窗门逐窗复用静态索引

- 审阅对象：分支 `p154-game-index-cache/2026-10-12`，commit **39155c4**（`git diff main...HEAD`）
- 审阅时间：2026-10-12 晚（本 worktree；审阅期间实现者仍在并发编辑 `design.md` / `tools/zz-profile-sweep.mjs` / `viewer/app.js`）
- 手段：读 diff + 读断言体 + **实跑**（测试、真实门、变异、一次性探针；探针全部落在 `/tmp`，未入库）
- 未覆盖：`design.md` §D6（TBD，按指示不计）

## 0. 结论

**不通过（需修后复审）**——但请注意这不是「代码错」。

- **行为侧：我未能构造出任何一条「复用索引 → 观测包 / finding / 退出码与逐窗重建不同」的反例。**
  逐位等价、全窗无污染、守卫无误伤、无跨 seed 泄漏、判据面未动、`verify.sh` 全绿，全部实测通过（§3）。
- **守卫与文档侧：两处 P1 级「判据/文档声称覆盖了 X，而断言体并不覆盖 X」**，
  且这两条恰好是本 change 用来支撑「可以复用」的全部论据（§1 P1-1、P1-2）。
  按本仓纪律（假覆盖声明 = 未完成），这两条修完才算完成。

| 级别 | 条数 | 一句话 |
|---|---|---|
| P1 | 2 | ①「生产路径真的在用缓存索引」无任何断言（变异存活）；②「摘要用例覆盖全部窗口」与实际（22/2157 = 1.02%）不符 |
| P2 | 5 | Map 摘要盲区 / 索引其实依赖 config（与 spec 声明相反）/ 探针入库且已坏 / `app.js` 版本号未随（HEAD）/ fixture 并未走到所声称的 `null` 分支 |
| NIT | 3 | 见 §2 |

---

## 1. P1

### P1-1 「生产路径 `runSeed` 真的在用缓存索引」是假覆盖声明：把优化整个摘掉，20 条用例全绿

- 落点：`tools/spacing-sweep.test.mjs:344`（注释「② 生产路径 `runSeed` 真的在用缓存索引，且每窗喂给
  detector 的快照与参照实现逐位相同」）；对应用例本体 `:311-380`。
- **断言体只比 detector 的输出签名**（`liveSigs` vs `refSigs`）。而这两条路径的观测**本来就逐位相同**
  ——这正是本 change 要证明的东西。于是「用没用缓存索引」这件事在断言里**不可观测**。
- **复现（我实跑）**：
  1. `cp tools/spacing-sweep-core.mjs /tmp/core.bak`（sha256 `cdb4838a588f2e6ee578cc07b5505964f3961e600cff59387ed702f874bb9958`）
  2. 把 `:112` 的 `new Game(events, lineup, 'continuous', { index })` 改成
     `new Game(events, lineup, 'continuous')`（`buildGameIndex` 照旧调用、`index` 变成未使用）
  3. `cd tools && node --test spacing-sweep.test.mjs`
  4. 结果：**`# tests 20 / # pass 20 / # fail 0`** —— 一条都没红
  5. 还原：`cp /tmp/core.bak tools/spacing-sweep-core.mjs` → sha256 与备份一致，
     `git diff --stat -- viewer/game.js tools/spacing-sweep-core.mjs` 输出为空（与 HEAD 逐字节相同）
- **复验（HEAD 会动，故此条按两版都核过）**：审阅期间实现者把该用例改强了——现在**逐窗比
  detector 的输入**（`bundle.audit_input.players`，新增 `refInputs`/`liveInputs` 与相邻窗非恒等的反证条），
  这确实补掉了「finding 恒空 ⇒ 只比输出恒真」那类空转。但对本条**无效**：我用同一变异
  （`spacing-sweep-core.mjs:112` 去掉 `{ index }`）在**改后**的用例上重跑
  （`--test-name-pattern "缓存索引 == 逐窗重建"`）→ `# pass 1 / # fail 0`，**仍是绿的**。
  原因不变：`liveInputs === refInputs` 是被测性质本身，不能证明「缓存被用了」。
- 影响：本 change 的**唯一交付物**（生产路径复用索引）可以被人一次重构悄悄摘掉而 CI 全绿——
  step 5 直接回到 9–12 分钟，没有任何哨兵。这与 #152 审阅 P1-1 的教训（「detector 被摘掉会静默存活」，
  于是有了 `detect` 注入点）是**同一类**，而本 change 恰好漏了同一手。
- 建议（照抄 `detect` 注入点的思路，成本很低）：给 `runSeed` 加一个可注入的
  `buildIndex = buildGameIndex`（或一个 `onIndex` 回调），用例断言**每 seed 恰好调用一次**、
  且返回的对象身份就是喂给 `new Game` 的那份。这样「摘掉优化」和「每窗重建索引」两种退化都会变红。

### P1-2 「摘要用例覆盖**全部窗口**（而非抽样窗口）」与代码不符：实际是 22/2157 = 1.02%

- 声称处：
  - `design.md` §D7 表第 2 行：「**静态索引是确定性纯函数 + 整轮扫描后逐字节未变** | 覆盖**全部窗口**
    （不止抽样窗口）」
  - `tasks.md` 4.2：「…（覆盖**全部窗口**，而非抽样窗口）」
  - §D7「覆盖边界」段：「**时域局部的索引污染**在粗 `STEP` 下可能不落在抽样窗口内…这条由**摘要用例**兜底
    （它对污染不挑时刻）」
- 代码实际：`tools/spacing-sweep.test.mjs:389` `const step = 250;` → 循环
  `for (let t = 5; t <= dur - 5; t += step)` = **22 窗**（生产 `STEP=2.5` 是 2157 窗）。
  与它「兜底」的那条等价用例（`:316` 同样 `step = 250`）**抽样完全一样**。
- 也就是说：§D7「覆盖边界」里点名的兜底**不存在**——被兜底者与兜底者用的是同一组 22 个窗口；
  「全部 2157 窗」这条覆盖目前**只**由 §D6（人工、TBD、不进 CI）承担。
- **独立复核（我实跑，避免只靠读代码下结论）**：用生产 `STEP=2.5` 跑 seed 42 的全部 2157 窗
  （每窗 `new Game(..., {index})` + `seekTo` + **额外** `step(0.05)` + `captureObservation` + `detect`），
  前后用**展开 Map 的深摘要**比对 `timeline / ballAnchors / playerAnchors / ballBounds / playerBounds /
  eventEnds / matchEnd` 以及 `events` / `lineup`：
  `窗口数=2157 findings=0`，`共享索引 + events + lineup 在全窗扫描后逐字节未变? true`。
  ⇒ **结论本身成立**（本 change 未引入污染），**是覆盖声明写错了**，不是发现了真实缺陷。
- 建议（二选一，都便宜）：
  (a) 把该用例的 `step` 改成 `DEFAULT_STEP`（本机成本 ≈ +65 s；CI 上更久）；或
  (b) 承认它只抽 22 窗，把 design §D7 表 / 覆盖边界段 / tasks 4.2 的「全部窗口」改成
      「22 个抽样窗口（生产 `STEP=2.5` 的全窗对照见 §D6，人工、不进 CI）」。
  我倾向 (b)：真正的全窗对照放 §D6 已经够了，硬把它塞进 CI 会吃掉本 change 刚省下的预算。

---

## 2. P2 与 NIT

### P2-3 `viewer/game.test.js` 的索引摘要对**全部 Map 内容**是盲的（该类污染只有带 wasm 的那条用例看得见）

- 落点：`viewer/game.test.js:660` / `:668`：
  `JSON.stringify({ ...index, events: null, lineup: null })`。
  `playerAnchors` / `playerBounds` 是 `Map`，`JSON.stringify` 把它们序列化成 `{}` ——
  这正是 `design.md` §D7「摘要实现的一个坑」**点名过的那个坑**，tools 侧避开了（`digestIndex` 显式展开 Map），
  `game.test.js` 侧**没有**。
- **复现（探针，`/tmp/probe-digest2.mjs`）**：
  | 污染 | 该摘要看得见？ |
  |---|---|
  | `playerAnchors.get(0).pop()`（组内删锚点） | **看不见** |
  | `playerAnchors.delete(5)`（整组删） | **看不见** |
  | `playerBounds.get(0).isLast[0] = true` | **看不见** |
  | `eventEnds[1] += 1` | 看得见 |
  | `timeline[0].x = 0.99`（锚点对象被改，经 timeline 泄漏） | 看得见 |
  （即：只有「不经过 timeline 的那几类」才漏——而 `playerAnchors.delete(id)` 正是
  `design.md` §D7 记的 M1 变异形态。）
- 影响面：这条用例是**唯一不依赖 wasm、恒跑**的那条（`:655-670`），它的用途声明是
  「构造/推进不得改写被复用的静态索引」。带 wasm 的 tools 用例确实覆盖了该类（见下），
  所以不是真缺口，而是**声明与断言体不符** + 本地无 wasm 时该类污染无守卫。
- 旁证（顺带确认 tools 侧的摘要**真的**有区分度，不是空转）：我把
  `viewer/game.js:126` 后插一行 `if (opts.index && …) this._playerAnchors.delete(<首键>)`（M1 的自然形态）后实跑：
  `not ok 1 - 缓存索引 == 逐窗重建` + `not ok 2 - 静态索引是确定性纯函数…逐字节未被改写`（2 红），
  还原后 sha256 与 HEAD 一致（`88f5701d4a5fd4f02caf74f6d379e8802ce9c61f876977e2b1fa7d99d461bb95`，`git diff` 空）。
  其中 2 号红**只能**来自「展开 Map」——裸 `JSON.stringify` 在这个变异下是绿的。
- 建议：把 tools 里那个 `digestIndex` 提到共享处（或复制一份展开 Map 的版本）给 `game.test.js` 用。

### P2-4 「索引只依赖 `(events, lineup, mode)`」与代码不符：它把 `config` 烘进去了，而守卫看不见

- 声称处（三处，措辞都是「只依赖 (events, lineup, mode)」）：
  - delta spec `specs/pitch-viewer/spec.md`：「该结果 SHALL 只依赖 `(events, lineup, mode)`，
    SHALL NOT 依赖 `playTime` 或任何构造期可变状态」
  - `viewer/game.js:48-58` 的模块注释与 `:110-111`
  - `design.md` §D1 结论 1 / §D3「放（只依赖 `(events, lineup, mode)`…）」——而 §D3 同时把
    「依赖 config」列为**排除** `_highlightWindows` 的理由
- 实际：`buildTimeline`（`viewer/interpretation.js`）在**构建索引时**读 `config`。
  用探针把 `config` 的每个数值叶子逐个 ×2+1、看索引摘要是否变化，实测**活读取**有 5 个：
  `interpretation.shot.keeperReactDelay`、`interpretation.tackle.deflectSpeed`、`defaults.runSpeed`、
  `pitch.lengthMeters`、`pitch.widthMeters`。
- **复现（`/tmp/probe-config2.mjs`）**：
  1. `index = buildGameIndex(events, lineup, 'continuous')`（config = 默认）
  2. 改 `config.interpretation.shot.keeperReactDelay`（两次构造之间改 config —— §D3 明确承认调用方会这么干）
  3. `new Game(events, lineup, 'continuous', { index })` → **构造成功（守卫没拦）**
  4. 同一 `t=120` 的 `captureObservation` 整包：旧索引 vs 用新 config 重建 → **不同**
     （`守卫拦下了吗？ 没拦` / `旧索引 vs 重建：同一 t=120 的观测包 **不同**`）
- 可达性：**当前不可达**——唯一调用方 `tools/spacing-sweep-core.mjs:30-31` 在模块加载时设置 config 后再不修改，
  App 侧根本不传索引。所以这是「契约/机制表述错 + 守卫前提比声明窄」，不是活缺陷，故 P2。
- 建议：把措辞改成「只依赖 `(events, lineup, mode)` 与**建索引时刻的 config 常量**」，并说明守卫
  （身份比较）覆盖不到 config 变化；或把 live 的 5 个 config 叶子纳入「不得在两次构造之间改」的边界声明。
  另注意 §D3 的理由因此不自洽：「依赖 config」不能作为排除项，真正的排除理由是「依赖**逐次构造**的入参
  （`opts.skipThreshold`）」。

### P2-5 探针 `tools/zz-profile-sweep.mjs` **随 change 入库**，且现在已经是坏的/会误报

- `git diff --stat main...HEAD` 里有 `tools/zz-profile-sweep.mjs | 120 +++++`（HEAD 已包含）；
  但 `design.md` §D8、`tasks.md` 2.3 与**它自己的文件头**都写「读数固化后**删除**」。
- 且它在 HEAD 里已经**失准**：它包装 `Game.prototype._buildAnchorIndex` / `_computeEventEnds`
  （`:43-56`），而这两个方法在本 change 已被删除 → `Game.prototype[name]` 是 `undefined`，
  包一层壳后**永不被调用**，那两个阶段会静默打印 `0 ms … (0 次)`；同时它的「改前」列
  `new Game(events, lineup, 'continuous')` 现在**本身就含建索引成本**，改前/改后对比已无意义。
- 工作树里未提交的版本（167 行）在 `:126` 用了 `buildGameIndex`，但 `:13` 的 import 只有 `Game`
  → `ReferenceError`，跑到「改后」段就崩（即**现在也没法用它生成 §D6 的读数**）。
- 建议：合入前删掉（`git rm`）。若还要用它在合完 §D6 前再跑一次，先补 import，并在 `tasks.md` 里
  明确它是「临时保留到 §D6 落盘」而不是遗漏。

### P2-6 `viewer/app.js` 的 `game.js` import 版本号在 HEAD 里没跟着改（工作树已修）

- HEAD 状态：`viewer/index.html:537` → `app.js?v=20261012-1`（改了），但
  `viewer/app.js:10` 仍是 `import { createGame } from './game.js?v=20260918-15';`（**没改**）。
- 机制：模块 import 的 URL 才是缓存键，**不会**继承 `index.html` 里 `app.js?v=` 的查询串。
  于是回访用户拿到的仍是旧的 `game.js`（本 change 改的正是它）。
  本仓既有做法可佐证：`adc3b4d` 一次同时改了 `viewer/game.js`（28 行）与 `viewer/app.js`（4 行，
  即把 specifier 从旧值换成 `?v=20260918-15`）。
- 影响：本次**是良性的**——App 侧行为按设计逐位不变，旧 `game.js` 与新 `game.js` 在 App 路径上等价；
  所以这是「约定未遵守」，不是用户可见的错。但按 CLAUDE.md §4 的口径它就是遗漏。
- 现状：**我审阅期间工作树里出现了未提交的修复**（`viewer/app.js:10` → `game.js?v=20261012-1`），
  提交上去即可关闭本条（本报告按 HEAD=39155c4 记录）。

### P2-7 `viewer/game.test.js` 声称覆盖 `_interpolateAnchors` 返回 `null` 的回落分支，fixture 走不到

- 声称处：`viewer/game.test.js:584-586`（「…**包括 `_interpolateAnchors` 返回 null 时回落 lineup 站位的那条分支**…」）。
  `design.md` §D2/§D5 与 delta spec 的 scenario「该分支 SHALL 在两条路径上表现相同」都以它为论据之一。
- **复现（探针 `/tmp/probe-fixture.mjs`，直接用该用例的 fixture）**：
  各组首锚点 `t`：`0:0 5:0 9:0 15:0`，球 7 个锚点；在用例列出的 12 个时刻
  （0 / 0.5 / 3 / 5 / 9.999 / 12 / 20 / 29.5 / 30 / 30.5 / 45 / 999）上
  `_interpolateAnchors` 返回 `null` 的次数 = **0**。
  ⇒ 这条分支在 fixture 里**一次都没被走到**，断言体不可能覆盖它。
- 注：这与 `design.md` §D5 的实测（真实流里每个实体在 `t=0` 就有锚点、该分支在窗口区间不可达）**一致**——
  所以这条分支在生产里也确实不可达，属「结构性等价」而非可测等价；但**那就该把注释改成实话**
  （或给 fixture 加一个「在 lineup 里但事件流里从不出现」的球员 id，让分支真的被走到——
  我已确认：`lineup` 里没有锚点的 id 会让 `_playerAnchors.get(id)` 为 `undefined` → 返回 `null` → 走回落）。

### NIT

- **NIT-1**：`viewer/game.js` 构造函数里字段**赋值顺序变了**（`_eventEnds`/`_matchEnd` 现在先于
  `sentOffAt`/`_clipIndex` 赋值）。我逐条核过：被移动的三段（`buildTimeline` / 分组索引 / `eventEnds`+`matchEnd`）
  都不读 `sentOffAt`/`_clipIndex`，`_buildHighlightIndex` 仍在 `_eventEnds` 之后调用，
  `_initToEvent(0)` 仍在最后 → 无语义差异。仅记录，供日后 diff 时不被误判为可疑。
- **NIT-2**：`_computeEventEnds` / `_buildAnchorIndex` 两个 prototype 方法被删除，其体移入模块级自由函数。
  全仓 grep（含 `openspec/`）只有那个已坏的探针在 `Game.prototype` 上包装它们 → 无其它 monkey-patcher，
  但「prototype 方法消失」是一条隐式 API 变更，值得在 design 里记一句（现在没记）。
- **NIT-3**：新用例给 CI step 3 加了 ~45 s（本机：等价用例 43.0 s；整个 `spacing-sweep.test.mjs` 167 s）。
  相对于它守住的东西这笔账是划算的，但本仓有「CI 预算债」的前科，建议在 design/report 里如实记读数
  （现在 §D7 没记新用例的 CI 成本）。

---

## 3. 我实跑核实为**真**的关键主张（正面清单）

1. **默认路径逐位不变（App 侧）**：`index = opts.index ?? buildGameIndex(events, lineup, this.mode)`
   的两条分支里，默认分支的字段来源与旧代码**逐行同构**（`buildTimeline(events, m)` → 同样的分组循环 →
   `eventBoundaryFlags` → 同样的 `max(events[last].t, timeline[last].t)`；`computeEventEnds` 体与旧
   `_computeEventEnds` 只差 `this.timeline` → 形参）。`mode` 归一化两侧是**同一表达式**
   （`game.js:60` vs `:100`：`mode === 'clip' ? 'clip' : 'continuous'`）。
   证据：`cd viewer && node --test *.test.js` → **393 tests / 387 pass / 0 fail / 6 skipped**（含 `app.test.js` DOM）；
   `node e2e-v2.mjs` → `E2E v2 OK：6281 事件 … 无 snap(4 seed: 球 0.0079, 球员 0.0151)`。
2. **真实门端到端**：`node tools/spacing-sweep.mjs` → 8 行 `seed N: 2157 windows, player_overlap findings=0`
   + `OK: no player_overlap findings over the swept windows`，**exit 0**，wall **3m18.7s**（并发 4 worker，本机）。
   顺带证明守卫在 **worker 线程里也不误伤**（worker → `runSeed` → 带索引构造，未抛）。
3. **全窗污染 = 0**（生产 `STEP=2.5`、2157 窗、含 Map 展开的深摘要）：见 P1-2 的复核；摘要敏感性另行自证
   （锚点对象改动经 timeline 可见；三类 Map 内容改动经展开可见）。
4. **`design.md` §D5 独立复现**：8 个默认 seed 全部满足「23 个实体（球 + 22 人）的**最早锚点 `t` 都 = 0**」，
   `lineup` 里无锚点的球员 = 0；对窗口区间 `t ∈ [5, 5395]` 以 step 12.7 s 逐点调用
   `_interpolateAnchors('ball'|'player', t, id)` → **null 次数 = 0**。
   结论（该分支在本门窗口区间不可达）与其机制（引擎在 lineup/kickoff 就为每个球员发锚点）**都成立**，
   且比 §D5 写的更强：连 `t = 0` 都不可达。
5. **`design.md` §D1 方向复现**：seed 42、`DUR=5400`、`t ∈ [5,605]`、241 窗 —— `events=6281`、
   `timeline anchors=105411`（与 §D1 完全一致）；逐窗构造 = **93.7%**（§D1：91.5%），
   缓存后逐窗成本 32.03 ms（构造 1.20 ms），**提速 14.78×**（§D1 估 11.9×）。
   ⚠️ 绝对毫秒与本机负载相关（我这台明显更慢：改前 473 ms/窗 vs §D1 的 153 ms/窗），**比值与结论一致**。
6. **共享结构只读**：全仓 grep `_ballAnchors|_playerAnchors|_ballBounds|_playerBounds|_eventEnds|_matchEnd|.timeline`
   → 读点全在 `viewer/game.js`（插值/二分/高亮/progress）与 `viewer/observation.js:239`（传给
   `deriveAuditInput`），无写点；`derive-audit-features.js` 的 `anchorLists` 只把锚点**引用**推进**新建**数组；
   仓内 `.sort(` 只出现在自建数组上（`interpretation.js:486` 排自己的 `anchors`；
   `detectors.mjs:481` 排 `[...snapshots]` 副本）。`_highlightWindows` 逐实例新建（`game.js:178`），未共享。
7. **守卫无「合法但被拒」**：全仓 `new Game(` 调用点已枚举（`viewer/*.test.js` / `debug.test.js` /
   `e2e-v2.mjs` / `visual-probe.js` / `observation.test.js` / `derived-audit.test.js` /
   `tools/fixtures/generate-real-audit-fixture.mjs` / `spacing-sweep-core.mjs`），除本 change 的
   tools 路径外**无人传 `opts.index`**；也**无人**把 `index` 当别的含义塞进第 4 参
   （既有 opts 只有 `baseSpeed`/`skipThreshold`）。`mode` 归一化两侧同式，clip↔clip 放行已测。
   「非法但能过」= 身份相同而内容就地变（就地改 `events`/`lineup`，或改 config）——
   前者实现者已补进 `design.md` §D4（我读到的版本含该段），后者见 P2-4。
8. **无跨 seed 泄漏**：`index` 是 `runSeed` 内的 `const`（`:107`），每 worker 独立 wasm，
   `game.js` 无模块级记忆化；并发路径与串行路径共用同一 `runSeed`（未改）。
9. **`simulateEvents` 抽取逐字等价**：与旧内联体（`git show main:tools/spacing-sweep-core.mjs` 的
   对应段）逐行比对一致，仅把 `SCRATCH`/`encoder`/`decoder` 的引用留在模块作用域内。
   窗口循环、`captureObservation` 参数、`detect(bundle.audit_input.players, DEFAULT_AUDIT_PROFILE)`、
   `windows/findings/worst` 累加、返回对象形状、`formatSeedLine`/`sweepExitCode` 全部未变。
10. **判据面未动**：`DUR=5400` / `STEP=2.5` / `DEFAULT_SEEDS=[42,1,2,3,7,59,18,94]` /
    `DEFAULT_AUDIT_PROFILE` / `detectors.mjs` / `engine/` / `.github/workflows/ci.yml` 均**不在**
    `git diff main...HEAD` 里。`openspec validate p154-game-index-cache --strict` → `valid`。

---

## 4. 我不确定 / 未能核实的部分

1. **§D7 变异表 M1 的「红 1 条」我复现不出**：我按最自然的落点（构造函数里、复用路径上、
   `this._playerAnchors.delete(<首键>)`）实跑得到 **2 红**（等价用例 + 摘要用例同时红）。
   「只红摘要那一条」需要某个特定落点（例如删一个**行为上无关**的键）才能实现。
   ⇒ 我看不出表里 M1 的具体改法是否与它自述的落点一致；建议把 M1/M3/M5 的**变异 hunk 原文**记进
   design（现在只有文字描述），否则这条取证不可复核。**（我未据此判缺陷——我复现出的 2 红恰好
   证实了摘要必须展开 Map 这一机制性主张。）**
2. **M2 / M3 / M5 我未重跑**：M5（生产路径喂 `lineup.map(p => ({...p}))` → 6 红）与守卫逻辑一致、
   可信度较高；M3（就地累加 `eventEnds` → 2 红）同理。但**「红 6 条」里的「含 `runSweep` 三条编排」我没验证**。
3. **`design.md` §D6 仍是 TBD**（按指示不计）。注意：P1-2 的「全 2157 窗」覆盖目前**只**挂在 §D6 上，
   而 §D6 是人工复验、不进 CI —— 这部分覆盖**结构性缺失**是否可接受，需要实现者/用户拍板。
4. **`tools/zz-profile-sweep.mjs` 的最终处置**：我只是在它被并发编辑的过程中读/静态分析了两版；
   它会不会在 §D6 落盘后被删，我无法预判（见 P2-5）。
5. **本 worktree 在审阅期间是脏的且仍在动**：`viewer/app.js`（P2-6 的修复）、
   `tools/spacing-sweep.test.mjs`（加强 detector 输入比对）、`design.md`（新增 §D4「守卫的边界」段）、
   `tools/zz-profile-sweep.mjs`，外加 `node_modules` 自指 symlink 被换成真实目录
   （`git status` 报 `D node_modules`）。这些**不是**我的改动；我对 `viewer/game.js` 与
   `tools/spacing-sweep-core.mjs` 的临时变异已逐字节还原（两文件 `git diff --stat` 为空，
   哈希 `88f5701d…` / `cdb4838a…`，无 `MUTANT` 残留）。§1/§2 的行号按 **HEAD=39155c4** 记，
   涉及实现者并发改动处已单独标注。

## 5. 复现命令速查（全部在 repo 根）

```bash
# 我改过又还原的两处，还原证据：
git diff --stat -- viewer/game.js tools/spacing-sweep-core.mjs   # 空

# 全量套件（App 侧语义未变）
cd viewer && node --test *.test.js        # 393 tests / 387 pass / 0 fail / 6 skipped
node e2e-v2.mjs                            # E2E v2 OK …
cd ../tools && node --test *.test.mjs      # spacing-sweep.test.mjs: 20/20（含 4 条 #154 新用例）

# 真实门（本机 3m19s，exit 0）
node tools/spacing-sweep.mjs

# 变异 M-a（P1-1）：把 spacing-sweep-core.mjs:112 的 { index } 去掉 → 20 条全绿
# 变异 M1（P2-3 旁证）：viewer/game.js:126 后插 this._playerAnchors.delete(<首键>) → 2 红
```
