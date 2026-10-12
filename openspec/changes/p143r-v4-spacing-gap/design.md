# Design: 高亮结束那一拍的分离视野缝隙（#149）

## D0. 目标与判据

**改什么**：让高亮参与者「**抵达落点并原地保持**」的那段显示轨迹**按需**进入同队分离 solver 的
视野，使 `tools/spacing-sweep.mjs` 默认 8 seed 归零，且**不动任何阈值 / 统计带**、L1 保持 9/9。

**判据**（门槛，缺一不可）：
1. `node tools/spacing-sweep.mjs`（默认 8 seed 42/1/2/3/7/59/18/94）→ **全 0**（本 change 验收核心）。
2. `cargo test`（默认全量）全绿。
3. `cargo test --test realism --release -- --ignored` L1 **9/9**。
4. `cd viewer && node e2e-v2.mjs` 无 snap + viewer/tools 单测全绿。
5. **反证**：撤掉修法 → `node tools/spacing-sweep.mjs 2` 回红（贴 exit code）。

**记录口径**（本仓头号纪律）：wasm sha16 + 事件流哈希 + **seed 区间 + 时长 + 源码状态**。
对照 wasm：修前 `574b653f7d8e`（= main B），修后 `e3b3e89f`（窄触发版，见 §D4）。

## D1. ★ 真机制（订正 §9.6；探针 + 数值双证）

### D1.1 复现（seed 2）

`node tools/spacing-sweep.mjs 2` → `player_overlap findings=5 worst=1.957m`（修前 `574b653f7d8e`）。
detector 报 `first_breach_time=4567.5`，pair away `11↔18`。

### D1.2 时序重建（探针 `viewer/zz_probe_seed2.mjs`，同 sweep 管线）

| t | 事件 | 关键位置 |
|---|---|---|
| 4566 | `pass` subj=12 → to=11，`speed` 由引擎 RNG 抽（`12.0 + rng%130/10`），落点 `(0.2291,0.5164)` | 接球者 11 动作前 `rx/ry=(0.2468,0.6416)`；飞行时长 = 距离 ÷ 速度 = **1.1559s** ⇒ `t_end=4567.156` |
| 4566 | beat（飞行）| mover 18: `(0.1848,0.4830)→(0.2186,0.5007)` |
| 4567 | beat（飞行）| mover 18: `(0.2186,0.5007)→(0.2631,0.4874)` |
| 4568 | beat | `main subj=11 (0.2291,0.5164)→(…)`（finalize 已把 11 放落点） |

- viewer 给 11 的两个锚点：`t=4566`（动作前）→ `t=4567.156`（落点），之后**保持**到 `t=4568`
  的 main 锚点 ⇒ **11 在 `[4567.156, 4568]` 一直停在落点**。
- detector 采样步长 `VIEWER_DERIVATION.sample_step = 0.5s`，窗口 ±5s ⇒ 采样点落在整/半秒网格。
  违规采样点 = **4567.5**（落在保持段内）。

### D1.3 为什么 solver 没修（数值，`/tmp/zz_calc.mjs`）

引擎在 tick 4567 的模型（`highlight_frozen_segs`）把 11 的显示建模为**均匀拉伸**的本拍子段：

- 11 段 = `[lerp(u(4567)), lerp(u(4568))]` = `[(24.306,36.263), 落点(24.056,35.115)]`（米）
- 18 段 = `[(22.953,34.048), (27.626,33.143)]`

`sweep_pair_lateral` 的「同步参数最近点」（把两人当作**同样地**在拍内线性插值）算得
**2.1462m ≥ `SAME_TEAM_SWEPT_MIN_M`(2.14)** ⇒ **判定无冲突、不推**。

但 viewer 真实显示是「拍中即抵达落点并**保持**」，不是均匀拉伸：参与者 11 的真实显示最近点
（对 τ∈[0,1] 取 min）= **1.2577m**（在 τ=0.185 处）⇒ **solver 口径 2.146 vs viewer 真实 1.258**。

⚠️ **真正的触发点**：mover 18 在**该拍起点**（tick 4567 的 `starts`，**起点不可动**）距落点仅
**1.535m < 2.14**；而 18 的起点 = 它在**上一拍（4566）的终点**。上一拍只按「本拍子段终点
`lerp(u(4567))`」算最近点（=2.598m ≥ 阈值），**看不见落点** ⇒ 18 的终点被允许落在落点近旁
⇒ 下一拍起点越界、起点不可动 ⇒ 整拍残留。**根因 = 落点（参与者将要占据并保持的位置）没进
solver 的约束——尤其没进「上一拍终点 = 下一拍起点」这条跨拍耦合。**

### D1.4 ★ 订正 §9.6（「结论对、机制错」）

§9.6 称根因是「`sweep_pair_lateral` 对**起点已 < `SAME_TEAM_SWEPT_MIN_M`** 的 pair 原样返回」。
**实测不成立**：该 pair 在 tick 4567 的**起点距离** = `dist(lerp(u(4567)), 18.from)` = **2.5964m
≥ 2.14m**，早返回分支（`if same_team_dist_m(a0,b0) < SAME_TEAM_SWEPT_MIN_M`）**未触发**。
真因是 §D1.3 的「均匀拉伸时序 + 落点未入视野」。结论（要修缝）不变，机制描述按实测定正。

## D2. 修法（窄触发；最小、有原则）

**单点改动**：`engine/src/lib.rs` 的 `highlight_frozen_segs` 一处（+ 一个 `point_seg_dist_m`
辅助 + 常量 `SAME_TEAM_OVERLAP_MIN_M = 2.0`）。

**触发**（`breach`）：对每个高亮参与者，**只在**「参与者的落点 `end` 真落在某**同队** mover
本拍轨迹 `[from, to]` 的 `SAME_TEAM_OVERLAP_MIN_M`(2.0m，= detector `player_overlap.min_distance`)
内」时才介入。触发后按 `t_end` 相对本拍分两档：

```rust
let t_rem = h.t_end - t;
let completes_mid_tick = t_rem < TICK_SECONDS;                            // 严格本拍内完成（有保持段）
let completes_mid_next = t_rem > TICK_SECONDS && t_rem < 2.0 * TICK_SECONDS; // 下一拍内完成
let breach = movers.iter().any(|m| m.id <= 21 && ((m.id <= 10) == (id <= 10))
    && point_seg_dist_m(end, (m.from_x, m.from_y), (m.to_x, m.to_y)) < SAME_TEAM_OVERLAP_MIN_M);
let (from, to) = if breach && completes_mid_tick {
    (end, end)                                        // 保持拍：落点退化为一点
} else if breach && completes_mid_next {
    (lerp(start, end, u(t)), end)                     // 跨拍约束：终点钉落点
} else {
    (lerp(start, end, u(t)), lerp(start, end, u(t + TICK_SECONDS)))  // 原口径
};
```

**为什么窄触发（正确修 ≠ 必最大扰动）**：缝隙的机制是「mover 的下一拍起点离落点过近」，
起点不可动 ⇒ 必须在**上一拍**把 mover 终点推开（跨拍约束，见 §D1.3）。若**无条件**加这条约束
（早期变体），含近失的**任意 seed** 都触发 —— L1 区间实测有 ~2.2m 量级推移，把**贴沿**的
`l3_shot_ratios`（下界 0.72，main 余量仅 +0.0013）顶破。把触发收到 **detector 真实门 2.0m**
（真越界才改），扰动只落在**真会破阈**的比赛上 ⇒ `l3` 保住（§D4）。

**分档为什么「严格」**：`t_end == t+TICK`（如**抢断**，`t_end = t + TICK`）是「滑行恰好占满整拍、
无保持段」——当保持拍会丢掉参与者**起点侧**的扫掠覆盖。**对照（非严格变体）**：`t_rem <= TICK`
走保持拍的那个构建（wasm `/tmp/engine-fix-dprime.wasm`）在 seed 18 **新造缝隙**——`node
viewer/zz_sweep1.mjs /tmp/engine-fix-dprime.wasm 18` → `pair 5,9: min=1.681 first_breach=242.5`；
本 change 的**严格**版（`t_rem < TICK`）同一命令 seed 18 = **no findings**。故该情形退回原口径。

**覆盖边界（如实记，不加约束）**：保持拍把落点退化为一点后，本拍 mover 的**起点侧**：本拍起点
= 上一拍终点，恒被逼离落点 ≥ **detector 阈值 2.0m**（上一拍也走破阈档时 ≥ 引擎目标 2.14m；
两档都 ≥ 2.0m）；但本拍 mover 轨迹**内部**对「滑行尾段 `[lerp(u(t)), end]`」**无显式约束**
（欠约束上界 = 尾段长 = `(t_rem/span)·|glide|`；单拍飞行时无上一拍、尾段即整段）。
**未观测到越界**：默认 8 seed 全 0；默认集外**修法真正触发**的 seed（20/23/26/27/29，审阅补跑）
全 0；L1 触发 seed（425/450/575）整场 sweep 结果见 §D4。**不据此加约束**——加会顶破贴沿带
`l3_shot_ratios`（§D2）。

> **读数口径**：本文所有「最近点」读数（如 2.9216 / 1.957）均为 **detector 同口径**（0.5s 采样、
> `VIEWER_DERIVATION.sample_step`），与 detector 判据可直接对照；连续时间最近点更低（seed 2 修前
> 连续 min = 1.2577m，见 §D1.3），但 detector 只看采样点，故以采样口径为准记录。

**SHALL NOT**：不放宽任何阈值；不动 detector 门 / 统计带；不动事件层常数；不动 viewer；
不动 `sweep_pair_lateral` 的既有豁免口径。是**新增一条按需约束**。零 RNG、确定性。

### D2.1 备选与取舍（实跑对照，均 seed 2 单 point）

| 变体 | 做法 | seed 2 修后最近点 | l3 | 结论 |
|---|---|---|---|---|
| （旧） | 本拍子段终点 | 1.957m（红） | 绿 | 基线 |
| 无条件延伸（`D'`） | 所有滑行将被完成拍钉落点 + 保持拍退化 | 2.9216m（绿） | **0.720 红** | 扰动过宽 |
| 仅延伸 / 仅保持拍 | —— | 1.651 / 0.641（更差） | 绿 | 单腿不成立 |
| **窄触发（本 change）** | **真越界(<2.0m)才介入** | **2.9216m（绿）** | **0.721 绿** | ✅ 采用 |

> **口径注**：表里的「修后最近点」是 **detector 采样口径**（`sample_step=0.5s` 网格上 t=4567.5 的
> 距离 = 2.9216m）——即**验收门看到的那个数**；同一拍的**连续口径**真值为 **2.1564m**（离 detector
> 阈 2.0 仅余 0.156m）。两者都绿；记此以免把采样值当连续真值（审阅 P3-5，先于本 change 的既有口径）。

**候选 (b)（让 `sweep_pair_lateral` 对「起点近失」做有限修正）不适用**：本 pair 起点距 2.596m
≥ 2.14m，「起点近失」分支未触发（§D1.4）。

## D3. 行为变更 / 爆炸半径（实测）

**churn（`viewer/zz_churn.mjs`，修前 `574b653f` vs 窄触发 `e3b3e89f`；含 mover 逐坐标真实位移）**：

| 区间 | seed | 计数差 | 逐槽差异 | mover 最大位移（归一化） |
|---|---|---|---|---|
| 触发 seed | 2 | **beat+1/pass−8/foul−1/shot+3** | 结构性 | 结构性 |
| golden 1..10 | 1,3,4,5,6,7,8,9,10 | 无 | **0** | **0**（bit-identical） |
| golden | 2 | 见上 | 结构性 | — |
| L1 401..600（抽样） | 425 / 450 / 575 | 无 | 5 / 3 / 3 槽 | 6.9e-3 / 2.2e-2 / 3.2e-3 |
| L1 401..600（抽样） | 401,475,500,525,550,600 | 无 | **0** | **0** |

⇒ 窄触发把扰动压到**只在真越界的比赛**上：golden 1..10 里**只有触发 seed 2 变**，其余
**逐字节不变**（golden 重基线只动 seed-2.json）；L1 区间只有少数 seed 微动（无计数变更）。

**golden-v8**：**只 seed 2 变**（结构性，n_events 6301→6296 / n_pass 860→852 / n_shot 22→25，
见 §D4 的 diff 摘要）⇒ 照规 `ACCEPT_GOLDEN=1` 重基线。
**p15 截断形态 seed**：`TRUNCATION_FORM_SEEDS=[51,103,244]` **仍全部命中**（窄触发扰动足够小）
⇒ **无需重扫**。

## D4. 复验读数

**修后 wasm**：`f753b1777dfb4854`（窄触发；= 用于 §D4 全部读数的构建的**行为等价**重编——源码注释/新增 `#[cfg(test)]` 会改 wasm 文件哈希但**不改行为**，已用 `zz_churn` 核 `slotDiff=0`；记录读数所用的中间构建 = `e3b3e89fe47f6766`）。

| 判据 | 命令 | 读数 |
|---|---|---|
| **spacing（验收核心）** | `node tools/spacing-sweep.mjs` | **8 seed 全 0** |
| spacing（修法真正触发的非默认 seed） | `node tools/spacing-sweep.mjs 425 450 575`（L1 区间）+ `20 23 26 27 29`（审阅补跑） | **全 0** |
| **L1 9/9** | `cargo test --test realism --release -- --ignored` | **9 passed; 0 failed**（`l3_shot_ratios` 禁区占比 **0.721**，411/570） |
| 默认套件 | `cargo test`（--no-fail-fast） | 全绿（golden 重基线后；见下） |
| 端到端 | `cd viewer && node e2e-v2.mjs` | OK，**无 snap**（球 0.0079 / 球员 0.0151） |
| viewer 单测 | `node --test viewer/*.test.js` | 352/353（唯一红 = `app.test.js`，**环境缺 jsdom**，见 §D4c；非本次引入） |
| tools 单测 | `node --test tools/*.test.mjs` | 505/505（含基线哨兵 / 口径守护） |
| **反证** | 撤修法（换回 `574b653f`）→ `spacing-sweep.mjs 2` | **回红** |

**golden-v8 diff**（只 seed 2；`git diff` 全量）：`n_events 6301→6296`、`n_beats 5348→5349`、
`n_shot 22→25`、`n_shot_saved 4→5`、`n_shot_off 13→15`、`n_box 10→11`、`n_arc 8→9`、`n_far 1→2`、
`n_tackle_success 22→23`、`n_pass 860→852`、`n_pass_success 731→722`、`n_gk_pass 28→30`、
`n_out_sideline 20→19`、`n_foul 23→22`、`n_free_kick 23→22`、
`stream_hash → 14702323164668992722`。**其余 9 seed 逐字节不变。**

### D4c. 已知环境限制
- `viewer/app.test.js` 用 jsdom（唯一 devDependency）；本 worktree 的 `node_modules` 是指向主仓库
  的 symlink、而主仓库那份已自指损坏（`Too many levels of symbolic links`）⇒ 本地 jsdom 缺失、
  该用例 `ERR_MODULE_NOT_FOUND`。**CI 会 `npm ci` 装上 ⇒ 不受影响**（主仓库同一用例同样红，证非本次引入）。
