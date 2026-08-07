# Spec: match-engine

## ADDED Requirements

### Requirement: 固定 tick 时间推进

引擎 SHALL 按固定时间间隔（1s）推进比赛时间，每个 tick 更新全部 22 名球员的位置/动作状态，并产出一条 beat 节拍事件。

#### Scenario: 固定 tick 产节拍
- **WHEN** 引擎模拟一场比赛
- **THEN** 每 1s 产一条 beat 事件，覆盖整场（约 2700 条），事件 t 严格单调递增

#### Scenario: 关键时刻仍产高亮事件
- **WHEN** 传球/射门/抢断发生
- **THEN** 引擎仍产出 v1 高亮事件（pass/shot/tackle），叠加在 beat 节拍流上，按自己的时序呈现

### Requirement: 全员状态逐 tick 更新

引擎 SHALL 维护 22 名球员的实时位置 `pos[22]`，每 tick 为每个球员决策目标位置，更新 pos[] 并反映在 beat 的 movers 中。本轮目标决策用现有角色锚点 + 小幅调整（队形公式在 p5）。

#### Scenario: 持球者带球
- **GIVEN** 持球者在带球
- **THEN** beat 的 main 描述带球（球轨迹由 main 驱动），**main 含持球者当前位置更新**（持球者不进 movers，见"carrier 不进 movers"场景）

#### Scenario: 队友跑位
- **GIVEN** 一名无球球员需要调整位置
- **THEN** beat 的 movers 含该球员向目标位置的移动（本轮为角色锚点 + 小幅调整）；位移阈值 = 静区（dead-zone），等值 ~0.5m——移动超过阈值才动、才发 movers，低于阈值不动不发（"移动 ⇔ 发 movers"，last-emitted-pos 恒等于 pos[]）

#### Scenario: last-emitted-pos 跨缺席连续
- **GIVEN** 一名球员在 movers 中缺席若干 tick 后重新出现
- **THEN** 其 from = 上次出现在 movers 的 to（last-emitted-pos），跨缺席精确衔接（无跳变）

#### Scenario: 高亮触发节拍门控
- **GIVEN** 持球 hold（8-15 tick）
- **THEN** hold 内每 tick 发 main（carrier 带球）+ movers；hold 归零时在整数 tick 掷高亮类型（pass/shot/tackle）；非每 tick 掷高亮

#### Scenario: carrier 不进 movers
- **GIVEN** 持球者在带球/控球
- **THEN** 持球者不出现在 movers（其移动只由 main 表达）

### Requirement: 球所有权唯一驱动者

引擎 SHALL 保证每个开放比赛时刻球有且只有一个驱动者：节拍 stretch 由 main 带球驱动，高亮期间由高亮事件驱动，松散球由 beat 携带 ball 坐标。

#### Scenario: 节拍带球驱动
- **GIVEN** 持球者带球（无高亮事件）
- **THEN** beat 的 main 携带球轨迹（x/y→x2/y2+speed），球由 main 驱动；每个持球 tick 都发 main（含零位移控球）；main 每拍推进 ≤ speed×1s（约 5-7m），持球者多数 tick 为零位移控球或短带球

#### Scenario: 高亮驱动球
- **GIVEN** 一条 pass 高亮事件进行中
- **THEN** 球位置由 pass 事件的 x/y→x2/y2 + speed 在飞行时序内插值，beat 不重复驱动球

#### Scenario: 松散球
- **GIVEN** 无持球者（抢断弹开等）
- **THEN** beat 携带 ball 坐标（loose:true），球由 beat.ball 驱动

### Requirement: 高亮参与者排除

引擎 SHALL 在高亮事件（pass/shot/tackle）时序内，将该高亮的参与者从 beat movers 排除；高亮事件起点对齐整数 tick；高亮事件携带参与者精确起点；引擎维护飞行中高亮注册表并对账 pos[] 到高亮结束位置；任意时刻至多一条飞行中高亮；参与者退出高亮后以高亮结束位置回归 movers。

#### Scenario: 排除高亮参与者
- **GIVEN** 一条 pass 高亮事件进行中
- **THEN** 传球者/接球者在该高亮时序内不在 beat movers（唯一规范，无"或与高亮精确一致"逃生门）；引擎 pos[] 对账到高亮结束位置

#### Scenario: 高亮起点对齐整数 tick
- **GIVEN** 一条高亮事件
- **THEN** 其 t 量化到 1s tick 边界，高亮从该 tick 起是唯一驱动者（该 tick 不产 main）

#### Scenario: 高亮覆盖区间与 main 恢复
- **GIVEN** 一条高亮事件的覆盖区间为 [t_start, t_end)
- **THEN** t_start 为整数 tick；t_end = 自然飞行终点（可非整数）；main 从接球者持球后的首个 tick 边界恢复（非 t_end 立即恢复）

#### Scenario: 至多一条飞行中高亮
- **WHEN** 一条高亮事件在飞行中
- **THEN** 引擎不再掷新的高亮事件（保证球优先级链"高亮>main>ball"在任意时刻定义明确）

#### Scenario: 高亮参与者回归 movers
- **GIVEN** 一名高亮参与者退出高亮（高亮结束）
- **THEN** 其 last-emitted-pos 置为注册表的"高亮结束位置"，回归 movers 时 from = 高亮结束位置（viewer 从该位置继续，不回弹）

#### Scenario: 高亮携带参与者起点
- **GIVEN** 一条 pass/shot/tackle 高亮事件
- **THEN** 携带参与者精确起点（pass: passer_x/y+receiver_x/y；shot: shooter_x/y+keeper_x/y；tackle: carrier_from+tackler_x/y），无 fallback；tackle 的 carrier_from = 被铲者在 tackle tick 的位置（接触点，carry-beat 归零——v2 中带球逼近已由 main 表达）

### Requirement: 确定性

引擎 SHALL 保持种子确定性：同 seed 同 config → 同事件流（含 beat 节拍与高亮事件）。

#### Scenario: 节拍确定性
- **WHEN** 同 seed 两次模拟
- **THEN** beat 节拍序列（movers/main/ball）与高亮事件完全一致
