# Grill Design: #53 引擎侧同队间距约束（≥2m）

> batch-grill-me：codex 已标推荐（全 A）。用户已确认。grill 全稿见 `.scratch/issues/53-same-team-spacing-grill.md`。

## 背景（facts，已从代码确认）

- 现象（#35 实测）：同队可贴到 0.11m；窗口同队最小间距 0.54/0.65/1.20m，均 <2m。
- detector `player_overlap` 已存在（P26）：米制 `strict <2.0m`，按同队 pair 聚合。
- 根因①口径分裂：`REPULSION_MIN_DIST=0.02` 归一化，`dist_norm` 无轴向缩放 → x 2.1m / y 1.36m；detector 用米制 → y 方向只保证 1.36m。
- 根因②target 层 ≠ 最终位置：只推目标点 ≤3 次；dead_zone 停者不动。
- 根因③盲区：carrier 不参与；特殊站位目标本身可 <2m。

## Grill 决策树（codex 全 A）

### Q1 间距度量空间
- **A（推荐）米制空间**：保留归一化存储，新增局部米制距离/推开纯函数（dx×105、dy×68），阈值 2.0m+0.05≈2.05m。B（分轴阈值）只有实现成椭圆度量才与 A 等价。风险：余量过大会让角球/禁区/门前过疏散。

### Q2 最终位置保证
- **A（推荐）两阶段**：target 层 repulsion + 最终候选位置分离后处理，但后处理放**写入 st.pos / 构造事件之前**。固定上限确定性迭代 + 终断言。风险：一轮 pair sweep 不保证全局无冲突；边界 clamp01 可能分离不足（需边界感知或记录退化）。

### Q3 盲区覆盖
- **A（推荐）统一兜底**：最终分离覆盖 carrier/门将/全部特殊站位。carrier 随机结果视为已确定候选终点，分离零 RNG、固定遍历顺序；同步 `MainAction.x2/y2`（x/y 保留起点）、`st.pos[carrier]`、`ball_pos`、`carrier_from`、`last_emitted[carrier]`。

### Q4 golden 重基线
- **A（推荐）**：MODEL_VERSION 5→6，新增 golden-v6，保留 v1–v5；legacy 测试扩 v1–v5。风险：新 golden 可能掩盖过大漂移，须人工审查 diff。

### Q5 采样级
- **A（推荐）**：引擎硬门查每 tick 最终发射位置 + detector 继续作 0.5s 采样真实门。不预计算中点推开。风险：非连续时间数学保证；验收必须真跑 detector。

### Q6 流程
- **A（推荐）**：OpenSpec change `p34-same-team-spacing`，validate 后 apply。match-engine 新增同队最终位置 ≥2m requirement。

## User Confirmation（2026-09-15，batch-grill-me）

- Q1–Q6 全按 codex 推荐（全 A）：米制空间 2.05m；两阶段最终位置分离（写前处理）；统一兜底 carrier/门将/特殊站位；golden v6 保留 v1–v5；引擎硬门 + detector 真门；OpenSpec change 立项。

## Open Questions

无。方向已收敛，已立项。
