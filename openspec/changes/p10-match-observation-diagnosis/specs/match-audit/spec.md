## ADDED Requirements

### Requirement: Audit 是确定性且可复现的

Audit SHALL 对相同 observation bundle、代码版本和 profile 产生相同的 findings、特征值、严重级别和证据；每个 finding SHALL 包含 detector id、profile 版本、比赛时间、事件索引或实体 id、实际值和阈值。

#### Scenario: 重复审计相同观察

- **WHEN** runner 对同一 bundle 连续执行两次 audit
- **THEN** 两次输出的 finding ids、detector ids、特征值和证据完全一致

### Requirement: Audit 区分事实异常和真实感风险

Audit SHALL 将结果分类为 `invariant_violation`、`realism_warning`、`realism_failure` 或 `unknown`，不得把无法从 bundle 推导的判断标记为已确认失败。

#### Scenario: 缺少必要证据

- **WHEN** 观察窗口没有足够的位置或事件信息计算传球防守压力
- **THEN** 对应 detector 输出 `unknown` 或明确跳过原因，不生成虚假的 failure

### Requirement: 检测无压力传球出界

Audit SHALL 在排除死球、解围、角球、界外球和明确争抢后，识别普通传球出界，并报告传球前最近防守者距离、传球目标距离、压力等级、出界原因字段和样本计数。

#### Scenario: 无压力普通传球出界

- **WHEN** 一次普通传球出界，最近防守者距离高于 profile 压力阈值且不是战术性解围
- **THEN** 输出 `unforced_out` finding，并携带事件索引、传球距离、边线距离、压力特征和 profile 阈值

### Requirement: 检测责任状态下连续站桩

Audit SHALL 只在球员处于责任状态时统计静止：球进入其责任区、球权刚转换、或其所在防线整体移动；死球、门将固定站位和明确阵型保持 SHALL 被排除。

#### Scenario: 防守责任下连续不动

- **WHEN** 防守球员在责任状态下连续超过 profile 的静止时长且没有向球、责任区或回防目标移动
- **THEN** 输出 `inactive_responsibility` finding，并携带球员 id、开始/结束时间、静止时长和责任触发原因

### Requirement: 检测可拦截传球但无防守反应

Audit SHALL 计算传球走廊、最近防守者到走廊的距离、球到达走廊的时间、防守者以 profile 速度到达的时间和实际移动方向，并识别存在合理拦截机会但无反应的片段。

#### Scenario: 忽略可拦截传球

- **WHEN** 防守者到传球走廊的预计时间小于球到达时间，且防守者在该窗口内没有向走廊、持球者或接球者移动
- **THEN** 输出 `ignored_interception_opportunity` finding，并携带传球事件、 defender id、走廊距离、两个到达时间和实际位移

### Requirement: Audit 支持聚合评估

Audit SHALL 能对一场或多场确定性 replay 聚合 detector 指标，并报告样本数、异常数、异常率、参考带或 profile 阈值以及未覆盖原因。

#### Scenario: 比较压力下传球表现

- **WHEN** runner 扫描多个 seed 的普通传球
- **THEN** 报告无压力和有压力传球的出界率、成功率和样本量，避免只凭单个片段下结论
