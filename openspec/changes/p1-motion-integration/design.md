# Design: 引擎统一运动执行层（C1 运动学，GitHub #170）

> **状态：D11 六项决策已由用户拍板（2026-11-21，全按推荐）；gpt-6.1-sol 审阅 H1–H6 的设计答案已落盘（见本文件 D2.3/D5.1/D6.1/D8/D5.4/D9，Fix log 在 `notes/review-gpt61-2026-11-21.md`）；design 正式批准仍待复审与用户批准。**
> 批准方式（#170 已定）：用户在 #170 评论「design 批准」或在对应 PR approve。
> 批准链接：_待填_。
>
> 本 design 回答 #170 的八问，并按 main v11（2026-10-30）的现状更新 #170 的旧默认值。
> **#170 里写的 `TICK_SECONDS=1.0` / `MODEL_VERSION=9` 已过时；当前 main 是 2Hz、v11。**
>
> **数字出处与可自证性（本文件统一声明）**：本文件里的读数分三类——
> ① **仓内可自证**：带文件与行号/章节（如 `engine/src/lib.rs:639`、main spec 的 Requirement 名）；
> ② **落盘 note**：本 change 的 `notes/**` 入库文件；
> ③ **本仓 main 不可自证**：Change 0 裁决（分支 `p155-measurement-instrument/2026-11-19`）、
> #170 票面、外部文献——这类均显式标「不可自证」并给来源。
> 同一段内不混用两种标准。

## D0 目标、边界与不做什么

**目标**：把「每拍目标点 + 固定步长 + dead-zone 冻结」换成「每球员有速度/朝向状态、受加速度/制动约束的连续运动」；在不改变事件概率常量的前提下，让渲染帧的条件 `turn120`、`staticFrac`、速度谱向真实靠近。

**做**：

- 每球员 `MotionState { vel_mps, heading, mode }`；`pos_m` 内部米制。
- 10Hz 仿真积分 / 2Hz 决策 / 5Hz beat。
- 统一执行：carrier、无球、高亮参与者、门将、重开走位、同队分离。
- 协议版本化、golden 重基线、L1/ratchet 重标定（在受控范围内）。

**不做**：

- 不做 C2 站位表、C3 盯人、C4 压迫场、C5 持球者搜索（后续票）。
- 不改高亮事件（pass/shot/tackle/foul）的**类型与概率常量**（地图 #175 的第一原则）。
  **注意区分**：概率常量与机会时钟不变 ≠ 涌现事件计数逐位相同；几何改变会让实际实现的
  pass/shot/tackle 计数漂移（M6，见 D5.3 与 D9）。
- 不在本 change 修 viewer 的视觉风格；只在协议/插值层做必要同步。
- 不把「更接近统计带」当唯一目标；最终验收是盲测 + 用户观感。

## D1 与 #170 默认口径的差异（必须显式记录）

#170 写于 main v9/1Hz 时代；当前 main（`16dfaa0`）已经是 v11/2Hz。差异如下：

| #170 默认 | 本 design | 理由 |
|---|---|---|
| 仿真 10 Hz / 决策 **1 Hz** / beat 5 Hz | 仿真 **10 Hz** / 决策 **2 Hz** / beat **5 Hz** | main v11 已把决策拍改为 2Hz（`engine/src/lib.rs:639` `TICK_SECONDS=0.5`），事件体量/概率已在该节拍上重标定。再回 1Hz 会重开一整轮事件率校准；Change 0 的仪器能测，但没有必要。**决策仍 2Hz** 是本 design 对 #170 的明确推翻。 |
| `MODEL_VERSION 9→10` | **11→12** | 当前 main 已是 11（`engine/tests/golden-v11/` 已存在）。 |
| 真实锚 2 场 Metrica | 2 场 Metrica + Change 0 的 frozen 24 窗（SkillCorner 真实窗为转述/受限） | Change 0 已建条件指标与 frozen 集；真实侧仍以 2 场 Metrica 为可复现锚，SkillCorner 标口径。读数出处：Change 0 裁决 §…（分支 `p155-measurement-instrument/2026-11-19`，**本仓 main 不可自证**）。 |
| `DEAD_ZONE_METERS` 删除 | **删除「到点冻结」语义**，但保留「到达半径/制动」 | dead-zone 是「到点不产 mover」的根因；运动层用制动曲线到达，不用 2m 硬开关。 |
| beat 相位 `t = 1.0 + k×0.2`（#170 审查闭环 #4） | **`t = 0.5 + 0.2k`，决策/事件/高亮终点再切段**（D2.3） | #170 的 1.0 相位绑定 1Hz 决策与首 tick=1.0；main v11 首 tick=0.5（`lib.rs:3339`）。相位随决策 cadence 一起改。`viewer/e2e-v2.mjs:65` 的「首拍 ∈ [1,2]」断言是实现阶段必须改的 viewer 测试。 |
| 专项目标 `lf.disp ≥ 10.77 m`（#170「验收」表） | **撤销为主靶**；`disp` 仅作「不退化」报告 | Change 0 实测 `disp` 的 AUC = 0.514（判别力=噪声），且 viewer 消融对旧 `turn120` 只贡献 −1.6%、`staticFrac` −3.2%——真正的判别维度是条件 `turn120` 与 `staticFrac`。读数出处：Change 0 裁决（不可自证，同上）。旧目标与 ratchet「不许低于 6.27」保留为报告项，不再写进成功判据。 |

### D1.1 对 #170「测试成本」旧推断的替代（M4）

#170 的成本表（p124 debug ~40 min、L1 194 s、快照 ×10）建立在「`tick` 改 10Hz」上。
本 design **保留 `tick = decision`**：10Hz 只是 `tick()` 内部的运动子步，观测快照仍按 decision 拍提交。
因此：

- p16/p124 的「快照数 == tick 数」契约**不变**（`engine/tests/p16_spatial_features.rs:371`、
  `engine/tests/p124_intent_observations.rs:471` 的断言语义不变，只把常量引用从 `TICK_SECONDS`
  换成语义名 `DECISION_DT`；若保留别名则断言文本也要同步）。
- #170 的「快照 ×10、p124 6.7 h」推断**不适用**；真实成本以 Phase 0 的 v11 实测为分母（D7.5）。
- A 案（快照按 decision 拍）**定死**，删除「B：降频到 decision 拍」这个伪选项——它把
  「tick 已经是 decision 拍」与「tick 是 10Hz 子步」混为一谈（M4）。

## D2 三层 cadence 与时间合同

### D2.1 三个常量

| 常量 | 值 | 语义 |
|---|---:|---|
| `SIM_DT` | **0.1s** | 物理积分步长（内部子步） |
| `DECISION_DT` | **0.5s** | 决策/概率掷定间隔（= 当前 `TICK_SECONDS`） |
| `BEAT_DT` | **0.2s** | beat 名义输出间隔（viewer 采样对齐） |

LCM(0.2, 0.5) = 1.0s：beat 名义网格与 decision 每 1s 重合一次；其余 beat 复用最近一次决策状态。
三者都是 0.1 的整数倍。

### D2.2 代码落点

当前 `tick()` 假设「一拍 = 一次决策 + 一次 beat」。改为三个循环层：

```
for sim_step in 0..(DECISION_DT/SIM_DT) {   // 5 步
    integrate_motion(SIM_DT);               // 只动位置/速度/朝向，不掷骰
    if segment_due(t) { emit_beat(segment_dt(t)); } // 见 D2.3 的段边界
}
if decision_due(t) {                        // 每 5 步
    advance_action_opportunity(...);        // 现有决策/掷骰
    execute_action_resolution(...);         // 可能产非 beat 事件 → 切段
}
```

- 决策/掷骰仍只在 `DECISION_DT` 发生；仿真子步**不新增 RNG**。
- 高亮飞行/重开准备/死球仍按事件时间推进；段边界由全局 10Hz 时间轴驱动，
  不由 `tick()` 的调用次数驱动。
- 所有 `*_TICKS` 常量必须重新挂到 **decision 拍**计数器（#170 已列 17 个实际换域常量；
  当前 v11 已按 `TPF=2` 换过一轮，本 change 要再核一遍，不能假设）。

### D2.3 时间合同（H1）

**仿真计数与首拍**

- `sim_i ∈ ℕ` 是整数仿真步计数，`t = sim_i × SIM_DT`。
- 仿真从 `sim_i = 5`（`t = 0.5`）开始第一次决策；`[0, 0.5)` 是**前导期**：
  不积分、不产 beat，画面由 `lineup` / `kickoff` 事件描述。这一条承接 main 的首个 tick=0.5
  （`engine/src/lib.rs:3339` `let mut t = TICK_SECONDS`）。
- 决策时刻集合 `D = {0.5 + 0.5m | m ≥ 0}`；beat 名义网格 `B = {0.5 + 0.2k | k ≥ 0}`。
- **段边界** `S = sort(B ∪ D ∪ E)`，`E` = 全部非 beat 事件的发射时刻（实现约束：事件时刻
  必须落在 0.1s 网格上，故段长只会被切成 0.1/0.2，不会出现任意小数）。
- 每个段 `[s_i, s_{i+1})` 产一条 beat：`beat.t = s_i`（**段起点**），
  `beat.dt = s_{i+1} − s_i ∈ {0.1, 0.2}`，`from` = 状态(`s_i`)，`to` = 状态(`s_{i+1}`)。

**0–1s 时间表**

| t | 类型 | 内容 | 段 |
|---:|---|---|---|
| 0 | 非 beat | `lineup` / `kickoff` | 前导期 [0,0.5) 不积分 |
| 0.5 | decision + beat | 首次决策；beat B0 | [0.5,0.7) dt=0.2 |
| 0.7 | beat | B1 | [0.7,0.9) dt=0.2 |
| 0.9 | beat | B2（被 1.0 决策截断） | [0.9,1.0) dt=0.1 |
| 1.0 | decision + beat | 第二次决策；beat B3 | [1.0,1.1) dt=0.1 |
| 1.1 | beat | B4 | [1.1,1.3) dt=0.2 |
| 1.3 | beat | B5 | [1.3,1.5) dt=0.2 |
| 1.5 | decision + beat | 第三次决策（与 beat 网格重合，**不额外切段**） | [1.5,1.7) dt=0.2 |

- 切段示例：0.9 的 beat 只描述 `[0.9,1.0]`；1.0 的 beat 描述**事件后**的 `[1.0,1.1]`。
- **段数**：每个 1s 周期有 5 个名义 beat 段 + 1 个偶数决策切段 = **6 段/s**，
  即 main 2Hz 的 **3×**（不是 2.5×；2.5× 只数名义 beat，漏了切段）。
- **同时间戳排序**：非 beat 事件先（按引擎发射顺序，确定性），beat 最后；
  beat 描述这些事件之后的段。任何“先 beat 后事件”或“beat 描述事件前的段”都 SHALL 视为实现错误。

**实体连续性**

- 对任意实体 `id`（球员或球），若它在相邻两段都被携带（`movers` / `main` / `ball` 任一表示），
  SHALL 满足 `from(N+1) == to(N)`（按米制、按状态位）。
- 若在 N+1 段因零位移被省略，则其状态 = N 段末状态；下一次重新出现时
  `from` SHALL 等于该状态。
- **跨表示切换**（carrier 从 `main` 变 `movers` 或反之）也 SHALL 按实体位置连续：
  边界处的 `main.x2/y2`、`movers.to_x/to_y`、事件终点、`st.pos` 四者一致。
- 连续性校验是**属性测试**（D7），不是只比 `to(N)` 与 `from(N+1)` 的字段。

**合法断点（位置跳变 / 速度重置）**

| 事件 | 位置跳变 | 速度重置 | 边界要求 |
|---|---|---|---|
| `kickoff` | 球到 (0.5,0.5) | 球/开球者 = 0 | kickoff 事件时刻必须是段边界 |
| 死球重开（out / goal kick / corner / throw-in / free kick） | 球从越界处到固定点 | 球 = 0 | 重开事件时刻必须是段边界；重开者走位仍受运动学约束（D5.4） |
| `save-caught`（门将扑住） | 无（位置连续） | 门将持球瞬间 = 0 | 允许速度重置，不允许位置跳变 |
| 高亮 finalize / 交接 | 无（位置连续） | 按结果停住；扑住置 0 | 位置变化 ≤ `V_MAX·SIM_DT`；否则失败 |
| 罚下（red card） | 实体移除 | — | 该实体此后 SHALL NOT 出现在任何段 |
| 进球后回中圈 | 球到 (0.5,0.5) | 球 = 0 | `whistle` / `kickoff` 时刻是段边界 |
| 终场排空 | 无新段 | — | `t ≥ dur` 不产 beat；见下 |

除上表之外的 finalize 位置跳变 SHALL 视为失败（D5.4、D7 的 finalize 断言）。

**非网格飞行落地**

- 球的飞行终点 `t_end = t + dist/speed` 一般不在段边界上。事件自身的锚点
  （`t_start → t_end`）在 viewer 内**优先于** beat 端点；宿主段的 `to` 仍是该段末状态
  （落地后位置），因此连续性不受影响。
- 高亮结束时引擎在**第一个 ≥ t_end 的段边界** finalize（D5.3），该边界必须是段边界；
  finalize 时刻的事件先于同刻 beat。

**死球与终场**

- 死球窗口可以不产 beat；从死球前最后一条 beat 到重开后第一条 beat 的 gap SHALL ≤ 2.0s，
  且若死球窗口本身 > 2.0s，引擎 SHALL 至少每 2.0s 发一条静态 `ball` beat（零位移锚点）。
- 终场排空：`t ≥ dur` 不产 beat；同一 `dur` 上的链式 finalize 只保留一个段（P30 的旧规则），
  终场前的最后一个段以 `dur` 结束。

### D2.4 观测快照（M4）

- `tick` 仍是 **decision**（`DECISION_DT`）；10Hz 只是 `tick()` 内部子步。
- 快照点：主循环内、`tick()` 返回之后（终态提交后），首个 `t = 0.5`，此后每 `0.5s`；
  `expected_ticks = ceil(DUR / DECISION_DT) − 1`；终场排空不采样。
- p124 的 `intent_snapshots[i]` 与 `state_snapshots[i]` 同一 `t`、同一提交点相邻 push
  （沿用 `lib.rs:3352`–`:3368` 的现状）。
- 若实现时把 `TICK_SECONDS` 更名为 `DECISION_DT`，p16/p124 与文档的引用必须同批更新；
  不允许只改常量、留下旧名断言。

## D3 `TICK_SECONDS` 的三重语义拆分

#170 已指出：`TICK_SECONDS` 同时承担三件事，拆错会破坏 `from(N+1)==to(N)` 连续性与 p53 族。

| 语义 | 当前位置/例子 | 新常量 |
|---|---|---|
| ① 物理步长 | `norm_step(speed * TICK_SECONDS)` | `SIM_DT` |
| ② beat / 决策间隔 | L2 beat gap、`t_end` 的常规高亮 | `BEAT_DT` / `DECISION_DT` |
| ③ 高亮锚点的「往前一步」 | `u(t + TICK_SECONDS)` / `highlight_frozen_segs` | **`BEAT_DT`**（不是 SIM_DT，也不是 1s） |

**特别警告（沿用 #170）**：tackle 高亮的 `t_end = t + TICK_SECONDS` 是**高亮时长**，不是 beat 间隔。
当前 main 下它是 0.5s；本 change 保留 `DECISION_DT`（0.5s），**不要改成 0.2s**，否则 tackle
高亮会短 2.5×、松散球提前出现。save 高亮的「首个整数 tick 边界」改为「首个 decision 边界」。

## D4 运动模型与单位

### D4.1 内部米制

**决定：内部位置/速度/加速度全部用米制**（`pos_m`、`vel_mps`、`accel_mps2`），只在事件发射时转归一化：

```
x_norm = pos_m.x / 105.0
y_norm = pos_m.y / 68.0
```

理由（#170 Q7）：`norm_step(m)=m/105` 只对 x 对齐；若直接 `pos += vel·dt`，y 速度会被
68/105 机械压到 2.59 m/s，且没有测试能抓。内部米制是唯一能同时对齐 x/y 的方式。

### D4.2 速度/加速度（M2：按 #170 末尾纠错重新标注）

| 参数 | 值 | 类别 | 出处 / 备注 |
|---|---:|---|---|
| `A0` | **6.4–7.8 m/s²** | 文献值 | #170「审查闭环」#10（原文 6.39–7.81；旧票面 6.3–7.6 已撤回） |
| `S0` | **9.2–9.8 m/s** | 文献值 | #170 票面 PMC10880943 行 |
| `a_lat` | **6.5 m/s² 起步** | **工程初值，待标定** | #170「审查闭环」#8：`a_lat 6–8` 在 PMC6132493 查不到；本值不是实测 |
| `V_MAX` | **9.5 m/s** | 文献值 | EPL 光学追踪 9.53 ± 0.39（#170 票面） |
| 冲刺距离 | **>7 m/s 距离分布**（160 ± 89 m/场） | 文献值 | #170「审查闭环」#9；「平均 5.9m 冲刺」**不作锚**（不在 PMC11474994） |
| `a_brake` | **= A0 起步** | 工程初值，待标定 | 与加速同量级；用同口径真实分布校准 |
| `ARRIVE_RADIUS_M` | **1.0 m** | 工程初值，待标定 | 到达半径；不用 2m 冻结 |
| `RESIDUAL_SPEED_MAX` | **0.2 m/s** | 工程初值 | 到达后的数值残余；**不允许 0–1 m/s 的漂移**（H6 防微抖） |
| `V_REVERSE` | **0.5 m/s** | 工程初值 | 目标在身后时先减速到该值再转身 |

- 侧向：`|ω| ≤ a_lat / max(v, 1)`；实现时 `a_lat` 是**待标定参数**，不得当物理硬事实引用。
- 模式速度上限：`run` / `sprint` / `close_down` / `chase` / `keeper` 的 `v_cap` 由现有常量映射
  （4.0 / 6.8 / 5.0 / 3.0 等），**只约束 `v_des`，不直接 clamp 瞬时 `v`**（见 D4.4 第 5 步）。
- 所有「文献值」均为外部文献，**本仓不可自证**；「工程初值」以真实分布校准后才升级为标定值，
  校准记录进 `notes/`。

### D4.3 目标与转向

- 目标仍由现有 `formation_target` / `close_down` / `chase` / `corner_setup_target` 产生；
  本 change **不新增战术任务层**。
- 目标每 decision 拍更新；仿真子步内目标保持，避免目标抖动直接变成方向抖动。
- 转向用 heading 的一阶限制；目标方向与 heading 的夹角超过 `ω_max·SIM_DT` 时按最大角速度转，
  不瞬时反向。

### D4.4 确定性单步算法（M3）

每个仿真子步 `t → t + SIM_DT`，对全部未罚下球员**按 id 升序**执行；决策窗口内
`target` / `mode` 固定（只在 decision 边界更新）：

1. **到达判定**：`d = |target − pos|`；若 `d ≤ ARRIVE_RADIUS_M`，`v_des = 0`。
2. **期望速度**：`v_des = min(mode_cap, V_MAX, sqrt(2·a_brake·max(d − ARRIVE_RADIUS_M, 0)))`。
3. **朝向误差**：`θ_err = wrap(atan2(target−pos) − heading)`；
   `ω_max = min(MAX_TURN_RATE, a_lat / max(v, V_REVERSE))`。
4. **目标在身后**：若 `|θ_err| > π/2` 且 `v > V_REVERSE`，本子步只制动（`v_des = 0`），
   不转身加速；待 `v ≤ V_REVERSE` 后再按第 3 步转、第 5 步加速。**禁止瞬时反向**。
5. **速度**：`a_cmd = clamp(v_des − v, −a_brake·SIM_DT, A0·(1 − v/S0)·SIM_DT)`；`v += a_cmd`；
   `v = max(v, 0)`。模式 cap 下调只改 `v_des`，减速由 `a_brake` 限制（不直接 clamp `v`）。
6. **朝向**：`heading += clamp(θ_err, −ω_max·SIM_DT, +ω_max·SIM_DT)`。
7. **位置（半隐式 Euler，先速度后位置）**：`pos += v·SIM_DT·(cos heading, sin heading)`。
   出界时把位置钳到 `[0,1]`，并把指向边界外的速度分量清零（记录 `boundary_reset`，不是失败）。
8. **分离**：全部球员积分后，按 D4.5 执行分离求解（固定 id 顺序、≤3 次迭代、零 RNG）。
9. **提交**：段边界上才写 `last_emitted` / 发 beat；子步不发射。

**积分次序是合同的一部分**：决策 → 子步（朝向 → 速度 → 位置）→ 分离 → 段边界提交。
同 seed 同 config 必须逐位复现；任何“先位置后速度”或“浮点累加顺序随 HashMap”都算实现错误。

**不可行预测与失败规则**：

- 分离/避碰在**进入不可避免冲突前**介入（D4.5 的预测层），而不是等端点越界后再推。
- 若某子步的约束不可行，求解器 SHALL 置 `constraint_infeasible`（带 pair/step/量），
  并使对应守卫红；SHALL NOT 静默推端点、clamp 速度或在下一子步“补回来”。
- 高亮参与者的可达性失败用 `highlight_infeasible`（D5.4）；同样使守卫红，不产伪合法轨迹。

### D4.5 同队分离与碰撞（三层）

同队 2.2m 约束保留（P34/#53 的契约），但从「直接推端点」改为三层：

1. **目标层**：沿用现有 repulsion（目标点最小间距 = `SAME_TEAM_MIN_DIST_M`），
   carrier 不参与 repulsion（位置由 main 驱动；射门推进/起脚窗口的 swept_light 豁免保留）。
2. **速度预测层**：积分前，对每对同队球员计算本段预测最近距离；若 < 2.2m，
   沿相对速度的确定性垂线方向调整 `v_des`，每子步修正量 `|Δv| ≤ a_max·SIM_DT`；
   选边按 `(小 id, 大 id)` 的预测叉积符号，叉积为零时按 `(id_a + id_b) % 2`。
3. **位置投影层（硬不变量）**：积分后仍 < 2.2m 时，按最小平移向量投影；由此产生的
   速度修正 `|Δv| = |Δpos| / SIM_DT` SHALL ≤ `a_max·SIM_DT`。若在 3 次迭代内不可行，
   置 `constraint_infeasible`（第 2 层本应提前避免；这是防御网，不是常规路径）。

- `carrier` 仍参与端点分离；`frozen` 的高亮参与者只作约束、不被推移（沿用
  `commit_beat_positions_ex` 的 `frozen_mask` 语义，`lib.rs:6889`）。
- 跨队（tackle 结算的双方）不受同队 2.2m 约束（main spec 的 `跨队不适用` scenario）。

## D5 事件流与协议

### D5.1 beat 5Hz 与稀疏 main/ball（H2）

- `beat` 每段一条；段定义见 D2.3。`movers` 含该段有非零位移的球员
  （`{id, from_x, from_y, to_x, to_y, speed, action}`）。
- **`main` 携带规则（已定，不再留推荐项）**：
  `main` SHALL 在**每个 carrier 有非零位移的段**携带；零位移段可省略，viewer 保持上一状态。
- **`ball` 携带规则**：无持球者时，`ball` SHALL 在**每个球有非零位移的段**携带；
  静止松散球段可省略，viewer 保持上一状态。
- 高亮进行中：参与者被排除出 `movers`；球由事件锚点驱动，`main`/`ball` 不携带（沿用 main 现状，
  `lib.rs:3551`–`:3555`）。
- **状态失效**：`pass` / `shot` / `tackle` / `out` / `whistle` / `foul` 事件在 `t` 时刻
  使其前的 `main` 记忆失效；`movers`-only beat **不**使状态失效。
- **删除的歧义**：「只在状态变化或 decision 拍携带」「若现有条款冲突…再退回每个 decision 拍
  带一次」这类措辞全部删除。携带规则的唯一判据是**该段是否有非零位移**。

**viewer 的 seek / 重建规则**（与 D6.2 同义，协议侧先写死）：

- 向前（时间轴）找最近的主状态来源：优先当前活跃高亮的**事件锚点**；否则最近一条
  `main` / `ball`；再否则最近一条 beat（球员 mover）。
- 高亮结束后的第一段从**事件终点**续接；不得从高亮前的旧 `main` 续接。
- `currentCarrier()` 必须向前扫描到最近的 `main`，并在遇到失效事件时停止（不能只看当前
  beat——这是 `viewer/game.js:416`–`:420` 的现状缺口）。

**三条短 trace（人球一致性的最小证据）**

*Trace A：连续带球 1s（carrier 以 2.5 m/s 向 +x）*

| t | 事件 | 携带 | 段 |
|---:|---|---|---|
| 0.5 | decision + beat | `main {carrier:C, x=30.00, y=34.00, x2=30.50, y2=34.00, speed=2.5}` | [0.5,0.7) |
| 0.7 | beat | `main {x=30.50 → 31.00}` | [0.7,0.9) |
| 0.9 | beat | `main {x=31.00 → 31.25}` | [0.9,1.0) dt=0.1 |
| 1.0 | decision + beat | `main {x=31.25 → 31.50}` | [1.0,1.1) dt=0.1 |
| 1.1 | beat | `main {x=31.50 → 32.00}` | [1.1,1.3) |

连续性：每段的 `from` = 上一段 `to`；`main` 每段都在（位移 > 0）。若任一段位移为 0，
该段可省略 `main`，下一段 `from` = 省略前的状态。

*Trace B：松散球滚动 1s（球 6 m/s 向 +x，无持球者）*

| t | 携带 | 段 |
|---:|---|---|
| 0.5 | `ball {x=50.00 → 51.20, y=34.00, speed=6, loose:true}` | [0.5,0.7) |
| 0.7 | `ball {51.20 → 52.40}` | [0.7,0.9) |
| 0.9 | `ball {52.40 → 53.00}` | [0.9,1.0) dt=0.1 |
| 1.0 | `ball {53.00 → 53.60}` | [1.0,1.1) dt=0.1 |
| 1.1 | `ball {53.60 → 54.80}` | [1.1,1.3) |

无 `main`；每段球都有位移，故每段携带。球在 1.2 停下后，后续段省略 `ball`，viewer 保持
最后位置；重新滚动时 `from` = 停点。

*Trace C：0.5s 球权切换（t=1.0 的 tackle，success；highlight=[1.0,1.5]）*

| t | 事件 | 携带 | 段 |
|---:|---|---|---|
| 0.9 | beat | `main {carrier:A, → 接触点 P}` | [0.9,1.0) |
| 1.0 | **tackle（非 beat，先）** | `{subject:B, to:A, x2/y2=P, loose_x/y=L, carrier_from=…}` | — |
| 1.0 | beat | **无 main / 无 ball**；`movers` 排除 A、B | [1.0,1.2) |
| 1.2 | beat | 同上（movers-only） | [1.2,1.4) |
| 1.4 | beat | 同上（被 highlight 终点 1.5 截断） | [1.4,1.5) |
| 1.5 | beat（finalize 后） | `ball {x=L, x2=…, loose:true}`；`movers` 含拾球者 | [1.5,1.7) |

状态失效：1.0 的 tackle 使 `main(A)` 失效；1.0–1.4 的 movers-only beat 不得让 viewer 回退到
A 持球。1.5 起球由 `ball` 接力，直到新的 `main` 出现。球的位置：0.9 段末 = P，
tackle 的 `x2/y2` = P，1.5 的 `ball.x` = L（事件 `loose_x/y` 的终点）——按 D2.3 的合法断点表，
这中间的球轨迹由事件锚点驱动，不是位置瞬移。

### D5.2 是否加 `vx/vy/heading`（已定）

**已定：第一阶段只发端点**（D11 #3）。5Hz 端点 + viewer 线性插值已足够连续；加字段会扩大
协议/测试面。若视觉验收发现 5Hz 线性仍有折角，再以可选字段加入，并 bump 协议版本。
**本 change 新增的 `beat.dt` 是段长（时序）字段，不是运动矢量字段**，不受 D11 #3 的
「只发端点」限制。

### D5.3 高亮时长与 fill 飞行（H3/M6）

- tackle：保留 `DECISION_DT=0.5s`（当前语义），不跟 `BEAT_DT`。
- save：首个 decision 边界武装 transition。
- pass/shot：飞行时长仍由距离/速度决定；`tick_filling_flight` 的填拍域**定死为 `BEAT_DT`**：
  `FILL_FLIGHT_S = 0.95 × BEAT_DT = 0.19s`。
  - **速度带守卫**：只有当 `dist / FILL_FLIGHT_S ∈ [PASS_SPEED_MIN, PASS_SPEED_MAX)` = [10,25)
    时才填拍；否则**保持原飞行时长**（可跨多个 beat），不得为填拍牺牲 L2 速度带。
  - **finalize 时刻**：`t_end = t + flight`；在**第一个 ≥ t_end 的段边界** finalize，
    该边界的事件先于同刻 beat；finalize 之后的第一段携带新状态（`ball` 或 `main`）。
  - **口径区分（M6）**：决策仍 2Hz、零新增 RNG ⇒ **概率常量与机会时钟不变**；
    但几何/可达性会改变实际实现的 pass/shot/tackle **计数**（涌现事件计数不逐位相同）。
    本 change 不调概率常量；若 L1 体量带破，停止并另立标定 change，**不得**追着候选结果放宽真实带。

### D5.4 高亮参与者与统一运动状态（H5）

所有角色 SHALL 服从同一 `MotionState` 积分器；高亮参与者不冻结、不瞬移。目标产生 →
积分 → 事件锚点 → 完成交接如下：

| 角色 | 目标产生 | 积分 | 事件锚点 | 完成交接 |
|---|---|---|---|---|
| pass 接球者 | decision 时由接球者位置 + lead 生成落点 `(x2,y2)` | 与其他球员同一积分器，`target=落点`，时限 `[t_start,t_end]` | `pass.x2/y2` 只在可达性检查通过后写入 | finalize 时 `pos=落点`，`vel=` 积分所得；下一段作为普通 mover 从落点继续 |
| pass 拦截者 | 拦截点 `at`（由传球路径与拦截者位置生成） | 同上，`target=at` | `interceptor` + `at` 仅当可达 | finalize 时 `pos=at`；若成为新 carrier，下一段 `main.from=at` |
| shot 门将 | 扑救点 = 球路径上与门将可达集的最早交点；若结果=save 但不可达，见下 | 同上，`target=扑救点` | `keeper_x/y` 仍是**射门瞬间**位置；扑救点在 finalize 才成为位置 | 扑住（caught）时位置连续、速度置 0（合法速度重置）；扑出（rebound）时速度可取积分值 |
| tackle 双方 | 接触点 `(x2,y2)` = 双方可达集的确定性交点 | 双方同一积分器，时限 `[T,T+DECISION_DT]` | `subject_end/carrier_end` 只在可达性检查通过后写入 | finalize 时双方 `pos` = 事件终点；速度取积分值（或按结果停住），不得瞬移 |
| 重开者（角球/界外球/任意球） | 固定点 = 角旗/出界点/犯规点 | 准备期正常走位（`v_cap` 同现有 8 m/s 快走），到达半径内才允许发球 | 发球 pass 起点 = 固定点 | 到达前不发球；准备期延长而不是瞬移（上限 `RESTART_PREP_MAX_S`，工程初值 6.0s） |

**显示轨迹 vs 内部积分（不能混用）**：

- viewer 看到的参与者轨迹 = **事件锚点线**：固定起点 `participant_start`（事件发出时参与者的位置）
  → 事件终点；viewer 只在两个事件锚点间线性插值，不重建引擎的内部积分轨迹。
- `Highlight` MUST 保存 `participant_start`；`highlight_frozen_segs` MUST 用它计算显示线段，
  **不得再用 `st.pos[id]` 当起点**（main 能这么做是因为参与者被冻结；C1 的参与者会被积分，
  `st.pos` 每段都在变，拿它当起点会让 solver 约束一条 viewer 看不到的线）。
- 分离 solver 用**显示线**约束队友，不用参与者的内部积分轨迹。
- finalize 时 `st.pos[participant]` MUST 等于事件终点（容差内），内部速度取积分值；
  这样“引擎状态、事件字段、viewer 显示”三者在 `t_end` 对齐。

**可达性检查（事件发出前，不是事后）**：

- `reachable(pos, vel, end, T)` 用**同一积分器**对 `end` 跑 `ceil(T/SIM_DT)` 步：
  若 `|pos_end − end| ≤ REACH_TOL_M`（0.25m）且 `v_end ≤ REACH_SPEED_TOL`（0.5 m/s）则可达。
  纯函数、零 RNG、可单测。
- **修复顺序（确定性）**：
  1. **延长时限** `T`（最多到 `T_MAX`，且不得把 pass 速度推出 L2 带）；
  2. **改落点**：沿原方向把落点移入可达集（传球缩短 / 扑救点沿球路前移 / 接触点改到双方
     可达集交点）；事件字段写**改后**的值；
  3. **失败**：置 `highlight_infeasible`，不发射结果、不产生伪合法轨迹。
- **禁止**：先固定事件结果（`x2/y2` / `subject_end` / `loose`）再让参与者瞬移凑终态。
- **射门 save 的几何否决**：若概率掷定 save，但扑救点在时限内不可达，则结果**改为 goal**
  （物理上扑不到）；该否决率是预注册统计量（D9），若 > 2% 则停止并另立射门/扑救概率标定
  change，不得在本 change 内静默改概率。
- **finalize 瞬移**：除 D2.3 的合法断点表外，`|pos_final − pos_at(t_end^-)|` SHALL ≤
  `v_max·SIM_DT`（一个子步的连续位移）；否则守卫红。
- **测试分两路（H5）**：① **子步速度**——每个 `SIM_DT` 断言 `|Δv| ≤ a_max·SIM_DT`、
  `|Δheading| ≤ ω_max·SIM_DT`；② **5Hz 输出**——每个段端点断言 `|to−from| ≤ speed×beat.dt +`
  分离余量、且 `to` 等于同一时刻 `st.pos`。不以视觉平滑替代运动约束。

## D6 Viewer

### D6.1 配置拆分（H3）

`viewer/config.js` 的 `interpretation.tickSeconds` 拆成三个键（旧键删除，不留双写）：

| 键 | 值 | 用途 |
|---|---:|---|
| `beatSeconds` | **0.2** | beat 段长；老流无 `beat.dt` 时的回退值 |
| `tackleSeconds` | **0.5** | tackle 高亮时长（= `DECISION_DT`），**不跟 beat** |
| `highlightSeconds` | **0.5** | 仅在 pass/shot 既无距离也无速度时的兜底；正常走事件时长 |

**逐点归属**（`viewer/interpretation.js`）：

| 行 | 现用途 | 新归属 |
|---:|---|---|
| 186 | `approachDur ≤ 0.6 × tickSeconds` | `0.6 × tackleSeconds`（= 0.3s） |
| 192 | 接触点 `≤ t0 + tickSeconds − 0.05` | `t0 + tackleSeconds − 0.05` |
| 219 | tackle 高亮终点 `t0 + tickSeconds` | `t0 + tackleSeconds` |
| 304 | beat 铺满 `t0 + tickSeconds` | `t0 + (e.dt ?? beatSeconds)` |
| 350 | `highlightEndTime(tackle) = e.t + tickSeconds` | `e.t + tackleSeconds` |
| 348–353 | pass/shot 终点 | 事件 `distance/speed`；缺失才用 `highlightSeconds` |

`viewer/game.js` 的 `_highlightEnd` / `_activeHighlightIndex` 仍从事件锚点推导，不直接读
`beatSeconds`；只需保证 `interpretTackle` 写出的锚点终点 = `t0+tackleSeconds`。

**0.5s tackle 跨 3 个 beat 的时间线验证**（t=10.0，tackleSeconds=0.5）：

| t | 段 | 事件/状态 |
|---:|---|---|
| 9.9 | [9.9,10.0) | tackle 前的最后一段 |
| 10.0 | [10.0,10.1) | tackle 事件（先）+ beat；双方排除出 movers；球由事件锚点驱动 |
| 10.1 | [10.1,10.3) | movers-only；球仍在事件轨迹上 |
| 10.3 | [10.3,10.5) | movers-only；球到 loose 点前 |
| 10.5 | [10.5,10.7) | finalize：松散球 `ball` 接力；拾球者进入 movers |

高亮 [10.0,10.5] 覆盖 3 个段；若误用 `beatSeconds=0.2`，tackle 会在 10.2 结束，松散球提前
0.3s 出现——D9 的 viewer 断言必须钉住这 3 段。

### D6.2 稀疏状态与 seek/重建（H2）

- `buildTimeline` 对缺失的 `main`/`ball` **不补锚点**；插值器按 `_interpolateAnchors` 的
  `prev` 锚点保持（`viewer/game.js:517`–`:530`）。这与 D5.1 的「零位移段省略」一一对应。
- `currentCarrier()` 改为向后扫描到最近的 `beat.main`，遇到 `pass/shot/tackle/out/whistle/foul`
  停止；缓存结果（按 beat 索引）。
- 随机 seek：先二分到 `t` 前最近的主状态来源（高亮事件锚点优先），再用插值器；高亮结束后
  从事件终点续接，不得跳回高亮前的 `main`。
- 旧流（无 `beat.dt`）回退到 `beatSeconds`；若旧流还是 2Hz，`beatSeconds` 与旧
  `tickSeconds` 同值 0.5，行为不变（兼容窗口只在第一阶段保留，加一行 warning）。

### D6.3 插值规则

- **只插值同一轨迹**：同一实体、同一 `evt` 或跨段连续的相邻锚点；不跨事件类型合成。
- 高亮期间事件锚点优先于 beat 端点；`t_end` 不在段边界时，段内按事件锚点渲染。
- 高亮参与者的显示轨迹 = 事件锚点线（`participant_start` → 终点），不是引擎内部积分轨迹；
  引擎不输出参与者的中间轨迹，viewer 也不自行合成（见 D5.4）。
- **Catmull/T1 默认关闭**：保留代码，`interpolation.smooth=false` / `PLAYER_TEXTURE.ampM=0`
  为默认；视觉验收后再单独决定是否开启。引擎的运动已经连续，viewer 不应叠加第二套运动。
- 缓存版本号：`viewer/index.html` 的 `app.js?v=` 与 app.js 的 import specifier 必须同步 bump
  （CLAUDE.md §4）。

## D7 测试、golden、L1 与守卫

### D7.1 先量后改

- 改动前：`node tools/ratchet.mjs save openspec/changes/p1-motion-integration/notes/ratchet-before.json`。
- 改动后：`node tools/ratchet.mjs diff ...`，有退化 exit 1。
- 预注册指标：条件 `turn120`、`staticFrac`、速度 p50/p90/p99、加速度尾部、路径长度、
  路径效率/回环率、低速转向、残余漂移、ballStatic（标 viewer 链 caveat）。
- 训练/留出 seed 与真实窗分开（D9.1）；条件 `turn120` 用 `tools/visual-review/motion-census.mjs`
  的 frozen 口径。

### D7.2 L1 / 守卫

- **权威 L1 基线必须实测**：Phase 0 在 main 同配置跑 200 场，落盘
  `notes/l1-baseline-main.json`，记录 `source_commit`、`engineFingerprint`（wasm+`lib.rs`）、
  seed 列表、每条带的读数与红清单。**「当前已知 4 红」是历史转述，不是权威**（D9.1）。
- 角球带：D11 #4 已定**重锚到真实锚 ~10.27**，保留单场 max 护栏；不降级为报告项、不删门
  （Phase 0 完成具体置信带与单场 max 的证据）。
- `p53/p31/p6/p32`：改成「显式构造场景 + 条件断言 + 多 seed 置信范围」的夹具，保留契约；
  Phase 0 前置。
- `p16` / `p124`：按 D2.4（tick=decision，A 案定死）。
- `l2_cross_event_invariants` 的 beat gap 断言改为从 `BEAT_DT` 字面量推导，不写死 {1.0,2.0}；
  `realism.rs:453` 的 `ok_step` 改为 `dt ∈ {BEAT_DT, DECISION_DT 切段 0.1, 2×BEAT_DT}` 的
  显式集合，**不得**再用 `(dt−TICK)||(dt−2×TICK)` 的假绿写法。
- `DEAD_ZONE_METERS` 的 spec 条款（`match-engine:729/755`）显式 MODIFIED；不能只改代码。

### D7.3 golden / 研究门（L2）

- `MODEL_VERSION=12`，`engine/tests/golden-v12/`；`ACCEPT_GOLDEN=1` 重基线；旧 golden 保留。
- `golden_dir()` 必须加 `12 => "tests/golden-v12"`（`engine/tests/realism.rs:1504`），
  否则新版本直接 panic。
- **生成与验收分离**：golden 产物由**已提交的树**生成（`source_commit` = `git rev-parse HEAD`），
  验收在干净工作树上跑；`ACCEPT_GOLDEN=1` 只用于显式重基线，不得在常规测试里隐式生成。
- **同构建身份**：wasm / `lib.rs` / 新增 `motion.rs` / 工具产物的指纹必须成组记录；
  `engineFingerprint` 的覆盖范围要加 `motion.rs`（M5）。
- 研究门清单（#170 审查闭环 #7）：
  - `p18`（behavior gates）、`p17a`（behavior chain baseline）、`p17b`（diagnosis report）、
    `p16`（spatial features）、`p124`（intent observations）**全部保留**，`--ignored` 产物门
    在同一 commit 上用环境变量显式声明 `P*_SOURCE_COMMIT` 重跑；
  - `p15`（behavior observation）同样保留；
  - **没有「退役」项**：p18/p17a 不是遗漏，也不是退役——它们是 `--ignored` 产物门，不在
    `verify.sh` 的默认步骤里（CLAUDE.md §3 已列），必须用显式命令跑；
  - 固定 seed 的门换样本不换判据；不得静默放宽或挑绿样本。
- `benchmark-baseline.json` 的 `engineFingerprint` 需重生成；CLAUDE.md 的「注释变哈希也变」
  规则仍适用，但**当前哨兵允许“源码变、行为不变”放行**（`tools/benchmark-baseline.test.mjs`
  的现行分支）——不得把「注释变必红」当作无条件硬门；真正要求重生成的是**行为变更**
  （本 change 必然触发）。记录两个哈希，不靠版本号绕过。

### D7.4 baseline 数据依赖（M5）

- Phase 0 必须先确认：Metrica 2 场 + SkillCorner 20 场的**授权位置、文件身份（名/字节/哈希）、
  离线可用性**；`tools/benchmark-baseline.mjs:295` 起在缺真实数据时直接抛错，
  `:310` 起在缺 wasm 时抛错——两者都是硬阻断，不是可跳过项。
- 若数据不可用：本 change **停在 Phase 0**，不进入实现；不得用「只改版本号/哈希」绕过基线哨兵。
- 生成命令与数据身份写进 `notes/baseline-data.md`，供复审复算。

### D7.5 测试成本预算（M1）

> 下表是**预算与估算**，不是实测；Phase 0 用 v11 的实测值替换「估算」列。
> #170 的旧表（p124 ~40 min、L1 194 s、快照 ×10）是 **1Hz/v9 口径**，且建立在「tick 改 10Hz」上，
> 已被 D1.1 推翻，**不得直接当 v11/C1 预算**。

| 项 | main v11 实测 | C1 估算/预算 | 处置 |
|---|---|---|---|
| `cargo test` 默认（debug） | 待 Phase 0 实测（CI job 曾 16–24 min；R6 2Hz 后 >30 min） | 运动子步 5×/decision，但快照/决策数不变；估算 +10–30%；PR 门 ≤45 min | 超限则拆短套件 / 把长套件移 nightly |
| `realism --ignored` L1 200 场 | 待实测（#170 旧值 194 s 是 1Hz/v9，不可比） | ≤2× v11；目标 ≤15 min（release） | 超 15 min 移 nightly 或分片 |
| p124 debug（30 seed × 5400 s） | 待实测（#170 旧值 ~40 min 是 1Hz/v9，不可比） | 快照数不变；运动子步增加；目标与 v11 同比 ≤1.3× | 超 90 min 则 CI 分片 / release |
| spacing-sweep | #170 旧值 10m49s（1Hz/v9，不可比） | anchors ≈3× ⇒ 估算 ≤3× v11 | 移 nightly；PR 只跑 1 seed 烟测 |
| JSON 体积（同 seed） | 以 v11 字节数为分母 | **≤3.0×**（6 段/s vs 2 段/s；稀疏 main/ball 抵消一部分） | 超限：只带 movers、省略零位移 main/ball、必要时压缩；不新增随机 |
| viewer 5min 加载 | 待实测（`buildGameIndex` 是主成本） | ≤2× v11 加载时间；目标 ≤1 s | 超限：索引缓存 / 分块 |
| viewer 90min 加载 | 待实测 | 目标 ≤10 s、峰值内存 ≤2× v11 | 超限：分块 / 只索引高亮邻近窗 |
| seek | 待实测 | ≤50 ms | 超限：二分索引已存在，查锚点数组 |
| 帧耗时 | 待实测 | ≤16 ms（60fps） | 超限：关闭 T1/Catmull（默认已关） |

首个实现实验只跑 1 seed smoke，确认成本后才铺全量（#170 的「先量后改」）。

## D8 Spec delta 清单（H4：设计批准前已补全）

正式 delta 已写入本 change 的 `specs/**`，**不是**只列行号/条款描述。清单：

| 文件 | 类型 | Requirement（精确头名） | Scenario 数 | 关键修改 |
|---|---|---|---:|---|
| `specs/event-stream-protocol/spec.md` | ADDED | `beat 段与切段` | 5 | 段起点/段长/首拍/切段/同刻排序/跨表示连续 |
| 同上 | ADDED | `beat 的死球与终场边界` | 2 | 死球 gap ≤2.0s、终场不产 beat |
| 同上 | ADDED | `稀疏 main/ball 的携带与状态失效` | 5 | 非零位移每段携带、零位移省略、seek 重建 |
| 同上 | MODIFIED | `beat 节拍事件字段` | 4（全保留） | 1s tick → 段（0.1/0.2）；`dt`；main/ball 携带规则 |
| 同上 | MODIFIED | `重开准备期球锚点` | 1（保留） | dead-zone 措辞删除；准备期首段静态锚点 |
| `specs/match-engine/spec.md` | ADDED | `确定性单步运动积分` | 5 | 起步/制动/反向/降速/狭窄冲突 |
| 同上 | ADDED | `到达与制动语义` | 1 | 删除 dead-zone 整拍冻结；到达半径/残余速度 |
| 同上 | ADDED | `高亮参与者与统一运动状态` | 2 | 同一积分器、不冻结、显示线与积分轨迹分离 |
| 同上 | ADDED | `高亮参与者的可达性检查与修复` | 6 | 可达性、改落点、门将、抢断、重开、无瞬移 |
| 同上 | ADDED | `段边界执行顺序` | 3 | 决策/事件先于 beat、非网格落地、终场排空 |
| 同上 | MODIFIED | `事件流过程真实性不变量（L2）` | 8（全保留） | beat gap 从段边界推导；速度带与填拍守卫 |
| 同上 | MODIFIED | `同队球员间距（≥2m）` | 9（全保留） | 段边界；位移 ≤ speed×beat.dt；分离不绕过加速度 |
| 同上 | MODIFIED | `球相关队形目标` | 5（全保留） | 防橡皮筋去 dead-zone；门将条款去 `DEAD_ZONE_METERS` |
| 同上 | MODIFIED | `控球阶段与攻防转换` | 6（全保留） | tackle 高亮 [T,T+0.5)；save 首个 decision 边界 |
| `specs/pitch-viewer/spec.md` | ADDED | `播放段与插值合同` | 5 | beat.dt、只插值同一轨迹、事件锚点优先、T1/Catmull 默认关、tackle 跨 3 段 |
| 同上 | MODIFIED | `静止球员 micro-motion` | 4（全保留） | C1 第一阶段默认关闭 T1；开启时语义不变 |
| 同上 | MODIFIED | `演绎节奏配置化（S4 边界明确）` | 2（全保留） | beatSeconds / tackleSeconds / highlightSeconds |

**自检清单（机械检查，见 D8.1）**

- [x] 每个 MODIFIED 头名与主 spec 逐字一致；
- [x] 每个 MODIFIED 复制了主 spec 的**全部** scenario（数量见上表）；
- [x] 同一 requirement 的多处修改已合并为一次 MODIFIED；
- [x] 无关 scenario 原样保留；
- [x] 无「与新增条款同义但反向」的 SHALL 残留（重点：dead-zone、每 tick main、1s beat）；
- [x] `openspec validate p1-motion-integration --strict` 通过（门槛，不是语义批准）；
- [x] 归档合并审计（不改主树）：见 D8.1 的 scenario 覆盖脚本。

### D8.1 归档合并审计（不改主树）

实现阶段（或设计复审）跑一个只读检查：对每个 MODIFIED requirement，从主 spec 抽取
`### Requirement:` 与全部 `#### Scenario:` 名，与 delta 的同名集合做**集合包含**检查；
缺任何一个 scenario 即失败。该检查不写主 spec、不依赖 `validate` 的语义判断
（`validate` 对 delta 头写错仍可能 exit 0，见 #170 审查闭环 #11）。

## D9 验收（H6）

### D9.1 验收决策表

| 项 | 指标定义（口径） | 样本身份 | 训练/留出 | 最小有意义改善 / 不退化边界 | 区间方法 | 失败 / 无结论处置 |
|---|---|---|---|---|---|---|
| 条件 `turn120` | 只计双方步速 ≥0.5 m/s 的相邻步；转角 >120° 的占比；frozen 24 窗口径 | Change 0 frozen 24 窗 + 真实 2 场 Metrica | frozen 24 窗 = **公开回归集**（已看过，不算留出）；引擎 seed 1–160 调参、321–440 留出 | 最小有意义：相对 v11 基线**降低 ≥50%**，且配对差 95% CI 下界 >0；目标：留出 ≤3× 真实 0.0104 | 按 seed/源比赛聚类的 bootstrap（10k），95% 百分位；配对差 | 留出不改善 → 回退 C1；只在训练 seed 改善 → 判失败（#170 审查闭环的「只靠训练 seed」） |
| `staticFrac` | 步速 <0.5 m/s 的球员步占比；frozen 口径 | 同上 | 同上 | 最小：相对降低 ≥30%；目标 ≤2× 真实 0.040 | 同上 | 若靠 0.5–1 m/s 漂移降低 → 由 D9.2 审计否决 |
| 速度谱 | p50/p90/p99（m/s），逐场算再平均（不跨场拼接） | 同上 | 同上 | 不退化：各分位 ≤ v11 +10% 或落在真实带内 | 同上 | 退化 → 回退 |
| 加速度尾部 | p99 `|Δv|/dt`（m/s²） | 同上 | 同上 | ≤ `A0` 上界 + 容差；不得靠瞬时折角刷高 | 同上 | 超界 → 失败 |
| 路径效率 / 回环 | 5s 窗内净位移 / 路径长度；回环率 = 效率 <0.5 的窗占比 | 同上 | 同上 | 不恶化：效率不低于 v11 −5%，回环率不高于 v11 +5pp | 同上 | 恶化 → 失败（防「大回环」） |
| 低速转向 | 只计步速 ∈ [0.5,1.5] m/s 的 turn120 | 同上 | 同上 | 不高于 v11；且 `jitterRatio`（速度 ∈[0.5,1.0] 且 1s 净位移 <0.5m 的占比）不高于真实 + 5pp | 同上 | 超界 → 失败（防微抖刷 staticFrac） |
| 残余漂移 | 到达后 1s 内净位移；`RESIDUAL_SPEED_MAX=0.2` | 同上 | 同上 | 到达目标 1m 内后净位移 ≤0.2m/s | 同上 | 超界 → 失败 |
| L1 体量/分布 | 射门 [14,29]、抢断 [24,50]、传球成功率 [0.82,0.90]、犯规 [16,30]（main spec 现行带） | 200 场，固定 seed 列表（Phase 0 落盘） | 1–200 为门；321–440 为留出 | 逐条在带内；角球带按 D11 #4 重锚 | 逐场值 + 200 场均值；不做「挑绿」 | 破带 → 停止，另立标定 change；不得放宽真实带 |
| 球静止 ballStatic | viewer 链读数 | 5min/90min viewer 窗口 | — | **只作报告项，不作门** | 报告 | 不据此判成功/失败 |
| 盲测 | 强制二选一「哪边是真实」；同渲染器、盐/key 隔离、含负控 | **72 clip 为结论下限**（48–71 只作筛查），每个来自**不同源比赛/seed**；≥5 零上下文裁判 | clip 级划分；留出源比赛不参与调参 | 主判据：**不可区分**——准确率 95% CI 含 0.5 且半宽 ≤0.15（72 clip 的二项 SE≈0.059，cluster bootstrap 下取 0.15 作为可执行上界）；负控（real-vs-real / engine-vs-engine）用于估计偏置 | 按 clip 聚类 bootstrap；报告每个裁判与每个源比赛 | CI 下界 >0.5 → 可区分，失败；CI 含 0.5 但半宽 >0.15 或 clip <72 → 无结论，按预注册上限扩样；不得把「点估计接近 0.5」当通过 |

**门槛 vs 目标**：表中「最小有意义改善」是通过门槛；「目标」列是方向，不达目标不自动判失败，
但必须在 PR 记录缺口与后续票（不得把目标值当已达成）。任何「不退化」行都是硬门。

**冻结 24 窗的定位**：只作**公开回归集**（防退化），不作留出、不作唯一成功证据。
留出必须来自**未参与调参**的源比赛/seed；同一场比赛的所有窗口只能整体落在一侧。

**真实数据集分层**：Metrica 2 场 = 1 场标定 + 1 场留出；SkillCorner 20 场按整场分组
= 14 标定 + 6 留出。真实拟合带保留；**护栏带不是真实拟合带**（护栏只守「不塌缩/不爆炸」，
破护栏 ≠ 变差；见本仓既有教训）。

**先测权威 L1 基线**：Phase 0 在 main 同配置跑 200 场，落盘读数与红清单；D9 的「v11 基线」
一律指这份实测，不指历史转述。若实测红清单与「已知 4 红」不同，以实测为准并在 note 记录差异。

**对 #170 `lf.disp≥10.77m` 的替代**：见 D1 最后一行；`disp` 只作「不退化」报告，不再作主靶。
替代依据是 Change 0 的 AUC 0.514 与 viewer 消融（不可自证，来源已标）。

### D9.2 视觉与审计

- `trajectory.mjs` + `contact-sheet.mjs` 覆盖：开放比赛、攻防转换、长传、禁区、松散球、死球。
- 用户尺度：`viewer-match.mjs` seed42/5min，先报 5min 再报 90min。
- 判据是「长直段/瞬时折角/平行车道」是否减少，不是单一指标。
- 低速转向 / 路径回环 / 残余漂移审计（D9.1 的三行）是**防微抖刷指标**的硬审计；
  它们与 turn120/staticFrac 一起看，不能只看后两者。

### D9.3 盲测执行

- 48–72 项、≥5 名零上下文裁判、同渲染器、盐/key 隔离、含负控。
- **48–71 clip 只作筛查；「不可区分」的结论需要 ≥72 clip 且 CI 半宽 ≤0.15**。
- 预注册；base 与候选配对、顺序平衡、留出选窗；按源比赛/seed 聚类统计。
- 不以「准确率 <0.5」当成功；看区间与反向可识别性。
- 有效样本 = **clip 数**（每个来自不同源），不是「clip × 裁判数」；裁判评分按 clip 聚类。

## D10 风险与回退

| 风险 | 表现 | 回退/缓解 |
|---|---|---|
| 惯性追跳变目标 | 大回环、绕圈 | 目标每 decision 拍保持；限制 `ω_max`；路径效率/回环审计；留出窗不改善则回退 |
| 制动增加静止 | `staticFrac` 反而升高 | 到达半径 + `RESIDUAL_SPEED_MAX`；与条件 turn120 联合验收；不允许 0–1 m/s 漂移 |
| 分离 solver 绕过加速度 | 端点被推、速度不一致 | 三层分离（目标/预测/投影）；`constraint_infeasible` 显式红；不能只改端点 |
| 球/人不一致 | 接球者到不了落点、球瞬移 | `reachable()` 前置检查；修复顺序（延长→改落点→失败）；finalize 无瞬移断言 |
| 事件率漂移 | 射门/抢断/犯规越带 | 决策仍 2Hz；不新增 RNG；L1 逐条对照；概率常量不动，必要时另立标定 change |
| 5Hz 体积（实际 3×） | JSON/内存 ~3× | D7.5 预算；只带 movers、省略零位移 main/ball；超限压缩，不新增随机 |
| viewer 双运动 | 引擎连续 + T1/Catmull 叠加 | 第一阶段默认关闭；视觉验收后再单独决定 |
| 研究门红 | p15/p16/p18/p17a/p17b/p124 固定 seed 失效 | 换样本不换判据；Phase 0 先做不变量化夹具；产物门用显式 `--ignored` 重跑 |
| 基线数据缺失 | `benchmark-baseline` 生成失败 | Phase 0 先确认数据身份/离线可用；缺数据则停在 Phase 0（D7.4） |

## D11 决策记录（用户已拍板，2026-11-21）

用户决定：**六项全部按推荐**。以下不再是开放项；后续审阅/实现不得把它们重新当成待定。

| # | 决策 | 已定值 |
|---|---|---|
| 1 | 决策 cadence | **保持 2Hz**（`DECISION_DT=0.5`），不回 #170 的 1Hz |
| 2 | beat cadence | **5Hz 名义**（`BEAT_DT=0.2`），决策/事件切段后实际 6 段/s（D2.3） |
| 3 | 协议字段 | **第一阶段只发端点**（`from/to/speed/action`），不加 `vx/vy/heading`；`dt` 是段长时序字段，不算运动矢量 |
| 4 | 角球带 | **重锚到真实锚 ~10.27**，保留单场 max 护栏；不降级为报告项、不删门 |
| 5 | 守卫不变量化 | **作为本 change 的 Phase 0**（p53/p31/p6/p32 替换夹具，保留契约） |
| 6 | C1 范围 | **只做运动执行**；C2/C3/C4/C5 不在本 change |

## D12 批准记录

- **2026-11-21**：用户在会话中拍板 D11 六项全按推荐。
- design 正式批准（#170 评论「design 批准」或 PR approve）：_待填_。
- 批准范围：C1 运动执行 + Phase 0 守卫/角球前置；不含 C2–C5。
