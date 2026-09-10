# Spec: match-observation

## ADDED Requirements

### Requirement: 已提交观察的描述以服务端为权威并自动回填

对于已提交（有 task_id）的观察条目，页面 SHALL 以服务端 bundle 的 statement 为权威：在刷新恢复与任务轮询时 SHALL 用服务端返回的 statement 覆盖本地条目；服务端返回空字符串时 SHALL 覆盖为空；服务端未返回该字段时 SHALL 保持本地值。采集未提交（无 task_id）的条目 SHALL 保持本地值。

#### Scenario: 刷新后从服务端回填描述
- **GIVEN** 一个已提交观察，服务端 bundle statement 为「球员射门偏出太多了」，本地 localStorage 存的是旧值「」
- **WHEN** 页面刷新并轮询该任务
- **THEN** 该条目 statement 显示为「球员射门偏出太多了」

#### Scenario: 服务端空描述覆盖本地脏值
- **GIVEN** 一个已提交观察，服务端 bundle statement 为空字符串，本地存有旧描述
- **WHEN** 页面刷新并轮询该任务
- **THEN** 该条目 statement 被清空（不残留旧描述）

#### Scenario: 服务端未返回 statement 时保持本地值
- **GIVEN** 一个任务响应不含 statement 字段（bundle 缺失或旧服务）
- **WHEN** 页面轮询该任务
- **THEN** 条目 statement 保持不变

#### Scenario: 未提交观察不参与回填
- **GIVEN** 一个采集未提交（无 task_id）的观察条目
- **WHEN** 页面刷新
- **THEN** 该条目 statement 保持本地值（服务端无此任务）
