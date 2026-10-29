# C1-ballpath-pass · 独立审阅 Round 4（2026-10-30，R6 研究门收口复审）

审阅者：零上下文独立审阅（只读；未改已跟踪文件、无 commit/push；未跑任何 `#[ignore]`）。
范围：`git diff 0d69c23..HEAD`（5 个提交：`321a7e7` / `c1c9ed5` / `0e27df0` / `f58d37a` / `4db6162`）。
工作树：HEAD=4db6162；除**预先存在**的 `.gitignore` 修改（StatsBomb 忽略项）与 4 项未跟踪笔记外干净（与 RECORD §4 的记录一致）；临时探针 `engine/tests/zz_probe_r6.rs` 用后已删、未入库。

## 结论

- **P1 = 0**：没有「结论错 / 门被实质放宽」的改动。所有重钉值、换样本都按原判据做了，实测读数与 RECORD/注释一致。
- **P2 = 3**（均为**记录**问题，不阻塞行为门）：
  1. `p17b/reasons.rs:193` 把 **729/729 标成「P17A 300 seed 实测」**——它是 **30 seed** 的数（R6 300 seed 实测该成因 15364，产物同页即 15364/15364）。本 diff 新引入。
  2. `p17b/report.rs:1221` 的产物文本把**拍数（beat）与秒混排**：`均长 6.43（design 载 … 均长 3.02）`。R6 的 beat→秒换算只改了测试、没改产物；HEAD 生成的 `engine/target/p17b-diagnosis/{canary,baseline}.md` 实文可证。
  3. `p124_intent_observations.rs:1256-1260` 的测试 doc（及 `p124/phasegate.rs:406`、`purify.rs:183` 的 `COUNTER_PROOF_EXPECTED=0.764`）仍把 `final_third` 记成 ≈0.855 / 0.764，而两条管线在 R6 上读数均为 **0.729**（本 diff 已把 p16 侧重钉为 0.729±0.03 并声称「同一管线逐位一致」，p124 侧漏钉；±0.05 容差把它掩盖成绿）。doc 的 ③ 还与 body 相反（详见正文）。部分为旧文本，本轮收口未一并更新。
- **P3 = 6**（措辞/陈旧示例，见正文）。

已跑（全部非 `--ignored`）：

| 命令 | 读数 |
|---|---|
| `cargo test --release --lib observation::tests::` | **67 passed / 0 failed** |
| `cargo test --release --test p15_behavior_observation` | **11 passed / 0 failed / 1 ignored** |
| `cargo test --release --test p16_spatial_features` | **36 passed / 0 failed / 2 ignored** |
| `cargo test --release --test p17b_diagnosis_report` | **33 passed / 0 failed / 2 ignored** |
| `cargo test --release --test p124_intent_observations` | 34 passed / **1 failed** / 2 ignored——唯一红是 `on_disk_artifacts_share_the_current_source_fingerprint`，原因 = 本 worktree 预先脏（见 §环境） |
| `node --test tools/benchmark-baseline.test.mjs` | **10/10** |
| 临时探针（30/300 seed，用后删） | 见各节读数 |

---

## 1. 逐项：改动的断言是否仍守得住

### 1.1 seed 覆盖门（lib observation×2 / p15）

- **旧判据想守什么**：三种截断形态（① 截断时刻新建 episode / ② restart 未 taken / ③ restart 已 taken）每种都在样本里真的出现；防空转断言要求三类计数都 >0。谓词/豁免条款未动，只换样本 ⇒ 判据仍守得住。
- 新样本：lib `[18,232,456,529,428,508,253,87,109]`（4/2/3）、p15 `[18,428,253]`（1/1/1）。两处测试均绿，防空转断言（三类各 >0）在实跑中通过。
- **产 gap 的截断样本**：旧 `562@120 / 348@400 / 441@700 / 347@300 / 470@120 / 1228@400` 在本树**全部 0 gap**；新样本 `360@400 / 103@900 / 225@450` 各 **1 gap**（临时探针直读 `gap_count()`，见下）。⇒ 「换样本、不换判据」成立。

```text
PROBE gap seed=562 dur=120 gaps=0   seed=441 dur=700 gaps=0   seed=347 dur=300 gaps=0
PROBE gap seed=348 dur=400 gaps=0   seed=470 dur=120 gaps=0   seed=1228 dur=400 gaps=0
PROBE gap seed=360 dur=400 gaps=1   seed=103 dur=900 gaps=1   seed=225 dur=450 gaps=1
```

### 1.2 p124 五门

| 门 | 本审阅实跑读数 | 与注释/RECORD | 判定 |
|---|---|---|---|
| 四臂净化 `[0.301,0.405,0.419,0.500]` | current 0.301 / drop_restart 0.405 / drop_passcount 0.419 / empty 0.500 | 一致（±0.03 钉值） | ✅ |
| bp `forward_m/s` 0.301 | p16 测试打印 0.301；p124 打印 0.301 | 一致 | ✅ |
| 循环行 4→6 | `first_window_frac` 0.917 / `max_window_ticks` 0.059（final_vs_rest，Circular）；同两行在 build_vs_prog 为 0.498 / 0.511（Intent） | 与注释、RECORD 逐字一致 | ✅ |
| `pressure_share` 豁免 | 仅 `drop_passcount[只留是否重开]/pressure_share` 一格 0.334；`current` 0.413 / `drop_restart` 0.522 仍走 0.15 判据；`weak_seen==1` 断言通过 | **只豁免一格**成立 | ✅ |
| 防空转（49/50 构造行） | `probe(49)` 不足 / `probe(50)` 充足 | 门槛=50 被钉住；`min_side=86`（打印）与 RECORD 一致 | ✅（见 P3-3） |
| `window_features...` | `{0:64,1:464,2:116,3:63,4:25,5:13,6:2,7:3,8:1}`；末拍 687/687；全拍 464/751=61.8%；首拍 464/687 | 与注释/RECORD 逐字一致 | ✅ |

- **`gate_rows` 按表 Circular 只影响 final_vs_rest**：实现是 `label == "final_vs_rest" && matches!(spec.name, ...)`；`build_vs_prog` 两表（`verdict_table` 与净化表）仍为 `Intent`——实跑打印证实（0.498/0.511 标 `[Intent]`）。判据成立。
- **`pressure_share` 豁免**按 `arm.name` + `feature` 双等值匹配，且 `weak_seen == 1` 保证它恰好出现一次；其他行仍按 `|Δ|≤0.15`。不会误豁免 `current`/`drop_restart`。

### 1.3 p16（depth 锚与两处 AUC）

- **depth 锚 24.79 与 `viewer/data/benchmark-baseline.json` 一致**：`engine.perMetric.hd.avg = 24.793455673206626`，min/max = 21.3976/28.8566（注释写 [21.40,28.86] ✅）；真实集 Metrica 25.939 / SkillCorner 18.307 ✅。Rust 侧实跑 `mean depth=24.84 m`，落在 `(18.6..=31.0)`（±25% 包围 24.79）✅。
- 基线 `engineFingerprint` = wasm `f6a9f9ec…` / lib `26417dcc…`；当前 `viewer/engine.wasm` sha256 = `f6a9f9ec…`、当前 `engine/src/lib.rs` sha256 = `26417dcc…` ⇒ 注释「由 R6 终版 wasm / lib 生成」**与产物一致**。
- `final_third` **0.729**（pin ±0.03）、bp **0.301**（pin ±0.03）、未归一 **0.616**、时长中位数 **36.5 / 24.5 / 19.5 s**——实跑逐字一致。

### 1.4 p17b（过半→最大类、beat→秒）

- **`loose_runs` 的 beat 是逐 tick 一条**：`loose_runs` 对每条 `Beat && ball.loose && !in_restart_window` 事件 `beats += 1`，遇到任何非 loose-beat 事件即切段；Beat 在开放比赛每 tick 产一条（重开/犯规路径不产 beat 但会先切段）。⇒「1 beat = `TICK_SECONDS` = 0.5 s」成立。
- 换算实跑：**6.430 beat × 0.5 = 3.215 s**（30 seed；与 design 3.02 s 差 +6.5%），落在未改动的 `[2.8,3.3]` 秒带内 ✅。
- **过半→最大类**：30 seed 零时长 1689/3786 = **44.6%**，最大档 `0 ms`（次高 2.5 s 档 1404 = 37.1%）；300 seed 17074/37401 = **45.7%**，最大档 `0 ms`。新判据 `max_dur == 0` 实跑通过；若被别的档反超（含并列，`max_by_key` 取最后最大值）即红。判据仍是结构判据 ✅。
- **90.4% / 9.6%**：300 seed 零时长中「收束一段 episode」= 15434/17074 = **90.4%** ✅（30 seed 1513/1689 = 89.6% ✅）。
- **「729/729」出处错误见 P2-1。**

### 1.5 SHOT_WINDOW_TICKS ↔ 687/687 的因果

`TICK_SECONDS = 0.5`、`TPF = 2`、`SHOT_WINDOW_TICKS = 2×TPF = 4 tick = 2 s`（`engine/src/lib.rs:639/641/758`）。
`window_ticks` 在每个窗口决策 tick +1；提交射门时 `shot_setup = None`，而 `intent_snapshots` 在 `tick()` 返回**之后**采样 ⇒ 射门那一拍不再记 `in_window`，**末个 `in_window` 拍 = 射门前一拍**（+0.5 s = 射门时刻）。实跑 687/687 与该机制一致；若窗口在射门后仍开、或末拍没接射门，断言会红。**注释因果与代码一致** ✅（另见 P3-6 的「最多 4 拍」歧义）。

## 2. 数字出处 / 跨树同名数

- `0.431`（P16 300 seed 旧基线）在 `map.md` / `issues/116` / `issues/124` / roadmap 均有出处；新写的 `0.431 → 0.296` 全部**显式标为「P16 时代」**，没有把它当 R6 值；`0.296`（R6 300 seed）只出现在 p124_baseline 断言与 RECORD，属落盘 note 出处。
- `0.855 / 0.461 / 0.382` 一律标为 P16 / v4 历史值，与新值 0.729 / 0.301 并列——**除 P2-3 指出的 p124 doc 与 counter-proof 锚**。
- 300 seed 的 `17074/37401/15434` 与 30 seed 的 `1689/3786/1513` 全部实跑复核（探针见下）；`13331 = 35.6%（300 seed 次高）`未单列复算，但算术与 30-seed 分布同型。
- `53142 episode`（RECORD，p124_baseline 300 seed）与 `0.296` 一样来自 `#[ignore]` 门，本审阅**按约定未跑**，只能核到：30 seed 同管线 0.301、±0.03 钉值、RECORD 有章节出处。**本仓内不可独立复现这一点应视为已知边界**。
- `2097 runs / 6.43 beat`（30 seed）实跑一致；`20341 runs / 6.53 beat`（300 seed，仅我的探针，非 RECORD 数）。

## 3. 防空转改动是否有判别力

- **49/50 构造行**：不是恒真——把 `MIN_SIDE_FOR_SEPARABILITY` 改成 49 或 40 会分别红在 `probe(49)` / `probe(50)`。它钉的是门槛常量，**不再**钉「数据集里真的存在样本不足行」（旧写法在 2 Hz 下恒红）；`min_side` 现在只打印。这是有意的取舍，RECORD/注释都写明 ✅（残余见 P3-3）。
- **687/687**：由「post-tick 采样 + 射门同拍清 `shot_setup`」机制保证，属真不变量（不是数据巧合）；未来若出现「射门后窗口仍开」或「非窗口路径射门且同 episode 有窗口」，会红。有判别力 ✅。
- **`instant_contest` 最大类断言**：空直方图时 `max_dur` 默认 0，但 ② `zero_closing < zero`（0<0）会先红；`all_contests > 500` 防小样本。无空转 ✅。

## 4. P1 / P2 / P3

### P2（3）

- **P2-1｜`engine/tests/p17b/reasons.rs:193`：729/729 的 seed 口径标错（本 diff 新引入）**
  `P17A 300 seed 实测该成因 729/729 不产 loose beat`——729 是 **30 seed** 的数：
  - 同文件 `:14` 的权威表头明写「30 seed」，表里 `interception_loose 729`；`.scratch/notes/17b-recon-2026-09-30.md:64/98` 明写「30 seed」「729/729（30 seed）」。
  - 本树 300 seed 实测 `interception_loose = 15364`（临时探针），且 HEAD 生成的 `engine/target/p17b-diagnosis/baseline.md:190` 自己就是 `interception_loose | 15364 | … | 追逐不可见`；`:57` 却仍印「实测 729/729」——**产物同页自相矛盾**。
  - 「机制未变」本身成立（300 seed 15364/15364 不可见，产物可证），错的只是「300 seed」这个标号。改法：「P17A 30 seed 实测 729/729（R6 300 seed 机制未变：15364/15364 不可见）」。

- **P2-2｜`engine/tests/p17b/report.rs:1221`：产物把 beat 当秒印**
  `均长 6.43（design §4.4.1 载 946 段 / 均长 3.02）`——6.43 是 **beat**（2 Hz），3.02 是**秒**；HEAD 产物 `engine/target/p17b-diagnosis/canary.md:222` 与 `baseline.md:222` 实文如此。R6 已在测试里改成 `mean_s = mean × TICK_SECONDS`，但**生成器没改**，读者会把 6.43 vs 3.02 读成 2.1× 的口径分叉。修法：产物里同时印 `6.43 beat = 3.21 s`，或直接印秒并注明「design 3.02 s（1 Hz）」。（另：`cr` 是 30/300 seed 的段数，与 design 的 946（30 seed）并列时也有 seed 口径差——这是 v4 起就有的旧账，建议一并标注。）

- **P2-3｜`p124` 的 `final_third` 记录锚未随 R6 重钉，且 doc 与 body 相反**
  - `p124_intent_observations.rs:1256-1260` 的测试 doc 写「① 仍 ≈0.855、≈0.461」「③ `window_opened`/`setup_share` 应强」；body 实际断言 `final_third = 0.764 ±0.05`、`bp = 0.301 ±0.03`，并在 ③ 断言**没有**强意图证据（窗口特征循环）。doc 与 body 方向相反——本仓「doc 声称的机制代码里不存在」家族。
  - `p124/purify.rs:183` `COUNTER_PROOF_EXPECTED = 0.764`；实跑两管线 30 seed 均 **0.729**（p16 测试打印 0.729；p124 打印 `forward_m/s[空间] AUC=0.729`）。本 diff 把 p16 侧重钉为 0.729±0.03 并写「与 p124 同一管线逐位一致」，却没重钉 p124 侧；`|0.729−0.764| = 0.035 ≤ 0.05` 让它**侥幸仍绿**。
  - 影响：join-bug 判别力仍在（0.714 底 ≫ 0.5），但记录值不再代表本树，且 doc 的 0.855 会让读者误以为对照基线还是 P16 值。建议：`COUNTER_PROOF_EXPECTED = 0.729`（同步 p16），doc ①②③ 按 body 重写。
  - 说明：这是**旧文本**，非本 diff 引入；但 `gate_rerun...` 是本 diff 修改的函数，收口时应一并处理。

### P3（6，措辞/陈旧示例）

1. **p15 / `observation.rs` 里陈旧 seed 示例仍以「已复核/实测」现在时出现**：`p15:36/1190/1192/1572/1606`、`observation.rs:5325-5327` 仍写 `470@120 / 1228@400`、`562@120 / 348@400` 产 gap；实测全部 0（同文件 1229/1345 与 5329+ 的 R6 重扫记录已说明失效）。建议把示例改成新 seed 或显式加「R6 前」。
2. **`p17b/episode.rs:615` 的绝对数 `20053` 陈旧**（R6 = 37401）。比例「约 70% / 余下 30%」仍成立（本树 25078/37401 = 67.1%，32.9%），所以**不是**与 90.4% 矛盾（90.4% 是「零时长子集」的分母，两者不同口径）；只需改绝对数并写明两个分母。
3. **p16「这不是放宽」措辞过强**：旧 `auc_final > 0.75`（单侧）→ 新 `0.729 ±0.03` = `[0.699,0.759]`。下限实际从 0.75 降到 0.699（放宽 0.051），换来了上限；「收紧成窄带」只在「新增上限」意义上成立。建议改成「改为以实测基数为中心的窄带（下限较旧 0.75 略低，但新增上限，join bug 仍会红）」。
4. **防空转替代的覆盖缩窄**：`gate_rerun...` 与 `purification_over_intent...` 的 49/50 构造行只钉门槛常量，不再探测数据集组成变化；后者有 `weak_seen == 1` 补回一个数据相关断言，前者只剩打印。已注释说明，记在这里防回归。
5. **loose census 的 runs 贴带上沿**：30 seed `runs = 2097`，带 `[1500,2100]`，余量仅 3（0.14%）；任何轻微改动会红。按本仓「引擎贴着带沿站」的教训，建议注明该余量或按新基数复核带（未要求本轮改）。
6. **RECORD「SHOT_WINDOW_TICKS … 2 s（最多 4 拍）」易被读成「每 episode 最多 4 个窗口拍」**；实测 per-episode 直方图到 8（一个 episode 可开多窗，每个 ≤4 拍）。建议写「单窗口最多 4 拍」。

另记录（不算缺陷）：
- **p124 baseline 产物是 30 seed 报告**（`render_artifacts` 恒用 `GATE_SEEDS` 1..=30，provenance 记 `seed_last=30`），300 seed 的 0.296 只进 stdout/断言，不进产物；沿用 P16 形态，未变。
- **RECORD §4「p16/p17b 同源（p16 记 c1c9ed5…）」措辞**：p17b 产物实际记 `source_commit=f58d37a`（因为它在该提交后重跑过），建议改成「p16 记 c1c9ed5（其后测试源码未变）；p17b 记 f58d37a」。

## 5. 环境前提复核（p124 的 1 红）

`on_disk_artifacts_share_the_current_source_fingerprint` 失败信息：

```text
产物 `target/p124-intent/canary.md` 记的 `worktree_dirty=false`，而真跑 `git status --porcelain` 得 `true`
```

- 本 worktree 的脏来自**预先存在**的 `M .gitignore`（StatsBomb 忽略项）与 4 项未跟踪笔记——均**非本分支**、本轮未提交、也未被我改动（`git status --porcelain` 前后一致）。
- 产物内容与当前源码一致（`test_source_fingerprint` 断言先于脏检查并通过；`source_commit=f58d37a` 是 HEAD 祖先）；RECORD §4 的 1178-1182 行已如实登记这条环境前提。⇒ **该红不是本 diff 的缺陷**；干净 clone/CI（无产物）下该守卫整段跳过。

## 6. 作用域与确定性

- `engine/src/lib.rs` **零改动**（`git diff 0d69c23..HEAD --stat` 不含它）；`engine/src/observation.rs` 的 3 个 hunk 全部在 `#[cfg(test)] mod tests`（自 :3069 起）内 ⇒ 生产路径零改动。
- 确定性：`observation_api_leaves_formal_events_byte_identical` 通过；本 diff 不触碰事件生成，RECORD 的三条事件流哈希前提（lib `26417dcc…`）与 HEAD 一致。
- 基线哨兵 10/10 绿；`viewer/engine.wasm` = `f6a9f9ec…`、`engine/src/lib.rs` = `26417dcc…`，与 `benchmark-baseline.json` 的 `engineFingerprint` 一致。

## 最终判定

**P1 0 / P2 3 / P3 6。** 行为门与重钉值全部按原判据复核通过（实测读数与注释/RECORD 逐一吻合）；三处 P2 都是**记录层**问题：一处 seed 口径标错（本 diff 引入）、一处产物单位混排（beat vs 秒）、一处 p124 记录锚/doc 未随 R6 重钉。建议合入前修 P2-1（一行），P2-2/P2-3 可随本轮或下一轮收口。
