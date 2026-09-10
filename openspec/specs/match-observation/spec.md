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

