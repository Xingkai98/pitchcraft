# Spec: match-engine

## ADDED Requirements

### Requirement: 确定性单步运动积分

引擎 SHALL 为每名未罚下球员维护连续运动状态（`pos_m`、`vel_mps`、`heading`、`mode`），并按固定 `SIM_DT=0.1s` 积分。一个仿真子步的执行顺序 SHALL 固定为：期望速度 → 目标在身后的制动/不转向判定 → 朝向更新 → 速度指令 → **运动预算** → 位置更新 → 分离求解 → **总预算**。目标与 `mode` SHALL 只在 `DECISION_DT` 边界更新，子步内保持不变。`mode` 的速度上限 SHALL 只约束期望速度 `v_des`，SHALL NOT 直接 clamp 瞬时速度；减速 SHALL 受 `a_brake` 限制。目标在身后且 speed > `V_REVERSE` 时 SHALL 只制动、SHALL NOT 转向，待 speed ≤ `V_REVERSE` 后才转身；SHALL NOT 瞬时反向。约束不可行时求解器 SHALL 置 `constraint_infeasible` 并使守卫红，SHALL NOT 静默推端点、clamp 速度或在下一子步补回来。

#### Scenario: 起步（0 → 6 m/s）

- **GIVEN** 一名球员静止，目标在其前方 30m，`mode` 允许 6 m/s
- **WHEN** 连续仿真 2s（20 个 `SIM_DT`）
- **THEN** 速度从 0 单调增加且不超过 `V_MAX`；每个子步的 `|Δv_total| ≤ A_MAX·SIM_DT`；位置连续变化

#### Scenario: 近目标制动

- **GIVEN** 一名球员以 6 m/s 接近目标，剩余距离进入制动区
- **WHEN** 连续仿真到目标
- **THEN** `v_des` 按 `sqrt(2·a_brake·(d−ARRIVE_RADIUS_M))` 下降；速度下降而非瞬停；到达半径内 `v_des=0`，残余速度 ≤ `RESIDUAL_SPEED_MAX`

#### Scenario: 突然反向

- **GIVEN** 一名球员以 6 m/s 向 +x 移动，目标突然出现在 -x
- **WHEN** 下一个仿真子步
- **THEN** 若 `|θ_err| > π/2` 且 `v > V_REVERSE`，本子步 SHALL 只制动（`v_des=0`、`turn_allowed=false`），SHALL NOT 转向或瞬时反向；待 `v ≤ V_REVERSE` 后才按 `ω_max·dt` 转向

#### Scenario: 速度上限下调

- **GIVEN** 一名球员以 6 m/s 移动，`mode` 的 `v_cap` 从 6.8 下调到 4.0
- **WHEN** 后续子步执行
- **THEN** `v_des` 被限制到 4.0，但瞬时速度 SHALL 按 `a_brake` 减速，SHALL NOT 在一个子步内被 clamp 到 4.0；`|Δv_total| ≤ A_MAX·SIM_DT`

#### Scenario: 狭窄冲突不可行

- **GIVEN** 两名同队球员的目标点在同一位置，且预测本段内会进入 2.2m 内
- **WHEN** 分离求解执行
- **THEN** 预测层 SHALL 在进入冲突前介入；若 3 次迭代内无法在 `|Δv_total| ≤ A_MAX·SIM_DT` 下满足 2.2m，SHALL 置 `constraint_infeasible`，SHALL NOT 输出伪合法轨迹

### Requirement: 向量速度与位置提交

`vel_mps` SHALL 是**二维速度向量**（权威量）；`speed=|vel|`、`heading=atan2(vel.y,vel.x)`（speed > `V_EPS` 时，否则保留上一 heading）。运动预算后 SHALL 用最终 `vel_after` 直接更新位置 `pos += vel_after·SIM_DT`，SHALL NOT 再用「标量 speed × (cos heading, sin heading)」的混合写法；SHALL 从最终 `vel_after` 恢复 `speed`/`heading`。分离/边界再改速度后 SHALL 从最终 `vel_final` 恢复 `speed`/`heading`，并重做总预算检查。

#### Scenario: 向量速度提交

- **GIVEN** 一个子步的 `vel_before` 与朝向更新后的 `heading`
- **WHEN** 运动预算得到 `vel_after`
- **THEN** 位置 SHALL 为 `pos + vel_after·SIM_DT`（向量直接乘 dt）；`speed`/`heading` SHALL 从 `vel_after` 恢复，不得保留第 3 步的旧 heading 去积分缩放后的向量

### Requirement: 总向量加速度预算

运动预算 SHALL 先于位置更新检查：`Δv_motion = vel_cmd − vel_before`（加速 + 转向 + 预测避碰）超 `A_MAX·SIM_DT` 时按比例缩放到预算内，得到 `vel_after`；位置 SHALL 用 `pos += vel_after·SIM_DT`，并由 `vel_after` 恢复 `speed`/`heading`。分离后 SHALL 再检查总预算 `|vel_final − vel_before| ≤ A_MAX·SIM_DT`（`vel_final = vel_after + Δpos_sep/SIM_DT`）；超预算时先缩减分离修正并重解，仍不满足 2.2m 或仍超预算则置 `constraint_infeasible`。SHALL NOT 由各阶段分别过门；`A_MAX` SHALL ≥ `max(A0_max, a_lat)`。

#### Scenario: 总向量加速度预算

- **GIVEN** `v=6 m/s, A0=6.4, S0=9.5, a_lat=6.5, dt=0.1, θ_err=0.2 rad`
- **WHEN** 一个正常运行子步同时加速与转向
- **THEN** 纵向 `Δspeed=0.236 m/s`、横向 `v·Δθ=0.650 m/s`；**精确二维旋转**的 `|Δv_total| ≈ 0.703044 m/s`；SHALL ≤ `A_MAX·dt`（`A_MAX=8.0` → 0.8）；不得用 `A0·dt=0.64` 误判为超界（那会把正常运动判红）。线性化 `sqrt(0.236²+0.650²)=0.692` 只是近似，SHALL NOT 用作精确验收值

### Requirement: 米制边界与边界重置

`pos_m` SHALL 钳在 `[0,105] × [0,68]`（米制；归一化只在发射时做）。指向边界外的法向速度 > `A_MAX·dt` 时置 `constraint_infeasible`；否则清零并**重做一次总预算检查**（`|vel_final − vel_before| ≤ A_MAX·SIM_DT`），记 `boundary_reset`；仍超预算则 `constraint_infeasible`。

#### Scenario: 米制边界

- **GIVEN** 球员在 `(30m, 34m)`，速度指向场内
- **WHEN** 子步更新位置
- **THEN** `pos_m` SHALL 仍以米制钳在 `[0,105] × [0,68]`，不得被钳到 `[0,1]`；归一化只在事件发射时做；若指向边界外的法向速度 > `A_MAX·dt`，置 `constraint_infeasible`，否则清零并记 `boundary_reset`（计入总预算）

### Requirement: 到达与制动语义

引擎 SHALL NOT 使用「距目标小于固定 dead-zone 即整拍不移动」的冻结语义。到达目标 SHALL 用制动曲线/到达半径表达：普通球员进入 `ARRIVE_RADIUS_M` 后 `v_des=0`，速度按 `a_brake` 下降，残余速度 SHALL ≤ `RESIDUAL_SPEED_MAX`。**事件参与者 SHALL 使用独立的精确到达模式 `PRECISION_ARRIVE_RADIUS_M`（SHALL ≤ `REACH_TOL_M`）**，不得用 1m 普通到达半径把 0.5m 的接球判成不可达。

#### Scenario: 到达半径不冻结

- **GIVEN** 一名球员进入目标 `ARRIVE_RADIUS_M` 内
- **WHEN** 后续仿真子步执行
- **THEN** `v_des` SHALL = 0，速度按 `a_brake` 下降；SHALL NOT 因「距目标 < dead-zone」而整拍不产 mover；残余速度 ≤ `RESIDUAL_SPEED_MAX`

#### Scenario: 精确到达模式

- **GIVEN** 一名事件参与者在距落点 0.5m、速度 0 处，`ARRIVE_RADIUS_M=1.0`、`PRECISION_ARRIVE_RADIUS_M=0.25`
- **WHEN** 可达性检查与积分执行
- **THEN** 参与者 SHALL 用 `PRECISION_ARRIVE_RADIUS_M`（不是 1.0m）判定到达，能继续减速到 ≤ `REACH_TOL_M`；SHALL NOT 因 1.0m 普通到达半径让 `v_des=0` 而永远停在 0.5m

### Requirement: 高亮参与者与统一运动状态

高亮事件（pass/shot/tackle/重开）的参与者 SHALL 与其他球员使用同一 `MotionState` 积分器与同一分离 solver；SHALL NOT 冻结位置、SHALL NOT 隐藏、SHALL NOT 在 finalize 时瞬移。参与者**在该段有非零位移时** SHALL 出现在 `movers`（`action:"highlight"`）；零位移段按稀疏规则保持上一位置。事件锚点 SHALL 等于参与者**连续积分（含分离）到 `t_end`** 的位置（容差 `REACH_TOL_M`）；`t_end` 不在段边界时，用该段起点的分离结果 + 积分到 `t_end`，finalize 边界状态再施加段末分离。SHALL NOT 再用「事件锚点直线」合成参与者轨迹（没有第二条轨迹）。finalize 取连续积分结果；除合法断点（kickoff / 死球重开 / 进球回中圈 / 罚下 / 终场）外，SHALL NOT 有任何位置投影/跳变。

#### Scenario: 参与者不冻结

- **GIVEN** 一名接球者在高亮期内
- **WHEN** 逐仿真子步检查其位置/速度
- **THEN** 位置 SHALL 按同一积分器更新（含分离），SHALL NOT 冻结在动作前位置；子步 `|Δv_total| ≤ A_MAX·SIM_DT`

#### Scenario: 参与者进入 movers

- **GIVEN** 一条 pass/shot/tackle 高亮在 `[t,t_end)` 内
- **WHEN** 引擎产出该区间的 beat
- **THEN** 接球者/拦截者/门将/抢断双方在**有非零位移的段** SHALL 出现在 `movers`（`action:"highlight"`），零位移段保持上一位置；球由事件锚点驱动；`main`/`ball` 不携带；viewer 用 mover 端点渲染参与者

#### Scenario: 事件锚点等于积分终点

- **GIVEN** 一条 pass/tackle 的参与者连续积分到 `t_end`
- **WHEN** 事件字段写入 `x2/y2` / `subject_end` / `carrier_end`
- **THEN** 这些值 SHALL 等于参与者（含分离）连续积分到 `t_end` 的位置（容差 `REACH_TOL_M`）；SHALL NOT 用投影或另一条直线凑终点

### Requirement: 事件提交协议

候选事件 SHALL 只定意图，**不先写** `x2/y2` / `subject_end` / `carrier_end` / `loose`。发射前 SHALL 用同一积分器 + 同一分离 solver 做确定性前视规划（含未来 decision 与分离；`PLAN_HORIZON` ≥ 最长高亮时长），得到球路、时长与全部参与者端点；前视用 RNG 副本，提交时记录 `cp_commit`/`cp_end`，覆盖内不消耗正式 RNG，交还 live 用 `cp_end`。验证后**原子提交事件 + `CommittedPlan`**；提交后 SHALL NOT 修改已承诺锚点。若视野不足或计划不稳定，SHALL 在事件 `t` 之前调整时间/落点或置 `highlight_infeasible`；SHALL NOT 先发事件再补计划。

#### Scenario: 发射前原子提交

- **GIVEN** 一条 pass 候选事件，`t_end − t = 0.475s`，期间无 decision
- **WHEN** 引擎决定是否发射
- **THEN** 先规划到包含 `t_end` 的完整输出段末端（`P_end=ceil(t_end/SIM_DT)·SIM_DT`，含 22 人与分离），得到参与者终点；验证后原子提交事件 + 计划；事件 `t` 之后 SHALL NOT 修改 `x2/y2`/`subject_end`/`carrier_end`

### Requirement: CommittedPlan 执行

`CommittedPlan` SHALL 覆盖 `[t_c, P_end]`，至少包含真实 `t_end` 所在完整输出段与 finalize 状态提交；内容 SHALL 含逐边界完整状态、decision 结果、事件列表、RNG checkpoints（`cp_commit`/每个 decision/`cp_end`）与规划轨迹。覆盖内调度器 SHALL **只消费缓存**：SHALL NOT 调 `decision()`、SHALL NOT 重掷 RNG；逐边界核对实际状态。`P_end` 处原子交还 live scheduler（状态 + `cp_end`），不得回滚已提交字段。计划末端若产生新高亮，follow-on plan SHALL 从 `P_end` 开始且无重叠；链式上限 `MAX_PLAN_CHAIN=3` / `PLAN_CHAIN_MAX_S=30s`，超限 `highlight_infeasible`。

#### Scenario: 计划覆盖内不重掷

- **GIVEN** 一个 `CommittedPlan` 覆盖 `[1.0,1.7]`，1.5 是 decision 边界
- **WHEN** 调度器执行到 1.5
- **THEN** 它 SHALL 读取计划缓存的 decision 结果（动作机会/目标/mode/事件）；SHALL NOT 调用 `decision()` 或重掷 RNG；beat 的 `from`/`to` 取缓存状态

#### Scenario: 计划末端交还

- **GIVEN** 一个计划在 `P_end=1.7` 结束，`cp_end` 是影子末端 RNG checkpoint
- **WHEN** 执行到 1.7
- **THEN** 应用计划 finalize/状态后 SHALL 原子交还 live：状态 = 缓存末端状态、RNG = `cp_end`；SHALL NOT 回滚已发事件/锚点；此后 1.7 的新事件/decision 由 live scheduler 处理

#### Scenario: follow-on 无重叠

- **GIVEN** 计划末端 `P_end` 产生新高亮候选
- **WHEN** 引擎决定接续
- **THEN** follow-on plan SHALL 从 `P_end` 开始（新事件 `t ≥ P_end`），与前一计划无重叠；若 `t < P_end`，必须合并进当前计划或拒绝；链数超过 `MAX_PLAN_CHAIN=3` 或总时长 > `PLAN_CHAIN_MAX_S=30s` 时置 `highlight_infeasible`

### Requirement: 高亮参与者的可达性检查与修复

可达性用**真实可用时长 `T`**（`floor(T/SIM_DT)` 个整步 + 一个 `dt_rem` 部分步，SHALL NOT 用 `ceil` 多给时间）；末态满足 `|pos_end−end| ≤ REACH_TOL_M` 且 `v_end ≤ REACH_SPEED_TOL` 才算可达。参与者 SHALL 用 `PRECISION_ARRIVE_RADIUS_M`。不可达时的修复顺序 SHALL 为：① 延长时限（不把 pass 速度推出 L2 带）；② 沿原方向把落点移入可达集；③ 置 `highlight_infeasible` 并不发射结果。SHALL NOT 先固定事件结果再让参与者瞬移凑终态。

#### Scenario: 接球可达性检查

- **GIVEN** 一条 pass 事件，落点 `(x2,y2)`、接球者位置/速度与真实飞行时长 `T=0.475s`
- **WHEN** 事件发出前
- **THEN** 引擎 SHALL 用同一积分器跑 4 个整步 + 1 个 0.075s 部分步（**不是 ceil 到 0.5s**）；只有按真实 T 可达才写入事件；不可达时按修复顺序处理

#### Scenario: 不可达改落点

- **GIVEN** 接球者在飞行时限内到不了原落点
- **WHEN** 修复执行
- **THEN** 优先延长飞行（若 pass 速度仍在 [10,25)）；否则沿传球方向缩短落点并把**改后**的值写入 `x2/y2`；两者都不可行则置 `highlight_infeasible`

#### Scenario: 门将扑救点

- **GIVEN** 一条 shot 事件且原结果为 save（save-caught/rebound），球路固定
- **WHEN** 门将在真实时限内到不了扑救点
- **THEN** 扑救点 SHALL 前移到球路径上最早可达的交点；若整条球路都不可达，结果 SHALL 改为 goal（几何否决）；**不得把原本 `off_target` 的 shot 改成 goal**；否决率报三个分母（全部 shot / 原 save / 尝试修复的 save）、逐 seed，超过**原 save 结果的 2%** 时停止并另立概率标定 change；挂 L1 射门结果分布的既有红非恶化门

#### Scenario: 抢断接触点

- **GIVEN** 一条 tackle 事件，双方在 `[T, T+DECISION_DT]` 内无法到达原接触点
- **WHEN** 事件发出前
- **THEN** 接触点 SHALL 改为双方可达集的确定性交点，并把改后的 `x2/y2` / `subject_end` / `carrier_end` 写入事件；无交点则置 `highlight_infeasible`

#### Scenario: 重开走位

- **GIVEN** 一次角球/界外球重开，发球者距固定点 > 到达半径
- **WHEN** 准备期执行
- **THEN** 发球者 SHALL 以正常运动学走位到固定点；到达前 SHALL NOT 发球；准备期 SHALL 延长而不是瞬移，上限 `RESTART_PREP_MAX_S`（工程初值 6.0s）

#### Scenario: finalize 无瞬移

- **GIVEN** 一条高亮事件在 `t_end` finalize，finalize 边界为第一个 ≥ `t_end` 的 0.1s 网格步
- **WHEN** 检查参与者位置
- **THEN** `st.pos` SHALL 等于**连续积分（含分离）结果**；事件锚点在 `t_end` 与积分轨迹的差 SHALL ≤ 一个 sim step 的采样差且 ≤ `REACH_TOL_M`；SHALL NOT 用「≤ `V_MAX·SIM_DT` 的位置投影」当连续性；除合法断点表外，任何跳变 SHALL 使守卫红

### Requirement: 段边界执行顺序

在一个段边界上，引擎 SHALL 按「上段终态 → finalize/事件 → decision → snapshot → 下一段积分/缓存 → 发出下一段 beat」执行；beat SHALL 描述事件之后的段。非 beat 事件与 beat 同时间戳时，事件 SHALL 排在 beat 之前。球的飞行终点 `t_end = t + dist/speed` 不要求落在段边界上：事件自身的锚点仍用真实 `t_end`；高亮 SHALL 在**第一个 ≥ `t_end` 的 0.1s 网格 sim step** finalize（该步进入段边界集合 `E`）。终场排空期（`t ≥ dur`）SHALL NOT 产 beat；同一 `dur` 上的链式 finalize SHALL 只保留一个**终态事件**，不新增段；终场前最后一段以 `dur` 结束，允许 `dt = dur − t_last`（0 < dt ≤ 0.2）。

#### Scenario: 顺序合同

- **GIVEN** 一个 live 段边界上同时有 finalize、decision 与 beat
- **WHEN** 引擎提交
- **THEN** 顺序 SHALL 为「上段终态 → finalize/事件 → decision → snapshot → 下一段积分/缓存 → beat」；beat 的 `from` 是 decision 后的状态

#### Scenario: 决策与事件先于 beat

- **GIVEN** 一个 `t=1.0` 的段边界上同时有决策、一条 tackle 事件与一条 beat
- **WHEN** 引擎提交
- **THEN** 顺序为「上段终态 → tackle → decision → snapshot → 积分下一段 → 发出 beat」；beat 的 `from` 是 tackle/decision 后的状态

#### Scenario: 非网格落地

- **GIVEN** 一条传球飞行 `t_end=0.975`，段边界为 0.9 与 1.0
- **WHEN** 引擎与 viewer 处理落地
- **THEN** 引擎在 1.0（第一个 ≥ 0.975 的 0.1s 网格步）finalize；0.9 段的 `to` 是 1.0 时刻状态（已落地）；viewer 用事件锚点在段内渲染球，不改变段端点的连续性

#### Scenario: 终场排空

- **GIVEN** 比赛在 `dur` 结束且仍有悬空高亮
- **WHEN** 终场 finalize
- **THEN** `t ≥ dur` 不产 beat；同一 `dur` 上的链式 finalize 只保留一个终态事件、不新增段；终场前最后一段以 `dur` 结束（`dt` 可为 `dur − t_last`，0 < dt ≤ 0.2）

### Requirement: 计划覆盖边界的执行

若一个段边界被 `CommittedPlan` 覆盖，finalize/事件/decision/下一段状态 SHALL 取计划缓存；SHALL NOT 重新 `decision()`、掷骰或积分；逐边界核对实际状态 == 缓存状态，不一致置 `plan_divergence`（D2.2）。

#### Scenario: 计划覆盖边界

- **GIVEN** 一个段边界被 `CommittedPlan` 覆盖
- **WHEN** 调度器执行到该边界
- **THEN** decision/事件/下一段状态 SHALL 取计划缓存；SHALL NOT 调用 `decision()` 或重掷 RNG；实际状态与缓存不一致时置 `plan_divergence`

## MODIFIED Requirements

### Requirement: 事件流过程真实性不变量（L2）

引擎 SHALL 使事件流满足以下跨事件不变量，任意 seed 都成立。

#### Scenario: 比分与进球计数一致
- **WHEN** 引擎产出一场完整比赛
- **THEN** whistle 事件 score（`"{home}-{away}"`）SHALL 精确等于事件流中 shot[result="goal"] 的计数

#### Scenario: 射门落点在球门矩形内
- **WHEN** 引擎产出一条 shot 事件
- **THEN** goal/saved 的 y2 SHALL ∈ [0.455, 0.545]，x2 SHALL = 攻方门线（home 射 0.98 / away 射 0.02）；off_target 的 y2 SHALL ∈ [0.40, 0.445] ∪ [0.555, 0.60]（贴柱偏出）

#### Scenario: beat 节拍固定
- **WHEN** 引擎产出 beat 事件序列
- **THEN** 按路径/边界类型判定（不是单一常量集合）：开放比赛/重开准备的**相邻已发 beat** `t` 差 SHALL ∈ {0.1, 0.2} ± 0.001（0.1 = 决策/事件/高亮终点切段，0.2 = 名义；**0.4 不合法**）；死球窗口允许 gap ≤ 2.0s，且若窗口 > 2.0s 引擎 SHALL 至少每 2.0s 产一条静态 beat（使**每一对相邻已发 beat** 都 ≤ 2.0s）；终场最后一段例外，`dt = dur − t_last`（0 < dt ≤ 0.2）且 `t+dt=dur`；终场排空期（`t ≥ dur`）不产 beat，不受本断言约束

#### Scenario: 速度不超物理量
- **WHEN** 引擎产出带 speed 的事件
- **THEN** 普通射门 speed ∈ [22, 30)；头球射门 speed ∈ [15, 20)；pass 事件 speed ∈ [10, 25)；beat main.speed ≤ 5.1；beat mover.speed ≤ 8.1（重开走位 8 m/s 例外上限）。填拍（fill-to-`BEAT_DT`）SHALL NOT 把 pass speed 推出 [10,25)：若 `dist/(0.95×BEAT_DT)` 不在带内，引擎 SHALL 保持原飞行时长（可跨多个 beat），不得为填拍牺牲速度带

#### Scenario: 门将贴门线
- **WHEN** 引擎产出 shot 事件
- **THEN** keeper_x SHALL < 0.15 或 > 0.85（**射门瞬间**门将仍在本方门前区域 = 距本方门线 < 15.75 m）。
  ⚠️ **理由子句的口径（2026-10-17 订正）**：本 Scenario **只约束射门瞬间**，**不**约束门将的整场移动——
  M1b 之后门将随球出/退，其**目标**距本方门线的上界 = `GK_COME_OUT_SLOPE × PITCH_LENGTH_M − |GK_COME_OUT_INTERCEPT_M|`
  = `0.2440 × 105 − 0.4632` = **25.1568 m**（`≈25 m`；公式与两个系数见 `球相关队形目标` 的「门将随球出/退」，
  该 Scenario 本身**不印这个数**，故在此写出算式），
  原括号理由「门将不离开门线区域」**已不成立**（它是 M1b 之前的实情）。判据本身不受影响：
  实测射门瞬间距本方门线 max **9.55 m** < 15.75 m，0 违例、余量 **1.65×**。

#### Scenario: 事件时间范围
- **WHEN** 引擎产出一场时长 dur 的比赛
- **THEN** 全部事件 t SHALL ∈ [-0.001, dur+0.001]

#### Scenario: 罚下球员零参与
- **WHEN** 从事件流中 `foul[card=red]` 重建罚下集合并扫描其后所有事件
- **THEN** 罚下球员不得出现在任何事件的 `subject` / `movers[].id` / `carrier` / `interceptor` / `to` 中，违例计为零

#### Scenario: L2 门覆盖红牌派生路径
- **GIVEN** 罚下球员参与的违例只在少数 seed 出现（红牌约 1/6 场）
- **WHEN** 用窄 seed 窗口（如 15）运行 L2
- **THEN** 门可能在实际被违反时仍全绿（假绿）；故 seed 覆盖 SHALL ≥ 300（实测最早出现该路径的 seed 为 260），且开球者与接球者 SHALL 不同一人（自传退化）

### Requirement: 同队球员间距（≥2m）

引擎 SHALL 使同队两球员在引擎发射的任意位置采样点（lineup 初始站位、mover 终点 `to_x/to_y`、main 终点 `x2/y2`、以及模拟状态位置 `st.pos`）上的**米制**间距 ≥ 2m（阈值常量 `SAME_TEAM_MIN_DIST_M` = 2.2m，含 JSON 4 位小数序列化与 `beat.dt` 采样插值的安全余量）。间距 SHALL 用真实米制几何计算（x 方向 × 105、y 方向 × 68），SHALL NOT 用归一化欧氏距离（归一化圆在 105×68 球场上 x 方向 2.1m、y 方向仅 1.36m）。分离 SHALL 覆盖 carrier、门将、特殊站位（角球包抄 / close_down / chase / anticipate）与到达半径内停者；由事件直接指定的终点（传球接球点 / 门将扑救点 / 抢断结算点 / 开球落点 / 松散球拾取点）SHALL 在写入状态前经同一分离。分离 SHALL 为纯函数：零额外 RNG、固定遍历顺序、不改变事件类型/频率的判定逻辑。**分离产生的速度修正 SHALL 计入 D4.4 的总向量预算 `|Δv_total| ≤ A_MAX·SIM_DT`（不得与加速/转向各自单独过门）；若在 3 次迭代内不可行，SHALL 置 `constraint_infeasible` 并使守卫红，SHALL NOT 静默推端点。高亮参与者同样参与分离、不被冻结；其事件终点写成分离后的连续积分结果。** 段内插值中点 SHALL 由 viewer 侧 `player_overlap` detector 观测（不在引擎预计算每段中点推开）。

#### Scenario: 整场无同队重叠
- **GIVEN** 引擎以多 seed 模拟整场比赛
- **THEN** 每个段边界的同队两两米制距离 SHALL ≥ `SAME_TEAM_MIN_DIST_M - ε`（ε 为浮点容差）；lineup 初始站位、mover 终点、main 终点均满足

#### Scenario: 米制口径
- **GIVEN** 两个归一化坐标点，其归一化欧氏距离相同但轴向不同
- **THEN** 引擎按 x×105 / y×68 的真实米制距离判定是否 < 2m，而非归一化欧氏距离（y 方向 0.02 归一化 = 1.36m < 2m，须被分离；x 方向 0.02 归一化 = 2.1m ≥ 2m，不强制分离）

#### Scenario: carrier 参与分离
- **GIVEN** carrier 带球推进逼近同队队友至 <2m
- **THEN** 分离后 carrier 与队友米制间距 ≥ 2m，且 `main.x2/y2`、`st.pos[carrier]`、`ball_pos`、`carrier_from`、`last_emitted[carrier]` 全部与分离后终点一致（`main.x/y` 保留起点）

#### Scenario: 特殊站位兜底
- **GIVEN** 角球包抄 / close_down / chase / anticipate 目标使同队球员 <2m
- **THEN** 最终分离仍使同队间距 ≥ 2m，且不重选目标、不重抽 RNG、保留 action 标签

#### Scenario: 拍内扫掠（viewer 插值口径）
- **GIVEN** 两名同队球员某一段的线性轨迹（`from`→`to`，viewer 在锚点间线性插值）在中途 <2m
- **THEN** 引擎 SHALL 对整条轨迹施加约束（侧向推移终点），使中点间距亦 ≥ 2m − 舍入余量；推移量 SHALL 有界（≤ 该球员本段步长 `speed×beat.dt`），超限时留给下一段而非横甩

#### Scenario: 分离位移有界
- **GIVEN** 引擎产出的任一 beat
- **THEN** 每个 mover 的单段位移 SHALL ≤ 其 `speed × beat.dt` + `SAME_TEAM_MIN_DIST_M`（多轮扫掠的累积有界，不得横穿球场）

#### Scenario: 零 RNG 确定性
- **WHEN** 同 seed 同 config 两次模拟
- **THEN** 事件流（含分离后的坐标）完全一致（由 golden master 全流哈希守护）

#### Scenario: 跨队不适用
- **GIVEN** 抢断瞬间防守者与被抢者（跨队）结算到 `subject_end/carrier_end`
- **THEN** 该跨队分离 SHALL NOT 受同队 2m 约束（同队间距只作用于同队 pair）

#### Scenario: 状态与事件一致
- **GIVEN** 任一段边界结束
- **THEN** 每名未罚下球员的 `st.pos` SHALL 等于其最近一次发射位置（`last_emitted`），不得出现状态与 viewer 所见错位

### Requirement: 球相关队形目标

引擎 SHALL 为每名球员计算目标位置 = 角色站位基准 + 队形偏移（随球位置、控球阶段、球侧变化），使球队呈现整体伸缩/平移而非独立人偶回位。**门将 SHALL NOT 走本队形目标**——其目标由**门将出/退律**单独计算（见「门将随球出/退」Scenario）。

#### Scenario: 防线随球前压/回撤
- **GIVEN** 球推进到前场
- **THEN** 防守方后卫线（防线 = 每队离己方门线最近的 4 名外场球员，**按 default_lineup 基准站位定静态身份，非逐 tick 动态重选**，不含门将）目标位置随球前压（push up）：目标 = `clamp01(clamp(base + shift + press + push, base, ball)).clamp(0.04, 0.9)`（末段为 P7 的"不顶门线/不进小禁区"钳制）沿己方进攻方向——home 攻左→右取 `min(球位, …)`、away 攻右→左取 `max(球位, …)`，**且不下穿角色基准 `base`**；球回撤时防线回收（drop back）；门将不参与防线前压（**不走本队形目标**）。**注意**：球位于该防线基准之后（球 x < base.x）时以 `base` 为准，此时目标可在球之前（地板优先于"不得越过球"）

#### Scenario: 全队随球侧平移
- **GIVEN** 球在球场左半
- **THEN** 外场球员目标位置向左偏移（ball-side shift，连续映射 shift ∝ ball_x−0.5，非二分切换），保持球侧紧凑；纵向同向随球压缩（y 偏移 = (ball_y−0.5)×`SIDE_SHIFT_FACTOR`×0.6）；门将不参与球侧平移（**不走本队形目标**，其横向按 `GK_TRACK_Y` 跟球，见下）

#### Scenario: 控球阶段压上
- **GIVEN** 己方处于 attack phase
- **THEN** 外场球员目标位置前压（门将不走本队形目标）；己方处于 defend phase 时回收（压上由 phase 驱动，不绑定瞬时持球状态——松散球期间 attack 方仍前压）

#### Scenario: 门将随球出/退
- **GIVEN** 引擎产出 `beat` 事件的 `movers` 数组（`id` = 0 / 21 的门将项，`action` = `keeper_return`）
- **THEN** 门将的目标位置 SHALL 由**球距本方门线的距离**决定，SHALL NOT 是常数：
  门将距本方门线 = `max(GK_COME_OUT_INTERCEPT_M + GK_COME_OUT_SLOPE × 球距本方门线, GK_COME_OUT_FLOOR_M)`，
  横向 `y = 0.5 + (球 y − 0.5) × GK_TRACK_Y`。⇒ 球越远、门将站得越出；球贴本方门线时钳在地板 `GK_COME_OUT_FLOOR_M`。
- **AND** 两个系数 SHALL 来自真实语料（22 场：Metrica 2 + SkillCorner 20）的**观测分箱中位最小二乘**
  （斜率 `0.2440`、截距 `−0.4632`；地板 `2.0` 取真实 q10 之下的保守值），
  SHALL NOT 由引擎现状标定。
- **AND** 本改动 SHALL NOT 改 `GK_SPEED_MS`、`keeper_return` 这个 action 名、
  同队间距分离，或任何其它常量。`DEAD_ZONE_METERS` 的「到点冻结」语义由本 change 的 C1 运动层删除
  （见 `match-engine` 的「每球员连续运动状态」）；门将同受到达半径/制动约束，不再有 2m 静区。
- **AND** **代价 SHALL 与实现一同记录，且每条读数 SHALL 带【树】与【口径】标签**——
  下面三条一律是**落地树（M5 + M1b，`672ea33`）**的读数：树不同则数不同、**机制画像也不同**，
  SHALL NOT 跨树搬运（早期记录里的 `<2.2 m` = `2/12/61`、`<5 m` 比值 = `29×/32×/28×`
  是 **M1b-only 树**（base + M1b patch）的读数，**不在本规格口径内**；两者在落地树上分别是
  `79/29/19` 与 `40.5×/30.0×/23.0×`）。
  (i) L2「门将贴门线」余量由 1.78×（节点表口径）降到 **1.65×**
  （300 seed，射门瞬间 `keeper_x` 离最近门线 max **9.55 m** vs 门限 15.75 m，0 违例）；
  (ii) 门将↔队友 `<5 m` 频次 **40.5× / 30.0× / 23.0×** 基线（seed 42/1/7，0.2 s 插值帧口径）；
  (iii) 同口径下 `<2.2 m` 对数 **79 / 29 / 19**。
  ⚠️ **出处与可自证性**：(ii)(iii) 的值出自**独立审阅 B 的自建探针**（`REVIEW-B.md §3.3`，探针**未入库**）
  ⇒ **本仓内不可自证**（方法可自证：同一支探针在 base 与 M1b-only 两棵树上的读数与旧记录逐位相同，
  而落地树行不同）。(i) 的 `15.75 m` 是可自证的算术（`0.15 × PITCH_LENGTH_M`），`9.55 m` 与 `1.65×` 同出一处审阅。
- **AND** **分离线未被越过这条结论 SHALL 带口径写**：上面 (ii)(iii) 用的 **0.2 s 插值帧**口径
  在两拍之间做线性插值，会切角、造出「两人交叉」的**帧间插值伪影对**；
  **tick 口径**（`state_snapshots` 逐拍 22 人位置）下三 seed 的最小同队间距恰 = **2.200 m**，
  且 `< 2.14 m` 与 `< 2.0 m` 的**对数全为 0** ⇒ **分离目标线在引擎自己的拍上从未被越过**
  （`spacing-sweep` 仍 0 findings）。⇒ 两种口径 SHALL 并列写明，SHALL NOT 把插值帧的对数
  直接读成「越过了分离线」。
- **AND** 「门将挤队友 → 外场被推开」这条**因果未做消融**（REVIEW 独立 dump 首处外场分歧，
  核到的是**球位驱动**：偏移比 0.28 = `(1−FORM_MIX_X)·SIDE_SHIFT_FACTOR + FORM_MIX_X·FORM_TRACK_X`，
  不是门将推移）⇒ SHALL 记为**解释**而非已证因果。

#### Scenario: 防橡皮筋
- **WHEN** 每段边界更新目标
- **THEN** 移动受速度/加速度/制动的上限约束（见「确定性单步运动积分」）；目标进入到达半径时 `v_des=0`、按 `a_brake` 减速，**不再有 `DEAD_ZONE_METERS` 的「到点整拍冻结」语义**；目标点间距约束（repulsion，作用域 = 同队内部，在队形/close_down 目标后施加最小间距修正；**最小间距 = `SAME_TEAM_MIN_DIST_M` = 2.2m，米制**——P34（#53）起判定与推开都走米制（`same_team_dist_m` + `separate_pair_m`），与 detector `player_overlap` 口径一致；旧归一化欧氏口径在 105×68 球场上 y 方向只保证 1.36m。间距 < 阈值的同队球员对沿连线推开至阈值，确定性迭代 ≤3 次；速度修正计入总向量预算 `|Δv_total| ≤ A_MAX·SIM_DT`，不可行时置 `constraint_infeasible`；carrier 不参与 repulsion——其位置由 main 带球轨迹决定），避免两圆点重叠；运算顺序：先到达半径判定，后 approach-rate cap 限幅

### Requirement: 控球阶段与攻防转换

引擎 SHALL 维护每队**基础 phase（attack/defend）+ transition 叠加窗口（transition_active 布尔）**；球权易主（抢断成功 / 射门被扑住（save-caught）——`TransitionSource` 的仅有两个来源）时触发固定 `TRANSITION_TICKS = 4` 的 transition 窗口（**tick 仍指 decision 拍 `DECISION_DT`，即窗口 = 2.0s**）：**窗口内的 decision 拍只产 main + movers、不走机会评估（因此不掷新高亮）**；新进攻方全队前压（经 `formation_target` 的 `press` 在窗口内放大 2× 经 movers 表达），新防守方回撤并就近收缩。

#### Scenario: 抢断成功触发反击
- **GIVEN** 一次抢断成功（球权易主）
- **THEN** 触发 transition（固定 `TRANSITION_TICKS = 4` 个 decision 拍）：tackle 高亮起点即武装 transition（tackle 高亮时长 1 个 decision 拍覆盖 `[T, T+DECISION_DT)`）；松散球自 `t_end=T+DECISION_DT` 产生，窗口内的 decision 拍只产 `beat.ball` + movers、不走机会评估；**main v11 实测拾取恒发生在 T+4（C1 必须重测；该实测值不是契约）**（`LOOSE_MAX_TICKS = 2` 只封顶球的滚动、不封顶追逐，追逐者每个 decision 拍走 `RUN_SPEED_MS`；拾取 decision 拍顶部窗口已被清除）——故 tackle 路径下**不存在"新持球者在窗口内前插"这一可见行为**（`carrier_move` 的反击前插分支只对窗口内持球者生效，而该路径下窗口内无持球者）；新进攻方队形前压（`formation_target` 的 `press` 窗口内放大 2×，经 movers 表达），新防守方整体回撤并**就近 2 名外场防守者收缩（close_down，执行者 = 距目标最近且非 carrier 的 2 名，确定性平局按 id 小者；目标 = 球位——tackle 源恒取 `st.ball_pos`，即松散球位置；收缩不进入拾取半径；原持球方"回位" = 不参与拾取竞争（不追球抢球），但按 close_down 向目标侧收缩/压迫，非静止不动）**

#### Scenario: 射门被扑救触发反击
- **GIVEN** 一次射门被门将扑住（save-caught，球权易主）
- **THEN** save 高亮终点后的**首个 decision 边界**武装 transition（门将扑住时刻可非整数，取整到下一个 `DECISION_DT` 边界）：门将持球 → main 恢复（P4 D12）；**门将 carrier 不参与"前插"**（前插只作用于外场球员，门将持球在门线零位移/短带，**transition 窗口结束后回到正常开放比赛的机会评估（自然 deadline，钳制 [3,12] 个 decision 拍，门将另有 `GK_DEADLINE_BONUS_TICKS` 放宽）；门将持球走出球档，直接掷 pass 高亮出球**）；新防守方整体回撤 + **就近 2 名外场防守者 close_down（执行者 = 距目标最近的 2 名外场球员，排除门将 / carrier / 罚下者，确定性平局按 id 小者；save-caught 源的目标 = `attacking_forward`——新进攻方中最靠其进攻方向球门的球员，即门前/禁区前沿的对方球员；收缩不进入拾取半径）**，transition 窗口从武装 decision 拍起算

#### Scenario: 射门扑出反弹不触发 transition
- **GIVEN** 一次射门被门将扑出（save-rebound）
- **THEN** 不触发 transition——进入普通松散球（P4 D11，**双方可争**，追逐者 = 距球最近者），拾取后 phase 按球权刷新（原进攻方补射拾取 → 继续 attack；防守方拾取 → 回 defend）

#### Scenario: 松散球期间 phase 按易主后归属
- **GIVEN** 球权易主后的松散球阶段（无人持球，新持球者尚未拾取）
- **THEN** 两队基础 phase 按易主后归属：新进攻方（抢断方/扑救方）为 attack、原持球方为 defend（transition_active 叠加），transition 窗口不因松散球中断；新持球者拾取后按球权刷新（save-rebound 未易主则沿用易主前归属，拾取后按实际拾取方刷新）

#### Scenario: transition 期间不掷新高亮
- **GIVEN** transition 进行中
- **THEN** transition 期间**不开启行动机会**（该 decision 拍只产 main + movers，不走机会评估），因此不再掷新高亮（保证反击窗口完整可见）；**窗口结束后恢复正常机会评估**（自然 deadline 驱动，无独立 hold 计数）；球权易主 → 新 carrier 的机会在其持球段起始处重新起算

#### Scenario: transition 窗口结束
- **GIVEN** transition 窗口（4 个 decision 拍）结束后
- **THEN** 每队回到 attack/defend 阶段（按球位置/持球方），队形目标恢复正常
