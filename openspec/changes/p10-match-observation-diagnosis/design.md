## Context

当前系统已经有确定性 seed、事件时间线、viewer `seekTo`/`jumpToEvent` 和 debug 日志，但没有统一的观察包。事件流主要描述“画什么”，缺少“为什么这样决定”的可追溯输入；viewer 也无法把用户看到的某一帧与引擎事件和代码版本绑定。

本 change 面向本地开发环境，目标是先建立一条低依赖、可复现、可人工审查的纵向链路：

```text
viewer observation
  -> local observation service
  -> deterministic audit
  -> Claude Code diagnosis
  -> structured report
  -> replay original window
```

系统必须区分三层事实：

- `engine_truth`：回放/审计推导出的事件和状态。
- `event_projection`：viewer 消费的事件与时间线。
- `viewer_frame`：提交时 viewer 的播放时刻、实体位置和当前事件。

## Goals / Non-Goals

**Goals:**

- 用户用自然语言标记一个具体比赛瞬间，并保存可复现上下文。
- 同一 observation bundle 能在命令行重复运行，产生相同 audit findings。
- 首批检测器能把“无压力出界”“责任状态站桩”“可拦截但无防守反应”转换成具体数值证据。
- 诊断 Agent 能从 bundle、audit、代码和测试中定位层次、规则/符号、根因假设和验证命令。
- 默认以 bypass 权限模式运行诊断 Agent（Claude `bypassPermissions`）：可读代码、执行验证/复现命令、修改文件；权限模式可配置，`read-only` 只读诊断作为可恢复选项。
- Agent provider、model、预算、超时可配置，默认使用本机 `claude` 和 `ANTHROPIC_API_KEY`。

**Non-Goals:**

- 本 change 不建立完整足球 AI 或完整真实比赛模型。
- 本 change 不让模型直接从截图判断真实性。
- 本 change 不自动生成或合并代码修改。
- 本 change 不宣称首批检测器覆盖所有真实感问题。
- 本 change 不把第三方云端 API key 暴露给浏览器。

## Decisions

### 1. 观察包作为唯一诊断输入

页面提交后生成版本化 JSON bundle，而不是把页面状态直接传给 Agent。bundle 至少包含 `schema_version`、`observation_id`、`seed`、`config`、`match_time`、`window`、`statement`、`selected_entities`、`events`、`engine_snapshot`、`viewer_snapshot`、`audit_input`、`source_revision`。

选择 bundle 而不是实时 RPC 的原因是：它可落盘、可 diff、可重放、可作为回归 fixture，也能在 Agent 失败后脱离页面复查。

### 2. 先确定性审计，再启动 Agent

本地服务收到 bundle 后先运行 audit。audit 负责计算事实和 detector findings；Agent 只能读取这些结果并检查代码因果链。若 bundle 无法重放或检测器没有足够证据，任务状态为 `insufficient_evidence`，不启动“猜测式”诊断。

### 3. 诊断 Agent 通过 provider adapter 启动

runner 定义窄接口：

```text
runDiagnosis(bundlePath, auditPath, agentConfig) -> runId
getRun(runId) -> status/result
cancelRun(runId)
```

首个 adapter 为 `ClaudeCodeAdapter`，通过子进程调用本机 `claude --print --output-format ...`。provider 配置只包含命令、model、permission mode、预算（映射到 `--max-budget-usd`）和超时；认证不进入配置，runner 仅检查 `ANTHROPIC_API_KEY` 是否存在并把它继承给子进程。

验证命令契约：默认 bypass 模式下，diagnosis Agent 直接读取证据与代码，**实际执行**重放/验证命令（重放 seed、跑相关测试）以复现观察，并在结构化报告的 `verification` 字段记录可复现的验证命令供人工复核；配置 `read-only`/`plan` 时 Agent 以 plan 模式运行且编辑工具被禁用，验证命令由 runner 或用户另行执行。任务状态只反映 audit 与诊断结论，报告始终记录 Agent 实际执行过的修改动作。

### 4. 结构化 Agent 输出必须校验

Agent 输出必须解析为固定 JSON，至少包含 `status`、`phenomenon_summary`、`layer`、`hypotheses`、`root_cause`、`proposed_fix`、`verification`、`confidence`。输出无法解析时最多重试一次，仍失败则保存原始输出并标记 `invalid_agent_output`，不能把自然语言当成已诊断结果。

### 4.5 诊断结果分流（triage）

每个 `diagnosed` 报告必须带 `triage` 字段：`category` 枚举 `bug` / `design` / `discuss` + `rationale`（分类理由，面向用户）+ `confidence`（agent 对分类本身的信心）。分类判定原则：**看根因性质，不看修复工作量**。

- `bug`：现有代码行为与预期不符，有明确根因（文件:行号）和可验证修复路径，修复不改变产品意图。
- `design`：代码按设计工作，但设计/模型本身有缺口（缺机制、缺数据、需产品决策），需要新设计而非修 bug。
- `discuss`：根因不明、多因素叠加、agent 低置信（<0.7）、需用户权衡取舍或确认现象。

agent 未给出或给出非法分类时，runner 兜底标 `discuss` 并注明"agent 未提供分类"，不替 agent 决策。后续动作按类别映射：

- `bug` → 生成 OpenSpec change 草稿（现象/证据/根因/修复方案/验证命令 → proposal 文本），用户确认后进 change 流程。
- `design` → 列出 open questions，进入设计讨论（wayfinder issue），讨论后再立 change。
- `discuss` → 列出需用户确认的问题，用户答复后重新评估。

triage 是 agent 的建议，不是结论：页面展示分类徽章与动作指引，用户可自行调整走向。

### 5. 首批 detector 使用 profile 和排除条件

detector 不把所有失败都算异常。每个 detector 显式声明适用场景、排除场景、特征、阈值、证据和聚合指标。首批 profile：

- `unforced_out`: 排除角球、界外球、门球、解围、死球和明确争抢；统计无压力普通传球出界及其前后压力证据。
- `inactive_responsibility`: 排除死球和明确保持阵型；仅在球进入责任区、球权转换或防线整体移动时统计连续静止。
- `ignored_interception`: 计算传球走廊、最近防守者到走廊距离、球和防守者到达时间以及防守者实际速度方向。

阈值集中在 audit profile 中，finding 必须记录实际值和阈值，避免把阈值隐藏在 Agent prompt。

### 6. 本地服务和页面解耦

viewer 只提交观察并轮询任务状态，不直接启动进程，也不接触 API key。一个本地 service 负责静态文件转发、观察 POST、任务存储和 runner 调度。若浏览器服务暂时不可用，页面仍支持导出 bundle 文件供 CLI 重放。

### 7. 诊断和修复分离

默认 bypass 模式下，诊断 Agent 可直接执行验证命令与修复，修改动作记录在任务报告中供用户审查；`--permission read-only` 可恢复“只读诊断、修复另开”的保守模式（后续 change 再实现用户确认后的 fix worker、独立 worktree 和补丁验证）。报告中的验证命令必须能复现原观察。

### 8. 本地诊断 HTTP 服务

服务进程 `tools/service.mjs` 用 Node 原生 `http` 实现（无第三方依赖），默认绑定 `127.0.0.1:8787`（`--port` 可改，`--tasks-dir` 复用 runner 落盘目录）。职责是把页面提交和既有 runner 接起来，不重复实现任何审计/诊断逻辑：

```text
POST /observations   body = observation bundle JSON
                     -> validateObservationBundle（含凭证拒绝）
                     -> runAudit -> runDiagnosis（异步后台执行）
                     -> 202 { task_id }
GET  /tasks/:id      -> redacted 任务状态与结果（页面轮询用）
OPTIONS              -> CORS 预检 204
```

- **CORS 只回显 localhost 来源**：仅当 `Origin` 属于 `localhost` / `127.0.0.1` 时回显该 Origin，其他来源不带 CORS 头且拒绝，避免任意网页驱动本机诊断。
- **安全**：只绑定 `127.0.0.1`；请求体大小上限（默认 5 MB）；API key 不进入响应、日志或任务文件（复用 runner 的 redaction）；无 key 时诊断返回 `provider_unavailable`，audit 结果照常返回。
- **轮询契约**：`GET /tasks/:id` 返回与 `runDiagnosis` 持久化一致的 task 状态机（8 个状态），页面按状态渲染进度，最终状态自动回填 findings 并打时间轴红点。
- 服务不可用或请求失败时，页面回退为现有"导出 bundle + CLI 模板"路径，不阻塞观察采集。

### 9. `.env` 加载

runner 内部契约不变（只读 `process.env`）；`.env` 加载只发生在 CLI/service 入口层，用一个无依赖解析器读取仓库根 `.env`（存在时）：按 `KEY=VALUE` 行解析，`process.env` 已有值优先（不覆盖），解析失败仅告警不退出。这样单元测试不触碰真实 `.env`，且 `3.4` 的"凭证只存在于进程环境"约束不变。

- `.env` 加入 `.gitignore`；提交 `.env.example`（含 `ANTHROPIC_API_KEY=` 占位与说明），避免把真实 key 带进仓库。
- 页面、bundle、日志、prompt 依旧不接触 key。

## Risks / Trade-offs

- [现有事件流没有完整决策原因] -> 首版使用可从事件/beat 推导的事实；无法推导的项标记 `unknown`，不伪造 root cause；后续再增加 decision trace。
- [首批阈值可能误报] -> 所有 finding 保存原始特征和 profile 版本，先作为 warning，不把单个片段直接升级为统计结论。
- [Agent 输出不稳定] -> 固定 prompt、bundle、JSON schema、只读权限和同 seed 验证；无法复现时拒绝诊断。
- [Claude CLI 或 API key 不可用] -> 任务返回明确的 `provider_unavailable`，audit 结果仍可独立查看。
- [长比赛 bundle 过大] -> 只保存观察窗口及其必要的前置 lineup/state，保留完整比赛的 seed/config 作为重放来源。

## Migration Plan

1. 新增 bundle/audit/runner 模块和单元测试，不改变现有播放路径。
2. 增加页面观察入口；默认关闭时不影响现有播放。
3. 增加本地 service 启动命令和配置示例，验证 `ANTHROPIC_API_KEY` 后再启用诊断。
4. 运行现有 `verify.sh` 及新增 observation/audit/runner 测试。
5. 若 runner 不可用，回退为页面导出 bundle + CLI audit；删除任务目录不会影响比赛模拟。

## Open Questions

- 是否在后续 change 中把 engine `decision_id/rule_id` 作为正式事件协议字段，还是保持在独立 trace 文件。
- 真实比赛参考带采用哪个联赛/赛季作为默认 profile。
- 是否需要把已确认的 finding 自动转成回归测试模板。
