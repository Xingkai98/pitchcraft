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
  仍 < 0.95s 的从 main 的 15,347 降到 **441** 条 —— 它们都是**开球拨球**（引擎有意只拉长
  `kickoff_end`、事件 speed 保持 12.0）与距离 < 0.5m 的传球（不改写）。

⇒ **C3 在 main 上不改变任何位置/决策/时间戳/计数；唯一的差异面是 `speed` 字段。**

## 3. golden 重基线（按仓惯例 bump 版本，不覆写旧目录）

- `MODEL_VERSION` **9 → 10**；`golden_dir()` 加 `10 => "tests/golden-v10"`；
  `ACCEPT_GOLDEN=1 cargo test --test realism gm_canary_seeds` 生成 `tests/golden-v10/seed-{1..10}.json`。
  `tests/golden-v9/` 原样保留（仓惯例：P27/P29/P30/P31/P34/M5 都是「旧目录不覆写」）。
- **v10 vs v9 逐 seed 核对**：10/10 的**全部计数逐位相同、只有 `stream_hash` 不同**——这正是
  「只改协议字段值」的签名，也是本次重基线没有把行为漂移洗进基线的证据。
- 新增常跑门 `realism::gm_v10_is_v9_plus_speed_field_only`：逐 seed 断言 v10 与 v9 的
  计数全同且哈希不同（防止未来重基线把行为变化伪装成字段变化）。
- `p15` 的 golden 锚会跟着 `MODEL_VERSION` 自动读 `golden-v10`，重基线后转绿。

## 4. L2 pass-speed 门的改写（不是放宽）

原判据：`spd ∉ [10,25)` 记违例（编码的是「生成器原始速度」语义）。
C3 后 `speed` 对短传变成「填拍等效速度」，下界必须随语义重写——但**不把下界放宽**，改成守住改写自身：

> 凡 `speed < 10` 的 pass，其由序列化字段（x,y,x2,y2）复算的 `距离/speed` 必须 ≈ **0.95s**（容差 0.03s，
> 由坐标 4 位小数量化误差推得 ≤0.024s）；`speed ≥ 25` 仍记违例。

反证（变异测试）：把 `TICK_FILL_FLIGHT_S` 临时改成 `0.80` 后
`cargo test --release --test realism l2_cross_event_invariants` **立即红**，报
`pass speed 7.30 <10 但不是 tick-fill（复算 flight 0.798s，want 0.95±0.03）`；改回 0.95 后转绿。

## 5. P36 比赛标尺基线重生成

C5/T1 改了 **viewer 插值层**（球员平滑/纹理）与 C3 改了球飞行时长 ⇒ 经 `Game.seekTo` 采样的
引擎侧队形指标有微小漂移，`tools/benchmark-baseline.test.mjs` 的「源码指纹」慢路径因此红
（main 上因源码哈希未变走快路径，是绿的）。按官方脚本重生成：

```bash
node tools/benchmark-baseline.mjs
```

diff 核对：**只有 `engine` 段与 `engineFingerprint` 变**（17 个指标摘要 + 5 个 perSeed），
`datasets`（真实侧）逐位未动。2 位小数下变化仅 3 处（见 README 的 2026-10-29 同步注）。
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

## 8. 未触碰

`.gitignore` 的既有改动、`.scratch/notes/goal-loop-r2-acceptance-2026-10-28/`、
`.scratch/notes/probes/`、`.scratch/notes/statsbomb-volume-distribution-2026-10-28.md`、
`.scratch/statsbomb/` —— 全部未发生任何改动、未 git add。
