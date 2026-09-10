# Design: viewer DOM 测试基建（jsdom harness）

## Context

`viewer/` 无 `package.json`、无 `node_modules`（纯 Node ESM + 零第三方依赖）。现有测试 `node --test *.test.js` 直接跑纯函数，`renderer.test.js`/`micro-motion.test.js` 已用 `mock-canvas.js` mock 掉 Canvas。`app.js` 顶层 import 全部带 `?v=` 查询串（cache-busting），其注释明确「传递依赖未带版本号（Node 测试不支持查询串）」——直接 `import app.js` 在 Node 里会因查询串失败。P15 审阅 round3 曾用树外 headless harness 驱动真实 `app.js` 实测（3000 序列 0 mismatch），证明可行但未入库。

## Goals / Non-Goals

**Goals:**
- 用 jsdom 建 DOM 测试基建，把 P15 的 5 个 spec Scenario 锁进 CI（采集后清空、提交覆盖、提交后清空、凭证抹除、保留 frozen）。
- 测试驱动**真实 `app.js`**（真实按钮监听器 + 真实 `resolveSubmitStatement` 接线），非重新实现一遍逻辑。
- `verify.sh` 全绿纳入新测试。

**Non-Goals:**
- 不给整个 `app.js` 做全覆盖（渲染循环、播放控制、problem 面板等不在本次范围）。
- 不改 `app.js` 运行时逻辑（除非为可测性做最小重构且不改变行为）。
- 不把 jsdom 带进浏览器运行时/WASM bundle（仅 devDependency）。

## Decisions

### D1: jsdom 作为项目首个 devDependency

- 建 `package.json`，`devDependencies.jsdom`。测试用、不进运行时。符合「从零写」约束边界——jsdom 是通用测试工具，非 FM 类实现。
- `node --test` 直接用 Node 原生 test runner，不引入 jest/mocha。

### D2: 查询串 import 处理（agent 调研选型，推荐优先级）

app.js 顶层 `import './game.js?v=...'` 在 Node ESM 下无法解析。候选：
1. **Node loader（`module.registerHooks` / `--loader`）**：resolve 阶段把 `.js?v=...` 剥成 `.js`。不改 app.js 源码、不破坏浏览器 cache-busting。**推荐**。
2. 测试里读 app.js 源码，正则剥查询串后用临时文件/data URL import。hacky，可作 fallback。
3. 改 app.js 顶层 import 去掉查询串。**不取**——破坏浏览器 cache-busting。

### D3: stub 面

- Canvas：复用 `mock-canvas.js`。
- WASM：`global.fetch`（`engine.wasm`）+ `WebAssembly.instantiate` stub，或复用 `mock-event-stream.js` 路径让 app 走 mock 事件流（P0 注释明示「当 engine.wasm 未就绪时 app 可用 mock 替代」——优先此路径）。
- `requestAnimationFrame`、`localStorage`（jsdom 自带）、其他顶层用到的浏览器 API 按需 stub。

### D4: 测试范围 = P15 5 Scenario

逐一映射：
1. 采集后清空 → 点采集按钮后断言 `obsStatementEl.value === ''`。
2. 提交覆盖 → 采集（空描述）→ 输入 → 点提交 → 断言 bundle statement 或列表条目 statement 为输入值。
3. 提交后清空 → 采集→输入→提交后断言输入框清空。
4. 凭证抹除 → 输入含 `sk-ant-` 后提交，断言 statement 抹除。
5. 保留 frozen → 采集前输入→采集（清空）→直接提交→断言保留冻结值。

## Risks / Trade-offs

- **[npm install 网络可行性]**：本环境 npm 可能受限。agent 先 `npm install jsdom` 验证；失败则回退「手写轻量 DOM stub」（round3 已验证可行，零依赖，失真风险略高），并回报主 session 重新确认。
- **[jsdom 与 Node 版本]**：确认 Node 版本支持 jsdom 与 `module.registerHooks`（若选 loader 路线）。
- **[app.js 顶层初始化重]**：顶层 `document.getElementById` 大量元素 + WASM 加载 + 事件绑定，import 即执行。jsdom 需先建好完整 DOM（从 index.html 读）再 import，且 stub 齐全，否则 import 抛错。

## Open Questions

- npm install 在本环境是否可行（agent 落地第一步验证，不可行即回报）。
