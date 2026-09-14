# Design: 删槽位 + 涌现频率 + liveness guard（#25 阶段 3）

## Context

#25 收官。4 决策已 grill 定稿（全选 codex 推荐 A）。删槽位后，频率完全由状态涌现 + 非事件型 liveness guard 防塌缩。

## Goals / Non-Goals

**Goals:**
- 删槽位层，比赛完全由自然 deadline 驱动。
- 出界由传球落点误差涌现（角球/界外球/门球有自然来源）。
- liveness guard 三层递进，只改行为状态不直接造事件。
- 5 分钟统计方向性护栏 + 90 分钟带重新校准。

**Non-Goals:**
- 不改事件协议（out 字段 P27 已铺）、不改 viewer。
- 不做球员属性/战术（#04/#11）。

## Decisions

### D1: 删槽位层（用户拍板）

删 `HIGHLIGHTS_PER_MATCH` / `SLOT_HOLD_MIN_TICKS` / `SLOT_AVG_EVENT_TICKS` / `slot_hold_max` / `slot_clock` / `slot_interval` / `roll_fallback_situation` / `FallbackSituation` / `OpportunityTrigger::FallbackDeadline` / `OpportunityReason::SlotFallback` / `emit_pass_out_play_slot`。tick 开放比赛分支改为：自然 deadline 到期 → 评估持球/防守 → 结算；否则产 beat。

### D2: 出界涌现 = 落点误差（用户拍板，阶段 3 必要闭环）

- 新增纯函数 `sample_pass_landing(from, intended, pass_risk, rng) -> PassLanding`：`raw = intended + deterministic_seeded_error`（`error_sigma = base_error + risk_gain * pass_risk`），`projected = clamp01(raw)`。
- `raw` 越 x 边界 → goal_line；越 y 边界 → sideline；场内 → 普通传球。
- 重开映射（按最后触球方）：`NormalPass + goal_line → GoalKick`、`NormalPass + sideline → ThrowIn`、`Clearance + goal_line → Corner`、`Clearance + sideline → ThrowIn`。
- 删 `PassOutSource::CornerDirect`（角球不再由槽位制造）。
- 只允许开放比赛普通传球走出界误差（发球重开/角球/界外球/任意球/门球/头球 battle 不走出界）。

### D3: liveness guard 三层递进（用户拍板）

- `MatchState` 增 `ticks_since_meaningful_action: u32`。
- 三档常量：`LIVENESS_STAGE_1_TICKS=8` / `STAGE_2=12` / `STAGE_3=16`。
- `liveness_profile(ticks) -> LivenessProfile { forward_intent_bonus, pass_risk_bonus, deadline_pressure_ticks }`。
- 接入三处：`action_deadline_for`（`deadline = base - deadline_pressure_ticks`）、carrier 前插倾向、`emit_pass_highlight_inner`（`pass_risk` 并含 `pass_risk_bonus`）。
- meaningful action = 射门/成功传球/拦截/抢断/犯规/球权变化/出界重开/松散球拾取；普通 beat、contain/jockey、单纯跑位**不重置**。

### D4: 5 分钟统计方向性（用户拍板）

- 删「5分钟≥90分钟 53%」槽位式断言。
- 5 分钟用 `L1_5MIN_SEEDS=1000` cohort：累计射门>0、重开(角球+界外球+门球)>0、犯规宽带、进球≥0。
- 90 分钟带保留，阶段 3 后重新离线校准（删槽位改变 RNG 序列 + 机会数量 + 出界机制）。

### D5: golden v5

- 新目录 `golden-v5`，v1/v2/v3/v4 保留。
- 频率断言全改方向性。

## 验收

- 删槽位后，`roll_fallback_situation`/`FallbackSituation`/`slot_clock`/`slot_interval` 全不存在。
- 出界由落点误差涌现（角球来自 Clearance+goal_line，门球来自 NormalPass+goal_line，界外球来自 sideline）。
- liveness guard 三层递进：停滞 8/12/16s 逐档加强，不直接造事件。
- 5 分钟 cohort 方向性护栏通过；90 分钟带重新校准。
- golden v5 重基线，v1-v4 保留且回归绿。
- `./verify.sh` 全绿 + `openspec validate` 通过。
