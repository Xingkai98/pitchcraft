Type: grilling
Status: resolved

## Question

**引擎（Rust）和画面（JS Canvas）在"网页版"和"Windows 桌面版"里怎么协同运行？**

候选：A 离线预生成 / B 内嵌引擎（桌面 Tauri 后端内嵌 + 网页 WASM）/ C 混合。

## Answer

**B 一步到位（内嵌引擎）。**
- 桌面版：Tauri 后端内嵌 Rust 引擎 crate，画面 JS 通过 Tauri IPC 拿事件流。
- 网页版：Rust 引擎编译成 WASM 在浏览器内跑，画面 JS 直连（改战术→重新模拟）。
- 不搞"先离线预生成再升级"的过渡——P0 直接上 WASM 工程。
- 引擎必须是独立 Rust crate（库），同时支持桌面内嵌与 WASM 编译两种消费方式。

## 影响（记入 design.md P0）

- P0 即含 Rust→WASM 构建链（wasm-bindgen 等）。
- 引擎 crate 的 I/O 需保持"纯逻辑、可被任一端调用"——不能假设自己有文件系统/命令行。
