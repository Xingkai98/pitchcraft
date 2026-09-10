# Tasks: viewer DOM 测试基建（jsdom harness）

## P1. 基建

- [ ] P1.1 建 `package.json`（`type: module`、`devDependencies.jsdom`、test script）
- [ ] P1.2 `npm install jsdom` 验证网络/版本可行性（失败 → 回报主 session 走手写 stub 回退）

## P2. 查询串 import 处理

- [ ] P2.1 选型并实现：让 `import app.js`（顶层带 `?v=`）在 Node 下可解析（loader/剥离），不改 app.js 源码

## P3. DOM harness

- [ ] P3.1 jsdom 从 `index.html` 建 DOM，stub 齐全（Canvas 复用 mock-canvas.js；WASM 优先走 mock-event-stream 路径；RAF/其他按需）
- [ ] P3.2 import 真实 app.js 不抛错，按钮监听器就位

## P4. 测试

- [ ] P4.1 `viewer/app.test.js`：P15 5 scenario（采集后清空 / 提交覆盖 / 提交后清空 / 凭证抹除 / 保留 frozen）
- [ ] P4.2 测试能驱动真实按钮监听器（非重新实现逻辑）

## P5. 验证收尾

- [ ] P5.1 `verify.sh` 纳入新测试并全绿（引擎 + viewer 含 app.test.js + WASM e2e + 真实性套件）
- [ ] P5.2 `openspec validate --all --strict` 通过
- [ ] P5.3 代码审阅闭环（独立 subagent 审阅 → 修复 → 再审阅，直到无遗留问题）
