# Spec: match-engine

## ADDED Requirements

### Requirement: 无球球员的目标点 SHALL 以球为原点组织（球导向跑位）

引擎 SHALL 使无球球员的目标点由「角色基准 + 球侧平移」改为**以球为原点的相对块**：块心随球纵向
牵引、块内角色铺开、并叠一路**确定性**个体抖动——以便消除「球员在水平细线上滑行」的观感，
且 SHALL NOT 依赖 RNG（抖动是 `id` 与停滞秒数的纯函数）。

目标点 SHALL 是旧式与新式的**加权混合**（弱化档），SHALL NOT 直接用强档——强档与传球选择叠加
会反转主客进球方向。

#### Scenario: 轨迹不再是水平细线（形态判据，先看图）

- **GIVEN** 引擎以 seed42 渲 5 分钟轨迹图（`tools/visual-review/trajectory.mjs`，用户尺度）
- **THEN** 轨迹 SHALL 呈现**斜向/纠缠弧线**，SHALL NOT 是基线那样的水平细线
- **AND** 该判据 SHALL 先由人/模型**读图**确认，再引数值

#### Scenario: 弱化档参数

- **GIVEN** `formation_target` 的球相对块实现
- **THEN** 混合权重 SHALL 为 `FORM_MIX_X=0.5` / `FORM_MIX_Y=0.7`，
  铺开度 `FORM_SPREAD_X=0.8` / `FORM_SPREAD_Y=1.3`，个体抖动 `FORM_INDIV=0.08`
- **AND** 这些值 SHALL 与 `design.md` §D2 的硬前沿表一致（弱化档是 ratio×home 轴上的折中）

### Requirement: 防守方 SHALL 在开放局对持球者实施逼抢

引擎 SHALL 在非 transition 的开放局指派离球最近的 N 名防守外场**逼近持球者**并停在
`OPEN_PRESS_STOP_DIST` 处（≈5m），SHALL 受半场门控（仅球在防守方本方半场时逼抢）。

出球档阈值 `OPEN_PLAY_PASS_PRESSURE_M` SHALL 小于逼抢停距（8m→4m）——否则持球者恒判「被逼抢
→ 出球」，射门推进档永久不可达（射门被逼抢锁死）。这是本层与事件密度层共存的**必要条件**。

#### Scenario: 防守方上前（接触表可辨）

- **GIVEN** 引擎以 seed42 渲 5 分钟 contact-sheet（`tools/visual-review/contact-sheet.mjs`）
- **THEN** 每窗 SHALL 可见球附近的防守方**贴身**，SHALL NOT 是隔 10m 观望

#### Scenario: 逼抢不锁死射门

- **GIVEN** 引擎以 200 seed × 90 分钟模拟（seeds 401..600）
- **THEN** 普通射门/场 SHALL 落在既有带 `[14,29]` 内（`l1_shot_result_distributions` 绿）

### Requirement: 事件密度 SHALL 抬到真实量级（决策节奏 ~2 tick）

引擎 SHALL 把行动机会 deadline 基线与下界压到 2 tick、liveness 三档阈值压到 2/4/7 秒——
以便产生「球在场上传动」而非「球被钉住」的观感。停滞（liveness 二档）SHALL 先经过一次
射门推进评估再改选出球（`SHOT_FIRST`），SHALL NOT 直接把停滞判为出球（那会锁死推进路径）。
带球档 SHALL 有小概率（`CIRCULATION_PASS_P`）主动转向传球。

#### Scenario: 传球量抬到真实量级

- **GIVEN** 引擎以 200 seed × 90 分钟模拟
- **THEN** 传球成功率 SHALL 落在既有带 `[0.82,0.90]`（`l1_pass_completion_rate` 绿）
- **AND** 顶层事件（pass+shot+tackle）/场 SHALL 落在 `[600,1400]`（真实锚 ~860-1060）

### Requirement: 传球目标 SHALL 由价值函数选择（含反乒乓记忆）

引擎 SHALL 在多候选队友里按**价值函数**选传球目标（前向推进 / 落点开阔度 / 短传偏好 /
前方空当 / 「正好在前方」奖励 / **反乒乓记忆**），替代「传最近队友」。反乒乓项 SHALL 使
「上一次传球的有向对反转为本次候选」时扣分——以消除「两人对倒」的观感缺陷。

选目标 SHALL 是**零 RNG**的纯几何函数（不改变 RNG 消费序列）。

#### Scenario: 不再两人对倒

- **GIVEN** 引擎以 seed42 播 5 分钟（`tools/visual-review/viewer-match.mjs`）
- **THEN** 事件流 SHALL 出现球权在不同球员/队之间的转换，SHALL NOT 是两前锋对倒

#### Scenario: 传球成功率的联合守护

- **GIVEN** 200 seed × 90 分钟（seeds 401..600）
- **THEN** 整体传球成功率 SHALL ∈ `[0.82,0.90]`，拦截占失败比例 SHALL ∈ `[0.55,0.90]`

### Requirement: 对抗成败 SHALL 按几何决定（sigmoid）

引擎 SHALL 使抢断成败由「贴身度 + 迎面逼近 − 坏角度」的 sigmoid 决定，替代平抛 0.5——
使技术好的防守者（正面贴身）成功率更高、背后回追者更低。

约束：抢断**体量**带 `[24,50]`/场 SHALL 由 `BASE_DEF_TACKLE` 承载（几何化只改成败比、不改次数）；
整体 success 率 SHALL 仍落在 `[0.42,0.58]`。

#### Scenario: 抢断体量与成功率

- **GIVEN** 200 seed × 90 分钟（seeds 401..600）
- **THEN** 抢断/场 SHALL ∈ `[24,50]`，整体 success SHALL ∈ `[0.42,0.58]`

## MODIFIED Requirements

### Requirement: 射门与抢断的体量带（L1 体积，真实量级）

引擎 SHALL 使普通射门与抢断的**绝对体量**对齐真实联赛量级（多 seed ≥200 聚合）。
本 requirement 取代先前隐含在 `l1_shot_result_distributions` / `l1_tackle_dilution_and_slot_mix`
里的**压缩态体量带**（原射门带 `[6,11]`、原单场角球上界 `12`）——那些带的语义是
「引擎无二次进攻链，射门设计上低于真实」，该前提已被 #104 证伪（射门体量只是一个可调常量）。

**带的推导 SHALL 来自真实侧分布，SHALL NOT 照引擎现状配**（「按现状标定」是本 requirement 要消除的对象）。
推导口径：真实侧样本按 90 分钟归一、**逐场算再平均**，带 = `mean ± 1.5·sd`。

体量 SHALL 由**既有常量**产生（射门频率 `OPEN_PLAY_SHOT_ENGAGE_SHIFT`、抢断倾向
`BASE_DEF_TACKLE`、犯规倾向 `BASE_DEF_FOUL`），SHALL NOT 依赖任何事件类型配额或固定节拍；
抢断的抬升 SHALL 与射门一起做（`volume-compensation.md` §2.4：体积是一组缺口，
只抬射门会让 shot/tackle 越界）。

**p143r-v4 增补**：四层机制（球导向跑位 / 开放局逼抢 / 事件密度 / 传球选择+对抗几何）叠加后，
射门与抢断的**联合常数**须比任一单层更深（接触机会 × 贴身相乘）——取
`BASE_DEF_TACKLE = −0.86` / `BASE_DEF_FOUL = −0.19` / `OPEN_PLAY_SHOT_ENGAGE_SHIFT = −4.15`。
**实测硬前沿**：`shot/tackle ≥ 0.5` 与「主队进球 > 客队进球」是**同一根轴的两端**，
在本四层组合下不可兼得（`design.md` §D2 有扫描表）——本 change 取「保主场优势」侧，
代价是 `shot/tackle = 0.484`（差下界 3.15%）。是否重标定 ratio 下界 / 改 home 优势通道
SHALL 作为**用户级决策**上报，本 change SHALL NOT 自行改带。

#### Scenario: 普通射门体量
- **GIVEN** 引擎以 200 个 seed × 90 分钟模拟（seeds 401..600）
- **THEN** 普通射门（非头球）`shot` 事件 / 场 SHALL ∈ **[14, 29]**
  （推导：StatsBomb Open Data 大五联赛子集 n=170，mean **21.64** / sd **5.03**，`mean ± 1.5·sd` = [14.09, 29.18]）
- **AND** p143r-v4 实测读数 SHALL 落带内（p143r-v4 实测 **22.2**）

#### Scenario: 抢断体量
- **GIVEN** 引擎以 200 个 seed × 90 分钟模拟
- **THEN** `tackle` 事件 / 场 SHALL ∈ **[24, 50]**
  （推导：同上的大五子集 n=170，`Duel` 中 `type=="Tackle"`，mean **36.90** / sd **8.87**，`mean ± 1.5·sd` = [23.60, 50.21]）
- **AND** 口径对齐：StatsBomb `Duel/Tackle` 含**成功与失败两态**（`Success In Play`/`Success Out`/`Lost In Play`/`Lost Out`），
  与引擎 `tackle` 事件（`TACKLE_SUCCESS_RATE=0.5`，两态）**同口径**；
  WhoScored 的「~30（15-17/队）」是**成功抢断**口径，SHALL NOT 作为本带的依据

#### Scenario: 单场角球上界（数量级护栏）
- **GIVEN** 引擎以 **200** 个 seed × 90 分钟模拟（seeds 401..600，与 `l1_tackle_dilution_and_slot_mix`
  的 L1 窗口一致——这是**运行时门的口径**）
- **THEN** 单场 `detail="corner"` 的 pass 计数 SHALL ≤ **15**
- **AND** 本上界的语义 SHALL 是「不塌缩 / 不爆炸」的**数量级护栏**，SHALL NOT 被当作真实拟合

#### Scenario: 体积抬升不引入崩溃
- **GIVEN** 引擎以 200 个 seed × 90 分钟模拟
- **THEN** `crashedSeeds` SHALL = 0

#### Scenario: shot/tackle 比值与主客进球方向（p143r-v4 边际，决策项）
- **GIVEN** 引擎以 200 个 seed × 90 分钟模拟（seeds 401..600，`l1_tackle_dilution_and_slot_mix`）
- **THEN** `shot/tackle` 比值 SHALL ∈ **[0.5, 1.5]** —— **p143r-v4 实测 0.484（差下界 3.15%），
  为已知边际红**；抢断体量（45.8 ∈ [24,50]）与 overall success（∈[0.42,0.58]）SHALL 绿
- **AND** 主客进球（`l1_home_away_goal_asymmetry`，600 seed 401..1000）SHALL 满足
  主队 1.475 > 客队 1.425 且主队 ∈ [0.85,1.60]
- **AND** 两者**不可兼得**的证据（`BASE_DEF_TACKLE` 扫描表）SHALL 保留在 `design.md` §D2；
  取舍 SHALL 由用户拍板，SHALL NOT 以「放宽某一带」自行消红
