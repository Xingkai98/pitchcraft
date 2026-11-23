# Grill 收敛：C1 运动层 design（2026-11-23）

> 输入：`notes/grill-G1.md`（时间/协议/状态机，6 问）、`notes/grill-G2.md`（物理/性能，10 问）、
> `notes/grill-G3.md`（行为/验收/范围，10 问），以及 Round 6 审阅。
> 本文是**合并去重后的收敛记录**：不需要用户拍板的项已直接修进 design/spec/tasks；
> 需要用户拍板的 12 项已于 **2026-11-23 全部选择「按推荐」**，记录见 §2 与 `design.md` `## D13`。
> 本轮只改文档/规范/tasks；未改 `engine/`、`viewer/`，未 push。

## 0. 已钉死事实（不再讨论）

- **G1-F1** 三层 cadence 与首拍：`SIM_DT=0.1` / `DECISION_DT=0.5` / `BEAT_DT=0.2`；首 beat=0.5；
  `S=sort(B∪D∪E)`；`beat.t`=段起点，`dt∈{0.1,0.2}`（终场末段例外）。
- **G1-F2** 高亮参与者不隐藏/不 frozen：参与者进 `movers`（`action:"highlight"`），事件锚点 =
  连续积分（含分离）到 `t_end`；`frozen_mask` 不再用于参与者，`highlight_frozen_segs` 退役。
- **G1-F3** 唯一执行路径：`CommittedPlan` 覆盖内只消费缓存，不 `decision()`/不掷骰/不积分；
  未覆盖边界由 live scheduler 执行；SHALL NOT 第二套调度语义。
- **G1-F4** 旧流 v11 回放：`buildTimeline` 按第一条 beat 有无 `dt` 做流级选择；
  旧流 `legacyBeatSeconds=0.5` + warning；混用报错；第一阶段不逐段混用。
- **G1-F5** 四态驱动 `controlled/loose/highlight/restart`；高亮期禁 `main`/`ball`、事件本身=首锚点；
  非高亮新状态首段即使零位移也发 `main`/`ball`。
- **G1-F6** 同刻排序：非 beat 事件先、beat 最后；beat 描述事件后段。
- **G2-F1** 三时钟与快照域：`tick` 仍是 decision，10Hz 是内部子步；快照数与 tick 数契约不变。
- **G2-F2** 唯一执行路径：`CommittedPlan` 覆盖 `[t_c,P_eff]`；`P_end` decision 归 live；
  `cp_end` 在其之前。
- **G2-F3** 统一运动、锚点=积分终点：所有角色同一 `MotionState`/分离 solver；不冻结/不隐藏/
  不投影。
- **G2-F4** 运动学与预算：`A0=6.4–7.8`、`S0=9.2–9.8`、`a_lat=6.5`、`V_MAX=9.5`、`A_MAX=8.0`、
  `V_REVERSE=0.5`、到达/精确半径 1.0/0.25m、`RESIDUAL_SPEED_MAX=0.2`；`A_MAX` 是总向量预算。
- **G2-F5** 合法断点/finalize：只有 kickoff / 死球重开 / 进球回中圈 / 罚下 / 终场允许位置跳变；
  finalize = 第一个 ≥ `t_end` 的 0.1s 网格步。
- **G2-F6** Viewer：新流按 `beat.dt`、旧流整条 `legacyBeatSeconds=0.5`、tackle 恒 0.5、
  T1/Catmull 默认关。
- **G2-F7** 边界钳制不覆盖球：球员 `pos_m` 钳 `[0,105]×[0,68]`；球飞行/出界锚点不被同一钳制截断。
- **G3-一** D11 六项已拍板；批准范围 = 运动执行 + Phase 0 + D1.2 两处可见差异；
  beat/`movers` 是允许的接缝变更；主判据已预注册（turnsPerPlayer 24s/121 帧等）；
  最终验收是盲测；viewer 不是主因。

## 1. 合并去重后的决策表

> 「用户决策」列：**是** = 曾进用户决策；**否** = 已按推荐修进文档。
> **2026-11-23 用户已对 12 个「是」项全部选择「按推荐」**，具体选择见 §2；本节保留
> 拍板前的推荐与证据作溯源。证据里的行号以对应章节为准。

| ID | 问题 | 选项 A/B/C | 推荐 | 证据 | 用户决策 |
|---|---|---|---|---|---|
| G1-Q1 | 悬空高亮 `t_end>dur` 的终场 finalize 链由谁执行？ | A 保留 main 排空循环；B 并入 `CommittedPlan` 的 `P_eff=dur` 终态、循环退出后零 live finalize；C 拒绝跨 dur 高亮 | **B** | main `lib.rs:3395` 独立排空循环；A 违反「唯一执行路径」；C 改「终场射门仍计分」语义 | 否（已补 D2.2） |
| G1-Q2 | 权威伪代码两个 finalize 发射器（`boundary_events_at` / `plan.events_at`） | A A 阶段计划感知、`P_eff` 由交还块消费同一账本一次；B 交还块唯一发射；C 字面两处都发 | **A** | `start_marker` 只防重复起点，不防 `P_eff` 双发 | 否（已补 D2.2 伪代码） |
| G1-Q3 | 观察层 `frozen` 快照字段迁移 | A 保留为「活跃高亮参与者标签」，p16 改断言；B 恒空删断言；C 继续按 participants 填 | **A** | p16 `p16_spatial_features.rs:495` 防空转断言会因参与者不冻结而红 | 否（已补 D2.4） |
| G1-Q4 | 验收主指标工具不在 main + 参与者进 movers 使 frozen 口径失效 | A 从 p155 移植 `motion-census.mjs` + 过滤 `action:"highlight"`；B 重造 turn120/重标定真实锚；C 留待验收再决定 | **A** | main `tools/visual-review/` 无 `motion-census.mjs`；C1 后输入变 | 否（已补 D7.1/tasks 2.11） |
| G1-Q5 | `last_emitted` 是否纳入计划完整状态 | A 纳入并逐边界提交；B 发射时回写；C 限定 live 边界 | **A** | retained scenario「状态与事件一致」要求 `st.pos == last_emitted` | 否（已补 D2.2） |
| G1-Q6 | 旧流 tackle beat-first 回溯是否保留 | A 流级分叉：新流事件先、旧流保留 legacy tackle-beat-first；B 旧流也按事件先；C 旧流只保段长/五段式 | **A** | `viewer/game.js:424` 旧序；新 spec scenario 原前提只对新流 | 否（已补 D6.2/pitch-viewer spec） |
| G2-Q1 | `A_MAX=8.0` 与 `sqrt(A0²+a_lat²)` 不自洽 | A 抬到 10.2；B 保留 8.0 为权威预算、预算优先、裁剪有界且裁剪率报告；C 压 a_lat | **B** | v=2、A0=6.4、S0=9.5 → `sqrt(5.053²+6.5²)=8.233>8`；`sqrt(7.8²+6.5²)=10.15` | 否（已补 D4.2/D4.4/spec） |
| G2-Q2 | 参与者末速 ≤0.5 对所有角色成立吗？ | A 拆 settle/impact；B 单判据 + 2% 否决；C 按角色 tol | **A** | tackle/扑救到点必须还在动；统一判据会撞 2% 上界并抬高 staticFrac | **是**（D13 #9） |
| G2-Q3 | 分离投影预算 0.08m/步 vs main ~3.4m/拍；预测层只 0.1s | A 同一 A_MAX + 预测视野 ≥0.75s + 投影触发即停；B 分离专用预算；C 删投影 | **先 A，B 为预注册应急** | `lib.rs:6628` 每拍 6.6m 预算；`sqrt(2×1/8)=0.50s`、`sqrt(2×2.2/8)=0.74s` | **是**（D13 #10） |
| G2-Q4 | 扑救点早于门线/`t_end`，无扑救时刻字段，L2 saved x2=门线冲突 | A 加 `save_x/save_y/save_t`；B 改 saved x2=扑救点并改 L2；C 保持门将终点=门线 | **A** | `lib.rs:4785` save_pos=(x2,y2)；`lib.rs:4757` t_end 到门线 | **是**（D13 #11） |
| G2-Q5 | 前视规划/分离成本与超预算降级梯子 | A Phase 0 实测 + 硬门 + 只允许保真度不变优化；B 接受 3–5× 移 nightly；C 允许少算 22 人/先锚后推 | **A + C** | 300–900 次规划/场估算；分离 O(n²) 每 0.1s；wasm 90min 加载目标 | **是**（D13 #12） |
| G2-Q6 | 高亮期无事件决策，计划 decision/RNG 机制为不存在分支而建 | A 写成不变量 + 单测；计划只留 cp_commit/cp_end；状态核对标注为接线守卫；B 保留完整机制；C 只算物理不算目标刷新 | **A** | `lib.rs:3543-3559` 高亮直接早退；状态赋值自缓存 → 只能抓接线错误 | 否（已补 D2.2/spec） |
| G2-Q7 | 若干部件常量无值/打架（MAX_TURN_RATE、V_EPS、a_brake、S0 vs V_MAX） | A 钉 v1 标量表 + S0≥V_MAX 不变量；B 留区间 | **A** | `S0=9.2` 时 v>9.2 会负；`a_brake` 两处要同一标量 | 否（已补 D4.2/spec 运动常量 v1） |
| G2-Q8 | 「关 Catmull/T1」是三处接线不是配置值 | A 显式开关 + 新流停发事件派生球员锚点 + 同步测试 + audit 读 beat.dt；B 靠 0.5s 门槛；C 长飞行继续 Catmull | **A** | `game.js:539` 无条件平滑、`PLAYER_TEXTURE.ampM=0.12`；`interpretation.test.js:163`、`derive-audit-features.js:122` 旧耦合 | 否（已补 D6.1/spec/tasks） |
| G2-Q9 | 落点/锚点改后 viewer `dist/speed` 时长错位；重开 pass 起点不精确 | A `x2/y2` 用最终计划点并重算 speed；重开 pass 起点用发球者积分位置（REACH_TOL_M 内）；B 加 duration；C 接受误差 | **A** | `interpretation.js:348-353` 用 dist/speed；重开协议原写「同一固定点」 | 否（已补 D5.4/event-stream spec） |
| G2-Q10 | 「非零位移」无 epsilon，22 人每段进 movers | A `ε_move≥1e-3 m/段` + 收敛规则 + movers/beat 报告；B 严格非零；C 只压重复字段 | **A** | 残余 0.2m/s × 0.2s = 0.04m；3×/5× 体积预算会被吃掉 | 否（已补 D5.1/spec/tasks） |
| G3-Q1 | D1.2 是否漏第三类「可达性修复 + 候选拒绝」 | A 扩三类并给频次预算；B 维持两类；C 禁止修复 | **A** | 修复改事件几何/计数；C 丢更多事件 | **是**（D13 #1） |
| G3-Q2 | 验收门槛是否太弱 | A 收紧到 turn120 ≤10×/staticFrac ≤3× 真实；B 维持门槛但无结论=不验收；C 现状 | **A+B** | 现门槛 50%/30% 仍是 40×/4×；盲测最可能无结论 | **是**（D13 #2） |
| G3-Q3 | 盲测协议可执行吗（7 簇 CI、无结论处置、裁判媒介、seed） | A 预注册扩样/无结论=不验收/裁判媒介/seed 321–440；B δ=0.20；C 先哑测 | **A** | 7 真实簇、140 clip 上限；5 裁判×140≈700 判定 | **是**（D13 #3） |
| G3-Q4 | 是否加「先看画面」vertical slice 门 | A 运动核心后 1 seed×5min 回放+轨迹图→用户先看；B 全量后看；C 只看数字 | **A** | 本仓「指标变好、画面不变」教训 | **是**（D13 #4） |
| G3-Q5 | CommittedPlan 是否与可见改善同批 | A 拆 C1a（运动核心）/C1b（CommittedPlan），C1a 先过视觉门；B 一次做完；C 简化 | **A** | 可见改善只依赖运动积分；C 重开 R4-H1 | **是**（D13 #5） |
| G3-Q6 | Phase 0 独立 PR 还是塞进大 PR | A 同 change 内拆独立 PR、行为零变化、对照 main v11；B 一个大 PR；C 独立 change | **A** | 区分「门变严/重锚」与「运动破带」 | 否（已补 tasks §2） |
| G3-Q7 | 旧流 v11 兼容是否必要 | A 删除旧流、缺 dt 报错；B 保留；C 只读旧流 | **A**（除非仓外消费者） | 仓内未发现无 dt 消费者 | **是**（D13 #6） |
| G3-Q8 | 加速度尾部指标是否空转 | A 从已发射 beat 端点算、双口径；B 定性为构造不变量；C 维持内部子步 | **A** | 内部 p99 恒 ≤A_MAX，软目标必绿 | 否（已补 D9.1/tasks） |
| G3-Q9 | L1「新增破带=失败」会被护栏带误杀 | A 带分类审计 + 护栏按方向判；B 现规则；C 护栏全降报告 | **A** | 角球 [1,7]/界外球 [15,60] 是护栏带非真实值 | **是**（D13 #7） |
| G3-Q10 | 回退/停止条件可判定吗、谁判 | A 视觉门后显式 Go/No-Go、No-Go=分支留档；B 全量后判；C 逐指标自动停 | **A** | 回退成本随阶段指数上升 | **是**（D13 #8） |

## 2. 用户拍板（2026-11-23）

> 用户对 12 项**全部选择「按推荐」**。逐项细节与影响见 `design.md` 的 `## D13`；
> 下表记录选择，后面的问题/选项/影响保留作溯源自。

| # | ID | 选择（按推荐） | 选定值 |
|---:|---|---|---|
| 1 | G3-Q1 | A | 批准范围扩三类（save 否决 / 参与者进 movers / 可达性修复+候选拒绝），修复/拒绝率 ≤5% |
| 2 | G3-Q2 | A+B | turn120 ≤10× 真实、staticFrac ≤3× 真实；盲测无结论=不验收 |
| 3 | G3-Q3 | A | δ=0.15、CI [0.35,0.65]、72→140 clip、固定裁判媒介、seed 仅 321–440、7 簇多向聚类 |
| 4 | G3-Q4 | A | C1a 后 1 seed×5min 回放+轨迹/contact-sheet，用户先看 |
| 5 | G3-Q5 | A | 拆 C1a（运动核心）/C1b（CommittedPlan），C1a 先过视觉门 |
| 6 | G3-Q7 | A | 删除旧流 v11 兼容；缺 dt 报错；无 legacy/五段式/旧序回溯 |
| 7 | G3-Q9 | A | L1 带分类；护栏按方向判；过时重标/退役但不删塌缩守卫 |
| 8 | G3-Q10 | A | 视觉门后 Go/No-Go；No-Go=停止、分支留档 |
| 9 | G2-Q2 | A | settle / impact 两分到达语义 |
| 10 | G2-Q3 | A（B 应急） | 预测视野 ≥0.75s、投影 20 seed 0 次；B 应急 ≤2.2m/0.1s + separation_push |
| 11 | G2-Q4 | A | shot saved 加 save_x/save_y/save_t；finalize 在 save_t；x2/y2 仍门线 |
| 12 | G2-Q5 | A | Phase 0 release+wasm 实测；L1 ≤2× v11、wasm 90min ≤10s；只允许保真度不变优化 |

1. **G3-Q1 批准范围是否扩为三类**（save 否决 / 参与者进 movers / 可达性修复+候选拒绝）。
   推荐：**A 扩为三类**，修复率/拒绝率预算 ≤5%。
2. **G3-Q2 验收门槛是否收紧**（turn120 ≤10× 真实、staticFrac ≤3× 真实）+ 盲测无结论=不验收。
   推荐：**A+B 组合**。
3. **G3-Q3 盲测协议**：δ=0.15 是否保留、无结论处置、裁判媒介、engine seed 仅 321–440。
   推荐：**A 按现协议冻结**。
4. **G3-Q4 是否加「1 seed×5min 回放+轨迹图给用户先看」视觉门**。推荐：**A 加**。
5. **G3-Q5 是否拆 C1a（运动核心）/C1b（CommittedPlan）**。推荐：**A 拆**，C1a 先过视觉门。
6. **G3-Q7 旧流 v11 兼容是否保留**。推荐：**A 删除**（缺 `dt` 报错），除非存在仓外消费者。
7. **G3-Q9 L1 护栏带是否按「向真实锚移动=通过、远离=失败」判**。推荐：**A 是**。
8. **G3-Q10 是否在视觉门后设显式 Go/No-Go + No-Go=分支留档**。推荐：**A 是**。
9. **G2-Q2 到达语义是否拆 settle / impact**。推荐：**A 拆**。
10. **G2-Q3 分离预算先 A（预测视野 ≥0.75s，投影触发即停）还是直接 B（分离专用预算）**。
    推荐：**先 A；B 作预注册应急分支**。
11. **G2-Q4 扑救协议**：加 `save_x/save_y/save_t`（推荐 A）还是改 L2 的 saved x2=门线。
    推荐：**A 加字段**。
12. **G2-Q5 性能门**：Phase 0 实测 + 硬门（推荐 A），超预算只允许保真度不变的优化。
    推荐：**A + C 作为唯一降级梯子**。

## 3. 已收敛（设计已补）

> 以下 14 项按 grill 推荐直接修入文档，未改变用户已拍板的 D11。

| ID | 决定 | 改了哪里 |
|---|---|---|
| G1-Q1 | 终场 finalize 链并入 `CommittedPlan` 的 `P_eff=dur` 终态；循环退出后零 live finalize，删除 main 排空循环 | `design.md` D2.2 时间范围/终场段；`match-engine` spec `P_end 与终场交接` |
| G1-Q2 | A 阶段 `boundary_events_at` 计划感知；`P_eff` 由交还块消费同一账本一次；`events_done_at` gating；账本每条只消费一次 | `design.md` D2.2 伪代码/双发射器合并；`match-engine` spec `计划覆盖边界的执行` |
| G1-Q3 | `observe_state.frozen` 保留为「活跃高亮参与者标签」；p16 改断言（非空/仅高亮拍/少数拍），删「位置冻结」语义 | `design.md` D2.4；`tasks.md` 6.16 |
| G1-Q4 | Phase 0 从 p155 移植 `motion-census.mjs`，引擎侧过滤 `action:"highlight"`；v11 读数 ≠ Change 0 则停止说明 | `design.md` D7.1；`tasks.md` 2.11 |
| G1-Q5 | `last_emitted` 纳入计划完整状态清单，逐边界随缓存提交 | `design.md` D2.2 内容/事务；`match-engine` spec `CommittedPlan 执行` |
| G1-Q6 | 旧流已被 G3-Q7 删除：缺 `dt` 报错；不再保留 tackle-beat-first legacy 回溯；新流事件先 | `design.md` D6.2；`pitch-viewer` spec `高亮参与者回溯识别` |
| G2-Q1 | `A_MAX=8.0` 权威总预算、预算优先；低速大转向会裁剪且有界；裁剪率只报告；`sqrt(7.8²+6.5²)=10.15` 写进理由 | `design.md` D4.2/D4.4；`match-engine` spec `总向量加速度预算` |
| G2-Q6 | 高亮期零事件决策/零事件 RNG 写成不变量；计划只留 `cp_commit`/`cp_end`；状态核对标注为接线守卫 | `design.md` D2.2 事务；`match-engine` spec `CommittedPlan 执行`/`计划覆盖边界的执行`；`tasks.md` 6.15 |
| G2-Q7 | v1 常量钉死 `S0=9.8`、`a_brake=6.4`、`V_EPS=1e-3`、`MAX_TURN_RATE=4.0`；`S0≥V_MAX` 不变量；数值例改「MAX_TURN_RATE≥1.0833」 | `design.md` D4.2/D4.4；`match-engine` spec `运动常量 v1`；`tasks.md` 3.2 |
| G2-Q8 | 显式 `interpolation.smooth=false` / `textureAmpM=0`；新流停发事件派生球员锚点；同步测试改 beatSeconds/DECISION 映射；audit 读 beat.dt | `design.md` D6.1；`pitch-viewer` spec `播放段与插值合同`；`tasks.md` 5.2/5.11/5.12 |
| G2-Q9 | 事件 `x2/y2` 用最终计划点并重算 `speed=dist/(t_end−t)`；重开 pass 起点用发球者积分位置（REACH_TOL_M 内） | `design.md` D5.4；`event-stream` spec `重开准备期球锚点`；`match-engine` spec `高亮参与者与统一运动状态` |
| G2-Q10 | `ε_move=1e-3 m/段` + 收敛规则；`movers/beat` 报告量；微位移不产 mover scenario | `design.md` D5.1；`event-stream` spec `稀疏 main/ball 的携带`；`tasks.md` 6.14 |
| G3-Q6 | Phase 0 拆独立 PR，每 PR 行为零变化、对照 main v11 | `tasks.md` §2 头注 |
| G3-Q8 | 加速度尾部改从已发射 beat 端点算主口径 + 内部子步对照；内部 p99 仅构造不变量 | `design.md` D7.1/D9.1；`tasks.md` 6.18 |

## 4. Open Questions

- **规划/分离成本未实测**：22 人 × `PLAN_HORIZON≈12.5s` 的前视、缓存、拒绝重试成本只有估算；
  Phase 0 smoke（tasks 2.10）前不能声称已覆盖。若超预算，只能优化或停止，不得回退
  「先写锚点再让分离推位置」。
- **v11 的 motion-census 读数能否复现 Change 0**：移植并过滤 `action:"highlight"` 后，若
  0.829/0.0104 对不上，必须停止说明口径差异；这不是设计可单方面解决的未知。
- **save 否决率/7 真实簇 CI 宽度**：只有 Phase 0/验收实测才知道；到 140 clip 上限仍无结论
  就如实报告，不伪造独立性。
- **D13 的 12 项用户决策已拍板（2026-11-23，全部按推荐）**：批准范围、验收门槛、盲测协议、
  交付顺序（C1a/C1b）、旧流删除、L1 带分类、Go/No-Go、settle/impact、分离预算 A/B、
  扑救 `save_*` 字段、性能门已落进 design/spec/tasks；**formal design approval 仍待用户
  明确「design 批准」/PR approve**。

## 5. 结论

- 26 个 grill 问题：**14 个不需要用户拍板已收敛**，**12 个已由用户拍板（全部按推荐）**。
- 已收敛项与拍板项只改文档/规范/tasks；未写实现、未改 engine/viewer、未 push。
- `openspec validate p1-motion-integration --strict` 通过后再提交；提交哈希见 commit 记录。
