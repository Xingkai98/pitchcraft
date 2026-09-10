# Design: 固定比赛时长（时长保留为参数，UI 不暴露切换）

## Context

`viewer/config.js` `playback` 现有 `matchDurations: [5,10,45,90]` + `matchDuration: 90` 两个字段；`app.js` 用 `durationIndex` 在数组里循环，`btnDuration` 点击后 `rebuildGame()` 重新 simulate。引擎侧 `match_duration_seconds` 参数保留，不同时长 = 不同随机流（已实测确认，非截断）。

## Goals / Non-Goals

**Goals:**
- 从 UI 移除时长切换入口（按钮、循环逻辑）。
- 时长保留为**单一可配置参数**，改 config 即可改比赛时长（未来调试需要换时长不必改代码逻辑）。
- 当前值固定 5 分钟。

**Non-Goals:**
- 不改引擎 `match_duration_seconds` 语义与参数。
- 不重做「多时长并存」的产品设计（未来要恢复再单开 change）。
- 不引入 seed 可配置（那是另一个 change）。

## Decisions

### D1: config 收敛为单一参数 `playback.matchDuration`

- 删 `matchDurations` 数组，保留单一 `matchDuration: 5`（分钟）。
- 语义：这是「比赛内容的真实时长参数」，非播放时长（播放快慢仍由跳过/倍速控制）。
- 未来要换时长：改 `config.playback.matchDuration = 90` 即可，无需动 app.js 逻辑。

### D2: app.js 移除切换接线

- 删 `durationIndex`（`app.js:130-131`）、`btnDuration`（`:62`）、`rebuildGame`（`:344-348`）、`btnDuration` 监听（`:357-361`）。
- `init()` 两处 `config.playback.matchDurations[durationIndex] ?? 90` → `config.playback.matchDuration`。
- 删除后 `resetMicroMotion` 若只被 `rebuildGame` 调用，检查是否还有其他调用方；无则一并评估（保持最小 diff，不动 micro-motion 本身）。

### D3: index.html 删按钮 + bump

- 删 `#btn-duration` 按钮（`index.html:387`）。
- `?v=` bump。

## Risks / Trade-offs

- **[未来要恢复多时长]**：需把单一参数改回数组/选项。缓解：config 语义清晰（`matchDuration` 单一值），恢复成本低。
- **[观察锚定在哪场]**：本次之后所有观察锚定「seed=42 + 5 分钟」这一场。此前已采的观察也是 5 分钟档（11.5/27/51s 均在 300s 内），与固定后一致。

## Migration Plan

1. `config.js`：`matchDurations`+`matchDuration` → 单一 `matchDuration: 5`。
2. `app.js`：删切换接线，init 读 `matchDuration`。
3. `index.html`：删按钮 + bump `?v=`。
4. `verify.sh` 全绿 + `openspec validate` + 审阅闭环。
