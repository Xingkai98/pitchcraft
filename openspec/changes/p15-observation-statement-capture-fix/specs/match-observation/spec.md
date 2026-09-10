# Spec: match-observation

## ADDED Requirements

### Requirement: 观察描述在提交时最终确定

页面 SHALL 在「采集」时以当前输入框内容冻结描述作为初值，并在「提交诊断」时重读输入框：若提交时输入框非空，SHALL 以提交时内容（经凭证形片段抹除）覆盖 bundle 与列表条目的 statement；若提交时输入框为空，SHALL 保留采集时冻结的描述。采集完成后 SHALL 清空描述输入框，避免旧描述泄漏给下一条观察。

#### Scenario: 采集后输入描述，提交时覆盖
- **GIVEN** 用户采集一条观察（采集时描述输入框为空，冻结 statement 为空）
- **WHEN** 用户随后在描述输入框输入「球员射门偏出太多了」并点击「提交诊断」
- **THEN** 提交的 bundle 的 statement 为「球员射门偏出太多了」，列表条目同步显示该描述

#### Scenario: 采集前已输入描述，提交时未改
- **GIVEN** 用户先输入描述「传球时防守队员完全不干扰」再采集观察（冻结该描述），采集后输入框被清空
- **WHEN** 用户直接点击「提交诊断」（不重新输入）
- **THEN** 提交的 bundle 的 statement 保留「传球时防守队员完全不干扰」（不因清空而丢失）

#### Scenario: 采集后清空输入框
- **GIVEN** 用户输入描述并采集观察
- **WHEN** 采集完成
- **THEN** 描述输入框内容被清空，下一条观察不会继承上一条的描述

#### Scenario: 提交时的描述仍抹除凭证形片段
- **GIVEN** 用户采集观察后在描述输入框输入含 `sk-ant-...` 凭证形文本
- **WHEN** 点击「提交诊断」
- **THEN** 提交 bundle 的 statement 中凭证形片段被替换为 `[REDACTED]`
