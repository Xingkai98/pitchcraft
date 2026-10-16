# 真实侧样本扩容：2 场 → 22 场（SkillCorner opendata 20 场）

**日期**：2026-10-16 · 基线 `50b2c8a` · 执行者：主 session（机械活，零发挥）
**目的**：双盲判别测试 3 裁判全 24/24 判对，但真实侧只有 2 场 Metrica ⇒ 无法排除
「裁判其实认出了那两场」。本文件交付 20 场 SkillCorner，把真实侧扩到 22 场。
**状态**：✅ 20/20 全部转换成功、全部通过 schema 消费验收、**与 P37 基线逐字节复现**。

---

## 0. 一句话结论

**真实侧现在有 22 场可直接用于面板与判别测试**（Metrica 2 场 + SkillCorner 20 场），
其中 SkillCorner 20 场共 **139 个 300 s 窗**、**439 437 帧**、产出 **425.0 MB**，
原始件 **1.8 GB**，全流程耗时约 **3.5 分钟**。

⚠️ **一个必须带进面板的差异**：SkillCorner 的 **primary 口径（跳外推点）每窗只有 113–1060
个可用帧（均值 466 / nominal 1500，即可用率 8–71%）**，而 Metrica 侧是 1500/1500。
面板若要在 SkillCorner 上算逐帧类判据（P1/P5），**真实侧可用的帧数只有 Metrica 侧的 1/13 – 1/1.4（均值 1/3.2）**；这不是数据缺陷，是「外推点默认不进主口径」这条既有口径在该数据集上的直接后果。
详见 §5。

---

## 1. 配方（实际执行的命令，可复跑）

> ⚠️ **`tools/fetch-tracking-data.mjs` 第一步有竞态 bug，本脚本裸跑必失败**（见 §4 异常 A）。
> 该文件禁止修改（源码指纹哨兵），故按下面的绕法执行：**第 1 步手工铺骨架，第 2 步照跑脚本**。

```bash
# ── 1) 骨架（脚本这一步坏了，手工等价替代；URL 与脚本内 SKILLCORNER_TARBALL 完全一致）──
mkdir -p .scratch/tracking-data/skillcorner
curl -sSL -o .scratch/tracking-data/skillcorner/opendata.tar.gz \
  "https://codeload.github.com/SkillCorner/opendata/tar.gz/refs/heads/master"
tar xzf .scratch/tracking-data/skillcorner/opendata.tar.gz -C .scratch/tracking-data/skillcorner
rm -f .scratch/tracking-data/skillcorner/opendata.tar.gz

# ── 2) 20 场 tracking 实体（走脚本；骨架已就位它会跳过坏掉的第一步）──
nohup node tools/fetch-tracking-data.mjs --dataset skillcorner-opendata > /tmp/fetch-skillcorner.log 2>&1 &

# ── 3) 逐场转换（默认 keyframeHz=5，与 Metrica 侧同一输出频率）──
for id in $(node -e "console.log(require('./.scratch/tracking-data/skillcorner/opendata-master/data/matches.json').map(m=>m.id).join(' '))"); do
  node tools/convert-skillcorner-to-frames.mjs \
    --match ".scratch/tracking-data/skillcorner/opendata-master/data/matches/$id/${id}_match.json" \
    --out "viewer/data/skillcorner-$id.json"
done
```

- **输出路径必须匹配 `viewer/data/skillcorner-*.json`**（`tools/benchmark-baseline.mjs:60`
  的 `matchFile: /^skillcorner-.*\.json$/` 靠这个正则认它）。
- 方向自检（`keeperSideCheck`）20/20 通过；`shiftSource` 20/20 取到权威半场边界 `match_periods`。

---

## 2. 逐场表

`300s 窗数`＝ `match-metrics.js` 的 `cutWindows`（300 s 窗 / 900 s 步长、只取完整窗）实际切出的窗数。
`外推点%`＝ `meta.coverage.extrapolatedPointPct`（坐标层 `is_detected !== true` 的点占比）。

| id | 队名（主 vs 客） | 球场尺寸 | 帧数 | keyframeHz | 300s 窗数 | 文件大小 | 12s 刺激窗数 | 外推点% |
|---|---|---|---|---|---|---|---|---|
| 1874553 | Brisbane Roar FC vs Adelaide United Football Club | 105×68 | 22122 | 5 | 7 | 21.42 MB | 2506 | 42.06 |
| 1886347 | Auckland FC vs Newcastle United Jets FC | 104×68 | 21729 | 5 | 7 | 20.8 MB | 2455 | 40.71 |
| 1899585 | Auckland FC vs Wellington Phoenix FC | 104×68 | 20341 | 5 | 7 | 19.55 MB | 2513 | 44.81 |
| 1925299 | Brisbane Roar FC vs Perth Glory Football Club | 105×68 | 23971 | 5 | 7 | 23.11 MB | 2549 | 42.11 |
| 1927964 | Western Sydney Wanderers FC vs Wellington Phoenix FC | 105×68 | 22380 | 5 | 7 | 21.55 MB | 2454 | 38.55 |
| 1953632 | Central Coast Mariners Football Club vs Melbourne City FC | 105×68 | 21956 | 5 | 7 | 21.22 MB | 2462 | 37.89 |
| 1959846 | Melbourne Victory Football Club vs Western United | 106×68 | 21370 | 5 | 7 | 20.8 MB | 2429 | 42.96 |
| 1986691 | Western Sydney Wanderers FC vs Auckland FC | 105×68 | 21538 | 5 | 7 | 20.89 MB | 2455 | 41.17 |
| 1996435 | Sydney Football Club vs Adelaide United Football Club | 105×68 | 21766 | 5 | 7 | 20.94 MB | 2395 | 34.21 |
| 1996436 | Auckland FC vs Macarthur FC | 104×68 | 21533 | 5 | 7 | 20.72 MB | 2500 | 44.6 |
| 2006229 | Melbourne City FC vs Macarthur FC | 105×68 | 22086 | 5 | 7 | 21.26 MB | 2464 | 37.08 |
| 2006363 | Melbourne Victory Football Club vs Central Coast Mariners Football Club | 106×68 | 22174 | 5 | 7 | 21.55 MB | 2456 | 47.01 |
| 2007448 | Perth Glory Football Club vs Brisbane Roar FC | 105×68 | 22142 | 5 | 7 | 21.47 MB | 2414 | 46.04 |
| 2007721 | Auckland FC vs Central Coast Mariners Football Club | 104×68 | 23149 | 5 | 7 | 22.2 MB | 2390 | 40.42 |
| 2010085 | Melbourne City FC vs Central Coast Mariners Football Club | 106×68 | 22761 | 5 | 7 | 22.06 MB | 2453 | 44.64 |
| 2011166 | Wellington Phoenix FC vs Melbourne Victory Football Club | 105×68 | 19508 | 5 | 7 | 18.91 MB | 2465 | 47.57 |
| 2013725 | Western United vs Sydney Football Club | 106×68 | 22496 | 5 | **6** | 21.9 MB | 2360 | 46.04 |
| 2015213 | Western United vs Auckland FC | 106×68 | 24271 | 5 | 7 | 23.67 MB | 2491 | 47.46 |
| 2016236 | Western United vs Adelaide United Football Club | 106×68 | 21942 | 5 | 7 | 21.4 MB | 2495 | 50.9 |
| 2017461 | Melbourne Victory Football Club vs Auckland FC | 105×68 | 20202 | 5 | 7 | 19.58 MB | 2430 | 48.85 |
| **合计 20** | — | — | **439 437** | 5 | **139** | **425.0 MB** | **49 136** | 34.2–50.9（区间） |

补充事实（逐场核过，非估计）：
- **联赛/赛季**：澳超（A-League）2024/25，比赛日 `2024-11-23` – `2025-05-17`。
- **球场尺寸三种**：105×68（10 场）、104×68（4 场）、106×68（6 场）——转换器**逐场读取**，
  不折算（design D4）。面板/标尺侧必须按逐场尺寸换算回米制。
- **`2013725` 只有 6 个 300 s 窗**：该场拼接后时长 5674.9 s < 7×900+300 = 6600 s，
  第 7 个整窗放不下 ⇒ 由 `cutWindows` 的循环边界正常排除，不是缺帧。
- **`1953632` 的 `status` 是 `not_started`**（其余 19 场 `closed`），但 tracking 数据完整
  （21956 帧 / 7 窗）。转换器按设计原样透传 `status` 且**不据此过滤**，本表如实记录。
- **球缺失率** 0%（`ballMissingPct` 全 0 —— 球位每帧都有，但其中一部分带
  `ballFill: 'extrapolated'`，是外推而非原始观测）。

---

## 3. 总耗时与总占用（实测）

| 阶段 | 耗时 | 说明 |
|---|---|---|
| 骨架（tar.gz 25.7 MB） | ~5 s | 手工替代步骤，`curl` 实测 `time_total=5.1s` |
| tracking 实体 20 场（1.82 GB，6 路并发） | **~84 s** | `18:16:25` 启动 → `18:17:49` 收尾；20 秒时已完成 12/20 |
| 转换 20 场（`convert-skillcorner-to-frames.mjs`） | **~100 s** | 19 场 / 95 s + 首场 / 5.2 s ≈ 5.2 s 每场 |
| **合计** | **≈ 3.5 分钟** | 未触发任何断点续传重试（`TRACKING_MAX_ATTEMPTS` 一轮即过） |

| 占用 | 大小 |
|---|---|
| `.scratch/tracking-data/skillcorner/tracking/`（20 个 `.jsonl` 原始件） | **1.7 GB** |
| `.scratch/tracking-data/skillcorner/opendata-master/`（骨架：`matches.json` + 20 场 `match.json` + LFS 指针） | 105 MB |
| `.scratch/tracking-data/skillcorner/` 小计 | **1.8 GB** |
| `viewer/data/skillcorner-*.json`（20 个转换产物） | **406 MB**（表内 MB 为十进制 MB，合计 425.0 MB） |
| **总计** | **≈ 2.2 GB** |

两者都落在 `.gitignore`（`.scratch/tracking-data/`、`viewer/data/`）——**无一入库**。

---

## 4. 失败 / 异常清单

| # | 项 | 性质 | 处置 |
|---|---|---|---|
| **A** | **`tools/fetch-tracking-data.mjs` 第 1 步（骨架）100% 失败**：`fetchSkillcorner` 里 `curl(SKILLCORNER_TARBALL, tarPath)` 是 **async 函数但未 `await`**（第 144 行），紧接着同步的 `sh('tar', ['xzf', tarPath, ...])`（第 146 行）立刻执行 ⇒ tar 去读一个 curl 还没写完的文件 ⇒ `Cannot open: No such file or directory`。脚本打印「✗ 骨架拉取失败」并 exit 1。 | **脚本 bug（竞态）**，与网络无关（同 URL 手工 `curl` 5.1 s 拿到 200 / 25 681 691 B） | **未修改该文件**（源码指纹哨兵 + 硬约束）⇒ 按 §1 用同一 URL 手工铺骨架，再让脚本跑它的第 2 步（该步的 `curl` 有 `await`，无此问题，实测 20/20 成功）。**建议单独开一个 change 修这个 `await`**——它让「按文档一条命令拉数据」这条路在干净机器上根本走不通。 |
| B | `1953632` 的 `status` 为 `not_started` | 源数据自身状态 | 如实记录，不据它过滤（tracking 完整）。 |
| C | `2013725` 只有 6 个 300 s 窗 | 时长不足，非缺帧 | 如实记录。 |
| D | 逐场 49–80 处「相邻帧间隔 ≠ 0.2 s」 | 转播缺口（回放/特写无 tracking），**非缺陷** | 与转换器自报的 `meta.timeAxis.gaps.count` **逐场精确相等**（62/62、63/63、…、73/73）⇒ 交叉核对通过。 |
| E | `viewer/engine.wasm` 指纹 ≠ committed 基线（`9ea317b2…` vs `574b653f…`） | **既有状况，与本次扩容无关**：工作树里 `engine/src/lib.rs` 本就脏（+213/−42，进本任务前即如此），本地 `engine.wasm` 是从它构建的 | **本任务零引擎改动**（`git diff --stat` 只有那条既有的 `M engine/src/lib.rs`）。仅记录：任何「引擎基线」列仍不能用手上这份 wasm。 |

**转换失败 0 场、schema 消费失败 0 场、方向自检失败 0 场。**

---

## 5. 对面板的影响：「12 s 窗 / 2.4 s 步长」能不能直接用？

**结论：能用，且步长是整数、不需要任何换算。** 但有一条必须写进口径的真实差异。

### 5.1 采样率这一节：能直接用

- SkillCorner 源是 **10 fps**（广播 CV），转换器**下采样到 `keyframeHz = 5`**（时步 0.2 s），
  **与 Metrica 转换器（25 fps → `--keyframe-hz 5`）输出同一个频率**。
- 面板/刺激集的「6 帧横排 / 12 s / 每 2.4 s 一帧」（`p-discrimination-2026-10-15/DESIGN-CLEAN.md:32`）
  在 5 Hz 下就是 **每 12 个 keyframe 取一帧**：`2.4 s × 5 Hz = 12`，整数。
  **换算关系：`下标步长 = 2.4 s × keyframeHz = 12`**；若将来改用别的 keyframeHz，
  该式成立的前提是 `2.4 × keyframeHz` 为整数（10 Hz ⇒ 24，2.5 Hz ⇒ 6，都行）。
- **`t` 是不是 0.2 的整数倍无关紧要**：SkillCorner 的 `t` 是比赛时钟，起点相位任意
  （实测 55% 的帧不在 0.2 s 绝对栅格上，**无害**）。按下标取帧时，实测跨度与 2.4 s 的偏差
  **只在转播缺口处非零**（每场 49–80 处缺口 × 12 个落点），其余为 0。
  这与 Metrica 侧一样，靠既有的**死球窗过滤**处理，不需要新机制。
- 可切出的 12 s 刺激窗数：**每场 2360–2549 个，20 场合计 49 136 个**（远够 12 真样本）。

### 5.2 但 **primary 口径的可用帧率掉到 8–71%**（Métrica 侧是 100%）——这条要写进面板口径

`windowMetrics` 的默认口径（`primary`）**跳过外推点**，且逐帧要求两队各有 ≥7 名非门将、
非外推球员，否则整帧丢弃。SkillCorner 约 **34–51% 的点是外推**，后果实测：

| 数据集 | 每窗可用帧（`okPrimary`） | 全点对照（`okAllPoints`） |
|---|---|---|
| Metrica（13 窗，`real-game-1/2`） | **1500 / 1500**（恒定满窗） | 1500 |
| SkillCorner（139 窗） | **均值 466，min 113，max 1060**（nominal 1500） | 均值 1111 |

⇒ **面板若在 primary 口径上算 SkillCorner**：
- 等效采样率从 5 Hz 掉到 **≈0.4–3.5 Hz**；
- **逐帧类判据（P1 队形方正度、P5 贴身接触）的真实侧样本缩水至 1/13 – 1/1.4（均值 1/3.2）**，
  真实分布的**分位估计会明显变噪**，而引擎侧仍是满帧 ⇒ 「真实 vs 引擎」两侧的
  **有效样本量不可比**。
- 处置建议（**本任务不实施，留给面板重标定**）：要么在 SkillCorner 上也并列报 `allPoints`
  口径（采信外推，均值 1111 帧 ≈ 74%），要么把逐帧判据改成「窗内比率」以免受帧数波动影响。
  ⚠️ 无论选哪条，**两侧必须同一口径**（PLAN §2 的纪律①），且**阈值不得据引擎现状配**。

---

## 6. 独立复核：与 P37 基线逐字节复现

不是「自报成功」，而是**用生产工具重算一遍、与已入库的基线逐字节比对**：

```bash
node tools/benchmark-baseline.mjs --out /tmp/baseline-regen.json
# → datasets.skillcorner 段：逐字节相同 (true, 38461 chars)
# → datasets.metrica   段：逐字节相同 (true)
# → engineFingerprint  ：不同（见 §4 异常 E，既有脏树，与本次无关）
```

即：本次 20 场转换产出的每一个窗指标（`hd/ad/spread/gap/width/ballDist/possession*`、
`frameCount/okPrimary/okAllPoints`）都与 `viewer/data/benchmark-baseline.json` 里
P37 那次生成的 **20 场 / 139 窗完全一致**。⇒ **配方可复跑、产物可复现**。
（Metrica 两场 `real-game-{1,2}.json` 全程未被触碰，其段亦逐字节相同。）

---

## 7. 交付清单

1. `viewer/data/skillcorner-<id>.json` × **20**（gitignore；合计 406 MB）
2. `.scratch/tracking-data/skillcorner/`：`tracking/<id>_tracking_extrapolated.jsonl` × 20（1.7 GB）
   + `opendata-master/`（骨架 105 MB）
3. 本文件 + `PROGRESS.md`（逐场一行）
4. 探针（**用完即删，不入库**）：`/tmp/probe-skillcorner.mjs`、`/tmp/probe-skillcorner-wins.mjs`
   —— 逐场跑 `fromTrackingFrame` → `cutWindows` → `windowMetrics`，全 20 场 0 错误。
