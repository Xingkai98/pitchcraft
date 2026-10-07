# 飞轮修复 · 独立审阅（第 3 轮，2026-10-07）

审阅对象：`visual-flywheel-tools/2026-10-07` 分支 commit `ed3bb50`——**本轮新增、未经审阅**的两样东西：
1. `tools/visual-review/trajectory.mjs` + `.test.mjs`（引擎 vs 真实**球员轨迹并排图**）；
2. `motion-metrics.mjs` 新增 **`lat`（横向运动占比）** 与 **`mix`（混队度）**，`like-football.mjs` 表加两行，两者进守护测试。

纪律：**只审阅、只报告**；唯一写操作是本文件。所有变异改完即还原 + `sha256sum` 对拍（见 §7）。

审阅环境：`node v22.22.2`；`/tmp/flywheel-merge` 内已备 gitignored 数据：
`viewer/engine.wasm`(main，sha8 `c8e77188`)、`viewer/data/real-game-1.json`/`real-game-2.json`/`benchmark-baseline.json`。
另从主仓借 FB4：`/home/shared/.../viewer/engine-fb4.wasm`(sha8 `e41583d9`)。

---

## 0. 跑测试 —— **32 passed / 0 failed**（主张 1 成立）

```
$ cd tools/visual-review && node --test *.test.mjs
# tests 32   # pass 32   # fail 0
```

---

## 1. 数核（主张 2 / 参考真值）—— **复算相符，但文档里挂的锚数不对**

```
$ node tools/visual-review/motion-metrics.mjs viewer/engine.wasm 5 12
  [引擎] 横向运动占比 中位 0.123     [引擎] 混队度 0.650
  [真实] 横向运动占比 中位 0.428     [真实] 混队度 0.800
```

| 量 | 我复算 | 主 session 参考真值 | 判定 |
|---|---|---|---|
| lat main | **0.123** | ~0.13 | ✓ |
| lat real | **0.428** | ~0.43 | ✓ |
| mix main | **0.650** | ~0.65 | ✓ |
| mix real | **0.800**（median 口径）/ 0.737（mean 口径） | 0.73–0.80 | ✓（但见 §6.2：工具**打印的**「真实 ~0.73」≠ 它**算的** 0.80） |

**FB4 对拍**（`engine-fb4.wasm`）：lat **0.246**（seeds 42–46）/ **0.261**（BENCHMARK 口径）；mix **0.611 / 0.600**。
——**与文档写死的「FB4 lat 0.35 / mix 0.625」不符**（见 §6.2）。

---

## 2. 主张 D（「开发时从不看图」是元缺陷，`trajectory.mjs` 补这个）—— **成立（我读图确认）**

我渲了两张图并**亲自 Read**：

```
$ node tools/visual-review/trajectory.mjs viewer/engine.wasm  /tmp/traj-main.png 42 1800 90
$ node tools/visual-review/trajectory.mjs .../engine-fb4.wasm /tmp/traj-fb4.png  42 1800 90
```

**看到的内容（一句话）**：
- **引擎面板（左）**：20 名球员各自是一条**水平短线**（左右滑、横向几乎冻结），**红队整体钉在左半场、蓝队钉在右半场**，中间一条竖直中线把两队分开。main 与 FB4 **都是这样**（FB4 的短线略多几道横向小毛刺，但**仍是铁轨、仍分边**）。
- **真实面板（右）**：**一团纠缠的弧线**——球员跑向球、绕行、回追，**红蓝交错混在中下部**，没有「各占半场」的分界。

⇒ `trajectory.mjs` **确实能一眼看出「铁轨 vs 弧线」+「分不分边」**——主张 D 的机制（这张图能发现指标看不见的结构缺陷）**成立**。
FB4「加了横向抖动、画面仍不对」也**看图成立**：左图 FB4 只是短线更毛，**没变成弧线、没聚拢**。

---

## 3. ★ 纪律主张（lat 必须与 mix 一起看，单看 lat 会被「抖动」刷分）—— **机制成立，但所引数字不重现**

实跑（同口径对比）：

| | lat | mix |
|---|---:|---:|
| main | 0.123 | 0.650 |
| FB4 | **0.246**（↑ 翻倍） | **0.611**（↓ 略降） |
| real | 0.428 | 0.800 |

⇒ **机制对**：FB4 把 lat 抬高了近一倍（← 「抖动刷分」），而 **mix 没改善（反而略降）**——只看 lat 会误判为「更像真实」。
看图也印证：FB4 左图仍是铁轨、仍分边。**这条「别被单一指标骗」的守卫，机制成立。**

⚠ 但**文档挂的 FB4 数字（lat 0.35 / mix 0.625）与实跑（0.246 / 0.611）差得多**——见 §6。

---

## 4. 逐条主张判定

| 主张 | 判定 | 依据 |
|---|---|---|
| **1** 测试 32 绿 | **成立** | §0 |
| **2** lat/mix 实测值（main/low、real 高） | **成立** | §1，四数复算全中 |
| **D** 元缺陷=不看图；`trajectory.mjs` 能看出铁轨 vs 弧线 | **成立（读图）** | §2 |
| **★** lat 单看能被抖动刷分，须配 mix | **机制成立 / 数字不重现** | §3 |
| 「删 lat/mix 行必红」的变异 | **成立，但机制是「行数」不是「身份」** | §5 M5/M6 红，但 M19（同数换行）**绿** |
| 「trajectory 只画一侧面板必红」 | **大多成立，有 1 个假阴性** | §5 M3b/M7 红，**M3a 绿** |
| 文档数字与代码/实跑一致 | **不成立** | §6（4 处锚数陈旧 + 1 处口径混） |

---

## 5. 变异矩阵（≥5 个定向变异；改完即还原）

> 文件都是 **tracked**，用 `/tmp/*.mjs` 备份 + `cp` 还原 + `sha256sum` 对拍。

| # | 文件:行 | 变异 | 跑哪条 | 结果 | 红的断言 |
|---|---|---|---|---|---|
| **M1**（指定① lat 常数） | motion-metrics.mjs:52 | `lat.push(sy/(sx+sy))` → `lat.push(0.5)` | visual-review.test | **RED ×2** | lat 数值条 + lat 反证条 |
| **M2**（指定② mix 常数） | motion-metrics.mjs:76 | `return tot?opp/tot:null` → `return 0` | visual-review.test | **RED ×1** | 混队度 mixing |
| **M3a**（指定③ 只画一侧·**元数据保留**） | trajectory.mjs:75 | `const nr = drawTrajPanel(...'REAL')` → `const nr = rPaths.length`（**真实面板整条不画**，但 `panels.real.n` 仍=20） | trajectory.test | **GREEN ×4** | ⚠ **无——假阴性！见 §6.1** |
| **M3b**（指定③ 变体·元数据也丢） | trajectory.mjs:75 | → `const nr = 0` | trajectory.test | **RED ×1** | 分面板（`panels.real.n===20` 那条） |
| **M4**（指定③ 变体·窗约束） | trajectory.mjs:54 | 去掉上界 `f.t > t0+win` | trajectory.test | **RED ×1** | collectPaths 窗约束 |
| **M5**（指定④ 删 lat 行） | like-football.mjs:50 | 删 `{key:'lat'...}` | like-football.test | **RED ×2** | `ln4/9`、coverage 9（**都是行数**） |
| **M6**（指定④ 删 mix 行） | like-football.mjs:51 | 删 `{key:'mix'...}` | like-football.test | **RED ×2** | 同上 |
| **M6b** | like-football.mjs:50-51 | 同时删 lat+mix 两行 | like-football.test | **RED ×2** | 同上 |
| **M7** | trajectory.mjs:74 | 引擎面板不画、元数据保留 | trajectory.test | **RED ×1** | 分面板（左带）——**左侧无污染，能抓** |
| **M8** | trajectory.mjs:58 | collectPaths 所有点挤到 id 1 | trajectory.test | **RED ×2** | collectPaths + 分面板 |
| **M9** | motion-metrics.mjs:52 | lat 分母去绝对值 `sy/(sx-sy)` | visual-review.test | **RED ×1** | lat 数值条 |
| **M10** | motion-metrics.mjs:73 | mixing 异队判定取反 | visual-review.test | **RED ×1** | 混队度 |
| **M11** | trajectory.mjs:40 | 只画端点、去掉 `lineTo`（无轨迹线） | trajectory.test | **RED ×1** | 分面板 |
| **M12** | contact-sheet.mjs:44 | `t0s` → `t0s.slice(0,1)`（只画第一窗） | contact-sheet.test | **RED ×3** | 每窗都画了 / 分排 / rows 覆盖 |
| **M13**（自选） | trajectory.mjs:54 | collectPaths 去**下界** `f.t<t0` | trajectory.test | **GREEN ×4** | ⚠ **无——见 §6.1** |
| **M14**（自选） | motion-metrics.mjs:71 | mixing 最近邻→「第一个其他球员」 | visual-review.test | **RED ×1** | 混队度 |
| **M16**（自选） | motion-metrics.mjs:67 | mixing 阈值 `ps.length<4` → `<2` | visual-review.test | **GREEN ×12** | ⚠ 无（盲区，非本主张） |
| **M17b**（自选） | motion-metrics.mjs:45 | 米制因子 (105,68)→(1,1) | visual-review.test | **RED ×5** | 多条数值断言 |
| **M18**（自选·现实形态） | trajectory.mjs:37 | 真实面板**画底但不画轨迹** | trajectory.test | **RED ×1** | 分面板（底把引擎溢出擦掉→右带归零） |
| **M19**（自选·★关键） | like-football.mjs:50 | 把 `lat` 行换成 `disp` 的**重复行**（**行数不变**） | like-football.test | **GREEN ×10** | ⚠ **无——见 §6.1** |

**指定的 5 个定向变异（lat 常数 / mix 常数 / 只画一侧 / 只画一窗 / 删 lat+mix 行）全部变红** —— 主 session 的「变异验证」声称**基本诚实**。
自选变异里挖出 3 个真盲区（M3a / M13 / M19）——见下。

---

## 6. 空转断言 / 盲区（主 session 未抓）

### 6.1 ★ trajectory 分面板像素断言**不独立**：右侧带会被**左侧溢出**填满（P2）

**现象**：M3a——把 `const nr = drawTrajPanel(...'REAL')` 换成 `const nr = rPaths.length`（**真实面板整条不画**，但 `panels.real.n` 元数据仍算对），trajectory 4 条测试**全绿**；而我实测若保留「画底不画轨迹」（M18）或干脆 `nr=0`（M3b）**都会红**。

**根因**：`trajectory.test.mjs` 的合成帧把 x 写到 **4.65**（`x: 0.1 + 0.02*i + k*0.03`，i 到 199），**远超球场 [0,1]**。于是**引擎面板的轨迹溢出到右侧带**：

```
（变异 M3a，合成帧 200×20）
  eng+real : {left:4422, right:5292, ne:20, nr:20}   ← 真实面板没画，右带却 5292（引擎溢出）
  eng+[]   : {left:4422, right:5292, ne:20, nr:0}
  []+real  : {left:0,    right:0,    ne:0, nr:20}
（把合成帧改成球场内 x∈[0,1] 后）
  eng+real : {left:3866, right:3866, ne:20, nr:20}
  M3a      : {left:3866, right:0,    ne:20, nr:20}   ← 0 < 300，**该红**
```

即：`assert.ok(rightCol > 300)` 这条**本意是守「真实面板画了」**，却能被**引擎面板的溢出**满足——**断言测的是「布局带里有像素」，不是「右侧那块面板画了内容」**。
（生产路径的引擎/真实坐标都在场内，故**当下不显形**；但这是**测试合成帧的现实性缺口**——一旦谁改布局/改进出，此守卫会静默失效。）
**修法**：合成帧用**球场内坐标**（x,y∈[0,1]）——这一条改完 M3a 立即变红（我已验证）；或断言**右带的红蓝像素在各队着色比例**而非总量。

### 6.2 ★ `like-football` 损失表**没有 lat/mix 的身份守卫**——同数换行静默通过（P2）

M5/M6（**删** lat/mix 行）确实红，但**红的机制是「行数」**：`loss：单量 4× → ln4/9` 与 `coverage` 两条断言**把 9 写死**。因此：
**M19**——把 `{key:'lat'}` 换成 `{key:'disp', label:'DUP'}` 的**重复行**（**9 行不变**）→ **GREEN ×10（全绿）**。

⇒ 那张**专设的**「★ 表里必须有 gap 与 disp」断言只点名了 **gap / disp**，**没有点名 lat / mix**。
「lat 必须与 mix 一起看」这条**★ 关键纪律**——是**散落在输出文字里的散文**，**没有任何断言夹住「lat 与 mix 都在表里且是它们本身」**。
（若有人把 lat/mix 换成别的 motion 量，行数不变 → 全套测试绿。）
**修法**：把 §5 那条成员断言扩成 `['gap','disp','lat','mix'].every(k => keys.includes(k))`（一行即可，M19 立刻变红）。

### 6.3 collectPaths 只测了**窗上界**，下界无覆盖（P3）
M4（去上界）红、**M13（去下界 `f.t < t0`）绿**——合成帧恰好从 `t0=1800` 起，下界永真。属覆盖盲区（非本主张）。

---

## 7. 数字 / 机制诚实性（「结论对、口径混 / 陈旧数」族）

### 7.1 ⚠ 工具**打印的**真实锚 ≠ 它**算的**（口径混，P2）

`motion-metrics.mjs:116` 打印 `混队度 ... ← 真实 ~0.73`，而**同一屏下一行** `[真实] 混队度 0.800`。
**0.73 不是本工具的 median-over-windows 口径**——它只在**别的口径**下成立：我把真实帧逐帧算 `mixing` 后取 **mean = 0.737**（≈0.73）；本工具的 **median-over-windows = 0.800（各窗长 12/20/…/120 全为 0.800）**；含门将 median=0.727。
⇒ **广告的锚（0.73）≠ 用的锚（0.80）**——本仓头号纪律（别缺口径）在此**自己破了一次**，且**同屏自相矛盾**。`like-football.mjs:51/164`、`motion-metrics.mjs:31` 的 `mix ... 真实 0.73` 同源。
**结论不受影响**（引擎 mix 0.65 < 真实 0.80 或 0.73 都成立），但**读数不可比**。

### 7.2 陈旧锚数（P3 × 3）

| 位置 | 写的 | 实跑 | 
|---|---|---|
| `motion-metrics.mjs:29` 头注释 | main **0.147** / FB4 **0.353** | **0.123 / 0.246** |
| `like-football.mjs:50` 行注释 | main 0.147 vs 真实 0.44 | 0.12 / 0.43 |
| `motion-metrics.mjs:31`、`like-football.mjs:51/164` | FB4 mix **0.625**、lat **0.35** | mix **0.611**、lat **0.246** |

（这些是**本 commit 新写进去的**读数，写进了源码注释与打印文字。）

### 7.3 ⚠ SKILL.md / diagnosis 的「距离 0.85」是本 commit 的**新鲜陈旧数**（P3）

`SKILL.md:116`、`SKILL.md:127`、`diagnosis.md` 表都写「距离 **0.85**（0.853）」。而**本 commit 的表头**（`like-football.mjs`）实跑 = **`[覆盖 9/9 行] = 0.828`**：

```
9 行均值（含 lat/mix）= 0.8289（工具打印 0.828）
7 行均值（不含 lat/mix）= 0.8543（= 文档里的 0.85/0.853）
```

⇒ `0.85` 是**加 lat/mix 之前**的 7 行口径；**本 commit 加了 lat/mix（表 7→9 行）却把 0.85 抄进了新文档**。
`diagnosis §缺陷 B` 的逐量表**也不含 lat/mix 两行**。属「文档挂的锚 ≠ 工具实算」。

---

## 8. 还原声明

- 全部变异在 `/tmp/*.mjs` 备份基础上改、改完 `cp` 还原；探针脚本 `/tmp/probe-*.mjs` 用完即弃（不在仓内）。
- 还原后逐文件 `sha256sum` 对拍**与审阅开始时逐位一致（8/8 PRISTINE）**：

```
f3fe099d…  trajectory.mjs          1fb832bf…  trajectory.test.mjs
e43717e0…  motion-metrics.mjs      57a88c97…  like-football.mjs
ac159e0a…  like-football.test.mjs  c70c4bb3…  visual-review.test.mjs
948749d4…  contact-sheet.mjs       e11529d8…  contact-sheet.test.mjs
```

- 还原后重跑全套：**32 passed / 0 failed**；`git status --porcelain` **空**（除本报告）。

---

## 9. 残余风险 / 未清项

1. **P2**：`trajectory` 分面板像素断言被合成帧的**场外坐标**污染 → 「真实面板整条不画（元数据保留）」**全绿**（§6.1）。
2. **P2**：损失表**无 lat/mix 身份守卫** → 同数换行全绿；「lat 必须配 mix」是散文不是断言（§6.2）。
3. **P2**：`mix` 的**打印锚（~0.73）≠ 实算锚（0.80）**——同屏自相矛盾，破「别缺口径」纪律（§7.1）。
4. **P3×3**：`lat`/`mix` 的 4 个锚数（0.147/0.353/0.625/0.44）与实跑不符（§7.2）；SKILL/diagnosis 的「距离 0.85」是 7 行口径的新鲜陈旧数（§7.3）；collectPaths 下界无覆盖（§6.3）。
5. **未复核**：`lat` 是**逐帧绝对值**口径，而 `trajectory` 图渲染的是**净位移**——同窗 main 净位移 lat=**0.096** vs 逐帧 lat=**0.123**。两者都指向「铁轨」但**不是一个数**；本工具未像 disp 那样把这条口径差写进注释（低危，记录）。
6. **未复核**：`like-football` 距离对 `lat/mix` 的**入表后可比性**——0.828（9 行）与 0.853（7 行）**不可直接比**（工具已标 `[覆盖 9/9]`，但 SKILL 正文仍拿 0.85 当基准）。

---

## 总判定

**本 commit 可合入。核心主张成立、工具真实可用；但有 3 条 P2（含 1 条真盲区）+ 3 条 P3 未清，建议随手修。**

- **成立的**：测试 32 绿 ✓；`lat`/`mix` 四数复算全中 ✓；**主张 D 读图坐实**——`trajectory.mjs` 一渲即见「引擎=水平铁轨·红蓝分半场 / 真实=纠缠弧线·混在中路」✓；
  **★ 纪律机制成立**——FB4 lat 翻倍（0.12→0.25）而 mix 未动（0.65→0.61），单看 lat 确会被「抖动」骗 ✓；
  **指定的 5 个定向变异全部变红** ✓（主 session 的「变异验证」声称不虚）。
- **须修的（按序）**：
  - **P2-①（真盲区）**：`trajectory.test.mjs` 合成帧用**场外坐标** → 右带被左面板溢出污染，「真实面板整条不画」仍全绿（M3a）。改用场坐标（我已验证：改完即红）。
  - **P2-②**：损失表把 `['gap','disp','lat','mix']` 一起纳入成员断言（否则同数换行静默通过，M19）。
  - **P2-③**：`mix` 的打印锚改回本工具实算口径（0.80），或显式标「~0.73 是逐帧 mean 口径」。
  - **P3**：清 `0.147/0.353/0.625/0.44` 陈旧锚、把 SKILL/diagnosis 的「距离 0.85」改成 9 行口径 `0.828`。

**P0：无。P1：无。P2：3 条（§6.1 / §6.2 / §7.1）。P3：3 条（§6.3 / §7.2 / §7.3）。**
