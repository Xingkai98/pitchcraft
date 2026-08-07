# Spec: event-stream-protocol

## ADDED Requirements

### Requirement: beat 节拍事件（协议 v2）

事件流 SHALL 支持 `beat` 节拍事件：每个固定时间间隔（1s）产一条，描述该时刻所有在移动球员的并行动作。beat 携带 `movers`（并行跑位数组，增量——只含移动的球员）；持球者带球/控球时携带 `main`（带球轨迹）；松散球时携带 `ball`（loose）。

#### Scenario: 节拍含并行跑位
- **GIVEN** 一个 tick 时刻
- **WHEN** 引擎产出一条 beat 事件
- **THEN** 携带 `movers: [{id, from_x, from_y, to_x, to_y, speed, action}]`，列出正在移动的球员；静止球员不在 movers 中；`to` = tick 步进终点（pos after ≤1s movement at speed）

#### Scenario: 节拍含带球 main
- **GIVEN** 持球者在带球/控球（无高亮事件）
- **WHEN** 引擎产出一条 beat 事件
- **THEN** 携带 `main`（如 `{type:'dribble', subject, x, y, x2, y2, speed, touch_freq}`），球轨迹由 main 驱动；每个持球 tick 都发 main（含零位移控球）；main 每拍推进 ≤ speed×1s（约 5-7m）；`touch_freq` 与主 spec「事件含演绎参数」对 dribble 的要求一致

#### Scenario: carrier 不进 movers（main-only）
- **GIVEN** 持球者在带球/控球
- **WHEN** 引擎产出一条 beat 事件
- **THEN** 持球者不出现在 movers 中（其移动只由 main 表达）；movers 只含无球跑位球员

#### Scenario: 松散球
- **GIVEN** 无持球者（抢断弹开等）
- **WHEN** 引擎产出一条 beat 事件
- **THEN** 携带 `ball: {x, y, x2, y2, speed, loose:true}`（含滚动轨迹，viewer 在拍内插值），球由 beat.ball 驱动

#### Scenario: 向后兼容
- **WHEN** viewer 收到 v1 事件（pass/shot/tackle 等）
- **THEN** 仍能解析演绎（与 beat 共存，高亮事件叠加）；demo_mode 保持 v1 事件驱动

### Requirement: 球位置驱动

球的位置 SHALL 在任意开放比赛时刻由唯一驱动者决定，优先级链：高亮 > main(带球) > beat.ball(松散) > hold(死球)。

#### Scenario: 高亮驱动球
- **GIVEN** 一条 pass 事件跨多个 tick
- **THEN** 球位置由 pass 事件的 x/y→x2/y2 + speed 在飞行时序内插值（高亮驱动），beat 不重复驱动球

#### Scenario: main 驱动球
- **GIVEN** 持球者带球（无高亮）
- **THEN** beat 的 main 携带球轨迹（x/y→x2/y2+speed），球由 main 驱动

#### Scenario: 松散球驱动
- **GIVEN** 无持球者
- **THEN** beat 携带 `ball`（`{x, y, x2, y2, speed, loose:true}`——球滚动轨迹，viewer 在拍内插值），球由 beat.ball 驱动

#### Scenario: kickoff 事件驱动球
- **GIVEN** 开场或进球后 kickoff
- **THEN** kickoff 事件自身携带球轨迹（x/y→x2/y2+speed）驱动球（与高亮同级的事件驱动）；kickoff 起点对齐整数 tick，其后首个 beat 从下一 tick 起；**kickoff 球到达接球者（x2/y2）后 → 接球者持球 → main 在下一 tick 边界恢复（同 D12 pass 交接）**

#### Scenario: shot 结局编码
- **GIVEN** 一条 shot 高亮事件
- **THEN** 携带 `result`：`goal` / `saved` / `off_target`（引擎实际产出三值）；`saved` 的"扑住 vs 扑出反弹"**不由 result 值区分**，由高亮后的交接区分——`save-caught` 后随 main（门将 carrier），`save-rebound` 后随 beat.ball（loose）

### Requirement: 高亮事件锚点对齐

pass/shot/tackle 高亮事件 SHALL 起点对齐整数 tick（量化到 1s 边界），并携带参与者精确起点；覆盖区间为 [t_start, t_end)（t_end = 自然飞行终点，可非整数）；任意时刻至多一条飞行中高亮。

#### Scenario: 高亮起点对齐
- **GIVEN** 一条高亮事件
- **THEN** 其 t 为整数（1s tick 边界），高亮 tick 不产 main

#### Scenario: 高亮覆盖区间
- **GIVEN** 一条高亮事件的起点 t_start 为整数 tick
- **THEN** 覆盖区间为 [t_start, t_end)，t_end = 自然飞行终点（可非整数）；高亮结束后的驱动者按 D12 交接（pass→接球者 main / shot→goal、save-caught、save-rebound、off_target / tackle→success 松散球、fail 被铲者 main）；**main 在首个 tick 边界恢复仅对不进入松散球的结局成立**（pass、save-caught、tackle fail；进入松散球的结局按 D11 由 beat.ball 驱动，待拾取后回 main）

#### Scenario: 至多一条飞行中高亮
- **WHEN** 一条高亮事件在飞行中
- **THEN** 引擎不产新的高亮事件（球优先级链在任意时刻定义明确）

#### Scenario: 参与者起点精确
- **GIVEN** 一条 pass/shot/tackle 高亮事件
- **THEN** 携带参与者精确起点，无 fallback：pass{基础 x/y = 传球者，receiver_x/y = 接球者}；shot{基础 x/y = 射手，keeper_x/y = 门将}；tackle{基础 x/y = 防守者，carrier_from_x/y = 被铲者接触点}——主参与者用基础 x/y，字段不冗余

### Requirement: movers/main/ball 互斥

beat 事件 SHALL NOT 同时携带 main 与 ball（唯一驱动者）；高亮覆盖区间内的 beat SHALL 既不含 main 也不含 ball（球由高亮驱动）；movers 的 id 唯一且在 0-21；坐标在 [0,1]。

#### Scenario: 唯一驱动校验
- **WHEN** 引擎产出一条 beat 事件
- **THEN** 非高亮 beat 不同时含 main 和 ball；movers id 唯一且在 0-21；坐标在 [0,1]

#### Scenario: 高亮期间 beat 无 main 无 ball
- **GIVEN** 一条高亮事件进行中（覆盖 [t_start, t_end)）
- **WHEN** 引擎产出该区间内的 beat 事件
- **THEN** beat 只含 movers，不含 main 也不含 ball（球由高亮事件驱动，不重复驱动）

## MODIFIED Requirements

### Requirement: 事件字段定义

每条事件 SHALL 包含：t（比赛时间秒）、type（事件类型）、subject（主球员 id）、x/y（发生位置归一化坐标）。可选的派生字段（from/to、x2/y2、result、speed、touch_freq、lead、score、detail、note）按事件类型使用。**例外：`beat` 类型不携带顶层 subject/x/y**（主体与位置嵌套在 main/movers/ball 内），协议校验对 beat 跳过基础字段必填。

#### Scenario: 基础字段必填
- **WHEN** 引擎产出一条事件
- **THEN** 事件包含 t、type、subject、x、y 字段

#### Scenario: beat 豁免基础字段
- **GIVEN** 一条 type='beat' 的事件
- **THEN** 其 t/type 必填，但顶层 subject/x/y 不要求（主体与位置在 main/movers/ball 内）——基础字段校验对 beat 跳过

### Requirement: 事件类型枚举

事件流 SHALL 支持事件类型：v1 的 kickoff、whistle、pass、dribble、shot、tackle、interception、substitution、lineup（初始站位）、off_ball_run；**v2 新增 `beat` 节拍类型**。**v2 全场比赛不再产生顶层 `dribble`、`off_ball_run` 与 `interception` 事件**（带球由 beat.main 表达、无球跑位由 beat.movers 表达、拦截标注"后续加入"p5）；lineup 保留（v2 开场初始站位）；demo_mode 保持 v1 事件驱动（含 dribble）以测兼容路径。goal 不设独立类型，由 shot 的 result=goal 表达。

#### Scenario: 枚举覆盖核心动作
- **WHEN** 画面层遇到事件流中的事件
- **THEN** 能按 type 识别为 kickoff/whistle/pass/dribble/shot/tackle/interception/substitution/lineup/off_ball_run/beat 之一

#### Scenario: v2 无顶层 dribble
- **WHEN** 引擎以 v2 模式模拟全场比赛
- **THEN** 非 demo 流不含顶层 type='dribble' 事件（带球由 beat.main 表达）；demo_mode 流仍含

#### Scenario: 进球由射门表达
- **WHEN** 一次射门得分
- **THEN** 事件为 shot 且 result=goal，不产生独立的 goal 事件

### Requirement: tackle 字段定稿（必填 x2/y2 + carrier_from + loose）

tackle 事件 SHALL 携带接触点 `x2/y2`（必填，定稿）与 `carrier_from_x/carrier_from_y`；SHALL 携带 `loose_x/loose_y`（弹开点）。**v2 语义（carry-beat 归零）**：`carrier_from_x/carrier_from_y` = 被铲者在 tackle tick 的位置（接触点，带球逼近已由 beat.main 表达），不再是被铲者带球段起点。**v2 移除 `to` 字段**（被铲者接续位置——v2 中由 beat.main 表达；v1 兼容路径仍接受含 to 的旧事件），**新增 `carrier`（被铲者 id）** 承载被铲者身份（v1 中 `to` 的身份语义迁移到 `carrier`）。

#### Scenario: tackle 必填字段
- **GIVEN** 一条 tackle 事件
- **THEN** 必须含 `x2`、`y2`（接触点）、`carrier_from_x/carrier_from_y`（被铲者接触点位置）、`carrier`（被铲者 id）与 `loose_x/loose_y`（弹开点）；缺失时协议校验抛错

#### Scenario: v2 carrier_from = 接触点
- **WHEN** 引擎以 v2 模式产出一条 tackle 事件
- **THEN** `carrier_from_x/carrier_from_y` == `x2/y2`（接触点，carry-beat 归零）；`loose_x/loose_y` 为确定性弹开点（success/fail 均携带）

#### Scenario: 向后兼容
- **WHEN** 画面层收到 v1 旧版 tackle 事件（carrier_from = 带球段起点）
- **THEN** 仍能解析并演绎（v1 五段式 carry 路径）；v2 事件按零长度 carry 处理
