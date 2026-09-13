# Proposal: player_overlap 同队间距 invariant detector

## Why

引擎产出的球员坐标中，同队球员可贴到 **0.11m**（实测 seed 42 全场，id 4/5，t=2377）。真人比赛同队站位间距通常 ≥2m。观察窗口内同队最小间距实测 0.54m / 0.65m / 1.20m，均 <2m（阈值 2m 下每窗口报 10/17/1 对）。这是 issue #35 的 detector 部分（L3 拆出的确定性规则违反检测器）。

引擎侧间距约束（`REPULSION_MIN_DIST` 仅 1.36m + repulsion 盲区）已另起 issue #53，等 #25 引擎大重构后做。本 change 只做 **detector 先暴露问题**：钉住「观察窗口内同队间距 < 2m」，等 #53 修引擎后告警归零。

## What Changes

新增 `player_overlap` detector（tools/detectors.mjs）：
- 读 `audit_input.players` 快照的 `x/y/t`，team 按 id 范围推（0-10 home / 11-21 away，与 protocol.js / derive-audit-features 的 `teamOf` 一致）。
- 阈值 `min_distance: 2.0`（profile 配置）。
- **按「球员对」聚合**：一个同队 pair 在窗口内任一时点间距 < 阈值 → 报一条 finding（不逐采样点刷屏）。
- severity = `realism_warning`（观感问题，非硬规则 bug——区别于罚下球员的 `invariant_violation`）。

## Capabilities

### Modified Capabilities

- `diagnosis-runner`: 新增 `player_overlap` detector + 字段契约清单登记。

## Impact

- `tools/detectors.mjs`（新 detector + runAudit 集成 + profile 配置）
- `tools/detector-field-contract.mjs`（登记 player_overlap 条目）
- `tools/detectors.test.mjs`（真实 fixture 断言现状有告警 + 阈值边界）
- 不碰引擎、viewer（引擎侧归 #53）

## 关联

- 修复 issue #35 的 detector 部分；引擎侧间距约束归 #53（等 #25）
