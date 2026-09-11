# Tasks: 观察诊断前的「事件锚定确认」步

## P1. 状态词表

- [ ] P1.1 runner `TASK_STATUSES` 加 `awaiting_confirmation`、`confirmed`
- [ ] P1.2 页面 `OBSERVATION_STATUSES` 加同两态（`observation-list.js`）

## P2. 人话标签共享模块

- [ ] P2.1 新增事件描述函数 `describeEvent(e, lineup)`（`#55 · t=51s · 传球出边线 · 主队 #7`）
- [ ] P2.2 单测覆盖各类型（shot/pass/corner/throw_in/tackle/foul/beat 折叠/detail 区分）
- [ ] P2.3 双端可 import（viewer + tools）

## P3. runner 提案模式

- [ ] P3.1 `runProposal`：读 bundle → provider 产提案 → 写 `awaiting_confirmation` + `proposal`
- [ ] P3.2 无 provider → `proposal.source = "fallback-empty"`，状态仍 awaiting_confirmation
- [ ] P3.3 诊断 prompt 附 `confirmation.event_indexes` 锚定事件

## P4. service 端点

- [ ] P4.1 `POST /tasks/:id/confirm` 写 `confirmation`，状态 captured/awaiting_confirmation → confirmed
- [ ] P4.2 `GET /tasks/:id` 返回 `proposal` + `confirmation`

## P5. queue-cli

- [ ] P5.1 `propose <id>`（跑提案）
- [ ] P5.2 `events <id>`（看提案 + 全量事件人话标签）
- [ ] P5.3 `confirm <id> [--events 3,5 --note "..."]`

## P6. 页面

- [ ] P6.1 `awaiting_confirmation` 态渲染提案（A+B：默认模型提案，可展开全量重选）
- [ ] P6.2 勾选/删/加事件 → 提交 confirm
- [ ] P6.3 `confirmed` 态展示「已确认，等待诊断」
- [ ] P6.4 index.html 版本号 bump

## P7. 测试 + 收尾

- [ ] P7.1 service/runner/queue-cli 单测
- [ ] P7.2 页面 app.test.js（jsdom harness）提案渲染 + confirm
- [ ] P7.3 `verify.sh` 全绿 + `openspec validate` + 审阅闭环
