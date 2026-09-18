# P36 实施审阅（独立 subagent，零记忆）

- **审阅区间**：`1a7834a..32f0f7e`（`a4144f5` P1+P2 指标/测试/基线/对比工具；`9bb6abd` 文档数字对齐 + 探针归档；`32f0f7e` 勾选 P3.3）
- **开始 HEAD**：`32f0f7e28ce9f8870e896f892d324a0cf7f297bf`
- **结束 HEAD**：`32f0f7e28ce9f8870e896f892d324a0cf7f297bf`（审阅期无新提交）
- **开始 `git status --porcelain`**：`（空）`
- **结束 `git status --porcelain`**（新写本报告前的瞬时快照；报告为唯一新增文件）：

```
（空）
```

- **`viewer/match-metrics.js` sha256 前后对照**（同一值，逐字节未变）：

```
开始：3b9c627dcffcbcf66a78401bf3b1e013f665df039504a0b2b6557eb2cca66617
结束：3b9c627dcffcbcf66a78401bf3b1e013f665df039504a0b2b6557eb2cca66617
```

- **基线/实现文件 sha256 校验**（`sha256sum -c`，全部 OK）：

```
viewer/match-metrics.js: OK
tools/benchmark-compare.mjs: OK
tools/benchmark-baseline.mjs: OK
tools/benchmark-engine.mjs: OK
viewer/match-metrics.test.js: OK
viewer/data/benchmark-baseline.json: 87cf18d8ca09fdb9bdc7e4e32d3136f39c147b2e414c6680ff1f6bd2f07ba35b
```

审阅期间所有变异/改动均即时还原，每条变异后都以 `git diff --stat` + `git status --porcelain` 证明工作区 pristine。

---

## 0. 结论速览

- 任务点名的 8 条变异**全部按预期变红或正确跳过**（见 §1），口径守护的主干是有效的。
- 但扩展变异暴露 **7 处盲区**：其中「紧凑度 x/y 配对」是本 change **实现期真实发生过并被修掉的 bug**（probe12），却**没有任何测试守护**——重新引入时全绿。
- 文档数字逐项 diff 发现 **1 处不一致（README）**：`紧凑度` 真实区间仍是**修 bug 前的旧值**。按任务约定「不一致 = P1」。
- **最终判定：需修**（存在 P1）。

---

## 1. 变异测试结果表

**驱动方式**（每条：改源 → 跑 `cd viewer && node --test match-metrics.test.js` → `git checkout --` 还原 → 证明 pristine）：

```bash
cd viewer && node --test match-metrics.test.js        # 口径守护
cd tools  && node --test benchmark-compare.test.mjs   # 对比逻辑
```

| # | 变异 | 结果 | 红了哪些用例 | 盲区结论 |
|---|---|---|---|---|
| M1 | `depth = xs[n-2]-xs[1]` → `xs[n-1]-xs[0]`（trim1→max-min） | **红** | #1 #5 #10 #11 #12 #15 #23（7 条） | 守护充分 |
| M2 | `teamShape` 去掉 `!KEEPER_IDS.includes(p.id)` | **红** | #1 #3 #4 #5 #8 #9 #10 #11 #12 #15 #23（11 条） | 守护充分 |
| M3 | 窗口聚合改「合并整窗位置再算」 | **红** | #5 #11 #25（3 条） | 守护充分 |
| M4a | `windowMetrics` 中 `if (!rawBallOnly \|\| isRawBallFrame(f))` → `if (true)` | **红** | #16（1 条） | 守护充分 |
| M4b | `isRawBallFrame` 恒 `return true` | **红** | #16 #19（2 条） | 守护充分 |
| M5 | `possessionProxy` 恒返回 `'home'` | **红** | #13（1 条） | 守护充分 |
| M6 | `SAMPLE_INTERVAL_SEC` 0.2→1 | **红** | #14（1 条） | 守护充分 |
| M7 | `MIN_OUTFIELD_PLAYERS` 7→1 | **红** | #15（1 条） | 守护充分 |
| M8 | `cutWindows` `minFrames` 100→0 | **绿** | — | **盲区**：安全网无守护，且注释陈义（见 P2-4） |
| M9 | `elasticity` 样本守卫 `if(false) return null` | **红** | #22（1 条） | 守护充分 |
| M10 | `cutWindows` 贴边容差 `T+1`→`T` | **绿** | — | **盲区**：容差分支无覆盖（见 P2-5） |
| M11 | `ad.push(m.away.depth)` → `m.home.depth`（客队纵深接成主队） | **绿** | — | **盲区**：指标接线无守护（见 P2-2） |
| M12 | `gap` 欧氏 → 曼哈顿（`hypot`→`abs+abs`） | **绿** | — | **盲区**：采用门的公式无守护（见 P2-2） |
| M13 | `spread` 复现历史 bug：排序 x 与未排序 y 按下标配对 | **绿** | — | **盲区**：**实现期真实 bug 无回归守护**（见 P1-2） |
| M14 | `windowMetrics` 控球队别取反（`'home'`→`'away'`） | **绿** | — | **盲区**：控球代理结果无取值断言（见 P2-2） |
| M15 | `possessionProxy` 跳过门将参与判定 | **绿** | — | **盲区**：该断言空转（见 P2-3） |
| M16 | `sampleEngineFrames` `Math.round`→`Math.floor` | **红** | #21（1 条） | 守护充分 |

**任务点名的第 8 项（基线陈旧/缺失）实测**：

```bash
python3 -c "import json;p='viewer/data/benchmark-baseline.json';b=json.load(open(p));b['metricsModule']['sha256']='0'*64;json.dump(b,open(p,'w'),ensure_ascii=False,indent=2)"
node tools/benchmark-compare.mjs
# → "P36 标尺：跳过（基线陈旧） … 已变更（sha256 3b9c627dcffc… ≠ 基线记录的 000000000000…）"；EXIT=0
```

`tools/benchmark-compare.test.mjs` 的 missing/stale 用例（#9 `基线缺失→missing`、#10 `哈希不匹配→stale`、#12 `main 缺失→退出 0`）覆盖同一路径（临时文件注入 `deadbeef...` 时 `reason=stale`）。**陈旧检出与缺失跳过都成立**，且都退出 0。

---

## 2. 问题清单（按严重度）

### P1-1（需修）README 紧凑度真实区间与基线不一致 —— 是修 bug 前的旧值

- **文件**：`README.md:68`
- **证据**：

```bash
grep -n "紧凑度（到重心）" README.md
# 68:| 紧凑度（到重心） | 15.2m [10.8–17.4] | 20.0m [17.9–23.2] | 不重叠，+31% |

node -e 'const b=require("./viewer/data/benchmark-baseline.json");const s=b.real.perMetric.spread;
console.log(s.avg.toFixed(1),"["+s.min.toFixed(1)+"–"+s.max.toFixed(1)+"]")'
# 15.2 [10.7–17.2]
```

- **性质**：`[10.8–17.4]` 正是 `probe12` 记录的 **x/y 配对 bug 修正前**的真实值
  （探针 `baseline-numbers.json` `real.perMetric.spread`: `min=10.7951, max=17.3686` → 10.8/17.4）。
  `design.md` D3 行 91 与 D5 表行 152 都已更新为 `(10.7–17.2)` / `[14.0, 17.2]`，**只有 README 漏改**。
- **建议修法**：`README.md:68` 真实区间改为 `[10.7–17.2]`。可顺手加一条文档数字哨兵
  （见 P2-6）避免下次再漏。

### P1-2（需修）「紧凑度」的历史 x/y 配对 bug 无回归守护 —— 重新引入时全绿

- **文件**：`viewer/match-metrics.js:146-148`（正确实现）；`viewer/match-metrics.test.js`（缺断言）
- **证据**（M13，复现 probe12 记载的错误配对）：

```diff
-  const spread = mean(outfield.map((p) => Math.hypot(
-    p.x * PITCH_LENGTH_M - cx, p.y * PITCH_WIDTH_M - cy,
-  )));
+  const ysSorted = outfield.map((p) => p.y * PITCH_WIDTH_M);
+  const spread = mean(xs.map((sx, i) => Math.hypot(sx - cx, ysSorted[i] - cy)));
```

```
# tests 25 / # pass 25 / # fail 0     ← 全绿
```

- **为什么现有测试挡不住**：唯一的 spread 断言（`match-metrics.test.js:57`）让**全队 y 相同**
  （`makeFrame` 里 `y=0.5`），此时「排序后 x 配未排序 y」与「同一球员配对」数值恒等——断言对配错免疫。
- **严重度理由**：`spread`（紧凑度）是**三项采用门之一**；这个 bug 在实现期真实发生过、只在
  `generate-baseline-numbers.mjs` 的复核里被发现（`probes/README.md` 有专段记载），
  正是 `design.md` D6 所说「口径会在某次重构里悄悄失效，而数字只是缓慢漂移」的教科书场景。
- **建议补的断言**：构造两队 y **不同**的输入（例如主队 y 沿 x 递增、客队 y 递减），
  用「同一球员 (x,y) 配对」手算期望值断言 `spread`；再补一条反证，断言错误配对会给出不同数值。

### P2-1（建议）基线文件损坏/字段缺失 → 未捕获异常，退出码 1

- **文件**：`tools/benchmark-compare.mjs:51`（`JSON.parse`）、`:107`（`baseline.real.perMetric`）
- **证据**：

```bash
printf '{ this is not json' > viewer/data/benchmark-baseline.json
node tools/benchmark-compare.mjs        # SyntaxError 栈回溯；EXIT=1

printf '{"kind":"x"}' > viewer/data/benchmark-baseline.json
node tools/benchmark-compare.mjs        # TypeError: Cannot read properties of undefined (reading 'perMetric')；EXIT=1
```

- **性质**：spec scenario 只要求「**缺失**时跳过而非失败」，损坏/半截 JSON 属边界外。
  但 `verify.sh` 第 6 步在 `set -e` 下会因此**整体失败**——文件已入库且正常，风险低。
- **建议修法**：`loadBaseline` 把 `JSON.parse` 与字段形状校验包进 try/catch，
  失败时返回 `{ ok:false, reason:'invalid', message:'…重新生成：node tools/benchmark-baseline.mjs' }`，
  与 missing/stale 同路径退出 0。

### P2-2（建议）指标接线/公式无守护（M11 / M12 / M14 三处同源）

- **文件**：`viewer/match-metrics.js:180`（gap 公式）、`:195`（ad 接线）、`:204`（控球队别）
- **证据**：三条变异全部**全绿**（见 §1 表）。根因相同——测试只断言「单一规范输入」，
  而该输入下变异恰好数值不变：
  - `gap`（M12）：唯一断言（`test:67`）让两队 `y` 相同，曼哈顿 = 欧氏；
  - `ad`（M11）：`ad` 只被摘要计数断言过，**从无取值断言**；
  - 控球队别（M14）：只断言 `possessionFrames` **计数**（`test:251`），不断言 `possessionHome` 取值。
- **影响**：`gap` 是采用门，`ad`/`possessionHome` 是报告项——错值会静默进入报告与基线。
- **建议补的断言**：
  1. `gap`：两队 y 不同（如主队 y=0.3、客队 y=0.7），手算 `hypot` 期望值；
  2. `ad`：构造主客队纵深**不同**的帧，断言 `w.ad` 等于客队值而非主队值；
  3. `possessionHome`：构造已知归属的帧，断言 `possessionHome` 的具体数值（不只计数）。

### P2-3（建议）「门将参与控球代理」是空转断言

- **文件**：`viewer/match-metrics.test.js:200-202`（注释声称「含门将参与判定」）
- **证据**（M15：让 `possessionProxy` 跳过门将）：

```diff
-    if (!p) continue;
+    if (!p || KEEPER_IDS.includes(p.id)) continue;
```

```
# pass 25 / # fail 0     ← 全绿
```

- **为什么空转**：`nearKeeper` 帧球在 `x=0.021`，门将(id0) `x=0.02` 距离 0.105m 最近；
  但若剔除门将，**最近者变成主队 id1（x=0.3）与客队 id11（x=0.3）并列**，
  `Math.hypot` 相等时循环取先遇到的主队 id1 → 仍得 `'home'`，断言照样通过。
- **建议修法**：把球放到只有门将严格最近、且**次近者是客队**的位置（如主队非门将整体压到
  对方半场、门将留在本方门线附近），使「含门将」与「不含门将」结论相反。

### P2-4（建议）`minFrames` 安全网无守护 + 注释陈义

- **文件**：`viewer/match-metrics.js:107-108`（注释）、`:117`（判定）
- **证据**：

```bash
# M8: minFrames 100→0  →  # pass 25 / # fail 0（全绿）

node -e '...'   # game2 T=5646.24；s=5400 不满足 s+300<=T+1；强行取该窗得 1232 帧
# → 1232 > 100，minFrames 门槛根本拦不住它
```

- **性质**：注释称「game2 尾部的 246s 残窗就**由此**排除」——**事实错误**。
  残窗是被循环边界 `s + sizeSec <= T + 1`（`:115`）排除的；`minFrames` 是另一条从未被触发的
  安全网。行为当前正确，但注释会误导后来人以为残窗防护来自 `minFrames`。
- **建议修法**：修正注释说明两者分工；补一条单测直接构造「缺口中段、含一个帧数 < minFrames 的
  短窗」的输入，断言该短窗被丢弃。

### P2-5（建议）`cutWindows` 的 `T+1` 贴边容差无覆盖

- **文件**：`viewer/match-metrics.js:115`
- **证据**：M10（`T+1`→`T`）全绿。现有 `cutWindows` 用例（`test:284`）的 `T=5700` 恰满足
  `s+sizeSec <= T`（5700 ≤ 5700），落不到容差那 1 秒上。
- **建议修法**：加一条 `T` 落在窗口边界**略小于** `s+sizeSec`（如 `T=5699.999`，模拟采样相位差）
  的用例，断言贴边整窗被保留。

### P2-6（建议）基线文件的「样本量/边界声明」与真实基线内容无自动化断言

- **文件**：`viewer/data/benchmark-baseline.json`（`declarations` / `windows.real`）、
  `tools/benchmark-baseline.mjs`（`realGameWindows` / `generateBaseline`）
- **证据**：

```bash
grep -rn "benchmark-baseline.json\|realGameWindows\|generateBaseline\|benchmark-engine" \
  viewer/*.test.js tools/*.test.mjs
# （无输出）
```

- **性质**：spec scenario「基线标注样本量与边界」要求基线含样本量与未覆盖维度声明，
  但**没有任何测试读这份入库文件**；`benchmark-baseline.mjs` 的生成逻辑（含残窗记录、
  `uncoveredSec` 计算）也**零测试覆盖**（对比工具单测用的是手写 `makeBaseline` 合成数据）。
  入库文件被误改/生成逻辑回归时无人发现。
- **建议修法**：加一条读真实基线的轻量断言测试（不必跑引擎）：校验
  `windows.real.nGames/nWindows`、`declarations.notCovered` 非空、`metricsModule.sha256`
  与当前模块一致（陈旧哨兵）、`discardedPartialWindow` 的 `durationSec≈246`。

### P2-7（建议）`design.md` 审阅记录残留「默认改为 ratchet」

- **文件**：`openspec/changes/p36-match-benchmark/design.md:287`
- **证据**：`R2-P1-2 … | 默认改为 **ratchet**（首日即绿 + 真能挡回归）`，
  而同一文档 D5b（`:180`）与 `proposal.md:12-15` 均为「**报告期**」（用户 2026-09-18 拍板）。
- **性质**：「审阅记录」是历史小节，D5b 为权威决策；不构成实现错误，但读者会看到两种默认形态。
- **建议修法**：在该行补一句「（最终由用户拍板改为**报告期**，见 D5b）」，或把该格改为
  「报告期（用户拍板覆盖 ratchet 建议）」。

---

## 3. 其余核查项（无问题）

| 核查项 | 方法 | 结果 |
|---|---|---|
| **测试是否真的跑了真实数据** | `cd viewer && node --test match-metrics.test.js` | 25/25 pass，**0 skipped**——`真实数据冒烟` 实测执行（非跳过） |
| **全量套件** | `cd viewer && node --test *.test.js` / `cd tools && node --test *.test.mjs` | 370 pass / 0 fail；445 pass / 0 fail |
| **对比工具端到端** | `node tools/benchmark-compare.mjs` | 正常出报告，EXIT=0；数字与基线 JSON 一致（hd 39.56 vs 25.21、余量 2.58m、均值 +56.9%） |
| **verify.sh 第 6 步·基线缺失** | `mv baseline …` → `node tools/benchmark-compare.mjs` | 打印「跳过（基线缺失）」+ 生成方式；**EXIT=0**；文件已还原（sha 一致） |
| **verify.sh 第 6 步·wasm 缺失** | `mv viewer/engine.wasm …` → 同上 | 打印「跳过（engine.wasm 缺失）」+ 构建提示；**EXIT=0**；文件已还原 |
| **.gitignore 例外** | `git check-ignore -v` / `git ls-files` | `viewer/data/*` 命中 real-game-1.json；`benchmark-baseline.json` 未忽略且**已在库**（`git ls-files` 列出） |
| **index.html 版本号已 bump** | `git diff 1a7834a..32f0f7e -- viewer/index.html` | `20260918-11` → `20260918-12` |
| **报告期无 pass/fail 语义** | `grep -n "assert\|process.exit" tools/benchmark-compare.mjs` + 单测 | 无断言；仅 `process.exit(code)`/异常 `exit(1)` 两条非判定路径；`renderReport` 无阈值判定词（单测 `test:129` / `assert:136` 断言报告文本不含 合格/通过/FAIL/PASS/失败） |
| **design D5 交叉验证表数字** | 亲跑 `cutWindows` 复算 game1/game2 | 纵深 [24.2,27.2] 3/6、紧凑度 [14.0,17.2] 5/6、重心间距 [6.8,10.5] 6/6——与 `design.md:151-153` 逐项一致 |
| **design D3 / tasks P3.2 / proposal 数字** | 逐项 diff 基线 JSON | hd 25.2/39.6/+57%、余量 2.6m、ad 26.2/38.9、均值差 49%、修正说明 15.30→15.24、19.83→19.98——**全部与基线一致**（唯一例外见 P1-1） |
| **`Game.players` 罚下过滤被采样正确消费** | 读 `viewer/game.js:171-178` + `sampleEngineFrames` | 采样走 `game.players` getter，罚下者从帧数组消失、`p.id` 保留，`teamShape` 按 `p.id` 判定 → 人数跌破 7 时该帧丢弃，**消费正确** |
| **空帧 / null 球员 / 浮点边界** | `test:256`、`test:262`、`cutWindows` 非空守卫、`MIN_OUTFIELD_PLAYERS` 保证 `xs.length≥7` | 均已有守护（M7 变红佐证） |
| **归档探针可复现** | `cp probes/probe9-convention-scan.mjs viewer/ && node` | 正常跑出 5 种约定对比表（trim1 真实 24.9 (16.2–29.6) / 引擎5400s 39.6 (32.1–47.6)），README 所称「可复现证据」成立 |

---

## 4. 最终判定

**需修**（存在 P1-1、P1-2 两条 P1）。

需修项都很小、且互不牵连：

1. **P1-1**：`README.md:68` 紧密度的真实区间 `[10.8–17.4]` → `[10.7–17.2]`（对齐基线；其余文档已对）。
2. **P1-2**：给 `spread`（紧凑度）补一条 y 不同构的配对守护断言 + 反证——
   让「实现期真实发生过的 x/y 配对 bug」重新引入时**必红**。

P2 项（建议随修，非阻断）：P2-2 三处指标接线/公式补取值断言（`gap` 是采用门，优先）、
P2-6 给入库基线加轻量哨兵（可同时兜住 P1-1 类文档漂移）、P2-4 修正 `minFrames` 陈义注释并补用例、
P2-3 修掉空转的门将断言、P2-5 / P2-1 / P2-7 各自的小修。

修完 P1 后重跑本报告的 M13 与 M12/M14/M11 变异即可验证守护是否生效。
