# Proposal: 观察诊断前的「事件锚定确认」步

## Why

现在链路：`采集(statement+窗口事件) → captured → 诊断(agent 直接拿 statement 分析/改)`。

缺一步：agent 没先确认「用户这句话到底指窗口里哪几个事件」。自然语言描述要落到具体事件锚点上，猜错锚点则后面诊断全废。真实案例：任务1「射门偏出+为啥角球」实际窗口里只有「传球出底线」（无射门），角球更漂在窗口外 t=27——若直接诊断，agent 面对「你说射门、窗口没射门」只能瞎猜。

本 change 在 `captured` 与诊断之间插入「事件锚定确认」步：让模型（或用户）从窗口事件列表里选出几个候选事件，经用户确认锚定后，才进入诊断。设计已 grill 定稿，见 `.scratch/issues/12-observation-confirmation.md`。

## What Changes

- **状态机**：`captured → [提案] → awaiting_confirmation → [确认] → confirmed → [诊断] → 终态`。新增两个状态 `awaiting_confirmation`、`confirmed`。
- **runner 提案模式**：新阶段，读 bundle（statement + 窗口事件），产出候选事件 index 集合 + 每个候选的「为什么」+ 锚点漂移提示。只提案不诊断。无 provider 时提案为空（用户直接从全量列表选）。
- **确认数据结构**：task 文件加 `confirmation` 字段（`event_indexes` + `source` + `note`）。
- **service**：`POST /tasks/:id/confirm` 写确认；`GET /tasks/:id` 返回 `confirmation` + `proposal`。
- **queue-cli**：`propose <id>`（跑提案）、`events <id>`（看提案+全量事件人话标签）、`confirm <id> [--events 3,5]`（写确认）。
- **页面**：`awaiting_confirmation` 态渲染提案（A+B 组合：默认模型提案，可展开全量列表重选）；人话标签函数（三面共用）。
- **诊断输入**：诊断阶段 prompt 带上 `confirmation.event_indexes`（锚定事件），不再自己猜锚点。

## Capabilities

### Modified Capabilities

- `match-observation`: 观察提交后增加事件锚定确认步（页面 UI + 人话标签）。
- `diagnosis-runner`: runner 提案模式、确认端点、queue-cli 子命令、诊断输入带锚定事件。

## Impact

- 状态词表（runner `TASK_STATUSES` + 页面 `OBSERVATION_STATUSES`）
- `tools/runner.mjs`（提案模式 + 诊断输入改）、`tools/service.mjs`（confirm 端点 + 返回字段）
- `tools/queue-cli.mjs`（propose/events/confirm 子命令）
- 人话标签函数（双端共享：viewer 页面 + queue-cli CLI）
- `viewer/app.js` / `viewer/observation-list.js` / `viewer/index.html`（提案 UI + 版本号）
- 不碰引擎、事件流协议。

## 关联

- 设计定稿：`.scratch/issues/12-observation-confirmation.md`
- 依赖：人话标签需读 bundle 事件；诊断后发现的引擎问题属 #25（独立）。
