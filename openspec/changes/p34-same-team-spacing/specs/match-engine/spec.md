# Spec: match-engine

## ADDED Requirements

### Requirement: 同队球员间距（≥2m）

引擎 SHALL 使同队两球员在引擎发射的任意位置采样点（lineup 初始站位、mover 终点 `to_x/to_y`、main 终点 `x2/y2`、以及模拟状态位置 `st.pos`）上的**米制**间距 ≥ 2m（阈值常量 `SAME_TEAM_MIN_DIST_M` = 2.2m，含 JSON 4 位小数序列化与 0.5s 采样插值的安全余量）。间距 SHALL 用真实米制几何计算（x 方向 × 105、y 方向 × 68），SHALL NOT 用归一化欧氏距离（归一化圆在 105×68 球场上 x 方向 2.1m、y 方向仅 1.36m）。分离 SHALL 覆盖 carrier、门将、特殊站位（角球包抄 / close_down / chase / anticipate）与 dead_zone 停者；由事件直接指定的终点（传球接球点 / 门将扑救点 / 抢断结算点 / 开球落点 / 松散球拾取点）SHALL 在写入状态前经同一分离。分离 SHALL 为纯函数：零额外 RNG、固定遍历顺序、不改变事件类型/频率的判定逻辑。拍内插值中点 SHALL 由 viewer 侧 `player_overlap` detector 观测（不在引擎预计算每段中点推开）。

#### Scenario: 整场无同队重叠
- **GIVEN** 引擎以多 seed 模拟整场比赛
- **THEN** 每个 tick 的同队两两米制距离 SHALL ≥ `SAME_TEAM_MIN_DIST_M - ε`（ε 为浮点容差）；lineup 初始站位、mover 终点、main 终点均满足

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
- **GIVEN** 两名同队球员某一拍的线性轨迹（`from`→`to`，viewer 在锚点间线性插值）在中途 <2m
- **THEN** 引擎 SHALL 对整条轨迹施加约束（侧向推移终点），使中点间距亦 ≥ 2m − 舍入余量；推移量 SHALL 有界（≤ 该球员本拍步长），超限时留给下一拍而非横甩

#### Scenario: 分离位移有界
- **GIVEN** 引擎产出的任一 beat
- **THEN** 每个 mover 的单拍位移 SHALL ≤ 其 `speed × 1s` + `SAME_TEAM_MIN_DIST_M`（多轮扫掠的累积有界，不得横穿球场）

#### Scenario: 零 RNG 确定性
- **WHEN** 同 seed 同 config 两次模拟
- **THEN** 事件流（含分离后的坐标）完全一致（由 golden master 全流哈希守护）

#### Scenario: 跨队不适用
- **GIVEN** 抢断瞬间防守者与被抢者（跨队）结算到 `subject_end/carrier_end`
- **THEN** 该跨队分离 SHALL NOT 受同队 2m 约束（同队间距只作用于同队 pair）

#### Scenario: 状态与事件一致
- **GIVEN** 任一 tick 结束
- **THEN** 每名未罚下球员的 `st.pos` SHALL 等于其最近一次发射位置（`last_emitted`），不得出现状态与 viewer 所见错位
