# Tasks: 观察描述以服务端为权威（刷新自动回填 statement）

## P1. 服务端

- [x] P1.1 `tools/service.mjs` `readTaskState` 响应加 `statement: readBundle(id)?.statement ?? null`
- [x] P1.2 `tools/service.test.mjs`：GET /tasks/:id 返回 statement（captured 任务 = bundle statement；statement 空串也返回空串）

## P2. 页面纯函数

- [x] P2.1 `viewer/observation-list.js` 加 `applyServerStatement(entry, statement)`（string 含空串覆盖，null/undefined 保留）
- [x] P2.2 `viewer/observation-list.test.js` 单测（覆盖 / 空串覆盖 / null 保留 / undefined 保留）

## P3. 页面接线

- [x] P3.1 `viewer/app.js` `pollTask` 用 `applyServerStatement` 把服务端 statement 并进 `updateEntry`
- [x] P3.2 `viewer/index.html` 版本号 bump（`?v=` 新值）
- [x] P3.3 `viewer/app.test.js`（jsdom harness）：刷新恢复时 statement 从服务端回填（含覆盖本地旧值、覆盖成空两种）

## P4. 验证收尾

- [x] P4.1 `verify.sh` 全绿（含 tools + viewer 单测）
- [x] P4.2 `npx openspec validate --all --strict` 通过
- [x] P4.3 代码审阅闭环（独立 paseo agent 审阅 → 修复 → 再审阅，直到无遗留问题）
