# Design: 射门机会迁移（#25 阶段 2B）

## Context

#25 阶段 2B。4 决策已 grill 定稿（见 reviews/grill-design.md）。2A 的 `CarrierAction::Shoot` 候选在 2A 内结构性不可达（fallback 被逼抢情境恒被 Tackle 压过）；2B 起让 `Shoot` 真正经 hazard 打分涌现。

这是 #25 第一个改变可观测行为的 change：射门由槽强制 → hazard 涌现。

## Goals / Non-Goals

**Goals:**
- 射门由 hazard 五因子打分涌现（非槽强制）。
- `shot_setup` 推进到射程 → 起脚窗口（`committed:false`）→ hazard 决定射/转/被抢断。
- 被抢断产 `canceled → tackle → loose ball`（不产 Shot）。
- golden v3 新基线（v1/v2 保留）。

**Non-Goals:**
- 不做防守接触竞争（2C）、不删槽位（阶段 3）。
- 不改事件协议（shot 字段不变）、不改 viewer。
- 不做射门质量校准（射门结果概率 shot_bucket 保持，仅改「是否起脚」）。

## Decisions

### D1: Shot 提交点 = 起脚窗口 + committed（用户拍板）

- `ShotSetup` 增 `committed: bool`。
- 推进到射程（`dist <= target`）后，**不立即射**，进入起脚窗口（1-2 tick）：每 tick 用 hazard 打分评估射/转（pass/dribble）/被抢断。
- 一旦 hazard 判定射门 → `committed = true` → 产 Shot 事件 → 不可回溯。
- 窗口内若被抢断 → `canceled → tackle → loose ball`。

### D2: hazard 五因子公式（用户拍板）

```rust
score = base_tendency
      + distance_quality      // 距离分段（复用 shot_bucket 分桶，但不再强制射门）
      + angle_quality         // 正对球门中路→高；边路→低；背向→禁止 Shoot 候选
      + space_available       // 最近+第二防守者距离
      - defensive_pressure    // 最近+第二防守者贴近 + 前向通道被挡
      - cooldown_penalty      // 最近射门后冷却

hazard = exp(score)
p_shot = 1 - exp(-hazard * window)   // window = 起脚窗口 tick 数
```

- 距离分段：6-16.5m→0.9-1.0、16.5-25m→0.45-0.9、25-35m→0.05-0.45、>35m→0.0-0.05。
- `angle_quality = clamp01(cos(angle_to_goal_center).max(0.0))`；背向球门 → 禁止 Shoot 候选。
- `space_available = 0.65 * nearest_defender_score + 0.35 * second_defender_score`（≤2m→0、2-8m 线性、≥8m→1）。
- `cooldown_penalty = shot_cooldown_ticks / SHOT_COOLDOWN_TICKS`（局部状态衰减，不读全场射门数）。

### D3: 被抢断产出 = canceled → tackle → loose ball（用户拍板）

- `shot_setup` 推进中或起脚窗口内被抢断：产 tackle 事件 → 松散球，**不产 Shot**。
- 不产任何「射门意图」事件（Q3 选 A，非 C）。

### D4: golden v3（用户拍板）

- 新目录 `engine/tests/golden-v3/`，v1/v2 保留。
- 频率断言改方向性：`Shot` 不再等于 Shot 槽数量；断言「射门在压力低/角度好/距离近时更易发生」的方向，而非固定数量。
- 禁止运行时读「本场已射多少次」（C 路原则）。

## 验收

- 纯决策测试：hazard 各因子方向（近门/正对/无压 → p_shot 高；远射/边路/贴身 → 低）。
- 起脚窗口测试：推进到射程不立即射；committed 后不可回溯；被抢断产 tackle→loose 不产 Shot。
- 频率方向性断言：Shot ≠ 槽数量。
- golden v3 重基线，v1/v2 保留且回归绿。
- `./verify.sh` 全绿 + `openspec validate` 通过。
