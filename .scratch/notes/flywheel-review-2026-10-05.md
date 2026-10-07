# 飞轮修复 · 独立审阅（2026-10-05）

审阅对象：本轮新增/修改的视觉飞轮工具与测试
（`tools/visual-review/like-football.mjs` + `.test.mjs`、`contact-sheet.mjs` + `.test.mjs`、
`motion-metrics.mjs`、`.claude/skills/visual-review/SKILL.md`、`.scratch/notes/flywheel-diagnosis-2026-10-05.md`）。

⚠️ 审阅期间主 session 把 `like-football` 的真实结构锚从「Metrica 整场均值」换成
**committed 基线 `benchmark-baseline.json` 的 `datasets.skillcorner`**、引擎侧改用同口径
`cutWindows(300s)→windowMetrics.primary→跨窗均值` + `BENCHMARK_SEEDS=[42,1,7,99,123]`。
**本报告一律以当前磁盘版本为准**；最初 prompt 里的旧数字（0.623/0.579/2.94×/7.9m）作废。

审阅环境：`node v*`（`node --test`），本地有 `viewer/engine.wasm`(c8e77188=main)、
`/tmp/landed.wasm`(e41583d9=FB4)、`viewer/data/real-game-1/2.json`、
`viewer/data/benchmark-baseline.json`。**只读**，唯一写操作是本文件。

---

## 0. 主张 C（flag 口径）先说：**成立**

`motion-metrics.mjs` 的静止阈值确为「窗内位移 <0.5m」（`motion-metrics.mjs:44`）。
真实位移 13.46m → 0.5/13.46 = **1/26.9 ≈ 1/27** ✓。
FB4 位移 **3.60m（真实 13.46m 的 27.5%）** 在此阈值下静止占比 = **0.00%**（实跑，见下）✓
——「数字说在跑、眼睛说没动」的机制成立。

---

## 1. 跑测试 —— **20 passed / 0 failed**（主张 1 成立）

```
$ node --test tools/visual-review/*.test.mjs
# tests 20   # pass 20   # fail 0   # duration_ms 833
```

---

## 2. 数核（新锚，主张 B/D 的更新版）—— **数字全部复现**

```
$ node tools/visual-review/like-football.mjs viewer/engine.wasm 5 12
距离 = 0.853  disp 1.77 vs 13.46 = 0.13×   gap 23.16 vs 5.24 = 4.42×
hd 40.05/18.31 = 2.19×  ad 40.37/18.45  spread 18.76/12.76  width 40.83/35.96  ballDist 21.82/14.97
worst = disp  dir 0.63 vs 0.70    静止 50% vs 0%
$ node tools/visual-review/like-football.mjs /tmp/landed.wasm 5 12
距离 = 0.808  disp 3.60 vs 13.46 = 0.27×   gap 25.33 vs 5.24 = 4.84×（worst）
hd 42.90/18.31 = 2.34×  dir 0.66 vs 0.70   静止 0% vs 0%
```

- **main 引擎结构量逐位复现基线 `engine.perMetric`**：hd 40.05(=40.0519)、ad 40.37(=40.3733)、
  spread 18.76(=18.7629)、gap 23.16(=23.1647)、width 40.83(=40.8299)、ballDist 21.82(=21.8235) ✓
  —— 这是工具口径**自证**，是本轮最扎实的一环，**同意**主 session 的这个说法。
- 真实结构锚 gap = **5.2357**（基线 skillcorner，n=139）✓；非主锚 metrica gap=8.32 ✓
- FB4 = **0.808（−5.3%）**；FB4 把 worst 从 **disp 换成 gap** ✓（disp 1.32 < gap 1.58）
- 距离自洽核：main 6.0/7=0.853 ✓；FB4 5.67/7=0.810≈0.808 ✓

**主张 D 成立**（用新数）：FB4 距离仅降 5%，分边**恶化**（4.42→4.84×）、纵深也恶化 →
「此消彼长、净效果≈零」量化了「用户看不出」。

---

## 3. 逐条主张判定

| 主张 | 判定 | 依据 |
|---|---|---|
| **A** 无损失函数 → loop 优化了 main 已过关的 `dir` | **成立** | `motion-metrics.mjs` 只并排报 median（无标量）；实跑 main dir 0.63≈真实 0.67/0.70（差 ≤0.07），无优化信号 ✓ |
| **B** `gap` 是最大缺口且不在视野里 | **部分成立** | ① `gap` 确不在 motion-metrics、也不在 L1 带（l1-metrics 键无任何重心间距量）✓；② 但 **`gap` 不是最大 |ln| 缺口——`disp`(2.03) > `gap`(1.49)**，gap 是第二。诊断文档已改口「最大缺口**之一**」，**但工具头注释仍写死「全场最大缺口」（错）** |
| **C** 阈值与眼睛脱钩（0.5m = 真实的 1/27） | **成立** | 见 §0 |
| **D** FB4 距离只降 5%、分边反而恶化 | **成立** | 见 §2 |
| **E** 新工具的守护测试**不是空转** | **部分不成立** | 3 个指定变异**确实变红**（见 §4），但**另有空转断言 + 盲区**（见 §5）：删掉整条 REAL 行，contact-sheet 4 条测试**全绿** |

---

## 4. 变异矩阵（对当前版本；所有变异后已还原）

> ⚠️ 关键操作事实：`like-football.mjs` / `contact-sheet.mjs` 及两个 `.test.mjs` 在 git 里是
> **untracked（`??`）**——**`git checkout --` 还原不了它们**。我先 `cp` 到 `/tmp/lf-backup/`，
> 变异后 `cp` 回来，并逐文件 `sha256sum` 对拍确认 pristine（见 §7）。

| # | 文件 | 改了哪行 | 跑哪条测试 | 结果 | 红的断言 |
|---|---|---|---|---|---|
| **M1**（指定①） | like-football.mjs | `LOSS_METRICS` 删 `{key:'gap'...}` 行(46) | like-football.test.mjs | **RED ×3** | test2「ln4/7」、test4「飞轮守卫」、test5「gap 必须在表里」 |
| **M2**（指定②） | like-football.mjs | `:115` `\|ln(ratio)\|` → `\|ratio−1\|` | like-football.test.mjs | **RED ×3** | test2、test3「\|ln\| 对称」、test4 |
| **M3**（指定③） | contact-sheet.mjs | `:40` `t0s` → `t0s.slice(0,1)` | contact-sheet.test.mjs | **RED ×1** | test2「每一窗都真的画了」（test1 布局**仍绿**——正是作者注释预言的） |
| **M3b** | contact-sheet.mjs | `:40` `t0s` → `t0s.slice(0,2)` | contact-sheet.test.mjs | **RED ×1** | test2（2/3 窗也抓得到） |
| **M4**（自选） | contact-sheet.mjs | `:41` 循环里**删掉 `['R', realFrames, 'REAL']`** | contact-sheet.test.mjs | **GREEN ×4** | **⚠ 无——空转！** |
| **M5**（自选） | like-football.mjs | `LOSS_METRICS` 删 `{key:'disp'...}` | like-football.test.mjs | **RED ×3** | test2、test4、test5 |

**结论**：指定的三个「主 session 声称能红」的变异**确实都能红**（M1/M2/M3）——**主张 E 这部分成立**。
但 M4 揭示了一个**未被任何测试覆盖的失效形态**（见 §5.1）。

---

## 5. 空转断言与盲区（主张 E 的反驳）

### 5.1 ★ contact-sheet「每个格子都画了球」是**总量计数 → 整行丢失看不见**（P1）

`contact-sheet.test.mjs:41-46` 只数**全图**黄像素总量（`countYellow(img) > 1000`）。
把 `:41` 的循环缩成只画 `ENGINE` 行（**整条 REAL 行 = 半个网格消失**），4 条测试**全绿**：

```
[MUTATED: REAL row dropped] y1=678 y3=2034 y3/y1=3.00  test3total=1356 (阈值 1000)
```

机理：`test2` 的「三窗/单窗」比值（y3/y1）与「总量」（test3）**都与行数无关**（丢一行 → 两数
等比缩小，比值不变、总量仍 >1000）。而工具存在的全部理由就是**引擎 vs 真实并列**
（`render.mjs` 的守护测试**逐行分别断言**「单排丢球必红」`visual-review.test.mjs:48-59`，
**contact-sheet 却没有**）。⇒ 这是与 render.mjs 的**不对称**，应补一条「REAL 行黄像素 > 阈值」的**分排**断言。

### 5.2 ★ like-football「反证条：删掉 gap」是**恒真式**（P2）

`like-football.test.mjs:70-74`：
```js
const mutatedKeys = LOSS_METRICS.filter(m => m.key !== 'gap').map(m => m.key);
assert.ok(!mutatedKeys.includes('gap'), ...);
```
它对自己**临时过滤出的副本**断言「不含 gap」——`filter(!== gap)` 的结果**永远**不含 gap，
**与源码无关**。实测坐实：M1 真把 gap 从 `LOSS_METRICS` 删了，**test6 仍然绿**。
⇒ 这是**假的「反证条」**：它声称「证明 test5 有区分度」，实际什么都没证。
（真正的守卫是 test5，M1 下确实变红——所以**覆盖存在**，但这条反证条本身是空转、且给人虚假信心。）
**建议**：改为对**模块导出的 `LOSS_METRICS` 本体**做断言，或直接删除（test5 + 外部变异已足够）。

### 5.3 ★ 损失函数在「量=0」处**反向奖励**（P2，潜伏）

`like-football.mjs:113` `ok = e != null && r != null && r > 0 && e > 0`——**引擎值 e=0 时该行被静默剔除**。
后果（实跑）：

```
engine disp=0     (fully static): distance = 0        ← disp 行被剔，退化成 6 行均值
engine disp=0.001 (near-static) : distance = 1.358    ← 有值就正常
ALL engine shape=0 + disp=0     : distance = null     ← 整表空
```

即：**「球员全程不动」这一飞轮专门要抓的失效，恰恰使 `disp` 行消失、距离掉到 0（甚至 null）**。
`e>0` 的护栏本意是防 `ln(0)=−∞`，但它把**最坏情形**变成了**「不可测」而非「无限差」**。
当前 main 的 disp=1.77、FB4=3.60，**尚未触达** 0（外场 `mean(mags)` 是正量），所以是**潜伏**而非现行——
但它是本就该被夹死的边界。**测试从不喂 `e=0`**（test1 用全 1、其余用 4×/0.5×/2×），故无区分度。
**建议**：`e=0` 时记 ratio=0 → gap 取一个显式的大上界（或让该行参与 loss 并标注 `✗(静止)`），并补一条 `e=0` 的单测。

### 5.4 「距离」标量**随本地数据在场与否而变**（P2，口径）

`disp` 只在本地有 `real-game-*.json` 时才有真实锚；无则整行 `n/a` ⇒ loss 从 **7 行均值**变 **6 行均值**。
**同一引擎、同一结构锚**：
```
distance WITH motion frames    = 0.853
distance WITHOUT motion frames = 0.657   （−23%）
```
工具会打印 `motionLabel`，但**标量本身不可比**——与仓里「别缺口径 ⇒ 不可比」的头号纪律冲突。
（CI 上因缺 wasm 本来就跑不了，故实践影响有限；但任何人本地没下 tracking 数据就会拿到 0.657 当「主指标」。）
**建议**：loss 在运动锚缺失时**显式标 `⚠ 仅结构（6/7 行）`**，或固定用结构 6 行做主标量、`disp` 单列性质旗标。

### 5.5 覆盖盲区（P3）：**wiring 函数零测试**

`grep` 确认**没有任何测试 import** `shapeFromFrames` / `realShapeFromBaseline` / `realMotionFromFrames` / `engineProfile`。
测试只覆盖纯函数 `lossTable` / `buildContactSheet` / `windowStats`。
⇒「引擎与真实**同一聚合方法**」（`cutWindows→primary→跨窗均值`）这一**核心可比性主张**，
以及「引擎结构量复现基线」这一**自证**，只能靠**跑工具**验证（需 wasm，gitignored → 不在 CI）。
若有人改坏 `shapeFromFrames` 的聚合，测试**全绿**。

---

## 6. 诊断诚实性：数字/机制 vs 代码

**主要数字已同步**：诊断文档与 SKILL.md 的 0.853 / 4.42× / 2.19× / 4.84× **均与实跑一致** ✓。
文档已把 gap 改口为「最大缺口**之一**」（正确，因 disp 更大）✓。

**残留陈旧/机制错（「结论对、机制错」同族）**：

| 位置 | 写的是 | 实际 | 严重 |
|---|---|---|---|
| `like-football.mjs:9`（头注释） | gap「**全场最大缺口**」 | disp(2.03) > gap(1.49)，**disp 才是最大** | 机制错（文档已改口，注释漏改） |
| `flywheel-diagnosis:46` | FB4 位移 **3.71m** | BENCHMARK_SEEDS 下是 **3.60m**（3.71 是旧连续种子集的读数） | 陈旧数字 |
| `SKILL.md:86` | main dir **0.62** | main dir = **0.63**（0.62 是 P143r 旧值） | 陈旧（0.63 vs 0.67 的「≈」结论不受影响） |
| `SKILL.md:55-58` | 「`like-football` 在 CI 跑不了（缺 wasm + **真实帧**）」 | 其**结构锚是 committed 基线**（CI 可读），只因 wasm gitignored 才跑不了；「缺真实帧」对其**结构部分不成立** | 机制不准 |

其余机制表述（缺陷 A 的「无标量→优化 dir」、缺陷 C 的 1/27、FB4 的此消彼长）**与代码/实跑一致** ✓。

---

## 7. 残余风险 / 未清项

1. **P1（须修）**：contact-sheet 无**分排**断言 → 整条 REAL 行丢失全绿（§5.1）。类比 render.mjs 已有分排守卫，属回归风险。
2. **P2（建议修）**：fake 反证条（§5.2）、`e=0` 反向奖励（§5.3）、距离随数据在场而变的标量（§5.4）。
3. **P3（记录）**：wiring 函数零测试（§5.5）；头注释「全场最大缺口」与 3.71/0.62 的陈旧数（§6）。
4. **口径纪律**：`contact-sheet` 的视觉结论（「main/FB4 三窗近乎一致、每窗红钉左蓝钉右」）我**端到端跑通并读图确认**了——
   渲染图 6 行（3 窗×2 源）×6 帧，引擎行确为红左蓝右铺开、真实行聚在球附近 ✓。**该视觉主张成立**。
5. **主张 A 未去核分支侧**：「v2 把 dir 0.80→0.68、且 0.80 是分支自造」是**关于 P143r 分支的历史主张**，
   本次只核了 main 侧（0.63≈真实，无信号）；分支侧数字未复算（无分支 wasm），按记忆记载采信。

**还原声明**：全部变异已 `cp` 还原；§7 末尾逐文件 `sha256sum` 对拍 **5/5 PRISTINE**
（`like-football.mjs`=18152d4d…、`contact-sheet.mjs`=84296123… 与 `/tmp/lf-backup/` 一致）。

---

## 总判定

**飞轮修复「方向正确、主体可信」，但「测试非空转」这一主张只部分成立——有 1 条 P1 未清。**

- **可信的部分**：新锚（committed 基线 skillcorner）**口径自证**（引擎逐位复现 `engine.perMetric`）；
  `like-football` 的损失表结构、对数比、对称性、`gap`/`disp` 入表**都有真实区分度**（M1/M2/M5 变红）；
  `contact-sheet` 的「多窗内容」守卫**真实**（M3/M3b 变红），工具端到端跑通、视觉结论被读图证实。
  缺陷 A/C/D **成立**，缺陷 B **部分成立**（gap 是第二大而非最大缺口）。
- **不可全信的部分（主张 E 的反驳）**：
  - **P1**：`contact-sheet` 缺**分排**断言——**删掉整条 REAL 行，4 条测试全绿**（M4）。
  - **P2×3**：fake 反证条（真删 gap 仍绿）、`disp=0` 使距离掉到 0（最坏情形反向奖励）、
    距离标量随本地数据在场而变（0.853↔0.657）。
  - **P3**：wiring 函数（含「同一聚合」这一核心可比性主张）**零测试**。
- **文档诚实性**：主数字已同步且与实跑一致；残留 `like-football.mjs:9`「全场最大缺口」（机制错）+
  3.71/0.62 两处陈旧数。

**P0：无**（无安全/数据破坏/主张完全落空）。
**P1：1 条**（contact-sheet 无分排断言 → 半网格丢失不被发现）。
**P2：3 条**（见上）。清掉 P1、修掉 P2 的 fake 反证条后，本飞轮可判「可信」。
