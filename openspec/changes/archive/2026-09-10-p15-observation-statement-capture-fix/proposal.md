# Proposal: 观察描述采集时机修复（statement 错位）

## Why

P10 观察采集里，描述（`#obs-statement`）在「采集」那一刻冻结进 bundle：`viewer/app.js:442` `readObservationInputs` 读一次 `obsStatementEl.value.trim()`。但采集后输入框从不被清空，提交时（`submitObservation`）也不再重读。

用户实际操作流是「**采集 → 描述 → 提交**」：描述在采集之后才输入，于是每个 bundle 拿到的都是**前一条**的描述——第 1 条空、第 2 条拿第 1 句、第 3 条拿第 2 句，最后一条描述彻底丢失。已在 `.scratch/tasks` 三个 bundle 实测复现（`d411fca1` statement 空、`6c211786` 拿到「射门偏出…」、`4986e440` 拿到「角球…」）。

## What Changes

- **提交时重读描述**：`submitObservation` 在 POST 前重读 `obsStatementEl.value`，非空则覆盖 `lastBundle.statement`（经凭证形片段抹除）并同步更新当前列表条目的 statement。
- **采集后清空输入框**：`captureCurrentObservation` 冻结 bundle 后 `obsStatementEl.value = ''`，杜绝旧描述泄漏给下一条观察。
- **统一抹除口径**：`viewer/observation.js` 导出 `redactCredentialText`（原为模块私有），并新增纯函数 `resolveSubmitStatement(frozen, current)` 承载「非空覆盖、空则保留」的提交语义，可单测。

## Capabilities

### Modified Capabilities

- `match-observation`: 观察描述以「提交时输入框」为最终权威（采集时冻结的仅为初值/显示）；采集后清空输入框，避免跨观察错位。

## Impact

- `viewer/app.js`：`captureCurrentObservation` 采集后清空；`submitObservation` 提交前重读覆盖 + 同步列表条目。
- `viewer/observation.js`：导出 `redactCredentialText`；新增 `resolveSubmitStatement`。
- `viewer/index.html`：cache-busting 版本号 bump。
- `viewer/observation.test.js`：`resolveSubmitStatement` / `redactCredentialText` 导出单测。
- 不改服务端 / runner / 协议；无新依赖。
