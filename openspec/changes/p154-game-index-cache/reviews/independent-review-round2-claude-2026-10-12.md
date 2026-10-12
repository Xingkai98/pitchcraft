# 独立审阅（第二轮 / 复审修复）：#154 滑窗门逐窗复用静态索引

- 复审对象：commit **0d089f1**（`fix(viewer,tools): #154 审阅修复——把「优化被摘掉」变成可观测的判据`），
  在其上审阅的区间 = **`39155c4..0d089f1`**
- 第一轮报告：`reviews/independent-review-claude-2026-10-12.md`（P0×0 / P1×2 / P2×5 / NIT×3）
- 手段：**逐条独立复跑**（不复用实现者的读数）：4 条定向变异 + 3 个一次性探针（全部落 `/tmp`，已删）
  + 全套测试 + 真实门。所有被我改过的文件均**逐字节还原**（见 §5）。
- 未覆盖：`engine/`（本区间零改动）、`cargo test`（同上）、CI 上的最终时长（§7）

## 0. 结论

**通过。** 第一轮的 **2 条 P1 + 5 条 P2 + 3 条 NIT 全部修复，我逐条复验成立**，且这轮修复
没有引入新的 P0/P1（本区间新增的注入点与篡改式断言，我都用变异独立验过它的区分度）。

本轮新发现 6 条**全部是 NIT**（5 条是 §D7 变异表/现场记录的**读数与归属不准**，1 条是测试断言可以更
严密），**没有一条影响代码行为或判据有效性**。是否在合入前修掉由实现者定；我倾向「NIT-1/2/3 顺手改文字
（成本几分钟），NIT-4/5 记入已知即可」。

| 第一轮 finding | 状态 | 我的独立证据（摘要） |
|---|---|---|
| **P1-1** 优化被摘掉不可观测 | ✅ 已修 | 复跑 M6 → **红 1**（`注入的索引必须真的被构造消费`）；复跑 M7 → **红 1**（`实测 23 次`）；篡改字段的**可观测性自证**：22/22 窗输入不同且窗数不变（非退化） |
| **P1-2** 「覆盖全部窗口」是假声明 | ✅ 已修 | 代码 = 构造层真 2157 窗（`assert.equal(fullWindows, 2157)`）+ 管线层 22 窗并如实标注；**区分度实跑**：M1 下红在「全部 2157 窗…」那条断言上 |
| **P2-3** `game.test.js` 摘要有 Map 盲区 | ✅ 已修 | 摘要改为 `digestIndexForTest`（展开 Map）+ 反证条；M1（就地删组）→ `game.test.js` #40 **红**（第一轮同一变异下它是绿的） |
| **P2-4** 「只依赖 (events, lineup, mode)」机制错 | ✅ 已修 | 代码注释 / design §D3+§D4 / pitch-viewer spec 三处措辞均已订正；**新理由经读码核对为正确**（见 §2.4） |
| **P2-5** 探针入库且已坏 | ✅ 已修 | `tools/zz-profile-sweep.mjs` 已 `git rm`，全仓（含 `openspec/`）无代码引用 |
| **P2-6** `viewer/app.js` 版本号未随 | ✅ 已修 | `viewer/app.js:10` = `game.js?v=20261012-1`，已提交；与 `index.html:537` 同日序号一致 |
| **P2-7** fixture 走不到 `null` 分支 | ✅ 已修 | 探针实测：新 fixture 里 id 7 在 t=0/5/20/45 **全部**返回 `null`（其余球员非 null），落点保持 lineup 站位；测试自带前提断言 |
| NIT-1（赋值顺序）/ NIT-2（隐式 API 变更）/ NIT-3（CI 成本） | ✅ 已记入 §D8 / §D7 | 文字与代码一致（§2.6） |

---

## 1. 我本轮的变异矩阵（全部自己跑，含与实现者记录不一致处）

工具：`cp` 备份 → `python3` 单点替换（`assert count == 1`）→ 跑目标用例 → `cp` 还原 → `git diff` 空
+ `grep -c MUTANT` = 0（§5 有还原证据）。

| 我跑的变异 | 我的落点 | 我的实得 | 实现者记录 | 一致？ |
|---|---|---|---|---|
| **M6** 摘掉优化（`{ index }` 去掉） | `core:112` | tools：**红 1**，报错文案 = `seed 42：注入的索引必须真的被构造消费` | 红 1 | ✅ |
| **M7** 索引挪回窗口循环（保留循环外那次） | `core:123` 后 | tools：**红 1**，`静态索引每 seed 只应构造一次（实测 23 次）` | 红 1，但记的是「实测 **2158** 次」 | ⚠️ 红数一致，**读数不一致**（见 NIT-2） |
| **M1** 就地删 `playerAnchors` 一组（**原样照抄 §D7 记的 hunk**） | `game.js:125` 后 | tools：**红 1**（摘要用例，逐窗一致**绿**）；`game.test.js`：**红 3**（#40 输入/索引不被改写 + #14/#16 tackle 两条连带） | 「红 1 条」 | ⚠️ 红数在 **tools 文件内**一致；**仓库级实为 4**（见 NIT-3） |
| **M5** 生产路径索引与 lineup 不同源 | `core:123` | tools：**红 6** = #6 并发==串行 / #7 门被悄悄放宽 / #9 detector 接线 / #10 runSweep 干净 / #11 runSweep finding / #17 逐窗一致 | 红 6（举的例子是「逐窗一致、并发==串行、detector 接线、runSweep **三条**编排」） | ⚠️ 红数一致，**清单不准**（runSweep 是 2 条不是 3 条；漏了 #7 且它是另一类）（见 NIT-4） |
| **M2** 同源守卫削弱成只比 `mode` | `game.js:118` | tools #20 **红 1**；`game.test.js` #41 **红 1** | 红 1 | ✅ |
| **V4**（我第一轮的 M1 落点：`if (opts.index && …)` + 删首键） | `game.js:125` 后 | tools：**红 2**（逐窗一致 + 摘要） | §D7 称我那条的差异「正是**因为表里没写清删的是哪个键**」 | ❌ **机制说错了**（见 NIT-1） |
| **M4**（naive 复用实例） | — | **未重跑**（第一轮已独立复现其前提：§D5 的 null 分支在窗口区间不可达 → 真等价变异） | 绿 | — |

### 1.1 我额外做的「篡改字段真的看得见吗」自证（实现者点名要核的那条）

实现者说：第一版篡改选 `playerBounds` **改了也看不见**（audit 通路自己从 `timeline` 分组）。
我用探针把三种篡改的**逐窗 detector 输入**与正常路径逐窗比（seed 42、`dur=5400`、`step=250` → 22 窗）：

| 篡改 | 窗口数（正常/篡改） | 不同窗数 | 判据 |
|---|---|---|---|
| `timeline: []`（**实装选的就是这个**） | 22 / 22 | **22/22** | ✅ 真的看得见；且窗数不变 ⇒ 不是「退化/异常」造成的假不同（第 1 窗输入 24,339 B → 2 B） |
| `playerBounds = new Map()`（对照） | 22 / 22 | **0/22** | ✅ 证实「这个字段改了看不见」，选它就等于空转 |

⇒ ②b 的篡改**落在「改了就一定看得见」的字段上**，这条接线守卫不是空话。

---

## 2. 逐条核「声明 = 断言体」

### 2.1 P1-1（`tools/spacing-sweep-core.mjs` + `spacing-sweep.test.mjs:388-430`）

- 注入点：`runSeed`/`runSerial`/`runSweep` 三处都有 `buildIndex = buildGameIndex`（`:112` / `:177` / `:300`）；
  并发 > 1 + 非默认注入 → **报错**（`:317`），与 `detect` 那条**同一条守卫、同一句文案** ✅
  （测试 `:271-285` 两条 `assert.rejects` 分别钉 `detect` 与 `buildIndex`，我复跑全绿）。
- ②b(i) `assert.equal(indexCalls, 1)`：**双向有效** —— 摘掉调用 → 0 ≠ 1 红；挪回循环 → 23 ≠ 1 红（我两种都实跑过）✅
- ②b(ii) 篡改式接线断言：见 §1.1，区分度实测成立 ✅
- worker 路径未被污染：`spacing-sweep-worker.mjs` 仍只传 `{wasm, seed, dur, step}` → `buildIndex` 走默认 ✅
- 「新引入的旁路」核查：`runConcurrent` **不**接受 `buildIndex`（同 `detect` 的既有形状）；绕过 `runSweep`
  直接调 `runConcurrent({…, buildIndex})` 会被 JS 静默忽略——这是 `detect` **既有**的同款性质，不是本区间新引入的，且 §D7「覆盖边界」已把「未来绕过 `runSeed` 的加速路径不受保护」写成已知边界 ✅

### 2.2 P1-2（`spacing-sweep.test.mjs:455-492`）

- 构造层：`for (let t = 5; t <= dur - 5; t += DEFAULT_STEP)` + `assert.equal(fullWindows, 2157)`；
  管线层：`t += 250` + `assert.equal(sampled, 22)` —— **两个层各自都有计数断言**，声明与断言体一致 ✅
- 区分度（关键）：M1 变异下，红的是 `全部 2157 窗的构造/seekTo/step 之后索引仍须逐字节相同`
  —— 证明这个 2157 窗循环**真的**在守构造期写入，不是装饰 ✅
- design §D7 与该用例的「守什么」列、§D7「覆盖边界」段、tasks 4.2 现在的措辞 = 「构造层全部 2157 窗 /
  管线层 22 窗抽样 / 全窗管线对照见 §D6 人工 run」——**与代码一致** ✅

### 2.3 P2-3（`viewer/game.test.js:671-704`）

- `digestIndexForTest` 显式展开 `playerAnchors` / `playerBounds`（`:677-678`），与 tools 侧 `digestIndex` 同口径 ✅
- 反证条覆盖：分组整组删 / 组内删锚点 / 锚点被改 / 结束时刻被改（`:692-703`）—— 我核过每条的前提非空
  （id 5 存在、`shrunk.get(5)` 非空、`eventEnds[0]` 存在）⇒ 无空转 ✅
- **端到端**：M1（就地删组）→ `#40 索引复用不改变外部输入` 变红。第一轮我把同一变异跑在旧摘要上是**绿**的
  （探针实测三类全盲）—— 修复确实把这一类补上了 ✅

### 2.4 P2-4（`viewer/game.js:48-63`、design §D3/§D4、`specs/pitch-viewer`）

- 三处措辞均已改成「只依赖 `(events, lineup, mode)` **+ 建索引时刻的 config 常量**」，
  并把 config 变化写成**已知边界**（含我第一轮 `keeperReactDelay` 实验的结论）✅
- 我核过新写的「实测活读取 5 个叶子」列表与我的测量**逐字一致**（`shot.keeperReactDelay` /
  `tackle.deflectSpeed` / `defaults.runSpeed` / `pitch.lengthMeters` / `pitch.widthMeters`）✅
- **D3 的新理由对不对（你点名要我读码核）**：**对**。`_highlightWindows` 由 `_eventEnds` **加
  `this._skipThreshold`** 派生，而 `this._skipThreshold = opts.skipThreshold ?? config.playback.skipThresholdSeconds`
  （`game.js:148`）——即它依赖**逐次构造的 `opts`**，而 `buildGameIndex(events, lineup, mode)` 的签名
  里**没有 opts**、构造时也拿不到。若把它冻进索引，`viewer/*.test.js` 里大量 `skipThreshold: Infinity`
  的构造会复用另一套窗口 ⇒ **语义变化**。新理由准确、且比旧理由（「依赖 config」——`eventEnds` 同样是
  config 产物，说不通）更sharp ✅
- 旧理由已在 §D3 里**显式标注为「机制说错了」**并给出正确理由 —— 符合本仓「记录订正」的惯例 ✅

### 2.5 P2-5 / P2-6 / P2-7

- P2-5：`tools/zz-profile-sweep.mjs` 不存在（`ls` 报 No such file），`git diff --stat` 里是删除 ✅
- P2-6：`viewer/app.js:10` = `import { createGame } from './game.js?v=20261012-1';`，在 0d089f1 里已提交 ✅
- P2-7：探针实测（§1.1 之外的独立一条）：`buildGameIndex` 的 `playerAnchors` 键 = `[0, 5, 9, 15]`（**不含 7**）；
  `_interpolateAnchors('player', t, 7)` 在 t = 0 / 5 / 20 / 45 **全部 null**，其余球员**全部非 null**；
  id 7 的落点 = lineup 站位 `(0.3, 0.62)`（回落分支真的生效）。用例 `:638` 自己断言这条前提
  ⇒ 回落分支**真的被走到**，不是空话 ✅

### 2.6 NIT-1/2/3（§D8 / §D7 的记录）

- §D8 记的两个 prototype 方法被删 + 字段赋值顺序 —— 我第一轮逐条核过无语义差异，文字与代码一致 ✅
- §D7 记的「新增用例 CI 成本」：我复测 `tools/spacing-sweep.test.mjs` **整文件 22.7 s**
  （#17 13.5 s、#18 3.5 s）——与记录的「≈18–21 s」同量级 ✅。⚠️ 附带一条**读数纪律**：同一文件我第一轮
  在负载高的机器上量到 **167 s**（#17 43 s）——**同一台机器差 7×**。故「18–21 s」不可当上界读，
  与仓内「CI 机型速度波动大」那条教训一致。建议在 §D7 那句后加半句「本机空闲读数；负载下可达 ~2–3 分钟」。

---

## 3. 本轮新发现（全部 NIT，均不影响行为）

### NIT-1 §D7 把我第一轮「2 红 vs 1 红」的原因说错了（机制错，不是结论错）

- 落点：`design.md:235`（「审阅者按最自然的落点复现 M1 得到的是 2 红而不是表里的 1 红，
  **正是因为表里没写清「删的是哪个键」**」）。
- **反例（我实跑 + 探针）**：两个 hunk 删的是**同一个键**——探针实测 seed 42 下
  `playerAnchors` 首个键 = **0**，`_players[0].id` 也 = **0**（`lineup` 前三个 id = 0,1,2）。
  真正的差异是**落点是否被 `opts.index` 守卫**：我的 hunk 写成 `if (opts.index && …)` ⇒ 只在复用路径删、
  逐窗重建路径不删 ⇒ **两条路径观测分岔** ⇒ 逐窗一致用例也红（2 红）；§D7 的 hunk 是**无条件**删 ⇒
  两条路径同样删 ⇒ 逐窗一致绿、只有摘要红（1 红）。我两个 hunk 都实跑过：`2 红` / `1 红`，与本解释吻合。
- 影响：纯记录。但它落在「变异表的解释」上，而这正是本仓反复出问题的位置（「结论对但机制错」），故列出来。

### NIT-2 M7 记录的读数（2158 次）与记录的 hunk + 用例的 `step=250` 不自洽

- 落点：`design.md:245`（「实测 **2158** 次」）。
- 按记录 hunk（循环外 1 次 + 循环内每窗 1 次）跑**该用例**（`step = 250`，22 窗），断言实际打印
  **`实测 23 次`**（我实跑所见）。要得到 2158（= 2157 + 1）需要循环跑生产密度（`step=2.5`）——
  而 `indexCalls` 只在等价用例里计数，那条用例的 step 是 250。
- 影响：纯记录。红数（红 1）我复现 ✓，结论不变。

### NIT-3 M1 的「红 1 条」未标定范围；仓库级实为 4 条

- 落点：`design.md:241`（M1 行「**红 1 条**」）。
- 实测（原样照抄 §D7 的 hunk）：`tools/spacing-sweep.test.mjs` **红 1**（摘要用例，与表一致）；
  `viewer/game.test.js` **红 3** = `#40 索引复用不改变外部输入`（**这正是 P2-3 修复的预期后果**）
  + `#14/#16`（tackle 两条，因为该 hunk 是**无条件**的，顺带改了**默认路径**的行为）。
- 影响：纯记录。建议表里写清「口径 = tools 套件内」或直接记仓库级 4 条（含 2 条连带）。

### NIT-4 M5 的「红 6 条」清单不准（数字对）

- 落点：`design.md:243`（举的例子：「逐窗一致、并发==串行、detector 接线、`runSweep` **三条**编排」）。
- 我实跑得到的红集合 = `#6 并发==串行`、`#7 门被悄悄放宽必须变红`、`#9 detector 接线`、
  `#10 runSweep 干净路径`、`#11 runSweep finding`、`#17 逐窗一致` —— 计数 6 ✓，但
  `runSweep` 编排是 **2 条**（#12 崩溃路径这条是绿的），且**漏列了 #7**（判据面钉死那条，另一类）。
- 影响：纯记录（结论「fail-loud、6 条红」成立且我复现）。

### NIT-5 ②b(ii) 只断言「不同」，没断言「同窗数」——理论上可被「零窗」满足

- 落点：`tools/spacing-sweep.test.mjs:425-430`：`assert.notDeepEqual(tamperedInputs, refInputs, …)`。
- 若某天篡改导致 `runSeed` 少跑/不跑窗口（例如提前 return），`tamperedInputs = []` 也会「不同」⇒ 断言**因错的
  理由**通过（当前不会：抛异常会直接红）。我实测篡改运行的窗数 = 22 = 正常窗数（§1.1），所以**当前无实洞**。
- 建议（一行）：在 `notDeepEqual` 前加 `assert.equal(tamperedInputs.length, refInputs.length, …)`。

### NIT-6 `viewer/index.html` 的版本串未随 0d089f1 再 bump

- 0d089f1 改了 `viewer/app.js`（specifier）与 `viewer/game.js`（注释），按 CLAUDE.md §4 的字面要求
  「改 JS 后把 `?v=` 换成新值」，同日序号可到 `20261012-2`；实际仍是 `20261012-1`。
- **无实害**：App 行为逐位不变，且本区间把 `index.html`（`app.js?v=20261012-1`）与 `app.js`
  （`game.js?v=20261012-1`）**改成了一致**；已拉到旧 `app.js` 的浏览器最多继续用旧 `game.js`，
  而两者在 App 路径上等价。列出来只是因为本仓对 §4 很较真。

---

## 4. 我实跑的全套结果（0d089f1，本机）

| 套件 | 结果 |
|---|---|
| `cd viewer && node --test *.test.js` | **394 tests / 388 pass / 0 fail / 6 skipped**（含 `app.test.js` 38/38 DOM） |
| `cd viewer && node e2e-v2.mjs` | `E2E v2 OK：6281 事件 … 无 snap(4 seed: 球 0.0079, 球员 0.0151)` |
| `cd tools && node --test *.test.mjs`（全套） | **525 tests / 525 pass / 0 fail / 0 skipped**，22.6 s |
| `node tools/spacing-sweep.mjs`（真实门） | 见 §7（本轮复跑） |
| `openspec validate p154-game-index-cache --strict` | `valid`（第一轮已核；本区间 spec 仍为 ADDED delta） |

⚠️ **本地环境坑（不是代码问题）**：本轮 `viewer/app.test.js` 一开始 **`ERR_MODULE_NOT_FOUND: jsdom`** 失败——
因为提交态 `node_modules` 是**入库的自指 symlink**（`git ls-tree HEAD node_modules` = `120000 blob …`），
其目标链 `…/football-manager-clone/node_modules` 自指（`Too many levels of symbolic links`）⇒ jsdom 解不到。
ci 走 `npm ci`，不受影响。我按 §D8 记录的同款做法在本 worktree 临时 `npm ci`（38 包，2 s）跑完 DOM 测试，
随后 `rm -rf node_modules && git checkout -- node_modules` 还原（`readlink` 与 `git status` 均干净，§5）。
**结论：第一轮的 app.test.js 绿不是偶然，本轮同样绿；中间那次红是环境态，不是回归。**

---

## 5. 还原证据（我改过又还原的文件）

```
sha256(viewer/game.js)              = d4725db4d69d1f3b956e523bed33b35dfc880dd3e4dfc1b963037266e34c78fc
sha256(tools/spacing-sweep-core.mjs)= 1caef1efad98b7a06e8bde4405453a5dc2e523721f3f51695c6022221bd473dc
git diff --stat -- viewer/game.js tools/spacing-sweep-core.mjs   # 空（与 0d089f1 逐字节相同）
grep -rc MUTANT viewer/game.js tools/spacing-sweep-core.mjs      # 0 / 0
git status --porcelain                                            # 空
```

---

## 6. 我没验证的部分（如实写）

1. **M4（naive 复用实例 → 绿）本轮未重跑**：它是「真等价变异」的主张，依据是第一轮我独立复现过的
   §D5（null 分支在窗口区间不可达）。若要在 CI 口径上更强，可把 §D5 的 8-seed 扫描做成一次性探针记录 —— 我判断不值得（结论已两轮独立成立）。
2. **CI 上的最终读数**（step 5 / job 时长、`verify.sh` 全绿）——只有 push 后才有；本区间**未跑 `cargo test`**
  （`git diff 39155c4..0d089f1 -- engine/` 为空，且本 change 不动 Rust）。
3. **`design.md` §D6 的 sha256 明细与「16 分钟/seed」** 是人工全量跑的读数，我**未重跑**（8 seed × 2157 窗 ×
   两条路径 ≈ 数小时）。我只独立跑过：真实门（§7）、seed 42 全 2157 窗的深摘要对照（第一轮）、
   等效性由单元用例覆盖（22 窗 × 2 seed × 2 路径）。
4. **variant 类猜测**：NIT-2 里「2158 大概来自生产 STEP 的某次跑」是我的推断，不是实测。

## 7. 真实门复跑（0d089f1，本机）

见文末追加段（后台任务完成后补记）。

---

## 8. 复现命令速查

```bash
# 全套
cd viewer && node --test *.test.js && node e2e-v2.mjs
cd ../tools && node --test *.test.mjs

# 变异 M6（摘掉优化）→ 应红 1（注入守卫）
python3 - <<'PY'
import pathlib; p=pathlib.Path('tools/spacing-sweep-core.mjs'); s=p.read_text()
p.write_text(s.replace("const game = new Game(events, lineup, 'continuous', { index });",
                       "const game = new Game(events, lineup, 'continuous'); // MUTANT"))
PY
cd tools && node --test --test-name-pattern "缓存索引 == 逐窗重建" spacing-sweep.test.mjs

# 变异 M1（§D7 原样 hunk）→ tools 红 1（摘要）/ game.test.js 红 3
python3 - <<'PY'
import pathlib; p=pathlib.Path('viewer/game.js'); s=p.read_text()
p.write_text(s.replace("    this._playerAnchors = index.playerAnchors;\n",
  "    this._playerAnchors = index.playerAnchors;\n    if (this._players.length) this._playerAnchors.delete(this._players[0].id); // MUTANT\n"))
PY
```
