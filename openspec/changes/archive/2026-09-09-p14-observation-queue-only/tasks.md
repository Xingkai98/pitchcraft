# Tasks: 观察任务入队模式（observation queue-only）

## P1. 后端：service queue-only + runner-cli --run-id

- [x] P1.1 `runner.mjs`：确认/修正 runId 续跑覆盖 captured 任务时 status_history 追加完整流转
- [x] P1.2 `service.mjs` `createService` 加 `queueOnly` 选项：POST /observations 分流（queueOnly → 落盘 bundle + captured task + 返回 `202 {task_id, queued:true}`，不调 runDiagnosis）
- [x] P1.3 `service.mjs` `main`/usage 解析 `--queue-only`
- [x] P1.4 `runner-cli.mjs` 加 `--run-id ID` 可选参数（传入透传 runId，不传不变）
- [x] P1.5 `queue-cli.mjs`（新）：list（best-effort 读 bundle 显示 statement/seed/match_time，`--all` 含全部）+ run（buildRunArgs 纯函数、runner-cli 绝对路径、失败可重试 isRerunnable）
- [x] P1.6 `service.mjs` queue-only captured task 写盘 try/catch + unlink 孤儿 bundle（500）

## P2. 页面：captured 展示

- [x] P2.1 `observation-list.js` 核对 `captured` 状态文案/label（应显示「已入队，等待处理」）
- [x] P2.2 `viewer/app.js`/观察列表：queue-only 服务下 captured 不误报失败/回退 CLI
- [x] P2.3 index.html 版本号 bump

## P3. 测试

- [x] P3.1 `service.test.mjs`：queue-only POST 只入队（fake runDiagnosis 不被调用、task captured、返回 queued:true）
- [x] P3.2 `service.test.mjs`：queue-only GET /tasks/:id 返回 captured
- [x] P3.3 `service.test.mjs`：非 queue-only 行为不变（现有测试保持绿）
- [x] P3.4 `runner.test.mjs` / runner-cli：`--run-id` 续跑 captured → 终态，status_history 完整

## P4. 验证收尾

- [x] P4.1 手动全链路验证：queue-only service → POST 观察 → 页面显示已入队 → runner-cli --run-id 手动跑 → 终态
- [x] P4.2 跑 tools 测试全绿
- [x] P4.3 代码审阅闭环
