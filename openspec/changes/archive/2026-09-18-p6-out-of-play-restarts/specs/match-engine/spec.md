# Spec: match-engine

## ADDED Requirements

### Requirement: 出界判定与重开类型

引擎 SHALL 判定球出界并按类型触发重开：**射门打偏 → 门球**（由 `p6-goal-kick-and-restart` 建立）；传球出边线 → 界外球（对方）；传球出底线 → 门球（对方门将）或角球（对方），按**越过的是哪条底线**区分；**防方头球解围出底线/出边线 → 角球/界外球（进攻方）**；射门被扑出底线 → 角球（进攻方）。出界走新高亮结局（PassOutOfPlay/CornerAward），事件的**场内投影坐标 `x2/y2` 钳制在 [0,1]**（真实越界值另存 `out_pos`，可越界），事件带 detail 表达出界类型。**出界触发由受 `pass_risk` 调制的涌现通道决定（P31：`open_play_out_probability(pass_risk)`，非固定百分比）**——重开球（角球发球/界外球掷球/门球开大脚）落点恒在界内、不走出界通道。

#### Scenario: 传球出边线 → 界外球
- **GIVEN** 一次普通传球（source=NormalPass）的落点出边线（y<0 或 y>1，由 `open_play_out_probability(pass_risk)` 通道判定）
- **THEN** 高亮结局 PassOutOfPlay（detail=`out_sideline`），pass 事件 to=None（无接球者），坐标钳制 [0,1]；对方掷界外球

#### Scenario: 传球出底线 → 按底线归属重开
- **GIVEN** 一次普通传球（source=NormalPass）的落点出底线（x<0 或 x>1）
- **THEN** 高亮结局 PassOutOfPlay（detail=`out_goal_line`），pass 事件 to=None；重开按 `out_restart_for` 判定——**传球方越的是对方底线 → 门球（对方门将）；越的是己方底线 → 角球（对方）**（`own_goal_line` 区分；简化不做触碰归属）

#### Scenario: 解围出底线 → 角球
- **GIVEN** 防方头球解围（pass detail=clearance）落点出底线（source=Clearance）
- **THEN** 高亮结局 PassOutOfPlay（detail=`out_goal_line`），pass 事件 to=None；**角球重开（进攻方发角球）**——解围最后触碰方明确是防守方，不走门球

#### Scenario: 解围出边线 → 界外球
- **GIVEN** 防方头球解围落点出边线（source=Clearance）
- **THEN** 高亮结局 PassOutOfPlay（detail=`out_sideline`），pass 事件 to=None；**界外球（进攻方掷）**

#### Scenario: 射门被扑出底线 → 角球
- **GIVEN** 一次射门被扑出（save-rebound）且**越线（`corner_roll < 90`，即 ~90% 触发；越线点 = 原射门终点 `x2/y2` 的门线前一点，场内 x≈0.02/0.98）**（home 攻 x>1 / away 攻 x<0）
- **THEN** 高亮结局 CornerAward → 角球重开（进攻方从角旗区开球）；**角旗侧由该越线点所在半场确定（仅引擎内部），事件字段坐标一律钳制 [0,1]**

### Requirement: 角球机制

引擎 SHALL 支持角球：从角旗区开长角球到禁区（pass 高亮 + 高度 h）→ 落点松散球 + 攻防双追逐 → 争抢结果（攻方基线 55/45，P33 起叠加**主场偏移**——攻方为主队 58 / 客队 52，围绕 55/45 对称）→ 攻方头球射门（55%）/摆渡（30%）/拿球（15%）、防方头球解围（70%）/解围出底线（20%，再角球）/解围出边线（10%，界外球）。

#### Scenario: 长角球发球
- **GIVEN** 一次角球
- **THEN** 从角旗区（**按出底线点 x/y 就近取角**：x>0.5 → 右角 x=1，x≤0.5 → 左角 x=0；y≥0.5 → y=1，y<0.5 → y=0）开长角球，pass 事件 detail=`corner`、to=None、h>0，落点禁区附近（**落点在发球高亮时刻选定**，pass 高亮）；**发球准备期发球者（攻方离角旗最近外场球员）走向角旗（RestartPrep，球停在角旗），到角旗后发球**

#### Scenario: 角球站位
- **GIVEN** 角球发球准备期（RestartPrep，球在角旗）
- **THEN** **全队**外场球员的目标位置改由 `corner_setup_target` 决定（角球准备期 `formation_target` 被覆盖，不参与）：攻方全队压入禁区**贴门线一侧**、防方全队退入本方禁区**前沿一侧**（同函数；两者 y 均按 id 确定性分散在 0.2-0.8）；发球者单独走向角旗区

#### Scenario: 禁区双追逐争抢
- **GIVEN** 角球落点松散球（battle 标记）
- **THEN** 攻防各 1 名追逐（攻方 chaser=LooseBall.chaser、防方 chaser=battle 元组，**loose 启动时固定**）向落点追逐；**攻方 chaser 达到落点拾取半径时掷胜者**（攻方得球概率 55/45）；败者就地停；**防方胜时防方 chaser 移动到位（到落点）**

#### Scenario: 攻方头球射门
- **GIVEN** 攻方赢得角球争抢
- **THEN** 以概率分支（55/30/15）：头球射门（subject=攻方 chaser，shot 高亮 detail=header、h=0，起点=争抢点、方向=球门，result=goal 15%/saved 30%/off_target 55%，对齐禁区内桶）/ 头球摆渡（subject=攻方 chaser，pass 给队友，无 detail、h=0）/ 拿球组织（main 恢复，carrier=攻方 chaser）

#### Scenario: 防方头球解围
- **GIVEN** 防方赢得角球争抢（防方 chaser 已移动到位）
- **THEN** 防方 chaser（carrier）就地以概率分支（70/20/10）：头球解围（subject=防方 chaser，pass 顶出禁区 detail=clearance、h=0 → 松散球**重新争（普通松散球，非 battle）**）/ 解围出底线（PassOutOfPlay source=Clearance → 再角球）/ 解围出边线（PassOutOfPlay source=Clearance → 界外球，进攻方掷）

### Requirement: 界外球机制

引擎 SHALL 支持界外球：传球出边线后**对方**（防方解围出边线后**进攻方**）从边线掷向附近队友（pass 高亮，短传无高度 h=0）。掷球者 = 接球方离出界点最近的**外场球员（非门将）**。

#### Scenario: 界外球掷球
- **GIVEN** 一次界外球
- **THEN** 接球方离出界点最近**非门将外场球员**（掷球者）**先走向出界点（边线，RestartPrep 准备期，球停在出界点）**，到点后从边线出界点掷向附近队友（pass 高亮，短传无高度 h=0，to=附近队友，receiver_x/y=接球队友当前位置）

### Requirement: 头球复用高亮

头球 SHALL 复用 shot/pass 高亮，不新增事件类型：头球射门 = shot 带 detail=`header`；头球解围/摆渡 = pass。

#### Scenario: 头球射门带 header
- **GIVEN** 一次头球射门
- **THEN** shot 事件 detail=`header`（viewer 据此演绎头球）

#### Scenario: 头球解围为 pass
- **GIVEN** 一次头球解围
- **THEN** pass 事件顶出禁区（无高度 h=0），落点松散球重新争

#### Scenario: 头球摆渡为 pass
- **GIVEN** 攻方赢得角球争抢后头球摆渡给队友
- **THEN** pass 事件无 detail、h=0（低空头球，球不放大）
