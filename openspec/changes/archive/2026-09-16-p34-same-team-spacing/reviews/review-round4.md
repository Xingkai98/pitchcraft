# P34 独立零记忆审阅（第 4 轮 / 终审）

审阅对象：分支 `p34-same-team-spacing/2026-09-15`，工作区
`/home/happy/.paseo/worktrees/1g1x3st4/p34-same-team-spacing-2026-09-15`。
审阅者**无任何前序上下文**，只凭仓库内容判断；以下每个数字均为本轮亲手跑出。

> **审阅期间 HEAD 移动了三次**（实现者在同 worktree 并发提交）：
> 任务点名的是 `ad88ce0`；审阅开始后依次落了 `c1b437c`（04:34）、`5bb7b9a`（04:51）、
> `8d836b0`（05:16）。本报告覆盖**整个区间**：以 `ad88ce0` 为主审对象，并对三笔后续提交
> 逐条独立复核。所有变异均已还原，最终 `git status` **干净**（见文末）。
> 三笔后续提交**未触碰** `viewer/game.js` / `engine/` / `verify.sh`；
> 只改了 `viewer/game.test.js`（+边界断言）、`tools/spacing-sweep.mjs`（seed 集）与文档。

---

## 结论：**通过**（P0 无；P1 无；P2 全部撤销或已修、NIT ×4，其中 4 项在审阅期间已由后续提交修复）

任务点名的 `ad88ce0` 三项改动（真修 `SWEPT_LIGHT_SHARE` 注释、viewer 幽灵渲染排除、
滑窗门入 `verify.sh`）**全部正确**，既有测试无回归（viewer 305/305、tools 404/404、
`verify.sh` 六步全绿、`openspec validate` 14/14）。新增 viewer 改动**语义正确、无遗漏使用点、
有测试覆盖且测试有牙**（两处恒真/恒假变异均变红）。

审阅中我发现的 P2/NIT 缺陷，实现者已在 `c1b437c`/`5bb7b9a`/`8d836b0` **并发修复**（边界测试牙、
`real-gate.md` 陈旧断言、`review-response.md` 错误声明、红牌 seed 单点覆盖、悬空引用）。
**最终 HEAD `8d836b0` 上除 §五 NIT-6 一项外均已收口**（我已逐条独立复核，见 §四/§五）。

---

## 一、新 viewer 改动（重点）

文件：`viewer/game.js`（`sentOffAt` / `players` getter / `_players`）。

### 1.1 时刻语义正确 ✅

`players` getter（`game.js:171-178`）：

```js
get players() {
  if (this.sentOffAt.size === 0) return this._players;
  const t = this.playTime;
  return this._players.filter((p) => {
    const offAt = this.sentOffAt.get(p.id);
    return offAt === undefined || t <= offAt;   // t <= offAt 仍可见；t > offAt 隐藏
  });
}
```

与任务要求（`t <= offAt` 仍显示、之后隐藏）**一致**，且与 audit 侧口径**逐字一致**
（`derive-audit-features.js:333` 的 `if (offAt !== undefined && t > offAt) continue;`）。

**端到端行为验证**（我直接读 wasm 事件流 + 跑真实采集管线，seed 59 的 two reds
`15@78`、`8@3835`）：

```
id=15 t=73  (offAt=78):   viewer_snapshot_has=true    audit beyond_offAt=0
id=15 t=78  (offAt=78):   viewer_snapshot_has=true    ← 红牌当刻仍可见 ✅
id=15 t=83  (offAt=78):   viewer_snapshot_has=false   ← 之后隐藏 ✅
id=15 t=278 (offAt=78):   viewer_snapshot_has=false
id=8  t=3830(offAt=3835): viewer_snapshot_has=true
id=8  t=3835(offAt=3835): viewer_snapshot_has=true    ← ✅
id=8  t=3840(offAt=3835): viewer_snapshot_has=false   ← ✅
id=8  t=4035(offAt=3835): viewer_snapshot_has=false
```

`viewer_snapshot.players`（`observation.js:76`，走 `game.players`）与 `audit_input.players`
**对同一球员结论一致**（都不再出现幽灵）——第 3 轮 P2-3 / NIT-1 的「两个视图结论相反」已消除。

### 1.2 内部三处均已改用 `_players` ✅

`grep -n "_players" viewer/game.js` 确认三处内部使用点全部是 `_players`：

| 使用点 | 行 | 状态 |
|---|---|---|
| `_prevPlayerPos` 初始化 | 63 | ✅ `for (const p of this._players)` |
| `_logFrame` | 267 | ✅ `for (const p of this._players)` |
| `_updateFromTimeline` | 362 | ✅ `for (const p of this._players)` |

即 `p.x/p.y` 对罚下球员仍每帧插值维护（内部一致），只是不对外渲染——符合注释所述。

### 1.3 有无遗漏的 `this.players` 使用点导致 bug？✅ 无

`grep -rn "\.players\b" viewer/ tools/`（排除 node_modules）逐一核对**全部**外部使用点：

| 位置 | 用法 | 判读 |
|---|---|---|
| `app.js:185`（micro-motion 移动集合）| `for (const p of game.players)` | ✅ 应排除幽灵（不为其算微动）|
| `app.js:193/233`（`renderFrame`）| `game.players` | ✅ 渲染不应画幽灵 |
| `observation.js:76`（`viewer_snapshot`）| `(game.players ?? []).map` | ✅ 不应带幽灵 |
| `visual-probe.js:68/107` | `game.players` | ✅ 调试图，同渲染口径 |
| `e2e-v2.mjs:89/133`（no-snap 检测）| `game.players` | ✅ 见 §五 INFO-2（罚下移除对该检查是良性的）|
| `spacing-sweep`（经 `captureObservation`）| 间接 | ✅ |

**关键结构检查**：全仓**没有**任何 `game.players = ...` 赋值
（`grep -rn "\.players\s*="` 零命中）→ getter **不会被实例属性遮蔽**。
另查 `Object.assign(game`/`...game`/`JSON.stringify(game)` 全仓零命中 → 无 setter 陷阱风险。

### 1.4 性能可接受 ✅

常见路径（无红牌，`sentOffAt.size === 0`）**直接返回 `_players` 引用，零分配**。
有红牌时每次调用一次 22 元素 `filter`。调用方 `app.js` 每动画帧约调 3 次 → 至多
~66 次元素比较/帧。**可忽略**。

### 1.5 `game.test.js` 新测试有牙 ✅（含一处**原本无牙**的边界，后续提交已补）

新增测试 `sent-off player is excluded from the rendered players list (no ghost)`。
我对 getter 做三处变异（每次改完还原）：

| # | 变异 | `ad88ce0` 结果 | 最终 HEAD 结果 |
|---|---|---|---|
| M1 | `t <= offAt` → `false`（恒隐藏）| 🔴 RED（#33 fail）| 🔴 RED |
| M2 | `t <= offAt` → `true`（恒显示）| 🔴 RED（#33 fail）| 🔴 RED |
| M3 | `t <= offAt` → `t < offAt`（**闭→开边界**）| 🟢 **GREEN**（无牙，见下）| 🔴 **RED** |

> **M3 是本次审阅新发现的 NIT**：`ad88ce0` 的测试只断言 `t=6`（红牌前）与 `t=20`（红牌后），
> **没有钉 `t == offAt` 当刻**，故把闭边界改成开边界测试**不变红**。
> 实现者已在 `c1b437c` 补了 `g2.seekTo(10); assert(g2.players.some(id===15))`
> （「红牌当刻仍可见」），我复核该变异**此时变红**（§四-NIT-3）。

### 1.6 既有测试未破坏 ✅

```
cd viewer && node --test *.test.js
# tests 305  # pass 305  # fail 0
```

（305 = 第 3 轮 304 + 本次新增 1 条）。

---

## 二、`verify.sh` 第 5 步（整场滑窗门）

### 2.1 六步全绿 ✅

`bash verify.sh`（实跑，退出码 0）：

| 步 | 结果 |
|---|---|
| 1/6 Rust `cargo test` | ✅ 通过（`tail -15` 只截到 integration 段；另单独 `cargo test --lib` → **129 passed / 0 failed**，含 `p53_same_team_spacing_ge_2m`、`p53_same_team_spacing_holds_between_anchors` 双绿）|
| 2/6 Viewer | ✅ **305 passed / 0 failed** |
| 3/6 Tools | ✅ **404 passed / 0 failed** |
| 4/6 WASM e2e | ✅ `无 snap(4 seed: 球 0.0072, 球员 0.0074)` |
| 5/6 滑窗门 | ✅ 默认集 6 seed × 2157 窗 **全零**，`OK: no player_overlap findings` |
| 6/6 realism L1 | ✅ **9 passed / 0 failed** |

### 2.2 `viewer/engine.wasm` 缺失时不会硬失败 ✅（且该分支在完整跑中不可达）

- 第 4 步（`verify.sh:32-35`）已有 `if [ ! -f viewer/engine.wasm ]; then … exit 1; fi` ——
  **wasm 缺失时整脚本在第 4 步就退出**，故第 5 步的「跳过」分支（`verify.sh:41-46`）
  在完整跑中**结构上不可达**，只是防御性写法。
- **errexit 语义验证**：我构造最小复现确认 `set -e; set -o pipefail` 下，
  `if …; then exit 1; else <非零命令>; fi` 的 **else 分支内非零退出会传播**（外层退出码 1）。
  即 `node tools/spacing-sweep.mjs` 一旦出现 finding，**第 5 步是真正的门**，不是空跑。

---

## 三、`SWEPT_LIGHT_SHARE` 注释（第 3 轮 P1-1 硬伤）

**这次真的改了** ✅（第 3 轮指出上轮「声称改了但一字未动」）。

| 命令 | 结果 |
|---|---|
| `git log -S "保守取向" --oneline -- engine/src/lib.rs` | 命中 **`ad88ce0`**（本 commit）|
| `grep -c "对半）破 L3" engine/src/lib.rs` | **0**（旧断言已消失）|
| `git show ad88ce0 -- engine/src/lib.rs` 净增删 | **仅 `///` 注释行**，无一行代码改动 |

新注释（`lib.rs:632-638`）改为实测口径：0.0/0.12/0.5 在 Rust 门 / 真实滑窗 / L3 上无差异，
0.12 是**保守取向**而非承重常量。与第 3 轮审阅实测（0.770/0.775/0.773，带 [0.72,0.92]）一致。

> **INFO-1（非缺陷）**：`viewer/engine.wasm` 时间戳（03:56:45）**早于** `lib.rs`（04:00:54）。
> 因本次 lib.rs 改动**纯注释**，编译产物无差异 → wasm 陈旧**无害**。但需注意
> `verify.sh` 第 4/5 步跑的是**未从 HEAD 源码重建**的二进制；本 change 下可接受。

---

## 四、文档 / 门槛一致性（含后续提交的并发修复）

### 4.1 `tools/spacing-sweep.mjs` 默认 seed 集 ✅

- `ad88ce0` 版：代码 `[42, 1, 2, 3, 7, 59]`，注释「`59` 是默认集中**唯一**含红牌」。**一致**。
- 「11 含红牌」错误声明已删（`grep 11` 在该文件零命中）。

**独立复核（我亲手跑 wasm）**：

```
seed 42/1/2/3/7/11: reds=0
seed 59: reds=2  [15@78, 8@3835]   ← 与注释逐字一致
seed 18: reds=1  [12@5347]
seed 94: reds=1  [7@1064]
```

`5bb7b9a` 把默认集扩为 `[42, 1, 2, 3, 7, 59, 18, 94]`，注释新增断言
「1..200 内共 12 个含红牌 seed：18 33 59 78 85 94 95 113 121 145 186 190」。
**我扫 seed 1–200 复核：count=12，seed 列表与注释逐字一致** ✅。

我另跑**新默认集全量** `node tools/spacing-sweep.mjs`（8 seed × 2157 窗）→ 8 seed 全零，**退出码 0** ✅。

### 4.2 `git status` 干净 + `openspec validate` 14/14 ✅

```
git status --porcelain        # 空
npx openspec validate --all --strict
# Totals: 14 passed, 0 failed (14 items)
```

### 4.3 缓存版本号 ✅

`viewer/index.html:498`：`app.js?v=20260913-1` → **`20260916-1`**（改了 viewer JS，符合
CLAUDE.md 强制要求）。

---

## 五、新缺陷清单（审阅中发现；分级）

### 🟠 P2-1（**已在 `c1b437c` 修复**）：`real-gate.md:14` 用法注释仍是旧默认 seed 集

`ad88ce0` 只改了 `real-gate.md:35` 的表格行，`:14` 的 bash 注释仍写
`# 默认 seed 42 1 2 3 7（各 2157 窗）`（缺 `59`）。→ `c1b437c` 补为 `42 1 2 3 7 59`，
`5bb7b9a` 再补为 `42 1 2 3 7 59 18 94`。**已复核现状与代码一致** ✅。

### 🟠 P2-2（**已在 `5bb7b9a` 修复**）：`real-gate.md` 的 `SWEPT_LIGHT_SHARE` 段落与 `lib.rs` 新注释**互相矛盾**

`ad88ce0` 改了 `lib.rs` 的注释但**没动** `real-gate.md:47-49` 的旧断言
「对半分摊会把禁区占比 0.758→0.693、破 L3……完全豁免又会让中点越界残留」——这正是
第 3 轮判定「复现不出」的断言。→ `5bb7b9a` 更正为实测口径并标注「原文断言已更正」。**已复核** ✅。

> 记录同一模式的**历史重复**：第 3 轮 P1-1 是「commit message 声称改了但正文没改」，
> 本轮 P2-2 是「改了 A 处注释但 B 处文档没同步」。两轮都是**同一文档-代码一致性**问题。

### ✅ P2-3（**已独立复核，撤销**）：`real-gate.md:35` 的「fresh seed 批」可复现

`5bb7b9a` 把含糊的「12 个 fresh seed」改为具体批次
`5 17 29 41 53 67 71 83 97 101 127 149` 并断言**全零**。该批 12 个 seed 均为**非红牌**
seed（与 4.1 的红牌 seed 集不相交），不与默认集重叠。

**我独立完整复跑该批**：

```
seed 5 17 29 41 53 67 71 83 97 101 127 149: 各 2157 windows, player_overlap findings=0
OK: no player_overlap findings over the swept windows   EXIT=0
```

12/12 全零 → 该文档断言**成立**，P2-3 撤销（判为**无缺陷**）。

### ⚪ NIT-3（**已在 `c1b437c` 修复**）：幽灵测试未钉 `t == offAt` 边界

见 §1.5-M3。`ad88ce0` 下闭→开边界变异不变红。→ `c1b437c` 补断言后**变红**。**已复核** ✅。

### ⚪ NIT-4（**已在 `c1b437c` 修复**）：`review-response.md:96` 的「含红牌的 11」错误声明

原文称默认集 `… 59 11`（含 R2 命中的 59 与**含红牌的 11**）——seed 11 实测零红牌
（§4.1）。→ `c1b437c` 就地更正并保留「第 3 轮更正注」。**已复核** ✅。

### ⚪ NIT-5（**已在 `8d836b0` 修复**）：`real-gate.md` 引用不存在的 `fix-round-1.md`

`real-gate.md` 末段原写「（见 `fix-round-1.md`）」——该文件在全仓**不存在**
（`find . -name "fix-round*"` 零命中），是 `1d8eae8` 引入的**既有**悬空引用。
→ `8d836b0` 改为指向实际存在的 `review-response.md`。**已复核** ✅。

### ⚪ NIT-6（**部分修复；新增一处不可复现断言**）：`real-gate.md` 的「真实采集窗口」口径

`ad88ce0` 版此行写「真实采集窗口（7 窗 × 6 seed）」，未列 seed。`8d836b0` 把它改为
「每 seed 的 6 个真实重开窗口 + 死球窗口；**seed 42 1 2 3 4 5**」。

**问题**：该 seed 列表在仓库内**无任何可复现来源**——`tools/fixtures/generate-real-audit-fixture.mjs`
的 `SEED = 42` 是**硬编码单 seed**，产物 fixture 也只有 seed 42 的 7 个窗口
（`match_time = 244,250,441,1565,2340,3167,5400`）。该「6 seed」口径的唯一出处是
`review-paseo.md:116` 提到的**一次性临时脚本 `/tmp/realgate.mjs`**（已不存在）。
即：`8d836b0` 把一个无可复现来源的笼统数字，改成了一个**同样无可复现来源的具体断言**。

**判读**：这是**文档断言**问题，非代码缺陷，且我可以**证伪不了**（无法排除实现者当时确实
跑过那 6 个 seed）。影响面小：该行是**补充性手工检查**，不是门禁——真正的门
（`spacing-sweep` 整场滑窗）已进 `verify.sh` 且我已独立复跑全绿。
**建议**：要么补一个可复现的脚本/命令（如给 fixture generator 加 seed 参数，或写明
用哪条命令采集 6 seed 的窗口），要么退回笼统表述并标注「一次性手工检查，无入库脚本」。

---

## 六、三个必答问题（任务 §1–§6）

1. **新 viewer 改动是否正确、有无回归？** —— ✅ **正确，无回归**。
   时刻语义与 audit 口径一致（端到端实测：红牌当刻可见、之后隐藏）；内部三处已全用
   `_players`；全仓无其他 `this.players` 误用、无赋值遮蔽；性能零分配常见路径；
   305/305 全绿；两处恒真/恒假变异均变红。
2. **`verify.sh` 第 5 步是否真门、wasm 缺失是否硬失败？** —— ✅ 第 5 步是**真门**
   （else 分支非零退出会传播，已最小复现验证）；wasm 缺失时**第 4 步即 `exit 1`**，
   第 5 步的跳过分支**不可达**，不会静默放行。
3. **`SWEPT_LIGHT_SHARE` 注释这次真的改了吗？** —— ✅ **真改了**。
   `git log -S "保守取向"` 命中 `ad88ce0`；旧断言文本在 worktree 中计数为 0；
   改动纯注释、无代码行。

---

## 七、审阅期间工作区洁净性

- **本审阅者未改任何源文件**。全部变异（M1/M2/M3 于 `viewer/game.js`）均已用备份还原；
  `git diff --stat -- viewer/game.js engine/src/lib.rs` = **空**。
- 审阅期间 `git status` 曾出现 `M real-gate.md` / `M tools/spacing-sweep.mjs` /
  `M review-response.md` / `M game.test.js` / `M review-round4.md` —— 全部是**实现者的并发
  提交**（`c1b437c`、`5bb7b9a`、`8d836b0`）所致，**非本审阅者所为**（`review-round4.md`
  是本报告本体，由实现者在 `8d836b0` 中一并入库）。
- **最终 HEAD `8d836b0`**；工作区仅 `M review-round4.md`（本报告在提交后仍有编辑），
  无任何被审阅源文件的未提交改动 ✅。

### 滑窗复跑（本审阅者亲手跑，全部退出码 0）

- 默认 8-seed 集（`42 1 2 3 7 59 18 94`）→ **8/8 全零**；
- `real-gate.md:35` 的 12-seed fresh 批（`5 17 29 41 53 67 71 83 97 101 127 149`）
  → **12/12 全零**；
- 单独 `18 94` → 全零。
三组共同独立复核了 `real-gate.md` 表格中的「默认集」与「fresh 批」两项断言。

---

## 总评

`ad88ce0` 点名的三项修复**全部落实且正确**，是本 change 三次「声称已修」争议后的
**真正收口**（注释这次改到了、幽灵渲染排除用 getter + 全量 `_players` 双轨实现得干净、
滑窗门接进了 `verify.sh`）。审阅中新发现的边界测试牙缺口与两处文档-代码不一致，
实现者在 `c1b437c`/`5bb7b9a` 中**全部修复**，我已逐条独立复核。**无 P0、无 P1。**
遗留仅 NIT-5（悬空 `fix-round-1.md` 引用）等文档细节，不阻断。
