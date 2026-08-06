# Proposal: 引擎 tackle 语义补全（tackle-engine）

## Why

P1（tackle-drama）之后，单事件演绎已成形（传球/带球/射门/抢断都"演得像动作"），但 **tackle 的引擎语义不自洽**：viewer 把抢断演成"球弹到侧面、有人捡球"，引擎连续流却认为"防守者在接触点拿到球"（`pos[p] = victim_pos`）。一旦连续播放（见 `p3-continuous-playback`），tackle 播完球在弹开点、下一事件却从接触点出发 → 画面 snap。

P1 还遗留：防守者是随机抽的（可能跨半场狂奔）、永远 success（看不到抢断失败）、没有"带球中被抢"的坐标语义。

本 change = 原 p2 的 Phase B：引擎/协议 tackle 语义补全，为连续播放铺路。Phase C（viewer 连续播放）已拆分到 `p3-continuous-playback`。

## What Changes

### 引擎语义补全（tackle 专项 + 协议定稿）

- 引擎 tackle 改用**就近防守**（`nearest_defender` + 距离阈值），不再随机抽人跨半场；且**每个事件点**做距离感知 + 抢断积极性决策（低概率，目标 8-15 次/场），不是固定概率必抢。
- 引擎按概率出 **`result=fail`**（成功 ~50% / 失败 ~50%，用户确认），状态更新分两支（success=防守者到弹开点拿球 / fail=被铲者追到弹开点拿回，防守者停接触点——两端状态一致不 snap）。
- 引擎新增输出：**`loose_x/loose_y`**（抢断后弹开点，确定性规则，viewer 优先采用）+ **`carrier_from_x/carrier_from_y`**（被铲者带球起点，支撑"带球中被抢"演绎）。
- 协议定稿（对齐票据 02）：tackle 的 `to`/`x2/y2` 列为**必填**；新增可选 `loose_x/y`、`carrier_from_x/y`。协议校验 + viewer 解析同步。
- viewer `interpretTackle` 升级**五段式**：带球（被铲者从 `carrier_from` 带球到接触点）→ 逼近（防守者同时接近）→ 碰撞 → 弹开（优先 `loose_x/y`）→ 捡球（`result` 驱动）。

## Capabilities

### Modified Capabilities

- `match-engine`: tackle 就近防守 + fail 概率 + loose/carrier_from 字段产出 + 状态双分支。
- `event-stream-protocol`: tackle 字段定稿（to/x2/y2 必填）+ 新增 loose_x/y、carrier_from_x/y。
- `pitch-viewer`: 抢断五段式（带球中被抢）。

## Impact

- 改动：`engine/src/lib.rs`、`viewer/interpretation.js`、`viewer/protocol.js`、`viewer/mock-event-stream.js` + 测试。
- 协议 v1 增量扩展（tackle 字段），向后兼容（旧事件缺新字段时 viewer fallback）。
- 引擎改动影响同 seed 事件流（确定性改变），可接受（demo 重放）。

## 关联票据（wayfinder）

- `02` 事件流协议 → 本 change 定稿 tackle 字段，可标 resolved。
