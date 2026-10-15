# 二阶审阅过程记录（v2）

树：`/tmp/gate-review`，HEAD = `b7d041a`（"apply v2"），父 = main `3db023f`。
⚠️ 与简报有出入的一条事实：**补丁只有 1 个 commit**（`git log -2` 只有 `b7d041a` + 父 merge），
不是简报说的 2 个 commit。第一轮的审阅产物（`gate-fix-review-2026-10-14/REVIEW.md` + `PROGRESS.md`）
也在同一个 commit 里。

## 步骤流水

- [0] `git diff 3db023f --name-status`：11 个文件。M: SKILL.md / LANDING.md / CLAUDE.md / realism.rs /
  like-football.mjs / like-football.test.mjs；A: gate-fix-review(PROGRESS,REVIEW) / gate-landmines.md /
  **zz_probe_width.mjs** / **verify.log**。
- [1] 读 v1 审阅报告全文（501 行）、gate-landmines note、like-football.mjs 全文、补丁 diff 全文。
- [2] 环境：`viewer/engine.wasm` 已在本 worktree 现构建（18:34，晚于 checkout 18:32）。
  `node --test tools/visual-review/`（**目录参数**）在本机 **报 MODULE_NOT_FOUND**——
  在原始 change 树 `/tmp/gate-fix` 上**同样报错** ⇒ **非本补丁引起**（node 22 的目录参数行为/quirk），
  正确跑法是 `node --test tools/visual-review/*.test.mjs` → **39 passed / 0 failed**。已记录。
- [3] wasm 来源核验（防「demo 构建」假读数）：`viewer/engine.wasm` sha256 `b0bc4796…59518f24`，
  `engine/src/lib.rs` sha256 `75190e51…f9b3a7a`。committed 基线里的 `engineFingerprint` 记的是**更老**的一对
  （`574b653f…` / `ed9c23f5…`，P143r-v4 时代）⇒ 快路径不成立，但 `node --test tools/benchmark-baseline.test.mjs`
  **10/10 全绿**（走「重算引擎侧指标与基线比对」慢路径，耗时 22.3s）⇒ **本 wasm 行为 == 基线记录的主源码行为**
  （这才是真判据；wasm 文件哈希本仓明令不可作哨兵）。
- [4] realism.rs 逐行核：把两版去注释/空行后 diff，**唯一代码差异 = 新增 1 行 `println!`**（1098 → 1099 行）。
- [5] 红线：`engine/src/lib.rs`（sha256 同父提交）、`viewer/data/benchmark-baseline.json`（sha256 同父提交）未动；
  `engine/` 下只有 `tests/realism.rs` 一个文件被改。
- [6] 变异 a–f（必红）+ g/h/i（我自加）——见 REVIEW.md §2。全部用 python 精确串替换，
  **每次跑完用 sha256 校验还原**（`e4556a36…` 两次一致）。
- [7] 实跑 `like-football.mjs viewer/engine.wasm 5 12`：新口径 **0.544**、旧口径对照 **0.520**、
  `[覆盖 8/8 行]`、宽度行 `1.38 / 0.32` 带 `※` ⇒ 与补丁声称逐位一致。
  另写 `/tmp/v2rev/caliber.mjs` 拿未舍入值算双口径：新 0.5444491、旧 0.5199745、
  `(8·新 + |ln(49.7285/35.9597)|)/9` 与旧值**差 0（精确）**。
- [8] L1 `cargo test --test realism --release -- --ignored --nocapture`（后台）——
  已见 `[corners] 单场峰值 max=14（界 15，余量 1）均值=4.83/场`，等全套结束。
- [9] 7 个 200 场块探针：`engine/tests/zz_probe_blocks.rs`（realism.rs 的**副本** + 追加探针，
  保证被审文件零污染），跑完即删。
- [10] 陈旧引用全仓 grep —— 见 REVIEW.md §4。

- [11] L1 全套跑完：`9 passed; 0 failed`（283.32s），`[corners] … max=14（界 15，余量 1）均值=4.83/场` ✓。
- [12] 7 块探针跑完（735s，10 passed）：峰值 **14/14/13/12/14/11/16**、`break_old` 只在 1601–1800 = 1、
  逐块 var/mean ∈ [1.138, 1.442]、**pooled 1400 = 1.294**、`ge20 = 0/1400`、`ge16 = 1/1400`。
  ⇒ 注释的四条事实全部复现；只有「1400 场**合计** var/mean = 1.14–1.44」是**措辞**问题（那是逐块范围）。
- [13] 跑他们自己提交的 `zz_probe_width.mjs`：90s 窗 46.85–51.01（≠ 注释写的 48.9–50.1，后者是 300s 窗/基线值）；
  **发现该探针的 `touchlineShare()` 按 `p.team` 过滤，而帧里没有 `team` 字段 ⇒ 恒 0**（真实数据也报 0.00%，
  我手工复算 <4m 全体球员 = **52.03%**）。
- [14] 结构事实核验：`grep width engine/tests/realism.rs` = 0 命中；spec 无队形宽度 requirement
  ⇒ **全仓没有第二个门/带管横向尺度**；committed 真实 width 逐窗 25.17–46.38、引擎 49.73（高于上沿）。
- [15] 交付 `REVIEW.md`；删 `engine/tests/zz_probe_blocks.rs`；`git status` 只剩本 notes 目录；
  被审两文件 sha256 与 HEAD 逐位相同（`e4556a36…` / `e625b704…`）。

## 未核清（已写进 REVIEW.md §7）

- 「真实贴边 11.7% → 0.03%」：两轮都复现不出（我用探针定义得 52.03%）。
- 「真实 width sd ≈ 9 m」：我三种口径分别是 5.95/7.16（90s 窗间）、10.3/11.2（逐帧）、4.45/5.72（300s 窗间）——9 落不进任何一格。
- 完整 `verify.sh` 九步未跑（只跑了 cargo L1 全套 + visual-review 39 条 + benchmark-baseline 10 条）。
