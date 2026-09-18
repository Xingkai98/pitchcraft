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

确定性审计的出界证据 SHALL 优先认定 `result === 'out'` 的 pass 事件为出界（主路径）；SHALL 兼容 `out_side`、`detail` 为 `out_sideline`/`out_goal_line`、以及落点几何出界作为次要证据分支。真实出界传球（`result:"out"` + `out_side`）SHALL 被判定为出界，而非 `unknown`。

#### Scenario: 显式 out 被判定出界
- **GIVEN** 一个 pass 事件 `result:"out"`、`out_side:"sideline"`
- **WHEN** 运行审计
- **THEN** 该事件被认定为出界（unforced_out 依据 nearest_defender_distance 产出 finding；pass_outcomes 计入 out_count）

#### Scenario: 兼容旧 detail 出界
- **GIVEN** 一个 pass 事件 `result:"contested"`、`detail:"out_sideline"`（旧 bundle）
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
- **GIVEN** player_overlap 标记 `calibrated:false` 且其告警率超出参考 band
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

### Requirement: Runner 支持可配置 Agent 和 model

诊断 runner SHALL 支持 provider、command、model、permission mode、预算、超时和最大重试次数配置；默认 provider SHALL 为 `claude-code`，默认命令 SHALL 为本机 `claude`，默认认证来源 SHALL 为 runner 进程的 `ANTHROPIC_API_KEY` 环境变量。

#### Scenario: 使用本机 Claude Code

- **WHEN** 用户未指定 provider 和 model 且本机存在 `claude` 与 `ANTHROPIC_API_KEY`
- **THEN** runner 使用默认 Claude Code 配置（bypass 权限）启动诊断任务

### Requirement: 诊断 Agent 权限模式可配置，默认 bypass

默认 diagnosis 任务 SHALL 以 bypass 权限模式（Claude `bypassPermissions`）启动本机 Claude Code，允许 Agent 读取 observation bundle、audit report 和相关源代码，运行验证/复现命令（重放、跑测试等），并可修改源码、配置或测试文件；报告的 `verification` 字段 SHALL 仍包含可复现的验证命令供人工复核。权限模式 SHALL 可配置：配置为 `read-only`/`plan` 时，Agent 以 plan 模式运行且编辑工具被禁用，MUST 禁止修改源码、配置、OpenSpec 或测试文件。

#### Scenario: 默认 bypass 模式运行诊断

- **WHEN** 用户未指定权限模式
- **THEN** runner 以 `bypassPermissions` 启动诊断，Agent 可执行验证/复现命令并可修改文件，报告仍携带 `verification` 字段

#### Scenario: 配置只读模式后尝试编辑

- **WHEN** 用户配置 `--permission read-only` 且 diagnosis Agent 尝试写入仓库文件
- **THEN** runner 运行在 plan 模式并禁用编辑工具，任务记录未执行任何修改

#### Scenario: Agent 提出验证命令

- **WHEN** diagnosis Agent 得出结论
- **THEN** 报告中包含能复现原始观察窗口的验证命令（verification 字段），该命令由 Agent 在默认 bypass 模式下直接执行，或由 runner/用户后续执行

### Requirement: Agent 输出使用结构化报告

Runner SHALL 要求并校验 JSON 诊断报告，报告至少包含 status、phenomenon_summary、layer、hypotheses、root_cause、proposed_fix、verification 和 confidence；无法解析的输出不得标记为 diagnosed。

#### Scenario: 合法诊断报告

- **WHEN** Agent 返回符合 schema 且包含代码位置和验证命令的报告
- **THEN** runner 保存报告并将任务状态更新为 `diagnosed`

### Requirement: 诊断报告包含 triage 分流

`diagnosed` 报告 SHALL 包含 `triage` 字段：`category` 枚举 `bug`/`design`/`discuss`、`rationale` 非空字符串、`confidence` 在 [0,1]；Agent prompt SHALL 包含分类判定指南（看根因性质不看修复工作量；`bug`=现有实现缺陷、`design`=设计缺口、`discuss`=根因不明/低置信/需用户确认）；Agent 未提供或提供非法 `triage` 时，runner SHALL 兜底为 `discuss` 并注明原因，不拒绝整份报告；页面 SHALL 展示分类徽章与按类别的后续动作指引（`bug`→change 草稿生成、`design`→open questions 讨论、`discuss`→需用户确认问题清单）。

#### Scenario: 报告带合法 triage

- **WHEN** Agent 返回 `triage: { category: 'bug', rationale: '...', confidence: 0.9 }`
- **THEN** runner 校验通过，页面显示 bug 徽章与"生成 change 草稿"动作

#### Scenario: Agent 未提供 triage

- **WHEN** Agent 返回诊断报告但不含 `triage` 字段
- **THEN** runner 兜底为 `triage: { category: 'discuss', rationale: 'agent 未提供分类', confidence: 0 }`，报告仍保存并展示

#### Scenario: triage 类别非法

- **WHEN** `triage.category` 不在枚举中
- **THEN** runner 视为无效 triage，按"未提供"兜底为 `discuss`，不拒绝整份报告

### Requirement: 诊断必须基于可重放证据

Agent prompt SHALL 包含 observation bundle 路径、audit report 路径、重放/验证说明、工作区代码版本和“无法复现则返回 insufficient_evidence”的要求；默认 bypass 模式下 Agent SHALL 实际执行重放/验证命令以复现观察；配置只读模式时验证命令由 runner 或用户执行。

#### Scenario: 无法重现现象

- **WHEN** Agent 无法用相同 seed/config 从证据和代码重现用户描述或 audit finding
- **THEN** Agent 报告 `insufficient_evidence`，不得编造确定的代码根因

### Requirement: 认证信息只存在于 runner 进程环境

Runner MUST NOT 从浏览器、项目配置或 observation bundle 接收 API key；启动 Claude Code 时只从本机进程环境读取 `ANTHROPIC_API_KEY`，且不得把该值写入日志、任务结果或 Agent prompt 文件。

#### Scenario: 缺少 API key

- **WHEN** runner 发现 `ANTHROPIC_API_KEY` 未设置
- **THEN** runner 不启动 Agent，返回 `provider_unavailable`，并提示配置环境变量而不暴露任何凭证内容

### Requirement: 诊断结果可重放和审查

Runner SHALL 持久化任务输入摘要、provider/model、开始结束时间、命令退出状态、结构化报告和原始输出引用；同一任务 SHALL 能重新关联到原始 observation 和 audit evidence。

#### Scenario: 查看诊断结果

- **WHEN** 用户打开一个已完成诊断任务
- **THEN** 系统展示用户描述、audit findings、Agent 根因、代码位置、方案、验证命令和置信度，并能跳回原比赛时刻

### Requirement: 本地诊断服务接收观察提交并提供任务轮询

本地诊断 HTTP 服务 SHALL 默认监听 `127.0.0.1`（`--host` 可配置，如 tailscale 场景传 `0.0.0.0`），提供 `POST /observations`（接收 observation bundle，执行校验、审计和异步诊断，返回 `task_id`）与 `GET /tasks/:id`（返回 redacted 任务状态与结果供轮询）；服务 SHALL 默认仅回显 localhost 来源的 CORS 头，并支持 `--allow-origin` 追加额外白名单来源（如 tailscale 网内页面地址），白名单外的来源不带 CORS 头并拒绝；SHALL 限制请求体大小；服务不可用时页面 SHALL 回退为 bundle 导出 + CLI。绑定非 loopback 地址后，非浏览器客户端（curl 等）不受 CORS 约束，网内访问控制由部署者自行保证。

#### Scenario: 页面提交观察到本地服务

- **WHEN** 页面 POST 一个合法 observation bundle 到本地服务
- **THEN** 服务返回 `202 { task_id }`，后台依次执行 bundle 校验、确定性审计和诊断（默认 bypass 权限），页面轮询 `GET /tasks/:id` 直到终态

#### Scenario: 服务拒绝白名单外来源

- **WHEN** 请求的 Origin 不属于 `localhost`/`127.0.0.1`，也不在 `--allow-origin` 配置的白名单中
- **THEN** 服务不返回 CORS 头并拒绝该请求，不启动任何诊断任务

#### Scenario: 白名单内 tailscale 来源

- **WHEN** 服务以 `--allow-origin http://100.114.76.34:8000` 启动，且页面从该地址访问并提交
- **THEN** 服务回显该 Origin 的 CORS 头并正常处理诊断任务

#### Scenario: 服务不可用

- **WHEN** 本地服务未启动或请求失败
- **THEN** 页面回退为"导出 bundle + CLI 模板"，观察采集不受影响

### Requirement: runner 入口可从 .env 读取 API key

CLI 与服务入口 SHALL 在启动时加载仓库根 `.env` 文件（存在时）中的 `KEY=VALUE` 行；`process.env` 已有值 SHALL 优先，加载不得覆盖；加载失败 SHALL 仅告警不退出。`.env` SHALL 加入 `.gitignore`，仓库只提交 `.env.example`。key 的读取与使用仍只发生在 runner 进程内，不进入浏览器、bundle、日志或 prompt。

#### Scenario: 未设置环境变量但存在 .env

- **WHEN** 进程环境没有 `ANTHROPIC_API_KEY` 且仓库根存在 `.env`
- **THEN** 入口从 `.env` 读取该值注入 `process.env`（不覆盖已存在的值），诊断流程照常执行

#### Scenario: .env 缺失或格式错误

- **WHEN** 仓库根没有 `.env` 或其中某行无法解析
- **THEN** 入口仅提示/告警，不退出；`ANTHROPIC_API_KEY` 未配置时诊断返回 `provider_unavailable`

### Requirement: provider 子进程环境净化

启动 `claude` 子进程时，runner SHALL 净化其环境：只继承基础变量（PATH/HOME/TERM/LANG/SHELL 等）与 `ANTHROPIC_API_KEY`，MUST 剔除调用进程的 Claude Code 会话与认证变量——`CLAUDE_CODE_*`、`CLAUDE_PID`、`CLAUDE_CODE_EXECPATH`、`CLAUDE_CODE_ENTRYPOINT`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_*`、`AI_AGENT`、`CLAUDECODE`——保证 `--bare` 语义（仅用 `ANTHROPIC_API_KEY` 直连默认端点）成立；净化逻辑 SHALL 可注入环境以便测试。

#### Scenario: 调用进程带会话变量

- **WHEN** runner 进程环境中存在 `CLAUDE_CODE_CHILD_SESSION`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` 等会话变量，且调用诊断
- **THEN** 子进程 `claude` 的环境不含这些变量，只含基础变量与 `ANTHROPIC_API_KEY`，诊断正常启动

#### Scenario: 无 API key

- **WHEN** 净化后环境没有 `ANTHROPIC_API_KEY`
- **THEN** runner 不启动 Agent，返回 `provider_unavailable`

