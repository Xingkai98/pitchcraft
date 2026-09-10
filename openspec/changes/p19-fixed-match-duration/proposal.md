# Proposal: 固定比赛时长（时长保留为参数，UI 不暴露切换）

## Why

页面现在提供 5/10/45/90 分钟四档时长切换（`btn-duration` 按钮循环切换）。但实测确认：不同时长不是「同一场比赛截长/截短」，而是引擎按 `match_duration_seconds` 重塑整条随机流——5 分钟和 90 分钟是**两场完全不同的比赛**（seed=42 下 330 vs 5817 个事件，第 8 个事件起就分叉）。

当前目标是「先把一场比赛调好」。UI 上暴露多时长会让观察散落在不同比赛里，且这个切换对当前调试没有价值。本 change 把**时长降级为配置参数**（改 `config.js` 即可改，未来要换时长也方便），但**从界面移除切换入口**——当前固定为 5 分钟。

## What Changes

- **`viewer/config.js`**：`playback` 里把 `matchDurations` 数组与 `matchDuration` 双字段，收敛为单一参数 `matchDuration: 5`（分钟）。**时长值保留为可配置参数，改这里即改比赛时长**，只是不再有 UI 切换。
- **`viewer/app.js`**：删除 `btnDuration` 引用、`durationIndex` 变量、`rebuildGame` 函数、`btnDuration` click 监听；`init` 里时长固定读 `config.playback.matchDuration`。
- **`viewer/index.html`**：删除 `#btn-duration` 按钮 + `?v=` 版本号 bump。
- **spec 增补**：`pitch-viewer` 加「比赛时长是单一可配置参数，界面不提供切换」需求。

## Capabilities

### Modified Capabilities

- `pitch-viewer`: 比赛时长改为单一配置参数（当前 5 分钟），UI 移除时长切换入口。

## Impact

- `viewer/config.js` / `viewer/app.js` / `viewer/index.html`。
- 测试无对 matchDurations/matchDuration/btnDuration 的断言，无需改；`e2e-v2.mjs` 硬编码 `run(42,5400)` 不读 config，不受影响。
- 不碰引擎（`match_duration_seconds` 参数保留）、服务端、协议。
