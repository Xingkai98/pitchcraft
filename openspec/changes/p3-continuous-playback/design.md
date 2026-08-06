# Design: viewer 连续播放（continuous-playback）

## Context

Phase B（原 p2 的 B 阶段）已归档：引擎 tackle 语义补全（就近防守、可失败、loose/carrier_from 字段、两端状态一致）。事件流坐标语义自洽，"带球中被抢"在 clip 模式可看。但 viewer 仍是**解耦点播**：Game 状态机是单事件片段、`app.js` 跑 `demo_mode: true`。

本 change 让画面整场连续流转：kickoff → whistle 自动衔接，事件间 hold，不 snap。

## Goals / Non-Goals

**Goals:**
- Game 连续播放模式：跨事件推进、事件间 hold、播完自动切下一个。
- app 接引擎连续流（`demo_mode: false`），控件适配整场播放/重播。
- 端到端可验证（无视觉依赖）：连续边界断言（无 snap）。

**Non-Goals:**
- 不做无球跑位/位置维持事件（`off_ball_run`）——后续单独 change。
- 不做带标签 RNG 流完整化/定点数——票据 06。
- 不做完整 90 分钟比赛规则——之后。
- 不做 Tauri 桌面壳——票据 07 已定，接入桌面独立工作。

## Decisions

### D1: 连续播放 = Game 新增模式，默认连续；解耦模式保留
- Game 增加 `mode: 'continuous' | 'clip'`（默认 continuous）。continuous：跨事件推进、事件间 hold、播完不自动停（whistle 结束）；clip：现有点播行为（调试保留）。
- `playTime` 整场推进；事件间空档靠现有 `_interpolateAnchors` 的 prevAny 兜底（球/人停在上个事件终态）。
- **为什么**：连续播放是主路径，解耦点播是调试工具，都保留。

### D2: 事件间空档 hold，不做无球跑位
- 连续播放里，事件之间的 12–20s 内球员/球保持上一事件终态（球在持球者脚下）。
- **为什么**：避免过度设计；无球跑位（`off_ball_run` 事件）是后续增强，届时引擎定期发跑位事件即可。

### D3: 确定性用现有种子 RNG（带标签流归票据 06）
- 引擎随机仍走单一 `SeededRng`，同 seed → 同事件流（现有约束不变）。
- **为什么**：票据 06 的带标签流/定点数是引擎 AI 复杂化时的完整目标。

### D4: 连续模式的重复段处理（对齐 Phase B design D3）
- Phase B 的 `carrier_from` = 被铲者带球起点；clip 模式（当前）每个事件自包含，tackle 自带"带球中被抢"完整演绎（符合用户核心诉求）。
- 连续模式里若 tackle 前正好是同一被铲者的 dribble，viewer **丢弃 carry-beat 起点**、hold 到接触时刻，避免重复前段——在 viewer 侧处理，不改变 `carrier_from` 的"带球起点"语义。

## Risks / Trade-offs

- **[连续播放事件密度低（12–20s 一个）观感静止]** → 事件间 hold 保证衔接不断裂；无球跑位作为后续 change 提升"活"度。
- **[连续边界断言阈值校准]** → 阈值需大于正常事件内位移、小于 snap 跳变；端到端测试里校准并注释依据。

## Migration Plan

- `game.js`：Game 增加 mode，`step()` 改为跨事件推进（不 clamp 到当前事件）。
- `app.js`：`demo_mode: false` 接引擎连续流；控件适配（整场时间、整场重播）。
- 测试：连续模式单测 + 端到端连续边界断言。

## 前置事项（Phase B 终审记录，2026-08-06，本 change 必须先处理）

- **进球事件同刻**：非 demo 路径进球后 shot/whistle/kickoff 共用同一 `t`（demo 用 +2s/+3s 拉开）。连续播放落地时球会在射门飞行中被瞬移回中圈——需给 whistle/kickoff 加时间偏移（对齐 demo）。
- **静默迭代后 carrier_from 过期**：shot 分支"持球者不在进攻半场"时静默迭代（不产事件）不刷新 `carrier_from`，连续模式下会"重放旧带球段再被抢"——按 D4 丢弃 carry-beat 起点可缓解，或引擎在静默分支对称刷新 `carrier_from = pos_p`。

## Open Questions

- 事件间是否补低频 `off_ball_run` 事件让比赛"活"起来？——建议本 change 之后单独 change。
- 连续播放的进度 UI（整场时间轴 vs 事件列表）？——先用整场时间显示 + 现有控件适配，观感验收后再调。
