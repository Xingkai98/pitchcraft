# Spec: event-stream-protocol

## ADDED Requirements

### Requirement: 5Hz beat 与连续运动语义

beat 节拍事件 SHALL 每 `BEAT_DT=0.2s` 输出一次（不含不产 beat 的死球/重开准备窗口）；`movers` SHALL 描述该 0.2s 内的连续运动端点，并 SHALL 保持 `from(N+1) == to(N)` 的跨拍连续性。`main` / `ball` 的携带规则 SHALL 显式定义，避免 5Hz 下的重复状态。

#### Scenario: beat 间隔

- **GIVEN** 引擎处于开放比赛
- **WHEN** 连续运行 1s
- **THEN** 相邻 beat 的 `t` 差为 0.2s（重开准备等 spec 例外窗口除外）

#### Scenario: 跨拍端点连续

- **GIVEN** 同一名球员在相邻两个 beat 都有 mover
- **WHEN** 检查两个 mover 的端点
- **THEN** 上一 beat 的 `to_x/to_y` SHALL 等于下一 beat 的 `from_x/from_y`

#### Scenario: 5Hz 不重复 main/ball

- **GIVEN** 一个 `DECISION_DT` 内的 2.5 个 beat
- **WHEN** 没有新的持球/球状态变化
- **THEN** 中间 beat SHALL 只携带 `movers`（或按 spec 定义的显式规则），SHALL NOT 重复完整 `main`/`ball` 状态

### Requirement: 运动段与高亮锚点同语义

`movers` 与高亮参与者的显示段 SHALL 使用同一 `BEAT_DT` 时间语义；tackle 高亮时长 SHALL 保持一个决策拍（`DECISION_DT`），SHALL NOT 因 beat 改 5Hz 而缩短。

#### Scenario: tackle 高亮不缩短

- **GIVEN** 一次 tackle 在高亮起点 `T` 触发
- **WHEN** beat 改为 0.2s
- **THEN** tackle 高亮仍覆盖 `[T, T+DECISION_DT)`，松散球不提前出现

#### Scenario: 高亮滑行与 mover 同拍

- **GIVEN** 一名接球者在高亮期滑向落点
- **WHEN** 同一拍有队友 mover
- **THEN** 分离/避让约束 SHALL 使用同一 `BEAT_DT` 子段，不得用 1s 或 `SIM_DT` 的另一套时间
