# Spec: match-engine

## ADDED Requirements

### Requirement: 球相关队形目标

引擎 SHALL 为每名球员计算目标位置 = 角色站位基准 + 队形偏移（随球位置、控球阶段、球侧变化），使球队呈现整体伸缩/平移而非独立人偶回位。

#### Scenario: 防线随球前压/回撤
- **GIVEN** 球推进到前场
- **THEN** 防守方后卫线（防线 = 每队离己方门线最近的 4 名外场球员，**按 default_lineup 基准站位定静态身份，非逐 tick 动态重选**，不含门将）目标位置随球前压（push up）：目标 = `clamp01(clamp(base + shift + press + push, base, ball)).clamp(0.04, 0.9)`（末段为 P7 的"不顶门线/不进小禁区"钳制）沿己方进攻方向——home 攻左→右取 `min(球位, …)`、away 攻右→左取 `max(球位, …)`，**且不下穿角色基准 `base`**；球回撤时防线回收（drop back）；门将不参与防线前压（仅回位到门线）。**注意**：球位于该防线基准之后（球 x < base.x）时以 `base` 为准，此时目标可在球之前（地板优先于"不得越过球"）

#### Scenario: 全队随球侧平移
- **GIVEN** 球在球场左半
- **THEN** 外场球员目标位置向左偏移（ball-side shift，连续映射 shift ∝ ball_x−0.5，非二分切换），保持球侧紧凑；纵向同向随球压缩（y 偏移 = (ball_y−0.5)×`SIDE_SHIFT_FACTOR`×0.6）；门将除外（不参与球侧平移，仅回位到门线）

#### Scenario: 控球阶段压上
- **GIVEN** 己方处于 attack phase
- **THEN** 全队目标位置前压（不含门将）；己方处于 defend phase 时回收（压上由 phase 驱动，不绑定瞬时持球状态——松散球期间 attack 方仍前压）

#### Scenario: 防橡皮筋
- **WHEN** 每 tick 更新目标
- **THEN** 移动受速度上限约束；位移小于静区阈值时不移动（静区绑定单一常量 `DEAD_ZONE_METERS`——P4 起的同一个门、非新引入；P7 由 0.5m 放大到 **2.0m**，到位后目标微变不追，避免球门旁来回小幅摆动）；目标点间距约束（repulsion，作用域 = 同队内部，在队形/close_down 目标后施加最小间距修正；**最小间距 = `SAME_TEAM_MIN_DIST_M` = 2.2m，米制**——P34（#53）起判定与推开都走米制（`same_team_dist_m` + `separate_pair_m`），与 detector `player_overlap` 口径一致；旧归一化欧氏口径在 105×68 球场上 y 方向只保证 1.36m。间距 < 阈值的同队球员对沿连线推开至阈值，确定性迭代 ≤3 次；carrier 不参与 repulsion——其位置由 main 带球轨迹决定），避免两圆点重叠；运算顺序：先 dead-zone 判定，后 approach-rate cap 限幅

### Requirement: 控球阶段与攻防转换

引擎 SHALL 维护每队**基础 phase（attack/defend）+ transition 叠加窗口（transition_active 布尔）**；球权易主（抢断成功 / 射门被扑住（save-caught）——`TransitionSource` 的仅有两个来源）时触发固定 `TRANSITION_TICKS = 4` 的 transition 窗口：**窗口内该 tick 只产 main + movers、不走机会评估（因此不掷新高亮）**；新进攻方全队前压（经 `formation_target` 的 `press` 在窗口内放大 2× 经 movers 表达），新防守方回撤并就近收缩。

#### Scenario: 抢断成功触发反击
- **GIVEN** 一次抢断成功（球权易主）
- **THEN** 触发 transition（固定 `TRANSITION_TICKS = 4`）：tackle 高亮起点 tick 即武装 transition（tackle 高亮时长 1 tick 覆盖 [T, T+1)）；松散球自 t_end=T+1 产生，窗口内该 tick 只产 `beat.ball` + movers、不走机会评估；**实测拾取恒发生在 T+4**（`LOOSE_MAX_TICKS = 2` 只封顶球的滚动、不封顶追逐，追逐者每 tick 走 `RUN_SPEED_MS`；拾取 tick 顶部窗口已被清除）——故 tackle 路径下**不存在"新持球者在窗口内前插"这一可见行为**（`carrier_move` 的反击前插分支只对窗口内持球者生效，而该路径下窗口内无持球者）；新进攻方队形前压（`formation_target` 的 `press` 窗口内放大 2×，经 movers 表达），新防守方整体回撤并**就近 2 名外场防守者收缩（close_down，执行者 = 距目标最近且非 carrier 的 2 名，确定性平局按 id 小者；目标 = 球位——tackle 源恒取 `st.ball_pos`，即松散球位置；收缩不进入拾取半径；原持球方"回位" = 不参与拾取竞争（不追球抢球），但按 close_down 向目标侧收缩/压迫，非静止不动）**

#### Scenario: 射门被扑救触发反击
- **GIVEN** 一次射门被门将扑住（save-caught，球权易主）
- **THEN** save 高亮终点 tick 后的**首个整数 tick 边界**武装 transition（门将扑住时刻可非整数，取整到下一整数 tick）：门将持球 → main 恢复（P4 D12）；**门将 carrier 不参与"前插"**（前插只作用于外场球员，门将持球在门线零位移/短带，**transition 窗口结束后回到正常开放比赛的机会评估（自然 deadline，钳制 [3,12] tick，门将另有 `GK_DEADLINE_BONUS_TICKS` 放宽）；门将持球走出球档，直接掷 pass 高亮出球**）；新防守方整体回撤 + **就近 2 名外场防守者 close_down（执行者 = 距目标最近的 2 名外场球员，排除门将 / carrier / 罚下者，确定性平局按 id 小者；save-caught 源的目标 = `attacking_forward`——新进攻方中最靠其进攻方向球门的球员，即门前/禁区前沿的对方球员；收缩不进入拾取半径）**，transition 窗口从武装 tick 起算

#### Scenario: 射门扑出反弹不触发 transition
- **GIVEN** 一次射门被门将扑出（save-rebound）
- **THEN** 不触发 transition——进入普通松散球（P4 D11，**双方可争**，追逐者 = 距球最近者），拾取后 phase 按球权刷新（原进攻方补射拾取 → 继续 attack；防守方拾取 → 回 defend）

#### Scenario: 松散球期间 phase 按易主后归属
- **GIVEN** 球权易主后的松散球阶段（无人持球，新持球者尚未拾取）
- **THEN** 两队基础 phase 按易主后归属：新进攻方（抢断方/扑救方）为 attack、原持球方为 defend（transition_active 叠加），transition 窗口不因松散球中断；新持球者拾取后按球权刷新（save-rebound 未易主则沿用易主前归属，拾取后按实际拾取方刷新）

#### Scenario: transition 期间不掷新高亮
- **GIVEN** transition 进行中
- **THEN** transition 期间**不开启行动机会**（该 tick 只产 main + movers，不走机会评估），因此不再掷新高亮（保证反击窗口完整可见）；**窗口结束后恢复正常机会评估**（自然 deadline 驱动，无独立 hold 计数）；球权易主 → 新 carrier 的机会在其持球段起始处重新起算

#### Scenario: transition 窗口结束
- **GIVEN** transition 窗口（4 tick）结束后
- **THEN** 每队回到 attack/defend 阶段（按球位置/持球方），队形目标恢复正常

### Requirement: 队形与阶段转换确定性

引擎 SHALL 保持种子确定性：同 seed 同 config → 同事件流（队形目标、阶段转换、movers 一致）。

#### Scenario: 阶段确定性
- **WHEN** 同 seed 两次模拟
- **THEN** 可观测代理一致：以**反击段 movers 方向（新进攻方前压 / 新防守方回撤 + close_down 收缩）为区分性代理**（窗口内无新高亮单独不具区分度——正常持球段也长时间无高亮），队形目标导致的位置更新完全一致（phase 本身不发射，通过可观测事件流断言）
