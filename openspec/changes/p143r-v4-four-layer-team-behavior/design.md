# Design: 四层球队行为整合落地（P143r-v4）

## D0. 目标与判据

**改什么**：把 P143r 探通的四层机制（移动 v3 / 防守 def / 密度 vol / 事件 evt）整合进
`engine/src/lib.rs`，并联合标定三个共享常数，使四层**能同时存在**且 L1 尽可能绿。

**判据**：
1. `cargo test --test realism --release -- --ignored l1_` —— 5 条官方 L1 带（权威，非快筛）。
2. `cargo test`（默认套件）——常数断言与 seed 覆盖门按新口径更新后全绿；已知红显式记录。
3. 视觉：`trajectory.mjs` + `contact-sheet.mjs` + `viewer-match.mjs`（**用户尺度 seed42/5min**，先看图再引数字）。

**记录口径**（本仓头号纪律）：wasm sha16 + 事件流哈希 + **seed 区间 + 时长**。

## D1. 三个共享常数的联合标定（四层叠加超线性）

四层各自调过反向常数，合并后**相乘**：密度层让每个机会点更频繁被评估、逼抢层让防守者常态贴身
→ 接触事件相乘。故联合解比任一单层都更深：

| 常数 | main | 单层值 | 合并取 | 作用 |
|---|---|---|---|---|
| `BASE_DEF_TACKLE` | −0.65 | −0.70(vol) / −0.65 | **−0.86** | 压抢断进带 `[24,50]` |
| `BASE_DEF_FOUL` | −0.06 | −0.08(def) | **−0.19** | 压犯规进带 `[16,30]`（抢断/犯规同一块饼，须联合调） |
| `OPEN_PLAY_SHOT_ENGAGE_SHIFT` | −3.4 | −3.95/−4.05(vol) | **−4.15** | 压射门进带 `[14,29]` |

**为什么几何化抢断不能救上界**：`TACKLE_GEOM` 只改成败**比**、不改次数——`[24,50]` 是**体量**带，
只能靠 `BASE_DEF_TACKLE`。

## D2. ★ 硬前沿：`ratio ≥ 0.5` 与 `home > away` 是同一根轴的两端

**实测（权威 cargo + 快筛双口径一致）**：

| `BASE_DEF_TACKLE` | tackles(200) | ratio(200) | fouls(200) | home(600) | away(600) |
|---|---:|---:|---:|---:|---:|
| −0.82 | 51.46 | 0.4308 | 24.1 | 1.4217 | 1.3267 |
| −0.84 | 48.57 | 0.4560 | 25.4 | 1.4183 | 1.5017 |
| −0.86 | 45.81 | 0.4838 | 26.0 | 1.4750 | 1.4250 |
| −0.88 | 44.44 | 0.5013 | 26.7 | 1.5033 | 1.5083 |
| −0.90 | 42.98 | 0.5162 | 27.7 | 1.4217 | 1.4800 |

- **ratio ≥ 0.5 要求 tackles ≤ 2×shots**（shots ≈ 22）→ 只有 `−0.88` 及更深才够；
- **home > away 只在 `−0.82 / −0.86` 成立**（`−0.84 / −0.88 / −0.90` 反向）——600 场主客进球各
  ~300 个，`gh − ga` 的 σ ≈ 0.05/场，故「反向」多数在噪声内，但**方向本身被冲淡到 ≈1.0**。

**机制**：这正是 combine 报告 §3「v3 强度 × 传球选择 → home 反转」的延续——四层叠加后
**主队高位控球 → 阵型压上 → 被客队打身后**，控球→射门的转化方向被削弱。HOME 优势通道
（`CLINICAL_GOAL_PP_HOME` / `BATTLE_ATTACK_WIN_HOME`）**未动**，是涌现层的净效果把方向压平的。

**取值 −0.86**：保住主场优势（产品属性），ratio 差 3.15%（0.484 vs 0.5）。**决策项**：
要 ratio 绿就得吃 home 方向消失（`−0.88`）；要 home 稳就得接受 ratio 边际红。**二选一，需用户拍板**。

## D3. 为什么 `OPEN_PLAY_PASS_PRESSURE_M` 8→4 是前提

开放局逼抢让防守者常态停在 ~5m。若出球档阈值仍是 8m，持球者**每 tick 都判「被逼抢」→ 恒出球**
→ 射门推进档（②）**永久不可达** → 射门被逼抢锁死。收到 4m（< 逼抢停距 5m）后，只有真贴身
（≤4m）才强制出球，推进档恢复可达。这是「def 逼抢」与「vol 射门」两层共存的关键。

副作用（**可接受**）：`p28_action_opportunity_is_live` 里 `res_jockey` 由「结构性不可达（0）」
变为可达（~2407 次）——正是该测试注释预设的触发条件（「改了阈值就有意更新本断言」），
且是**改进**：D5「contain/jockey 只调压力状态」的两条腿现在都真实命中。

## D4. 已知默认套件红：`p53_same_team_spacing_holds_between_anchors`

**现象**：同队轨迹（含拍内中点）出现 **1.765m < 2.0m**（seed 8, t=0.719s, id 2/4），
8 个 seed 里**仅 1 次**，且**越界对含 carrier**（探针确认 `carrier_at_tick=4`）。

**隔离证据**（关掉各层重跑该测试）：

| 关掉的层 | 结果 |
|---|---|
| 移动 v3（`FORM_MIX_*`=0） | 仍红（seed 3, 1.040m） |
| 开放局逼抢（`OPEN_PRESS_N`=0） | 仍红（seed 6, 0.942m） |
| 密度 vol（deadline/liveness/circ 复原） | 仍红（seed 6, 1.892m） |
| **传球选择（`PASS_SELECTION_ENABLED`=false）** | **绿** |
| 对抗几何（`TACKLE_GEOM_ENABLED`=false） | 仍红（seed 1, 1.645m） |

**⚠️ 根因订正（收尾探针实测，2026-10-11）**：原稿把根因归为「P34 carrier 拍内扫掠豁免」。
**探针证伪了它**——违规点落在**拍起点**（线段最近点 `sk_raw=−0.191 < 0`，`kind=START`），
不是拍内中点；且 `emit_beat_with_main` 的**起点**在扫掠步里本就「不可动」（`sweep_pair_lateral`
起点 <阈值即早返回），与 carrier 是否豁免**无关**。真机制是：

- `finalize_highlight` 把参与者位置**直接写 `st.pos`**（`for (id, end_pos) in &h.participants`），
  **绕过同队分离**；
- 传球落点在**发球时**已与队友分离，但飞行期无球 mover 可自由跑进该落点（实测 id2 在
  t=717→718 跑进落点 1.765m 内）；
- 结算时接球者（= 下一拍 carrier）被放到该落点 → 起点 <2m，而起点不可动 ⇒ 整拍残留。

**处置（已修）**：`PassCaught` 结算处用既有 `separate_target_point(st, receiver, catch_pos)`
把接球者从**当前**队友位置推开（队友冻结、只推接球者）。**验证**：p53 绿（seed 8 最坏
1.765m→2.133m）**且 L1 仍 4/5**（未破射门几何）。**不是缩守卫**——修正的是真实的写路径缺口。

## D5. seed 覆盖门重钉 = 换样本不换判据

`truncated_stream_produces_a_full_time_gap_by_design` 与
`every_episode_and_restart_object_has_event_indexes_or_a_documented_exception` 是
**seed 覆盖门**（选特定 seed 命中结构形态）。密度层改事件流后旧 seed 不再命中 →
按**同一判据**在 5400 下重扫。**收尾的 p53/l2 源码修复又改了一次流**，故下表是**复扫后**的值：

- gap 样本：`470`（dur 120）→ **`562`**（同判据：kickoff 飞行被终场哨截断）；第二例
  `1228`（dur 400）→ **`348`**。
- 三形态集合：`[1,9,24,36,53,86,100,317,5]` → **`[11,42,154,225,288,353,393,55,43]`**
  （形态①②③ 计数 5/1/3）。谓词、豁免条款、防空转断言**均未改**。

**全量重钉清单（收尾，`rescan` 探针复扫）**：gap 门 (562,120)/(348,400)；CANARY 三形态改由
独立 `TRUNCATION_FORM_SEEDS=[11,225,42]`（与 CANARY 解耦）；CONTEST_SEEDS 补 `match_end` seed 7；
p17b fallback 窗口补 225/278；`l2_sent_off_kickoff_seeds` 29/35/59/84→64/121/168/203；
observation.rs 三形态集→[11,42,154,225,288,353,393,55,43]。**换样本，不换判据。**

## D6. `MODEL_VERSION 7→8`

四层改变**可观测行为**（事件流逐 seed 不同）→ 按仓惯例 bump 模型版本、新建 `tests/golden-v8/`，
v1..v7 保留作历史对照。`golden_dir()` 加 `8 => "tests/golden-v8"`。

## D7. 与合并构建器 `all4w5` 的差异（**清理浮点重排 → 事件流变，属预期**）

本 change 是**手写干净源码**，不是照抄 `build-combined.mjs` 的输出：
- 去掉 `0.0 *` 死项（`K_ROLE`/`K_SPREAD`/`DEF_CLAMP`/`SIDE_ANCHOR`/`COMPRESS`/`FAR_SPREAD`/`BEAT_P`/
  `EVADE`/`SHOOT_PRESS`/`FWD_PASS` 全为 0 的分支）与参数占位注释。
- 用命名常量（`FORM_*` / `PASS_*` / `TACKLE_GEOM_*` / `OPEN_PRESS_*`）替代单字母占位。
- 传值函数按权重化简（删除 `W_GOAL`/`W_SAFE`/`W_INTPEN` 的零项）。

**浮点重排会级联到 tick 演化**（本仓已知）→ 与 `all4w5` 事件流**不再逐字节一致**，且 `BASE_DEF_TACKLE`
取了不同的联合解（`all4w5` 用 −0.82 → 官方 tackles 50.27；本 change 用 −0.86 收进带）。
**清理可以，清完必须重跑全套验证**——不能声称「与 all4w5 一致」。

## D8. 已知未收（遗留）

1. ~~`p53_same_team_spacing_holds_between_anchors`（见 §D4）。~~ **已在收尾修复**（见 §D4 订正）。
2. `shot/tackle ratio` 边际红（见 §D2）——**用户已拍板接受**（保主场优势）。收尾后实测 0.479。
3. `viewer/data/benchmark-baseline.json` 的 `engineFingerprint` 哨兵会红（引擎源码变了，
   基线未重生成）——重生成需真实 tracking 数据（gitignored，本机无 SkillCorner 20 场），
   **列为合入后步骤**（`node tools/benchmark-baseline.mjs`）。

## D9. ⚠️ 裁决待定（**用户级动作，本 change 不自改**）

`final_third` 仍可分 ⇒ **探针完整性/版本锚点漂移**类（`counter_proof` 0.855→0.764、
`gate_rerun` ① 0.855→0.764）**按新引擎重锚**（保留 ≈0.5 的 join-bug 判别力）。

但 `build_up vs progression` 在**时长归一** `forward_m/s` 上由「分不开」（`|AUC−0.5|≤0.06`）
变为 **0.382（可分）**——**这是对 P16 裁决（「空间量不足以判这两档」）的推翻**，属**用户级
动作**（仓史「结论对但机制错」教训）。本 change **不自行改判**：涉及的三处（`p16::phaseability_verdict`
②、`p124::gate_rerun` ②、`p124::purification_records_the_v4_verdict_pending_review` ①）**只记录 v4 读数 +
显式注释「裁决待定」**，绝不静默放宽。**待用户拍板**后才另立 change 处理新裁决。
