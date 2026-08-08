# Spec: match-engine

## ADDED Requirements

### Requirement: 出界判定与重开类型

引擎 SHALL 判定球出界并按类型触发重开：传球出边线 → 界外球（对方）；传球出底线 → 门球；射门被扑出底线 → 角球（进攻方）。出界落点坐标钳制在 [0,1]，事件带 detail 表达出界类型。

#### Scenario: 传球出边线 → 界外球
- **GIVEN** 一次传球落点出边线（y<0 或 y>1）
- **THEN** 事件 detail=`out_sideline`，坐标钳制 [0,1]；对方掷界外球

#### Scenario: 传球出底线 → 门球
- **GIVEN** 一次传球落点出底线（x<0 或 x>1）
- **THEN** 事件 detail=`out_goal_line`；门球重开（对方门将）

#### Scenario: 射门被扑出底线 → 角球
- **GIVEN** 一次射门被扑出（save-rebound）且球到门线外
- **THEN** 角球重开（进攻方从角旗区开球）

### Requirement: 角球机制

引擎 SHALL 支持角球：从角旗区开长角球到禁区（pass 高亮 + 高度感）→ 落点松散球 → 禁区争抢（攻方 55/45）→ 攻方头球射门/摆渡/拿球、防方头球解围/解围出底线/解围出边线。

#### Scenario: 长角球发球
- **GIVEN** 一次角球
- **THEN** 从角旗区（x=0/1, y=0/1）开长角球，落点禁区附近（pass 高亮，带高度 h）

#### Scenario: 禁区争抢
- **GIVEN** 角球落点松散球
- **THEN** 落点最近攻/防球员争抢；攻方得球概率 55/45

#### Scenario: 攻方头球射门
- **GIVEN** 攻方抢到角球争抢点
- **THEN** 以概率分支：头球射门（shot 高亮，起点=争抢点、方向=球门，~10% 进球）/ 头球摆渡（pass 给队友）/ 拿球组织（main 恢复）

#### Scenario: 防方头球解围
- **GIVEN** 防方抢到角球争抢点
- **THEN** 以概率分支：头球解围（pass 顶出禁区 → 松散球重新争）/ 解围出底线（再角球）/ 解围出边线（界外球）

### Requirement: 界外球机制

引擎 SHALL 支持界外球：传球出边线后对方从边线掷向附近队友（pass 高亮，短传无高度）。

#### Scenario: 界外球掷球
- **GIVEN** 一次界外球
- **THEN** 对方从边线出界点掷向附近队友（pass 高亮，短传无高度 h=0）

### Requirement: 头球复用高亮

头球 SHALL 复用 shot/pass 高亮，不新增事件类型：头球射门 = shot 带 detail=`header`；头球解围/摆渡 = pass。

#### Scenario: 头球射门带 header
- **GIVEN** 一次头球射门
- **THEN** shot 事件 detail=`header`（viewer 据此演绎头球）

#### Scenario: 头球解围为 pass
- **GIVEN** 一次头球解围
- **THEN** pass 事件顶出禁区（无高度 h=0 或低），落点松散球重新争
