# Spec: diagnosis-runner

## ADDED Requirements

### Requirement: 服务支持入队模式（queue-only）

本地诊断服务 SHALL 支持 `--queue-only` 旗标：开启后 `POST /observations` SHALL 只校验并持久化 bundle、将任务置为 `captured` 状态并返回 `202 { task_id, queued: true }`，SHALL 不自动启动审计或诊断，SHALL 不读取 provider 凭证。未开启时 SHALL 保持原有「后台自动执行审计与诊断」行为。

#### Scenario: queue-only 提交只入队
- **GIVEN** 服务以 `--queue-only` 启动
- **WHEN** 客户端 POST 一个合法 observation bundle
- **THEN** 返回 `202 { task_id, queued: true }`；`<task_id>.bundle.json` 与 `<task_id>.task.json` 落盘，task 状态为 `captured`；且诊断 provider 未被调用

#### Scenario: queue-only 任务状态可查询
- **GIVEN** queue-only 服务下已入队一个任务
- **WHEN** 客户端 GET `/tasks/:id`
- **THEN** 返回状态 `captured`（无 report、无 errors），供页面显示「已入队」

#### Scenario: 非 queue-only 行为不变
- **GIVEN** 服务未开启 `--queue-only`
- **WHEN** 客户端 POST 一个合法 observation bundle
- **THEN** 返回 `202 { task_id }` 且后台自动执行审计与诊断（原有行为）

### Requirement: 手动取队列任务续跑

诊断 runner SHALL 支持对已存在的 `captured` 任务按同一 `run_id` 续跑，续跑后任务状态从 `captured` 流转到 `auditing → … → diagnosed`，`status_history` SHALL 追加完整流转。

#### Scenario: 按 run_id 续跑 captured 任务
- **GIVEN** 一个 queue-only 入队的 `captured` 任务（`<id>.bundle.json` 已落盘）
- **WHEN** 以 `runId = <id>` 调用诊断 runner
- **THEN** 复用该 id，重新执行审计与诊断，最终 task 状态为终态（`diagnosed`/`insufficient_evidence`/`failed`），`status_history` 含 `captured → auditing → …` 完整记录

### Requirement: runner-cli 支持 --run-id

runner-cli SHALL 接受可选 `--run-id ID` 参数：传入时以该 id 作为 run_id 执行诊断（续跑队列任务）；不传时行为与原来一致（自动生成新 id）。

#### Scenario: runner-cli 传 --run-id
- **GIVEN** 队列中一个 `captured` 任务 `<id>`
- **WHEN** `node tools/runner-cli.mjs --bundle <id>.bundle.json --audit <id>.audit.json --replay "..." --revision <rev> --tasks-dir <dir> --run-id <id>`
- **THEN** 诊断以 run_id = `<id>` 执行并覆盖 `<id>.task.json` 为终态

#### Scenario: runner-cli 不传 --run-id
- **WHEN** 不传 `--run-id`
- **THEN** 行为与现有版本一致（自动生成 run_id）

### Requirement: queue-cli 提供取任务入口

工具 `tools/queue-cli.mjs` SHALL 提供 `list` 与 `run <task-id>` 两个命令，作为用户在 paseo/shell 侧取队列任务的主入口。

#### Scenario: list 列出可取任务
- **GIVEN** 队列目录含 captured 任务与已诊断任务
- **WHEN** `node tools/queue-cli.mjs --tasks-dir DIR list`
- **THEN** 输出仅含可取任务（captured，或失败终态但 status_history 以 captured 开头的可重试任务）；`--all` 时输出全部任务；captured 任务 best-effort 显示其 bundle 的 statement/seed/match_time

#### Scenario: run 自动推导参数续跑
- **GIVEN** 队列中一个 `captured` 任务 `<id>`（`<id>.bundle.json` 已落盘）
- **WHEN** `node tools/queue-cli.mjs --tasks-dir DIR run <id>`
- **THEN** 从存储 bundle 自动推导 bundle/audit 路径、replay 指令与 source revision，以 `--run-id <id>` 调用 runner-cli 执行诊断

#### Scenario: 失败取任务可重试
- **GIVEN** 队列任务 `<id>` 上次取任务失败（终态 `failed`/`provider_unavailable`/`insufficient_evidence`），且其 status_history 以 `captured` 开头
- **WHEN** `node tools/queue-cli.mjs --tasks-dir DIR run <id>`
- **THEN** 接受该任务并按同一 run_id 续跑（不因上次失败而永久消费队列项）

#### Scenario: 不可取任务被拒绝
- **GIVEN** 队列任务 `<id>` 状态为 `diagnosed`（诊断完成）或非 captured 源起的失败
- **WHEN** `node tools/queue-cli.mjs --tasks-dir DIR run <id>`
- **THEN** 拒绝执行并给出非零退出码与原因说明
