# P13 Problem Actions — Design

## Goals / Non-Goals

**Goals:**

- 验证下发：从页面执行问题报告中的验证命令，结果回写。
- 修复下发：在隔离 worktree 起 bypass agent 修复并验证，主 checkout 零改动。
- 确认闭环：页面确认后合入修复，问题 closed，change_ref 记录。

**Non-Goals:**

- 自动合入（必须人工确认）。
- fix agent 的多轮对话/断点续跑（单次任务）。
- verify 命令的任意 shell 执行（白名单 + 超时 + 截断）。

## verify 设计

`POST /problems/:id/verify` body 可选 `{ command }`（缺省取报告 verification 字段第一条命令；无命令 → 400）。

- 命令白名单：只允许项目内可验证命令——`cargo test`、`cargo build --target wasm32-unknown-unknown --release`、`node --test tools/*.test.mjs`、`cd viewer && node --test *.test.js`、`./verify.sh`（前缀匹配 + 参数白名单）；其余拒绝。
- 执行：主 checkout cwd，`child_process` + 超时（默认 600s）+ 输出截断（保留尾部 2KB，redactKey 净化）。
- 结果回写：`decisions` 追加 `{action:'verify', by, at, command, exit_code, summary}`；全部通过（exit 0）且 body `{ mark_fixed: true }` → status `fixed`（默认不自动，页面按钮可选"验证并标记 fixed"）。
- 并发：同一 problem 并发 verify 允许（各自独立记录）；MVP 不做锁。

## fix 设计

`POST /problems/:id/fix` body 可选 `{ extra_instructions }`。

1. **worktree 创建**：`git worktree add <tmp>/p13-fix-<id> <branch>`（branch 从 main 分叉：`fix/<problem-id>/<ts>`）；主 checkout 只读。
2. **prompt 构建**（复用 diagnosis prompt 模式 + 修复指令）：现象、根因（report.root_cause）、修复方案（proposed_fix）、验证命令（verification）、约束（测试先行、不越界改无关文件、完成后跑验证命令并汇报结果）。
3. **agent 运行**：ClaudeCodeAdapter（bypass、env 净化、结构化输出校验——复用 provider.mjs/runner.mjs 的 `runDiagnosis` 骨架，但改"执行修复"模式：输出 schema 含 `changed_files`、`summary`、`verification_results`）。
4. **结果回写**：`decisions` 追加 `{action:'fix', by, at, worktree, branch, summary, changed_files, verification_results}`；status → `in_progress`；problem 存 `fix_ref: {worktree, branch, commit?, status:'pending_confirm'|'merged'|'rejected'}`。
5. **确认合入**：`POST /problems/:id/merge-fix` → 检查 worktree 分支有提交且验证过 → `git merge --no-ff <branch>` 入主 checkout main → problem status `closed`、`change_ref` 填 `fix/<id>`（或用户指定）→ 清理 worktree；失败/拒绝 → `fix_ref.status='rejected'`，worktree 保留供检查。（备注：合入只发生在本地主 checkout，**MVP 不自动 push 远程**——遵守「不提交不 push」纪律；推送到 origin 由用户/后续流程显式执行。实现见 implementation.md「审阅修复」第 5 条。）
6. 失败语义：fix agent 非零退出/超时/无效输出 → decisions 记录失败，problem 不变（status 不动），fix_ref 不建。

## viewer

- 详情面板加「验证」（+可选"并标记 fixed"）「修复」「确认合入」按钮与结果区（decisions 渲染）。
- 全部 textContent + redactText；cache-busting bump。

## 切片

1. **Slice 1**：`tools/actions.mjs` verify 执行器（白名单/超时/截断）+ `/verify` 端点 + 测试。
2. **Slice 2**：fix 编排（worktree/prompt/agent/结果回写）+ `/fix` + 测试（fake provider）。
3. **Slice 3**：merge-fix（合入/清理/闭环）+ viewer 按钮与结果展示 + docs + 全量验证。

## Risks / Trade-offs

- [verify 命令执行风险] → 白名单 + 超时 + 截断 + 只读工作树（verify 不改文件）。
- [fix agent 越界修改] → 隔离 worktree + 合入前 diff 审查（页面展示 changed_files）+ 人工确认。
- [worktree 泄漏] → 合入/拒绝后清理；异常残留记录在 fix_ref。
- [与 OpenSpec 流程的关系] → MVP 直接合入主 checkout；后续可改为"转 OpenSpec change"模式。
