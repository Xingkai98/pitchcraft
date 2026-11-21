# Proposal: 引擎统一运动执行层（C1 运动学，GitHub #170）

## Why

Change 0（#190）已经把「引擎 / viewer / 指标定义」分开：

- viewer 不是主因：同流消融中 viewer 对旧 `turn120` 贡献 −1.6%、`staticFrac` −3.2%；24×/6× 在**引擎 raw mover 端点**里已经存在。
- 条件 `turn120`（只计双方步速 ≥0.5 m/s）引擎 **0.829 vs 真实 0.0104 = 79.6×**（frozen 24 窗）；旧 24× 被零步伪角低估。
- `staticFrac` 6.5×（frozen 24 窗）；球静止 10× 在 frozen 成立，但它是 viewer 链读数，不能当纯引擎目标。

根因是结构性的：`compute_mover_candidates()` 每拍从 `st.pos` 重算目标，固定步长直追，距目标 <`DEAD_ZONE_METERS=2.0` 直接不产 mover；没有速度/加速度/朝向状态。结果是「走走停停 + 瞬时折角」，而不是连续弧线。viewer 的 Catmull/T1 只改变小部分自转，不能修复锚点往返。

⇒ 本 change 把运动执行换成**有状态的连续运动层**：每球员 `MotionState`（速度/朝向）、加速度/制动约束、10Hz 内部积分、2Hz 决策不变、5Hz beat 输出。这是 C1（#170）的实现设计。

## What Changes

- 新建 `engine/src/motion.rs`（或 `lib.rs` 内模块）：每球员 `pos / vel / heading`；`dv/dt = A0(1−v/S0)`；转向 `|ω| ≤ a_lat / max(v,1)`；近目标自动减速；删掉「到点冻结」的 dead-zone 语义。
- **三层 cadence**（与 #170 默认的差异见 design D1）：
  - 仿真积分 **10 Hz**（内部子步，固定顺序、无新增随机抽样）；
  - 决策/概率掷定 **保持 main v11 的 2 Hz**（`TICK_SECONDS=0.5`），不回到 1 Hz；
  - beat 输出 **5 Hz**（0.2s），与 viewer 采样对齐。
- `beat.movers` 保持现有端点字段（`from/to/speed/action`）；第一阶段**不加** `vx/vy/heading`（D11 #3）。beat 增加**段长** `dt`（0.1/0.2s，时序字段，不是运动矢量）；`main`/`ball` 只在有非零位移的段携带，零位移段由 viewer 保持上一状态。viewer 只插值同一轨迹，不再用 Catmull/T1 叠加第二套运动。
- 统一覆盖持球者、无球者、高亮参与者、门将、重开走位者与同队分离提交；分离 solver 改为「可达性/避让约束」，不得绕过加速度约束。
- `MODEL_VERSION 11 → 12`；新建 `engine/tests/golden-v12/`；L1/ratchet/协议 spec 按新运动合同重标定。
- **前置**（Change 0 的结论，D11 已拍板）：
  - 角球均值 [1,7] 是护栏带：**重锚到真实 ~10.27**，保留单场 max 护栏（不降级、不删门）；
  - p53/p31/p6/p32 的固定 seed 夹具改为「显式构造场景 + 条件断言 + 多 seed 置信范围」；
  - 预注册条件 `turn120`、`staticFrac`、速度分位、加速度尾部、路径效率/回环、低速转向、残余漂移；并在 main 同配置实测**权威 L1 基线**（历史「4 红」不是权威）。

## Capabilities

### New Capabilities

（无。本 change 修改既有引擎/协议/画面能力。）

### Modified Capabilities

- `match-engine`: 运动执行从「每拍目标点 + 固定步长 + dead-zone 冻结」改为「有状态连续运动 + 加速度/制动」；三层 cadence 与 L2 不变量更新。
- `event-stream-protocol`: beat 节拍从 0.5s 改为 0.2s；`movers` 的运动语义与可选速度/朝向字段；高亮时长的 tick 语义。
- `pitch-viewer`: 播放器只插值同一运动轨迹；去掉与引擎运动重复的 Catmull/T1 叠加（分阶段，视觉验收后）。

## Impact

- `engine/src/lib.rs`、新 `engine/src/motion.rs`、`engine/src/wasm.rs`、`engine/tests/*`（golden/L1/L2/p53/p31/p6/p32/p15/p16/p17a/p17b/p18/p124）、`viewer/game.js` / `interpretation.js` / `config.js`、`openspec/specs/{match-engine,event-stream-protocol,pitch-viewer}/spec.md`。
- 事件流体积：beat 名义 2Hz → 5Hz，决策/事件切段后实际 6 段/s ⇒ **约 3×**（不是 2.5×）；稀疏 `main`/`ball` 抵消一部分。JSON 体积、viewer 加载/seek/帧耗时按 design D7.5 的预算实测。
- 行为全量改变：golden 重基线、L1/ratchet 重标定、研究门重扫。
- **设计批准前不写实现**（#170 的硬要求）。

## 关联

- GitHub #170（C1 运动学，本 change 的主票）；地图 #175；Change 0 #190（仪器与裁决）。
- 设计必须回答 #170 的八问；本 change 的 `design.md` 是第一步交付。
