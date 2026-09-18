# Spec: event-stream-protocol

## ADDED Requirements

### Requirement: 门将开大脚高亮（无 to 长球）

门将开大脚（门球）SHALL 以高亮事件表达：球从门将当前位置（门线附近）飞到中场落点，携带球轨迹（x/y→x2/y2+speed）；无明确接球者（落点是争抢点），`to` 可不携带。

#### Scenario: 开大脚无 to
- **GIVEN** 一条门将开大脚高亮事件
- **THEN** 携带球轨迹（x/y→x2/y2+speed）；`to` 不要求（复用 kickoff 形态的事件驱动球，或 pass 高亮 to 可选）

#### Scenario: 球到达落点进入松散球
- **GIVEN** 门将开大脚球到达落点
- **THEN** 后续 beat 携带 `ball`（`loose:true`）——落点无人持球，双方可争（同 P4 save-rebound 模式）
