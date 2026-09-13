# Proposal: 出界事件协议迁移（#25 阶段 1）

## Why

出界传球现在是「语义错位」：`result:"contested"`（争抢）+ `detail:"out_sideline"/"out_goal_line"`（唯一线索）+ 落点被 `clamp01` 钳回边界线（真实越界坐标丢失）。detector 只能靠 `detail` 字符串猜出界（P21 治标），viewer 协议坐标必须 ∈[0,1] 却拿不到「球实际飞出多远」的几何证据。

这是 issue #25（引擎涌现重构）的**阶段 1**：先把出界事件的协议改对（显式 `out` + 真实越界坐标 + 出界边），为阶段 2/3 的「涌现出界」（传球落点误差自然导致出界）铺路。方向已由用户拍板（频率走 C 路、5 分钟真实时间），见 `.scratch/issues/25-emergent-engine-design.md`。

## What Changes

**出界 pass 事件**（`emit_pass_out_play_slot` 的 corner/throw_in 槽 + P6 普通传球出界 + 头球解围出界）改发：

| 字段 | 旧 | 新 |
|---|---|---|
| `result` | `"contested"` | `"out"` |
| `out_side` | （无） | `"goal_line"` \| `"sideline"` |
| `x2/y2` | clamp 后边界点 | **保留**场内投影（协议 ∈[0,1] 不破） |
| `out_pos` | （内部 `out_pos` 存 clamp 值） | 真实越界坐标（不 clamp） |

**不改**：
- 射门 `off_target`（它走「打飞 → 门球」，不是出界 pass，不加 out 字段）
- 门球/角球发球 pass 的 `result:"contested"`（那是真「争抢落点」，不是出界）
- 出界触发概率、重开归属、RNG 消费顺序（codex 验收边界：只改协议字段，不改事件数量）

## Capabilities

### Modified Capabilities

- `event-stream-protocol`: 出界 pass 事件新增 `out_side`/`out_pos` 字段，`result` 增 `out` 值。
- `diagnosis-runner`: detector 出界证据优先读显式 `result='out'`（P21 的 detail 治标保留作兼容分支）。

## Impact

- `engine/src/lib.rs`（`emit_pass_out_play_slot` / P6 普通传球出界 / 头球解围出界：result 改 out、加 out_side、out_pos 存真实值、Event struct 加 out_pos 字段 + to_json 输出）
- `viewer/protocol.js`（pass detail 校验补 `out_side` 枚举；不校验 result 取值故无破坏）
- `tools/detectors.mjs`（`outEvidenceOf` 优先 `result='out'`；`classifyPassOutcome` 同步）
- golden：v1 保留，v2 新基线目录（`engine/tests/golden-v2/`）

## 关联

- #25 阶段 1；P21 的 detail 治标在此可简化的前提；golden 策略见阶段 0
