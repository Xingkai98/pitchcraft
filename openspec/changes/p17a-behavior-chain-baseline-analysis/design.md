# P17A 设计：行为链基线分析

## 1. 位置与边界

分析器是**只读消费者**，位于集成测试层：

```text
simulate_with_behavior_observations(seed, config) -> DiagnosticMatch
                                                       │
                            ┌──────────────────────────┴───────────────┐
                            │  engine/tests/p17a/                       │
                            │    model.rs      逐场派生 + 聚合原语（纯函数）│
                            │    metrics.rs    M1/M2/M3 指标             │
                            │    motifs.rs     M4 动作链 motif 挖掘       │
                            │    anomalies.rs  异常规则 + 样本证据        │
                            │    report.rs     JSON / Markdown 序列化     │
                            └──────────────────────────┬───────────────┘
                                                       │
                       target/p17a-baseline/{baseline,canary}.{json,md}
```

为什么放在 `tests/` 而不是 `src/` 或新 crate：

- **不碰生产 crate**：`engine/src/` 只保留引擎与 #15A observation 层，分析器不引入任何生产 API、不必要地增大 `fm_engine` 的公开面。
- **进入既有验证链**：`cargo test` 直接编译并运行语言语义测试；重活（300 seed）用 `#[ignore]` 显式跑，与 #15A 的 `l3_300_seed_90min_calibration_lands_evidence_on_disk` 同款约定，不拖慢默认循环。
- **不新增包**：仓库只有一个 Rust crate（`engine/`），`tools/` 是 JS 工具链。新建第二个 crate 只为分析会增加构建面，而分析器**必须**能调用引擎公开 API。

调用方可见的契约只有 `fm_engine::{simulate_with_behavior_observations, MatchConfig}` 与 `fm_engine::observation::{...}` 公开类型。

## 2. 固定样本与可复现命令

| 模式 | seed 集 | 时长 | 用途 |
|---|---|---|---|
| baseline | `1..=300` | 5400 s | 前后对比的权威基线 |
| canary | `1..=30` | 5400 s | 快速迭代；**是 baseline 的前缀子集** |

canary ⊂ baseline 是刻意的：canary 上的任何变化都必须在 baseline 上同样可见，否则说明指标对 seed 集敏感，结论不可用于前后对比。

命令：

```bash
cd engine
# canary（30 场，先用它确认口径与异常规则）
P17A_SOURCE_COMMIT=$(git rev-parse HEAD) \
  cargo test --release --test p17a_behavior_chain_baseline -- --ignored --nocapture p17a_canary
# baseline（300 seed × 90 分钟）
P17A_SOURCE_COMMIT=$(git rev-parse HEAD) \
  cargo test --release --test p17a_behavior_chain_baseline -- --ignored --nocapture p17a_baseline
# 默认快速门（语义 + 确定性 + 防空转 + 两产物同源）
cargo test --test p17a_behavior_chain_baseline
```

实际条数：默认路径 **23 passed / 2 ignored**（2026-09-24 第四轮审阅修复后实测）。

**两产物必须同源**：`canary` 与 `baseline` 要在**同一棵树、同一 analyzer 版本**下产出。
`on_disk_artifacts_share_one_provenance_block` 会在两者 provenance 不一致时变红——若只重跑了
其中一个模式，先补跑另一个再交付（实测曾出现一个产物来自脏树的情况）。

产物目录默认 `engine/target/p17a-baseline/`（**不进版本库**：可复现的运行产物提交进仓库只会制造一份会漂的副本，与 #15A 校准产物同约定）。可用 `P17A_OUT_DIR` 覆盖。

## 3. 指标口径（reviewer 重点核这一段）

### 3.1 聚合纪律：逐场算，再跨场平均

所有**离散度 / 分位**指标先在**单场**内计算，再对逐场结果取平均与分布；**不把跨 seed 的原始观测池化**后一次算 sd/分位。原因：池化会把「场间差异」当成「场内方差」，使 sd 虚高，并**奖励**把场均量级压平的改动（该结论在 P38 已用实测坐实）。

**计数型**指标（如 end_reason 计数、motif 命中次数）按逐场计数求和后归一，属标准比例聚合；在报告中按此口径标注。

### 3.2 时间与"动作"的定义

- 时间一律取 sidecar 的 `ObservedTime.value`（秒），并**记录 basis**；同一指标只混用同 basis 的字段，混用处在报告中显式标注。
- 引擎 tick = 1 s（`TICK_SECONDS`），故秒与 tick 同刻度。
- **"动作"（action）= 归属 episode 的正式事件里类型为 `pass` / `shot` / `tackle` / `foul` / `kickoff` 的事件**。`beat` 是**每 tick 的位移节拍**（含 carrier 带球与 movers 跑位），**不计入动作数**——它是引擎的渲染/位移载体，不是决策动作。分析器同时报告"被绑定的 beat 数"作为 `event_indexes` 完整性的交叉检查，但不把它并入动作链。
- 本引擎 v6 的事件流**不含** `dribble` / `interception` / `off_ball_run` 事件：拦截编码为 `pass.result="intercepted"`，带球只存在于 `beat.main`。分析器按此事实建模，**不**假设"应该有 dribble 事件"。

### 3.3 M1 possession 形状

| 指标 | 定义 |
|---|---|
| episodes / 场 | `possession_episodes.len()`，并按 `start_reason` 分组 |
| 持续时间 | `end_t.value - start_t.value`；逐场 max 处同样本内分位后再跨场平均 |
| 动作数 / 传球数 | 归属该 episode 的动作事件数 / 其中 `pass` 数 |
| 动作间隔 | episode 内相邻动作事件的时间差（一阶差分的逐场分位，再跨场平均）。**这是"持球-出球节奏"的直接观测** |
| 结束原因分布 | `end_reason` 计数占比（整体，以及**按 `start_reason` 条件分解**） |
| 射门前链长 | 对**动作链里含 `shot` 事件**的 episode（= `first_shot_index.is_some()`），射门事件在动作序列中的序号（0-based，即它之前有多少个动作），以及它之前成功传球数。**注意分母口径**：这是"含射门的 episode"，**不是** `end_reason ∈ {goal, saved_caught, shot_rebound}`（两者数量不同，勿互换；300 场在 main/`MODEL_VERSION=7` 上实测 5741 vs 1226）。**证据样本必须取自同一母体**——A5 原先用后者选回放样本，给前者的证据配了后者的一小撮（守卫 `a5_evidence_comes_from_the_statistic_population`） |
| 多脚传递深度 | **开放比赛**成功传球（`!is_delivery`）≥2 的 episode 占比。定位球**交付**是重开片段的第一步，不计入；含交付会把「1 次交付 + 1 次开放传球」记成多脚传递（300 场实测差异 2063 个 episode，比例 65.7% vs 57.9%，守卫 `multi_pass_share_counts_open_play_passes_only`） |
| `start_reason` 覆盖率 | 闭集全成员的出现计数，`0` 也要输出（防空转：某个 start_reason 消失时报告必须显式显示 0，而不是省略） |

### 3.4 M2 控制权转换

- **争抢时长**：由 `contest_started` 与紧邻的 `contest_ended` 配对，`ended.t - started.t`；同时输出**取值分布**（去重后的取值 + 计数），用来暴露"时长只取少数几个离散步长"这类退化。
- **争抢原因**：`contest_started.detail`（`pass_lost` / `interception_loose` / `tackle_loose` / `shot_rebound` / `delivery_loose` / `unknown`）计数。
- **原控球队重新拿球率**：争抢结束后下一次 `control_established` 所属球队 == `contest_started.team` 的比例（分母 = 有明确 pickup 队伍的争抢）。语义注意：`contest_started.team` 是**失去控制的一方**（见 `ControlFact.team` 的 kind 相关语义），故本指标 = "丢球方夺回"。
- **转换后下一控制方**：按争抢原因分组，报告 pickup 队伍 ∈ {原控球队, 对手} 的比例。
- **转换后前 1–3 个动作**：取争抢结束后的新 episode 的动作序列前 3 项 token，输出 token 序列频次。

### 3.5 M3 restart 质量

- **重开耗时**：`taken_t - start_t`（死球确认 → 发出）与 `open_play_resumed_t - taken_t`（发出 → 恢复开放比赛），按 `RestartKind` 分组。
- **重开 → 首次明确控制**：重开后由 `restart_control` 开启的首个 episode 的 `start_t` 与 `taken_t` 之差。
- **重开后首个 possession**：动作数、持续时间、`end_reason` 分布。
- **"发出 → 立即丢失/争抢"**：在该 episode 的**第一个非交付动作**上就丢失控制（`end_reason == control_lost` 或随即进入争抢）的比例；另报告"重开后首个 possession 持续时间 ≤ 3 s"的比例。

### 3.6 M4 动作链 motif

在**动作 token 序列**（episode 级）上做 n-gram（n=2..4）频次统计，并显式输出四个具名 motif：

| motif | 判定 |
|---|---|
| `pickup → pass → lost` | `start_reason == pickup`，成功传球数 == 1，且**至少 1 次**失败传球（`intercepted`/`lost`），**首次**失败传球在那次成功传球之后（即"拿球 → 传一次 → 丢"；之后再传丢仍算同一命中）。实现取 `bad >= 1`，实测 300 场里该条件下 `bad` 分布为 `{1: 779}`（两种读法此刻同结果，但 `bad == 2` 是可达形状） |
| `restart → receive → immediate loss` | `start_reason == restart_control`，三条通路任一（`matches_restart_immediate_loss`）：① 首个**非交付**动作即失败传球；② **交付-only**（交付之后没有任何开放动作）且 `end_reason == control_lost`——此通路**不设时长上限**（"没出球就丢"与等了多久无关）；③ 有开放动作之后以 `control_lost` 结束、且结束时刻距交付 ≤ [`IMMEDIATE_LOSS_SECONDS`]（3 s）。边界见 `named_motif_matchers_hold_on_constructed_chains` 里的 60 s delivery-only 例与 20 s delayed 反例 |
| `control → pass* → shot` | `end_reason ∈ {goal, saved_caught, shot_rebound}`。注意：**本 motif 只输出命中计数/比例 + `consequence_end_reasons`（即 end_reason 分布）**。"射门前成功传球数（`pass*` 长度）的分布"是 **M1 指标**（`possession_shape.pre_shot_successful_passes`，母体 = `first_shot_index.is_some()`），**不是**本 motif 的输出——两者的母体口径不同（见 §3.3），不要互相引用 |
| `tackle → loose → original team pickup` | `contest_started.detail == tackle_loose` 且 pickup 队伍 == `contest_started.team` |

每条 motif 输出：命中次数、分母（口径写在 `denominator_name`）、比例、`consequence_end_reasons`（命中后的 end_reason 分布），以及最多 N 条**回放定位**（seed / t / episode_id 或 restart_id / 事件下标区间）。

### 3.7 异常规则与证据格式

异常是**规则写在代码里**的具名条项，不是报告里手写的散文。每条异常产出：

```json
{
  "id": "A1",
  "title": "持球-出球节奏：possession 内相邻动作间隔 12.5 s，超出未标定的期望量级（持球后 1–3 s 出球）",
  "value": 11.42, "unit": "s",
  "baseline_expectation": "[未标定] 领域假设（非实测）：真实比赛持球者 1–3 s 内出球",
  "sample_size": 28210,
  "evidence": [{"seed": 1, "t": 11.0, "episode_id": 0, "event_indexes": [12, 34], "note": "..."}],
  "why_not_football": "...",
  "mechanism_hypothesis": "行动机会 deadline 轮次（BASE_ACTION_DEADLINE_TICKS=7，lib.rs:1077）——轮数随场面变化，不由常量决定",
  "missing_evidence": "#15B phase / #16 空间压力——无法区分'被压迫无法出球'与'无条件等待'",
  "confidence": "high"
}
```

注意 `mechanism_hypothesis` 这条**不含任何运行时占比**（如"约占 73%"）——它是静态文本，canary 与 baseline
共用；随 seed 集变化的量只进 `criterion`（见报告纪律第 7 条）。

`title` 里的 `12.5 s` 是**示例值**（由指标插值）；实现里不得写死——见下方报告纪律第 3 条。

规则必须**自证样本量**（`sample_size`），并在样本量不足时把该条异常标为 `insufficient_sample` 而不是静默省略。

**禁止**在异常里写「场均 X 偏差」而不给动作链证据；也禁止把 `#15B`/`#16` 尚未提供的解释写成结论（只能写进 `missing_evidence`）。

**报告纪律（2026-09-24 审阅补，必须遵守）**：

1. **阈值 vs 参照值**：`criterion` 里的数字是**内部诊断阈值**（本 change 自定，用于固定 seed 集上的前后对比）；`baseline_expectation` 里的数字是**未标定的领域假设**。两者都不是 measured real-match facts，因此每条 `baseline_expectation` 必须以 `[未标定] ` 开头（`anomalies::UNCALIBRATED_TAG`，守卫 `anomaly_expectations_are_tagged_uncalibrated`）。本 change **没有使用任何真实比赛数据集**，Markdown §7 必须显式声明这一点（守卫 `markdown_states_the_missing_real_match_dataset`）。
2. **"异常"是候选不是结论**：Markdown §6 标题为「异常候选」，并附声明——越阈 + 可回放证据 ≠ 已证明与真实足球不符。确认要等 #15B / #16 与真实比赛数据。
3. **数值一律插值**：`title` / `criterion` / `why_not_football` 不得写死会随 seed 集变化的量（计数、均值、sd）。实测事故：A7 正文写死角球准备期 `15.25 s（sd 1.25）`，而同一份产物的表里是 15.35 s / sd 0.74。守卫 `markdown_states_the_missing_real_match_dataset`（断言产物不含写死值）。
4. **报数同口径**：规则里出现的均值/离散度必须取自与报告表**同一份 `Stat`**，不得自己算池化均值。实测事故：A7 用池化 `model::mean` 报 kickoff 3.58 s，表里是 2.58 s。守卫 `a7_reports_the_per_match_statistic_not_the_pooled_mean`。
5. **证据母体一致**：证据样本的选取条件必须与统计量的分母口径一致。实测事故：A5 的分母是"含 shot 的 episode"（v7 上 5741），证据却按 `is_shot_ending`（v7 上 1226）挑。守卫 `a5_evidence_comes_from_the_statistic_population`。
6. **措辞不夸大**：`x ∈ [0.5±0.2]` 是**中央 40% 区间**，不得称"窄带"——A8 的异常依据是两端区间近乎空集，不是该区间窄。
7. **机制文本不含运行时数值**（2026-09-24 第四轮审阅补）：`mechanism_hypothesis` / `why_not_football` 是 `&'static str`，**canary 与 baseline 共用同一句**，因此任何随 seed 集变化的量（占比/计数/均值）写进去都会与其中一份产物自相矛盾。实测事故：A1 写「（约占 73%）」、A2 写「`delivery_loose` 的 26.3%」。这类量**只能**在 `criterion`（`String`，由指标插值）里出现。合法内容：源码常量（`BASE_ACTION_DEADLINE_TICKS=7`）、`file.rs:NNNN` 行号、结构性极端（0% / 100% 读作"必然/从不"）。守卫 `mechanism_prose_carries_no_frozen_statistical_ratios`（扫 `N%` token + 断言机制文本在两份不同指标的输入上逐字节相同）。

## 4. provenance（每条产物必须自带口径）

产物顶层记录：`source_commit`（由 `P17A_SOURCE_COMMIT` 传入，缺省 `unknown`）、`model_version`、`engine crate version`、**引擎源码指纹**、**sidecar schema 指纹**、`analyzer_version`、完整 `config`、`seed_range`、`mode`、以及**真正驱动被报告指标**的常量（`tick_seconds` / `loose_max_ticks` / `transition_ticks` / `intercept_d_*` / `pitch_*`）。

**不要把无读取点的常量写进口径快照**：`HOLD_MIN_TICKS` / `HOLD_MAX_TICKS` / `POSSESSION_HOLD_MIN/MAX` 在 P31 删槽位后已无读取点（`lib.rs` 只剩声明），把它们列为"口径常量"会让 reviewer 用错误的常量核对判据。

**sidecar schema 指纹**：对 observation 模块全部闭集枚举的 `ALL` 成员串名做顺序敏感哈希，并附每个枚举的成员数。它随闭集变化而变化，因此"两次结果不可比"能在产物层被察觉（同 wasm 哈希 ≠ 同一次实验，见 P38 教训）。

**引擎源码指纹**（`engine_source_fingerprint`）：`include_str!` 取引擎**仿真源码文本**做哈希。覆盖范围 = **凡是能改变 `simulate_with_behavior_observations` 输出的 `engine/src/` 文件**，当前为 `lib.rs` + `observation.rs` + `rng.rs`（清单即 `report::ENGINE_SOURCES`）。

为什么需要它：`source_commit` 读的是**提交**而不是**工作树**——实测发生过"临时改了引擎源码、未提交就跑了 canary"的事故，此时 commit 不变、schema 指纹不变，产物层完全看不出它与干净的 baseline 不可比。源码指纹随工作树内容变化，因此这种不可比性会被 `on_disk_artifacts_share_one_provenance_block` 抓住。

为什么覆盖范围必须完整（2026-09-24 审阅）：只哈希 `lib.rs` + `observation.rs` 留了盲区——`rng.rs` 的 `SeededRng` 决定每一次随机分支，只改它时指纹不变。守卫 `engine_source_fingerprint_covers_all_simulation_sources` 用**文件系统**核对清单（新增仿真源文件而忘了纳入指纹时变红），并对每个文件做内容变异证明它真的进了哈希输入。`wasm.rs` 是 `#[cfg(target_arch = "wasm32")]` 平台垫片，不进本测试的编译单元，故不在列。

**分析器版本**（`analyzer_version`）：判据文本/阈值/口径/指纹覆盖范围变化时必须手改。它**不**覆盖在 schema 指纹里（schema 只管 sidecar 闭集），所以是"这次运行跑了哪版判据"的唯一标识。

时间戳**不写入产物**：它会把确定性输出变成每次不同的文本。需要时由调用方在产物之外自行记录。

## 5. 测试策略

| 测试 | 判据 | 默认跑 |
|---|---|---|
| `per_episode_action_chain_uses_only_decision_events` | 语义：beat 不入动作链、pass/shot/tackle/foul/kickoff 入 | ✅ |
| `action_mapping_covers_the_engine_vocabulary` | 语义：事件→动作映射覆盖真实词表（含 `contested`、交付标记） | ✅ |
| `contest_pairing_uses_the_adjacent_ended_fact` | 语义：争抢配对、时长、原队夺回率（含非紧邻与死球两个反例） | ✅ |
| `restart_first_control_uses_the_next_episode` | 语义：`restart_control` 的首个 episode 归属与耗时（含流截断反例） | ✅ |
| `named_motif_matchers_hold_on_constructed_chains` | 语义：四个具名 motif 的判定边界（含 6+ 反例） | ✅ |
| `statistics_are_per_match_then_cross_match` | 口径：逐场分位再跨场，不池化；sd 为 n-1 样本 sd | ✅ |
| `by_kind_stats_group_per_match_not_per_observation` | 口径：by-kind/by-reason 表 `matches ≤ seed 数`（防空转的池化回归） | ✅ |
| `sidecar_schema_fingerprint_is_stable_and_content_sensitive` | 口径：17 个闭集与 `ALL` 逐一对齐、内容敏感 | ✅ |
| `engine_source_fingerprint_covers_all_simulation_sources` | 口径：指纹覆盖 `engine/src/` 全部仿真源码（对文件系统核对 + 逐文件内容变异必变） | ✅ |
| `baseline_and_canary_seed_ranges_are_pinned_and_nested` | 口径：`1..=300` / `1..=30` / 5400 s / 前缀子集被钉住 | ✅ |
| `zero_count_closed_set_members_are_present_not_omitted` | 口径：闭集 0 计数显式出现，不缺行 | ✅ |
| `anomaly_rules_degrade_when_sample_is_insufficient` | 口径：零样本下每条规则降级而非消失 | ✅ |
| `a7_reports_the_per_match_statistic_not_the_pooled_mean` | 口径：A7 报数取自逐场 `Stat`，池化均值不得出现（构造池化≠逐场的数据） | ✅ |
| `a7_title_is_interpolated_and_evidence_covers_the_control_channel` | 口径：A7 title 由指标插值、证据含对照通道（有真实准备期的方式） | ✅ |
| `a5_evidence_comes_from_the_statistic_population` | 口径：A5 证据母体 = `first_shot_index.is_some()`，非 `is_shot_ending` | ✅ |
| `multi_pass_share_counts_open_play_passes_only` | 口径：A9 只计开放比赛成功传球（排除定位球交付） | ✅ |
| `anomaly_expectations_are_tagged_uncalibrated` | 口径：每条规则的 `baseline_expectation` 带 `[未标定]` 标签 | ✅ |
| `mechanism_prose_carries_no_frozen_statistical_ratios` | 口径：机制文本不含冻结统计比例（扫 `N%` token，只放行 0%/100%）+ A1/A2 机制文本不随指标变化 | ✅ |
| `markdown_states_the_missing_real_match_dataset` | 口径：产物显式声明无真实数据集、异常为候选、不含写死数值 | ✅ |
| `identical_inputs_produce_byte_identical_output` | 确定性：同 seed 集两次运行 JSON 逐字节相同 | ✅ |
| `on_disk_artifacts_share_one_provenance_block` | 同源：两个产物的 provenance 除 mode/seed 外逐字段相同（含引擎源码指纹） | ✅ |
| `first_control_delay_equals_delivery_flight_on_real_path` | 已知冗余：重开→首次控制 ≡ 交付飞行（接线变化时提醒改口径） | ✅ |
| `aggregates_are_not_vacuous_on_real_seeds` | 防空转：真实路径上关键分母 ≥ 下限 | ✅ |
| `p17a_canary` | 落盘 canary JSON+MD | ❌ `#[ignore]` |
| `p17a_baseline` | 落盘 300-seed JSON+MD | ❌ `#[ignore]` |

语义测试的 fixture 一律**照真实路径观测到的形状**构造（例如争抢时长取实测的 `{0, 3}` 取值），并配一条**生产路径**测试证明同一语义在 `simulate_with_behavior_observations` 上成立——避免"fixture 参数生产不可达 ⇒ 断言恒真"。

## 6. 已确认的观测事实（recon 实测，写入本 change 作为起点）

在 seed 1 / 90 分钟上实测（`events=5828, facts=1087, episodes=87, restarts=42, gaps=0`）：

- 事件类型只有 `beat 5370 / foul 21 / kickoff 1 / lineup 1 / pass 416 / shot 5 / tackle 13 / whistle 1`——**无 `dribble` / `interception` / `off_ball_run` 事件**。
- episode `start_reason`：`pickup 45 / restart_control 40 / kickoff 1 / control_change 1`；`SuccessfulReceive` 为 0（其注释已说明生产路径不可达）。
- episode `end_reason`：`control_lost 45 / foul 21 / out 20 / saved_caught 1`。
- 争抢时长实测**只取 `{0, 3}` 秒**（`contest_ended` 与 `contest_started` 同刻或 +3）。
- 单个 episode 常为「30–55 s 但只有 3–6 个动作」（例：ep 0 = 55 s / 5 次传球 ≈ 11 s 一次出球）。

这些数字是 #17A 的**起点证据**，不是结论；结论以 300 seed 产物为准。
