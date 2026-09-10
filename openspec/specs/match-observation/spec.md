# match-observation Specification

## Purpose
TBD - created by archiving change p14-observation-queue-only. Update Purpose after archive.
## Requirements
### Requirement: 页面提交到 queue-only 服务时正确展示入队状态

当页面 POST bundle 到 queue-only 模式的本地诊断服务时，页面 SHALL 将任务显示为「已入队、等待处理」（状态 `captured`），SHALL 轮询 `GET /tasks/:id` 并在任务转为终态前保持该展示，SHALL 不将 `captured` 误报为「诊断失败」或「回退 CLI」。

#### Scenario: queue-only 任务显示已入队
- **GIVEN** 本地诊断服务以 queue-only 运行，页面提交一个观察
- **THEN** 页面显示该任务状态为「已入队，等待处理」，轮询不报错、不触发回退 CLI

#### Scenario: queue-only 任务刷新后不被误报
- **GIVEN** 一个 queue-only 入队的 `captured` 任务，页面刷新恢复观察列表
- **WHEN** 本地诊断服务不可达，或任务长时间无人手动取
- **THEN** 页面 SHALL 保持「已入队，等待处理」展示，SHALL 不将其误报为「本地诊断端点不可用/回退 CLI」或「等待诊断超时」

#### Scenario: 任务被手动处理后终态回填
- **GIVEN** 一个 queue-only 入队的任务已被用户以 `--run-id` 手动跑完（终态）
- **WHEN** 页面继续轮询
- **THEN** 页面自动渲染诊断报告与 finding 标记（与 P10 终态行为一致）

### Requirement: 观察描述在提交时最终确定

页面 SHALL 在「采集」时以当前输入框内容冻结描述作为初值，并在「提交诊断」时重读输入框：若提交时输入框非空，SHALL 以提交时内容（经凭证形片段抹除）覆盖 bundle 与列表条目的 statement；若提交时输入框为空，SHALL 保留采集时冻结的描述。采集完成后 SHALL 清空描述输入框；提交诊断完成后 SHALL 同样清空描述输入框——两处缺一不可，否则旧描述会泄漏给下一条观察。

#### Scenario: 采集后输入描述，提交时覆盖
- **GIVEN** 用户采集一条观察（采集时描述输入框为空，冻结 statement 为空）
- **WHEN** 用户随后在描述输入框输入「球员射门偏出太多了」并点击「提交诊断」
- **THEN** 提交的 bundle 的 statement 为「球员射门偏出太多了」，列表条目同步显示该描述

#### Scenario: 采集前已输入描述，提交时未改
- **GIVEN** 用户先输入描述「传球时防守队员完全不干扰」再采集观察（冻结该描述），采集后输入框被清空
- **WHEN** 用户直接点击「提交诊断」（不重新输入）
- **THEN** 提交的 bundle 的 statement 保留「传球时防守队员完全不干扰」（不因清空而丢失）

#### Scenario: 采集后清空输入框
- **GIVEN** 用户输入描述并采集观察
- **WHEN** 采集完成
- **THEN** 描述输入框内容被清空，下一条观察不会继承上一条的描述

#### Scenario: 提交后清空输入框
- **GIVEN** 用户采集观察后在描述输入框输入描述并点击「提交诊断」
- **WHEN** 提交完成
- **THEN** 描述输入框内容被清空，下一条观察不会继承刚提交的描述

#### Scenario: 提交时的描述仍抹除凭证形片段
- **GIVEN** 用户采集观察后在描述输入框输入含 `sk-ant-...` 凭证形文本
- **WHEN** 点击「提交诊断」
- **THEN** 提交 bundle 的 statement 中凭证形片段被替换为 `[REDACTED]`

### Requirement: 观察采集/提交的 DOM 行为有自动化测试覆盖

观察采集与提交的清空/覆盖行为（P15 引入）SHALL 有驱动真实 `viewer/app.js` DOM 接线的自动化测试，且随 `verify.sh` / CI 运行——误删或改坏这些接线（采集后清空、提交时覆盖、提交后清空）时测试 SHALL 失败。

#### Scenario: 采集后清空输入框被测试断言
- **GIVEN** 观察采集测试用例
- **WHEN** 驱动真实「采集」按钮监听器
- **THEN** 断言描述输入框内容被清空

#### Scenario: 提交时覆盖描述被测试断言
- **GIVEN** 观察提交测试用例（采集时描述为空，随后输入描述）
- **WHEN** 驱动真实「提交」按钮监听器
- **THEN** 断言提交的 statement 为输入值（经凭证抹除）

#### Scenario: 提交后清空输入框被测试断言
- **GIVEN** 观察提交测试用例（采集后输入描述并提交）
- **WHEN** 提交完成
- **THEN** 断言描述输入框内容被清空

### Requirement: 已提交观察的描述以服务端为权威并自动回填

对于已提交（有 task_id）的观察条目，页面 SHALL 以服务端 bundle 的 statement 为权威：在刷新恢复与任务轮询时 SHALL 用服务端返回的 statement 覆盖本地条目；服务端返回空字符串时 SHALL 覆盖为空；服务端未返回该字段时 SHALL 保持本地值。采集未提交（无 task_id）的条目 SHALL 保持本地值。

#### Scenario: 刷新后从服务端回填描述
- **GIVEN** 一个已提交观察，服务端 bundle statement 为「球员射门偏出太多了」，本地 localStorage 里是 P15 错位修复前的旧描述「传球太慢」
- **WHEN** 页面刷新并轮询该任务
- **THEN** 该条目 statement 显示为「球员射门偏出太多了」

#### Scenario: 服务端空描述覆盖本地脏值
- **GIVEN** 一个已提交观察，服务端 bundle statement 为空字符串，本地存有旧描述
- **WHEN** 页面刷新并轮询该任务
- **THEN** 该条目 statement 被清空（不残留旧描述）

#### Scenario: 服务端未返回 statement 时保持本地值
- **GIVEN** 一个任务响应不含 statement 字段（bundle 缺失或旧服务）
- **WHEN** 页面轮询该任务
- **THEN** 条目 statement 保持不变

#### Scenario: 未提交观察不参与回填
- **GIVEN** 一个采集未提交（无 task_id）的观察条目
- **WHEN** 页面刷新
- **THEN** 该条目 statement 保持本地值（服务端无此任务）

