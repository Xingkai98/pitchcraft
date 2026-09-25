## Why

当前真实性校准主要比较事件统计分布，无法回答一场比赛中的控制权如何建立、丢失、争抢、重开和重新进入开放比赛。仅调统计量可能得到“分布正确但行为不像足球”的结果。

## What changes

- 在 Rust engine 内增加 opt-in 的 `BehaviorObservationRecorder`。
- 从生产状态提交点记录只读 `ControlFact`，生成 `DiagnosticMatch` sidecar。
- 定义 `PossessionEpisode` 与 `RestartSequence`，区分开放比赛控制和死球重开。
- 保持 `simulate()`、正式 `Event` 协议、viewer 播放和 RNG 行为不变。
- 先交付 #15A 控制权/重开观察；#15B phase annotator 在此基础上单独实现。

## Non-goals

- 不重定义 `MatchState.possession`。
- 不从事件文本事后猜测控制权。
- 不在本 change 内修改比赛决策、调参或 viewer 正式协议。
