## ADDED Requirements

### Requirement: 可复现的行为链基线分析器

仓库 SHALL 提供一个编译型分析器，只通过引擎公开 API（`simulate_with_behavior_observations` 与 `observation` 模块公开类型）消费 #15A sidecar，并在**固定 seed 集 × 固定时长**上产出机器可读 JSON 与人可读 Markdown。分析器 SHALL NOT 修改比赛生成、RNG、正式事件流或 viewer 播放行为。

#### Scenario: 默认基线与 canary 两种模式
- **WHEN** 以默认模式运行分析器
- **THEN** baseline 使用 `1..=300` seed × 5400 s，canary 使用 `1..=30` seed × 5400 s，且 canary seed 集是 baseline 的前缀子集

#### Scenario: 产物自带口径
- **WHEN** 任一模式的产物被写出
- **THEN** 顶层 provenance 记录源码 commit、`model_version`、engine crate 版本、sidecar schema 指纹、完整 config、seed 区间与聚合口径版本，使两次不可比的运行能在产物层被识别

#### Scenario: 分析不改变生成
- **WHEN** 分析器运行任意 seed 集
- **THEN** 不产生任何对 `engine/src/` 的依赖变更，且同一 seed 的正式事件流与 `simulate()` 逐字节一致

### Requirement: 四组指标覆盖行为链

分析器 SHALL 计算四组指标：possession 形状（持续时间、动作/传球数、起止原因、射门前链长、按开始原因的结束分布）、控制权转换（争抢时长、原控球队夺回、转换后下一控制方、转换后前 1–3 个动作）、重开质量（重开到首次控制、重开后首个 possession 长度与结束原因、立即丢失/争抢）、动作链 motif（含 `pickup→pass→lost`、`restart→receive→immediate loss`、`control→pass*→shot`、`tackle→loose→original team pickup`）。

#### Scenario: 动作只计决策事件
- **WHEN** 统计某 episode 的动作数
- **THEN** 只计入归属该 episode 的 `pass` / `shot` / `tackle` / `foul` / `kickoff` 事件，`beat` 不计入动作链（`beat` 是每 tick 的位移节拍）

#### Scenario: 条件分布按开始原因分解
- **WHEN** 输出结束原因分布
- **THEN** 同时输出整体分布与按 `start_reason` 条件分解的分布，且 `start_reason` / `end_reason` 闭集成员计数为 0 时也显式输出 0

#### Scenario: 每场先算再聚合
- **WHEN** 输出分位或离散度类指标
- **THEN** 先在单场内计算，再对逐场结果聚合；不得把跨 seed 的原始观测池化后一次计算

### Requirement: 异常模式必须带回放定位与机制假设

报告 SHALL 列出 5–10 条高影响异常模式，每条 SHALL 包含数量证据（含样本量）、可回放定位（seed、比赛时间、episode 或 restart 标识、事件下标）、为什么不像足球、最可能的引擎机制/决策区域，以及缺失的 phase 或空间证据。

#### Scenario: 样本不足时显式降级
- **WHEN** 某条异常规则的分母低于其声明的下限
- **THEN** 该条标记为样本不足并保留在输出中，不得静默省略或当作已确认异常

#### Scenario: 不以场均偏差充当异常
- **WHEN** 一条异常被输出
- **THEN** 它至少给出一条具体动作链证据（seed + 时间 + 对象标识），而不是仅有场均统计偏差

### Requirement: 确定性与防空转

分析器输出 SHALL 对同一输入完全确定；集成测试 SHALL 有快速语义测试与防空转下限，300 seed 基线以显式 `#[ignore]` 方式运行。

#### Scenario: 同输入两次运行逐字节相同
- **WHEN** 用同一 seed 集与同一 config 连续运行两次并序列化
- **THEN** 两次 JSON 输出逐字节相同

#### Scenario: 默认可快速验证
- **WHEN** 运行 `cargo test --test p17a_behavior_chain_baseline`
- **THEN** 语义、确定性与防空转测试在默认路径执行，300 seed 基线不执行
