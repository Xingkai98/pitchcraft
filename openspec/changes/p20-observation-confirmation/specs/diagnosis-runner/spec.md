# Spec: diagnosis-runner

## ADDED Requirements

### Requirement: runner 支持提案模式与确认

诊断 runner SHALL 支持「提案模式」：读 bundle 产出候选事件 index 集合与锚点漂移提示，只提案不诊断；SHALL 支持按任务 id 写确认（事件 index 集合）；诊断阶段 SHALL 以确认的事件集合为锚点输入。

#### Scenario: 提案模式只产出候选不诊断
- **GIVEN** 一个 captured 观察任务
- **WHEN** 以提案模式运行
- **THEN** 任务状态转为 `awaiting_confirmation`，写 proposal（event_indexes/candidates/drift_hints），且不执行诊断

#### Scenario: 无 provider 回退为空提案
- **GIVEN** 提案模式运行但 provider 不可用
- **WHEN** 运行提案
- **THEN** proposal.source 为 fallback-empty，状态仍 awaiting_confirmation

#### Scenario: 确认写任务并供诊断使用
- **GIVEN** 一个 awaiting_confirmation 任务
- **WHEN** 客户端提交确认（event_indexes 集合）
- **THEN** 任务状态转为 confirmed，confirmation.event_indexes 持久化，后续诊断以该集合为锚点
