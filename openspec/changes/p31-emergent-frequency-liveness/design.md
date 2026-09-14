# Design: 删槽位 + 涌现频率 + liveness guard（#25 阶段 3）

## Context

#25 收官。4 决策已 grill 定稿（全选 codex 推荐 A）。删槽位后，频率完全由状态涌现 + 非事件型 liveness guard 防塌缩。

**D2/D3 于实施期修订（2026-09-14，用户二次拍板）**：原 D2（纯落点误差产出界）与原 D3（三层护栏只调参）
在真实引擎上实测**结构上不成立**（证据见 `.p31-progress.md`「待用户拍板」节）：
意图落点从不进入距边界 5m 内（n=44635 实测 p05 已是 14.7m/20.3m），纯误差够不着边界；
三层护栏只让 carrier 更快地重复「继续带球」，停滞上限实测 3600s。两处均按用户拍板改路（见下）。

## Goals / Non-Goals

**Goals:**
- 删槽位层，比赛完全由自然 deadline 驱动。
- 出界有自然来源（角球/界外球/门球），且来源由 `pass_risk` 调制（非槽位硬造）。
- liveness guard 三层递进，只改行为状态（含 carrier 决策），不直接造事件。
- 5 分钟统计方向性护栏 + 90 分钟带重新校准。

**Non-Goals:**
- 不改事件协议（out 字段 P27 已铺）、不改 viewer。
- 不做球员属性/战术（#04/#11）。

## Decisions

### D1: 删槽位层（用户拍板）

删 `HIGHLIGHTS_PER_MATCH` / `SLOT_HOLD_MIN_TICKS` / `SLOT_AVG_EVENT_TICKS` / `slot_hold_max` / `slot_clock` / `slot_interval` / `roll_fallback_situation` / `FallbackSituation` / `OpportunityTrigger::FallbackDeadline` / `OpportunityReason::SlotFallback` / `emit_pass_out_play_slot` / `PASS_BREAK_TICKS`。tick 开放比赛分支改为：自然 deadline 到期 → 评估持球/防守 → 结算；否则产 beat。

### D2: 出界 = `pass_risk` 调制出界通道（用户二次拍板，采纳 grill Q2 选项 B）

**修订理由（实测）**：纯落点误差产不出出界——`lead_point` 在最远 0.9 处插值于传球者与
**最近队友**之间，而队友按 `formation_target` 站位，意图落点被结构性地锁在场中央：
200 场 44635 条有向传球实测距底线 p05=14.7m / 距边线 p05=20.3m，**无一落在 5m 内**。
把 σ 放大到够得着边界会让每次传球都出界（比赛退化为「传球即出界」）。故出界的**触发**
改由 `pass_risk` 调制的通道承担（grill Q2 当时被 codex 以「两张皮」否决，实测证明它是正确解）。

- 纯函数 `sample_pass_landing(from, intended, pass_risk, rng) -> PassLanding` **保留**（`raw` 带确定性
  误差、`projected = clamp01(raw)`、误差越界即 `out_side`）——它仍负责**落点位置**，并在误差足够大时
  自然越界（该分支保留为正确但罕见）。
- 新增纯函数 `open_play_out_probability(pass_risk) -> f64`（`base + gain * pass_risk`，钳到 [0,1]）
  与 `out_side_for_intended(home, intended, rng) -> OutSide`：**出界触发** = 该通道命中。
- 出界落点 = 意图落点沿该轴推过边界（overshoot 由 RNG 给定），`out_pos` 记真实越界值、
  `x2/y2` 记场内投影（viewer 渲染用）。
- 重开映射（纯函数 `out_restart_for(source, side, own_goal_line)`）：
  - `NormalPass + goal_line + **己方**底线 → Corner`（回传/解围越过自家底线 → 角球）
  - `NormalPass + goal_line + **对方**底线 → GoalKick`（进攻传球越过对方底线 → 门球）
  - 任意 `source + sideline → ThrowIn`
  - `Clearance + goal_line → Corner`（解围只能越过自家底线）
  **实施期修正**：初版把 `NormalPass + goal_line` 一律判门球，遗漏了「越过自家底线」这一半
  （己方底线出界在真实规则里是角球）。新增 `own_goal_line` 分量修复。
- 删 `PassOutSource::CornerDirect`（角球不再由槽位制造）。
- 只允许开放比赛普通传球走出界通道（发球重开/角球/界外球/任意球/门球/头球 battle **不**走）。

### D3: liveness guard 三层递进（用户二次拍板：补「无压久持 → 出球」决策档）

**修订理由（实测）**：原设计的三处接入（deadline 缩短 / 前插倾向 / 传球风险）都只让 carrier
**更快地重复同一个「继续带球」决定**，在「无人逼抢 + 射门推进 hazard 未命中」这一态下没有任何
一条能产出事件——实测 `ticks_since_meaningful_action` 全场上限达 **3600s**。故补一档**决策**：

- `MatchState` 增 `ticks_since_meaningful_action: u32`。
- 三档常量：`LIVENESS_STAGE_1_TICKS=8` / `STAGE_2=12` / `STAGE_3=16`。
- `liveness_profile(ticks) -> LivenessProfile { forward_intent_bonus, pass_risk_bonus, deadline_pressure_ticks }`。
- **接入四处**（前三处调参、第四处改决策）：
  1. `action_deadline_for`（`deadline = base - deadline_pressure_ticks`）；
  2. `carrier_move` 前插倾向；
  3. `open_play_pass_risk`（含 `pass_risk_bonus`，并驱动 D2 的出界通道）；
  4. **`evaluate_open_play_carrier_action`：停滞达 `LIVENESS_STAGE_2_TICKS` 且无压 → 强制选择
     「出球」候选（普通传球）**。guard 本身仍**不 emit 任何事件**；它只改 `ticks_since_meaningful_action`
     这一状态，carrier 决策**因该状态变化而选择出球**——事件仍由既有 `emit_pass_highlight_inner` 产。
- meaningful action = 射门/成功传球/拦截/抢断/犯规/球权变化/出界重开/松散球拾取；普通 beat、contain/jockey、单纯跑位**不重置**。

### D4: 5 分钟统计方向性（用户拍板）

- 删「5分钟≥90分钟 53%」槽位式断言。
- 5 分钟用 `L1_5MIN_SEEDS=1000` cohort：累计射门>0、重开(角球+界外球+门球)>0、犯规宽带、进球≥0。
- 90 分钟带保留，阶段 3 后重新离线校准（删槽位改变 RNG 序列 + 机会数量 + 出界机制）。

### D5: golden v5

- 新目录 `golden-v5`，v1/v2/v3/v4 保留。
- 频率断言全改方向性。

### D6: 抢断频率接受涌现新值 + 带重标定（用户二次拍板）

**实施期的措辞更正（2026-09-14，审阅发现）**：本节最初按拍板时点的**中间态**测量写为
「抢断降至 ~2.6/场」，但那是「仅删槽位、尚未接入 liveness 出球档与犯规基线重标定」的中间值。
**最终引擎实测抢断 9.40/场（200 seed×90min），比 P30 基线的 5.60 上升 68%**，不是下降。
原因（变异实验定位，非推测）：主因是 **D3 的第四处接入**（无压久持 → 出球档）——
把该档关闭（只此一处改动）后抢断回落到 **4.47/场**（接近基线 5.6），说明它贡献了增量中的 ~4.9/场。
机制：该档让 carrier 在无压停滞时也**承诺传球动作**（pass 候选 219 → 404/场），
「carrier 承诺 → 防守竞争评估并可能判为抢断」这条通路的触发次数随之近乎翻倍。
次要因素：犯规基线 0.05 → -0.10（犯规 36 → 23/场）使部分机会点由犯规改选抢断。
两处都是本 change 的**有意设计**（用户拍板采纳），非参数意外。
结论不变：**不给防守竞争补新的强制来源**，接受涌现新值并重标定 `shot/tackle` 带
（实测 7.85/9.40 = 0.835，带 [1.0,1.8] → [0.5,1.5]）。同一原则适用于删源后其余频带
（如角球——原 12% 槽位来源被删，实测 3.71 → 2.00，带 [2,9] → [1.0,7.0]）。

## 验收

- 删槽位后，`roll_fallback_situation`/`FallbackSituation`/`slot_clock`/`slot_interval` 全不存在。
- 出界由 `pass_risk` 调制通道涌现（角球来自 NormalPass+己方底线 / Clearance+底线，
  门球来自 NormalPass+对方底线，界外球来自 sideline），`out_pos` 为真实越界值、`x2/y2` 为场内投影。
- liveness guard 三档递进 + 第四处接入（无压久持 → 出球）：停滞有界、不直接造事件。
- 5 分钟 cohort 方向性护栏通过；90 分钟带重新校准。
- golden v5 重基线，v1-v4 保留且回归绿。
- `./verify.sh` 全绿 + `openspec validate` 通过。
