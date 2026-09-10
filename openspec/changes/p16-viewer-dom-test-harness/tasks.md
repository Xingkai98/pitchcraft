# Tasks: viewer DOM 测试基建（jsdom harness）

## P1. 基建

- [x] P1.1 建 `package.json`（`type: module`、`devDependencies.jsdom`、test script）
- [x] P1.2 `npm install jsdom` 验证网络/版本可行性（失败 → 回报主 session 走手写 stub 回退）
      —— 本环境可行：jsdom 30.0.1 / 38 包 / ~10s。走 jsdom 路线，无需回退。

## P2. 查询串 import 处理

- [x] P2.1 选型并实现：让 `import app.js`（顶层带 `?v=`）在 Node 下可解析（loader/剥离），不改 app.js 源码
      —— `viewer/test-query-loader.mjs`（`module.registerHooks`，design D2 推荐路线）：
      resolve 阶段把 `.js?v=…` 解析为「保留查询串的 file URL」，load 阶段剥查询串读盘。
      查询串保留使不同 `?…` 得到独立模块实例（与浏览器一致），测试可隔离 app.js 模块级状态。

## P3. DOM harness

- [x] P3.1 jsdom 从 `index.html` 建 DOM，stub 齐全（Canvas 复用 mock-canvas.js；WASM 优先走 mock-event-stream 路径；RAF/其他按需）
      —— `viewer/dom-test-harness.mjs`：`HTMLCanvasElement.getContext` → `MockContext`；
      `fetch` 默认抛错 → app.js 的 `tryLoadEngine` 退回 mock 事件流（不碰 engine.wasm）；
      rAF no-op（渲染循环属 Non-Goals）；document/window/location/localStorage/navigator/getComputedStyle 从 jsdom window 借入。
- [x] P3.2 import 真实 app.js 不抛错，按钮监听器就位
      —— init 完成 status 为「事件数: 19 | mock 数据」，`#btn-capture`/`#btn-submit` 监听器可用。

## P4. 测试

- [x] P4.1 `viewer/app.test.js`：P15 5 scenario（采集后清空 / 提交覆盖 / 提交后清空 / 凭证抹除 / 保留 frozen）
      —— 8 用例（5 scenario + harness 自检 + 等值裁剪清空 + 跨观察隔离）。
- [x] P4.2 测试能驱动真实按钮监听器（非重新实现逻辑）
      —— 点 `#btn-capture`/`#btn-submit` 触发 app.js `addEventListener`；断言其写入的输入框值 /
      列表 DOM / 实际 POST 出去的 bundle。mutation 验证：删 app.js 两行清空 → 5 用例红；
      把 `resolveSubmitStatement(…, obsStatementEl.value)` 改成 `''` → 3 用例红。

## P5. 验证收尾

- [x] P5.1 `verify.sh` 纳入新测试并全绿（引擎 + viewer 含 app.test.js + WASM e2e + 真实性套件）
      —— viewer 251 用例全绿（243 基线 + 8 新增）；4 步全通过。
- [x] P5.2 `openspec validate --all --strict` 通过（17 items, 0 failed）
- [ ] P5.3 代码审阅闭环（独立 subagent 审阅 → 修复 → 再审阅，直到无遗留问题）
