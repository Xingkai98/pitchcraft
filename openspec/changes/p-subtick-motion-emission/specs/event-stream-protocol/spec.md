## ADDED Requirements

### Requirement: 亚拍运动采样事件（move）

引擎 SHALL 在相邻两个 `beat` 事件之间发射确定性的亚拍运动采样事件 `move`，用于画面层的连续运动呈现；
`move` SHALL NOT 改变 `beat` 的 1 Hz 决策节拍、RNG 消费、`st.pos` 拍边界语义或任何判据读数。

- `move` 字段：`{ "type": "move", "t": <秒>, "positions": [[id, x, y], ...] }`；
- `t` SHALL 严格位于相邻两个 beat 的 `t` 之间；`positions` SHALL 覆盖全部 22 人（含门将，id 0/21）；
- 坐标 SHALL 与既有事件字段同口径（归一化 0..1，x 左门线→右门线，y 下边线→上边线）；
- 每个 tick 发射的采样数 SHALL 由 `MOTION_SAMPLES_PER_TICK` 决定（默认 5，含 0 表示关闭）；
- 采样 SHALL 只依赖拍边界位置与上一拍速度状态（零 RNG）；同 seed 同配置 SHALL 产生同一条流。

#### Scenario: 采样不改变决策与判据

- **GIVEN** 同一 seed 与 config
- **THEN** 开启 `move` 发射前后，`beat` 事件序列、`st.pos` 拍边界、L1/P38/P18/ratchet 读数 SHALL 完全一致；
  `move` 事件只增加"拍间位置"，不参与任何决策或统计输入

#### Scenario: 无 move 时向后兼容

- **GIVEN** 一条不含 `move` 的旧事件流
- **THEN** 画面层 SHALL 按既有线性插值渲染，不得报错或改变行为

#### Scenario: 采样坐标与确定性

- **GIVEN** `MOTION_SAMPLES_PER_TICK = 5`
- **THEN** 每个 tick SHALL 发射 4 条 `move`（i=1..4），其 `t` 单调递增且落在该拍区间内；
  同 seed 重跑 SHALL 逐字节一致
