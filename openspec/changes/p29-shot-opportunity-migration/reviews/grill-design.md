# Grill Design: 阶段 2B 射门机会迁移（shot-opportunity-migration）

> batch-grill-me：敲定 #25 阶段 2B 的设计细节。用户在 Open Questions 全部确认前，不写实现代码。

## 背景（facts，已从代码确认）

- 2A 已合入（P28）：`CarrierAction`/`DefensiveAction`/`ActionResolution` 深模块 + fallback trigger 已就位；自然 deadline 在 2A 内决策中性（结算恒「继续带球」）。
- `ShotSetup { drive_ticks_left, target_dist }`；`advance_shot_setup` 现在「`dist <= target || ticks_left==0` 就到即射」——**这是 2B 要改的点**（改成可被抢断的起脚窗口）。
- `sample_shot_target(rng)` 采样目标距离（禁区 58%/弧 27%/远 15%）；`shot_bucket(dist)` 分桶给射门结果概率。
- 射门现在由 fallback 情境（原 Shot 槽）强制产生；2B 起改成 hazard 打分涌现。
- **2B 是 #25 里第一个改变可观测行为的 change**：射门不再由槽强制，事件流会变、golden 会重基线、频率会变。

## Round 1: 2B 设计树 frontier

### Q1: Shot 提交点（codex 列为必 grill）

`shot_setup` 推进到何时算「已提交、不可被抢断」？

- **A（推荐）起脚窗口 + committed 标志**：推进到射程后不立即射，进入「起脚窗口」（1-2 tick），窗口内 hazard 打分决定射/转/被抢断；一旦 `committed=true` 才产 Shot 事件，此后不可回溯。
- **B 到射程即提交**：保持现状「到即射」，只把「射」从槽强制改成 hazard 决定。简单，但「到射程」和「起脚」之间没有可被抢断的窗口。
- **C 推进全程可抢断**：从开始推进就允许抢断打断，不设 committed。

理由：A 是 codex 建议（「射门推进被抢断」应产「canceled → tackle → loose ball」而非「先 Shot 后 Tackle」）；B 少了「起脚前被断」的真实性；C 过度（推进刚开始就被抢，射门机会难成型）。

### Q2: 射门 hazard 打分公式

- **A（推荐）codex 初始形状**：`score = base_tendency + distance_quality + angle_quality + space_available - defensive_pressure - cooldown_penalty`；`hazard = exp(score)`；`p_shot = 1 - exp(-hazard * window)`。距离用分段（复用 shot_bucket 分桶但不再强制射门）。
- **B 只按距离+压力**：`score = distance_quality - pressure`，砍掉角度/空间/冷却。简单但丢了「角度」和「被防空间」。
- **C 先软一点**：2B 先用「距离 + 压力」两因子，角度/空间/冷却留 2B 后续微调。

理由：A 是 codex 给的完整形状，各分量几何量都有（2A 已算 pressure/escape 等）；B 太简化；C 是折中——但「角度」对射门真实性挺关键（边路不该和正对球门同概率射）。

### Q3: 被抢断时的产出（关键验收）

`shot_setup` 被抢断打断时，事件流产什么？

- **A（推荐）canceled → tackle → loose ball**：射门推进被抢，产 tackle 事件 → 松散球，**不产 Shot**。因果正确。
- **B 先 Shot 后 Tackle**：先产 Shot（表示射门意图）再产 Tackle 打断。因果倒置，codex 明确反对。
- **C 只产 Tackle，不产任何「射门意图」标记**。

理由：A 是 codex 明确要求（「否则事件流仍因果倒置」）；B 是被否掉的；C 是 A 的简化（不产「canceled」标记事件，直接 tackle）。

### Q4: 2B 改变行为 → golden 重基线

2B 起事件流会变（射门涌现、频率变），golden 怎么处理？

- **A（推荐）v3 golden 新基线 + v1/v2 保留**：新目录 `golden-v3`，旧 v1/v2 保留作回归对照。频率断言改成方向性（Shot 不再等于槽数量）。
- **B 沿用 v2 覆盖重基线**：直接 ACCEPT_GOLDEN 覆盖 v2。会丢 v2 的历史对照。
- **C 2B 暂不改频率，保持行为等价**：先只把 hazard 打分「接上但阈值调到等价」，等 2C/阶段3 再真正生效。

理由：A 符合 codex「v2 独立 golden、不覆盖旧基线」+「模型版本迁移」的一贯建议；B 丢历史；C 是「又行为等价一次」——但 2B 的核心价值就是让射门真正涌现，C 等于没做。

## User Confirmation（2026-09-14，batch-grill-me Round 1）

- **Q1 Shot 提交点**：用户答复 **起脚窗口 + committed**（推进到射程 → 1-2 tick 起脚窗口内 hazard 决定射/转/被抢断；`committed=true` 才产 Shot，不可回溯）。
- **Q2 hazard 公式**：用户答复 **完整五因子**（`score = base + distance_quality + angle_quality + space_available - defensive_pressure - cooldown_penalty`；`hazard=exp(score)`；`p=1-exp(-hazard*window)`）。
- **Q3 被抢断产出**：用户答复 **canceled → tackle → loose ball**（不产 Shot，因果正确）。
- **Q4 golden**：用户答复 **v3 新基线保留旧**（`golden-v3` 新目录，v1/v2 保留；频率断言改方向性）。

## Open Questions

无。2B 四个核心决策已收敛，可立项。
