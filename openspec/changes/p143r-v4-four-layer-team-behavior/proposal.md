# Proposal: 四层球队行为整合落地（球导向跑位 + 开放局逼抢 + 事件密度 + 传球选择/对抗几何）（P143r-v4）

## Why

用户反复反映引擎比赛「**不像足球**」：球员在「铁轨」上滑动、球被钉住、防守方隔 10m 观望、
传球在两人之间对倒。P143r 系列把问题拆成四层分别探通，每一层各自能修好一个症状：

| 层 | 症状 | 机制 | 出处 |
|----|------|------|------|
| **移动 v3** | 「铁轨感」（球员水平细线滑行） | 目标点从「角色基准 + 球侧平移」改为**以球为原点的相对块** | `.scratch/notes/p143r-v3-*` |
| **防守 def** | 防守方隔 10m 观望 | 开放局指派最近 N 人 **close_down 持球者** | `.scratch/notes/p143r-def-probe-*` |
| **密度 vol** | 球被钉住、传球稀 | 决策 deadline 7→2 tick、liveness 档 8/12/16→2/4/7、循环传球 | `.scratch/notes/p143r-volume-probe-*` |
| **事件 evt** | 两人对倒、抢断是平抛硬币 | 传球目标换**价值函数**（含反乒乓记忆）+ 对抗成败**几何化** | `.scratch/notes/p143r-events-probe-*` |

四层已在合并构建器里验证过能一起跑（保真证明：分层隔离版与原 builder 单跑**流哈希逐字节相等**），
用户看过合并效果（`engine-combined-all4w5.wasm`）说「**有很大进步**」，选择**先落地**。

本 change 把这四层**手写进干净源码**（不是照抄生成器输出），走审阅闭环合入。

## What Changes

**1. 移动层（v3 球导向跑位，弱化档）** —— `formation_target` 尾部换球相对块公式：
块心随球纵向牵引（`FORM_TRACK_X=0.5`）+ 块内角色铺开（`FORM_SPREAD_X=0.8`/`FORM_SPREAD_Y=1.3`）+
个体确定性抖动（`FORM_INDIV=0.08`），最终目标是旧/新两式的加权混合（`FORM_MIX_X=0.5`/`FORM_MIX_Y=0.7`）。

**2. 防守层（def 开放局逼抢）** —— `compute_mover_candidates` 加「开放局最近 N 人 close_down
持球者」分支（`OPEN_PRESS_N=1 OPEN_PRESS_GATE=1`，停距 `OPEN_PRESS_STOP_DIST=0.05`≈5m）；
并把出球档阈值 `OPEN_PLAY_PASS_PRESSURE_M` **8→4**——这是四层能共存的前提（否则逼抢把射门推进档锁死）。

**3. 事件密度（vol）** —— `BASE_ACTION_DEADLINE_TICKS 7→2`、`MIN_ACTION_DEADLINE_TICKS 3→2`、
`LIVENESS_STAGE_{1,2,3}_TICKS 8/12/16→2/4/7`、`SHOT_FIRST`（停滞不再直接判出球，先给射门推进一次机会）、
`CIRCULATION_PASS_P=0.15`（循环传球）。事件密度 ~2.1×（传球 394→830/场）。

**4. 事件层（evt）** —— `carrier_pass_target` 换成**价值函数选目标**（前向推进 / 开阔度 / 短传 /
前方空当 / 反乒乓记忆），并加 `MatchState.last_pass_pair` 承载反乒乓项；对抗成败由平抛 0.5
换成**几何 sigmoid**（贴身度 + 迎面逼近 − 坏角度）。

**5. 联合调定常数**（四层叠加**超线性**，须比任一单层更深）：
`BASE_DEF_TACKLE −0.65→−0.86`、`BASE_DEF_FOUL −0.06→−0.19`、`OPEN_PLAY_SHOT_ENGAGE_SHIFT −3.4→−4.15`。

## 已知代价 / 硬前沿（**须用户知情——重标定决策项**）

**`shot/tackle ≥ 0.5` 与 `home > away` 不可兼得**（同一根轴的两端，实测）：

| `BASE_DEF_TACKLE` | tackles/场 | ratio | home（600seed） | away（600seed） | 官方 L1 |
|---|---:|---:|---:|---:|---|
| −0.82 | 51.46 | 0.431 | 1.422 | 1.327 | ✗tackles ✗ratio |
| −0.86（**本 change 取值**） | 45.81 | **0.484** | **1.475** | 1.425 | ✗**ratio**（差 3%） |
| −0.88 | 44.44 | 0.501 | 1.503 | 1.508 | ✗homeAdvDir（home 优势被冲淡到噪声级） |

选 **−0.86**：**保住主场优势**（用户在意的产品属性），代价是 ratio 差 3%。
这是「四层合并把主客优势冲淡到 ≈1.0」的延续——`ratio` 与 `home` 是**同一根轴的两端**，
无中间点可同时满足。是否重标定 `ratio` 下界 / 改 home 优势通道 = **用户级决策**。

## Impact

- `engine/src/lib.rs`：四层机制 + 联合常数 + `MODEL_VERSION 7→8`（可观测行为变 → 新 golden 基线 v8）。
- 新增 `MatchState.last_pass_pair` 字段（`Option<(i32,i32)>`，零 RNG）。
- 默认套件：常数断言（LV*/deadline/jockey 可达性）按新口径更新；两个 seed 覆盖门重钉（**换样本不换判据**）。
- ⚠️ **一条已知默认套件红**：`p53_same_team_spacing_holds_between_anchors`（详见 design §D4）。
- 无新依赖、无新事件类型。
