# Spec: match-engine

## ADDED Requirements

### Requirement: 固定 tick 时间推进

引擎 SHALL 按固定时间间隔（1s）推进比赛时间，每个 tick 更新全部 22 名球员的位置/动作状态，并产出一条 beat 节拍事件。

#### Scenario: 固定 tick 产节拍
- **WHEN** 引擎模拟一场比赛
- **THEN** 每 1s 产一条 beat 事件，覆盖整场（约 2700 条）；beat 事件 t 严格单调递增（高亮事件单独严格递增；合并流非严格单调——同一整数 t 允许 beat + 高亮并存）

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
- **THEN** hold 内每 tick 发 main（carrier 带球）+ movers；hold 归零时在整数 tick 掷高亮类型（pass/shot/tackle，含 tackle 距离/积极性检查）；非每 tick 掷高亮

#### Scenario: 高亮门控 fallback
- **GIVEN** hold 归零且掷出 tackle 但距离/积极性检查失败（最近防守者距离 > ~10m 或积极性不中）
- **THEN** 仍产出一条高亮，改掷 pass/shot（无 'dribble' 落点——v2 带球由 main 表达）；tackle 频率目标保持 8-15/场，由检查阈值维持

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
- **THEN** beat 携带 `ball`（`{x, y, x2, y2, speed, loose:true}`——球滚动轨迹，viewer 在拍内插值），球由 beat.ball 驱动

#### Scenario: kickoff 事件驱动球
- **GIVEN** 开场或进球后 kickoff
- **THEN** kickoff 事件携带球轨迹（x/y→x2/y2+speed）由事件驱动（与高亮同级）；kickoff 起点对齐整数 tick，其后首个 beat 从下一 tick 起

### Requirement: 松散球生命周期

松散球 SHALL 由高亮结束产生（tackle 成功弹开、shot 扑出反弹）；高亮结束（t_end）后的下一个整数 tick 边界起由 beat.ball 驱动；引擎按确定性规则选追逐者、在拾取半径内拾取、回到 main 驱动。**松散球起点**：tackle 弹开 = loose_x/y（首个 beat.ball 的 x/y = loose_x/y）；save-rebound = shot.x2/y2（弹开方向决定首个 beat.ball 滚动方向）。

#### Scenario: 追逐者选择
- **GIVEN** 一个松散球（beat.ball loose:true）
- **THEN** 按松散球来源选追逐者：**tackle 成功弹开（transition 相关）**→ 追逐者 = 抢断方离球最近的球员（按 pos[] 欧氏距离，确定性平局按 id 小者），每 tick 以速度上限向球移动（纳入 movers，action='chase'），原持球方不参与拾取竞争但按 p5 close_down 收缩（不进入拾取半径）；**save-rebound（非 transition）**→ 追逐者 = 距球最近的球员（不限队，双方可争）

#### Scenario: 拾取与回 main
- **GIVEN** 追逐者进入拾取半径（~0.5m）
- **THEN** 该球员成为 carrier；下一 tick 边界 main 恢复（last-emitted-pos = 拾取点，pos[] 连续性保证无 snap）

#### Scenario: 松散球上限
- **WHEN** 松散球持续超过 `LOOSE_MAX_TICKS = 2`
- **THEN** 若追逐者仍未进入拾取半径，球在当前位置 hold 等待拾取（**不瞬移**；球弹开时速度阻尼递减，追逐者必达）

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
- **THEN** t_start 为整数 tick；t_end = 自然飞行终点（可非整数）；t_end 到下一整数 tick 边界之间 viewer 在各自高亮结束位置 hold（球与参与者）；高亮结束后的驱动者按球权结局交接（D12）：pass→接球者持球、shot→goal/save-caught/save-rebound/off_target、tackle→成功弹开/失败保持；**main 在首个 tick 边界恢复仅对不进入松散球的结局成立**（pass、save-caught、tackle fail；save-rebound / tackle success 进入松散球，按 D11 由 beat.ball 驱动，待拾取后回 main）

#### Scenario: 高亮参与者起点硬约束
- **GIVEN** 一条高亮事件的参与者起点字段（主参与者 = 基础 x/y；第二参与者 = receiver_x/y / keeper_x/y；tackle 被铲者 = carrier_from_x/y）
- **THEN** 各起点 == 该 tick 开始时的 pos[]（前一 beat 的 to / main.to / last-emitted-pos），引擎保证等式成立（不依赖 viewer 阈值兜底）

#### Scenario: 高亮参与者结束位置派生
- **GIVEN** 一条高亮事件结束（t_end）
- **THEN** 参与者"高亮结束位置"由事件字段派生：pass 接球者 = pass.x2/y2、**传球者 = 其起点（基础 x/y，高亮期间静止）**；shot 门将 = shot.x2/y2、**射手 = 其起点（基础 x/y）**；tackle 双方 = **接触点（被铲者 carrier_from / 防守者 x2/y2）**，球弹开 = loose_x/y——viewer 与引擎同一派生，无额外 payload

#### Scenario: shot 高亮结局
- **GIVEN** 一条 shot 高亮事件在 t_end 结束
- **THEN** 按结局交接：result=goal → 死球（hold，P3 机制 kickoff 重开）；门将扑住（save-caught）→ 门将持球，main 在首个 tick 边界恢复（last-emitted-pos = 扑救点；门将出球在 p5 transition 窗口结束、高亮门控恢复后按正常门控经 pass 高亮）；扑出反弹（save-rebound）→ 进入松散球（D11，起点 = shot.x2/y2 **无位置跳变**，弹开方向决定首个 beat.ball 滚动方向，**双方可争**）；**打偏/出界（off_target）→ 死球（球出界），按 P3 机制 kickoff 重开（对方开球；球轨迹终点坐标钳制在 [0,1]，出界表现为到达边线）**

#### Scenario: tackle 高亮结局
- **GIVEN** 一条 tackle 高亮事件在 t_end 结束
- **THEN** 按结局交接：result=success → 弹开进入松散球（D11，球由 beat.ball 驱动，追逐者 = 抢断方）；result=fail → 被铲者保持，main 在首个 tick 边界恢复（last-emitted-pos = 接触点），**不进入松散球**（loose_x/y 仅作续带方向参考，不触发 beat.ball 松散阶段）

#### Scenario: 至多一条飞行中高亮
- **WHEN** 一条高亮事件在飞行中
- **THEN** 引擎不再掷新的高亮事件（保证球优先级链"高亮>main>ball"在任意时刻定义明确）

#### Scenario: 高亮参与者回归 movers
- **GIVEN** 一名高亮参与者退出高亮（高亮结束）
- **THEN** 其 last-emitted-pos 置为注册表的"高亮结束位置"，回归 movers 时 from = 高亮结束位置（viewer 从该位置继续，不回弹）

#### Scenario: 高亮携带参与者起点
- **GIVEN** 一条 pass/shot/tackle 高亮事件
- **THEN** 携带参与者精确起点，无 fallback：pass{基础 x/y = 传球者起点，receiver_x/y = 接球者起点}；shot{基础 x/y = 射手起点，keeper_x/y = 门将起点}；tackle{基础 x/y = 防守者起点，carrier_from_x/y = 被铲者接触点（== x2/y2，carry-beat 归零），carrier = 被铲者 id}——主参与者用基础 x/y，字段不冗余

### Requirement: 确定性

引擎 SHALL 保持种子确定性：同 seed 同 config → 同事件流（含 beat 节拍与高亮事件）。

#### Scenario: 节拍确定性
- **WHEN** 同 seed 两次模拟
- **THEN** beat 节拍序列（movers/main/ball）与高亮事件完全一致

## MODIFIED Requirements

### Requirement: 产出最小比赛事件流

引擎 SHALL 能产出一场最小比赛的事件流。**v2 全场比赛**：以 lineup（初始站位）+ kickoff 开始、whistle 结束，中间为固定 tick 的 beat 节拍流（含 main 带球 + movers 跑位）与叠加其上的高亮事件（pass/shot/tackle）；**不再产出顶层 dribble 与 off_ball_run 事件**（带球由 beat.main 表达、无球跑位由 beat.movers 表达）。demo_mode 保持 v1 事件驱动（含 dribble）。

#### Scenario: 最小比赛（v2）
- **WHEN** 引擎以 v2 模式被要求模拟一场最小比赛
- **THEN** 输出事件流以 lineup + kickoff 开始，以 whistle 结束，中间包含 beat 节拍与 pass/shot/tackle 高亮事件，不含顶层 dribble 与 off_ball_run 事件

#### Scenario: demo_mode v1 兼容
- **WHEN** 引擎以 demo_mode 模拟
- **THEN** 仍产出 v1 事件流（含 dribble），供兼容路径测试

### Requirement: 抢断触发决策（距离感知 + 抢断积极性）

引擎 SHALL 不固定概率必抢，而是由防守者基于情境自行判断是否抢断：存在距持球者 ≤ 阈值的对方球员时，以低概率（抢断积极性）决定是否真的去抢；超阈值或无积极性则不产 tackle。**v2 整合到高亮门控**：hold 归零必掷一条高亮；掷出 tackle 但距离/积极性检查失败 → 改掷 pass/shot（v2 无 'dribble' 落点，带球由 main 表达）。参数为引擎内常量 + `should_tackle()` 决策函数。**v2 标定**：距离阈值 12m、积极性 0.15（v2 高亮模型贴防率低于 v1 逐事件模型，需更宽阈值/更高积极性维持 8-15 次/场目标；v1 的 ~10m/~0.09 为逐事件模型标定）。

#### Scenario: 就近防守
- **GIVEN** 一个事件点
- **THEN** 引擎找离持球者最近的对方球员（用实时 pos[]）；最近距离超过阈值（v2 标定 12m）时不产 tackle

#### Scenario: 超阈值落回进攻（v2）
- **GIVEN** 最近防守者距离超过阈值
- **THEN** 不产 tackle；在 hold 门控归零时改掷 pass/shot（无 'dribble' 落点——v2 中 tackle 检查只在门控归零时刻发生；改掷 85% pass / 15% shot，shot 有半场 guard）

#### Scenario: 抢断积极性
- **GIVEN** 最近防守者距离 ≤ 阈值（hold 门控归零时刻）
- **THEN** 以低概率（抢断积极性，v2 标定 0.15，目标每场 8-15 次）决定是否真的去抢；概率不中 → 改掷 pass/shot（无 'dribble' 落点，与高亮门控 fallback 一致）

#### Scenario: 抢断频率目标
- **WHEN** 一整场比赛（2700s）模拟
- **THEN** tackle 事件总数落在约 8-15 次（用户确认目标）

#### Scenario: 抢断可失败
- **WHEN** 引擎产出一条 tackle 事件
- **THEN** `result` 为 `success`（约 50%）或 `fail`（约 50%）

#### Scenario: 抢断成功状态更新
- **GIVEN** tackle `result=success`
- **THEN** 球权归防守者，弹开进入松散球（D11：beat.ball 驱动 → 追逐 → 拾取 → main），不 snap

#### Scenario: 抢断失败状态更新
- **GIVEN** tackle `result=fail`
- **THEN** 球权保留原持球者，被铲者保持，main 在首个 tick 边界恢复（last-emitted-pos = 接触点），不 snap

### Requirement: 抢断事件携带完整坐标语义

tackle 事件 SHALL 携带：防守者起点 `x/y`、被铲者接触点 `carrier_from_x/carrier_from_y`、接触点 `x2/y2`、弹开点 `loose_x/loose_y`、**被铲者 id `carrier`**。**v2 语义（carry-beat 归零）**：`carrier_from_x/carrier_from_y` 等于被铲者在 tackle tick 的位置（接触点），带球逼近已由 beat.main 表达；不再等于被铲者带球段起点。

#### Scenario: 带球起点（v2 归零）
- **WHEN** 引擎产出一条 tackle 事件
- **THEN** `carrier_from_x/carrier_from_y` == `x2/y2`（接触点，carry-beat 归零）

#### Scenario: 弹开点（v2 语义）
- **WHEN** 引擎产出一条 tackle 事件
- **THEN** `loose_x/loose_y` 为确定性弹开点：逼近方向垂线 × 弹开距离，优先场内、越界钳制、零距离退化——与画面层 `deflectPoint` 同规则；**success 时触发松散球阶段（D11），fail 时仅作被铲者续带方向参考（不进入松散球，main 从接触点恢复）**

#### Scenario: 确定性
- **WHEN** 同 seed 同 config 两次模拟
- **THEN** tackle 事件的选择、结果、弹开点全部一致
