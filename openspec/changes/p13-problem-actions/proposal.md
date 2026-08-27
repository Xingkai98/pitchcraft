## Why

P10-P12 让问题可诊断、可持久化、可操作（重跑/删除/导入/issue），但"修复 → 验证 → 闭环"仍停留在页面外：用户要手工开会话改代码、手工跑验证、手工更新问题状态。本 change 把问题页面升级为工作台——**验证与修复动作可直接从页面下发**，结果回写审计轨迹，确认后闭环。

## What Changes

- `POST /problems/:id/verify`：执行问题诊断报告中的 verification 命令（或显式指定命令），结果（exit code / 输出摘要）回写 decisions；全部通过时可选自动置 `fixed`（默认人工确认）。
- `POST /problems/:id/fix`：从报告（现象/根因/修复方案/验证命令）生成 fix prompt，在**隔离 worktree** 中启动本机 Claude Code（bypass 模式）执行修复并自行验证；完成后结果回写 problem（decisions + status），页面展示修复摘要；主 checkout 不被触碰，用户确认后才合入。
- 确认闭环：页面按钮"确认合入修复"（fix 完成后）→ 把修复 worktree 的改动合入主 checkout（或转 OpenSpec change 流程），status → `closed`；`change_ref` 自动填写。
- 复用 provider 全链路（环境净化/redaction/bypass 权限/结构化输出校验）；所有动作留审计轨迹。

## Capabilities

### Modified Capabilities

- `problem-lifecycle`: 增加 verify / fix / 确认合入三个动作下发

## Impact

- `tools/actions.mjs`（新）：verify 执行器（白名单命令、超时、输出截断 redact）、fix 编排（worktree 创建、prompt 构建、agent 运行、结果汇总）。
- `tools/service.mjs`：`/problems/:id/verify`、`/problems/:id/fix`、`/problems/:id/merge-fix` 端点。
- `tools/github.mjs` 或 actions：worktree git 操作（创建分支/提交/合入，或生成 patch 供确认）。
- `viewer`：详情面板加"验证 / 修复 / 确认合入"按钮与结果展示；cache-busting。
- 无新依赖；fix agent 复用 ClaudeCodeAdapter（bypass）。
