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

---

## 作者修复记录（**非审阅结论**；仅供审阅者定位，不代替其核实）

> ⚠️ 本节由**被审者**写，故**不得**被当作「已修复」的证据。审阅者须独立复核。

第 1 轮判「需修改」后的修复落在 `beb822d` / `67884ea` / `bdd1e65`。

| 轮 1 发现 | 修复提交 | 修法 | 新增/加强的守卫 |
|---|---|---|---|
| [P1] 卡片【丢球后】只展示收束那一拍 | `bdd1e65` | pursuit 窗 `(start_t, end_t)` → **争抢窗** `[end_t, contest_ended]` | `pursuit_window_spans_the_whole_contest_not_just_the_closing_tick`（断言段须**跨过** `ep.end_t`；初版在此会红） |
| [P1] `instant_contest` 口径错 | `67884ea` | 改用**争抢**时长 | `instant_contest_uses_the_contest_duration_not_the_possession_duration` |
| [P1] 同源哨兵只扫一个文件 | `bdd1e65` | 扫 `TEST_SOURCES` 里 p17b **全部模块** | 同上测试（变异 M1/M1b 现会红） |
| [P2] `MatchGapCount` 死探针 | `bdd1e65` | 补判别输入 + 如实标注能力边界 | `locus_read_probes_...` |
| [P2] 措辞守卫不覆盖 `report.rs` | `bdd1e65` | 纳入扫描（原排除理由在该文件上不成立） | `wording_guard_...`（变异 M14 现会红） |
| [P2] `188/513` 单位混用 | `bdd1e65` | 改 `168/513（32.8%）` 并注明世界坐标 | 三处引用已同步 |
| [P2] `by_contest_start` 无分母 | `bdd1e65` | 补 `facts_full_corpus` + 「未被覆盖」栏 | md 显式写出 610 条未覆盖 |
| [MINOR] ×4 | `bdd1e65` | 逐条改（见提交信息） | — |
| （自查）同刻多段重复认领争抢事实 | `bdd1e65` | 只归最靠前那段 | `a_contest_fact_closes_at_most_one_episode` |
| （自查）普查/卡片两口径混用 | `bdd1e65` | 分列 + 普查复现 design §4.4.1 | `loose_census_reproduces_the_design_caliber_and_differs_from_the_card_caliber` |

**同时记录一处「审阅未能核实」的反馈**：审阅者说复现不出 `tasks.md` 的「宽松口径 324 段 / 8.83」。
作者的处置：**该口径已从代码与注释里删掉**（`episode.rs` 不再声称「差 3 倍」或「见口径对照栏」），
分段口径只剩一条：**流中相邻**。产物里并列的是**普查（匹配级）vs 卡片（争抢窗）**，
不是「严格 vs 宽松」。

**新增的两栏口径（供审阅者重点核）**：
- 产物新增「全场松散球普查」节（匹配级口径）——它应与 design §4.4.1 的
  **946 段 / 均长 3.02 / both 57.2% / one 42.8%**（canary）对得上；
- `by_contest_start` 新增「全量事实 / 被卡覆盖 / 未被覆盖」三栏；
- 异常类表新增「L1 选取口径」栏（`tail_p90` / `all` / `stride` / `all_canary`）。

---

### 轮次 2 — 需修改（独立审阅 agent · Claude / paseo worktree `1g1x3st4` · 2026-09-30）

**审阅对象**：`bdd1e652c664790ea3389e6fb6297b9a67dcaf26`（我 `git rev-parse HEAD` 自核）。
默认套件实跑：`30 passed; 0 failed; 2 ignored`。每条变异都在**改前 `git diff` 确认干净、
改后 `git checkout -- engine/tests` 还原、再 `git status` 确认 pristine** 的循环里跑；
每条判红都**亲眼见到目标测试名 + `panicked at`**（排除编译失败）。
临时探针 `engine/tests/zz_p17b_r2_probe.rs` 用完**已删**（`git status` 现仅剩 `REVIEW.md` 的未提交改动）。

**方法**：全程用 analyzer **自己的** `card_of` / `loose_runs` / `classify` / `build_report`
（`#[path]` include 四个模块），不重实现口径；产物的 canary/baseline 均在 `/tmp` **重跑**
（`P17B_OUT_DIR=/tmp/p17b-regen`），未覆盖磁盘件。

#### 逐条复核轮次 1

| 轮 1 发现 | 在 `bdd1e65` 上 | 证据 |
|---|---|---|
| **[P1-a]** 卡片【丢球后】只展示收束那一拍 | **不成立（已修，且守卫真判红）** | 用 `card_of` 跑 30 seed：段长分布由轮 1 的 `{1:674}` 变为 `{1:11, 2:1, 3:652, 4:8, 5:1, 6:1}`；`extends_past_ep_end=663`。变异「把 pursuit 窗右端从 `contest_end` 退回 `end_t`」→ 目标测试 **RED**（`p17b_diagnosis_report.rs:1374`，`{1:674}` 复现）。 |
| **[P1-b]** `instant_contest` 用 possession 时长 | **不成立（已修，守卫真判红）** | 30 seed 实测争抢时长==0 占 **1082/2027（53.4%）**、possession 时长==0 仅 **1/3075**。变异退回 possession 口径 → `instant_contest_uses_the_contest_duration_...` **RED**（`:1217`）。 |
| **[P1-c]** 同源哨兵只扫一个文件 | **不成立（已修，守卫真判红）** | 扫描面现为 `TEST_SOURCES` 里全部 5 个 p17b 模块（探针实测命中 5）。变异 M1/M1b/M1c（往 `episode.rs` / `evidence.rs` / `report.rs` 追加 `SUPPORT_*_M`）**三条全部 RED**（`:831`）——轮 1 时全 GREEN。 |
| **[P1-d]** 产物与源码不同源（默认门红） | **不成立（门现绿）** | 默认套件 30/30；`on_disk_artifacts_share_...` 绿。但我另查到一处**标签陈旧**（见「新发现」M-1）。 |
| **[P2]** `MatchGapCount` 恒真死探针 | **仍成立（未真正修复）** | 见「新发现」P2-1——这是本轮判「需修改」的唯一实质原因。 |
| **[P2]** 措辞守卫不覆盖 `report.rs` | **不成立（已修，守卫真判红）** | 变异 M14 重做（往 `render_card_md` 插 `（本段属 build_up）`）→ `wording_guard_...` **RED**（`:769`，点名 `p17b/report.rs`）。 |
| **[P2]** `188/513` 单位混用 | **不成立（已修）** | 我按世界坐标（`Δx·105, Δy·68`，球位取当拍 `BallState`）独立复算 8 seed：`n=513`、`>5.25m=168`（32.7%）、median 2.39 m、p10 1.53 m——与新的 `168/513（32.8%）` 逐位吻合。三处引用已改并注明坐标口径。 |
| **[P2]** `by_contest_start` 无分母 | **不成立（已修）** | 产物新增「全量事实 / 被卡覆盖 / 未被覆盖」三栏；300 seed 重跑自洽（`uncovered == facts − cards` 逐行成立；合计 facts **20053** / cards **14108** / uncovered **5945**）。缺口在 md 里被显式写成「5945 条不与任何 episode 收束同刻」，且我独立核出该缺口**全部来自 `delivery_loose`**（见「轮 1 未覆盖 → 已核」k）。 |
| **[MINOR]** `episode.rs` 指向不存在的「口径对照栏」+ 不可复现的「3 倍」 | **不成立（已处置）** | 原注释已删；现注释是一段**自我更正**（明确写「审阅复现不出那个 3 倍、产物里没有口径对照栏」）。「3 倍」在代码/产物里**不再作为结论出现**。 |
| **[MINOR]** `evidence.rs` chase 计数把子集写全集 | **不成立（已修）** | 现文写「全量 6745；其中开球期松散球 beat 内 3091；另 3654 落在非松散球 beat」。我探针复算：全量 `chase` **6745**、松散球段内 **3091**——逐位吻合。 |
| **[MINOR]** `aggregates_are_not_vacuous...` 注释里的数不符 | **不成立（已修）** | 注释由「实测 10 seed > 300」改为「实测 10 seed = 209（30 seed = 674）」，我复算 30 seed `loose_runs = 674`。 |
| **[MINOR]** `contest_coverage_guard_...` 的 ① 名不副实 | **部分成立** | ① 现改为「用本地副本表驱动查找」并附一段说明，但实现仍是**同义反复**（`found.is_none()` 恒真——`found` 来自刚被 `filter` 掉的列表），且**没有调用真的 `coverage_of`**。见「新发现」P2-2。 |

#### 新增守卫的变异表（本轮**独立**重做；每条都自核 pristine）

| # | 变异改法 | 目标测试 | 实际结果 | 真判红？ |
|---|---|---|---|---|
| M1 | `episode.rs` 追加 `pub const SUPPORT_MAX_DIST_M: f64 = 25.0;` | `support_caliber_is_live_read_from_p16_not_copied` | **RED**（`:831`，README 点名 `p17b/episode.rs`） | ✅（轮 1 GREEN） |
| M1b | `evidence.rs` 追加 `SUPPORT_MIN_FORWARD_M` | 同上 | **RED**（`:831`） | ✅（轮 1 GREEN） |
| M1c | `report.rs` 追加 `SUPPORT_MAX_DIST_M` | 同上 | **RED**（`:831`） | ✅ |
| M-P1a | pursuit 窗右端退回 `end_t` | `pursuit_window_spans_the_whole_contest_not_just_the_closing_tick` | **RED**（`:1374`，`{1:674}` 复现） | ✅ |
| M-IC | `instant_contest` 退回 `end_t-start_t` | `instant_contest_uses_the_contest_duration_not_the_possession_duration` | **RED**（`:1217`） | ✅ |
| M-A2 | 删类定义里「~70%」缺口措辞 | `instant_contest_covers_only_the_episode_closing_share_of_a2` | **RED**（`:1309`） | ✅ |
| M-CEN | `chase_class` 改成与 `presence_class` 同源 | `loose_census_reproduces_the_design_caliber_and_differs_from_the_card_caliber` | **RED**（`:1452`） | ✅ |
| M-WORD | `render_card_md` 插 `build_up` | `wording_guard_rejects_phase_vocabulary_after_stripping_comments` | **RED**（`:769`） | ✅（轮 1 GREEN） |
| M-OWN | 去掉 `closing_contest_fact` 的同刻 tie-break | `a_contest_fact_closes_at_most_one_episode` | **RED**（`:1500`，seed 24 复现） | ✅ |
| M3 | 去掉 `!in_restart_window(windows, ev.t)` | `loose_ball_criterion_guard_has_discriminating_power` | **RED**（`:489`，427 vs 427） | ✅（本就红） |
| **M2** | `evidence.rs` `Locus::MatchGapCount => true` | `locus_read_probes_actually_read_the_field` | **GREEN** | ❌ **守卫仍空转** |

#### 新发现

- **[P2-1] 轮 1 的 `MatchGapCount` 死探针未修复，且修复文本新造了一处「假覆盖声明」**（本轮判「需修改」的唯一实质原因）
  - 轮 1 的建议是「给 `MatchGapCount` 造一个**判别输入**（如断言 `gap_count()` 插入 gap 后**变大**）」。
    作者写的是 `with_gap.gap_count() >= dm.gap_count()`（`p17b_diagnosis_report.rs:302-305`），
    而 `dm.gap_count()` 实测为 **0** ⇒ `usize` 的 `>= 0` **恒真**，对 `Locus::read` 的
    `MatchGapCount => true` 变异**无判别力**——**M2 实测仍 GREEN**。
  - 更重的是注释（`:296`）：「恒 `true` 的探针在这里仍会存活——故另有
    **`match_gap_count_probe_actually_counts`** 直接核 `gap_count` 的行为」。
    我 `grep` 全仓：**该测试名不存在**（`engine/tests` 与 `openspec/` 零命中）。
    ⇒ 这正是本仓点名的 `[[false-coverage-handoff-claims]]`：**断言存在、覆盖声明存在、
    覆盖面不存在**，而且它出现在「声称已修复该族缺陷」的那一笔提交里。
  - 影响面与轮 1 同（`read` 的编译期字段存在性仍在；运行时判别力仍是空的），
    但「已如实标注能力边界」这句**本身不实**。建议：要么直接断言插入 gap 后 `gap_count()`
    **严格变大**（对 `read => true` 仍不判红，故须**另加**一条直接核 `gap_count` 行为的测试，
    名字就用注释里那个或改注释），要么把兜底分支拆开、注释改成「本变体只有编译期保证」并
    **删掉悬空的测试名**。

- **[P2-2] `contest_coverage_guard_has_discriminating_power` 的 ① 仍不触及真的 `coverage_of`**
  - ①（`p17b_diagnosis_report.rs:359-375`）用本地 `probe_table` 做 `filter`，再对同一列表
    `find` 并断言 `is_none()`——**同义反复**，且没调用 `coverage_of`。
    实测：给 `reasons.rs::coverage_of` 加兜底 `unwrap_or(&CONTEST_COVERAGE[0])`（把「未声明」
    静默当成已声明），`closed_set_...` / `contest_coverage_guard_...` / `spec_anomaly_coverage_*`
    **全 GREEN**（`:108` 的变异确在二进制里生效）。
  - 轮 1 的建议（「用一个局部副本表驱动 `coverage_of` 的逻辑」）**没有落到真的函数上**。
    建议：把 `coverage_of` 拆成 `fn coverage_in(table: &[ContestCoverageRow], r) -> Option<..>`
    再让真函数调用它，反证条即可对**真函数**判红。

- **[MINOR] M-1 磁盘产物的 `source_commit` 是 HEAD 的父提交**
  - 磁盘 `engine/target/p17b-diagnosis/*.{json,md}` 的 `source_commit = 67884ea…`，而 HEAD=`bdd1e65`。
    我核过：**内容与 `bdd1e65` 逐字节一致**——用 `P17B_SOURCE_COMMIT=67884ea…` 重跑 canary，
    与磁盘件**逐字节相同**；用 `bdd1e65` 重跑则**只差那一行 `source_commit`**。
    根因是常规的「先跑门、后提交」（产物 17:07，提交 17:08）。指纹门
    （`on_disk_artifacts_share_...`）与 `source_commit != unknown` 都**不会**抓它
    （门不核 `== HEAD`）。影响有限（content 是对的，指纹也对得上），但「产物 = 哪一版源码」
    这条线索在 `source_commit` 一栏上仍会误导。建议：把 `source_commit` 换成**由产物指纹反推**
    或干脆标注「本栏是提交时点的 HEAD、可能与内容差一笔」，或让产物门在 `P17B_SOURCE_COMMIT`
    ≠ 内容指纹所对应的提交时发声。

- **[MINOR] M-2 `ANOMALY_COVERAGE` 有三条 note 声称取了产物里不存在的字段**
  - 产物卡（`l1[]`）与顶层**都不含** `ControlFact.location`、下一段的 `start_reason`、
    逐条的 `RestartWindow`/`end_source`（我逐键核过）。但 note 写：
    - A4「重开窗的右端来源亦在 provenance 的口径快照里」——provenance 只记了
      「两档实测从不构造」的**文本**与 `stream_end` 计数，**没有逐条 `end_source`**；
    - A7「本层的重开窗（`RestartWindow`）逐条给出 `[start,end)` 与右端来源」——产物**没有**
      `restart_window` 结构（只在 `evidence_table` 的常量说明里出现 `end_source` 一词）；
    - A8「本层给收束侧事实下标；**位置须读 `ControlFact.location`**」——产物给了
      `closing_fact_index`，但**没有 `location` 字段**，故读者**无法**从产物得到位置；
    - A10「本层给…下一段的 `start_reason`/队；**单段内**即可看到」——卡里**没有**下一段字段，
      「单段内」与「下一段」自相矛盾。
  - 这几条与轮 1 的立身之本是同一把尺子（「不得声称能解释它看不见的东西」）。属
    「结论对但机制/落点错」族，且守卫 `every_p17a_anomaly_rule_is_declared_...` 只核
    「note 非空」，抓不到。建议：要么把 note 改成产物**实际**有的落点，要么补相应字段。

- **[MINOR] M-3 `episode.rs` 关于争抢窗的两句话互相矛盾**
  - `contest_window` 字段声明（`:519`）：`[contest_started.t, contest_ended.t]`，且写
    「追逐过程的段取自**它**——不是 `[start_t, end_t]`」；但 runtime 实际调用
    `loose_runs(dm, windows, (ep.start_t.value, Some(contest_end)))`（`:560`），
    左端是 **`ep.start_t`**，注释块（`:546`）也写「窗取 **`[end_t, contest_ended]`**」。
    三处说了三种左端。实跑上无差别（我核过：`[start_t, end_t)` 内 loose beat 数 = **0**，
    且宽窗 `(start_t,cend)` 与窄窗 `(end_t,cend)` 结果 **1417 相同 / 0 不同**），
    但这是「三处说法不一致、其中统一靠巧合」的形态，属于本 change 反复记的
    `[[conclusion-right-mechanism-wrong]]`。建议把三处统一到一个左端并说明为何二者等价。

#### 轮 1「未覆盖/存疑」——本轮核掉的

- **`close_down` 的 `SaveCaught` 分流占比：实测**（这是**推翻**设计 §4.4.3 归因的一处）。
  - 口径：`SaveCaught` 来源的 `close_down` 只在 `finalize_highlight(ShotSavedCaught)`
    武装 `transition`（`TRANSITION_TICKS=4`）后产生，该 tick 同时把**旧** episode 以
    `SavedCaught` 收束。30 seed 实测：**`SaveCaught` 窗口内 `close_down` = 215 / 2162（9.9%）**；
    8 seed（轮 1 的区间）：**9 / 513（约 1.8%）**。
  - **反证**：我另核「`close_down` 的 move 终点是否在**靠近球**」——8 seed 下
    **靠近 513 / 远离 0**。也就是说，按 `SaveCaught` 窗口划分出的 `close_down`，
    **其 move 仍然朝球移动**。
  - ⇒ 轮 1 用「距球 > 5.25 m」间接支持「37% 在追人」，但**距球远 ≠ 在追人**：
    `close_down_stop` 只推进 `d − 0.02`（≈2 m），**打不到靶点**，故远端球员的 mover
    终点天然离球很远（我 dump 到 19–30 m 的样本，全部朝球**逼近**）。
    「先逼近、但停在离球仍远的位置」在 `close_down` 这个动作上是**常态**，
    不能据此命名「追人」。措辞纪律（不并称 `chase`/`close_down` 为「追球者」）**仍然成立**
    （`close_down` 的靶点确实按 `TransitionSource` 分流），但**支撑它的那两个数字（188/513、168/513）
    与「追人」的因果链不成立**——它们量的是「停在远端」，不是「追的是人」。
    当前产物只在值层面展示 `close_down`（正确），**没有**把它命名成「追人」（也对），
    但这层「数字→机制」的归因被写进了 `evidence.rs` 的 `MoverTarget` 行与 `reasons.rs`
    的 `WORDING_RULES`（`why` 一栏），**仍值得收回**。建议：把这行改成「终点距球远，
    因 `close_down_stop` 只推进到 ~2 m 外，**不代表追人**；`SaveCaught` 分流实测仅约 10%」。

- **`ANOMALY_COVERAGE` 里 A1/A4–A10 的「有逐 episode 样本」能否真取到样本：可核的已核。**
  - 逐 episode 筛子命中（30 seed，`classify`）：`long_dwell` **2229**（A1）、`empty_possession`
    **161**（A6）、`instant_contest` **743**（A2）、`shot_rebound_end` **7**（A4）——四类**均有样本**。
  - A5/A9 靠 `chain`（每卡都有）；A2/A3 的**追逐过程**落在盲区（已由 `Incontestness` 正确声明）。
  - **但** A4/A7/A8/A10 的 note 声称的**具体落点**在产物里不存在（见 M-2）——
    所以「有样本」这半**成立**，「样本里带 note 声称的那个字段」这半**不成立**。

- **`baseline`（300 seed）产物：已重跑并逐项自洽。**
  - 重跑 `cards_omitted = 26813`、L1 收录 **3366**、`l2.cards = 30179`。
  - `by_exception.*.kept_in_l1` 与「L1 里该类重算张数」**逐类相等**
    （`long_dwell` 3186、`instant_contest` 1028、`empty_possession` 148、`shot_rebound_end` 73）
    ——「全集命中 / 进了 L1 / 选取口径」三栏自洽，且 `kept_in_l1` 是「该类被选进 L1 的张数」
    （可重入分类的语义成立：`sum(kept)=4435 > L1 3366`，因为一张卡可属多类）。
  - 新增的「L1 选取口径」栏（`tail_p90` / `stride` / `all` / `all_canary`）与 `EXC_TAIL_*` /
    `EXC_CLASS_CAP` 逻辑一致（`instant_contest` 与 `shot_rebound_end` 驱动量退化 ⇒ `stride` 等距抽样，
    其余 `tail_p90`）；canary 一律 `all_canary`。**自洽。**
  - 我另核了 [P2]「`by_contest_start` 无分母」的缺口成因：300 seed 的 **5945 条未覆盖全部是
    `delivery_loose`**（`delivery_loose` 全量 6275、同刻 330），与其 note/md 的说明**一致**
    （`delivery_loose` 是落点争抢，收束时刻常不在 episode 的 `end_t` 上）。

#### 不可越界核实（三条，全部独立跑）

1. **零 `engine/src/` 改动**：`git diff main --stat -- engine/src` → **空**（且 `git status` 干净）。✅
2. **不报相位**：自写**剥注释**扫描器扫 `tests/p17b/{evidence,episode,reasons,report}.rs`
   → **0 命中**（`Phase` / `build_up` / `progression` / `final_third` / `attacking_transition`）。
   `report.rs` 纳入扫描**未误伤**：它自身**不含任何 phase 字面量**（`grep` 只在注释里出现 `Phase`），
   `Phase` 闭集名由 `crate::model::sidecar_schema_fingerprint` 在**指纹构造点**经
   `add!("Phase", Phase::ALL)` 产生——该宏在 `p17a/model.rs`，**不在扫描面内**，
   故「纳入 `report.rs` 会误伤」**不成立**（轮 1 的排除理由确实站不住）。✅
   （入口文件 `p17b_diagnosis_report.rs` 自身的 `PHASE_TOKENS` 常量与反证条字面量命中 6 处，
   是守卫的**判据源**，不属禁令范围，且该文件不在三条要求的扫描面内。）
3. **不产生 pass/fail**：扫 canary/baseline 的 JSON+MD，`PASS/FAIL/通过率/好、坏/合格/passed/failed`
   **全 0**；`通过/失败` 仅出现在「它不给出通过/失败判定」「失败传球不造成失球」这类
   **元陈述/赛事事实**里，非判定。✅

#### 新内容口径核对（`bdd1e65` 加的全场普查）

- **独立复现**（canary 30 seed，我 `P17B_OUT_DIR=/tmp/p17b-regen` 重跑）：
  - 普查段数 **946**、总拍 **2861**、均长 **3.02**——与 design §4.4.1 的 **946 / 3.02** 逐位一致；
  - **任一 mover** 口径 `both` **541（57.2%）** / `one` **405（42.8%）**——与 design 的 **57.2% / 42.8%** 一致；
  - `chase` 口径 `both` **107（11.3%）** / `one` **839（88.7%）**——与 `tasks.md` 第 2 处更正一致。
- **两分母是否写清**：**是**。产物 md 单列「### 全场松散球普查（**匹配级**口径）」，并加粗写
  「与 design §4.4.1 的权威数字**同分母**」「诊断卡里的【丢球后】一节只覆盖**该段争抢窗内的子集**
  ——**两者不可互相换算**」；`episode.rs` 的 `MatchCards` 字段注释亦分列 `census_*` 与卡片侧。
  **产物层的分列是实打实写出来的**（不是只在代码注释里）。

#### 未覆盖/存疑

- **P17A 的交叉引用仍只核了「本层」一侧**：我用本层的 `classify` 证明了四类筛子在 30 seed 上**有样本**，
  但**没有**重跑 P17A 的 10 条规则去逐条比对其样本集（那需要跑 P17A 的 `evaluate`）。
  A2 的母体数（300 seed 10564/20053）我只核了它的**本层对应**（`instant_contest` 全集 7364），
  没有独立重算 A2 本身的 10564。
- **「全场普查」与「卡片侧」的 946 是否结构 1:1 对应**（note §3.4 的更正）我未重核。
- **产物语义层的「好坏标签」**：我只核了字符串禁串表 + 人工抽查；「某个措辞是否在暗示优劣」
  我没有系统性判定（同轮 1）。
- **`EXC_CLASS_CAP=200` 的等距抽样**：我核了它的**口径标注**与**规模自洽**，但
  **没有**核「为何是 200」（作者的理由是「人眼可读」）是否与产物实际大小匹配（baseline 仍 11 MB）。

**判定**：**需修改**。三条 P1 全部**确实修复**且守卫经独立变异**真有判别力**（M1/M1b/M1c/M-P1a/M-IC 全红）；
但轮 1 的 **P2（`MatchGapCount` 死探针）未真正修复**——替换上的断言 `gap_count() >= gap_count()` 仍是
`usize >= 0` 的恒真式，`Locus::read` 的 `=> true` 变异（M2）**仍存活**，且注释把判别力推给了
**一个不存在的测试名**（`match_gap_count_probe_actually_counts`），构成一处**新的假覆盖声明**。
按本任务判定标准（「若轮次 1 的发现**全部**确实修掉」是「通过」的必要条件），P2 未修 ⇒ **需修改**。
其余新发现（P2-2 悬空反证条、M-1 产物 `source_commit` 陈旧、M-2 三条 note 指向不存在字段、
M-3 争抢窗三处说法不一）均为文档/守卫层，不阻断结论，但同属本 change 反复记的
「结论对但机制/落点错」族，建议一并收。

---

### 轮次 3 — 通过（独立审阅 agent · Claude / paseo worktree `1g1x3st4` · 2026-09-30）

**审阅对象**：`dc15f12b74a6d077473f1f0630721a278246df80`（我 `git rev-parse HEAD` 自核）。
默认套件实跑：`32 passed; 0 failed; 2 ignored`。
每条变异都在**改前 `git status` 确认干净、改后 `git checkout -- engine/tests`（或还原 `src` 备份）
还原、再 `git status` 确认 pristine** 的循环里跑；每条判红都亲眼见到**目标测试名 + `panicked at`**
（排除编译失败）。产物在 `/tmp/p17b-r3-regen` **重跑**（未覆盖磁盘件），磁盘件只读比对。
本轮**未新建**探针文件（`#[path] include` 式临时探针易与指纹门纠缠，改为直接读重跑产物 + 定向变异）。

#### 逐条复核轮次 2

| 轮 2 发现 | 在 `dc15f12` 上 | 独立证据 |
|---|---|---|
| **[P2-1]** `MatchGapCount` 死探针 + 悬空测试名 | **不成立（已真修）** | ① `grep -n "fn match_gap_count_probe_actually_counts"` → **存在**（`p17b_diagnosis_report.rs:1583` 定义，表头第 40 行亦登记）；② 断言体是**严格 +1 / −1 / +2**，不是 `>=`；③ 我把 `DiagnosticMatch::gap_count`（`observation.rs:1398`）改成常数 `0` ⇒ **RED**（`:1605`，`left: 0 / right: 1`），即它真在核 `gap_count` 的行为。④ 旧的 `gap_count() >= dm.gap_count()` 已**删除**。 |
| **[P2-2]** `contest_coverage_guard` ① 不触及真 `coverage_of` | **不成立（已真修）** | ① `reasons.rs` 拆出 `coverage_in(table, reason)`，真入口 `coverage_of` 只经它；② 反证条改为对**真函数** `coverage_in(&holed, …)` 喂**缺项表**（`holed` 由 `CONTEST_COVERAGE.to_vec()` + `retain` 去掉 `interception_loose`）；③ 变异实测见下表 M-3a / M-P2-2b **均判红**（轮 2 时全绿）。 |
| **[MINOR] M-1** 产物 `source_commit` 与 HEAD 差一笔 | **不成立（已处置）** | `report.rs:105` 的 `Provenance` 构造点与 `to_markdown` 的 md 栏均加注「本栏是跑门时记的 HEAD；判陈旧请看下面两条指纹」；我 `P17B_SOURCE_COMMIT=$(git rev-parse HEAD)` 重跑后 `canary.md` 与磁盘件**逐字节相同**（除该栏）。 |
| **[MINOR] M-2** `ANOMALY_COVERAGE` note 引用不存在字段 | **不成立（已修，守卫有效但有两处窄缺口）** | 四条 note（A4/A7/A8/A10）已改到产物**真有**的落点；新守卫 `anomaly_coverage_notes_only_cite_fields_the_product_carries` 对**普通**的不存在字段**判红**（M-NOTE-A7 / M-NOTE-PLAIN 均 RED，`:1682`）。窄缺口见「新发现」N-3。 |
| **[MINOR] M-3** 争抢窗左端三处说法不一 | **不成立（已统一）** | 字段注释（`episode.rs:521-527`）、注释块（`:551-555`）、runtime（`:560` 传 `(ep.start_t.value, Some(contest_end))`）现在**互相自洽**：语义窗 = `[contest_started.t, contest_ended.t]`（`contest_started.t == end_t`），实现左端取 `ep.start_t` 被**显式标注**为「宁宽勿窄的防御」。我另做**等价性反证**：把左端收窄回 `end_t` ⇒ 默认套件**除指纹门外零红**，与「两种左端逐段等价」的声明一致。 |

#### 变异表（本轮**独立**重做；每条都自核 pristine）

| # | 变异改法 | 目标测试 | 实际结果 | 真判红？ |
|---|---|---|---|---|
| M-GAP | `observation.rs` `DiagnosticMatch::gap_count` → `0` | `match_gap_count_probe_actually_counts` | **RED**（`:1605`，`left 0 / right 1`） | ✅ 新测试真有判别力 |
| M-3a | `coverage_of` 加 `.or(Some(&CONTEST_COVERAGE[0]))` | `contest_coverage_guard_has_discriminating_power` | **RED**（`:408`，源码文本档） | ✅（轮 2 GREEN） |
| M-3c | `coverage_of` 改成 `match coverage_in {None => Some(&first)}` | 覆盖类 5 测试 | **GREEN**（唯一红是与变异无关的产物指纹门） | ❌ **文本档可被 `match` 绕过** |
| M-3d | M-3c **＋** 从 `CONTEST_COVERAGE` 删掉 `interception_loose` 行 | `closed_set_…`、`contest_coverage_guard_…` | **RED**（`:340` `5≠6`；`:385` `TackleLoose≠InterceptionLoose`） | ✅ **同一性档兜住**（这才是真危险组合） |
| M-P2-2b | `coverage_in` 加 `.or(table.first())` | `contest_coverage_guard_has_discriminating_power` | **RED**（`:362`） | ✅ |
| M1/M1b/M1c | 往 `episode.rs` / `evidence.rs` / `report.rs` 各追加一份 `SUPPORT_*_M` | `support_caliber_is_live_read_from_p16_not_copied` | **RED**（`:878`） | ✅ |
| M-P1a | pursuit 窗右端退回 `end_t` | `pursuit_window_spans_the_whole_contest_not_just_the_closing_tick` | **RED**（`:1421`） | ✅ |
| M-IC | `instant_contest` 退回 possession 时长 | `instant_contest_uses_the_contest_duration_not_the_possession_duration` | **RED**（`:1264`） | ✅ |
| M-WORD | `report.rs` 的 `render_card_md` 插 `build_up` | `wording_guard_rejects_phase_vocabulary_after_stripping_comments` | **RED**（`:816`） | ✅ |
| M-NOTE-A7 | A7 的 note 还原成引用 `RestartWindow` | `anomaly_coverage_notes_only_cite_fields_the_product_carries` | **RED**（`:1682`） | ✅ 抓住它的原始靶子 |
| M-NOTE-PLAIN | note 引用普通的不存在字段 `RestartWindow` | 同上 | **RED**（`:1682`） | ✅ 非空转 |
| M-NOTE-EVADE | note 引用 `` `逐条 RestartWindow 的起止` ``（**反引号内有空格**） | 同上 | **GREEN** | ❌ 逃逸（见 N-3） |
| M-NOTE-VALUE | note 引用 `kickoff` 当字段名（它是产物的**值**） | 同上 | **GREEN** | ❌ 逃逸（见 N-3） |
| M2 | `evidence.rs` `Locus::MatchGapCount => true` | `locus_read_probes_actually_read_the_field` | **GREEN** | ⚠️ 仍未判别，但**已如实标注**（见下） |
| M-LEFT | pursuit 窗左端收窄回 `end_t` | 默认套件（等价性反证） | 仅指纹门红，**零行为红** | — 反证「两左端等价」 |

> **关于 M2**：`evidence.rs:256` 仍是 `Locus::MatchGapCount => dm.gap_count() == dm.gap_count()`（恒真）。
> 但 `p17b_diagnosis_report.rs:274-286` 的分支注释现在**如实写明**「本变体在运行时**无法判别**，
> 只有**编译期**保证」，且它把「行为判别力」指向的测试名**真的存在**（已由 M-GAP 证明）。
> ⇒ 这不再是「假覆盖声明」，而是一处**被显式标注的能力边界**；判定按此采信。

#### 新发现

- **[P2] 「收回 `close_down` 追人因果链」在 `p17b_diagnosis_report.rs` 留下一处**自相矛盾**的残留**
  - `p17b_diagnosis_report.rs:613-616`（`pursuit_roles_are_classified_never_merged` 的 doc）**仍写**：
    「侦察实测（8 seed、**世界坐标**）168/513（32.8%）的 `close_down` 终点距球 > 5.25 m——
    **它们在「追人」**。（… **结论不变**…见 `evidence.rs` 的 `MoverTarget` 行）」
  - 而它**指向的那一行**现在写的恰恰是反面：`evidence.rs:441-448` 明写「**不得把『距球远』读成『在追人』**
    （审阅轮 2 推翻）… `close_down_stop` 只推进 ≈2 m、打不到靶点… 实测 8 seed 全部**朝球逼近**」。
  - ⇒ 同一仓内**行 A 指向行 B，而行 B 否认行 A**。这正是本 change 反复记的
    `[[conclusion-right-mechanism-wrong]]`：作者收回了 `evidence.rs`/`reasons.rs` 两处（提交信息属实），
    但**第三处拷贝（本文件）漏了**。数字（168/513）本身没错，错的是它后面那句归因。
  - 建议：把这行改成与 `evidence.rs` 同调——「终点距球远，因 `close_down_stop` 只推进约 2 m、打不到靶点，
    **不代表追人**；`SaveCaught` 分流实测仅约 9.9%」。
  - 影响面：**文档层**，不进产物、不挂断言，故不阻断结论。

- **[P2] 同一处归因在 change 的**权威文档**里也未收**（`design.md` 仍以 37% 支撑「追人」）
  - `design.md:236-237`：「**`SaveCaught` → `attacking_forward(..)`（追人）**。实测（8 seed）
    **188/513（37%）** 的 `close_down` 终点距球 > 5.25 m。」——这**正是**轮 2 推翻的两个数
    （`188` 是归一化混用；「距球远 ⇒ 追人」的因果链不成立）。`design.md` 是产物 provenance
    与 spec 溯源的**权威稿**，读者会照它引。
  - `tasks.md:29` 仍写「MAJOR-2 `close_down` **不恒追球**（**37% 在追人**）」；
    `.scratch/notes/17b-recon-2026-09-30.md:181-182` 仍写「实测 **188/513** … ⇒ 它们在**追人**」。
  - 三处都**早于**轮 2，且作者的修复记录只声明改了 `evidence.rs` + `reasons.rs`（属实），
    故这不是「声称修复而没修」，而是**同一族残留**；但既然本轮任务要求 grep `188/168/追人`，
    如实记录。建议在 `design.md:237` 与 `tasks.md:29` 加**收回注记**（保留原数以便追溯，
    但标明「轮 2 推翻：此为距离口径，非追人证据；`SaveCaught` 分流实测 9.9%」）。
  - 影响面：文档层，不阻断。

- **[MINOR] N-3 新守卫 `anomaly_coverage_notes_only_cite_fields_the_product_carries` 有两处可绕路径**
  - (a) **反引号内有空格即跳过**：守卫 `if t.is_empty() || t.contains(' ') || t.contains('（') { continue; }`
    ——实测把 A7 的 note 写成 `` `逐条 RestartWindow 的起止` ``（一个**不存在**的字段/结构，
    只是短语里带了空格）⇒ 守卫 **GREEN**（M-NOTE-EVADE）。
  - (b) **「产物里出现过的串值」档**：`as_value = json.contains(&format!("\"{t}\""))` 对**键或值**都为真
    ——实测把 note 写成「本层给 `kickoff` 字段」（`kickoff` 是产物的一个**取值**，不是字段）
    ⇒ 守卫 **GREEN**（M-NOTE-VALUE）。
  - 我另核了守卫的键集抓取：它对整份 JSON 做**裸引号扫描**，抓到的 202 个 token 里有 **34 个不是真键**
    （`A1`、`both`、`home`、`canary`、`passI`、`kickoff` …）——即「档① `keys.contains(bare)`」
    实际把**值**也当键放行。这是上面 (b) 的根因。
  - 结论：守卫对它**设计的靶子**（note 里裸写一个不存在的字段名）**有效**（M-NOTE-A7 / M-NOTE-PLAIN 均 RED），
    但「说了产物给不出的东西」这条纪律的**一般形式**它挡不住。
    建议：把档③收紧为「**只比对值**（键集须来自 JSON 解析而非裸扫描）」，并去掉空格跳过
    （或改为「空格分隔后**逐 token** 核」）。

- **[MINOR] N-4 表头有一个**悬空测试名**（与轮 2 抓到的同族，但在**本文件**）
  - `p17b_diagnosis_report.rs:44` 登记 `` [`spec_anomaly_coverage_blocks_carry_both_halves_and_the_guard_is_not_vacuous`] ``，
    而全仓**无此函数**——真实的两条是 `spec_anomaly_coverage_blocks_carry_both_halves`
    与 `spec_anomaly_coverage_guard_is_not_vacuous`（名字被拼成了一行）。
    引入于 `da4d651`（`git log -S` 可证），**非** `dc15f12` 引入，且轮 2 亦未捕获。
  - 影响：文档表，极小；建议拆成两行或改成一个真实名字。

#### 产物核对（**重跑**，非磁盘件）

重跑命令（两条都 `P17B_OUT_DIR=/tmp/p17b-r3-regen`）：
`P17B_SOURCE_COMMIT=$(git rev-parse HEAD) cargo test --release --test p17b_diagnosis_report -- --ignored --nocapture p17b_canary|p17b_baseline`

- **普查节与 design §4.4.1 对得上**（canary）：`census_runs = 946`、`census_beats = 2861`
  ⇒ 均长 `2861/946 = 3.024 → 3.02`；任一 mover 口径 `both 541 (57.19%)` / `one 405 (42.81%)`；
  `chase` 口径 `both 107 (11.3%)` / `one 839 (88.7%)`。**全部与 design / tasks 逐位一致**。
- **`by_contest_start` 自洽**：逐行 `facts_uncovered_by_cards == facts_full_corpus − cards`
  成立（canary 合计 facts 2027 / cards 1417 / uncovered 610；baseline 20053 / 14108 / **5945**）。
  md 显式写出「**有 610 条争抢未被任何诊断卡覆盖**——它们**不与任何 episode 收束同刻**」，
  并声明「这不等于『没发生』」——**缺口有显式说明，非留空**。
- **「L1 选取口径」栏**：canary **4 类全为 `all_canary`**（`empty_possession`/`instant_contest`/
  `long_dwell`/`shot_rebound_end`）；baseline 为 `tail_p90`×2 + `stride`×2，与其 `EXC_*` 逻辑一致。
- **新增 `contest_window` 字段**：出现在 1417/3075 张卡（非争抢收束的 1658 张为 `null`）；
  逐卡核 **`window[0] == end_t`**（1417/1417）且 **`window[1] − window[0] == contest_duration_s`**
  （1417/1417，含 743 张 `contest_duration_s == 0.0` 的即时争抢）。
- **确定性**：`P17B_SOURCE_COMMIT` 相同重跑，`canary.json`/`canary.md` 与磁盘件**逐字节相同**。

#### 未覆盖/存疑

- **产物 md 不渲染 `contest_window`**（grep `canary.md` 仅命中 A8/A10 的说明行，卡体内无该栏）。
  A8/A10 的 note 写「**本层给**…争抢窗（`contest_window`）」——就 **JSON 产物**而言为真，
  故不构成「声称了给不出的东西」；但**只读 md 的读者看不到它**。属观察项，非缺陷。
- **P17A 侧交叉引用仍未独立重跑**：`ANOMALY_COVERAGE` 里 A1/A4–A10「有逐 episode 样本」的
  母体数（如 A2 的 10564/20053）我仍只核了**本层对应**（`instant_contest` 全集），
  未跑 P17A 的 `evaluate`。（同轮 1/轮 2，未变。）
- **`EXC_CLASS_CAP = 200` 的取值理由**（「人眼可读」）未核；baseline 产物仍 11.7 MB。
- **产物语义层的「好坏标签」**：同前两轮，只核字符串禁串表 + 人工抽查，未做系统性语义判定。
- **`design.md` / `tasks.md` / recon note 的历史归因**我只核了 `188/168/追人` 三个串；
  change 文档里是否还有**别的**已被推翻的归因，未做穷举。

#### 不可越界核实

1. **零 `engine/src/` 改动**：`git diff main --stat -- engine/src` → **空**。✅
2. **不报相位**：自写**剥注释**扫描器（先 `re.sub(r'/\*.*?\*/')` 去块注释，再逐行截 `//`）
   扫 `tests/p17b/{evidence,episode,reasons,report}.rs` → `build_up`/`progression`/`final_third`/
   `attacking_transition`/`Phase` **零命中**。✅
3. **不产生 pass/fail 或好坏标签**：扫重跑后的 canary/baseline 的 JSON+MD——
   `PASS`/`FAIL`/`通过率`/`合格`/`passed`/`failed` 全 **0**；`通过`/`失败` 仅出现在
   元陈述（「它不给出通过/失败判定」）与赛事事实（「失败传球不造成失球」）里；
   `坏` 仅 1 处、为技术词「不变量被破坏」。✅

#### 判定

**通过**。轮 2 的五条（P2-1 / P2-2 / M-1 / M-2 / M-3，含轮 1 遗留的 `MatchGapCount` 族）
**全部确实修掉**，且修复经独立定向变异**确有判别力**（M-GAP / M-3a / M-P2-2b / M-NOTE-A7 全红；
M-3c 的逃逸被 M-3d 的同一性档兜住）。
**未发现新的 P0/P1**：本轮四条新发现（N-1 `close_down` 归因在测试文件里的自相矛盾残留、
N-2 同一归因在 `design.md`/`tasks.md`/recon note 的残留、N-3 新 note 守卫的两处可绕路径、
N-4 表头悬空测试名）**全在文档/守卫层**，不进产物、不挂断言、不改变任何结论，属建议收尾项。
其中 **N-1 值得优先收**（它是「行 A 指向行 B、B 否认 A」的自相矛盾，最易误导下一个读者）；
N-2 因 `design.md` 是权威稿，建议一并加收回注记。

### 轮次 4 — 需修改（独立审阅 agent · Claude / paseo worktree `1g1x3st4` · 2026-09-30）

**审阅对象**：`4dad5a467d799dfecdd2b164b7c99a2fa7a08615`（我 `git rev-parse HEAD` 自核）。
默认套件实跑：`32 passed; 0 failed; 2 ignored`。产物在 `/tmp/p17b-r4` **干净重跑**（前台、无并发探针），
磁盘件只读比对。每条变异都在 `git status` 干净 → 改动 → `git checkout --` 还原 → `git status` 确认
pristine 的循环里跑；每条判红都亲眼见到**目标测试名 + `panicked at`**（排除编译失败）。

任务要求：确认轮 3 的 N-1..N-4 是否真被修掉、且这次修复本身没引入新问题。
结论提前说：**N-1/N-2/N-4 确实修好；N-3 反而引入了本轮唯一的 P1——新守卫的判别力比旧守卫更弱**
（旧守卫能判红的三种输入，新守卫全部放行），且**轮 3 明确点名、作者声称已堵的 `kickoff` 逃逸仍原样存活**。

#### 逐条核实 N-1..N-4

| # | 轮 3 的原话 | 在 `4dad5a4` 上 | 独立证据 |
|---|---|---|---|
| **N-1** | 入口测试 doc 的 `close_down` 归因与 `evidence.rs` 自相矛盾（第三处拷贝） | **不成立（已真修）** | `p17b_diagnosis_report.rs:613-626` 改写成「依据是**靶点分流**，**不要**用终点距离」；我逐条核了源码事实：`compute_mover_candidates`（`engine/src/lib.rs:3295`）`Tackle → st.ball_pos` / `SaveCaught → attacking_forward(st, tr.attacking)`、`CLOSE_DOWN_STOP_DIST = 0.02`（归一化 ≈2 m，`:692`）**全部存在且与 doc 一致**。三处（入口测试 doc / `evidence.rs:441` / `reasons.rs:283`）现在互相一致。 |
| **N-1（续）** | 建议 grep `188`/`168`/`追人` 找**第四处** | **发现第四处仍在**（见新发现 P2） | `grep` 全仓：`evidence.rs`/`reasons.rs`/入口测试/`design.md`/`tasks.md` 五处**已收回**；但 **`.scratch/notes/17b-recon-2026-09-30.md:180-183`（本轮被审提交未触及）仍写「实测 **188/513** … ⇒ 它们在**追人**」**，零注记。且该 note 被 `proposal.md:45`、`spec.md:22`、`tasks.md:9`、`.scratch/map.md:176`、`.scratch/notes/17b-handoff` 多处引用为设计依据。轮 3 报告（`:635`）点过这处，本轮只修了其点名的 `design.md`/`tasks.md`，漏了 `recon note`。 |
| **N-2** | `design.md`/`tasks.md` 的更正引注 | **不成立（已真修，且未篡改冻结正文）** | `design.md:238-250` 是在原证据句**之后**插入 `>` 引言块（原句 `:236` 保留可读），分「数值层 188 是归一化混用 / 因果层 `close_down_stop` 打不到靶点」两层，并明写**「结论与纪律不变…但依据只能是靶点分流本身」**。`tasks.md:29` 的 MAJOR-2 行同步加注。**冻结设计的原句没有被改得读不通**——`design.md:235-236` 的源码事实句与 `:252-253` 的正式措辞纪律原样保留。 |
| **N-3** | note 守卫三处可绕路径（引号内空格 / 值蒙混 / 只扫反引号内） | **三处已堵，但修复走了一条「收窄候选」的路，判别力反而变弱**（见新发现 P1） | ① 引号内空格：`` `逐条 RestartWindow 的起止` `` ⇒ **RED** ✅；② 裸 CamelCase：`**本层不给逐条 RestartWindow**` ⇒ **RED** ✅；③ snake_case 不存在字段：`foo_bar` ⇒ **RED** ✅。但沿路发现：**旧守卫能判红的 `location` / `restartwindow` / `chain.fake_field` 三种输入，新守卫全部放行**（变异表 M4-J/K/L）。 |
| **N-4** | 表头 `spec_anomaly_coverage_blocks_carry_both_halves_and_the_guard_is_not_vacuous` 悬空 | **不成立（已真修）** | 表头 `:44-45` 现拆成两行；两名字**都是真函数**：`fn spec_anomaly_coverage_blocks_carry_both_halves`（`:1000`）与 `fn spec_anomaly_coverage_guard_is_not_vacuous`（`:1776`）。我另扫了表头全部 34 个 `` [`name`] `` 引用，除 `classify`/`coverage_of`（那是散文里指方法名，非测试登记）外**无新的悬空测试名**。 |

#### 变异表（本轮独立重做；每条自核 pristine）

> 变异注入点：`reasons.rs` 的 `A7` note（`ANOMALY_COVERAGE` 行）。「NEW」= HEAD（`4dad5a4`）的守卫，
> 「OLD」= `dc15f12` 的守卫。判红 = 目标测试名 + `panicked at`。

| # | 注入的 note 片段 | 期望 | OLD | NEW | 判读 |
|---|---|---|---|---|---|
| M4-A | `` `逐条 RestartWindow 的起止` ``（引号内含空格） | 判红 | RED | **RED** | ✅ 轮 3 逃逸(a)已堵 |
| M4-B | `**本层不给逐条 RestartWindow**`（无引号） | 判红 | RED | **RED** | ✅ 轮 3 逃逸(③)已堵 |
| M4-C | `` `foo_bar` ``（不存在的 snake 字段） | 判红 | RED | **RED** | ✅ 非空转 |
| M4-D | `` `passC` ``（产物**值**，CamelCase） | 判红 | GREEN | **GREEN** | ❌ 仍逃逸（值蒙混，档①把值当键） |
| M4-E | `` `restart_control` ``（产物**值**） | 判红 | GREEN | **GREEN** | ❌ 仍逃逸 |
| M4-F | `` `kickoff` ``（**轮 3 的 M-NOTE-VALUE 原样重放**） | 判红 | GREEN | **GREEN** | ❌ **声称已堵，实测仍开** |
| M4-G | `` `chain.fake_field` ``（真键 head + **假尾段**） | 判红 | **RED** | GREEN | ❌ **新守卫回归** |
| M4-H | `` `fakename.team` ``（假 head + **真键尾段**） | 判红 | RED | GREEN | ❌ **新守卫回归** |
| M4-I | `` `event_indexes.nope` `` | 判红 | RED | GREEN | ❌ **新守卫回归** |
| M4-J | `` `location` ``（**守卫自己的动机字段**，全小写无下划线） | 判红 | **RED** | GREEN | ❌ **新守卫回归（最讽刺）** |
| M4-K | `` `restartwindow` ``（全小写无下划线） | 判红 | **RED** | GREEN | ❌ **新守卫回归** |
| M4-L | `` `nodes` `` / `` `team` `` / `` `player` ``（裸小写字段名） | 判红 | RED | GREEN | ❌ 新守卫回归 |
| ABL-1 | 去掉档③ `as_value` 子句 | 应红 | — | **仍 GREEN** | 档③在当前 notes 上**不承重** |
| ABL-2 | 去掉档④ `PROSE_OK` 子句 | 应红 | — | **仍 GREEN** | 档④在当前 notes 上**不承重** |
| ABL-3 | 去掉 `keys.contains(head/tail)` 子句 | 应红 | — | **RED** | 该子句**在承重**（放行 `ControlFact.team` 等） |
| ABL-4 | 去掉 `SOURCE_SIDE_OK` 子句 | 应红 | — | **RED** | 该子句**在承重** |

#### 新发现

- **[P1] 新 note 守卫的判别力**比旧守卫更弱**——它把「候选筛选」当成了「豁免」，于是**放行了旧守卫能判红的三类输入
  - 机制（读断言体，`p17b_diagnosis_report.rs:1739-1763`）：
    - `:1742` `if !(is_camel || is_snake) { continue; }`——**候选筛选**只看「同时含大小写」或「含 `_`」。
      全小写无下划线的标识符（`location` / `team` / `player` / `nodes` / `restartwindow`）
      **连 `checked` 都不进**，直接跳过 ⇒ 永不判红。
    - `:1749-1750` `keys.contains(head) || keys.contains(tail)`——点号路径只核**两段**，
      故 `chain.fake_field`（真键 head + 假尾）与 `fakename.team`（假 head + 真键尾）**全放行**。
      旧守卫只取 `rsplit('.').next()`（尾段）比 `SOURCE_SIDE_OK`，故这两种都被判红。
    - 更底层：`keys` 集仍是 `:1669-1678` 的**裸引号扫描**（201 个 token，含 33 个非真键），
      产品**取值**（`kickoff`/`passC`/`restart_control`…）**仍在键集里** ⇒ 档①
      `keys.contains(t)` 对「值当字段」原样放行。轮 3 报告 `:646-651` 明确指出这是 M-NOTE-VALUE 的根因，
      本轮**没有把 `keys` 改成 JSON 解析**，只加了档③的形态闸（而档③经 ABL-1 证明不承重、被档①短路）。
  - **最讽刺的一点**：`location`（全小写、无前缀）正是这条守卫的**动机字段**——`A8` 的 note 原先就写
    「位置须读 `ControlFact.location`」，后面还专门用 `Event.x,y` 顶替的反而被拦。
    **恰好因为旧写法带点号路径、作者把它写进了 `SOURCE_SIDE_OK`，才没有暴露**。
    换言之：新守卫把「能抓到目标」缩到「只抓 CamelCase / snake_case」，而它唯一想抓的那个字段名
    **不在这个形态里**。
  - 这也解释了轮 3 的 `M-NOTE-VALUE` 为何「修了却还是绿」：`kickoff` 的形态闸是 `is_enum_token`+`json`，
    但 `keys.contains("kickoff")` 先命中（裸扫描键集含值）⇒ `as_value` 的收紧**被档①短路，形同虚设**。
  - 影响面：**测试层**（守卫的判别力），不进产物、不改变任何已发布结论。
    但本 change 的立身之本就是「守卫不得空转/不得假覆盖」，故按 P1 记。

- **[P2] `close_down` 归因的第四处拷贝仍在**（`.scratch/notes/17b-recon-2026-09-30.md:180-183`）
  - 原文仍写：「实测 **188/513（8 seed）** 的 `close_down` 终点距球 > 5.25 m ⇒ 它们在**追人**」——
    这正是轮 2 推翻的**数值 + 因果**两层错误，且**零注记**。
  - 与 N-1 的第三处（入口测试 doc）**同族**：作者本轮修了轮 3 点名的 `design.md`/`tasks.md`，
    **漏了同样被点名的 recon note**（轮 3 报告 `:635` 明列此文件）。
  - 为何值得记为 P2 而非 MINOR：该 note 被 `proposal.md:45`/`spec.md:22`/`tasks.md:9`/`.scratch/map.md:176`
    当**证据来源**引用；下一个读者照它引，就会把已推翻的归因再抄一遍——这正是本仓
    `[[conclusion-right-mechanism-wrong]]` 的主角。影响面仍在文档层，不阻断产物。
  - 修法（低成本）：在其后加与 `design.md:238-250` 同款的「实现期更正」引注即可（**不必**篡改正文）。

- **[MINOR] 入口测试 doc 有一处**轻微误述**：`p17b_diagnosis_report.rs:621` 写「本 change 曾在**三处**那么写」，
  但 `design.md:248` 与 `tasks.md` 的注记说「实现侧**三处**引用已收回」。实际「距球远⇒追人」的拷贝至少
  **五处**（入口测试 / `evidence.rs` / `reasons.rs` / `design.md` / `tasks.md`），再加未收的 recon note 共六处。
  数字不一致不影响结论（都在讲「曾在多处」），但下次读者数数对不上会再生疑。属 MINOR。

#### 未覆盖/存疑

- **`checked` 计数与注释一致**：实测 `checked = 19`，注释声称「当前十行 note 上有 19 个候选标识符」——**吻合**；
  下限 `> 12` 未空转，且**十条真 note 全过**（无误伤）。这部分单独看是好的。
- **两档放行（档③ `as_value` / 档④ `PROSE_OK`）在当前 notes 上不承重**（ABL-1/ABL-2）：
  去掉它们默认套件仍绿。不是缺陷（未来 note 可能需要），但说明**当前四档里只有两档在实际起作用**。
- **新守卫对「同族新字段名」的判别**：我只测了有限形态。**未穷举**的是——
  若作者未来写 `ChainNode`（CamelCase、不在产物、不在源侧），新守卫**会**判红（属其设计面）；
  但写 `location2` / `chain_nodes` 这类**形态不匹配**的名字仍会逃逸。同 P1 的根因。
- **产物语义层的「好坏标签」**：同前几轮，只做字符串禁串表 + 人工抽查，未做系统性语义判定。
- **`EXC_CLASS_CAP = 200` / 产物是否该渲染 `contest_window`**：同前几轮，未变。

#### 不可越界核实

1. **零 `engine/src/` 改动**：`git diff main --stat -- engine/src` → **空**。✅
   （复核了 doc 引用的 `CLOSE_DOWN_STOP_DIST`、`compute_mover_candidates`、`attacking_forward` 是**既有**源码，
   不是本 change 新增。）
2. **不报相位**：自写**块注释 + 行注释双剥**扫描器（`re.sub(r'/\*.*?\*/', '')` 去块注释，再逐行截 `//`）
   扫 `tests/p17b/{evidence,episode,reasons,report}.rs` 的**非注释**行 ——
   `build_up`/`progression`/`final_third`/`attacking_transition`/`Phase` **零命中**。
   **扫描器有判别力**：正控（注入 `pub const PHASE_PROBE = "build_up"` + `/* final_third */` + `// progression`）
   只抓出代码里的 `build_up`、正确忽略两条注释；负控（只放注释）判 clean。✅
3. **不产生 pass/fail 或好坏标签**：扫重跑产物（`/tmp/p17b-r4/*.json` + `*.md`）——
   `PASS`/`FAIL`/`通过率`/`合格`/`passed`/`failed` 全 **0**；`通过` 仅 1 处（元陈述「它不给出通过/失败判定」）、
   `失败` 仅 3 处（元陈述 + 赛事事实「失败传球不造成失球」）、`坏` 仅 1 处（技术词「不变量被破坏」）。✅
4. **产物与源码同源**：磁盘件与 `/tmp/p17b-r4` 重跑件**只差 `source_commit` 一栏**（其余逐字节一致）；
   `test_source_fingerprint` 磁盘件 = `fnv1a64:c23f8be58685ef07`，**与我从 HEAD 源码独立计算的指纹逐位吻合**。
   （我第一轮重跑曾得到 `7fa23bbc…`，但那是我并发跑变异探针污染了 `tests/p17b/reasons.rs` 所致——
   干净前台重跑即回到 `c23f8be5`；**这正是 `test_source_fingerprint` 该有的行为**，非缺陷。）
5. **`source_commit` 栏**：磁盘件记的是生成时的 HEAD（`dc15f12`），比 HEAD 差一笔；
   该栏已在产物层显式注明「跑门时记的 HEAD；判陈旧请看下面两条指纹」，指纹一致 ⇒ **非缺陷**。✅

#### 判定

**需修改**。N-1 / N-2 / N-4 三条**确实修好**（入口测试 doc 与 `design.md`/`tasks.md` 的更正真实、措辞与
源码事实一致、冻结设计的原句未被改坏、表头两条测试名都真存在）。
但 **N-3 的修复引入了本轮唯一的 P1**：新守卫为堵三处窄逃逸而「收窄候选 + 加 head/tail 段」，
**净判别力比旧守卫更弱**——旧守卫判红的 `location`（守卫自己的动机字段）、`restartwindow`、
`chain.fake_field`/`fakename.team` 三类**新守卫全部放行**，且轮 3 明确点名、提交信息声称已堵的
`kickoff` 逃逸**原样存活**（`keys` 裸扫描仍把产品值当键）。按判定标准「N-1..N-4 全部确实修掉 **且**
无新 P0/P1 ⇒ 通过」，此处**不满足**：既有 N-1 的第四处（recon note，P2）未收回，
又有守卫判别力回退（P1）。

**建议的最小修法**（不要求重做）：
1. 把 `keys` 集从**裸引号扫描**改为**真键解析**（按 `"key":` 形态），并让档③只比对**值**——
   这是轮 3 已给出的方案，能一次消掉 `kickoff`/`passC`/`restart_control` 一整类逃逸；
2. 候选筛选**不要 `continue` 跳过**，而是「形态像标识符就纳入 `checked`」，
   全小写无下划线的 token 只要**不是产物键也不是源侧清单**也判红（或至少对「点号路径」两端都核）；
3. 给 `recon note:180-183` 补「实现期更正」引注（照 `design.md:238-250` 的形状）。

### 轮次 5 — 需修改（独立审阅 agent · Claude / paseo worktree `1g1x3st4` · 2026-09-30）

**审阅对象**：`929f8a6bb5c605207b1abffa03f5438cfbbd04b3`（我 `git rev-parse HEAD` 自核）。
默认套件实跑：`33 passed; 0 failed; 2 ignored`。产物在 `/tmp/p17b-r5` **前台重跑**（无并发探针），
磁盘件只读比对。每条变异都在 `git status` 干净 → 注入 → `git checkout --`（或 `git checkout HEAD -- <doc>`）
→ `git status` 确认 pristine 的循环里跑；每条判红都亲眼见到**目标测试名 + `panicked at`**（排除编译失败）。

**结论提前说**：轮 4 的 **P1（守卫判别力回退）确实修好了**——我独立重放轮 4 表里全部逃逸，
`location` / `restartwindow` / `chain.fake_field` / `fakename.team` / `event_indexes.nope` / 裸 `RestartWindow`
**逐个判红**，且 `keys` 换成真键解析（与真 JSON 解析器**逐键吻合**）。但本轮**新增的 P2 守卫**
（`retracted_close_down_attribution_is_always_annotated`）**抓不住它为之而生的那段原文**——
我把侦察 note `git checkout dc15f12` 还原成修复前文本，守卫**判绿**。故判**需修改**。

#### A. P1 修复的证明（`anomaly_coverage_notes_only_cite_fields_the_product_carries`）

**先核两条机制事实（不是读注释，是实测）**：

1. **候选不收形态筛选**：`identifier_words`（`:2086`）对 note 全文按 `[A-Za-z_][A-Za-z0-9_.]*` 扫，
   只留「≥3 个字母」的词，**不分大小写形态**。读断言体确认（`continue` 只剩「不是标识符首字符」一条，
   无 CamelCase/snake_case 分支）。
2. **键集是真键解析**：我把产物 JSON 落盘（`/tmp/r5_report.json`，3.09 MB），用 Python 的 `json` 模块
   抽真键，再用 Rust `json_object_keys` 同款算法重放：**真键 172 / 扫描 172 / EXTRA 0 / MISSING 0**。
   ⇒「只抽 `"k":` 形态、键值分离」**真的成立**（轮 4 的根因③已消）。`kickoff`/`passC`/`pass+` 这些**取值**
   **不在键集里**了。
   实测防假绿阈值：`json_keys.len() = 172 > 50`、`checked = 32 > 30`（下方「存疑」记了余量问题）。

**逃逸尝试表**（变异注入点 = `reasons.rs` A7 note；每条自核 pristine；RED = 目标测试名 + `panicked at`）：

| 输入（注入 A7 note 的片段） | 依据 | 预期 | 实际 | 结论 |
|---|---|---|---|---|
| `` `location` ``（轮 4 表 / **守卫自己的动机字段**） | 全小写无下划线 | 判红 | **RED** | ✅ 回退已修 |
| `` `restartwindow` ``（轮 4 表） | 全小写 | 判红 | **RED** | ✅ |
| `` `chain.fake_field` ``（轮 4 表；真 head + 假尾） | 点号路径 | 判红 | **RED** | ✅ head/tail 豁免已消 |
| `` `restart_window` `` / `` `next_episode` `` / `` `card_index` `` | 不存在的 snake 字段 | 判红 | **RED** | ✅ |
| `` `position` `` / `` `ball_x` `` / `` `formation` `` / `` `zone` `` / `` `half` `` / `` `attack_dir` `` | 该产物**确实没有**的字段 | 判红 | **RED** | ✅ 非空转 |
| 裸 `RestartWindow` / 裸 `LooseRun`（无引号） | 类型名 | 判红 | **RED** | ✅（且已从白名单删除） |
| `` `fakename.team` ``（假 head + **真键**尾） | 点号路径反向 | 判红 | **RED** | ✅ 轮 4 的 M4-H 已修 |
| `` `event_indexes.nope` `` / `` `a.b.c` `` / `` `chain.fake_field.` `` / `` `.chain.fake` `` / `` `ControlFact.location.nope` `` | 点号路径变体（尾部点 / 前导点 / 双点 / 加长） | 判红 | **RED** | ✅ 无点号捷径 |
| `须读location字段`（**无引号 + 中文夹持**） | 轮 3 的「裸词」坑 | 判红 | **RED** | ✅ |
| `<!-- location -->` / `` `location`<!--注释--> `` | HTML 注释伪装 | 判红 | **RED** | ✅ |
| `` `A11` ``（不存在的规则号） | 短 + 非白名单 | 判红 | **RED** | ✅ |
| `` `nodes2` `` / `` `location2` `` / `` `ab_cd` `` | 形态不匹配的伪造名 | 判红 | **RED** | ✅ 轮 4「形态不匹配会逃逸」的担忧**不成立** |

**⇒ 轮 4 的 P1 证伪：判别力回退已消除**。新守卫在**我被测到的每一个输入**上都不弱于旧守卫。

#### A′. P1 守卫**残留的三条豁免**（诚实地列出来；两条是承袭、一条是新形态）

| 输入 | 预期 | 实际 | 判读 |
|---|---|---|---|
| `` `kickoff` 字段 `` / `` `restart_control` 字段 `` / `` `all_canary` 字段 `` | 判红 | **GREEN** | ❌ **显式白名单成了逃逸口**：`PROSE_OK` 收了**取值**（`kickoff`/`restart_control`/`all_canary`…），note 把它们**当字段名**引用照样过。这就是轮 3 `M-NOTE-VALUE` 的形态，**从「碰巧」变成了「成文」**。承袭（旧守卫同样放行），非回归。 |
| `` `zz` `` / `` `tt` `` / `` `qb` `` / `` `x9` `` / `` `ab` ``（≤2 字母伪字段） | 判红 | **GREEN** | ❌ `identifier_words` 的「≥3 字母」下限把 2 字母标识符整个跳过——**与轮 4 P1 同族的「筛选=豁免」**，只是窄得多。现实字段名 ≥3 字母，风险低。 |
| `` `读ControlFact.location` ``（中文+反引号夹持） | — | **GREEN** | ✅ **非逃逸**：`ControlFact.location` 精确命中 `SOURCE_SIDE_OK`，是**设计内的放行**。 |

> 白名单是**精确匹配**（`contains(&t.as_str())`），**不是**前缀/包含匹配——故不存在「前缀相同即放行」的漏洞；
> 但它也意味着**值 token 一旦进白名单就永久开着一扇门**（上表第一行）。

#### B. P2 修复的证明 / **证伪**

**正向（该判红的判红）**：往四处各塞一条**无注记**的旧结论，结果：

| 注入点 | 注入内容 | 结果 |
|---|---|---|
| `.scratch/notes/17b-recon-2026-09-30.md`（append） | `实测 188/513 … ⇒ 它们在追人。` | **RED** |
| `engine/tests/p17b/evidence.rs`（append） | 同上（168/513） | **RED** |
| `design.md`（append） | 同上（188/513、37%） | **RED** |
| `tasks.md`（append） | `37% 在追人（188/513）` | **RED** |
| `p17b_diagnosis_report.rs`（**守卫自己**，unannotated，远离标记词） | 同上 | **RED**（自指正确） |

**反向（不该判红的不判红）**：注记放**同一行** / **下一行** / **下两行** → **全 GREEN**（无误伤）。
我另逐行核了当前仓库里**全部 7 条命中该判据的行**（`design.md:239`、`tasks.md:29`、`recon:185`、`recon:188`、
`evidence.rs:440`、入口测试 `:1770`/`:1815`）——**全部 annotated=True**。⇒ 本轮作者的**注记本身**是真的。

**窗口边界**（任务点名要核）：实测窗口是 **`i−2 .. i+2`（±2 行）**——注记在 **delta +2 → GREEN**，
**delta +3 → RED**。即「放在四行之外」**会判红**（这符合设计：注记不该漂太远，**可接受**）。

**❌ 证伪：守卫抓不住它为之而生的那段原文。** 我把三个文档用 `git checkout dc15f12 -- <file>` 还原成**修复前**状态：

| 还原的文件 | 守卫 | 为什么 |
|---|---|---|
| `design.md`（原文：分数与结论在**同一行**） | **RED** ✅ | 命中 |
| `.scratch/notes/…recon…md`（原文：`188/513` 与 `⇒ 它们在**追人**` **折行分处两行**） | **GREEN** ❌ | **判据要求分数与判定语在**同一行**（`line.contains("188/513") && line.contains("追人")`），折行即两者不相遇 |
| `tasks.md`（原文：`37% 在追人`，**根本没有分数**） | **GREEN** ❌ | 同上 |

⇒ **四处里只有一处（`design.md`）能被它抓**。作者在提交信息里写的「实测：往侦察 note 或 `evidence.rs`
塞一条无注记的旧结论 ⇒ 判红」**属实**——但那是用**我这种单行插入**测的；**真正的原文**（中文散文会折行）
**不触发**。守卫被**校准到了修复后的单行改写形**，而不是**错误本身**。
这正撞上本 change 反复记的 `[[conclusion-right-mechanism-wrong]]` / `[[false-coverage-handoff-claims]]`。

**公开「绕法」**（任一条都能让被推翻的归因重新进来而不判红）：
1. 把分数与 `追人` **分写两行**（中文散文最常见）；
2. 只写 `37% 在追人`（**不写分数**）——`37%` 单独**不在**判据的「数字」分支里；
3. 把注记放在 claim 的 **±3 行之外**。

**连带两处文档/代码不一致**（同一处判据）：
- 断言体上方的 doc 写「若出现被推翻的**证据数字**（`188/513`/`168/513`）**或**断言句（`⇒ …追人`）」
  ——用了 **「或」**；**代码实现的是「且」**（同一行同时含分数与判定语）。文档**高估**了判据。
- doc 写「**必须同段**出现更正标记」、assert 文案写「**相邻三行**」；实现是 **±2 行**。三种说法不一致。

#### C. 新发现

- **[P1] 新 P2 守卫 `retracted_close_down_attribution_is_always_annotated` 对**其目标文本**无判别力**
  ——证据即上表：`recon note` / `tasks.md` 的**修复前原文**判 **GREEN**。这不是「窗口太窄」（±2 行够用），
  而是**判据的合取条件要求两半落在同一行**，而真实中文文档会折行。按任务判定标准
  （「P1、P2 确实修掉 **且** 无新 P0/P1 ⇒ 通过」），这条**新守卫的判别力**构成 **P1**。
  **修法**（低成本，二者取一即可）：
  (a) 先把窗口内的**行拼成一段**再判（`window.contains("188/513") && window.contains("追人")`），
      保留 ±2 行窗口；或
  (b) 把 `37%` 也当「数字」分支的一部分、并允许**跨行**合取。
  同时把 doc 的「**或**」改成「**且（同段内）**」，与实现对齐。

- **[P2] `PRODUCT_KEYS` 是**悬空标识符**（新造，与 `[[conclusion-right-mechanism-wrong]]` 同族）
  ——`p17b_diagnosis_report.rs:1703` 的 doc 写「白名单分三张…`PRODUCT_KEYS`（…**从 JSON 里自动抽**）」，
  但 `grep -rn "PRODUCT_KEYS"` **只有这一处**（注释自身）——**没有这个常量**；真绑定是 **`json_keys`**
  （`let json_keys = json_object_keys(&json)`）。且它与另两张**由人手写**的白名单**性质不同**（自动抽），
  把它们并列成「三张，都由人明确写下」措辞亦不符。进产物无影响，但会误导下一个读者去找一个不存在的表。属测试层 MINOR，建议改名对齐。

- **[P2] `PROSE_OK` 收**取值** ⇒ 「值冒充字段」永久放行**（见 A′ 表第一行）。承袭自轮 3/4，
  但本轮把它**写死进白名单**，等于把一处「可绕」升格为「成文允许」。建议：把 `PROSE_OK` 拆成
  「散文词」与「取值枚举」两张，用**独立分支**核取值（例如「note 提到某取值时，只有当它**不以字段名身份**
  出现」——至少给一条**反证条**：喂 `「本层给 `kickoff` **字段**」` 必须判红，否则这扇门就是敞的）。

- **[MINOR] 防空转下限余量偏薄**：`checked = 32`，下限 `> 30`——**只差 2**。逐条 note 的候选数实测为
  `A1=3, A2=8, A3=3, A4=4, A5=1, A6=4, A7=0, A8=4, A9=2, A10=3`。**A7 的 note 现在是 0 个候选**
  （它已被改写为纯中文说明，`identifier_words` 一个词都抽不到）。再有一条 note 被改写成纯中文、
  总候选数掉到 30 以下，本守卫会**假红**（而不是假绿）——方向安全，但下一个编辑者会撞到它。
  建议把下限写成一个**与 note 体量挂钩**的判据，或在注释里写明「加/删 note 要同步核这个数」。

- **[MINOR] `.scratch` 侦察 note 缺席时**静默跳过**：`read_to_string(...).unwrap_or_default()` ⇒
  文件若被删/改名，`recon` 为空、该源**被静默移出扫描面**（其余 5 源仍提供 `hits>0`，故守卫**仍绿**）。
  与「扫描面塌成空」是同一族。建议：缺席时**断言失败**（这份 note 是**被 `proposal`/`spec`/`tasks`/`map`
  引为设计依据**的，缺席本身就该红）。

#### 未覆盖/存疑

- **`json_object_keys` 的转义脆弱性**（潜在，**当前不触发**）：它不做 JSON 转义处理。我用合成 JSON 测：
  值里含转义引号（`{"n": "a\"b", "z": 3}`）时扫描器**漏掉真键 `z`**（1/2）。**当前产物无此形态**
  （172/172 精确吻合），故现在无影响；一旦某字段的**值**里出现 `\"`（如把用户文本塞进 JSON），
  会**漏键** ⇒ 对合法 note **假红**（方向安全）。属观察项。
- **`checked` 的「≥3 字母」下限**：我没穷举**全部** 2 字母伪字段，只测了 `zz/tt/qb/x9/ab`（均 GREEN）。
- **产物语义层的「好坏标签」**：同前几轮，只做字符串禁串表 + 人工抽查，**未**做系统性语义判定。
- **`EXC_CLASS_CAP = 200` / 产物是否该渲染 `contest_window`**：同前几轮，未变。
- **`ANOMALY_COVERAGE` 之外的 note**（如 `CONTEST_COVERAGE.mechanism`、`WORDING_RULES.why`）
  **不受**本守卫约束——我只核了它**设计覆盖**的那一列。

#### 不可越界核实

1. **零 `engine/src/` 改动**：`git diff main --stat -- engine/src` → **空**。✅
2. **不报相位**：自写**块注释 + 行注释双剥**扫描器（`re.sub(r'/\*.*?\*/')` 再逐行截 `//`）扫
   `tests/p17b/{evidence,episode,reasons,report}.rs` 的**非注释**行 →
   `build_up`/`progression`/`final_third`/`attacking_transition`/`Phase` **零命中**。
   **正控**（代码里放 `pub const PHASE_PROBE = "build_up";` + 两条注释）只抓出代码里的 `build_up`、
   正确忽略注释 ⇒ 扫描器**有判别力**。✅
3. **不产生 pass/fail 或好坏标签**：扫 `/tmp/p17b-r5/*.json` + `*.md`——
   `PASS`/`FAIL`/`通过率`/`合格`/`passed`/`failed` 全 **0**；`通过` 仅 1 处（元陈述「它不给出通过/失败判定」）、
   `失败` 4 处（元陈述 + 赛事事实「失败传球不造成失球」）、`坏` 2 处（技术词「不变量被破坏」）。✅
4. **产物与源码同源**：磁盘件（`engine/target/p17b-diagnosis/*`）与 `/tmp/p17b-r5/*` 重跑件
   **只差 `source_commit` 一栏**（`4dad5a4…` → `929f8a6…`，JSON 与 MD 各 2 行），其余**逐字节一致**；
   默认套件里的 `on_disk_artifacts_share_the_current_source_fingerprints` 亦**通过**。✅

#### 判定

**需修改**。轮 4 的 **P1（守卫判别力回退）确实修好**——我独立重放全部逃逸，`location` 等逐个判红，
键集换成真键解析（与真 JSON 解析器 172/172 吻合），无误伤；轮 4 的 **P2 文本**（四处归因注记）也确实补齐。
但 **`929f8a6` 新增的 P2 守卫 `retracted_close_down_attribution_is_always_annotated` 抓不住它为之而生的那段原文**
——把 `recon note` / `tasks.md` `git checkout dc15f12` 还原成修复前文本，守卫**判绿**（只有 `design.md` 会红）。
它被校准到了**修复后的单行改写形**，而不是**错误本身**；且其 doc 用「**或**」、实现是「**且**」（同一行合取），
三种「窗口」说法（同段 / 相邻三行 / ±2 行）互不一致。按判定标准（P1、P2 确实修掉 **且** 无新 P0/P1 ⇒ 通过），
这条**新守卫的可绕性**构成 **P1** ⇒ 不满足。

**建议的最小修法**（不要求重做）：
1. P2 守卫的判据改为**在 ±2 行窗口内**分别核「分数」与「判定语」（跨行合取），并把 doc 的「或」改成「且（同段内）」；
   另把 `37%` 计入「数字」分支（`tasks.md` 原文形态）；
2. `PROSE_OK` 拆出「取值枚举」，给一条**反证条**（`「本层给 `kickoff` **字段**」` 必须判红），
   否则「值冒充字段」这扇门是敞的；
3. doc 里的悬空 `PRODUCT_KEYS` 改名为 `json_keys`（或补上真常量）；
4. `.scratch` 侦察 note 缺席时**断言失败**（而非 `unwrap_or_default()` 静默跳过）。

### 轮次 6 — 需修改（独立审阅 agent · Claude / paseo worktree `1g1x3st4` · 2026-09-30）

**审阅对象**：`58aeccb986343dd7743ec3b2876b9534d3e8a837`（我 `git rev-parse HEAD` 自核）。
默认套件实跑：`33 passed; 0 failed; 2 ignored`。产物门（`--ignored`）实跑：**2 passed / 0 failed**，
落 `/tmp/p17b-r6`。所有变异都在「`git status` 干净 → 注入 → 跑 → `git checkout HEAD -- <file>` →
`git status` 证明 pristine」的循环里跑，每步之后都核过 pristine。每条判红都亲眼见到**目标测试名 + `panicked at`**。

**结论提前说**：作者声称的三条**在字面上都成立**——我独立把三份文档从 `dc15f12` 还原成修复前文本，
`design.md` / `tasks.md` / 侦察 note **现在都判红**（轮 5 证明漏掉的那两份也红了）。P2-2 的悬空标识符确实消失。
P2-3 的「逐词断言真在产物里」确实会红。**但**：段块判据在**两个方向**都引入新错——
既**放走了它为之而生的错误形**（`evidence.rs` 的 235 行巨块把一条无注记的旧结论自动「注记」掉，**旧守卫在同处判红**），
又**误红了合法文本**（纪律句 / 被空行并成一块的两句无关话）。且 P2-3 的断言**并不能**区分「键」与「取值」，
把取值当字段在 `VALUE_OK` 命中的那些词上**仍然成文放行**。故判**需修改**。

#### A. P2-1 的证明/证伪（核心）

**先证作者的主张（独立还原测试，每条之后 `git checkout HEAD -- <file>` + `git status` pristine）**：

| 还原的文件（`git checkout dc15f12 -- <file>`→实为 `git show dc15f12:<f> > <f>`） | 修复前文本形态 | 新守卫 | 目标测试名 + `panicked at` |
|---|---|---|---|
| `design.md`（分数与结论同段） | `实测…188/513（37%）…> 5.25 m`（折行） | **RED** ✅ | 见 `:1870` |
| `tasks.md`（原文**无分数**，只有 `37% 在追人`） | `（37% 在追人）` | **RED** ✅ | `第 24 行` |
| `.scratch/notes/17b-recon-….md`（分数与 `⇒…追人` 折行分两行） | `188/513（8 seed）`\n`… > 5.25 m ⇒ 它们在**追人**` | **RED** ✅ | `第 173 行` |

⇒ **作者「三份文档现在都判红」的主张属实**，含轮 5 证明漏掉的那两份。**折行**这一形态确实被堵了。

**但——绕法尝试表**（注入点：运行时读取的侦察 note 为主要注入点，无需重编译；每条自核 pristine）：

| # | 绕法 | 预期 | 实际 | 判读 |
|---|---|---|---|---|
| E1 | 距离证据与「追人」之间**隔一个空行** | 判红 | **green** | ❌ **绕**：空行把它们切成两块，各自都不命中（段块切分的反面） |
| E2 | 只写推论、不写距离（`⇒ 它们在**追人**`） | 判红 | **green** | ❌ 绕（无距离证据则整条判据不触发——设计如此，但意味着「只留推论」是自由通道） |
| E3 | 距离写成 `5.3 m` | 判红 | **green** | ❌ **绕**：`DISTANCE_EVIDENCE` 是**4 个字面量**的闭集，换一种写法就漏 |
| E4 | 距离写成 `逾五米` | 判红 | **green** | ❌ 绕（中文数字） |
| E5 | 距离写成 `>5m` / `525 cm` | 判红 | **green** | ❌ 绕（单位/符号变体） |
| E6 | 更正标记 `单位` 出现在**无关**位置（`（本节距离的单位为米）`） | 判红 | **green** | ❌ **绕**：只查标记词是否出现，不查它是否在**修那处结论** |
| E15 | 标记词被用来**反向**否认更正（`所谓「打不到靶点」的说法**不成立**`） | 判红 | **green** | ❌ **绕**：语义相反也算「已注记」——即任务点名的那个反向形态 |
| E17 | `至于「追人」——不存在这回事`（在引入**新的**错误陈述） | 判红 | **RED** | ✅（本例无标记词故红；但见 E15 的语义反向） |
| **E10** | 把一条无注记的旧结论**插进 `evidence.rs` 的 `EVIDENCE_TABLE` 巨块内**（距最近的标记词约 150 行） | 判红 | **green** | ❌ **回归（见下）** |
| **E12** | 把 `bdd1e65` 的**原始错误行**逐字还原（`168/513…> 5.25 m ⇒ 它们在追人` + 同行「单位混用」） | 判红 | **green** | ❌ 两版守卫**都**漏（`单位混用` 是标记词，且距 claim ≤2 行）——非本轮引入，但说明「标记词共现」这个判据家族本就抓不住它 |
| **E8（反向）** | 合法的**纪律句**：`…> 5.25 m **不得**据此称其在**追人**` | 不误红 | **RED** | ❌ **误红**（旧守卫此处 **green**——`5.25` 是**本轮新加**进 `DISTANCE_EVIDENCE` 的，正是它把误红引进来） |
| **E13（反向）** | 两句**无关**的话被「没有空行」并成一块（`close_down_stop 上限 2 m，与 5.25 m 无关。` + `真正的「追人」只在 SaveCaught 分流上`） | 不误红 | **RED** | ❌ **误红**（旧守卫 green） |
| E16（反向） | 真正的收回但用**同义词**（`该归因已作废`，不在标记表里） | — | **RED** | ⚠️ 两版都红（标记表是闭集，合法收回用别的词就误红） |
| E9（反向） | 合法 note：距离 + 追人 + `推翻` | 不误红 | **green** | ✅ 正确 |

**数量级检查**：`incidents` 实测 **6**（我插桩打印：`R6 incidents=6`）。防空转断言 `incidents > 0` **太弱**——
只要有一处（哪怕就在守卫自己的 doc 里）就满足。另：`design.md` **当前贡献 0 处命中**，
因为它的「追人」行（`:236`）与「已被推翻」块（`:239+`）之间**正好有一个空行**（`:237`）——
当前绿是**巧合**，不是「距离与推论同块」这条判据在它身上生效。`design.md` 的修复前文本能红，
靠的是修复前那一版**恰好没空行**。

**回归的严格证明（E10）**：`evidence.rs` 里 `EVIDENCE_TABLE`（`:274–508`，**235 行无空行**）是**一个块**。
我离线重放**旧守卫**（单行合取 ±2 行）在同一插入处 → **RED**；新守卫 → **green**。
即：**对这处最原始的错源之一（`evidence.rs` 正是四份拷贝中的一份），新守卫比它替换掉的旧守卫更弱。**
这正是本 change 反复记的形态（守卫被校准到修复形），只是这次方向反了：**不是漏了原文，是为了覆盖折行而把粒度放大到段落，反而吞掉了它本该抓的近邻情形。**

#### B. P2-2 / P2-3 的证明/证伪

**P2-2（悬空标识符）**：`PRODUCT_KEYS` 全仓**已无**（只剩 `REVIEW.md` 里轮 5 的历史记录）；
doc 现引用 `json_keys`（6 处）与 `json_object_keys`（3 处），**都是真存在的**。
⇒ 悬空标识符本身**已消** ✅。**但**改写后的 doc 文本**自身又错了**（同族）：
- `:1702` 写「白名单分**三张**，都由人**明确写下**」，紧接着列了 **四个** bullet
  （`json_keys` / `SOURCE_SIDE_OK` / `PROSE_OK` / `VALUE_OK`）——**数对不上**；
- 且 `json_keys` 被同一段明说「由 `json_object_keys` **从 JSON 里自动抽**……**不需人工维护**」，
  与「**都由人明确写下**」**直接矛盾**。
⇒ 把一处 doc/code 不符，换成了**两处**新的 doc 自相矛盾。

**P2-3（取值当字段的后门）**：
- ✅ **正向**：`VALUE_OK` 加一个**不在产物里**的词（`zzz_absent_value`）→ **RED**（`:1751`，目标测试名 + `panicked at`）。
  「名不副实的条目当场红」这句**属实**。`kickoff` 当字段（不在 `VALUE_OK`）→ **RED**（`未白名单化…A1 → \`kickoff\``）。
- ❌ **断言并不能区分「键」与「取值」**（doc 声称这一档 = 「产物里会出现的**取值**」）：
  断言体是 `json.contains(&format!("\"{v}\""))`——**键**和**值**都满足。
  实测：把 `duration_s`（一个**键**）加进 `VALUE_OK` → **green**（断言过）。
  ⇒ 只要一个 token **在 JSON 里以任何身份出现过**，就能被塞进 `VALUE_OK` 而断言不响，**门仍敞**。
- ❌ **轮 5 点名的后门只关了一半**：把**在 `VALUE_OK` 里**的取值**当字段**引用 → **仍 green**。
  实测（把 `本层给 \`X\` 字段` 注入 A1 note）：`restart_control` → **green**；`empty_possession` → **green**；
  `kickoff`（**不在** `VALUE_OK`）→ RED。⇒ 后门从「所有取值」缩到「`VALUE_OK` 命中的那 7 个」，**没有关闭**。
- ❌ doc 数不符：`:1737` 写「得到的正是下面这 **9** 个」，代码里 **7** 个。

#### C. 新发现

- **[P1] `evidence.rs` 巨块回归（E10）**：段块 = 空行切分，而 Rust 源码注释与 `EVIDENCE_TABLE` 字面量
  **内部无空行**。实测块大小：`evidence.rs` 最大块 **235 行**、`report.rs` 最大块 **147 行**、`reasons.rs` **83 行**。
  在这些块内插入无注记旧结论 → 被块内**任意**位置的标记词「注记」掉。
  **旧守卫在同处 RED**。这是「修复形 → 更弱守卫」的又一次，只是方向是「粒度放太粗」。
- **[P1] 新误红面（E8/E13）**：`5.25` 被加进 `DISTANCE_EVIDENCE`（为覆盖 `tasks.md` 原文的 37% 形态而扩的集），
  于是**任何**同时提到 `5.25` 与「追人」的块都成命中——包括**纪律句**（`不得据此称其在追人`，E8）
  与**被空行漏并的两句无关话**（E13）。二者旧守卫都是 green。**判据没有「这是在断言、还是在禁止」的方向感。**
- **[P2] 标记词无语义（E6/E15）**：标记表是 7 个字面量的闭集，**只查出现、不查它在修哪句**。
  `单位` 可被无关的「单位是米」点亮（E6）；`不成立` 可被用来**反向**否认更正（E15）。
- **[MINOR] 承袭未修**：轮 5 MINOR#4（`.scratch` 侦察 note **缺席时静默跳过**，`:1825` 仍 `unwrap_or_default()` +
  `:1834` `if !recon.is_empty()`）**未修**。该 note 是设计依据，缺席本身该红，现在会让该源静默移出扫描面。
- **[MINOR] `identifier_words` 补 `+`/`?`**：我实测无**误伤**（`pass+`/`pass?`/`passI` 正确整体抽出；
  `x+`/`y?` 因 <3 字母被正确跳过）。但该函数**只裁句末 `.`**：`pass+` 之后紧跟句号（`pass+.`）仍整体保留，
  故 `pass+` 后的中文句读不会被吞进 token——**当前无问题**。观察项：字符集一旦再加符号（如 `-`/`/`）会开始吞正常标点。

#### 不可越界核实（独立核实）

1. **零 `engine/src/` 改动**：`git diff main --stat -- engine/src` → **空**。✅
2. **不报相位**：自写**块注释（`re.sub(r'/\*.*?\*/')`）+ 行注释（逐行截 `//`）双剥**扫描器，
   扫 `tests/p17b/{evidence,episode,reasons,report}.rs` 的**非注释**行 →
   `build_up`/`progression`/`final_third`/`attacking_transition`/`Phase` **四个文件全 0 命中**。✅
3. **不产生 pass/fail 或好坏标签**：大小写敏感扫 `engine/target/p17b-diagnosis/*.{json,md}` →
   `PASS`/`FAIL`/`通过率`/`合格`/`passed`/`failed` 全 **0**（小写 `pass` 是域 token `/pass`、`pass+`、`pass_lost`，
   非判据）。`通过`=0、`失败`=1（赛事事实「失败传球不造成失球」）、`坏`=1（技术词「不变量被破坏」）。✅
4. **产物与源码同源**：磁盘件与 `/tmp/p17b-r6` 重跑件**只差 `source_commit` 一栏**（JSON/MD 各 2 行），
   其余**逐字节一致**；两件 `test_source_fingerprint` / `engine_source_fingerprint` **相同**。✅
   （磁盘件记 `929f8a6`、重跑件记 `58aeccb`——这只是跑门时 HEAD 尚未提交，指纹守卫按设计只判 `!=unknown`，
   注释已说明「`== HEAD` 断言会自失效」，**非缺陷**。）

#### 默认套件与产物门

- `cargo test --test p17b_diagnosis_report`：**33 passed / 0 failed / 2 ignored** ✅
- `P17B_OUT_DIR=/tmp/p17b-r6 P17B_SOURCE_COMMIT=$(git rev-parse HEAD) cargo test --release -- --ignored`：**2 passed / 0 failed** ✅
- 插桩实测：`checked = 32 > 25`（与作者所述一致）、`incidents = 6`。

#### 未覆盖/存疑

- 我未穷举 `VALUE_OK` 可吸收的**全部** token（只证「键可混入」这一点已足以证伪其 doc 语义）。
- 段块切分对 **Markdown 表格**的行为：表格行之间无空行 → 整张表**一块**（`tasks.md` 主表 7 行成一块）。
  这与 `EVIDENCE_TABLE` 同族：表格越宽，块越大，标记词越容易「顺带」注记掉别处的旧结论——**未穷举其后果**。
- 产物语义层的「好坏标签」：同前几轮，只做字符串禁串 + 抽查，**未**做系统性语义判定。
- `ANOMALY_COVERAGE` 之外的 note（`CONTEST_COVERAGE.mechanism`、`WORDING_RULES.why`）不受本守卫约束。

#### 判定

**需修改。** 按判定标准（P2-1..P2-3 确实修掉 **且** 无新 P0/P1 ⇒ 通过）：
- **P2-1**：字面主张成立（三份修复前文本都红），**但** 该守卫在两个方向都**新**引入判别力问题——
  **E10 是对旧守卫的回归**（`evidence.rs` 235 行块内插旧结论：旧 RED、新 green），
  **E8/E13 是本轮新造的误红**（`5.25` 入集 + 空行并块）。⇒ **新 P1**（守卫可绕/误报）。
- **P2-2**：悬空标识符已消，但换成 **2 处 doc 自相矛盾**（「三张」实为 4 条；「都由人写下」对自动抽取的 `json_keys` 不成立）。
- **P2-3**：断言确会红，但**不区分键/取值**（`duration_s` 可混入），且「取值当字段」在 `VALUE_OK` 命中的词上**仍成文放行**——**未修净**。

**建议的最小修法**（不要求重做）：
1. **段块判据换掉**：不要用「空行切块」，改用**滚动窗口**（例如以每条「距离证据」出现处为中心，取 ±N 行/±字符），
   既覆盖折行（E1 的反面），又不会把 235 行的 `EVIDENCE_TABLE` 当成一个语义单元（E10）。
2. **距离证据别用闭集字面量**：改判「数字 + 距离单位/比较词」（如 `\d+(\.\d+)?\s*(m|cm|米)` 或 `> / 阈` 邻近），
   否则 E3/E4/E5 永远可绕。
3. **标记要有方向与归属**：至少要求标记词与**同一条**距离证据/推论在**同一句或紧邻句**内，
   并区分「断言 / 禁止 / 收回」三类（堵 E6/E8/E15）。
4. **`VALUE_OK` 的断言改成核「是值不是键」**（例如断言该 token **不以** `"t":` 形态出现），
   并对 `restart_control`/`empty_possession` 这类加一条**反证条**：`本层给 \`X\` 字段` 必须判红。
5. **doc 与代码对齐**：`:1702` 的「三张／都由人写下」与 `:1737` 的「9 个」按实际改写。
6. **（承袭）** `.scratch` 侦察 note 缺席时改**断言失败**。

---

## 收束决定：`close_down` 归因守卫降级为「窄判据 + 如实记录的残余风险」

（主 session 在第 6 轮后介入裁定；作者执行。**这是本守卫族的终点，不再迭代。**）

**为什么停**：该守卫写了 **5 版**（单行合取 → 段落块 → 加词表/窗口 → 锚点式 → 条目式），
**每版都被独立审阅证伪，且每版的修复都制造下一版的问题**——
尤其第 5 轮为堵「`5.3 m` 换写法」把 `5.25` 加进词表，**正是它引出了第 6 轮的 E8 误红**。
根因是结构性的：**文本扫描判不出「散文有没有讲错机制」**——
「断言」与「禁止」共用同一批词（`5.25` + 「追人」既可能是在讲错、也可能是在**禁止**讲错）。
任何词表/窗口的取舍都会在「漏报」与「误红」之间来回摆，**不收敛**。

**现行判据（窄而真）**：`retracted_close_down_claim_sites_carry_their_retraction` 只扫
**会喂进产物的结构化条目**（`evidence.rs` 的 `EvidenceRow`/`UnavailableItem`、
`reasons.rs` 的 `ContestCoverageRow`/`WordingRule`）的字段字面量：条目里若
**同时**出现距离证据（`5.25`/`188/513`/`168/513`）与「追人」，必须带收回标记。

**验收（实跑，见下）**：
| 输入 | 期望 | 实测 |
|---|---|---|
| 无注记旧结论插进 `EVIDENCE_TABLE`（第 6 轮 E10，曾让旧版退化） | RED | **RED** ✅ |
| 删掉真实条目的收回标记 | RED | **RED** ✅ |
| 合法纪律句落在自由散文（E8） | GREEN | **GREEN** ✅ |
| 两句无关话并块（E13） | GREEN | **GREEN** ✅ |
| 基线 | GREEN | **GREEN** ✅ |

**如实记录的残余风险（**不假装已机制化**）**——以下形态**本守卫抓不住**，且
**本 change 不再尝试**抓：
- 在**自由散文**里用**新措辞 / 新单位 / 新同义词**重写这处归因：
  空行隔开距离与推论（E1）；只留推论语（E2）；写 `5.3 m` / `逾五米` / `>5m` / `525 cm`（E3–E5）；
- 把收回词用在**无关**处（E6）或**反向**否认收回（E15）；用同义词收回（E16，会误红）；
- 逐字还原旧句而旧句本身含某个标记词（E12）。

**残余风险的防线是「人」，不是机制**：`ANOMALY_COVERAGE` 的 `note` 只有十行；
这处归因的权威叙述**只有一份**（`evidence.rs` 的 `MoverTarget` 行 + `design.md` §4.4.3 +
侦察 note 第 6 条），改动它们是显眼的。**本仓先例**：P124 如实放弃
`doc_referenced_symbols_exist` 并写明「只靠人工」——本处同款处置。

**另外两条第 6 轮的 P2**：
- **P2-2（`PRODUCT_KEYS` 悬空）**：已修——doc 改为如实列出**四张**名单，
  并标明哪张自动（`json_keys`）、哪张人工；
- **P2-3（键/取值不分）**：**降级并如实记录**。实测**做不到**纯自动判别——
  `empty_possession` 等**既是取值又是键**（`by_exception` 的键名与取值同批串），
  故「值 ⇒ 非键」不成立。守卫保证的是「note 引用的每个标识符都真实存在于产物」；
  **同一个串按哪种身份被引用，它判不了**——那半个后门由**人读那十行 note** 兜。

---

### 轮次 7 — 需修改（独立审阅 agent · Claude / paseo worktree `1g1x3st4` · 2026-09-30）

**审阅对象**：`1b276fc`（我进入时自核）。**审阅中 HEAD 前移到 `faee6c9`**
（docs 提交：`tasks.md` 勾选 Slice 5）——`git diff --stat 1b276fc faee6c9` 只含 `tasks.md`，
`p17b_diagnosis_report.rs` / `tests/p17b/*` **零字节差**，故守卫判定不受影响
（见「未覆盖/存疑」）。默认套件实跑 **33 passed / 0 failed / 2 ignored**；
产物门实跑 **2 passed / 0 failed**（`/tmp/p17b-r7`）。所有变异都在
「`git status` 干净 → 注入 → 跑 → `git checkout -- <file>` → 再证干净」的循环里跑，
每条判红都亲眼见**目标测试名 + `panicked at`**（未混入编译失败）；收尾 `git status` 空、`zz_*` 探针已删。

**结论提前说**：**本次「收束处置」的诚实性——验收表 5 行、残余风险清单——我逐条实测，全部属实**，
且**偏保守**（清单里的形态确实都抓不住，清单外还另有可绕法也没被夸成抓得住）。
**但** `1b276fc` 同批改的 `VALUE_OK` 文档**又在同一族上复发**：
`1718`/`1743` 两处**声称**该断言核「真在产物里 **且** 不是键」，**代码只核了前者**（实测 `duration_s` 这个**键**
加进 `VALUE_OK` 判 **GREEN**）；且守卫 doc 写「**零误报**」——我实测**反例成立**（见下）。
故按判定标准（「文档假称已机制化」「窄判据自身有 bug」）判**需修改**。
**但这是文档/声明层的 P2，不是引第 6 轮循环的 P1 守卫族**——修法只是**改两处措辞 + 补一条残余风险**，
**不需要**再动守卫判据。主 session 的止损仍然成立。

#### A. 收束处置的诚实性（**核心**）

**A-1 验收表 5 行——逐行自己跑（不是抄）**：

| 输入（我实跑） | 期望 | 实测 | 证据 |
|---|---|---|---|
| 无注记旧结论插进 `EVIDENCE_TABLE`（E10：新 `EvidenceRow`，含 `168/513` + `> 5.25 m` + `追人`） | RED | **RED** ✅ | `retracted_...` FAILED @`:1893` `panicked at` |
| 删掉真实条目（`evidence.rs:435`）的收回标记，只留距离 + 追人 | RED | **RED** ✅ | 同上 |
| 合法纪律句落**自由散文**（E8：`//! ...> 5.25 m **不得**据此称其在追人`） | GREEN | **GREEN** ✅ | 1 passed |
| 两句无关话并块落**自由散文**（E13） | GREEN | **GREEN** ✅ | 1 passed |
| 基线（未注入） | GREEN | **GREEN** ✅ | 33 passed |

⇒ 验收表**属实**，五行全部复现。

**A-2 残余风险清单——逐条实测（**两个方向**都查）**。先验「作者说抓不住的，是否真抓不住」
（在**自由散文**即守卫作用域**之外**注入，作用域内的同类见 A-3）：

| 形态 | 作者称 | 实测 | 判读 |
|---|---|---|---|
| E1 空行隔开距离与推论 | 抓不住 | **GREEN** | ✅ 属实 |
| E2 只留推论（`距球远，故在追人`） | 抓不住 | **GREEN** | ✅ 属实 |
| E3 `5.3 m` | 抓不住 | **GREEN** | ✅ 属实 |
| E4 `逾五米` | 抓不住 | **GREEN** | ✅ 属实 |
| E5 `>5m` / `525 cm` | 抓不住 | **GREEN** | ✅ 属实 |
| E6 收回词用在无关处（`本节距离单位：米`） | 抓不住 | **GREEN** | ✅ 属实 |
| E15 反向否认收回（`所谓「打不到靶点」不成立`） | 抓不住 | **GREEN** | ✅ 属实 |
| E12 逐字还原旧句（含 `单位混用`） | 抓不住 | **GREEN** | ✅ 属实 |
| E16 同义词收回（`该归因已作废`） | **会误红** | **RED**（另测） | ✅ 属实（标记表是闭集） |

⇒ **清单无「过度放弃」**：清单里**没有一条**其实抓得住。**第二个方向**（有没有**清单外**的可绕法）：
**有**，且都落在「作者已声明的窄化」里、**没有被说成抓得住**（故属**保守**而非**不实**）：
- **E3-S（作用域内、隔离形）**：结构化条目里**只写** `5.3 m`（不带 `5.25`/分数）→ **GREEN**
  （`DISTANCE_EVIDENCE` 是 3 个字面量的闭集）；
- **E6-S（作用域内、真标记词用在无关处）**：条目里含 `归一化`/`单位混用`/`更正` 而**不是**在修那句
  → **GREEN**（标记只查出现、不查归属）；
- **E14（清单未点名的族）**：见下。

**A-3 作用域声明 vs 实宽（一个建议补记的边界）**：收束节写扫描对象是
「**会喂进产物的结构化条目**（`evidence.rs` 的 `EvidenceRow`/`UnavailableItem`、
`reasons.rs` 的 `ContestCoverageRow`/`WordingRule`）」。但**实际会喂进产物**的还有
`reasons.rs` 的 **`AnomalyCoverageRow`**（`report.rs:1109` 遍历它写 md；实测
`target/p17b-diagnosis/baseline.md` 含 A8 的 note 原文）。我实测：在 **A8 的 `note`** 里插入
`168/513 的 close_down 终点距球 > 5.25 m，故它们在追人` → **GREEN**（该族不在四张里）。
⇒ 把「会喂进产物」当作四张族的**定义性描述**会**高估覆盖面**（四张 ≠ 全部会喂进产物的族）。
文中**没有**直说「四张全是会喂进产物的」，故**不是**假称已机制化；但**残余风险清单未点名这条族级窄化**，
**建议补一句**（与它自身的诚实纪律一致）。

#### B. 窄判据自身的 bug

1. **`units()` 的条目切分对非 4 空格缩进失效**（实测，离线探针 `zz_units`，已删）：
   opener 硬编码 `\n    EvidenceRow {`（4 空格）。→ 条目若被格式化到 **8 空格缩进**，
   `units` 返回 **0**（该族整体静默移出扫描面，而非报错）；
   **单行条目** `    EvidenceRow { x }`（同层）会把**两个连续条目并成 1 个**（少算）。
   当前源文件里两族都恰好是 4 空格、逐条成块（实测 `EvidenceRow`=35、
   `UnavailableItem`=4、`ContestCoverageRow`=6、`WordingRule`=5，与 grep 一致），**现状不触发**；
   但 Rust 允许 `};`（末条不带逗号）与自定义缩进——**切分失配时是静默漏，不是红**。
2. **防空转下限 `units_checked > 40` 抓不住「整族消失」**：实测 `50`（余量 25%）。
   我把 `WordingRule` 的 opener 改坏（该族 5 条归零）→ `units_checked = 45`，**仍 GREEN**
   （且 `claim_units=1` 由 `evidence.rs` 那条满足）。⇒ 该下限只挡「扫描面**整体**塌成空」，
   挡不住**单族**静默消失。注释对此**未声称**能挡单族，故是**观察项**不是谎报。
3. **新的恒真/弱断言**：`claim_units > 0` 的下限**恰好**由**唯一**一条真实条目（`evidence.rs:435`）满足——
   该条是**承重结构**：谁把它收干净（本来这正是「收干净拷贝」的目标），`claim_units` 归 0 →
   **守卫红并要求「把守卫连同说明一起删掉」**（`:1915` 文案如此）。这是**设计意图**（宁红勿空转），
   但意味着「把最后一处错源收干净」会**先把守卫判红**——**易被误读成回归**，值得在 doc 里点一句。
4. **比例回退**：E3-S 隔离形（条目里只写 `5.3 m`）比 E3（自由散文）**更难被判红**——
   即**收窄到条目后，作用域内的距离写法覆盖率反而低于**老版的「中文散文 ±N 行」扫描。
   这是**窄化的已知代价**，doc 的残余风险**未列**「作用域内换单位写法」（只列了自由散文的 E3–E5）。
5. **悬空引用**：逐一 grep，doc 点名的 `json_object_keys` / `anomaly_coverage_blocks` 均存在；
   `PRODUCT_KEYS` 全仓已 **0**（只剩历史记录）；`:1836` 的 `doc_referenced_symbols_exist`
   （P124 的历史符号）在 `openspec/changes/p124-intent-observations/REVIEW.md` 中**确有记载**
   （`git log -S` 追到 `2921b8d`/`33a3214`），**非假名**；`:1837` 的「§4.4.3」在 `design.md:233`
   逐字存在（`#### 4.4.3 close_down 不恒为「追球」（MAJOR-2）`）。**无悬空引用** ✅。

#### C. 新发现（**`1b276fc` 同批改的 `VALUE_OK` 文档，在同族上复发**）

- **[P2] 断言声明 vs 断言体不符（**「把判不了的写成判得了」**）**：
  `:1718` 写「故下面逐词断言**两条**：真在产物里，**且不是键**」；`:1743` 写
  「每个都断言「真在产物里 **且** 不是键」」。**代码只有一条断言**（`:1754` `json.contains("\"{v}\"")`），
  **没有**任何「不是键」的检查。**实测**：把 **`duration_s`（一个键）** 加进 `VALUE_OK` →
  `anomaly_coverage_notes_only_cite_fields_the_product_carries` **GREEN**。
  **注意**：`:1759-1765` 的**紧随注释**是对的（明确写「做不到纯自动判别…本断言只核该串存在」）——
  即**同一段里 `:1718`/`:1743` 与 `:1759` 自相矛盾**。这正是本 change 反复记的形态
  （结论对、声明错），也是第 6 轮 P2-2「换一处 doc/code 不符为两处 doc 自相矛盾」的**同款复发**。
- **[P2] 「零误报」被夸大**：守卫 doc `:1816`/`:1823` 写「**零误报**：自由散文（纪律句、无关两句话）**不扫**」。
  「自由散文不扫」为真；但「零误报」**为假**——**纪律句落在被扫的结构化条目内**照样误红。
  实证：把 `WordingRule` 的 `forbidden` 改成合法禁令
  「不得把 close_down 终点距球 > 5.25 m 读成它们在追人」→ **RED**（`:287`）。
  这不是构造出来的怪输入：`WordingRule` 的语义就是「可说 / **不可说**」，`forbidden` 正是写禁令的地方，
  且 **`WORDING_RULES[0]` 现有文本已含一处纪律句**（只是没带距离字面量，故当前不触发）。
  根因**与作者自己写下的完全一致**——「断言」与「禁止」共用同一批词，判据没有方向感；
  只是 E8 那一例落在自由散文（不扫，侥幸绿），换成条目内（扫）就红。
- **[P2] `VALUE_OK` 后门只关了一半（承袭，已如实声明）**：`:1759` 已如实写「同一个串按哪种身份被引用，
  本守卫判不了」。实测**吻合**：`duration_s`（键，不在 `VALUE_OK`）**进** `VALUE_OK` → GREEN；
  但**已登记**的 7 个词被「当字段」引用仍成文放行。作者的**处置（降级 + 如实记录）我判合格**——
  它没假装关上了；只有 `:1718`/`:1743` 那两处与新注释打架的措辞需要改。
- **[PASS] 四张名单与代码标识符确实对应**：`json_keys`（6 处）/`SOURCE_SIDE_OK`（5）/`PROSE_OK`（5）/
  `VALUE_OK`（6）/`json_object_keys`（3）**均存在**；`PRODUCT_KEYS` **0**；`VALUE_OK` 实测**7** 条，
  与 `:1741` 的「**7** 个」一致（第 6 轮 P2-2 的「9 个」数错**已修**）。
- **[PASS] `VALUE_OK` 的「真在产物里」确实挡后门**：加一个**不在产物里**的词 `zzz_absent_value` →
  **RED**（`anomaly_coverage_notes...` @`:1755`，目标测试名 + `panicked at`）。此条**属实**。

#### 不可越界核实（独立核实）

1. **零 `engine/src/` 改动**：`git diff main --stat -- engine/src` → **空**；
   `git rev-parse main:engine/src` == `git rev-parse HEAD:engine/src` == `493ac86e…`。✅
2. **不报相位**：自写**块注释（`re.sub(r'/\*.*?\*/')`）+ 行注释（逐行截 `//`）双剥**扫描器，扫
   `tests/p17b/{evidence,episode,reasons,report}.rs` 非注释行 → `build_up`/`progression`/
   `final_third`/`attacking_transition`/`Phase` **四文件全 0 命中**。✅
3. **不产生 pass/fail 或好坏标签**：大小写敏感扫 `engine/target/p17b-diagnosis/*.{json,md}` →
   `PASS`/`FAIL`/`passed`/`failed`/`通过率`/`合格` **全 0**。✅
4. **产物与源码同源**：磁盘件 vs `/tmp/p17b-r7` 重跑件**只差 `source_commit` 一栏**
   （JSON/MD 各 1 行差异 → `diff` 计 2 行）；两件 `test_source_fingerprint`（`dbca27f5…`）/
   `engine_source_fingerprint`（`49447252…`）**逐字节相同**。磁盘件记 `51e8307`、重跑件记 `faee6c9`
   ——按 report.rs 的口径 `source_commit` 是「跑门时的 `P17B_SOURCE_COMMIT`」，**陈旧判据是
   两个源码指纹**（守卫只核 `!= unknown`，注释已说明 `== HEAD` 会自失效），**非缺陷**。✅
   （顺带：磁盘件 `source_commit`=51e8307 但指纹与当前一致，是因为 `1b276fc` 只改了**外层**
   `p17b_diagnosis_report.rs`，而 `test_source_fingerprint` 只哈 `tests/p17b/*`——**Pre-existing** 口径，非本次引入。）

#### 默认套件与产物门

- `cargo test --test p17b_diagnosis_report`：**33 passed / 0 failed / 2 ignored** ✅
- `P17B_OUT_DIR=/tmp/p17b-r7 P17B_SOURCE_COMMIT=$(git rev-parse HEAD) cargo test --release -- --ignored`：
  **2 passed / 0 failed** ✅（`canary.md` 3075 卡、`baseline.md` 收录 3366/省略 26813）

#### 未覆盖/存疑

- **HEAD 前移**：审阅期间 HEAD 由 `1b276fc` → `faee6c9`（仅 `tasks.md`）；我按**两者守卫代码逐字节相同**
  作了覆盖判定。若后续再动 `p17b_diagnosis_report.rs`，**本报告结论需重跑**。
- **（已澄清，非存疑）** `:1836` 的 `doc_referenced_symbols_exist`（P124 历史符号，见 P124 的
  `REVIEW.md`）与 `:1837` 的「§4.4.3」（`design.md:233`）**均真实存在**，不是假名。
- **「零误报」只被我用一条反例证伪**；我未穷举 `WordingRule`/`ContestCoverageRow` 全部合法写法，
  也未核 `evidence.rs` 的两族在**未来新增条目**时是否还会撞上（当前 `EVIDENCE_TABLE` 那条**带了**
  一个 `推翻`/`打不到靶点` 双标记，故现绿）。
- `ANOMALY_COVERAGE` 之外的 note（`CONTEST_COVERAGE.mechanism` 的 `why`、`WORDING_RULES.why` 的自由散文）
  不受本守卫约束——`WORDING_RULES[0].why` 已含「追人 + `推翻`」（**带**注记，故安全），
  但**它若被改写成无注记形态，无守卫会红**（属作者已声明的「自由散文」残余）。

#### 判定

**需修改。** 按判定标准逐条对照：
- **A（收束诚实性）**：✅ **属实且偏保守**——验收表 5 行真、残余风险 9 条真、无过度放弃；仅建议**补记**
  「`AnomalyCoverageRow` 不在四张内」与「作用域内换单位写法」两条**族级窄化**（非不实，是全度可再精确）。
- **B（窄判据 bug）**：⚠️ 发现 **4 处**（切分对非 4 空格缩进静默失效 / `>40` 挡不住单族消失 /
  `claim_units>0` 承重于**唯一**一条 / 作用域内 E3-S 覆盖回退）。均**非当前源文件触发**，
  但「静默漏」与「承重唯一」属**判据自身的脆性**。
- **C（新问题）**：❌ **`1b276fc` 引入两处文档不实**——`:1718`/`:1743` 声称断言核「不是键」而实际没有
  （`duration_s` 实测 GREEN），**且与本文件 `:1759` 的正确注释自相矛盾**；`「零误报」` 被实测反例证伪
  （条目内合法禁令 → RED）。**二者都是「把判不了的写成判得了」的同族**——正是本 change 的立身之戒。
- **D/E**：✅ 三条不可越界全过；套件 33/0/2、产物门 2/0、磁盘件与重跑件只差 `source_commit`。

**为什么不判「通过」**：判定标准写明「**文档假称已机制化**」或「**窄判据自身有 bug**」即需修改。
C 的两条（断言声明/断言体不符、零误报夸大）**有定向变异坐实**，不是措辞口味问题。
**为什么不是第 6 轮那种 P1 循环**：本次问题**不在判据的判别力**（那族已按主 session 裁定止损），
**只在两处随同提交写下的声明**——修法是**改措辞**（把 `:1718`/`:1743` 的「且不是键」删掉或改成
「只核存在」，与 `:1759` 对齐）**+ 把「条目内合法禁令会误红」与「`AnomalyCoverageRow` 不在内」
补进残余风险清单**，**不触碰 `units()`/`DISTANCE_EVIDENCE`/`RETRACTION_MARKERS`**。
若作者认同「`零误报` 应改为『自由散文零误报；条目内仍可能误红』」，则本轮可在**不重启守卫迭代**的前提下收口。

**建议最小修法**（不要求重做）：
1. 删/改 `:1718` 与 `:1743` 的「**且不是键**」——与 `:1759` 的如实声明对齐（或真的加一条
   `!json_keys.contains(v)` 的反向断言，但那会**误伤** `empty_possession` 这类双身份词，故**建议改文档**）。
2. 「**零误报**」改为「**自由散文零误报；落在被扫条目内的合法禁令仍可能误红**」。
3. 残余风险清单补两条：①**被扫条目内**换距离写法（E3-S）；②`AnomalyCoverageRow` 等
   **会喂进产物但不在四张**的族。
4. （可选，观察项）给 `units()` 加一条**反证条**：对每个 opener 家族断言「本族条目数 > 0」
   （或把 `>40` 改成**逐族**下限），以堵「整族因缩进/改名静默移出扫描面」。

### 轮次 7 后的处置（作者；第 7 轮判「需修改」，两条均为**文档层**）

轮 7 的结论是：**收束处置本身诚实**（残余风险清单 9 条逐条实测、无一条「其实抓得住」；
验收表 5 行逐行复现），**但 `1b276fc` 同批改的 `VALUE_OK` 文档在同族上复发**——
两处「把判不了的写成判得了」。**这两条不触碰 `units()` / 距离词表 / 收回词表**，
故主 session 的止损裁定仍成立。处置如下：

1. **「逐词断言**两条**：真在产物里，且不是键」→ 改为如实的一条**。
   代码里**只有一条**检查（`json.contains`），实测把 `duration_s`（键）加进 `VALUE_OK` **不会红**。
   根因：`empty_possession` 等**既是取值又是键**，故「值 ⇒ 非键」不成立。
   现文档写明：**只断言「该串出现在产物里」**，身份那半**做不到自动判别**，由人读十行 note 兜。
2. **「零误报」→ 删除该表述**。实测证伪：把**合法禁令**
   （`不得把 close_down 终点距球 > 5.25 m 读成它们在追人`）写进**另一个** `WordingRule` 条目 ⇒ **RED**。
   `E8` 之所以不红，只是因为它恰好落在**不扫的自由散文**里，**不是**判据有方向感。
   根因正是本守卫自己写下的那句「断言与禁止共用同一批词」。
3. **补一条残余风险**：条目内换距离写法（只写 `5.3 m`）**比自由散文更难判红**。
4. **补一个扫描面漏洞（同一套精确锚定的扩面，非新启发式）**：
   `reasons.rs` 的 `AnomalyCoverageRow`（P17A 异常覆盖表）也**喂进产物**，
   此前漏在四族之外 ⇒ 现纳入。轮 7 的观察项（往 A8 note 插旧结论不红）**已实测转为 RED**。

处置后：默认门 **33 passed / 0 failed**；产物门 2 passed；
验收五条 + A8 扩面 + 两条文档所指的边界，全部实跑核对，变异后源码 `diff` 确认 pristine。
**本守卫族的迭代到此为止**（主 session 裁定），后续不再加判据。

---

### 轮次 8 — 需修改（独立审阅 agent · Claude / paseo worktree `1g1x3st4` · 2026-09-30）

**审阅对象**：`68d228b`（我进入时自核 `git rev-parse HEAD` = `68d228b16c024aa86654ab184b1111967e213a55`，
提交信息自称 `68d228b`，一致）。审阅期间 HEAD **未移动**、工作树**全程 pristine**（每条变异后
`git checkout -- <file>` + `git status --porcelain` 空；`zz_*` 探针已删）。
默认套件实跑 **33 passed / 0 failed / 2 ignored**；产物门实跑 **2 passed / 0 failed**（`/tmp/p17b-r8`）。

**结论提前说**：轮 7 点名的**三条处置，全部真的到位**（A 段逐条实测，含两条定向变异）。
`VALUE_OK` 的两处文档不实**已删净且与新注释自洽**；`AnomalyCoverageRow` **确实纳入扫描**（A8 注入实测转 RED）。
**但** `68d228b` 补扫描面时，在**同一段注释里写下了一条新的、可证伪的覆盖面声明**——
`:1882` 断言「**扫描面 = 所有「喂进产物」的结构化条目族**」，而**至少还有两族**既喂进产物、
又不在 5 个 target 里，且 `units()` 能机械处理它们：`episode.rs` 的 `CoverageClaim`
（→ 产物键 `coverage_claims`）与 `EXCEPTION_CLASSES`（→ 产物键 `exception_classes`）。
我把轮 7 那处被推翻的归因**原样**注入这两族 ⇒ 目标守卫**均 GREEN**（实测，见 B）。
这正是本 change 的立身之戒「**不得声称能解释它看不见的东西**」的**同族复发**——
**且是本次提交自己引入的**。故判**需修改**，修法**只是改一句措辞 + 补一条残余风险**，
**不触碰** `units()` / 距离词表 / 收回词表（主 session 的止损**仍成立**）。

#### A. 轮 7 三条处置的核实（**逐条自己跑，不抄提交信息**）

**A-1 「且不是键」是否删净 + `VALUE_OK` 注释是否与断言体一致** —— ✅ **到位**。

- 全文 grep `不是键`：只剩 **2** 处，**两处都是否定式**——`:1746`「⚠️ **不断言「且不是键」**」、
  `:1831`「⚠️ **不可声称「零误报」**」。**无任何一处**再宣称断言做那条检查。✅
- 断言体（`:1757-1770`）**只有一条** `json.contains(&format!("\"{v}\""))`，与上方 `:1714-1720`
  的「**只断言一条**：该串真的出现在产物里。身份那半由人读十行 note 兜」**逐句自洽**——
  轮 7 的「同段自相矛盾」**已消除**。✅
- **定向变异复现轮 7 的证伪**：把 **`duration_s`（一个键）** 加进 `VALUE_OK` →
  `anomaly_coverage_notes_only_cite_fields_the_product_carries` **GREEN**（`1 passed`）。
  即「值 ⇒ 非键」**确实不成立**，文档**如实**写明了这一点。✅（变异后已还原）

**A-2 「零误报」是否删净 + 是否有如实记述** —— ✅ **到位**。

- grep `零误报`：仅 **1** 处，且是 `:1831` 的「⚠️ **不可声称「零误报」**（轮 7 实测证伪）」。
  原「✅ **零误报**」的判据式措辞**已删除**，改为「✅ **自由散文不扫**」（`:1827`）。✅
- **定向变异复现轮 7 的证伪**：把 `WORDING_RULES[1].forbidden` 改成**合法禁令**
  「不得把 close_down 终点距球 > 5.25 m 读成它们在追人」→ `retracted_...` **RED**
  （`:1907` `panicked at`，非编译失败）。文档 `:1831-1834` **逐句描述了**这条误红
  （「`WordingRule` 的 `forbidden` 字段里写一条合法禁令…会被判红」），且**点明根因**
  （E8 只是恰好落在不扫的自由散文里，不是判据有方向感）。✅（变异后已还原）

**A-3 `AnomalyCoverageRow` 是否真纳入扫描 + 轮 7 观察项是否真转 RED** —— ✅ **到位**。

- `:1890` 已加 `("p17b/reasons.rs", "\n    AnomalyCoverageRow {", "P17A 异常覆盖条目")`，
  `targets` 由 4 → 5。✅
- **我自己实测**（不采信提交信息）：往 `ANOMALY_COVERAGE` 的 **A8 `note`** 插入
  `168/513 的 close_down 终点距球 > 5.25 m，故它们在追人` → `retracted_...` **RED**
  （`:1907` `panicked at`，报「`p17b/reasons.rs` 第 230 行的P17A 异常覆盖条目」）。✅
  轮 7 的 GREEN 观察项**确已转为 RED**。（变异后已还原）

⇒ **轮 7 的三条处置全部到位，且都能被定向变异坐实。** A 段无问题。

#### B. 过度声明扫描（**本轮核心**）——一处**新的、可证伪的覆盖面声明**

逐句核了 `anomaly_coverage...` 的 doc（`:1641-1801`）与 `retracted_...` 的 doc（`:1803-1933`）的
每条「✅／抓得住」「❌／抓不住」「残余风险」，并对**收束节**（`:1176-1220`）与
**处置节**（`:1409-1430`）逐句对照断言体。结论：**旧条目全部属实**（轮 7 已核，我抽核未发现回退），
**但 `68d228b` 新写的扩面注释里埋了一条不实**：

- **[P2 · 由本次提交引入] `:1882` 的「扫描面 = **所有**「喂进产物」的结构化条目族」是**过度声明**。**
  这是一个**全称命题**（「= 所有」），断言扫描面**恰好等于**「会喂进产物的结构化条目族」的**全集**。
  **实测证伪——全集至少漏两族**：
  | 族（定义处） | 是否喂进产物 | 证据 | 注入旧结论后 `retracted_...` |
  |---|---|---|---|
  | `episode.rs` **`CoverageClaim`**（`:432`/`:439`） | **是**（JSON 键 `coverage_claims`，`report.rs:892-906`） | 磁盘 `baseline.json` 含其 `answerable` 原文「按成因分别可答」 | **GREEN** ❌ |
  | `episode.rs` **`EXCEPTION_CLASSES`**（`:766`） | **是**（JSON 键 `exception_classes`，`report.rs:882-889`） | 磁盘 `baseline.json` 含其定义原文「同拍收束：**争抢**时长为 0」 | **GREEN** ❌ |
  两族的条目都以 4 空格缩进成块（`\n    CoverageClaim {` / `\n    ("`），**`units()` 能机械处理**——
  即这不是「启发式抓不住」的残余（那类已有清单），而是**漏登记**。故「所有」二字**不成立**。
  **这正是轮 7 那处 P2 的同型**：不是判据坏了，是**文档把自己说强了**（「把抓不住的写成抓得住」），
  **且是本次提交新写的**——与它的立身之戒直接冲突。
- **[MINOR · 同批引入] `:1876` 仍写「**四个**会喂进产物的结构化条目族」**，而 `:1885` 的 `targets`
  已改为 **5** 项（`:1887` 还有「漏在四**族**之外」的旧措辞）。**同一段内计数不自洽**
  （「四个」vs 5 项）。方向是**少数**（安全侧），但与本段的「说清扫描面」的目的相抵。
- **[MINOR · 承袭] `:1822` 的「只扫**结构化条目**——`evidence.rs` 的 `EvidenceRow`、`reasons.rs` 的
  `WordingRule`」** 只列 5 项中的 2 项。这是**少列**（过度放弃侧），不构成「说强了」，
  但与 `:1882` 的「所有」叠在一起，读者无法从 doc 拼出**真实**的扫描面。

**其余逐条核查（均属实，无误）**：
- doc 的 ❌ 残余风险清单（E1–E6/E12/E15 + `:1843` 新补的「条目内换距离写法」）：我**抽核三条**——
  **E3-S（条目内只写 `5.3 m`）** 注入 `WordingRule.forbidden` → **GREEN**（`: 1 passed`，**属实**）；
  **E2（只留推论语，无距离字面量）** → **GREEN**（属实）；**自由散文 E8 纪律句**（带 `> 5.25 m` + 「不得」）
  → **GREEN**（属实）。⇒ 清单**无「过度放弃」**：所列各条**确实**抓不住。
  清单**外**的可绕法（如上面 B 的两族）**未被夸成抓得住**——**唯一**的问题是 `:1882` 的
  「= 所有」**把它们从「未点名」升格成了「已覆盖」**。
- doc 的 ✅ 项（`json_object_keys` 抽取 >50 键、`VALUE_OK`「真在产物里」挡后门）：**属实**
  （`json_keys.len() > 50` 实测通过；`VALUE_OK` 不在产物里的词会被 `:1758` 判红——轮 7 已证）。
- **别处能力声明抽核**：`design.md:165/283` 与 `tasks.md:75` 仍写措辞守卫「扫**三**文件、
  **排除** `report.rs`」——而实现**已扫 4 文件含 `report.rs`**（`:817-822`，并有 `:810-816`
  的翻转说明）。这是**反向（少报覆盖）**，**不是**过度声明，且设计文档是提案历史件；
  列为观察项，**不**构成「需修改」。

#### C. 新发现（恒真断言 / 悬空引用 / 防空转实测值 / `units()` 脆弱点）

- **无新的恒真断言。** `claim_units > 0`（`:1927`）由**唯一**一条真实条目（`evidence.rs:435`）承重——
  实测 `claim_units = 1`。这是**设计意图**（宁红勿空转），其文案（`:1929-1931`「请把本守卫连同其
  设计说明一起删掉」）已如实写明**易被误读成回归**，属**已声明**的承重结构，非新问题。
- **防空转实测值（自写探针 `zz_checked_probe`，已删）**：
  `checked = 32`（与 `:1794` 声明的 **32** 一致；下限 `>25`，余量 22%），
  `units_checked = 60`（下限 `>40`），`claim_units = 1`。**逐族条目数实测**
  `EvidenceRow=35 / UnavailableItem=4 / ContestCoverageRow=6 / WordingRule=5 / AnomalyCoverageRow=10`
  （与 `grep` 计数逐一吻合）。⇒ **防空转断言当前有真实材料，不空转。**
- **`units()` 的 4 空格缩进脆弱点——当前源文件不触发**：逐族 `openers == units` **完全相等**
  （35/4/6/5/10），**无** `unterminated`（即无「末条无逗号 `};`」缺口），
  **无** 8 空格缩进条目、**无**同层单行条目（`    X { ... },`）。⇒ 轮 7 记的三条静默失效形态
  **现状均不触发**（与轮 7 的判断一致）。
- **悬空引用：无。** 逐一 `grep` doc 点名物：`json_object_keys`（3）、`anomaly_coverage_blocks`（6）、
  `identifier_words`（2）、`doc_referenced_symbols_exist`（1，P124 历史符号，确在
  `p124-intent-observations/REVIEW.md`）、`§4.4.3`（`design.md:233` 逐字存在）。
  `PRODUCT_KEYS` 全仓 **0**（只剩历史记录）。✅
- **无新增恒真/弱断言**；`:1361-1370` 的 `EXCEPTION_CLASSES` 断言（核 `instant_contest` 定义含「70%」）
  是对**被扫族之外**的一处**已存在**的定向守卫，非本守卫族，且**有效**。

#### 不可越界核实（独立核实）

1. **零 `engine/src/` 改动**：`git diff main --stat -- engine/src` → **空**；
   `git rev-parse main:engine/src` == `git rev-parse HEAD:engine/src` == `493ac86e…`。✅
2. **不报相位**：自写**块注释（`re.sub(r'/\*.*?\*/')`）+ 行注释（逐行截 `//`）双剥**扫描器，扫
   `tests/p17b/{evidence,episode,reasons,report}.rs` 非注释行 → `build_up`/`progression`/
   `final_third`/`attacking_transition`/`Phase` **四文件全 0 命中**。✅
3. **不产生 pass/fail 或好坏标签**：大小写敏感扫 `engine/target/p17b-diagnosis/*.{json,md}`
   **与** `/tmp/p17b-r8/*.{json,md}` → `PASS`/`FAIL`/`passed`/`failed`/`通过率`/`合格` **全 0**。✅
4. **产物与源码同源**：磁盘件 vs `/tmp/p17b-r8` 重跑件**只差 `source_commit` 一栏**
   （JSON/MD 各 1 行 → `diff` 计 2 行）。两件 `engine_source_fingerprint`（`49447252…`）/
   `test_source_fingerprint`（`a44de471…`）/`sidecar_schema_fingerprint`（`7c76518c…`）**三者逐字节相同**，
   且**与当前源码一致**（默认套件的 `on_disk_artifacts_share_the_current_source_fingerprints` **绿**）。
   磁盘件记 `source_commit=faee6c9`、重跑件记 `68d228b`——按 `report.rs` 的口径这是
   「跑门时的 `P17B_SOURCE_COMMIT`」快照，**陈旧判据是两条源码指纹**（本处相同），**非缺陷**。
   ⚠️ 顺带核实：`test_source_fingerprint` **包含** `p17b_diagnosis_report.rs`（`report.rs:47`），
   故 `68d228b` 对守卫的改动**本应**改变它——实测确由轮 7 的 `dbca27f5…` 变为 `a44de471…`，
   而磁盘件**已重生成**为新值（未陈旧）。✅

#### 默认套件与产物门

- `cargo test --test p17b_diagnosis_report`：**33 passed / 0 failed / 2 ignored** ✅
- `P17B_OUT_DIR=/tmp/p17b-r8 P17B_SOURCE_COMMIT=$(git rev-parse HEAD) cargo test --release -- --ignored`：
  **2 passed / 0 failed** ✅（`canary.md` 3075 卡、`baseline.md` 收录 3366 / 省略 26813）

#### 未覆盖/存疑

- **[需修改项]** `:1882` 的「= 所有」为**过度声明**，有**两族定向反例**坐实（B 段）。
  修法（**不动判据**）：① 把「= 所有」改为**枚举**（如「= 本 change 登记的 5 个 target 族」）
  或删「所有」二字；② 在残余风险清单**补一条**：`episode.rs` 的 `CoverageClaim` /
  `EXCEPTION_CLASSES` 等**喂进产物但未登记**的族，不扫；③ 顺手把 `:1876` 的「四个」
  与 `:1887` 的「四族」改为与 `targets`（5）一致。
- **[观察项，非判据]** `design.md:165/283`、`tasks.md:75` 仍写措辞守卫「扫三文件、排除 `report.rs`」，
  与实现（4 文件含 `report.rs`）不符——**少报**方向，建议一并订正，但不阻断。
- **[观察项]** 我**未**穷举全部「喂进产物」的族（只核了 `const ..._SOURCES` / 结构体数组 /
  report.rs 的 `push_str("\"键\":` 三处线索）；B 的两族是**确证**反例，「可能还有更多」本身
  不影响判定（一条反例即证伪「所有」）。
- **[承袭，已声明]** `claim_units` 承重于唯一一条真实条目；`units()` 对非 4 空格缩进静默漏——
  两者均**现状不触发**且**已在 doc 如实记录**，不构成需修改。

#### 判定

**需修改。** 按判定标准（「文档假称已机制化 / 把抓不住的写成抓得住」即需修改）：
- **A（轮 7 三条处置）**：✅ **全部到位**，三条均有定向变异坐实（「且不是键」删净、
  「零误报」删净且如实记误红、`AnomalyCoverageRow` 纳入且 A8 注入转 RED）。
- **B（过度声明）**：❌ **`68d228b` 新引入 `:1882` 的全称声明「扫描面 = 所有喂进产物的结构化条目族」**，
  被 `episode.rs` 的 `CoverageClaim` / `EXCEPTION_CLASSES` **两族反例证伪**（各注入旧结论 → GREEN，
  且都进 JSON 产物）。**同族复发**，故需修改。
- **C（新问题）**：✅ 无新恒真断言、无悬空引用；防空转实测值真实（`checked=32`/`units=60`/`claim=1`）；
  `units()` 现状不触发脆弱形态。
- **D/E**：✅ 三条不可越界全过；套件 33/0/2、产物门 2/0、磁盘件与重跑件只差 `source_commit`。

**为什么不是「因守卫窄而判需修改」**：判定标准明说「守卫覆盖面**窄本身**不是理由——**只要它如实**」。
本条**不是窄**的问题，而是文档**宣称了全称覆盖**（「= 所有」）而实际只覆盖 **5 族中的一部分**——
**恰恰是「不如实」**。若改为枚举 + 补残余风险，**即符合**「窄而真」，本轮可在**不重启守卫迭代**的
前提下收口（与轮 7 同款处置）。

**建议最小修法（不要求重做）**：
1. `:1882` 删「所有」或改为枚举本 change **登记的 5 个 target 族**；
2. 残余风险清单补一条：`episode.rs` 的 `CoverageClaim` / `EXCEPTION_CLASSES` 等
   **喂进产物但未登记**的族**不在扫描面内**；
3. `:1876`/`:1887` 的「四个 / 四族」改为与 `targets` 一致（5）；
4. （可选）订正 `design.md:283` / `tasks.md:75` 的「扫三文件、排除 `report.rs`」。

### 轮次 8 后的处置（作者；轮 8 判「需修改」，一条**新造的过度声明**）

轮 8 确认：**轮 7 的三条处置全部真实到位**（逐条独立变异复核，不是采信提交信息）；
但它抓到我在 `68d228b` 里**新造**的一句**全称声明**——
注释写「**扫描面 = 所有「喂进产物」的结构化条目族**」，而这是**假的**：
至少 `episode.rs` 的 `CoverageClaim`（JSON 键 `coverage_claims`）与
`EXCEPTION_CLASSES`（JSON 键 `exception_classes`）也喂进产物，却不在 5 个 target 里。
往这两者注入旧结论 ⇒ 守卫 **GREEN**。
**这正是本 change 的立身之戒（「不得声称能解释它看不见的东西」）在本守卫自己的注释上复发。**

处置（**改措辞 + 同一套精确锚定的扩面，不触碰判据本体**，故止损裁定仍成立）：
1. **删掉全称**：改为「扫**下方显式列出的七个条目族**」，并**显式写下**
   「不要把它写成『所有喂进产物的条目族』——清单是显式登记的，不保证穷尽」；
2. **补登两族**：`CoverageClaim` / `EXCEPTION_CLASSES`（后者是元组形态，
   故 `units()` 增加 `closer` 参数：结构体 `\n    },`、元组 `\n    ),`）；
   实测：往两者各注入旧结论 ⇒ **均 RED**（轮 8 时均 GREEN）；
3. **残余风险清单补一条**：清单本身**不保证穷尽**——将来新增「喂进产物且有说明字段」
   的条目族而忘了登记，守卫**不会说话**（轮 8 抓到的正是这一族）。

---

## ⛔ 迭代终止（主 session 裁定，2026-09-30）

**本守卫族（`retracted_close_down_claim_sites_carry_their_retraction`）到此为止，不再迭代。**

主 session 在第 6 轮后已裁定停止迭代；第 7、8 轮为执行该裁定的**收尾改动**
（改措辞 + 同一套精确锚定的登记面扩面），**未新增判据逻辑**。第 9 轮**不再修**——
其发现**如实记录在下方，作为已知残余风险**。

### 第 9 轮（进行中被裁定终止）的发现——**如实记录，不修**

**又一处假阴性**：往 `EXCEPTION_CLASSES` 的 `("long_dwell", …)` 注入旧结论 ⇒ **GREEN**，
因为**约 30 行外**一处**无关**的「更正」二字落在同一个条目的窗口里，把它「自动注记」掉了。
——这正是本轮 doc 自己声明的、第 6 轮已证伪的 **v2 形态**（「巨块内被远处的标记词自动注记」）。
本次它出现在**第 8 轮刚补登的**元组族上：`EXCEPTION_CLASSES` 的条目在源文件里是
**连续多行元组**，`units()` 的 `"\n    ),"` 切口把相邻条目之间的说明也纳入了单位。

⇒ **结论（与第 6 轮的裁定一致）**：这类「标记词共现」判据**永远**会在
「漏报」与「误红」之间摆动——**再加窗口/词表的修正只会换一个新的失败面**。
**本 change 接受该残余风险，不再修**（本仓先例：P124 如实放弃 `doc_referenced_symbols_exist`）。

### 该守卫的**真实能力边界**（最终版，供后续读者）

✅ **保证**：**显式登记的七个条目族**里，若某条目**同时**出现距离证据
（`5.25` / `188/513` / `168/513`）与「追人」，该条目（其 `units()` 窗口内）必须带收回标记。
实测抓得住：`evidence.rs` 的 `EvidenceRow` 行、删掉真实条目的收回标记、
`AnomalyCoverageRow` / `CoverageClaim` 的注入（轮 7/8 的靶子）。

❌ **不保证**（已知残余风险，**全部实测过**）：
- **自由散文**里的新措辞 / 新单位 / 同义词：空行隔开、只留推论语、
  `5.3 m` / `逾五米` / `>5m` / `525 cm`、收回词用在无关处、收回词被**反向**使用、逐字还原旧句；
- **条目窗口内被无关标记词自动注记**（第 9 轮：`EXCEPTION_CLASSES` 的 `long_dwell` 条目）；
- **条目内**把距离写成 `5.3 m`（窗口内没有 `5.25` 则整条判据不触发）；
- **清单不保证穷尽**：将来新增「喂进产物且有说明字段」的条目族而忘了登记，守卫不会说话；
- **「条目内合法禁令」会误红**（`WordingRule.forbidden` 里写一条**合法**禁令时；
  实测 RED）——`E8` 之所以不绿是**侥幸**（它落在不扫的自由散文里），**不是判据有方向感**。

**防线是「人」，不是机制**：这处归因的权威叙述**只有一份**
（`evidence.rs` 的 `MoverTarget` 行 + `design.md` §4.4.3 + 侦察 note 第 6 条），
`ANOMALY_COVERAGE` 的 note 只有十行——**改动它们是显眼的**。
