# Spec: match-engine

## ADDED Requirements

### Requirement: 射门打偏走门球（goal kick）

引擎 SHALL 在射门打偏（off_target）后走门球重开：球到对方守门员脚下（瞬移），对方门将开大脚到中场，落点进入松散球（双方可争），拾取后恢复开放比赛。

#### Scenario: 打偏后球到对方门将
- **GIVEN** 一次射门 result=off_target
- **THEN** 球位置 = 对方门将位置（瞬移，不做滚动动画）；possession 切到对方（门将 = 对方门将 id）

#### Scenario: 门将开大脚到中场
- **GIVEN** 门球阶段开始
- **THEN** 对方门将从门线开大脚：高亮事件（起点 = 门线，终点 = 中场落点，高速长球 ~15-20 m/s），无明确接球者（落点是争抢点）

#### Scenario: 中场松散球双方可争
- **GIVEN** 门将开大脚球到达中场落点
- **THEN** 落点无人持球 → 松散球（`beat.ball loose:true`）→ 双方外场都可争（`nearest_any`）→ 最近者拾取 → 恢复 main → 开放比赛

#### Scenario: 门球不触发 transition
- **WHEN** 门球发生（球权易主）
- **THEN** 不触发 transition 窗口（首批保持简单；开大脚的高球权转换后续再定）

### Requirement: 进球后球直接回中圈

引擎 SHALL 在进球确认后让球直接回中圈（不做"从门内滚回中圈"过渡），随后按现有死球流程开球。

#### Scenario: 进球球直接回中圈
- **GIVEN** 一次射门 result=goal（球越过门线进网）
- **THEN** 进球确认后球位置直接设为中圈（死球→kickoff 瞬移例外）；开球者（被进球方前锋）走向中圈开球（现有流程保留）
