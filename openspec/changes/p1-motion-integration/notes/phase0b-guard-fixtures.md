# Phase 0-B / 2.2：p53 / p31 / p6 / p32 不变量夹具

日期：2026-11-25
分支：`p1-phase0b/2026-11-25`（基于 main `4428ccc`）
改动面：**只改 `#[cfg(test)]` 段内的测试**（`engine/src/lib.rs` 测试模块）；
`git diff` 的所有 hunk 都从测试模块（`#[cfg(test)] mod tests`，行 7933 之后）开始——
**生产代码零 diff**、`viewer/` 零改动、引擎常量/判据未动。

口径：把「依赖固定 seed / 某条事件链恰好出现」的脆弱夹具，换成
「**显式构造场景 + 条件断言 + 多 seed 有界性**」，并保留原契约。

## 1. p53 同队间距

### 旧夹具的问题

- `p53_same_team_spacing_ge_2m` / `p53_same_team_spacing_holds_between_anchors`：
  扫 10/8 个 seed 的整场事件流，断言「最坏同队间距贴着阈值（`worst < 阈值+0.05/0.15`）」。
  这是**活体抽样**：运动层一改（重叠变少）就会因为「没有贴近阈值的 pair」而假红，
  即使分离契约完好。
- 端点违规 / 拍内对穿这两个契约本身没有确定性的直接用例（只能靠整场撞见）。

### 新构造夹具（`engine/src/lib.rs` 测试模块）

辅助 `spacing_scene(...)`：22 人沿 x 排开、相邻同队 pair 间距 2.625m（≥ 阈值），
再把同队 id 1/2 放成指定起点/终点——不依赖任何 seed。

| 用例 | 构造 | 断言（契约） |
|---|---|---|
| `p53_constructed_endpoint_contract` | id1/id2 **终点**相距 1.36m（y 轴 0.02 归一化，<2.2m） | 分离后米制终点间距 ≥ `SAME_TEAM_MIN_DIST_M − EPS`；同输入二次调用**幂等**（扫到无改动即停） |
| `p53_constructed_sweep_contract` | id1/id2 本拍**路径对穿**：起终点均相距 52.5m、线性插值中点重合（0m） | 拍中（线性插值）间距 ≥ `SAME_TEAM_SWEPT_MIN_M`（2.14m）且 > detector 门 2.0m；**只做侧向推移**（沿球场方向位移 ≤1mm，y 向相反侧） |
| `p53_constructed_sweep_start_unresolvable` | **起点**本身 < 扫掠阈值 | 本拍无解、终点原样返回（已知残留契约，不得硬推） |

保留的原契约：端点 ≥2.2m（含序列化余量）、拍内扫掠 ≥2.14m（detector strict `<2.0m`）、
「只做侧向推移」、起点不可动、solver 幂等。原两条多 seed 整场扫描**保留为安全网**，
但按 P0B-M2：只保留「不得违反间距 / 高于 detector 门 / 样本量」等不变量；
`worst < 阈值+0.05/0.15` 的上界条件已移除，`worst` 改为 `println!` 报告
（「solver 会处理违规输入」已由上面的确定性构造证明）。

## 2. p31 liveness

### 旧夹具的问题

`p31_liveness_stages_reachable_and_pulls_back` 跑 **40 场**，断言「停滞恰好达到一档/二档」。
停滞是否出现是**事件抽样结果**：运动层改善后停滞减少，就会假红，即使三档护栏完好。

### 新夹具

同名测试重写为三段：

1. **三档可达（确定性构造）**：构造无压后场持球状态，把停滞计时置于 1/2/3 档界，
   走**生产接入点** `open_action_opportunity`，断言：
   - `liveness_stage_hits[i] == 1`（三档各自被记录一次）；
   - deadline **逐档压缩**（`deadline < last_deadline`），且三档后仍 ≥ `MIN_ACTION_DEADLINE_TICKS`；
   - `liveness_deadline_pressure_max > 0`（实际应用量非零）。
2. **拉回（确定性构造）**：停滞二档 + 无压，驱动 `advance_action_opportunity` 到自然 deadline
   到期，断言选出 `CarrierAction::Pass`；执行 `execute_action_resolution` 后
   `ticks_since_meaningful_action == 0`（出球把比赛拉回）。
3. **多 seed 只守有界性**：8 seed 跑整场，断言停滞上限
   `liveness_max_ticks ≤ LIVENESS_STAGE_3_TICKS + 8s`；是否达到某档只 `println!` 报告，
   **不再作门**。

保留的原契约：三档阈值/阶跃不变、deadline 压缩不变、二档无压必出球、出球后计时归零、
停滞不会无限增长。**「可达性」不再是概率性断言**——构造用例直接覆盖。

## 3. p6 角球双追

### 旧夹具的问题

`p6_corner_battle_double_chase` 扫 80 个 seed 找第一个角球：

- 没角球 → `panic!`（样本依赖）；
- 有角球但没找到松散球 beat → **静默通过**（断言写在 `if let Some(b)` 里）——
  契约实际上可能从未被检查。

### 新夹具

同名测试改为显式构造 `MatchState`：

- 铺开两队外场，指定 home id4（离落点 33.6m）与 away id14（~13.1m）为最近者；
- `start_battle_loose` 后断言 `loose.battle == Some((4, 14))`（loose 启动时固定）；
- 连续 3 拍 `advance_loose`：断言 battle 双追逐者身份**不漂移**、球仍在滚、
  每拍 beat 的 `movers` 含 **≥2 个 `action=chase`** 且 id14 在其中（防方固定 chaser 追落点）；
- 构造距离保证 3 拍内不会拾取（不会被「已经结束」掩盖）。

保留的原契约：角球 battle 必须攻防各 1 名 chaser、**双 chase**、防方 chaser 固定。
新用例不再依赖 seed，也不会静默跳过。

## 4. p32 拦截自洽

### 旧夹具的问题

旧 `p32_interception_self_consistency` 聚合 **400 场**全量样本做二项自洽。判据是恒等式，
但 95% CI 会因 RNG 流变化出现抽样波动——历史上远距桶越界后只能靠**加倍样本**
（200→400）复绿，成本高且 RNG 再变就可能重演。

### 新夹具（三层）

1. **确定性恒等** `p32_interception_roll_contract_constructed`：
   3 个落点距离档 × 3 个传球长度层，每格**完整枚举 `fail_roll` 0..99**，
   走生产记账 `note_interception_roll`，断言：
   - 期望宽度 = `ceil(p)`（贴防/中距/远距 × 非长传/长传/超长 = 8/15/23、5/12/20、2/9/17）；
   - 期望拦截数 = `width × 100`、实际命中 = `width`（条件恒等，与 seed 无关）；
   - 长传/超长分层与 very⊆long 嵌套；
   - 充足样本下 `assert_interception_self_consistent` 必须 `Ok`；样本不足必须
     `Err("insufficient_sample")`（不静默绿）。
2. **决策分支 ↔ 记账一致性**（P0B-M3 补强）`p32_interception_branch_matches_bookkeeping`：
   直接调用**生产决策路径** `emit_pass_highlight_inner`（`allow_out=false`），64 seed
   各产一次真实传球，断言 `intercept_roll_actual == 1` ⇔ `pass.result == "intercepted"`，
   并要求 hits > 0 且 misses > 0（否则「恒真/恒假」变异会漏网）。这条覆盖的是
   「记账器对、但实际拦截分支断开/反接」——helper 恒等发现不了。
3. **接线守卫** `p32_interception_self_consistency`（8 seed 小样本）：
   - 记账点真实命中：`intercept_roll_samples > 0`、`actual > 0`、三桶样本 > 0；
   - 分桶样本/预期之和 == 总数；
   - **条件自洽**：样本 ≥ `P32_MIN_BUCKET_SAMPLES` 时必须 `Ok`，不足时必须显式
     `insufficient_sample`；至少全局/主桶完成一次自洽检查；
   - 分层字段活性：长传样本 > 0、`long_actual ≤ long_samples`、very⊆long。

保留的原契约：`ceil(p)` 量化、逐桶自洽、样本不足显式 `insufficient_sample`、
LONG / VERY_LONG 加成各自可杀、非常量接线。`p32_interception_roll_width_quantizes_by_ceil`
（纯函数）原样保留。三个距离桶在上面的构造用例里都被直接喂满 100 个 roll（不依赖自然样本量）。

## 5. 定向变异（每条都先红、后还原）

方法：临时改**生产代码**去掉契约 → 跑目标测试 → 确认 `FAILED` 且 `panicked at` 来自该测试
（排除编译失败）→ 还原。还原后 `git diff` 的 hunk 全部落在测试模块内（生产零 diff）。

| # | 变异 | 目标测试 | 结果 |
|---|---|---|---|
| M1 | `same_team_ok_m` 恒 `true`（删端点分离判定） | `p53_constructed_endpoint_contract` | **红**（分离后仍 1.36m < 2.2m） |
| M2 | `stalled_unpressed = false`（删「二档无压→出球」拉回契约） | `p31_liveness_stages_reachable_and_pulls_back` | **红**（二档却未选出 Pass） |
| M3 | `interception_roll_width` 的 `ceil` → `floor`（改量化契约） | `p32_interception_roll_contract_constructed` | **红**（期望宽度 8/15/23 对不上） |
| M4 | 角球 battle 防方 chaser 的 `action` `chase` → `run`（删双追逐） | `p6_corner_battle_double_chase` | **红**（beat 里 chase < 2） |
| M5 | 实际拦截分支断开：`if fail_roll < interception_p` → `if false` | `p32_interception_branch_matches_bookkeeping` | **红**（记账 actual=1 但事件非 intercepted） |
| M6 | 拦截概率 ×10：`open_play_interception_p_dir` 返回值 `×10` | `p32_interception_roll_contract_constructed` | **红**（期望宽度 8/15/23 → 80/150/230） |
| M7 | 单桶漏记：`note_interception_roll` 对 `bucket == 2` 直接 `return` | `p32_interception_roll_contract_constructed` + `p32_interception_self_consistency` | **双双红**（远距桶样本 0 / 分桶和≠总数） |

**还原证明**：`git diff -U0 engine/src/lib.rs` 的 hunk 起始行全部 ≥ 9200（测试模块从 7933 开始）；
生产函数（`same_team_ok_m`、`stalled_unpressed`、`interception_roll_width`、
`battle_def_chaser` 分支、`emit_pass_highlight_inner` 的拦截分支、`open_play_interception_p_dir`、
`note_interception_roll`）无 diff。生产段逐字节相同另由验证步的 sha 对比确认。

## 6. 验证

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd engine
cargo test --lib p53      # 14 passed; 0 failed（39.01s）
cargo test --lib p31      # 20 passed; 0 failed（44.12s）
cargo test --lib p6       # 17 passed; 0 failed（50.39s）
cargo test --lib p32      # 4 passed; 0 failed（11.72s）
cargo test --release --test realism -- --ignored l1_tackle_dilution_and_slot_mix
# 1 passed; 0 failed; 16 filtered out（165.12s）——见 phase0b-corner-band.md
```

测试成本变化：p32 全量样本 400 seed → 8 seed 接线 + 确定性构造；p31 可达性 40 seed → 构造
（多 seed 只留 8 seed 有界性）。契约不变、抗 RNG 流变化。

## 7. 残余风险

- `p31_all_four_liveness_hooks_are_live` 仍是 8 seed 的**接线**观测（四个接入点在真实比赛里
  必须被读到非零），本 change 未动它；它不是「可达性门」，但若运动层彻底消灭停滞，
  该接线观测会变弱。已由构造用例覆盖「档位逻辑可达」，两者的分工在测试注释里写明。
- p53 的两条多 seed 整场扫描保留为安全网：**下界/ detector 门/样本量**不变；
  「最坏值贴近阈值」的上界条件已按 P0B-M2 移除，改为 `println!` 报告——它依赖「本场恰好
  出现近阈值重叠」的事件抽样，运动层一改就会假红。「solver 会处理违规输入」由确定性构造
  用例证明，整场扫描只守安全不变量。
