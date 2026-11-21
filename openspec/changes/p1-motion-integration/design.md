# Design: 引擎统一运动执行层（C1 运动学，GitHub #170）

> **状态：D11 六项决策已由用户拍板（2026-11-21，全按推荐）；gpt-6.1-sol Round 1–6 审阅 loop 已收敛（Round 6 = 0 High / 3 Medium / 1 Low，可批准）；design 正式批准待用户确认。**
> Round 1 H1–H6、Round 2 R2-H1/H2/H5/H6/N1、Round 3 R3-H1/H2/H5/H6/N1-M/L、
> Round 4 R4-H1/M1–M3/L1、Round 5 R5-H1/M1/M2 的设计答案已落盘
> （D2.2/D2.3/D4.4/D5.1/D5.4/D6/D7.5/D8/D9；Fix log 在 `notes/review-gpt61-2026-11-21.md`）。
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
| beat 相位 `t = 1.0 + k×0.2`（#170 审查闭环 #4） | **`t = 0.5 + 0.2k`，决策/事件/高亮终点再切段**（D2.3） | #170 的 1.0 相位绑定 1Hz 决策与首 tick=1.0；main v11 首 tick=0.5（`lib.rs:3339`）。相位随决策 cadence 一起改。**当前 `viewer/e2e-v2.mjs:65`–`:66` 的首拍断言已是 `[0.5,1.0]`**（不是旧转述的 `[1,2]`），与新首拍 0.5 一致；若实现阶段要改成精确 0.5，按新协议另写理由。 |
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

### D1.2 本 change 的可见行为差异（写进批准范围）

除运动层数值外，本 change 明确引入两处**事件结果/表示**变化，必须写进批准范围，不能藏成
「只是运动数值更新」：

1. **save 的几何否决**：概率掷定 save 但扑救点在真实时限内不可达时，结果可改为 goal
   （D5.4）。它不改概率常量，但改**结果实现**；分母/逐 seed/L1 非恶化门见 D9.1。
2. **高亮参与者进入 `movers`**：参与者从「隐藏 + viewer 合成直线」改为「5Hz 端点正常输出」，
   事件锚点与积分终点对账（D5.4）。这是协议表示的可见变化，golden/L2 都会变。

## D2 三层 cadence 与时间合同

### D2.1 三个常量

| 常量 | 值 | 语义 |
|---|---:|---|
| `SIM_DT` | **0.1s** | 物理积分步长（内部子步） |
| `DECISION_DT` | **0.5s** | 决策/概率掷定间隔（= 当前 `TICK_SECONDS`） |
| `BEAT_DT` | **0.2s** | beat 名义输出间隔（viewer 采样对齐） |

LCM(0.2, 0.5) = 1.0s：beat 名义网格与 decision 每 1s 重合一次；其余 beat 复用最近一次决策状态。
三者都是 0.1 的整数倍。

### D2.2 唯一权威执行规则：Live Scheduler + CommittedPlan（R4-H1）

当前 `tick()` 假设「一拍 = 一次决策 + 一次 beat」。新实现 SHALL 只有**一条**执行路径：
`CommittedPlan` 覆盖的边界**只消费计划缓存**；未覆盖的边界由 live scheduler 执行。
**SHALL NOT 存在第二套调度语义**（不得在计划覆盖内再调 `decision()`/重掷 RNG，也不得
「先写锚点再让分离推位置」）。

**`CommittedPlan`（提交时冻结，不可变）**

- **时间范围**：`[t_c, P_eff]`，`t_c` = 候选事件提交时刻；
  `P_end = ceil(t_end / SIM_DT) × SIM_DT`，**`P_eff = min(P_end, dur)`**。
  计划 SHALL 至少覆盖包含真实 `t_end` 的完整输出段及其 finalize 状态提交；若 `dur < P_end`，
  计划 SHALL 覆盖终场截段 `[last_boundary, dur]`（`dt = dur − last_boundary`，允许非
  0.1/0.2 的终场短 dt），`t ≥ dur` 不产 beat，`cp_end` 在 `dur` 终态、无未来 decision。
  **部分步只用于落地/锚点对账，不改变实际积分分割**：非终场段仍是整 `SIM_DT` 步；
  终场末段是唯一允许的部分步/短 dt。
- **内容**：
  - 逐边界完整状态 `pos_m / vel_mps / heading / mode` **+ 完整调度状态**：球权、冷却、
    动作机会、活跃高亮、重开、decision 计数（见 R5-M1）；
  - **decision 所有权：`[t_c, P_end)` 内的 decision 归计划**；**恰在 `P_end` 的 decision
    归 live/下一个计划**。`cp_end` 是 `P_end^-`（该 decision **之前**）的 RNG/状态；
  - 事件列表（含 finalize 事件）；
  - RNG checkpoints：`cp_commit`（candidate decision 已定意图之后，见 R5-M1）、每个
    计划拥有的 decision `cp_s`、计划末端 `cp_end`；
  - 规划轨迹（球段端点/落点/飞行时长/参与者端点）。
- **覆盖内只消费缓存**：在 `s ∈ [t_c, P_end)`，调度器 SHALL：
  - 取缓存状态/事件/decision 结果；**SHALL NOT** 调 `decision()`、**SHALL NOT** 重掷 RNG；
  - 逐边界核对实际状态 == 缓存状态；不一致置 `plan_divergence`；
  - beat 的 `from`/`to` 取缓存状态（不重新 `integrate`）。
- **末端原子交还**：在 `P_eff` 应用计划的 finalize/状态提交后，把状态 = 缓存末端状态、
  RNG = `cp_end` 原子交还 live scheduler；**不得回滚已提交字段**。`P_end` 的 decision
  由 live（或 follow-on plan）**只执行一次**；`cp_end` 在它之前。
- **RNG 两个 checkpoint**：规划用 RNG **副本**；`cp_commit` 在 candidate decision 已确定
  意图之后；`cp_end` 在 `P_eff` 终态。覆盖内不消耗正式 RNG；交还 live 用 **`cp_end`**。
  拒绝影子时 live 保持 `cp_commit`（不是 `cp_end`），见 R5-M1。
- **后续高亮（follow-on）**：计划末端若产生新高亮，SHALL NOT 在同一计划内提交。
  follow-on plan 从 **`P_eff`** 开始（新事件 `t ≥ P_eff`），与前一计划**无重叠**；
  若新事件 `t < P_eff`，必须**合并进当前计划**或拒绝候选。链式上限
  `MAX_PLAN_CHAIN = 3`，总时长上限 `PLAN_CHAIN_MAX_S = 30s`；超限置
  `highlight_infeasible`，SHALL NOT 重叠承诺。
- **视野**：`PLAN_HORIZON` ≥ 单条高亮最长时长；`P_eff − t_c ≤ PLAN_HORIZON + SIM_DT`。

**事务边界与守卫（R5-M1）**

- **candidate decision 恰执行一次**：decision 只产生候选意图（含 result 掷定）；`cp_commit`
  定义在该 decision **已确定意图之后**（outcome/participants/目标族已定）。
- **拒绝/重试**：影子规划用 `cp_commit` 的 RNG 副本；拒绝时丢弃影子 state/events/RNG，
  live 保持 **`cp_commit`**（不是 `cp_end`）；重试从 `cp_commit` 起，**意图/参数不变、
  不重抽 candidate result**；规划阶段零新 RNG（若需扰动，只允许预注册的确定性扰动）。
  重试上限 2 次；超限拒绝候选（事件不发射），live 的 RNG/状态仍为 `cp_commit`。
- **`plan_divergence` 三路核对**：① 状态（完整调度状态 == 缓存）；② **独立事件账本**
  （顺序/每条恰好发射一次，无遗漏/重复）；③ RNG 消费/checkpoint（覆盖内正式 RNG 不消耗；
  实际 RNG == `cp_s`/`cp_end`）。任一不符使守卫红，不得静默修补。
- **计划快照**：用完整调度状态（motion + 球权/冷却/动作机会/活跃高亮/重开/decision 计数），
  不是只复制 `MotionState`。

**权威调度伪代码（显式四阶段 A/B/C/D）**

```
s = 0.5; state = initial; rng = live; plan = None
while s < dur:
    # ---- A. 边界事件/decision：每个边界只处理一次 ----
    boundary_done = (plan and plan.start_marker == s)  # 本边界已在创建计划时处理过
    if not boundary_done:
        emit/apply boundary_events_at(s)               # finalize / 事件（确定性顺序）
        if decision_due(s):
            if plan and plan.owns_decision(s):
                apply plan.decision_at(s)              # 只消费缓存；不调 decision()
            else:
                decision(s)                            # candidate decision 恰执行一次
                if candidate committed:
                    plan = new_plan; plan.start_marker = s
    # ---- B. 选择/接管计划（同一迭代；首段立即消费）----
    use_plan = plan is not None and plan.covers_segment(s)
    if use_plan: plan.start_marker = s
    # ---- C. snapshot：仅 decision_due ----
    if decision_due(s): snapshot(s, state)
    # ---- D. 取缓存或 live 推进 → 发 beat ----
    if use_plan:
        p = plan.at(s)
        assert state == p.state                         # 逐边界核对
        dt = p.dt(s); state_next = p.state_next
        emit_beat(s, dt, p.state, state_next)           # from/to = 缓存
    else:
        dt = next_boundary_after(s) - s                 # 0.1/0.2；末段 dur-s
        state_next = integrate(state, dt)
        emit_beat(s, dt, state, state_next)
    state = state_next; s += dt
    if use_plan and s == plan.P_eff:
        emit plan.events_at(s)                          # P_eff 的 finalize 事件
        assert state == plan.state_end
        rng = plan.cp_end; plan = None                  # 原子交还 live
```

- **A 只跑一次**：候选 decision 在 A 创建 plan#1 后，B **同一迭代**接管首段；
  `start_marker` 防止下一轮回到同一 `s` 时重复发起点事件/decision。流程是
  **「算一次（A）→ 发一次（A/D）→ 缓存接管一次（B）→ 不再重算（D）」**。
- **P_end 所有权**：A 在 `s=P_end` 时 plan 已在上一轮 D 交还清空，因此 `P_end` 的
  decision 由 live（或 follow-on plan）执行一次；`cp_end` 是它之前的 `P_end^-`。
- **终场**：`P_eff=min(P_end,dur)`；若 `dur<P_end`，D 的最后一段是 `[last_boundary,dur]`
  的短 dt，`t≥dur` 不发 beat，`cp_end` 在 dur 终态，无未来 decision；SHALL NOT 原样发到
  `P_end>dur`，也不得为修末段重新积分已承诺计划。
- **顺序是合同**：上段终态 → finalize/事件 → decision → snapshot → 下一段（缓存或积分）→
  beat。`beat.t` 是段起点，`to` 是段终点状态（缓存或预积分）。
- **finalize 的 `t`**：第一个 ≥ `t_end` 的 0.1s 网格 sim step；事件内部锚点仍用真实
  `t_end`（D2.3 非网格落地）。
- **快照语义**：记录 `s` 时刻的边界状态（事件/决策后），等于上段 `to` 与下段 `from`；
  p16/p124 的交叉断言改为对 `beat.from`（D2.4）。
- **例外路径**：死球窗口可跳过段不发 beat（但每 2.0s 至少一条静态 beat）；重开准备
  判定段不产 beat——按 D2.3 的显式例外。
- 决策/掷骰仍只在 `DECISION_DT` 发生；仿真子步**不新增 RNG**；子步不发射。
- 所有 `*_TICKS` 常量必须重新挂到 **decision 拍**计数器（#170 已列 17 个实际换域常量；
  当前 v11 已按 `TPF=2` 换过一轮，本 change 要再核一遍，不能假设）。

**交接边界对账表（事件 / decision / RNG / beat）**

| 场景 | A 边界处理 | B 接管 | C snapshot | D 段与 beat | RNG |
|---|---|---|---|---|---|
| 首段 `s=1.0, plan=None` | 执行 candidate decision，创建 plan#1（`t_end=1.65`） | 同一迭代接管 plan#1 首段 `[1.0,1.1)` | decision_due → snapshot(1.0) | 缓存 `from/to`，发 beat [1.0,1.1) | 正式 RNG 不消耗；`cp_commit` |
| 跨 decision `s=1.5` | plan 拥有该 decision，应用缓存结果（不重掷） | 接管 `[1.3,1.5)` 后的下一段 | decision_due → snapshot(1.5) | 发 beat [1.3,1.5)；下一段 [1.5,1.7) 缓存 | `cp_1.5` |
| `P_end=1.5`（t_end=1.45） | 1.5 的 decision **不在计划内**；1.5 前先交还 | plan 不拥有 1.5 | live decision 后 snapshot(1.5) | 计划发 [1.3,1.5) 后交还；1.5 decision 由 live 执行一次 | `cp_end` = 1.5^-（decision 前）；live decision 消耗它 |
| `P_end=1.7` 接续 | 1.5 在计划内；1.7 的 decision 归 live/follow-on | plan#2 从 1.7 起（若候选） | 1.7 live decision 后 snapshot(1.7) | plan#1 发 [1.5,1.7) 后交还；plan#2 发 [1.7,...) | `cp_end` = 1.7^-；plan#2 用 `cp_end` |
| `dur=1.55` | plan#1 覆盖到 `P_eff=1.55`；无 1.55 decision | 计划内最后段 `[1.5,1.55]`（dt=0.05） | 1.5 snapshot；1.55 非 decision 不 snapshot | 发 [1.5,1.55) 的短 dt 后结束；`t≥1.55` 不发 beat | `cp_end` 在 1.55 终态 |

- 1.5 的 decision 在 `P_end=1.7` 场景只算一次（计划内）；在 `P_end=1.5` 场景由 live 只算
  一次（`cp_end` 在之前）。两种情况的执行结果唯一。
- 1.7 的 finalize/交还与 follow-on 不重叠；plan#2 的起点 ≥1.7。
- 部分步（`t_end=1.65`）只用于球落点/锚点对账；非终场实际段仍是整 0.1 步，终场 1.55 段
  是唯一短 dt。

**实现者只需实现这一条路径**：live path 与 plan-consume path 共用同一个段边界循环、
同一个 beat 发射点、同一份状态提交；不存在「只在计划内用另一套调度」的选项。若实现时
发现必须新增第二套语义，说明本合同的覆盖范围/交还点还没写清，应回到 D2.2 修合同，
而不是在代码里分叉。

### D2.3 时间合同（H1）

**仿真计数与首拍**

- `sim_i ∈ ℕ` 是整数仿真步计数，`t = sim_i × SIM_DT`。
- 仿真从 `sim_i = 5`（`t = 0.5`）开始第一次决策；`[0, 0.5)` 是**前导期**：
  不积分、不产 beat，画面由 `lineup` / `kickoff` 事件描述。这一条承接 main 的首个 tick=0.5
  （`engine/src/lib.rs:3339` `let mut t = TICK_SECONDS`）。
- 决策时刻集合 `D = {0.5 + 0.5m | m ≥ 0}`；beat 名义网格 `B = {0.5 + 0.2k | k ≥ 0}`。
- **段边界** `S = sort(B ∪ D ∪ E)`，`E` = 全部非 beat 事件的发射时刻
  （事件/finalize 必须落在 0.1s 网格上，故段长只会被切成 0.1/0.2）。
- 每个段 `[s_i, s_{i+1})` 产一条 beat：`beat.t = s_i`（**段起点**），
  `beat.dt = s_{i+1} − s_i ∈ {0.1, 0.2}`，`from` = 状态(`s_i`)，`to` = 状态(`s_{i+1}`)。
  **例外**：终场最后一段 `dt = dur − s_last`（`0 < dt ≤ 0.2`，不要求 ∈ {0.1,0.2}）；
  重开准备的「判定段」不产 beat（见 D2.3 末尾的显式例外）。
- **事件密集上界**：若一个原本 0.2s 的段内有事件落在名义网格之间（如 0.6），该段被切短，
  段密度可升到 0.1s 一段（名义 10 段/s）。**6 段/s 与 3× 只是「无额外事件」的预算基准，
  不是事实**（R2-M2，D7.5 给上界与超预算处置）。

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
- **段数基准**：无额外事件时每个 1s 周期 5 个名义 beat 段 + 1 个偶数决策切段 = **6 段/s**
  （main 2Hz 的 3×）；事件密集时上界 10 段/s。预算是 3×，不是由段数保证的固定倍数。
- **同时间戳排序**：非 beat 事件先（按引擎发射顺序，确定性），beat 最后；
  beat 描述这些事件之后的段。beat 在段起点、处理完该边界的事件/决策后发出，
  `to` 是预积分到段终点的状态（D2.2）。任何“先 beat 后事件”或“beat 描述事件前的段”
  都 SHALL 视为实现错误。
- **显式例外**：重开准备（RestartPrep）的**判定段**不产 beat（它是「判定 → 准备」的
  一次性边界）；其后每个准备段仍按本规则产 beat。除该例外与死球窗口外，每个段一条 beat。

**实体连续性**

- 对任意实体 `id`（球员或球），若它在相邻两段都被携带（`movers` / `main` / `ball` 任一表示），
  SHALL 满足 `from(N+1) == to(N)`（按米制、按状态位）。
- 若在 N+1 段因**稳定静止**被省略（不是新状态首段），则其状态 = N 段末状态；
  下一次重新出现时 `from` SHALL 等于该状态。新状态首段即使零位移也必须发锚点（D5.1）。
- **跨表示切换**（carrier 从 `main` 变 `movers` 或反之）也 SHALL 按实体位置连续：
  边界处的 `main.x2/y2`、`movers.to_x/to_y`、事件终点、`st.pos` 四者一致。
- 连续性校验是**属性测试**（D7），不是只比 `to(N)` 与 `from(N+1)` 的字段。

**合法断点（位置跳变 / 速度重置）**

| 事件 | 位置跳变 | 速度重置 | 边界要求 |
|---|---|---|---|
| `kickoff` | 球到 (0.5,0.5) | 球/开球者 = 0 | kickoff 事件时刻必须是段边界 |
| 死球重开（out / goal kick / corner / throw-in / free kick） | 球从越界处到固定点 | 球 = 0 | 重开事件时刻必须是段边界；重开者走位仍受运动学约束（D5.4） |
| `save-caught`（门将扑住） | 无（位置连续） | 门将持球瞬间 = 0 | 允许速度重置，不允许位置跳变 |
| 高亮 finalize / 交接 | **无位置跳变**（执行连续积分结果） | 按结果停住；扑住置 0 | 只有连续积分结果；**不允许位置投影/一步跳变**；否则失败 |
| 罚下（red card） | 实体移除 | — | 该实体此后 SHALL NOT 出现在任何段 |
| 进球后回中圈 | 球到 (0.5,0.5) | 球 = 0 | `whistle` / `kickoff` 时刻是段边界 |
| 终场排空 | 无新段 | — | `t ≥ dur` 不产 beat；末段允许 `dt = dur − s_last`；见下 |

除上表之外的 finalize 位置跳变 SHALL 视为失败（D5.4、D7 的 finalize 断言）。
**「≤ V_MAX·SIM_DT 的一步位置投影」不算连续性**——它是瞬移，只是小；C1 不接受它替代
连续积分结果（R2-H5）。

**非网格飞行落地**

- 球的飞行终点 `t_end = t + dist/speed` 一般不在段边界上。事件自身的锚点
  （`t_start → t_end`）仍用真实 `t_end`；宿主段的 `to` 是该段末状态（落地后位置），
  因此连续性不受影响。viewer 用 mover 端点渲染参与者、用事件锚点渲染球（D5.4）。
- 高亮结束时引擎在**第一个 ≥ t_end 的 0.1s 网格 sim step** finalize（事件从而切段）；
  事件的 `t` = 该边界，事件内部锚点终点仍是 `t_end`。finalize 时刻的事件先于同刻 beat。

**死球与终场**

- 死球窗口可以不产 beat；约束的对象是**相邻已发 beat**的 gap（不是「死球前最后一条」与
  「重开后第一条」的差）：相邻已发 beat 的 `t` 差 SHALL ≤ 2.0s。若死球窗口本身 > 2.0s，
  引擎 SHALL 至少每 2.0s 发一条静态 `ball` beat（零位移锚点），使**每一对相邻已发 beat**
  都满足上界；死球总时长本身可以 > 2.0s。
  - 例（3s 死球，t=10.0 开始，13.0 重开）：已发 beat 在 10.0（死球开始）、12.0（静态锚点）、
    13.0（重开）→ 相邻 gap = 2.0、1.0，均 ≤ 2.0s；不是要求 10.0 与 13.0 的差 ≤2.0s。
- 终场排空：`t ≥ dur` 不产 beat；链式 finalize 的去重对象是**终态事件集合**——同一 `dur`
  上的多条 finalize 只保留**一个终态**（P30 的旧规则），**不新增段**；终场前最后一段以
  `dur` 结束，允许 `dt = dur − s_last`（0 < dt ≤ 0.2）。

### D2.4 观测快照（M4）

- `tick` 仍是 **decision**（`DECISION_DT`）；10Hz 只是 `tick()` 内部子步。
- **快照点（R2-H1 钉死）**：段边界 `s ∈ D`、`s < dur`，在 `process_events_at(s)` 与
  `decision(s)` **之后**、下一段积分之前采样。记录的是**边界状态**（= 上段 `to` = 下段
  `from`），不是 main 的「窗口末态」。首个 `s=0.5`，之后每 `0.5s`；
  `expected_ticks = ceil(DUR / DECISION_DT) − 1`；终场排空不采样。
- p16 的「快照位置 == beat 投影」断言 SHALL 改为对**同 `t` 的 `beat.from`**（或上段 `to`），
  不得再对 `to`——否则会把「边界状态」错当「窗口末态」。这是一条**观测语义的显式变化**，
  必须在 p16/p124 的测试与文档同批更新。
- p124 的 `intent_snapshots[i]` 与 `state_snapshots[i]` 同一 `t`、同一提交点相邻 push
  （`s` 时刻、decision 之后）；两通道顺序不变。
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
| `ARRIVE_RADIUS_M` | **1.0 m** | 工程初值，待标定 | **普通**到达半径；不用 2m 冻结 |
| `PRECISION_ARRIVE_RADIUS_M` | **0.25 m** | 工程初值 | **事件参与者**的精确到达模式；SHALL ≤ `REACH_TOL_M` |
| `REACH_TOL_M` | **0.25 m** | 工程初值 | 可达性判据的位置容差（与普通到达半径**分离**） |
| `REACH_SPEED_TOL` | **0.5 m/s** | 工程初值 | 可达性判据的末速容差 |
| `RESIDUAL_SPEED_MAX` | **0.2 m/s** | 工程初值 | 到达后的数值残余；**不允许 0–1 m/s 的漂移**（H6 防微抖） |
| `V_REVERSE` | **0.5 m/s** | 工程初值 | 目标在身后时先减速到该值再转身 |
| `A_MAX` | **8.0 m/s²** | 工程初值，待标定 | **总向量加速度预算**；SHALL ≥ `max(A0_max, a_lat)`；见 D4.4 |

**为什么普通到达半径与事件参与者半径必须分开（R2-H5）**：若参与者用 `ARRIVE_RADIUS_M=1.0`，
一个距落点 0.5m、速度 0 的接球者会被判「已在到达半径内 → `v_des=0`」，永远到不了 0.25m 的
`REACH_TOL_M`，可达性检查必然失败。参与者改用 `PRECISION_ARRIVE_RADIUS_M=0.25m` 的精确到达
模式后，0.5m 的短距离会正常减速到点。普通球员仍用 1.0m，避免全队为 0.25m 抖动。

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

### D4.4 确定性单步算法（M3/R2-N1）

每个仿真子步 `t → t + dt`（`dt = SIM_DT`，或可达性检查的最后不足一步的部分步），
对全部未罚下球员**按 id 升序**执行；决策窗口内 `target` / `mode` 固定（只在 decision
边界更新）。**统一顺序（R2-N1 写死一种）**：

**状态表示（R3-M1）**：`vel_mps` 是**二维速度向量**（权威量）；`speed = |vel|`、
`heading = atan2(vel.y, vel.x)`（`speed > V_EPS` 时），`speed ≤ V_EPS` 时保留上一 heading。
预算与位置只用 `vel`，不再用「标量 speed × 方向」的混合写法。

1. **期望速度**：`d = |target − pos|`；
   `R = (参与者 ? PRECISION_ARRIVE_RADIUS_M : ARRIVE_RADIUS_M)`；
   若 `d ≤ R`，`v_des = 0`；否则
   `v_des = min(mode_cap, V_MAX, sqrt(2·a_brake·(d − R)))`。
2. **反向判定/制动**：`θ_err = wrap(atan2(target−pos) − heading)`。
   若 `|θ_err| > π/2` 且 `speed > V_REVERSE`：本子步 `v_des = 0`、`turn_allowed = false`
   （只制动，不转向）；否则 `turn_allowed = true`。**禁止瞬时反向**。
3. **朝向更新**：仅当 `turn_allowed`：
   `ω_max = min(MAX_TURN_RATE, a_lat / max(speed, V_REVERSE))`；
   `heading += clamp(θ_err, −ω_max·dt, +ω_max·dt)`。
4. **速度指令**：`a_cmd = clamp(v_des − speed, −a_brake·dt, A0·(1 − speed/S0)·dt)`；
   `speed_next = max(speed + a_cmd, 0)`；
   `vel_cmd = speed_next · (cos heading, sin heading)`。
   模式 cap 下调只改 `v_des`，减速由 `a_brake` 限制（不直接 clamp `speed`）。
5. **运动预算（先于位置）**：`Δv_motion = vel_cmd − vel_before`
   （加速 + 转向 + 预测避碰的指令修正全部计入）。若 `|Δv_motion| > A_MAX·dt`，
   按比例缩放：`vel_after = vel_before + Δv_motion·(A_MAX·dt/|Δv_motion|)`；
   否则 `vel_after = vel_cmd`。由 `vel_after` 恢复 `speed = |vel_after|`、
   `heading = atan2(vel_after.y, vel_after.x)`（speed > V_EPS 时）。
   **不允许**用 `A0·dt` 或 `a_lat·dt` 分别判界（正常加速+转向会超过 `A0·dt`）。
6. **位置更新（半隐式 Euler）**：`pos += vel_after · dt`（**向量直接乘 dt**，不再乘 cos/sin）。
7. **分离与总向量预算（R2-N1 的关键门）**：全部球员积分后，按 D4.5 执行分离；
   分离引起的 `Δv_sep = Δpos_sep/dt` 加到 `vel_after` 得 `vel_final`；检查
   `|vel_final − vel_before| ≤ A_MAX·dt`。若超预算，**先缩减分离修正并重解**（≤3 次）；
   若缩减后仍不能同时满足 2.2m 间距与预算，置 `constraint_infeasible`。
   由 `vel_final` 恢复 `speed`/`heading`。**不允许**在分离后「缩放所有修正并重算位置」
   来绕过间距，也不允许各阶段分别过门。
8. **米制边界**：`pos_m` 钳到 `[0, 105] × [0, 68]`（**不是 [0,1]**；归一化只发生在发射时）。
   若指向边界外的法向速度 `> A_MAX·dt`，置 `constraint_infeasible`（目标/运动本身非法）；
   否则该法向分量清零，**清零后重做一次总预算检查**（`|vel_final − vel_before| ≤ A_MAX·dt`），
   并记录 `boundary_reset`；仍超预算则 `constraint_infeasible`。
9. **提交**：段边界上才写 `last_emitted` / 发 beat；子步不发射。

**数值例（精确向量值，R3-L1）**：`speed=6 m/s, A0=6.4, S0=9.5, a_lat=6.5, dt=0.1,
θ_err=0.2 rad, MAX_TURN_RATE 不更紧`。纵向 `Δspeed = 6.4·(1−6/9.5)·0.1 = 0.236 m/s`；
`ω = min(MAX_TURN_RATE, 6.5/6) = 1.0833 rad/s`，`Δθ=0.10833 rad`。二维旋转后的
**精确**总向量 `|Δv| ≈ 0.703044 m/s ≤ A_MAX·dt = 0.8`（A_MAX=8.0）。
`sqrt(0.236² + 0.650²) = 0.692` 是**线性化近似**，只用于说明量级，SHALL NOT 用作精确验收值。
若把 `A_MAX` 设成 `A0=6.4`，同一个正常运行就会红——所以 `A_MAX` 必须独立定义且
`≥ max(A0_max, a_lat)`。

**积分次序是合同的一部分**：决策 → 子步（期望速度 → 反向/制动 → 朝向 → 速度 →
**运动预算** → 位置 → 分离 → **总预算**）→ 段边界提交。同 seed 同 config 必须逐位复现；
任何“先位置后速度”或“浮点累加顺序随 HashMap”都算实现错误。

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
   沿相对速度的确定性垂线方向调整 `v_des`；修正计入 D4.4 第 7 步的总预算 `A_MAX·dt`；
   选边按 `(小 id, 大 id)` 的预测叉积符号，叉积为零时按 `(id_a + id_b) % 2`。
3. **位置投影层（硬不变量）**：积分后仍 < 2.2m 时，按最小平移向量投影；由此产生的
   速度修正同样计入总预算 `A_MAX·dt`。若在 3 次迭代内不可行，
   置 `constraint_infeasible`（第 2 层本应提前避免；这是防御网，不是常规路径）。

- **高亮参与者不再是 frozen**：他们与普通球员一样进入分离、一样被推移；事件终点写成
  **分离后的连续积分结果**（D5.4）。`frozen_mask` 不再用于参与者；`highlight_frozen_segs`
  的「显示线」机制退役。
- `carrier` 仍参与端点分离（开放比赛里其位置由 main 表达，但仍要被推开）。
- 跨队（tackle 结算的双方）不受同队 2.2m 约束（main spec 的 `跨队不适用` scenario）。

## D5 事件流与协议

### D5.1 beat 5Hz 与稀疏 main/ball（H2/R2-H2）

- `beat` 每段一条；段定义见 D2.3。`movers` 含该段有非零位移的球员
  （`{id, from_x, from_y, to_x, to_y, speed, action}`）。
- **驱动状态机（R3-H2）**：事件流只有四种驱动状态，SHALL NOT 混用：

  | 状态 | 人/球驱动 | `main` / `ball` | 首段规则 |
  |---|---|---|---|
  | `controlled` | carrier 用 `main` | 每个 carrier 有非零位移的段发 `main` | **进入 controlled 的首段即使零位移也发 `main`** |
  | `loose` | 球用 `ball` | 每个球有非零位移的段发 `ball` | **进入 loose 的首段即使零位移也发 `ball`** |
  | `highlight` | 球用事件锚点；参与者用 `movers` | **禁止 `main` / `ball`** | **事件本身 = 新状态首锚点**；不强制 `main`/`ball` |
  | `restart` | 球停固定点；发球者走位用 `movers` | 首个准备段发静止 `ball`；其后稳定可省 | 首个准备段即使零位移也发 `ball` |

- **转移**：`controlled ↔ loose`（拾取/弹开）、任意 → `highlight`（pass/shot/tackle 开始）、
  `highlight → controlled/loose`（finalize）、任意 → `restart`（out/foul）、
  `restart → highlight`（重开发球）。**高亮开始时，事件本身就是新状态首锚点，并清除旧
  `main`**；高亮期间禁止 `main`/`ball`；**高亮结束后的首个 controlled/loose 段**才强制
  `main`/`ball`（即使零位移）。非高亮的原地拾取、固定点、静止松散球仍按上表首段规则。
- **高亮参与者不再隐藏（R2-H5）**：接球者/拦截者/门将/抢断双方/重开者与普通球员一样，
  **在该段有非零位移时进入 `movers`**，`action` 标记为 `"highlight"`；零位移段保持上一位置。
  角色由当前高亮事件给出，不新增字段。
- **状态失效**：`pass` / `shot` / `tackle` / `out` / `whistle` / `foul` 事件在 `t` 时刻
  使其前的 `main` 记忆失效；`movers`-only beat **不**使状态失效。失效后若进入 `highlight`，
  事件本身是首锚点（不是 `main`/`ball`）；若进入 `restart` / `controlled` / `loose`，
  按上表首段规则发锚点。
- **删除的歧义**：「只在状态变化或 decision 拍携带」「若现有条款冲突…再退回每个 decision 拍
  带一次」这类措辞全部删除。判据是**该段是否有非零位移**，外加**进入非高亮状态的首段**。

**viewer 的 seek / 重建规则**（与 D6.2 同义，协议侧先写死）：

- 向前（时间轴）找最近的主状态来源：当前高亮活跃时，球用事件锚点、参与者用 `movers`；
  否则最近一条 `main` / `ball`；再否则最近一条 beat（球员 mover）。
- 高亮结束后的第一段从**事件终点**续接；该段是 `controlled`/`loose` 首段，必有
  `main`/`ball` 锚点；不得从高亮前的旧 `main` 续接。
- `currentCarrier()` 必须向前扫描到最近的 `main`，并在遇到失效事件时停止（不能只看当前
  beat——这是 `viewer/game.js:416`–`:420` 的现状缺口）。
- **seek 断言（R2-H2）**：随机 seek 到任何稳定静止段，回扫必须能命中**该状态的首锚点**
  （新状态首段已强制发出 main/ball）；不得出现「回扫到旧状态」或「无锚点可用」。
  该断言是属性测试，覆盖 save-caught 零速持球、原地拾取、新 loose 球静止三类。

**短 trace（人球一致性的最小证据）**

> 下表是**米制示意**（`x/y` 单位 m）；线上协议字段是归一化坐标，发射前按 `x/105`、`y/68`
> 换算（`from/to`、`x2/y2` 同理）。`dt` 单位秒。

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

无 `main`；每段球都有位移，故每段携带（本表是**匀速**版本，1.3 时球在 54.80）。
若球在段内减速停下，**连续停点在球轨迹内表现**（宿主段的 `to` 是段末状态，viewer 段内线性
插值是近似）；**状态转移只在下一个 0.1s `SIM_DT` 网格边界确认**，该边界后的首段发静止
`ball {x=停点, x2=停点, speed=0, loose:true}`（即使零位移），其后稳定静止段可省略。
**不新增非终场任意短 dt**（末段 `dur − t_last` 是唯一例外）；不得把连续停点时刻直接当成
新段边界。若球恰在 0.1 网格步停下，直接在该边界切换；否则等到下一个 0.1 边界。

*Trace C：0.5s 球权切换（t=1.0 的 tackle，success；highlight=[1.0,1.5]）*

| t | 事件 | 携带 | 段 |
|---:|---|---|---|
| 0.9 | beat | `main {carrier:A, → 接触点 P}` | [0.9,1.0) |
| 1.0 | **tackle（非 beat，先）** | `{subject:B, to:A, x2/y2=P, loose_x/y=L, carrier_from=…}` | — |
| 1.0 | beat | **无 main / 无 ball**；`movers` **含 A、B**（`action:"highlight"`）；球由事件锚点驱动 | [1.0,1.1) |
| 1.1 | beat | 同上（movers-only 的球状态；A、B 仍在 movers） | [1.1,1.3) |
| 1.3 | beat | 同上（到 highlight 终点 1.5） | [1.3,1.5) |
| 1.5 | beat（finalize 后） | 新状态首段：`ball {x=L, x2=…, loose:true}`（即使零位移也发）；`movers` 含拾球者 | [1.5,1.7) |

- 段按全局网格：1.0 之后是 1.1、1.3、1.5，**不是** 1.2、1.4（R2-H1）。
- 状态失效：1.0 的 tackle 使 `main(A)` 失效；1.0–1.3 的 movers-only beat 不得让 viewer
  回退到 A 持球；1.5 起球由 `ball` 接力，直到新的 `main` 出现。
- 参与者不再隐藏：A、B 在 1.0–1.3 的每个段都出现在 `movers`；1.5 时两人的 mover 端点
  SHALL 等于 tackle 的 `carrier_end` / `subject_end`（连续积分结果，容差 `REACH_TOL_M`）。
- 球的位置：0.9 段末 = P，tackle 的 `x2/y2` = P，1.5 的 `ball.x` = L（`loose_x/y` 的终点）；
  中间轨迹由事件锚点驱动，不是位置瞬移。

*Trace D：shot result=saved（内部 outcome=caught）门将零速持球（t=10.0 finalize）*

> `save-caught` **不是线上事件类型**：它是 `shot` 事件（`result=saved`）的内部 outcome。
> 10.0 是这条 shot 高亮的 finalize 边界；状态从 `highlight` 转入 `controlled`。

| t | 事件 | 携带 | 段 |
|---:|---|---|---|
| 10.0 | **内部 finalize（无新事件类型）** | `shot` 事件在 `t_start` 已发（`result=saved`、内部 outcome=caught）；10.0 只是高亮结束；状态 → controlled（carrier=GK，mode=hold，speed=0） | — |
| 10.0 | beat | **`main {subject=GK, x=S, x2=S, speed=0}`**（进入 controlled 的首段，零位移也发） | [10.0,10.1) |
| 10.1 | beat | 稳定静止段，**可省略 `main`**；viewer 保持 GK 持球 | [10.1,10.3) |
| 10.3 | beat | 稳定静止段，可省略 | [10.3,10.5) |
| 10.5 | decision + beat | 若 mode/carrier 变化，首段再发 `main`；否则继续省略 | [10.5,10.7) |

*Trace E：松散球原地被拾取（t=12.0）*

> 「拾取」**不是线上事件类型**：它是 `loose → controlled` 的内部转移（无独立事件）。
> 该转移发生在 12.0 这个 decision 边界；首段由 `main` 表达。

| t | 事件 | 携带 | 段 |
|---:|---|---|---|
| 12.0 | decision（内部 loose→controlled） | 球在 L 静止，球员 P 也在 L；carrier=P，speed=0 | — |
| 12.0 | beat | **`main {subject=P, x=L, x2=L, speed=0}`**（进入 controlled 首段；同段不再发 `ball`） | [12.0,12.1) |
| 12.1 | beat | 稳定静止段，可省略 `main`；viewer 保持 P 持球 | [12.1,12.3) |
| 12.3 | beat | 稳定静止段，可省略 | [12.3,12.5) |

*Trace F：tackle 弹开 → 高亮结束后的 loose 转移（t=14.0 开始，14.5 finalize）*

> 14.0 是 **tackle 高亮开始**，不是 loose 开始；14.0–14.5 是 `highlight` 状态（禁 main/ball）。
> loose 从 **14.5 finalize 后**才开始；首个 loose 段 [14.5,14.7) 强制发静止 `ball`。

| t | 事件 | 携带 | 段 |
|---:|---|---|---|
| 14.0 | **tackle（高亮开始，非 beat，先）** | 状态 controlled→highlight；球由事件锚点驱动；参与者 A/B 在 movers | — |
| 14.0 | beat | **无 main / 无 ball**；`movers` 含 A/B（`action:"highlight"`） | [14.0,14.1) |
| 14.1 | beat | 无 main / 无 ball；双方继续 movers；球仍在事件轨迹 | [14.1,14.3) |
| 14.3 | beat | 同上（到高亮终点 14.5） | [14.3,14.5) |
| 14.5 | **内部 finalize（高亮结束；无新事件类型）** | 状态 highlight→loose；球停在 L | — |
| 14.5 | beat | **`ball {x=L, x2=L, speed=0, loose:true}`**（进入 loose 首段，零位移也发） | [14.5,14.7) |
| 14.7 | beat | 稳定静止段，可省略 `ball`；viewer 保持 L | [14.7,14.9) |

**相位核对表（所有 trace 由同一个 `S = sort(B ∪ D ∪ E)` 机械生成，禁止手写相位）**

| trace | 起点 | 段边界 | 强制 decision 点 |
|---|---:|---|---|
| A / B | 0.5 | 0.5, 0.7, 0.9, **1.0**, 1.1, 1.3 | 0.5, 1.0 |
| C | 1.0 | 1.0, 1.1, 1.3, **1.5**, 1.7 | 1.0, 1.5 |
| D | 10.0 | **10.0, 10.1, 10.3, 10.5** | 10.0, 10.5 |
| E | 12.0 | **12.0, 12.1, 12.3, 12.5** | 12.0, 12.5 |
| F | 14.0 | **14.0, 14.1, 14.3, 14.5, 14.7** | 14.0, 14.5 |

- 每行相邻 `from/to` 必须逐位相等；`dt` = 下一界 − 当前界；非末段 `dt ∈ {0.1,0.2}`。
- 三条新 trace 的共同点：**进入 controlled/loose 的首段是「身份/模式」锚点，不是「位移」锚点**；
  高亮开始由事件本身做首锚点，不强制 main/ball；seek 回扫必须命中状态首锚点（D6.2 属性测试）。

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
  - **finalize 时刻**：`t_end = t + flight`；在**第一个 ≥ t_end 的 0.1s 网格 sim step**
    finalize（该步进入段边界集合，事件先于同刻 beat）；finalize 之后的第一段携带新状态
    （`ball` 或 `main`，**新状态首段即使零位移也发**，D5.1）。
  - **口径区分（M6）**：决策仍 2Hz、零新增 RNG ⇒ **概率常量与机会时钟不变**；
    但几何/可达性会改变实际实现的 pass/shot/tackle **计数**（涌现事件计数不逐位相同）。
    本 change 不调概率常量；若 L1 体量带破，停止并另立标定 change，**不得**追着候选结果放宽真实带。

### D5.4 高亮参与者与统一运动状态（H5/R2-H5）

所有角色 SHALL 服从同一 `MotionState` 积分器；参与者**不冻结、不隐藏、不瞬移**。
参与者在**该段有非零位移时** SHALL 出现在 `movers`（`action:"highlight"`）；零位移段按 H2
保持上一位置。球由事件锚点驱动。
事件锚点 SHALL 等于参与者**连续积分到 `t_end`** 的位置（容差 `REACH_TOL_M`）；
viewer 用 `movers` 端点渲染参与者，**不再合成起终点直线**。目标产生 → 积分 → 事件锚点 →
完成交接：

| 角色 | 目标产生 | 积分 | 事件锚点 | 完成交接 |
|---|---|---|---|---|
| pass 接球者 | decision 时由接球者位置 + lead 生成落点 | 同一积分器，`target=落点`，时限 `[t_start,t_end]`；分离也作用于他 | `receiver_x/y` = `t_start` 位置；`x2/y2` = **球落点 = 接球者在 `t_end` 的连续积分位置**（容差内） | 该边界 mover 端点 = `x2/y2`（容差内）；下一段作为普通 mover 继续；不瞬移 |
| pass 拦截者 | 拦截点 `at` | 同上，`target=at` | `interceptor` + `at` = 连续积分到 `t_end` 的位置 | 若成为新 carrier，下一段首段 `main.from=at`（H2 新状态首段） |
| shot 门将 | 扑救点 = 球路径上与门将可达集的最早交点 | 同上，`target=扑救点` | `keeper_x/y` 仍是**射门瞬间**位置；扑救点 = 连续积分到 `t_end` 的位置 | 扑住（caught）位置连续、速度置 0（合法速度重置）；扑出（rebound）速度取积分值 |
| tackle 双方 | 接触点 `(x2/y2)` = 双方可达集的确定性交点 | 双方同一积分器 + 分离，时限 `[T,T+DECISION_DT]` | `subject_end/carrier_end` = **分离后**连续积分到 `t_end` 的位置 | 该边界 mover 端点 = 事件终点（容差内）；速度取积分值（或按结果停住） |
| 重开者（角球/界外球/任意球） | 固定点 = 角旗/出界点/犯规点 | 准备期正常走位（8 m/s 快走 `v_cap`） | 发球 pass 起点 = 固定点 | 到达前不发球；准备期延长而不是瞬移（上限 `RESTART_PREP_MAX_S`，工程初值 6.0s） |

**事件必须以 `CommittedPlan` 提交（R4-H1）**：高亮事件的端点不是「先写目标、执行时再被
分离推」，而是由 **D2.2 的唯一权威执行规则**中的 `CommittedPlan` 在发射前冻结。计划的生命
周期（覆盖范围 `[t_c, P_end]`、逐边界状态/decision/事件、RNG `cp_commit`/`cp_end`、覆盖内
只消费缓存、末端原子交还、follow-on 链上限）**全按 D2.2**；本节只列高亮特有的规划输入：

- **候选意图**：decision 只产生候选事件的意图（type、participants、result、目标族），
  **不写** `x2/y2` / `subject_end` / `carrier_end` / `loose`。
- **规划输入**：当前 decision 状态下的 22 人（含同队分离）状态；用同一积分器 + 同一分离
  solver 做确定性前视，产出球路、飞行时长、全部参与者端点。**分离在计划内**，不得先写
  锚点再让分离改位置。
- **覆盖范围**：`P_end = ceil(t_end/SIM_DT)·SIM_DT`、`P_eff = min(P_end, dur)`，
  至少包含真实 `t_end` 所在完整输出段与 finalize 状态提交；若 `dur<P_end` 覆盖终场
  短 dt（`dur−last_boundary`）与 dur 终态。**`P_end` 的 decision 不归计划**（归 live/
  follow-on），`cp_end` 在该 decision 之前；部分步只作落地/锚点对账，不改变非终场积分分割。
- **验证**：计划终点满足 `reachable`/`REACH_TOL_M`/同队间距/总向量预算；事件锚点 = 计划
  终点（容差内）。
- **不可行**：在事件 `t_c` 之前调整时间/落点或置 `highlight_infeasible`；**SHALL NOT**
  先发事件再补计划，也 **SHALL NOT** 在 `t_c` 之后覆盖已承诺端点。
- **执行**：覆盖内只读 D2.2 的计划缓存（不调 `decision()`、不重掷 RNG），逐边界核对；
  偏差 `plan_divergence`。计划末端若产生新高亮，按 D2.2 的 follow-on 规则从 `P_end`
  开新计划（无重叠，`MAX_PLAN_CHAIN=3` / `PLAN_CHAIN_MAX_S=30s`）。

**单一轨迹（R2-H5 的核心）**：

- 参与者是正常 mover：每段 `movers` 端点就是 viewer 看到的轨迹；**没有第二套合成直线**。
- `st.pos`（含分离）在段边界 == 发出的 mover 端点 == 事件锚点在 `t_end` 的值（容差内）。
- `highlight_frozen_segs` 的「显示线」机制**退役**；`frozen_mask` 不再用于参与者。
  分离 solver 直接约束参与者的 mover 线段（与队友同一条线）。

**可达性检查（事件发出前，不是事后）**：

- `reachable(pos, vel, end, T)` 用**同一积分器**跑**真实可用时长 `T`**：
  `n = floor(T/SIM_DT)` 个整步 + 一个 `dt_rem = T − n·SIM_DT` 的部分步（`dt_rem > 0` 时）。
  **不得用 `ceil(T/SIM_DT)` 多给时间**（R2-H5 的反例：T=0.475 不能按 0.5 判）。
- 参与者用 `PRECISION_ARRIVE_RADIUS_M`（0.25m）的精确到达模式；普通球员用
  `ARRIVE_RADIUS_M`（1.0m）。判据：`|pos_end − end| ≤ REACH_TOL_M` 且
  `v_end ≤ REACH_SPEED_TOL`。纯函数、零 RNG、可单测。
- **修复顺序（确定性）**：
  1. **延长时限** `T`（最多到 `T_MAX`，且不得把 pass 速度推出 L2 带）；
  2. **改落点**：沿原方向把落点移入可达集（传球缩短 / 扑救点沿球路前移 / 接触点改到双方
     可达集交点）；事件字段写**改后**的值；
  3. **失败**：置 `highlight_infeasible`，不发射结果、不产生伪合法轨迹。
- **禁止**：先固定事件结果（`x2/y2` / `subject_end` / `loose`）再让参与者瞬移凑终态。

**finalize（R2-H5）**：

- finalize 边界 = **第一个 ≥ `t_end` 的 0.1s 网格 sim step**；事件的 `t` = 该边界，
  事件内部锚点终点仍是真实 `t_end`。该边界上 `st.pos` = **连续积分结果**（含分离）。
- **取消「≤ `V_MAX·SIM_DT` 的位置投影算连续」**：只有 D2.3 的合法断点（kickoff / 死球重开 /
  进球回中圈 / 罚下 / 终场）允许位置跳变；其他 finalize 跳变一律失败。
- `t_end` 与 finalize 边界之间最多差一个 sim step：事件锚点（`t_end`）与 mover 端点在
  `REACH_TOL_M` 内；这段差是**采样网格**，不是瞬移，必须由断言显式允许并记录。
  该上界由可达性条件保证：`v_end ≤ REACH_SPEED_TOL=0.5 m/s`，一个 0.1s sim step 的额外
  位移 ≤ 0.05m < 0.25m。
- 若 `t_end` 不在段边界：事件锚点用**该段起点的分离结果 + 积分到 `t_end`** 计算；
  finalize 边界状态是该段末再施加分离的连续结果；两者差由 `REACH_TOL_M` 覆盖。

**射门 save 的几何否决（R2-M3）**：

- 只在**固定球路**内处理：不得把原本 `off_target` 的 shot 改成 goal；只处理「原结果 = save
  （含 save-caught/rebound）」且扑救点不可达的情形。
- 结果改为 goal 的统计必须给三个分母：全部 shot、原 save 结果、**尝试修复的 save**；
  逐 seed 计数，并挂 L1「射门结果分布」既有红的**非恶化门**（不要求本 change 修旧红，
  但不得让旧红显著恶化）。
- 若否决率 > **原 save 结果的 2%**，停止并另立射门/扑救概率标定 change；不得在本 change
  内静默改概率。该行为列入 D1.2 与批准范围。

**两路验证（R2-H5）**：

- **内部间距**：每个段边界 `st.pos`（含分离）== 发出的 mover 端点；同队间距 ≥ 2.2m。
- **显示间距**：viewer 按 `movers` 端点插值后的 `player_overlap` detector findings = 0。
- **子步速度**：每个 `SIM_DT` 断言 `|Δv_total| ≤ A_MAX·SIM_DT`（D4.4 第 7 步）。
- **5Hz 输出**：每个段端点断言 `|to−from| ≤ speed×beat.dt +` 分离余量，且 `to` 等于同一
  时刻 `st.pos`。不以视觉平滑替代运动约束。

## D6 Viewer

### D6.1 配置拆分（H3）

`viewer/config.js` 的 `interpretation.tickSeconds` 拆成**三个语义键 + 一个旧流回退键**
（旧键删除，不留双写）：

| 键 | 值 | 用途 |
|---|---:|---|
| `beatSeconds` | **0.2** | 新流的名义 beat 段长（有 `beat.dt` 时以 `dt` 为准） |
| `legacyBeatSeconds` | **0.5** | **旧 v11 流**（beat 无 `dt`）的段长；不是 0.2 |
| `tackleSeconds` | **0.5** | tackle 高亮时长（= `DECISION_DT`），**不跟 beat** |
| `highlightSeconds` | **0.5** | 仅在 pass/shot 既无距离也无速度时的兜底；正常走事件时长 |

**旧流选择机制（R2-M1）**：不靠全局配置同时兼容两种节拍。`buildTimeline` 读事件流的
**第一条 beat**：有 `dt` → 新流（逐条用 `dt`）；无 `dt` → 旧流（整条流用
`legacyBeatSeconds=0.5`，并打一条 warning）；同一条流里 `dt` 时有时无 → **报错**。
第一阶段**不支持**旧流在 0.2/0.5 之间逐段混用。

**逐点归属**（`viewer/interpretation.js`）：

| 行 | 现用途 | 新归属 |
|---:|---|---|
| 186 | `approachDur ≤ 0.6 × tickSeconds` | `0.6 × tackleSeconds`（= 0.3s） |
| 192 | 接触点 `≤ t0 + tickSeconds − 0.05` | `t0 + tackleSeconds − 0.05` |
| 219 | tackle 高亮终点 `t0 + tickSeconds` | `t0 + tackleSeconds` |
| 304 | beat 铺满 `t0 + tickSeconds` | `t0 + (e.dt ?? 流级段长)`；新流用 `dt`，旧流用 `legacyBeatSeconds` |
| 350 | `highlightEndTime(tackle) = e.t + tickSeconds` | `e.t + tackleSeconds` |
| 348–353 | pass/shot 终点 | 事件 `distance/speed`；缺失才用 `highlightSeconds` |

`viewer/game.js` 的 `_highlightEnd` / `_activeHighlightIndex` 仍从事件锚点推导，不直接读
`beatSeconds`；只需保证 `interpretTackle` 写出的锚点终点 = `t0+tackleSeconds`。

**0.5s tackle 跨 3 个 beat 的时间线验证**（t=10.0，tackleSeconds=0.5）：

| t | 段 | 事件/状态 |
|---:|---|---|
| 9.9 | [9.9,10.0) | tackle 前的最后一段 |
| 10.0 | [10.0,10.1) | tackle 事件（先）+ beat；双方在 `movers`（`action:"highlight"`）；球由事件锚点驱动 |
| 10.1 | [10.1,10.3) | 双方继续在 movers；球仍在事件轨迹上 |
| 10.3 | [10.3,10.5) | 双方继续在 movers；球到 loose 点前 |
| 10.5 | [10.5,10.7) | finalize：连续积分终点；新状态首段 `ball` 接力（即使零位移也发）；拾球者进入 movers |

高亮 [10.0,10.5] 覆盖 3 个段；若误用 `beatSeconds=0.2`，tackle 会在 10.2 结束，松散球提前
0.3s 出现——D9 的 viewer 断言必须钉住这 3 段。

### D6.2 稀疏状态与 seek/重建（H2）

- `buildTimeline` 对缺失的 `main`/`ball` **不补锚点**；插值器按 `_interpolateAnchors` 的
  `prev` 锚点保持（`viewer/game.js:517`–`:530`）。这与 D5.1 的「零位移段省略」一一对应。
- `currentCarrier()` 改为向后扫描到最近的 `beat.main`，遇到 `pass/shot/tackle/out/whistle/foul`
  停止；缓存结果（按 beat 索引）。
- 随机 seek：球向前找最近的主状态来源（高亮期间用事件锚点，否则 `main`/`ball`/beat）；
  球员（含高亮参与者）用最近 mover / main 端点。高亮结束后球从事件终点续接，
  不得跳回高亮前的 `main`。
- **新状态首锚点**：稳定静止段的 seek 回扫必须命中该状态首段强制发出的 `main`/`ball`
  （D5.1），不得回退到旧状态；三类 trace（D/E/F）各有一条属性断言。
- 旧流（beat 无 `dt`）按 D6.1 的**流级选择**用 `legacyBeatSeconds=0.5`（不是 0.2 回退）；
  新流逐条用 `dt`；混用直接报错。旧流兼容只在第一阶段保留，加 warning。

### D6.3 插值规则

- **只插值同一轨迹**：同一实体、同一 `evt` 或跨段连续的相邻锚点；不跨事件类型合成。
- 高亮参与者由 `movers` 端点驱动（与其他球员同一条线）；球由事件锚点驱动。
  事件锚点只用于 `t_end` 的对账，不再拿来合成参与者直线（R2-H5）。
- `t_end` 不在段边界时，球在段内按事件锚点渲染；参与者按 mover 端点在网格上采样。
- **Catmull/T1 默认关闭**：保留代码，`interpolation.smooth=false` / `PLAYER_TEXTURE.ampM=0`
  为默认；视觉验收后再单独决定是否开启。引擎的运动已经连续，viewer 不应叠加第二套运动。
- 缓存版本号：`viewer/index.html` 的 `app.js?v=` 与 app.js 的 import specifier 必须同步 bump
  （CLAUDE.md §4）。

## D7 测试、golden、L1 与守卫

### D7.1 先量后改

- 改动前：`node tools/ratchet.mjs save openspec/changes/p1-motion-integration/notes/ratchet-before.json`。
- 改动后：`node tools/ratchet.mjs diff ...`，有退化 exit 1。
- 预注册指标：条件 `turn120`（`turnsPerPlayer`，**24s/121 帧**，不除窗长）、`staticFrac`、
  速度 p50/p90/p99、加速度尾部（p99 `|Δv_total|/SIM_DT`，排除合法重置；报告/软目标）、
  路径长度、路径效率/回环率、低速转向、残余漂移、ballStatic（标 viewer 链 caveat）。
- 训练/留出 seed 与真实窗分开（D9.1）；条件 `turn120` 用 `tools/visual-review/motion-census.mjs`
  的 frozen 口径。

### D7.2 L1 / 守卫

- **权威 L1 基线必须实测**：Phase 0 在 main 同配置跑 200 场，落盘
  `notes/l1-baseline-main.json`，记录 `source_commit`、`engineFingerprint`（wasm+`lib.rs`）、
  seed 列表、每条带的读数与红清单。**「当前已知 4 红」是历史转述，不是权威**（D9.1）。
- **已有红 vs 新增破带（R2-H6）**：把基线红分成两类，处置不同——
  - **已有真实机制红**（如射门结果分布、home/away 等，标注机制与归属 change）：本 change
    **允许保留**，但必须过**预注册的非恶化门**（逐 seed 配对，指标不得恶化超过预注册边界；
    具体边界在 Phase 0 由基线读数与机制归属确定后写死）。**不强迫本 change 修所有旧红**。
  - **新增破带**（基线在带内、C1 后出带）：**失败**，停止并定位；不得用「这是旧红」解释。
  - 两者都 SHALL NOT 放宽真实带；角球带按 D11 #4 重锚是唯一例外（Phase 0 证据化）。
- 角球带：D11 #4 已定**重锚到真实锚 ~10.27**，保留单场 max 护栏；不降级为报告项、不删门
  （Phase 0 完成具体置信带与单场 max 的证据）。
- `p53/p31/p6/p32`：改成「显式构造场景 + 条件断言 + 多 seed 置信范围」的夹具，保留契约；
  Phase 0 前置。
- `p16` / `p124`：按 D2.4（tick=decision，A 案定死）。
- `l2_cross_event_invariants` 的 beat gap 断言**按路径/边界类型**判定，不写死单一集合：
  - 开放比赛/重开准备：`dt ∈ {0.1, 0.2}`（0.1 = 切段，0.2 = 名义）；
  - 死球窗口：**相邻已发 beat** 的 gap ≤ 2.0s（窗口内可跳过名义边界）；
  - 终场末段：`0 < dt ≤ 0.2` 且 `t+dt = dur`；
  - **0.4 不属于开放比赛合法 gap**；不得用 `{BEAT_DT, 2×BEAT_DT, …}` 的不分场景常量集合
    代替协议（那会把 0.4 假绿）。
  - `realism.rs:453` 的 `ok_step` 同样按上述路径/边界类型派生，**不得**再用
    `(dt−TICK)||(dt−2×TICK)` 的假绿写法。
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
| spacing-sweep | #170 旧值 10m49s（1Hz/v9，不可比） | anchors 正常 ≈3×、事件密集上界 ≈5× v11；按实测 | 移 nightly；PR 只跑 1 seed 烟测 |
| JSON 体积（同 seed） | 以 v11 字节数为分母 | **正常 ≤3.0×，事件密集上界 ≤5.0×**（6–10 段/s；`dt` 每段一个数；解析成本同量级）；这是**需实测的预算**，不是段数保证的事实 | 超限：压缩静止段/重复字段/编码，**不得省略移动段的 main/ball**（那是语义丢失，不是优化）；不新增随机 |
| viewer 5min 加载 | 待实测（`buildGameIndex` 是主成本） | ≤2× v11 加载时间；目标 ≤1 s | 超限：索引缓存 / 分块 |
| viewer 90min 加载 | 待实测 | 目标 ≤10 s、峰值内存 ≤2× v11 | 超限：分块 / 只索引高亮邻近窗 |
| seek | 待实测 | ≤50 ms | 超限：二分索引已存在，查锚点数组 |
| 帧耗时 | 待实测 | ≤16 ms（60fps） | 超限：关闭 T1/Catmull（默认已关） |

**前视规划成本（R4-M1，单列，不被上表覆盖）**：上表按「运动子步 5×/decision、快照/决策
不变」估算，**未计** 22 人 × 最长约 12.5s 的 `CommittedPlan` 影子规划、候选拒绝/重试、
分离 solver 与轨迹/状态/RNG 缓存。下表是必须实测的预算（首个 smoke 专测；未实测前不得
声称已覆盖）：

| 规划量 | 预算/门 | 超限处置 |
|---|---|---|
| 规划次数/场 | 每个高亮候选 1 次；follow-on 链 ≤3 | 超限：减少候选/合并，不得回退「先写锚点再推」 |
| 平均视野 | ≤1.0s（典型 pass/shot） | 超限：优化缓存/提前终止不必要候选 |
| 最大视野 | ≤ `PLAN_HORIZON`（约 12.5s） | 超限：拒绝该候选或调整落点/时间 |
| 候选拒绝率 / 重试 | ≤5% / 每候选 ≤2 次 | 超限：停止设计并定位，不得静默放宽 |
| 计划缓存内存 | ≤64MB（22 人 × 边界 × 链） | 超限：分块/只缓存必要字段 |
| 计划执行复用率 | ≥95%（缓存状态被实际执行的比例） | 过低说明规划浪费，需修正候选策略 |
| 计划相关测试时长 | 默认套件 ≤45 min / nightly ≤90 min | 超限：分片到 nightly，但 smoke 必须保留 |

首个实现实验只跑 1 seed smoke，先测上表与运动成本，确认后才铺全量（#170 的「先量后改」）。
超预算只能优化缓存/算法、调整未提交候选或停止设计；**SHALL NOT** 回退到「先写锚点再让
分离推位置」，也 **SHALL NOT** 把全部验证移 nightly 来掩盖规划不可用。

## D8 Spec delta 清单（H4：设计批准前已补全）

正式 delta 已写入本 change 的 `specs/**`，**不是**只列行号/条款描述。清单：

| 文件 | 类型 | Requirement（精确头名） | Scenario 数 | 关键修改 |
|---|---|---|---:|---|
| `specs/event-stream-protocol/spec.md` | ADDED | `beat 段与切段` | 6 | 段起点/段长/首拍/切段/同刻排序/跨表示连续/重开判定段例外 |
| 同上 | ADDED | `非网格状态转移` | 1 | 状态转移只在 0.1s 网格确认；不新增非终场短 dt |
| 同上 | ADDED | `beat 的死球与终场边界` | 3 | 相邻已发 beat gap ≤2.0s、终场不产 beat、末段短 dt |
| 同上 | ADDED | `稀疏 main/ball 的携带` | 3 | 非零位移每段携带、稳定静止省略、新状态首段必发 |
| 同上 | ADDED | `高亮与重开驱动状态` | 1 | 高亮期禁 main/ball、事件=首锚点、结束后首段必发 |
| 同上 | ADDED | `新状态首段与状态失效` | 4 | 状态键、失效事件配对、高亮首锚点、seek |
| 同上 | MODIFIED | `beat 节拍事件字段` | 4（全保留） | 1s tick → 段（0.1/0.2）；`dt`；main/ball 携带规则；参与者进 movers |
| 同上 | MODIFIED | `重开准备期球锚点` | 1（保留） | dead-zone 措辞删除；准备期首段静态锚点 |
| `specs/match-engine/spec.md` | ADDED | `确定性单步运动积分` | 5 | 起步/制动/反向/降速/狭窄冲突 |
| 同上 | ADDED | `向量速度与位置提交` | 1 | vel 向量权威；pos += vel·dt；恢复 speed/heading |
| 同上 | ADDED | `总向量加速度预算` | 1 | A_MAX 总预算（含分离） |
| 同上 | ADDED | `米制边界与边界重置` | 1 | pos_m [0,105]×[0,68]；边界清零重查预算 |
| 同上 | ADDED | `到达与制动语义` | 2 | 删除 dead-zone 整拍冻结；普通/精确到达分离 |
| 同上 | ADDED | `高亮参与者与统一运动状态` | 3 | 同一积分器、不冻结、进入 movers、事件锚点=积分终点 |
| 同上 | ADDED | `事件提交协议` | 1 | 候选意图→含分离前视计划→原子提交→执行核对 |
| 同上 | ADDED | `CommittedPlan 执行` | 4 | 首段同迭代接管、覆盖内只消费缓存、拒绝重试、链上限 |
| 同上 | ADDED | `P_end 与终场交接` | 4 | P_end decision 归 live/cp_end 在前；dur<P_end 终场截段；末端交还；follow-on 无重叠 |
| 同上 | ADDED | `高亮参与者的可达性检查与修复` | 6 | 真实 T、改落点、门将、抢断、重开、finalize 连续 |
| 同上 | ADDED | `段边界执行顺序` | 4 | 顺序合同、决策/事件先于 beat、非网格落地、终场排空 |
| 同上 | ADDED | `计划覆盖边界的执行` | 1 | 计划覆盖内只消费缓存、不 decision/不掷骰 |
| 同上 | MODIFIED | `事件流过程真实性不变量（L2）` | 8（全保留） | beat gap 从段边界推导；速度带与填拍守卫 |
| 同上 | MODIFIED | `同队球员间距（≥2m）` | 9（全保留） | 段边界；位移 ≤ speed×beat.dt；分离不绕过加速度 |
| 同上 | MODIFIED | `球相关队形目标` | 5（全保留） | 防橡皮筋去 dead-zone；门将条款去 `DEAD_ZONE_METERS` |
| 同上 | MODIFIED | `控球阶段与攻防转换` | 6（全保留） | tackle 高亮 [T,T+0.5)；save 首个 decision 边界 |
| `specs/pitch-viewer/spec.md` | ADDED | `播放段与插值合同` | 4 | beat.dt、参与者用 mover/球用事件锚点、T1/Catmull 默认关、tackle 跨 3 段 |
| 同上 | ADDED | `稀疏状态与 seek 重建` | 1 | 稳定静止保持、新状态首锚点、seek |
| 同上 | ADDED | `旧流段长选择` | 1 | 旧流 0.5 / 新流 dt / 混用报错 |
| 同上 | MODIFIED | `事件演绎遵循剧本` | 6（全保留） | 新流人物用 movers、事件锚点只驱动球；旧流保留五段式兼容 |
| 同上 | MODIFIED | `静止球员 micro-motion` | 4（全保留） | C1 第一阶段默认关闭 T1；高亮事件统一「事件先、beat 后」 |
| 同上 | MODIFIED | `演绎节奏配置化（S4 边界明确）` | 2（全保留） | beatSeconds / legacyBeatSeconds / tackleSeconds / highlightSeconds |

**自检清单（机械检查，见 D8.1）**

- [x] 每个 MODIFIED 头名与主 spec 逐字一致；
- [x] 每个 MODIFIED 复制了主 spec 的**全部** scenario（数量见上表）；
- [x] 同一 requirement 的多处修改已合并为一次 MODIFIED；
- [x] 无关 scenario 原样保留；
- [x] 无「与新增条款同义但反向」的 SHALL 残留（重点：dead-zone、每 tick main、1s beat、
  participants 隐藏、tackle beat 先、ceil 可达性、3× 固定事实、高亮期 main/ball 冲突、
  事件锚点事后覆盖、旧 viewer 五段式未迁移）；
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
| 条件 `turn120`（**turnsPerPlayer**） | **`conditional['0.5'].turnsPerPlayer`（Change 0 原口径）**：**24s 窗、5Hz=121 帧**；只计双方步速 ≥0.5 m/s 的相邻步；`turns = 每球员转角 >120° 的次数之和`；`nPlayers = 窗内至少有一个连续步的球员数`（`motion-census` 的 `perPlayer.length`）；**逐窗求 `turns/nPlayers` 再聚合，不再除窗长**；0.829/0.0104 可直接比较 | Change 0 frozen 24 窗 + 真实 2 场 Metrica | frozen 24 窗 = **公开回归集**（已看过，不算留出）；引擎 seed 1–160 调参、321–440 留出 | 最小有意义：**turnsPerPlayer** 相对 v11 基线降低 ≥50%，配对差 95% CI 下界 >0；目标：留出 ≤3× 真实 **0.0104（次数锚，不是百分比）** | 按 seed/源比赛聚类的 bootstrap（10k），95% 百分位；配对差 | 留出不改善 → 回退 C1；只在训练 seed 改善 → 判失败（#170 审查闭环的「只靠训练 seed」） |
| `turnsPerEffectivePair`（**报告项**） | `turns / effectivePairs`（Change 0 的 0.0000934 口径），同一 24s/121 帧窗；**独立报告，不与 0.0104 混用** | 同上 | 同上 | 只报告，不作门；不得用占比改善冒充 `turnsPerPlayer` 改善；若要每秒率或 12s 窗，须单列新指标并同窗重算 base/real | 同上 | 报告 |
| `staticFrac` | 步速 <0.5 m/s 的球员步占比；frozen 口径 | 同上 | 同上 | 最小：相对降低 ≥30%；目标 ≤2× 真实 0.040 | 同上 | 若靠 0.5–1 m/s 漂移降低 → 由 D9.2 审计否决 |
| 速度谱 | p50/p90/p99（m/s），逐场算再平均（不跨场拼接） | 同上 | 同上 | 不退化：各分位 ≤ v11 +10% 或落在真实带内 | 同上 | 退化 → 回退 |
| 加速度尾部（**报告 + 软目标**） | p99 `|Δv_total|/SIM_DT`（m/s²），**排除合法速度重置**（kickoff / 死球重开 / save-caught / 进球回中圈 / `boundary_reset`）；**经验目标，不是物理硬门** | 同上 | 同上 | 软目标 ≤ `A_MAX + 10%`（8.8 m/s²）；与 D4.4 的**每子步物理硬门** `|Δv_total| ≤ A_MAX·SIM_DT`（A_MAX=8.0）区分；不得靠瞬时折角刷高 | 同上 | 超软目标 → 报告并定位，不直接判失败；违反每子步 A_MAX 才是硬失败 |
| 路径效率 / 回环 | 5s 窗内净位移 / 路径长度；回环率 = 效率 <0.5 的窗占比 | 同上 | 同上 | 不恶化：效率不低于 v11 −5%，回环率不高于 v11 +5pp | 同上 | 恶化 → 失败（防「大回环」） |
| 低速转向 | 同一 **turnsPerPlayer** 口径（24s/121 帧，不除窗长），只计步速 ∈ [0.5,1.5] m/s 的步 | 同上 | 同上 | 不高于 v11；且 `jitterRatio`（速度 ∈[0.5,1.0] 且 1s 净位移 <0.5m 的占比）不高于真实 + 5pp | 同上 | 超界 → 失败（防微抖刷 staticFrac） |
| 残余漂移 | 到达后 1s 内净位移；`RESIDUAL_SPEED_MAX=0.2` | 同上 | 同上 | 到达目标 1m 内后净位移 ≤0.2m/s | 同上 | 超界 → 失败 |
| L1 体量/分布 | 射门 [14,29]、抢断 [24,50]、传球成功率 [0.82,0.90]、犯规 [16,30]（main spec 现行带） | 200 场，固定 seed 列表（Phase 0 落盘） | 1–200 为门；321–440 为留出 | **已有真实机制红**：允许保留 + 过预注册非恶化门；**新增破带**：失败；角球带按 D11 #4 重锚 | 逐场值 + 200 场均值；不做「挑绿」 | 新增破带 → 停止并定位；不得用「旧红」解释；不得放宽真实带；不强迫本 change 修所有旧红 |
| save→goal 几何否决（R2-M3） | 三个分母：全部 shot、原 save 结果、尝试修复的 save；逐 seed 计数 | 200 场 | 同上 | 只在固定球路内；不得把 off-target 改 goal；否决率 ≤ **原 save 结果的 2%**；L1 射门结果分布**非恶化** | 逐 seed 比率 + cluster bootstrap | 超 2% 或旧红显著恶化 → 停止，另立概率标定 change |
| 球静止 ballStatic | viewer 链读数 | 5min/90min viewer 窗口 | — | **只作报告项，不作门** | 报告 | 不据此判成功/失败 |
| 盲测 | 强制二选一「哪边是真实」；同渲染器、盐/key 隔离、含负控；**预注册等价边 δ=0.15** | 72 clip（48–71 只作筛查）；**真实独立源 = 7 个簇**（Metrica 1 + SkillCorner 6 留出）；其余 clip 是同一批源 × engine seed/window；≥5 裁判 | clip 级划分；留出源比赛不参与调参 | 主判据：**等效性**——准确率 95% CI **完全落入** `[0.5−δ, 0.5+δ] = [0.35,0.65]`；负控估计偏置 | **多向聚类 bootstrap**（source match × engine seed/window）；报告独立真实簇数（7）与有效样本，不报「72 个独立真实源」 | CI 完全落在 0.5 任一侧且超出 `[0.35,0.65]`（含**完全低于 0.5**）= 失败；其他/CI 太宽 = 无结论，按预注册上限扩 engine seed，不伪造真实源独立性 |

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

### D9.3 盲测执行（R2-H6）

- 48–72 项、≥5 名零上下文裁判、同渲染器、盐/key 隔离、含负控。
- **预注册等价边 δ=0.15**；通过 = 准确率 95% CI **完全落入** `[0.35,0.65]`。
  CI 完全落在 0.5 任一侧且超出该区间（**包括完全低于 0.5 的反向可识别**）= 失败；
  其他（CI 跨 0.5 但太宽、或 clip <72）= 无结论，按预注册上限扩 engine seed/window。
  **不以「点估计接近 0.5」或「未拒绝差异」当通过**。
- **样本独立性如实写**：真实留出源只有 **7 个簇**（Metrica 1 + SkillCorner 6），
  72 clip 是同一批源 × engine seed/window 的重复取样；**不承诺 72 个独立真实源**。
  统计用 source match × seed/window 的**多向聚类 bootstrap**，报告独立真实簇数（7）、
  engine seed 数、有效样本与证据等级；CI 太宽时扩 engine seed/window，不伪造真实源独立性。
- **Phase 0 预注册执行设计（R3-M3，先冻结再看结果）**：
  - **配对**：source match × engine seed/window 的配对矩阵；每个 clip 是一个 12s 窗，
    同一窗不得在同一 clip 内重复使用；同一 source match 的所有 clip 聚为一簇。
  - **裁判/重复**：≥5 名零上下文裁判，每名对每个 clip 评一次；顺序平衡；同一裁判不得
    重复评同一 clip。裁判评分按 clip 聚类，不把「clip × 裁判」当独立样本。
  - **bootstrap**：source match × engine seed/window 的**多向聚类 bootstrap**，10k 次，
    95% 百分位；报告独立真实簇数（7）、engine seed 数、有效样本与证据等级。
  - **证据等级**：A = 7 簇、≥140 clip（每簇 ≥20）、CI 半宽 ≤0.15；B = 7 簇、70–139 clip、
    CI 半宽 ≤0.20；C = <70 clip 或 CI 半宽 >0.20 → **无结论**。
  - **扩样上限**：最多 7 簇 × 20 seed/window = 140 clip；到上限仍为 C 就报告无结论，
    SHALL NOT 继续加同一个真实源的重复窗来「凑显著」，也 SHALL NOT 声称 72 个独立真实源。
  - **7 真实簇是下限**：若 Phase 0 发现更多独立留出比赛，只能**新增簇**，不得把同一场
    切成多个「独立源」。
  - **旧红非恶化边界的来源（R4-M3，先冻结）**：在候选运动调参**之前**，对每个既有红
    逐指标定义边界，**不得用未来候选配对差**（同 seed 重复差恒 0，未来候选差又违反先冻结）。
    边界 SHALL 取以下三者之一/其组合，并落盘 `notes/l1-baseline-main.json`：
    ① **base 逐 seed 分布的采样不确定度**（200 场 seed 级 bootstrap 95% CI 半宽）；
    ② **独立预注册扰动/重复块**（如 seed 重排/窗口重切）测得的波动；
    ③ **领域容忍幅度**（预先声明的业务可接受恶化）。
    默认 `boundary = max(①, ③)`；②用于验证 ① 不低估。
  - **单位存储合同（R5-M2）**：**JSON 存 0–1 比例，粒度 0.001；展示为 0.1pp**。
    比较/阈值计算全部在 0–1 存储单位里做，**不得**把 0.001 当 pp 或把 pp 当比例直接相加
    （那会差 100 倍）。例：`base=0.85`、`boundary=0.001`（=0.1pp）；若指标上升为恶化，
    恶化侧阈值 = `0.851`；若下降为恶化，阈值 = `0.849`。
  - **取整方式（R5-M2）**：边界值按**向恶化侧 ceiling 到 0.001 网格**（保守、更宽的
    非恶化门），不做四舍五入到 1；计数类存**每场次数**，ceiling 到 **0.1/场**。
    展示层只做 `×100` 转 pp，不改变存储值。
  - 候选侧只做**单向非恶化**检验（上升为恶化的指标：候选 ≤ `base + boundary`；下降为
    恶化的指标：候选 ≥ `base − boundary`），不做“候选 vs 未来自己”的配对。
  - **盲测到上限仍无结论**：7 簇 × 20 = 140 clip 上限到达后，若 CI 仍未**完全落入**
    `[0.35,0.65]`，一律报告**无结论**，不因证据等级叫 A/B 而改判。
- 有效样本 = **独立真实源簇数 × engine seed/window 结构**，不是「clip 数」也不是
  「clip × 裁判数」；裁判评分按 clip 聚类。

## D10 风险与回退

| 风险 | 表现 | 回退/缓解 |
|---|---|---|
| 惯性追跳变目标 | 大回环、绕圈 | 目标每 decision 拍保持；限制 `ω_max`；路径效率/回环审计；留出窗不改善则回退 |
| 制动增加静止 | `staticFrac` 反而升高 | 到达半径 + `RESIDUAL_SPEED_MAX`；与条件 turn120 联合验收；不允许 0–1 m/s 漂移 |
| 分离 solver 绕过加速度 | 端点被推、速度不一致 | 三层分离（目标/预测/投影）；`constraint_infeasible` 显式红；不能只改端点 |
| 球/人不一致 | 接球者到不了落点、球瞬移 | `reachable()` 前置检查（真实 T + 精确到达）；修复顺序（延长→改落点→失败）；finalize 连续积分无瞬移 |
| 事件率漂移 | 射门/抢断/犯规越带 | 决策仍 2Hz；不新增 RNG；L1 已知红/新增破带分流；概率常量不动，必要时另立标定 change |
| save 否决扩大结果逻辑 | 把 off-target 改 goal / 旧红恶化 | 只在固定球路内；三分母 + 逐 seed + ≤2% 原 save；见 D1.2/D9.1 |
| 5Hz 体积（正常 3×，密集上界 5×） | JSON/内存超预算 | D7.5 预算；压缩静止段/重复字段；**不得省略移动段 main/ball**；不新增随机 |
| viewer 双运动 | 引擎连续 + T1/Catmull 叠加 | 第一阶段默认关闭；视觉验收后再单独决定 |
| 研究门红 | p15/p16/p18/p17a/p17b/p124 固定 seed 失效 | 换样本不换判据；Phase 0 先做不变量化夹具；产物门用显式 `--ignored` 重跑 |
| 基线数据缺失 | `benchmark-baseline` 生成失败 | Phase 0 先确认数据身份/离线可用；缺数据则停在 Phase 0（D7.4） |

## D11 决策记录（用户已拍板，2026-11-21）

用户决定：**六项全部按推荐**。以下不再是开放项；后续审阅/实现不得把它们重新当成待定。

| # | 决策 | 已定值 |
|---|---|---|
| 1 | 决策 cadence | **保持 2Hz**（`DECISION_DT=0.5`），不回 #170 的 1Hz |
| 2 | beat cadence | **5Hz 名义**（`BEAT_DT=0.2`），决策/事件切段后正常 6 段/s、事件密集上界 10 段/s（D2.3；3× 是预算，不是事实） |
| 3 | 协议字段 | **第一阶段只发端点**（`from/to/speed/action`），不加 `vx/vy/heading`；`dt` 是段长时序字段，不算运动矢量 |
| 4 | 角球带 | **重锚到真实锚 ~10.27**，保留单场 max 护栏；不降级为报告项、不删门 |
| 5 | 守卫不变量化 | **作为本 change 的 Phase 0**（p53/p31/p6/p32 替换夹具，保留契约） |
| 6 | C1 范围 | **只做运动执行**；C2/C3/C4/C5 不在本 change |

## D12 批准记录

- **2026-11-21**：用户在会话中拍板 D11 六项全按推荐。
- **2026-11-21**：gpt-6.1-sol 零上下文审阅 loop（Round 1–6）。
  **Round 6 = 0 High / 3 Medium / 1 Low，可批准**；报告见
  `notes/review-gpt61-2026-11-21.md` 的 `## Round 6`。
  - 已知非阻塞残余：R6-M1 1.7 接续对账表把非 decision 点写成 decision/snapshot；
    R6-M2 重试成功场景缺少能改变可行性的确定性 attempt 序列；
    R6-M3 RNG 三路守卫未区分 live 冻结对象与影子游标；
    R6-L1 D5.4/tasks 摘要仍用 `P_end` 描述有效覆盖/交还。
    以上不改变 High=0 的调度合同，进 Phase 0/实现时收紧。
- design 正式批准（#170 评论「design 批准」或 PR approve）：_待填_。
- 批准范围：C1 运动执行 + Phase 0 守卫/角球前置；**含 D1.2 的两处可见行为差异**
  （save 几何否决、参与者进入 `movers`）；不含 C2–C5。
