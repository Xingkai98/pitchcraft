# Design: 引擎统一运动执行层（C1 运动学，GitHub #170）

> **状态：待用户批准（design-only，不写实现）。**
> 批准方式（#170 已定）：用户在 #170 评论「design 批准」或在对应 PR approve。
> 批准链接：_待填_。
>
> 本 design 回答 #170 的八问，并按 main v11（2026-10-30）的现状更新 #170 的旧默认值。
> **#170 里写的 `TICK_SECONDS=1.0` / `MODEL_VERSION=9` 已过时；当前 main 是 2Hz、v11。**

## D0 目标、边界与不做什么

**目标**：把「每拍目标点 + 固定步长 + dead-zone 冻结」换成「每球员有速度/朝向状态、受加速度/制动约束的连续运动」；在不改变事件概率常量的前提下，让渲染帧的条件 `turn120`、`staticFrac`、速度谱向真实靠近。

**做**：

- 每球员 `MotionState { vel_mps, heading, mode }`；`pos_m` 内部米制。
- 10Hz 仿真积分 / 2Hz 决策 / 5Hz beat。
- 统一执行：carrier、无球、高亮参与者、门将、重开走位、同队分离。
- 协议版本化、golden 重基线、L1/ratchet 重标定（在受控范围内）。

**不做**：

- 不做 C2 站位表、C3 盯人、C4 压迫场、C5 持球者搜索（后续票）。
- 不改高亮事件（pass/shot/tackle/foul）的类型、频率、概率常量（地图 #175 的第一原则）。
- 不在本 change 修 viewer 的视觉风格；只在协议/插值层做必要同步。
- 不把「更接近统计带」当唯一目标；最终验收是盲测 + 用户观感。

## D1 与 #170 默认口径的差异（必须显式记录）

#170 写于 main v9/1Hz 时代；当前 main（`16dfaa0`）已经是 v11/2Hz。差异如下：

| #170 默认 | 本 design | 理由 |
|---|---|---|
| 仿真 10 Hz / 决策 **1 Hz** / beat 5 Hz | 仿真 **10 Hz** / 决策 **2 Hz** / beat **5 Hz** | main v11 已把决策拍改为 2Hz（`TICK_SECONDS=0.5`），事件体量/概率已在该节拍上重标定。再回 1Hz 会重开一整轮事件率校准；Change 0 的仪器能测，但没有必要。**决策仍 2Hz** 是本 design 对 #170 的明确推翻。 |
| `MODEL_VERSION 9→10` | **11→12** | 当前 main 已是 11。 |
| 真实锚 2 场 Metrica | 2 场 Metrica + Change 0 的 frozen 24 窗（SkillCorner 真实窗为转述/受限） | Change 0 已建条件指标与 frozen 集；真实侧仍以 2 场 Metrica 为可复现锚，SkillCorner 标口径。 |
| `DEAD_ZONE_METERS` 删除 | **删除「到点冻结」语义**，但保留「到达半径/制动」 | dead-zone 是「到点不产 mover」的根因；运动层用制动曲线到达，不用 2m 硬开关。 |

## D2 三层 cadence 的落点

### D2.1 三个常量

| 常量 | 值 | 语义 |
|---|---:|---|
| `SIM_DT` | **0.1s** | 物理积分步长（内部子步） |
| `DECISION_DT` | **0.5s** | 决策/概率掷定间隔（= 当前 `TICK_SECONDS`） |
| `BEAT_DT` | **0.2s** | beat 输出间隔（viewer 采样对齐） |

LCM(0.2, 0.5) = 1.0s：beat 与 decision 每 1s 对齐一次；其余 beat 复用最近一次决策状态。三者都是 0.1 的整数倍。

### D2.2 代码落点

当前 `tick()` 假设「一拍 = 一次决策 + 一次 beat」。改为三个循环层：

```
for sim_step in 0..(DECISION_DT/SIM_DT) {   // 5 步
    integrate_motion(SIM_DT);               // 只动位置/速度/朝向，不掷骰
    if beat_due(t) { emit_beat(BEAT_DT); }  // 每 2 步
}
if decision_due(t) {                        // 每 5 步
    advance_action_opportunity(...);        // 现有决策/掷骰
    execute_action_resolution(...);
}
```

- 决策/掷骰仍只在 `DECISION_DT` 发生；仿真子步**不新增 RNG**。
- 高亮飞行/重开准备/死球仍按事件时间推进；`beat_due` 由全局 10Hz 时间轴驱动，不由 `tick()` 的调用次数驱动。
- 所有 `*_TICKS` 常量必须重新挂到 **decision 拍**计数器（#170 已列 17 个实际换域常量；当前 v11 已按 `TPF=2` 换过一轮，本 change 要再核一遍，不能假设）。
- `p16` / `p124` 的观测快照：当前契约是「快照数 == tick 数」；本 change 必须二选一并写死：
  - **A（推荐）**：快照仍按 decision 拍（`DECISION_DT`），不按 10Hz 子步；`expected_ticks` 用 `DECISION_DT` 重算；
  - B：快照降到 decision 拍会导致现有 `ceil(DUR/TICK_SECONDS)-1` 断言变化，必须改两个既有 change 的契约。选 A 的成本更低，且不改变观测语义。

## D3 `TICK_SECONDS` 的三重语义拆分

#170 已指出：`TICK_SECONDS` 同时承担三件事，拆错会破坏 `from(N+1)==to(N)` 连续性与 p53 族。

| 语义 | 当前位置/例子 | 新常量 |
|---|---|---|
| ① 物理步长 | `norm_step(speed * TICK_SECONDS)` | `SIM_DT` |
| ② beat / 决策间隔 | L2 beat gap、`t_end` 的常规高亮 | `BEAT_DT` / `DECISION_DT` |
| ③ 高亮锚点的「往前一步」 | `u(t + TICK_SECONDS)` / `highlight_frozen_segs` | **`BEAT_DT`**（不是 SIM_DT，也不是 1s） |

**特别警告（沿用 #170）**：tackle 高亮的 `t_end = t + TICK_SECONDS` 是**高亮时长**，不是 beat 间隔。当前 main 下它是 0.5s；本 change 保留 `DECISION_DT`（0.5s），**不要改成 0.2s**，否则 tackle 高亮会短 2.5×、松散球提前出现。save 高亮的「首个整数 tick 边界」改为「首个 decision 边界」。

## D4 运动模型与单位

### D4.1 内部米制

**决定：内部位置/速度/加速度全部用米制**（`pos_m`、`vel_mps`、`accel_mps2`），只在事件发射时转归一化：

```
x_norm = pos_m.x / 105.0
y_norm = pos_m.y / 68.0
```

理由（#170 Q7）：`norm_step(m)=m/105` 只对 x 对齐；若直接 `pos += vel·dt`，y 速度会被 68/105 机械压到 2.59 m/s，且没有测试能抓。内部米制是唯一能同时对齐 x/y 的方式。

### D4.2 速度/加速度

- 加速：`dv/dt = A0 · (1 − v/S0)`；A0 ∈ [6.3, 7.6] m/s²、S0 ∈ [9.2, 9.8] m/s（#170 的 PMC10880943 锚）。
- 侧向：`|ω| ≤ a_lat / max(v, 1)`；a_lat ∈ [6, 8] m/s²（PMC6132493）。
- 极速：`V_MAX ≈ 9.5 m/s`（EPL 光学追踪 9.53 ± 0.39）；冲刺通常 <1s（平均 5.9m）。
- 制动：`v_desired = min(V_MAX, sqrt(2 · a_brake · d))`，`a_brake` 与加速同量级；不设 2m 冻结。
- 到达：`d < ARRIVE_RADIUS_M` 时目标速度降到 0–1 m/s；允许微小 residual motion，不产「逐比特静止」。
- 模式速度上限：`run` / `sprint` / `close_down` / `chase` / `keeper` 各自的 `v_cap` 由现有常量映射（4.0 / 6.8 / 5.0 / 3.0 等），不新增战术语义。

### D4.3 目标与转向

- 目标仍由现有 `formation_target` / `close_down` / `chase` / `corner_setup_target` 产生；本 change **不新增战术任务层**。
- 目标每 decision 拍更新；仿真子步内目标保持，避免目标抖动直接变成方向抖动。
- 转向用 heading 的一阶限制；目标方向与 heading 的夹角超过 `MAX_TURN_RATE` 时，按最大角速度转，不瞬时反向。
- 目标不可达/被 separation 推离时，记录 constraint violation，下一子步重新求解；不得让 solver 直接改端点绕过加速度约束。

### D4.4 同队分离与碰撞

- 同队 2.2m 约束保留（P34/#53 的契约），但从「直接推端点」改为「约束求解 + 速度修正」：推完后用位移差/`SIM_DT` 更新速度，并把加速度/转向上限纳入求解；若无法同时满足，优先保持间距，标记本子步的 velocity correction。
- carrier 仍参与端点分离，但射门推进/起脚窗口的 swept_light 豁免保留（P34 的教训）。
- 高亮参与者的滑行段继续作为约束；其显示轨迹必须与运动层同一时间语义（`BEAT_DT`）。

## D5 事件流与协议

### D5.1 beat 5Hz

- `beat` 每 `BEAT_DT=0.2s` 一条；`movers` 含本拍在动的球员（`from/to/speed/action`）。
- `main` / `ball` 的携带规则必须写死，避免 2.5 倍重复：
  - **推荐**：`main`/`ball` 只在「状态变化」或 decision 拍携带；其余 beat 只带 `movers`，viewer 保持上一状态。
  - 若 reviewer 认为这破坏现有「beat 必有 main 或 ball」的 spec，需在 spec delta 里显式 MODIFIED，不能只改测试。
- `MODEL_VERSION 11→12`；新 `engine/tests/golden-v12/`；旧 golden 保留。

### D5.2 是否加 `vx/vy/heading`

**推荐：第一阶段不加**。5Hz 端点 + viewer 线性插值已足够连续；加字段会扩大协议/测试面。若视觉验收发现 5Hz 线性仍有折角，再以可选字段加入（`vx/vy/heading`），并 bump 协议版本。

### D5.3 高亮时长

- tackle：保留 `DECISION_DT=0.5s`（当前语义），不跟 `BEAT_DT`。
- save：首个 decision 边界武装 transition。
- pass/shot：飞行时长仍由距离/速度决定；`tick_filling_flight` 的「填满一拍」改为填满 `BEAT_DT` 还是 `DECISION_DT`？**推荐填满 `BEAT_DT`**（0.2s），因为 beat 是渲染拍；但这会让短传速度更高，需在 L2 传球速度契约里重标（见 D7）。

## D6 Viewer

- `viewer/config.js` 的 `interpretation.tickSeconds` 改为 `beatSeconds=0.2`；`game.js`/`interpretation.js` 的 beat 铺满、Catmull 邻窗、T1 纹理都以 `beatSeconds` 为准。
- **第一阶段**：viewer 只做 5Hz 端点线性插值；Catmull/T1 默认关闭。引擎的运动已经连续，viewer 不应叠加第二套运动。
- 传球/接球者的滑行锚点必须与运动层同一时间语义；若引擎已输出接球者轨迹，viewer 不再自行合成。
- 缓存版本号：`viewer/index.html` 的 `app.js?v=` 与 app.js 的 import specifier 必须同步 bump（CLAUDE.md §4）。
- 视觉验收：trajectory/contact-sheet，看「长直段/折角/平行车道」是否减少；若 viewer 仍制造折角，再单独修 viewer。

## D7 测试、golden、L1 与守卫

### D7.1 先量后改

- 改动前：`node tools/ratchet.mjs save openspec/changes/p1-motion-integration/notes/ratchet-before.json`。
- 改动后：`node tools/ratchet.mjs diff ...`，有退化 exit 1。
- 预注册指标：条件 `turn120`、`staticFrac`、速度 p50/p90/p99、加速度尾部、路径长度、ballStatic（标 viewer 链 caveat）。
- 训练/留出 seed 与真实窗分开；条件 `turn120` 用 `tools/visual-review/motion-census.mjs` 的 frozen 口径。

### D7.2 L1 / 守卫

- 当前已知 4 红：`l1_shot_result_distributions`（box goal ~0.06）、`l1_tackle_dilution_and_slot_mix`（角球）、`l3_shot_ratios`（射正 ~0.47–0.49）、`l1_home_away_goal_asymmetry`。
- **角球带决策（必须在实现前拍板）**：均值 [1,7] 是护栏带、真实 ~10.27；二选一：
  - 重锚到真实锚（例：均值 [7,13] + 保留单场 max 护栏）；
  - 或降级为报告项（不得删红门）。
- **p53/p31/p6/p32**：改成「显式构造场景 + 条件断言 + 多 seed 置信范围」的夹具，保留契约；本 change 必须先做这个前置（可作为一个独立 task）。
- `p16` / `p124` 的观测快照按 D2.2 A 案处理；`l2_cross_event_invariants` 的 beat gap 断言改为从 `BEAT_DT` 推导，不写死 {1.0,2.0}。
- `DEAD_ZONE_METERS` 的 spec 条款（`match-engine:729/755`）必须显式 MODIFIED；不能只改代码。

### D7.3 golden / 研究门

- `MODEL_VERSION=12`，`engine/tests/golden-v12/`；`ACCEPT_GOLDEN=1` 重基线。
- `p15/p16/p17b/p124` 的固定 seed/读数门需重扫；换样本不换判据；不得静默放宽。
- `benchmark-baseline.json` 的 `engineFingerprint` 需重生成；CLAUDE.md 的「注释变哈希也变」规则仍适用。

## D8 Spec delta 清单（实现时必须同批改）

> #170 的行号基于旧 main；下面是 2026-11-21 在 `main=16dfaa0` 上重新扫描的**需求名**。
> MODIFIED 必须复制主 spec 的**全部 scenario**（本仓 archive 的已知坑）。

| 文件 | 需求/条款 | 处置 |
|---|---|---|
| `openspec/specs/event-stream-protocol/spec.md:28` | beat 描述一个 tick（1s） | MODIFIED：beat = 0.2s；`movers` 语义 |
| `openspec/specs/event-stream-protocol/spec.md:219` | restart_prep「dead-zone 吞掉 <2m」 | MODIFIED：到达半径/制动；不再用 2m 冻结 |
| `openspec/specs/match-engine/spec.md:229` | 相邻 beat gap ∈ {1.0,2.0} | MODIFIED：从 `BEAT_DT` 推导（当前 main 代码已是 0.5/1.0，spec 已漂移） |
| `openspec/specs/match-engine/spec.md:591` | mover 单拍位移 ≤ speed×1s | MODIFIED：≤ speed×`BEAT_DT` + 分离余量 |
| `openspec/specs/match-engine/spec.md:729` | SHALL NOT 改 `DEAD_ZONE_METERS` | MODIFIED：显式推翻，说明理由 |
| `openspec/specs/match-engine/spec.md:755` | 静区 2.0m / 先 dead-zone 后 approach cap | MODIFIED：到达/制动语义 |
| `openspec/specs/match-engine/spec.md:763` | tackle 高亮 1 tick [T,T+1) | MODIFIED：1 decision tick（0.5s）[T,T+0.5) |
| `openspec/specs/match-engine/spec.md:767` | save 高亮后首个整数 tick 边界 | MODIFIED：首个 decision 边界 |
| `openspec/specs/pitch-viewer/spec.md` | 播放/插值/采样 | MODIFIED：5Hz beat、只插值同一轨迹、关闭 T1/Catmull 默认 |

⚠️ `realism.rs` 的 `ok_step` 用 `(dt − TICK_SECONDS) || (dt − 2×TICK_SECONDS)`；当前 main 下 0.5/1.0 都假绿。实现时必须改成从 `BEAT_DT` 字面量推导，否则 5Hz/10Hz 都能绕过。

## D9 验收

### D9.1 数值

- 条件 `turn120`（frozen 24 窗）从 0.829 向真实 0.0104 靠近；报旧/条件两列。
- `staticFrac` 从 0.239 向真实 0.040 靠近；同时报速度谱与加速度尾部。
- 路径长度/速度不恶化到「靠高速刷位移」；`disp` 不作为主靶（AUC 0.514）。
- L1：既有 4 红列清单；新增偏离必须按真实锚联合重标定；护栏仍检查退化。
- 确定性、坐标、身份、事件/状态对账、球权一致是硬门；spacing overlap = 0。

### D9.2 视觉

- `trajectory.mjs` + `contact-sheet.mjs` 覆盖：开放比赛、攻防转换、长传、禁区、松散球、死球。
- 用户尺度：`viewer-match.mjs` seed42/5min，先报 5min 再报 90min。
- 判据是「长直段/瞬时折角/平行车道」是否减少，不是单一指标。

### D9.3 盲测

- 48–72 项、≥5 名零上下文裁判、同渲染器、盐/key 隔离、含负控。
- 预注册；base 与候选配对、顺序平衡、留出选窗；按源比赛/seed 聚类统计。
- 不以「准确率 <0.5」当成功；看区间与反向可识别性。

## D10 风险与回退

| 风险 | 表现 | 回退/缓解 |
|---|---|---|
| 惯性追跳变目标 | 大回环、绕圈 | 目标每 decision 拍保持；限制 `MAX_TURN_RATE`；留出窗不改善则回退 |
| 制动增加静止 | `staticFrac` 反而升高 | 到达半径 + 最小 residual speed；与条件 turn120 联合验收 |
| 分离 solver 绕过加速度 | 端点被推、速度不一致 | 约束求解 + velocity correction；不能只改端点 |
| 球/人不一致 | 接球者到不了落点、球瞬移 | 接球可达性检查；高亮锚点与运动段同语义 |
| 事件率漂移 | 射门/抢断/犯规越带 | 决策仍 2Hz；不新增 RNG；L1 逐条对照；必要时联合重标定 |
| 5Hz 体积 | JSON/内存 ~2.5× | 评估；只带 movers；必要时压缩 |
| viewer 双运动 | 引擎连续 + T1/Catmull 叠加 | 第一阶段关闭 T1/Catmull；视觉验收后再决定 |
| 研究门红 | p15/p16/p124/p17b 固定 seed 失效 | 换样本不换判据；先做不变量化夹具 |

## D11 需要用户拍板的决策

1. **决策 cadence**：保持 2Hz（推荐）还是回 #170 的 1Hz？
2. **beat cadence**：5Hz（推荐）还是 4Hz/10Hz？
3. **协议字段**：第一阶段只发端点（推荐）还是加 `vx/vy/heading`？
4. **角球带**：重锚到真实 ~10.27（推荐）还是降级为报告项？
5. **守卫不变量化**：作为本 change 的 Phase 0（推荐）还是单独 pre-change？
6. **C1 范围**：只做运动执行（推荐）还是顺带 C2 站位表？

## D12 批准记录

（待用户批准后填写：日期、链接、批准的范围/例外。）
