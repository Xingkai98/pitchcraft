# P11 Problem Lifecycle — Design

## Goals / Non-Goals

**Goals:**

- 每条诊断结果可持久化为 Problem，跨会话跟踪。
- 分类可流转：agent 建议（bug/design/discuss）+ 人工决策（defer/wontfix），全部带理由、留审计轨迹。
- discuss 在页面内对话收敛，可落为 GitHub issue。
- bug/design 一键 `gh issue create`，本地记录 issue 引用。
- 管理页面统一查看所有问题的状态、结果、流程。

**Non-Goals:**

- GitHub issue 状态回读（本地 → issue 单向同步，issue → 本地回读后续做）。
- OpenSpec change 与 Problem 的自动关联（change_ref 手工填或后续自动）。
- 多用户/协作、权限系统。
- discuss 的 AI 参与对话（后续可"带讨论上下文再起诊断"）。

## 领域模型

### Problem 实体

```text
{
  id: "prob-<ts>-<n>",
  title: string,                    // 现象摘要，可编辑
  description: string,              // 用户描述 + 现象 + 证据摘要
  source: {                         // 证据链（可空 = 人工创建）
    observation_id, task_id, report  // report = 诊断报告（含 triage/findings）
  },
  triage: "bug" | "design" | "discuss" | "defer" | "wontfix",
  status: "open" | "in_progress" | "fixed" | "closed",
  decisions: [                      // 审计轨迹，每次流转追加
    { action, by, at, reason }
  ],
  discussion: [ { author, text, at } ],   // discuss 对话
  github: { issue_number, url, synced_at } | null,
  change_ref: "p12-..." | null,
  created_at, updated_at
}
```

### 状态机

- **triage**（分类，可人工改）：`bug`/`design`/`discuss` 来自诊断报告（agent 建议）；人工可改 `defer`（先不搞，带理由）/`wontfix`（废弃，带理由）；`defer`/`wontfix` 可改回并重开。
- **status**（生命周期）：`open` → `in_progress`（关联 change 或开始处理）→ `fixed`（修复验证过）→ `closed`；`defer`/`wontfix` 也落在 status=closed 之外？——**约定**：`defer`/`wontfix` 是 triage 分类，status 仍走 `closed`（defer=closed+可重开，wontfix=closed+终态）。重开 = status→open + triage 改回。
- 每次 triage/status 变化追加 decisions 记录（action/by/at/reason），reason 必填（defer/wontfix 强制，其他可选但鼓励）。

### 后续动作映射（沿用 P10 triage 面板）

- `bug` → 可提交 GitHub issue（标题前缀标记 bug，正文 = change 草稿内容）；也可直接转 change。
- `design` → 可提交 GitHub issue（标题前缀标记 design）；先讨论。
- `discuss` → 页面讨论区留言，收敛后"转为 issue"（讨论摘要进正文）。
- `defer` → 暂停跟踪（列表可见、可重开；不提交 issue）。
- `wontfix` → 废弃（列表可见、可重开；不提交 issue）。

## 持久化

- `<tasks-dir>/problems/<problem-id>.json`，一问题一文件；服务端（tools/service.mjs）是唯一写入口。
- 写操作原子化（先写临时文件再 rename）；读失败返回 404/空列表，不崩服务。
- 页面通过服务端 API 读写，不直接碰文件系统。

## 服务端 API（service.mjs 扩展）

```text
GET    /problems                  → 列表（全部，含状态/分类筛选参数可选）
POST   /problems                  → 从诊断报告创建（body: { task_id } 或完整 report 对象）
GET    /problems/:id              → 详情
PATCH  /problems/:id              → 更新（title/description/triage/status/reason/change_ref）
POST   /problems/:id/discussion   → 留言 { author, text }
POST   /problems/:id/github       → gh issue create（body 可选 override），回写 github 字段
```

- 复用现有 CORS/白名单/body 上限/凭证净化逻辑（localhost + --allow-origin、5MB、redact）。
- 创建来源：诊断任务终态（diagnosed）时自动生成 Problem？——**MVP 不做自动**：用户从页面 triage 面板点"创建问题"显式创建（避免噪音）。

## GitHub 集成

- `tools/github.mjs`：`createGithubIssue(problem, { repo, dryRun, labels })` 用 `gh issue create --repo <repo> --title ... --body ...` 子进程调用。
- 仓库默认读 git remote origin（`gh repo view --json nameWithOwner` 或直接 `git remote get-url origin` 解析），可配置覆盖。
- 凭证：gh 本机登录（token scopes 需 repo）；gh 子进程环境复用 provider 的净化策略（剔除 CLAUDE_CODE_*/ANTHROPIC_* 会话变量，保留基础变量——不泄漏 token 到日志）。
- 失败处理：gh 不可用/未登录 → 任务失败并返回明确错误（页面显示"gh 未登录/不可用"），本地 Problem 不受影响。
- issue 标题带 triage 前缀标记（`[bug]`/`[design]`/`[discuss]`）；body 由 `buildChangeDraft`（P10 已有）渲染 + 问题描述/讨论摘要；`--label` 仅在调用方显式传入 `labels` 时才附加（避免依赖仓库预建 label）。

## 管理页面

- viewer 新增"问题"入口（顶部 tab 或区块切换：比赛 / 问题）。
- 列表：标题、分类徽章、状态、来源（observation/task）、issue 号、change_ref、时间；按分类/状态筛选。
- 详情：完整诊断报告 + findings + triage 徽章 + 动作面板（转 issue / defer / 废弃 / 重开 / 标记 fixed/closed / 改 change_ref）+ 讨论区（留言列表 + 输入框 + "转为 issue"）。
- 全部渲染 textContent + redactText；页面不接触任何凭证。

## 切片

1. **Slice 1**：`tools/problems.mjs`（实体/状态机/decisions/持久化）+ 服务端 `/problems` CRUD + 测试（无 API 调用）。
2. **Slice 2**：管理页面（列表/详情/动作/讨论区）+ 诊断报告 triage 面板"创建问题"按钮 + cache-busting + 测试。
3. **Slice 3**：`tools/github.mjs` gh issue 集成 + `/problems/:id/github` + 失败路径测试 + docs。

## Risks / Trade-offs

- [gh 未登录/不可用] → 明确错误提示，本地功能不受影响。
- [issue 与本地状态漂移] → MVP 单向同步，文档明示；状态回读后续做。
- [问题数量增长] → 列表筛选 + 详情按需加载（文件小，全量列表可接受）。
- [讨论内容凭证风险] → 留言先 redact 再存储/渲染。
- [/problems/:id/github 对外发布副作用] → 在宽松 localhost CORS 模型下，任何本地端口的页面可触发 `gh issue create`（对外发布动作）；token 不离开本机，但动作可被触发，建议仅本机使用。
