# Tasks: 观察描述采集时机修复（statement 错位）

## P1. 纯函数（observation.js）

- [x] P1.1 导出 `redactCredentialText`（原模块私有函数）
- [x] P1.2 新增 `resolveSubmitStatement(frozen, current)`：非空覆盖 + 凭证抹除 + 空则保留 frozen

## P2. 页面（app.js）

- [x] P2.1 `captureCurrentObservation` 采集后清空 `obsStatementEl.value`
- [x] P2.2 `submitObservation` 提交前 `resolveSubmitStatement` 覆盖 `lastBundle.statement` 并 `updateEntry` 同步 statement
- [x] P2.3 `index.html` 版本号 bump（`?v=` 新值，格式 `YYYYMMDD-N`）

## P3. 测试

- [x] P3.1 `observation.test.js`：`resolveSubmitStatement` 覆盖 / 保留 / 空串 / 凭证抹除
- [x] P3.2 `observation.test.js`：`redactCredentialText` 导出可引用

## P4. 验证收尾

- [x] P4.1 `verify.sh` 全绿（引擎 + viewer 单测 + WASM e2e + 真实性套件）
- [x] P4.2 代码审阅闭环（独立 subagent 审阅 → 修复 → 再审阅，直到无遗留问题）
