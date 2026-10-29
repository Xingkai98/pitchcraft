# C3 合入 main 的验证 + 重基线（2026-10-29）

分支：`feat/render-fixes-to-main/2026-10-29`（三个提交都 cherry-pick 自 `feat/in-box-shot-priority-2026-10-28`）：

| 提交 | 内容 | 改动面 |
|------|------|--------|
| `0854fda` | C5 球员锚点跨拍转角平滑（Catmull–Rom） | `viewer/game.js`（事件流零改动） |
| `6105407` | C3 传球飞行上报时长填拍 `TICK_FILL_FLIGHT_S=0.95` | `engine/src/lib.rs`（只改事件 `speed` 字段与内部 `t_end`） |
| `0306cad` | T1 拍内纹理弓（垂直弦，sin² 包络） | `viewer/game.js` + `viewer/app.js`/`index.html` 的 `?v=` |

基线：`origin/main` = `1c5729d`（本分支 off 它）。

## 1. 默认套件红集对比

- **main base**（临时 worktree `/tmp/fm-main-base` checkout `1c5729d`，验证后已删除；`cargo test --no-fail-fast`）：
  **全绿，0 红**（9 个 target 全 `test result: ok`）。
- **分支重基线前**（同命令）：3 条红
  1. `p15_behavior_observation::recorder_on_and_off_reproduce_the_golden_canary_stream` — golden 流哈希（预期重基线）；
  2. `realism::gm_canary_seeds` — golden 流哈希（预期重基线）；
  3. `realism::l2_cross_event_invariants` — **pass speed 下界 `[10,25)`**。C3 把短传上报速度改为
     `距离/0.95`，短传必然 < 10（seed 1 有 61 条，最低 2.30 m/s）⇒ 这是**协议字段语义变化**，
     不是行为退化。
- 其余 target（lib 201 / p124 35 / p16 36 / p17a 24 / p17b 33 / p18 6）逐条与 base 一致、全绿。

## 2. 掩 speed 流哈希证明（C3 在 main 上位置/决策逐位不变）

做法：main wasm（`/tmp/fm-main-base` 构建）与本分支 wasm（`viewer/engine.wasm`）对同 seed 集各跑
`match_duration_seconds=5400`，把事件流 JSON 里所有 `"speed":<num>` 替换为 `"speed":MASK` 后**逐字节**
比较；同时记录未掩码哈希作为反证。

脚本与原始输出（本目录）：

```bash
node .scratch/notes/c3-render-fixes-to-main-2026-10-29/probe-masked-speed.mjs \
  <main-wasm> viewer/engine.wasm > masked-speed-proof.json
```

结果（`masked-speed-proof-wide.json`，45 seed = 1–40 + 42/99/123/317/1000）：

- 未掩码流：45/45 **全部不同**（`allRawDiffer=true`，证明 speed 改写确实落盘）；
- 掩码流：45/45 **逐字节相同**（`allMaskedEqual=true`），共掩掉 **2,165,726** 个 speed 字段；
  45 个掩码哈希两两不同（无坍缩，防「全掩成常量导致假等价」）；
- 飞行时长：branch 有 **14,954** 条 pass 的 `距离/speed ≈ 0.95s`（改写面），
  仍 < 0.95s 的从 main 的 15,347 降到 **441** 条（45 seed 口径）。
  ⚠️ **归因订正（2026-10-29 独立审阅 P1.1）**：原文把 441 条说成「开球拨球 + 距离 < 0.5m」是
  **错的**——① 开球事件类型是 `"kickoff"`，根本不在 `type === "pass"` 统计里
  （`kickoff_end` 的填拍只喂观察层 `resumed_t`，事件 speed 恒 12.0、不序列化）；
  ② 残余的 01 分位距离是 2.05m，不是 <0.5m；③ 300 seed 实测（`probe-pass-flight-residuals.mjs`
  输出 `pass-flight-residuals-prefix-300seeds.json`）：原始口径残余 2,932 条，**其中 932 条
  （32%）是出界 pass**——`emit_pass_highlight_inner` 的出界分支当时是唯一没接
  `tick_filling_flight` 的 pass 分支。其余 2,000 条是 `speed {:.1}` 序列化量化噪声
  （距离空间偏差 ≤0.06m），不是「没填拍」。
  修复见 §3b（出界分支已补齐填拍）。

⇒ **C3 在 main 上不改变任何位置/决策/时间戳/计数；唯一的差异面是 `speed` 字段。**

⚠️ 2026-10-29 修复时探针的掩码替换由 `"speed":MASK` 改为 `"speed":0`（与 Rust 侧
`mask_speed_fields` 逐字一致，这样 JS 的 `hashMasked` 才能与 golden 的
`speed_masked_stream_hash` 逐位对拍）。已核对：seed 1–10 两套实现逐位相同。
`masked-speed-proof-wide.json` 是**旧替换**的产物，其 `hashMasked` 与新脚本不可逐位对拍；
判据（`allRawDiffer` / `allMaskedEqual` / 计数）不受替换文本影响。修复后的重跑见
`masked-speed-proof-after-p1fix.json`（45/45 `allMaskedEqual=true`、45 个掩码哈希两两不同）。

## 3. golden 重基线（按仓惯例 bump 版本，不覆写旧目录）

- `MODEL_VERSION` **9 → 10**；`golden_dir()` 加 `10 => "tests/golden-v10"`；
  `ACCEPT_GOLDEN=1 cargo test --test realism gm_canary_seeds` 生成 `tests/golden-v10/seed-{1..10}.json`。
  `tests/golden-v9/` 原样保留（仓惯例：P27/P29/P30/P31/P34/M5 都是「旧目录不覆写」）。
- **v10 vs v9 逐 seed 核对**：10/10 的**全部计数逐位相同、只有 `stream_hash` 不同**——这正是
  「只改协议字段值」的签名，也是本次重基线没有把行为漂移洗进基线的证据。
- 新增常跑门 `realism::gm_v10_is_v9_plus_speed_field_only`：逐 seed 断言 v10 与 v9 的
  计数全同且哈希不同（防止未来重基线把行为变化伪装成字段变化）。
  **2026-10-29 审阅 P1.2 加固**：原版只比计数 + 「哈希不同」，看不见位置类字段漂移
  （审阅用 `receiver_x + 0.0007` 反证：旧守卫照绿）。现在 golden 文件多一列
  `speed_masked_stream_hash`（掩掉所有 `"speed":<num>` 数值后的事件流 FNV-1a），本测试断言
  **v9 与 v10 的这一列逐 seed 相同**。v9 目录的该列由 `1c5729d` 的引擎生成：10/10 seed 的
  计数与 `stream_hash` 与旧文件逐位相同，diff 只有新增一行（证据见 §9）。
- `p15` 的 golden 锚会跟着 `MODEL_VERSION` 自动读 `golden-v10`，重基线后转绿。

## 3b. P1.1 修复：出界 pass 也接填拍（2026-10-29）

`emit_pass_highlight_inner` 的出界分支（`detail = out_goal_line / out_sideline`）此前是唯一
没调 `tick_filling_flight` 的 pass 分支。修复后：

| 口径（300 seed，`probe-pass-flight-residuals.mjs`） | 修复前 | 修复后 |
|---|---|---|
| pass 总数 | 253,813 | 253,813 |
| 原始残余（flight < 0.95 − 5e-3） | 2,932 | 2,017 |
| 其中出界 pass | **932**（821 边线 + 111 底线） | 17（全是量化噪声） |
| **真违例**（`0.95·speed − 距离 > 0.06m`） | **938**（全是出界 pass） | **0** |
| 残余距离 max | 23.2m | 10.2m |

残余的 2,017 条全部落在 `speed {:.1}` 量化容差内（最坏 |flight−0.95| = 0.0233s），
不是「没填拍」。位置/决策/时间戳仍逐位不变：掩 speed 后与 main 逐字节相同的 45 seed 证明
在修复后重跑仍成立（`masked-speed-proof-after-p1fix.json`，`allMaskedEqual=true`）。
L2 门已改写为覆盖该分支的统一下界（见 §4），变异反证：把出界分支改回不填拍 ⇒ L2 红。

## 4. L2 pass-speed 门的改写（2026-10-29 审阅后重写）

原判据：`spd ∉ [10,25)` 记违例（编码的是「生成器原始速度」语义）。
C3 后 `speed` 对短传变成「填拍等效速度」，下界必须随语义重写——但**不把下界放宽**，改成守住改写自身：

> 对任何落点可验、距离 ≥ 0.52m 的 pass：`距离 / speed` 必须 ≥ **0.95s − 0.06m/speed**；
> `speed ≥ 25` 仍记违例。

等价的距离形式：`距离 ≥ 0.95 × speed − 0.06m`。依据：`tick_filling_flight` 在
「原飞行 < 0.95s 且距离 ≥ 0.5m」时把 speed 改写成 `距离/0.95`，否则保持原速（原飞行 ≥0.95s），
故**无论填没填**都有 `speed ≤ 距离/0.95`。

容差是距离空间的**硬上界**（旧版写「0.03s、由坐标量化推得 ≤0.024s」漏了 speed 自身的量化，
推导不成立）：坐标 4 位小数 ⇒ 距离误差 ≤0.0126m；`speed {:.1}` ±0.05 ⇒ 0.95×0.05 = 0.0475m；
合计 ≤ **0.06m**。距离 < 0.52m 跳过（0.5m 填拍守卫 ± 坐标量化在边界上不可判）。
旧版残留的两个覆盖盲区一并关掉：① 只查 `speed < 10`（≥9.5m 的快速传球该填却未填时不查）；
② 出界分支（§2b）。实测余量：300 seed 真违例 0，最坏量化偏差 0.0233s。

反证（变异测试，真跑）：
- `TICK_FILL_FLIGHT_S: 0.95 → 0.80` ⇒ `CARGO_EXIT=101`，`panicked at tests/realism.rs:1347`，
  首个违例 `pass speed 13.50 未填拍（复算 flight 0.800s…距离 10.79m）`——注意这条距离
  >9.5m，旧门根本不会检查；改回 0.95 转绿。
- 出界分支改回「不填拍」⇒ 同样 `panicked at tests/realism.rs:1347`（exit 101）；还原后转绿。

## 5. P36 比赛标尺基线重生成

C5/T1 改了 **viewer 插值层**（球员平滑/纹理）与 C3 改了球飞行时长 ⇒ 经 `Game.seekTo` 采样的
引擎侧队形指标有微小漂移，`tools/benchmark-baseline.test.mjs` 的「源码指纹」慢路径因此红
（main 上因源码哈希未变走快路径，是绿的）。按官方脚本重生成：

```bash
node tools/benchmark-baseline.mjs
```

diff 核对：**只有 `engine` 段与 `engineFingerprint` 变**（17 个指标摘要 + 5 个 perSeed），
`datasets`（真实侧）逐位未动。

**数字订正（2026-10-29 审阅 P2）**：原文「2 位小数下变化仅 3 处」只在 README 表（5 个指标）里成立；
**基线 JSON 全量 leaf 值里 2 位小数变化共 11 处**：`spread.min`、`gap.min`、`ballDist.avg/min`、
`ballDistAllFrames.avg/min`、`possessionHome.max`、`elasticity.half.max`、
`elasticity.centroid.avgDelta/min/max`（复算：`git show HEAD:viewer/data/benchmark-baseline.json`
对 `git show 1c5729d:…`，按 `f"{v:.2f}"` 比较；脚本输出见 §9 修复记录）。

本次 P1.1 修复后**再次**重生成基线（出界 pass 的 `speed` 变 → 球飞行动画采样点微移）：
leaf 值变化 20 个、**2 位小数变化 0 个**（相对本分支修复前；相对 main 仍是那 11 处）。
`engineFingerprint.wasmSha256 = d7b84010…`、`sourceSha256 = 92991ec4…` 与当前树一致。
D3 分离结论未破（hd/spread/gap 的引擎 min 仍高于真实 max）。

## 6. 其余验证（分支最终态）

| 检查 | 结果 |
|------|------|
| `cargo test --no-fail-fast`（最终红集，见 §7） | 见下 |
| `viewer`: `node --test *.test.js` | 398 pass / 0 fail |
| `viewer/e2e-v2.mjs` | OK：6285 事件，4 seed 无 snap（球 0.0075 / 球员 0.0348） |
| `tools`: `node --test *.test.mjs` | 536 pass / 0 fail（重生成基线后） |
| `tools/visual-review`: `node --test *.test.mjs` | 53 pass / 0 fail |
| `node tools/spacing-sweep.mjs` | 0 findings（4 seed × 2157 窗） |
| `node tools/benchmark-compare.mjs` | exit 0（不报「陈旧」） |
| `?v=` 缓存版本号 | `index.html` 的 `<script src="./app.js?v=20261028-1">` 与 `app.js` 的 `./game.js?v=20261028-1` **两处都已 bump**（T1 提交 `0306cad` 一并改了这两处；C5 只改 game.js，被 T1 的 bump 覆盖） |

## 7. 分支最终红集

重基线 + 门改写后的最终一轮 `cargo test --no-fail-fast`：**0 红**（9 个 target 全 `ok`；
`realism` 现在 5 passed = 原 4 条 + 新增 `gm_v10_is_v9_plus_speed_field_only`）。
补跑 CI 第 7 步 `cargo test --test realism --release -- --ignored`：**9 passed / 0 failed**。
⇒ 最终红集 = main base 红集（∅）+ 0。

**2026-10-29 审阅修复后复跑**（`cargo test --no-fail-fast`，debug）：**EXIT=0，9 个 target 全 `ok`**
（lib 201 / p124 35 / p15 11 / p16 36 / p17a 24 / p17b 33 / p18 6 / realism 5，0 failed）。
⚠️ 跑全量期间不要改 `engine/src`：p16/p17a 的 fingerprint 测试用 `include_str!`（编译期）对
磁盘源码（运行期）独立重建比对，树在编译与运行之间变脏会红（本修复期间实测过一次，
树稳定后复跑全绿；详见 `review-fixes-2026-10-29.md` §4）。

## 8. 未触碰

`.gitignore` 的既有改动、`.scratch/notes/goal-loop-r2-acceptance-2026-10-28/`、
`.scratch/notes/probes/`、`.scratch/notes/statsbomb-volume-distribution-2026-10-28.md`、
`.scratch/statsbomb/` —— 全部未发生任何改动、未 git add。
