# event-stream-protocol Specification

## Purpose
TBD - created by archiving change p0-event-to-pitch. Update Purpose after archive.
## Requirements
### Requirement: 事件流是引擎与画面的唯一接缝

引擎 SHALL 将比赛模拟结果输出为事件流；画面 SHALL 只消费事件流来渲染，不访问引擎内部状态。

#### Scenario: 引擎产出事件流
- **WHEN** 引擎完成一次模拟
- **THEN** 输出是一个事件序列，每条事件遵循协议字段定义

#### Scenario: 画面只读事件流
- **WHEN** 画面层渲染一场比赛
- **THEN** 画面仅从事件流获取信息，不读取引擎内部状态

### Requirement: 事件字段定义

每条事件 SHALL 包含：t（比赛时间秒）、type（事件类型）、subject（主球员 id）、x/y（发生位置归一化坐标）。可选的派生字段（from/to、x2/y2、result、speed、touch_freq、lead、score、detail、note、interceptor、receiver_x/receiver_y、loose_x/loose_y、carrier_from_x/carrier_from_y、keeper_x/keeper_y、h、card）按事件类型使用（card 仅 foul 用：`yellow`/`red`）。出界 pass（`result="out"`）SHALL 额外携带 `out_side`（`goal_line`/`sideline`）与 `out_pos`（真实越界坐标，可越界）；`x2/y2` 保留场内投影点（∈[0,1]）。

#### Scenario: 出界 pass 携带显式出界字段
- **GIVEN** 一条出界 pass 事件
- **THEN** 事件含 `result="out"`、`out_side`（goal_line/sideline）、`out_pos`（真实越界坐标）；`x2/y2` 为场内投影点（∈[0,1]）

### Requirement: beat 节拍事件字段

beat 节拍事件 SHALL 描述一个 tick（1s）内所有在移动球员的并行动作，顶层不携带 subject/x/y（主体与位置嵌套在 main/movers/ball 内）。beat SHALL 携带：`movers`（并行跑位数组，增量——只含移动球员，`{id, from_x, from_y, to_x, to_y, speed, action}`）；持球者带球/控球时携带 `main`（`{type:'dribble', subject, x, y, x2, y2, speed, touch_freq}`，球轨迹由 main 驱动）；无持球者（抢断弹开等）时携带 `ball`（`{x, y, x2, y2, speed, loose:true}`，球由 beat.ball 驱动）。beat SHALL NOT 同时携带 main 与 ball（任意开放比赛时刻球有唯一驱动者）。

#### Scenario: 节拍含并行跑位
- **GIVEN** 一个 tick 时刻
- **WHEN** 引擎产出一条 beat 事件
- **THEN** 携带 `movers`（只含移动球员，静止球员不在其中）；持球者不出现在 movers（其移动只由 main 表达）

#### Scenario: 持球者带球由 main 表达
- **GIVEN** 持球者在带球/控球（无高亮事件）
- **WHEN** 引擎产出一条 beat 事件
- **THEN** 携带 `main`（球轨迹 x/y→x2/y2 + speed 驱动）；每个持球 tick 都发 main（含零位移控球）

#### Scenario: 松散球由 ball 表达
- **GIVEN** 无持球者（抢断弹开等）
- **WHEN** 引擎产出一条 beat 事件
- **THEN** 携带 `ball`（`loose:true`，含滚动轨迹），球由 beat.ball 驱动

#### Scenario: main 与 ball 互斥
- **WHEN** 引擎产出一条 beat 事件
- **THEN** 不同时含 main 与 ball（唯一驱动者）

### Requirement: pass 拦截字段（interceptor）

拦截 pass（`result=intercepted`）SHALL 携带 `interceptor`（断球方球员 id），画面层据此演绎"球被防守方截走"。引擎产出一条有向 pass 事件时，`result` SHALL 为 `success` / `intercepted` / `lost` / `out` / `contested` 之一（`out` = 出界；`contested` = 落点是争抢点的发球/门球，非出界）。

#### Scenario: 拦截事件携带拦截者
- **GIVEN** 一条 pass 事件且 `result=intercepted`
- **THEN** 事件含 `interceptor`（0-21 整数）；画面层排除拦截者与传球者的高亮冻结，原接球者照常跑位

#### Scenario: pass 结果枚举
- **WHEN** 引擎产出一条有向 pass 事件
- **THEN** `result` 为 `success` / `intercepted` / `lost` / `out` / `contested` 之一

#### Scenario: 出界 pass result 为 out
- **GIVEN** 一条出界 pass 事件
- **THEN** `result` 为 `out`（非 `contested`）

#### Scenario: 发球/门球 pass result 仍为 contested
- **GIVEN** 一条门球/角球发球 pass 事件
- **THEN** `result` 为 `contested`（落点是争抢点，非出界）

### Requirement: 事件类型枚举

事件流 SHALL 支持以下事件类型（非 demo 模式）：lineup（初始站位）、kickoff、whistle、pass、shot、tackle、foul（犯规/纪律牌）、beat（固定 tick 节拍）。goal 不设独立类型，由 shot 的 result=goal 表达；传球拦截由 pass `result=intercepted` 表达（不设独立 interception 事件）。demo_mode SHALL 保持 v1 事件驱动（含 dribble）。

#### Scenario: 枚举覆盖核心动作
- **WHEN** 画面层遇到事件流中的事件
- **THEN** 能按 type 识别为 lineup/kickoff/whistle/pass/shot/tackle/foul/beat 之一（demo_mode 另含 dribble）

#### Scenario: 拦截由 pass result 表达
- **WHEN** 一次传球被对方断下
- **THEN** 事件为 pass 且 result=intercepted、携带 interceptor；不产生独立的 interception 事件

#### Scenario: foul 事件字段
- **WHEN** 引擎产出一条 foul 事件
- **THEN** 事件含 `subject`（犯规者 id）、`x/y`（犯规点）、`detail`=`foul_<type>`、可选 `carrier`（被犯规持球者 id）与可选 `card`（`yellow`/`red`；缺省=无牌犯规）；任意球重开由 `pass detail=free_kick` 表达

#### Scenario: 进球由射门表达
- **WHEN** 一次射门得分
- **THEN** 事件为 shot 且 result=goal，不产生独立的 goal 事件

### Requirement: 球员 id 方案（B1/S1 修复）

事件流 SHALL 使用固定 id 方案：球员 id 0-10 = 主队（home），11-21 = 客队（away），画面层据 id 区分主客队颜色。

#### Scenario: 主客队颜色区分
- **WHEN** 画面层渲染球员圆点
- **THEN** id 0-10 渲染为主队颜色，11-21 渲染为客队颜色

### Requirement: 初始站位消息（B1 修复）

事件流 SHALL 在开头发出一条初始站位消息（扩展 kickoff 或新增 lineup 事件），携带 22 个 {id, team, x, y} 的初始位置，使画面层能从事件流获知所有球员的初始站位，不依赖引擎外部状态。

#### Scenario: 画面层渲染初始阵容
- **WHEN** 画面层收到事件流开头的初始站位消息
- **THEN** 据此渲染 22 个球员的初始位置，随后按事件流更新

### Requirement: 坐标系统

事件坐标 SHALL 使用球场归一化坐标（0-1），朝向中立（x=0 是左门线，不区分主客队左右）；画面层按需翻转朝向。

#### Scenario: 画面层映射坐标
- **WHEN** 画面层渲染事件位置
- **THEN** 将归一化坐标乘以画布尺寸得到屏幕坐标，方向翻转由画面层处理

### Requirement: 协议与序列化分离

事件流协议（字段定义、类型枚举）SHALL 与序列化格式解耦；P0 用 JSON 序列化，将来可换紧凑格式而不改协议。

#### Scenario: 序列化可替换
- **WHEN** 需要更换事件流序列化格式（如 JSON → 二进制）
- **THEN** 字段定义与事件类型不变，仅序列化实现变化

### Requirement: 演绎参数由引擎提供

pass/dribble/shot 事件的演绎参数（speed、touch_freq、lead）SHALL 由引擎输出，画面层不自行推断。

#### Scenario: 画面使用引擎参数演绎
- **WHEN** 画面层演绎带球/传球/射门动作
- **THEN** 使用引擎提供的速度、触球频率、提前量参数，不自行猜测

### Requirement: tackle 字段定稿（必填 to/carrier + x2/y2 + 新增可选字段）

tackle 事件 SHALL 携带被铲者身份（v2 `carrier`，v1 兼容 `to`）与接触点 `x2/y2`（**必填**，定稿）；SHALL 可选携带 `loose_x/loose_y`（弹开点）、`carrier_from_x/carrier_from_y`（被铲者带球起点）、`subject_end_x/subject_end_y`（抢断者结算终点）、`carrier_end_x/carrier_end_y`（被抢者结算终点）。

#### Scenario: tackle 必填字段
- **GIVEN** 一条 tackle 事件
- **THEN** 必须含 `to` 或 `carrier`、`x2`、`y2`（被铲者与其接触点）；缺失时协议校验抛错

#### Scenario: tackle 可选字段
- **WHEN** 引擎产出一条 tackle 事件
- **THEN** 可携带 `loose_x/loose_y`（弹开点）、`carrier_from_x/carrier_from_y`（被铲者带球起点）；画面层对缺失字段 fallback

#### Scenario: 抢断结算空间分离终点
- **WHEN** 引擎产出一条 v2 tackle 事件
- **THEN** 可携带 `subject_end_x/subject_end_y` 与 `carrier_end_x/carrier_end_y`（抢断者/被抢者高亮结算终点）；二者间距 ≥ 最小间隔（约 0.03，观感不重合）；画面层按各自终点画两球员

#### Scenario: 向后兼容
- **WHEN** 画面层收到缺可选字段的旧版 tackle 事件
- **THEN** 仍能解析并演绎（缺 `loose`→画面自行算弹开点；缺 `carrier_from`→被铲者原地带球；缺结算终点→两球员回退接触点）

### Requirement: 门将开大脚高亮（无 to 长球）

门将开大脚（门球）SHALL 以高亮事件表达：球从门将当前位置（门线附近）飞到中场落点，携带球轨迹（x/y→x2/y2+speed）；无明确接球者（落点是争抢点），`to` 可不携带。

#### Scenario: 开大脚无 to
- **GIVEN** 一条门将开大脚高亮事件
- **THEN** 携带球轨迹（x/y→x2/y2+speed）；`to` 不要求（复用 kickoff 形态的事件驱动球，或 pass 高亮 to 可选）

#### Scenario: 球到达落点进入松散球
- **GIVEN** 门将开大脚球到达落点
- **THEN** 后续 beat 携带 `ball`（`loose:true`）——落点无人持球，双方可争（同 P4 save-rebound 模式）

### Requirement: 出界 detail 表达

**pass 事件** SHALL 在出界时携带 detail 表达出界类型（`out_sideline` / `out_goal_line`），坐标仍钳制 [0,1]；出界 pass 的 to=None（落点是出界点，无接球者）。**射门出界不额外加 detail**（打偏由 result=`off_target` 表达门球；扑出越线由 CornerAward 高亮结局表达角球，见 match-engine spec）。

#### Scenario: 出界 pass detail
- **GIVEN** 一次出界传球
- **THEN** pass 事件 detail=`out_sideline` 或 `out_goal_line`；坐标 [0,1]；to=None

#### Scenario: 射门出界不加 detail
- **GIVEN** 一次射门出界（打偏/被扑出底线）
- **THEN** shot 事件不加 out_goal_line detail（result=off_target → 门球；扑出越线 → CornerAward 高亮结局 → 角球）

#### Scenario: 出界 pass 无接球者
- **GIVEN** 一次出界传球
- **THEN** to=None（无接球者，落点是出界点）——参照门球开大脚无 to 先例

### Requirement: 头球 detail

头球 SHALL 以 detail 表达：头球射门 = shot 事件 detail=`header`；头球解围 = pass 事件 detail=`clearance`（复用 shot/pass，不新增类型）。

#### Scenario: 头球射门
- **GIVEN** 一次头球射门
- **THEN** shot 事件 detail=`header`，携带射手/落点/result

#### Scenario: 头球解围
- **GIVEN** 一次头球解围
- **THEN** pass 事件 detail=`clearance`，顶出禁区

#### Scenario: 头球摆渡
- **GIVEN** 攻方赢得角球争抢后头球摆渡给队友
- **THEN** pass 事件无 detail、h=0（普通 pass，viewer 按普通传球演绎，球不放大）

### Requirement: 球高度 h 字段

事件流 SHALL 支持可选字段 `h`（归一化 0-1，球高度）——pass/shot 高亮带弧线高度，viewer 用球大小表示（FM 做法，P6 首批已实现）。**h 语义**：h 缺失（undefined）→ viewer 按飞行时长/距离默认插值（向后兼容）；h=0 → 明确无高度（球不放大）；h>0 → 有高度（球放大）。

#### Scenario: 带高度
- **GIVEN** 一次长球（角球发球/门球开大脚 h>0 0.5-0.8；普通中长传 >20m h>0 0.2-0.4）
- **THEN** pass 事件带 h>0（球飞起）

#### Scenario: 无高度（h=0）
- **GIVEN** 一次短传（界外球掷球/头球解围/头球摆渡/头球射门/普通短传 ≤20m）
- **THEN** pass/shot 事件 h=0（球不放大，明确无高度）

#### Scenario: h 缺失向后兼容
- **GIVEN** 一次 pass/shot 不带 h（旧事件流，或**普通射门**——`emit_shot_highlight` 恒不带 h）
- **THEN** viewer 按飞行时长/距离默认插值（不回归）

### Requirement: 角球发球 detail

角球发球 SHALL 以 pass 事件 detail=`corner` 表达（viewer 据此识别角球发球，不靠起点推断）。**detail 校验按事件类型限定**（pass 校验 out_sideline/out_goal_line/corner/clearance/throw_in/free_kick、shot 校验 header），不校验 whistle/kickoff 等既有 detail。

#### Scenario: 角球发球带 corner
- **GIVEN** 一次角球发球
- **THEN** pass 事件 detail=`corner`，起点=角旗区、落点=禁区附近、h>0、to=None（落点是争抢点）

### Requirement: 重开准备期球锚点

角球/界外球发球准备期（RestartPrep，**指判定 tick 之后的每个准备 tick**——判定 tick 本身不产 beat，见 match-engine 的 beat 间隔不变量）SHALL 产 beat 事件表达球停在固定点等待发球：beat.ball = 静止锚点（x==x2 且 y==y2，loose=true），坐标=角旗区/出界点；movers 含发球者/掷球者走向固定点的走位（**发球者已在固定点、其余球员均在静区内时该拍 movers 可为空**——dead-zone 吞掉位移 < 2m 的走位）。发球高亮起点=同一固定点，viewer 连续播放无球瞬移。

#### Scenario: 准备期球停固定点
- **GIVEN** 一次角球/界外球发球准备期（判定 tick 之后的准备 tick）
- **THEN** beat.ball 静止在角旗区/出界点（x==x2、y==y2），发球者/掷球者 mover 走向固定点；发球 pass 起点=同一固定点

