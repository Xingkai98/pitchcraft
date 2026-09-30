## ADDED Requirements

### Requirement: 诊断器只读，且不改变比赛生成

诊断器 SHALL 只消费 `simulate_with_behavior_observations()` 返回的公开 `DiagnosticMatch`，
**SHALL NOT** 新增生产 API、修改 `engine/src/`、或改动跑位/决策、RNG、正式事件流协议。

#### Scenario: 正式路径与 opt-in 路径事件流逐字节相同
- **WHEN** 同一 seed 分别走 `simulate()` 与 `simulate_with_behavior_observations()`
- **THEN** 两条路径产出的正式事件流**逐字节相同**

#### Scenario: 生成逻辑零改动有守卫
- **WHEN** 检查本 change 的 diff
- **THEN** `engine/src/` 无改动；若确需改动，须另开 change 并自带 gate

### Requirement: 每条结论必须标注证据性质与落点

报告的每条结论 SHALL 标注其**性质**（`观测` / `派生`）与**落点**（产生它的公开字段名）。
**SHALL NOT** 把机制假设写成结论。

理由：本项目反复出现「doc 声称的机制，代码里不存在」这一族缺陷
（见 `.scratch/notes/17b-recon-2026-09-30.md` 记录的两处**读码推断被实测推翻**）。
诊断器若声称能解释它看不见的东西，就是该族缺陷的新实例。

#### Scenario: 结论带落点
- **WHEN** 报告输出任一条归因
- **THEN** 该条附带产生它的公开字段路径（如 `control_fact.source_event_index`）

#### Scenario: 证据性质可审计
- **WHEN** 任一条结论被标为 `观测` 或 `派生`
- **THEN** 其落点字段确实存在于 `observation` 模块的**公开**类型上（有守卫扫描）

#### Scenario: 假设不冒充结论
- **WHEN** 报告出现因果性文字（「因为…所以…」）
- **THEN** 它必须位于显式标为「机制假设（未验证）」的段落，并附「验证它需要什么」

### Requirement: 不得用区域或坐标冒充战术相位

报告 SHALL NOT 出现 `Phase` 词或其成员名（`build_up` / `progression` / `final_third` /
`attacking_transition`）。
「转换」一类归因 SHALL 以**事件级**取值表达（`EpisodeStartReason` / `EpisodeEndReason` /
`ContestStartReason`）。

理由：`#16`（空间特征）与 `#124`（意图观测）已**双双**判定 `build_up`/`progression` 不可判——
phase 判据目前没有可用的观测依据。

#### Scenario: 措辞有守卫
- **WHEN** 有人把 phase 词写进报告生成代码或产物模板
- **THEN** 至少一条测试变红（源码扫描守卫，须对变异有判别力）

#### Scenario: 事件级转换可报
- **WHEN** 一段 possession 以争抢收束
- **THEN** 报告给出 `ContestStartReason` 的闭集取值与对应事件下标

### Requirement: 报告展开到单个 possession，且可回放定位

报告 SHALL 为每个 possession episode 产出可定位的记录，含开始/结束原因、动作链、以及
**可回放的坐标**（seed / 时间 / episode id / 事件下标）。

#### Scenario: 定位可回到事件流
- **WHEN** 给定一条诊断记录的 `(seed, event_index)`
- **THEN** 它能定位到该 seed 事件流中的确定事件，且时间自洽

#### Scenario: 覆盖 P17A 点名的异常样本
- **WHEN** 报告在 P17A 的固定 seed 集上运行
- **THEN** P17A 触发的异常规则各自都能找到对应的逐 episode 样本

### Requirement: 缺证据时显式 unknown，不猜

当某条归因所需的观测不存在或不适用时，报告 SHALL 记 `unknown` 并写明缺失原因，
**SHALL NOT** 用代理量冒充。

#### Scenario: 缺失分类
- **WHEN** 某量不可得（如传球选择集）
- **THEN** 报告标注 `unknown` 与原因，且该条不计入聚合的分子/分母

#### Scenario: 已知不可得项被如实声明
- **WHEN** 报告文档描述其能力
- **THEN** 它列出结构性不可得项（战术相位 / 传球选择集 / 射门 hazard）

#### Scenario: 覆盖缺口必须按成因分别声明
- **WHEN** 报告描述「丢球后追逐过程」的可答性
- **THEN** 它**按 `ContestStartReason` 逐项**声明该成因是否可答，**SHALL NOT** 给出笼统的
  「可答」；对不可见的成因（如 `interception_loose`）显式记「**追逐不可见**」而非留空

#### Scenario: 覆盖缺口有守卫
- **WHEN** 有成因未被显式声明覆盖
- **THEN** 至少一条测试变红（不得只靠文档描述）

### Requirement: 松散球判据必须排除重开准备期

诊断器识别「松散球」时 SHALL **排除重开准备期**（`RestartSequence` 的 `[start_t, taken_t)`），
因为该期间球钉在发球点、并非比赛中的松散球。

#### Scenario: 判据排除准备期
- **WHEN** 统计松散球时段或追球者
- **THEN** 处于重开准备期窗口内的 beat **不被计入**

#### Scenario: 判据有守卫
- **WHEN** 有人去掉排除条件（用裸 `beat.ball.loose`）
- **THEN** 至少一条测试变红（该变异须被判红，不得静默通过）

### Requirement: 动作归因不得把「追人」当作「追球」

报告使用 `Mover.action` 做「谁在追球」的归因时，SHALL 区分 `chase`（靶点恒为球）
与 `close_down`（靶点按 `TransitionSource` 分流，`SaveCaught` 时是**前插球员**）。

#### Scenario: 分类而非并称
- **WHEN** 报告列出「追球者」
- **THEN** 它不把 `chase` 与 `close_down` 混为同一类，且 `close_down` 标注其靶点来源

### Requirement: 不产生通过/失败判定

报告 SHALL 只输出诊断与聚合数字，**SHALL NOT** 产生 pass/fail 或「好/坏」标签。

#### Scenario: 报告不阻断
- **WHEN** 报告工具运行
- **THEN** 它不以非零退出码表达结论；行为门留给 `#18`

### Requirement: 确定性与防空转

同输入两次运行 SHALL 产出逐字节相同的产物；且须有覆盖率下限断言防止「空跑也通过」。

#### Scenario: 逐字节可复现
- **WHEN** 同一 seed 集与配置运行两次
- **THEN** 两份产物逐字节相同

#### Scenario: 防空转下限
- **WHEN** 在真实 seed 上运行
- **THEN** 非空诊断记录的比例高于设定下限（阈值须有理由，不得是 0）

### Requirement: 产物自带口径 provenance

产物 SHALL 记录源码 commit、引擎指纹、口径版本、seed 集与聚合口径（沿用 `#17A`/P16 形态），
使口径不同的两次运行在产物层可区分。

#### Scenario: provenance 可区分口径
- **WHEN** 口径常量变化后重跑
- **THEN** 产物 provenance 与旧产物可区分，且对比工具能识别陈旧
