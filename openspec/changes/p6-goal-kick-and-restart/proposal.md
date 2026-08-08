# Proposal: 死球重开正确化——门球 + 进球回中圈（goal-kick-and-restart）

## Why

用户视觉验收（2026-08-08）反馈两个明显的死球呈现问题：

1. **射门打偏（off_target）重开类型错误**：当前 off_target 走"丢球方中圈 kickoff"——球从出界点滚回中圈、丢球方前锋开球。真实足球打偏应该是**门球（goal kick）**：守门员在门线发球，根本不经过中圈。
2. **进球后球回中圈过渡生硬**：当前进球后球从门内滚回中圈（2 秒过渡），用户希望**球直接跳回中圈**然后开球（死球→kickoff 本就是 spec 允许的瞬移例外）。

本 change = P6 首批，只做这两个死球重开场景。**不做**：犯规/出界判定、角球/界外球/任意球/点球（P6 后续）、越位。

## What Changes

- **off_target → 门球（goal kick）**：
  - 射门打偏 → 球出界 → 球到对方守门员脚下（瞬移可接受，不做滚动动画）。
  - 守门员**开大脚**：球从门线飞到中场落点（高亮事件，起点=门线、终点=中场，高速长球）。
  - 中场落点**无人持球** → 松散球（`beat.ball loose:true`）。
  - **双方可争**：复用 P4 松散球"双方可争"模式（`nearest_any`——双方外场都能追球），最近者拾取 → 恢复 main → 开放比赛。
- **进球 → 球直接跳回中圈**：
  - 进球确认（球越过门线进网）→ 球直接回中圈（去掉 2 秒滚回过渡锚点）。
  - 开球者（被进球方前锋）走向中圈开球（现有流程保留）。

## Capabilities

### New Capabilities

无（复用既有高亮/松散球/死球机制，修正重开类型与过渡）。

### Modified Capabilities

- `match-engine`：off_target 结局从"中圈 kickoff"改为"门球"（possession 切对方门将 + 门将开大脚 → 松散球）；进球后球直接回中圈（死球阶段调整）。
- `event-stream-protocol`：无协议结构变化（复用 kickoff/pass 高亮 + beat.ball loose）。
- `pitch-viewer`：门将开大脚演绎（高亮）+ 进球球瞬移回中圈（去滚回过渡）+ goal vs off_target 视觉区分加强。

## Impact

- 引擎：`finalize_highlight` 的 ShotOffTarget 分支重写 + DeadBall 状态机支持"门球"类型；ShotGoal 分支去掉回中圈过渡。
- viewer：buildTimeline 去掉进球滚回中圈过渡锚点；可能加强 goal 视觉（球越过门线更明显）。
- 测试：引擎（门球流程/possession/争抢/进球回中圈）+ viewer（门球演绎/进球瞬移）。

## 关联票据（wayfinder）

- `10` 定位球 + 犯规规则层 → P6 首批落地门球场景（票据已含本 change 的两个具体场景）。
