# Design: 连续比赛播放（continuous-match-playback）

## Context

P1 之后单事件演绎成形，但画面是"解耦点播"：每事件独立片段、播完即停。用户要"完整播放的比赛画面"。两个缺口：

1. **坐标语义不自洽**：P1 viewer 把抢断演成"球弹到 loose 点、有人捡球"，引擎连续流却认为"防守者在接触点拿到球"（`pos[p] = victim_pos`）。连续播放必 snap。
2. **无连续播放模式**：Game 状态机是单事件片段。

本 change = Phase B（引擎/协议语义补全）+ Phase C（viewer 连续播放）。先 B 后 C：C 依赖 B 的坐标衔接。

## Goals / Non-Goals

**Goals:**
- 引擎 tackle 语义真实化：就近防守、可失败、事件自带"带球起点 + 弹开点"。
- viewer 抢断升级五段式：被铲者带球中被抢。
- viewer 连续播放：整场 kickoff→whistle 连续流转，事件边界不 snap。
- 端到端可验证（无视觉依赖）：连续边界断言。

**Non-Goals:**
- 不做引擎 AI（决策打分/能力值）——票据 05，之后。
- 不做无球跑位/位置维持事件（`off_ball_run`）——Phase C 先 hold，后续单独 change。
- 不做带标签 RNG 流完整化/定点数——票据 06 的完整目标，Phase B/C 用现有种子 RNG 保证同 seed 确定。
- 不做完整 90 分钟比赛规则（越位/界外球/角球）——之后。
- 不做 Tauri 桌面壳（票据 07 已定，但接入桌面是独立工作）。

## Decisions

### D1: 一个 change、两个阶段，先 B 后 C
- Phase B 先做（引擎语义），Phase C 后做（连续播放）。C 的事件边界连续性依赖 B 的 loose/carrier_from。
- **为什么**：一次落盘完整路线，实施时按阶段推进，每阶段可独立验证。

### D2: `loose_x/y` 由引擎算，规则与 viewer `deflectPoint` 对齐
- 引擎确定性地算弹开点：逼近方向垂线 × 距离（归一化），优先场内、越界钳制、零距离退化——与 P1 viewer 的 `deflectPoint` 同规则。
- viewer 优先采用引擎的 `loose_x/y`；缺失时 fallback 现有 `deflectPoint`。
- **为什么**：引擎说了算（语义），viewer 兜底（兼容旧数据）。两端同规则保证一致。

### D3: `carrier_from_x/y` = 被铲者带球起点（上一事件持球者位置）
- 引擎在 `pos[]` 里维护持球者位置，tackle 事件发 `carrier_from` = 持球者上一位置，`x2/y2` = 接触点。
- viewer 在一个片段内演"被铲者从 `carrier_from` 带球到接触点"，防守者同时逼近 → 移动中的持球者被抢。
- **为什么**：真实语义——tackle 针对移动中持球人；引擎数据现成，成本极低；单事件自包含（不依赖事件流上下文）。

### D4: tackle 就近 + 距离阈值 + fail 概率
- `nearest_opponent` 替换 `random_player`；防守者距持球者 > 阈值（~10m）时不产 tackle，落回其他事件类型。
- tackle 结果按概率：success ~70% / fail ~30%。状态更新分两支：
  - success：球权归防守者，防守者到 `loose` 点。
  - fail：球权保留原持球者，持球者留在接触点附近（`pos` 微调或不移）。
- **为什么**：消除"跨半场狂奔逼抢"的荒谬；fail 让"原持球人拿回"的演绎真实出现。

### D5: 连续播放 = Game 新增模式，默认连续；解耦模式保留
- Game 增加 `mode: 'continuous' | 'clip'`（默认 continuous）。continuous：跨事件推进、事件间 hold、播完不自动停（whistle 结束）；clip：现有点播行为（调试保留）。
- `playTime` 整场推进；事件间空档靠现有 `_interpolateAnchors` 的 prevAny 兜底（球/人停在上个事件终态）。
- **为什么**：连续播放是主路径，解耦点播是调试工具，都保留。

### D6: 事件间空档 hold，不做无球跑位
- 连续播放里，事件之间的 12–20s 内球员/球保持上一事件终态（球在持球者脚下）。
- **为什么**：避免过度设计；无球跑位（`off_ball_run` 事件）是后续增强，届时引擎定期发跑位事件即可。

### D7: 确定性用现有种子 RNG（带标签流归票据 06）
- Phase B 引擎随机仍走单一 `SeededRng`，同 seed → 同事件流（现有约束不变）。
- **为什么**：票据 06 的带标签流/定点数是引擎 AI 复杂化时的完整目标，现在引入反而扰动现有确定序列。

## Risks / Trade-offs

- **[连续播放事件密度低（12–20s 一个）观感静止]** → 事件间 hold 保证衔接不断裂；无球跑位作为后续 change 提升"活"度。
- **[Phase B 改变同 seed 事件流]** → 引擎逻辑变化必然改变事件序列；demo 重放随之变化，可接受。
- **[协议扩展向后兼容]** → 新字段可选；viewer 对缺失字段 fallback（`carrier_from` 缺失→被铲者原地带球；`loose` 缺失→`deflectPoint`）。
- **[连续边界断言阈值校准]** → 阈值需大于正常事件内位移、小于 snap 跳变；端到端测试里校准并注释依据。

## Migration Plan

- 协议 v1 增量扩展：tackle 新增可选字段、`to`/`x2/y2` 转必填（protocol.js 校验 + spec 定稿）。旧事件流仍可解析。
- 引擎状态机：tackle 分支重写；`pos[]` 维护逻辑补 `loose`/`carrier_from`。
- viewer：`interpretTackle` 五段式 + Game 连续模式 + app 接连续流。
- mock：tackle 样例补 `carrier_from`/`loose`，加 fail 样例（已有一条）。

## Open Questions

- 事件间是否补低频 `off_ball_run` 事件让比赛"活"起来？——建议 Phase C 之后单独 change，本 change 先 hold。
- 连续播放的进度 UI（整场时间轴 vs 事件列表）？——先用整场时间显示 + 现有控件适配，观感验收后再调。
