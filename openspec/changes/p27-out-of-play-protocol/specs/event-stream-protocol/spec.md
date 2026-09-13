# Spec: event-stream-protocol

## MODIFIED Requirements

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
