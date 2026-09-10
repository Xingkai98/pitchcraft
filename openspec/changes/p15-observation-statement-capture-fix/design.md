# Design: 观察描述采集时机修复（statement 错位）

## Context

观察采集里描述读取时机错误：`readObservationInputs`（`viewer/app.js:442`）在「采集」时读一次 `obsStatementEl.value.trim()` 冻结进 bundle；采集后输入框不清空、提交时也不重读。用户「采集 → 描述 → 提交」的流程导致每个 bundle 拿到前一条的描述（错位一位，实测 `.scratch/tasks` 三 bundle 复现）。

## Goals / Non-Goals

**Goals:**
- 描述以「提交时输入框」为最终权威：非空覆盖，空则保留采集时冻结值。
- 采集后清空输入框，杜绝旧描述泄漏给下一条。
- 凭证形片段抹除口径统一（复用 `redactCredentialText`）。

**Non-Goals:**
- 改服务端 / runner / 协议（纯 viewer 行为）。
- 给观察列表加每条目独立提交按钮（保持单一「提交诊断」按钮语义）。
- 改变 queue-only 入队流程。

## Decisions

### D1: 提交时重读，覆盖 + 清空双管齐下

- `captureCurrentObservation`：冻结 bundle 后 `obsStatementEl.value = ''`。
- `submitObservation`：POST 前用 `resolveSubmitStatement(lastBundle.statement, obsStatementEl.value)` 得到最终 statement，非空覆盖 `lastBundle.statement` 并 `updateEntry(currentEntryId, { statement })` 同步列表卡片；随后**同样清空输入框**。
  - 只在采集时清空不足：提交后输入框仍留有刚提交的描述，下一条采集会把它冻结成初值，提交时若未再输入就沿用 —— 与本次修的错位同源。两处清空都必要。

### D2: 纯函数 `resolveSubmitStatement(frozen, current)`（observation.js，可测）

- 语义：`next = redactCredentialText(String(current ?? '').trim())`；`next` 非空 → 返回 `next`，否则返回 `String(frozen ?? '')`。
- 覆盖两种流程：(a) 采集前已输入描述、采集（清空）后提交未改 → 保留 frozen；(b) 采集后输入描述 → 覆盖。
- `redactCredentialText` 从模块私有改为导出，供 app.js 与测试复用（与 `captureObservation` 内抹除口径一致）。

### D3: 不改数据协议

- `statement` 仍在 bundle 顶层字段；server/runner 不感知变化。`redactBundleForExport` 提交前的深抹除保持兜底。

## Risks / Trade-offs

- **[下载 bundle 不经提交]**：`downloadBundle` 用当时 `lastBundle.statement`；若用户采集后输入描述但不提交直接下载，下载的 bundle 仍是空/旧描述（尚未提交过时 = 采集时冻结值）。缓解：明确「下载」用当前 bundle 快照、诊断用提交时最终描述；不扩大本次范围。
- **[提交时清空后覆盖语义]**：采集前输入描述、采集（清空）后想改成无描述再提交，会保留采集时旧描述（仅非空才覆盖）。缓解：这是当前单输入框模型的固有权衡，非本次目标。

## Migration Plan

1. `observation.js` 导出 `redactCredentialText` + 新增 `resolveSubmitStatement`。
2. `app.js` 采集后清空 + 提交时重读覆盖 + 同步列表条目。
3. `observation.test.js` 加 `resolveSubmitStatement` 单测（覆盖/保留/抹除/空串）。
4. `index.html` 版本号 bump。
5. `verify.sh` 全绿（viewer 单测 + e2e）。
6. 代码审阅闭环（独立 subagent，直到全部通过）。
