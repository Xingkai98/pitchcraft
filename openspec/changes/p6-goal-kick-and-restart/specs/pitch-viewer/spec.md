# Spec: pitch-viewer

## ADDED Requirements

### Requirement: 门将开大脚演绎

画面层 SHALL 演绎门将开大脚：球从门线飞到中场（高亮事件插值），落点进入松散球后按 `beat.ball` 滚动 + 双方球员追逐（复用 P4 松散球演绎）。

#### Scenario: 开大脚球飞行
- **GIVEN** 一条门将开大脚高亮事件
- **WHEN** 画面层播放该段
- **THEN** 球从门线沿事件轨迹飞向中场（高亮演绎）；无接球者动画（球落点为争抢点）

#### Scenario: 中场争抢
- **GIVEN** 门将开大脚球到达落点（松散球 loose:true）
- **WHEN** 画面层播放该段
- **THEN** 双方球员追逐球（`nearest_any` 双方可争），最近者拾取后恢复 main 带球

### Requirement: 进球视觉区分 + 球直接回中圈

画面层 SHALL 区分 goal vs saved/off_target：goal 球越过门线进网 + 明显停留；saved/off_target 球停门线/边线。进球确认后球 SHALL 直接出现在中圈（不做"从门内滚回中圈"过渡）。

#### Scenario: goal 越门线进网
- **GIVEN** 一条 shot result=goal
- **WHEN** 画面层播放该段
- **THEN** 球越过门线进网（x=1.02/[-0.02]）并明显停留；门将扑向射门侧但未够到

#### Scenario: saved/off_target 停门线/边线
- **GIVEN** 一条 shot result=saved 或 off_target
- **WHEN** 画面层播放该段
- **THEN** 球停在门线（saved）或边线（off_target），不越过门线

#### Scenario: 进球球直接回中圈
- **GIVEN** 一次进球确认
- **WHEN** 画面层播放该段
- **THEN** 球从门内直接跳到中圈（瞬移，无"从门内滚回中圈"过渡锚点）；开球者走向中圈开球
