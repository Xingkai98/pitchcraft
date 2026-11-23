# G2 逼问：物理 / 可行性 / 性能（C1 运动层 design）

> 审阅镜：物理 / 可行性 / 性能。**只读**：未改 design/spec/引擎/viewer，未 commit。
> 树：本 worktree（`p1-motion-integration/2026-11-21`，HEAD=`8728a02`）；主代码基准 = `engine/src/lib.rs` / `viewer/*.js` 当前内容。
> 已读：design.md 全文、`specs/match-engine/spec.md`、`specs/event-stream-protocol/spec.md`、tasks.md、`notes/review-gpt61-2026-11-21.md` 的 Round 6 与 Fix log，以及 main 的 `tick` / `compute_mover_candidates` / `commit_beat_positions_ex` / `separate_same_team_m` / `highlight_frozen_segs` / `finalize_highlight`、`viewer/game.js` / `interpretation.js` / `config.js`。
> **数字口径**：引用带文件:行；自算的数在同段给出算式与全部操作数（可复算）；凡是 G2 自己的估算一律标「G2 估算（非实测）」。

## A. 设计已钉死、不需要用户再决策的事实

- **F1 三时钟与快照域**：`SIM_DT=0.1` / `DECISION_DT=0.5` / `BEAT_DT=0.2`，`tick` 仍是 decision、10Hz 只是内部子步，观测快照数与 tick 数契约不变（design.md:80-87、:314-318）。
- **F2 唯一执行路径**：`CommittedPlan` 覆盖 `[t_c,P_eff]`，覆盖内只消费缓存、不 `decision()`/不掷骰；`P_end` 的 decision 归 live，`cp_end` 在其之前（design.md:89-141、:145-222；match-engine spec:117-171）。
- **F3 统一运动、锚点=积分终点**：含高亮参与者的所有角色同一 `MotionState`/同一分离 solver，不冻结、不隐藏、不投影；事件锚点 = 连续积分（含分离）到 `t_end` 的位置（design.md:645-717；match-engine spec:85-105、:207-211）。当前 main 的 `finalize_highlight` 是**直接写 `st.pos`**（lib.rs:5186-5189），这是本 change 要拆掉的那条旧路径。
- **F4 运动学与预算**：`A0=6.4–7.8`、`S0=9.2–9.8`、`a_lat=6.5`、`V_MAX=9.5`、`A_MAX=8.0`、`V_REVERSE=0.5`、到达/精确半径 1.0/0.25m、`RESIDUAL_SPEED_MAX=0.2`（design.md:357-371）；`A_MAX` 是**总向量预算（含分离与边界清零）**（design.md:416-432；match-engine spec:49-67）。
- **F5 合法断点与 finalize**：只有 kickoff / 死球重开 / 进球回中圈 / 罚下 / 终场允许位置跳变；finalize = 第一个 ≥ `t_end` 的 0.1s 网格步；其余跳变一律失败（design.md:276-298、:706-717；match-engine spec:213-239）。
- **F6 Viewer 语义**：新流按 `beat.dt`、旧流整条用 `legacyBeatSeconds=0.5`、tackle 恒 0.5（=DECISION_DT）、T1/Catmull 默认关（design.md:741-804；tasks.md:66-67）。
- **F7 边界钳制不覆盖球**：球员 `pos_m` 钳 `[0,105]×[0,68]`；当前重开点本就**在线上**（角旗 `(0|1,0|1)` lib.rs:5613；界外球 `y=0|1` lib.rs:5633-5637），本仓从不把掷球者放到场外。⇒ 该钳制与现模型不冲突，但 `ball_pos` 的飞行/出界锚点不得被同一钳制截断（这是实现规则，不是用户决策）。

## B. 决策题

### Q1 `A_MAX=8.0` 与「A0 加速 + a_lat 转向」两套律不自洽——照字面实现必被裁剪
**问题**：design 声称 `A_MAX` 只要 `≥ max(A0_max, a_lat)` 就不会裁剪正常运动（design.md:371、:440-441）；但纵向与横向是**同时**发生的，向量上界是 `sqrt(A0(v)² + a_lat²)`。
**证据/算式**（全部操作数见 design.md:359-361）：v=2 m/s、A0=6.4、S0=9.5 → 纵向 `6.4×(1−2/9.5)=5.053`，合成 `sqrt(5.053²+6.5²)=8.233 > 8.0`（+2.9%）；取 A0=7.8、S0=9.8 → 纵向 `7.8×(1−2/9.8)=6.208`，合成 `sqrt(6.208²+6.5²)=8.988`（+12.4%）。不被裁剪的必要条件是 `A_MAX ≥ sqrt(7.8²+6.5²)=10.15`。design 的数值例（design.md:435-439）只覆盖 v=6、θ_err=0.2（合成 0.703），没覆盖低速大转向。
**选项**：
- A. 抬 `A_MAX` 到 10.2（或 `sqrt(A0_max²+a_lat²)` 上取整），同步改加速度尾部软目标（现为 `A_MAX+10%`，design.md:979）。
- B. 保留 8.0，把它定义成**权威摩擦椭圆**：把 `dv/dt=A0(1−v/S0)`、`|ω|≤a_lat/max(v,1)` 的措辞改成「期望指令，受 A_MAX 裁剪」，并加「预算裁剪次数」报告量。
- C. 压 `a_lat` 到 ~1.8 使 `sqrt(7.8²+1.8²)≤8` —— 物理上明显过小。
**推荐**：B。**需要用户决策：否**。实现规则：保留 8.0，修正 design.md:371/:440-441 的「不裁剪」主张为「预算优先」，并加单测钉住低速大转向会被裁剪且裁剪有界；裁剪率只作报告、不作门。

### Q2 「参与者末速 ≤0.5 m/s」对所有角色成立吗？——对抢断/扑救是物理错误
**问题**：可达性判据统一要求 `v_end ≤ REACH_SPEED_TOL=0.5`（design.md:696-698；match-engine spec:175），但设计同时把 tackle 双方、门将扑救、拦截者都列为「参与者」（design.md:654-660）。抢断是碰撞、扑救是扑身，**到点必须还在动**；要求末速 ≈0 会把两类事件判成不可达。
**证据**：当前引擎 tackle 终点就是双方接触点、门将终点就是射门门线落点（lib.rs:4785 `save_pos=(x2,y2)`；lib.rs:5186-5189 直接写位置）；射门 save 是概率结果（lib.rs:4731-4743）。若实施该判据：(i) 射门 save 被大量否决，而否决率硬上限是「原 save 结果的 2%」（design.md:727），大概率直接撞停；(ii) 所有接球者被迫先停再接，`staticFrac` 反向升高，与 D9.1 的 staticFrac 目标（design.md:977）打架。
**选项**：
- A. 拆两类到达语义：**settle**（重开者、需要停的连接球）要求 `v_end≤tol`；**impact**（tackle 双方、门将扑救、拦截者、以及允许跑动接的接球者）只要求**位置可达 + 末速在 `[0, mode_cap]` 内**，不要求停。
- B. 保留单判据，用 2% 否决顶盖上界，接受事件统计漂移。
- C. 按角色给不同 tol（接球者 0.5、抢断 8.1、门将 3.0 等）。
**推荐**：A（C 是 A 的特例）。**需要用户决策：是**——它改变「可达性」的定义与射击/抢断结果统计，属 design 语义变更，不是实现细节。

### Q3 分离投影的位移预算与 main 的实测位移差 8.5×；预测层视野只有 0.1s
**问题**：design 要求分离修正计入 `|Δv_total|≤A_MAX·SIM_DT`，即每 0.1s 最多 **0.08m** 的分离位移（`8.0×0.1`，design.md:416-426；match-engine spec:51）。但 main 的分离 solver 每**拍**给每人 `SAME_TEAM_MIN_DIST_M×3=6.6m` 预算（lib.rs:6628；`SAME_TEAM_SWEPT_PUSH_CAP_M` 同值，lib.rs:974），且注释记「近对穿的侧推需数倍阈值才收敛（实测 ~3.4m）」（lib.rs:971-974）。按 0.5s 拍折算 ≈6.8 m/s，是 0.8 m/s 预算的 **8.5×**。同时速度预测层的视野写成「本段预测最近距离」（design.md:460-462）——0.1s；而横向让出 1m 需要 `sqrt(2×1/8)=0.50s`、让出 2.2m 需要 `sqrt(2×2.2/8)=0.74s`（同段算式，a=A_MAX）。⇒ 按现文本，预测层来不及，投影层又只够 8cm，真实对穿必 `constraint_infeasible`。
**选项**：
- A. 保留「同一 A_MAX 预算」，但把预测层视野改成 `max(0.75s, 到最近接近时间)`，并在 smoke 里**计数投影层触发次数**（预注册目标：20 seed 内 0 次）；触发即停止定位。
- B. 给分离单独有界预算（如每 0.1s 允许 ≤2.2m 投影 = 22 m/s），显式记 `separation_push` 事件量并保留 A0/a_lat 的加速度约束不变。
- C. 只信目标层（目标已 ≥2.2m），删投影层。
**推荐**：先 A，并把 B 作为**预注册的应急分支**（若 smoke 证明 A 达不到，再切 B；不得静默放宽）。**需要用户决策：是**——B 会改「分离与加速共用一个预算」的 spec 条款。

### Q4 扑救点与「射门 x2/y2 = 门线」的 L2 条款冲突，且事件没有扑救时刻字段
**问题**：design 把扑救点定义为球路径上与门将可达集的**最早交点**（design.md:658），门将终点 = 该点、在 `t_end` 到达；但射门的 `t_end` 是球飞到**门线落点**的时间（lib.rs:4757），L2 又钉死 saved 的 `x2` = 门线（match-engine spec:261-263）。若扑救点在门线之前，球到达该点早于 `t_end`——画面里门将「晚到」，或球「穿过」门将后才被扑。
**选项**：
- A. 事件增加 `save_x/save_y/save_t`（或显式 `duration`）字段：finalize 在 save_t，扑救点用新增字段；`x2/y2` 仍保持门线语义给 L2。协议 bump。
- B. 把 saved 射门的 `x2/y2` 重定义为扑救点，连带改 L2 的「saved x2 = 门线」scenario。
- C. 保持门将终点 = 门线落点（回到现状的冻结/投影，违反 F3）。
**推荐**：A。**需要用户决策：是**——A 是协议加字段（D11 #3「只发端点」的边界要重新说明），B 改 L2 守卫。

### Q5 前视规划成本与「超预算允许什么降级」没有可执行梯子
**问题**：D7.5 的规划预算是「平均视野 ≤1.0s、最大 ≤12.5s、拒绝率 ≤5%、缓存 ≤64MB」（design.md:894-907），但没给**每场规划次数**与**总 CPU 上限**，也没写超预算时允许降什么。事件量：传球事件 L1 断言 ≥300/场（60000/200，realism.rs:1060-1068），同文件另有两处互相矛盾的注释数（`~403/场` realism.rs:1057 与 `396→844/场` realism.rs:1036）——**G2 不裁决哪个对，Phase 0 以实测为准**；即便取 300，加上射门 14–29、抢断 24–50（design.md:983），每场仍需数百次计划。
**G2 估算（非实测，操作数全在仓内）**：活体运动从 2Hz 变 10Hz ⇒ 运动子步 5×（design.md:884）；每次计划平均 ~10 步（视野 ≤1.0s / SIM_DT=0.1）；规划步数 ≈ 300–900 场次 ×10 = 3000–9000 步，相对活体 54000 步（5400s/0.1）约 +6–17%；但分离 solver 从「每 0.5s 一次」变「每 0.1s 一次（预测+投影各一轮）」，其 O(n²) 成本约 10–15×，而 D7.5 给默认套件 +10–30%、L1 ≤2×（design.md:884-886）。WASM 端更慢：viewer 在浏览器里**同步生成整场**（app.js:257-284），90min 加载目标 ≤10s（design.md:890）。
**选项**：
- A. Phase 0 先用 1 seed 在 release + wasm 实测「活体 5× + 规划」的总时长，预注册两个门（L1 ≤2× v11、wasm 90min simulate ≤ X s），不达标就停，不进实现。
- B. 接受 3–5×，把长套件移 nightly、PR 只跑烟测。
- C. 允许的降级梯子：只做**保真度不变**的优化（目标缓存、邻居表、预分配、只对可能冲突的 pair 做预测）；**明确拒绝**「少算 22 人」「先写锚点再让分离推」。
**推荐**：A，降级只允许 C。**需要用户决策：是**——若实测超预算，是抬 CI/nightly 预算还是降计划保真度，属批准范围。

### Q6 高亮期间根本没有事件决策，`CommittedPlan` 的 decision/RNG 机制是为不存在的分支建的
**问题**：`tick()` 在高亮分支直接早退（lib.rs:3543-3559），高亮期间不评估机会、不掷事件 RNG，只做无球目标刷新与 beat。design 仍为计划覆盖内的每个 decision 定义「结果缓存 + `cp_s` + decision 所有权」（design.md:106-122），并为 RNG 三路核对称「实际 == `cp_s`/`cp_end`」（design.md:134-141）。另外「逐边界核对实际状态 == 缓存状态」（design.md:169）里被核对的 state 本来就**赋值自缓存**，它只能抓调度接线错误，抓不到物理漂移（本仓「空转断言」教训）。
**选项**：
- A. 把「高亮期间无事件决策（只有零 RNG 的目标/模式刷新）」写成不变量并加单测；计划只保留 `cp_commit`/`cp_end` 两个 checkpoint；显式注明状态核对是接线守卫，不是物理等价证据。
- B. 保留完整 decision/RNG 机制（成本/复杂度 + R6-M3 的对象歧义）。
- C. 计划只算物理、不算目标刷新（会让计划与 live 的目标不一致，违反 F2）。
**推荐**：A。**需要用户决策：否**。实现规则：先写单测证明高亮内零 RNG；若证伪，停止并重开 design。

### Q7 若干部件常量没有值 / 互相打架（`MAX_TURN_RATE`、`V_EPS`、`a_brake`、`S0` vs `V_MAX`）
**问题**：`MAX_TURN_RATE` 在 D4.4 第 3 步与数值例里被使用（design.md:410、:436），但 D4.2 参数表（design.md:357-371）、spec、tasks 都没给值；`V_EPS` 同样无值；`a_brake` 写成「=A0 起步」的**区间** 6.4–7.8，却在 `sqrt(2·a_brake·(d−R))` 与 `−a_brake·dt` 两处要求同一个标量；`S0=9.2–9.8` 与 `V_MAX=9.5` 区间重叠——取 S0=9.2 时 `A0(1−v/S0)` 在 v>9.2 变负，与 V_MAX=9.5 的期望速度对打。
**选项**：
- A. 钉一张「motion constants v1」标量表并加不变量单测：`S0 ≥ V_MAX`（建议 `S0=9.8`）、`a_brake=6.4`、`V_EPS=1e-3`、`MAX_TURN_RATE=4.0 rad/s`（该值只在 v<`a_lat/4=1.625 m/s` 时生效，不改变 design.md:436 的数值例）。
- B. 留区间给实现者自行选（无法复现 golden，也无法复算数值例）。
**推荐**：A。**需要用户决策：否**。数值例的「`MAX_TURN_RATE` 不更紧」应改成「当 `MAX_TURN_RATE ≥ 1.0833`（=6.5/6）时，数值例成立」。

### Q8 Viewer 的「关 Catmull/T1」不是改配置值，是改三处接线
**问题**：`game.js:539` **无条件**调用 `_smoothNeighborPositions`，其门槛要求锚点跨度 ∈[0.5,1.5]s（game.js:632-640）。新流 0.2/0.1s 的 mover 链会自然落回线性（s1<0.5），但**事件派生的参与者锚点**（pass 飞行 0.3–1.2s）仍落在窗口内，除非新流不再发这些球员锚点（D6.3 要求参与者只由 movers 驱动）。T1 的 `PLAYER_TEXTURE.ampM=0.12` 默认开启（game.js:42、:177-180），要显式改 0。另有两处旧耦合会因拆分而红：`interpretation.test.js:163-168` 断言 viewer `tickSeconds` == 引擎 `TICK_SECONDS`；`derive-audit-features.js:122-130` 用 `tickSeconds` 铺 beat 时长。
**选项**：
- A. 加显式开关（`interpolation.smooth=false`、`textureAmpM=0`），新流停止发事件派生的球员锚点，同步把同步测试改成 `beatSeconds↔BEAT_DT` / `tackleSeconds↔DECISION_DT`，audit features 改读 `beat.dt`。
- B. 靠 0.5s 门槛「碰巧」关掉（不是设计决定，长飞行仍会被平滑）。
- C. 长飞行段继续 Catmull（与 F6 冲突）。
**推荐**：A。**需要用户决策：否**。

### Q9 落点/锚点的精确性与 viewer「距离÷速度」推导时长会错位
**问题**：pass 的 `x2/y2` 被定义为「接球者在 `t_end` 的连续积分位置」（design.md:656），修复路径又会**改落点**（design.md:699-702）；而 viewer 用 `dist/speed` 推飞行时长（interpretation.js:348-353）。若改落点后不重算 speed（或显式时长），viewer 显示的飞行终点时刻 ≠ 引擎 finalize 边界，球与 mover 端点会错开。重开者用 1.0/0.25m 到达半径停下，而协议写「发球 pass 起点 = 同一固定点」（event-stream-protocol spec:163-167）也不是精确相等。
**选项**：
- A. 事件 `x2/y2` 用**最终计划点**，并重算 speed 使 `dist/speed = t_end − t`；重开 pass 的 `x/y` 用发球者积分位置（目标=固定点），spec 措辞改成「在 `REACH_TOL_M` 内」。
- B. 协议加显式 `duration` 字段（一次性消除推导）。
- C. 接受误差（10 m/s 下 0.25m ≈0.025s）。
**推荐**：A（B 留作后续）。**需要用户决策：否**。

### Q10 「非零位移」需要发射 epsilon，否则 22 人每段都进 movers，3× JSON 预算不成立
**问题**：D5.1 定义 movers = 「该段有非零位移的球员」（design.md:477-478；event-stream-protocol spec:78-96），而 `RESIDUAL_SPEED_MAX=0.2 m/s` 允许「已停」球员在 0.2s 段内仍有 0.2×0.2=0.04m 的残余（design.md:369）。没有 epsilon 时，浮点残差与数值漂移会让近 22 人每段都发 mover；design 的 JSON 正常 ≤3×、密集 ≤5× 预算（design.md:888）与 viewer 90min 加载目标（design.md:889-892）都会被这条吃掉。
**选项**：
- A. 定义 `ε_move`（建议 ≥1e-3 m/段）与收敛规则（`|v|<V_EPS` 或 `v_des=0` 后 a_brake 一步归零），并把 `movers/beat` 作为报告量。
- B. 严格非零就发（预算不可控）。
- C. 只压缩重复 from/to 字段（治标）。
**推荐**：A。**需要用户决策：否**。

## C. G2 认为仍会阻塞 design 批准的点

1. **Q2（阻塞）**：`v_end≤0.5 m/s` 对所有参与者成立会让 tackle/扑救不可达，直接撞 2% 否决上界并反向抬高 staticFrac；必须先在 design 内拆 settle/impact 两种到达语义。
2. **Q3（阻塞）**：分离投影 0.08m/步 vs main 实测 ~3.4m/拍（≈6.8 m/s）差 8.5×，且预测层只前瞻 0.1s；必须写死预测视野与「投影触发即失败」的预注册判据，或预注册分离专用预算分支。
3. **Q4（阻塞）**：扑救点不在门线上时，`t_end`（飞到门线）与扑救时刻不一致，且事件没有扑救时刻字段；L2 的 saved `x2`=门线条款与之冲突，必须二选一改协议或改 L2。
4. **Q1/Q5（批准前必须收口，不一定需要用户拍板）**：Q1 是 design/spec 的数学措辞错误（不裁剪条件应为 `sqrt(A0_max²+a_lat²)`）；Q5 的规划/分离成本只有估算、无实测门，且「超预算允许什么降级」还没有梯子——这两条不改文本就批准，实现阶段会以「意外超预算/测试变红」的形式回来。
5. **建议的零成本探针（批准前或 Phase 0 首日）**：用现有纯函数/积分器对 20 seed 采样 (i) 射门 save 的扑救点可达率、(ii) 典型同队对穿场景的投影触发次数、(iii) 高亮期决策是否零 RNG。三条都不需要写引擎，能提前证伪 Q2/Q3/Q6，避免把设计缺陷带进实现。
