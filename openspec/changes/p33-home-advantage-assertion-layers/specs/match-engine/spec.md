# Spec: match-engine

## MODIFIED Requirements

### Requirement: 主场优势（主客进球不对称，L1）

引擎 SHALL 使主队进球系统性多于客队，主客进球不对称对齐真实方向。主场优势通过**两个落在单点判定上的微差通道**实现（均只改比较阈值、不增/减确定性 RNG 消费，同 seed 同流，且不挤压其他 L1 带的合并统计口径）：机会把握——射门/头球 result 判定中主队 goal 窗口上移（`CLINICAL_GOAL_PP_HOME`）、客队不压；二点争顶——角球 battle 攻方胜率攻方为主队时高于攻方为客队时。引擎当前总进球 ~0.9-1.1/场（B 档体积扩展前），本机制只调**主客比例**不做体积扩展。验证 SHALL 按三层拆分：机制测试（系数方向，纯函数断言）、短窗口 sanity（方向检查，非精细 ratio 下界）、长期校准（ratio 点估计 + 置信区间，report-only）。

#### Scenario: 主队进球多于客队（L1 短窗口方向 sanity）
- **GIVEN** 引擎以 ≥600 个 seed × 90 分钟模拟（预注册冻结窗口）
- **THEN** 主队进球/场 SHALL ∈ [0.38, 0.75] 且主队进球 SHALL > 客队进球（方向检查，非 ratio ≥ 1.08 的精细下界——真实主客比 ~1.25，但引擎体积压缩下真实效应 ~1.11，600 场无法可靠分辨 1.08 vs 1.11，需数万场）
- **AND** 客队进球/场 SHALL ≥ 0.30（主队优势不得机械压低客队——客队进球不被宏观系数压缩）

#### Scenario: 机会把握主客平移
- **GIVEN** 一次射门/头球判定且射门方为主队
- **THEN** result goal 判定阈值 = 分桶声明概率 + `CLINICAL_GOAL_PP_HOME`（主队把握略高）；saved 窗口宽 SHALL 不变（门将扑救表现不随主客变化）
- **AND** 射门方为客队时阈值 = 分桶声明概率（客队不被压低）

#### Scenario: 角球二点争顶主客不对称
- **GIVEN** 一次角球 battle 争抢（攻方 chaser 到落点）
- **THEN** 攻方为主队时胜率 = `BATTLE_ATTACK_WIN_HOME`%、攻方为客队时 = `BATTLE_ATTACK_WIN_AWAY`%（攻/防基线 55/45；home 攻 58、home 守 100−52=48，各 +3pp）且主队方向不弱于客队

#### Scenario: 长期校准报告
- **GIVEN** 长期校准测试（report-only）
- **THEN** 输出主客进球 H/A 点估计 + log(H/A) 95% 置信区间，SHALL 不设 ratio 硬门（精确校准需数万场，600 场仅作可重复的观察报告）
