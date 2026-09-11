# diagnosis-runner Specification

## Purpose
TBD - created by archiving change p14-observation-queue-only. Update Purpose after archive.
## Requirements
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

### Requirement: 验证套件可在远端 CI 自动运行

仓库 SHALL 提供远端 CI 配置（GitHub Actions），使 `verify.sh` 的分层验证（引擎单测、viewer 单测含 DOM 测试、WASM e2e、真实性统计套件）在 push 与 pull request 时自动执行；CI SHALL 自行编译 WASM 引擎产物（`viewer/engine.wasm` 不入库）并安装 Node 依赖后再运行验证。

#### Scenario: push 触发完整验证
- **GIVEN** 仓库含 `.github/workflows/ci.yml`
- **WHEN** 任意分支 push
- **THEN** CI 检出代码、编译 WASM、`npm ci` 安装 devDependency、运行 `./verify.sh` 全套并全绿

#### Scenario: pull request 触发完整验证
- **GIVEN** 一个 pull request
- **WHEN** PR 创建或更新
- **THEN** 同一套 CI 验证在合入前执行，失败即标记 PR 未通过

### Requirement: runner 支持提案模式与确认

诊断 runner SHALL 支持「提案模式」：读 bundle 产出候选事件 index 集合与锚点漂移提示，只提案不诊断；SHALL 支持按任务 id 写确认（事件 index 集合）；诊断阶段 SHALL 以确认的事件集合为锚点输入。

#### Scenario: 提案模式只产出候选不诊断
- **GIVEN** 一个 captured 观察任务
- **WHEN** 以提案模式运行
- **THEN** 任务状态转为 `awaiting_confirmation`，写 proposal（event_indexes/candidates/drift_hints），且不执行诊断

#### Scenario: 无 provider 回退为空提案
- **GIVEN** 提案模式运行但 provider 不可用
- **WHEN** 运行提案
- **THEN** proposal.source 为 fallback-empty，状态仍 awaiting_confirmation

#### Scenario: 确认写任务并供诊断使用
- **GIVEN** 一个 awaiting_confirmation 任务
- **WHEN** 客户端提交确认（event_indexes 集合）
- **THEN** 任务状态转为 confirmed，confirmation.event_indexes 持久化，后续诊断以该集合为锚点

