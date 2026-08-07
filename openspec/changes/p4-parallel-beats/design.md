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
- **movers 位移阈值**：仅当球员移动超过阈值（~0.5m）才列入 movers，保证增量契约在多数时刻成立。
- **"移动 ⇔ 发 movers"（P4-3）**：movers 位移阈值 = 静区（dead-zone），等值 0.5m——球员移动超过阈值才动、才发 movers；低于阈值不动不发。保证 last-emitted-pos 恒等于 pos[]（不漂移）。
- **为什么**：数据量可控；等值保证连续性机制不漂移。

### D4: 球所有权（Q4 升级——替代"球位置由高亮事件驱动"单一表述）
- 每个开放比赛时刻，**球有且只有一个驱动者**：
  - 节拍 stretch（无高亮、持球者带球/控球）：`main` 带球轨迹（x/y→x2/y2+speed），球由 main 驱动。
  - 高亮期间（pass/shot）：球由高亮事件驱动（x/y→x2/y2+speed），beat 不重复驱动球。
  - 松散球（无持球者，如抢断弹开）：beat 携带 `ball`（`{x, y, x2, y2, speed, loose:true}`——球滚动轨迹，viewer 在拍内插值），球由 beat.ball 驱动，viewer 可读松散球追逐。
  - 死球（进球庆祝/开球准备）：viewer 在最后已知球位置 hold（不冻结成驱动者）。
- 球优先级链：**高亮 > main(带球) > beat.ball(松散) > hold(死球)**。
- **为什么**：消除"球无人驾驶"缺陷（审阅标为 FUNDAMENTAL）。

### D5: 新 type 'beat'（Q5）+ 位移阈值与连续性（审阅 M1）+ main-only（审阅 M2）
- 每拍 `{t, type:'beat', movers:[{id, from_x, from_y, to_x, to_y, speed, action}], main?:{...}, ball?:{x, y, x2, y2, speed, loose}}`。
- **movers 的 to = tick 步进终点**（pos after ≤1s movement at speed），非角色锚点——保证跨拍 from(N+1)==to(N)。
- **位移阈值 vs 连续性（M1）**：movers 位移阈值（~0.5m）与"跨拍精确衔接"共存——引擎维护 **last-emitted-pos**（每个球员上次在 movers 里的 to），保证球员重新出现时 from = 上次 viewer 见到的位置（跨缺席也精确衔接）。无 snap 容差内不跳变。
- **main-only（M2）**：**carrier 不进 movers**——持球者的移动只由 main 表达，movers 只含无球跑位球员。movers 的 action 枚举删 'dribble'（carrier 的带球在 main）。避免 main 轨迹 + movers 位移双重渲染。
- **为什么**：语义清晰；位移阈值不破坏跨拍连续；main-only 消除 carrier 双渲染。

### D6: main = 带球/控球 only，每持球 tick 都发（Q6 升级）
- **main 只在持球者带球/控球时出现**；pass/shot/tackle **绝不进入 main**（只走高亮事件，避免双播）。
- **每个持球 tick 都必须发 main**（含零位移控球：球在脚下，main 带球轨迹可为微小位移）——保证球可见、唯一驱动者成立（审阅 blocker：carrier-hold 时球不能冻结）。
- **为什么**：消除"同一动作定义两次"（dribble 双重广播）与"carrier-hold 球无人驾驶"两个缺陷。

### D7: 全员状态逐 tick 更新（Q7）+ 高亮触发节拍门控（审阅 H1）
- 引擎维护 `pos[22]`，每 tick 为每个球员决策目标：持球者带球、队友跑位（本轮用现有角色锚点 + 小幅调整，队形公式进 p5）、门将回位。更新 pos[]，产节拍。
- **高亮触发门控（H1）**：持球 hold 以 tick 计（8-15 tick），hold 内每 tick 发 main（carrier 带球）+ movers；hold 归零时在**整数 tick** 掷高亮类型（pass/shot/tackle，含 tackle 距离/积极性检查）。**不是每 tick 都掷高亮**（否则 2700 个），也**不是从不掷**（否则零高亮）。
- **高亮门控 fallback（审阅 p4-103）**：hold 归零**必定**产出一条高亮；掷出 tackle 但距离/积极性检查失败 → 改掷 pass/shot（v2 无 'dribble' 落点，不落回 dribble）。tackle 频率目标保持主 spec 8-15/场，由检查阈值（距离 ~10m、积极性 ~0.09）维持。
- **main 每拍推进上限（审阅 M3）**：main 的每拍推进 ≤ speed×1s（约 5-7m）；持球者多数 tick 为零位移控球（球在脚下小幅调整）或短带球，避免 8-15 tick 内横穿球场。
- **为什么**：FM slice 模型；高亮门控决定流形状（约 200 次/场），main 步进上限防止 carrier 超速。

### D8: 高亮参与者排除 + 高亮锚点整数 tick 对齐（D12 的核心，升级定死）
- **高亮期间参与者从 beat movers 排除**：pass 的传球者/接球者、shot 的射手/门将、tackle 的双方，在其高亮时序内不在 beat movers。这是**唯一规范**（无"或与高亮精确一致"逃生门）。
- **高亮事件起点对齐整数 tick**：pass/shot/tackle 的 t 量化到 1s tick 边界。简化合成——高亮 tick 不产 main，高亮从该 tick 起是唯一驱动者。
- **高亮覆盖区间**：[t_start, t_end)，t_end = 自然飞行终点（可非整数）；高亮结束后的驱动者按 D12 交接（不限于 pass）。**t_end 到下一整数 tick 边界之间**（审阅 N7）：viewer 在各自高亮结束位置 hold 球与参与者，从下一 tick 边界起按 D12 交接（main/beat.ball/hold 恢复）。
- **高亮期间 beat 不含 main 也不含 ball（审阅 p4-108）**：高亮覆盖区间内的 beat 只含 movers（球由高亮驱动）——互斥校验扩展为：高亮期间 beat 无 main、无 ball；非高亮 beat 不同时含 main 与 ball。
- **高亮事件必须携带参与者精确起点**（无 fallback，缺失即瞬移；**主参与者用基础 x/y，第二参与者用专名，字段不冗余**）：pass{基础 x/y = 传球者起点，receiver_x/y = 接球者起点}；shot{基础 x/y = 射手起点，keeper_x/y = 门将起点}；tackle{基础 x/y = 防守者起点，carrier_from_x/y = 被铲者接触点（== x2/y2），**carrier = 被铲者 id（v2 移除 to 后身份由 carrier 承载）**}。
- **参与者起点硬约束（审阅 p4-109）**：高亮参与者起点 == 该 tick 开始时的 pos[]（前一 beat 的 to / main.to / last-emitted-pos），引擎保证等式成立（不依赖 viewer 阈值兜底）。
- 引擎维护**飞行中高亮注册表**（哪些球员被高亮控制、到何时、结束位置），每 tick 查询以执行排除 + pos[] 对账到高亮结束位置。**任意时刻至多一条飞行中高亮**（保证球优先级链"高亮>main>ball"定义明确）。
- **高亮参与者结束位置派生（审阅 p4-106 / N3）**：注册表的"高亮结束位置"由事件字段派生，viewer 与引擎同一派生、无额外 payload——pass 接球者 = pass.x2/y2、**传球者 = 其起点（基础 x/y，高亮期间静止）**；shot 门将 = shot.x2/y2、**射手 = 其起点（基础 x/y）**；tackle 双方 = **接触点（被铲者 carrier_from / 防守者 x2/y2——防守者从基础 x/y 移动到接触点）**，球弹开 = loose_x/y。
- **高亮参与者回归 movers**：参与者退出高亮时，last-emitted-pos 置为注册表的"高亮结束位置"——viewer 从高亮结束位置继续，不回弹。
- **kickoff 球驱动角色（审阅 N8）**：kickoff 事件在 v2 保留，携带球轨迹（x/y→x2/y2+speed）由事件自身驱动（优先级链中与高亮同级——事件驱动球）；kickoff 起点对齐整数 tick，其后首个 beat 从下一 tick 起。
- **t 单调性澄清（审阅 p4-111）**：单类型流内严格单调（beat t 严格递增、高亮事件 t 严格递增）；合并流非严格单调（同一整数 t 允许 beat + 高亮并存）。
- **为什么**：消除"同一球员双重移动"，是最大技术风险（审阅标为 blocker）。

### D9: 关键时刻保持当前节奏（Q9 升级）+ tackle carry-beat 归零（审阅 H2）
- **v2 全场比赛：dribble 不再是独立高亮**——带球 = beat.main。pass/shot/tackle 仍为高亮事件（约 150-200 次/场）。
- **tackle carry-beat 归零（H2）**：v2 中被铲者在 tackle 前的若干 tick 已通过 main 演过带球逼近，故 **tackle 高亮的 carrier_from = 被铲者在 tackle tick 的位置（接触点）**，carry-beat 归零（不再从带球段起点重放）。viewer 不再需要基于 v1 dribble 事件的 dropCarryBeat 扫描（该机制在 v2 失效）。
- **为什么**：消除 dribble 双重广播；v2 中带球逼近已由 main 表达，tackle 高亮不重放带球段。

### D10: 协议 v2 新增 beat，向后兼容（Q10）
- 保留 v1 事件（pass/shot/tackle 等），新增 beat 节拍。viewer 兼容两者。
- demo_mode 保持 v1 事件驱动（给 viewer 一个 v1 生产者，兼容路径可测）。
- **为什么**：平滑过渡，旧事件（高亮）继续用，beat 补充并行。

### D11: 松散球生命周期（审阅 p4-107 / cross p4-101——补定义）
- 松散球由高亮结束产生：tackle 成功弹开、shot 扑出反弹。
- 高亮结束（t_end）后的**下一个整数 tick 边界起**，球由 `beat.ball`（`{x, y, x2, y2, speed, loose:true}`——滚动轨迹）驱动，直到被拾取——**不再属于高亮时序**（消除旧 Open Question 表述"作为 tackle 高亮的一部分"的矛盾）。
- **追逐者（两种模式，审阅 SEAM-3）**：
  - **tackle 成功弹开（transition 相关）**：追逐者 = 赢得球权的一方（抢断方）离球最近的球员（按 pos[] 欧氏距离，平局按 id 小者），每 tick 以速度上限向球移动（纳入 movers，action='chase'）；原持球方不参与拾取竞争（不追球抢球），但按 p5 close_down 向目标侧收缩（压迫/封堵，**不进入拾取半径**）——保证"球权易主"确定（消除窗口内二次球权翻转），p5 transition 前提成立。
  - **save-rebound（非 transition）**：追逐者 = 距球最近的球员（**不限队，双方可争**补射/解围），拾取方决定 phase（p5 S2.2d）。
- **拾取**：追逐者在拾取半径（~0.5m）内 → 该球员成为 carrier → 下一 tick 边界 `main` 恢复（last-emitted-pos = 拾取点，pos[] 连续性保证无 snap）。
- **上限与无瞬移（审阅 cross F6 / SEAM-2）**：松散球弹开时球速**阻尼递减**（每 tick 减速），追逐者速度高于球末速 → 追逐者必在 `LOOSE_MAX_TICKS = 2` 内进入拾取半径；若超时仍未进入（理论不可达），**球在当前位置 hold 等待拾取，不瞬移**——**超时语义 = hold 等待，非强制瞬移拾取**（"无 snap"对球员与球都成立）。
- **save-rebound 松散球起点（审阅 SEAM）**：= shot.x2/y2（高亮结束的球位置，**无位置跳变**）；弹开方向（同 deflectPoint 规则）决定首个 beat.ball 的滚动方向（从 x2/y2 沿弹开方向滚出）。
- **为什么**：松散球是球权易主（tackle/扑救）的自然延续；p5 transition 依赖此生命周期（拾取时序确定性可断言）。

### D12: 高亮结束 → 球权交接（审阅 cross p4-102 / p4-104——从 pass-only 推广）
- 高亮结束（t_end）后的驱动者由球权结局决定（**另含 kickoff**：kickoff 事件驱动球至接球者（x2/y2）→ 接球者持球 → main 在下一 tick 边界恢复，同 pass 交接）：
  - **pass（接球者持球）**：main 从接球者持球后的**首个 tick 边界**恢复（carrier = 接球者，last-emitted-pos = 接球点）。
  - **shot → goal**：死球（hold）→ 按 P3 机制 kickoff 重开（viewer 允许死球→kickoff 的球位置跳变）。
  - **shot → 门将扑住（save-caught）**：门将持球 → main 从**首个 tick 边界**恢复（carrier = 门将，last-emitted-pos = 扑救点）；**门将出球在 transition 窗口结束后经 pass 高亮**（窗口内高亮门控暂停，不出新高亮）。
  - **shot → 扑出反弹（save-rebound）**：进入松散球（D11，beat.ball 驱动，**双方可争**）→ 拾取 → main（拾取方决定 phase）。
  - **shot → 打偏/出界（off_target，审阅 N2）**：死球（球出界）→ 按 P3 机制 kickoff 重开（对方开球）；球轨迹终点坐标**钳制在 [0,1]**（出界表现为到达边线，不超坐标范围）。
  - **tackle 成功弹开**：进入松散球（D11）→ 拾取 → main（追逐者 = 抢断方，见 D11 球队限定）。
  - **tackle 失败（被铲者保持）**：main 从**首个 tick 边界**恢复（被铲者继续带球，last-emitted-pos = 接触点）；**不进入松散球**（loose_x/y 仍携带作为被铲者续带方向参考，但不触发 beat.ball 松散阶段）。
- **时序保证（审阅 SEAM-5，修正 off-by-one）**：tackle 高亮时长为 1 tick 覆盖 [T, T+1)，松散球在 t_end = T+1 产生；追逐 `LOOSE_MAX_TICKS = 2` → 拾取 ≤ T+3，落在 p5 transition 窗口 [T, T+4) 内——"前插必在窗口内激活"成立。
- **为什么**：球优先级链"高亮 > main > beat.ball > hold"在每种高亮结局下都有明确后继。

## Risks / Trade-offs

- **[数据量]**: 固定 tick + 全员，用增量 movers + 位移阈值控制；若仍大换紧凑格式。
- **[高亮与节拍合成]**: 所有权规则（D4/D8）是最大技术风险；viewer 需两层合成（高亮覆盖 beat）。高亮整数 tick 对齐 + 参与者排除是缓解。
- **[向后兼容]**: viewer 需同时处理 beat 与 v1 事件；协议校验扩展。
- **[性能]**: ~2700 beat + ~200 高亮锚点数量级增大，viewer 插值需从线性扫描改时间索引（P3 任务）。
- **[现有测试迁移]**: 引擎 16 测试 = 13 个 match-engine 测试（断言 v1 结构：dribble 事件、tackle 频率）+ 3 个 RNG 测试（不受 beat 重写影响）。beat 重写会破坏 13 个 match-engine 测试，需迁移（P4 任务）。

## Migration Plan

- 引擎：主循环重构为固定 tick + 全员状态更新 + 节拍产出；dribble 从高亮移入 main；高亮（pass/shot/tackle）仍产，锚点整数 tick 对齐；飞行中高亮注册表。
- 协议：新增 beat 类型 + movers 结构 + ball/main 所有权字段；viewer protocol 支持。
- viewer：beat 演绎（movers 批量插值，跨拍连续）+ 两层合成（buildTimeline 纯函数排除高亮参与者 + 高亮覆盖）+ 球可见性（main/高亮/松散球）。
- 测试：引擎节拍确定性/所有权/高亮排除；viewer beat 插值/合成/无 snap；现有测试迁移。

## Open Questions

- 高亮事件的整数 tick 对齐是否影响关键时刻节奏（原事件在任意时刻）——实施时验证，必要时改为非整数 + 注册表。
- 松散球追逐速度/拾取半径的具体值（拾取半径 ~0.5m、LOOSE_MAX_TICKS=2）——实施时调参。
