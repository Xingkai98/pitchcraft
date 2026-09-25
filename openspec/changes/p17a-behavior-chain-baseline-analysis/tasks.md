## Slice 1 — 分析器骨架与逐场派生

- [x] 建立 `engine/tests/p17a/`（`model.rs` / `metrics.rs` / `motifs.rs` / `anomalies.rs` / `report.rs`）
      与 target 文件 `engine/tests/p17a_behavior_chain_baseline.rs`；用 `#[path]` 挂载。
- [x] `EpisodeRecord` 逐场派生：动作链只取决策事件（pass/shot/tackle/foul/kickoff），`beat` 单独计数不入链；
      记录 source_event_index → seed/t/episode 的回放定位所需字段。
- [x] 争抢配对：`contest_started` → 紧邻 `contest_ended`（含非紧邻反例），记录时长、原因、pickup 队伍、
      原控球队是否夺回；`pickup_team` 的查找**有界**（遇到另一次争抢/死球/重开/终场即停止，不向前读无关进攻）。
- [x] restart 序列派生：`dead_ball → preparation → taken → open_play_resumed` 时间点，按 `RestartKind` 分组；
      携带 `event_indexes` 作回放定位。
- [x] 聚合原语：逐场结果 → 均值/分位/分布；`stat_by_match_and_key` 保证 by-kind/by-reason 表**每场一个观测向量**
      （不是每条观测一个），计数型按场求和归一。

## Slice 2 — 四组指标与 motif

- [x] M1 possession 形状（含按 `start_reason` 条件的结束分布、射门前链长、动作间隔）。
- [x] M2 控制权转换（争抢时长分布与按原因交叉、原队夺回率、转换后下一控制方、转换后前 1–3 动作）。
- [x] M3 restart 质量（重开耗时、重开→首次控制、首个 possession 形状、立即丢失/争抢率）。
- [x] M4 motif：n-gram（n=2..4）+ 四个具名 motif，每个输出频次/比例/回放定位样本。
- [x] `unknown`/0 覆盖：闭集成员计数为 0 时显式输出（`zero_count_closed_set_members_are_present_not_omitted`）。

## Slice 3 — 产物与异常规则

- [x] JSON 序列化（BTreeMap 有序、定点浮点、无时间戳）→ `baseline.json` / `canary.json`。
- [x] Markdown 序列化（指标表 + 异常模式含证据/机制假设/缺失证据）→ `baseline.md` / `canary.md`。
- [x] provenance：`source_commit`（`P17A_SOURCE_COMMIT`）、config、seed 区间、sidecar schema 指纹、口径版本。
- [x] 异常规则以代码具名条项实现（10 条），每条自证 `sample_size`，不足则降级为 `insufficient_sample`。
- [x] 汇总常量的来源注释：只列**真正驱动被报告指标**的常量（`tick_seconds` / `loose_max_ticks` /
      `transition_ticks` / `intercept_d_*` / `pitch_*`）——已剔除无读取点的 `HOLD_MIN/MAX_TICKS` 族。

## Slice 4 — 测试与运行

- [x] 快速语义测试：动作链只取决策事件、事件→动作词表、争抢配对与夺回率（含反例）、restart 首次控制语义、
      四个 motif 判定（含 6+ 反例）。
- [x] 确定性测试：同 seed 集两次运行 JSON 逐字节相同（并断言产物无时间戳字段）。
- [x] 防空转测试：真实路径关键分母 ≥ 下限；by-kind 表 `matches ≤ seed 数`（池化回归守卫）；
      闭集清单完整；seed 区间被钉住。
- [x] `#[ignore]` 运行器：`p17a_canary`（1..=30）与 `p17a_baseline`（1..=300），落盘到 `target/p17a-baseline/`。
- [x] 跑 canary → 复核口径 → 跑 baseline；产物：300 场 338,120 facts / 30,179 episodes / 15,584 restarts /
      20,053 contests / 0 gaps；canary 与 baseline 均 6/10 条异常触发。
      （**2026-09-25 在 main/`MODEL_VERSION=7` 基线上重算**：初版数字取自一条 fork 自无球 demo
      分支、`MODEL_VERSION=6` 的树，跨了 P104 体积重标定；判据未改、触发集合不变，数值全变。
      移植与重算记录见报告 §8。）
- [x] 分析报告：`.scratch/notes/behavior-chain-baseline-2026-09-24.md`（6 条异常 + 4 条未触发 + 机制假设 +
      缺失证据 + #19 最小改造候选 + 审阅修订记录）。
- [x] 验证：`cargo test --test p17a_behavior_chain_baseline`（**22 passed / 2 ignored**，第三轮时点）、
      `cargo test --release --test p17a_behavior_chain_baseline -- --ignored`、
      `npx openspec validate p17a-behavior-chain-baseline-analysis --strict`、`git diff --check`、
      `cargo test`（全量，含 `tests/p15_behavior_observation.rs` 的逐字节一致门）。
- [x] 代码审阅闭环：起 subagent 审阅 → 修复（2 处 blocking + 8 项 should-fix）→ 再行验证；
      审阅发现的口径错误（by-kind 统计被池化）与机制误指（把无读取点的死常量当作成因）已修，
      并加了对应的判别守卫。
- [x] 更新 `.scratch/map.md` 的 `17A` 状态与 `.scratch/notes/behavior-realism-analysis-roadmap.md` 的 frontier。

## Slice 5 — 第三轮审阅修复（2026-09-24）

第三轮审阅在**口径一致性**上又抓到 2 处 P1 + 6 处 P2。已修，每项都配了判别式守卫：

- [x] **P1 A7 报数口径**：规则原先自己算池化 `model::mean(vals)`，而报告 M3 表用逐场 `Stat`
      ——同产物里 kickoff 出现 3.58 s 与 2.58 s 两个值。改为与表同源（`prep_seconds_by_kind`）；
      报数与零方差判定都走该路径。守卫 `a7_reports_the_per_match_statistic_not_the_pooled_mean`。
- [x] **P1 A5 证据母体**：证据按 `is_shot_ending` 挑，统计量分母却是
      `first_shot_index.is_some()`。改为同一母体。守卫
      `a5_evidence_comes_from_the_statistic_population`。
      （原文记的是当时 v6 树上的 572 与 2760；v7 基线上同一对为 1226 与 5741——**此处只去数字，
      因为它们是会随基线漂的实例值，留在这里会再次变成陈旧记录**。）
- [x] **P2 A7 正文硬编码**：删掉 `15.25 s（sd 1.25）`（同一产物表里是 15.35 s / sd 0.74）；
      A7 `title` 改为由零方差通道插值；证据配额改为**每通道上限 + 保留对照通道**（否则早期 seed
      的任意球占满 6 条，角球这个唯一有真实准备期的方式从不进证据）。
      守卫 `a7_title_is_interpolated_and_evidence_covers_the_control_channel`。
- [x] **P2 标定措辞**：`x ∈ [0.5±0.2]` 不再称"窄带"，改称**中央 40% 区间**（A8 的异常依据是
      两端区间近乎空集）；全部 10 条规则的 `baseline_expectation` 加 `[未标定]` 前缀标签；
      Markdown §6 改标题为「异常候选」、§7 增"本轮没有使用任何真实比赛数据集"声明。
      守卫 `anomaly_expectations_are_tagged_uncalibrated` / `markdown_states_the_missing_real_match_dataset`。
- [x] **P2 motif 文档/实现一致**：`matches_pickup_pass_lost` 文档写"恰有一次失败传球"而实现取
      `bad >= 1`。定为**至少 1 次**（实测该条件下 `bad` 分布 `{1: 779}`，但 `bad == 2` 可达），
      文档、design §3.6 与边界测试同步。守卫并入 `named_motif_matchers_hold_on_constructed_chains`。
- [x] **P2 A9 口径**：改为只计**开放比赛**成功传球（排除定位球交付），不再把一次交付 + 一次开放
      传球记成多脚传递（实测差异 2063 个 episode，65.7% → 57.9%，阈值两侧行为不变）。
      守卫 `multi_pass_share_counts_open_play_passes_only`。
- [x] **P2 指纹覆盖**：`engine_source_fingerprint` 增加 `src/rng.rs`（`SeededRng` 决定随机分支）；
      清单改为 `report::ENGINE_SOURCES`，`ANALYZER_VERSION` 升至 `p17a-3`。
      守卫 `engine_source_fingerprint_covers_all_simulation_sources`（对文件系统核对 + 逐文件变异）。
- [x] 两产物从**同一棵干净树**重跑（canary + baseline），指纹一致、逐字节稳定。
- [x] 验证（第三轮）：`cargo test` 全量 **263 passed / 0 failed**（含 `p15_behavior_observation.rs`
      的逐字节一致门）；四个产物文件重跑到 `/tmp` 与 `target/p17a-baseline` **逐字节相同**；
      `npx openspec validate ... --strict` 通过；`git diff --check` 干净。
      四项 P1/P2 修复各做过**定向变异**（改回旧实现即红，跑完还原并校验 `engine/src/` 与
      三个分析模块均为 pristine）。

## Slice 6 — 第四轮审阅修复（2026-09-24）

第四轮审阅在**机制文本的数值纪律**与**守卫判别力**上又抓到 2 处 P1 + 6 处 P2。已修：

- [x] **P1 A2 机制文本冻结数值**：写出「不要把 `delivery_loose` 的 26.3% 夺回归给它」——该比例随 seed
      集变化，静态文本（canary/baseline 共用）必然与其中一份矛盾。改为不含运行时比例的表述。
- [x] **P1 A1 机制文本冻结数值**：写出「相邻动作间隔 ≈ 若干轮 deadline 之和（约占 73%）」。同上更正。
- [x] **P2 防空转守卫判别力不足**：原守卫只有 `!md.contains("15.25")` 单字符串检查，换个数字即绕过。
      新增结构性守卫 `mechanism_prose_carries_no_frozen_statistical_ratios`——扫全部规则机制文本里的
      `N%` token（只放行 0%/100% 结构性极端），并对 A1/A2 断言两种不同指标输入下机制文本逐字节相同
      （拦「改成 `format!` 嵌指标」的写法）。不扫无 `%` 的数字（源码常量与 `file.rs:NNNN` 行号合法）。
- [x] **P2 phantom 引用**：`motifs.rs` 指向不存在的测试名 → 改指真实测试的边界用例。
- [x] **P2 假覆盖声明**：baseline 测试注释声称的 `contains_closed_set_members` 不存在、"返回常数即红"为假
      → 把 `sidecar_schema_fingerprint_...` 改为用 `ALL` 独立重建期望指纹再比对（常数返回/成员未进哈希都红）。
- [x] **P2 指纹测试较弱**：改为**从磁盘独立读**每个 `ENGINE_SOURCES` 文件、独立重建哈希输入并比对实现返回
      （尤其 `rng.rs`），再逐文件变异后重建必变——不再只是把实现的清单重拼一遍。
- [x] **P2 design 缺件与 motif 口径**：模块图补 `metrics.rs`；`restart → receive → immediate loss`
      写清三条通路（② 交付-only 且 `control_lost` **不设时长上限**）；「射门前成功传球分布」归回 **M1**
      （非 motif 输出）。边界测试补 60 s delivery-only 正例 + 20 s delayed 反例。
- [x] **P2 引文精确化**：A2/A10 的 `deflect_point`、`nearest_any`、`lost/intercept_pass_highlight` 行号
      与函数区间核对更正；A8 剔除无关的 `CORNER_SETUP_MIN_TICKS`；A9 的 `HOLD_MIN/MAX_TICKS`（已无读取点）
      改指真正的驱动常量与 deadline 路径；A7 的 `spot` 行号 2327 → 2328。
- [x] **版本号**：`ANALYZER_VERSION` → `p17a-4`（判据/守则/文档变化）；tasks/design/note 同步。
- [x] 验证：`cargo test --test p17a_behavior_chain_baseline`（**23 passed / 2 ignored**）、
      `npx openspec validate p17a-behavior-chain-baseline-analysis --strict`、`git diff --check`；
      `engine/src/` 生产源码字节未变（指纹仍 `fnv1a64:883f16287059d32a`）。

## 未完成 / 交给后续 change

- [ ] 把 `delivery_loose` 的夺回率按 `RestartKind` 再拆一层（看它主要来自角球 battle 还是门球），
      以彻底落实 A2 的机制归因。**留给 #15B/#16 之后**（当前 A2 结论不依赖它）。
      注：具体比例随 seed 集变化，只应从产物读数，不要写进任何静态文本（见 Slice 6 的 P1）。
- [ ] 事件下标在 episode 交接处可能重复（seed 1 事件 2240 等）→ `episode action_count` 不可加总。
      已在报告 §6 披露；根因在 #15A 绑定层，**不在本 change 范围内**。
