# Spec: event-stream-protocol

## ADDED Requirements

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
- **GIVEN** 一次 pass/shot 不带 h（旧事件流）
- **THEN** viewer 按飞行时长/距离默认插值（不回归）

### Requirement: 角球发球 detail

角球发球 SHALL 以 pass 事件 detail=`corner` 表达（viewer 据此识别角球发球，不靠起点推断）。**detail 校验按事件类型限定**（pass 校验 out_sideline/out_goal_line/corner/clearance、shot 校验 header），不校验 whistle/kickoff 等既有 detail。

#### Scenario: 角球发球带 corner
- **GIVEN** 一次角球发球
- **THEN** pass 事件 detail=`corner`，起点=角旗区、落点=禁区附近、h>0、to=None（落点是争抢点）

### Requirement: 重开准备期球锚点

角球/界外球发球准备期（RestartPrep）SHALL 产 beat 事件表达球停在固定点等待发球：beat.ball = 静止锚点（x==x2 且 y==y2，loose=true），坐标=角旗区/出界点；movers 含发球者/掷球者走向固定点的走位。发球高亮起点=同一固定点，viewer 连续播放无球瞬移。

#### Scenario: 准备期球停固定点
- **GIVEN** 一次角球/界外球发球准备期
- **THEN** beat.ball 静止在角旗区/出界点（x==x2、y==y2），发球者/掷球者 mover 走向固定点；发球 pass 起点=同一固定点
