# Design: 观察描述以服务端为权威（刷新自动回填 statement）

## Context

`GET /tasks/:id`（`tools/service.mjs` `readTaskState`）返回白名单 `{task_id, status, errors, report, status_history, failure_kind, findings}`，无 statement。页面 statement 唯一存于 localStorage；`restoreObservationList`（`viewer/app.js:850`，启动时 `:1594` 调用）→ `loadList` 读 localStorage → 对每条有 task_id 的条目 `pollTask`，但 pollTask 只回填 status。

statement 的权威源是 bundle（`readBundle(id)`，`service.mjs:274`）：POST 时写盘、queue-only 与诊断后都保留，runner 也读它。

## Goals / Non-Goals

**Goals:**
- 已提交条目（有 task_id）刷新/轮询时 statement 从服务端 bundle 回填覆盖本地。
- 服务端 statement 为空串时也覆盖为空（正确处理「用户清空的第三条」）。
- 采集未提交条目（无 task_id）保持本地值（服务端无此任务）。

**Non-Goals:**
- 不做「localStorage 清空后从服务端重建整份观察列表」（需 list 端点 + entry 重建，更大的功能）。
- 不改 task.json schema、POST /observations、引擎、协议。
- 不回填 seed / match_time（match_time 本地即对，seed 页面不显示）。

## Decisions

### D1: 服务端 readTaskState 加 statement

- `statement: readBundle(id)?.statement ?? null`，进响应前照旧过 `redactKey`（bundle statement 在 P15 采集/提交时已抹凭证，此处二次兜底）。
- `readBundle` 是 `readTaskState` 同作用域下的 `const`，`readTaskState` 只在请求处理期调用（createService 返回后），届时已初始化，无 TDZ 问题。

### D2: 纯函数 `applyServerStatement(entry, statement)`（observation-list.js，可测）

- 语义：`typeof statement === 'string'`（含 `''`）→ 返回 `{...entry, statement}`；否则（null/undefined，bundle 缺失或旧服务）→ 原样返回 entry。
- 覆盖「第三条清空」：服务端返回 `''` 会覆盖掉本地脏值。

### D3: pollTask 回填

- 在 `pollTask` 的 `updateEntry` patch 里，`typeof data?.statement === 'string'` 时加 `statement: data.statement`。
- 该位置在终态分支 `return` 之前 → 终态条目刷新时同样回填。
- 同时覆盖 `restoreObservationList`（刷新）与提交后的实时轮询两条路径。

## Risks / Trade-offs

- **[服务端 statement 为空 vs 无此字段]**：空串（用户清空）与 null（bundle 缺失/旧服务）语义不同，D2 已区分——空串覆盖、null 保留。
- **[轮询覆盖本地]**：提交后实时轮询会用服务端值覆盖本地刚 `resolveSubmitStatement` 写入的值；两者同源（提交即写 bundle），值一致，无副作用。

## Migration Plan

1. `service.mjs` readTaskState 加 statement + `service.test.mjs` 断言。
2. `observation-list.js` 加 `applyServerStatement` + `observation-list.test.js` 单测。
3. `app.js` pollTask 回填 + `app.test.js`（jsdom harness）刷新恢复回填断言。
4. `index.html` 版本号 bump（改了 JS）。
5. `verify.sh` 全绿 + `openspec validate` + 审阅闭环。
