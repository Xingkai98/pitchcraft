# Spec: event-stream-protocol

## ADDED Requirements

### Requirement: 出界 detail 表达

pass/shot 事件 SHALL 在出界时携带 detail 表达出界类型（`out_sideline` / `out_goal_line`），坐标仍钳制 [0,1]。

#### Scenario: 出界 detail
- **GIVEN** 一次出界（传球/射门）
- **THEN** 事件 detail=`out_sideline` 或 `out_goal_line`；坐标 [0,1]

### Requirement: 头球 detail

头球射门 SHALL 以 shot 事件 detail=`header` 表达（复用 shot，不新增类型）。

#### Scenario: 头球射门
- **GIVEN** 一次头球射门
- **THEN** shot 事件 detail=`header`，携带射手/落点/result
