## Why

P10 建立的诊断闭环（观察 → 审计 → 诊断 → triage）目前止于"一条诊断报告 + 页面展示"：结果不持久化，无法跟踪后续（修没修、讨论到哪、是否废弃），bug/design 无法沉淀到 GitHub，discuss 没有对话空间，多个问题没有统一视图。每条反馈的价值随会话结束而丢失。

本 change 建立**问题生命周期管理**：把每条诊断结果（及人工创建）收敛为持久化 Problem，支持分类流转、讨论、GitHub issue 落库和统一管理页面。

## What Changes

- 新增 Problem 实体：标题/描述/来源（observation/task/报告）/triage 分类/生命周期状态/决策审计轨迹/讨论/GitHub issue 引用/OpenSpec change 引用。
- triage 分类：agent 给 `bug`/`design`/`discuss`，人工可改为 `defer`（先不搞）或 `wontfix`（废弃），所有流转必须带理由并记录决策轨迹。
- 生命周期：`open` → `in_progress`（关联 change）→ `fixed`（验证过）→ `closed`；defer/wontfix 可重开。
- 本地持久化：`<tasks-dir>/problems/` 下 JSON 文件（一问题一文件，无第三方依赖），服务端是唯一写入口。
- 服务端 API：列表/详情/创建（从诊断报告一键建）/更新（分类/状态流转/理由）/讨论留言。
- GitHub 集成：`gh issue create`（本机已登录，凭证只走 gh，不碰 token）把 bug/design 落为 issue，本地记录 issue 号与 URL；MVP 单向同步（本地 → GitHub）。
- 管理页面：viewer 新增"问题"视图——列表（状态/分类筛选、徽章、issue 号、change 引用）+ 详情（完整报告、动作面板、讨论区）。
- discuss 对话：页面内留言，收敛后可"转为 issue"（讨论摘要带进 issue 正文）。

## Capabilities

### New Capabilities

- `problem-lifecycle`: Problem 的创建、分类流转、持久化、讨论、GitHub issue 落库与管理页面

### Modified Capabilities

- `match-observation`: triage 动作面板从"复制草稿"升级为"创建问题"
- `diagnosis-runner`: 诊断报告可一键转为 Problem（服务端 API）

## Impact

- `tools/service.mjs`：新增 `/problems` CRUD + discussion + github 端点（gh CLI 子进程）。
- 新增 `tools/problems.mjs`（Problem 实体/状态机/持久化，纯逻辑可测）+ 测试。
- `viewer/app.js`、`viewer/index.html`：问题管理视图、列表/详情渲染、讨论区。
- 不新增第三方依赖；gh CLI 作为本机可执行程序调用（凭证继承本机 gh 登录）。
- 凭证纪律不变：GitHub token 不进入浏览器/页面/日志，gh 子进程环境同样净化。
