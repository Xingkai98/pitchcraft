## MODIFIED Requirements

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
- **AND** 本改动 SHALL NOT 改 `GK_SPEED_MS`、`DEAD_ZONE_METERS`、`keeper_return` 这个 action 名、
  同队间距分离，或任何其它常量。
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
- **WHEN** 每 tick 更新目标
- **THEN** 移动受速度上限约束；位移小于静区阈值时不移动（静区绑定单一常量 `DEAD_ZONE_METERS`——P4 起的同一个门、非新引入；P7 由 0.5m 放大到 **2.0m**，到位后目标微变不追，避免球门旁来回小幅摆动；门将同受此静区约束）；目标点间距约束（repulsion，作用域 = 同队内部，在队形/close_down 目标后施加最小间距修正；**最小间距 = `SAME_TEAM_MIN_DIST_M` = 2.2m，米制**——P34（#53）起判定与推开都走米制（`same_team_dist_m` + `separate_pair_m`），与 detector `player_overlap` 口径一致；旧归一化欧氏口径在 105×68 球场上 y 方向只保证 1.36m。间距 < 阈值的同队球员对沿连线推开至阈值，确定性迭代 ≤3 次；carrier 不参与 repulsion——其位置由 main 带球轨迹决定），避免两圆点重叠；运算顺序：先 dead-zone 判定，后 approach-rate cap 限幅

