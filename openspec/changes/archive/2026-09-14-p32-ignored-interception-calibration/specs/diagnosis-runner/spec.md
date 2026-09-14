# Spec: diagnosis-runner

## MODIFIED Requirements

### Requirement: 未标定 detector 告警降级

标记为未标定（`calibrated:false`）的 detector 的告警 SHALL 在聚合层降级：SHALL 不因超出参考 band 升级为 `realism_failure`，聚合摘要 SHALL 携带 `calibration:'uncalibrated'` 供诊断报告层识别，避免未标定告警污染诊断结论。

#### Scenario: 未标定告警不升级 failure
- **GIVEN** player_overlap 标记 `calibrated:false` 且其告警率超出参考 band
- **WHEN** 运行聚合
- **THEN** 该 detector 的 aggregate_severity 不升级为 realism_failure，摘要带 calibration:'uncalibrated'
