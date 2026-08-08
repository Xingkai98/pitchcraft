# Spec: match-engine

## ADDED Requirements

### Requirement: 出界判定与重开类型

引擎 SHALL 判定球出界并按类型触发重开：传球出边线 → 界外球（对方）；传球出底线 → 门球（对方门将）；**防方头球解围出底线/出边线 → 角球/界外球（进攻方）**；射门被扑出底线 → 角球（进攻方）。出界走新高亮结局（PassOutOfPlay/CornerAward），落点坐标钳制在 [0,1]，事件带 detail 表达出界类型。**PassOutOfPlay 按 source 区分重开**：source=NormalPass（普通传球）出边线 → 界外球（对方）、出底线 → 门球（对方门将）；source=Clearance（防方解围）出边线 → 界外球（进攻方）、出底线 → 角球（进攻方）。

#### Scenario: 传球出边线 → 界外球
- **GIVEN** 一次传球落点出边线（y<0 或 y>1，3-5% 概率，source=NormalPass）
- **THEN** 高亮结局 PassOutOfPlay（detail=`out_sideline`），pass 事件 to=None（无接球者），坐标钳制 [0,1]；对方掷界外球

#### Scenario: 传球出底线 → 门球
- **GIVEN** 一次传球落点出底线（x<0 或 x>1，source=NormalPass）
- **THEN** 高亮结局 PassOutOfPlay（detail=`out_goal_line`），pass 事件 to=None；**门球重开（对方门将：home 传球出 x>1 或 x<0 → away 门将；away 传球出 x<0 或 x>1 → home 门将，简化不做触碰归属）**

#### Scenario: 解围出底线 → 角球
- **GIVEN** 防方头球解围（pass detail=clearance）落点出底线（source=Clearance）
- **THEN** 高亮结局 PassOutOfPlay（detail=`out_goal_line`），pass 事件 to=None；**角球重开（进攻方发角球）**——解围最后触碰方明确是防守方，不走门球

#### Scenario: 解围出边线 → 界外球
- **GIVEN** 防方头球解围落点出边线（source=Clearance）
- **THEN** 高亮结局 PassOutOfPlay（detail=`out_sideline`），pass 事件 to=None；**界外球（进攻方掷）**

#### Scenario: 射门被扑出底线 → 角球
- **GIVEN** 一次射门被扑出（save-rebound）且**越线（概率 ~30% 触发，弹开点 = 门线外一点）**（home 攻 x>1 / away 攻 x<0）
- **THEN** 高亮结局 CornerAward → 角球重开（进攻方从角旗区开球）；**越线弹开点仅引擎内部确定角旗侧，事件字段坐标一律钳制 [0,1]**

### Requirement: 角球机制

引擎 SHALL 支持角球：从角旗区开长角球到禁区（pass 高亮 + 高度 h）→ 落点松散球 + 攻防双追逐 → 争抢结果（攻方 55/45）→ 攻方头球射门（55%）/摆渡（30%）/拿球（15%）、防方头球解围（70%）/解围出底线（20%，再角球）/解围出边线（10%，界外球）。

#### Scenario: 长角球发球
- **GIVEN** 一次角球
- **THEN** 从角旗区（**按出底线点 x/y 就近取角**：x>0.5 → 右角 x=1，x≤0.5 → 左角 x=0；y≥0.5 → y=1，y<0.5 → y=0）开长角球，pass 事件 detail=`corner`、to=None、h>0，落点禁区附近（pass 高亮）；**发球准备期发球者（攻方离角旗最近外场球员）走向角旗（RestartPrep），到角旗后发球**

#### Scenario: 角球站位
- **GIVEN** 角球发球准备期（RestartPrep）
- **THEN** 攻方禁区包抄（nearest 几名向落点/禁区预判）、防方回防（formation_target 自然覆盖 + 落点预判）；发球者走向角旗区

#### Scenario: 禁区双追逐争抢
- **GIVEN** 角球落点松散球
- **THEN** 攻方 nearest（LooseBall chaser）+ 防方 nearest（compute_movers chase）向落点追逐；**攻方 chaser 达到落点拾取半径时掷胜者**（攻方得球概率 55/45）；败者就地停

#### Scenario: 攻方头球射门
- **GIVEN** 攻方赢得角球争抢
- **THEN** 以概率分支（55/30/15）：头球射门（shot 高亮 detail=header、h=0，起点=争抢点、方向=球门，result=goal(~10%)/saved(~40%)/off_target(~50%)）/ 头球摆渡（pass 给队友，无 detail）/ 拿球组织（main 恢复）

#### Scenario: 防方头球解围
- **GIVEN** 防方赢得角球争抢
- **THEN** 防方 chaser 就地以概率分支（70/20/10）：头球解围（pass 顶出禁区 detail=clearance、h=0 → 松散球重新争）/ 解围出底线（PassOutOfPlay source=Clearance → 再角球）/ 解围出边线（PassOutOfPlay source=Clearance → 界外球，进攻方掷）

### Requirement: 界外球机制

引擎 SHALL 支持界外球：传球出边线后**对方**（防方解围出边线后**进攻方**）从边线掷向附近队友（pass 高亮，短传无高度 h=0）。掷球者 = 接球方离出界点最近的**外场球员（非门将）**。

#### Scenario: 界外球掷球
- **GIVEN** 一次界外球
- **THEN** 接球方离出界点最近**非门将外场球员**（掷球者）**先走向出界点（边线，RestartPrep 准备期）**，到点后从边线出界点掷向附近队友（pass 高亮，短传无高度 h=0，to=附近队友，receiver_x/y=接球队友当前位置）

### Requirement: 头球复用高亮

头球 SHALL 复用 shot/pass 高亮，不新增事件类型：头球射门 = shot 带 detail=`header`；头球解围/摆渡 = pass。

#### Scenario: 头球射门带 header
- **GIVEN** 一次头球射门
- **THEN** shot 事件 detail=`header`（viewer 据此演绎头球）

#### Scenario: 头球解围为 pass
- **GIVEN** 一次头球解围
- **THEN** pass 事件顶出禁区（无高度 h=0），落点松散球重新争
