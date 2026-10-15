# gate-fix 审阅 · 过程记录（2026-10-14）

被审对象：`/tmp/gate-landmines.patch`（249 行，含 commit message）。
审阅树：`/tmp/gate-review` = main `3db023f` + `git apply /tmp/gate-landmines.patch`。
**判决见同目录 `REVIEW.md`。**

## 时间线

- [建树] `git apply /tmp/gate-landmines.patch` → OK（4 文件，121+/14−）。
- [wasm] 本树现构建（24.4s）→ `viewer/engine.wasm` sha256 `b0bc4796…59518f24`
  （sha16 `b0bc479678af53aa` = `p-table-compress-2026-10-14/PROGRESS.md` 记的基线指纹
  ⇒ 确为 main 源码、非 demo 构建）。`engine/src/lib.rs` sha256 `75190e51…f9b3a7a`（未被补丁改动）。
- [单测] `tools/visual-review/like-football.test.mjs` 12 pass / 0 fail。
- [变异 a–d] 全红（命令与原文见 REVIEW §1.3），**无假覆盖**。
- [变异 e] 角球新断言改成 `>= 5` → `panicked at tests/realism.rs:877`（是断言红，非编译错）
  ⇒ 断言是活的；同时暴露 `println!` 文案硬写「≥20/场」而 filter 已是 `>=5`（**日志说谎**）。
- [变异 f]（自加）`formatLossTable` 跳过 report 行 → **12/12 全绿** ⇒
  「仍被打印」**零守卫**，新用例名在过度声明。
- [实跑] like-football 5 seed × 5400s × win12：补丁版 **0.544 [覆盖 8/8]**（`※` 只挂宽度行）
  vs pristine **0.520 [覆盖 9/9]** ⇒ commit message 的 0.520→0.544 **逐位复现**。
- [实跑] `cargo test --test realism --release -- --ignored` → **9 passed**，
  `[corners] max=14 均值=4.83/场 ≥20/场 占比=0/200` —— 与补丁注释逐位一致。
- [探针] `zz_probe_corner_blocks`（`ZZ_BLOCK_START` 参数化，7 进程并行）→ 7 块峰值
  **14/14/13/12/14/11/16**，块 1601–1800 `break_old=1` ⇒ commit message 的序列**逐位复现**；
  合并 1400 场 **var/mean=1.14–1.44**（轻度超散布，Poisson 不成立）→ 这解释了为什么
  「随机红」的解释站不住：max=16 是引擎自身分布的正常尾部，不是噪声。**探针已删**。
- [探针] `tools/visual-review/zz_probe_width.mjs`（**留着，untracked**）→ 引擎 width 逐 90s 窗
  sd=**0.61**（补丁说 ≈0.5 ✓）、真实窗间 sd=**5.95 / 7.16**（补丁说 ≈9 ✗）、
  「有人贴边 11.7%」**复现不出**（定义未知）。
- [实跑] `cargo test --test realism --release`（默认非 ignored）→ `4 passed; 0 failed; 9 ignored`。
- [还原] 三个被改文件与「重新干净应用补丁」的副本 `cmp` **逐位相同**；
  `grep -c zz_probe engine/tests/realism.rs` = 0。

## 机器上另有并发会话（非本审阅）

`/tmp/regress-inside`、`/tmp/reg-c-*`、`/tmp/reg-mutB` 在跑同类 `zz_probe_l3_block`，
`/tmp/gate-fix/verify.sh` 在跑。load 12–13 / 4 核 ⇒ 所有读数只取自本树，耗时不可比，未报耗时。
（踩坑一次：`pkill -f "realism-…"` 的模式匹配到我自己的命令行，把自己 kill 了；
改按 PID kill。）

## 结论落点

- 工具侧（width 降级）：**可合**，建议补「双距离打印」+ 打印路径断言 + 4 处文档注记。
- 门侧（角球护栏）：**不建议按现状合** —— 理由错（「随机红」不成立）、对均值漂移冗余
  （被未动的 `per_match ∈ [1,7]` 吞掉）、且 `openspec/specs/match-engine/spec.md:294-303`
  仍写着 `SHALL ≤ 15`（规格/实现分叉）。建议改 `max_single <= 19`（一行、严格更强）。
