## ADDED Requirements

### Requirement: Problem 可删除

系统 SHALL 提供 `DELETE /problems/:id`：删除对应问题文件；不存在 SHALL 返回 404；成功 SHALL 返回 200；页面删除操作 SHALL 先确认。

#### Scenario: 删除已存在问题

- **WHEN** 用户确认删除一个存在的 Problem
- **THEN** 服务端删除其文件并返回 200，列表不再包含该问题

#### Scenario: 删除不存在的问题

- **WHEN** 用户删除一个不存在的 id
- **THEN** 服务端返回 404，不影响其他问题

### Requirement: Problem 可重跑诊断

系统 SHALL 提供 `POST /problems/:id/rerun`：读取问题关联任务的 bundle，异步重新运行诊断（复用 runDiagnosis 全链路），立即返回 `202 {task_id}`；问题 source.task_id 更新为新任务，decisions 追加 `rerun` 记录；诊断终态后页面 SHALL 能刷新拿到新报告。

#### Scenario: 重跑成功

- **WHEN** 用户对有关联 bundle 的问题点击"重跑诊断"
- **THEN** 服务端返回新 task_id，问题关联更新；诊断完成后详情显示新报告，decisions 含 rerun 记录

#### Scenario: 问题无关联 bundle

- **WHEN** 问题的 source.task_id 缺失或对应 bundle 不存在
- **THEN** 服务端返回 400 并说明原因，问题不变

### Requirement: 历史诊断任务可批量导入

系统 SHALL 提供 `POST /problems/import`：body 可选 `task_ids`（缺省扫描全部 diagnosed 任务）；已有关联 Problem 的任务 SHALL 跳过；返回 created/skipped/failed 统计；task_id 校验与 body 上限复用既有约束。

#### Scenario: 批量导入

- **WHEN** 用户导入全部历史 diagnosed 任务（其中一个已存在 Problem）
- **THEN** 已存在的跳过，其余创建为 Problem，返回 created 与 skipped 列表

#### Scenario: 指定任务导入

- **WHEN** 用户传入 `task_ids` 列表
- **THEN** 只导入列表中的 diagnosed 任务，不存在的任务计入 failed
