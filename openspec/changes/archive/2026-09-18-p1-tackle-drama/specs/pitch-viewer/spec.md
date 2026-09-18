# Spec: pitch-viewer

## MODIFIED Requirements

### Requirement: 事件演绎遵循剧本

画面层 SHALL 按演绎剧本（连续带球（人球分离领先）、传跑配合、抢断五段式）渲染动作，实现人球解耦——人不是和球一起平移。

#### Scenario: 抢断演绎（五段式，带球中被抢）
- **GIVEN** 一条 tackle 事件，带 `subject`（防守者）、`to`（被铲者）、`x/y`（防守者起点）、`carrier_from_x/y`（被铲者带球起点）、`x2/y2`（接触点）、可选 `loose_x/y`（弹开点）、`result`
- **WHEN** 画面层演绎该事件
- **THEN** 被铲者从 `carrier_from` 带球到接触点，防守者同时从 `x/y` 逼近到接触点，碰撞后球向弹开点（优先引擎 `loose_x/y`，缺失则画面自算）弹出，按 `result` 决定捡球者（success=防守者 / fail=原持球人）。**画面层 SHALL 对 `carrier_from` 缺失做 fallback（原地持球）**；注意引擎当前置 `carrier_from == 接触点`（`x2/y2`），该带球段退化为零长度

#### Scenario: 抢断成功演绎（防守者拿球）
- **GIVEN** 一条 tackle 事件，`result=success`（非 demo 引擎事件恒带 `carrier`，走 v2 高亮路径；demo 流带 `to` 无 `carrier`，走 v1 兼容路径）
- **WHEN** 画面层演绎该事件
- **THEN** 球弹到弹开点后停在弹开点至高亮结束，随后由 beat.ball 接力：防守者追到弹开点与球汇合（拾取）；两球员终态 = 引擎结算终点 `subject_end`/`carrier_end`（缺省回退接触点）

#### Scenario: 抢断失败演绎（原持球人拿回）
- **GIVEN** 一条 tackle 事件，`result=fail`
- **WHEN** 画面层演绎该事件
- **THEN** 前两段（带球/逼近）同成功，双方在接触点对上；**球不弹开**——停在接触点（不产生松散球），被铲者回到 `carrier_end`（缺省回退接触点）继续持球，下一拍由 main 恢复；抢断者在 `subject_end` 停住

#### Scenario: 弹开方向与逼近方向垂直
- **GIVEN** 一条 tackle 事件且被铲者/防守者在场内（弹开点无需钳制）
- **WHEN** 画面层自算弹开点（引擎未给 `loose_x/y`）
- **THEN** 弹开向量与逼近向量点积为零（垂直）；两候选弹向按 `(tackler×7 + victim×3) % 2` 确定性选边（不消耗 RNG）

#### Scenario: 弹开点在场内
- **GIVEN** 一条 tackle 事件
- **WHEN** 画面层自算弹开点
- **THEN** 弹开点坐标落在 [0,1]×[0,1] 内（越界候选被钳制）

#### Scenario: 演绎确定性
- **WHEN** 同一事件重复演绎
- **THEN** 锚点序列完全一致

### Requirement: 演绎节奏配置化（S4 边界明确）

演绎节奏参数（phase 时长、人球分离量、抢断弹开参数）SHALL 放在配置文件，便于调参。**参数分工**：per-event 速度/提前量/触球频率 SHALL 来自事件载荷（事件值优先）；config SHALL 只放动画时序（phase 时长、人球分离量、弹开距离/速度/捡球停顿），不覆盖事件的速度/提前量/触球频率。

#### Scenario: 调整演绎节奏
- **WHEN** 开发者修改演绎节奏配置文件中**实际被读取**的参数（`dribble.separation`、`shot.keeperReactDelay`、`tackle.*`、`foul.cardShowDuration`）
- **THEN** 画面层的动作节奏随之变化，无需改代码。**注意**：`interpretation.pass.*` 与 `dribble` 的 `touchDuration/chaseDuration/windupDuration`、`shot.flightDuration`、`turnDuration` 当前**未被实现读取**（改之无效果）

#### Scenario: 调整抢断演绎节奏
- **WHEN** 开发者修改 `config.interpretation.tackle`（弹开距离/弹开球速/捡球停顿）
- **THEN** 抢断演绎的时序随之变化，无需改代码。**参数适用面**：`deflectSpeed`（球到弹开点的时长）对所有**带弹开段**的 tackle 演绎生效（v1 全部 + v2 success；v2 fail 无弹开段）；`deflectDistance` 仅在引擎未提供 `loose_x/y` 时用于画面自算弹开点；`collectDelay`（捡球反应停顿）仅在无 `carrier` 的旧版事件（v1 路径）生效——引擎事件恒给 `loose_x/y` + `carrier`，走 v2 高亮，不读这两项
