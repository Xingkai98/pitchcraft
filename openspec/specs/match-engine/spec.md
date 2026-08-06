# match-engine Specification

## Purpose
TBD - created by archiving change p0-event-to-pitch. Update Purpose after archive.
## Requirements
### Requirement: 引擎纯逻辑、平台无关

Rust 引擎 SHALL 是纯逻辑库，不假设有文件系统/命令行——数据进、事件流出，可被 WASM 与 Tauri 内嵌两种方式消费。

#### Scenario: 引擎被 WASM 消费
- **WHEN** 引擎编译为 WASM 并在浏览器中调用
- **THEN** 引擎不执行任何文件系统/命令行操作，仅通过调用接口产出事件流

### Requirement: 最小 config 形状（S3 修复）

引擎的 simulate(seed, config) 接口 SHALL 定义最小 config 形状：`{ match_duration_seconds }`，使确定性契约（同 seed 同 config）可测试。config 形状 SHALL 在引擎 API 中明确，P0 不做更多配置项。

#### Scenario: config 决定比赛时长
- **WHEN** 引擎被传入 config { match_duration_seconds: 2700 }
- **THEN** 产出的事件流时间跨度约为 2700 秒（半场 45 分钟）

### Requirement: 种子确定性

引擎 SHALL 在给定相同种子与相同配置时，产出完全相同的事件流。

#### Scenario: 同种子可复现
- **WHEN** 引擎用种子 S 和配置 C 模拟一场比赛两次
- **THEN** 两次产出的事件流完全相同

#### Scenario: 不同种子结果不同
- **WHEN** 引擎用不同种子模拟同一配置
- **THEN** 两次产出的事件流（通常）不同

### Requirement: 产出最小比赛事件流

引擎 SHALL 能产出一场最小比赛的事件流，至少包含 kickoff、pass、dribble、shot、whistle 五类事件。

#### Scenario: 最小比赛
- **WHEN** 引擎被要求模拟一场最小比赛
- **THEN** 输出事件流从 kickoff 开始，以 whistle 结束，中间包含传球、带球、射门事件

### Requirement: 事件含演绎参数

引擎 SHALL 在 pass/dribble/shot 事件中输出演绎参数：pass 含球速与提前量（speed、lead），dribble 含带球速度与触球频率（speed、touch_freq），shot 含球速（speed）。

#### Scenario: 传球带演绎参数
- **WHEN** 引擎产出一条 pass 事件
- **THEN** 事件包含 from、to、起点坐标、终点坐标、球速（speed）、提前量（lead）、结果（result）

### Requirement: 事件坐标归一化

引擎 SHALL 用球场归一化坐标（0-1，x 左门线→右门线，y 下边线→上边线）表示事件位置。

#### Scenario: 坐标在 0-1 范围
- **WHEN** 引擎产出一条带位置的事件
- **THEN** 事件坐标 x、y（及 x2、y2）均在 0-1 范围内

### Requirement: 抢断触发决策（距离感知 + 抢断积极性）

引擎 SHALL 不固定概率必抢，而是由防守者基于情境自行判断是否抢断：存在距持球者 ≤ 阈值的对方球员时，以低概率（抢断积极性）决定是否真的去抢；超阈值或无积极性则不产 tackle。参数为引擎内常量 + `should_tackle()` 决策函数。

#### Scenario: 就近防守
- **GIVEN** 一个事件点
- **THEN** 引擎找离持球者最近的对方球员（用实时 pos[]）；最近距离超过阈值（约 10m）时不产 tackle

#### Scenario: 超阈值落回进攻
- **GIVEN** 最近防守者距离超过阈值
- **THEN** 不产 tackle，该次机会重掷落回 pass/dribble/shot（当作普通进攻事件处理）

#### Scenario: 抢断积极性
- **GIVEN** 最近防守者距离 ≤ 阈值
- **THEN** 以低概率（抢断积极性，标定约 0.09，目标每场 8-15 次）决定是否真的去抢；概率不中则继续进攻

#### Scenario: 抢断频率目标
- **WHEN** 一整场比赛（2700s）模拟
- **THEN** tackle 事件总数落在约 8-15 次（用户确认目标）

#### Scenario: 抢断可失败
- **WHEN** 引擎产出一条 tackle 事件
- **THEN** `result` 为 `success`（约 50%）或 `fail`（约 50%）

#### Scenario: 抢断成功状态更新
- **GIVEN** tackle `result=success`
- **THEN** 球权归防守者，持球者变为防守者，且防守者位置更新到弹开点 `(loose_x, loose_y)`（下一事件从 loose 出发，不 snap）

#### Scenario: 抢断失败状态更新
- **GIVEN** tackle `result=fail`
- **THEN** 球权保留原持球者，被铲者位置更新到弹开点（追回球），防守者停在接触点——两端状态一致，下一事件不 snap

### Requirement: 抢断事件携带完整坐标语义

tackle 事件 SHALL 携带：防守者起点 `x/y`、被铲者带球起点 `carrier_from_x/carrier_from_y`、接触点 `x2/y2`、弹开点 `loose_x/loose_y`。

#### Scenario: 带球起点
- **WHEN** 引擎产出一条 tackle 事件
- **THEN** `carrier_from_x/carrier_from_y` 等于被铲者（持球者）上一位置，`x2/y2` 等于被铲者当前位置（接触点）

#### Scenario: 弹开点（success/fail 都发）
- **WHEN** 引擎产出一条 tackle 事件
- **THEN** `loose_x/loose_y` 为确定性弹开点：逼近方向垂线 × 弹开距离，优先场内、越界钳制、零距离退化——与画面层 `deflectPoint` 同规则；success 与 fail 均携带

#### Scenario: 确定性
- **WHEN** 同 seed 同 config 两次模拟
- **THEN** tackle 事件的选择、结果、弹开点全部一致

