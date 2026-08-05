Type: grilling
Status: resolved

## Question

**画面层怎么处理"网页 + Windows 双端"？**

需求：网页版（移动端）+ Windows 程序都要能玩。
约束澄清："不用框架"指不用现成的 FM 类实现；通用工具（Canvas / SDL / Electron / Tauri / WASM）允许。

## Answer

**JS + Canvas。**
- 网页/移动端：浏览器原生 Canvas，纯几何绘制，不依赖图片素材。
- Windows 桌面：Tauri 套壳。Tauri 后端即 Rust，与引擎（Rust）同栈，天然契合。
- 画面层是纯消费端：读事件流渲染圆点球场，引擎（Rust）通过事件流喂给画面。

> 关联：`01` 引擎 Rust；`08` 运行时拓扑（画面如何拿到事件流）。
