# p15-match-behavior-observation

为比赛引擎增加独立的 Match Behavior Observation sidecar，记录控制权、争抢、飞行、死球和重开生命周期，支持后续按真实足球行为而不是单纯统计分布进行验证和改造。

正式设计：`.scratch/notes/match-behavior-observation-design.md`

原型材料：

- `tools/behavior-observer-prototype.mjs`
- `tools/behavior-observer-prototype.test.mjs`

原型只用于语义边界对照和测试夹具，不读取最终 `MatchState`，不作为正式实现或生产数据源。
