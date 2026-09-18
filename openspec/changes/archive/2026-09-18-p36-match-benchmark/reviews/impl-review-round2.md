# P36 实施审阅·第二轮（独立 subagent，零记忆）

- **审阅区间**：`1a7834a..6b00a0d`（重点：最后一笔 `6b00a0d` 对第一轮 `reviews/impl-review.md` 的修复）
- **开始 `git rev-parse HEAD`**：`6b00a0de3e329e9efa967a61b8da7ffe15329d46`
- **结束 `git rev-parse HEAD`**：`6b00a0de3e329e9efa967a61b8da7ffe15329d46`（审阅期无新提交）
- **开始 `git status --porcelain`**：`（空）`
- **结束 `git status --porcelain`**（新写本报告前的瞬时快照；报告为唯一新增文件）：

```
（空）
```

- **审阅期所有变异均以 `cp` 备份原文件、`cp` 还原，逐条后以 `git status --porcelain` 证明工作区 pristine。**
  关键文件 sha256 前后对照（逐字节未变）：

```
viewer/match-metrics.js               0a6ef660a473c0aff9da6aff0b9f00e319f12ba9931b18f899dd4507165fc20d
viewer/data/benchmark-baseline.json    912d9e7bf054d2c9098c72a8fbc42fdba456056044b33e21eb425d069164ee1b
tools/benchmark-compare.mjs            acf775294a2074699a9e3f83b6363726958eb2f553a6ffe94adb04ec237c8e25
viewer/index.html                      7531a969a5481cd9c905b4881bccab33c8f69cb47fd112082870cc7dfd139783
```

---

## 0. 结论速览

- **A 部分 7 条点名变异全部变红**（§1 表），第一轮暴露的 7 处盲区**守护全部生效**。
- 手算核查确认新断言**非同义反复**：SPREAD_DELTAS（6m / 5.929）、gap（40 / 56）、
  possessionHome（1/3、2/3）的期望值均由我从原始输入独立复算，未复用实现。
- B 部分逐项核查**全部通过**：invalid 跳过路径三/四类边界实测 EXIT=0；基线哨兵对
  sha256/数值/字段/残窗/D3 分离 五类篡改都变红、基线缺失时正确跳过；cutWindows 注释与
  代码行为经实验一致；基线 JSON **仅 sha256 一行变**、数字逐项不动；README/design/tasks
  文档数字与基线逐项一致；index.html 版本号已 bump；全套件绿、对比工具 EXIT=0。
- **唯一新发现**：一条测试**注释**把「剔除门将后的最近者」写成 id11，实测是 **id16**
  （距离 3.045m 引用正确、但 id 写错）——纯注释笔误，断言本身正确。定为 **P2**。
- **最终判定：通过**（无 P0/P1；仅 1 条 P2 注释笔误）。

---

## 1. A 部分：7 条复变异结果表

**驱动方式**（每条：`cp` 备份 → 用 python 施加变异 → `cd viewer && node --test match-metrics.test.js`
→ `grep` 取 `# tests/pass/fail` 与 `not ok` 行 → `cp` 还原 → `git status --porcelain` 证明 pristine）：

| # | 变异 | 结果 | 红了哪些用例（编号-名） | 判定 |
|---|---|---|---|---|
| M1 | spread 恢复历史 bug：排序后 x 配未排序 y | **红** `31/30/1` | #5 紧凑度按同一球员的 (x,y) 配对 | ✅ 守护生效 |
| M2 | gap 欧氏 → Manhattan（`hypot`→`abs+abs`） | **红** `31/30/1` | #4 重心间距 = 欧氏距离而非 Manhattan | ✅ 守护生效 |
| M3 | `ad.push(m.away.depth)` → `m.home.depth` | **红** `31/30/1` | #8 窗口聚合接线：hd 取主队、ad 取客队 | ✅ 守护生效 |
| M4 | possessionHome 累加 `'home'` → `'away'` | **红** `31/30/1` | #9 控球代理聚合取值 | ✅ 守护生效 |
| M5 | possessionProxy 跳过门将（`!p \|\| KEEPER_IDS.includes(p.id) → continue`） | **红** `31/30/1` | #17 口径·控球代理（含门将参与判定） | ✅ 守护生效 |
| M6 | cutWindows `minFrames` 100→0 | **红** `31/30/1` | #26 cutWindows：minFrames 安全网 | ✅ 守护生效 |
| M7 | cutWindows `T + 1` → `T` | **红** `31/29/2` | #25 贴边容差 T+1；#26 minFrames 安全网 | ✅ 守护生效 |

> **M7 同时打红 #26 的机制已核实**：`#26` 的构造序列最后一帧是 `t = 2999.8`
> （`i/5 < 300` 生成 `[0,300)`，再整体平移到 `[2700,3000)` → 末帧 `2999.8`），并非整 3000。
> 于是 `s=2700` 窗 `2700+300 = 3000`：
> - 容差 `T+1 = 3000.8` → `3000 <= 3000.8` 成立，末窗保留 → 期望 `[0, 2700]`；
> - 去容差 `T = 2999.8` → `3000 <= 2999.8` **不成立**，末窗被丢 → 实得 `[0]` → **红**。
>
> 实测复现：`cap=T+1 → [0, 2700]`、`cap=T → [0]`。同理 `#25`（`T=5699.8`）的
> `[5400,5700)` 窗在去容差后被丢。两条边界用例都红，守护充分。

**每条变异后均还原并证明 pristine**（`git status --porcelain` 为空，`sha256sum` 回到
`0a6ef660…`）。命令样例：

```bash
cp viewer/match-metrics.js /tmp/mm-backup.js          # 备份
# … 施加变异 …
cd viewer && node --test match-metrics.test.js        # 观察红/绿
cd .. && cp /tmp/mm-backup.js viewer/match-metrics.js # 还原
git status --porcelain                                # 证明 pristine（空）
```

### 1.1 同义反复核查（手算，不复用实现）

| 断言 | 测试文件行 | 实现的常量/函数是否被复用 | 我的独立手算 | 结论 |
|---|---|---|---|---|
| spread = 6m（SPREAD_DELTAS） | `match-metrics.test.js:116` | 否——期望值 6 来自构造表 | 10 个 `(dx,dy)` 的 `hypot` = 5×8 + 10×2 = 60，均值 **6.0**；`sum dx = 0`、`sum dy = 0`（重心不动） | ✅ 正确 |
| 反证 scrambled ≈ 5.929 | `:118-121` | 否——测试内独立 `reduce+hypot` | 排序 x `[-6,-5,-4,-3,0,0,3,4,5,6]` 配原序 y `[4,-4,-3,3,5,-5,0,0,8,-8]` → 逐对 `hypot`… 均值 **5.9290848…**，`|Δ−6| = 0.0709 > 0.05` | ✅ 正确、有区分度 |
| gap = 40 / Manhattan = 56 | `:104-106` | 否 | 主队重心 (50,30)、客队 (74,62)：`dx=24, dy=32` → `hypot = 40`（3-4-5×8）、`|24|+|32| = 56` | ✅ 正确 |
| possessionHome = 1/3、2/3 | `:162,164` | 否 | 球 x=0.305：主队 id1@0.30 距 0.525m 唯一最近 → home；球 x=0.9：客队 id16@0.88 距 2.1m 最近 → away。逐帧计数 1/3、2/3 | ✅ 正确 |
| ad = 22.05（客队） | `:152` | 否 | 客队步长 0.03：`trim1 = xs[8]-xs[1] = (0.2+8·0.03 − 0.2−0.03)·105 = 0.21·105 = 22.05m` | ✅ 正确 |

**结论：新断言均为「原始输入 → 独立手算期望值」的构造式断言，非空转、非同义反复。**
反证条（scrambled / Manhattan）尤其关键——它们直接从输入复算「错误公式」会给出的值，
与实现路径无关，因此对「公式被换掉」的变异有区分度（M2、M1 实测变红佐证）。

---

## 2. B 部分：修复自身的手查

### 2.1 `tools/benchmark-compare.mjs` 的 invalid 路径（P2-1）

四类损坏实测（每条 `printf`/python 写入 → `node tools/benchmark-compare.mjs` → 读 EXIT）：

| 类别 | 输入 | 输出 | EXIT |
|---|---|---|---|
| 半截 JSON | `printf '{ this is not json'` | `跳过（基线损坏）… JSON 解析失败… Expected property name…重生成` | **0** |
| 结构缺失（合法 JSON） | `{"kind":"x"}` | `跳过（基线损坏）… 缺 real/engine.perMetric…重生成` | **0** |
| 类型异常（顶层数组） | `[1,2,3]` | `跳过（基线损坏）… 缺 real/engine.perMetric…重生成` | **0** |
| 结构半缺（有 real 无 engine） | 删 `engine` 字段 | `跳过（基线损坏）… 缺 real/engine.perMetric…重生成` | **0** |

**正常基线仍出报告**：还原后 `node tools/benchmark-compare.mjs` EXIT=0，报告三项采用指标
`hd 39.56 [32.14–47.59]`、`spread 19.98 [17.86–23.24]`、`gap 15.11 [11.72–18.01]` 全部照常。

**修复自身的守护反向验证**（额外变异，证明新测试真挡）：

| 变异 | 结果 |
|---|---|
| 去掉结构校验 `if (false)`（保留 try/catch） | **红** #12（reason=invalid 用例） |
| 去掉 try/catch（回到裸 `JSON.parse`） | **红** #12 + #13（main 退出码用例） |
| label 映射删 `invalid` 项 | **红** #13（打印「跳过（基线损坏）」用例） |

### 2.2 `tools/benchmark-baseline.test.mjs` 哨兵（P2-6）

篡改实测（`cp` 备份 → 改 → `cd tools && node --test benchmark-baseline.test.mjs` → 还原）：

| 篡改 | 结果 |
|---|---|
| `metricsModule.sha256` 改 `0`×64 | **红** #1 陈旧性哨兵 |
| `windows.real.nWindows` 13→12 | **红** #2 样本量记录 |
| 删 `real.perMetric.hd.max` | **红** #4 数值量级/区间有序 |
| `engine.perMetric.spread.min` 压到 real.max−1（破 D3 分离） | **红** #4（D3 tripwire） |
| `declarations.notCovered` 去掉「联赛」 | **红** #3 未覆盖维度声明 |
| `discardedPartialWindow.durationSec` 246→999 | **红** #2 残窗记录 |
| **基线缺失**（改名为 `/tmp/baseline-renamed.json`） | **5 条全 SKIP**（`# skipped 5`，非 fail） |

缺失时跳过成立，且 skip 原因带完整生成链路提示。文件已还原（sha 回到 `912d9e7b…`）。

### 2.3 `viewer/match-metrics.js` 注释修订（P2-4）与代码行为一致性

`cutWindows` 新注释称两条机制分工不同。**实验构造验证**：

```bash
node --input-type=module -e '
import { cutWindows } from "./viewer/match-metrics.js";
const f=[]; for(let i=0;i*0.2<=5646+1e-9;i++) f.push({t:i/5});   // game2 时长
console.log(cutWindows(f).map(w=>w[0].t));                        // [0,900,…,4500]
console.log(f.filter(x=>x.t>=5400&&x.t<5700).length);            // 1231 帧
'
# → 窗列表 [0,900,1800,2700,3600,4500]；被排除的尾部窗若强行取有 1231 帧 ≫ minFrames=100
```

- **残窗确实由循环边界 `s + sizeSec <= T + 1` 排除**：`s=5400` 时 `5700 > 5646+1`，
  残窗进不了循环——与 `minFrames` 无关（1231 帧远高于 100）。注释正确。
- **minFrames 确实只是数据缺口安全网**：在真实 game1/game2 上逐窗实测帧数**全部为 1500**
  （满窗），minFrames 从未触发：

```
game1: T=5800.2 cuttable windows=[0:1500, 900:1500, …, 5400:1500]
game2: T=5646.2 cuttable windows=[0:1500, 900:1500, …, 4500:1500]
```

注释「当前真实数据上从未触发，纯防御」属实。**注释描述与代码行为一致。**

### 2.4 基线 JSON 只变 sha256 一行

```bash
git diff 6b00a0d~1 6b00a0d -- viewer/data/benchmark-baseline.json
# 唯一 hunk：metricsModule.sha256 3b9c627d… → 0a6ef660…
```

语义比对（把 sha256 归一化后 `JSON.stringify` 相等）结果 **`identical after normalizing sha256: true`**
——**数字逐项不变**。

### 2.5 文档数字一致性（逐项 diff 基线 JSON）

以基线为准逐项核对：

| 文档 | 紧凑度真实区间 | 其余数字 | 结论 |
|---|---|---|---|
| `README.md:68`（本轮修复点） | `15.2m [10.7–17.2]` ✅ | hd 25.2/39.6 +57%；gap 8.3/15.1 +82%；ad 26.2/38.9 0.4m；spread +31% | ✅ 一致 |
| `design.md:91` D3 | `15.2m (10.7–17.2)` ✅ | hd/gap/ad 全部一致；`:101` 修正说明 15.30→15.24、19.83→19.98 ✅ | ✅ 一致 |
| `design.md:154` D5 LOO 表 | `[14.0, 17.2]`（**game1 单场**范围，非基线） | 亲跑复算 game1 区间 `[14.0, 17.2]`，game2 落入 **5/6**；gap 6/6；hd 3/6 | ✅ 一致 |
| `design.md:170-171` D5 | — | 引擎 32.1–47.6 / 真实 16.2–29.6、余量 2.6m、均值差 57% | ✅ 一致 |
| `tasks.md:53` P3.2 | — | 25.2 vs 39.6（+57%）、+31%、+82% | ✅ 一致 |
| `tasks.md:37` P2.1 | — | 体积 `~11KB`（实测 `10778` 字节） | ✅ 一致 |

> 特别核实：D5 表的 `[14.0, 17.2]` 与 README/D3 的 `[10.7–17.2]` **不是同一个量**——
> 前者是 **game1 单场**的观测范围（留一交叉验证的「拿 game1 查 game2」），后者是
> **两场合计 13 窗**的基线范围。亲跑 `cutWindows+windowMetrics` 复算 game1 得
> `[14.0, 17.2]`，与文档逐字一致，**不存在漂移**。

### 2.6 index.html 版本号

```bash
git diff 6b00a0d~1 6b00a0d -- viewer/index.html
# -<script type="module" src="./app.js?v=20260918-12"></script>
# +<script type="module" src="./app.js?v=20260918-13"></script>
```

已 bump（本轮改了 `viewer/match-metrics.js`）。

### 2.7 全套件 + 对比工具

```bash
cd viewer  && node --test *.test.js    # # tests 376 / # pass 376 / # fail 0 / # skipped 0
cd tools   && node --test *.test.mjs   # # tests 452 / # pass 452 / # fail 0 / # skipped 0
node tools/benchmark-compare.mjs       # EXIT=0，正常出报告
```

**计数自洽**：第一轮 tools 为 445；本轮新增 `benchmark-baseline.test.mjs` 5 条 +
`benchmark-compare.test.mjs` 2 条 = **452**（`node --test benchmark-baseline.test.mjs` = 5）。
`benchmark-baseline.test.mjs` 确实被 `*.test.mjs` glob 收录。

---

## 3. 新发现的盲区（C 部分）

### P2（新，注释笔误，非行为错误）测试注释把「剔除门将后的最近者」写成 id11，实测为 id16

- **文件**：`viewer/match-metrics.test.js:275`
- **注释原文**：「若剔除门将 → 最近者变成客队 **id11**（3.045m）→ 结论反转」
- **实测**（独立复算该构造帧，逐人距离）：

```
id 16 dist 3.0450   ← 真正最近的非门将
id 15 dist 3.3349
id 17 dist 3.3349
...
id 11 dist 7.4506   ← 注释写的 id11，实为最远
```

- **性质**：**距离值 3.045m 引用正确，但 id 写错**（3.045m 是 id16 的，id11 是 7.45m）。
  断言 `assert.ok(nearestNonKeeper.id >= 11 && nearestNonKeeper.d > 3)` **本身正确**
  （id16 ≥ 11、3.045 > 3），不影响守护有效性——M5 实测变红即证。纯注释准确性问题，
  与第一轮 P2-4「注释陈义」同类。
- **建议修法（非阻断）**：`:275` 的 `客队 id11（3.045m）` 改为 `客队 id16（3.045m）`。

### 其余盲区探测（额外变异，结论：无新守护缺口）

| 额外变异 | 结果 | 评价 |
|---|---|---|
| `teamShape` 主客队 id 过滤互换（`<=10`↔`>=11`） | **红** 10 条（#1,2,4,5,6,8,15,16,19,29） | 守护充分 |
| `possessionN` 只在主队时自增 | **红** #9 | 新断言有效 |
| `minFrames` 判定 `>` → `>=`（边界 100 帧） | **绿** | 仅在「恰好 100 帧」时有别，真实数据/构造输入都不落此点；属**极窄边界**，且该常量的语义是「远少于 300s×5Hz 的短窗」——边界取开/闭无实质影响。**不构成 P1/P2**，记录备查 |

**未发现修复引入的新不一致**（注释↔实现、测试↔文档均经上述核查一致）。

---

## 4. 问题清单（按严重度）

| 级别 | 项 | 状态 |
|---|---|---|
| **P0** | 无 | — |
| **P1** | 无（A 部分 7/7 变红，守护全部生效） | — |
| **P2** | 测试注释笔误：`match-metrics.test.js:275` 的最近非门将 id 写 `id11`，实测 `id16`（距离 3.045m 正确） | 建议随下一笔修，非阻断 |

---

## 5. 最终判定

**通过。**

- 第一轮的 2 条 P1（README 旧值、spread 配对 bug 无守护）均已修复并被验证：
  README 区间已对齐基线；spread 守护经复变异（M1）**必红**。
- 第一轮的 7 条 P2 全部落地：invalid 跳过路径、指标取值断言（gap/ad/possessionHome）、
  门将空转断言、cutWindows 注释与安网用例、T+1 容差用例、入库基线哨兵、design 审阅记录
  注记——逐项实测有效。
- 新断言非同义反复（手算复核 5 组期望值全部独立复现）。
- 唯一新问题为 1 条 P2 注释笔误（id11→id16），不影响任何断言与产物，**不阻断收尾**。

报告写完时仓库与 `6b00a0d` 逐字节一致，唯一新增文件为本报告。
