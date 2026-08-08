# Spec: pitch-viewer

## ADDED Requirements

### Requirement: 角球演绎

画面层 SHALL 演绎角球：长角球从角旗区飞向禁区（pass 高亮 + 高度 h，球大小表示高度），落点松散球禁区争抢（攻防各 1 名双追逐），头球射门/解围复用 shot/pass 高亮。

#### Scenario: 角球发球
- **GIVEN** 一次角球
- **WHEN** 画面层播放该段
- **THEN** 球从角旗区飞向禁区（h>0，球变大表示高度），落点松散球攻防双方各 1 名追逐争抢

#### Scenario: 角球站位
- **GIVEN** 角球发球准备期
- **WHEN** 画面层播放该段
- **THEN** 发球者走向角旗区；攻方禁区包抄、防方回防（movers 呈现站位）

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
- **THEN** 掷球者先走向边线出界点（准备期），再从边线短传掷向附近队友（h=0，球不放大），队友接球后恢复持球

### Requirement: 出界视觉

画面层 SHALL 在球出界时呈现球飞到边线/底线（坐标钳制到边缘），随后进入对应重开。

#### Scenario: 出界球飞向边界
- **GIVEN** 一次出界（detail=out_sideline/out_goal_line）
- **WHEN** 画面层播放该段
- **THEN** 球飞向边线/底线（钳制到边缘），停住后进入对应重开（角球/界外球/门球）

### Requirement: 球高度 h 大小表示

画面层 SHALL 用球大小表示高度（FM 做法，P6 首批已实现）：pass/shot 事件带 h 时，球按 h 放大/恢复。**h 缺失（undefined）→ 按飞行时长默认插值（向后兼容）；h=0 → 基础半径（无高度）**。

#### Scenario: 高度变化
- **GIVEN** 一次 pass/shot 带 h>0
- **WHEN** 画面层播放该段
- **THEN** 球在飞行中点按 h 放大（半径 ×(1+h×1.5)，h∈[0,1]），落地恢复基础大小

#### Scenario: h 缺失向后兼容
- **GIVEN** 一次 pass/shot 不带 h（旧事件流）
- **WHEN** 画面层播放该段
- **THEN** 球按飞行时长默认插值高度（P6 首批现有行为，不回归）

#### Scenario: h=0 无高度
- **GIVEN** 一次界外球掷球/头球解围（h=0）
- **WHEN** 画面层播放该段
- **THEN** 球用基础半径（无放大），表示无高度短传
