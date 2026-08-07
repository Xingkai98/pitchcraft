# Design: 并行节拍事件流核心（parallel-beats）

> 本 change = Change A（核心）。Change B（队形公式、阶段转换、micro-motion）在 `p5-team-shape-and-transition`。

## Context

P3 之后连续播放成立，但事件流是"串行"的：每条事件只描述一个球员的动作，同一时刻只有 1-2 人有数据，其他 21 人站桩。用户反馈：真实比赛是 22 人每一刻都在同时动（有人带球、有人插上、有人卡位、有人回撤），当前"一个动作一个动作顺序播放"很不合理。

本 change 把事件流从"串行动作"重构为"并行节拍"：**固定 tick（1s）产节拍事件**，每拍描述所有在移动的球员的并行动作；关键时刻（传球/射门/抢断）保留为高亮事件叠加在节拍流上。**球在任意开放时刻有唯一驱动者**（main 带球 / 高亮 / 松散球）。

## Goals / Non-Goals

**Goals:**
- 固定 tick（1s）推进，每 tick 更新全员位置/动作状态，产节拍事件（main + movers）。
- 节拍 movers 增量（只发移动球员），viewer 对静止球员 hold。
- 关键时刻（pass/shot/tackle）保留为高亮事件，有球轨迹/门将扑救/传跑节奏。
- 球所有权：每个开放时刻球有唯一驱动者（main 带球 / 高亮 / beat.ball 松散球）。
- 高亮参与者从 beat movers 排除（避免双重移动）。
- 协议 v2 新增 beat 类型，向后兼容 v1 事件。

**Non-Goals（移出到 p5 Change B）:**
- 球相关队形公式（防线前压/球侧平移/控球阶段压上）——p5。
- 控球阶段 + 攻防转换（transition/反击）——p5。
- 静止球员 micro-motion——p5。
- 完整球员 AI（决策打分/能力值）——票据 05。
- 战术系统（阵型/指令）——票据 04。
- 完整比赛规则（越位/界外球/定位球）——之后。

## Decisions

### D1: 固定 tick 1s（Q1）
- 引擎按固定 1s 推进（slice 模型），每 tick 产一个节拍事件。
- 关键时刻（传球/射门）跨多 tick：球轨迹由高亮事件驱动，viewer 在事件时序内插值。
- **为什么**：1s 是圆点画面的甜点；固定节奏让"全员每刻决策"成为可能。

### D2: 高亮事件叠加（Q2）
- 节拍流描述"每个人在干嘛"（带球/跑位/卡位）；传球/射门/抢断是独立高亮事件，按自己的时序叠加。
- **为什么**：保留 P1-P3 打磨的戏剧演绎（射门扑救、传跑配合），关键时刻不被 tick 拉平。

### D3: movers 增量（Q3）
- 节拍 `movers` 只列正在移动的球员（带球者、跑位者、门将移动等），静止球员不发，viewer hold。
- **movers 位移阈值**：仅当球员移动超过阈值（如 ~0.5m）才列入 movers，保证增量契约在多数时刻成立（防止队形目标让全员每 tick 都动）。
- **为什么**：数据量可控，符合"事件流只描述变化"。

### D4: 球所有权（Q4 升级——替代"球位置由高亮事件驱动"单一表述）
- 每个开放比赛时刻，**球有且只有一个驱动者**：
  - 节拍 stretch（无高亮、持球者带球/控球）：`main` 带球轨迹（x/y→x2/y2+speed），球由 main 驱动。
  - 高亮期间（pass/shot）：球由高亮事件驱动（x/y→x2/y2+speed），beat 不重复驱动球。
  - 松散球（无持球者，如抢断弹开）：beat 携带 `ball` 坐标（`loose:true`），球由 beat.ball 驱动，viewer 可读松散球追逐。
  - 死球（进球庆祝/开球准备）：viewer 在最后已知球位置 hold（不冻结成驱动者）。
- 球优先级链：**高亮 > main(带球) > beat.ball(松散) > hold(死球)**。
- **为什么**：消除"球无人驾驶"缺陷（审阅标为 FUNDAMENTAL）。

### D5: 新 type 'beat'（Q5）
- 每拍 `{t, type:'beat', movers:[{id, from_x, from_y, to_x, to_y, speed, action}], main?:{...}, ball?:{x, y, loose}}`。
- **movers 的 to = tick 步进终点**（pos after ≤1s movement at speed），非角色锚点——保证跨拍 from(N+1)==to(N)。
- **为什么**：语义清晰，协议版本化易区分；不 hack off_ball_run。

### D6: main = 带球/控球 only，每持球 tick 都发（Q6 升级）
- **main 只在持球者带球/控球时出现**；pass/shot/tackle **绝不进入 main**（只走高亮事件，避免双播）。
- **每个持球 tick 都必须发 main**（含零位移控球：球在脚下，main 带球轨迹可为微小位移）——保证球可见、唯一驱动者成立（审阅 blocker：carrier-hold 时球不能冻结）。
- **为什么**：消除"同一动作定义两次"（dribble 双重广播）与"carrier-hold 球无人驾驶"两个缺陷。

### D7: 全员状态逐 tick 更新（Q7）
- 引擎维护 `pos[22]`，每 tick 为每个球员决策目标：持球者带球、队友跑位（本轮用现有角色锚点 + 小幅调整，队形公式进 p5）、门将回位。更新 pos[]，产节拍。
- **为什么**：FM slice 模型，真正的"全员每刻决策"。

### D8: 高亮参与者排除 + 高亮锚点整数 tick 对齐（D12 的核心，升级定死）
- **高亮期间参与者从 beat movers 排除**：pass 的传球者/接球者、shot 的射手/门将、tackle 的双方，在其高亮时序内不在 beat movers。这是**唯一规范**（无"或与高亮精确一致"逃生门）。
- **高亮事件起点对齐整数 tick**：pass/shot/tackle 的 t 量化到 1s tick 边界。简化合成——高亮 tick 不产 main，高亮从该 tick 起是唯一驱动者。
- **高亮事件必须携带参与者精确起点**：pass{passer_x/y, receiver_x/y}、shot{shooter_x/y, keeper_x/y}、tackle{carrier_from, tackler_x/y}——无 fallback（缺失即瞬移）。
- 引擎维护**飞行中高亮注册表**（哪些球员被高亮控制、到何时、结束位置），每 tick 查询以执行排除 + pos[] 对账到高亮结束位置。
- **为什么**：消除"同一球员双重移动"，是最大技术风险（审阅标为 blocker）。

### D9: 关键时刻保持当前节奏（Q9 升级）
- **v2 全场比赛：dribble 不再是独立高亮**——带球 = beat.main。pass/shot/tackle 仍为高亮事件（约 150-200 次/场）。
- **为什么**：消除 dribble 双重广播（D6 决定）；pass/shot/tackle 是高光，带球是节拍流动。

### D10: 协议 v2 新增 beat，向后兼容（Q10）
- 保留 v1 事件（pass/shot/tackle 等），新增 beat 节拍。viewer 兼容两者。
- demo_mode 保持 v1 事件驱动（给 viewer 一个 v1 生产者，兼容路径可测）。
- **为什么**：平滑过渡，旧事件（高亮）继续用，beat 补充并行。

## Risks / Trade-offs

- **[数据量]**: 固定 tick + 全员，用增量 movers + 位移阈值控制；若仍大换紧凑格式。
- **[高亮与节拍合成]**: 所有权规则（D4/D8）是最大技术风险；viewer 需两层合成（高亮覆盖 beat）。高亮整数 tick 对齐 + 参与者排除是缓解。
- **[向后兼容]**: viewer 需同时处理 beat 与 v1 事件；协议校验扩展。
- **[性能]**: ~2700 beat + ~200 高亮锚点数量级增大，viewer 插值需从线性扫描改时间索引（P3 任务）。
- **[现有测试迁移]**: 引擎 16 测试断言 v1 结构（dribble 事件、tackle 频率），beat 重写会破坏，需迁移（P4 任务）。

## Migration Plan

- 引擎：主循环重构为固定 tick + 全员状态更新 + 节拍产出；dribble 从高亮移入 main；高亮（pass/shot/tackle）仍产，锚点整数 tick 对齐；飞行中高亮注册表。
- 协议：新增 beat 类型 + movers 结构 + ball/main 所有权字段；viewer protocol 支持。
- viewer：beat 演绎（movers 批量插值，跨拍连续）+ 两层合成（buildTimeline 纯函数排除高亮参与者 + 高亮覆盖）+ 球可见性（main/高亮/松散球）。
- 测试：引擎节拍确定性/所有权/高亮排除；viewer beat 插值/合成/无 snap；现有测试迁移。

## Open Questions

- 高亮事件的整数 tick 对齐是否影响关键时刻节奏（原事件在任意时刻）——实施时验证，必要时改为非整数 + 注册表。
- movers 的 action 枚举值（run/return/close_down/dribble/keeper_return）——实施时定义。
- 松散球生命周期（谁追、多久、谁拿回、拿回后回 main）——实施时细化，作为 tackle 高亮的一部分。
