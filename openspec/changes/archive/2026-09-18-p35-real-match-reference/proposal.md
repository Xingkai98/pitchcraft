# Proposal: 真实比赛对照（公开 tracking 数据 → 2D 圆点参照物）

## Why

调参一直被卡在「只能用语言描述感觉不对劲」：引擎的比赛画面像不像足球，只能靠人眼看、
用形容词说（"站位太散""回防太慢"），没有可对着看的参照物，也没有可比的数字。用户原话：

> 现在咱们调来调去，我只能用语言来描述感觉不对劲的地方，还是很局限，比如直接找现实中的
> 比赛能不能转成 2d 这种格式来参考，以及观察行为

关键判断：**公开的真实比赛 tracking 数据本身就是逐帧 22 人 + 球的位置**，与引擎产出的
`beat`（每拍若干球员的 from→to）是同一类东西的两种采样。因此不需要"把真实比赛编译成事件流"
——把 tracking 按时间插值、直接喂给**同一个** `renderFrame`，球场/圆点/配色全部复用，
真实比赛与引擎比赛即可背靠背切换播放。

本 change 做的是**把参照数据接进来、能播**。它不定义"拿什么当标尺"——量化指标对比（阵型
宽度/纵深、全队重心、到球距离分布）是下一个 change，本 change 只负责稳定它所依赖的接口
（帧序列 schema、`TrackingPlayer` 读写面）。

## What Changes

- **数据获取**：`tools/fetch-tracking-data.mjs` 拉公开数据集（Metrica Sports sample-data，
  3 场 25Hz，0-1 归一化坐标、105×68m）。数据落 `.scratch/tracking-data/`，不入库。
- **格式转换**：`tools/convert-tracking-to-frames.mjs` 把 tracking CSV 转成帧序列 JSON
  （`{ meta, frames: [{ t, players[22], ball }] }`），落 `viewer/data/`，不入库。
  处理三类必须处理的错位（详见 design.md）：
  1. **半场方向**：两场比赛的起始攻防方向相反，必须从数据检测（且必须用全量帧判定，
     裁剪窗口里"最贴底线的人"可能是开角球的边后卫）。
  2. **身份映射**：不能按球衣号排序（门将球衣号是 11）；表头有 `Player 26`（带空格）
     这类写法，严格正则会静默丢人。
  3. **数据质量如实暴露**：球缺失、坐标重叠、人数不足——统计进 `meta.coverage` 并展示，
     不挪动位置掩盖。
- **播放**：`viewer/tracking-player.js` 把帧序列插值成每帧 `{ players, ball }`（播放控制、
  seek、缺帧回退），复用 `renderFrame` 渲染；`activeSource` 在两个数据源间切换。
- **viewer 接线**：数据源切换 UI（`#data-source` / `#tracking-select` / `#tracking-meta`）；
  UI 三态从 `activeSource` 单一推导（`syncSourceUI`），异步加载用 `loadSeq` 作废过期请求。
- **验收测试**：转换器单测、`TrackingPlayer` 单测、真实数据 → `renderFrame` 的像素级 e2e、
  数据源切换的 DOM 测试与竞态交错矩阵。全部无视觉依赖。

## Capabilities

### Modified Capabilities

- `pitch-viewer`: 新增「真实比赛对照数据源」——帧序列的读入与插值播放、数据源切换、
  数据质量的如实标注；明确该通路**绕过引擎与演绎层**（参照物定位）。

## Impact

- 新增：`tools/fetch-tracking-data.mjs`、`tools/convert-tracking-to-frames.mjs`（+ 测试）、
  `viewer/tracking-player.js`（+ 测试）、`viewer/tracking-e2e.test.js`、
  `.scratch/notes/real-match-reference.md`（设计说明与踩坑记录）。
- 修改：`viewer/app.js`（数据源切换）、`viewer/app.test.js`、
  `viewer/dom-test-harness.mjs`（`driveFrame` 驱动单帧）、`viewer/index.html`、
  `.gitignore`（排除数据与产物）、`README.md`、`CLAUDE.md`。
- 不碰引擎（`engine/` 零改动）、不碰事件流协议（`event-stream-protocol` 零改动）、
  不碰 `Game`/演绎层（tracking 通路完全绕开）。
- 数据与转换产物不入库：`.scratch/tracking-data/`、`viewer/data/`。
- 已知边界：tracking 模式下不支持观察采集（采集链路读引擎 `game`，会采到"引擎冻结的那一刻"
  而非用户正看的真实比赛）。已加守卫拒绝并提示，未打开该能力。
