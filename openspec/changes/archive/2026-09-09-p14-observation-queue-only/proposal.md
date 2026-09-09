# Proposal: 观察任务入队模式（observation queue-only）

## Why

P10 的本地诊断服务收到 `POST /observations` 后**自动在后台启动 Claude Code 跑诊断**。但实际使用中两个问题：

1. **诊断服务常不可用**（本机没起 service、tailscale 场景下 service 绑 127.0.0.1 页面连不上、容器里没有可用 provider）→ 页面报「本地诊断端点不可用（Failed to fetch），已回退到 CLI」→ 用户只能复制命令行手动跑，体验断裂。
2. **用户希望把「提交观察」与「执行诊断」解耦**：页面只负责采集 + 入队 + 持久化；诊断由用户在 paseo/CLI 侧**随时取任务手动跑**，而不是被页面自动触发绑定。

本 change 给诊断服务加 **queue-only 模式**：`POST /observations` 只校验并落盘 bundle、写入 `captured` 状态任务，**不自动启动诊断**；用户之后用 `queue-cli run <id>`（内部走 `runner-cli --run-id <id>`，新增参数）手动触发同一任务的审计与诊断。取任务走 CLI，不在 service 加 `/run` 端点。

## What Changes

- **`tools/service.mjs`**：新增 `--queue-only` 旗标。开启后 `POST /observations` 不再调用 `runDiagnosis`，改为：校验 bundle → 写 `<id>.bundle.json` → 写 `<id>.task.json`（状态 `captured`、`status_history: [{captured}]`）→ 返回 `202 { task_id, queued: true }`。`GET /tasks/:id` 正常返回 `captured` 状态（页面轮询不报错）。
- **`tools/runner.mjs`**：`runDiagnosis` 已支持传入 `runId`；确认 queue-only 落盘的 `captured` 任务能被续跑覆盖为 `auditing → diagnosed`（含 status_history 追加）。
- **`tools/runner-cli.mjs`**：新增 `--run-id ID` 参数：传入时复用该 runId 续跑（不再 `randomUUID()`），用于「手动取队列里某个 captured 任务跑诊断」。不传时行为不变。
- **`tools/queue-cli.mjs`**（新）：面向用户的取任务入口。`list` 列出可取任务（captured + 失败可重试，best-effort 读 bundle 显示 statement/seed/match_time）；`run <id>` 从存储 bundle 自动推导 bundle/audit/replay/revision 并透传 `--run-id <id>` 续跑。**失败的取任务不永久消费队列项**：失败终态但 status_history 起于 captured 的任务可再次 `run` 重试（复用同 runId）。
- **页面**：队列只有 `captured` 任务时，观察列表显示「已入队，等待处理」，不再误报「诊断失败 / 回退 CLI」（服务在线但 queue-only 时）。
- **spec 增补**：`diagnosis-runner` 加 queue-only 需求；`match-observation` 加「提交后入队等待」场景。

## Capabilities

### New Capabilities

- `diagnosis-runner`: 服务支持 queue-only（入队不自动跑）；runner-cli 支持按 run-id 手动取任务。

### Modified Capabilities

- `match-observation`: 页面提交到 queue-only 服务时任务停在 `captured`，展示「已入队」。

## Impact

- `tools/service.mjs`：`createService` 加 `queueOnly` 选项；`main` 解析 `--queue-only`；POST /observations 分流。
- `tools/runner-cli.mjs`：`--run-id` 参数解析 + 透传。
- `tools/service.test.mjs` / `runner.test.mjs`：queue-only 落盘、续跑、状态流转测试。
- `viewer/observation-list.js` / `viewer/app.js`：captured 状态的展示文案。
- 无新依赖；`--queue-only` 下不读 `ANTHROPIC_API_KEY`、不启动任何 provider。
