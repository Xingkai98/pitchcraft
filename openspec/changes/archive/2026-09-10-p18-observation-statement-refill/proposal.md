# Proposal: 观察描述以服务端为权威（刷新自动回填 statement）

## Why

观察描述（statement）当前只有一份「页面本地」的存储：采集时冻结进 `localStorage`（key `p10.observation.list.v1`），提交时 POST 进 bundle。服务端 `GET /tasks/:id` 返回的字段白名单里**没有 statement**，页面刷新后 `restoreObservationList` 只回填 status、从不动 statement。

后果：服务端 bundle 的 statement 是权威（诊断 runner 读它），但页面刷新后显示的是 localStorage 里的旧值——两者割裂。本次 P15 错位修正改的是服务端 bundle，页面却仍显示旧的错位描述，只有手动清 localStorage 才能同步。

本 change 让「已提交（有 task_id）的观察条目」的 statement 以服务端 bundle 为权威：刷新/轮询时自动回填覆盖本地缓存，改任务数据后刷新页面即可看到变化。

## What Changes

- **`tools/service.mjs`**：`readTaskState` 返回体加 `statement` 字段，值来自 `readBundle(id)?.statement`（bundle 是 statement 唯一权威源）。
- **`viewer/observation-list.js`**：新增纯函数 `applyServerStatement(entry, statement)`——仅当服务端返回字符串（含空串）时覆盖，null/undefined 保持本地值。
- **`viewer/app.js`**：`pollTask` 里用 `applyServerStatement` 把服务端 statement 并进 `updateEntry`（同时覆盖「刷新恢复」与「实时轮询」两条路径）。
- **spec 增补**：`match-observation` 加「服务端 statement 权威、刷新回填」需求。

## Capabilities

### Modified Capabilities

- `match-observation`: 已提交观察条目的描述以服务端 bundle 为权威，刷新/轮询自动回填。

## Impact

- `tools/service.mjs` / `tools/service.test.mjs`：statement 字段 + 测试。
- `viewer/observation-list.js` / `viewer/observation-list.test.js`：纯函数 + 单测。
- `viewer/app.js` / `viewer/app.test.js`：pollTask 回填 + jsdom harness 测试（刷新恢复回填）。
- 不碰引擎、协议、POST /observations；不改 task.json schema。
