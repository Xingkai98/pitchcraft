# P17B 审阅记录（Slice 5）

本文件按本仓强制流程（`CLAUDE.md` §3）记录**独立审阅**：每轮由**零本 change 上文**的
独立 agent 审查 → 修复 → 再审阅 → 直到全部通过。

**审阅者须知（如果你是审阅者，先读这段）**：

- 你**没有**本 change 的任何上文。全部信息在仓库文件里，**以文件为准，不以本文件的转述为准**。
- **不要相信本文档的任何断言**——它是被审者写的。你要独立核对。
- 本仓最常犯的三族缺陷（`[[conclusion-right-mechanism-wrong]]` /
  `[[false-coverage-handoff-claims]]` / `[[mutation-red-must-rule-out-compile-error]]`）：
  1. **结论对但机制错**：注释/文档说的机制，代码里不存在或不是那样。**读注释时要连
     「因为/原因是」一起核**——去代码里找那个机制；
  2. **假覆盖声明**：文档说「这一面由测试 X 覆盖」，而 X 的断言体根本管不到那一面。
     **读 X 的断言体**，必要时**做定向变异**看 X 会不会红；
  3. **变异判红要排除编译失败**：Rust 的 exit 101 兼含编译错误。要见到目标测试名 + `panicked at`，
     否则那是「没跑成」而不是「判红了」。
- **读代码会错**（本仓实测四次）。关键结论要**实跑**。探针用完即删，不入库。

## 本 change 的范围（供你定位，不是供你采信）

| 文件 | 是什么 |
|---|---|
| `engine/tests/p17b_diagnosis_report.rs` | 入口测试 + 全部门槛（25 条默认 + 2 条 `#[ignore]` 产物门） |
| `engine/tests/p17b/evidence.rs` | 证据边界表 + `Locus` 枚举 |
| `engine/tests/p17b/episode.rs` | 逐 episode 派生（动作链 / 尾部窗口 / 松散球段 / 异常筛选） |
| `engine/tests/p17b/reasons.rs` | 覆盖声明（争抢成因 / P17A 异常规则）+ 措辞规则 |
| `engine/tests/p17b/report.rs` | JSON / Markdown / provenance / L2 聚合 |
| `openspec/changes/p17b-explainable-diagnosis-report/` | design / proposal / spec / tasks |

**三条不可越界**（设计定死，你必须独立核实）：
1. **零 `engine/src/` 改动**（`git diff main --stat -- engine/src` 应为空）；
2. **不报相位**（`build_up` / `progression` / `final_third` / `attacking_transition` / `Phase`
   不得出现在 `tests/p17b/{evidence,episode,reasons}.rs` 的**非注释**行；`report.rs` 被排除，
   因为它经 `crate::model` 的 sidecar 指纹**正确地**触及 `Phase`）；
3. **不产生 pass/fail**（产物里不得有通过/失败判定或好坏标签）。

## 审阅轮次

（每轮由审阅 agent 追加自己的段落到下方；被审者不代写。）

### 轮次 1 — 需修改（独立审阅 agent · Claude / paseo worktree `1g1x3st4` · 2026-09-30）

> **审阅对象是 `da4d651`**（按任务书）。审阅过程中分支被并发推进到 `beb822d` +
> 未提交改动，故后期核对全部在 `git worktree add /tmp/p17b-da4d651 da4d651`
> 的**干净检出**上做，与主 worktree 的并发编辑隔离。下文行号均为 **`da4d651`** 的行号。

**方法**（全部实跑，无一条采信文档）：

1. **三条不可越界**：`git diff main --stat -- engine/src` 为空；自写**剥注释**扫描器
   （`python3` 逐行截 `//`）扫 `tests/p17b/{evidence,episode,reasons,report}.rs`
   + `p17b_diagnosis_report.rs`；解析两份产物 JSON/MD 全量扫 pass/fail 与好坏标签。
2. **三份独立探针**（`engine/tests/zz_p17b_*.rs`，用完即删，已确认 `git status` 干净）：
   ① 复现 note/design 的数字（946/3.02、57.2/42.8、3091、188/513、四档 fallback）；
   ② **直接用 analyzer 自己的模块**（`#[path]` include `p17b/{evidence,episode,reasons,report}.rs`）
   跑 `card_of` / `loose_runs` / `restart_windows`，避免我自己的重实现与它口径不符；
   ③ 原始事件流 dump（`seed=1` 的逐拍 `Event`/`mover` 明细）。
3. **10 条定向变异**，逐条要求见到**目标测试名 + `panicked at`**（排除编译失败）；
   每条变异后 `git diff` 确认源文件回到 pristine（每轮都验证过，无残留）。
4. **产物抽验**：JSON 可解析；卡片自洽（`duration_s`、tail 窗口、`replay.event_indexes` 回到事件流）；
   `interception_loose` 卡逐张核；产物里两张边界表与 `evidence.rs`/`reasons.rs` 常量逐行比对；
   另**重跑一次 canary**（`P17B_OUT_DIR=/tmp/p17b-regen`）与磁盘产物逐字节对比。

**发现**：

- **[P1] 交付树上默认套件有一条红：产物与源码不同源（`on_disk_artifacts_share_...`）**
  - 证据：`cd engine && cargo test --test p17b_diagnosis_report` →
    `test result: FAILED. 24 passed; 1 failed; 2 ignored`，
    `panicked at tests/p17b_diagnosis_report.rs:1195:9: 落盘产物 target/p17b-diagnosis/canary.md
    的 test_source_fingerprint 与当前源码不符`。产物记 `fnv1a64:aee9b435d301d16b`，
    `da4d651` 的应值（我独立复算 FNV-1a）= `fnv1a64:4d4238cf901718f7`；
    产物的 `source_commit` 是 `a948c2c…`（merge base），**连 `da4d651` 都不是**。
  - 语义层面我核过：在 `da4d651` 干净树上重跑 canary，两份 JSON **除 `source_commit` 外逐字节相同**
    （MD 差 2 行、均为 commit 串）。所以今天它**恰好**没被读错——但门红着，
    而 `tasks.md` 写「25 条默认门全绿」。该门的全部价值就是暴露这个状态。
  - 为什么这是问题：这条门在「本 change 声称已完成」的树上是红的，等于
    **声明与可复现状态不符**；且根因是产物早于最后一批编辑（源文件 mtime 16:24–16:32 > 产物 16:23），
    同一原因会让后续读者继续失去「产物 = 哪一版源码」这条线索。
  - 建议：`P17B_SOURCE_COMMIT=$(git rev-parse HEAD) cargo test --release --test p17b_diagnosis_report
    -- --ignored --nocapture` 重跑两条产物门；并在修复后重跑默认套件确认 25/25。

- **[P1] 卡片的【丢球后】一节只展示「收束那一拍」，不是追逐过程——本 change 的立身之本（Q3）实际不成立**
  - 证据（三条互相独立，且产物本身即可核）：
    ① `episode.rs:494` `loose_runs(dm, windows, (ep.start_t.value, end_t))`——span 右端是 `end_t`。
    ② 用 analyzer 自己的 `card_of` 跑 30 seed：`total_runs=674`，**段长分布 `{1: 674}`**，
       **段末端 vs `end_t`：`== 674 / < 0 / > 0`**——每一段都只有 1 拍、且都在收束那一刻。
    ③ 直接读产物 `canary.json`：674 段**全部** `beats==1`、`t_end==end_t`，
       `chase_class` **恒为 `"one"`**（`{"one": 674}`，`both`/`none` 各 0）。
    ④ 原始流（seed 1, ep1）：t=81/82/83 三拍 `loose=true`，三拍都有 `chase(7)` 与
       `close_down(11)(14)`；`end_t=81`，故卡片只落第 1 拍，**后 2 拍全丢**。
       产物渲染出来就是 `松散球段 t=[81.0, 81.0]，1 拍，归属 = one / 追球者： [7]`。
    ⑤ 全场 946 段 / 均长 3.024 我复现到了（与 design §4.4.1 一致），
       但这些段 **76.4% 的 loose beat 落在任何 episode span 之外**；
       同一段丢球的「下一拍」画像明显更有信息：`pass_lost` 187/212、`tackle_loose` 434/434、
       `delivery_loose` 35/35 在 `end_t+1` 都有 `chase`。
  - 为什么这是问题：**结论对但口径差了 2/3 的过程**。产物顶层表把 `tackle_loose` 记为
    「追逐可见」、`pass_lost`「追逐可见」，`ANOMALY_COVERAGE` 的 A3 也说「给每段的
    `contest_start` 成因与拾取方」；但读者拿到的是**丢球那一拍的追球者名单**，
    看不到「谁追、追了多久、追没追上」。更要命的是 `chase_class` 在产物里恒为 `one`
    ——design §4.4.1 的权威口径是「两队都追 **57.2%**」，那个数在**产物里一次都不出现**
    （我复现：全段 any-mover 口径 `both=57.2% one=42.8%`、chase-only `both=11.3% one=88.7%`，
    与 tasks.md 第 2 处更正逐位吻合）。也就是说：报告交给 #19 的「丢球后追球结构」
    是一个**退化量**，而产物没有一处说明它被截断了。
  - 建议（二选一，须显式选定并写进产物）：
    ① **扩 span**：pursuit 段按「该争抢的完整 loose 过程」取
    （`[end_t, 该段争抢对应的 `contest_ended`]`，或退到下一段 `episode.start_t`），
    并把 LooseRun 的 `beats`/`t_start`/`t_end` 如实展开——这样 `chase_class` 才会出现 `both`；
    ② 若坚持 episode 内口径，则**改声明**：把 `pursuit_visible` 改名为
    「收束拍可见」，在产物里显式写「本段只看收束那一拍；完整追逐过程须见 XX」，
    并把 `ANOMALY_COVERAGE`/`CONTEST_COVERAGE` 里「跑动阶段存在」的措辞收回到实测所见。
    无论哪条，**都要加一条断言**：产物的 `chase_class` 不允许恒为单一值
    （例如断言 `both > 0`——现在这个断言会红，这正是它该有的判别力）。

- **[P1] `instant_contest` 拿 possession 时长冒充 P17A A2 的争抢时长——命中 1/3075 而非 744，A2 的逐 episode 覆盖声明不成立**
  - 证据：`episode.rs:615` `if duration == Some(0.0) && c.contest_start.is_some()`，
    而 `duration = c.end_t - c.start_t` 是 **possession** 时长；P17A 的 A2（`anomalies.rs` 的 `a2`）
    判的是 `transitions.duration_value_counts["0.000"]`，即 **争抢时长**
    （`contest_started` → `contest_ended`）。30 seed 实测：possession 时长 == 0 的卡 **1** 张；
    争抢时长 == 0 的 **744** 张；两者交集 **1**。产物也印证：带外 baseline 的
    `by_exception.instant_contest` 只有 `{cards_full_corpus: 1, kept_in_l1: 1}`。
  - 为什么这是问题：`EXCEPTION_CLASSES` 的串把这一类写成「（P17A A2 的逐 episode 化身）」，
    `ANOMALY_COVERAGE` 的 A2 行又写 `per_episode_samples: true` + 「本层对应 `instant_contest` 筛子」。
    实测这两个断言都不成立：A2 在 P17A 是**多数现象**（53.4% 的争抢），在本层几乎不命中。
    这正是 spec 明令禁止的形态——「断言每条异常都能找到样本」，只不过它以
    「筛子名字对、口径不对」的形式躲过了措辞守卫。另：`episode.rs:663` 的注释
    「`instant_contest` 在 300 seed 上只命中 8 张（`interception_loose` 使然）」，
    「使然」是错的归因（`interception_loose` 的 possession 时长并不为 0；8 张是巧合）。
  - 建议：改用争抢时长作判据（`contest_started` → 紧随的 `contest_ended` 的 Δt == 0），
    并加一条**行为层**断言（命中数落在合理区间 + 至少一张卡与 A2 的样本可对齐）。
    ⚠️ 我看到并发改动里已经加了 `contest_duration_s` 与
    `instant_contest_uses_the_contest_duration_not_the_possession_duration`——方向正确，
    但那条修复**尚未进入 `da4d651`**，本轮按 `da4d651` 判。

- **[P1] 同源哨兵 `support_caliber_is_live_read_from_p16_not_copied` 只扫一个文件，是空转守卫**
  - 证据：`p17b_diagnosis_report.rs:729-730` 只 include 了 `p16/features.rs` 与
    **`p17b_diagnosis_report.rs`**，然后在后者的 `strip_line_comments` 结果里找
    `const … SUPPORT_*_M … =`。变异：把 `pub const SUPPORT_MAX_DIST_M: f64 = 25.0;`
    追加到 `tests/p17b/episode.rs` → 目标测试 **GREEN**；追加到 `tests/p17b/evidence.rs` → **GREEN**。
    （`episode.rs` 正是 runtime 里调 `crate::features::support_formation` 的那个文件。）
  - 为什么这是问题：测试的 doc 与断言消息都写「**p17b** 不得自己声明该常量」，
    而实现里的「p17b」只等于 5 个文件中的 1 个。可以长出第二份常量的两个文件恰好不在扫描面内
    ——`[[false-coverage-handoff-claims]]` 的形态：断言存在、覆盖声明存在、覆盖面不存在。
  - 建议：扫 `TEST_SOURCES` 里 p17b 的**全部**模块（`report.rs` 已 include；
    `episode.rs`/`evidence.rs`/`reasons.rs` 再各 include 一次即可），
    或直接对 `include_str!` 汇总的文本扫；并在注释里把「运行时可能用到该常量的模块」写清楚。

- **[P2] `Locus::MatchGapCount` 是恒真死探针，而测试把它的判别力推给了一条不存在的证明**
  - 证据：`evidence.rs:256` `Locus::MatchGapCount => dm.gap_count() == dm.gap_count()`（恒真）；
    `p17b_diagnosis_report.rs:269` 把它与 `MatchCoherence` 一起塞进 `=> true` 的兜底分支，
    注释说「它们的判别力由「不自洽输入」证明（见下）」——但紧随其后的那条只证明 `MatchCoherence`
    （造 `invariant_violations`，断言 `!MatchCoherence.read(&bad)`），**没有任何一句碰 `gap_count`**。
    变异：`Locus::MatchGapCount => true` → `locus_read_probes_actually_read_the_field` **GREEN**，
    `evidence_table_lists_every_locus_and_every_row_is_readable` **GREEN**。
  - 为什么这是问题：该测试 doc 写「若某个 `read` 分支写死 `true`，本测试会红」——实测有反例。
    影响有限（`read` 的主价值是编译期字段存在性，`dm.gap_count()` 改名仍会编译不过），
    但「判别力」这半句是空的，且它是证据边界表 33 个落点里唯一一个。
  - 建议：给 `MatchGapCount` 造一个判别输入（例如断言「`gap_count()` 在人为插入一条
    `ObservationGap` 事实后变大」），或把兜底分支拆开、注释改成「本变体只有编译期保证」。

- **[P2] 措辞守卫不覆盖产物模板所在的 `report.rs`，且 `design §4.1` 给的排除理由不成立**
  - 证据：变异——在 `report.rs` 的 `render_card_md` 里插一行
    `o.push_str("（本段属 build_up）\n")` → `wording_guard_rejects_phase_vocabulary_after_stripping_comments`
    **GREEN**，`report_is_deterministic_and_self_describing` 也 **GREEN**
    （它的禁串表只有 `PASS/FAIL/通过率/好/坏/合格`，不含 phase 词）。
    另：`da4d651` 的 `report.rs` **根本不出现** `Phase`/`build_up` 等任何 phase 词
    （我 grep 过），所以 design §4.1 写的排除理由「它经 `crate::model` 的
    `sidecar_schema_fingerprint` **正确地**触及 `Phase` 闭集」在该文件上**不成立**——
    真正含 `Phase` 的是 `p17a/model.rs`，而它本来就不在扫描范围内。
  - 为什么这是问题：spec 的 Scenario 是「把 phase 词写进**报告生成代码或产物模板** ⇒ 至少一条测试变红」。
    产物模板就在被排除的那个文件里，于是这条 scenario 保护的正是守卫扫不到的地方。
  - 建议：把扫描范围扩到 `report.rs`，只**排除指纹构造点**（该处只出现符号名
    `sidecar_schema_fingerprint`，不含 phase 字面量，其实无需排除）；
    若担心误伤，至少把「产物模板函数」（`render_card_md` / `to_markdown` / `to_json`）
    纳入扫描，并保留现有的反证条。

- **[P2] `188/513 终点距球 > 5.25 m` 是单位混用算出来的；世界坐标真值是 `168/513`**
  - 证据：我用世界坐标（`Δx·105 m, Δy·68 m`）算 8 seed 的 `close_down` 终点距球：
    `n=513`，`> 5.25 m` = **168**（32.8%），median = 2.39 m，p10 = 1.53 m。
    把**归一化**距离直接与 `5.25` 比才得到 **188**（逐位吻合文档的数）。
    （顺带：这条数值的三个引用点 `evidence.rs:437`、`reasons.rs:255`、
    `p17b_diagnosis_report.rs:501` 只写了「实测」，没有一处写坐标口径。）
  - 为什么这是问题：这是本仓点名的头号缺陷族——结论（`close_down` 不恒为追球）**对**，
    但支撑它的数字用错了单位。168/513 仍然足以支撑结论，所以修法很便宜。
  - 建议：改成 `168/513（32.8%）` 并写清「世界坐标、球位取当拍 `BallState.{x,y}`」。

- **[P2] 覆盖缺口表只有分子没有分母：30% 的争抢不出现在任何诊断卡里，产物不报这件事**
  - 证据：30 seed 实测——`ContestStartReason` 事实 **2027** 条，
    而 `card_of` 的 `contest_start` 只覆盖 **1418** 张卡（70.0%）。
    分项最大缺口是 `delivery_loose`：事实 645、被卡覆盖 **35**。
    原因在 `episode.rs` 的 `closing_contest_fact`：只认 `t == end_t` 的 `contest_started`
    （同刻多条取最早），跨刻争抢落空。产物的 `by_contest_start` 表给的是 `cards`，
    读者会把它当成「该成因的争抢数」。
  - 为什么这是问题：「按成因逐项声明覆盖」是本 change 的立身之本，而这张表的**分母**恰好
    不是「争抢数」。凡未被任何卡覆盖的争抢，报告既没说它不可见、也没说它没被采到——
    属于「留空」，正是 design §5 待决策 8 明令禁止的形态。
  - 建议：在 `by_contest_start` 旁并列「事实数 / 被卡覆盖数 / 差额」，
    差额非零时在 md 里显式写「其余 N 条争抢不与 episode 收束同刻，本表未收录」。

- **[MINOR] `episode.rs:244` 指向一个不存在的栏目**
  - 证据：注释「跳过中间的 dry beat 会把两段无关的球拼成一段（实测差 **3 倍**，见**报告的
    口径对照栏**）」。`canary.md` / `baseline.md` / 两份 JSON 里都没有「口径对照」或「宽松」字样。
    `tasks.md:47` 另载「宽松口径 = 324 段 / 8.83」，但**我两种实现（跨 non-beat 事件 / 跨 dry beat）
    都收敛到严格口径的 946 / 3.024**，复现不出 324。
  - 为什么这是问题：断言「报告里有一栏」而产物没有，是文档-产物漂移；且「3 倍」这个数
    在当前源码上我无法复现（见「未覆盖/存疑」）。
  - 建议：要么在 L2 里真的加一栏并列两口径，要么把句子改成「见 `tasks.md` 的口径对照」
    并补上可复现的脚本/公式；「3 倍」须重测后再写。

- **[MINOR] `evidence.rs:330` 的 chase 计数把子集写成了全集**
  - 证据：`how_verified` 写「30 seed 实测 `chase` 共 **3091** 个、全部落在开球期」。
    实测：`chase` mover 总数 **6745**；其中落在「开球期 loose beat」= **3091**，
    落在「非 loose beat」= **3654**。所以「3091 个」是子集，不是「共」。
    后半句（准备期 0 个）正确。
  - 建议：改成「开球期 loose beat 内 `chase` 共 3091 个（全量 chase = 6745，其余 3654 落在非 loose beat）」。

- **[MINOR] `aggregates_are_not_vacuous_on_real_seeds` 的下限余量只有 4.5%，且注释里的数不符**
  - 证据：`p17b_diagnosis_report.rs:1150-1153` 注释「实测 10 seed：`loose_runs` > 300」，
    断言 `> 200`。实测 seed 1..=10：`loose_runs = 209`、`chasers = 209`。
    注释的 300 对不上；断言 200 距实测 209 只有 4.5% 余量。
  - 为什么这是问题：防空转下限的全部意义是「阈值须有理由」，而这里的理由（300）与实测（209）
    不符，等于阈值是被反推着压上去的。
  - 建议：注释改成实测值并说明余量来源，或把 seed 区间扩到与 `CANARY_SEEDS` 一致（30 seed 674 段）。

- **[MINOR] `contest_coverage_guard_has_discriminating_power` 的 ① 名不副实**
  - 证据：`p17b_diagnosis_report.rs:333` 附近，① 的注释写「用一个**闭集里没有**的成因，
    `coverage_of` 必须给出 None」，实现却是「数 `CONTEST_COVERAGE` 里 `InterceptionLoose`
    出现几次，断言 == 1」——没有构造任何闭集外的成因，也没断言过 `None`。
    真正的判别力来自 ②（`unwrap()` 一个必须存在的行）。
  - 为什么这是问题：doc 声称的机制（反证条覆盖「兜底 ⇒ 盲区被静默报成可答」）在代码里不存在；
    这一条恰好是 BLOCKER-1 的防线，读者会以为它有反证条。
  - 建议：按注释真的写一条——`coverage_of` 的签名是 `Option`，可直接断言
    「从表里移除 `interception_loose` 后 `coverage_of` 返回 `None`」（用一个局部副本表驱动），
    或把注释改成如实描述 ②。

**变异表**（在 `da4d651` 干净检出上跑；每条都确认见到目标测试名 + `panicked at`）：

| # | 变异改法 | 目标测试 | 实际结果 | 真判红？ |
|---|---|---|---|---|
| M1 | `episode.rs` 追加 `pub const SUPPORT_MAX_DIST_M: f64 = 25.0;` | `support_caliber_is_live_read_from_p16_not_copied` | **GREEN** | ❌ 守卫空转 |
| M1b | `evidence.rs` 追加 `pub const SUPPORT_MIN_FORWARD_M: f64 = 2.0;` | 同上 | **GREEN** | ❌ 同上 |
| M2 | `evidence.rs` `MatchGapCount => dm.gap_count() == dm.gap_count()` 改 `=> true` | `locus_read_probes_actually_read_the_field`、`evidence_table_lists_every_locus_and_every_row_is_readable` | **GREEN / GREEN** | ❌ 死探针未被抓 |
| M3 | `episode.rs` `loose_runs` 去掉 `&& !in_restart_window(...)` | `loose_ball_criterion_guard_has_discriminating_power` | **RED**（`:454`，目标测试名可见） | ✅ |
| M3b | 同 M3 | `loose_ball_criterion_excludes_the_restart_prep_window`（判据本体） | GREEN | ⚠️ 判据本体不覆盖该变异，只靠配套反证条 |
| M4/M13 | `LooseRun::chasing_teams` 改成 `chasers.iter().chain(close_downers)` | `pursuit_role_guard_has_discriminating_power` | **RED**（`:566`） | ✅ |
| M5 | `episode.rs` 非注释行追加 `pub const ZZZ: &str = "build_up";` | `wording_guard_rejects_phase_vocabulary_after_stripping_comments` | **RED**（`:691`） | ✅ |
| M6 | `reasons.rs` `coverage_of` 加 `unwrap_or(&CONTEST_COVERAGE[0])` 兜底 | 全默认套件 | GREEN（唯一红是产物门 `:1195`，与变异无关） | ⚠️ 兜底变异**不被覆盖缺口门**抓（该变异改的是 `coverage_of`，而 `closed_set_...` 走 `is_some()`，仍为真；`contest_coverage_guard_...` 的 ② 直接 `unwrap()`，也仍为真）——建议补一条「表里没有的成因必须返回 `None`」 |
| M7b | 从 `EVIDENCE_TABLE` 删掉 `MoverTarget` 那一行 | `evidence_table_lists_every_locus_and_every_row_is_readable` | **RED**（`:170`，表漏项） | ✅ |
| M8 | `spec.md` 的 A2 scenario 还原成「各自都能找到样本」 | `spec_anomaly_coverage_blocks_carry_both_halves` | **RED**（`:855`） | ✅ |
| M9 | `tasks.md` 停止条件 bullet 还原成裸 bullet | 同上 | **RED**（`:855`） | ✅ |
| M10 | `episode.rs` 删掉 fallback 第 2 档 `open_play_resumed_t` | `restart_window_falls_back_explicitly_when_taken_t_is_missing` | **GREEN** | ❌ 该档在真实 seed 上是死代码（见下） |
| M11 | `episode.rs` 删掉 fallback 第 3 档 `next_restart_start_t` | 同上 | **GREEN** | ❌ 同上 |
| M12 | `episode.rs` `action_token` 把 `"intercepted" => "passI"` 改 `"passX"` | `action_tokens_match_the_p17a_reference` | **RED**（`:825`） | ✅ |
| M14 | `report.rs` 的 `render_card_md` 插入 `（本段属 build_up）` | `wording_guard_...`、`report_is_deterministic_and_self_describing` | **GREEN / GREEN** | ❌ 产物模板不在措辞守卫扫描面内 |

**独立复现到的（与产物/文档对得上的部分，供对照）**：

- 三条不可越界：`git diff main --stat -- engine/src` **空**；剥注释后
  `tests/p17b/{evidence,episode,reasons}.rs` **零** phase 词；产物里 `PASS/FAIL/通过率/好/坏/合格`
  全 0（`canary.md` 里仅有的「失败/通过」出现在元陈述句「它不给出通过/失败判定」与
  「本 change 要防的失败」，不是判定）。
- 946 段 / 均长 3.024、准备期 379 段 / 6.277——**复现**（design §4.4.1 表）。
- 57.2% / 42.8%：**复现**，但口径是 **any-mover**（`chase` 或 `close_down`）；
  chase-only 是 **11.3% / 88.7%**（与 `tasks.md` 第 2 处更正逐位吻合）。
- `chase` 在准备期 **0 个**、`close_down` 距球 median 2.39 m——复现。
- 重开窗口：30 seed 共 **1613**，档位 `{taken_t: 1611, stream_end: 2}`，
  `open_play_resumed_t` / `next_restart_start_t` **各 0**；两个 fallback 样本
  （seed 8 `start=5394`、seed 9 `start=5400`）与 `evidence.rs`/`design §5-3` 记载一致。
- `interception_loose` 730 张卡 **全部** `pursuit.state == "invisible"`；
  `tackle_loose` 434 / `shot_rebound` 7 全 visible（与 `CONTEST_COVERAGE` 一致）。
- 产物抽验：JSON 合法；30 seed canary 3075 张卡，`duration_s` 与 `end_t-start_t` 全等、
  闭合卡 tail 非空且落在 `(end_t-3, end_t]`、`bad_event_indexes` 全 0、
  `replay` 下标可回到事件流（我另跑 `replay_locators_...` 亦绿）；
  产物里 `evidence_table`(33 行)/`structural_unavailable`(4 行)/`contest_coverage`(6 行)
  与 `evidence.rs`/`reasons.rs` 常量**逐行一致**。
- `formal_path_is_byte_identical_...`、`exception_thresholds_match_the_p17a_rules`、
  `action_tokens_...`、`spec_anomaly_coverage_*`、`observation_credibility_gate_...` 均绿。

**未覆盖/存疑**（我没能核实的，别当已核）：

- **「宽松口径 324 段 / 8.83」复现不出**。我写了两种「跨过非 loose beat」的实现，
  都收敛到严格口径的 946 / 3.024（差异 0），因此无法确认也无法否证 `tasks.md:47`
  与 `episode.rs:244` 的「差 3 倍」。可能是我对「宽松」的定义与原作者不同；
  建议原作者补一段可复现的脚本或写清判据。
- **`close_down` 的 `SaveCaught` 分流实际占比**。我在 `lib.rs` 确认了代码路径
  （`TransitionSource::Tackle => st.ball_pos` / `SaveCaught => attacking_forward(...)`），
  但**没有**测出 30 seed 里有多少 `close_down` 走的是 `SaveCaught` 分支
  （原始 movers 数组不携带来源，须读引擎内部状态）。所以「37% 在追人」的**方向**我只用
  距离分布间接支持（168/513 距球 > 5.25 m），**没有**独立证实其来源归因。
- **`card_of` 的 `coherent` 字段在产物里恒 1**：30 seed 全 `coherent: true`、`gap_count: 0`，
  所以「观察不可信门」的**真实路径**从未被走到，只有 `observation_credibility_gate_...`
  里那条人为造卡的断言在守它。这是预期的（引擎侧自洽），但意味着该门在真实数据上没有取证。
- **产品层「不产生 pass/fail」我只核了字符串**（禁串表 + 全量扫）。「好/坏标签」的**语义**
  层面（例如某个措辞是否在暗示优劣）我没有系统核，只抽查了 md 的固定结语。
- **P17A 的交叉引用**：我没有重跑 P17A 的产物，故 `ANOMALY_COVERAGE` 里 A1/A4–A10
  那 8 条「有逐 episode 样本」的声明，我只核了「表里有这一行、`note` 非空」，
  **没有**逐条去 L1 里验证它承诺的那个样本真的能取到。
- **`p17b_baseline`（300 seed）产物**：我只解析了磁盘上那份（陈旧）baseline，
  没有在 `da4d651` 上重跑 300 seed（约 20 s×N 的产物门，且会覆盖磁盘产物）。
  baseline 的 `cards_omitted = 26973`、`by_exception.long_dwell.kept_in_l1 = 3041`
  等数字我未独立复算。
- **并发编辑**：审阅期间分支从 `da4d651` 推进到 `beb822d` + 未提交改动
  （`contest_duration_s` / `SelectionKind` / `EXC_CLASS_CAP` 等）。
  我只对 `da4d651` 负责；新改动里 `build_report` 的**等距抽样**分支
  （`Stride`）我**完全没有审**（它在本轮定稿之后出现）。

**补记（同一审阅 agent，写完后核对最新 HEAD）**：

写完之后分支又推进了两笔（`beb822d` → `67884ea`「fix(#17B): 三处口径错（自查 + 实测驱动）」），
产物也重跑过（`source_commit = 67884ea`，`test_source_fingerprint = fnv1a64:2958e493e9215b76`）。
我在**最新 HEAD** 上重核了一遍各条：

- **已修**：`instant_contest` 口径（产物 `by_exception.instant_contest.cards_full_corpus`
  由 **1** 变为 **744**，与我对「争抢时长 == 0」的实测一致）；
  越界计数改逐卡自算（我这轮见到的实现已是逐卡）；
  产物指纹哨兵现在**绿**（默认套件 `27 passed; 0 failed; 2 ignored`）。
  ⇒ 我原报告里的 **P1-b（instant_contest 口径）与 P1-d（产物同源门红）在最新 HEAD 上已不成立**，
  保留在文中以便追溯（它们对 `da4d651` 成立）。
- **仍未修（在 `67884ea` 上重核）**：
  - **P1-a（卡片【丢球后】只展示收束那一拍）**——`episode.rs:504` 仍是
    `loose_runs(dm, windows, (ep.start_t.value, end_t))`；重跑后的产物仍是
    **段长 `{1: 674}`、`chase_class {one: 674}`、段末端 `==end_t: 674`**。
    这一条**没有变**，仍是本 change 最重的问题。
  - **P1-c（同源哨兵只扫一个文件）**——`p17b_diagnosis_report.rs:765` 仍只 include
    `p17b_diagnosis_report.rs`；`episode.rs`/`evidence.rs` 仍不在扫描面内（变异 M1/M1b 仍会存活）。
  - **P2 ×4**——`MatchGapCount` 恒真（`evidence.rs:256`）、措辞守卫仍不覆盖 `report.rs`、
    `188/513` 三处引用未改单位、`by_contest_start` 仍无分母。
  - **MINOR ×4**——`episode.rs:249` 仍指向不存在的「口径对照栏」与不可复现的「3 倍」、
    `evidence.rs:330` 仍写「`chase` 共 3091 个」、`p17b_diagnosis_report.rs:1332` 仍是
    「实测 10 seed > 300」（实测 209）、`contest_coverage_guard_...` 的 ① 仍与注释不符。

⇒ **判定维持「需修改」**（P1-a / P1-c 在最新 HEAD 上未修）。
另外：`67884ea` 引入的 `SelectionKind` / `EXC_CLASS_CAP` **等距抽样**路径我**没有审**
（它晚于本轮定稿）——那是一个新的产物筛选语义，须单独核它的选取口径是否与
「类内分位尾部」的实测依据一致、以及是否有断言守住它。
