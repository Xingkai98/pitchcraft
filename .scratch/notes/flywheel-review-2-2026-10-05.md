# 飞轮修复 · 独立复审（第 2 轮，2026-10-05）

审阅对象：第 1 轮（`review-1.md`）列出的 **1 P1 + 3 P2 + 1 P3** 的逐条修复是否真落地。
纪律：**只审阅、只报告**；唯一写操作是本文件。所有变异改完即 `cp` 还原 + `sha256sum` 对拍。

审阅环境：`node v22.22.2`；本地有 `viewer/engine.wasm`(c8e77188=main)、`/tmp/landed.wasm`(e41583d9=FB4)、
`viewer/data/real-game-1.json`、`real-game-2.json`、`benchmark-baseline.json`。
快照基线（本轮开始时磁盘版本）已 `cp` 到 `/tmp/r2-backup/`。

---

## 0. 跑测试 —— **25 passed / 0 failed**（主张 1 成立）

```
$ node --test tools/visual-review/*.test.mjs
# tests 25   # pass 25   # fail 0
```
第 1 轮是 20 passed；本轮 +5 条（contact-sheet 3 条分排/覆盖/间隙 + like-football 的 P2b + P3 各 1 条），
数字吻合「新增守卫」的声称。

---

## 1. 逐条修复判定 —— **5/5 真修复**（无假修复）

| 修复 | 声称 | 判定 | 依据（变异） |
|---|---|---|---|
| **P1** contact-sheet 分排断言 | ①`buildContactSheet` 返回 `rows`（与画出行同源）；②分排断言 + rows 覆盖 + 间隙反证条 | **真修复** | 变异 A（删整条 REAL 行）→ **RED ×3**（含 P1 那条分排断言）；第 1 轮此变异 **GREEN ×4**。且变异 D2（只 push rows、不画像素）也 **RED** ⇒ 断言看的是**像素**不是 rows 元数据 ✓ |
| **P2a** fake 反证条（对 filter 副本恒真） | 删恒真条、改注释 | **真修复** | `grep 'filter(m => m.key'` 仅剩**注释**（`like-football.test.mjs:75`）；活断言里无此式 ✓ |
| **P2b** `e==0` 静默剔除（反向奖励） | `e==0` 记 `CAP_LN` 罚、不再剔除 | **真修复** | 变异 B（还原 `e>0` 剔除）→ **RED**（test 6「退化引擎不被静默剔除」）✓ |
| **P2c** 距离随本地帧在 0.853↔0.657 跳 | `coverage:{used,total}` + 输出 `[覆盖 N/7]` | **真修复** | 变异 D1（coverage 写死 total）→ **RED**（test 7）；实跑输出确含 `[覆盖 7/7 行]` ✓ |
| **P3** wiring 零测试（「同一聚合」无守卫） | 合成帧过两条路逐位相等 + 破坏聚合反证条 | **真修复** | 变异 C（`shapeFromFrames` 切窗换 100s）→ **RED**（test 9）；D4/D5/D6（常量/单字段常量/丢末窗）→ **RED ×3**（逐字段有区分度）；D7（抽掉反证条的场形变化）→ **RED**（反证条非恒真）✓ |

**关键的「是否假修复」正面回答**：
- P1 的分排断言 **不是只看 rows 元数据** —— 变异 D2 把「push rows」与「drawPanel」解耦后，test 3（分排像素）与
  test 5（间隙带）双双变红，证明它数的是**真实黄球像素**。
- P3 的相等断言 **不是对某些字段恒真** —— 变异 D5 只让 `ballDist` 走错（其余量正常），test 9 仍红 ⇒
  **每一字段都在被比较**，不是只看一个键。

---

## 2. 变异矩阵（本轮新增/改守卫）

> 全部改完 `cp` 还原，逐文件 `sha256sum` 对拍（见 §5）。`like-football.mjs`/`contact-sheet.mjs`
> 及两个 `.test.mjs` 在 git 里是 **untracked（`??`）**，`git checkout --` 还原不了 —— 我用 `/tmp/r2-backup/` 对拍。

| # | 文件 | 改了哪行 | 跑哪条 | 结果 | 红的断言 |
|---|---|---|---|---|---|
| **A**（指定①，原 P1） | contact-sheet.mjs | `:45` 源数组删 `['R',realFrames,'REAL']` | contact-sheet.test.mjs | **RED ×3** | test3 分排、test4 rows 覆盖、test5 间隙反证 |
| **B**（指定②，P2b） | like-football.mjs | `:122` `present` 恢复 `&& e>0`、`:124` gap 去 CAP | like-football.test.mjs | **RED ×1** | test6 退化引擎 |
| **C**（指定③，P3） | like-football.mjs | `:55` `cutWindows(frames)` → `{sizeSec:100,stepSec:900}` | like-football.test.mjs | **RED ×1** | test9 同一聚合 |
| **D1**（自选，P2c） | like-football.mjs | `:136` coverage 写死 `LOSS_METRICS.length` | like-football.test.mjs | **RED ×1** | test7 coverage |
| **D2**（自选，P1 深化） | contact-sheet.mjs | `:51` R 行只 push rows、`if(src!=='R')` 跳过 drawPanel | contact-sheet.test.mjs | **RED ×2** | test3 分排像素、test5 间隙反证 |
| **D3**（自选，盲区） | like-football.mjs | `:58` `.primary` → `.allPoints` | like-football.test.mjs | **GREEN ×10** | ⚠ **无 —— 见 §4.1（行为中性，非空转）** |
| **D4**（自选，P3 深化） | like-football.mjs | `:63` 全字段返回常量 42 | like-football.test.mjs | **RED ×1** | test9 |
| **D5**（自选，P3 深化） | like-football.mjs | `:60` 仅 `ballDist` 不累加 | like-football.test.mjs | **RED ×1** | test9（逐字段有区分度） |
| **D6**（自选，P3 深化） | like-football.mjs | `:57` `wins.slice(0,-1)` 丢末窗 | like-football.test.mjs | **RED ×1** | test9 |
| **D7**（自选，反证条非恒真） | like-football.test.mjs | `:132` 抽掉反证条场形的 `sin` 调制（跨度恒定） | like-football.test.mjs | **RED ×1** | test10 破坏聚合反证 |
| **D8**（自选，盲区） | contact-sheet.mjs | `:45` R 行改画 engineFrames（错源非丢源） | contact-sheet.test.mjs | **GREEN ×6** | ⚠ **无 —— 见 §4.2** |
| **D9**（自选，CAP 量级） | like-football.mjs | `:111` `CAP_LN 4.0 → 0.01` | like-football.test.mjs | **RED ×2** | test2 `ln4/7`、test4 飞轮守卫 ⇒ CAP 量级被 test2/4 钉住 ✓ |
| **M1**（回归） | like-football.mjs | 删 `LOSS_METRICS` 的 `gap` 行 | like-football.test.mjs | **RED ×4** | test2/4/5/7 |

**结论**：指定的三个变异 A/B/C **全部变红**（第 1 轮 A 在全绿）；自选的 D1/D2/D4/D5/D6/D7/D9 **全部变红**；
只有 D3/D8 绿 —— 二者是**已知盲区、非空转**（下面单列）。

---

## 3. 主张复核：诊断/SKILL 数字 vs 代码/实跑

实跑复核（工具自报）：
```
$ node like-football.mjs viewer/engine.wasm 5 12     → 距离 0.853  disp 1.77 vs 13.46=0.13×  gap 4.42×  [覆盖 7/7]
$ node like-football.mjs /tmp/landed.wasm 5 12       → 距离 0.808  disp 3.60 vs 13.46=0.27×  gap 4.84×  [覆盖 7/7]
```
- `0.853 / 0.808 / 4.42× / 4.84× / 2.19× / 3.60m / 0.27×` **全部逐位复现** ✓
- 非主数据集对照 `metrica gap=8.32`：`23.16/8.32 = 2.78 ≈ 2.8×` ✓（诊断 §B、SKILL:33 一致）
- `全场最大缺口` → `最大缺口之一` 修复**已落地**：`like-football.mjs:9` 与 `SKILL.md:33` 都写「之一」✓（第 1 轮 P3 残余已清）
- 3.71 / 0.62 两处陈旧数**已清**：`grep 3.71`、`grep 0.62` 在 live 文件里命中 0（`0.62` 仅剩 `review-1.md` 的历史引用）✓

### ⚠ 残留（本轮新引入、第 1 轮未抓）：**同一「真实位移/窗」有两个口径，文档混用**（P3）

`like-football` 与 `motion-metrics` 都报「真实 端点位移/窗」，但**用不同的真实锚 + 不同引擎 seed 集**：

| 工具 | 真实锚 | 引擎 seed 集 | 真实 disp（自报） | FB4 引擎 disp |
|---|---|---|---|---|
| `like-football` | `real-game-1+2` | `BENCHMARK_SEEDS=[42,1,7,99,123]` | **13.46** | **3.60** |
| `motion-metrics` | `real-game-1` 单场 | `[42..46]` | **13.33** | **3.71** |

实测坐实（`windowStats` 直调）：`game-1 only → 13.33 / dir 0.67`；`game-1+2 → 13.46 / dir 0.70`。
本轮**新增的**文档文字混用了两口径：
- `SKILL.md:36-37`、`diagnosis.md:45-46`：写「真实 **13.3m** 的 1/27」+「FB4 **~3.6m**（真实 **13.3m** 的 27%）」
- 同文件 `SKILL.md:101`：写「1.77m vs **13.46m**」
- 即 **13.3（motion-metrics 锚）与 13.46（like-football 锚）出现在同一份文档**；且 `3.6m`（like-football seed）**配 `13.3m`**（motion-metrics 锚）= 分子分母**跨口径**。
- **结论未受影响**：`3.60/13.46=26.7%`、`3.71/13.33=27.8%`，都 ≈27%；`0.5/13.3≈1/27` 与 `0.5/13.46≈1/27` 都成立。属
  **「结论对、口径混」**（本仓高发族）。
- **修法（最小）**：把「真实 13.3m」改成「真实 13.46m」（对齐 like-football 口径），或显式标注「motion-metrics 口径=game-1 单场 13.33m」。**不改也可**，但该数字是 SKILL 里唯一未标口径的读数。

---

## 4. 盲区（已知、非空转，如实带过）

### 4.1 变异 D3（`.primary → .allPoints`）全绿 —— 行为中性，非空转
`shapeFromFrames` 在生产里**只吃引擎帧**（真实结构锚来自 committed 基线 JSON，不走此函数）；引擎帧无 `extrapolated`，
故 `.primary === .allPoints` ⇒ 该替换**不改行为**，测试绿是**正确**的，不是空转。（若将来让 `shapeFromFrames` 也吃真实帧，此盲区才会显形。）

### 4.2 变异 D8（REAL 行改画 engineFrames）全绿 —— 「错源」不被分排断言抓
分排断言只判「该行带有没有黄球（>100）」，**不判球的身份**。把真实行画成引擎帧（而非丢弃）仍绿。
**这是设计使然**：分排断言的靶是第 1 轮的「整行丢失」，不是「源串味」。风险低（源在 `:45` 字面写死，正常开发不会互换），
但记录在案：**「引擎 vs 真实并列」的同源性无断言守护**。

---

## 5. 还原声明

- 本轮所有变异均在 `/tmp/r2-backup/` 的副本基础上改，改完 `cp` 回；探针（D2/D7 的临时脚本）用完即删。
- 逐文件 `sha256sum` 对拍，**5/5 PRISTINE**：
  - `contact-sheet.mjs` = `948749d4…`
  - `contact-sheet.test.mjs` = `e11529d8…`
  - `like-football.mjs` = `24468081…`
  - `like-football.test.mjs` = `12fe537f…`
  - `motion-metrics.mjs` = `10226d4b…`
- 还原后重跑全套：**25 passed / 0 failed**。

---

## 总判定

**本轮修复后，飞轮可判「可信」。**

- **P1 已真清**：contact-sheet 分排断言数的是**像素**（A/D2 双红），删整条 REAL 行必红（第 1 轮 GREEN ×4 → 现 RED ×3）。
- **P2×3 已真清**：fake 反证条已删（活断言无 filter 副本）；`e==0` 记 CAP_LN 罚且排进 worst（B 红）；
  coverage 如实下降且输出标注（D1 红、实跑 `[覆盖 7/7]`）。
- **P3 已真清**：`shapeFromFrames` 与基线同一聚合有**逐字段**区分度的守卫（C/D4/D5/D6 全红），且反证条非恒真（D7 红）。
- **新增/改守卫无空转**：9 个自选变异里 7 红；绿的 2 个（D3/D8）是**行为中性或设计外的已知盲区**，非「声称修了实则空转」。
- **文档**：主数字（0.853/0.808/4.42×/4.84×/3.60m）逐位复现；「全场最大缺口」已改「之一」；3.71/0.62 陈旧数已清。

**残余风险（不阻塞「可信」）**：
1. **P3（记录诚实性）**：「真实位移/窗」在文档里有 13.3 vs 13.46 两个口径混用（§3），且 `3.6m×13.3m` 跨口径配对。
   **结论（~27% / 1/27）不受影响**；建议统一到 like-football 口径 13.46m。
2. **P3（盲区记录）**：D8「引擎/真实行源互换」无断言（§4.2）；D3「primary/allPoints」在现状下行为中性（§4.1）。
   两者均属低风险，如实记录即可。

**P0：无。P1：无未清。P2：无未清。**
（唯一未清为 1 条 **P3**：文档口径混用 —— 属记录诚实性、不影响工具判定。）
