# P37 实现审阅（独立 subagent，零记忆）

> **审阅区间**：`41cd4e0..267f195`（分支 `p37-skillcorner-corpus/2026-09-18`）。
> **审阅期间 HEAD 移动了 5 次**（实现者并发提交），故按**实际审到的 commit** 分段记录：
> 起始 `937de3d` → `5a53221` → `9513af0` → `ba36b4c` → `8b3ba13` → 终止 `267f195`。
> 所有"仍开放"的结论均在**最终 HEAD `267f195`** 上复核过。

## 1. 审阅范围与我实际跑的命令

```bash
git log --oneline 41cd4e0..267f195 ; git diff --stat 41cd4e0..937de3d
node --test viewer/match-metrics.test.js          # 40 passed（终态）
(cd tools && node --test *.test.mjs)              # 494 passed（终态）
node tools/benchmark-crossvalidation.mjs          # 真实基线，报告项
node tools/benchmark-baseline.mjs                 # 重算：与入库基线逐指标一致
node tools/convert-skillcorner-to-frames.mjs --match .../1874553_match.json --out /tmp/...
```

**变异测试方法**：因实现者并发提交会污染工作树，我在**干净 worktree**（`git worktree add /tmp/p5 267f195`）
上做变异，并复制 gitignored 产物（`real-game-{1,2}.json` / `skillcorner-*.json` / `engine.wasm`）。
判据用**行为层**：`viewer/*.test.js`（排除依赖 jsdom 的 `app.test.js`）+ `tools/*.test.mjs`，
**并排除 `benchmark-baseline.test.mjs` 的 sha256 陈旧性哨兵**——该哨兵对任何字节改动都红
（实测：连**只改注释**都红），对"口径是否被守护"**零区分度**，混进来会把所有变异染红、掩盖空转断言。
每个变异跑完立即 `git checkout --` 还原，并确认还原后套件回到全绿。

**独立复核**：我从 `viewer/data/skillcorner-*.json` **重算了一遍入库基线的全部四项指标**，
与 `benchmark-baseline.json` 逐位一致（hd 18.3071 / ad 18.4488 / spread 12.7573 / gap 5.2357，139 窗）
——基线**可由入库产物复现**，不是手改的。

## 2. 结论摘要

**核心口径实现正确、可收尾**。三条最要害的口径（β 估计量 / 外推默认跳过 / 逐场球场尺寸）
在**终态**都有带反证条的守护，且我用变异逐条验过它们**真的会红**。
数据完整性（20 场字节精确、朝向自检 20/20 通过、`match_periods` 20/20 齐全）无问题。
指标文件头写的插值规则与 `quantileSorted` 实现**逐字一致**，边界（n=1 / 空数组 / p=1）正确。

**但审阅过程中发现 4 条 P1/P2，其中 3 条是实现者在并发会话里**（看到本审阅的中间结论后）
**自行修掉的**，1 条仍开放。截至 `267f195`，**仍有 2 条 P2 + 4 条 P3 开放**——都不阻断口径正确性，
但**P2-1 / P2-2 是"文档与实测数字打架"**，与 README 自己立的"数字以基线文件为唯一来源"直接冲突，
按项目惯例（P36 曾专门修过 README 旧值）应当在合入前修掉。

| 级别 | 条数 | 是否阻断收尾 |
|---|---|---|
| P1 | 2（**均已修复**，见 §3.1） | 否 |
| P2 | 4（2 开放 / 2 已修复） | 否（但应合入前修） |
| P3 | 4（开放） | 否 |

## 3. 问题清单

### 3.1 已在审阅期间修复（我复现 → 实现者修 → 我复验）

| # | 问题 | 证据 | 状态 |
|---|---|---|---|
| **P1-1** | **spec 违规：半场拼接未用 `match_periods` 权威边界**。spec「源数据的时间轴须拼成单调序列」明写 `SHALL 使用源数据自带的权威字段……SHALL NOT 仅依赖观测到的首末帧`；`937de3d` 的实现只用了观测极值 | `grep -rn match_periods tools/ viewer/` = **0 命中**；实测 20 场里 6 场观测极值法与权威边界差 >0.5s（最大 `1996436` **39.1s**），缺口被静默吸收进 shift（正是 spec 禁止的失效模式） | 修于 `ba36b4c`，我复验：`shiftSource` 20/20 = `match_periods` ✓ |
| **P1-2** | **`--from/--to` 裁剪 + 换人时槽位下标错位**：`frameIds[k]` 的下标锚在"裁剪后窗口"，而映射算在"全量帧"上 | 修于 `5a53221`（改为按帧对象 `slotMapFor(f)` 现算），新增回归测试断言每帧恒 22 人 | 已修 ✓ |
| **P2-1** | **`pitchMeters` 全链路无行为守护**。我实测变异：`teamShape` 硬编码 105/68、`fromTrackingFrame` 丢 `pitchMeters`、`windowMetrics` 忽略帧上尺寸——**三个变异行为层全绿**（无测试变红） | 见 §4 的 M7/M12（修复前 GREEN）。数值证据：104m 场地的 hd 差 18.2666 vs 18.0926（≈1%） | 修于 `592b446` + `8b3ba13`，我复验：M7 现 **RED** ✓ |
| **P2-2** | **`possessionProxy` 的外推跳过无守护**：删掉 `if (!includeExtrapolated && isExtrapolated(p)) continue;` 行为层**全绿** | 见 §4 的 M3（修复前 GREEN） | 修于 `592b446`，我复验：M3 现 **RED** ✓ |

> 这 4 条里有 3 条（P2-1 的指标层、P2-2、P1-1 的文档面）是**本审阅先跑出变异证据、
> 实现者随后补的**。我逐条在终态复验，确认不是"补了测试但测试空转"。

### 3.2 仍开放

#### **P2-1（开放）README 数字与（重生成后的）基线不一致：6/12 格对不上**

README 第 81–89 行明写「数字以基线文件为**唯一来源**」，但终态基线上有 6 格的
`[min–max]` 与 README 不同（**全部集中在 min/max，avg 全对**）：

| 指标 | README（第 85–87 行） | 终态基线实测 |
|---|---|---|
| SC 主口径 hd | `18.3m [11.6–24.0]` | `18.3m [11.55–23.95]` |
| SC 全点 hd | `25.8m [17.1–31.1]` | `25.8m [17.05–31.13]` |
| SC 主口径 spread | `12.8m [9.7–16.0]` | `12.8m [9.70–15.95]` |
| SC 全点 spread | `14.8m [11.6–18.2]` | `14.8m [11.55–18.15]` |
| MC spread | `15.2m [10.8–17.2]` | `15.2m [10.75–17.15]` |
| SC 全点 gap | `6.9m [5.2–10.6]` | `6.9m [5.15–10.57]` |

同源问题：README 第 89 行「弹性 Δ 0.8」的实测值是 **0.866**（应作 `0.9`）。

**根因**：README 写于 `937de3d`，而基线在 `9513af0` 与 `ba36b4c` 被**重生成过两次**
（`possessionProxy` 口径修正 + `match_periods` 拼接修正）。数值漂移量都在 0.05–0.1m 量级
（不大），但既然 README 自己声明了"唯一来源"，就该以终态基线为准回填。
**修法**：按 `viewer/data/benchmark-baseline.json` 重抄这 6 格 + 弹性 Δ 三处；
或（更稳）在 README 里改成"以基线文件为准，此处为示意"并删除易漂的 min/max。

#### **P2-2（开放）"接缝贡献 0" 的声明在权威边界口径下已不成立**

| 位置 | 现文 | 实测（终态产物） |
|---|---|---|
| `tools/benchmark-baseline.mjs:304`（硬编码进 `declarations.timeGaps`） | 「……**接缝贡献 0**」 | 20 场接缝间隙**合计 80.5s**（最大 `1996436` = 39.1s） |
| `design.md:8`（审阅修订摘要） | 「接缝 ~190s 间隙是事实错误（实测 **0.00s**）」 | 同上——`0.00s` 是**观测极值法**的产物 |
| `design.md:49-50`（上下文第 3 条） | 「接缝间隙实测 **0.00s**（见 D3）」 | 同上 |

**这是 `ba36b4c` 修复后的"文档滞后"**：D3 正文已在 `267f195` 改写为"缺口如实显形为接缝间隙"，
但**同一份 design 的第 8 行与第 49–50 行仍断言 0.00s**（自相矛盾），
**且基线声明字符串是硬编码在 `benchmark-baseline.mjs` 里的**，重生成基线不会更新它。

**影响**：接缝占比其实只有 **0.26%**（80.5s / 30516s），所以"约 27% 无观测"这个主结论**不受影响**；
错的是归因句"接缝贡献 0"。**修法**：把 `benchmark-baseline.mjs:304` 的 `接缝贡献 0` 改成
"接缝间隙合计约 80s（占 0.26%），其余来自回放/特写"；同步删掉 design.md:8 与 49–50 的 `0.00s`
（D3 正文已是新口径，删残留即可）。

#### **P3-1（开放）`verify.sh` 的 `|| true` 会掩盖交叉验证工具的**真实崩溃**

`verify.sh` 第 8 步 `node tools/benchmark-crossvalidation.mjs || true`。
实测：构造一份结构异常但 JSON 合法的基线（`games[].windows` 是数字数组），工具**抛异常退出 1**，
而 `|| true` 让 verify.sh 照常打印"=== 全部验证通过 ==="、退出 0。
（数字语义上"报告项不阻塞"已经由**工具自身在所有已知缺失路径返回 0** 实现了——
`existsSync` 缺失 / JSON 损坏 / 无 `windowMetrics` 三条路径我都实测过，都干净退出 0。
`|| true` 是冗余的，且**把"未预期崩溃"也一并吞掉**。）
**修法**：去掉 `|| true`，让工具自身保证退出 0（它已经做到了）；若要保留，
至少改成 `|| echo "⚠ 交叉验证工具异常（报告项，不阻塞）"` 以便崩溃可见。

#### **P3-2（开放）`elasticity` 未按逐场尺寸换算，且无守护**

`viewer/match-metrics.js:335` 的 `const pitchMeters = pm || (frames.length ? frames[0].pitchMeters : null);`
若删成 `pm || null`（退回 105/68），**行为层全绿**（M9）。实测影响极小（106m 场地的 Δ 逐窗差 ~0.03m），
且弹性本就是"不作校准目标、报告项"。**修法**：要么补一条反证条（同 `windowMetrics` 的写法），
要么在注释里显式写明"弹性不按逐场尺寸（影响 ~0.03m，可忽略）"——现在是**没说**。

#### **P3-3（开放）转换器与基线的陈旧性没有绑定**

基线只 pin `viewer/match-metrics.js` 的 sha256（`benchmark-baseline.mjs:259`），
**不 pin 转换器**。而转换器是基线的直接输入——`ba36b4c` 改了拼接、基线数字就变了；
若将来有人只改 `tools/convert-skillcorner-to-frames.mjs` 而不重生成基线，
**不会触发任何哨兵**（`benchmark-compare.mjs` 只查指标模块哈希）。这正是 P36 立"陈旧性可检出"要防的事。
**修法**（便宜）：在 `metricsModule` 旁加一个 `converter` 字段（两个转换器的 sha256），
并在 `benchmark-baseline.test.mjs` 里比一次。注意**转换器改动不影响引擎侧与 Metrica 基线**，
所以这是"输入指纹"而非"口径锁"——语义上要写清。

#### **P3-4（开放）`tasks.md` 的 P4 复选框与提交信息不一致**

`937de3d` 的提交信息是「P4.1+P4.2：README / CLAUDE.md 更新」，但 `tasks.md` 里
P4.1/P4.2 仍是 `- [ ]`。审阅时无法从 tasks 判断 P4 到底完成没有。
（P4.4「代码审阅闭环」本就该等**本报告**，未勾是对的。）
**修法**：文档实际完成后勾上 P4.1/P4.2（P4.3 `openspec validate --all --strict` 我实测**16/16 通过**，也可勾）。

## 4. 变异测试实录

**判据**：行为层红 = 有测试真的对"口径被改错"有区分度；绿 = 空转断言（要点名）。
所有变异在 `/tmp/p5`（`git worktree add /tmp/p5 267f195`）上执行，跑完 `git checkout --` 还原。

### 4.1 要害口径（全部 RED ✓）

| # | 变异 | 预期 | 实测 | 变红的测试（节选） |
|---|---|---|---|---|
| M1 | `quantileSpan` 退回 `max-min` | 红 | **RED** | 9 条：米制换算精确值 / 均值聚合 / q10–q90 插值规则 / 瞬时队形 |
| M2 | `teamShape` 默认 `includeExtrapolated = true` | 红 | **RED** | 外推点默认跳过 / 外推守护反证条 |
| M3 | `possessionProxy` 删掉外推跳过行 | 红 | **RED**（修 P2-2 前是 GREEN） | 控球代理也跳过外推点【反证条】 |
| M4 | `possessionProxy` 默认 `includeExtrapolated = true` | 红 | **RED** | 同上 |
| M5 | `isRawBallFrame` 恒 true（外推球位泄漏进主口径） | 红 | **RED** | 球相关主口径只用原始球帧 / ballFill 透传 |
| M6 | `windowMetrics` 的 `allPoints := primary`（不是真第二遍） | 红 | **RED** | 并列输出两口径 |
| M7 | `fromTrackingFrame` 丢 `pitchMeters` | 红 | **RED**（修 P2-1 前是 GREEN） | 基线生成按逐场尺寸换算【反证条】 |
| M10 | `summarizeWindowMetrics` 不跳 null | 红 | **RED** | 跳过 null 窗口并如实报数 |

### 4.2 转换器（全部 RED ✓）

| # | 变异 | 实测 | 变红的测试 |
|---|---|---|---|
| D1 | 球员永不标外推 | **RED** | is_detected=false 写标记 / null 视为外推 |
| D2 | 球永不标外推 | **RED** | 外推球标 `ballFill='extrapolated'` |
| D3 | 球**全部**标外推（假阳性方向） | **RED** | 同上（该测试对两个方向都有区分度 ✓） |
| D4 | `makeNormalizer` 硬编码 105 | **RED** | 按每场尺寸归一（104/105/106 三档） |
| D5 | 朝向永不翻（忽略 `right_to_left`） | **RED** | 朝向翻 x / 门将贴边自检 |
| D6 | 门将改用 `position_group` | **RED** | 6 条（含门将识别、槽位、换人回归） |
| D7 | `stitchTimeline` 不平移 P2 | **RED** | 单调时间轴 |
| — | `match_periods` 优先路径（`5a53221` 后新增） | **RED** | 优先用权威边界 / 无边界时退回观测极值 |

### 4.3 交叉验证（全部 RED ✓——报告项也有牙）

| # | 变异 | 实测 | 变红的测试 |
|---|---|---|---|
| CV1 | `bOutsideA` 写死 0 | **RED** | 落空数与独立算出的期望一致【差分】 |
| CV2 | LOO `outside` 写死 0 | **RED** | 异类场不被其余场容纳 |
| CV3 | 分半按**窗口**而非**场次** | **RED** | 分半按场次 / 落空数差分 |
| CV4 | 分半忽略 seed（写死常数） | **RED** | 冻结种子【反证】：改 seed 则不同 |

### 4.4 空转断言（**点名**——这些变异全绿，说明对应路径无守护）

| # | 变异 | 实测 | 性质 | 影响 |
|---|---|---|---|---|
| **M9** | `elasticity` 忽略帧上 `pitchMeters`（退回 105/68） | **GREEN** | 真·空转 | 影响 ~0.03m；弹性是报告项（P3-2） |
| **M12** | `framePitchMeters` 恒返回 105/68 | **GREEN** | 真·空转 | 106m 场地 ballDist 14.745 vs 14.861（P3-2 同源） |

**两点诚实说明**：
- **M12 我验证过是"真差异"不是"等价变异"**——`framePitchMeters` 被 `frameMetrics`
  的 `ballDist` 用到，我实测 106m 场地上 14.7450 vs 14.8611。但由于守护测试只断言
  `depth`（走 `teamShape` 的 `opts.pitchMeters` 分支），`ballDist` 这一路的尺寸来源**没人守**。
- `benchmark-baseline.mjs` 的 `realGameWindows` 丢 `pitchMeters`（M13）在 `8b3ba13` 后
  已被 `realGameWindows` 反证条守住（我复验为 RED）；`8b3ba13` 之前它是 GREEN。

## 5. 数字自洽抽查（重点 7）

**基线本身**：我从 20 个入库产物**独立重算**了 139 窗的四项指标，与 `benchmark-baseline.json`
**逐位一致**（hd 18.3071 [11.5467–23.9467] / ad 18.4488 / spread 12.7573 / gap 5.2357，n=139）。
基线**可信、可复现**。逐场 `pitchMeters` 实测分布 **104×4 / 105×10 / 106×6**，
与 design 订正后的 **4/10/6** 一致 ✓；逐场 `status` 的 `not_started` 恰 1 场（1953632）✓。

**交叉验证**：README 第 135 行「half-split 落空率 0–8.6%、LOO 2/20 场」——
实测 half-split 逐指标落空率 {1.4%, 0%, 7.1%, 8.7%, 7.1%}（**最大 8.7%**，README 写 8.6%，
差 0.1 个百分点，属基线重生成后的漂移）；LOO **2/20 场**逐指标全对 ✓。

**不一致清单（全部在 §3.2 P2-1）**：README 表格 6/12 格的 min/max + 弹性 Δ 一处。

**其他文档**：CLAUDE.md 第 77–104 行的口径描述与实现一致（q10–q90 / 逐场尺寸 / 外推默认跳过 /
交叉验证报告项 / 105×70 缺省）✓；转换器头注释、`match-metrics.js` 头注释与实现逐条相符 ✓。

## 6. 看过了、没问题的项

- **`quantileSorted` 与头注释逐字一致**：`h=(n−1)p`、`i=floor(h)`、`i+1≥n` 取 `s[n−1]`、
  `n===1` 取该点、空数组 null——我逐个边界手算过（`[0,10]→8`、`[1..10]→7.2`、`[1,2,3],p=1→3`）✓。
- **`quantileSpan` 的 n 不变性**：头注释称"n 效应 trim1 3.09m → q10–q90 1.37m"，
  与 `reviews/probes/p05-findings.md` 的实测表**一字不差**（含"两口径分开标注"的口径纪律）✓。
- **外推标记的 JSON 往返**：坐标第三位 `1` 是 JSON 原生类型，`JSON.parse(JSON.stringify(...))`
  后标记仍在（测试实测）——**正确规避**了初稿"数组自定义属性会静默消失"的坑（审阅 P1-5）✓。
- **球的 `is_detected` 贯通**：转换器写 `ballFill:'extrapolated'` → `isRawBallFrame` 排除 →
  `windowMetrics` 主口径不收 → 该帧的 `possessionProxy` 也不算。三条链路我都读过代码，
  并用 M5/D2/D3 三个变异验过**有区分度** ✓。
- **`windowMetrics` 的 primary/allPoints 是真不同**：不是复制（M6 会红），
  且 `possessionProxy` 确实收到 `includeExtrapolated`（M3 会红）✓。
- **P36 破坏性变更的调用方全部改到位**：`windowMetrics` 从扁平对象改成 `{primary, allPoints}` 后，
  `benchmark-engine.mjs:69`、`benchmark-baseline.mjs:94` 都显式取 `.primary`；
  `benchmark-compare.mjs` 正确读 `datasets{}+primaryDataset` 新结构（并显式拒收旧结构）。
  我 grep 了全部调用点，**无遗漏的静默读错** ✓。
- **`realGameWindows` 的 `durationSec` 口径修正**（审阅 P1-2 的修法 4）已落实：
  改为记 `nominalSec: WINDOW_SIZE_SEC`，不再拿 `frameCount/hz` 当"时长"✓。
- **`windowMetrics` 返回 null 的路径已处理**：`summarizeWindowMetrics` 显式跳过 null 并返回
  `skippedWindows`（M10 有牙）；实测 SkillCorner 139 窗 `skippedWindows = 0` ✓。
- **`resolveTrackingPath` 正确避开 LFS 指针**：实测同目录是 133B 指针时，
  正确解析到 `<root>/tracking/<id>_tracking_extrapolated.jsonl`（90.7MB 实体），
  且"只剩指针时返回指针让调用方报错"的兜底路径存在 ✓。
- **下载的精确字节校验**：20/20 场文件大小与 LFS 指针 `size N` **精确一致**（不是"够大就行"），
  防住了 design 风险节点名的"截断被误判为完整（实测 17/20）" ✓。
- **数据完整性 / 朝向**：20/20 场可转换、`orientationDetected.keeperSideCheck.ok` 全 true、
  `match_periods` 20/20 场两条齐全 ✓。
- **交叉验证按场次分半 + 种子冻结**：`halfSplit` 先 `[...new Set(records.map(r=>r.game))]` 再洗牌，
  窗口跟场走（CV3 有牙）；种子 `20260918` 是冻结常数并写进报告（CV4 有牙）✓。
- **报告项语义落实**：工具返回结构里**没有** `pass`/`fail`/`ok` 判定字段（测试显式守护），
  `verify.sh` 里只打印不判定 ✓（`|| true` 的问题见 P3-1，那是"掩盖崩溃"而非"把报告项变门"）。
- **`openspec validate --all --strict`**：16/16 通过（含 `p37-skillcorner-corpus`）✓。
- **spec 要求与实现对照**：外推标记透传（球员+球）/ JSON 往返形状 / 估计量对 n 的依赖显式处理 /
  逐场尺寸 / 交叉验证报告项——五条我逐条对着 spec 的 Scenario 查过实现，**均落实** ✓。

## 7. 收尾建议

按优先级：

1. **（P2-1）回填 README 的 6 格 min/max + 弹性 Δ**（以终态基线为准）——这是 README 自己的承诺。
2. **（P2-2）改 `benchmark-baseline.mjs:304` 的"接缝贡献 0" + 删 design.md:8/49-50 的 `0.00s` 残留**。
3. **（P3-1）去掉 `verify.sh` 的 `|| true`**（或改成打印告警），让未预期崩溃可见。
4. **（P3-2/P3-3/P3-4）**：补弹性的尺寸反证条（或显式声明不按逐场）、给基线加转换器指纹、
   勾上 tasks.md 的 P4.1–P4.3。

第 1、2 条是**数字/归因与实测打架**，与 P36「README 旧值」那次同类，建议合入前修；
第 3 条是**流程可信度**问题（会让未来的红被静默）；第 4 条是加固，不阻断。
