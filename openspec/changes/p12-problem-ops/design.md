# P12 Problem Ops — Design

## Goals / Non-Goals

**Goals:**

- 删除：问题可删除（幂等、确认后执行），误建/废弃数据可清理。
- 重跑：同一 bundle 重新诊断（引擎修改后验证同一观察），结果回写到同一 Problem。
- 批量导入：历史 diagnosed 任务一键转 Problem（去重）。

**Non-Goals:**

- 重跑的历史版本对比（每次重跑覆盖 report，decisions 里保留 rerun 轨迹；版本 diff 后续做）。
- 删除的撤销/回收站。
- 导入的增量同步（导入是一次性操作）。

## 端点设计

### DELETE /problems/:id

- 删除 `<tasks-dir>/problems/<id>.json`；不存在 → 404；成功 → 200 `{ok:true}`。
- 幂等语义：重复删除第二次 404（文件已删）。页面删除按钮带 confirm 确认。

### POST /problems/:id/rerun

- 读取 problem.source.task_id 对应的 `<tasksDir>/<task_id>.bundle.json`；无 bundle → 400 `{error:'no bundle for rerun'}`。
- 生成新 runId，异步执行 `runDiagnosis({bundlePath, auditPath, replayInstructions, sourceRevision, tasksDir, runId, env})`（与 POST /observations 相同后台模式，先落 bundle 再 202）。
- 立即响应 `202 { task_id: newRunId }`，并把 problem 的 `source.task_id` 更新为新 runId（decisions 追加 `{action:'rerun', by, at, reason}`）；诊断终态后页面刷新 problem 详情拿到新 report。
- 语义：重跑期间 problem.source.task_id 指向新任务，页面轮询 `GET /tasks/:id`（既有端点）看进度；旧报告在终态后被覆盖。
- 并发：同一 problem 重复触发 rerun 允许（各自独立 task），MVP 不做互斥。

### POST /problems/import

- body 可选 `{ task_ids: [...] }`；缺省 = 扫描 `<tasksDir>/*.task.json` 中 status=diagnosed 的全部任务。
- 每个任务：若已有 Problem 的 source.task_id 指向它 → 跳过（计入 skipped）；否则按 POST /problems {task_id} 的同一逻辑创建（标题/描述/triage 来自报告）。
- 返回 `{ created: [...ids], skipped: [...task_ids], failed: [{task_id, error}] }`。
- 校验：task_id 白名单（TASK_ID_RE），body 大小上限复用。

## viewer

- 详情动作面板：加「重跑诊断」（rerun → 轮询 GET /tasks/:id → 终态刷新详情）与「删除」（confirm() → DELETE → 刷新列表）。
- 问题列表页顶部加「导入历史任务」按钮（POST /problems/import → 刷新列表，显示 created/skipped 摘要）。
- 全部 textContent + redactText；cache-busting bump。

## 切片

1. **Slice 1**：`tools/problems.mjs` 加 `deleteProblem`/`importProblems` 纯逻辑 + 服务端三端点 + 测试（fake child / fake runDiagnosis）。
2. **Slice 2**：viewer 按钮与接线（重跑轮询/删除确认/导入入口）+ cache-busting + 测试 + docs。

## Risks / Trade-offs

- [重跑覆盖旧报告] → decisions 保留 rerun 轨迹，MVP 接受；版本对比后续做。
- [导入重复] → 按 task_id 去重（已关联跳过）。
- [删除不可恢复] → 页面 confirm 确认；文件系统删除（无回收站），文档明示。
