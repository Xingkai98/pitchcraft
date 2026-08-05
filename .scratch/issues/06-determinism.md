Type: grilling
Status:

## Question

确定性策略？带标签 RNG 流 + 定点数（可回放、可调试、跨平台一致）vs 允许浮点随机（实现省事）。
回放是硬需求吗——需要"同一场种子比赛可重放/倒带"吗？

## 背景

这是 D6（见 design.md 第 3.6 节）。开源项目（agentic-fc、back-of-the-neural-net）都把确定性当一等约束；事件流本身就是回放数据。
