# Spec: pitch-viewer

## ADDED Requirements

### Requirement: 播放段与插值合同

画面层 SHALL 按 `beat.t` 与 `beat.dt` 播放段：段终点 = `beat.t + beat.dt`；老流缺 `beat.dt` 时回退到 `interpretation.beatSeconds`。画面层 SHALL 只插值**同一实体的同一轨迹**：相邻锚点必须属于同一实体、同一事件或跨段连续；SHALL NOT 跨事件类型合成轨迹。高亮进行中，事件自身的锚点（`t_start → t_end`）SHALL 优先于 beat 端点；`t_end` 不在段边界时，段内按事件锚点渲染。`main` / `ball` 在零位移段被省略时，画面层 SHALL 保持上一状态；随机 seek SHALL 向前找最近的主状态来源（活跃高亮锚点优先，其次最近 `main` / `ball`，再其次最近 beat 的 mover），高亮结束后 SHALL 从事件终点续接。第一阶段的球员转角平滑（Catmull–Rom）与 T1 路径纹理 SHALL 默认关闭；引擎的运动已经连续，画面层 SHALL NOT 叠加第二套运动。

#### Scenario: 段长生效

- **GIVEN** 一条 beat 的 `dt=0.1`（决策切段），另一条 `dt=0.2`
- **WHEN** 画面层展开 beat 锚点
- **THEN** 两条段的终点分别为 `t+0.1` 与 `t+0.2`；SHALL NOT 对 `dt=0.1` 的段仍按 0.2 铺满

#### Scenario: 稀疏状态 seek

- **GIVEN** 一个 movers-only beat（无 `main` / `ball`），其前后各有最近的主状态
- **WHEN** 播放或 seek 到该段中间
- **THEN** 画面层 SHALL 保持最近的主状态（球与 carrier 不跳变）；若该段处于高亮中，改用高亮事件锚点

#### Scenario: 事件锚点优先

- **GIVEN** 一条 pass 飞行终点 `t_end=0.975`，宿主段为 [0.9,1.0]
- **WHEN** 画面层渲染段内球位置
- **THEN** 球 SHALL 按事件锚点 `[t_start,t_end]` 在 0.975 落地并保持到 1.0；SHALL NOT 用 0.9 与 1.0 两个 beat 端点做直线插值而推迟落地

#### Scenario: 默认关闭二次运动

- **GIVEN** 默认配置
- **WHEN** 画面层渲染球员轨迹
- **THEN** Catmull–Rom 与 T1 纹理 SHALL 关闭；球员位置只由事件/beat 锚点线性插值得到（视觉验收后再单独决定是否开启）

#### Scenario: tackle 0.5s 跨 3 段

- **GIVEN** 一条 tackle 在 `t=10.0` 触发，`tackleSeconds=0.5`，段边界为 10.0、10.1、10.3、10.5
- **WHEN** 画面层播放 10.0–10.5
- **THEN** 高亮 SHALL 覆盖 3 个段；双方参与者 SHALL 在这 3 段都被排除出 mover 合成；松散球 SHALL 在 10.5 才出现，SHALL NOT 在 10.2 提前出现

## MODIFIED Requirements

### Requirement: 静止球员 micro-motion

**当 micro-motion 开启时**，画面层 SHALL 给静止球员（不在 beat movers、不在高亮参与者、**不是 main 持球者**）做小幅重心调整（micro-motion），避免圆点完全冻结；该调整仅影响渲染层，不改变逻辑位置。**C1 第一阶段（引擎已输出连续运动）SHALL 默认关闭 micro-motion（`PLAYER_TEXTURE.ampM=0`）**；关闭时逻辑位置与跨段连续性不受影响；是否重新开启由视觉验收单独决定。

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
- **GIVEN** 引擎的高亮事件与同 tick 的 beat 存在**三种相对位置**：pass/shot 的 beat 在**同 tick 之后**（遮蔽「当前事件索引」）、tackle 的 beat 在同 tick **之前**（不遮蔽）、foul **不产 beat**（无锚点，`_eventEnds` 回落 `e.t`）
- **WHEN** 画面层判定某球员是否为高亮参与者
- **THEN** SHALL 按**事件窗口**回溯查找覆盖当前播放时刻的高亮事件（事件 `t` → 其锚点最长 `t`；**foul 的语义窗口取纪律牌显示时长**），而非直接取当前事件索引——否则 pass/shot 的参与者集合恒为空、抑制失效（issue #81 实测：不回溯时约 98% 高亮帧未抑制，且 foul 因窗口零长度失效）

### Requirement: 演绎节奏配置化（S4 边界明确）

演绎节奏参数（phase 时长、人球分离量、抢断弹开参数）SHALL 放在配置文件，便于调参。**参数分工**：per-event 速度/提前量/触球频率 SHALL 来自事件载荷（事件值优先）；config SHALL 只放动画时序（phase 时长、人球分离量、弹开距离/速度/捡球停顿），不覆盖事件的速度/提前量/触球频率。节奏配置 SHALL 至少包含：`interpretation.beatSeconds`（beat 段长，0.2）、`interpretation.tackleSeconds`（tackle 高亮时长，0.5）、`interpretation.highlightSeconds`（pass/shot 无距离/速度时的兜底）；SHALL NOT 再用单个 `interpretation.tickSeconds` 同时承担 beat 段长与 tackle 高亮时长。

#### Scenario: 调整演绎节奏
- **WHEN** 开发者修改演绎节奏配置文件中**实际被读取**的参数（`dribble.separation`、`shot.keeperReactDelay`、`tackle.*`、`foul.cardShowDuration`、`beatSeconds`、`tackleSeconds`）
- **THEN** 画面层的动作节奏随之变化，无需改代码。**注意**：`interpretation.pass.*` 与 `dribble` 的 `touchDuration/chaseDuration/windupDuration`、`shot.flightDuration`、`turnDuration` 当前**未被实现读取**（改之无效果）；`beatSeconds` 只影响 beat 段长与老流回退，`tackleSeconds` 只影响 tackle 高亮与接触上限，二者不得互相覆盖

#### Scenario: 调整抢断演绎节奏
- **WHEN** 开发者修改 `config.interpretation.tackle`（弹开距离/弹开球速/捡球停顿）
- **THEN** 抢断演绎的时序随之变化，无需改代码。**参数适用面**：`deflectSpeed`（球到弹开点的时长）对所有**带弹开段**的 tackle 演绎生效（v1 全部 + v2 success；v2 fail 无弹开段）；`deflectDistance` 仅在引擎未提供 `loose_x/y` 时用于画面自算弹开点；`collectDelay`（捡球反应停顿）仅在无 `carrier` 的旧版事件（v1 路径）生效——引擎事件恒给 `loose_x/y` + `carrier`，走 v2 高亮，不读这两项
