# P17A（#17A）行为链基线分析报告

日期：2026-09-24（**2026-09-25 在 main 基线上重算**，见 §8）
分析器：OpenSpec change `p17a-behavior-chain-baseline-analysis`（`p17a-4`，第四轮审阅修复后）
口径与判据的权威定义：该 change 的 `design.md §3`；本文档只记录**本次运行的结果**与解读。

> **本文档的样本在 2026-09-25 换过基线。** 初版跑在一条 `MODEL_VERSION = 6`、且祖先里含有
> 无球 demo 提交的分支上；P15A 移植到 main 后重跑，`MODEL_VERSION` 变成 7（含 P104 体积重标定）。
> **判据（10 条规则、阈值、口径）一字未改，触发集合仍是 6/10**，但**所有数值都变了**。
> §0–§6 的数字是 **v7 main 基线**上的；§7 的两处复跑记录仍是 v6 当时的，未改写。
> 完整的移植与重算记录见 §8。

- 源码 commit：见产物 `provenance.source_commit`（`engine/src/` 未改动）。
  **此处刻意不写死哈希**：本文档与产物同属一个提交，任何后面的 rebase/amend 都会让写死的哈希
  指向不存在的对象（本次移植就发生过一次）。哈希请从产物里读，或按 §0 的复现命令重跑。
- `MODEL_VERSION` = 7，engine crate 0.1.0
- sidecar schema 指纹：`fnv1a64:7c76518ceff85604`（与 v6 相同——观察契约未变）
- **引擎源码指纹**：`fnv1a64:8845fafb13713cb8`（哈希编译进二进制的 `lib.rs`+`observation.rs`+`rng.rs`
  文本；见 §7 说明为什么光有 commit 不够，以及为什么必须覆盖 `rng.rs`）
- config：`match_duration_seconds = 5400`（90 分钟），`demo_mode = false`，seed `1..=300`
- 产物内 `caliber_constants`：`tick_seconds=1`、`loose_max_ticks=2`、`transition_ticks=4`、
  `intercept_d_tight_m=6`、`intercept_d_mid_m=12`、`pitch_length_m=105`、`pitch_width_m=68`

复现命令：

```bash
cd engine
P17A_SOURCE_COMMIT=$(git rev-parse HEAD) \
  cargo test --release --test p17a_behavior_chain_baseline -- --ignored --nocapture p17a_baseline
# canary（前 30 seed，baseline 的前缀子集）
P17A_SOURCE_COMMIT=$(git rev-parse HEAD) \
  cargo test --release --test p17a_behavior_chain_baseline -- --ignored --nocapture p17a_canary
```

产物（不进版本库，`P17A_OUT_DIR` 可覆盖）：`engine/target/p17a-baseline/{baseline,canary}.{json,md}`。

样本量（300 场 × 90 分钟）：338,120 `ControlFact`、30,179 episode、15,584 restart、
20,053 争抢、1,750,964 事件（其中 `beat` 1,609,360、决策动作 140,366）、
**0 gap、0 不变量违规、0 未闭合 episode**。
（canary 30 场：34,012 facts、3,075 episode、1,613 restart、2,027 争抢、175,117 事件。）

> **本报告经过三轮独立审阅并据此修订**（2026-09-24）。第一轮发现两处必须修的问题——
> 口径错误（by-kind 统计被池化）与机制误指（把无读取点的死常量当作 A1 的成因）；
> 第二轮又发现 A2 的替代机制同样被产物反证（`Some`/`None` 说不成立）与一次"两产物不同源"的事故；
> 第三轮在**口径一致性**上又抓到 2 处（A7 报数与报告表口径不同、A5 证据母体与统计量分母不同）
> 与 6 处措辞/覆盖问题。完整修订记录见 §7。**下面所有数字都取自修订后的产物**
> （三轮修完、同一棵干净树重跑，§7 有同源守卫与逐字节稳定性核验）。
>
> **阅读本报告前请先读 §7 第一条**：本轮**没有使用任何真实比赛数据集**，所有"预期量级"
> （1–3 s、20 s 等）都是**未标定的领域假设**，规则阈值是**内部诊断阈值**。
> 下文的"异常"一律是**待验证的候选**，不是已确认与真实足球不符。

---

## 1. 头条结论

当前模型的问题**不是**统计量偏差（射门 6–11/场、犯规 16–30/场、传球成功率 82–90% 都已在
`tests/realism.rs` 的 L1 带内），而是**球权转移的全部过程几乎不消耗时间、也几乎不由位置决定**：

| 头条数字 | 值 | 含义 |
|---|---:|---|
| possession 内相邻动作间隔 | **12.64 s**（P50 10.9，P90 17.0，最大 43） | 出球由行动机会 deadline 驱动 |
| 争抢时长 = 0 s 的占比 | **52.7%**（10,564 / 20,053） | 松散球不是竞争状态 |
| 争抢时长的全部取值 | **{0,1,…,10}** 十一档 | 与球员速度无关的离散档位 |
| 拦截/抢断后原队夺回率 | **0.0%**（7,186 与 4,514 次，无一例外） | 归属由丢球方式预定 |
| 传球 `lost` 后原队夺回率 | **94.7%**（2,001 次） | 「失败传球」不造成失球 |
| 任意球准备期 | 恒 **1.0 s**（6,172 次，场间 sd 0） | 球位恰在发球者脚下 |
| 门球准备期 | 恒 **0.0 s**（4,901 次） | 结构上跳过准备期 |
| 争抢位置落在**中央 40% 区间** `x∈[0.3,0.7]` | **78.2%**（五等分带 `[800, 6335, 5580, 6407, 931]`） | 两端各 20% 的区间合计仅 8.6%，丢球几乎不发生在两端 |

> 措辞更正（第三轮审阅）：上一条原先写作"中线两侧的**窄带**"。`x∈[0.3,0.7]` 覆盖球场
> **40%** 的纵向长度，本身不窄；本条异常的依据是**两端近乎空集**（五等分带 0 与 4 合计 6%），
> 不是"带很窄"。产物 `baseline.md` 与规则 A8 的文本已同步。

累计 possession 时长 5054.0 s / 5400 s = **93.6%** 的墙钟时间处在某队明确控制之下，
其中每段平均 50.7 s 却只包含 3.97 个决策动作。

## 2. 触发的异常模式（6 / 10 条规则）

分析器 10 条规则全部运行；以下是 6 条判定为异常的。其余 4 条见 §3（**不是**"没检查"）。
每条含数量证据、回放定位、机制假设与缺失证据；完整版见产物 `baseline.md §6`。

### A1 持球-出球节奏：相邻动作间隔 12.64 s（high）

- **证据**：91,039 个 episode 内动作间隔；逐场均值再跨场平均 12.64 s，P50 10.89、P90 17.03、最大 43。
- **回放**：seed 41 @ 2609 s episode 48（事件 2831/2877/2895/2905，最大间隔 43 s）；
  seed 249 @ 427 s episode 9；seed 279 @ 4146 s episode 88；seed 98 @ 5228 s episode 75。
- **为什么不像足球**：持球时长与场面脱钩，且动作数被压到 3.97——真实足球里持球时长由压迫、
  接应选项和推进机会决定。
- **机制（已读代码核对 + 变异实证，2026-09-24 更正）**：**不是** `HOLD_MIN_TICKS`/`HOLD_MAX_TICKS`
  ——它们在 P31 删槽位后**已无任何读取点**（`lib.rs` 只剩声明；改它们不改变任何输出）。
  真实驱动是 P28/P31 的**行动机会 deadline**：`advance_action_opportunity`
  只在 `opp.age_ticks >= opp.deadline_ticks` 时才让 `build_action_plan` 产出一次决策，
  deadline 由 `action_deadline_for` → `compute_action_deadline`
  从 `BASE_ACTION_DEADLINE_TICKS=7` 按危险/压迫/出球空间压缩到
  `MIN/MAX_ACTION_DEADLINE_TICKS=3/12`（门将 +3）；
  结算为「继续带球」时会**重新开一个机会再等一轮**，故间隔是若干轮 deadline 之和——
  这解释了 P90 达 17.0 s、最大 43 s，而不是停在 12 s 上界。
  （**行号已从本文档移除**：它们是从 demo 派生分支上抄来的，移植到 main 后全部漂了；
  引用一律改用符号名，见 §8。）
  **变异实证**（**2026-09-25 在 main 基线上重跑**，`lib.rs` 已还原为 pristine）：
  把 `BASE_ACTION_DEADLINE_TICKS` 从 7 改成 3 后，同一 30 seed 上间隔
  **12.64 s → 8.54 s**，episode 动作数 **3.90 → 4.24**、episode 数 3075 → 4065。
  （单位与 §1 头条同为**分析器口径**：只计决策动作、逐场再跨场平均。)
  这同时证明了两件事：
  ① 该常量确实是本指标的驱动（不是死常量）；
  ② **即使把它压到 3，间隔仍停在约 8 s**——因为 `MIN_ACTION_DEADLINE_TICKS=3` 是硬下界，
  单靠这个常数**到不了**真实足球的 1–3 s。这是 #19 必须知道的一条边界。
- **缺什么**：#16 空间特征——无法区分「无人可传而持球等待」与「按 deadline 等待」。
  **注意**：`PRESSURE_URGENCY`/`ESCAPE_BONUS` 已把压迫与出球空间计入 deadline，
  所以本条**不是**「与场面完全无关」，待空间特征到位后应重新表述。

### A2 争抢时长退化：53% 的松散球同 tick 被拾回（high）

- **证据**：20,053 次争抢，时长取值只有十一档：`0s=10564, 1s=131, 2s=8, 3s=9063, 4s=155,
  5s=45, 6s=33, 7s=22, 8s=18, 9s=12, 10s=2`。逐场口径下各原因时长：`interception_loose=0.00s`（sd 0）、
  `tackle_loose=3.00s`（sd 0）、`delivery_loose=1.52s`（P50 1.31，sd 0.44）、`pass_lost=2.63s`。
- **回放**：seed 1 @ 55 s（`interception_loose`，事件 58）、seed 1 @ 217 s（`delivery_loose`，事件 232）、
  seed 1 @ 445 s（`interception_loose`，事件 478）。
- **为什么不像足球**：`control_lost → contest → pickup` 多数情况下不占用任何时间；松散球只是
  一条记账旁路，而不是球员跑动去争的状态。
- **机制（两轮审阅后更正）**：时长档位由**「指定的追逐者是否已经在球上」**决定，**不是**由
  `winning_team` 的有无决定——第一版报告说「`Some` ⇒ 0 s、`None` ⇒ 3 s」是错的，被产物自身
  反证：`tackle_loose` 走 `Some(防守方)` 却恒 3 s，`pass_lost` 走 `None` 却同时出现在 0/1/3 s。
  真正判据是 `advance_loose` 的第一个检查——**松散球创建当刻 `chaser` 是否已在
  `PICKUP_RADIUS_METERS`（0.5 m）内**：是则当拍拾取（0 s），否则追逐者要跑过去
  （≈3 tick）。`interception_loose` 恒 0 s 是因为拦截路径**显式把拦截者对账到拦截点**
  （`intercept_pass_highlight` 内注释「拦截者位置已对账到 at」）；`tackle_loose` 恒 3 s 是因为
  抢断的松散球点取 `deflect_point(...)`，把球捅到离抢断者约 5.25 m（`TACKLE_DEFLECT_DISTANCE=0.05`
  归一化 ≈ 5% 球场长）处，追逐者必须先跑过去。`winning_team` 只决定**谁被允许追**，不决定 0 还是 3。
  角球 battle（`start_battle_loose`）仍是唯一双队对等的争抢。
  **本轮已识别但未做的细分**：按 `RestartKind` 拆开 `delivery_loose` 即可判定其夺回率来自
  battle 还是门球（门球是该原因最大来源）——留给 #16 之后（不改变 A2 结论：时长仍退化）。
- **缺什么**：#16 空间特征——需要落点附近双方距离才能断言「对手本可赶到」。

### A3 丢球归属由「丢球方式」预定：拦截/抢断 100% 归对手（high）

- **证据**：按争抢原因分解的夺回率极差 **94.7%**（阈值 60%）：
  `interception_loose = 0.0%`（7,186）、`tackle_loose = 0.0%`（4,514）、
  `pass_lost = 94.7%`（2,001）、`delivery_loose = 27.3%`（6,266）、`shot_rebound = 13.7%`（73）。
  总夺回率 18.1%（3,618 / 20,040）——**总率看起来「还算有争抢」，分解后才暴露确定性**。
- **回放**：seed 1 @ 55 s（拦截→对手，事件 58）、seed 1 @ 81 s（抢断→对手，事件 88）、
  seed 1 @ 117 s（传失→原队，事件 125）。
- **为什么不像足球**：同一类事件（拿到松散球）在三种丢球方式下分别是 0%、0%、94.7%，
  说明归属与球落在哪、谁离得近无关，而是由标签预定。直接后果：**拦截与抢断在行为上完全等价**
  （都等于换球权），抢断这个动作不产生任何附加过程。
- **机制（已读代码核对）**：拦截路径传 `Some(拦截者球队)`、抢断路径传 `Some(防守方)`
  → `nearest_in_team` → 对手不参与；`pass_lost` 与补射（`shot_rebound`）传 `None`
  → `nearest_any`，才有双向比较。
- **缺什么**：#16 空间特征（判断"对手是否本可赶到"）；但 0%/100% 的极端已足以说明
  结果不由位置竞争产生。

### A7 重开准备期：门球 0 s、任意球恒 1 s（high）

- **证据**：逐场口径准备期均值 `corner=15.27s(1048, sd 0.64)`、`free_kick=1.00s(6172, sd 0)`、
  `goal_kick=0.00s(4901, sd 0)`、`kickoff=4.11s(938, sd 1.67)`、`throw_in=4.22s(2515, sd 0.14)`；
  **场间 sd 为 0** 的方式有 2 条（`free_kick`、`goal_kick`）。
  交叉证据：`restart_preparation_started = 10682 < restart_taken = 15574`，差 **4892** ≈ 门球数。
- **回放**：seed 1 restart 1（任意球 @ 80 s，准备期 1.0 s，事件 **[87, 88]**）；
  restart 2（门球 @ 213 s，准备期 0.0 s，飞行 4.0 s，事件 **[230, 232]**）；
  restart 0（开球 @ 0 s，事件 [1]）——三条覆盖"常数准备期"的两种成因。
- **为什么不像足球**：重开是「球员走位、摆球、对手布防」的过程。门球在球出底线的同一秒被发出
  ——画面上球刚出底线就飞回场内；任意球恒 1 s，同样没有"走到球边"的过程。
- **机制（已读代码核对，2026-09-24 更正为两种不同成因）**：
  ① **门球是结构性的**——`observation::BehaviorObservationRecorder::goal_kick_started` 在死球
  **当拍**同时提交 `dead_ball_started` 与 `restart_taken`，完全不进 `RestartPreparation` 状态，
  故准备期恒 0。
  ② **任意球恒 1 s 不是常数，而是几何涌现**——准备期本身是「走向球位」的距离循环
  （8 m/step），`min_ticks = if kind == Corner { CORNER_SETUP_MIN_TICKS } else { 0 }`；
  而 `emit_foul_and_free_kick` 把球位设在**被犯规持球者自己的位置**（`spot = st.pos[carrier]`——
  注意不是"犯规者"，犯规者是事件的 `subject`）、发球者取 `nearest_in_team`，
  于是发球者恒在 1 step + 拾取半径内，下一 tick 即发出。
  真正按 kind 取常数的只有角球（`CORNER_SETUP_MIN_TICKS`）。
  **（原报告把两种成因合并成"按 kind 硬编码"，是错的。）**
- **缺什么**：#16 空间特征——需要发球者与球的距离，才能把②的「恒 1 s」从几何解释升级为
  可观测结论；①已由 sidecar 事实计数实证。

### A8 丢球位置集中在中带：78.2%（high，机制 medium）

- **证据**：20,053 次争抢中坐标合法的全部样本，落在 `x ∈ [0.3, 0.7]` 的占 78.2%；
  x 五等分带计数 `[800, 6335, 5580, 6407, 931]`——两端合计 8.6%。
- **回放**：seed 1 @ 55 s（x=0.422）、117 s（x=0.334）、217 s（x=0.638）、445 s（x=0.393）、
  545 s（x=0.565）。
- **为什么不像足球**：丢球区域决定转换发生的空间。若丢球只在一个横带发生，进攻不会因为推进到
  前场而冒险丢球，防守也不在自己的危险区承受压力；两者都是真实比赛的主要内容。
- **机制（未逐条核对，confidence medium）**：传球落点与队形纵向移动范围受限
  （`SIDE_SHIFT_FACTOR`、`OFF_BALL_RUN_DIST`）。
  **审阅已剔除原先并列的 `INTERCEPT_D_TIGHT_M/MID_M`**：那是围绕传球落点的**米制半径**，
  半径大小无法产生"集中在中场横带"这种位置分布，两者无因果关系。
- **缺什么**：#16 空间特征——需要 22 人宽度/纵深/线间距，才能区分「球到不了前场」与
  「到了前场但没人丢球」。本条是本轮唯一未做代码核对的机制假设。

### A10 失败传球不等于失球：`lost` 之后原队拿回 94.7%（high）

- **证据**：2,001 次 `pass_lost` 争抢中 94.7% 由传球方自己拿回（阈值 **>75% 即异常**，
  即本条判的是"夺回率过高"）。该原因下争抢时长 2.63 s。
  交叉检查：`EpisodeStartReason::SuccessfulReceive` 计数为 **0**，说明拿回走的是 `pickup`
  → **新 episode**，不是同一段控球的延续——控制权真的交接了。
- **回放**：seed 1 @ 117 s episode 3（事件 125）、seed 1 @ 595 s episode 13（事件 640）、
  seed 1 @ 1032 s episode 17（事件 1114）。
- **为什么不像足球**：`lost` 在统计口径里是失败传球（`l1_pass_completion_rate` 计入失败分母），
  但在过程里几乎不产生失球。与 A1 合起来意味着：**当前模型的球权转移只由「被拦截」和
  「被抢断」驱动，传球失误不参与其中**——失误的代价只是打断一次 episode、消耗约 3 秒。
- **机制（已读代码核对，比原表述更强）**：**结构性偏向传球方**，不是"通常离得近"——
  `lost_pass_highlight` 把落点设为 `lead_point(from_pos, to_pos, lead)`，即朝**原定接球队友**的
  提前量点，且**故意不把接球者位置同步到落点**；
  随后 `start_loose_ball(.., None)` → `nearest_any` 取全体最近者，而落点本就是按
  接球者选的，故拾回概率结构性偏高。对比拦截路径（传 `Some(拦截者球队)`）：
  那条路径的球直接飞向拦截者本人（`intercept_pass_highlight` 的落点 = 拦截者当前位置，
  其文档明写「拦截者离球最近默认拿到」），归属完全由标签预定。
- **缺什么**：#16 空间特征——需要落点附近双方位置，才能量化「本队确实最近」的强度。

## 3. 已检查但**未**触发的规则（4 条）

这 4 条是机器判定的"检查过、在带内"，不是遗漏。其中两条**推翻**了本报告起草时的直觉假设
（起草时据单场 recon 判断"射门前链过短""传递深度不足"），**以规则输出为准**：

| id | 规则 | 实测 | 阈值 | 结论 |
|---|---|---:|---|---|
| A4 | 重开后立即丢失 | 13.1%（2032 / 15565） | > 25% | 在带内；重开交付多数能形成控制 |
| A5 | 射门前成功传球数 | 3.56（P50 2.35，P90 8.21，n=5741） | < 1.0 | **未触发**——射门前有多次传球，链长不短 |
| A6 | 空转 possession（≥20 s 且动作 ≤1） | 5.1%（n=30179） | > 20% | 在带内；动作数 3.97 与 A1 的 12.64 s 间隔自洽 |
| A9 | **开放比赛**成功传球（排除交付）≥2 的 episode 占比 | 53.5% | < 20% | **未触发**——多脚传递是常态 |

A5 与 A9 未触发是本轮最值得记录的一点：它说明"场均链长看起来短"与"链长真的短"是两件事，
只有把口径写成机器规则才能避免把 recon 阶段的印象写进结论。A1 的缺陷体现在**时间**上
（12.64 s 的间隔），而不体现在**动作数**上。

> 口径注 1（A5 分母）：A5 的分母是「动作链里含 `shot` 事件的 episode」（5741），**不是**
> `end_reason ∈ {goal, saved_caught, shot_rebound}`（572）。两者不可互换。**证据样本也必须
> 取自同一母体**——第三轮审阅发现原先的回放样本按后者挑选（572 那一撮），已修
> （守卫 `a5_evidence_comes_from_the_statistic_population`）；现在样本里能看到
> `射门后以 out 收场`、`被扑出后由对手控制` 这些"射门没进"的主要形态。
>
> 口径注 2（A9 分母）：A9 只计**开放比赛**成功传球，定位球**交付**不计（它是重开片段的第一步，
> 不是开放比赛的推进）。含交付的旧口径为 59.9%，有 1931 个 episode 仅靠"交付 + 一次开放传球"
> 达到「≥2」。两种口径都不触发，故结论不变；变的是语义。
> 守卫 `multi_pass_share_counts_open_play_passes_only`。

## 4. 缺失证据与下一步（#15B / #16 的接口）

本轮**全部**结论只能定位到"什么现象"，无法定位到"为什么"，因为：

1. 没有 phase（#15B）：无法说明多脚传递缺失发生在 build_up 还是 progression，也无法判断
   射门前链长 3.56 是否集中在 final_third。
2. 没有空间特征（#16）：A1/A2/A3/A7/A8 的机制假设都需要「球附近双方人数 / 最近防守距离 /
   发球者到球距离 / 22 人宽度纵深」才能从假设升格为结论。
3. 事件流不含 `dribble` / `interception` / `off_ball_run` 顶层事件：带球推进不产生动作步，
   所以"动作数"不能直接读成"触球数"；拦截编码在 `pass.result` 内。

## 5. 推荐的前后对比口径（交给 #19）

**固定 seed 集**：`1..=300`（canary 用 `1..=30`，是前者的前缀子集；两者都固定 90 分钟）。
**主指标**（改动后必须一起看，单看任一项都会被压平量级的改动骗过）：

| 指标 | 本轮基线（v7） | 方向 |
|---|---:|---|
| possession 内相邻动作间隔（s） | 12.64 | 降低至 1–3 s 量级 |
| episode 动作数 | 3.97 | 在时长下降的前提下**不降** |
| 争抢时长取值档数 / 0 s 占比 | 11 档 / 52.7% | 档数上升、0 s 占比下降 |
| 拦截/抢断夺回率（各自） | 0.0% / 0.0% | 脱离 0/1 极端 |
| `pass_lost` 夺回率 | 94.7% | 降到与其他丢球方式同一量级 |
| 场间 sd 为 0 的重开准备期方式数 | 2 | 归零（每种方式都有分布） |
| 争抢位置中带占比 | 78.2% | 下移，两端球门区出现丢球 |
| motif `pickup→pass→lost` | 5.91%（833 / 14100） | 与新的球权转移口径一起复核 |

**护栏（不是优化目标）**：`tests/realism.rs` 的 L1 带（射门 6–11/场、犯规 16–30/场、
传球成功率 0.82–0.90）；`tests/p15_behavior_observation.rs` 的逐字节一致门与 300-seed 校准门。

**建议的最小改造候选**（#19，本 change 不改生成）：先只动**松散球追逐者选择**一条——
让 `winning_team` 路径的对手也进入 `LooseBall` 的追逐判定（即把 `start_loose_ball` 的单队
`chaser` 换成双队追逐，复用已有的 `battle` 机制），其余不动。理由：
① 它直接改善 **A3/A10**（归属预定），两处证据都指向这一个函数；
  **但它不会改善 A2 的主要部分**——A2 里 68.0% 的 0 s 争抢是 `interception_loose`
  （7186/10564），而拦截者本就被引擎对账到球上（距离 0），让对手也来追也拦不住他当拍拾取；
  A2 要另想办法（若要缩短"追过去"的 3 s，得改 `deflect_point` 的弹开距离或拾取半径）；
② 它是局部改动，不触碰射门带与犯规带；
③ 若改动后 A2/A3/A10 仍红，说明前提假设错，可立即回退而不影响其他流程。

**关于 A1 的额外提示（来自变异实证，2026-09-25 在 main 基线上实测）**：如果 #19 的目标包含把
持球节奏拉回 1–3 s，**单改 `BASE_ACTION_DEADLINE_TICKS` 到不了**——实测压到 3（下界由
`MIN_ACTION_DEADLINE_TICKS=3` 兜住）后间隔仍停在约 **8.5 s**（30 seed，分析器口径，逐场再跨场；
episode 数 3075 → 4065）。**端到端实测的差值只有 4.1 s**（12.64 → 8.54），即压掉基准 deadline
只解释了原间隔的约 **32%**——**其余约 68% 不随该常数变化**，指向「继续带球时重新开机会再等一整轮」
（`advance_action_opportunity` 的重置逻辑）与交付飞行 / transition 的固定开销。这两项不处理，
到不了 1–3 s。

> ⚠️ **不要把这条拆成「① deadline 轮次占 73% / ② 飞行为其余」**（2026-09-26 审阅更正）。
> 「73%」来自 **v6 时代的一次独立探针**（数 deadline 轮次 × 每轮 tick），**没有在 v7 上重新推导**；
> 而它与这里实测的 32% **不是同一个量**（一个是「间隔中来自 deadline 轮次的比例」，
> 一个是「把基准常数压到 3 后消失的比例」）。两个数并列会让读者以为能相加成 100%。
> #19 若要据此规划，须先在 v7 上单独推导拆分，**不要引用 v6 的 73%**。

## 6. 本次运行的已知局限

- **`first_control_delay` 与交付飞行时长恒等**：报告 M3 的两张表在本引擎上重复
  （守卫 `first_control_delay_equals_delivery_flight_on_real_path`）。不要当成两个独立证据。
- **A8 的机制假设未经代码核对**（见 A8 条内标注），置信度 medium。
- **"动作"只含决策事件**：`beat`（1,609,360 条，占事件 92%）不入链；带球推进无动作步。
- **事件下标可能跨 episode 重复**：sidecar 的 `event_indexes` 在 episode 交接处可能把同一条
  事件同时归给旧、新两个 episode（实测 seed 1 事件 2240、seed 4 事件 1732）。因此
  「episode 动作数」之和**不严格等于**决策事件总数（A5 分母 5741 > shot 事件 5314 即由此而来）。
  这是 #15A 绑定层的行为，本 change 不改，报告中不把它当作可加总的分区。
- **时间 basis 混用**：同一指标只混用同 basis 字段，但不同指标之间 basis 可能不同
  （`state_commit` vs `event_emit`）。
- **没有真实比赛数据集**（第三轮审阅补，最重要的一条）：见 §7 第三轮表格首行。
  各规则的"预期量级"是未标定的领域假设，阈值是内部诊断阈值；"异常"只能读成**候选**。
  本报告与产物 `baseline.md §6` 的所有标题已按此措辞改写。
- 本 change **不改生成逻辑**；以上异常候选不是调参依据，而是 #19 的输入。

## 7. 审阅修订记录（2026-09-24）

一轮独立审阅（adversarial review）发现并已修复：

| 类别 | 问题 | 修复 |
|---|---|---|
| **口径错误** | by-kind / by-reason 统计把**每条观测**各当一个"场"，`matches == observations`（如门球准备期 matches=3405），等于把设计 §3.1 禁止的池化偷偷引回：P50/P90 退化成均值、`cross_match_mean_sd` 膨胀 | 新增 `stat_by_match_and_key`（每场一个观测向量）；`matches` 现在 ≤ seed 数。守卫 `by_kind_stats_group_per_match_not_per_observation` |
| **机制误指** | A1/A6 把 `HOLD_MIN_TICKS`/`HOLD_MAX_TICKS`/`POSSESSION_HOLD_*` 当作成因——这些常量在 P31 后**已无读取点** | 改为行动机会 deadline 族（lib.rs:2225/1751/1731/1619/1077/1085-1088）；`caliber_constants` 同步换掉死常量 |
| **机制误指** | A7 把两种不同成因合并成"按 kind 硬编码" | 拆成①门球结构跳过准备期 ②任意球几何涌现（球位=犯规点） |
| **自相矛盾** | A2 说角球 battle 是"唯一非退化争抢"，A3/A10 说 `None → nearest_any` 才是双向——两者不能同真；且 `delivery_loose` 最大来源是门球而非 battle | A2 删除该归因并标注未做的细分 |
| **硬编码字数** | A7 正文写死"691 次"、A3 写死"7979/1417"，嵌入 canary 产物时与自己的表格矛盾（canary 实为 741/129） | 改为由指标插值（`criterion`）+ 正文不再出现计数 |
| **因果不成立** | A8 把拦截半径列为中带集中的成因（半径无法产生横带分布） | 剔除该子句，保留形状常量族并标注未核对 |
| **测试空转** | 指纹测试的内容敏感性只测了 `fnv1a`，删掉一个闭集仍绿 | 改为逐个断言 17 个闭集枚举与 `ALL` 对齐 |
| **测试空转** | canary/baseline seed 区间无默认路径断言（canary 改 1..=31 不会被发现） | 新增 `baseline_and_canary_seed_ranges_are_pinned_and_nested` |
| **测试空转** | 闭集 0 计数无断言 | 新增 `zero_count_closed_set_members_are_present_not_omitted` |
| **证据缺失** | A7 的回放定位 `event_indexes` 恒为空 | `RestartRecord` 携带 `event_indexes`（实测已填 [624, 640]） |
| **fixture 不可达** | 测试用了 `detail="goal_line"`，真实值为 `out_goal_line` | 改为真实值 |
| **口径未声明** | A5 分母与 design 表述不一致（2760 vs 572） | design §3.3 与 `metrics.rs` 注释对齐，报告 §3 加口径注 |

### 第二轮审阅（2026-09-24 晚）

| 类别 | 问题 | 修复 |
|---|---|---|
| **机制误指（blocking）** | 第一轮给 A2 换上的替代机制"`Some(team)` ⇒ 0 s、`None` ⇒ 3 s"被**产物自身反证**：`tackle_loose` 走 `Some` 却恒 3 s，`pass_lost` 走 `None` 却同时出现在 0/1/3 s | 改为真正判据：时长由**松散球创建当刻 chaser 是否已在 0.5 m 拾取半径内**（lib.rs:5260）决定；拦截者对账到球上故 0 s，抢断的 `deflect_point` 把球捅开 ≈5.25 m 故 3 s |
| **产物不可比（blocking）** | 实测发现 `canary.json` 曾被一次**临时改过引擎源码**的运行覆盖，而它与干净的 `baseline.json` 的 `source_commit`/`analyzer_version`/`schema_fingerprint` **完全相同**——产物层无法察觉两文件不可比 | ① 新增 `engine_source_fingerprint`（`include_str!` 哈希编译进二进制的 `lib.rs`+`observation.rs` 文本）：工作树脏即变，实测一次注释改动即改变指纹；② 新增 `on_disk_artifacts_share_one_provenance_block`，两个产物除 mode/seed 区间外 provenance 必须逐字段相同；③ `ANALYZER_VERSION` 升至 `p17a-2`；④ 两产物同源重跑 |
| 标签错误 | A7 说"球位设在**犯规者**自己的位置"——实际是 `spot = st.pos[carrier]`，即**被犯规持球者**；犯规者是事件的 `subject` | 报告与规则文本同步更正（结论不变） |
| 报告错字 | A7 回放定位写成"事件 [624, 640]"——那是 motif 的样本，restart 1 的真实下标是 **[87, 88]** | 已改为 [87, 88]，并补 restart 2（[230, 232]）与 restart 0（[1]）三条 |
| 报告错字 | §7 写"canary 实为 783/129"——canary 产物是 741/129 | 已改为 741 |
| 残留措辞 | A1 标题仍写"≈8–15 s"、正文仍说"固定 8–15 个 tick / 固定计时器"，与已更正的机制（3–12、几何调制）矛盾 | 标题改为 12.5 s；正文改为"等到 deadline 到期（基准 7、压缩到 3–12）" |
| 高估 | A1 机制原文说"相邻动作间隔 **=** 若干轮 deadline 之和" | 二审量化：deadline 轮次约占均值间隔的 **73%**，其余是交付飞行/transition 的 tick；措辞改为"≈…之和（约占 73%）+ 飞行 tick" |
| 建议越界 | §5 说最小改造"① 它同时改善 A2 与 A3/A10" | 更正：该改造**不会**改善 A2 的主要部分（A2 里 76.8% 的 0 s 争抢是 `interception_loose`，拦截者本就在球上）；A2 需另想办法 |
| 测试高估 | 指纹测试注释声称有个 `contains_closed_set_members` 断言（不存在），且"返回常数即红"为假 | 删除该假声明（17 个闭集的实体断言已在第一轮补上并有效）。**第四轮补正**：当时只是删掉假声明，判别力仍未落实——"返回常数即红"如今**真的成立**（见下方第四轮，`sidecar_schema_fingerprint_...` 改为用 `ALL` 独立重建期望指纹） |

### 第三轮审阅（2026-09-24 晚，口径一致性 + 措辞纪律）

| 类别 | 问题（均可复现） | 修复 |
|---|---|---|
| **无真实数据却写得像实测（P2）** | 期望值（1–3 s、20 s 等）与阈值混在一起，读者会把它们当成 measured real-match facts；产物里没有任何一句话说明"本轮没用真实数据集" | ① 10 条规则的 `baseline_expectation` 统一加 `[未标定] ` 前缀（守卫 `anomaly_expectations_are_tagged_uncalibrated`）；② Markdown §6 标题改「异常候选」并加声明、§7 首条显式声明无真实数据集（守卫 `markdown_states_the_missing_real_match_dataset`）；③ §7 阈值示例改由常量插值 |
| **口径不一致（P1）** | A7 的 `criterion` 自己算**池化** `model::mean`：baseline 上 kickoff 报 **3.58 s**，而同一产物的 M3 表是 **2.58 s**（各场 kickoff 观测数不等，池化把观测多的场加权了）。同一 kind 出现两个数，读者无法判断哪个是判据 | 报数一律取自 `restarts.prep_seconds_by_kind`（与表同一 `Stat`）。守卫 `a7_reports_the_per_match_statistic_not_the_pooled_mean`（构造"池化 8.0 s vs 逐场 5.0 s"的数据，改回池化即红） |
| **证据母体错位（P1）** | A5 的统计量分母是「含 shot 的 episode」（**2760**），证据样本却按 `is_shot_ending`（**572**）挑选——相差 4.8 倍；"射门后以 out 收场""被扑出后由对手控制"这些**射门没进的主要形态全部落在证据之外** | 证据改用 `successful_passes_before_shot(ep).is_some()`（与统计量同一母体）。守卫 `a5_evidence_comes_from_the_statistic_population` |
| **硬编码正文（P2）** | A7 正文写死角球准备期 `15.25 s（sd 1.25）`——而**同一产物**的表里是 15.35 s / sd 0.74（第二次审阅已因同类问题修过 A7 计数，此处是漏网的一处） | 删除该数值；A7 `title` 改为由零方差通道插值（`free_kick=1.0s(n 7126)` 等）。证据配额改为**每通道上限 3 条 + 保留对照通道**，否则早期 seed 占满额度、角球（唯一有真实准备期的方式）从不进证据。守卫 `a7_title_is_interpolated_and_evidence_covers_the_control_channel` |
| **措辞夸大（P2）** | A8 把 `x∈[0.3,0.7]` 称作"窄带"——那是球场 **40%** 的纵向长度，本身不窄；异常依据其实是两端近乎空集 | 全文改为**中央 40% 区间**；`title`/`criterion` 显式报两端合计占比（实测 6%）。产物与规则文本同步 |
| **文档/实现不符（P2）** | `matches_pickup_pass_lost` 文档写"恰有一次失败传球"，实现取 `bad >= 1` | 定为**至少 1 次**（实测该条件下 `bad` 分布 `{1: 779}`，两种读法此刻同结果，但 `bad == 2` 可达）；文档、design §3.6、边界测试同步（`named_motif_matchers_hold_on_constructed_chains` 补 2 条边界） |
| **口径未声明（P2）** | A9 用 `pass_success_count()`（**含定位球交付**）算"传递深度"，把"1 次交付 + 1 次开放传球"记成多脚传递 | 改为只计**开放比赛**成功传球（新增 `EpisodeRecord::open_play_pass_success_count`）；实测口径差异 2063 个 episode（65.7% → 57.9%），两种口径都不触发故结论不变。守卫 `multi_pass_share_counts_open_play_passes_only` |
| **指纹有盲区（P2）** | `engine_source_fingerprint` 只哈希 `lib.rs` + `observation.rs`，漏了 `rng.rs`（`SeededRng` 决定每一次随机分支）——只改它时两产物会静默不可比 | 清单改为 `report::ENGINE_SOURCES`（加 `rng.rs`）；`ANALYZER_VERSION` → `p17a-3`。守卫 `engine_source_fingerprint_covers_all_simulation_sources`（**对文件系统**核对 engine/src 全部 .rs，`wasm.rs` 平台垫片除外；再逐文件内容变异证明进了哈希） |

修复后复跑（同一棵干净树，`git rev-parse HEAD` = `baef134a`，`engine/src/` 未改动）：
`cargo test --test p17a_behavior_chain_baseline` **22 passed / 0 failed / 2 ignored**；
全量 `cargo test` **263 passed / 0 failed**（含 `p15_behavior_observation.rs` 的逐字节一致门）；
canary 与 baseline 都 **6 / 10** 条越阈，`analyzer_version = p17a-3`，
`engine_source_fingerprint` 两者一致 = `fnv1a64:883f16287059d32a`；
四个产物文件（两个 JSON + 两个 MD）重跑到 `/tmp` 与 `target/p17a-baseline` **逐字节相同**。

四项 P1/P2 修复的判别力都做过**定向变异**（只改目标行、跑完即还原并 diff 校验 pristine）：
A7 报数改回池化 → 红；A5 证据改回 `is_shot_ending` → 红；A9 改回含交付 → 红；
指纹清单删掉 `rng.rs` → 红；A7 去掉对照通道证据 → 红。

### 第四轮审阅（2026-09-24，机制文本冻结数值 + 守卫判别力）

第三轮修掉了 A7 正文的写死数值，但**漏掉了同一类缺陷的另两处**——它们都在 `&'static str`
机制文本里，而机制文本是 canary 与 baseline **共用**的，写进去必然与其中一份产物自相矛盾。

| 类别 | 问题（均可复现） | 修复 |
|---|---|---|
| **机制文本冻结数值（P1）** | A2 的 `mechanism_hypothesis` 写死「不要把 `delivery_loose` 的 **26.3%** 夺回归给它」——该比例随 seed 集变化，静态文本无法对两份产物同时成立 | 改为不含运行时比例的表述（"其夺回率见 M2 表，随 seed 集变化"）；比例只在 `criterion` 由指标插值。守卫 `mechanism_prose_carries_no_frozen_statistical_ratios` 腿 ① |
| **机制文本冻结数值（P1）** | A1 的 `mechanism_hypothesis` 写死「相邻动作间隔 ≈ 若干轮 deadline 之和（**约占 73%**）」 | 改为"轮数随场面变化，不由任何常量决定"（73% 这个实测值移出静态文本）。同上守卫 |
| **守卫判别力不足（P2）** | 防空转/防写死只有 `!md.contains("15.25")` 这一条单字符串检查——换个数字（26.3%）就绕过了 | 新增结构性守卫 `mechanism_prose_carries_no_frozen_statistical_ratios`：① 扫全部规则 `mechanism_hypothesis`/`why_not_football` 里的 `N%` token，只放行 0%/100%（语义极端）；② 对 A1/A2 断言两种**指标明显不同**的输入下机制文本逐字节相同（拦"改成 `format!` 嵌指标"的写法）。不扫无 `%` 的数字——源码常量与 `file.rs:NNNN` 行号是合法内容 |
| **phantom 引用（P2）** | `motifs.rs` 指向不存在的测试 `pickup_pass_lost_accepts_multiple_failed_passes_after_the_single_success` | 改为指向真实存在该边界用例的 `named_motif_matchers_hold_on_constructed_chains`（`two_fail` 例） |
| **假覆盖声明（P2）** | baseline 测试注释声称有 `contains_closed_set_members` 断言（不存在），"返回常数即红"为假 | 把 `sidecar_schema_fingerprint_is_stable_and_content_sensitive` 改为**用 `ALL` 独立重建期望指纹**再比对（常数返回与"成员串名未进哈希"都变红），注释同步更正 |
| **指纹测试较弱（P2）** | `engine_source_fingerprint_covers_all_simulation_sources` 只把实现的清单再拼一遍、断言两遍相等——常数返回也能过 | 改为**从磁盘独立读** `ENGINE_SOURCES` 每个文件、自己拼哈希输入并比对实现返回；再逐文件变异后独立重建（`rng.rs` 与其他文件一视同仁） |
| **design 缺件（P2）** | 模块图漏了 `metrics.rs`（M1/M2/M3 指标就在它里面） | 补上 `metrics.rs` 一行 |
| **motif 口径（P2）** | design §3.6 把 `restart → receive → immediate loss` 写成"首个非交付动作即失败传球，或 ≤3 s 内 control_lost"——漏了**交付-only 且 `control_lost` 不设时长上限**这条分支；又把「射门前成功传球数分布」当成 `control → pass* → shot` motif 的输出，实际上那是 **M1 指标**（母体口径不同） | 三条通路分开写清（② 明确"不设时长上限"）；把 pass 分布归回 M1，注明两 motif 母体不同勿互引。边界测试补 60 s delivery-only 正例 + 20 s delayed 反例 |
| **版本号** | 判据/守则/文档变化后 `analyzer_version` 未动，无法区分"这次跑了哪版判据" | `ANALYZER_VERSION` → `p17a-4`；tasks/design/note 同步 |

修复后复跑（同一棵树、`engine/src/` 未改动）：`cargo test --test p17a_behavior_chain_baseline`
**23 passed / 0 failed / 2 ignored**；`npx openspec validate p17a-behavior-chain-baseline-analysis
--strict` 通过；`git diff --check` 干净。`engine/src/` 三个源文件字节未变，故
`engine_source_fingerprint` 仍为 `fnv1a64:883f16287059d32a`，两产物同源关系不受影响。

---

### 审阅还确认了两件"没问题"的事（避免后来者重复怀疑）

- **A1 的机制是真的**：二审独立探针（seeds 1–30）测到 17,368 次 deadline 到期、其中 29.2% 结算为
  "继续带球"（**每个动作平均 1.413 轮 deadline**），deadline 直方图均值 6.469（范围 3–12，众数 7）——
  即 12.52 s 的间隔里约 9.14 s（73%）来自 deadline 轮次。把 `DANGER/PRESSURE/ESCAPE` 归零会让
  8–12 的整条尾部消失（约 17% 的 deadline 是受场面调制的）。
- **A4/A5/A6/A9 四条未触发不是漏报**：实测值与阈值相距 2–7 倍（10.5% vs >25%、4.23 vs <1.0、
  3.29% vs >20%、**57.9%** vs <20%），都在健康一侧。其中 A6 的口径偏保守（只抓"≥20 s 且 ≤1 动作"，
  3.29%），因此"未触发"**不能**读成"不存在这类片段"——它是三倍保守的下界。
  （A9 的数字第三轮由 65.7% 改为 57.9%：口径从"含交付"改为"仅开放比赛"，见上表。）

---

## 8. 基线移植与重算记录（2026-09-25）

本节记录**样本换了基线**这件事本身——否则后来者会以为 §0–§6 的数字与 §7 的记录出自同一棵树。

### 为什么换

P15A 当初开发在一条**不是从 main 切出来**的分支上：它的父链里有无球 demo 的 4 个提交
（`off_ball_movement_demo` 整条子系统），`MODEL_VERSION` 停在 **6**。main 上是 **7**——P104
体积重标定（"抬射门/抢断到真实量级"）是**真实的行为改动**。也就是说，原 P17A 数字不只是
"commit 不同"，而是**跨了一个模型版本**的陈旧基线，不能当作 main 的改动前基线。

### 怎么做的

把 P15A 的相干提交在 main 上重放（`git cherry-pick`，非 merge：分支相对 main 的树含 demo 祖先，
直接合并会把 demo 带进 main），随后在其上落 P17A。重放时**没有**移植 demo 的任何东西：

- **未移植**：`off_ball_movement_demo`、`ShotWindowDispatch`、`clamp_carrier_x`、
  `SHOT_ADVANCE_BUDGET_M`、demo-only 的 `MatchState` 字段、`engine/tests/off_ball_demo.rs`、
  demo 对 `realism.rs` 的改动、viewer/demo 改动。落地后 `engine/` 内这些符号计数**全为 0**。
- **一处语义移植**：`shot_window_plan` 的分支从 demo 的 `ShotWindowDispatch` 改回 main 的
  `ActionResolution`（`CarrierAction(Pass)` / `InterruptedByTackle` / `InterruptedByFoul`），
  只保留 P15 需要的 `obs` 提交点。
- **整块丢弃**：原冲突里 688 行的 `run_match_demo` / `demo_*` 测试——它们是 demo 的守卫，不属于 P15A。
- **测试层去 demo**：删掉 `MatchConfig { off_ball_movement_demo: false }` 这类字段
  （main 无此字段），以及 provenance 里指向该字段的 config 键——留着就是**假 provenance**。

### 判据没改，样本全换

P15A 的门在 v7 上变红，是**门对了**而不是门错了：它们用的是 v6 上选的 seed，那些形态在新基线上
不再出现在那些 seed 处。逐条按**同一判据**重扫（`MODEL_VERSION = 7`，5400 s）：

| 门 | 旧样本（v6） | 新样本（v7） | 依据 |
|---|---|---|---|
| 终场截断 gap | `147 @ 120`、`368 @ 400` | `470 @ 120`、`1228 @ 400` | 同一机制：kickoff 在 `t = dur-1` 发出、`t = dur` 落终场哨 |
| 三种截断形态的 seed 集 | `[1,15,33,86,100,120,157,317,5]` | `[1,9,24,36,53,86,100,317,5]` | 形态①②③ 命中数 1/1/2 |
| canary 集 | 10 个 | 补入 `9/24/36` 共 13 个 | 让形态覆盖断言非空转 |
| `shot_rebound` 补种子 | `24/38/49/80/84` | `37/41/66/106/107` | 各含 2 条（旧集在 v7 上只剩 3 条，低于下限 4） |

谓词、豁免条款、防空转下限**一条未改**；改的只是 seed。此外在 v7 上重测了§7 那条全称断言
（"空下标对象必在流截断时刻"）：2800 场（seed 1..=400 × dur {120,300,600,1200,2700,5400,9000}）
**0 反例**，计数为 29 条空 restart + 63 条空 episode（v6 上为 22 + 55）——谓词不变，数字变了。

### 一处必须点名的记录缺陷

P15A 的 golden 门函数原名 `recorder_on_and_off_reproduce_the_golden_v6_canary_stream`、
文档写"锚到 `tests/golden-v6/`"，但**函数体是从 `MODEL_VERSION` 推目录的**，在 main 上读的是
`golden-v7`。**结论对（事件流确实与磁盘基线逐字节一致），但陈述的机制是错的**——这正是本仓
反复出现的记录缺陷。已改名为 `..._golden_canary_stream` 并把文档改成"目录随 `MODEL_VERSION`"。

### 重算后的复跑

- `cargo test --test p17a_behavior_chain_baseline`：**23 passed / 0 failed / 2 ignored**
- 全量 `cargo test`：**199 + 11 + 4 passed / 0 failed**
- `./verify.sh`：9 步全过
- `openspec validate --all --strict`：11/11
- 10 条规则**触发集合不变：仍是 6/10**（A1/A2/A3/A7/A8/A10 触发，A4/A5/A6/A9 未触发）
- A1 的变异实证在 v7 上复测：`BASE_ACTION_DEADLINE_TICKS` 7→3 使间隔 **12.64 → 8.54 s**
  （30 seed，**分析器口径**：只计决策动作、逐场再跨场平均），结论与 v6 一致

> ⚠️ **口径更正（2026-09-26 审阅）**：本报告初版在此处（及 §2 A1、§5）写的是
> **11.96 → 7.98 s** 与 **4.73 → 5.13**。那组数是移植时用**临时探针**算的，探针把 episode 的
> **全部绑定事件**（含每 tick 的 `beat`）都当成了动作；而本报告 §3.1/§3.2 与分析器一律
> **只计决策动作**（`pass`/`shot`/`tackle`/`foul`/`kickoff`）。两种口径差约 0.7 s，
> 而这段又紧邻 §1 头条的 12.64 s（分析器口径）——**同一份报告里混用了两种口径**，
> 违反 §3.1「同一指标只混用同 basis 字段」。已按分析器口径重算并全篇统一。
> 感谢 2026-09-26 的移植增量独立审阅发现此点（finding P1-b）。

> **给 #15B / #16 的提醒**：本报告的数值口径是 **`MODEL_VERSION = 7`**。任何"改动前后对比"
> 都必须先确认两侧的模型版本与 `engine_source_fingerprint` 一致，否则比的是两个模型。
