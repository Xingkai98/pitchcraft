# Proposal: viewer DOM 测试基建（jsdom harness）

## Why

P15 修复了观察描述错位（采集/提交时的清空与覆盖），但这些改动落在 `viewer/app.js` 的 DOM 接线上——而 `app.js` 从未有测试文件（`app.test.js` 不存在）。现有测试全是纯函数（`observation.test.js` 等 `node --test *.test.js`），测不到 `app.js` 里「点采集 → 清空输入框」「点提交 → 覆盖 statement → 清空」这些真实 DOM 行为。

后果：若有人误删那两行 `obsStatementEl.value = ''`，CI 不会红，错位 bug 会静默回归。P15 审阅 round3 曾用一个树外 headless harness（临时 DOM stub）实测过真实 `app.js`，但该 harness 未入库。

本 change 把 DOM 测试基建正式化入库，用 jsdom 把 P15 的 5 个 spec Scenario 锁进 CI。

## What Changes

- **建 `package.json` + 引入 `jsdom` devDependency**（项目首个第三方依赖；仅测试用，不进运行时/WASM/浏览器 bundle）。
- **新增 `viewer/app.test.js`**：jsdom 挂 `index.html` DOM → import 真实 `app.js` → 驱动真实按钮监听器 → 断言 P15 采集/提交的清空与覆盖行为。
- **处理 app.js 顶层带 `?v=` 查询串的 import**（Node ESM 不支持查询串，需 loader/剥离方案）。
- **stub 浏览器 API**：Canvas 复用 `mock-canvas.js`；WASM `fetch`/`WebAssembly.instantiate`、`requestAnimationFrame` 等按需 stub。
- **`verify.sh` 纳入新测试**（viewer 单测自动包含 `app.test.js`，或显式补一条）。
- **spec 增补**：`match-observation` 加「DOM 行为有自动化测试覆盖」需求。

## Capabilities

### Modified Capabilities

- `match-observation`: 观察采集/提交的 DOM 行为（采集后清空、提交覆盖、提交后清空）由自动化测试覆盖并进 CI。

## Impact

- `package.json`（新）：jsdom devDependency + test script。
- `viewer/app.test.js`（新）：DOM 测试。
- `viewer/*` 可能新增测试专用 loader/stub 文件。
- `verify.sh`：纳入新测试。
- `openspec/specs/match-observation`：spec delta 同步。
- 不碰引擎、服务端、协议；不改 `app.js` 运行时逻辑。
