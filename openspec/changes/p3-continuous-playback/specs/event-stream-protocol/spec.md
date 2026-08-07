# Spec: event-stream-protocol

## MODIFIED Requirements

### Requirement: 事件类型枚举

事件流 SHALL 支持第二版 9 类事件：kickoff、whistle、pass、dribble、shot、tackle、interception、substitution、**off_ball_run**（无球跑位）。goal 不设独立类型，由 shot 的 result=goal 表达。

#### Scenario: off_ball_run 事件
- **WHEN** 引擎产出一条无球跑位事件
- **THEN** 事件为 `off_ball_run`，携带 `subject`（跑位球员）、`x/y`（起点）、`x2/y2`（终点）、`speed`（跑速 m/s）

#### Scenario: 事件时间由动作时长决定
- **WHEN** 引擎产出一条事件
- **THEN** 该事件与下一事件的 t 间隔 = 当前动作的实际时长（距离÷速度）+ 决策停顿，非固定间隔

#### Scenario: shot 携带门将位置
- **WHEN** 引擎产出一条 shot 事件
- **THEN** 携带 `keeper_x/keeper_y`（对侧门将当前实际位置，画面让门将从实位扑救，避免瞬移）；缺失时画面 fallback 门线中点

#### Scenario: 进球后开球序列
- **WHEN** 一次射门进球
- **THEN** 事件流为 shot → 庆祝无球跑位 → whistle → 准备无球跑位 → 开球者走回中圈 → kickoff（拨给同队接球者）；终场前进球（剩余 <~6s）跳过 kickoff 保持 t 单调
