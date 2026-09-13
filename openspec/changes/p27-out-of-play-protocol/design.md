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

### D3: 内部几何不 clamp（variantC，用户已批准）

- **事件字段** `out_pos` 发**真实越界值**（可 <0/>1），`x2/y2` 发场内投影点（∈[0,1]）——D2 的双坐标语义达成。
- **模拟内部**：`HighlightOutcome::PassOutOfPlay.out_pos` 存真实越界值；但**两个回灌模拟的消费点**
  （`highlight_ball_end` → 飞行期 `st.ball_pos`；`finalize_highlight` → `st.ball_pos` 与重开锚）
  显式 `clamp01` 回场内。否则队形目标越界会经 `nearest_*` 阈值级联改写全流。
- **飞行时长用投影点近似**（`flight` 仍按 `(x2,y2)` 算，而非真实终点）——这是 variantC 的**既定取舍**，
  目的见 D6。`finalize_highlight` 的重开归属仍用 `detail`（不变），阶段 2/3 再改由 `out_side` 驱动。

> **为何偏离原文「飞行时间/方向计算用真实终点」（用户已批准）**：`flight` 决定 `t_end`（=事件时序）
> 与飞行期 beat 数，改它必然破 D6 的「事件数量/时序逐 seed 与 v1 一致」。用户把 D6 标为硬验收，
> 故 D6 优先，飞行时长改用投影点近似。实测数据（探针）：raw 终点算 flight → 2-3/10 seed 事件数漂移；
> out_pos 存 raw 而不 clamp → 5/10 seed 漂移；两点 clamp 后 → 0/10。见 `.p27-progress.md §2`。
> 阶段 2/3 若要「涌现出界」（几何真正回灌），需移除这两处 clamp 并使用真实终点，届时本就该重基线。

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
- `MatchConfig` 加 `model_version` 字段（`default_()` = `MODEL_VERSION`=2）。golden 测试按版本目录读写（`model_version` → 目录名）。
  **注**：该字段目前**只用于 golden 目录选择**，不切换引擎行为（同一引擎代码对 v1/v2 都跑出同一事件流；
  v1 基线是 P27 之前的引擎产物，由 git 历史冻结）。真正的「按版本切换行为」不在本 change 范围。

### D6: 确定性边界

本 change 只改「出界 pass 事件的字段值 + 加字段」，**不改变 RNG 消费顺序**（`raw_x/raw_y` 的随机抽样顺序不变，只是不再 clamp 后丢弃）。因此事件数量、事件时序、比分全部不变，只有出界 pass 的 JSON 字段值变 → 流哈希变 → v2 golden 重基线。

**variantC 既定取舍（用户已批准）**：`flight`（飞行时长）用**投影点 `(x2,y2)` 近似**，不用真实越界终点。
`flight` 决定 `t_end`（事件时序）与飞行期 beat 数，改它必然破 D6 的「事件数量/时序逐 seed 与 v1 一致」。
同理，`out_pos` 虽存真实越界值，但在两个回灌模拟的消费点（`highlight_ball_end` / `finalize_highlight`）
clamp01 回场内。两者都是为保 D6 而**有意**牺牲 D3 的「飞行用真实终点」，不是实现遗漏。

**验收**：`engine/tests/realism.rs::gm_v1_regression_counts_unchanged` 把这条固化成测试——逐 seed 对比
v1 基线，28 个计数字段（事件数/类型分布/比分/出界计数）必须全等、`stream_hash` 必须不同。
更细的逐字段证据：`node tools/d6-stream-compare.mjs <pre.wasm> <post.wasm> <s0> <s1>`
（实测 seed 1-200：1,163,397 事件、1,322 出界事件，事件数不一致 seed = 0，非出界字段差异 = 0）。

## 验收

- `./verify.sh` 全绿（引擎单测 + viewer + tools + WASM e2e + realism）。
- 出界 pass 事件：`result=out`、`out_side` 正确、`x2/y2 ∈[0,1]`、`out_pos` 可越界。
- 出界触发概率/重开归属/RNG 顺序不变（事件数量逐 seed 对比 v1 一致，只有出界 pass 字段值变）。
- detector 新 bundle 走 `result='out'` 主路径，旧 bundle（detail）仍判出界。
- v2 golden 重基线，v1 保留。
