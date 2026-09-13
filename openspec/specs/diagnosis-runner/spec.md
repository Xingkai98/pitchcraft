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

### Requirement: detector 出界证据契约认 detail

确定性审计的出界证据 SHALL 优先认定 `detail` 为 `out_sideline` 或 `out_goal_line` 的 pass 事件为出界；SHALL 同时兼容 `result === 'out'` 与落点几何出界作为次要证据分支。真实出界传球（`result:"contested"` + `detail:"out_*"` + 钳制坐标）SHALL 被判定为出界，而非 `unknown`。

#### Scenario: 真实出界传球被判定出界
- **GIVEN** 一个 pass 事件 `result:"contested"`、`detail:"out_sideline"`、坐标在球场内（已钳制）
- **WHEN** 运行审计
- **THEN** 该事件被认定为出界（unforced_out 依据 nearest_defender_distance 产出 finding；pass_outcomes 计入 out_count）

#### Scenario: 兼容旧 result==='out'
- **GIVEN** 一个 pass 事件 `result:"out"`（无 detail）
- **WHEN** 运行审计
- **THEN** 该事件仍被认定为出界（兼容分支）

### Requirement: detector 排除位契约读 detail 字符串

确定性审计的 pass 排除位 SHALL 认 `detail` 字符串集合（corner/throw_in/free_kick/clearance）为死球/战术传球排除依据；SHALL 不把 `result === 'contested'` 单独作为排除依据（出界球同为 contested）。布尔排除位（如 `clearance === true`）SHALL 保留作为兼容分支。

#### Scenario: 角球/界外球/任意球/解围 pass 被排除
- **GIVEN** 一个 pass 事件 `detail:"corner"`（或 throw_in/free_kick/clearance）
- **WHEN** 运行 unforced_out 与 pass_outcomes 统计
- **THEN** 该事件被排除，不计入 ordinary pass 桶、不产 unforced_out finding

#### Scenario: 出界球不因 contested 被排除
- **GIVEN** 一个 pass 事件 `result:"contested"`、`detail:"out_sideline"`
- **WHEN** 运行 unforced_out
- **THEN** 该事件不被 contested 排除位排除，按出界处理

### Requirement: detector 字段契约单一权威

确定性审计 SHALL 以字段契约清单（声明每个 detector 读取的字段及其生产方）为单一事实来源；契约清单与 detector 代码不一致 SHALL 由测试发现。每个 detector 读取的字段 SHALL 在真实 audit_input 上由引擎或推导层生产，或显式登记为 known-gap。

#### Scenario: 契约断言覆盖所有读取字段
- **GIVEN** 字段契约清单覆盖全部 detector 的 reads/producers/known_gaps
- **WHEN** 对真实 bundle 的 audit_input 运行契约断言测试
- **THEN** 每个 reads 字段在真实数据上有生产者或登记 known-gap；契约清单与 detector 实现不一致时测试失败

### Requirement: audit_input 版本保护

audit_input SHALL 携带 `schema_version`；`runAudit` SHALL 在读取前校验版本，缺失或未知版本 SHALL 抛错而非静默按默认处理。

#### Scenario: 缺失版本抛错
- **GIVEN** 一个不带 `schema_version` 的 audit_input
- **WHEN** 调用 `runAudit`
- **THEN** 抛错并指出缺失版本，不产出 findings

#### Scenario: 已知版本正常审计
- **GIVEN** 一个 `schema_version` 为当前已知值的 audit_input
- **WHEN** 调用 `runAudit`
- **THEN** 正常产出 findings（版本校验通过）

### Requirement: 未标定 detector 告警降级

标记为未标定（`calibrated:false`）的 detector 的告警 SHALL 在聚合层降级：SHALL 不因超出参考 band 升级为 `realism_failure`，聚合摘要 SHALL 携带 `calibration:'uncalibrated'` 供诊断报告层识别，避免未标定告警污染诊断结论。

#### Scenario: 未标定告警不升级 failure
- **GIVEN** ignored_interception 标记 `calibrated:false` 且其告警率超出参考 band
- **WHEN** 运行聚合
- **THEN** 该 detector 的 aggregate_severity 不升级为 realism_failure，摘要带 calibration:'uncalibrated'

### Requirement: detector 阈值算子方向有测试守卫

确定性审计的阈值算子方向 SHALL 有测试守卫：每个**可达的**方向敏感判据（`>` / `>=` / `<`）SHALL 有「恰好等于阈值」的边界样本断言其方向；真实窗口的 finding 集合 SHALL 有 golden 签名断言其一致性。改判据方向、改阈值、删分支导致真实数据 finding 集合变化 SHALL 由测试发现。需浮点恰好相等才触发的容差类判据（如 `time_order_epsilon`）SHALL 在 design 中显式登记为缺口，而非静默。

#### Scenario: 等于阈值的边界钉死算子方向
- **GIVEN** unforced_out 的 pressure_distance 阈值为 8.0
- **WHEN** 输入 `nearest_defender_distance` 恰好等于 8.0
- **THEN** 不产 realism_warning（`>` 严格大于，等于阈值不属于无压迫）

#### Scenario: golden 签名兜住真实数据 finding 变化
- **GIVEN** 7 个真实窗口的 golden finding 签名已写死
- **WHEN** 运行审计
- **THEN** 产出的 finding 集合与 golden 签名逐条一致；任何让真实数据 finding 变化（改算子方向/阈值/删分支）的行为导致测试失败

### Requirement: player_overlap 同队间距 detector

确定性审计 SHALL 新增 `player_overlap` detector：对观察窗口内的球员快照，按 id 范围判定同队（0-10 home / 11-21 away），SHALL 对「同队两球员任一时点间距 < `min_distance`（默认 2.0m）」产出一条 `realism_warning` finding，并按球员对聚合（同 pair 多采样点重叠只报一条）。

#### Scenario: 同队重叠产出告警
- **GIVEN** 观察窗口内同队两球员某时刻间距 < 2.0m
- **WHEN** 运行审计
- **THEN** 产出一条 `player_overlap` realism_warning，match_time 为首次越界时刻，features 携带最小间距

#### Scenario: 阈值边界严格小于
- **GIVEN** 同队两球员间距恰等于 `min_distance`（2.0m）
- **WHEN** 运行审计
- **THEN** 不产 finding（严格 `<` 才算重叠）

#### Scenario: 同一球员对多采样点重叠只报一条
- **GIVEN** 同一同队球员对在窗口内多个采样点都 < 阈值
- **WHEN** 运行审计
- **THEN** 该 pair 只产出一条 finding，不逐采样点刷屏

