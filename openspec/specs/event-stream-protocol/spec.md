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

事件流 SHALL 支持第一版 8 类事件：kickoff、whistle、pass、dribble、shot、tackle、interception、substitution，另加 foul（犯规/纪律牌）。goal 不设独立类型，由 shot 的 result=goal 表达。

#### Scenario: 枚举覆盖核心动作
- **WHEN** 画面层遇到事件流中的事件
- **THEN** 能按 type 识别为 kickoff/whistle/pass/dribble/shot/tackle/interception/substitution/foul 之一

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

