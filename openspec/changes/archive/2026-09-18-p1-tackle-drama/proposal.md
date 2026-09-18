# Proposal: 抢断四段式演绎（tackle-drama）

## Why

P0 之后画面基本成型，但 **tackle 的演绎是目前最弱的动作**：现在只是"防守者从自己位置跑到被铲者位置"——球全程不参与（球停在上一个事件留下的位置，往往不在持球者脚下），也没有"碰撞→球被捅开→球权易手"的视觉。用户观察后指出：期望的效果是——**先有一个人持球，另一个人过去把球抢下来（一下碰撞），球往旁边滚，变成另一个人持球**。

## What Changes

- 重写 `viewer/interpretation.js` 的 `interpretTackle` 为**四段式戏剧**：持球 → 逼近 → 碰撞捅开 → 弹开 + 捡球。
- **球权归属由事件已有字段 `result` 驱动**（不新增协议字段）：
  - `result=success` → 防守者追到弹开点拿球（"另一个人持球"）；
  - `result=fail` → 原持球人追到弹开点重新拿回（"原来持球人拿到球了"）。
- 新增 `config.interpretation.tackle` 参数块（弹开距离/弹开球速/捡球停顿），保持"config 只放动画时序"的分工。
- 修正 `viewer/mock-event-stream.js`：tackle 补全 `to/x2/y2`，并加一条 `result=fail` 样例，让两种归属都可看。
- 纯 viewer 变更：**不改引擎、不改协议**（引擎 demo 的 tackle 数据已带 `to/x2/y2`，本 change 直接可用）。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `pitch-viewer`: 抢断/拦截演绎从"单人逼近"升级为"持球→逼近→碰撞捅开→弹开+捡球"四段式，球权归属按 `result` 区分成功（防守者拿球）/失败（原持球人拿回）。

## Impact

- 改动代码：`viewer/interpretation.js`、`viewer/config.js`、`viewer/mock-event-stream.js`、`viewer/interpretation.test.js`（+ 可选 `viewer/game.test.js`）。
- 无协议变更；无引擎变更；无新增依赖。
- 浏览器缓存：修改 JS 后需更新 `viewer/index.html` 与 `app.js` 的 `?v=` 版本号。
