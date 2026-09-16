# P34 独立零记忆审阅（review-paseo）

审阅对象：commit `1465c4b`（分支 `p34-same-team-spacing/2026-09-15`）。
审阅期间 HEAD 前进到 `5cf865e`（仅文档/spec/tasks 两个 commit，`git diff --stat 1465c4b HEAD -- engine/src engine/tests` 为空）
——**引擎源码与 `1465c4b` 逐字节一致**，本审阅的代码结论对两者同样成立；spec 轴结论以当前工作区（= `5cf865e`）为准。

**结论：不通过（P0 ×1、P1 ×3）**。核心实现方向正确、变异测试覆盖面良好，但
**「`player_overlap` finding 归零」这一验收结论不成立**：实现者只在 6–7 个手工挑的窗口上验证，
我按同一真实采集管线**逐窗口扫描整场**后发现多 seed 的**真实越界**（最低 **0.718m**，阈值 2.0m），
且其中三条有明确的代码根因。详见 A4/B4/P0-1。

---

## A 轴：Spec 符合性

### A1. delta spec 的 Requirement/Scenario 覆盖 —— **部分不满足**

| Scenario | 实现 | 测试是否真能抓变异 |
|---|---|---|
| 整场无同队重叠 | ✅ 端点统一分离 | ⚠️ `p53_same_team_spacing_ge_2m` 只扫**发射端点**（lineup / mover.to / main.x2y2），**不扫拍内中点** — 见 A4 |
| 米制口径 | ✅ `same_team_dist_m`/`separate_pair_m` 全米制 | ✅ 变红（MUT3 5 红；MUT1 1 红）|
| carrier 参与分离 | ✅ `beat_movers_main` + `sync_main_after_commit` | ✅ MUT2 变红 |
| 特殊站位兜底 | ✅ 特殊目标经 `compute_mover_candidates` → 统一分离 | ⚠️ 无直接单测 |
| **拍内扫掠** | ⚠️ 实现存在，但**有三类漏网** | ❌ **无任何单测**（MUT4 关闭整个扫掠，p53/p5 全绿）|
| 分离位移有界 | ✅ 每拍预算 + `p5_approach_cap` | ✅ 有断言 |
| 零 RNG 确定性 | ✅ 分离函数体内零 `rng`/`next_u64`（已 grep 复核）| ✅ golden 全流哈希 |
| 跨队不适用 | ✅ `(a<=10)!=(b<=10) continue` | ✅ `p53_cross_team_not_constrained` |
| **状态与事件一致** | ⚠️ 见 P0-1 根因① | ❌ 无测试 |
| **「抢断结算点 … SHALL 在写入状态前经同一分离」** | ❌ **未实现** | ❌ 无测试 — 见 P1-3 |

### A2. design D1–D4 遵守情况

- **D1（距离与方向**都**米制化）**：✅ 遵守。`separate_pair_m` 用 `dx_m=PITCH_LENGTH_M / dy_m=PITCH_WIDTH_M` 求方向，
  再各轴除以真实长度写回。MUT1（方向改回归一化单位向量）→ `p53_separate_pair_uses_metric_direction_not_normalized`
  与 `p5_approach_cap`、golden 三处变红。**这条守住了。**
- **D2 顺序硬约束**：基本遵守（`carrier_move` / `compute_mover_candidates` 均已改为「只产候选不写 `st.pos`」，
  `commit_beat_positions` 统一写回）。**但存在一处违反**：`advance_loose`（`lib.rs:3881`）在 `commit_beat_positions`
  之前**直接写 `st.pos[chaser]`**，污染了分离 solver 的 `starts[]` 输入 → 见 P0-1 根因①。
- **D2 零 RNG 约束**：✅ 遵守（分离层零 RNG；`carrier_move` 内 RNG 消费顺序逐位未变）。
- **carrier 五处一致性**：✅ 代码正确（`sync_main_after_commit` 同步 `main.x2/y2`、`st.pos`、`ball_pos`、
  `carrier_from`、`last_emitted`，`main.x/y` 保留起点）。但 MUT2 表明该路径**只被整场扫描单测覆盖**，无定点单测。
- **D3 验收三重**：第 1 重（引擎硬门）✅、第 2 重（米制口径单测）✅、**第 3 重（detector 真门）❌ 见 P0-1**。
- **D4 golden v6**：✅ 遵守（`MODEL_VERSION=6`、`golden_dir` 加 v6、legacy 扩 v1–v5、`gm_legacy_baselines_preserved_and_differs`
  断言 v6 与 v1..v5 逐 seed 不同）。

### A3. tasks.md 勾选核对

18 项勾选、1 项未勾（P5.5 本审阅）。**P5.4 勾选为「已完成：finding 归零」——该断言不成立**（见 P0-1）。
其余勾选项与代码/测试实体一一对应，核对无误。

### A4. 超出 grill/design 已确认范围的额外改动 —— **判定：2 项合理、1 项越界**

| 额外改动 | 判定 |
|---|---|
| 拍内扫掠侧向约束 | **合理**。design D2 明确留了「若实测出现需边界感知/补中点处理」的口子；这是 grill Q5 的延伸落地。 |
| loose 球滚动 clamp 场内（`advance_loose`） | **合理**。扫掠中暴露的既有缺陷（越界 `beat.ball` 破协议契约），属就地修复。 |
| **carrier 在「射门推进/起脚窗口」豁免扫掠侧推** | **越界**。design/real-gate 的措辞把它限定在射门窗口，但代码在 `emit_beat_with_main`（普通开放比赛带球）**无条件传 `true`**，即**所有 carrier beat 都豁免轨迹级修正**。这是 P0-1 根因②，且与文档自述不符。 |

---

## B 轴：Standards 符合性

1. **分层验证（`CLAUDE.md`）**：✅ `cargo test` 全绿（128 lib + 4 realism），`verify.sh` 五步可跑通，
   viewer 303 / tools 404 全绿，e2e v2 无 snap。无视觉依赖。
2. **零 RNG / 确定性 / 固定遍历顺序**：✅ 成立。`separate_same_team_m`（`lib.rs:4382`）与 `separate_pair_m`
   （`lib.rs:4336`）函数体内无任何 `rng`/`next_u64`；遍历为 `for a in 0..22 / for b in a+1..22` 固定升序；
   新增分离逻辑**未在任何路径消费 `SeededRng`**（grep 复核）；golden 全流哈希守护通过。
3. **代码质量**：良好。命名与既有风格一致，注释绝大多数解释「为什么」（如 `SAME_TEAM_SWEPT_MIN_M` 的 2cm 余量来源）。
   - ⚠️ `separate_target_points`（复数版，`lib.rs:4503`）**是死代码** —— 全仓只有 `separate_target_point`（单数）
     调用它，而单数版永远只传 1 个 target。其存在理由（「抢断结算是跨队 pair，必须共同平移」）说明作者知道
     需要一个多点入口，但**该入口从未被接到抢断路径上** → 见 P1-3。
   - ⚠️ `lib.rs:3881` 的 `st.pos[chaser] = (cx, cy)` 与其下方「走统一分离路径」的注释**自相矛盾**（见 P0-1）。
   - 编译告警 4 条（`carry_plan` 未用、`count_detail`/`count_goals` 死代码等）**均为 5a32ae7 起既有**，非本 change 引入。
4. **性能/复杂度**：⚠️ 有风险但可接受。`commit_beat_positions` 每拍调用 `separate_same_team_m`，
   后者最坏 12 轮 × C(11,2)×2 = 110 pair ×（`separate_pair_m` + `sweep_pair_lateral`）；
   `separate_target_points` 内层还会最多 12×N 次调用整个 solver。实测 `p53_same_team_spacing_ge_2m`
   （10 seed 整场）5.5s、`gm_canary_seeds`（10 seed）5.5s，**无实际超时风险**。
   但注意 `separate_target_points` 目前只走单点，一旦接线（修 P1-3）需重新评估。

---

## 变异测试结果表

| # | 变异 | p53 | p5 | p23 | golden | 判定 |
|---|---|---|---|---|---|---|
| 1 | `separate_pair_m` 推开方向 → 归一化单位向量 | ❌ 1 红 | ❌ 1 红 | ✅ | ❌ | **有牙** |
| 2 | 删 `sync_main_after_commit`（carrier 五处失同步） | ❌ 1 红 | ✅ | ✅ | ❌ | **有牙（仅整场扫描）** |
| 3 | `same_team_dist_m` → `dist_norm` | ❌ 5 红 | ❌ 1 红 | ✅ | ❌ | **有牙** |
| 4 | **整个 `sweep_pair_lateral` 直接 return 不改** | ✅ | ✅ | ✅ | ❌ | **盲区**（无单测） |
| 5 | 删 `normal_pass_highlight` 的 `separate_target_point` | ✅ | ✅ | ✅ | ❌ | **盲区** |
| 6 | 删「补 mover」循环（被推动者不产 mover） | ✅ | ✅ | ✅ | ❌ | **盲区** |

---

## 独立复算的几何证据

手算（与实现一致）：

- x 轴 0.02 归一化 = `0.02 × 105 = 2.1m` ≥ 2.08m → **不分离**（`p53_separate_pair_x_axis_2m1_not_separated` 断言正确）。
- y 轴 0.02 归一化 = `0.02 × 68 = 1.36m` < 2.08m → **须分离**；各推 `(2.08−1.36)/2 = 0.36m` = `0.005294` 归一化
  （`p53_separate_pair_y_axis_1m36_separated_to_min` 断言正确）。
- 完全重合退化：各推 `2.08/2 = 1.04m` = `0.009905` 归一化沿 +x（`p53_..._coincident_degenerates_along_x` 正确）。

未覆盖：`p53_separate_pair_clamps_to_pitch` 明确断言「边界场景下分离不足是已知残留」——
这是**已知且被文档承认**的缺口（design D2 边界感知），不计为发现，但值得记一笔。

---

## P0 / P1 / P2 / NIT

### 🔴 P0-1：「detector finding 归零」不成立 —— 整场逐窗口扫描仍有多处真实越界

**证据（我独立复现，用实现者自己的真实采集管线 `captureObservation → detectPlayerOverlap`）**：

- 实现者的 `reviews/real-gate.md` 及 `tasks.md P5.4` 声称「7 观测窗口全零」。
  我复跑其脚本口径（`/tmp/realgate.mjs`，6 seed × 5–7 个窗口）**确实全零** —— 但这个口径只采样
  **6 个事件触发窗口 + 1 个哨声窗口**，是对 5400s 比赛的极度稀疏采样。
- 我改成「**整场每 5s 开一个 ±5s 真实窗口**」（1081 窗口/seed，同一 `captureObservation` 路径），结果：

| seed | 窗口数 | findings | 最恶劣 |
|---|---|---|---|
| 42 | 2701(步长2s) | 10 | **1.846m** id12/15 @t=2716 |
| 1 | 1081 | 6 | **1.919m** id3/8 @t=4089.5；1.927m id1/5 |
| 3 | 1081 | 6 | **0.718m** id2/4 @t=1877.5；1.657m；1.687m |
| 7 | 1081 | 2 | **1.686m** id17/19 @t=1880.5 |

**这些值低于 detector 的 `strict < 2.0m` 阈值** → 是**真实 finding**，不是 real-gate.md 所称的
「0.5s 采样落在 [2.00, 2.08) 边缘的舍入误差」。real-gate.md 的「残留 1–2 条 … 余量内合法结果」结论**错误**。

**三条独立根因（均已定位到 `file:line`）**：

#### 根因① `advance_loose` 预写 `st.pos`，污染扫掠的起点输入（seed 3，0.718m）

`engine/src/lib.rs:3881`
```rust
let (cx, cy) = move_toward(chaser_pos, loose_pos, step);
st.pos[chaser as usize] = (cx, cy);   // ← 预写：commit 之前就写了终点
...
let mut movers = compute_mover_candidates(st, rng, t, &[chaser]);
movers.push(Mover { id: chaser, from_x: chaser_pos.0, ..., to_x: cx, to_y: cy, ...});
commit_beat_positions(st, &mut movers, &frozen, &[]);   // ← 此时 before[chaser] 已经是终点
```
`commit_beat_positions` 用 `let before = st.pos;` 作为 `starts[]` 传给 `separate_same_team_m`，
而 `sweep_pair_lateral` 的整条逻辑建立在「`starts[id]` 是本拍**起点**」之上。此处 `starts[chaser]` 已是**终点**，
扫掠算出退化的线段（`d≈0`）后走 `if dmin >= ... || sk < 1e-6 { return (a1,b1) }` 直接放弃修正。

**我做了验证性补丁**（删掉该预写，仅此一行，改完已还原）：seed 3 的 **0.718m → 2.0167m**，该 finding 消失。
（这是**审阅诊断实验**，不是建议的修法——修法见下。）

**建议修法**：把 `advance_loose` 改为走统一候选路径（像 `advance_restart_prep` / `advance_dead_ball`
已做的那样），删除 `st.pos[chaser]` 预写，让 chase 终点只经 `movers.push` 进入 solver。

#### 根因② carrier 的扫掠豁免过宽（seed 1，1.927m）

`engine/src/lib.rs:2559`
```rust
let movers = beat_movers_main(st, rng, t, main.subject, (main.x2, main.y2), true);
//                                                                          ↑ swept_exempt 恒 true
```
`commit_beat_positions_ex` 的文档与 real-gate.md 都把该豁免的理由限定为「**射门推进 / 起脚窗口**
避免射门几何漂移」，但 `emit_beat_with_main`（普通开放比赛带球）**无条件传 `true`**。
后果：carrier 与队友**轨迹对穿**时（`sweep_pair_lateral` 中 `a2=false, b2=true`，`lb = gap/sk` 随 `sk→0` 爆掉，
被 `SAME_TEAM_SWEPT_PUSH_CAP_M` 拦下后原样返回），端点分离修不了中点 → seed 1 的 1.927m 长期残留。

**建议修法**：把豁免收敛到设计声明的范围（仅 `emit_shot_window_beat` / `advance_shot_setup`），
或为「豁免侧不可动 + 对侧可动」的对穿场景补一条只推可动侧的兜底路径。

#### 根因③ 抢断结算点从未与队友分离（seed 42，1.846m）

`engine/src/lib.rs:3414`
```rust
let (subject_end, carrier_end) = tackle_settle_points(victim_pos, def_pos, success);
// ← 直接用，无 separate_target_point
```
spec（`openspec/specs/match-engine/spec.md:414`，由 `5cf865e` 写入）明确要求
「由事件直接指定的终点（传球接球点 / 门将扑救点 / **抢断结算点** / 开球落点 / 松散球拾取点）
SHALL 在写入状态前经同一分离」。实测：seed 42 t=2715 抢断，`carrier_end=(0.3679,0.3695)` 距**同队**队友 id12
（`(0.3591,0.3460)`）仅 **1.8459m**，而该位置在 `finalize_highlight` 会写进 `st.pos[15]`、viewer 也照此渲染。

**建议修法**：接线 `separate_target_points`（复数共同平移版，`lib.rs:4503`）——
它正是为此写的，但**从未被调用**（见 B3）。传 `[(victim, carrier_end), (def_id, subject_end)]`
即可在保持跨队既有间距的同时消除与各自队友的重叠。

> 注：以上三处都**不会被 `p53_same_team_spacing_ge_2m` 抓到**，因为它只扫发射端点（见盲区清单）。
> 这正是本 change 已勾选 P5.4「归零」却仍有真实越界的原因。

### 🟠 P1-1：`p53_same_team_spacing_ge_2m` 的 `worst < SAME_TEAM_MIN_DIST_M + 0.5` 断言偏松

`engine/src/lib.rs:6190` 用 `worst < 2.58m` 证明「分离确实在起作用」。实测最坏值 2.08m 级，
该断言留了 0.5m 裕度，**对「扫掠部分失效」这类退化不敏感**（MUT4 关掉整个扫掠，该测试仍绿）。
建议收紧到 `worst < SAME_TEAM_MIN_DIST_M + 0.05`，或补一条「中点最恶劣值」断言。

### 🟠 P1-2：五个 `SAME_TEAM_MIN_DIST_M` 隔离的中间阈值缺文档交叉引用

`SAME_TEAM_SWEPT_MIN_M = SAME_TEAM_MIN_DIST_M − 0.06`（`lib.rs:622`）与
`SAME_TEAM_MIN_DIST_M` 的 0.08m 序列化余量是**两套独立余量**，都为了同一个 JSON `round3`/0.5s 采样问题。
当前注释各自正确，但**没有一处说明两者叠加后的总余量是多少**（0.08 与 0.06 不叠加，是两条不同路径），
将来调参容易只改一处。建议在常量区补一句总账。

### 🟡 P2-1：主 spec / delta 已同步但存在历史遗留的重复 requirement 块

`openspec/specs/match-engine/spec.md` 的 `## ADDED Requirements` 段（`5cf865e` 加入）与
文件既有 requirement 列表**同级并存**，`npx openspec validate --all --strict` 14/14 通过，
但主 spec 里同时有 83 个 `#### Scenario`（含本 change 新增 9 个）。归档前请按 memory 记录的盲区
（「MODIFIED header 须与主 spec 一致且全量复制 scenario」）再核一次 header 一致性 —— 本次 delta 是
`## ADDED Requirements`（纯新增），与主 spec 的追加方式一致，**这一条本次没有问题**，仅提示归档时复检。

### 🟡 P2-2：`separate_target_points` 死代码

`lib.rs:4503` 的多点版从未被调用（唯一调用者 `separate_target_point` 只传单点）。
要么按 P1-3 接线，要么删除以免误导。

### ⚪ NIT-1：`real-gate.md` 需随修复更新

「7 观测窗口全零」的表述会被误读为「整场无越界」。修完后建议把验收口径改为
「整场每 N 秒滑窗扫描」并把命令落到仓库内（当前脚本在 `/tmp/p34-*.mjs`，**未入库、不可复现**，
违反 `CLAUDE.md` 的可复现验证精神）。

### ⚪ NIT-2：`p5_approach_cap` 的容差常量重复书写

`lib.rs:6107` 与 `6097` 各自写 `sep_budget * 1.05 + 1e-6`，建议提常量。

---

## 盲区清单（哪些测试实际抓不住变异）

1. **拍内扫掠完全无单测** —— MUT4（整个 `sweep_pair_lateral` 失效）p53/p5/p23 全绿，只有 golden 变红。
   golden 只能证明「事件流变了」，不能证明「中点间距达标」。**这是 P0-1 三条根因全部漏网的直接原因。**
2. **`p53_same_team_spacing_ge_2m` 只扫发射端点，不扫拍内中点** —— 与 spec 的「拍内扫掠」Scenario 存在
   语义缺口：Scenario 要求中点 ≥ 2m−ε，但没有任何自动化断言检查它。
3. **事件指定终点的分离（接球点/扑救点/抢断点/开球落点）无专测** —— MUT5（删传球接球点分离）仅 golden 变红。
4. **「补 mover」行为无专测** —— MUT6 仅 golden 变红。
5. **「状态与事件一致」（`st.pos == last_emitted`）Scenario 无任何断言** —— 全仓 grep 无相关测试。
6. **`separate_pair_m` 的边界 clamp 只断言「不越界」**，明确接受分离不足（`lib.rs:6268`）；
   该已知残留无上界约束（多少算可接受？）。本次实测最坏 0.718m 说明它不止是理论缺口。
7. **`p5_approach_cap` 的 `max_excess` 断言偏松**（见 P1-1）。

---

## 复核过的「没问题」项（供归档参考）

- 分离/扫掠/solver 三个新函数**零 RNG**、固定遍历顺序（grep + 阅读确认）。
- `carrier_move` 内 RNG 消费顺序逐位未变（golden 只在分离推移处漂移）。
- carrier 五处状态同步代码正确（`sync_main_after_commit` 与 4 个调用点的 `set_carrier_from` 取值合理）。
- 全部 `compute_mover_candidates` 调用点（`lib.rs:2499, 3000, 3050, 3083, 3116, 3207, 3388, 3505, 3625,
  3683/3689, 3701, 3747, 3780, 3815, 3875, 3907/3913, 4001, 4029, 4111, 4126, 4137, 4145, 4157/4163`）
  都紧随 `commit_beat_positions*` 或 `beat_movers*`，**无遗漏的裸调用点**（grep 全仓确认
  `compute_movers` 已无残留，仅注释中提及）。
- golden v6 与 `MODEL_VERSION=6` 匹配；`gm_legacy_baselines_preserved_and_differs` 已扩到 v1–v5 且
  断言 v6 与五者**逐 seed 流哈希不同**（若 v6 与旧版相同会报红）——该断言有效。
- v6 golden 与 v5 的聚合漂移（事件数 58282→58281、射门 83→89、抢断 99→79、比分 7→11）
  落在 v3→v4/v4→v5 的历史带内，**不构成拒绝基线的理由**（逐 seed 有比分翻转，属正常重基线）。
- `npx openspec validate --all --strict` 14/14 通过；`verify.sh` 五步可跑通。
- 编译告警 4 条均为 change 之前既有。

---

## 复现命令（审阅者自己用的）

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd engine && cargo test                                  # 128 + 4 全绿
cd .. && npx openspec validate --all --strict            # 14/14

# 整场逐窗口扫描（同一 captureObservation 真实管线）——这条会暴露 P0-1
node /tmp/realgate.mjs     # 实现者的 6 窗口口径：0 findings（复现其结论）
node /tmp/win5.mjs 3       # 整场每 5s 一窗：seed 3 → 0.718m 等 6 findings
```

**回归建议**：把「整场滑窗扫描」沉淀成一个入库脚本并加进 `verify.sh` 门槛，
否则 P0-1 这类「只在稀疏采样下归零」的回归会反复发生。
