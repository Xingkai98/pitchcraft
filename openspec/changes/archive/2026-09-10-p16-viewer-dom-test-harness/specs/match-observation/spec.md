# Spec: match-observation

## ADDED Requirements

### Requirement: 观察采集/提交的 DOM 行为有自动化测试覆盖

观察采集与提交的清空/覆盖行为（P15 引入）SHALL 有驱动真实 `viewer/app.js` DOM 接线的自动化测试，且随 `verify.sh` / CI 运行——误删或改坏这些接线（采集后清空、提交时覆盖、提交后清空）时测试 SHALL 失败。

#### Scenario: 采集后清空输入框被测试断言
- **GIVEN** 观察采集测试用例
- **WHEN** 驱动真实「采集」按钮监听器
- **THEN** 断言描述输入框内容被清空

#### Scenario: 提交时覆盖描述被测试断言
- **GIVEN** 观察提交测试用例（采集时描述为空，随后输入描述）
- **WHEN** 驱动真实「提交」按钮监听器
- **THEN** 断言提交的 statement 为输入值（经凭证抹除）

#### Scenario: 提交后清空输入框被测试断言
- **GIVEN** 观察提交测试用例（采集后输入描述并提交）
- **WHEN** 提交完成
- **THEN** 断言描述输入框内容被清空
