## ADDED Requirements

### Requirement: 开放比赛防守方逼近持球者（B4 结构性判据）

引擎 SHALL 在**开放比赛**（非 transition、非死球、非松散球、非重开准备）中，指派
**无球方最近 1 名外场球员**逼近持球者，且该逼近 SHALL 与持球侧的射门路径**解耦**——
防守方逼近不得使射门变为**不可能**，只可使其**概率降低**。

**为什么需要（实跑证据）**：`#18` 的 **B4**（持球时被防守方逼近覆盖的时间占比）引擎实测
**5.81%** vs 真实 **56.09%**。侦察证明：持球拍最近防守者到持球者距离**已接近真实**
（引擎 mean 7.79 m vs 真实 6.01 m），但**只有 6.3% 的持球拍有防守方朝持球者移动**——
防守移动是**队形驱动**（奔向 `formation_target`），不是**对手驱动**。

**压力门形状**：开放比赛的持球决策中，`OPEN_PLAY_PASS_PRESSURE_M` 的判定 SHALL NOT
在射门候选评估**之前**以硬 early-return 排除射门路径。受压持球者 SHALL 仍然掷射门推进
hazard（`open_play_shot_engage_hits`），由 `compute_shot_score` 的连续 `defensive_pressure`
项决定射门启动概率。**门将持球**与 **liveness 停滞**（`stalled_unpressed`）SHALL 保持
出球优先（不受本改动影响）。

理由：`OPEN_PLAY_PASS_PRESSURE_M`（8.0）与 `SHOT_PRESSURE_NEAR_M`（8.0）是**同一个数**；
硬门在打分前 return 使连续压迫项在射门路径可达时**恒为 0**（两者在 8.0 处**恰好互补**），
连续机制**结构性够不着**。形状改动使其够得着。

**常量**：逼抢停距 `CLOSE_DOWN_STANDOFF_M`（米）。取值 SHALL 由**联合可行窗口**标定：
- 下界：更贴近使**犯规带** `[16,30]` 破（贴近 → 犯规爆）；
- 上界：更远离使 **B4 < 0.28**（= `#18` 判据带下沿 = 0.5 × 真实 0.5609）。
实测联合窗口 ∈ [≈4.0, ≈4.15]；实现取 **`CLOSE_DOWN_STANDOFF_M = 4.0`**。
该常量 SHALL NOT 随意调整——它是经三个标定 seed 窗口（401..600 / 601..800 / 801..1000）
联合验证的窄窗口值。

#### Scenario: 开放比赛有防守方逼近持球者
- **GIVEN** 开放比赛（非 transition）中一名外场持球者
- **WHEN** 引擎推进一拍
- **THEN** 无球方最近 1 名外场球员的 mover SHALL 以 `chase`/`close_down` 语义朝持球者移动
  （至多逼近到 `CLOSE_DOWN_STANDOFF_M` 外），且该指派 SHALL NOT 改变持球者的移动候选

#### Scenario: 受压不禁止射门、只降低概率
- **GIVEN** 开放比赛中持球者被防守方逼至 `nearest ≤ OPEN_PLAY_PASS_PRESSURE_M`
- **WHEN** 引擎评估开放比赛持球行动
- **THEN** 持球者 SHALL 仍进入 `open_play_shot_engage_hits` 掷定（不是直接出球），
  射门启动概率由 `compute_shot_score` 的连续 `defensive_pressure` 项降低；
  **SHALL NOT** 出现「受压 ⇒ 射门路径不可达」的硬 early-return

#### Scenario: 门将与停滞仍出球优先
- **GIVEN** 门将持球，或持球者停滞达 `LIVENESS_STAGE_2_TICKS`（且无压）
- **WHEN** 引擎评估开放比赛持球行动
- **THEN** 持球决策 SHALL 选择出球候选（本改动 SHALL NOT 把这两支也挪到射门掷定之后）

#### Scenario: B4 达到判据带下沿
- **GIVEN** 引擎以 30 seed × 90 分钟模拟（canary，`#18` 同口径）
- **THEN** B4（持球拍中有防守方朝持球者逼近 > 0.3 m 的占比）SHALL ≥ 0.28
  （= 0.5 × 真实参照 0.5609，`#18` 判据带下沿）。改动前实测 0.0581。

#### Scenario: L1 四带与三窗稳定
- **GIVEN** 引擎以 200 场 × 90 分钟在**三个标定窗口**（401..600 / 601..800 / 801..1000）各跑一遍
- **THEN** 普通射门/场 ∈ `[14,29]`、抢断/场 ∈ `[24,50]`、犯规/场 ∈ `[16,30]`、
  传球成功率 ∈ `[0.82,0.90]` SHALL 在每个窗口成立（防窗口过拟合——`#104` 的教训）

#### Scenario: 同队最小间距不因逼抢破裂
- **GIVEN** 引擎以多 seed 模拟，逐拍检查同队球员轨迹（含拍内中点）
- **THEN** 任意同队 pair 的轨迹间距 SHALL ≥ 2 m（`p53` 硬门）。
  ⚠️ 本 scenario 是**已知风险**：原型在 30 seed 里出现 ~2 处扫掠违规（1.28–1.74 m），
  修法见 design §5；**未收干净前不得实现**。
