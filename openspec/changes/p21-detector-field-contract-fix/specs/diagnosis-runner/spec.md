# Spec: diagnosis-runner

## ADDED Requirements

### Requirement: detector 出界证据契约认 detail

确定性审计的出界证据 SHALL 优先认定 `detail` 为 `out_sideline` 或 `out_goal_line` 的 pass 事件为出界；SHALL 同时兼容 `result === 'out'` 与落点几何出界作为次要证据分支。真实出界传球（`result:"contested"` + `detail:"out_*"` + 钳制坐标）SHALL 被判定为出界，而非 `unknown`。

#### Scenario: 真实出界传球被判定出界
- **GIVEN** 一个 pass 事件 `result:"contested"`、`detail:"out_sideline"`、坐标在球场内（已钳制）
- **WHEN** 运行审计
- **THEN** 该事件被认定为出界（unforced_out 依据 nearest_defender_distance 产出 finding；pass_outcomes 计入 out_count）

#### Scenario: 兼容旧 result==='out'
- **GIVEN** 一个 pass 事件 `result:"out"`（无 detail）
- **WHEN** 运行审计
- **THEN** 该事件仍被认定为出界（兼容分支）

### Requirement: detector 排除位契约读 detail 字符串

确定性审计的 pass 排除位 SHALL 认 `detail` 字符串集合（corner/throw_in/free_kick/clearance）为死球/战术传球排除依据；SHALL 不把 `result === 'contested'` 单独作为排除依据（出界球同为 contested）。布尔排除位（如 `clearance === true`）SHALL 保留作为兼容分支。

#### Scenario: 角球/界外球/任意球/解围 pass 被排除
- **GIVEN** 一个 pass 事件 `detail:"corner"`（或 throw_in/free_kick/clearance）
- **WHEN** 运行 unforced_out 与 pass_outcomes 统计
- **THEN** 该事件被排除，不计入 ordinary pass 桶、不产 unforced_out finding

#### Scenario: 出界球不因 contested 被排除
- **GIVEN** 一个 pass 事件 `result:"contested"`、`detail:"out_sideline"`
- **WHEN** 运行 unforced_out
- **THEN** 该事件不被 contested 排除位排除，按出界处理

### Requirement: detector 字段契约单一权威

确定性审计 SHALL 以字段契约清单（声明每个 detector 读取的字段及其生产方）为单一事实来源；契约清单与 detector 代码不一致 SHALL 由测试发现。每个 detector 读取的字段 SHALL 在真实 audit_input 上由引擎或推导层生产，或显式登记为 known-gap。

#### Scenario: 契约断言覆盖所有读取字段
- **GIVEN** 字段契约清单覆盖全部 detector 的 reads/producers/known_gaps
- **WHEN** 对真实 bundle 的 audit_input 运行契约断言测试
- **THEN** 每个 reads 字段在真实数据上有生产者或登记 known-gap；契约清单与 detector 实现不一致时测试失败

### Requirement: audit_input 版本保护

audit_input SHALL 携带 `schema_version`；`runAudit` SHALL 在读取前校验版本，缺失或未知版本 SHALL 抛错而非静默按默认处理。

#### Scenario: 缺失版本抛错
- **GIVEN** 一个不带 `schema_version` 的 audit_input
- **WHEN** 调用 `runAudit`
- **THEN** 抛错并指出缺失版本，不产出 findings

#### Scenario: 已知版本正常审计
- **GIVEN** 一个 `schema_version` 为当前已知值的 audit_input
- **WHEN** 调用 `runAudit`
- **THEN** 正常产出 findings（版本校验通过）

### Requirement: 未标定 detector 告警降级

标记为未标定（`calibrated:false`）的 detector 的告警 SHALL 在聚合层降级：SHALL 不因超出参考 band 升级为 `realism_failure`，聚合摘要 SHALL 携带 `calibration:'uncalibrated'` 供诊断报告层识别，避免未标定告警污染诊断结论。

#### Scenario: 未标定告警不升级 failure
- **GIVEN** ignored_interception 标记 `calibrated:false` 且其告警率超出参考 band
- **WHEN** 运行聚合
- **THEN** 该 detector 的 aggregate_severity 不升级为 realism_failure，摘要带 calibration:'uncalibrated'
