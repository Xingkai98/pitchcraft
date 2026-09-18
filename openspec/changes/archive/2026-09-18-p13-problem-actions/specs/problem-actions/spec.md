## ADDED Requirements

### Requirement: 问题可下发验证命令

系统 SHALL 提供 `POST /problems/:id/verify`：执行问题报告 verification 字段的命令（或显式 `command`）；命令 SHALL 受白名单约束（cargo test / cargo build wasm / node --test tools / viewer 测试 / verify.sh，参数受限），带超时与输出截断（redact 后回写）；结果 SHALL 追加 decisions（command/exit_code/summary）；body `mark_fixed: true` 且 exit 0 时 SHALL 置 status `fixed`。

#### Scenario: 验证通过

- **WHEN** 用户下发 verify 且命令 exit 0
- **THEN** decisions 追加 verify 记录，页面显示通过摘要；`mark_fixed` 时 status 置 fixed

#### Scenario: 白名单外命令

- **WHEN** 用户传入白名单外的命令
- **THEN** 服务返回 400 拒绝，不执行

### Requirement: 问题可下发修复

系统 SHALL 提供 `POST /problems/:id/fix`：在隔离 worktree（分支从 main 分叉）启动本机 Claude Code（bypass、环境净化、结构化输出校验）执行修复；prompt SHALL 含现象/根因/修复方案/验证命令与约束（测试先行、不越界、完成后自验证）；结果 SHALL 回写 decisions（summary/changed_files/verification_results），status 置 `in_progress`，problem 记录 `fix_ref`（worktree/branch/status）；主 checkout 不得被触碰。

#### Scenario: 修复成功

- **WHEN** fix agent 在 worktree 完成修改并通过自带验证
- **THEN** problem 记录 fix_ref pending_confirm，页面展示 changed_files 与验证结果

#### Scenario: 修复失败

- **WHEN** fix agent 非零退出/超时/输出无效
- **THEN** decisions 记录失败，problem 状态与数据不变

### Requirement: 修复确认闭环

系统 SHALL 提供 `POST /problems/:id/merge-fix`：合入 fix worktree 分支到主 checkout（必须存在提交且验证记录），成功 SHALL 置 problem `closed` 并填 change_ref、清理 worktree；用户拒绝 SHALL 置 fix_ref rejected（worktree 保留）；合入前 SHALL 展示变更摘要供确认。

#### Scenario: 确认合入

- **WHEN** 用户在页面确认合入修复
- **THEN** 分支合入主 checkout，problem closed，change_ref 记录，worktree 清理

#### Scenario: 拒绝修复

- **WHEN** 用户拒绝该修复
- **THEN** fix_ref 置 rejected，worktree 保留，problem 不闭环
