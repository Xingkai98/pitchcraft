# Design: 死球重开正确化——门球 + 进球回中圈（goal-kick-and-restart）

> **归档对齐说明（2026-09-18，issue #81）**：本文是立项时的原始设计稿（正文保留原样，勿据以实现）。
> 核对后主体与现行实现一致（门球不触发 transition、进球后球回中圈），但对两处 spec 作了贴合代码的订正：
> - `specs/match-engine/spec.md`：开大脚速度 "~15-20 m/s" 收敛为 "~16-20 m/s + 高度 h 0.5-0.8"。
> - `specs/pitch-viewer/spec.md`：**原稿球终态坐标与代码相反**——原写 goal 停在 x=1.02、
>   off_target "不越过门线"；代码（`viewer/interpretation.js`）实为 goal 停在网内 x=1.005、
>   off_target 飞过球门 x=1.02、saved 停 `x2`。已按代码改写，否则会把错误规则写进主 spec。
>
> `tasks.md` 的勾选状态不作为完成依据。

## Context

P5 完成后用户视觉验收发现两个死球呈现问题（2026-08-08）：

- off_target 走了"中圈 kickoff"（错误重开类型）；真实应为门球。
- 进球后球从门内滚回中圈（2s 过渡）；用户希望直接跳回中圈。

本 change 修这两处。门球是定位球的一种——P6 票据 10 的首批场景；进球回中圈是死球重开的简化。

## Goals / Non-Goals

**Goals:**
- off_target → 门球：守门员开大脚到中场 → 双方争抢松散球 → 拾取恢复。
- 进球 → 球直接跳回中圈 → 开球。
- goal vs saved/off_target 视觉可区分。

**Non-Goals（移出到 P6 后续）:**
- 犯规/出界判定（角球/界外球/任意球触发的规则层前置）。
- 角球 / 界外球 / 任意球 / 点球重开。
- 谁去把球捡回来放中圈（进球庆祝扩展）。
- 越位。

## Decisions

### D1: off_target → 门球（goal kick，用户确认：门将开大脚 + 中场争抢）

- 射门打偏（off_target）→ 球飞到界外（shot 终点已钳制在 [0,1]，出界表现为到达边线）。
- **球到对方守门员脚下**：瞬移（用户确认可接受）——引擎直接把球位置设到对方门将，不做滚动动画。
- **possession 切换**：off_target 后 possession 切到对方（门将 = 对方门将 id）。
- **门将开大脚**：复用 pass 高亮（起点 = 门将门线，终点 = 中场落点，高速长球 ~15-20 m/s）；**无明确接球者**——落点是争抢点。
- **中场松散球**：落点无人持球 → `beat.ball loose:true` → **双方可争**（复用 P4 `nearest_any`——双方外场都能追球）→ 最近者拾取 → 恢复 main → 开放比赛。
- 门球是否触发 transition：**暂不触发**（P6 设计时再定——开大脚是高球权转换，但首批保持简单，不叠 transition）。

**为什么**：门球 = 守门员发球重新组织，不经过中圈；链路（高亮飞行 → 松散球 → 双方追逐 → 拾取）P4 已建成，成本低。

### D2: 进球 → 球直接跳回中圈

- 进球确认（球越过门线进网）→ **球直接回中圈**（去掉当前 2 秒"从门内滚回中圈"过渡锚点）。
- 死球→kickoff 本就是 spec 允许的瞬移例外（viewer「死球→kickoff 例外」场景）。
- 开球者（被进球方前锋）走向中圈开球（现有流程保留：准备期 → kickoff）。
- **goal vs saved/off_target 视觉区分**：goal 球终点越门线（x=1.02/[-0.02]）进网 + 球在门内停一拍；saved/off_target 球停门线/边线。当前已有越门线，加强为"球进网后明显停留 + 门将无够到"。

**为什么**：用户确认"球直接跳回中圈就行"；区分进球让观众能看出哪些进了。

### D3: 门球的高亮表达（无 to 长球）

- 门将开大脚 = 高亮事件，但**无明确接球者**（to 可选）。
- 实现选择：复用 kickoff 事件形态（自带球轨迹 x/y→x2/y2+speed，无 to 依赖）或 pass 高亮 to 可选。
- **倾向**：新增/复用 kickoff 形态的高亮（球从门线飞到中场），因为 kickoff 已有"事件驱动球 + 无 to"的先例。

**为什么**：门将开大脚没有明确接收者，落点是争抢点；kickoff 形态天然支持"无 to 长球"。

### D4: 松散球双方可争（复用）

- 中场落点松散球：追逐者 = `nearest_any`（双方外场都可追）——与 P4 save-rebound 同模式。
- 拾取后 possession 对账到拾取方（P4 已有 `advance_loose` 拾取分支）。

**为什么**：P4 已建成，零新机制。

## Risks / Trade-offs

- **[门球频率]**: off_target 约 11/19 射门 → 门球次数多。每个门球 = 高亮 + 松散球争抢，画面节奏变化大。缓解：参数调（开大脚落点分布、球速）。
- **[无 to 高亮]**: 复用 kickoff 形态需确认 viewer 演绎无 to 高亮不破坏（interpretEvent kickoff 已支持无 from/to）。
- **[视觉区分]**: goal 越门线 + 停留，saved/off_target 停门线/边线——需 viewer 微调，风险低。

## Migration Plan

- 引擎：`finalize_highlight` ShotOffTarget 分支重写（possession 切对方门将 + 门将开大脚高亮 + 落点松散球）；ShotGoal 分支去回中圈过渡；DeadBall 支持门球类型（门将发球，非中圈 kickoff）。
- viewer：buildTimeline 去进球滚回中圈过渡；kickoff 形态高亮无 to 演绎确认；goal 视觉加强。
- 测试：引擎（门球流程/possession 切换/双方争抢/进球回中圈）+ viewer（门球高亮/进球瞬移/goal 区分）。

## Open Questions

- 门球是否触发 transition（开大脚高球权转换）——首批不触发，P6 设计时定。
- 开大脚落点分布（中场哪里）——实施时调参（近中场/偏某侧）。
- 门将发球后己方阵型是否压上（门球后全队推进）——实施时看队形目标是否自然覆盖。
