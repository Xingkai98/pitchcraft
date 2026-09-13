# Design: 出界事件协议迁移（#25 阶段 1）

## Context

#25 阶段 1。出界 pass 语义错位（`result=contested` + clamp 丢失越界几何）。方向已拍板：频率 C 路 + 5 分钟真实时间，见 `.scratch/issues/25-emergent-engine-design.md`。

## Goals / Non-Goals

**Goals:**
- 出界 pass 发显式 `result="out"` + `out_side` + 真实越界 `out_pos`。
- detector 出界证据优先读显式 out（P21 detail 治标保留兼容）。
- 不改变出界触发概率、重开归属、RNG 消费顺序（codex 验收边界）。

**Non-Goals:**
- 不改射门 off_target（走门球，不是出界 pass）。
- 不改门球/角球发球的 `result=contested`（真争抢落点）。
- 不做「涌现出界」（传球落点误差）——那是 #25 阶段 2/3。

## Decisions

### D1: result 语义区分

- 出界 pass：`result="out"`。
- 门球/角球发球 pass：`result="contested"` **保留**（这是「落点是争抢点」语义，不是出界）。
- 普通传球出界（P6 批次1 `emit_pass_highlight` 里 `allow_out` 分支）与头球解围出界（`clearance` 分支）同样改 `result="out"`。

### D2: 双坐标语义（不破 viewer 协议）

- `x2/y2`：保留 clamp 后边界投影点（∈[0,1]，viewer 渲染飞行终点）。
- 新增 `out_pos`：真实越界坐标（`raw_x/raw_y`，可 <0 或 >1），Event struct 加字段。
- `out_side`：`"goal_line"`（底线）| `"sideline"`（边线），由出界点哪条边越界判定。

### D3: 内部几何不 clamp

`HighlightOutcome::PassOutOfPlay.out_pos` 从「clamp 后值」改为「真实越界值」。飞行时间/方向计算用真实终点，事件渲染用 `x2/y2` 投影点。`finalize_highlight` 的重开归属仍用 `detail`（不变），后续阶段 2/3 再改由 `out_side` 驱动。

### D4: detector 出界证据优先显式 out

`outEvidenceOf` 判定顺序改为：
1. `result === 'out'` → `'event.result'`（主路径）
2. `out_side` 存在 → `'event.out_side'`（新字段兜底，阶段 2/3 用）
3. `detail === 'out_sideline'|'out_goal_line'` → `'event.detail'`（P21 兼容分支，旧 bundle）
4. 几何出界 → `'landing_out_of_bounds'`（防御）

`classifyPassOutcome` 同步。这样旧 bundle（只有 detail）仍能判出界，新 bundle（有 result=out）走主路径。

### D5: golden 版本分离

- 旧基线 `engine/tests/golden/seed-*.json` 保留（v1）。
- 新基线 `engine/tests/golden-v2/seed-*.json`（本 change 出界协议变化导致流哈希变）。
- `MatchConfig` 加 `model_version` 字段（默认 v1，本 change 后 simulate 走 v2 输出）。golden 测试按版本目录读写。

### D6: 确定性边界

本 change 只改「出界 pass 事件的字段值 + 加字段」，**不改变 RNG 消费顺序**（`raw_x/raw_y` 的随机抽样顺序不变，只是不再 clamp 后丢弃）。因此事件数量、事件时序、比分全部不变，只有出界 pass 的 JSON 字段值变 → 流哈希变 → v2 golden 重基线。

## 验收

- `./verify.sh` 全绿（引擎单测 + viewer + tools + WASM e2e + realism）。
- 出界 pass 事件：`result=out`、`out_side` 正确、`x2/y2 ∈[0,1]`、`out_pos` 可越界。
- 出界触发概率/重开归属/RNG 顺序不变（事件数量逐 seed 对比 v1 一致，只有出界 pass 字段值变）。
- detector 新 bundle 走 `result='out'` 主路径，旧 bundle（detail）仍判出界。
- v2 golden 重基线，v1 保留。
