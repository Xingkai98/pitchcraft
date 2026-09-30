## ADDED Requirements

### Requirement: 意图类信号以只读方式进观测层

观测层 SHALL 接出引擎内**已有**的意图类状态：起脚窗口（`in_window` / `window_ticks` /
`drive_ticks_left` / `committed` / `entry_pressure_bucket`）与防守动作类型及持球者受压程度。
接入 SHALL NOT 改变 `ControlFact` 闭集、正式事件流、决策路径或 RNG。

#### Scenario: 正式路径逐字节不变
- **WHEN** 以 `simulate()`（recorder 关闭）跑任意 seed
- **THEN** 产出的正式事件流与接入前逐字节一致

#### Scenario: 观测层不引用引擎状态类型
- **WHEN** recorder 接收意图事实
- **THEN** 传的是值语义（不持有 `MatchState`），且 `observation.rs` 的「不引用 `MatchState`」承诺仍成立

#### Scenario: 意图不得从位置反推
- **WHEN** 采集任一意图信号
- **THEN** 取自引擎的显式状态字段，**不得**由球员坐标反推

### Requirement: 意图类特征与空间特征并列报告

分析器 SHALL 为意图信号定义逐 episode 特征，每条给出**定义、覆盖率、缺失原因分类**
（沿用 P16 的空间特征口径），并与 P16 的空间特征**并列**输出，使两者可分别对照。

#### Scenario: 覆盖不足显式降级
- **WHEN** 某意图特征在部分 episode 上不可得
- **THEN** 显式记为 `unknown` 并归类原因，不得静默省略或以默认值填充

### Requirement: 重跑 gate 必须对照 P16 基线并净化混淆

本 change SHALL 用「空间 + 意图」重跑三档可分性检验，SHALL 与 P16 基线（`final_third` 0.855 /
`build_up` vs `progression` 0.461，30 seed）**并列对照**，且 SHALL 重新净化 motif 混淆
（`build_up` 与 `progression` 在「传球数」与「是否重开」上同时不同）。

#### Scenario: 净化带反证条
- **WHEN** 执行混淆净化
- **THEN** 同一管线先跑一条已知应给高分的对照（`final_third`），以证明探针本身未坏

#### Scenario: 结论不得跨口径引用
- **WHEN** 引用任一 AUC 数字
- **THEN** 同时标明 seed 数与特征口径（P16 教训：30 seed 与 300 seed 的数字不可互换）

### Requirement: 裁决必须明确且不得以区域冒充阶段

本 change SHALL 给出**二选一**的裁决：够（附三档可执行谓词）或不够（附缺失观测说明与 #15B 的处置）。
SHALL NOT 以球场区域/坐标直接充当战术阶段；若最终只能用几何代理，必须命名为**证据**
（如 `GoalwardProgressEvidence`），**不得复用** `Phase`。

#### Scenario: 不够时说清缺什么
- **WHEN** 裁决为「不够」
- **THEN** 明确指出还缺哪类观测，以及 #15B 应保留 `unknown` 还是需换路线

#### Scenario: 本 change 不改生成
- **WHEN** 本 change 的任何产物被生成
- **THEN** 未修改跑位/决策逻辑、RNG、正式事件流协议或 viewer 正式播放，且不实现 #15B
