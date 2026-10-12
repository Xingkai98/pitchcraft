# 独立审阅报告：p143r-v4-spacing-gap（GitHub #149）

## 0. ⚠️ 审阅期间 HEAD 移动 + 本报告的下落（先读这段）

- **我实际核对的修订**：`engine/src/lib.rs` 的 git blob = `1b7fe2f…`（会话开始时的快照，≈11:46）；行为读数用 wasm = `e3b3e89f`（11:21 构建）。
- **审阅期间工作树被推进多次**：`lib.rs` blob `1b7fe2f…`→`f3e51a6…`(≈13:29)→`f467cb63…`(13:41)；change dir 的 `design.md`(12:43) / `spec.md`(12:25) / `proposal.md`(13:27) / `tasks.md`(12:32) 也被改过；`viewer/engine.wasm` 重编为 `f753b1777dfb4854`。**实现者在本审阅进行中并发改了注释、加了一条单测、更新了 change 文档**。
- **收尾时变更已被提交**：commit **`4d121d4`**（`fix(engine): #149 …（窄触发）`，父 `dc86ca1`）。**关键：4 个逻辑 hunk 的代码在三次修订间逐字节未变**（`point_seg_dist_m` / `SAME_TEAM_OVERLAP_MIN_M` / `beat_movers` 调用点 / `highlight_frozen_segs` 三分支）——我核过 `git diff dc86ca1 4d121d4` 的代码行，与 `1b7fe2f` 版一致。故**我的行为验证（§2 全部读数）对已提交的 `4d121d4` 继续有效**。
- **本报告的下落**：实现者已把本报告的一份快照（不含 R8b 行）**移动并提交**为 `.scratch/notes/p143r-v4-spacing-gap-review-2026-10-12.md`（含于 `4d121d4`），并从工作树移走了原文件。此处按任务要求**复原最终版**到 `REVIEW-p143r-v4-spacing-gap.md`（补回 R8b）。`tasks.md:38-40` 记录其处理的一轮零上下文审阅为「P0=0；P1×1；P2×2；P3×4」——**该轮即本报告**（其 P1-1/P2-1/P2-2/P3-1/3-2/3-4/3-6 与本报告逐条对应）。
- **工作方式**：先按 `1b7fe2f` 核机制与跑证据（§2/§7/§8），再按后续修订**复核**每条发现是否已被修掉（§9）。**我没有改动仓库里任何受审文件**。

## 1. 总结论

**机制主张属实、修法有效、复现读数全部对得上**。核心改动（`lib.rs:6381-6413`，三版一致）与 design §D1/§D2 的机制描述、§D4 的每一项读数，都独立复现。design §D0 的**五条判据我全部独立复核成立**：① 默认 8 seed 全 0（R2）② `cargo test` 全绿（R8/R8b）③ L1 9/9（R9b）④ e2e 无 snap（R11）⑤ 撤修法回红（R3）。「非严格边界」反证也**逐位复现**（R15）。

**未发现 P0。** 我提出的 P1×1、P2×2、P3-1/3-2/3-4/3-6 **已被实现者并发修掉，且我逐条复核过修法正确**（§9）。**仍存**的只有两条**信息项 P3**（哨兵采样盲区 P3-3、采样门 vs 连续真值余量薄 P3-5），均**先于本 change 存在**、不阻塞。

**一句总结：无阻塞性（P0）问题；我提的 P1/P2/P3 均已在提交 `4d121d4` 中修毕并复核通过；无遗留的运行时正确性问题，也无未处理的审阅项。**

---

## 2. 我实跑的复现读数（全部与 design 对得上）

| # | 判据 | 命令 / 探针 | 读数 | 对应 |
|---|---|---|---|---|
| R1 | spacing seed 2（修后） | `node tools/spacing-sweep.mjs 2` | **0 findings**（2157 窗） | design §D4 ✓ |
| R2 | **spacing 默认 8 seed（修后）** | `/tmp/gate-sweep.log`（修后 wasm） | **42/1/2/3/7/59/18/94 全 0** → `OK: no player_overlap findings` | §D0 判据 1 ✓ |
| R3 | 反证（修前 wasm） | `zz_sweep1 /tmp/engine-b.wasm 2` | `pair 11,18: min=1.957 first_breach=4567.5` | §D1.1 / 判据 5 ✓ |
| R4 | §D1 数值（自建探针 `/tmp/zz_verify149.mjs`） | 修前 wasm seed 2 | flight=`1.1559s`、`t_end=4567.1559`、solver 均匀口径=`2.1462m`、viewer 连续最近点=`1.2577m@τ=0.185`、`dist(from67,end)=1.5347m`、`dist(lerp(u(4567)),from67)=2.5964m` | §D1.2/§D1.3/§D1.4 逐条精确复现 ✓ |
| R5 | §D1.4「订正 §9.6」 | 同上 | 起点距 **2.5964 ≥ 2.14** ⇒ `sweep_pair_lateral` 早返回（`lib.rs:6081`）**确未触发** | 订正成立 ✓ |
| R6 | golden 只有 seed 2 变 | `zz_churn b g 2 1 3 4 5 6 7 8 9 10` | seed 2 结构性变；**1,3..10 `slotDiff=0 maxDisp=0`（逐位相同）** | §D3 ✓ |
| R7 | L1 抽样 churn | `zz_churn b g 401 425 450 475 500 525 550 575 600` | 401/475/500/525/550/600=**0**；425/450/575=**5/3/3 槽，maxDisp 6.9e-3/2.18e-2/3.2e-3**，无计数变更 | §D3 ✓ |
| R8 | 默认套件 | `cargo test`（`1b7fe2f` 树） | **全绿，EXIT 0**（含 golden-v8 canary + realism L2/golden） | §D0 判据 2 ✓ |
| R8b | 默认套件（**当前树** `f467cb63`） | `cargo test --lib` / `--test p16_spatial_features` / `--test realism` | **`201/0`（含新单测 + 全部源扫描守卫）/ `36/0` / `4/0`**（blob 前后稳定）；早先一次全量红 = 并发编辑 artifact（见 §10） | 判据 2 复核 ✓ |
| R9 | L3 禁区占比 | `cargo test --test realism --release -- --ignored --nocapture l3_shot_ratios` | **ok**，`禁区占比=0.721`（411/570）、sot=0.376、conv=0.121 | §D4 ✓ |
| R9b | **L1 全量 9/9** | `cargo test --test realism --release -- --ignored` | **9 passed; 0 failed** | §D0 判据 3 ✓ |
| R10 | 基线指纹哨兵 | `node --test tools/benchmark-baseline.test.mjs` | **10/10 pass** | §D4「tools 505/505」核心条 ✓ |
| R11 | 端到端无 snap | `cd viewer && node e2e-v2.mjs` | `无 snap(4 seed: 球 0.0079, 球员 0.0151)` | §D4 判据 4 ✓ |
| R12 | 基线引擎 seed 未动 | `zz_churn b g 99 123` | 两者 `slotDiff=0` ⇒ 哨兵走「行为未变」放行（见 P3-3） | — |
| R13 | §D2.1「2.9216m」 | 由 R4 值手算 | = **t=4567.5 采样点距离 `2.9221`**；连续口径真值 `2.1564m` | §D2.1 ✓（见 P3-5） |
| R14 | 修法触发 seed 稀少 | `zz_churn` 扫 21 个默认外 seed | **全部 `slotDiff=0`** ⇒ 这些 seed 上 `breach` 从未触发 | §8 方法学 |
| R15 | **严格边界反证** | `zz_sweep1 /tmp/engine-degen-only.wasm 18` | `pair 5,9: min=1.681 first_breach=242.5` —— **逐位对上** design §D2 | §D2 严格边界 ✓ |
| R16 | **改注释后的 wasm 行为等价** | `zz_churn /tmp/engine-gate.wasm viewer/engine.wasm …`（`e3b3e89f` vs 现树 `f753b177`） | seed 2/1/3/425/450/575 **全 `slotDiff=0`** ⇒ 现树 wasm（注释/新测后重编）与我在跑读数所用构建**行为逐位相同** | §D4 的「行为等价重编」✓ |

**结论：design 引的每一处读数我都独立跑出来了，没有不可复现之处。**

---

## 3. P0

无。

---

## 4. P1

### [P1-1] spec delta 的 SHALL 比实现宽（未写「窄触发」）—— **已修，已复核**

- **我在 `1b7fe2f` 版本看到的问题**：`spec.md` 的需求段落把「线段终点钉落点 / 退化为落点一点」写成**无条件 SHALL**，而代码只在 `breach`（落点落在某同队 mover 本拍候选轨迹 `<2.0m` 内）+ 严格 `t_rem<TICK` 时才做。按 OpenSpec 归档「整块替换主 spec」的口径，归档即会把主 spec 写错。
- **现树（`4d121d4`）复核**：`spec.md:12` 已补「**触发 SHALL 为窄触发**：当且仅当……2.0m 内……未触发时 SHALL 保持原口径」；`:14/:15` 给出两档精确条件；`:17` 补「`t_rem == TICK` / `t_rem ≥ 2·TICK` SHALL 走原口径」；`:18` 声明「`SAME_TEAM_OVERLAP_MIN_M` 是 detector 既有真实门，非新阈值」。**与代码逐条对上**（`lib.rs:6390-6410`）。
- **标注：真问题（曾存在）→ 已修（复核通过）**。

---

## 5. P2

### [P2-1] 注释「滑行的那一小段已由上一拍覆盖，不漏约束」过宽 —— **已修，已复核**

- **问题**：`1b7fe2f` 的注释在「严格本拍内完成」档声称滑行尾段「已由上一拍覆盖，不漏约束」。实测/分析：**只覆盖到拍边界那一点**（上一拍线段把 mover 的**上一拍终点** = 本拍起点逼离落点），**不覆盖本拍 mover 轨迹内部 vs 滑行尾段**（欠约束上界 = 尾段长 = `(t_rem/span)·|glide|`，seed 2 = 1.18m）；单拍飞行时**无上一拍**。
- **现树复核**：`lib.rs:6373-6376` 已改为「**覆盖边界如实记**：本拍 mover 的起点侧由上一拍线段约束……本拍轨迹内部对滑行尾段无显式约束（欠约束上界 = 尾段长；单拍飞行时无上一拍、尾段即整段）。实测默认 8 seed + L1 抽样均未越界——不据此加约束」；`design.md:101-105` 同义。**这段表述与我独立分析一致**。
- **我的额外证据（支撑「不加约束」的取舍）**：5 个**修法真正触发**的 seed（20/23/26/27/29）修后 sweep **全 `no findings`**（§8）；即残留**未观测到显形**。
- **标注：真问题（曾存在）→ 已修（复核通过）**；残留本身**未证伪亦未证实**，已被如实记录。

### [P2-2] 改动无引擎级测试覆盖 —— **已修，已复核**

- **问题**：全仓无测试构造 highlight 再调 `beat_movers`/`highlight_frozen_segs`；`p53_same_team_spacing_holds_between_anchors`（`lib.rs:8523`）只取 beat 的 movers/main，**取不到参与者 pass 落点锚点**；`p53_same_team_frozen_participant_separates_mover`（`lib.rs:8646`）不设 highlight。故本改动**只由外部 `tools/spacing-sweep.mjs` 守护**。
- **现树复核**：新增单测 `p53_highlight_landing_enters_solver_on_breach`。我**跑了**：`cargo test --lib p53_highlight_landing` → `1 passed`（也含在 R8b 的 `--lib` 201/0 里）。**读断言体**：覆盖 ① 破阈+本拍内完成→`(landing,landing)` ② 破阈+下一拍内完成→终点=landing ③ 未破阈→`to ≠ landing` ④ **跨队 mover 不触发** ⑤ `t_rem==TICK` 走原口径（用 `from == 动作前位置` 区分——此档 `to` 与落点数值同值，作者在注释里说明了）。**在 4 个判别轴上有区分度**。作者在 commit message 里称做过「**定向变异**证有区分度」（我未独立复跑该变异，见下）。
- **我未做**：变异测试（临时改 `lib.rs` 再跑）。理由：**HEAD 正在被实现者并发编辑**，改动 `lib.rs` 有污染/被提交的风险（本仓 `p34-review-head-moves` 的教训）。故**非空转性我只做了「读断言体」级核验**，未做「定向变异后必红」级核验。
- **标注：真问题（曾存在）→ 已修（复核通过；非空转性未做我的独立变异验证）**。

---

## 6. P3

| 编号 | 内容 | 状态 |
|---|---|---|
| P3-1 | 注释交叉引用悬空：`lib.rs` 曾写「design.md §D2/**§D5**」（无 §D5）；`design.md:140/146` 写「见 **§D4b**」（实为 §D4c） | **已修**（`lib.rs` 现只引 §D2；design.md 无 §D4b/§D5 引用）——复核通过 |
| P3-2 | `design.md` §D4 的 golden diff 摘要漏 `n_free_kick 23→22` 等 | **已修**（§D4 现列 `n_free_kick`、`n_shot_saved/off/box/arc/far`、`n_pass_success`）——复核通过 |
| P3-3 | **指纹哨兵采样盲区**：`tools/benchmark-baseline.test.mjs` 的 P38 #87 哨兵在「源码哈希变、但 5 采样 seed（42/1/7/99/123）指标逐位一致」时打印「仅注释/重构」并**放行**——而本 change **是**行为改动（seed 2 / L1 425/450/575 变，只是没命中那 5 个 seed）。我实跑到该放行输出并确认 seed 99/123 逐位相同（R12） | **仍存**（信息项；**先于本 change 存在**；`tasks.md:40` 已记入 design） |
| P3-4 | `tasks.md` 勾选与 `design.md` 结论不一致（4.1–4.7 未勾等） | **已修**（4.x / 5.x 已勾，1.2 改为「环境不可用→手工核对」）——复核通过 |
| P3-5 | **验收门是采样的**：§D2.1「2.9216m」= t=4567.5 **采样点**距离；连续口径真值 **2.1564m**（离 detector 阈 2.0 只剩 **0.156m**）。detector `sample_step=0.5` 是**既有口径** | **仍存**（信息项；先于本 change；意味着 P2-1 残留若显形、余量更薄） |
| P3-6 | `proposal.md:36` 曾称其余默认 seed「仅 **1e-6 级浮点抖动**」，与 `design.md` 的「逐字节不变」矛盾，且我的 churn（R6）实测为**逐位相同、无抖动** ⇒ proposal 一侧为假 | **已修**（现为「seed 1、3–10 逐字节不变（zz_churn 实测）」）——复核通过 |

---

## 7. 逐项核对（「结论对但机制错」专查 + 边界）

| 检查点 | 结论 | 证据 |
|---|---|---|
| 触发门 `< SAME_TEAM_OVERLAP_MIN_M` **= detector 真实门** | **已核实无误** | `tools/detectors.mjs:42` min_distance=2.0；`:652` 严格 `<`；`lib.rs:787` 常量 2.0、`lib.rs:6402` 严格 `<` |
| 门槛**漏掉静止队友**（未产 mover） | **已核实无误** | 静止队友在 solver 里是退化点，仍参与；且 `completes_mid_tick` 下**原口径线段端点本就是 `end`**（`u(t+TICK)` clamp=1，`lib.rs:6387`）⇒ 静止队友照样被推离落点 |
| 传入的 `movers` 是**分离前候选** | **已核实（无害）** | 分离只**增大**距离；且无论 breach 与否，`completes_mid_tick` 线段端点含 `end` ⇒ mover 天然被约束「离 `end` ≥2.14」 |
| 同队判定 `((m.id<=10)==(id<=10))` | **已核实无误** | 与 `compute_mover_candidates:3692` / `separate_same_team_m:6029` 同口径（home=0..10）；门将 0/21 覆盖 |
| 边界 `t_end == t+TICK`（抢断）走原口径 | **已核实无误** | 抢断 `lib.rs:4480` `t_end=t+TICK_SECONDS`、t 为整数 ⇒ `t_rem` 恰 `=1.0` ⇒ 两档皆 false ⇒ else；`t_rem>0`（flight>0）恒成立 |
| 边界 `t_end == t+2·TICK` | **已核实无误** | `completes_mid_next` 严格 `>`，恰 2.0 走 else（此时 `u(t+1)<1`，原口径本就正确） |
| **真没改**阈值 / detector 门 / 统计带 / 事件层常数 | **已核实无误** | `git diff --name-only`（`dc86ca1`→`4d121d4`）= `lib.rs` + `golden-v8/seed-2.json` + change 工件；新增常量仅 `SAME_TEAM_OVERLAP_MIN_M=2.0`；`tools/` `viewer/` 未动 |
| 只影响**移动层** | **已核实** | churn（R6/R7）：golden 只 seed 2、L1 抽样无计数变更 |
| code 注释机制 vs 代码 | **除已修的 P2-1 外一致** | `lib.rs:6357-6383` 的窄触发、两档、严格边界逐条对 `6394-6414` 核过 |
| design §D1.4「订正 §9.6」 | **已核实无误** | R4/R5：起点距 2.5964 ≥ 2.14，早返回确未触发 |
| 「零 RNG、确定性」 | **已核实无误** | 新码只用 `movers.iter().any(...)`（id 序确定），无 RNG 消费 |

---

## 8. 补跑 / 额外覆盖（直测「门槛是否漏真越界」）

**方法学要点**：本修法是**窄触发**——我在 21 个默认集外 seed 上做 churn（`zz_churn b g …`），**全部 `slotDiff=0`（逐位不变）** ⇒ 这些 seed 上 `breach` **从未触发**，扫它们**等于扫 main**、测不到本修法。**要测残留，必须扫「修法真正触发」的 seed**。

- **修法真正触发的 seed（churn `slotDiff>0`）**：默认集外 `20, 23, 26, 27, 29`；L1 的 `425, 450, 575`（R7）。
- **结果**：`20 / 23 / 26 / 27 / 29` **全部 `no findings`**（5/5 触发 seed 修后无缝）。⇒ 残留**未在这些触发 seed 上显形**。（L1 的 425/450/575 未跑——时间/负载。）
- **默认集**：8/8 全 0（R2）。
- **「非严格边界」反证**：`zz_sweep1 /tmp/engine-degen-only.wasm 18` → `pair 5,9: min=1.681 first_breach=242.5`，**逐位对上** design §D2 的反证（design 记该构建为 `/tmp/engine-fix-dprime.wasm`；两者对 seed 18 给出同一读数）。**结论：严格边界（`t_rem < TICK`）必要**。

---

## 9. 复核记录（审阅期间 HEAD 移动）

| 我提的 | `1b7fe2f`（受审） | `4d121d4`（提交） | 复核方式 |
|---|---|---|---|
| P1-1 spec 过宽 | 需求段落无条件 SHALL | `spec.md:12-18` 补窄触发 + 严格边界 + SHALL NOT | 读全文 + 对代码逐条核 |
| P2-1 注释过宽 | 「已由上一拍覆盖，不漏约束」 | `lib.rs:6373-6376` + `design.md:101-105` 改精确表述 | 读码 + 与我独立分析比对 |
| P2-2 无单测 | 无 | 新增 `p53_highlight_landing_enters_solver_on_breach` | **跑了**（pass）+ 读断言体（4 轴有区分度） |
| P3-1 悬空引用 | §D5 / §D4b | 已引 §D2；design 无 §D4b/§D5 | grep 复核 |
| P3-2 diff 摘要漏项 | 漏 `n_free_kick` 等 | §D4 列全 | 读 §D4 对 `git diff` |
| P3-4 tasks 不同步 | 4.x 未勾 | 已勾 / 改措辞 | 读 tasks.md |
| P3-6 proposal 抖动 | 「1e-6 级浮点抖动」 | 「逐字节不变」 | 读 proposal + R6 |
| P3-3 哨兵盲区 | 信息项 | 仍存（已记入 `tasks.md:40`） | — |
| P3-5 采样 vs 连续余量 | 信息项 | 仍存 | R13 |

> 注：以上「已修」的实现者动作（12:25–13:41）**早于**本报告首次落盘（≈13:29 起），即实现者是**独立**处理了与我一致的发现；`tasks.md:38-40` 把它记为一轮零上下文审阅（P0=0/P1×1/P2×2/P3×4）。

---

## 10. 附注 / 环境

- 机器重载（4 核、load ≈ 8–19，另有并发 agent 在同一 worktree 跑 `spacing-sweep`），单 seed 整场 sweep 约 8–17 分钟。
- ⚠️ **`cargo test` 的「并发编辑假红」**：我在当前树跑默认套件时拿到过一次红——`p16_spatial_features::provenance_carries_the_comparability_triple`（`tests/p16_spatial_features.rs:1736`）报「指纹必须可由磁盘源码独立重建」不符。**这是 artifact，不是缺陷**：该测试把 `include_str!`（**编译期**源码）算的指纹与**运行期读磁盘**的源码比；我在 `cargo` 编译后、测试运行前，实现者于 **13:41 又改了 `engine/src/lib.rs`** ⇒ 两侧源码不同 → 红。**证据**：等编辑落定后单跑该用例 → `ok`（`lib.rs` blob 前后均 `f467cb63`、mtime 13:41 稳定）；随后 `--lib`/`p16`/`realism` 三个二进制全绿（R8b）。**给下游的提示**：**并发编辑期间任何一次 `cargo test` 都可能出现这类假红**，判红前先确认源码未在跑测期间变动（记 blob hash）。
- 我用的临时探针 `/tmp/zz_verify149.mjs` 在**仓库外**，无需清理；仓库内 `viewer/zz_*.mjs` 是作者自带探针（未提交），**我未新增/改动仓库的受审文件**。
- `node_modules` 自指 symlink 已损坏（同 design §D4c），本次所有测试均不依赖它。
