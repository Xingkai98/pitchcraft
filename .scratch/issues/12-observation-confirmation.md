# 12 · 观察诊断前的「事件锚定确认」步

- Type: design
- Status: resolved（设计定稿，待立 OpenSpec change）
- Created: 2026-09-10
- 关联: `openspec/specs/match-observation`、`diagnosis-runner`；`queue-cli.mjs`

## 背景

现在链路：`采集(statement+窗口事件) → captured → 诊断(agent 直接拿 statement 分析/改)`。

缺一步：agent 没先确认「用户这句话到底指窗口里哪几个事件」。自然语言描述要落到具体事件锚点上，猜错锚点则后面诊断全废。

## 设计定稿（grill 敲定）

### 核心模型

窗口内已有一个完整事件列表（bundle 的 `events`，每条带 `index`）。模型（或用户）从里面选出**几个候选事件**，把候选对应到用户描述上，经用户确认后锚定，才进入诊断。

**确认的唯一产物 = 事件 index 集合**（可增可减，可为空）。

### 展示形式：A+B 组合

- **A（默认）**：模型提案——列出候选事件（带「为什么」），附锚点漂移提示（`⚠️` 文字提示「描述里的 X 不在窗口内，可能在 t=Y」）。**只提示，不做一键扩窗口。**
- **B（展开）**：点「从全部事件重选」展开全量事件列表（默认只列高亮事件 shot/pass/corner/tackle/foul/throw_in，**beat 折叠**；提供「显示全部」开关展开 beat）。
- 无模型时直接进 B（全量列表让用户选）。

### 人话标签

事件是技术字段 `{t,type,subject,result,x,y}`，需渲染成 `#55 · t=51s · 传球出边线 · 主队 #7` 之类。**页面/CLI/对话三处共用同一份标签函数**。类型必须显眼（传球 vs 射门 vs 角球），否则用户无法发现「以为是射门、其实是传球」的错位。

### 状态机

```
captured → [提案] → awaiting_confirmation → [确认] → confirmed → [诊断] → 终态
```

- `awaiting_confirmation`：提案已产出，等人确认。
- `confirmed`：**不自动触发诊断**，跟 `captured` 一样是「等人来取」的待处理态（queue-only 服务等 CLI、非 queue-only 可确认后自动跑、对话由主 session 触发）。
- 确认动作 = 往 task 写 `confirmation`，不改别的。

### 确认的数据结构（task 文件）

```json
"confirmation": {
  "event_indexes": [55],
  "source": "page | cli | chat",
  "note": "用户确认 t=51 出边线这条"
}
```

### 三面触发

| 入口 | 触发 | 落点 |
|---|---|---|
| 页面 | 观察条目 `awaiting_confirmation` 态渲染 A 提案（勾/删/加）→ `POST /tasks/:id/confirm`（**只记确认，不自动跑**） | service 端点写 task |
| CLI | `queue-cli events <id>` 看提案（人话标签）+ `queue-cli confirm <id> [--events 3,5 --note "..."]` | 直接写 task |
| 对话 | **主 session 编排同一套 CLI 原语**（读提案→转述→转达确认→触发诊断），零新增代码 | 复用 CLI |

## 真实案例（验收样例）

三个任务已对齐，作为确认步的验收：

1. **任务1**「射门偏出+为啥角球」：窗口 [6.5,16.5] 只有 `#9 传球出底线`，无射门无角球（角球漂在 t=27）。→ 确认步须能显示类型错位（pass≠shot）+ 锚点漂移提示。
2. **任务2**「角球防守站位」：`#28 角球` 锚对，但「站位关系」在 `viewer_snapshot.players` 坐标里、不在事件类型里。→ 确认步/诊断输入须带快照坐标。
3. **任务3**「踢出边线」：`#55 传球出边线` 完美对齐。→ 正常路径。

## 影响面

- 状态词表（runner `TASK_STATUSES` + 页面 `OBSERVATION_STATUSES`）：加 `awaiting_confirmation`、`confirmed`
- runner：提案模式（新 agent 阶段，只产出候选 index 集合，不诊断）
- queue-cli：`events`（看提案）、`confirm`（写确认）子命令
- service：`POST /tasks/:id/confirm` 端点
- 页面：提案 UI（A+B）+ 人话标签函数 + 快照展示（任务2 需要）
- spec：`match-observation` + `diagnosis-runner` 增补

## Next

- 立 OpenSpec change（建议单独立项 `p20-observation-confirmation`）。
- 提案模式的 prompt 设计（怎么让 agent 只产出 index 集合 + 理由 + 漂移提示）待 change 内定。
- 与 #25（引擎造数重构）独立：确认步锚定事件后，发现的「引擎不合理」是另一条线。
