# Spec: match-audit

## ADDED Requirements

### Requirement: 整场滑窗门逐窗复用静态索引，且结果与逐窗重建逐位一致

`tools/spacing-sweep*.mjs`（同队间距整场滑窗门）SHALL 对**每个 seed 只构造一次**播放器的静态索引
（与窗时刻无关的锚点时间线 / 时间索引 / 每事件结束时刻），并在该 seed 的**全部窗口**上复用。
逐窗 SHALL 仍独立构造播放器对象并独立 `seekTo`——SHALL NOT 跨窗复用播放器的可变状态
（球员位置、球位置、播放时刻）。

复用后，逐窗 `captureObservation` 的观测包（含 `audit_input`、`viewer_snapshot`、窗口事件、
lineup）与 detector 的产出（finding 集合、顺序、`features.min_distance`）SHALL 与逐窗重建**逐位
相同**；窗口数、每 seed 汇总与进程退出码语义 SHALL 不变。

SHALL NOT 为提速改动 `DUR`、`STEP`、默认 seed 集、detector 阈值或 audit profile；SHALL NOT 修改
`engine/`；SHALL NOT 抬高 CI `timeout-minutes` 或拆分 job。

#### Scenario: 复用索引与逐窗重建逐位一致

- **WHEN** 对同一 seed 的同一组窗口分别以「复用静态索引」与「每窗重建」跑采集 + detector
- **THEN** 每个窗口的观测包与 detector 输出逐位相同，每 seed 的 finding 数、最恶劣间距与窗口数相同

#### Scenario: 缓存失效条件被守卫

- **WHEN** 静态索引与本次构造的 `(events, lineup, mode)` 不同源
- **THEN** 报错（fail-loud），不得静默产出「看起来正常但错」的位置与 finding

#### Scenario: 「生产路径确实在复用索引」必须可断言

- **WHEN** 扫描的索引构造被替换为测试注入实现
- **THEN** 每个 seed 的索引**恰好构造一次**（不是每窗一次），且注入实现返回的对象**确实**被窗口
  构造消费——即把这份结果摘掉或退回每窗重算时，守护测试必须**变红**（「两条路径等价」这条判据
  对「优化被摘掉」不可观测，故 SHALL NOT 只靠它）

#### Scenario: 判据面未被放宽

- **WHEN** 复用索引的改动落地
- **THEN** `DUR=5400` / `STEP=2.5` / 默认 seed 集 / detector 阈值 / audit profile 逐字未变，
  窗口数与退出码语义不变
