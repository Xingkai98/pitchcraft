# Proposal: P0 事件流到球场（event-to-pitch）

## Why

wayfinder 讨论已锁定技术栈（Rust 引擎 + JS Canvas 画面 + B 内嵌引擎），但**尚无任何可运行的代码**。协议草案（`event-stream-protocol-prototype.md`）的关键字段（subject/from/to、result 枚举、时间/坐标精度）**必须靠真实原型验证**才能定稿——纸上无法拍板。P0 的目标是**打通"Rust 引擎 → 事件流 → JS 画面"这条链路**，让协议在真实代码里被检验，同时建立一个可扩展的工程骨架。

## What Changes

- 新建 **Rust 引擎 crate**：纯逻辑、平台无关，可编译为 WASM（桌面端 Tauri 内嵌与网页端 WASM 两种消费方式的基础）。
- 新建 **JS 画面层**：Canvas 渲染圆点球场，消费事件流，按演绎剧本（`interpretation-scripts.md`）画出可看懂的动作。
- 建立 **事件流协议 v1**：基于草案（字段、8 类事件、归一化坐标），作为引擎与画面的接缝，在 P0 中验证并迭代。
- 引擎产出**最小比赛事件流**（kickoff → 传球/带球/射门 → whistle），画面把事件演绎成圆点动画。
- 浏览器中可见：引擎（WASM）实时产出事件流 → 画面播放。

## Capabilities

### New Capabilities

- `match-engine`: Rust 事件引擎——确定性产出一场比赛的事件流（纯逻辑、平台无关、可 WASM 编译）。
- `event-stream-protocol`: 引擎与画面之间的事件流协议——字段定义、事件类型枚举、归一化坐标（草案 v1，P0 中验证迭代）。
- `pitch-viewer`: JS Canvas 2D 画面层——消费事件流，按演绎剧本把事件渲染成圆点球场动画。

### Modified Capabilities

无（首次开发）。

## Impact

- 新增代码：`engine/`（Rust crate）+ `viewer/`（JS + Canvas）。
- 新增依赖：Rust（wasm-bindgen 等 WASM 构建链）；JS（纯原生 Canvas，无框架）。
- 技术栈已由 wayfinder 锁定：Rust 引擎 + JS Canvas + Tauri（双端）+ B 内嵌引擎拓扑。
- 协议字段待 P0 验证后定稿；不预设最终结论。
