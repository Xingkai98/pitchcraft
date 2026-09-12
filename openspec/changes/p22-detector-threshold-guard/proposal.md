# Proposal: detector 阈值算子守卫

## Why

P21 修好了「detector 读的字段有没有生产者」（字段契约），但**判据方向**（比较算子，如 `>` vs `>=`）没有任何守卫：把 `nearest_defender_distance > threshold` 改成 `>=` 或删除，所有测试全绿。P21 审阅 r10 独立确认该逃逸在 P21 合入**之前**就存在，属 detector **语义**而非字段契约（issue #38）。

阈值算子决定 detector 的边界行为：`>` 与 `>=` 在输入恰好等于阈值时产出的 finding 完全不同；`<` 改成 `>` 则判据整体反向。字段契约守卫钉的是「读了哪些字段」，钉不住「怎么比较」。需要独立机制。

## What Changes

两处纯测试新增（不改 `detectors.mjs` 生产逻辑）：

1. **边界测试**：对每个阈值算子，用「恰好等于阈值」的样本钉死方向。这类样本在真实 fixture 里几乎不可能出现（真实值连续、恰等于 8.0/3.0/0.5 等阈值的概率近零），故手写合成输入，断言「等于阈值时的判定」与算子方向一致。
2. **golden finding 签名（宽网）**：对 `tools/fixtures/real-audit-input.json` 的 7 个真实窗口，记录 `runAudit` 产出的 finding 集合（窗口 label + detector_id + severity + event_index + entity_id），断言逐条一致。任何「改判据方向、改阈值、删分支」只要让真实数据上的 finding 集合变化，测试当场红——防「改了阈值但现有边界测试没覆盖到的那一处」漏网。

## Capabilities

### Modified Capabilities

- `diagnosis-runner`: 确定性审计层的阈值算子方向获得测试守卫（边界 + golden 签名）。

## Impact

- `tools/detectors.test.mjs`（新增边界用例 + golden 签名用例）
- 不改 `tools/detectors.mjs` 生产逻辑、不碰引擎、不碰 viewer

## 关联

- 修复 issue #38；从 P21 审阅 r10 拆出
- 与 #36（ignored_interception 标定）同类——都属 detector 语义，但 #36 是要改阈值本身，本 change 只加「改了就红」的守卫
