## Why

`#19`（最小生成改造）是本项目**第一次真正改引擎的生成逻辑**（此前 P15A→P18 全是只读分析）。
本轮任务由用户框定为**验证一个假设**：

> **`OPEN_PLAY_PASS_PRESSURE_M` 的硬门「形状」（打分前 early-return）是不是瓶颈？**
> 换成「让连续压迫机制够得着」后，防守方逼近能否与 L1 四带同时成立？

**侦察（实跑）先更正了两件事**（见 `.scratch/notes/19-recon-2026-10-01.md`）：

1. **`map.md` 的头号靶点数字取自已被 #18 撤销的口径**。「防守方起始 61.5 m / 净位移 −1.09 m」
   是 `#18` 探针 `【chase】` 行（过滤 `chase`/`close_down` mover，那些只在**松散球拍**出现）的读数；
   `#18` 自己已把 B1–B3 撤销，理由即「种群不同义」。**直测「持球拍最近防守者到持球者距离」均值
   = 7.79 m**（真实 6.0 m）——**距离量级已接近真实**。
2. **真问题是「有距离、无逼近」**：防守方平均在持球者 7.8 m 处，但只有 **6.3%** 的持球拍存在
   「防守方朝持球者移动」。防守移动是**队形驱动**（奔向 `formation_target`），不是**对手驱动**。
   `#18` 的 **B4**（引擎 5.81% vs 真实 56.09%）抓的正是这个，它是**真信号**。

**代码复核（主 session 指出的关键）**：`OPEN_PLAY_PASS_PRESSURE_M = 8.0`（lib.rs:576）与
`SHOT_PRESSURE_NEAR_M = 8.0`（lib.rs:556）**是同一个数**——射门打分里**本来就有**连续的受压惩罚，
且用同一常量；但开放比赛路径上**硬门在打分之前就 return 了** ⇒ 那套连续机制**结构性够不着**。

**形状探针（实跑）证实了假设**（`.scratch/notes/19-shape-probe-2026-10-01.md`）：
只把压力子句移到射门掷定**之后**（`reorder`）+ 指派最近 1 名防守方以 ~4 m standoff 逼近持球者，
**B4 从 0.0581 → 0.2832（#18 门首次通过）**，**L1 四带在三个标定窗口全过且稳定**
（射门 18.3–18.7），A1/A2/C1 同向改善。**假设成立。**

## What changes

两处**最小**改动（这是「最小生成改造」的落地）：

1. **压力门形状**（`evaluate_open_play_carrier_action`）：把**压力子句**（`nearest ≤ 8`）
   从「出球优先」的 early-return 里**移出**，改到**射门掷定之后**——受压持球者**也**掷
   `open_play_shot_engage_hits`，由 `compute_shot_score` 的**连续 `defensive_pressure` 项**
   决定射门概率。**门将持球与 liveness/停滞子句保持出球优先**（只挪压力子句，一次只改一个变量）。
2. **开放比赛逼抢指派**（`compute_mover_candidates` 的开放比赛分支）：指派**无球队最近 1 名外场**
   以 `standoff` 距离逼近持球者（新常量），复用既有 `close_down_stop` 几何。**纯防守侧**，
   不动持球侧判定。

效果：受压从「**射门不可能**」变成「**射门概率降低**」，从而使防守逼近（B4 上升）与
L1 四带**同时**成立——这是 #19 要交付的「最小改造实验 + 前后对比 + 行为门结果」。

## 与用户框定的一致性

- **不改 L1 带**（四带全过，无需重标）——**这是与 naive press 的关键区别**（后者在任意
  standoff 上都破带）。故**不触发**任务书 §6 的「改 L1 带 = 用户级决定」。
- **不是「挪门」**（改阈值 2/3/4/6/9）——那是已测的死路；本 change 是**改门的形状**。
- **事件流合法改变**：golden / 事件流确定性按 roadmap §6 说明（哪些 golden 需重钉、同 seed 可否复现）。

## 爆炸半径（**如实声明**，见 design §5）

改动使默认 `cargo test` 套件 **4 红**：

| 测试 | 性质 | 处置 |
|---|---|---|
| `v2_highlight_gate_frequency` | 事件量上升（~410 → ~510/场） | 重钉期望值 + 记录依据 |
| `observation::tests::every_episode_and_restart_object_has_event_indexes_or_a_documented_exception` | seed 覆盖失效 | 重钉 seed + 记录 |
| `observation::tests::truncated_stream_produces_a_full_time_gap_by_design` | seed 覆盖失效 | 重钉 seed + 记录 |
| **`p53_same_team_spacing_holds_between_anchors`** | **真不变量破裂**（30 seed 里 ~2 处同队扫掠间距 < 2 m） | **必须修**（design §5 给出候选修法），或收窄 press |

## 不做什么

- **不修 A1/A2**：本 change 的靶点是 **B4**。A1/A2 仍 ~3.4–4.1×（改善 14–16% 但未达标）——
  它们需要动 `advance_action_opportunity` 的机会生命周期（另一条轴，属后续 change）。
- **不动 P15A recorder / `ControlFact` 闭集 / sidecar schema**。
- **不做 phase / 空间特征**（#16/#124 双负，判据不可得）。
