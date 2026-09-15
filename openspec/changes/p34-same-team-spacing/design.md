# Design: 引擎侧同队间距约束（#53）

## 决策背景（grill 已定稿，codex 全 A）

issue #53 方向在 `.scratch/issues/53-same-team-spacing-grill.md` 定稿：根治口径分裂（归一化欧氏 vs 米制）+ 最终位置保证 + 盲区兜底。codex 顾问（gpt-5.6-sol）对 6 个决策点全部标 A，并修正了 3 处关键事实（见 `reviews/grill-design.md`）。本文档落实现锚点。

## 核心事实（锚定）

| 事实 | 位置 |
|---|---|
| repulsion 用归一化欧氏 `dist_norm`，阈值 `REPULSION_MIN_DIST=0.02` | `engine/src/lib.rs:596,606,2776` |
| detector 用米制 `strict < 2.0m`，`x*105/y*68` | `tools/detectors.mjs:629` / `viewer/derive-audit-features.js:324` |
| 米制距离 helper 已存在 | `engine/src/lib.rs:4256` `distance_meters` |
| carrier 独立走位、不进 repulsion | `engine/src/lib.rs:2523` `carrier_move` / `2744` |
| target 层 repulsion 迭代 ≤3、不保证最终位置 | `engine/src/lib.rs:2766-2785` |
| dead_zone 停者不动 | `engine/src/lib.rs:487,2801` |
| 特殊站位目标（角球/close_down/chase/anticipate） | `engine/src/lib.rs:2604,2632,2747-2761` |
| 现有单测只证 target 层推开（`d>0.005`） | `engine/src/lib.rs:5685` |
| golden 版本分离 v1–v5，当前 MODEL_VERSION=5 | `engine/src/lib.rs:228` / `engine/tests/realism.rs:1084` |

## D1：米制分离纯函数（口径根治）

新增常量与纯函数（零 RNG、固定遍历顺序）：

```rust
/// 同队球员最小间距（米制）。2.0m（detector strict <） + 0.05 安全余量，
/// 防 round3 毫米舍入把 2.000m 变成 1.999m 误报。
pub const SAME_TEAM_MIN_DIST_M: f64 = 2.05;

/// 米制同队距离（x×105 / y×68），复用既有 distance_meters。
fn same_team_dist_m(a: (f64, f64), b: (f64, f64)) -> f64 { distance_meters(a, b) }

/// 米制推开：两同队点若间距 < min_dist_m，沿**米制**连线各推 (min_dist - d)/2。
/// 方向向量先在米制几何算（dx=PITCH_LENGTH_M, dy=PITCH_WIDTH_M），
/// 再换回归一化位移写回。d==0 退化沿 +x。零 RNG、纯函数。
fn separate_pair_m(a: (f64,f64), b: (f64,f64), min_dist_m: f64) -> ((f64,f64),(f64,f64))
```

**关键约束**：推开方向必须用米制向量，不能沿用归一化欧氏方向——否则 0.02 归一化圆里「看起来等距」的两点在米制下会误判。距离比较换成 `distance_meters` 但方向仍用 `dist_norm` 单位向量是**错误的半吊子**（codex 明确点出），必须距离+方向都米制化。

target 层 repulsion（`compute_movers` 第二遍）改用 `same_team_dist_m` 判定 + 米制推开。

## D2：最终位置统一分离（最终位置保证 + 盲区兜底）

**顺序原则（codex 硬约束）**：分离必须发生在「候选位置计算之后、写入 `st.pos` / 构造 mover/main 事件之前」，不是事件发出后补改状态。

### 提交路径重构

现状 `carrier_move` 直接写 `st.pos[carrier]`/`carrier_from`/`last_emitted` 并返回 `MainAction`；`compute_movers` 直接写各 `st.pos[id]`。重构为：

1. `carrier_move` 产出候选终点（不写 `st.pos`），返回候选 `(x2f, y2f)` + 构造 `MainAction` 所需的 `x/y`（起点）、`speed`、`touch_freq`。
2. `compute_movers` 产出候选 `Mover`（含候选 `to_x/to_y`，含 dead_zone 停者——停者的候选 = 当前 `st.pos`，仍需参与分离），不写 `st.pos`。
3. 新增**统一分离 solver**：把「carrier + 全体 mover 候选终点 + 不参与本拍移动的球员当前 `st.pos`」合并成 `[f64;22]` 位置数组，对同队 pair 跑固定上限（如 3–5 轮）米制分离，逐轮 `separate_pair_m`；结束后对仍 <2m 的 pair 做终断言（`debug_assert` / 单测捕获）。
4. **统一写回**：用分离后数组写 `st.pos`，同步 `last_emitted`、`carrier_from`（=分离后 carrier 终点）、`ball_pos`（跟 carrier 终点）；`MainAction.x2/y2` 与各 `Mover.to_x/to_y` 取分离后值；`MainAction.x/y`、`Mover.from_x/from_y` 保留起点。

### 覆盖范围

分离作用于**全部在场有位置语义的球员**：carrier、门将、普通 mover、dead_zone 停者、特殊 action（close_down/chase/anticipate/corner_prep 目标）。特殊目标函数（`corner_setup_target`/`close_down_stop` 等）继续表达「想去哪」，分离层统一表达「≥2m」，不把 invariant 分散到各入口。

### carrier 与 RNG 安全

- 分离**不得**重新调用 `carrier_move`、不得重抽 RNG、不得用随机重试找位。
- carrier 随机结果视为已确定候选终点，分离是确定性的几何后处理。
- 所有 `compute_movers` 调用点（tick 高亮飞行、`advance_restart_prep`、`emit_corner_kick`/`emit_throw_in`/`emit_free_kick`、`emit_beat_with_main`）都要走同一分离路径，避免某条路径漏分离。

### 语义副作用（接受）

- 分离会改变原本算好的 close_down 停点 / 角球包抄点 / chase 终点——这是「最小必要推移」，只移发生同队违规的 pair，不重选目标、不重抽 RNG，保留 action 标签。
- close_down 最终点可能不再精确保持 `CLOSE_DOWN_STOP_DIST`——「同队不重叠」优先级高于「压迫停点精确」。
- 边界（`clamp01`）可能使分离不足：靠边线/门线时，若 clamp 吃掉位移导致仍 <2m，终断言会暴露——实施时若实测出现，需边界感知的推开方向（沿边线切向），不得静默忽略。

## D3：验收（三重）

1. **引擎原生硬门**：`p53_same_team_spacing_ge_2m` 单测——多 seed（如 10–20）整场逐 tick 扫描同队 pair 米制距离 ≥ `SAME_TEAM_MIN_DIST_M - epsilon`。只查发射位置（lineup/mover to/main x2y2），不查 0.5s 插值中点。
2. **米制口径单测**：`separate_pair_m` 的 x 轴 / y 轴 / 重合退化 / 边界 clamp；更新 `p5_repulsion_separates_overlap` 为米制最终位置断言（不再 `d>0.005`）。
3. **detector 真实门**：跑真实 diagnosis，`player_overlap` finding 应**归零**。若 detector 仍报 0.5s 插值中点越界 → 回引擎调 solver（抬高余量或补中点处理），**不忽略 finding**。不在引擎预计算每段中点推开（把 detector 观测模型硬编码进模拟器 = 过度工程）。

## D4：golden v6 重基线

- `MODEL_VERSION` 5→6，`engine/tests/realism.rs:1084` `golden_dir` 加 `6 => "tests/golden-v6"`。
- `gm_legacy_baselines_preserved_and_differs`（`realism.rs:1260`）legacy 从 v1–v4 扩到 v1–v5，当前 v6 与全部旧版比较。
- `ACCEPT_GOLDEN=1 cargo test --test realism gm_canary_seeds` 生成 v6；**提交前人工审查每个 seed 的 diff**：比分 / 射门 / 传球 / 抢断 / 犯规 / 出界不得出现超出「同队分离」预期的漂移。若频率大幅漂移 → 拒绝基线、回头定位（是 carrier 被推移还是 RNG/事件顺序被意外改变）。

## 关键风险

- **carrier 状态一致性**：`MainAction.x2/y2`、`st.pos[carrier]`、`ball_pos`、`carrier_from`、`last_emitted[carrier]` 五处必须与分离后终点同步，漏一处 → 事件与状态不一致（codex 首要风险）。
- **一轮 pair sweep 不保证全局无冲突**：球员被后续 pair 推动后可能重新靠近之前的球员 → 固定迭代 + 终断言，不能只做一次 pass。
- **角色优先级**：把 carrier/门将都纳入统一 solver 后，「特殊角色优先」的隐含假设消失；如需优先级写成确定性规则，不依赖遍历顺序。
- **米制推开改队形观感**：x/y 位移不再对称，可能改既有队形观感（预期内，但 golden diff 要盯）。
