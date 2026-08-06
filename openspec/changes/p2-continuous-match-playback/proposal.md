# Proposal: 连续比赛播放（continuous-match-playback）

## Why

P1（tackle-drama）之后，单事件演绎已成形（传球/带球/射门/抢断都"演得像动作"），但浏览器里只能**逐事件点播**（解耦模式：每个事件独立片段、播完即停）。用户要的是——**打开就能看到一场比赛从 kickoff 到 whistle 连续流转**：球员带球被抢、传跑配合、射门……所有动作自然衔接，没有瞬移、没有 snap。

要让"完整播放的比赛画面"成立，缺两块：
1. **事件流坐标语义自洽（Phase B，引擎侧）**：P1 的 viewer 把抢断演成"球弹到侧面、有人捡球"，但引擎连续流认为"防守者在接触点拿到球"。一旦连续播放，tackle 播完球在弹开点、下一事件却从接触点出发 → 画面 snap。P1 还遗留：防守者是随机抽的（可能跨半场狂奔）、永远 success（看不到抢断失败）。
2. **viewer 连续播放模式（Phase C，画面侧）**：Game 现在是"单事件片段"状态机，需要整场连续推进 + 事件间衔接。

本 change 把 Phase B + Phase C 一次规划落地，做完即达成"完整播放的比赛画面"。

## What Changes

### Phase B：引擎语义补全（tackle 专项 + 协议定稿）

- 引擎 tackle 改用**就近防守**（`nearest_opponent` + 距离阈值），不再随机抽人跨半场。
- 引擎按概率出 **`result=fail`**（成功 ~70% / 失败 ~30%），状态更新分两支（success=防守者拿球 / fail=原持球人保持球权）。
- 引擎新增输出：**`loose_x/loose_y`**（抢断后弹开点，确定性规则，viewer 优先采用）+ **`carrier_from_x/carrier_from_y`**（被铲者带球起点，支撑"带球中被抢"演绎）。
- 协议定稿（对齐票据 02）：tackle 的 `to`/`x2/y2` 列为**必填**；新增可选 `loose_x/y`、`carrier_from_x/y`。协议校验 + viewer 解析同步。
- viewer `interpretTackle` 升级**五段式**：带球（被铲者从 `carrier_from` 带球到接触点）→ 逼近（防守者同时接近）→ 碰撞 → 弹开（优先 `loose_x/y`）→ 捡球（`result` 驱动）。

### Phase C：viewer 连续播放

- Game 新增**连续播放模式**：从事件 0 播到 whistle，播完当前事件自动切下一个；`playTime` 整场推进。
- 事件间空档（引擎 12–20s 一个事件）球员/球 **hold**（球停在持球者脚下、球员停在上个事件终态），事件边界不 snap。
- `app.js` 切到引擎连续流（`demo_mode: false`），播放控件适配（播放/暂停、倍速、整场时间、整场重播）。
- **端到端连续边界断言**：逐事件连续播放，断言球/球员在事件边界位移小于阈值（无瞬移）。

## Capabilities

### Modified Capabilities

- `match-engine`: tackle 就近防守 + fail 概率 + loose/carrier_from 字段产出 + 状态双分支。
- `event-stream-protocol`: tackle 字段定稿（to/x2/y2 必填）+ 新增 loose_x/y、carrier_from_x/y。
- `pitch-viewer`: 抢断五段式（带球中被抢）+ 连续播放模式。

## Impact

- 改动：`engine/src/lib.rs`、`viewer/interpretation.js`、`viewer/game.js`、`viewer/app.js`、`viewer/config.js`、`viewer/mock-event-stream.js`、`viewer/protocol.js` + 测试。
- 协议 v1 增量扩展（tackle 字段），向后兼容（旧事件缺新字段时 viewer fallback）。
- 引擎改动影响同 seed 事件流（确定性改变），可接受（demo 重放）。

## 关联票据（wayfinder）

- `02` 事件流协议 → Phase B 定稿 tackle 字段，可标 resolved。
- `03` 时间推进模型 → Phase C 落地"事件驱动连续推进"的画面消费端。
- `06` 确定性与回放 → Phase C 连续流 + 固定种子 = 回放数据；带标签 RNG 完整化仍开放。
