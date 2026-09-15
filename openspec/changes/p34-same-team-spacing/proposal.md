# Proposal: 引擎侧同队间距约束（≥2m，#53）

## Why

引擎产出的球员坐标中，同队球员可贴到 **0.11m**（#35 实测 seed 42，id 4/5，t=2377），观察窗口内同队最小间距实测 0.54m/0.65m/1.20m，均 <2m。真人比赛同队站位间距通常 ≥2m，同队重叠是最刺眼的画面破绽。

根因（codex 顾问复核，比 issue 原文更准）：

1. **口径分裂（核心）**：`REPULSION_MIN_DIST = 0.02` 是归一化值，repulsion 用 `dist_norm`（无轴向缩放）判定；而 detector `player_overlap` 用真实米制（x×105 / y×68）判定 `strict < 2.0m`。球场 105×68m，故 0.02 归一化 = x 方向 2.1m、y 方向 **1.36m**——引擎「以为」保证了 2m，实际 y 方向只保证 1.36m。
2. **target 层 ≠ 最终位置**：repulsion 只对目标点迭代 ≤3 次，不保证最终移动后位置（`st.pos` 发射坐标）间距；dead_zone（2m 内不动）让重叠球员停在原处。
3. **盲区**：carrier 不参与 repulsion（独立 `carrier_move`）；特殊站位（角球包抄 / close_down / chase / anticipate）虽有 repulsion 但目标本身可能 <2m。

## What Changes

- **米制化**：新增 `SAME_TEAM_MIN_DIST_M`（2.0m + 0.05 安全余量 ≈ 2.05m）+ 米制分离纯函数（距离与推开方向都在米制几何 `x×105 / y×68` 计算，零 RNG、固定遍历顺序）；target 层 repulsion 改米制判定/推开。
- **最终位置统一分离**：在「候选位置计算之后、写入 `st.pos` / 构造 mover/main 事件之前」对同队最终位置做分离后处理，覆盖 carrier、门将、特殊站位、dead_zone 停者。carrier 的 `MainAction.x2/y2`、`ball_pos`、`carrier_from`、`last_emitted` 与分离后终点一致（`x/y` 保留起点）。
- **单测**：新增整场扫描 `p53_same_team_spacing_ge_2m`（逐 tick 同队米制距离 ≥ 2m）+ 米制纯函数口径单测 + 更新 `p5_repulsion_separates_overlap` 为米制最终位置断言。
- **golden v6**：`MODEL_VERSION` 5→6，新增 `tests/golden-v6/`，保留 v1–v5 作历史对照；legacy 测试扩 v1–v5。
- **主 spec**：`match-engine` 新增「同队球员间距 ≥2m」requirement。

## Capabilities

### Modified Capabilities

- `match-engine`: 同队球员任意引擎发射位置采样点的米制间距 SHALL ≥ 2m（覆盖 carrier/门将/特殊站位/dead_zone），分离为纯函数零 RNG。

## Impact

- 改 `engine/src/lib.rs`（常量 + 纯函数 + carrier_move/compute_movers 提交顺序 + 单测 + MODEL_VERSION）
- 改 `engine/tests/realism.rs`（golden_dir v6 + legacy v1–v5）
- 新增 `engine/tests/golden-v6/`（`ACCEPT_GOLDEN=1` 生成，提交前人工审查 diff）
- 改 `openspec/specs/match-engine/spec.md`
- **detector 侧不改**：`player_overlap`（#35 已建，P26）作为真实门，本 change 后其 finding 应**归零**
- **跨队分离 out of scope**：tackle `subject_end/carrier_end`（约 0.03 归一化）是抢断者 vs 被抢者，player_overlap 只查同队，不动

## 关联

- 修复 issue #53；grill 全稿 `.scratch/issues/53-same-team-spacing-grill.md`（codex 全 A 已确认）
- 依赖 #25 已完成（槽位层已删，`compute_movers`/`formation_target` 是当前队形/跑位层）
- 关闭 #35 的引擎侧部分（#35 的 detector 部分已在 P26 完成）
