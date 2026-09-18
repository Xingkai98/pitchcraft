# P13 Problem Actions — 实现记录

日期：2026-08-27（Slice 1 verify + Slice 2 fix + Slice 3 闭环与 viewer）
范围：把问题页面升级为工作台——验证下发（verify）、修复下发（fix，隔离 worktree +
确认闭环）、确认合入/拒绝修复，全部动作留审计轨迹，主 checkout 零改动直到人工确认。

## 目标

P10-P12 让问题可诊断、可持久化、可操作（重跑/删除/导入/issue），但「修复 → 验证 →
闭环」仍停留在页面外。本 change 把问题动作直接下发：

- **验证**：从页面执行问题报告中的白名单验证命令，结果（exit code / 输出摘要）回写
  decisions；全部通过且勾选「并标记 fixed」时自动置 fixed（默认人工确认）。
- **修复**：从报告（现象/根因/修复方案/验证命令）生成 fix prompt，在**隔离 worktree**
  启动本机 Claude Code（bypass + 净化 env + 结构化输出校验）执行修复并自验证；结果回写
  problem（decisions + fix_ref + status in_progress），主 checkout 不被触碰。
- **确认闭环**：页面按钮「确认合入」→ 分支合入主 checkout（--no-ff）→ problem closed +
  change_ref（默认 `fix/<id>`）+ worktree 清理；「拒绝修复」→ fix_ref rejected，worktree 保留。

## 改动文件

### Slice 1 — verify 下发（tasks 1.1–1.2）

- `tools/actions.mjs`（新）：
  - `tokenizeCommand` —— 简单 shell 风格分词（引号/转义；不平衡 → null），只用于把
    白名单命令切成 argv 逐 token 校验，**原串绝不交给 shell**。
  - `buildVerifyPlan(command, repoRoot)` —— 白名单解析为具体子进程调用 `{ file, args,
    cwd }`：`cargo test [<filter>]`（追加参数限安全 token）、`cargo build --target
    wasm32-unknown-unknown --release`（精确）、`node --test <tools|viewer 测试文件或字面
    glob>`（glob 在构建期自己展开为绝对路径）、`cd viewer && node --test *.test.js`
    （cwd=viewer）、`./verify.sh`（精确）。白名单外/无法解析 → null。
  - `firstWhitelistedVerifyCommand` —— 从 report.verification（可多行/数组）取第一条白
    名单命令；无 → null。
  - `verifyProblem(problem, { command, cwd, timeoutMs, envKey, exec, repoRoot })` —— 执行
    白名单命令（child_process，不经过 shell），超时 kill（默认 600s），输出截断（保留
    尾部 ~2KB）+ `redactKey`/`redactCredentialText` 净化；返回
    `{ ok, command, exit_code, summary, timedOut }`。`exec` 可注入（测试用 fake）。
  - `gitRun` / `DEFAULT_EXEC_FILE` —— 通用 git / execFile 子进程助手（merge-fix 与 fix
    编排共用，均可注入）。
- `tools/problems.mjs`（扩展）：`recordVerify(id, { command, exit_code, summary,
  markFixed })` —— decisions 追加 `{action:'verify', by, at, command, exit_code, summary}`；
  exit 0 且 markFixed 时置 status fixed（追加 `status:fixed` 决策）。closed-triage
  （defer/wontfix）问题拒绝 markFixed（400，verify 记录不写入——原子）。
- `tools/service.mjs`（扩展）：`POST /problems/:id/verify` —— 缺省命令取报告 verification
  首条白名单命令（无 → 400）；白名单外 → 400（不执行）；成功 → decisions 追加 + mark_fixed
  语义；404 未知问题。
- 测试：`tools/actions.test.mjs`（20：tokenize/白名单/展开/默认命令/截断/redaction/超时/
  fix prompt/validateFixReport/runFix）、`tools/problems.test.mjs`（+10：recordVerify 三态
  /markFixed 原子拒绝/recordFix/recordFixFailure/recordMergeFix/recordRejectFix）、
  `tools/service.test.mjs`（+15：verify 六态 + fix 五态 + merge-fix 五态）。

### Slice 2 — fix 下发（tasks 2.1–2.2）

- `tools/actions.mjs`（扩展）：
  - `buildFixPrompt` —— 现象/用户描述/根因/修复方案/验证命令/额外指令 + 约束（测试先行、
    不越界、完成后自验证并记录真实结果、提交留待合入）。
  - `validateFixReport` —— 校验 fix agent 结构化输出 schema
    `{ status: fixed|failed|insufficient, summary, changed_files: [paths],
    verification_results: [{command, exit_code, summary}] }`；无效输出 → 任务失败。
  - `runFix` —— 编排：凭证 gate（无 key → provider_unavailable，不建 worktree）→
    `git worktree add <dir> -b fix/<id>/<ts> main` → 构建 prompt（各字段先
    redactKey+redactCredentialText 净化）→ 运行 provider（**复用 ClaudeCodeAdapter**，
    bypass + 净化 env + `cwd=worktree` + 超时）→ 结构化输出校验。成功 → `{ok:true,
    outcome:'fixed', worktree, branch, summary, changed_files, verification_results}`；
    失败（worktree add 失败/provider 失败/超时/无效输出/agent 自报 failed|insufficient）
    → `{ok:false, outcome, error, ...}`，**失败时清理残留 worktree** 防泄漏。
- `tools/provider.mjs`（扩展）：`ClaudeCodeAdapter.run(prompt, { env, timeoutMs, cwd })`
  支持 `cwd`（fix agent 在隔离 worktree 内运行；不传则向后兼容）。
- `tools/problems.mjs`（扩展）：`recordFix`（decisions 追加 fix 成功记录 + status →
  in_progress + fix_ref `{worktree, branch, status:'pending_confirm'}`）、`recordFixFailure`
  （只追加失败决策，状态与字段不变，fix_ref 不建）。
- `tools/service.mjs`（扩展）：`POST /problems/:id/fix`（body 可选 `extra_instructions`，
  净化后传入）—— 同步等待 provider；结果一律回写 decisions，响应 200 携带更新后的
  problem（成功建 fix_ref，失败只记决策）。前置校验：closed-triage 问题 / 已有 pending
  fix → 400。
- 测试：actions.test.mjs runFix（成功 worktree+provider+prompt 净化/缺 key 不建
  worktree/worktree add 失败/无效输出清理/agent failed）、service.test.mjs fix（成功写
  fix_ref/失败 no-op/closed-triage 与 pending 400/extra_instructions redaction）、
  runner.test.mjs（+1：adapter cwd 透传）。

### Slice 3 — 确认闭环 + viewer（tasks 3.1–3.3）

- `tools/problems.mjs`（扩展）：`recordMergeFix`（status → closed、change_ref 填
  `fix/<id>` 或 body 覆盖、fix_ref.status → 'merged'、decisions 追加 merge-fix）、
  `recordRejectFix`（fix_ref.status → 'rejected'，worktree 保留，problem 不闭环）。
- `tools/service.mjs`（扩展）：`POST /problems/:id/merge-fix` ——
  - 合入路径：校验 fix_ref pending_confirm + `git rev-parse` 分支有提交 + 验证记录全过
    （最近一条成功 fix 决策的 verification_results 全 exit 0；`force:true` 豁免）→
    `git merge --no-ff <branch>` 入主 checkout → `git worktree remove --force <dir>`
    （best-effort）→ recordMergeFix。
  - 拒绝路径（body `{reject:true}`，reason 可选）：recordRejectFix，不执行任何 git。
  - 失败语义：merge 失败 → 500，problem 不变（status/fix_ref 保持）；分支无提交 / 验证
    未全过 → 400。
- `viewer/problem-view.js`（扩展）：`normalizeProblem` 携带 fix_ref；`problemDetailToRender`
  decisions 扩展 verify/fix/merge-fix 结构化字段（command/exit_code/summary/outcome/
  worktree/branch/error/change_ref/changed_files/verification_results，全部 redactText）；
  新增 `formatDecisionText`（多行决策展示，summary 截断）与 `fixRefToRender`；API 客户端
  新增 `verify` / `fix` / `mergeFix`。
- `viewer/app.js`（扩展）：详情面板加 fix_ref 摘要区块（worktree/branch/status/时间）；
  动作面板加「验证」（命令输入 + 勾选「并标记 fixed」）、「修复」（pending 时禁用）、
  pending_confirm 时「确认合入」/「拒绝修复」按钮；决策轨迹改用 `formatDecisionText`
  （verify/fix 细节展示）；全部 textContent + redactText。
- `viewer/index.html` / `viewer/app.js`：cache-busting `20260826-16` → `20260826-17`
  （index.html 1 处 + app.js 全部 import + `VIEWER_SOURCE_REVISION` 共 12 处一致）。
- 测试：`viewer/problem-view.test.js`（+6：fix_ref 归一化/fixRefToRender/决策字段 redaction/
  formatDecisionText/三端点 URL 与 body/非 ok 透传）。

## 运行命令

```bash
node --test tools/*.test.mjs          # tools 全量
cd viewer && node --test *.test.js    # viewer 全量
openspec validate p13-problem-actions --strict
./verify.sh                            # cargo + viewer + WASM e2e
```

## 测试结果

```
tools:  # tests 271 / # pass 271 / # fail 0   （P12 基线 219 + actions 23 + problems 10 + service 18 + runner 1）
viewer: # tests 226 / # pass 226 / # fail 0   （P12 基线 220 + problem-view 6）
openspec validate --strict: valid
./verify.sh: 全部通过
rg 凭证扫描（strict 非测试）: sk-ant/sk-proj/ghp_/github_pat_ 值命中 0
grep 20260826-17 viewer/index.html viewer/app.js   # 1 / 10（含 VIEWER_SOURCE_REVISION）
```

## 关键设计 / 约定

- **verify 白名单 = 无 shell 执行**：白名单命令先 `tokenizeCommand` 切成 argv 再逐 token
  校验（安全 token 不含 shell 元字符），`buildVerifyPlan` 产出具体 `{file, args, cwd}`
  （相对命令在构建期解析为绝对路径；`node --test` 的 glob 构建期自己展开），最终走
  `execFile`。`cargo test && rm -rf /`、`node --test ../../x`、`cd /etc && ...` 一律拒绝。
- **fix 隔离**：`git worktree add <tmp>/p13-fix-<id> -b fix/<id>/<ts> main`；agent 在
  worktree cwd 内运行（adapter 支持 cwd）；主 checkout 零改动直到「确认合入」。
- **失败语义**：provider 失败/超时/无效输出/agent 自报 failed → decisions 记失败（action
  'fix' + outcome 'failed'），problem 状态与字段不变，fix_ref 不建；**残留 worktree 清理**
  （防泄漏，路径留在失败决策里供参考）。
- **确认闭环**：合入前置校验（pending_confirm + 分支有提交 + 验证记录全过，force 豁免）；
  合入后 problem closed + change_ref（默认 `fix/<id>`，可 body 覆盖）+ fix_ref merged +
  worktree 清理。**拒绝 → worktree 保留**（供检查），problem 不闭环。
- **验证记录在审计轨迹**：fix_ref 只记 `{worktree, branch, status}`；verification_results
  存在最近一条成功 fix 决策里，merge-fix 从决策读取校验。
- **凭证纪律**：verify 输出、fix prompt 的每个字段、extra_instructions、失败错误全部
  redactKey + redactCredentialText；viewer 全部 textContent + redactText，browser 零凭证接触。

## 审阅修复（2026-08-27，独立审阅 agent：1 major + 4 minor 修复/记录，nits 记录）

针对独立审阅报告逐项处理（报告基线：tools 267 / viewer 226 / openspec valid）。

1. **[major-必修] pending-fix 重复下发竞态（check-then-act）**（`tools/service.mjs`）：
   fix_ref 要等 agent 完成后才写入，双击/并发请求在 600s 窗口内会双双通过。修复：
   `createService` 内加进程内 `fixDispatchInFlight` Set 互斥（check 与 add 之间无 await，
   竞态消除；服务重启锁自然消失）。补 service 测试：挂起一个 fix 期间第二次下发 → 400
   `in progress`；放行后 pending_confirm 守卫接管。
2. **[minor] cargo test 参数白名单可携带选项形 token（--config/--manifest-path 可把
   构建/runner 指向仓库外文件）**（`tools/actions.mjs`）：新增 `CARGO_TEST_SAFE_FLAGS`
   白名单（仅 `--release`/`--`/`--ignored`/`--nocapture`/`--exact`），其余 `-` 开头
   token 一律拒绝；非 `-` 开头过滤名保留。补测试：`cargo test --config /tmp/x.toml`、
   `--manifest-path`、`-C`、`--offline` → 拒绝；`--release -- --ignored` → 放行。
3. **[minor] cargo 命令 cwd 修正**（`tools/actions.mjs`）：repo 根无 Cargo.toml，
   `cargo test` / `cargo build --target wasm32-unknown-unknown --release` 的 cwd 改为
   `engine/`。补测试断言 `buildVerifyPlan(...).cwd === join(repoRoot, 'engine')`。
4. **[minor] worktree add 失败不清理半途残留**（`tools/actions.mjs`）：add 失败（含
   gitExec 抛异常）路径也 best-effort `worktree remove --force`；gitExec 异常归一化为
   `{ok:false}` 失败（不冒泡 500）。补测试：add 失败 → remove 被调用；gitExec 抛异常 →
   failed outcome 且 provider 不跑。
5. **记录不修（有意设计）**：
   - **合入后已 closed（triage 非 closed-triage）仍可再下发 fix/mark_fixed**：与
     `updateProblem` 的「closed 可重开」状态模型一致；closed-triage（defer/wontfix）是
     硬边界。文档明示。
   - **merge 不删 `fix/<id>` 分支 ref**：保留供审计（fix_ref.branch 指向），合入历史已
     含提交；冗余 ref 后续统一清理。
   - **`by` 固定 `'user'`**：fix 由 agent 执行，决策的 `by` 记为发起人（用户）；执行 agent
     与发起人的区分留待后续。
   - **截断按 UTF-16 单元而非字节**（`VERIFY_OUTPUT_TAIL_BYTES`）：测试输出近似 ASCII，
     无实际影响。
   - **`assertNoCredentials` 文案在 fix 上下文略误导**：共享助手，不改签名。

## 合入前综合 review 修复（2026-08-27，1 blocker + 1 minor + 1 nit 修复，3 记录不修）

主 session 合入前 review 发现 1 个 blocker，全部处理。

1. **[blocker-必修] cargo verify 命令名重复**（`tools/actions.mjs` `buildVerifyPlan`）：
   两处 cargo 分支返回 `args: tokens`（含 `tokens[0]='cargo'`），`verifyProblem` 用
   `exec(plan.file, plan.args)` 执行 → 真实运行是 `cargo cargo test`（exit 101 必炸）。
   修复：`args: tokens` → `args: rest`（不重复命令名；与 node/verify.sh 分支及
   `gitRun` 的 `exec('git', args)` 语义一致）。补两个回归测试：纯断言（所有白名单
   plan 的 `args[0] !== plan.file`，cargo test args === `['test']`）+ **真实 execFile
   smoke**（`verifyProblem` 用真实 `DEFAULT_EXEC_FILE` 跑 `node --test tools/dotenv.test.mjs`，
   断言 exit 0）。原 fake-exec 断言从 `['cargo','test']` 改为 `['test']`。
2. **[minor] worktree add 失败 stderr / provider 错误文本源头净化**（`tools/actions.mjs`）：
   `detail = add.stderr` 与 provider_unavailable/timeout/error 分支的 `run.error` 统一
   `redactKey(_, envKey)`（与异常 throw 分支一致）。
3. **[nit] fixTimestamp 秒级分辨率**（`tools/actions.mjs`）：保留毫秒
   （去掉 `.replace(/Z$/,'')` 前的 16 位截断），避免同一秒内拒绝后立即重发 fix 撞
   worktree/分支名。断言更新为毫秒级 ts（`20260827T153000000`）。
4. **记录不修（写入遗留）**：merge 成功但 recordMergeFix 落盘失败（重试自愈）；reject
   后旧 worktree 残留需人工清理；merged 后重开 fix 覆盖 fix_ref（closed 可重开的有意
   设计）；closed-triage mark_fixed 拦截为冗余防御。详见下方遗留风险。

## 遗留风险 / 待办

- **fix 端点是同步等待**：fix agent 超时可达 600s，浏览器 fetch 期间页面无进度反馈
  （页面显示「修复中…」提示）。后续可改为后台任务 + 轮询（非目标，MVP 单次任务）。
- **merge 未 push 远程**：按纪律「不提交不 push」，合入只发生在本地主 checkout；推送到
  origin 由用户/后续流程决定（design 记「本地 push（若需要）」为可选，见 design 备注）。
- **worktree 基于 `main` 分叉**：若主 checkout 当前分支领先 main，合入时可能冲突
  （merge 失败 → 500 且 problem 不变，页面提示）。
- **fix 后分支若 agent 未提交**：merge-fix 的「分支有提交」校验会拒绝（400），页面提示。
- **真实 provider 修复端到端**（含真实 worktree/git merge）属用户带 `ANTHROPIC_API_KEY`
  验收；本 change 全部经 fake adapter / fake gitExec 测试。
- **merge 成功但 recordMergeFix 落盘失败的边缘**：git merge 已发生但 problem 未 closed；
  重试 merge-fix 时分支已合入，`--no-ff` 会再产一个合入提交后正常闭环（自愈），记录在案。
- **reject 后旧 worktree 残留**：拒绝修复保留 worktree 供人工检查，需用户确认后自行
  `git worktree remove` 清理；fix_ref.rejected 里保留路径供查找。
- **merged 后重开 fix 覆盖 fix_ref**：closed（非 closed-triage）问题可再下发 fix，
  `recordFix` 会把 status 拉回 in_progress 并覆盖 fix_ref——「closed 可重开」的有意设计
  （与 updateProblem 状态模型一致），决策轨迹完整保留。
- **closed-triage mark_fixed 拦截为双重防御**：service 在跑命令前已拦截，recordVerify
  内再拦一次（原子兜底），无实际触发路径。
- **app.js 接线为 thin DOM glue，未被 node:test 直接覆盖**：数据逻辑（API/渲染/redaction）
  全部下沉到 problem-view.js 并有 fake-fetch 单测；DOM 层符合既有模式（`node --check` 校验）。
