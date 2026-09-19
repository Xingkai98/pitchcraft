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
- **THEN** 微动偏移一致：A/φ/T 由 `hash(id)` 一次派生并缓存（球员级常量，非每帧随机）；t 连续推进（不 floor 到 tick），偏移 = `(A·sin(w), A·cos(w))`，`w = 2π·t/T + φ`（x 用 sin、y 用 cos，形成小幅环动；去冗余相位 t0，由 φ 吸收），tick 边界无跳变

#### Scenario: 移动中抑制微动
- **GIVEN** 一名球员正在移动（movers 或高亮参与者）或为 main 持球者
- **THEN** 不做微动（避免与移动叠加、人球分离）；**抑制切换用启停渐变（进入抑制淡出、退出淡入 ~0.3s），避免移动/静止切换瞬间的渲染跳变**

#### Scenario: 高亮参与者回溯识别
- **GIVEN** 引擎的高亮事件与同 tick 的 beat 存在**三种相对位置**：pass/shot 的 beat 在**同 tick 之后**（遮蔽「当前事件索引」）、tackle 的 beat 在同 tick **之前**（不遮蔽）、foul **不产 beat**（无锚点，`_eventEnds` 回落 `e.t`）
- **WHEN** 画面层判定某球员是否为高亮参与者
- **THEN** SHALL 按**事件窗口**回溯查找覆盖当前播放时刻的高亮事件（事件 `t` → 其锚点最长 `t`；**foul 的语义窗口取纪律牌显示时长**），而非直接取当前事件索引——否则 pass/shot 的参与者集合恒为空、抑制失效（issue #81 实测：不回溯时约 98% 高亮帧未抑制，且 foul 因窗口零长度失效）

### Requirement: 微动不影响无 snap

micro-motion SHALL 不改变逻辑位置，不影响跨拍连续（from(N+1)==to(N)）与无 snap 验证。

#### Scenario: 逻辑位置不变
- **WHEN** 渲染带微动的静止球员
- **THEN** 其逻辑位置与 beat 数据一致（微动仅渲染偏移）
