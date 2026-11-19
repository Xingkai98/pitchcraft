# Spec: match-measurement

## ADDED Requirements

### Requirement: 冻结刺激集必须自带可复现身份

测量 SHALL 使用一份显式的冻结刺激集，并 SHALL 在其中记录：引擎源码与 `viewer/` 源码的 SHA256、`MODEL_VERSION`、`TICK_SECONDS`、wasm 的构建方式、每个 seed 的完整事件流 SHA256、窗口 `(t0, t1, 采样率, 相位)`、真实数据清单与许可、以及缺数据处理。

#### Scenario: 冻结刺激集可被独立重建

- **WHEN** 另一会话拿到 `notes/stimulus.json` 与同一源码树
- **THEN** 它能用同一 seed/窗口重建出逐位相同的事件流与窗口切片，并复现 `windows.sha256`

#### Scenario: 源不一致时拒绝拼表

- **WHEN** 两份读数来自不同 wasm、不同源码 SHA 或不同窗口相位
- **THEN** 报告 SHALL 拒绝把它们合并成同一张对照表，并明确标出源差异

### Requirement: 渲染消融必须在同一事件流上分离 viewer 贡献

消融 SHALL 对同一批事件流/窗口分别用至少 `linear`、`catmull`、`t1`、`direct`、`current` 五种渲染路径出帧，并 SHALL 对每种路径报告同窗的 `turn120`（旧与条件）、`staticFrac`、路径长度、速度分位、加速度尾部与曲率。

#### Scenario: 同流消融可复现

- **WHEN** 用同一 `notes/stimulus.json` 连续运行两次消融
- **THEN** 两次输出的逐窗特征值与图 `sha256` 完全一致

#### Scenario: viewer 贡献必须给区间或明确不可分解

- **WHEN** 报告 `turn120` 或 `staticFrac` 的 viewer 贡献
- **THEN** SHALL 给出逐窗配对差的区间（或明确写「不可分解」及缺什么），SHALL NOT 只给单点百分比或把历史转述当本次复测

### Requirement: 运动指标必须同时报告旧口径与条件口径

`turn120` SHALL 保留旧口径（零步也计角）作历史对照，并 SHALL 新增条件口径：仅当相邻两步的步速都 ≥0.5 m/s 时计入转向。报告 SHALL 并列给出旧/条件 `turn120`、有效步数、每有效步转向率、每米路径转向率，以及 0.3/0.5/1.0 m/s 三档门限的敏感性。

#### Scenario: 零步不被计成大角转向

- **WHEN** 一名球员先以 ≥0.5 m/s 向左移动、随后一帧静止、再以 ≥0.5 m/s 继续向左
- **THEN** 条件 `turn120` 不计入该两次转向；旧 `turn120` 仍计入，且两列都出现在报告中

#### Scenario: 条件口径带有效步数

- **WHEN** 报告任一条件转向率
- **THEN** 同时给出有效步数（双方步速均 ≥ 门限的步数）与每有效步分母，SHALL NOT 只给一个无分母的比值

### Requirement: 静止与球静止必须分解到来源类别

报告 SHALL 把 `staticFrac` 与 `ballStaticFrac` 分解到至少以下来源：`carrier_hold`、`carrier_dribble`、`highlight_flight`、`loose`、`restart/dead`，并 SHALL 给出每类的时间权重、条件静止率与对总静止的贡献。

#### Scenario: 球静止不再只归因于 carrier hold

- **WHEN** 报告 `ballStaticFrac`
- **THEN** 报告 SHALL 给出五类来源的分解，且不得把 `CARRIER_HOLD_PP=45` 直接当作全场 hold 率或静止率

#### Scenario: 旧比例不可跨版本套用

- **WHEN** 引用 R2 或更早的静止构成比例
- **THEN** 报告 SHALL 标明该比例属于旧 1 Hz/旧树，不得直接作为 main 2Hz 的 current 值

### Requirement: L1 带必须逐条标注来源与性质

L1 带审计 SHALL 对 `engine/tests/realism.rs` 中每条带或比率给出：测试名/断言、当前值（实测或注明转述）、真实锚与出处、性质（`真实拟合` / `护栏` / `未验证`）、宽度来源、贴沿风险。

#### Scenario: 未验证的带不得被当真实锚

- **WHEN** 审计一条没有可核真实出处的带
- **THEN** 其性质 SHALL 标为 `未验证`，且报告 SHALL NOT 用它来证明引擎「已经贴近真实」

#### Scenario: 护栏带不按中点优化

- **WHEN** 审计角球、界外球、抢断体量等已标为护栏的带
- **THEN** 报告 SHALL 按「防塌缩/爆炸」处理，SHALL NOT 把带中点当真实最优值或优化目标

### Requirement: 守卫分类不得以「放宽」代替「替换脆弱夹具」

守卫审计 SHALL 把守卫分为真不变量、契约型场景守卫、统计/记录门三类，并 SHALL 为脆弱场景守卫给出「显式构造场景 + 条件断言 + 多 seed 置信范围」的替代夹具建议；本 change SHALL NOT 删除或放宽任何既有门。

#### Scenario: 真不变量保留

- **WHEN** 审计确定性、坐标有限、身份合法、事件/状态对账、球权一致等守卫
- **THEN** 它们 SHALL 保留为硬门，不因候选变红而删除

#### Scenario: 脆弱触发夹具可替换但契约不变

- **WHEN** 审计 p53/p31/p6/p32 等依赖固定 seed 或单条事件链的场景守卫
- **THEN** 报告 SHALL 给出替代夹具建议，同时保留原契约（间距、不死锁、双追、拦截概率自洽），且本 change SHALL NOT 实际改门

### Requirement: 测量仪器不得改变比赛行为

本 change SHALL 只改 `tools/`、文档与测试；`git diff -- engine/ viewer/` SHALL 为空，且 SHALL NOT 改 L1/ratchet/detector 阈值。

#### Scenario: 行为零改动

- **WHEN** 在最终树上运行 `git diff --stat main -- engine/ viewer/`
- **THEN** 输出为空

#### Scenario: 旧套件不新增红

- **WHEN** 运行既有 viewer/tools 测试
- **THEN** 失败集与 main 相同，不因本 change 新增红
