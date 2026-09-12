# Design: detector 阈值算子守卫

## Context

P21 的字段契约守卫钉「读的字段有没有生产者」，钉不住「怎么比较」。issue #38：阈值算子方向（`>`/`>=`/`<`/`<=`）改动全绿逃逸。本 change 加测试守卫，不改生产逻辑。

## Goals / Non-Goals

**Goals:**
- 每个阈值算子的方向被「等于阈值」样本钉死。
- 任何改判据/阈值/删分支让真实数据 finding 集合变化的行为，被 golden 签名兜住。

**Non-Goals:**
- 不改 detector 阈值本身（那归 #36 标定）。
- 不改生产逻辑、不重构 detector 为显式纯函数（留给 #34/#35 引入 detector 注册表时一并考虑）。

## Decisions

### D1: 双机制（边界 + golden 签名）

- **边界测试**（精确、可读、指向单一算子）：手写合成输入，样本值取「恰好等于阈值」，断言 `>` 不含等号、`>=` 含等号、`<`/`<=` 同理。
- **golden 签名**（宽网、防「改了没被测的那一处」）：对 7 个真实窗口记录 finding 集合（`label | detector_id | severity | event_index | entity_id`），逐条一致。

两者互补：边界测试读起来知道「哪条规则错了」，golden 签名保证「没有漏网的改动」。

### D2: 覆盖的阈值算子（P21 后 detectors.mjs 实际存在的判据）

| detector | 判据 | 方向 |
|---|---|---|
| unforced_out | `nearest_defender_distance > threshold` | 无压迫 = **严格大于** 8.0 |
| inactive_responsibility | `distance(...) >= stationary_epsilon`（跑段分割） | 移动 = **≥** 0.5 |
| inactive_responsibility | `static_duration < static_duration`（是否够久） | 告警 = **严格小于** 3.0（小于才 continue 跳过） |
| ignored_interception | `defenderArrival + margin < ballArrival` | 机会 = **严格小于** |
| pass_outcomes | `nearest_defender_distance > threshold`（unpressured 桶） | 同 unforced_out |

只测「方向敏感」的算子；类型守卫（`typeof x === 'number'`）与等值判断（`result === 'out'`）是 P21 已覆盖的契约，不重复。

### D3: golden 签名的稳定性

签名基于 `tools/fixtures/real-audit-input.json`（P21 落盘，逐字节可复现）。签名值由**当前正确实现**产出（14 条 finding，见实现时录制的快照），随本 change 写死进测试。fixture 本身不变，签名不会抖动；若未来有意改阈值（#36），需同时更新签名——这正是「改了就红」的预期代价。

### D4: 只放 detectors.test.mjs

边界用例与 golden 签名都放 `tools/detectors.test.mjs`（已有 real fixture 加载 helper 与 `runAudit` schema 注入包装，直接复用）。不新建文件，保持 #38 的「小」。
