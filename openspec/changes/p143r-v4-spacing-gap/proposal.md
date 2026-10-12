# Proposal: 高亮结束那一拍的分离视野缝隙（spacing-sweep seed 2，GitHub #149）

## Why

`main`（含 PR #148 / merge `dc86ca1`）的 CI **step 5（`tools/spacing-sweep.mjs`）在 seed 2 红**：
`player_overlap findings=5 worst=1.957m < 2.0m`；其余 7 个默认 seed（42/1/3/7/59/18/94）全 0。
用户 2026-10-12 拍板接受该红并入 #148（当时唯一红），并立票据 **#149** 要求**另立 change 修缝**。

这是「**既存缝隙被本轮流变暴露**」：T3（`highlight_frozen_segs`，commit `f9edf67`）只把高亮
参与者**拍内子段**纳入分离 solver，未覆盖「参与者**到达落点后原地保持**」的那部分轨迹；v4 的
球导向跑位把队友位移拉到 0.45×，把这处缝隙顶过 detector 阈值。

## What Changes

**1. 单一机制改动（`engine/src/lib.rs`，`highlight_frozen_segs` 一处）**

把高亮参与者的**冻结滑行线段**按**窄触发**处理：**仅当**参与者的**落点**真落在某**同队** mover
本拍候选轨迹 `SAME_TEAM_OVERLAP_MIN_M`(2.0m，= detector `player_overlap.min_distance`) 内
（即真会破 detector 阈）时，才按「剩余滑行时长 `t_rem = t_end − t`」改口径：

- **`t_rem < TICK`（严格本拍内完成，有保持段）**：线段退化为**落点一点** `(落点, 落点)`；
- **`TICK < t_rem < 2·TICK`（下一拍内完成）**：线段 = `[lerp(u(t)), 落点]`——终点钉在落点；

**未触发** / `t_rem == TICK`（如抢断：滑行恰好占满整拍、无保持段）/ `t_rem ≥ 2·TICK`：**保持原口径**
（本拍子段 `[lerp(u(t)), lerp(u(t+TICK))]`）。

理由（详见 design §D1/§D2）：传球飞行时长 = 距离 ÷ 事件 RNG 速度，**几乎从不落在拍边界上**；落点
必然落在飞行最后一拍的**拍中**，参与者到达后**原地保持**到下一锚点。旧口径用「均匀拉伸」的
本拍子段算最近点，低估了参与者的实际前进量，solver 判定无冲突（seed 2 实测 solver 口径 2.146m
≥ 阈值），而 viewer 真实显示最近点 1.258m。触发后让**落点**这条「参与者将要占据并保持」的轨迹
进入 ① 扫掠最近点、② 端点检查（逼队友**本拍终点** = 下一拍起点离落点 ≥ 阈值，补上被漏掉的
**跨拍约束**）。**为什么窄触发**：无条件加这条约束会把**贴沿**的 `l3_shot_ratios` 顶破
（design §D2.1 的变体对照表）；收到 detector 真实门 2.0m 后 `l3` 保住（§D4）。

**2. SHALL NOT**：不动任何阈值 / detector 门 / 统计带；不动事件层常数（TACKLE/FOUL/界外球带）；
不动 viewer；不动 `sweep_pair_lateral` 的既有豁免口径。是**新增一条约束**，不是放宽。

## Impact

- 引擎：行为**只在触发缝隙的 seed 上**变——窄触发（真越界 <2.0m 才介入）使 golden 1..10 里
  **只有 seed 2 变**（结构性，见 design §D3）；seed 1、3–10 **逐字节不变**（`zz_churn` 实测
  `slotDiff=0`）。
- 判据：`node tools/spacing-sweep.mjs`（8 seed）归零（本 change 验收核心）。
- golden-v8：seed 2 计数变 → **照规重基线**（design §D3 记 diff）。
- 不涉及 viewer / 协议 / 指标口径 → 基线哨兵、`match-metrics` 无关。

## 关联

- 票据：GitHub #149；承接 `.scratch/notes/p143r-v4-wrapup-2026-10-11.md` §9.6（根因）+ §9.8（建议）。
- ⚠️ **订正 §9.6 的机制描述**：§9.6 称根因是「`sweep_pair_lateral` 对起点已 <2.14m 的 pair 原样
  返回」——**实测不成立**（该 pair 起点距 2.596m ≥ 2.14m，早返回未触发）。真机制见 design §D1。
