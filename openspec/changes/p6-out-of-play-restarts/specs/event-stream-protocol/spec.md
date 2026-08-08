# Spec: event-stream-protocol

## ADDED Requirements

### Requirement: 出界 detail 表达

pass/shot 事件 SHALL 在出界时携带 detail 表达出界类型（`out_sideline` / `out_goal_line`），坐标仍钳制 [0,1]；出界 pass 的 to=None（落点是出界点，无接球者）。

#### Scenario: 出界 detail
- **GIVEN** 一次出界（传球/射门）
- **THEN** 事件 detail=`out_sideline` 或 `out_goal_line`；坐标 [0,1]；出界 pass 的 to=None

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

### Requirement: 球高度 h 字段

事件流 SHALL 支持可选字段 `h`（归一化 0-1，球高度）——pass/shot 高亮带弧线高度，viewer 用球大小表示（FM 做法，P6 首批已实现）。未提供 h 时 viewer 按距离默认插值（向后兼容）。

#### Scenario: 带高度
- **GIVEN** 一次长球（角球发球/门球开大脚/普通长传）
- **THEN** pass 事件带 h>0（球飞起）

#### Scenario: 无高度
- **GIVEN** 一次短传（界外球掷球/头球解围/普通短传）
- **THEN** pass 事件 h=0 或缺失（viewer 按距离默认）
