# ⚠️ 用户已拍板 —— 进 P2 之前先读这个

> **为什么放在 `reviews/`**：主 session 多次尝试用 `send_agent_prompt` 投递，均返回
> `Agent not found`（paseo 侧无法定位该 agent，已试 7 次）。这个目录是观测到你在轮询的路径，
> 故在此留指针。**不是** grill 产出。

## 决定（用户原话：「按你推荐」）

| # | 决定 |
|---|---|
| Q1 | **3 常量**（方案 ③） |
| Q2 | 射门带锚 **StatsBomb 大五联赛子集 ~21.7**，带 = **`[17, 26]`** ← **不是** `[13,21]` |
| Q3 | 主队进球带 **`[0.85, 1.60]`** |
| Q4 | 角球单场上界 **`≤18`**（但需核实独立依据，否则改 `≤15`） |
| Q5 | **确认** golden-v7 + `MODEL_VERSION` 6→7 |
| Q6 | **确认** 重生成 `viewer/data/benchmark-baseline.json` |

**完整说明（含 Q2 锚点的复核依据、两条待核实项、流程、硬约束）在：**

```
openspec/changes/p104-volume-recalibration/notes/user-confirmation-2026-09-22.md
```

**动手之前请先读那个文件。** 最关键的一点：

⚠️ **Q2 锚点变了**——主 session 独立复核推翻了 design §D7-Q2「两个真实来源冲突/无定论」的表述。
不冲突，是 Metrica 2 场的抽样噪声（StatsBomb 均值 22.37 / sd 7.04；随机抽 2 场均值 ≤17.5 的概率 13.7%；
Metrica 落在第 23 百分位；西甲 115 场 = 21.76 排除赛事构成；`body_part` 100% 完整排除口径 bug）。
复核脚本与结论：`.scratch/anchor-verify/`（含 README）。

**若你已按 `[13,21]` 开始实施，请停下来改成 `[17,26]`。**
