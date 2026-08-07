# Spec: match-engine

## ADDED Requirements

### Requirement: 球相关队形目标

引擎 SHALL 为每名球员计算目标位置 = 角色站位基准 + 队形偏移（随球位置、控球阶段、球侧变化），使球队呈现整体伸缩/平移而非独立人偶回位。

#### Scenario: 防线随球前压/回撤
- **GIVEN** 球推进到前场
- **THEN** 防守方后卫线（防线 = 外场后卫，不含门将）目标位置随球前压（push up），且防线 x 不超过球 x；球回撤时防线回收（drop back）；门将不参与防线前压（仅回位到门线）

#### Scenario: 全队随球侧平移
- **GIVEN** 球在球场左半
- **THEN** 全队目标位置向左偏移（ball-side shift，连续映射 shift ∝ ball_x−0.5，非二分切换），保持球侧紧凑；防守时收窄，进攻时保持宽度

#### Scenario: 控球阶段压上
- **GIVEN** 己方持球
- **THEN** 全队目标位置前压；对方持球时回收

#### Scenario: 防橡皮筋
- **WHEN** 每 tick 更新目标
- **THEN** 移动受速度上限约束；位移小于静区阈值时不移动（movers 保持增量）；目标点间距约束（repulsion），避免两圆点重叠

### Requirement: 控球阶段与攻防转换

引擎 SHALL 维护每队 phase（attack/defend/transition）；球权易主（抢断成功 / 射门被扑救；拦截标注"后续加入"）时触发固定 `TRANSITION_TICKS = 4` 的 transition 窗口，新进攻方持球者前插、全队前压，新防守方回撤并就近收缩。

#### Scenario: 抢断成功触发反击
- **GIVEN** 一次抢断成功（球权易主）
- **THEN** 触发 transition（固定 `TRANSITION_TICKS = 4`）：tackle 成功 tick 即武装 transition（全队前压/回撤立即生效），新持球者前插目标等松散球被拾取后激活；新进攻方队形前压，新防守方整体回撤并就近 2 名外场防守者向持球者收缩（close_down）

#### Scenario: 松散球期间 phase 沿用最后持球方
- **GIVEN** 球权易主后的松散球阶段（无人持球，新持球者尚未拾取）
- **THEN** 两队 phase 沿用最后持球方归属（新进攻方仍 attack、新防守方仍 defend），transition 窗口不因松散球中断；新持球者拾取后按球权刷新

#### Scenario: transition 期间高亮门控暂停
- **GIVEN** transition 进行中
- **THEN** 持球 hold 门控暂停（钉死为暂停这一种），transition 期间不再掷新高亮（保证反击窗口完整可见）

#### Scenario: transition 窗口结束
- **GIVEN** transition 窗口（4 tick）结束后
- **THEN** 每队回到 attack/defend 阶段（按球位置/持球方），队形目标恢复正常

### Requirement: 确定性

引擎 SHALL 保持种子确定性：同 seed 同 config → 同事件流（队形目标、阶段转换、movers 一致）。

#### Scenario: 阶段确定性
- **WHEN** 同 seed 两次模拟
- **THEN** phase 序列、transition 触发、队形目标完全一致
