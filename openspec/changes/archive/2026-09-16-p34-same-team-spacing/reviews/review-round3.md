# P34 独立零记忆审阅（第 3 轮 / review-round3）

审阅对象：**HEAD `e989c02`**（分支 `p34-same-team-spacing/2026-09-15`），工作区
`/home/happy/.paseo/worktrees/1g1x3st4/p34-same-team-spacing-2026-09-15`。
审阅者无任何前序上下文；以下每个数字均为本轮亲手跑出。审阅期间未改 `engine/src/` 与
`viewer/`（全部变异已还原，`git status` 见文末）。

> **审阅期间 HEAD 移动过**：开始时是 `f79831d`，03:16:26 落了 `e989c02`（实现者在本
> worktree 并发提交）。本报告以 `e989c02` 为准。工作区另有一处**未提交**改动
> （`tools/spacing-sweep.mjs`，见 P2-1），是实现者的在途修复，非本审阅者所为。

---

## 结论：**通过**（P0 无；P1 ×2、P2 ×3、NIT ×2）

**第 2 轮 P0 已真正修好**，且不是一个「看起来像修好」的空修法——我用**因果反证**证明了它：
把幽灵排除关掉，seed 59 立刻复现出与第 2 轮报告**逐字一致**的 18 findings / worst 0.870m；
打开则归零。**viewer 改动未引入回归**（304/304 全绿，且新测试对两处改动都有牙）。
**抢断推队友是承重的**（400 seed 埋点：进入分支 96 次、真正推动 96 次；删掉它中点门立刻
变红，报错数字与实现者所述完全吻合）。第 2 轮审阅者「恒不触发」的测量**是错的**。

没有阻断项。以下是必须收口的 P1/P2（都是**文档/门覆盖**问题，不是引擎或 viewer 的正确性
问题）。其中 **P1-1 是硬伤**：修复回应声称改过的注释，实际**一个字符都没动**。

---

## 一、必查项逐一核对（命令 + 数字）

### 1. 整场滑窗门 —— 默认集 + 自选 seed **全零**；且因果成立

| 命令 | 结果 |
|---|---|
| `node tools/spacing-sweep.mjs`（默认 `42 1 2 3 7 59 11`）| ✅ **全零**，7 seed × 2157 窗，退出码 0 |
| `node tools/spacing-sweep.mjs 13 21 88 456 1001`（5 个前两轮未跑过的 seed）| ✅ 全零，退出码 0 |
| `node tools/spacing-sweep.mjs 18 33 78 85 94 95 113 121 145`（9 个**含红牌**的 seed）| ✅ 全零，退出码 0 |

> 我另写脚本扫 seed 1–160，只有 `18 33 59 78 85 94 95 113 121 145` 含红牌。上表第 3 行把
> **除 59 外的全部 9 个含红牌 seed** 都跑了——幽灵路径（红牌后队友擦过静止锚点）被真正覆盖，
> 全部归零。这是第 2 轮 P0 最直接的独立复核。

**因果反证（本轮最关键的一步）**：把 `derive-audit-features.js:421` 的
`sentOff = sentOffTimes(allEvents ?? events)` 改成 `sentOff = new Map()`（即关掉幽灵排除，
其余不动），重跑：

```
node tools/spacing-sweep.mjs 59
→ seed 59: 2157 windows, player_overlap findings=18 worst=0.870m   （退出码 1）
```

与第 2 轮审阅报告的 **18 findings / worst 0.870m 逐字一致**。恢复后归零。**修复因果成立**。

### 2. 引擎侧确实不再发射罚下球员（修法前提本身）

我写脚本直接读 wasm 事件流，统计每名红牌球员**罚下时刻之后**是否仍出现在
`players` / `movers` / `main.subject` / `subject` / `carrier` / `from` / `to` 任一字段：

```
seed 59: reds=id15@78.0, id8@3835.0   post-sendoff-emissions=0
seed 11/1/2/3/7/42: post-sendoff-emissions=0
```

引擎侧 0 次残留发射——「罚下幽灵」**确实是 viewer 侧的**，实现者的归因正确。

### 3. `observation.js` 传的 `game.events` 是不是整场？（关键点）

✅ **是整场**。读代码 + 行为双重确认：

- `viewer/game.js:17` `this.events = events;`（构造函数原样保存引擎整场事件流，
  无裁剪）；`this.lineup` / `this.timeline` 同理。窗口裁剪只发生在
  `observation.js:55` 的 `collectWindowEvents`，产物写到 `bundle.events`。
- `observation.js:238` `allEvents: game?.events ?? bundle?.events ?? []` 取的正是整场。
- **行为验证**：把 `allEvents` 改回窗口版（`bundle?.events`）→ 新回归测试第 16 条**变红**
  （见下方变异表 MUT-C）。即该测试钉住的正是「必须传整场」这件事。

### 4. `sentOffTimes` 的二黄升级逻辑 —— 实现者的简化**正确**，旧黄牌分支确为死代码

读 `engine/src/lib.rs:5397 apply_card`：`card == Some("red")` 直接罚下；否则若
`has_yellow` 已置位 → `return Some("red")`（注释「二黄变红：罚下，事件按红牌展示」）；
否则记黄返 `"yellow"`。**即引擎对外只发 `card:"yellow"` / `card:"red"` 两种，二黄升级也
发 `red`。**

直接单测（临时插入，已删）：
```
apply_card: first=Some("yellow") second=Some("red")  third=Some("red")  sent_off7=true
```
所以 `card:"red"` 是罚下的**唯一**对外信号，`e989c02` 删掉不可达的黄牌跟踪分支是
**正确的简化**，不是漏修。补充观察：我扫的 10 个含红牌 seed 里**没有一个是二黄升级**
（全是直红或单黄+直红），该跨拍路径当前**无集成覆盖**——但引擎侧逻辑本身已被上式证明。

### 5. 全量门槛（本轮实跑）

| 门槛 | 结果 |
|---|---|
| `cd engine && cargo test`（lib）| ✅ **129 passed, 0 failed** |
| `cargo test`（realism：gm_canary / l2 / l3 / l1）| ✅ 4 passed / 9 ignored；L1 套件 9 passed |
| `bash verify.sh`（五步）| ✅ **全绿，退出码 0**（含 wasm e2e「无 snap」、realism L1）|
| `cd viewer && node --test *.test.js` | ✅ **304 passed, 0 failed** |
| `cd tools && node --test *.test.mjs` | ✅ **404 passed, 0 failed** |
| `npx openspec validate --all --strict` | ✅ **14 passed, 0 failed** |
| `git status` | 仅 `M tools/spacing-sweep.mjs`（非本审阅者所为，见文首）|

---

## 二、变异测试表（变异 → 是否变红）

| # | 变异 | 目标门 | 结果 | 判读 |
|---|---|---|---|---|
| MUT-A | 删除 `lib.rs:3444-3461` 抢断推队友循环（`let pushed = Vec::new()`）| `p53_..._holds_between_anchors` | 🔴 **RED**：`seed=1 t=3769 id=7/10 d=1.606482m` | 该路径**承重**，且被中点门守护 |
| MUT-A' | 同上 | `p53_same_team_spacing_ge_2m`（端点门）| 🟢 GREEN | 它只影响**拍内中点**，端点门结构上看不见——与门的分工一致 |
| MUT-B | `derive-audit-features.js:336` 幽灵跳过 `if (offAt…) continue;` 置 `false &&` | `derived-audit.test.js` #16 | 🔴 **RED** | 新测试有牙 |
| MUT-C | `observation.js:238` `allEvents` 改回 `bundle?.events`（窗口版）| `derived-audit.test.js` #16 | 🔴 **RED** | 测试同时钉住「传整场」这件事 |
| MUT-D | `sentOff = new Map()`（关掉幽灵排除，端到端）| `spacing-sweep.mjs 59` | 🔴 **RED**：18 findings / 0.870m | **因果反证**（第 2 轮 P0 的直接复现）|
| MUT-E | `SWEPT_LIGHT_SHARE` 0.12 → **0.0** | `cargo test --lib p53_` 全部 10 条 | 🟢 **GREEN** | ⚠️ 无牙（见 P1-1）|
| MUT-E' | `SWEPT_LIGHT_SHARE` 0.12 → **0.0** | `spacing-sweep.mjs 42 59` | 🟢 **GREEN**（全零）| ⚠️ 实采管线也无牙 |
| MUT-F | `SWEPT_LIGHT_SHARE` 0.12 → **0.5** | `l3_home_away_goal_calibration` | 🟢 **GREEN**，禁区内进球占比 **0.773**（带 [0.72,0.92] 内）| ⚠️ 注释所称「0.5 破 L3」**复现不出** |
| MUT-G | 抢断推队友埋点计数（400 seed）| — | ENTER=**96** / FIRE=**96** | 反驳 R2「恒不触发」|

**两处「无牙」是结论性的**：`SWEPT_LIGHT_SHARE` 取 0.0 / 0.12 / 0.5，Rust 门、实采滑窗、
L3 三项**全部通过**。它当前是一个**不可被任何门区分的调参**。（我复算的 0.773 与第 2 轮
审阅者测得的 0.773 **一致**——两次独立复算都指向「0.5 不破 L3」。）

---

## 三、新缺陷 / 盲区清单

### 🔴 P1-1（硬伤）：修复回应声称改过的 `SWEPT_LIGHT_SHARE` 注释，**实际一个字符都没改**

`reviews/review-response.md:102` 写给第 2 轮的回应：

> 「已把注释改为实测口径：0.12 是**保守取向**（偏向「carrier 少动」），不是一个被门钉死的
> 承重常量。」

但 `engine/src/lib.rs:631-633` 至今仍是被 R2 `:135` 逐字引用的原文：

```rust
/// carrier（或其它需保护几何的球员）在拍内侧推中的**分摊比例**：只承担这一小份，队友
/// 吸收其余。0.12 实测调参——0（完全豁免）会让对穿的中点越界残留，0.5（对半）破 L3。
const SWEPT_LIGHT_SHARE: f64 = 0.12;
```

git 证据：`git log -S "0.5（对半）破 L3" -- engine/src/lib.rs` 只命中**引入它的**
`1d8eae8`；`git show f79831d -- engine/src/lib.rs` **没有任何**触及该注释的 hunk
（`f79831d` 的 commit message 里提到「澄清 `SWEPT_LIGHT_SHARE` 注释」，但**正文没落地**）。
即：**commit message 与 review-response 双双声明已修，代码未修。**

而该注释的两个断言，我 MUT-E/E'/F 三个变异**全部复现不出**（见上表）。所以这是一条
**仍然误导的注释**：它让读者以为 0.12 被两个真实失败模式钉死，实际它对 L3 与滑窗都无影响。

**建议**：要么把注释改成实测口径（0.12 是保守取向、当前无门区分 0.0/0.12/0.5），要么补一条
能区分三取值的专测。**至少**，`review-response.md` 与 commit message 的「已改注释」须更正为
「未改」或补上真正的改动——否则文档与代码不一致，后续审阅会被误导。

### 🟠 P1-2：`real-gate.md` 的 seed 集已过期（第 2 轮 NIT-1 只做了一半）

`reviews/real-gate.md:14` `默认 seed 42 1 2 3 7（各 2157 窗）`、`:35`
`整场滑窗（每 seed 2157 窗 × 5 seed）| 全零` —— 这是**修复前**的默认集。当前默认集已含
`59`（且工作区在途版把 `11` 去掉了，见 P2-1）。第 2 轮 NIT-1 要求「表格里显式列出 seed 集」，
该表确实列了，但列的是**旧集合**，反而更容易让人以为已经覆盖 59。**建议**：同步为当前默认集
并注明「含红牌 seed 59」。

### 🟠 P2-1：`11` 被当作「含红牌的常态覆盖」，但 seed 11 **零红牌**

`tools/spacing-sweep.mjs:47`（HEAD 版）与 `f79831d` 的 commit message 都写：

> 「再加**含红牌的 `11`** 作常态覆盖。」

实测：seed 11 **reds=0**（连黄牌也是 0）。我扫 1–160，含红牌的只有
`18 33 59 78 85 94 95 113 121 145`。**「11 含红牌」是错的**——默认集里含红牌的其实
**只有 `59` 一个**。

> 实现者已在工作区（未提交）自行修正：注释改为「`59` 是默认集中**唯一**含红牌的 seed」，
> 默认集改为 `[42, 1, 2, 3, 7, 59]`。方向正确。**建议**：既然幽灵路径是本次 P0 的根因，
> 默认集应**多放 2–3 个含红牌 seed**（如 `18 33 94 113`），而不是只剩 1 个——单点覆盖下，
> 一旦 seed 59 因 RNG 流变化不再出红牌，整条幽灵路径将**无声失去覆盖**。

### 🟠 P2-2：`spacing-sweep.mjs` 未接入任何自动门

`grep -rn "spacing-sweep"` 全仓只命中它自己的注释——`verify.sh`（五步）与
`viewer`/`tools` 测试集**都没有**跑它。而它是**唯一**能抓到本轮 P0 那类缺陷的门
（两道 Rust 门结构上看不见幽灵）。当前「整场滑窗全零」这一验收结论，完全依赖**一个人记得
手动跑**。第 2 轮 P0-1 修法 3 建议接入 `verify.sh`，**未采纳**。**建议**：至少把它作为
`verify.sh` 的可选第 6 步（或注明「手动门，发布前必跑」并写进 tasks 的收尾清单），并考虑
用 1–2 个 seed 的快速版（约 2–3 分钟）接进 CI。

### 🟡 P2-3：viewer **仍然渲染**罚下幽灵（本次只修了 audit 采样）

修法是「让 audit 不采样幽灵」，`game.players` 与 renderer **没动**：`game.js:336-341`
仍用最后锚点插值该球员，`app.js:187` 仍把它画在场上；`viewer_snapshot.players`
（`observation.js:76`，走 `game.players`）也仍带幽灵。commit message 自己写明「renderer 照画」
——即这是**已知未修**。对 #53（引擎侧间距）而言，audit 干净即达标，故不算 P0；但用户会在
画面上看到一个红牌球员**永远杵在原地**，且抓取的 bundle 里 `viewer_snapshot` 与
`audit_input` 对同一球员**结论相反**。**建议**：记入 design 的「已知边界」，或后续 change
把罚下球员从 `game.players` 移除（真正的幽灵根治）。

### ⚪ NIT-1：`viewer_snapshot.players` 保留幽灵（P2-3 的具体面）

同上，`observation.js:76`。人工看 bundle 时容易被误导。

### ⚪ NIT-2：`separate_target_points` 多点分支仍不可达（**已按第 2 轮建议注明**）

`lib.rs:4579` 的 `n>1` 分支唯一入口 `separate_target_point`（`lib.rs:4561`）恒传单元素切片。
第 2 轮 P2-1 要求「明确保留并加注释说明为哪条未来路径预留」——`f79831d` **已补**（`:4575-4578`
写明「当前调用形态…多点分支是为…预留」）。✅ 该项**已收口**，此处仅登记。

---

## 四、三个必答问题

1. **第 2 轮 P0 是否真的修好？** —— ✅ **是，且因果成立**。默认集 + 5 个自选新 seed +
   **全部 9 个含红牌的 seed** 滑窗全零；关掉幽灵排除则 seed 59 逐字复现 18 findings / 0.870m。
   引擎侧实测罚下后 0 次残留发射，坐实根因在 viewer。

2. **viewer 改动是否引入回归？** —— ✅ **否**。`viewer 304/304`、`tools 404/404`、
   `verify.sh` 五步全绿；新测试对「跳过采样」与「传整场 allEvents」**两处**改动都有牙
   （MUT-B/MUT-C 双红）。`sentOffTimes` 只认 `card:"red"` 的简化经 `apply_card` 单测证实正确。

3. **抢断推队友到底是不是承重的？** —— ✅ **是承重的；第 2 轮审阅者错了，实现者对了。**
   400 seed 埋点：进入分支 96 次、**真正推动 96 次**；删除该循环 →
   `p53_..._holds_between_anchors` 变红（`seed=1 t=3769 id=7/10 d=1.606482m`，与实现者所述
   完全一致）。它只被**拍内中点门**守护、端点门看不见（MUT-A vs MUT-A'），这正解释了为什么
   第 2 轮「端点层埋点」会测出零推动——**测错了门**。

---

## 五、工作区洁净性

- `engine/src/lib.rs`、`viewer/derive-audit-features.js`、`viewer/observation.js`：
  变异全部还原，`diff` 与备份一致（MUT-A/A'/B/C/D/E/E'/F 与两处埋点均已撤销）。
- `viewer/engine.wasm`：用 `SWEPT_LIGHT_SHARE` 变异体重建过，已用**基线源码**重新构建并覆盖
  （`cargo build --target wasm32-unknown-unknown --release` + `cp`），复跑 `sweep 42 59` 归零。
- `git status`：仅 `M tools/spacing-sweep.mjs`——是**实现者**在审阅期间的在途修复（把 `11` 从
  默认集去掉），**非本审阅者所为**。本审阅者未对该文件做任何改动。
