# Spec: diagnosis-runner

## ADDED Requirements

### Requirement: detector 阈值算子方向有测试守卫

确定性审计的阈值算子方向 SHALL 有测试守卫：每个方向敏感的判据（`>` / `>=` / `<`）SHALL 有「恰好等于阈值」的边界样本断言其方向；真实窗口的 finding 集合 SHALL 有 golden 签名断言其一致性。改判据方向、改阈值、删分支导致真实数据 finding 集合变化 SHALL 由测试发现。

#### Scenario: 等于阈值的边界钉死算子方向
- **GIVEN** unforced_out 的 pressure_distance 阈值为 8.0
- **WHEN** 输入 `nearest_defender_distance` 恰好等于 8.0
- **THEN** 不产 realism_warning（`>` 严格大于，等于阈值不属于无压迫）

#### Scenario: golden 签名兜住真实数据 finding 变化
- **GIVEN** 7 个真实窗口的 golden finding 签名已写死
- **WHEN** 运行审计
- **THEN** 产出的 finding 集合与 golden 签名逐条一致；任何让真实数据 finding 变化（改算子方向/阈值/删分支）的行为导致测试失败
