# 立项期探针（P37）

2026-09-18 立项侦察时真的下载并解析了数据（**不是照抄 issue/调研报告**）。
本目录归档当时的脚本，让 `design.md` 里的数字可复现。

## 前置：数据

```bash
# 仓库骨架（含 match.json / matches.json，~25.7 MB）
curl -sSL -o /tmp/sc/opendata.tar.gz \
  "https://codeload.github.com/SkillCorner/opendata/tar.gz/refs/heads/master"
mkdir -p /tmp/sc && tar xzf /tmp/sc/opendata.tar.gz -C /tmp/sc

# 单场 tracking 实体（LFS；分支必须是 master）
curl -sSL -o /tmp/sc/tracking/1874553_tracking.jsonl \
  "https://media.githubusercontent.com/media/SkillCorner/opendata/master/data/matches/1874553/1874553_tracking_extrapolated.jsonl"
```

`analyze*.py` 里的路径常量（`BASE = '/tmp/sc-probe'`）按上面目录调整。

## probe1-corpus-and-identity.py

核对语料规模与**身份映射**——issue 已警示的坑，实测复核：

- 有 `player_data` 的帧 44,244 / 60,301（73.4%）；每帧恒定 22 条
- tracking 的 `player_id` ∩ `match.json.players[].id` = **32/32**
- tracking 的 `player_id` ∩ `players[].trackable_object` = **0**（用错字段会 0% 匹配）
- `is_detected`：真检测 **57.9%**，每帧真检测中位数 **14**/22
- 坐标范围（米，中心原点）确认；球有坐标帧中真检测 82.3%

## probe2-timeline-and-extrapolation.py

两个**立项期新发现**（issue 与调研报告都未记录）+ 外推口径的定量影响：

- **半场时钟回跳**：frame 28919 `00:48:10.90` → frame 29000 `00:45:00.00`（回跳 190.90s）；
  P2 平移 +190.90s 后时间轴严格单调
- **时间缺口**：拼接后仍有 61 处正向间隙，最大 143.0s，合计 1599.0s（约全长的 27%）
- **球场尺寸**：见 `probe1` 之外的 `matches.json` 扫描——20 场里 104/105/106 各 5/10/5 场
- **外推口径是一阶影响**（7 个 900s 窗）：

  | 口径 | 纵深 | 紧凑度 | 重心间距 | 可用帧 |
  |---|---|---|---|---|
  | 全点 | 20.5–28.8 m | 12.8–16.1 m | 5.9–6.8 m | 100% |
  | 仅真检测 | 12.6–17.5 m | 10.5–14.4 m | 3.9–5.3 m | 45% |

  纵深差 ~7 m（约 40%），与 P36 测出的"引擎 vs 真实差 14m"同一量级。
  → 口径选错会直接掩盖或放大要找的信号（design D2）。

## ⚠️ 已知不一致（独立审阅 P3-2 发现，2026-09-18）

**两支探针用的时间轴不同，而 design 引用的数字混用了两者**：

- `probe1-corpus-and-identity.py`（= 当时的 `analyze.py`）**没有实现半场平移**——
  P1/P2 的时间戳直接叠在一起，于是 300s 窗最多收 1853 帧（5Hz 的物理上限是 1500）。
  design D2 的「每窗 236–**932** 帧」正是这个 bug 的产物。
- `probe2-timeline-and-extrapolation.py`（= `analyze2.py`）**实现了平移**，同一窗是 552。

按 D3 要求的拼接口径，真实范围是 **236–552**。design 已在审阅修订中订正。
「可复现」是本目录的承诺——两支脚本内部不自洽会让这个承诺失效，故在此显式标注。

**对照表：design 的哪个数字出自哪支**（便于复核）：

| design 数字 | 出自 | 备注 |
|---|---|---|
| 帧数 60,301 / 有球员数据 44,244 | probe1 §时间轴 | 一致 |
| `player_id`↔`players[].id` 32/32、`trackable_object` 交集 0 | probe1 §身份 | 一致 |
| 真检测 57.9%、中位数 14/22 | probe1 | 一致 |
| 球真检测 82.3%（有坐标帧） | probe1 | 一致 |
| 半场回跳 190.9s、单调性 | probe2 | 一致 |
| 缺口 61 处 / 最大 143s / 合计 1599s | probe2 | 一致 |
| 逐窗指标范围（20.5–28.8 / 12.6–17.5 等） | probe2 | 一致 |
| 每窗可用帧「236–932」 | **probe1（未平移，有 bug）** | 已订正为 236–552 |
| 仅真检测 gap 上界「5.3m」 | 两支都对不上 | 已订正为 6.6m |

## 未归档的临时分析

单场逐窗的中间输出（表格）已摘录进 `design.md`；脚本本身是一次性分析，
不追求可复用，故只归档能复现**关键结论**的两支。
