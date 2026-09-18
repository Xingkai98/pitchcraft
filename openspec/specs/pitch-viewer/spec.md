# pitch-viewer Specification

## Purpose
TBD - created by archiving change p0-event-to-pitch. Update Purpose after archive.
## Requirements
### Requirement: Canvas 渲染圆点球场

画面层 SHALL 使用 JS + Canvas 渲染俯视球场，球员画为圆点（两队不同颜色，门将可区分），球画为小圆点。

#### Scenario: 渲染球场
- **WHEN** 画面层初始化
- **THEN** 在 Canvas 上绘制草地与球场白线（边线、中线、中圈、禁区）

#### Scenario: 渲染球员与球
- **WHEN** 画面层收到事件流
- **THEN** 按事件位置渲染 22 个球员圆点与球，主客队颜色不同

### Requirement: 消费事件流播放比赛

画面层 SHALL 按事件流的 t 推进播放时刻，把事件演绎成动画，形成连续比赛画面。

#### Scenario: 播放事件流
- **WHEN** 画面层收到一条事件流
- **THEN** 按时间顺序播放，画面随时间推进显示球员移动、传球、射门等动作

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

### Requirement: 第一版做简单演绎

P0 画面层 SHALL 只做简单演绎：带球不变向、传球直线（不做外弧），先验证链路。

#### Scenario: 直线直传
- **WHEN** 画面层演绎传球/带球
- **THEN** 球沿直线移动，不做外弧/变向（第一版）

### Requirement: 比赛时长是单一可配置参数，界面不提供切换

画面层 SHALL 将比赛内容时长实现为单一可配置参数（当前值为 5 分钟），并在初始化时按该参数请求引擎模拟；界面 SHALL 不提供时长切换入口。改配置值即改比赛时长，无需改画面层逻辑。

#### Scenario: 按配置的时长模拟
- **GIVEN** 配置 `playback.matchDuration` 为 5
- **WHEN** 页面初始化并加载引擎
- **THEN** 以 5 分钟（300 秒）为 `match_duration_seconds` 调用引擎模拟

#### Scenario: 界面无时长切换入口
- **GIVEN** 页面已加载
- **WHEN** 用户查看播放控制区
- **THEN** 不存在「切换比赛时长」的按钮或控件

#### Scenario: 改配置即改时长
- **GIVEN** 开发者将配置 `playback.matchDuration` 改为 90
- **WHEN** 页面重新初始化
- **THEN** 以 90 分钟调用引擎模拟，无需修改画面层代码逻辑

### Requirement: 门将开大脚演绎

画面层 SHALL 演绎门将开大脚：球从门将当前位置（门线附近）飞到中场（高亮事件插值），落点进入松散球后按 `beat.ball` 滚动 + 双方球员追逐（复用 P4 松散球演绎）。

#### Scenario: 开大脚球飞行
- **GIVEN** 一条门将开大脚高亮事件
- **WHEN** 画面层播放该段
- **THEN** 球从门将当前位置（门线附近）沿事件轨迹飞向中场（高亮演绎）；无接球者动画（球落点为争抢点）

#### Scenario: 中场争抢
- **GIVEN** 门将开大脚球到达落点（松散球 loose:true）
- **WHEN** 画面层播放该段
- **THEN** 双方球员追逐球（`nearest_any` 双方可争），最近者拾取后恢复 main 带球

### Requirement: 进球视觉区分 + 球直接回中圈

画面层 SHALL 区分 goal / saved / off_target 的球终态：goal 球心刚过门线停在网内（不飞过球门）；saved 停事件终点的门线位置；off_target 飞过球门出界。进球确认后球 SHALL 直接出现在中圈（不做"从门内滚回中圈"过渡）。

#### Scenario: goal 停在网内
- **GIVEN** 一条 shot result=goal
- **WHEN** 画面层播放该段
- **THEN** 球越过门线停在网内（球心 x=1.005，反方向 −0.005：球体完全越线但不飞过球门）并明显停留；门将扑向射门侧但未够到

#### Scenario: saved 停门线 / off_target 飞过球门
- **GIVEN** 一条 shot result=saved 或 off_target
- **WHEN** 画面层播放该段
- **THEN** saved 球停在事件给定终点 `x2`（门线附近）；off_target 球飞过球门出界（球心 x=1.02 / −0.02，y 偏离球门由引擎给）

#### Scenario: 进球球直接回中圈
- **GIVEN** 一次进球确认
- **WHEN** 画面层播放该段
- **THEN** 球从门内直接跳到中圈（瞬移，无"从门内滚回中圈"过渡锚点）；开球者走向中圈开球

### Requirement: 角球演绎

画面层 SHALL 演绎角球：长角球从角旗区飞向禁区落点（pass 高亮 + 高度 h，球大小表示高度），落点松散球禁区争抢（攻防各 1 名双追逐），头球射门/解围复用 shot/pass 高亮。

#### Scenario: 角球发球
- **GIVEN** 一次角球（pass 事件 detail=`corner`，发球者已走位到角旗）
- **WHEN** 画面层播放该段
- **THEN** 球从角旗区飞向禁区落点（h>0，球变大表示高度），落点松散球攻防双方各 1 名追逐争抢

#### Scenario: 角球站位
- **GIVEN** 角球发球准备期（RestartPrep，球停在角旗）
- **WHEN** 画面层播放该段
- **THEN** 发球者走向角旗区（球在角旗等待，无瞬移）；攻方全队压入禁区贴门线一侧、防方全队退入本方禁区前沿一侧（引擎 `corner_setup_target` 产出的 movers），movers 呈现站位

#### Scenario: 头球射门
- **GIVEN** shot detail=`header`（头球射门）
- **WHEN** 画面层播放该段
- **THEN** 球从争抢点飞向球门（shot 高亮），可进球/被扑/打偏

#### Scenario: 头球解围
- **GIVEN** 一次头球解围（pass detail=clearance 顶出禁区）
- **WHEN** 画面层播放该段
- **THEN** 球从禁区顶出到禁区外（低高度），落点松散球重新争

### Requirement: 界外球演绎

画面层 SHALL 演绎界外球：对方从边线掷向附近队友（pass 高亮，短传无高度 h=0）。

#### Scenario: 界外球掷球
- **GIVEN** 一次界外球
- **WHEN** 画面层播放该段
- **THEN** 掷球者先走向边线出界点（准备期，球停在出界点），再从边线短传掷向附近队友（h=0，球不放大），队友接球后恢复持球

### Requirement: 出界视觉

画面层 SHALL 在球出界时呈现球飞到边线/底线（坐标钳制到边缘），随后进入对应重开。

#### Scenario: 出界球飞向边界
- **GIVEN** 一次出界（detail=out_sideline/out_goal_line）
- **WHEN** 画面层播放该段
- **THEN** 球飞向边线/底线（钳制到边缘），停住后进入对应重开（角球/界外球/门球）

### Requirement: 球高度 h 大小表示

画面层 SHALL 用球大小表示高度（FM 做法，P6 首批已实现）：pass/shot 事件带 h 时，球按 h 放大/恢复。**h 缺失（undefined）→ 按飞行时长/距离默认插值（向后兼容）；h=0 → 基础半径（无高度）**。

#### Scenario: 高度变化
- **GIVEN** 一次 pass/shot 带 h>0
- **WHEN** 画面层播放该段
- **THEN** 球在飞行中点按 h 放大（半径 ×(1+h×1.5)，h∈[0,1]），落地恢复基础大小

#### Scenario: h 缺失向后兼容
- **GIVEN** 一次 pass/shot 不带 h（旧事件流）
- **WHEN** 画面层播放该段
- **THEN** 球按飞行时长/距离默认插值高度（P6 首批现有行为，不回归）

#### Scenario: h=0 无高度
- **GIVEN** 一次界外球掷球/头球解围/头球摆渡/头球射门（h=0）
- **WHEN** 画面层播放该段
- **THEN** 球用基础半径（无放大），表示无高度短传/低空头球

### Requirement: 静止球员 micro-motion

画面层 SHALL 给静止球员（不在 beat movers、不在高亮参与者、**不是 main 持球者**）做小幅重心调整（micro-motion），避免圆点完全冻结；该调整仅影响渲染层，不改变逻辑位置。

#### Scenario: 静止球员微动
- **GIVEN** 一名球员静止（不在 movers/高亮参与者/main 持球者）
- **WHEN** 画面层渲染该球员
- **THEN** 在逻辑位置做小幅重心调整（振幅 < 0.002 归一化），逻辑位置不变；**启停时振幅从 0 渐变（fade in/out ~0.3s），避免微动开始/结束瞬间的渲染跳变**

#### Scenario: 微动确定性且连续
- **GIVEN** 同一播放时刻重放
- **THEN** 微动偏移一致：A/φ/T 由 `hash(id)` 一次派生并缓存（球员级常量，非每帧随机）；t 连续推进（不 floor 到 tick），偏移 = `(A·sin(w), A·cos(w))`，`w = 2π·t/T + φ`（x 用 sin、y 用 cos，形成小幅环动；去冗余相位 t0，由 φ 吸收），tick 边界无跳变

#### Scenario: 移动中抑制微动
- **GIVEN** 一名球员正在移动（movers 或高亮参与者）或为 main 持球者
- **THEN** 不做微动（避免与移动叠加、人球分离）；**抑制切换用启停渐变（进入抑制淡出、退出淡入 ~0.3s），避免移动/静止切换瞬间的渲染跳变**

#### Scenario: 高亮参与者回溯识别
- **GIVEN** 引擎的高亮事件与同 tick 的 beat 存在**三种相对位置**：pass/shot 的 beat 在**同 tick 之后**（遮蔽「当前事件索引」）、tackle 的 beat 在同 tick **之前**（不遮蔽）、foul **不产 beat**（无锚点，`_eventEnds` 回落 `e.t`）
- **WHEN** 画面层判定某球员是否为高亮参与者
- **THEN** SHALL 按**事件窗口**回溯查找覆盖当前播放时刻的高亮事件（事件 `t` → 其锚点最长 `t`；**foul 的语义窗口取纪律牌显示时长**），而非直接取当前事件索引——否则 pass/shot 的参与者集合恒为空、抑制失效（issue #81 实测：不回溯时约 98% 高亮帧未抑制，且 foul 因窗口零长度失效）

### Requirement: 微动不影响无 snap

micro-motion SHALL 不改变逻辑位置，不影响跨拍连续（from(N+1)==to(N)）与无 snap 验证。

#### Scenario: 逻辑位置不变
- **WHEN** 渲染带微动的静止球员
- **THEN** 其逻辑位置与 beat 数据一致（微动仅渲染偏移）

