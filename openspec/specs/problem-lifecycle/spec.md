# problem-lifecycle Specification

## Purpose
TBD - created by archiving change p11-problem-lifecycle. Update Purpose after archive.
## Requirements
### Requirement: Problem 可创建并持久化

系统 SHALL 支持把诊断结果（或人工内容）创建为 Problem，持久化到 `<tasks-dir>/problems/<id>.json`（一问题一文件）；Problem SHALL 包含 id、title、description、source（observation_id/task_id/report）、triage、status、decisions、discussion、github 引用、change_ref、时间戳；服务端 SHALL 是唯一写入口，写操作原子化（临时文件 + rename）。

#### Scenario: 从诊断报告创建 Problem

- **WHEN** 用户在 triage 动作面板点击"创建问题"，传入已 diagnosed 的任务 id
- **THEN** 服务端从任务报告生成 Problem（标题=现象摘要、描述=用户描述+现象、triage=报告 triage、status=open），落盘并返回 Problem

#### Scenario: 人工创建 Problem

- **WHEN** 用户提交仅含标题与描述的创建请求
- **THEN** 服务端创建 triage=discuss、status=open、source=null 的 Problem

### Requirement: Problem 分类与状态可流转且留审计轨迹

Problem 的 triage SHALL 可人工改为 `bug`/`design`/`discuss`/`defer`/`wontfix`；status SHALL 在 `open`/`in_progress`/`fixed`/`closed` 间流转（`fixed` 表示修复已验证，`closed` 表示关闭）；`defer`/`wontfix` 必须提供 reason；每次 triage/status 变化 SHALL 追加 decisions 记录（action/by/at/reason）；`defer`/`wontfix` 的 Problem SHALL 可重开（status→open、triage 改回）。

#### Scenario: 标记 defer

- **WHEN** 用户对 open 的 Problem 执行 `triage=defer` 且提供 reason
- **THEN** Problem 的 triage 变为 defer、status 变为 closed，decisions 追加记录

#### Scenario: 重开 defer 的 Problem

- **WHEN** 用户对 defer 的 Problem 执行重开并改回 triage
- **THEN** status 回到 open，decisions 追加重开记录

#### Scenario: 缺少 reason 的 wontfix

- **WHEN** 用户尝试 `triage=wontfix` 但不提供 reason
- **THEN** 服务拒绝该请求并返回错误

### Requirement: discuss 在页面内对话并可转为 issue

discuss 分类的 Problem SHALL 支持页面内留言（作者/文本/时间，存储前 redact 凭证形态文本）；留言后 SHALL 可执行"转为 issue"——把讨论摘要并入 issue 正文。

#### Scenario: 留言并转为 issue

- **WHEN** 用户在讨论区发送两条留言后点击"转为 issue"
- **THEN** 服务端创建 GitHub issue，正文包含用户描述、诊断摘要与讨论摘要，Problem 记录 github 引用

### Requirement: bug/design 可提交 GitHub issue

系统 SHALL 通过本机 `gh` CLI 创建 GitHub issue（凭证只来自本机 gh 登录，token 不进入浏览器/页面/日志/prompt；子进程环境沿用净化策略）；issue 标题带 triage 前缀标记（`[bug]`/`[design]`/`[discuss]`）、正文由 Problem 内容渲染；默认不附加 `--label`（避免依赖仓库预建 label），`--label` 仅在显式传入时才使用；仓库默认从 git remote 解析、可配置覆盖；创建成功 SHALL 回写 github 引用（issue 号与 URL）。

#### Scenario: 提交 issue 成功

- **WHEN** 用户对 bug 分类 Problem 点击"提交 GitHub issue"且本机 gh 已登录
- **THEN** 服务端执行 `gh issue create` 成功，Problem 记录 issue_number 与 url

#### Scenario: gh 不可用

- **WHEN** 本机无 gh 或未登录
- **THEN** 服务返回明确错误（"gh 不可用/未登录"），Problem 保持原状，页面展示错误提示

### Requirement: 管理页面统一查看与操作

viewer SHALL 提供问题管理视图：列表（标题、分类徽章、状态、来源、issue 号、change_ref、时间，可按分类/状态筛选）与详情（诊断报告、triage、动作面板、讨论区）；所有外部文本 SHALL 经 redact 后以 textContent 渲染。

#### Scenario: 查看问题列表

- **WHEN** 用户打开问题视图
- **THEN** 页面拉取 `/problems` 并按状态/分类展示徽章与筛选

#### Scenario: 诊断完成后创建问题

- **WHEN** 诊断任务终态为 diagnosed，triage 面板展示"创建问题"
- **THEN** 点击后生成 Problem 并跳转/刷新问题列表

