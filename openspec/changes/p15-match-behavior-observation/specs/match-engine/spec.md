## ADDED Requirements

### Requirement: 可选比赛行为观察 sidecar

引擎 SHALL 提供一个 opt-in 的比赛行为观察接口，在不改变 `simulate()` 正式事件流、随机数消耗和比赛决策的前提下，输出独立的 `DiagnosticMatch` sidecar。观察事实 SHALL 在生产状态提交点记录，不得通过事件文本或最终状态事后猜测。

#### Scenario: 观察器关闭时保持现有行为
- **WHEN** 使用现有 `simulate(seed, config)` 运行同一场比赛
- **THEN** 返回值、正式事件流、事件顺序和 RNG 行为与加入本 change 前完全一致

#### Scenario: 观察器开启时不改变正式事件
- **WHEN** 使用同一 seed/config 分别运行普通模拟和带行为观察的模拟
- **THEN** 两次正式事件流完全相同，且 sidecar 只包含额外的观察事实

### Requirement: 控制权与重开生命周期可闭合

行为观察 SHALL 区分 `PossessionEpisode`、`Contested` 和 `RestartSequence`。`pass lost`、拦截、抢断成功和射门出手不得单独等价为对手已获得控制；明确 pickup/控制提交前 SHALL 保持争抢或飞行状态。所有正常死球重开 SHALL 遵循 `dead_ball_started → restart_preparation_started → restart_taken → open_play_resumed`，半场和终场为明确例外。

#### Scenario: 丢球先进入争抢
- **WHEN** 传球结果确认丢失且生产状态尚未提交新的 carrier
- **THEN** 旧 episode 记录 `control_released`，观察状态进入 `Contested`，不得立即创建对手的 `PossessionEpisode`

#### Scenario: 松散球 pickup 后建立新控制
- **WHEN** `advance_loose` 提交某队新的 carrier/possession
- **THEN** 争抢关闭，并以该队为 team 开启新的 `PossessionEpisode`

#### Scenario: 射门结果决定控制结局
- **WHEN** 射门进入 finalize
- **THEN** goal、saved caught、saved rebound、off target/out 分别按结果关闭 episode、进入控制/争抢或创建重开 sequence，不在 shot emit 时提前决定结局

#### Scenario: 死球重开只在开放控制确认后开启 episode
- **WHEN** 定位球已经 taken 但尚未提交首次明确控制
- **THEN** 只记录 `RestartSequence` 与 `BallInFlight`，首次明确控制前不得把定位球 delivery 伪装成普通 possession phase

### Requirement: 不确定事实显式降级

观察器遇到未覆盖或矛盾的状态输入 SHALL 记录 `observation_gap` 及 provenance，且不得为了闭合统计而猜测 team、carrier、restart kind 或时间。

#### Scenario: 未知重开归属
- **WHEN** 出界结果不足以确定最后触球方或重开类型
- **THEN** `RestartSequence` 保留 `unknown` 归属/类型和事实来源，并继续等待可确认的状态提交，不推断具体球队

#### Scenario: 哨声中断未完成飞行
- **WHEN** 半场或终场哨声在 `BallInFlight` 或未完成重开期间提交
- **THEN** 记录独立的 `observation_gap`，并使用 `half_time` 或 `full_time` 结束原因关闭当前观察对象
