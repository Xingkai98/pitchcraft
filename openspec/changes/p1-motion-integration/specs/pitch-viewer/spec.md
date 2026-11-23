# Spec: pitch-viewer

## ADDED Requirements

### Requirement: 播放段与插值合同

画面层 SHALL 按 `beat.t` 与 `beat.dt` 播放段：段终点 = `beat.t + beat.dt`；SHALL 只插值**同一实体的同一轨迹**（相邻锚点同实体、同事件或跨段连续），SHALL NOT 跨事件类型合成。高亮进行中：**参与者由 `movers` 端点驱动**（`action:"highlight"`），球由事件锚点（`t_start → t_end`）驱动；事件锚点只用于 `t_end` 对账，SHALL NOT 用来合成参与者直线。第一阶段 SHALL 显式设 `interpolation.smooth=false` 与 `textureAmpM=0`（不得靠 0.5s 门槛碰巧关闭）；引擎的运动已经连续，画面层 SHALL NOT 叠加第二套运动。新流 SHALL 停止发「事件派生的球员锚点」——参与者只由 `movers` 驱动。

#### Scenario: 段长生效

- **GIVEN** 一条 beat 的 `dt=0.1`（决策切段），另一条 `dt=0.2`
- **WHEN** 画面层展开 beat 锚点
- **THEN** 两条段的终点分别为 `t+0.1` 与 `t+0.2`；SHALL NOT 对 `dt=0.1` 的段仍按 0.2 铺满

#### Scenario: 球用事件锚点、参与者用 mover

- **GIVEN** 一条 pass 飞行终点 `t_end=0.975`，宿主段为 [0.9,1.0]
- **WHEN** 画面层渲染段内球与接球者
- **THEN** 球 SHALL 按事件锚点 `[t_start,t_end]` 在 0.975 落地并保持到 1.0；接球者 SHALL 按 `movers` 端点插值（与引擎同一条轨迹），SHALL NOT 用事件起终点合成直线；两者在 `t_end` 的差 SHALL ≤ `REACH_TOL_M`

#### Scenario: 默认关闭二次运动

- **GIVEN** 默认配置
- **WHEN** 画面层渲染球员轨迹
- **THEN** `interpolation.smooth=false` 与 `textureAmpM=0` SHALL 显式生效；球员位置只由 mover / beat 锚点线性插值得到；新流 SHALL NOT 再有事件派生的球员锚点（视觉验收后再单独决定是否开启）

#### Scenario: tackle 0.5s 跨 3 段

- **GIVEN** 一条 tackle 在 `t=10.0` 触发，`tackleSeconds=0.5`，段边界为 10.0、10.1、10.3、10.5
- **WHEN** 画面层播放 10.0–10.5
- **THEN** 高亮 SHALL 覆盖 3 个段；双方参与者 SHALL 在这 3 段都出现在 `movers`（`action:"highlight"`），viewer SHALL NOT 把他们排除出合成；球由事件锚点驱动；松散球 SHALL 在 10.5 才出现，SHALL NOT 在 10.2 提前出现

### Requirement: 扑救演绎

对 `result=saved` 的 shot，画面层 SHALL 用 `save_t/save_x/save_y` 渲染扑救：球与门将在 `save_t` 到达 `save_x/save_y`；**调度 `t_end := save_t`**；`save_t→P_end=ceil(t_end/SIM_DT)·SIM_DT` 保持在该点（门将零速持球、球停在扑救点）；`P_end` 提交状态后才恢复 `beat.ball`/`main`。画面层 SHALL NOT 把 `x2/y2`（门线投影）当作 saved 的球终点/飞行时长，SHALL NOT 在 `save_t` 后把球/门将闪回门线；若门线投影会到 1.08，画面层 SHALL NOT 因此新增 1.08 的段边界或锚点。`speed` 仍是原射门速度；`save_t` 不是 beat 段边界，段长仍按 `beat.dt`。

#### Scenario: 非网格扑救 1.03→1.1

- **GIVEN** 一条 saved shot：射门 `t=1.0`、`save_t=1.03`、`save_x/save_y=S`，`P_end=1.1`；门线投影约在 1.08
- **WHEN** 画面层播放 1.0–1.1
- **THEN** 1.0 段照常；1.03 球/门将到 S；1.03–1.1 保持在 S（门将零速、球停在 S），不闪回门线；SHALL NOT 用 `x2/y2` 造出 1.08 的额外边界/锚点；1.1 后才由 `beat.ball`/`main` 接力；`save_t` 不切 beat 段

### Requirement: 稀疏状态与 seek 重建

`main` / `ball` 在稳定静止段被省略时，画面层 SHALL 保持上一状态；**新状态首段即使零位移也会携带，不得漏掉**。随机 seek SHALL 向前找最近的主状态来源（球：活跃高亮锚点优先，其次最近 `main`/`ball`，再其次最近 beat；球员：mover / `main` 端点），高亮结束后球 SHALL 从事件终点续接；稳定静止段的回扫 SHALL 命中新状态首段强制发出的锚点。

#### Scenario: 稀疏状态 seek

- **GIVEN** 一个 movers-only beat（无 `main` / `ball`），其前后各有最近的主状态
- **WHEN** 播放或 seek 到该段中间
- **THEN** 画面层 SHALL 保持最近的主状态（球与 carrier 不跳变）；若该段处于高亮中，球用事件锚点、参与者用 mover 端点；稳定静止段的回扫 SHALL 命中新状态首段强制发出的锚点

### Requirement: 段长来源与缺 dt 报错

每条 beat SHALL 携带 `dt`；画面层 SHALL 用 `beat.t + beat.dt` 建段。缺失 `dt` 的 beat SHALL 使 `buildTimeline` **报错**；SHALL NOT 提供 `legacyBeatSeconds` / 旧五段式 / 旧序 tackle 回溯回退（G3-Q7 拍板删除 v11 兼容）。

#### Scenario: 缺 dt 报错

- **GIVEN** 一条 beat 没有 `dt`（旧 v11 流）
- **WHEN** 画面层建时间线
- **THEN** `buildTimeline` SHALL 报错；SHALL NOT 用 0.5 或 0.2 猜测段长；若后续发现仓外消费者，再回退 B（保留旧流）

## MODIFIED Requirements

### Requirement: 事件演绎遵循剧本

画面层 SHALL 按演绎剧本（连续带球、传跑配合、抢断五段式）渲染动作，实现人球解耦。**C1/v12 流 SHALL 用参与者的 `movers` 端点驱动人物、事件锚点只驱动球**，SHALL NOT 再用 tackle 事件字段合成人物逼近/接触/回终点；缺 `dt` 的旧流 SHALL 报错（G3-Q7），不保留五段式兼容路径。

#### Scenario: 抢断演绎（五段式，带球中被抢）
- **GIVEN** 一条 tackle 事件，带 `subject`（防守者）、`to`（被铲者）、`x/y`（防守者起点）、`carrier_from_x/y`（被铲者带球起点）、`x2/y2`（接触点）、可选 `loose_x/y`（弹开点）、`result`
- **WHEN** 画面层演绎该事件
- **THEN** 双方人物位置 SHALL 来自 `movers` 端点（含分离），球 SHALL 来自事件 `loose_x/y`/高亮锚点；SHALL NOT 用 `carrier_from`/`x/y`/`x2/y2` 合成人物逼近/接触/回终点；`loose_x/y` 缺失时画面自算弹开点（防御 fallback）

#### Scenario: 抢断成功演绎（防守者拿球）
- **GIVEN** 一条 tackle 事件，`result=success`
- **WHEN** 画面层演绎该事件
- **THEN** 球到 `loose_x/y` 后停到高亮结束，再由 `beat.ball` 接力；双方人物终态 = `movers` 端点，且与 `subject_end`/`carrier_end` 在容差内一致

#### Scenario: 抢断失败演绎（原持球人拿回）
- **GIVEN** 一条 tackle 事件，`result=fail`
- **WHEN** 画面层演绎该事件
- **THEN** 球停在接触点至高亮结束，随后由下一段 `main` 恢复；双方人物位置 = `movers` 端点（终态与 `subject_end`/`carrier_end` 容差内一致）

#### Scenario: 弹开方向与逼近方向垂直
- **GIVEN** 一条 tackle 事件且引擎未给 `loose_x/y`（防御 fallback）
- **WHEN** 画面层自算弹开点
- **THEN** 弹开向量与逼近向量点积为零（垂直）；两候选弹向按 `(tackler×7 + victim×3) % 2` 确定性选边（不消耗 RNG）；**新流必须使用引擎 `loose_x/y`，不走本自算**

#### Scenario: 弹开点在场内
- **GIVEN** 一条 tackle 事件且画面层自算弹开点（引擎未给 `loose_x/y` 的防御 fallback）
- **WHEN** 画面层计算弹开点
- **THEN** 弹开点坐标落在 [0,1]×[0,1] 内（越界候选被钳制）

#### Scenario: 演绎确定性
- **WHEN** 同一事件重复演绎
- **THEN** 锚点序列完全一致

### Requirement: 静止球员 micro-motion

**当 micro-motion 开启时**，画面层 SHALL 给静止球员（不在 beat movers、**不是 main 持球者**）做小幅重心调整（micro-motion），避免圆点完全冻结；该调整仅影响渲染层，不改变逻辑位置。高亮参与者现在也在 `movers`，因此由「不在 movers」统一排除，不再需要单独的高亮参与者排除。**C1 第一阶段（引擎已输出连续运动）SHALL 默认关闭 micro-motion（`PLAYER_TEXTURE.ampM=0`）**；关闭时逻辑位置与跨段连续性不受影响；是否重新开启由视觉验收单独决定。

#### Scenario: 静止球员微动
- **GIVEN** micro-motion 已显式开启，且一名球员静止（不在 movers/高亮参与者/main 持球者）
- **WHEN** 画面层渲染该球员
- **THEN** 在逻辑位置做小幅重心调整（振幅 < 0.002 归一化），逻辑位置不变；**启停时振幅从 0 渐变（fade in/out ~0.3s），避免微动开始/结束瞬间的渲染跳变**

#### Scenario: 微动确定性且连续
- **GIVEN** 同一播放时刻重放
- **THEN** 微动偏移一致：A/φ/T 由 `hash(id)` 一次派生并缓存（球员级常量，非每帧随机）；t 连续推进（不 floor 到 tick），偏移 = `(A·sin(w), A·cos(w))`，`w = 2π·t/T + φ`（x 用 sin、y 用 cos，形成小幅环动；去冗余相位 t0，由 φ 吸收），tick 边界无跳变

#### Scenario: 移动中抑制微动
- **GIVEN** 一名球员正在移动（movers 或高亮参与者）或为 main 持球者
- **THEN** 不做微动（避免与移动叠加、人球分离）；**抑制切换用启停渐变（进入抑制淡出、退出淡入 ~0.3s），避免移动/静止切换瞬间的渲染跳变**

#### Scenario: 高亮参与者回溯识别
- **GIVEN** 高亮事件与其 beat 统一为「事件先、beat 后」（pass/shot/tackle 都在同 tick 之后）；foul **不产 beat**（无锚点，`_eventEnds` 回落 `e.t`）
- **WHEN** 画面层判定某球员是否为高亮参与者
- **THEN** SHALL 按**事件窗口**回溯查找覆盖当前播放时刻的高亮事件（事件 `t` → 其锚点最长 `t`；**foul 的语义窗口取纪律牌显示时长**），而非直接取当前事件索引——否则事件窗口识别会失效（issue #81 实测：不回溯时约 98% 高亮帧未抑制，且 foul 因窗口零长度失效）；参与者位置仍由 `movers` 驱动，不因排除而隐藏

### Requirement: 演绎节奏配置化（S4 边界明确）

演绎节奏参数（phase 时长、人球分离量、抢断弹开参数）SHALL 放在配置文件，便于调参。**参数分工**：per-event 速度/提前量/触球频率 SHALL 来自事件载荷（事件值优先）；config SHALL 只放动画时序（phase 时长、人球分离量、弹开距离/速度/捡球停顿），不覆盖事件的速度/提前量/触球频率。节奏配置 SHALL 至少包含：`interpretation.beatSeconds`（名义 beat 段长，0.2）、`interpretation.tackleSeconds`（tackle 高亮时长，0.5）、`interpretation.highlightSeconds`（pass/shot 无距离/速度时的兜底）；SHALL NOT 再用单个 `interpretation.tickSeconds` 同时承担 beat 段长与 tackle 高亮时长；**不保留 `legacyBeatSeconds`**（G3-Q7）。

#### Scenario: 调整演绎节奏
- **WHEN** 开发者修改演绎节奏配置文件中**实际被读取**的参数（`dribble.separation`、`shot.keeperReactDelay`、`tackle.*`、`foul.cardShowDuration`、`beatSeconds`、`tackleSeconds`）
- **THEN** 画面层的动作节奏随之变化，无需改代码。**注意**：`interpretation.pass.*` 与 `dribble` 的 `touchDuration/chaseDuration/windupDuration`、`shot.flightDuration`、`turnDuration` 当前**未被实现读取**（改之无效果）；`beatSeconds` 只影响名义段长，`tackleSeconds` 只影响 tackle 高亮与接触上限，二者不得互相覆盖

#### Scenario: 调整抢断演绎节奏
- **WHEN** 开发者修改 `config.interpretation.tackle`（弹开距离/弹开球速/捡球停顿）
- **THEN** 抢断演绎的时序随之变化，无需改代码。**参数适用面**：`deflectSpeed`（球到弹开点的时长）对所有**带弹开段**的 tackle 演绎生效（v1 全部 + v2 success；v2 fail 无弹开段）；`deflectDistance` 仅在引擎未提供 `loose_x/y` 时用于画面自算弹开点；`collectDelay`（捡球反应停顿）仅在无 `carrier` 的旧版事件（v1 路径）生效——引擎事件恒给 `loose_x/y` + `carrier`，走 v2 高亮，不读这两项
