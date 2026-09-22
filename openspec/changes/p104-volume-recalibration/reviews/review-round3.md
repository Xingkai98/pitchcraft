# 实现审阅（round 3，收尾轮）—— #104 体积重标定 @ `a9eb958`

> 独立零记忆审阅者（第 3 轮）。**只验证一件事**：round2 的 7 条 MINOR 修复是否真落地、以及
> 修复过程中声称的「新坑（§D0b）」是否属实、是否已清除、是否还有同型残留。
> **不重新论证 change 价值**（前两轮已做）。
>
> 全部结论在**隔离 worktree**（`/tmp/r3-p104` detach 到干净 main `6f5827f`、`/tmp/r3b-p104`
> detach 到 `a9eb958`）与**本 worktree** 双重实测，机械扫描为主、肉眼为辅。
> 收尾：两个隔离 worktree 已删；本 worktree `git status --porcelain` 只剩 `.scratch/*` 未跟踪；
> `viewer/engine.wasm` 未被我改动（仍 `fb201b59`）。
>
> ⚠️ **审阅期间 HEAD 前移**：从 `a9eb958`（我评审的对象）→ **`3ab79d8`**（并发写入者提交的
> progress/tasks 状态更新，只改 `.md` 状态行，**不碰源码/门/wasm**）。本报告结论按
> **修复提交 `a9eb958`** 计；`3ab79d8` 的内容我核过，见文末。

---

## 总评

**可以交付。** round2 的 7 条 MINOR **内容全部修对**（我逐条实测复核，含 `16.38/10.98`
与 `±32.74%→[0.80,1.58]` 两处当场重算），§D0b 的**新坑真实存在且已彻底清除**（我模拟复现 + 机械扫源），
端到端 **9 步全绿 / L1 9 绿 / cargo test 129p0f**。

**唯一遗留全部是「文档层」的小瑕疵，零行为/零门影响**：本轮修复**自己引入**了两处 markdown
反引号破损（m1 的替换没做干净）、`§D0b` 把 `realism.rs` 误列为同类扫描测试的宿主（实为 0）、
三处行号引用仍在且**现已漂**、以及一处「当前交付 = `824644da`」已陈旧（现交付 `fb201b59`）。

**问题计数：BLOCKER 0 / MAJOR 0 / MINOR 5（其中 2 条为本轮修复自身引入）。**

---

## 逐条核验表（round2 的 7 条 MINOR）

| # | round2 说 | 我的核验 | 判定 |
|---|---|---|---|
| **m1** | `lib.rs:7514` 应为 7517 | 交付源码**已不再引行号**：`design.md` 改引**函数名** `p28_action_deadline_formula` + 断言文本 `compute_action_deadline(9.0,9.0,9.0)==5`。函数确在 `lib.rs:7485`；断言确在 `lib.rs:7523`（`assert_eq!(compute_action_deadline(9.0, 9.0, 9.0), 5);`）——**引用正确**。⚠️ 但替换把两处 markdown 弄坏（见 **new-1**） | **内容已修 / 引入格式缺陷** |
| **m2** | 注释指向不存在的 `design.md` §D11 | 全文 `§D11` → **0 命中**。`lib.rs` 里另两处 `D11`（:2376 `松散球（D11）`、:3909 `开始松散球（D11）`）是 **P4 松散球决策**，不指向 `design.md`——**按任务书不算**。该引用随 M1 注释重写消失 | **已修** ✅ |
| **m3** | §D0 机制命名不准（非「调试行号表」） | `design.md:48-55` 现写：交付 wasm **无任何 `.debug_*` 段** + ① `data` 段 `panic!` 的 `Location{file,line,col}` 静态常量 ② `name` 段 LLVM 内容哈希。**「无 `.debug_*`」这句我独立验证**：自写 wasm section 解析器 → 段清单 = `type…code, data, custom×3`，三个 custom 是 `name / producers / target_features`，**`debug_*` = 0** ✅ | **已修** ✅ |
| **m4** | `realism.rs` 三处「第 5 步」 | `realism.rs:8 / :622 / :1434` 三处**全改「第 7 步」**；`verify.sh` 的 L1 步确为 **7/9**（`=== 7/9 真实性统计套件 L1`） | **已修** ✅ |
| **m5** | 9+ 处 `file.rs:NNNN` 行号漂移 | **声明范围（design/proposal/progress/tasks）内 = 0 命中** ✅。**但 scope 外仍有残留且已漂**（`grill-design.md:82`、`notes/probes/out/FINDINGS-exploration.md:86-88`）——见 **new-3**。`notes/user-decision-round2-*.md:15` 是冻结史料（round2 已豁免，处置正确）；`grill-verification-round2.md:66` 的 `realism.rs:544-548` 我实测**仍指对**（`dist` 计算段） | **声明范围内已修 / 有 scope 外残留** |
| **m6** | `13b0263a` 标签不全 | `lib.rs:586-588` **已写明**「= `6f5827f` 源码 + 三条常量」+「带 `MODEL_VERSION=6` 与改动前的两条测试」+「为何行为仍等价（那两条在测试模块内不进产物、`MODEL_VERSION` 不参与模拟）」——**与 round2 建议逐字同** ✅。⚠️ 但 m6 的**原始出处** `design.md` §D0 表格行（`:61`）与正文（`:77`）**未同步**，仍作「无注释构建」——见 **new-5** | **部分修（落 `lib.rs`，`design.md` §D0 未同步）** |
| **m7** | §D4.2 出处指针找不到那两个数 | `design.md:272-276` 出处 = `notes/probes/big-sample.mjs` + **200 场** + 口径（`pass` 无 `to` 且无 `lead` 且 `subject∈{0,21}`）+ 警示「别拿 `p13` 的 println 对账（宽松口径，打 16.47）」。**我按该口径当场复现**：交付 wasm 200 场（401..600）→ `goalKicksPerMatch=16.380`、`cornerMean=3.19`；干净 main（我重建 `901da77b`）→ **200 场 `10.975`**、3000 场 `11.268`。**逐位吻合** ✅ | **已修** ✅ |
| **m8** | 算术滑 −32.7%/+33.6% | `realism.rs:903` + 两份 spec 现写「两翼**对称**，各 **±32.74%**」、派生带 **`[0.80, 1.58]`**。**我自己算**：`0.185/0.565 = 32.743%`；`1.188×(1−0.3274)=0.7990→0.80`、`1.188×(1+0.3274)=1.5770→1.58` ✅。且 `realism.rs:906` 的「下 −28.5% / 上 +34.7%」我也复核：`(1.188−0.85)/1.188=28.45%`、`(1.60−1.188)/1.188=34.68%` ✅ | **已修** ✅ |

---

## §D0b 的新坑：独立验证（本轮的**重点**）

任务书要我验三件事，逐条给结论：

### 1. §D0b 的描述**准确**吗（哪三条测试、为什么红）？

**三条测试的名字与宿主正确**：`p31_slot_layer_is_gone`（`lib.rs:9275`）、
`p31_landing_error_only_in_open_play_passes`（`:9556`）、`p31_liveness_section_never_emits_events`
（`:9659`）——三条**都在 `lib.rs`**，且都用 `include_str!("lib.rs")` +
`src.split("#[cfg(test)]").next()` 截取生产段。

**「为什么红」我模拟复现**：把字面量 `#[cfg(test)]`（连同中文说明）注入 `lib.rs` 的
`OPEN_PLAY_SHOT_ENGAGE_SHIFT` 注释区（≈:595，正是 M1 注释所在），`split` 在 :595 提前截断 →
生产段只剩前 595 行。三条同时红，且**红法与我预测一致**：

| 测试 | 红在哪 |
|---|---|
| `p31_slot_layer_is_gone` | **反证定位断言** `prod.contains("fn tick(")` 失败——`fn tick(` 在 `:2502`，被截掉 |
| `p31_landing_error_only_in_open_play_passes` | 代码行里 `sample_pass_landing(` 命中数 **0**（应为 2） |
| `p31_liveness_section_never_emits_events` | `prod.find("==== P31 liveness guard")` 找不到 → **区段定位缺失** panic |

生产代码本身**不变**（`sed 's://.*::'` 后逐行比对 = 空），纯注释改动却红——§D0b 的机理表述
（「注释里的字面量会被算进扫描」）**成立**。

> ⚠️ **一处措辞不准**：§D0b 开头写「**`lib.rs` / `realism.rs`** 里有几条测试扫描自己的源文件文本」。
> **`realism.rs` 里根本没有这类测试**——`grep include_str! realism.rs` = 0，
> `grep 'cfg(test)' realism.rs` = 0；它唯一的文件读取是 `read_to_string` 读 **golden 基线 JSON**
> （`tests/golden-v7/seed-*.json`），既不读 `.rs` 源码、也与注释文本无关。
> §D0b 把一个只存在于 `lib.rs` 的守卫安到了两个文件上。见 **new-2**。

### 2. 当前源码里确实没有这个陷阱了吗？

**是，已彻底清除。** 机械扫描（自写脚本，不靠眼看）：

- 全文件字面量 `#[cfg(test)]` 共 **5 处**：第 1 处（char 230617）是**真正的测试模块属性**，
  另 4 处全在测试模块**内部**的源码字符串里（那正是三条测试自己要 `split` 的东西）；
  **生产段（char 0..230617）内 = 0 处**。
- 生产段完整性三连（对齐三条测试的判据）：`prod.contains("fn tick(")` = **true**；
  `sample_pass_landing(` 代码行命中 = **2**；liveness 区段标记存在且 `fn liveness_profile` 在段内。
- 三条测试的**全部**被扫 token 我逐个核过（见下），**生产段内均无违规**。

### 3. 本票新增/修改的注释里，有没有**其它**被扫 token？（机械扫，不信实现者自述）

我先把三条测试的**完整 token 清单**读出来（不采信实现者列的）：

| 测试 | 被扫 token | 扫法 |
|---|---|---|
| `p31_slot_layer_is_gone` | `HIGHLIGHTS_PER_MATCH` / `SLOT_HOLD_MIN_TICKS` / `SLOT_AVG_EVENT_TICKS` / `slot_hold_max` / `slot_clock` / `slot_interval` / `roll_fallback_situation` / `FallbackSituation` / `FallbackDeadline` / `SlotFallback` / `emit_pass_out_play_slot` / `CornerDirect` / `PASS_BREAK_TICKS`（**13 个**）+ 反证 `fn tick(` | `!prod.contains(sym)` |
| `p31_landing_error_only_in_open_play_passes` | `sample_pass_landing(`（**仅代码行**） | 命中数须 == 2 |
| `p31_liveness_section_never_emits_events` | 区段内 `events.push` / `emit_` / `Vec<Event>` / `Event {`；**另** 6 个函数体内（`liveness_profile` / `forward_intent_pp` / `note_meaningful_action` / `resolution_is_meaningful` / `action_deadline_for` / `carrier_move`）的 `events.push` / `emit_` | `!section.contains` / `!body.contains` |

**脚本结果（本 worktree，HEAD `3ab79d8` 源码）**：
- 13 个槽位符号：生产段 **0 命中** ✅
- `sample_pass_landing(` 代码行：**2** ✅
- liveness 区段：4 个 forbidden **0 命中**；6 个函数体：2 个 forbidden **0 命中** ✅

**另**：`realism.rs` 无任何源码扫描测试（见上），故它本轮改的注释（三处步号 + m8 一带）
**不可能**被这类守卫生成红；且我用 grep 核过其新增行不含任何被扫 token。

**⇒ §D0b 的坑真实、已清除；本轮注释无其它被扫 token。**（唯一瑕疵是 §D0b 把 `realism.rs`
误列为宿主，见 new-2。）

---

## 新发现（本轮修复自身引入 / round2 未覆盖）

### new-1（**本轮引入**，格式）m1 的替换把两处 markdown 反引号弄坏

**证据**：`design.md:219` 现为
```
   ``p28_action_deadline_formula`（断言 `compute_action_deadline(9.0,9.0,9.0)==5`）` 硬编码 `== 5`）。同样是机制性的、与种子无关。
```
开头多了一个反引号（`` `` ``），整行的 Markdown 行内代码配对被打乱——`p28_action_deadline_formula`
到行尾的渲染会串味。`a9eb958` 之前该行是正常的两处 `` `lib.rs:7514` ``，替换时**漏删了原开引号**。

`reviews/grill-verification-round2.md:18` 更明显（原为 `engine/src/lib.rs:7514`）：
```
| 确认：`engine/src/`p28_action_deadline_formula`（断言 `...`）` 硬编码 `assert_eq!(...)`（...）| ✅ 吻合 |
```
替换只吃掉了 `lib.rs:7514`，**留下悬空的 `engine/src/`**，读起来像「`engine/src/` + `p28_action_deadline_formula`」
——而 `engine/src/` 不是文件。这两处是**引用正确性**这条主线上的新破损。

**建议**：`design.md:219` 删去多余的开引号；`grill-verification-round2.md:18` 把
`engine/src/` 一并删掉（或整句改写成「`engine/src/lib.rs` 里 `p28_action_deadline_formula`
断言 `compute_action_deadline(9.0,9.0,9.0)==5`，硬编码 `== 5`」）。

### new-2（§D0b 自身）「`lib.rs` / `realism.rs`」——`realism.rs` 并无同类扫描测试

见上 §D0b 第 1 条。**证据**：`grep -n 'include_str!\|cfg(test)' engine/tests/realism.rs` → **0 命中**；
它只 `read_to_string` golden JSON。**建议**：把 §D0b 的「`lib.rs` / `realism.rs`」改为「`lib.rs`」，
并可加一句「`realism.rs` 无此类守卫，故改其注释不受影响」以免后人误防。

### new-3（round2 m5 的 scope 外残留）三处行号引用仍在，且**现已漂**

`m5` 声明范围（design/proposal/progress/tasks）已清零，但**同型引用**在下列两文件仍在，
且本 change 已把它们推偏：

| 位置 | 现文本 | 现实际在 | 父提交 `6f5827f` |
|---|---|---|---|
| `reviews/grill-design.md:82` | `realism.rs:1047-1058`（「重扫历史注释」） | :1047 现为 `let n = SEEDS_L1 as f64;`（**无关代码**） | :1047 = `/// seed 失效 → 重扫取 26/41/57/59`（曾对） |
| `notes/probes/out/FINDINGS-exploration.md:86` | `realism.rs:684` | 射门带断言现移 **:695**（:684 已是注释） | :684 ✅ 曾对 |
| 同上 `:87` | `realism.rs:846` | 主队带断言现移 **:900 附近**（:846 已是注释） | :846 ✅ 曾对 |
| 同上 `:88` | `realism.rs:779` | 角球硬上界现移 **:842**（:779 已是注释） | :779 ✅ 曾对 |

**为什么算问题**：`FINDINGS-exploration.md` 的头部**自称「自动生成，不要手改数字——重跑探针再生成」**，
它记录的 `realism.rs:NNNN` 是**探针输出的一部分**，本 change 的源码改动使其失效——**要么重跑探针、
要么把这三行转成函数名/断言文本**。`grill-design.md:82` 同属「grill 报告」，与 round2 已修的
`grill-verification-round2.md` 同类，本轮**漏掉**了。
**建议**：`FINDINGS-exploration.md` 按函数名重写那三行（或在头部注明「行号按写就时点，已漂」）；
`grill-design.md:82` 改引测试名 `l2_sent_off_kickoff_seeds` 的定向 seed 重扫注释。

> **两条我不算问题**（与 round2 一致）：`notes/user-decision-round2-*.md:15` 的 `lib.rs:5986`
> 是**用户拍板当时的逐字冻结记录**，不应回改；`grill-verification-round2.md:66` 的
> `realism.rs:544-548` 我实测**仍指对**。

### new-4（陈旧）`design.md:65` 的「`824644da`（当前交付）」已过期

**证据**：`design.md:65` 写「…→ `67515c05`（round1 修复）→ **`824644da`（当前交付）**」；
但**当前交付** = `progress.md:10` 明写的 **`fb201b59`**，也是 `viewer/engine.wasm` 与
`benchmark-baseline.json` 的 `wasmSha256`（我实测三者一致 = `fb201b59…`）。
`824644da` 是 `807abe7`/`cb2fbaf` 时的交付哈希，`a9eb958` 又改了一次注释后它就陈旧了。
**为什么算问题**：这与 §D0 自己那条告诫**同型**——「当前交付」是**自指哈希**，每改一次注释就过期；
`design.md:65` 恰好踩了它警告的坑。**建议**：把「（当前交付）」改为中性措辞
（如「（round2 修复前）」），或干脆只保留到 `67515c05` 并注明「此后每次改注释都会变，
**当前交付以 `progress.md` / 基线 `engineFingerprint` 为准**」。

### new-5（m6 未落到其引用处）`design.md` §D0 仍把 `13b0263a` 说成「无注释构建」

**证据**：m6 的原始指控对象是 §D0。`a9eb958` 已在 **`lib.rs:586-588`** 补全标签（正确），
但 **`design.md:61`** 的表格行仍写 `| 三常量，**无** #104 注释块 | 13b0263a | … |`、
**`design.md:77`** 仍写「本票 §D3.4/§D4 的读数实测于 `13b0263a`（**无注释构建**）」——
都没提 `MODEL_VERSION=6` 与两条旧断言。读者只看 §D0 仍会以为「删注释即得 `13b0263a`」。
**为什么算问题**：不是「数值错」（`13b0263a` 的读数是真读数），而是 m6 想消除的**误导**在
其指名处仍在。**建议**：把 `design.md:61` 的标签行与 `:77` 的括注补成与 `lib.rs` 一致的
「`6f5827f` 源码 + 三常量（`MODEL_VERSION=6`、两条测试仍旧版）；行为与交付构建逐位相同」。

---

## 已验证、未发现问题的部分（支撑「可交付」）

1. **本轮修复是纯注释改动**（行为等价）：`b244bab` vs `a9eb958`，`lib.rs` 与 `realism.rs`
   的「去注释 + 去空行」逐行比对 **= 空**。
2. **行为等价独立坐实**：我自写探针（`simulateStream` 逐 seed 原始 JSON 拼接后 sha256），
   **60 seed 流哈希**：交付构建 `fb201b59` = **`44599dcead734d86`**，
   `a9eb958` 重建构建（`fb201b59`）= **同一值**，事件数 **350210** 逐同；
   干净 main `901da77b` = `47f2cad45c0966ef`（不同 hash，349684 事件——因为常量不同，
   **符合预期**）。即「本轮只改注释、行为不变」**成立**。
3. **交付 wasm 可从源码重建**：隔离 worktree detach 到 `a9eb958` 重建 → **`fb201b59`**，
   与提交的基线 `wasmSha256`（`fb201b59…`）**逐位一致** ✅。
4. **基线指纹自洽**：`benchmark-baseline.json` 的 `sourceSha256` = `a553235d…` =
   当前 `engine/src/lib.rs` 的 sha256（我实测）✅；`wasmSha256` = `fb201b59…` = 重建产物 ✅。
   基线哨兵 `node --test tools/benchmark-baseline.test.mjs` → **10/10 绿**（含第 9 条引擎源指纹哨兵）✅。
5. **端到端全绿**（我在本 worktree 全量重跑）：`./verify.sh` **9 步全绿、exit 0**，其中
   `cargo test` **129p/0f**、Viewer **389/389**、Tools **499/499**、E2E v2 无 snap、
   spacing-sweep `player_overlap=0`、**L1 九门 9p/0f**、判据组 6/6。第 6 步比赛标尺
   报「漂移 **+0.0%**」→ 佐证基线**已按当前 wasm 重生成**（不是陈旧基线）。
6. **spec 一致性**：delta 与主 spec 的 M2 那条 `**AND**` 块（含本轮改的 `±32.74%` / `[0.80,1.58]`）
   我逐行 diff = **IDENTICAL**；`npx openspec validate --all --strict` → **10/10** ✅。
7. **`engine.wasm` 未被审阅动作污染**：我全程只在隔离 worktree 里重建，本 worktree 的
   `viewer/engine.wasm` 收尾仍 `fb201b59`；`git status --porcelain` 只剩 `.scratch/*`。

---

## 我没能验证的边界（如实）

- **§D0b 的「历史红」是模拟复现，不是复跑当时的红**：我按机理注入字面量 token 复现了三条同红，
  但**没有**当时那份（含 token 的）`lib.rs` 可跑——机理与「三条同时红」吻合，**结论可靠**，
  但严格说「当时确实红过这三条」我是**由机理推出**，非有历史构建为证。
- **并发提交 `3ab79d8`**：只改 `progress.md` / `tasks.md` 的状态行（**零源码/零门/零 wasm**），
  我核过 diff；`lib.rs` 在 `a9eb958` 与 `3ab79d8` 之间**无变化**，故我的全部源码侧结论对它成立。
- **跨数据集可比性 / 判据组的独立重跑 / 看图复核**：不在本轮范围（round2 已记录其边界），未做。
- **`13b0263a` 的逐位重建**：round2 已逐位复现，本轮**未重做**（非本轮修复对象）。
- **CI/分发现场是否产出同一 wasm**：与前两轮同，环境所限无法验证。

---

## 给归档前的建议（按成本排序，都不阻塞交付）

1. **new-1**（两处反引号破损）——各一行，**建议在归档前修**（这是「引用正确性」主线上的新破损）。
2. **new-2**（§D0b 的 `realism.rs` 措辞）、**new-5**（§D0 表格行补 `MODEL_VERSION`）、
   **new-4**（`当前交付` 改中性）——各 1–2 行。
3. **new-3**（`grill-design.md:82` 与 `FINDINGS-exploration.md` 三行）——建议改引函数名；
   `FINDINGS` 那三行若走「重跑探针」成本高，可在头部加一句「行号为写就时点、已随本票漂移」。

---

## 并发与当前树状态（收尾实测）

- 我评审对象 = **`a9eb958`**（round2 的 7 MINOR 修复 + §D0b）。
- 收尾时 HEAD = **`3ab79d8`**（并发写入者的 progress/tasks 状态更新；`git log` 可见其
  只动两个 `.md`，`tasks.md` 把 P6.1–P6.4 勾选、P6.5（本收尾轮）留空——**与本报告结论不冲突**）。
- `viewer/engine.wasm` = `fb201b59`（未变）；`git status --porcelain` 仅 `.scratch/*`。
