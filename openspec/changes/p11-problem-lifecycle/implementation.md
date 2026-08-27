# P11 Problem Lifecycle — 实现记录

日期：2026-08-27（Slice 1-3 tools + Slice 4 viewer）
范围：问题生命周期管理——Problem 实体持久化、服务端 `/problems` API、GitHub issue
集成（`gh issue create`）、viewer 问题管理页（列表/详情/动作/讨论）。

## 目标

P10 诊断闭环止于「一条诊断报告 + 页面展示」：结果不持久化，无法跟踪后续。本 change 把
诊断结果（及人工内容）收敛为持久化 Problem，支持分类流转（bug/design/discuss + 人工
defer/wontfix，全带理由与决策审计轨迹）、讨论、GitHub issue 落库、统一管理页面。

## 改动文件

### Slice 1 — Problem 实体与持久化（tasks 1.1–1.2）

- `tools/problems.mjs`（新增）：
  - `createProblem(input, { tasksDir, now, newId, by, envKey })` —— 创建并落盘。
    `source`（observation_id/task_id/report，可空=人工创建）承载证据链；triage 默认
    `discuss`、status 默认 `open`；`defer/wontfix` 强制 `reason`（缺则抛
    `ProblemError('MISSING_REASON')`）且 status 强制 `closed`（显式传非 closed 拒绝）。
    id 默认 `prob-<ts>-<n>`（进程内计数 + 碰撞重试）。
  - `updateProblem(id, patch, { tasksDir, now, by, envKey })` —— title/description/
    triage/status/change_ref 更新。triage/status 每次流转追加 decisions 记录
    `{ action, from, by, at, reason }`；`defer/wontfix` 强制 reason；重开（triage 从
    defer/wontfix 改回 bug/design/discuss）默认 status→open（可被 patch.status 覆盖）；
    已闭分类的问题 status 只能为 closed（改其它 status 拒绝）。
  - `listProblems({ tasksDir, triage, status })` / `getProblem(id)` —— 读容错：损坏/缺失/
    非法 id 一律 null/跳过，不崩服务；列表最新在前。
  - `addDiscussion(id, { author, text }, opts)` / `setGithubRef(id, github, opts)` ——
    讨论留言追加与 github 引用回写。
  - 持久化 `<tasks-dir>/problems/<id>.json` 一问题一文件；写操作原子化（tmp + rename）；
    落盘前 `redactKey` final safety net（同 runner persistTask）。
- `tools/problems.mjs`：`updateProblem` 普通分类流转分支支持**组合 patch**（triage+status
  同时变 → 两者都生效并各自追加 decisions；不再静默丢弃 status）；`persistProblem` 落盘
  前对每个 string 值做组合净化 `redactCredentialText(redactKey(_, envKey))`——覆盖
  通用 `KEY=value`/`KEY: value`/`"KEY":"value"` 凭证键值对（token/secret/api_key/
  authorization/client_secret 等），不只已知凭证形值。
- `tools/problems.test.mjs`（新增，27 个）：report 创建/manual 创建、defer/wontfix 缺
  reason 拒绝、defer/wontfix 重开、决策轨迹、status 流转 from/to、组合 patch（triage+
  status、非法 status 拒绝）、持久化往返、损坏文件容错、discussion/github 落盘 + 凭证
  抹除（值形 + 通用键值对 + 对象键名净化）、id 碰撞重试、非法 triage/status 拒绝、
  合法文本/键名不误伤。

### Slice 2 — 服务端 API（tasks 2.1–2.2）

- `tools/service.mjs`（扩展）：复用现有 CORS 白名单/body 上限/redactKey。
  - `GET /problems?triage=&status=` —— 列表（非法筛选 400）。
  - `POST /problems` —— 从诊断报告一键创建（body `{ task_id }`：任务须终态 diagnosed 且
    带 report；标题=现象摘要，描述=`用户描述(bundle.statement)+现象+根因/修复/验证`，
    triage=报告分类，status=open）或人工创建（`{ title, description }`，默认
    discuss/open/source null）。
  - `GET /problems/:id`、`PATCH /problems/:id`（title/description/triage/status/reason/
    change_ref；defer/wontfix 无 reason → 400）。
  - `POST /problems/:id/discussion`（author/text 先 redactKey 再落盘）。
  - `POST /problems/:id/github`（见 Slice 3；成功回写 github 引用，失败 502 且 problem
    不变，dryRun 不写）。
  - OPTIONS 预检 `Allow-Methods` 增加 PATCH。
- `tools/service.mjs`：create-from-report 的 `source` 补 `observation_id`（来自原
  bundle）；problem 端点响应组合用 `redactProblemJSON`（redactKey + redactCredentialText，
  与落盘同规则）；discussion author/text 边界用组合净化。
- `tools/service.test.mjs`（+9）：CRUD 全路径、create-from-report（含用户描述/现象/
  observation_id）、wontfix 无 reason 拒绝、discussion redaction、通用凭证形状净化
  （description/discussion 含 `"client_secret":"x"` → 落盘已抹值）、404/400/非法筛选、
  非本机 origin 403、github 成功/失败/dryRun。

### Slice 3 — GitHub issue 集成（tasks 3.1–3.3）

- `tools/github.mjs`（新增）：
  - `createGithubIssue(problem, { repo, dryRun, labels, env, cwd, spawnFn, execAsync, spawnTimeoutMs })`
    —— `gh issue create --repo <repo> --title ... --body ...` 子进程（默认不传 `--label`，
    `labels` 显式传入时才附加；triage 由标题 `[bug]`/`[design]`/`[discuss]` 前缀标记）。
  - repo 默认从 `git remote get-url origin` 解析（`resolveRepoFromRemoteUrl`），失败回退
    `gh repo view --json nameWithOwner`；`repo` 参数可覆盖。
  - **子进程环境复用 provider 净化策略**（`sanitizeChildEnv` 从 `./provider.mjs` 导入）：
    剔除 CLAUDE_CODE_*/ANTHROPIC_AUTH_TOKEN 等会话变量；token 永不进 argv/日志/prompt。
  - issue 标题带 triage 前缀标记（`[bug]`/`[design]`/`[discuss]`），body 由
    `viewer/audit-report.js` 的 `buildChangeDraft(report)` 渲染 + 问题描述/change_ref/
    讨论摘要；渲染前 `redactText` + `redactKey`。**默认不传 `--label`**（避免依赖仓库预建
    label），`labels` 选项显式传入时才附加。
  - 错误映射：ENOENT → "gh 不可用（请先安装 GitHub CLI）"；stderr 含未登录/`gh auth
    login` → "gh 未登录"；非零退出 → 带退出码中文错误（stderr 经 `redactKey(_, envKey)`
    净化）；超时（默认 60s）→ kill + 超时错误。
  - `dryRun` 只返回将要执行的 argv，不 spawn gh（测试用）。
- `tools/github.test.mjs`（新增，15 个）：argv/body 构造、env 净化、退出码映射（未登录/
  非零/ENOENT/超时）、token 不进 argv/日志、dryRun 不 spawn、repo 解析两级回退、成功解析
  issue 号、默认无 --label / 显式 labels 才附加。
- `tools/service.mjs` `POST /problems/:id/github`：调 `createGithubIssueFn`（可注入），
  成功 `setGithubRef` 回写 `{ issue_number, url, synced_at }`；失败返回 502 + 明确错误且
  problem 不变；dryRun 200 不写。

### Slice 4 — viewer 问题管理页（tasks 4.1–4.3）

- `viewer/problem-view.js`（新增，纯函数 + 可注入 fetch 的 API 客户端）：
  - 枚举/徽章：`triageBadgeClass`（bug 红/design 蓝/discuss 黄/defer 灰/wontfix 黑灰）。
  - 来源 `problemSourceLabel`（task/observation/人工）、时间 `formatProblemTime`（UTC
    固定格式，确定性）、标题摘要、`filterProblems`（triage/status）、`normalizeProblem(s)`
    （字段兜底）。
  - 动作：`buildProblemPatch`（空 reason 不携带）、`validateProblemAction`
    （defer/wontfix 前端必填 reason）。
  - 渲染数据：`discussionToRender` / `problemDetailToRender`（复用 `formatReportSummary`
    + redactText，决策轨迹/讨论区文本全部抹除凭证形片段）。
  - `createProblemApi({ endpoint, fetchImpl })` —— list/create/get/patch/discuss/github
    六端点，响应归一 `{ ok, status, data }`，网络异常向上抛（调用方显示「服务不可达」）。
- `viewer/problem-view.test.js`（新增，17 个）：枚举/徽章/来源/时间/摘要、筛选、归一化、
  动作构造/校验、讨论/详情 redaction、API 客户端 fake-fetch（URL/method/body、非 ok、
  网络失败传播）。
- `viewer/app.js`（扩展）：
  - 顶部「比赛 / 问题」视图切换（`#view-tabs` + `#match-view`/`#problem-view` 互斥显示）。
  - 问题列表：标题、triage 徽章、status、来源、issue 号链接、change_ref、时间；按
    triage/status 筛选；`GET /problems` 拉取，服务不可达显示回退提示。
  - 详情：完整诊断报告（`formatReportSummary`）+ triage 徽章 + 决策轨迹 + 动作面板
    （bug/design/discuss 分类、defer/wontfix 弹输入框要求 reason、重开、标记
    in_progress/fixed/closed、填 change_ref、提交/转为 GitHub issue；**defer/wontfix
    的提交 issue 按钮禁用**）+ 讨论区（留言列表 + 作者/文本输入 + 留言）。
  - 动作走 `PATCH /problems/:id`、`POST /problems/:id/discussion`、
    `POST /problems/:id/github`；所有展示文本 `textContent` + `redactText`。
  - 观察面板 triage 动作面板（`renderReportActions`）追加「创建问题」按钮（诊断终态
    有 task_id 时）→ `POST /problems {task_id}` → 成功切问题视图；服务不可达 showNotice
    回退，不阻塞诊断链路。
  - **cache-busting → `20260826-14`**：`index.html` script + `app.js` 全部顶层 import +
    `VIEWER_SOURCE_REVISION = 'viewer-js:20260826-14'` 三处一致。
- `viewer/index.html`（扩展）：`#view-tabs`、`#match-view` 包裹、`#problem-view`（筛选/
  列表/详情容器）、问题卡片/徽章/详情 CSS、`[hidden]` 显式覆盖（`#match-view` 的
  `display:flex` 不被 `hidden` 覆盖）。

## 运行命令

```bash
node --test tools/*.test.mjs          # tools 全量
cd viewer && node --test *.test.js    # viewer 全量
openspec validate p11-problem-lifecycle --strict
./verify.sh                            # cargo + viewer + WASM e2e
```

## 测试结果（Slice 1-4 完成后 + 审阅修复）

```
tools:  # tests 199 / # pass 199 / # fail 0   （P10 基线 148 + problems 27 + github 15 + service 9）
viewer: # tests 214 / # pass 214 / # fail 0   （P10 基线 197 + problem-view 17）
openspec validate --strict: valid
./verify.sh: 全部通过
rg 凭证扫描（strict 非测试）: sk-ant/sk-proj/ghp_/github_pat_ 值命中 0
```

> 审阅修复后：problems 27（+9：组合 patch 2 + 通用凭证净化 4 + 值形净化 1 + 对象键名净化 2）、
> github 15（+1：默认无 --label / 显式 labels）、service 9（+1：通用凭证净化）。

## 关键设计 / 约定

- **决策审计**：triage/status 每次流转追加 `{ action, from, by, at, reason }`；
  `defer/wontfix` 强制 reason 且 status 强制 `closed`；重开 = triage 改回 + status→open
  （可被显式 status 覆盖）。
- **凭证纪律**：服务端对用户可控文本（author/text/statement）先 `redactKey` 再落盘，
  problems.mjs 持久化再有 final safety net；gh 子进程环境复用 `sanitizeChildEnv`
  （剔 CLAUDE_CODE_*/ANTHROPIC_AUTH_TOKEN 等，保留 ANTHROPIC_API_KEY）；token 不进
  argv/日志/prompt；viewer 全部渲染 `textContent` + `redactText`，browser 零凭证接触。
- **原子写**：`<tasks-dir>/problems/<id>.json` tmp+rename；损坏文件读为 404/跳过。
- **GitHub 单向同步**：本地 → issue 仅创建；issue 状态回读留待后续（design Non-Goals）。

## 遗留风险 / 待办

- **真实 `gh issue create` 未做集成测试**（约束：测试不调外部命令；全用 fake child）；
  需用户本机 gh 登录验收（token scopes 需 repo）。
- **真实 provider 诊断端到端**（P10 5.5）仍属用户带 `ANTHROPIC_API_KEY` 验收。
- **app.js 接线为 thin DOM glue，未被 node:test 直接覆盖**：其数据逻辑（列表渲染数据/
  筛选/动作构造/redaction/API 调用）全部下沉到 `problem-view.js` 并有 fake-fetch 单测；
  DOM 层符合既有模式（app.js 不进测试，`node --check` 校验语法）。
- **`by` 固定为 'user'**：服务端未区分 agent/人工（讨论作者由页面输入，默认 'user'）。
- **`/problems/:id/github` 对外发布副作用**：在宽松 localhost CORS 模型下，任何本地端口
  的页面可触发 `gh issue create`（对外发布动作）；token 不离开本机，但动作可被触发，
  建议仅本机使用（见 design.md Risks）。

## 审阅修复（2026-08-27，spec 1 major + 4 minor；standards 1 minor + nits）

针对两轮独立审查的发现逐项修复，全部落地为测试或契约收窄。

1. **[major] 组合 PATCH 静默丢弃 status**（`tools/problems.mjs`）：普通分类流转分支
   现在应用 `patch.status`（若提供）并追加对应 decisions 记录。补测试：组合 patch
   （triage+status 同时变 → 两者生效、两条 decisions）、只改 triage → status 不变、
   非法 status 拒绝且无部分应用。
2. **[minor] create-from-report 丢失 observation_id**（`tools/service.mjs`）：`source`
   补 `observation_id`（来自原 bundle）。补测试断言。
3. **[minor] defer/wontfix 仍可提交 GitHub issue**（`viewer/app.js`）：详情动作面板对
   defer/wontfix 禁用「提交 GitHub issue」按钮；discuss 保留「转为 issue」。
4. **[minor] 存储前净化缺通用凭证形**：`tools/provider.mjs` 新增
   `redactCredentialText`（与 viewer redactText 同规则：凭证形值 + JSON 风格键值对 +
   未加引号 `KEY: value`/`KEY = value`，键名 token/secret/api_key/authorization 等）。
   `problems.mjs` 持久化对每个 string 值做 `redactCredentialText(redactKey(_, envKey))`
   深度净化；`service.mjs` 响应组合与 discussion 边界同规则。补测试：讨论/描述含
   `"client_secret":"x"` → 落盘已抹值；合法文本（"token: of the month"、CJK key、
   `lib.rs: ...`）不误伤。
5. **[minor] gh label 依赖仓库预建 label**（`tools/github.mjs`）：**默认不传 `--label`**，
   triage 由标题 `[bug]`/`[design]`/`[discuss]` 前缀标记；`labels` 选项显式传入时才附加。
   spec.md/design.md 措辞同步（"含 triage 分类标签" → "标题带 triage 前缀标记"）。
6. **[minor] github 端点对外发布副作用说明**：design.md Risks 与 implementation.md
   遗留风险显式记录 `/problems/:id/github` 在宽松 localhost CORS 下可被本地任意端口页面
   触发对外发布动作；token 不离开本机，建议仅本机使用。
7. **[nit] tooltip 绕过 redactText**（`viewer/app.js`）：`title.title` 改为 `redactText(p.title)`；
   issue 链接 `a.href` 加 scheme 白名单（仅 http:/https:，否则不渲染为链接，列表与详情两处）。
8. **[nit] mapGhFailure 净化带 envKey**（`tools/github.mjs`）：`redactKey(stderr, envKey)`
   ——存活 key 值也绝不进 gh 失败错误消息。
9. **[nit] implementation.md 计数修正**：problems 18→25、github 14→15、service +8→+9；
   补本审阅修复记录。
- cache-busting bump：`20260826-13` → `20260826-14`（index.html + app.js 全部 import +
  `VIEWER_SOURCE_REVISION` 三处一致）。

### 不修（记录）

- `service.mjs` NOT_FOUND 死代码分支（保留无害）。
- 内存对象不净化（设计如此，头注已声明；落盘与响应路径均已净化）。

### 最终验证（审阅修复后）

```
node --test tools/*.test.mjs        # 197 pass / 0 fail
cd viewer && node --test *.test.js  # 214 pass / 0 fail
openspec validate p11-problem-lifecycle --strict   # valid
./verify.sh                          # 全部通过
rg 凭证扫描（strict 非测试）         # sk-ant/sk-proj/ghp_/github_pat_ 值命中 0
grep 20260826-14 viewer/index.html viewer/app.js   # 三处一致（1 / 10 / VIEWER_SOURCE_REVISION）
```

## 终审修复（2026-08-27，二次 review 3 项）

1. **[minor] 落盘路径对象键名不净化**：`tools/problems.mjs` `deepRedactText` 递归时对键名
   含凭证词（token/secret/api_key/authorization 等，复用 `provider.mjs` 导出的
   `hasCredentialTerm`）的对象，其值整体替换为 `[REDACTED]`（含嵌套对象/数组，与响应路径
   `redactProblemJSON` 行为一致）。补测试：嵌套 `client_secret` 键对象落盘已净化；合法键
   （layer/root_cause/task_id/change_ref/github.issue_number/url）不误伤。
2. **[nit] github.mjs 过时注释 + 死字段**：头注与 `TRIAGE_VALUES` 注释改为「标题前缀标记」
   （非 label）；`buildIssuePayload` 删除死字段 `labels: [triage]`（`createGithubIssueImpl`
   只解构 title/body）；对应测试断言同步删除。
3. **[nit] spawn-error 净化漏 envKey**：`tools/github.mjs` `redactKey(spawned.spawnError.message)`
   → 补 envKey（与 mapGhFailure 一致）。
- cache-busting 不动（viewer 无改动，保持 `20260826-14`）。

### 最终验证（终审修复后）

```
node --test tools/*.test.mjs        # 199 pass / 0 fail
cd viewer && node --test *.test.js  # 214 pass / 0 fail
openspec validate p11-problem-lifecycle --strict   # valid
./verify.sh                          # 全部通过
rg 凭证扫描（strict 非测试）         # sk-ant/sk-proj/ghp_/github_pat_ 值命中 0
```
