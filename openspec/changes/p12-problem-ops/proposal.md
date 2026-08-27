## Why

P11 的 Problem 只有创建/流转/讨论/issue 能力，缺少三个日常操作：历史诊断任务无法批量导入（只能逐条手工创建）、问题不能重跑诊断（修改引擎后想验证同一观察是否复现，需手工导出 bundle 再跑 CLI）、问题不能删除（误建/废弃数据无法清理）。本 change 补齐这三个操作闭环。

## What Changes

- `DELETE /problems/:id`：删除 Problem（幂等，不存在返回 404），页面详情面板加"删除"按钮（带确认）。
- `POST /problems/:id/rerun`：读取问题关联任务（source.task_id）的 bundle，异步重新运行诊断（复用 runDiagnosis），返回新 task_id；诊断完成后更新问题的 source.task_id/report 与 updated_at，decisions 追加 `rerun` 记录；页面详情面板加"重跑诊断"按钮并轮询新任务状态。
- `POST /problems/import`：批量把 tasks-dir 中终态 diagnosed 的任务转为 Problem（`task_ids` 可选指定；已有关联 Problem 的任务跳过），返回创建/跳过统计。
- 复用既有 CORS/body 上限/redaction/环境净化约束；viewer cache-busting bump。

## Capabilities

### Modified Capabilities

- `problem-lifecycle`: 增加重跑、删除、批量导入三个操作

## Impact

- `tools/problems.mjs`：`deleteProblem`、`rerunProblem`（重跑语义在 service 层编排）、`importProblems` 相关纯逻辑 + 测试。
- `tools/service.mjs`：三个新端点 + 测试。
- `viewer/app.js` / `viewer/index.html`：详情面板重跑/删除按钮、导入入口（可选按钮）、cache-busting。
- 无新依赖；重跑复用 runDiagnosis（含 bypass/净化/redaction 全链路）。
