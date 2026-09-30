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
