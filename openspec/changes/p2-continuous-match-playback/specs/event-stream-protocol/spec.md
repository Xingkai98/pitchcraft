# Spec: event-stream-protocol

## MODIFIED Requirements

### Requirement: tackle 字段定稿（必填 to/x2/y2 + 新增可选字段）

tackle 事件 SHALL 携带被铲者 `to` 与接触点 `x2/y2`（**必填**，定稿）；SHALL 可选携带 `loose_x/loose_y`（弹开点）、`carrier_from_x/carrier_from_y`（被铲者带球起点）。

#### Scenario: tackle 必填字段
- **GIVEN** 一条 tackle 事件
- **THEN** 必须含 `to`、`x2`、`y2`（被铲者与其接触点）；缺失时协议校验抛错

#### Scenario: tackle 可选字段
- **WHEN** 引擎产出一条 tackle 事件
- **THEN** 可携带 `loose_x/loose_y`（弹开点）与 `carrier_from_x/carrier_from_y`（被铲者带球起点）；画面层对缺失字段 fallback

#### Scenario: 向后兼容
- **WHEN** 画面层收到缺可选字段的旧版 tackle 事件
- **THEN** 仍能解析并演绎（缺 `loose`→画面自行算弹开点；缺 `carrier_from`→被铲者原地带球）
