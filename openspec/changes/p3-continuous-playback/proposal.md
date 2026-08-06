# Proposal: viewer 连续播放（continuous-playback）

## Why

Phase B（引擎 tackle 语义补全，原 p2 的 B 阶段）已完成并归档：事件流坐标语义自洽（success/fail 状态一致、carrier_from/loose 字段齐全），"带球中被抢"在 clip 模式可看。但画面仍是**逐事件点播**：每个事件独立片段、播完即停，`app.js` 也跑在 `demo_mode: true`。用户要的是**打开就能看到一场比赛从 kickoff 到 whistle 连续流转**。

本 change = 原 p2 的 Phase C（viewer 连续播放），独立成 change 以便在 p2 归档后继续推进。

## What Changes

- Game 新增**连续播放模式**：从事件 0 播到 whistle，播完当前事件自动切下一个；`playTime` 整场推进。
- 事件间空档（引擎 12–20s 一个事件）球员/球 **hold**（球停在持球者脚下、球员停在上个事件终态），事件边界不 snap。
- `app.js` 切到引擎连续流（`demo_mode: false`），播放控件适配（播放/暂停、倍速、整场时间、整场重播）。
- **端到端连续边界断言**：逐事件连续播放，断言球/球员在事件边界位移小于阈值（无瞬移）。

## Capabilities

### Modified Capabilities

- `pitch-viewer`: 从解耦点播升级为整场连续播放（事件间 hold、播完自动衔接）。

## Impact

- 改动：`viewer/game.js`（连续模式）、`viewer/app.js`（接连续流 + 控件）、`viewer/config.js`（如需阈值） + 测试。
- 无引擎改动（依赖 Phase B 已归档的坐标语义）。
- 需先处理两个前置事项（见 design.md）：进球事件同刻、静默迭代后 carrier_from 过期。

## 关联票据（wayfinder）

- `03` 时间推进模型 → 本 change 落地"事件驱动连续推进"的画面消费端。
- `06` 确定性与回放 → 连续流 + 固定种子 = 回放数据；带标签 RNG 完整化仍开放。
