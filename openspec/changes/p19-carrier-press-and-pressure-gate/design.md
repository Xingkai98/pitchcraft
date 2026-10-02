> # ⬛ #19 结项：负结果（D）——「最小单点生成改造」被证伪（2026-10-01）
>
> **结论**：`#19` 的最小单点生成改造**被证伪**。
> `OPEN_PLAY_PASS_PRESSURE_M`(8 m) 硬门**确实**是开放比赛射门路径的瓶颈
>（机制由 **独立 grill + 独立审阅双重复核**：8.0 与 `SHOT_PRESSURE_NEAR_M` 同常量、
> 连续压迫项在射门路径可达时恒为 0、两者在 8.0 处恰好互补），
> 但**把门形状改对之后**——`press 移均值 × L1 带余量薄（1–6%）× 引擎窗抖动` 三者相乘
> ⇒ **无连续可行区间**（米制 standoff 扫掠 `[5.35,5.95]` 步长 0.02 × 官方全套 × 三窗，
> 最长连续可行段 **0.04 m ≪ 0.10 m**）。
> **引擎未改动**（`engine/src/lib.rs` = 基线 `2adfe62b…`）。
>
> **这不是「L1 带定义矛盾」**（出处核查排除了：见
> `.scratch/notes/19-band-provenance-2026-10-01.md`）——而是**引擎贴着带沿站**：
> 射门(17.1)与抢断(30.4)都**低于**真实(21.6/36.9)，且要**同时抬升并保持比值**
>（贴真实 0.586），**单点改动做不到**。
>
> **#19 的真价值**：证明「为什么前六个 change（P15A→P18）都推不动引擎」——
> **不是分析不够，是这个结构结**（射门/抢断/犯规由同一处接触几何驱动，单点改必破另一带）。
>
> **证据**：`.scratch/notes/19-recon-2026-10-01.md`（侦察）+ `19-shape-probe-2026-10-01.md`
> （形状探针 §11 无洞扫描 + §12 区分实验）+ `19-band-provenance-2026-10-01.md`（带出处）
> + 本 change 的 `GRILL.md`（独立对抗审阅）。
> **裁决**：`#19` = 负结果结项，**frontier 待用户裁定下一步**。
# P19 设计：压力门形状 + 开放比赛逼抢（最小生成改造）

日期：2026-10-01
基线：`engine/src/lib.rs` sha256 = `2adfe62b49db00e8044d3e78c594b9290a4f111b8135cbd79adcad7f216f4cc1`
证据：`.scratch/notes/19-recon-2026-10-01.md`（侦察）、`.scratch/notes/19-shape-probe-2026-10-01.md`（形状探针）

---

> ## ⛔ 最终裁决（2026-10-01，独立审阅要求的**无洞区间扫描**后）：**D —— 无连续可行区间，不进实现**
>
> **裁决经三次翻转，最终为 D。** 前两次翻转（grill 改几何 → 有界调查修 retreat bug）都指向
> 「可行带存在」；**第三次是决定性的**：独立审阅（对 `d7ac7a8`）要求划出**有无连续无洞区间**，
> 严格扫描（`standoff ∈ [5.35,5.95]` 步长 0.02，**官方 realism 全套** × 三窗含两留出窗，
> B4 用权威判据器）后——**无连续 ≥0.1 m 的可行段**（最长仅 0.04 m）。
> 完整表与判定见 `.scratch/notes/19-shape-probe-2026-10-01.md` **§11**。
>
> **关键结果**：能过全套+门的点全是**孤立散点**（5.43 / 5.49 / 5.57 / 5.61 / 5.63 / 5.65），
> 每个点的相邻点（±0.02 m）都在**至少一个窗**上破带，破的是**哪条带/哪个窗随点漂移**。
> ⇒ 「可行」不是行为制度，是 **seed 窗 × standoff 的巧合**。下界由 `shot/tackle 比值 [0.5,1.5]`，
> 上界由 `B4 ≥ 0.28`，中间叠着 `射正率 [0.28,0.39]` 与 `禁区内进球占比 [0.72,0.92]` 的逐窗抖动洞。
>
> ⇒ **机制（硬门形状是瓶颈）成立**（grill 从代码复核确认），**但带间无可站立的连续区间**——
> 工程带宽 < 带间可行域宽度。走 A 须**同时**放宽/重标 L1 某几条带（用户级）**或**动接触几何（更大 change），
> 二者都不是「最小改造」。**本 change 不进入实现。**
>
> ⚠️ **按主 session 指示，本轮未动**：spec 常量（B5，仍写 `4.0`）、p53 修复（B4 类）、爆炸半径分类——
> 这三项取决于本次扫描结论，待用户裁定后再处理。
> 下面 §1–§9 保留为历史；其 §3–§4 的窗口数值（归一化几何产物）按 §11 作废，机制分析仍成立。

---

## 1. 问题陈述（实跑更正后）

| 主张 | 状态 |
|---|---|
| 「防守方起始 61.5 m，远离持球者」 | ❌ **撤回**：#18 已撤销的口径（种群是松散球 `chase`，非持球拍） |
| 「持球拍最近防守者 7.79 m（真实 6.0）」 | ✅ 实测 |
| 「只有 6.3% 的持球拍有防守方朝持球者逼近」 | ✅ 实测（B4 真信号） |
| 「防守移动是队形驱动、非对手驱动」 | ✅ 实测（持球拍防守方 mover：`run` 58961、`close_down` 215） |

**根因**：开放比赛里**没有任何球员被指派去逼近持球者**（`compute_mover_candidates` 的
`close_down` 只在 transition 分支指派）。而**射门路径**又被一个**硬门**卡在 8 m：

```
lib.rs:1836  if gk_holding || nearest_defender_m <= OPEN_PLAY_PASS_PRESSURE_M(8.0) || stalled → 出球
```

## 2. 关键机制：硬门与连续压迫项「恰好互补」

- 射门打分（`lib.rs:6081`）**本就有连续受压惩罚**：
  `defensive_pressure() = 0.65·clamp01(1 − nearest/8.0) + 0.35·clamp01(1 − second/16.0) + pressure_state·0.12`
- 但硬门在打分之前 return ⇒ 射门路径**只在 `nearest > 8` 时可达**；
  而连续项在 `nearest ≥ 8` 时**恒为 0**（`1 − 8/8 = 0`）。
- ⇒ **两者恰好在 8.0 处互补**：连续机制**结构性够不着**（用**同一个常量** 8.0，`SHOT_PRESSURE_NEAR_M` 与
  `OPEN_PLAY_PASS_PRESSURE_M` 数值相同，lib.rs:556/576）。

**纯函数算例**（证连续机制动态范围足够）：持球者距门 6 m、正对：
- 防守者 4 m：`pressure=0.478`、`score=1.22`、`p_engage≈0.107`
- 防守者 12 m：`score≈3.28`、`p_engage≈0.588`
⇒ 受压把射门概率从 59% 降到 11%——**足以**表达「变难但非不可能」。

## 3. 两处最小改动

### 3.1 `evaluate_open_play_carrier_action`（压力门形状）

**改法**：拆出 `pressured`（`nearest ≤ OPEN_PLAY_PASS_PRESSURE_M`）与
`gk_holding || stalled_unpressed`。**出球优先只保留后者**；`pressured` 改到射门掷定**之后**判：

```text
// 出球优先（门将 / 停滞）——不变
if gk_holding || stalled_unpressed { return Pass }
// 射门推进掷定——现在受压持球者也走这里（原先被硬门挡住）
if open_play_shot_engage_hits(st, rng) { … }
// 未启动推进 + 受压 / 停滞 → 出球（原硬门的落点后移）
if pressured || stalled_unpressed { return Pass }
// 否则带球
```

**语义变化**：`pressured` 从「**禁止**射门推进」变成「**降低**启动概率但不禁止」——
因为 `open_play_shot_engage_hits` 用的是 `compute_shot_score`，其 `defensive_pressure` 项此刻**非零**。

### 3.2 `compute_mover_candidates`（开放比赛逼抢指派）

**改法**：开放比赛分支（非 transition）指派**无球队最近 1 名外场**（复用 `pick_close_down_players`，
n=1）以 `CLOSE_DOWN_STANDOFF_M` 距离逼近持球者，复用既有 `close_down_stop` 几何：

```text
} else if carrier 是外场 {
    let c = st.pos[carrier];
    let ids = pick_close_down_players(st, 1 - possession, c, 1);
    let tgt = close_down_stop 到 standoff 距离外（朝持球者）；
    (ids, tgt)
}
```

**新常量**：`CLOSE_DOWN_STANDOFF_M`（见 §4 的窗口标定）。**纯防守侧**，不动持球侧判定。

## 4. 可行窗口（三窗联合，决定新常量取值）

**B4（30 seed 直测）随 standoff**：3→0.319 / **4→0.288** / 4.5→0.269 / 5→0.248 / 6→（抢断塌）。
**L1 三窗（401..600 / 601..800 / 801..1000，各 200 场）**：

| standoff | 三窗射门 | 三窗抢断 | 三窗犯规 | 判定 |
|---:|---|---|---|---|
| 3.5 | 16.2–16.8 ✅ | 34.1–34.4 ✅ | **30.2–31.2** ❌ | ❌（犯规 > 30） |
| **4.0** | **18.3–18.7** ✅ | **32.9–33.5** ✅ | **27.5–28.2** ✅ | ✅ **B4=0.288 过** |
| 4.2 | — | — | — | B4=0.280 < 0.28 ❌ |
| 5 | 21.3 ✅ | 28.9–29.6 ✅ | 26.5–27.2 ✅ | ✅ 但 **B4=0.248** ❌ |
| 6 | 23.5–23.9 ✅ | **22.2–22.4** ❌ | 25.6–26.4 ✅ | ❌（抢断 < 24） |

⇒ **联合可行窗口 standoff ∈ [≈4.0, ≈4.15]**；**取 `CLOSE_DOWN_STANDOFF_M = 4.0`**。
窗口窄（~0.15 m）但**三窗稳定**（边界单调，非随机漂移）：下界由**犯规带**（贴近→犯规爆）、
上界由 **B4 ≥ 0.28**（= #18 带下沿）。

> ⚠️ **窗口窄是本 change 的已知脆弱点**（design §7 决策 1）。它是「防守侧也有个窗口」的直接体现
> （用户侦察提示的线索）：贴近则犯规爆、远离则抢断塌，只留下中间一条缝。

## 5. 爆炸半径（**改坏了什么** —— 本 change 的核心风险面）

> ⚠️ **本节已更正（2026-10-01，独立 grill 指出）**：初版写「默认 `cargo test` 4 红」——
> **低估**。那次 `cargo test` 在**第一个失败的 test binary 就停了**（默认 fail-fast 停在该
> binary 的其余用例），故**没跑到** golden master 与 P15 精确流哈希两个 binary。
> 实测补跑（prototype 下）确认 **两条精确流哈希门也红**：

| 测试 | 现象 | 性质 |
|---|---|---|
| `realism.rs::gm_canary_seeds` | seed 1 起 `home_score` 等摘要字段 + `stream_hash` 漂移 | **golden master 精确哈希门**（须 MODEL_VERSION/重基线决策） |
| `p15_behavior_observation.rs::recorder_on_and_off_reproduce_the_golden_canary_stream` | seed 1 正式路径偏离 golden-v7 | **P15 精确流哈希门**（同族） |

⇒ 真实的爆炸半径 = **≥6 红**（下表 4 条 + 上述 2 条精确哈希门），**且不是全部**——
`l1_shot_result_distributions` 的九条桶比例带、`l1_tackle_dilution` 的 shot/tackle 比值带、
`l2_cross_event_invariants`、`p124_intent_observations` 的射门窗口/防守意图时序断言**都是
blast-radius 候选**（grill 逐条列出，见 `GRILL.md`「P2 Issues」末条）——**未经完整 `--no-fail-fast`
跑过不能声称「只有 N 条」**。若将来重启本改造，第一件事是 `cargo test --no-fail-fast` 全量清点。

**原始 4 条（未含精确哈希门，故不完整）**：

| 测试 | 现象 | 归因（逐个隔离实测） | 处置 |
|---|---|---|---|
| `tests::v2_highlight_gate_frequency` | 高亮 **~510/场** vs 期望 ~410 | **press 单独即触发** | 重钉期望值 + 记录依据（事件量合法上升） |
| `observation::tests::every_episode_and_restart_object_has_event_indexes_or_a_documented_exception` | seed 集不再覆盖三种截断形态 | 事件流改变 → 原 seed 失效 | 重钉 seed + 记录（P15A 移植先例） |
| `observation::tests::truncated_stream_produces_a_full_time_gap_by_design` | 该 seed 不再有未决飞行截断 | 同上 | 重钉 seed + 记录 |
| **`tests::p53_same_team_spacing_holds_between_anchors`** | **seed 4 t=5104 id12/15 同队扫掠间距 1.74 m < 2 m** | **仅 combined 触发**（press-only、shape-only 各自都过） | **必须修**（下述） |

> **注**：由于本 change 走 **D（不实现）**，上表**不是**「待拼的收尾工作」，而是**否决证据的一部分**——
> 即便机制成立，爆炸半径已触及 golden 版本决策（用户级）。

**p53 是真不变量破裂** —— **已在修复版原型（standoff 5.5）上复测确认**（2026-10-01）：
**30 seed 里 1 处**（seed 7 t=1461 id7/10，1.608 m < 阈值 1.98 m；pristine 0 处、worst 2.130 m）。
归因（逐个隔离）：**press-only 单独即触发**（seed5 1.769 m）；**shape-only 不触发**（p53 通过）；
combined seed7 1.608 m。⇒ **是 press 侧引入的真风险**，不是形状的。
证据：`notes/probes/p53-fixed-count.out.txt` + `zz_p19_p53.rs.txt`。
诊断：违规双方是 `run` mover（**不是** presser 本人）——press 改变队形/排斥求解的输入，
在极少数拍上逼出一次**拍内扫掠**穿叉。候选修法（实现期评估，**一次一个变量**）：

> ⚠️ **这是本 change 唯一未闭合的硬风险**（`p53` 是 main spec 的 requirement，非偏好）。
> 修复版窗口（5.5–5.75）**未经** p53 干净；**实现前必须先收掉**，否则「改好 B4、破同队间距」。
> 下列修法自初版沿用，**均未实测**（A 已试且无效）：

- **修法 A**：press 的目标点经 `separate_target_point` 端点分离（已试，**无效**——违规是**扫掠**非端点）。
- **修法 B**：把 presser 加入 `commit_beat_positions_ex` 的 `swept_light`（豁免拍内扫掠侧推）——
  但违规者非 presser，预期也无效，须实测。
- **修法 C**（最可能有效）：press 指派**收敛检测**——presser 已在 standoff 内则**不产 mover**
  （避免「来回蹭」制造重复扫掠）；或对 presser 的每拍位移设更紧的扫掠解算。
- **修法 D**（兜底）：若 A/B/C 均无效，**下调 press 强度**（如 presser 只在远离时逼近、近了就停），
  以 B4 余量换扫掠干净——可能需回到 §4 窗口重标。

> **若修法全失败** ⇒ 这是「最小改造实际需要动第 3 处耦合点（分离 solver）」的信号，
> 按任务书 §6 **停下来报告**。修法探索**设轮次上限**（本仓教训：连续 2 轮同族不收敛即止损）。

## 6. 与 L1 / golden 的关系

- **L1 四带**：**不改**——三窗全过（§4）。**这是本 change 与 naive press 的分水岭**。
- **golden**：事件流**合法改变**（改动即目的）。处置见 §8。
- **场均统计**：仅作**护栏**（L1），不作优化目标。

## 7. 待决策（**停下来找用户** —— 本仓流程：设计定稿 → 用户确认 → 实现）

1. **接受窄窗口吗？** standoff 可行集仅 ~[4.0, 4.15]。若可接受，实现按 4.0；
   若不可接受，须先探索「防守侧窗口」为何这么窄（可能要动犯规/抢断的结算几何 → 更大改动）。
2. **p53 修法取向**：优先 A/B/C/D 的哪条？若都失败是否接受「停下报告」（第 3 处耦合点）？
3. **golden 处置**：本 change 会改变 `golden-v7` 下的多个 seed 流。是重生成 golden（用户级）
   还是只记录「合法改变」不重钉？（#18/`p15` 先例是**重钉 + 记录**。）
4. **A1/A2 明确不在本 change 范围**（仍 3.4–4.1×）——确认这个 scope 切分。

## 8. 验收计划（实现后）

- `cargo test`（默认套件）**全绿**（含上述 4 条的处置结果）；
- `cargo test --test realism --release -- --ignored` **全绿**（L1/L3 四带 + 动作体量带）；
- **#18 判据**同 seed canary 前后对比：A1/A2/B4 + 护栏 A3/C1 **全报**；B4 应从 0.0581 → ≥0.28；
- **三窗**（401..600/601..800/801..1000）射门/抢断/犯规/传球成功率**全过**（防窗口过拟合）；
- **同 seed 可复现**：同 seed 两次模拟流哈希相同（确定性不破）；
- **golden 处置**：按 §7 决策执行并记录；
- **事件流确定性说明**：改了什么、哪些 golden 重钉、同 seed 前后是否可复现——写入 note。

## 9. 参照物/口径纪律（本仓头号缺陷）

- B4 的参照物是 `beat.main`（持球者），**不是 `beat.ball`**（#18 第三轮 grill 的教训；
  本 change 的侦察 F1 又踩了同一个坑的**引用侧**——`map.md` 引了 `chase`/`ball` 口径）。
- 「距离」用米制（×PITCH_LENGTH_M/WIDTH_M），**不是**归一化欧氏（#53 的教训）。
