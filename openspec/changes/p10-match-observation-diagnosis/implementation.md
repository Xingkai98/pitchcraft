# P10 第一个纵向切片实现记录

日期：2026-08-26（切片 1 + 审阅修复补丁）
范围：`tools/bundle.mjs` + `tools/detectors.mjs` + Node 单测。

## 目标

为 `match-observation` 与 `match-audit` 两条 spec 先搭起一条**无依赖、确定性、可人工审查**的最小纵向链路：版本化 observation bundle 形状校验 + 凭证抹除，以及三个首批 detector 的确定性审计。本切片不含 viewer 采集、本地服务、Claude 诊断或运行命令。

## 改动文件

- `tools/bundle.mjs`（新增）：观察包形状校验与凭证安全。
  - `validateObservationBundle(bundle)` → `{ valid, errors }`。校验 `schema_version` / `observation_id` / `seed` / `config` / `match_time` / `window` / `events` 七个核心字段的类型与存在性；并对凭证做硬性拒绝。`seed` 接受 string 或 number（引擎/viewer 用数值 seed）。
  - `redactCredentials(obj)` → 深克隆，把命中凭证键的值替换为 `[REDACTED]`，**不改动输入**。凭证键的值无论标量、对象还是数组都整体抹除。
  - `assertNoCredentials(obj)` → 发现存活凭证即 throw（含凭证键持有对象/数组的情况）；错误消息只含字段路径，绝不含秘密值。
  - 凭证键判定（归一化 key 后子串匹配，宁可过度抹除）：`apikey` / `token` / `secret` / `authorization`（覆盖 `ANTHROPIC_API_KEY`、`api_key`、`accessToken` 等）。
- `tools/detectors.mjs`（新增）：`DEFAULT_AUDIT_PROFILE` + `runAudit(input, profile)`。
  - 输入形状：`{ events: [...], players: { <id>: [snapshot...] } }`。纯函数，无副作用。
  - `unforced_out`：统计 `type==='pass' && result==='out'`；排除 `dead_ball/clearance/corner/throw_in/goal_kick/contested`；`nearest_defender_distance > pressure_distance` → finding；压力证据缺失 → `unknown`。另支持近边线观察：传球 `result !== 'out'` 但落点 `x2/y2` 距边界小于 `unforced_out.boundary_margin`（pitch 默认 105x68，坐标假设 [0,width]x[0,height]）时，无法证明出界 → 输出 `unknown`（携带落点与 boundary_distance）。
  - `inactive_responsibility`：按球员对 snapshot 按 `t` 排序，切出「责任触发 + 连续站桩(ε 内静止)」的连续段；排除死球 / 门将固定 / 阵型保持 / 向球或目标移动；段长超过 `static_duration` → finding；无任何责任触发证据 → `unknown`。
  - `ignored_interception_opportunity`：对传球事件用 `corridor_distance/pass_distance/pass_speed` 求防守者到达时间与球到达时间，`defender_arrival + margin < ball_arrival` 且防守者未朝走廊移动 → finding；走廊证据缺失 → `unknown`。
  - 输出：`{ profile: { id, version }, findings: [...] }`；finding 含 `id/detector_id/severity/match_time/event_index/entity_id/features/thresholds/reason`，且每个 finding 都携带 `profile_id` / `profile_version`（不只顶层 audit 结果）。id 由事件索引/球员 id/时间推导，天然确定性（同一 bundle 重复审计结果一致，有单测覆盖）。
- `tools/bundle.test.mjs`、`tools/detectors.test.mjs`（新增）：全部用 fixture 事件/快照数组，无 WASM、无真实 Claude/API 调用。覆盖：校验通过/缺失字段/凭证拒绝、递归抹除且不改输入、`assertNoCredentials` 抛错且错误不含秘密值、三类 detector 的正常命中/排除/unknown、确定性。

## 运行命令

```bash
cd <repo>
node --test tools/bundle.test.mjs tools/detectors.test.mjs
```

结果：切片 1 首次 17 个测试全部通过；审阅修复补丁后 23 个测试全部通过。见下文「测试结果」。

## 测试结果

```
# tests 23
# pass 23
# fail 0
# duration_ms ~123
```

## 已知 MVP 限制（切片 1 的历史记录，后续切片已解决）

> 本节记录切片 1 当时的限制。后续切片/审阅轮次已解决其中大部分：核心字段现为
> `engine_snapshot/viewer_snapshot/audit_input/source_revision` 全必填（含凭证值形拦截、
> 键名+值形双重检测）；特征推导已实现（`viewer/derive-audit-features.js`，几何压力/走廊/责任）；
> baseline invariant（task 2.2）、多 seed 聚合（task 2.6）、runner/provider adapter、viewer 集成均已实现。
> 仍成立的限制以「最终审阅修复」与「最终验证」为准。

- `validateObservationBundle` 目前只校验核心 7 字段；`statement / selected_entities / engine_snapshot / viewer_snapshot / audit_input / source_revision` 为可选，尚未强制。
- 凭证检测为**键名**判定（含子串），不做值内容嗅探；过度抹除可接受，但不会识别「放在普通键名里的秘密值」。
- 近边线判断假设落点坐标位于 `[0, pitch.width] x [0, pitch.height]`（默认 105x68）。若引擎坐标是居中（如 -52.5..52.5）或归一化（0..1），需要按实际坐标约定调整 `distanceToBoundary` 与 `pitch` 默认值。
- 三只 detector 消费的是「已带特征的事件/快照」（如 `nearest_defender_distance`、`corridor_distance`）。这些特征当前由 fixture/调用方提供，引擎事件流到特征值的推导（几何计算）尚未实现。
- `inactive_responsibility` 的「向责任区/回防目标移动」目前用 `moved_toward_goal / moved_toward_ball` 标志近似，未做目标几何计算。
- 所有 finding 默认 `realism_warning`，未接参考带 / 聚合样本数（task 2.6）。
- 尚无 baseline invariant 检查（task 2.2）、聚合评估（task 2.6）、runner / provider adapter（section 3）或 viewer 集成（section 4）。

## Slice 2（2026-08-26）— Local Diagnosis Runner（tasks 3.1–3.7）

范围：本地诊断 runner 的最小可运行切片。不含 viewer 集成（section 4）。

### 改动文件

- `tools/provider.mjs`（新增）：provider adapter 接口 + `ClaudeCodeAdapter`（评审修复：stdin prompt、`--bare`、`--output-format text`、`--permission-mode plan` + `--disallowedTools`、非零退出码视为 error）。
  - `createProviderAdapter(config)`：按 `provider` 名分发；当前仅 `claude-code`，其它抛错。
  - `ClaudeCodeAdapter.run(prompt, { env, timeoutMs })`：通过 `child_process.spawn` 调用本机 `claude`，**prompt 经 stdin 传入并 `end()`**（有 fake-child 测试断言 stdin 收到完整 prompt 且被关闭）；`model`、`timeout` 可配；超时 `kill()` 子进程并返回 `{ status:'timeout', timedOut:true }`；`env.ANTHROPIC_API_KEY` 缺失时**不 spawn**，返回 `provider_unavailable`。
  - 参数向量：`-p --output-format text --input-format text --bare --permission-mode <mode>`（该轮历史值曾写作 `-p - ...`，但 `claude --help` 无 `-` stdin 哨兵，`-` 会被当作字面 prompt 导致 stdin 被忽略；最终裁定见文末「最终审阅修复六」）。`--bare` 关闭 claude 的 keychain/OAuth 读取，改用 `ANTHROPIC_API_KEY`/apiKeyHelper 路径（用户要求本地 API-key 认证，非 claude auth）。`text` 输出让 stdout 直接是模型的 JSON 文本（规避 `json` 输出被 CLI result 对象包裹的问题）。
  - prompt 经 stdin 交付并 `end()`；**stdin 异步 EPIPE（子进程提前退出）用 `error` 监听器兜底**，避免未处理事件导致 runner 崩溃；良性错误（EPIPE/ERR_STREAM_DESTROYED）忽略，其它 stdin 错误由子进程 close/error 权威路径暴露（不会重复 resolve）。
  - 只读意图默认映射到合法的 Claude 模式 `plan`（只读、无 Edit/Write 工具）；并追加 `--disallowedTools Edit Write NotebookEdit MultiEdit` 作为可验证的兜底。**只要 `read_only` 为 true，无论配置哪个合法 permission 模式都会禁用编辑工具**（不只限于 plan 模式）。**限制**：`plan` 模式下 agent 的验证命令执行受约束/延后，验证命令由用户或后续流程执行。
  - **非零退出码一律视为 provider error**（即使 stdout 看似合法，也不得诊断成功），并把 stderr 安全抹除后写入 error。
  - 认证只存在于 runner 进程环境，绝不写入 prompt、argv、日志或持久化输出；有 args 测试断言 argv 不含 key、不含 `sk-ant-*`。
  - `redactKey(text, secret)`：把存活 key 值与通用 `sk-ant-*` 串替换为 `[REDACTED]`（防御性兜底）。
- `tools/runner.mjs`（新增）：编排 + prompt + 校验 + 持久化。
  - `DEFAULT_RUNNER_CONFIG`：`provider:'claude-code'`、`command:'claude'`、`permission:'read-only'`、`read_only:true`、`budget:null`、`timeout_seconds:300`、`max_retry:1`。
  - `buildDiagnosisPrompt({bundlePath, auditPath, replayInstructions, sourceRevision, bundleSourceRevision, statement, permission})`：引用 bundle、audit、重放/验证说明、当前源码修订（runner/checkout）与 bundle 来源修订（provenance）；明令只读、禁止改源码/配置/OpenSpec/测试；无法复现则必须返回 `insufficient_evidence`，禁止编造根因；要求返回固定 JSON 字段。
  - `validateDiagnosisReport(report)`（评审修复：类型与置信度区间、JSON 文本抽取）：校验 8 字段齐全；`status ∈ {diagnosed, insufficient_evidence}`；`phenomenon_summary/layer/root_cause/proposed_fix/verification` 必须为 string（`insufficient_evidence` 时用空串而非 null）；`hypotheses` 必须为 string 数组；`confidence` 必须为 [0,1] 数字；经 `assertNoCredentials`。`extractReportJSON` 处理 `--output-format text` 的原始输出（去 markdown fence、必要时切出最外层 JSON 对象）。无效输出一律不得标记为 diagnosed。
  - `runDiagnosis(...)`：读 bundle → `validateObservationBundle` → `runAudit` → 写 audit report（含 source_revision/observation_id/seed/match_time/findings）→ 环境 gating（key 缺失→`provider_unavailable`，不 spawn）→ 构造 prompt → 注入 adapter 执行（失败/超时/无效输出，按 `max_retry` 重试无效输出；**即使输出合法，非零退出码也判为 error，不得 diagnosed**）→ 校验输出 → 持久化。原始输出单独写 `<runId>.raw.txt`，结构化 report 写 `<runId>.task.json`；持久化前用 `redactTaskText` 兜底抹除值级凭证。
  - 任务记录字段：`run_id / status / input_summary(bundle,audit,revision,observation_id,seed,match_time,finding_count) / provider{...} / started_at / ended_at / command_exit_status / report / raw_output_ref / errors / retries{attempts,max_retry,reasons}`。
- `tools/runner-cli.mjs`（新增）：无依赖 CLI。必需参数 `--bundle --audit --replay --revision --tasks-dir`；可选 `--provider --command --model --permission --timeout --max-retry --statement`。校验 bundle → 运行 audit → 协调诊断；stdout 打印已抹除的任务 JSON；退出码 0=diagnosed、3=insufficient_evidence、1=其它（含 provider_unavailable）。
- `tools/runner.test.mjs`（新增，评审后 39 个）：覆盖 provider unavailable、stdin 收 prompt、**stdin 异步 EPIPE 与其它 stdin error 不崩溃且经 close/error 正常 resolve**、`--bare`/`plan`/`--disallowedTools` args 断言、read_only 与 permission 模式无关地禁用编辑工具（read_only=false 时省略）、key 不进 argv、非零退出码判 error、runDiagnosis 非零退出/error 不 diagnosed、无效输出、adapter 超时（fake child）、redaction/凭证不泄漏（含 sourceRevision/replayInstructions/输入路径的 scrubbing）、合法/`insufficient_evidence` 报告、fence JSON 抽取、null root_cause / 非数组 hypotheses / 越界 confidence 拒绝。全部用 fake adapter / fake child process，**无真实 Claude/API 调用**。

### 运行命令

```bash
cd <repo>
node --test tools/*.test.mjs
```

### 测试结果

```
# tests 70   （bundle 18 + detectors 13 + runner 39；本切片当时计数）
# pass 70
# fail 0
```

> 最终计数以文末「最终审阅修复六」为准（tools 106 / viewer 146）。

### 已知 MVP 限制（后续切片处理）

- `runDiagnosis` 仍假设 bundle 已落盘为 JSON 文件；本地 HTTP service（浏览器提交）与 viewer 集成留到 section 4。
- `budget` 已映射到本机 `claude` 的稳定参数 `--max-budget-usd <amount>`（`claude --help` 可见，仅 `--print` 生效）；`config.budget` 为正有限数时才加该参数，未设置/非正时不加。argv 有单测断言。
- 验证命令契约（最终裁定）：diagnosis Agent 在只读模式（`--permission-mode plan` + `--disallowedTools Edit Write NotebookEdit MultiEdit`）下读取证据与代码，并在报告 `verification` 字段**提出**可复现的验证命令；命令的**执行**由 runner 或用户另行完成。非交互 `--print` 会话不承诺执行完整验证流水线，plan 模式也从工具层面禁止修改文件。
- 真实 `claude` 子进程路径未做集成测试（约束：测试不调真实 API）；adapter 用 fake child 覆盖 stdin 交付、超时、未认证、非零退出码路径。`--bare`/`plan`/`--disallowedTools`/`--output-format text` 与本地 claude 版本的兼容性属用户验收环节。
- 重放说明 `replayInstructions` 目前由 CLI 调用方传入字符串，尚未从 bundle 自动生成确定性重放命令。

## 建议下一步

1. 打通「引擎事件流 → detector 特征」的推导层（几何压力、责任区、传球走廊）。
2. 实现 task 2.6 多 seed 聚合。
3. 接 bundle 导出/导入与 CLI 重放（task 1.4）。
4. section 4：viewer 提交观察 + 诊断状态展示 + 跳回原比赛时刻。

## Slice 3（2026-08-26）— Viewer Integration（tasks 4.1–4.4, 5.1）

范围：browser 侧观察采集 + 审计/诊断报告展示集成。**不含本地 HTTP 服务**（提交回退为导出 + CLI）；**不调真实 Claude/API**；**browser 永不接触 `ANTHROPIC_API_KEY`**。

### 改动文件

- `viewer/observation.js`（新增，纯函数、浏览器/Node 双端可测）：
  - `captureObservation({ game, statement, selectedEntities, window, seed, config, sourceRevision, opts })` → 版本化 ObservationBundle。字段：`schema_version`(=1)、`observation_id`、`seed`、`config`、`match_time`、`window`、`source_revision`、`selected_entities`、`statement`、`events`（观察窗口内 viewer 事件，前置 lineup 作上下文）、`lineup`、`viewer_snapshot`（players/ball/current_event_index/play_time/event_count）、`captured_at`。**所有数据深克隆**，后续游戏态变更不影响 bundle；**不含任何凭证**。`opts.{idFactory, now}` 供测试注入确定性 id/时钟。
  - `buildAuditInput({ game, bundle, config })` → `{ events, players }`（米制，供 detectors 消费）。窗口事件 `x/y/x2/y2` 归一化→米（x 沿 `config.pitch.lengthMeters`，y 沿 `widthMeters`）；安全时补 `pass_distance`。detector 专属字段（`nearest_defender_distance`、`corridor_distance`、`pass_speed`、`result`、`dead_ball` 等）在 viewer 无证据时**保持缺失** → 审计对缺失维度输出 `unknown`，不伪造结论。逐球员从 `game.timeline` 窗口内构建米制快照（无 responsibility 标记 → `inactive_responsibility` 输出 unknown）。
  - `buildCliCommandTemplate({ revision, statement })` → `node tools/runner-cli.mjs --bundle … --audit … --replay … --revision … --tasks-dir …` 模板，路径用显式占位符（browser 不知道落盘路径），**无任何秘密**。
- `viewer/audit-report.js`（新增，纯函数）：
  - `parseAuditImport(text)`：解析粘贴的 audit / task / report JSON（识别 `findings[]`、`report.findings[]`、`report{诊断字段}` 三种形状）；非法 JSON / 无法识别 → 返回 `{ kind, errors }`，不抛异常。
  - `formatFinding(f)` / `findingMarkers(findings)`：单行摘要 + 时间线 markers（`event_index` / `match_time` / `entity_id` / `severity`）。
  - `formatReportSummary(report)`：诊断摘要（现象/层次/根因/建议/验证/假设/置信度），不含凭证。
- `viewer/index.html`：新增「观察采集 / 诊断 (P10)」折叠面板：采集按钮 + 状态显示、陈述 textarea、before/after 窗口、选中实体 ids、导出/提交按钮、CLI 模板 pre、导入 JSON textarea + findings/report 渲染区。cache-busting 当前 `?v=20260826-9`（最终审阅修复后 bump，见文末「最终审阅修复六」）。
- `viewer/app.js`：接入上述控件。`captureCurrentObservation`（暂停 + 采集 + CLI 模板）、`downloadBundle`（Blob 下载，导出前 `redactBundleForExport` 深度抹除凭证）、`submitObservation`（本地端点未配置/不可用 → `provider_unavailable` 回退导出+CLI；browser 只见状态/错误摘要，错误文本先 `redactText` 抹除）、`importAuditReport`（渲染 findings + report + markers）、`jumpToFinding`（优先 `event_index` 跳事件，回退 `match_time` seek）。顶层 import 版本号同步 `?v=20260826-9`。
- `viewer/observation.test.js`、`viewer/audit-report.test.js`（新增，纯 Node 单测，共 29 个）：bundle 全字段 + 通过 `tools/bundle.mjs` 校验、**bundle 携带 `audit_input`（米制 + pass_distance）且仍过校验**、快照克隆隔离、detector 字段缺失、归一化→米 + pass_distance、逐球员米制快照、CLI 无秘密；`opts.now` 支持函数注入；选中实体回退到当前事件参与者；audit 导入三形状 / 非法 JSON / markers / 报告摘要无秘密 / **导入文本渲染前抹除 `sk-ant-*` 与凭证键值片段**；**CLI 模板对 statement/revision 做 POSIX 单引号转义**（`$()`、反引号、`$VAR`、单双引号、反斜杠、换行均安全，占位符保持可读）。无 DOM、无 WASM、无网络。

### 运行命令

```bash
cd viewer && node --test *.test.js        # 135 个
node --test tools/*.test.mjs               # 82 个
openspec validate p10-match-observation-diagnosis --strict   # valid
```

### 测试结果

```
viewer: # tests 139 / # pass 139 / # fail 0
tools:  # tests 93  / # pass 93  / # fail 0
```

### 审阅修复（Supervisor review）

1. `captureObservation` 现在把 `buildAuditInput` 结果写进 bundle 的 `audit_input`（米制事件 + 逐球员米制快照），导出/提交即携带。`tools/runner.mjs` 优先审计 `bundle.audit_input`，避免把归一化 [0,1] viewer 坐标当米（会破坏近边线/无压力出界证据）。新增 runner 测试证明 `runDiagnosis` 用 `audit_input` 的米制特征（`pass_distance=40`）产出 `unforced_out` finding，而非原始归一化事件。
2. `opts.now` 同时支持值或函数（测试注入时钟）。
3. 选中实体为空时回退到当前事件参与者（`resolveObservationSelection`：highlight 优先，其次当前事件 subject/from/to）；app 采集时应用。
4. `viewer/audit-report.js` 渲染路径（`formatFinding` / `formatReportSummary` / `parseAuditImport` errors）在展示前用 `redactText` 抹除 `sk-ant-*` 串与凭证键值片段。browser 无法知道存活 key，但可识别并抹除 key 形片段。

### 已知 MVP 限制（后续切片处理）

- **无本地 HTTP 服务**：`OBSERVATION_ENDPOINT = null`（`viewer/app.js`），提交按钮自动回退为「导出 bundle + CLI」；配置了本地端点后同路径即接上，browser 仍只见状态摘要。
- Rust 侧已在最终验证里跑通：`./verify.sh` 全绿（cargo test 32 + viewer 144 + WASM e2e OK），见文末「最终审阅修复四」。
- 独立审阅 agent（5.4）已跑并解决全部发现（见 tasks.md 勾选）；整条 fixture 端到端（5.5，需本地服务 + 真实诊断）仍未跑，属未来工作；真实 `claude` 子进程路径仍属用户验收（约束：测试不调真实 API）。

## 审阅修复（Supervisor review，2026-08-26）

本次针对 P10 当前切片，收窄修四类 spec 发现 + 一处文档/缓存问题，不实现 task 2.6 多 seed 聚合，不建本地 HTTP 服务。

### 1. observation bundle 增加必填 `engine_snapshot`

- `viewer/observation.js` 新增 `buildEngineSnapshot(game, matchTime, win)`：诚实 MVP 快照，只反映 viewer 可见的引擎/事件流事实——`kind: 'event-stream'`、`source`、`match_time`、`current_event_index`、`event_count`、`window`、`lineup`；**不伪造隐藏引擎状态**，全部深克隆。
- `tools/bundle.mjs` 把 `engine_snapshot` 加入 CORE_FIELDS（`object` 必填）。缺省/非对象 → 校验失败。
- 测试：bundle 含 `engine_snapshot` 且过 `validateObservationBundle`；缺失 / 非对象判非法。

### 2. `source_revision` 必填非空 string

- `tools/bundle.mjs`：`source_revision` 加入 CORE_FIELDS（`string` 必填），并额外校验非空（`trim()===''` 判非法）。
- `viewer/observation.js`：`captureObservation` 未注入具体版本时以 `'<source-revision>'` 占位符兜底（标记待填，不是真实修订证明）。
- `viewer/app.js`：`VIEWER_SOURCE_REVISION` 传入 `captureObservation`——本切片无法读 git，用与 cache-busting 同步的 viewer 资源版本串（**非 git commit hash**）。当时为 `viewer-js:20260826-3`（该轮历史值；当前最终版本见文末「最终审阅修复六」/`20260826-9`）。CLI 模板的 `--revision` 仍保留 `<source-revision>` 占位符供用户填具体 checkout。
- 测试：缺失 / null / 空串 `source_revision` 判非法；captured bundle 携带 string。

### 3. runner 任务状态对齐 match-observation spec

- `tools/runner.mjs` 的 `TASK_STATUSES` 收敛为 spec 词表：`captured / auditing / audit_ready / diagnosing / diagnosed / insufficient_evidence / provider_unavailable / failed`。
- **不再把内部状态写进 `task.status`**：`invalid_bundle / bundle_read_error / audit_write_error / timeout / provider_error / invalid_agent_output` 通过新字段 `failure_kind` + `errors` + `retries.reasons` 保留细节，`status` 统一为 `failed`。
- 新增 `status_history: [{status, at}]`，记录 `auditing → audit_ready → diagnosing → <final>` 转换（`diagnosed / insufficient_evidence / provider_unavailable / failed`）。
- CLI 退出码不变：diagnosed=0、insufficient_evidence=3、其它=1。
- 测试：`TASK_STATUSES` 词表断言；diagnosed 任务 `status_history` 序列 `['auditing','audit_ready','diagnosing','diagnosed']`；非法 bundle → `failed/invalid_bundle`；各失败路径 `failure_kind` 断言。

### 4. 凭证泄漏加固：不止键名，值形也拦

- `tools/bundle.mjs`：新增 `isCredentialValue`（`/sk-ant-[A-Za-z0-9_-]+/`），`redactCredentials` 与 `assertNoCredentials` 对任意键下的凭证形 string 值一律抹除/拒绝；错误消息仍只含路径、绝不含值。
- `viewer/observation.js`：`redactCredentialText` 抹除 `sk-ant-*`，应用于 `statement` 与 CLI 模板值。
- `tools/runner.mjs` `runDiagnosis`：构造 prompt 前用 `redactKey(statement, env.ANTHROPIC_API_KEY)` 抹除 CLI 传入 statement 里的 key；结构化报告若含凭证形值，判为 `failed / invalid_agent_output`（拒绝而非接受后抹除持久化），raw 输出仍单独落盘并抹除。
- 测试：bundle validator 拒绝 `statement: "sk-ant-…"`；`redactCredentials` 抹除此类值；captured bundle / CLI 模板不含 `sk-ant-`；fake-adapter 抓 prompt 证明不含 statement 里的 key。

### 5. 缓存版本 + 文档（该轮历史值）

- cache-busting 当时统一为 `?v=20260826-3`（该轮历史值；当前最终版本为 `20260826-9`，见文末「最终审阅修复六」）。`viewer/index.html` 的 `<script>` 与 `viewer/app.js` 全部顶层 import 一致；`VIEWER_SOURCE_REVISION` 与之同步。改动任何 viewer JS/HTML 后须再 bump。
- 本文件上文中过期版本号（`20260826-1`/`-2`）当时已对齐为 `20260826-3`。

## 最终审阅修复（final spec review，2026-08-26）

本轮针对最终 SPEC 审阅发现的修复，全部落实为可测试的实现或诚实的契约收窄；未伪造引擎内部事实。

### 1. 多 seed 聚合（task 2.6）

- `tools/detectors.mjs`：`runAudit` 新增 `stats`（每 detector 的 `samples` / `determinate` / `unknown` / `unknown_reasons`）；新增 `aggregateAudit(audits, { profile, referenceBands })`，输出样本数、异常数/异常率、参考带、band_state、`aggregate_severity` 与未知原因汇总。参考带默认未校准（MVP，design.md open question）；传入已校准 `referenceBands` 且异常率超上限时升级为 `realism_failure`——即 `realism_failure` 分类路径经聚合产生，不做单片段臆断。
- `tools/runner.mjs`：audit report 落盘时携带 `stats`，供跨 seed 报告文件聚合。
- 测试：`tools/detectors.test.mjs` 新增聚合 3 例（求和/升级/deterministic + 无样本 → unknown）。
- `tasks.md` 2.6 勾选。

### 2. 基线不变量（task 2.2）

- `tools/detectors.mjs`：新增 `detectInvariants`，检查事件时间单调（`invariant_event_time_order`）、坐标有限且在球场范围内（`invariant_finite_coordinates` / `invariant_coords_in_pitch`，含 5% 容差）、pass_distance 为正且不超过球场对角线。全部输出 `severity: 'invariant_violation'`——这是 `invariant_violation` 分类路径。
- `DEFAULT_AUDIT_PROFILE` 新增 `invariants` 与 `aggregation.reference_bands`；`baseline_invariant` 的参考带 `max: 0`（不变量违规即缺陷）。
- 测试：`tools/detectors.test.mjs` 新增 5 例（时间倒挂 / NaN / 越界 / 非正 pass_distance / 合法 bundle 无违规）。
- `tasks.md` 2.2 勾选。

### 3. 真实 viewer bundle 的特征推导（不再全 unknown）

- 新增 `viewer/derive-audit-features.js`：纯函数，输入归一化事件 + 锚点时间线 + lineup，输出米制 audit_input，并对**可观测几何/事件流事实**推导：
  - `nearest_defender_distance` / `nearest_defender_id`（传球起点 ↔ 对方球员插值位置）；
  - `corridor_distance` / `defender_id` / `pass_speed`（`pass_speed_source` 标注 event.speed 或 config 默认）/ `defender_moved_toward_corridor`（起点/终点到走廊距离对比）；
  - 逐球员固定步长采样 + `is_gk` / `dead_ball`（球静止 + 可观测死球标记）/ `responsibility`（`possession_transition` 或 `ball_entered_zone`，标注 `responsibility_source: 'viewer-derived'`；当前动作参与者排除）/ `moved_toward_ball` / `moved_toward_goal`。
  - 无法观测的引擎内部决策（formation_hold、engine responsibility 等）一律不推导 → 检测器输出 `unknown`。
- `viewer/observation.js`：`buildAuditInput` 改为调用 `deriveAuditInput`；`collectWindowEvents` 给窗口事件补完整事件流 `index`（finding 可跳回原时刻）。
- `tools/detectors.mjs`：`inactive_responsibility` 保留数字 entity id（`Object.entries` 的字符串键转回数字）。
- 测试：新增 `viewer/derived-audit.test.js`（5 例）：三个 detector 各自用真实 viewer 形状数据证明 `capture → audit_input → runAudit` 产出 `realism_warning`；特征来源标注断言；证据确实缺失时仍保持 `unknown`（不伪造）。`viewer/observation.test.js` 现有断言保持通过。

### 4. budget 配置真实生效

- `tools/provider.mjs` `ClaudeCodeAdapter.buildArgs`：`config.budget` 为正有限数时加 `--max-budget-usd <amount>`（本机 `claude --help` 确认的稳定参数，仅 `--print` 生效）；未设置/非正不加。
- `tools/runner-cli.mjs`：新增 `--budget USD` 选项并接入 config。
- 测试：`tools/runner.test.mjs` 新增 2 例（映射到 flag / 非正不加）。

### 5. 诊断验证命令契约（裁定：提出，另行执行）

- spec `diagnosis-runner/spec.md`：把「Agent 运行验证命令」改写为「Agent 读取证据与代码，在报告中提出可复现验证命令，由 runner/用户另行执行；Agent 仅在环境允许时运行只读验证命令；禁止修改任何文件」，并新增「Agent 提出验证命令」场景。
- `design.md` Decision 3 补充验证命令契约说明。
- `tools/runner.mjs` `buildDiagnosisPrompt`：明示 plan 只读模式、可尝试只读检查、禁止状态变更命令、`verification` 字段承载待执行命令。
- 默认 no-edit 安全保持：`plan` + `--disallowedTools Edit Write NotebookEdit MultiEdit` 不变。

### 6. unforced_out warning 补 boundary_distance

- `tools/detectors.mjs` `detectUnforcedOut`：`realism_warning` finding 的 features 在落点坐标可计算时补 `boundary_distance`（米制离最近边线距离）。
- `tools/detectors.test.mjs`：near-boundary unknown 用例已断言 `boundary_distance`；warning 路径由 `viewer/derived-audit.test.js` 断言 `< 3.0`。

### 7. 状态机/schema 措辞精确

- `tasks.md` 1.1：改为「bundle schema + 观察任务状态词表（任务生命周期才是状态机；bundle 本身无 `state` 字段）」，并勾选。不新增虚假 bundle `state`。

### 8. 标准审阅次要修复

- `tools/bundle.mjs`：`walk` 现在传完整 JSON pointer（`$/nested/auth_token`、`$/list[0]/api_key`），`assertNoCredentials` 错误消息路径精确；新增路径精确性测试。
- `tools/runner-cli.mjs` usage：`--permission` 列表改为真实模式（去掉不存在的 `default`），补 `--budget` 说明。
- `viewer/audit-report.js` `redactText`：新增未加引号 `token: xyz` / `api_key = xyz` 的保守抹除（值须 8+ 个非空白字符，避免误伤短短语）；新增 3 例测试。
- `implementation.md`：历史测试计数标注「当时计数」，最终计数以本节省为准（tools 82 / viewer 135）。

### 最终验证（2026-08-26）

```
node --test tools/*.test.mjs        # 82 pass / 0 fail
node --test viewer/*.test.js        # 135 pass / 0 fail
openspec validate p10-match-observation-diagnosis --strict   # valid
./verify.sh                          # cargo 32 + viewer 135 + WASM e2e OK，全部通过
rg 凭证扫描                           # 全部命中为测试夹具 / 抹除逻辑 / 环境 gating，无存活密钥
```

## 最终审阅修复二（final review round 2，2026-08-26）

针对第二轮最终审阅发现，全部落实为可测试的实现或诚实的契约收窄。

### 1. unforced_out 真实事件可达性（几何出界证据）

- `tools/detectors.mjs`：新增 `isOutOfPitch` 与 `outEvidenceOf`。`unforced_out` 现在把「落点在球场矩形之外（米制，`x2<0 || x2>width || y2<0 || y2>height`）」也视为出界证据（`out_evidence: 'landing_out_of_bounds'`），不再只认 `result==='out'`。压力证据缺失 → `unknown`；最近防守者超阈值且无排除 → `realism_warning`，携带 `out_evidence` / `out_reason` / `boundary_distance`。近边界但在场内、非 out → 仍是 `unknown`（不升级 warning）。
- 测试：`tools/detectors.test.mjs` 新增几何出界 warning、几何出界无压力 unknown、近边界在场内 unknown 3 例；`viewer/derived-audit.test.js` 新增归一化 `x2=1.01` → 米制越界 → `unforced_out` warning 的 viewer 端证明。

### 2. 重放场景契约收窄

- `specs/match-observation/spec.md`：「命令行重放观察」改为「命令行审计观察」——runner 对 bundle 内已保存事件窗口/audit_input 做确定性审计，seed/config/source_revision 仅作可追溯元数据；完整 seed/config 重建明确标为 1.4/5.5 未来工作，不虚假勾选。

### 3. bundle validator 必填 audit_input / viewer_snapshot

- `tools/bundle.mjs`：`audit_input` 与 `viewer_snapshot` 加入 CORE_FIELDS（非 null 非数组 object）。
- `tools/runner.mjs`：删除 `bundle.audit_input ?? { events, players }` 静默回退——缺 audit_input 的 bundle 直接校验失败（`invalid_bundle`），不再把归一化坐标当米审计。
- 测试：`tools/bundle.test.mjs` 缺/空/数组 audit_input 与 viewer_snapshot 拒收；`tools/runner.test.mjs` 缺 audit_input → `invalid_bundle`。

### 4. invariant finding 带 event_index / entity_id

- `tools/detectors.mjs` `checkCoords`：事件坐标不变量带 `event_index`（`e.index ?? i`），球员坐标不变量带 `entity_id`（数字 id 保留数字）。理由/features 保留。
- 测试：x2/y2 越界断言 `event_index`；球员越界断言 `entity_id`。

### 5. 安全/展示加固

- `viewer/app.js`：`submitObservation` 端点响应错误先 `redactText` 再渲染；`downloadBundle` 与提交 body 都经 `redactBundleForExport` 深度抹除。
- `viewer/observation.js` 新增 `redactBundleForExport`：递归抹除凭证键名（api_key/token/secret/authorization/access_token/client_secret/auth_token）与凭证形值（sk-ant-*、sk-proj-*、ghp_*、github_pat_*）。browser 侧第一道网；runner `assertNoCredentials` 仍权威。
- 测试：`viewer/observation.test.js` 新增 statement `ghp_...` 抹除、嵌套键抹除、抹除后 bundle 过 validator 3 例。

### 6. CLI 模板 shell 安全

- `viewer/observation.js` `buildCliCommandTemplate`：所有占位符单引号包裹（`--bundle '<observation-bundle.json>'`），`--replay` 也单引号；首行加 `# Paste-safe template: ...` 非命令提示。裸 `<...>` 在 shell 里是重定向，粘贴即危险。
- 测试：`viewer/observation.test.js` 断言全部占位符单引号 + 提示行。

### 7. aggregateAudit 干净语义

- `tools/detectors.mjs`：样本 >0 且异常数为 0 → `aggregate_severity: null`（干净，无事可报）；样本 0 → `unknown`；异常存在 → `realism_warning`，超校准带 → `realism_failure`。
- 测试：新增「样本存在但零异常 → null severity」。

### 8. 低层文档/tasks 清理

- `viewer/derive-audit-features.js`：GK 注释改为「home 0 / away 21」。
- `tasks.md`：勾选 1.2 / 1.3 / 5.4；1.4 与 5.5 保持未勾选并注明原因。
- `implementation.md`：版本号对齐 `20260826-5`；最终计数 tools 93 / viewer 139；切片 1 历史限制标注「已解决/以最终验证为准」。

### 9. --disallowedTools 格式确认

- 本机 `claude --help` 确认：`--disallowedTools, --disallowed-tools <tools...>` 接受「comma or space-separated list」。当前实现用空格分隔的 variadic 形式（`--disallowedTools Edit Write NotebookEdit MultiEdit`）即该 CLI 支持的形式；在 `tools/provider.mjs` 注释固化，`tools/runner.test.mjs` 新增精确断言（flag 后紧跟 4 个独立 arg，无逗号串）。

### 最终验证（2026-08-26，第二轮）

```
node --test tools/*.test.mjs        # 93 pass / 0 fail
node --test viewer/*.test.js        # 139 pass / 0 fail
openspec validate p10-match-observation-diagnosis --strict   # valid
./verify.sh                          # cargo 32 + viewer 139 + WASM e2e OK，全部通过
rg 凭证扫描                           # 全部命中为测试夹具 / 抹除逻辑 / 环境 gating，无存活密钥
```

## 最终审阅修复三（final review round 3，2026-08-26）

针对 supervisor 直接复现的两个回归/缺口。

### 1. 凭证形值抹除统一扩展（不止 sk-ant-*）

统一凭证形值集合覆盖 `sk-ant-*` / `sk-proj-*` / `ghp_*`（20+ 字母数字）/ `github_pat_*`（20+ body），
跨所有展示/输出/校验路径：

- `viewer/observation.js`：`CREDENTIAL_VALUE_SRC` 单一来源，`redactCredentialText`（statement、CLI 模板）
  与 `redactBundleForExport`（导出/提交 bundle）共用；注释同步。
- `tools/bundle.mjs`：`isCredentialValue` 扩展——`assertNoCredentials`/`redactCredentials` 现在拒绝/抹除
  任意非机密键下的 `ghp_`/`sk-proj-`/`github_pat_` 值，防止手工/旧 bundle 携带秘密进入诊断。
- `tools/provider.mjs` `redactKey` 与 `tools/runner.mjs` `scrubText`/`redactTaskText`：prompt、raw、task
  持久化全部抹除这些形状。
- `viewer/audit-report.js` `redactText`：这些形状即使不跟在 `token:` 后也抹除（展示层）。
- 测试：bundle（3 形状 + 短 ghp_ 容差）、runner（statement `ghp_...` 不进 fake prompt/不持久化、
  report 带 `ghp_...` 拒收）、observation（capture statement + CLI 模板 `ghp_...` 不泄漏）、
  audit-report（无前缀 `ghp_`/`sk-proj-`/`github_pat_` 抹除）。

### 2. baseline invariant 非坐标 finding 补 event_index

- `tools/detectors.mjs`：time-order 与 pass_distance（非正 + 超对角线两条路径）的 invariant finding
  现在 `event_index: <e>.index ?? i`，不再为 null。
- 测试：无显式 index 的 time-order（→ 1）与 pass_distance（→ 0）、超对角线带 index（→ 9）。

### 最终验证（2026-08-26，第三轮）

```
node --test tools/*.test.mjs        # 100 pass / 0 fail
node --test viewer/*.test.js        # 141 pass / 0 fail
openspec validate p10-match-observation-diagnosis --strict   # valid
./verify.sh                          # cargo 32 + viewer 141 + WASM e2e OK，全部通过
rg 凭证扫描（strict 非测试）         # sk-ant/sk-proj/ghp_/github_pat_ 值命中：0
```

## 最终审阅修复四（final review round 4，2026-08-26）

针对 supervisor 复现的 browser 侧键名匹配过窄问题。

### 1. viewer 键名检测与 tools/bundle.mjs 对齐（归一化子串匹配）

- `viewer/observation.js` `redactBundleForExport`：把「精确键名正则」换成与 `tools/bundle.mjs` 同口径的
  `isSecretKeyName`——归一化 key 为小写字母数字后，包含 `apikey`/`token`/`secret`/`authorization`
  任一即视为凭证键（覆盖 `ANTHROPIC_API_KEY`、`my_api_key`、`accessToken`、`clientSecret`、`authToken` 等）。
- `viewer/audit-report.js` `redactText`：新增 `hasCredentialTerm`，JSON 引号键值对与未加引号
  `key: value` / `key = value` 都接受带前缀/后缀的凭证键名；未加引号值仍要求像秘密（8+ 非空白
  字符或引号包裹），避免误伤 "token: of the month"。
- 测试：`redactBundleForExport` 对 `ANTHROPIC_API_KEY`/`my_api_key`/`authToken`/`token` 全部抹除；
  `redactText` 对 `ANTHROPIC_API_KEY=...`/`my_api_key: ...`/JSON 引号形式全部抹除。

### 最终验证（2026-08-26，第四轮）

```
node --test tools/*.test.mjs        # 100 pass / 0 fail
node --test viewer/*.test.js        # 144 pass / 0 fail
openspec validate p10-match-observation-diagnosis --strict   # valid
./verify.sh                          # cargo 32 + viewer 144 + WASM e2e OK，全部通过
rg 凭证扫描（strict 非测试）         # sk-ant/sk-proj/ghp_/github_pat_ 值命中：0
```

## 最终审阅修复五（final review round 5，2026-08-26）

针对 supervisor 复现的 display-redaction 边界与文档清理。

### 1. audit-report JSON 风格键名支持分隔符

- `viewer/audit-report.js` `redactText`：JSON 引号键值对与未加引号 `key: value` / `key = value` 的
  键名字符类放宽为 `[A-Za-z0-9_.-]`——带连字符/点/下划线的凭证键（`access-token`、`client-secret`、
  `github_pat.foo` 等）经 `hasCredentialTerm` 归一化后命中即抹除。
- 测试：`"access-token":"..."`、`"client-secret":"..."` JSON 形式与未加引号形式全部抹除。

### 2. implementation.md 历史行清理

- 把读起来像当前状态的过期语句标为历史/指向最终：verify.sh 计数 viewer 135 → 144、5.4 已跑、
  仅 5.5 留待未来；`VIEWER_SOURCE_REVISION = viewer-js:20260826-3` 与 cache-busting `20260826-3`
  标注为该轮历史值，最终版本统一指向 `20260826-8`。

### 最终验证（2026-08-26，第五轮）

```
node --test tools/*.test.mjs        # 100 pass / 0 fail
node --test viewer/*.test.js        # 145 pass / 0 fail
openspec validate p10-match-observation-diagnosis --strict   # valid
./verify.sh                          # cargo 32 + viewer 145 + WASM e2e OK，全部通过
rg 凭证扫描（strict 非测试）         # sk-ant/sk-proj/ghp_/github_pat_ 值命中：0
```

## 最终审阅修复六（final review round 6，2026-08-26）

针对 supervisor 的三项 SPEC/一致性发现 + 一处 CLI 回退路径 bug。

### 1. match-audit 聚合评估：普通传球 outcome/pressure 桶

- `tools/detectors.mjs`：
  - `runAudit` 新增 `pass_outcomes`：按 `unforced_out.pressure_distance` + `nearest_defender_distance`
    把普通传球分成 `unpressured` / `pressured` / `unknown_pressure` 桶（缺压力证据 → unknown_pressure，
    不伪造），并按 `unforced_out` 的 EXCLUSION_KEYS 排除战术/死球传球（计入 `excluded`）。
  - 每个桶统计 `sample_count` / `out_count` / `success_count` / `unknown_outcome_count`；
    `result==='out'` 或落点越界（几何）算 out，success/complete 算 success，其它/缺失结果算
    unknown_outcome（除非几何证明出界）。
  - `aggregateAudit` 新增 `pass_outcomes` 聚合段：跨 seed 求和并计算 `out_rate` / `success_rate`
    （round3），固定桶序、确定性。
- `tools/runner.mjs`：audit report 落盘时携带 `pass_outcomes`，供跨 seed 报告文件聚合。
- 测试：`tools/detectors.test.mjs` 新增 5 例（压力桶分类、几何出界算 out、跨 seed 聚合与
  out/success rate、排除、determinism + unknown_outcome 保留）。

### 2. provider 真实路径 stdin 管式调用

- `tools/provider.mjs` `ClaudeCodeAdapter.buildArgs`：去掉 `-p -` 里的独立 `-` 位置参数——
  `claude --help` 只文档化 `-p, --print`（"Print response and exit (useful for pipes)"），
  没有 `-` stdin 哨兵；`-` 会被当作字面 prompt 导致 stdin 被忽略。现改为
  `-p --output-format text --input-format text --bare`，prompt 仍写 stdin 并 `end()`。
- 测试：`tools/runner.test.mjs` 新增回归——args 含 `-p`、不含独立 `-`，且 prompt 仍经 stdin 送达。
- 文档：`tasks.md`/`implementation.md` 中的 `claude -p -` 历史文字更新为管式形式并标注最终裁定。

### 3. audit report 来源修订 provenance

- `tools/runner.mjs`：audit report 与 `input_summary` 的 `source_revision` 现在取自
  `bundle.source_revision`（经 env key + 凭证形模式 scrub），符合 spec「bundle 携带
  source_revision 用于可追溯」；CLI/当前 checkout 修订单独记为 `runner_source_revision`
  （scrub 后），并出现在 prompt 中（`current source revision (runner/checkout)`），
  bundle 修订也在 prompt 中标注（`observation bundle source revision`）。
- 测试：`tools/runner.test.mjs` 新增——bundle rev 与 runner rev 不同时，audit report 标记
  bundle 来源、runner 修订独立保留、prompt 同时含两者。

### 4. CLI 模板注释行不再续行

- `viewer/observation.js` `buildCliCommandTemplate`：注释行单独成行（不参与 ` \\\n` 连接），
  避免 POSIX 先处理反斜杠-换行导致 `node ...` 被并进注释、整段被注释掉。
- 测试：`viewer/observation.test.js` 新增——首行 `# ...` 不以 `\` 结尾、第二行以
  `node tools/runner-cli.mjs` 开头、后续参数行带续行符。

### 最终验证（2026-08-26，第六轮）

```
node --test tools/*.test.mjs        # 106 pass / 0 fail
node --test viewer/*.test.js        # 146 pass / 0 fail
openspec validate p10-match-observation-diagnosis --strict   # valid
./verify.sh                          # cargo 32 + viewer 146 + WASM e2e OK，全部通过
rg 凭证扫描（strict 非测试）         # sk-ant/sk-proj/ghp_/github_pat_ 值命中：0
```

## Slice 3（2026-08-26）— 本地诊断 HTTP 服务 + .env + 观察列表

范围：把页面提交和既有 runner 通过一个 localhost-only 的 Node `http` 服务接起来；在
CLI/service 入口层加载仓库根 `.env`；viewer 增加观察列表（实时状态徽章 + 轮询 +
刷新恢复 + 终态反馈渲染）。**不含真实 provider 端到端验收**（5.5，需用户带 key）。

### 改动文件

- `.env.example`（新增，提交）：`ANTHROPIC_API_KEY=` 占位 + 说明。`.env` 加进
  `.gitignore`（精确匹配 `.env`，不误忽略 `.env.example`，已用 `git check-ignore` 验证）。
- `tools/dotenv.mjs`（新增）：无依赖 `.env` 加载器。
  - `parseDotEnv(text)`：`KEY=VALUE` 行解析（容 whitespace / 引号 / `export ` 前缀），
    注释/空行跳过；非法行返回**只含行号**的告警（绝不带原始行内容，防 key 入日志）。
  - `loadDotEnv({ envPath, env, warn })`：仓库根 `.env`（存在时）注入 `process.env`；
    **已有值优先不覆盖**；缺失 `.env` 静默（ENOENT 不告警），其它读取失败仅告警不退出。
    返回 `{ loaded, count, errors }`，不含任何值内容。
  - 入口接入：`runner-cli.mjs` 与 `service.mjs` 的 `main()` 顶部调用 `loadDotEnv()`；
    runner 内部契约不变（仍只读 `process.env`）。
- `tools/dotenv.test.mjs`（新增，7 个）：解析/引号/转义、`export` 前缀、已有值优先、
  非法行告警不含内容、缺失静默、非 ENOENT 告警不退出。
- `tools/service.mjs`（新增）：Node 原生 `http`（无第三方依赖），默认绑定
  `127.0.0.1:8787`（`--port` 可改，`--tasks-dir` 传给 runDiagnosis）。
  - `POST /observations`：读 body（默认 5MB 上限 → 413）→ JSON 解析 → `validateObservationBundle`
    （含凭证拒绝，400 且错误只含路径）→ 预生成 `runId` → bundle 落盘
    `<tasksDir>/<runId>.bundle.json` → 微任务后台跑 `runDiagnosis`（重复校验 → 审计 →
    诊断）→ `202 { task_id }`。**不重复实现审计/诊断逻辑**。
  - `GET /tasks/:id`：读 `<tasksDir>/<id>.task.json` + 对应 audit report 的 findings，
    组成 redacted 轮询响应；任务文件未落盘但 bundle 已存在时返回合成 `auditing`（平滑轮询）；
    非法 id（防路径穿越）/ 未知任务 → 404。id 白名单 `[A-Za-z0-9_-]+`。
  - `OPTIONS`：CORS 预检 204，仅回显 localhost/127.0.0.1 Origin；非本机 Origin 一律 403
    **不带 CORS 头**（POST/GET/OPTIONS 同规则）；无 Origin 的 curl 式本地客户端放行但不带 CORS 头。
  - 响应/日志永不含 key：task 持久化已 redact，组合响应再 `redactKey` 防御性兜底；
    后台失败日志用 `redactKey` 抹除。
  - `main()`：`loadDotEnv()` → 解析 `--port`/`--tasks-dir` → 启动；`readRepoRevision()`
    尽力读 git HEAD 作为 `sourceRevision`（失败回退 bundle.source_revision）。
- `tools/service.test.mjs`（新增，14 个，无真实 API）：202 + task_id + runDiagnosis 参数与
  bundle 落盘；非法 bundle 400；凭证 bundle 400 且不泄漏值；非 JSON/非对象 400；body 超限
  413；非本机 Origin 403 无 CORS；无 Origin 本地客户端放行无 CORS；GET 轮询返回 task +
  findings；bundle 存在但 task 未落盘 → 合成 `auditing`；未知/路径穿越 id 404；OPTIONS
  预检 204 回显 localhost / 非本机 403；未知路径 404；**真实 runDiagnosis + env:{} 集成
  （不 spawn，provider_unavailable，audit report 照常产出）**。用 fake runDiagnosis 注入
  （参照 runner.test.mjs 的 fake 风格）。
- `tools/runner.mjs`：`runDiagnosis` 新增可选 `runId` 参数（service 预生成 task_id 以便
  POST 立即返回 `202 {task_id}`；省略时仍随机 UUID，行为不变）。`runner.test.mjs` 新增
  1 例断言注入 runId 被使用且任务文件按该 id 落盘。
- `viewer/observation-list.js`（新增，纯函数）+ `observation-list.test.js`（15 个）：
  - 8 状态词表 / 终态判定 / 条目创建 / 列表增改（不可变）/ `formatMatchTime`（2234→37:14）/
    `summarizeStatement` 摘要。
  - localStorage 序列化：`sanitizeEntry` 校验形状、未知状态归一为 failed、**派生渲染状态
    （findingsDetail）不持久化**；`loadList/saveList` 走注入 storage，读写失败静默。
- `viewer/audit-report.js`：新增 `taskResultToRender(data)` —— 本地服务轮询响应 → 与
  `parseAuditImport` 相同的渲染形状（status/findings/report/redacted errors）。
  `audit-report.test.js` 新增 3 例。
- `viewer/app.js`：
  - `OBSERVATION_ENDPOINT` 从 `null` 改为默认 `http://127.0.0.1:8787`；
    `VIEWER_SOURCE_REVISION = 'viewer-js:20260826-10'`，全部顶层 import 同步 `?v=20260826-10`。
  - **观察列表**：每次「采集当前观察」创建一条条目（描述摘要、`MM:SS / event #N`、8 状态
    徽章）；「提交诊断」→ POST `/observations` → `202 {task_id}` → 每 2s 轮询
    `GET /tasks/:id`，状态变化实时更新徽章，终态自动渲染 findings 红点（可跳转）+ 结构化
    报告（复用导入渲染路径 `taskResultToRender` + `findingMarkers` + `formatReportSummary`）；
    `provider_unavailable/failed` 显示任务 errors/failure 原因。
  - **刷新恢复**：localStorage 存条目元数据 + task_id；`restoreObservationList()` 启动时
    恢复，带 task_id 的条目从服务重新拉状态同步最新进度；服务不可达显示上次已知状态 +
    CLI 模板回退（`sync_error` 标记）。轮询最多 15 分钟，超时回退 CLI。
  - CLI 回退保留：未配置端点 / 服务不可达 / 提交失败 → 条目显示原因 + CLI 模板，
    状态为本地可表示的 captured/failed；browser 永不接触 API key（所有展示文本先
    `redactText`）。
- `viewer/index.html`：观察面板加 `#obs-list` 列表容器 + 条目/徽章 CSS（8 状态配色）；
  移除不再使用的 `#obs-cli`。cache-busting `?v=20260826-10`。

### 运行命令

```bash
cd <repo>
node --test tools/*.test.mjs     # 128 个（dotenv 7 + service 14 + runner 48 + detectors/bundle 等）
cd viewer && node --test *.test.js  # 164 个
node tools/service.mjs --tasks-dir <dir> [--port 8787]   # 本地服务入口
openspec validate p10-match-observation-diagnosis --strict   # valid
./verify.sh                          # cargo 32 + viewer 164 + WASM e2e OK
```

### 测试结果

```
tools:  # tests 128 / # pass 128 / # fail 0
viewer: # tests 164 / # pass 164 / # fail 0
openspec validate --strict: valid
./verify.sh: cargo 32 + viewer 164 + WASM e2e OK（2919 事件，无 snap）
rg 凭证扫描（strict 非测试）: sk-ant/sk-proj/ghp_/github_pat_ 值命中 0
```

### 端到端 smoke（本切片）

真实 viewer bundle（`captureObservation` 产物）→ 真实 service（env:{}）→ POST 202 →
轮询 `provider_unavailable` + 5 条 audit findings。无真实 API 调用。

### 遗留风险 / 未做

- **5.5 未勾选**：真实 provider 诊断需用户带 `ANTHROPIC_API_KEY` 验收（本地 `.env` 或
  进程环境）。本切片只覆盖到 `provider_unavailable` 的审计-落盘路径。
- 观察列表不持久化 bundle 全文（localStorage 只存元数据 + task_id）；刷新后旧条目的
  bundle 无法再导出/重放（服务端存有 `<task_id>.bundle.json`，但未提供下载端点——超出本
  change 范围）。
- `GET /tasks` 列表端点未做（需求明确「不做」；页面客户端维护列表 + `GET /tasks/:id` 恢复）。
- 多 seed CLI 聚合入口、engine decision trace 等均在本 change 范围外。
- 真实 `claude` 子进程路径（provider.mjs）仍属用户验收环节，本切片测试全部用 fake。
- cache-busting 最终版本：**`20260826-10`**（`index.html` script + `app.js` 顶层 import +
  `VIEWER_SOURCE_REVISION` 三处一致）。

## Slice 3 审阅修复（supervisor 两轮审查，2026-08-26）

针对 Slice 3 的两轮独立审查发现，修复 1 major + 3 minor；spec review 无 blocker/major，
不修项见文末「不修（仅记录）」。

### 1. [major] service.mjs 请求 handler 无异常兜底

- `createServer` 现在用 `(req, res) => { dispatch(req, res).catch(...) }` 包裹；`dispatch`
  是独立 async 函数，任何未预期异常都回到 catch：响应未发送则回 400 `{error:'invalid request'}`，
  已发送则直接 `res.end()`，**不再让 async listener 的 rejection 终止进程**。
- `dispatch` 内 `new URL(req.url, 'http://localhost')` 单独 try/catch：畸形绝对 form
  request-target（如 `GET http://localhost:badport/x`）→ 400 `{error:'invalid request url'}`。
- `main()` 增加 `process.on('unhandledRejection', ...)` 兜底：日志消息经 `redactKey` 抹除。
- 回归测试：用 `http.request` 发绝对 form + 无效端口请求 → 断言 400 且**进程存活**，
  随后正常请求仍返回 404。

### 2. [minor] GET /tasks/:id 响应白名单化

- `readTaskState` 不再 `{ ...task }` 整体展开，只返回页面轮询实际消费的字段：
  `task_id / status / errors / report / findings / status_history / failure_kind`。
  `input_summary.bundle_path` / `audit_path` 等内部绝对路径与 runner 配置不再外泄。
- 同步更新 service.test.mjs：断言 `input_summary / provider / started_at / ended_at /
  raw_output_ref / command_exit_status / retries` 均不在轮询响应中。

### 3. [minor] 流式 body 超限 413 测试

- 新增测试：无 Content-Length（chunked 传输）分多次 chunk 发送超限 body → 413，且
  runDiagnosis 未被调用。覆盖 `readBody` 的流式累计 + `req.pause()` 分支（原测试只覆盖
  content-length 预检分支）。

### 4. [minor] dotenv 行尾注释剥离

- `parseDotEnv`：未加引号的值遇 ` #` 截断（`KEY=abc # note` → `abc`）；引号内的 `#`
  保留（`KEY="abc#def"` → `abc#def`）；无空白前缀的 `#` 是字面值（`KEY=abc#def`）；
  值截断后为空或 `#` 开头（`KEY=`、`KEY=#note`、`KEY= # note`）→ 整行按注释跳过。
- 测试：新增注释剥离用例；`loadDotEnv` 的 `EMPTY=` 用例改为断言跳过（count 1，
  `env.EMPTY` 为 undefined）。

### 最终验证（Slice 3 审阅修复后）

```
node --test tools/*.test.mjs        # 131 pass / 0 fail（+3：dotenv 注释 1 + service 2）
node --test viewer/*.test.js        # 164 pass / 0 fail（未动 viewer，版本号仍 20260826-10）
openspec validate p10-match-observation-diagnosis --strict   # valid
./verify.sh                          # cargo 32 + viewer 164 + WASM e2e OK，全部通过
rg 凭证扫描（strict 非测试）         # sk-ant/sk-proj/ghp_/github_pat_ 值命中：0
```

### 不修（仅记录，supervisor 审查裁定）

- `OBSERVATION_ENDPOINT` 硬编码导致「未配置端点」分支死代码：保留（以后支持配置时有用）。
- 观察列表只有最近一次采集可提交：MVP 交互限制，已知。
- `redactText` 对含空格的无引号值不抹除：保守方向漏网，已知。

## 审阅修复（2026-08-26）— 默认诊断权限改为 bypass

spec（diagnosis-runner「诊断 Agent 权限模式可配置，默认 bypass」）、proposal、design
第 3/7 节已由主 session 更新并通过 `openspec validate --strict`。本段是代码与测试落地。

### 改动

- `tools/runner.mjs` `DEFAULT_RUNNER_CONFIG`：`permission: 'read-only'` → `'bypass'`、
  `read_only: true` → `false`（bypass 模式下**不禁用**编辑工具；只读契约通过显式
  `--permission read-only` 保留）。
- `tools/provider.mjs`：`PERMISSION_MODES` 映射保留（`bypass` → `bypassPermissions`，
  `read-only`/`plan` → plan + 禁编辑）；`readOnly = config.read_only !== false` 逻辑保留
  （默认 config 已是 `read_only: false`，故默认构建不含 `--disallowedTools`）；头部注释
  从「run a read-only diagnosis」改为「run a diagnosis（bypass 默认）」，`read_only`
  兜底语义注明「仅 bare 构造时 fail-closed 到只读」。
- `tools/runner-cli.mjs`：usage/help `--permission` 默认值改为 `bypass`，说明 bypass =
  完整工具权限（可执行验证命令与修改文件）；`permission: opts.permission ?? 'bypass'`。
- `tools/runner.mjs` `buildDiagnosisPrompt`：默认 `permission = 'bypass'`；按权限模式区分
  措辞——bypass：明确「full tool access，实际执行重放/验证命令（同 seed 重放、跑相关测试）
  复现观察，可修改文件，修改动作须在报告记录」，`verification` 字段仍承载命令供人工复核；
  read-only/plan：保留原只读措辞（MUST NOT 修改、验证命令由 runner/用户另行执行）。
- `tools/service.mjs`：无逻辑改动（走 `DEFAULT_RUNNER_CONFIG`）；无只读相关注释遗留。
- 测试：`tools/runner.test.mjs` +4（prompt 默认 bypass 含执行验证/记录修改措辞且无只读强制、
  prompt read-only 保留 no-edit 契约并 defer 执行、`DEFAULT_RUNNER_CONFIG` 构建 adapter →
  `bypassPermissions` 且无 `--disallowedTools`、`--permission read-only` 仍禁编辑）；
  runDiagnosis 成功用例补断言默认配置贯通（`provider.permission === 'bypass'`、
  `read_only === false`）；「adapter 空配置」用例改为 fail-closed fallback 语义并注明
  runner 默认另有专项用例。

### 最终验证（bypass 审阅修复后）

```
node --test tools/*.test.mjs        # 135 pass / 0 fail（+4 runner 用例）
node --test viewer/*.test.js        # 164 pass / 0 fail（未动 viewer，版本号仍 20260826-10）
openspec validate p10-match-observation-diagnosis --strict   # valid
./verify.sh                          # cargo 32 + viewer 164 + WASM e2e OK，全部通过
rg 凭证扫描（strict 非测试）         # sk-ant/sk-proj/ghp_/github_pat_ 值命中：0
```

> 注：`read_only` 只读契约的 CLI 验证仍属用户验收（真实 `claude` 子进程路径测试全部 fake）；
> 默认 bypass 下 agent 具备编辑/执行能力，由真实 provider 会话落地。

## 审阅修复（2026-08-26）— 服务支持 tailscale 网内访问

spec（diagnosis-runner「本地诊断服务接收观察提交并提供任务轮询」Requirement + 两个 Scenario：
「服务拒绝白名单外来源」「白名单内 tailscale 来源」）与 tasks.md 已由主 session 更新并通过
`openspec validate --strict`。本段是代码与测试落地。

### 改动

- `tools/service.mjs`：
  - `--host` 参数：默认 `127.0.0.1` 不变；tailscale 场景传 `0.0.0.0` 监听所有接口。
    `main()` 用注入的 `listen`（默认 `server.listen(port, host, cb)`），单元测试可捕获
    host/port 而不真实绑定端口。
  - `--allow-origin <origin>`（可重复）：把额外 Origin 加入 CORS 白名单（精确匹配，
    如 `http://100.114.76.34:8000`）。`createService` 新增 `allowedOrigins`；
    `dispatch` 的判定变为：Origin 为 localhost/127.0.0.1（现有 `isLocalhostOrigin`）
    **或**命中白名单 → 回显该 Origin；否则无 CORS 头并 403（现有行为不变）。
    无 Origin 的本地客户端（curl）仍放行且不带 CORS 头。
  - usage 文本更新（`--host` / `--allow-origin` 说明）；绑定非 loopback 后网内访问控制
    由部署者负责（spec 明确）。
- `tools/service.test.mjs`（+4，共 20）：
  - `parseArgs` 收集可重复 `--allow-origin` 与 `--host`；
  - 白名单 Origin 的 POST 回显 CORS 头并启动任务（fake runDiagnosis 被调用）；
  - 白名单外 Origin（`http://evil.example`）仍 403 且无 CORS 头、任务未启动；
  - `main` 把 `--host 0.0.0.0` 传给 `listen`（默认端口 8787）。
- viewer 不动（cache-busting 保持 `20260826-10`）。

### 最终验证（tailscale 审阅修复后）

```
node --test tools/*.test.mjs        # 139 pass / 0 fail（+4 service 用例）
node --test viewer/*.test.js        # 164 pass / 0 fail（未动 viewer）
openspec validate p10-match-observation-diagnosis --strict   # valid
./verify.sh                          # cargo 32 + viewer 164 + WASM e2e OK，全部通过
rg 凭证扫描（strict 非测试）         # sk-ant/sk-proj/ghp_/github_pat_ 值命中：0
```

> smoke（真实入口）：`--host 0.0.0.0 --allow-origin http://100.114.76.34:8000` →
> 白名单 Origin 的请求带 `Access-Control-Allow-Origin` 回显；evil Origin 403 无 CORS；
> 无 Origin curl 放行。

## 审阅修复（2026-08-26）— 页面端点随来源推导

spec（match-observation「页面提交使用本地诊断服务并回填结果」Requirement + tailscale
Scenario）与 tasks.md 已由主 session 更新并通过 `openspec validate --strict`。本段是代码
与测试落地。

### 问题

`OBSERVATION_ENDPOINT` 此前硬编码 `http://127.0.0.1:8787`：手机通过 tailscale 打开页面时
`127.0.0.1` 指向手机自身，提交必然失败。服务端已支持 `--host 0.0.0.0 --allow-origin`
（上轮），本段让页面端自动推导端点。

### 改动

- `viewer/observation.js`：新增纯函数 `deriveDiagnosisEndpoint(hostname)` 与
  `OBSERVATION_SERVICE_PORT` 常量：
  - hostname 为 `localhost` / `127.0.0.1` / 空（含 undefined/null）→
    `http://127.0.0.1:8787`；
  - 其它 hostname（tailscale 网内地址 `100.114.76.34`、域名等）→
    `http://<hostname>:8787`，页面自动指向服务所在机器，无需手工配置。
- `viewer/app.js`：`OBSERVATION_ENDPOINT` 从硬编码常量改为
  `deriveDiagnosisEndpoint(location.hostname)`；导出/提交/轮询/CLI 回退逻辑不变。
- `viewer/observation.test.js`（+2，共 24）：localhost/127.0.0.1/空 → 127.0.0.1:8787；
  `100.114.76.34` → `http://100.114.76.34:8787`；`*.tailnet.ts.net` 域名同理。
- **cache-busting bump 到 `20260826-11`**：`viewer/index.html` script + `app.js` 全部
  顶层 import + `VIEWER_SOURCE_REVISION = 'viewer-js:20260826-11'` 三处一致。

### 最终验证（端点推导审阅修复后）

```
node --test tools/*.test.mjs        # 139 pass / 0 fail
node --test viewer/*.test.js        # 166 pass / 0 fail（+2 observation 用例）
openspec validate p10-match-observation-diagnosis --strict   # valid
./verify.sh                          # cargo 32 + viewer 166 + WASM e2e OK，全部通过
rg 凭证扫描（strict 非测试）         # sk-ant/sk-proj/ghp_/github_pat_ 值命中：0
rg 20260826 viewer/app.js viewer/index.html   # 全部 20260826-11（3 处一致）
```

## 审阅修复（2026-08-27）— provider 子进程环境净化（真实诊断超时根因）

spec（diagnosis-runner「provider 子进程环境净化」Requirement + 两个 Scenario）与 tasks.md
已由主 session 更新并通过 `openspec validate --strict`。本段是代码与测试落地。

### 根因

服务从 Claude Code 托管环境启动时，`process.env` 带整套会话变量
（`CLAUDE_CODE_CHILD_SESSION`、`CLAUDE_PID`、`CLAUDE_CODE_SESSION_ID`、
`CLAUDE_CODE_EXECPATH`、`CLAUDE_CODE_ENTRYPOINT`、`ANTHROPIC_AUTH_TOKEN`、
`ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_*`、`AI_AGENT`、
`CLAUDECODE`）。provider 此前把整个 env 传给子进程 `claude`，使它走 child-session/代理
路径而非 `--bare` 直连，300 秒零输出后被超时杀掉（raw.txt 0 字节）。

### 改动

- `tools/provider.mjs`：
  - 新增导出纯函数 `sanitizeChildEnv(env = process.env)`（黑名单精确剔除，不突变输入）：
    - 精确剔除：`CLAUDE_PID`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、
      `ANTHROPIC_MODEL`、`AI_AGENT`、`CLAUDECODE`；
    - 前缀剔除：`CLAUDE_CODE_*`（session id / execpath / entrypoint / child-session 标记等）、
      `ANTHROPIC_DEFAULT_*`（model 覆盖）；
    - **保留**：基础变量（PATH/HOME/TERM/LANG/SHELL 等）、代理变量
      （HTTP(S)_PROXY / NO_PROXY / no_proxy，用户配代理时子进程需要）、以及
      **`ANTHROPIC_API_KEY`**。
  - `ClaudeCodeAdapter.run()`：spawn 时用 `{ env: sanitizeChildEnv(env) }` 替代原 env；
    key 门禁（provider_unavailable）逻辑不变（净化保留 key，缺失仍拒绝且不 spawn）；
    `readEnv` 注入仍可用（测试注入带会话变量的 env，断言 spawn 收到的已净化）。
- `tools/runner.test.mjs`（+3，共 55）：
  - `sanitizeChildEnv` 直接断言：会话/认证变量全部剔除，`ANTHROPIC_API_KEY` +
    基础变量 + 代理变量保留；
  - adapter fake-spawn 捕获 `opts.env`：子进程 env 不含会话变量，含 key/PATH/代理；
  - 净化场景无 key → 仍 `provider_unavailable` 且不 spawn。

### 最终验证（env 净化审阅修复后）

```
node --test tools/*.test.mjs        # 142 pass / 0 fail（+3 runner 用例）
node --test viewer/*.test.js        # 166 pass / 0 fail（未动 viewer）
openspec validate p10-match-observation-diagnosis --strict   # valid
./verify.sh                          # cargo 32 + viewer 166 + WASM e2e OK，全部通过
rg 凭证扫描（strict 非测试）         # sk-ant/sk-proj/ghp_/github_pat_ 值命中：0
```

> cache-busting 保持 `20260826-11`（viewer 无改动）。
> 真实诊断超时场景（Claude Code 托管会话 → 净化后直连）仍属用户带 key 验收（5.5 不勾）。

## 审阅修复（2026-08-27）— 诊断结果 triage 分流

spec（diagnosis-runner「诊断报告包含 triage 分流」Requirement + 3 个 Scenario）、design
4.5 节、tasks.md 已由主 session 更新并通过 `openspec validate --strict`。本段是代码与测试
落地。

### 改动

- `tools/runner.mjs`：
  - `TRIAGE_CATEGORIES = ['bug', 'design', 'discuss']` + `TRIAGE_FALLBACK_MISSING` /
    `TRIAGE_FALLBACK_INVALID` 常量。
  - 新增 `normalizeTriage(triage)`：校验 `category ∈ 枚举`、`rationale` 非空字符串、
    `confidence ∈ [0,1]`；缺失/非法返回兜底 `discuss`（missing → `'agent 未提供分类'`；
    invalid → `'agent 未提供分类（非法分类已兜底）'`）。
  - `validateDiagnosisReport`：triage **不是必填字段**（不进 REPORT_FIELDS），缺失或非法
    **不拒绝整份报告**；返回的 report 总是带规范化 `triage` 对象。
  - `buildDiagnosisPrompt`：加分类判定指南（**看根因性质不看修复工作量**：bug=现有实现
    行为与预期不符/明确根因/可验证修复路径；design=代码按设计工作但设计/模型有缺口；
    discuss=根因不明/多因素/低置信(<0.7)/需用户确认），JSON schema 段加 `triage` 字段说明。
- `viewer/audit-report.js`（纯函数，全部渲染前 `redactText`）：
  - `TRIAGE_CATEGORIES` / `TRIAGE_LABELS`；`formatTriage(report)` —— 报告无 triage 字段
    返回 null（不渲染徽章），triage 存在但非法 → 兜底 discuss；
  - `buildChangeDraft(report, { statement })` —— OpenSpec 风格 change 草稿 markdown
    （# Change 标题 / Why=现象+用户描述 / What Changes=根因+修复方案+验证命令 /
    Impact·验证建议），供 bug 类别复制/下载；
  - `openQuestionsFromReport(report)`（design → 来自 hypotheses/rationale）、
    `confirmQuestionsFromReport(report)`（discuss → 疑问/低置信点清单）；
  - `formatReportSummary` 追加分类行（`分类: <category> — <rationale>`）。
- `viewer/app.js`：`renderReportActions(container, report, statement)` —— triage 徽章
  （bug=红/design=蓝/discuss=黄，textContent 渲染）+ 按类别后续动作面板（bug → change
  草稿复制/下载；design → open questions；discuss → 确认问题清单）；entry card 终态与
  import 路径都接入（`#obs-next` 容器）；轮询反馈的 `findingsDetail` 携带 report 供渲染。
- `viewer/index.html`：triage 徽章 + next-steps 面板 CSS；`#obs-next` 容器。
- 测试：`tools/runner.test.mjs` +6（合法 triage 保留、缺失兜底不拒、非法 category 兜底、
  空 rationale/越界 confidence 兜底、triage.rationale 凭证拒绝、prompt 含分类指南）；
  runDiagnosis 成功用例补 `task.report.triage` 兜底断言；`viewer/audit-report.test.js` +8
  （TRIAGE_CATEGORIES、formatTriage 合法/兜底/缺失 null、buildChangeDraft 关键字段与无
  凭证、open/confirm questions、formatReportSummary 分类行）。
- **cache-busting bump → `20260826-12`**：`viewer/index.html` script + `app.js` 全部顶层
  import + `VIEWER_SOURCE_REVISION = 'viewer-js:20260826-12'` 三处一致。

### 最终验证（triage 分流审阅修复后）

```
node --test tools/*.test.mjs        # 148 pass / 0 fail（+6 runner triage 用例）
node --test viewer/*.test.js        # 174 pass / 0 fail（+8 audit-report triage 用例）
openspec validate p10-match-observation-diagnosis --strict   # valid
./verify.sh                          # cargo 32 + viewer 174 + WASM e2e OK，全部通过
rg 凭证扫描（strict 非测试）         # sk-ant/sk-proj/ghp_/github_pat_ 值命中：0
rg 20260826 viewer/app.js viewer/index.html   # 全部 20260826-12（3 处一致）
```
