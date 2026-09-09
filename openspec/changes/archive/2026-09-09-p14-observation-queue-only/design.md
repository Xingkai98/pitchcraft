# Design: 观察任务入队模式（observation queue-only）

## Context

P10 服务 `POST /observations` 当前：写 bundle → 立即 `runDiagnosisFn(...)` 后台跑 → 返回 `202 {task_id}`。诊断自动触发，页面轮询直到终态。

问题：服务不可用或用户希望手动掌控诊断时机时，自动触发是负担。用户要「页面只入队，paseo 侧随时取任务」。

## Goals / Non-Goals

**Goals:**
- `--queue-only` 模式下 POST 只落盘 bundle + `captured` 任务，不自动诊断、不读 API key。
- runner-cli 支持 `--run-id` 续跑队列任务（复用 service 预生成的 id）。
- 页面在 queue-only 服务下正确显示「已入队」，不误报失败。
- 状态流转完整：`captured → auditing → audit_ready → diagnosing → diagnosed`（手动触发后走原 pipeline）。

**Non-Goals:**
- 队列的并发调度/优先级（单用户手动取，不需要）。
- 页面主动「跑队列」按钮（用户明确要 paseo 侧手动取；页面只展示）。
- 改变非 queue-only 模式的现有行为。

## Decisions

### D1: 状态复用 `captured`，不新增 `queued`

- `TASK_STATUSES` 已有 `captured`（页面 `OBSERVATION_STATUSES` 也有）。queue-only 落盘状态用 `captured`，语义 = 「已捕获，待处理」。不引入新词表值，避免污染 status 校验与页面状态机。

### D2: service `--queue-only` 实现

- `createService` 加 `queueOnly = false` 选项。
- POST /observations 分支：校验 → 写 bundle → 若 `queueOnly`：写 `<id>.task.json`（`status: captured`，`status_history: [{status:'captured', at}]`，无 report/errors），返回 `202 {task_id, queued:true}`；否则原逻辑（自动跑）。
- `GET /tasks/:id` 需能读「只有 bundle 无 audit/raw」的 captured 任务：`readTaskState` 在 task 文件存在时直接返回（已支持——task 文件是权威状态）。确认 captured 不触发「auditing 兜底」误判。
- `main` 解析 `--queue-only` 透传；usage 补一行。
- queue-only 下不 `loadDotEnv` 强依赖 ANTHROPIC_API_KEY（本来 createService 就不强制，runDiagnosis 才需要）。

### D3: runner-cli `--run-id`

- `runner-cli.mjs` 加 `--run-id ID`（可选）。传入时 `runDiagnosis({ ..., runId })`。
- runDiagnosis 已支持 runId；它内部会重写 task 文件（auditing 起始覆盖 captured）并追加 status_history。**确认**：runDiagnosis 开头 `status: 'auditing'` 无条件覆盖——captured 任务被续跑后正确进入 auditing。
- 不传 run-id 时行为完全不变（向后兼容）。

### D4: 页面 captured 展示

- `observation-list.js` 状态词表已有 `captured`。确认其 label/描述：captured → 「已入队，等待处理」（若当前文案是别的如「已捕获」，保留或微调）。
- 页面轮询 queue-only 任务：`GET /tasks/:id` 返回 captured → 展示「已入队」非「失败」；终态前不报「回退 CLI」。
- 现有「服务离线回退 CLI」逻辑只在 fetch 失败时触发，captured 是成功响应，不触发回退。核对。

### D5: 手动取任务 = `tools/queue-cli.mjs`（用户 paseo/CLI 侧）

新增 `tools/queue-cli.mjs` 作为取任务入口（比裸 runner-cli 拼路径友好）：

```bash
# 列出可取任务（captured + 失败可重试；best-effort 读 bundle 显示 statement/seed/match_time）
node tools/queue-cli.mjs --tasks-dir <dir> list          # 加 --all 含全部

# 取任务跑（自动推导 bundle/audit/replay/revision，透传 --run-id <id>）
node tools/queue-cli.mjs --tasks-dir <dir> run <task-id> [--provider ...] [--permission ...]
```

**可重试语义**（D5a）：`run` 接受 `captured` 任务，也接受「失败终态（`failed`/`provider_unavailable`/`insufficient_evidence`）但 `status_history[0].status === 'captured'`」的任务——取任务失败不永久消费队列项，用户可再次 `run` 同一 id 续跑。诊断完成（`diagnosed`）或非入队源起（全新跑失败）的任务不可取。

**实现**：`buildRunArgs({tasksDir, taskId, bundle, opts, runnerCliPath})` 为纯函数（可测）；`runnerCliPath` 默认用本文件所在 tools/ 目录的 runner-cli.mjs 绝对路径（`import.meta.url` 推导），queue-cli 从任意 cwd 运行都能 spawn 到正确脚本。

## Risks / Trade-offs

- **[captured 任务缺 audit 文件]**：GET /tasks/:id 或续跑前 audit 文件不存在。缓解：readTaskState 以 task.json 为权威（audit 缺失时 report 为空）；续跑时 runDiagnosis 重新生成 audit。
- **[续跑 id 冲突]**：同一 run-id 跑两次 → 第二次覆盖。缓解：单用户手动，幂等可接受；runner 每次重写 task 文件。
- **[页面误报]**：captured 可能被现有「非终态显示 auditing」逻辑误标。缓解：pollTask 加 silent 模式——captured 条目轮询失败/超时不置 sync_error、不误报回退 CLI；观察到任务进入活动态后退出静默。
- **[失败取任务消费队列项]**：缓解见 D5a——失败可重试，不永久消费。

## Migration Plan

1. `runner.mjs` 确认 runId 续跑覆盖 captured（status_history 前置）。
2. `service.mjs` queueOnly 选项 + POST 分流 + main/usage（写盘 try/catch 防孤儿 bundle）。
3. `runner-cli.mjs` `--run-id`。
4. `tools/queue-cli.mjs`：list（读 bundle 补信息）+ run（buildRunArgs 绝对路径 + 可重试）。
5. 页面 observation-list/app captured 展示 + pollTask silent 模式。
6. 测试：service queue-only 落盘 + 手动续跑全链路；runner-cli --run-id；queue-cli isRerunnable/buildRunArgs。
7. 验证 + 审阅闭环。

## Open Questions

- ~~runner-cli 是否加 `--from-bundle <id>`~~：已解决——用独立 `tools/queue-cli.mjs` 做取任务入口（自动推导路径 + list），比给 runner-cli 加参数更清晰。
- 页面要不要在 captured 时也提供「复制取任务命令」按钮？——可选，先不做。
