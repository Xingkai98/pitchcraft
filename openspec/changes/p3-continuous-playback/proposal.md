# Proposal: 连续比赛播放（continuous-playback）

## Why

Phase B（引擎 tackle 语义补全，原 p2 的 B 阶段）已完成并归档：事件流坐标语义自洽（success/fail 状态一致、carrier_from/loose 字段齐全），"带球中被抢"在 clip 模式可看。但画面仍是**逐事件点播**：每个事件独立片段、播完即停，`app.js` 也跑在 `demo_mode: true`。用户要的是**打开就能看到一场比赛从 kickoff 到 whistle 连续流转**。

用户澄清（grill Q2/Q11b）：**"连续"的本质 = 引擎不断产生事件，画面逐个模拟，引擎产生得比画面快**；**事件时间应由动作时长自动推算**（距离÷速度），事件流 = 动作一个接一个，无固定间隔。

本 change = 原 p2 的 Phase C：引擎事件驱动时间推进 + viewer 整场连续播放。

## What Changes

- **引擎事件驱动时间推进**：`t += 12-20s 随机` → `t += 当前动作实际时长`（距离÷速度），动作间加小"决策停顿"。事件流 = 动作一个接一个，无固定间隔概念。
- 新增 **`off_ball_run`（无球跑位）事件**：短距离碎步移动（1-2m），有球事件间穿插，画面持续有动作。
- **前置事项**：进球后 whistle +2s/kickoff +5s 时间偏移；静默迭代后 carrier_from 对称刷新。
- **Game 连续播放模式**：跨事件推进、播完自动切下一个；事件间由 off_ball_run 锚点填满（不 hold）；clip 模式保留（调试）。
- `app.js` 切到引擎连续流（`demo_mode: false`），控件适配（播放/暂停、倍速、整场时间、整场重播、**进度条/时间轴**）。
- **端到端连续边界断言**：逐事件连续播放，断言球/球员在事件边界位移小于阈值（无瞬移）+ 事件驱动时间一致性（引擎 t 间隔 ≈ viewer 演绎时长）。

## Capabilities

### Modified Capabilities

- `match-engine`: 事件驱动时间推进 + off_ball_run 事件 + 进球时间偏移 + carrier_from 对称刷新。
- `event-stream-protocol`: 新增 off_ball_run 事件类型。
- `pitch-viewer`: 从解耦点播升级为整场连续播放 + off_ball_run 演绎 + 进度条。

## Impact

- 改动：`engine/src/lib.rs`（时间循环 + off_ball_run）、`viewer/game.js`（连续模式）、`viewer/app.js`（接连续流 + 控件 + 进度条）、`viewer/interpretation.js`（off_ball_run + carry-beat 丢弃）、`viewer/protocol.js`（事件类型） + 测试。
- 引擎时间模型改变影响事件流结构（t 不再固定间隔），同 seed 事件流变化，可接受（demo 重放）。

## 关联票据（wayfinder）

- `03` 时间推进模型 → 本 change 落地"事件驱动连续推进"（引擎 + 画面两端）。
- `06` 确定性与回放 → 连续流 + 固定种子 = 回放数据；带标签 RNG 完整化仍开放。
