# ⚠️ 第 2 轮拍板 —— 进 P2 之前先读这个

> 主 session 的 `send_agent_prompt` 对主 agent 一直返回 `Agent not found`（paseo 寻址故障，已试 13 次），
> 故决定落盘。**本目录是你每轮 poll 必查的路径。**

## 完整说明（必读）

```
openspec/changes/p104-volume-recalibration/notes/user-decision-round2-2026-09-22.md
```

## 三条要点

1. **第 1 轮的射门带 `[17,26]` 作废**（主 session 复现确认：它是照着候选配的，判别力为零，多窗口跌破）。
   新带 = **按真实侧分布推导**：大五子集 mean 21.64 / sd 5.03，±1.5sd → **`[14, 29]`**。
2. **体积方案不再预押**：方案③（3 常量）与 deadline 方案（2 常量）**各做补丁、跑全套门对照后再定**。
   判定原则与对照维度见 round2 文件第二节。
3. **接受 grill 的其余修正**：角球上界 `≤18`→**`≤15`**；抢断带锚 `Duel/Tackle` 37.5（修混口径）；
   补齐 B1 的 4 条漏门；改掉 B3 的角球归因；tasks P5.6 改成「如实记录」而非「不恶化」。

## ⚠️ grill 报告已落盘

`reviews/grill-design.md`（3 BLOCKER + 6 MAJOR + 4 MINOR）——**要逐条回应**，接受或反驳都写理由。

**主 session 已独立复现它最关键的三条**（隔离副本重跑，逐位吻合），这四条**不必再验证、直接采信**：
2 常量读数、候选跨下界、`v2_tackle_frequency` 上界 ≤14、`swarm` 恶化。
