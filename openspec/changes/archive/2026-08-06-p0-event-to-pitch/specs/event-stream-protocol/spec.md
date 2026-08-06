# Spec: event-stream-protocol

## ADDED Requirements

### Requirement: 事件流是引擎与画面的唯一接缝

引擎 SHALL 将比赛模拟结果输出为事件流；画面 SHALL 只消费事件流来渲染，不访问引擎内部状态。

#### Scenario: 引擎产出事件流
- **WHEN** 引擎完成一次模拟
- **THEN** 输出是一个事件序列，每条事件遵循协议字段定义

#### Scenario: 画面只读事件流
- **WHEN** 画面层渲染一场比赛
- **THEN** 画面仅从事件流获取信息，不读取引擎内部状态

### Requirement: 事件字段定义

每条事件 SHALL 包含：t（比赛时间秒）、type（事件类型）、subject（主球员 id）、x/y（发生位置归一化坐标）。可选的派生字段（from/to、x2/y2、result、speed、touch_freq、lead、score、detail、note）按事件类型使用。

#### Scenario: 基础字段必填
- **WHEN** 引擎产出一条事件
- **THEN** 事件包含 t、type、subject、x、y 字段

### Requirement: 事件类型枚举

事件流 SHALL 支持第一版 8 类事件：kickoff、whistle、pass、dribble、shot、tackle、interception、substitution。goal 不设独立类型，由 shot 的 result=goal 表达。

#### Scenario: 枚举覆盖核心动作
- **WHEN** 画面层遇到事件流中的事件
- **THEN** 能按 type 识别为 kickoff/whistle/pass/dribble/shot/tackle/interception/substitution 之一

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
