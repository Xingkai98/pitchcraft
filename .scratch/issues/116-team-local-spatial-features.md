# Grill/Research: 团队与局部空间特征（含 phaseability gate）

- Type: research
- Status: resolved（2026-09-29；PR #123 已合入。裁决：**部分够**——见文末「结论」）
- Created: 2026-09-28
- GitHub issue: https://github.com/Xingkai98/pitchcraft/issues/116（`wayfinder:research`）
- Blocked by: `12`（观察契约，已过 grilling）、`13`（可观测性盘点，已完成）
- 关联：#113（`attacking_transition` 已定论）→ 本票 → #15B（判据）→ #17B
- 权威路线：`.scratch/notes/behavior-realism-analysis-roadmap.md` §4.5

## 为什么是现在

#15B 已暂停（#113）：`attacking_transition` 是 team-state 不是 possession phase；
**另三档（`build_up`/`progression`/`final_third`）在 #16 之前没有判据**——
可用信号只有坐标，而契约明禁「把球场区域直接等同为战术阶段」（`map.md:64`）。

⇒ 15B 的目标（把 P17A 的异常钉到战术阶段）**它自己交付不了**。前置是 #16。

## 原始问题（保留）

> 从当前坐标和 beat/off-ball 信息中，第一版可靠计算哪些宽度、纵深、线间距、支援和压力特征？

原候选：球队宽度与纵深 / 球附近局部人数 / 最近防守距离·压力 / 前方与侧后方接应数量 /
支援角度 / 中后场与前场间距代理。

## 本轮新增：面向 phaseability 的特征

原候选是**静态快照**，不足以判定 phase——`build_up ≠ 后场`、`progression ≠ 球向前移动`、
`final_third ≠ 前 1/3`。三档描述**战术意图与推进质量**，不是位置。因此还须产出**带时间关系**的
特征（候选，需验证）：球门向净推进 / 连续动作窗口内的推进·回撤·横向转移 / 线间距变化 /
前方接应与局部人数优势 / 球权开始后的时间序列。

## 验收（**关键**）

**不是「特征算得出来」，而是 phaseability gate**：

1. **特征可靠性**：每条给定义、缺失数据处理规则、300 seed 覆盖情况；算不出的显式标 `unknown`。
2. **可判定性结论**（二选一，都要证据）：
   - **够** → 给出三档各自的可执行谓词（用哪些特征 / 什么时间窗 / 如何不退化成「区域 = 阶段」）；
   - **不够** → 明确缺什么，以及 15B 应保留 `unknown` 还是需补数据/模型。
3. **不得**用区域/坐标冒充战术阶段；若最终只能用几何代理，须命名为证据
   （如 `GoalwardProgressEvidence`），**不得复用 `Phase`**（与 #113 同类处置）。

## 范围边界

- 只做特征与可判定性；**不改跑位/决策逻辑**（原 #16 边界）；
- **不实现 15B**；
- 不改 P15A recorder / 正式事件流 / golden。

## 参考

- `.scratch/notes/behavior-chain-baseline-2026-09-24.md` §4：P17A 明确列出「缺 #16 空间特征」的异常
  （A1/A2/A3/A8 都需「球附近双方人数 / 最近防守距离 / 发球者到球距离 / 22 人宽度纵深」）
- `.scratch/notes/match-behavior-observation-design.md` §11（phase 契约）
- `.scratch/issues/113-15b-phase-mounting-model.md`（#113 完整论证）

## 结论（2026-09-29；PR #123 / merge `5c1c3d7`）

**裁决：部分够。**

| 阶段 | 能否判定 | 证据（`forward_m/s` AUC） |
|---|---|---|
| `final_third` | ✅ 能 | **0.855**（30 seed）/ **0.862**（300 seed） |
| `build_up` / `progression` | ❌ **判不了** | **0.461** / **0.431** |

**强度**：审阅者**自己扫了 21 个空间量**想分开后两档，最强非循环量只 **0.634**
⇒ 是「**空间量本身不足**」，不是「特征没选好」。混淆净化也做了（抽掉「是否重开」0.469 /
抽掉「传球数」0.490 / 空对照 0.500）——**抽掉哪个都没变好**。

**落地**：G1 导出真实位置（每 tick 全量 22 人 → `DiagnosticMatch.state_snapshots`，
**事件流零增量**、不改 `ControlFact` 闭集）；四类时间关系特征；口径以 `ControlFact` 为权威。

**给 15B**：`final_third` 是**几何证据不是战术意图**，须命名为证据
（如 `GoalwardProgressEvidence`），**不得复用 `Phase`**；另两档保留 `unknown`。

**后续**：#124 已接出意图信号并重跑 gate（2026-09-30，PR #127）——**仍不够**。
⇒ 与 #124 合读：**空间与意图两条路都试过、都不够**。

**审阅闭环**：7 轮独立审阅；记录见 `openspec/changes/p16-team-local-spatial-features/REVIEW.md`。
