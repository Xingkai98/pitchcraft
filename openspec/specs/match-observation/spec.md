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

