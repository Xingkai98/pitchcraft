# Spec: pitch-viewer

## ADDED Requirements

### Requirement: 静止球员 micro-motion

画面层 SHALL 给静止球员（不在 beat movers、不在高亮参与者、**不是 main 持球者**）做小幅重心调整（micro-motion），避免圆点完全冻结；该调整仅影响渲染层，不改变逻辑位置。

#### Scenario: 静止球员微动
- **GIVEN** 一名球员静止（不在 movers/高亮参与者/main 持球者）
- **WHEN** 画面层渲染该球员
- **THEN** 在逻辑位置做小幅重心调整（振幅 < 0.002 归一化），逻辑位置不变；**启停时振幅从 0 渐变（fade in/out ~0.3s），避免微动开始/结束瞬间的渲染跳变**

#### Scenario: 微动确定性且连续
- **GIVEN** 同一播放时刻重放
- **THEN** 微动偏移一致：A/φ/T 由 `hash(id)` 一次派生并缓存（球员级常量，非每帧随机）；t 连续推进（不 floor 到 tick），偏移 = `A·sin(2π·t/T+φ)`（去冗余相位 t0，由 φ 吸收），tick 边界无跳变

#### Scenario: 移动中抑制微动
- **GIVEN** 一名球员正在移动（movers 或高亮参与者）或为 main 持球者
- **THEN** 不做微动（避免与移动叠加、人球分离）；**抑制切换用启停渐变（进入抑制淡出、退出淡入 ~0.3s），避免移动/静止切换瞬间的渲染跳变**

### Requirement: 微动不影响无 snap

micro-motion SHALL 不改变逻辑位置，不影响跨拍连续（from(N+1)==to(N)）与无 snap 验证。

#### Scenario: 逻辑位置不变
- **WHEN** 渲染带微动的静止球员
- **THEN** 其逻辑位置与 beat 数据一致（微动仅渲染偏移）
