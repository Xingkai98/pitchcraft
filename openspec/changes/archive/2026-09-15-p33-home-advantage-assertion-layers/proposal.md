# Proposal: 主场优势断言三层重构（#63）

## Why

`l1_home_away_goal_asymmetry` 的 `gh > ga*1.08` 断言有统计功效问题：引擎真实主/客进球比 ~1.11，与 1.08 阈值只差 ~3pp，但 600 场窗口的 ratio 95% CI 半宽 ~0.10、相邻 200 场窗口 ratio 波动 0.96–1.27——「过不过」基本是固定窗口抽到哪些 seed 的确定性巧合（P29 抽到 1.33 过、P30 抽到 0.96 挂），机制本身没回归。

根因：一个比分统计同时承担「机制存在」和「长期统计达标」两件不相容的事。本 change 按三层拆分（codex 顾问已确认，全按推荐）：

1. **机制测试**（已存在，`engine/src/lib.rs:4960` `home_advantage_channel_semantics`）：直接测系数方向，不依赖进球数——已完成，不改。
2. **短窗口 sanity**：删 1.08 精细门，改纯方向 `gh > ga`（+ 保留体积带/客队下限），只负责「发现主场优势消失/反向」。
3. **长期校准**：独立 report-only 测试，输出 H/A 点估计 + log-scale 95% CI，供人工校准，不设硬门。

## What Changes

- `l1_home_away_goal_asymmetry`：`gh > ga*1.08` → `gh > ga`，注释改为「短窗口方向 sanity，非 ratio 校准」。
- 新增 `l3_home_away_goal_calibration`（`#[test] #[ignore]` report-only）：复用 `ha_stats()`，输出 H/A 点估计、log(H/A)、SE、95% CI，仅 `println!`，无 ratio 断言。

## Capabilities

### Modified Capabilities

- `match-engine`: 主场优势 L1 统计门从「精细 ratio 下界」改为「方向 sanity + 独立长期校准 report」。

## Impact

- 只改 `engine/tests/realism.rs`（断言 + 新增 report 测试）
- 不改 `engine/src/lib.rs`（机制测试已够）、`verify.sh`（report-only 即使被 verify 跑也不失败）
- **golden 不变**（纯测试改动，不碰 simulate/RNG/事件 JSON）

## 关联

- 修复 issue #63；grill 全稿 `.scratch/issues/63-home-advantage-assertion-layers-grill.md`
