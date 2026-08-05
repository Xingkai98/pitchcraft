Type: grilling
Status:

## Question

时间推进用哪种模型？
A) 固定 tick（每 1/8s 每个球员决策，仿 FM slice）
B) 事件驱动（next-event，直接算到下一事件）
C) 混合（逻辑 tick 推进 + 决策点触发 + 位置插值）——草案倾向 C

## 背景

这是 D3（见 design.md 第 3.1 节）。权衡：事件密度 vs 实现成本 vs 画面平滑度。
