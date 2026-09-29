## ADDED Requirements

### Requirement: 位置口径以观测层事实为权威

空间特征的位置 SHALL 取自 #15A 观测层的事实（episode 起点为 `control_established` 的
`location`；终点取同源的收束侧字段），**SHALL NOT** 以决策动作的 `Event.x` 替代。

理由（2026-09-29 实测）：`Event.x` 是**动作主体的位置**；episode 开场通常是带球，
首个决策动作晚**中位 8 秒**（p90 16s），届时球已离开后场。两种口径使「后场起点占比」
相差 **3 倍**（7.5% vs 23.5%），26.6% 的 episode 落在不同的带。

#### Scenario: 两口径不可混用
- **WHEN** 计算任何依赖 episode 位置的特征
- **THEN** 位置取自观测层事实，且**同一特征内起点与终点同源**（不一处用事实、一处用动作位置）

#### Scenario: 口径有守卫
- **WHEN** 有人把位置来源改回「决策动作的 `Event.x`」
- **THEN** 至少一条测试变红（守卫须对该变异有区分度，不得是恒真断言）

#### Scenario: 口径写进产物
- **WHEN** 任一产物被写出
- **THEN** provenance 记录口径版本与位置来源，使口径不同的两次运行在产物层可区分

### Requirement: 空间特征分静态与时间关系两组

特征 SHALL 分两组产出：
**静态**（`depth` / `width` / 重心 / `spread` / 有效人数）与
**时间关系**（球门向净推进 / 推进·回撤·横向转移 / 线间距变化 / 接应是否形成）。

时间关系组是本 change 的实际工作量：静态快照**不足以**判定战术阶段
（`build_up ≠ 后场`、`progression ≠ 球向前移动`、`final_third ≠ 前 1/3`）。

#### Scenario: 每条特征报告覆盖率
- **WHEN** 输出任一特征
- **THEN** 同时报告**可计算帧占比**、`unknown` 占比与缺失原因分类（外推点 / 人数不足 / 时间基准不可得）

#### Scenario: 时间基准不混用
- **WHEN** 计算任一特征
- **THEN** 同一特征只用同一 `TimeBasis` 的字段；确需跨 basis 的，显式标注并单独列出

#### Scenario: 轨迹来源如实标注
- **WHEN** 特征依赖逐帧轨迹
- **THEN** 使用全量采样帧（`sampleEngineFrames` 等价物），**不得**用 `episode.event_indexes`
      重建轨迹（实测它只挂 1.6% 的 beat，不足以重建）

### Requirement: phaseability gate 必须给出裁决

本 change SHALL 用产出的特征裁决 `build_up` / `progression` / `final_third`
**能否判定**，并给出**二选一**的明确结论：够（附可执行谓词）或不够（附缺失说明与 15B 的降级路径）。

#### Scenario: 够则给谓词
- **WHEN** 裁决为「够」
- **THEN** 给出三档各自的可执行谓词：用哪些特征、什么时间窗、以及在什么条件下输出 `unknown`

#### Scenario: 不够则说清缺什么
- **WHEN** 裁决为「不够」
- **THEN** 明确指出缺哪类观测，并给出 15B 的处置：保留 `unknown` 还是需补数据/模型

#### Scenario: 不得用区域冒充阶段
- **WHEN** 构造判别检验或谓词
- **THEN** **不得**以球场区域/坐标直接充当战术阶段；判别参考集**不得只由区域构造**
      （否则检验退化为循环论证）；若最终只能用几何代理，须命名为**证据**
      （如 `GoalwardProgressEvidence`），**不得复用 `Phase`**

### Requirement: 本 change 不改变比赛生成

本 change SHALL NOT 修改跑位/决策逻辑、RNG、正式事件流协议或 viewer 正式播放；
SHALL NOT 实现 #15B 的 phase 标注器。

#### Scenario: 分析不改变生成
- **WHEN** 本 change 的任何产物被生成
- **THEN** 同一 seed 的正式事件流与 `simulate()` 逐字节一致，且不受本 change 影响
