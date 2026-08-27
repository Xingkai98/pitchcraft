## ADDED Requirements

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
