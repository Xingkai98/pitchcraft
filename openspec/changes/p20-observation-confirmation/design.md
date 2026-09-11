# Design: 观察诊断前的「事件锚定确认」步

## Context

设计已 grill 定稿（`.scratch/issues/12-observation-confirmation.md`），本 design 落地实现细节。

链路现状：采集 → captured → 诊断。缺「确认用户描述锚定哪些事件」的步。bundle 的 `events` 是窗口内完整事件列表（每条带 `index`），是确认的数据基础。

## Goals / Non-Goals

**Goals:**
- 在 captured 与诊断之间插入确认步，确认产物 = 事件 index 集合。
- 三面触发（页面 / CLI / 对话）共享同一套数据与状态机。
- 无 provider 时确认步仍可用（用户从全量列表选）。

**Non-Goals:**
- 不「一键扩窗口」（锚点漂移只做文字提示）。
- 不做 seed 可配置（#24）、不做引擎重构（#25）。
- 对话面不加新端点——由主 session 编排 CLI 原语。

## Decisions

### D1: 状态机

```
captured → awaiting_confirmation → confirmed → auditing → … → 终态
```

- `captured`：已入队，等「取提案」。
- `awaiting_confirmation`：提案已产出，等人确认。
- `confirmed`：已确认锚定，等「取诊断」——**不自动触发诊断**，与 captured 同语义（queue-only 等 CLI / 非 queue-only 可自动跑）。
- 两个新增状态进 runner `TASK_STATUSES` 与页面 `OBSERVATION_STATUSES` 词表。

### D2: 提案的数据结构（task 文件）

```json
"proposal": {
  "event_indexes": [55],
  "candidates": [
    {"index": 55, "why": "窗口内唯一出边线传球，与『踢出边线』对应"}
  ],
  "drift_hints": [
    {"mention": "角球", "hint": "窗口内无角球事件；最接近的角球在 t=27s（窗口外）"}
  ],
  "source": "llm" | "fallback-empty"
}
```

- `fallback-empty`：无 provider 时 `event_indexes` 空、`candidates` 空，页面/CLI 直接展示全量列表让用户选。

### D3: 确认数据结构

```json
"confirmation": {
  "event_indexes": [55],
  "source": "page" | "cli" | "chat",
  "note": ""
}
```

- `event_indexes` 可为空数组（用户认为描述不锚定任何具体事件）。

### D4: 人话标签函数（双端共享）

- 函数 `describeEvent(e, lineup)` → `#55 · t=51s · 传球出边线 · 主队 #7`。
- 类型显眼（传球/射门/角球/界外球/抢断/犯规），区分 `detail`（out_sideline/out_goal_line/corner/header…）。
- **双端复用**：viewer 页面与 queue-cli 都要用。落地为一个共享模块（viewer 用 ESM import，CLI 用同样 ESM import——tools 下已有 `bundle.mjs` 被 viewer 引用的先例）。

### D5: runner 提案模式

- `runDiagnosis` 增加模式或新入口 `runProposal`：读 bundle → 调 provider 产提案 → 写 task 状态 `awaiting_confirmation` + `proposal`。
- 提案 prompt 要求：只输出 index 集合 + 每条 why + drift_hints，**不改代码、不做诊断**。
- 无 provider（provider_unavailable）→ 写 `proposal.source = "fallback-empty"`，状态仍 `awaiting_confirmation`（不失败）。

### D6: 诊断输入带锚定事件

- 诊断阶段 prompt 附 `confirmation.event_indexes`，把 bundle 里对应事件原文作为「用户确认的锚点」传入，agent 不再自己猜。

### D7: 三面触发

- 页面：`POST /tasks/:id/confirm`；CLI：`queue-cli confirm <id> --events 3,5`；对话：主 session 调 CLI。
- `GET /tasks/:id` 返回 `proposal` + `confirmation`（白名单字段扩展）。

## Risks / Trade-offs

- **[状态词表扩展的兼容]**：旧 captured 任务没有 proposal/confirmation；页面/CLI 需容错（无 proposal 时 captured 行为不变，确认步是可选增强，不强制）。
- **[人话标签的准确度]**：事件字段多样（beat 内嵌 main/movers）；标签只覆盖高亮事件，beat 折叠。
- **[提案质量]**：LLM 提案可能错，靠「可删可加 + 从全量重选」兜底。

## Migration Plan

1. 状态词表（runner + page）。
2. 人话标签共享模块 + 单测。
3. runner 提案模式 + 诊断输入改。
4. service confirm 端点 + 返回字段。
5. queue-cli propose/events/confirm。
6. 页面提案 UI（A+B）。
7. 测试 + verify.sh + 审阅闭环。
