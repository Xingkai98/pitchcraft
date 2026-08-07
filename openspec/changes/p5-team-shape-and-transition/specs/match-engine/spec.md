# Spec: match-engine

## ADDED Requirements

### Requirement: 球相关队形目标

引擎 SHALL 为每名球员计算目标位置 = 角色站位基准 + 队形偏移（随球位置、控球阶段、球侧变化），使球队呈现整体伸缩/平移而非独立人偶回位。

#### Scenario: 防线随球前压/回撤
- **GIVEN** 球推进到前场
- **THEN** 防守方后卫线（防线 = 每队离己方门线最近的 4 名外场球员，不含门将）目标位置随球前压（push up），且防线不得越过球（沿己方进攻方向钳制：home 攻左→右则 line.x ≤ ball.x，away 攻右→左则 line.x ≥ ball.x）；球回撤时防线回收（drop back）；门将不参与防线前压（仅回位到门线）

#### Scenario: 全队随球侧平移
- **GIVEN** 球在球场左半
- **THEN** 外场球员目标位置向左偏移（ball-side shift，连续映射 shift ∝ ball_x−0.5，非二分切换），保持球侧紧凑；防守时收窄，进攻时保持宽度；门将除外（不参与球侧平移，仅回位到门线）

#### Scenario: 控球阶段压上
- **GIVEN** 己方处于 attack phase（持球）
- **THEN** 全队目标位置前压（不含门将）；己方处于 defend phase（对方持球）时回收

#### Scenario: 防橡皮筋
- **WHEN** 每 tick 更新目标
- **THEN** 移动受速度上限约束；位移小于静区阈值时不移动（dead-zone 绑定 P4 单门 0.5m，同一变量）；目标点间距约束（repulsion，作用域 = 同队内部，在队形/close_down 目标后施加最小间距修正），避免两圆点重叠；运算顺序：先 dead-zone 判定，后 approach-rate cap 限幅

### Requirement: 控球阶段与攻防转换

引擎 SHALL 维护每队**基础 phase（attack/defend）+ transition 叠加窗口（transition_active 布尔）**；球权易主（抢断成功 / 射门被扑住（save-caught）；拦截标注"后续加入"）时触发固定 `TRANSITION_TICKS = 4` 的 transition 窗口，新进攻方持球者前插、全队前压，新防守方回撤并就近收缩。

#### Scenario: 抢断成功触发反击
- **GIVEN** 一次抢断成功（球权易主）
- **THEN** 触发 transition（固定 `TRANSITION_TICKS = 4`）：tackle 高亮起点 tick 即武装 transition（全队前压/回撤立即生效，tackle 高亮时长 1 tick 覆盖 [T, T+1)）；新持球者前插目标等松散球被拾取后激活（松散球 t_end=T+1 产生，追逐 ≤ `LOOSE_MAX_TICKS = 2` → 拾取 ≤ T+3，落在窗口 [T, T+4) 内）；新进攻方队形前压，新防守方整体回撤并就近 2 名外场防守者收缩（close_down；**过渡期目标 = 接触点/被铲者位置**，松散球产生后切换为球位，拾取后切换为持球者）

#### Scenario: 射门被扑救触发反击
- **GIVEN** 一次射门被门将扑住（save-caught，球权易主）
- **THEN** save 高亮终点 tick 后的**首个整数 tick 边界**武装 transition（门将扑住时刻可非整数，取整到下一整数 tick）：门将持球 → main 恢复（P4 D12）；**门将 carrier 不参与"前插"**（前插只作用于外场球员，门将持球在门线零位移/短带，**transition 窗口结束后**经 pass 高亮出球）；新防守方整体回撤 + 就近 2 名外场防守者 close_down（目标 = **门前区域对方球员（原进攻方前插者）**），transition 窗口从武装 tick 起算

#### Scenario: 射门扑出反弹不触发 transition
- **GIVEN** 一次射门被门将扑出（save-rebound）
- **THEN** 不触发 transition——进入普通松散球（P4 D11，**双方可争**，追逐者 = 距球最近者），拾取后 phase 按球权刷新（原进攻方补射拾取 → 继续 attack；防守方拾取 → 回 defend）

#### Scenario: 松散球期间 phase 沿用最后持球方
- **GIVEN** 球权易主后的松散球阶段（无人持球，新持球者尚未拾取）
- **THEN** 两队 phase 沿用最后持球方归属（新进攻方仍 attack、新防守方仍 defend），transition 窗口不因松散球中断；新持球者拾取后按球权刷新

#### Scenario: transition 期间高亮门控暂停
- **GIVEN** transition 进行中
- **THEN** 持球 hold 门控暂停（钉死为暂停这一种，hold 计数**冻结**——不增不减），transition 期间不再掷新高亮（保证反击窗口完整可见）；transition 结束续走

#### Scenario: transition 窗口结束
- **GIVEN** transition 窗口（4 tick）结束后
- **THEN** 每队回到 attack/defend 阶段（按球位置/持球方），队形目标恢复正常

### Requirement: 确定性

引擎 SHALL 保持种子确定性：同 seed 同 config → 同事件流（队形目标、阶段转换、movers 一致）。

#### Scenario: 阶段确定性
- **WHEN** 同 seed 两次模拟
- **THEN** 可观测代理一致：以**反击段 movers 方向（新进攻方前压 / 新防守方回撤 + close_down 收缩）为区分性代理**（窗口内无新高亮单独不具区分度——正常 hold 也长时间无高亮），队形目标导致的位置更新完全一致（phase 本身不发射，通过可观测事件流断言）
