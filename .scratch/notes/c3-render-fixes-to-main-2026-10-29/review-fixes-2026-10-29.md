# 独立审阅修复记录（2026-10-29）

- 输入：`review-independent-2026-10-29.md`（零上下文独立审阅；P0 无、P1 两条、P2 七条）
- 分支：`feat/render-fixes-to-main/2026-10-29`（off `origin/main` = `1c5729d`）
- 本记录的每个数字都带仓内出处：同目录的 JSON/脚本、`engine/` 源码注释，或本文件内可复算的算式。
  外部输入只有审阅原文（同目录已入库）。

## 结论摘要

| 项 | 修复 | 反证（真跑） | 状态 |
|---|---|---|---|
| P1.1 出界 pass 未填拍 + 归因错误 | 出界分支接 `tick_filling_flight`（选项 a）；笔记归因订正 | 真违例 938→0（300 seed）；把分支改回不填拍 ⇒ L2 红 | ✅ |
| P1.2 gm_v10 只守计数 | golden 加 `speed_masked_stream_hash` 列；gm_v10 断言 v9/v10 掩码哈希逐 seed 相同 | `receiver_x + 0.0007` ⇒ 新守卫红（旧守卫只比计数，审阅已证绿） | ✅ |
| P2.1 L2 容差推导漏 speed 量化 | 改为距离空间硬上界 0.06m，推导写进注释 | 见 P2 节 | ✅ |
| P2.2 L2 只查 speed<10（≥9.5m 盲区） | 统一不变量 `距离 ≥ 0.95·speed − 0.06m` 覆盖全部距离 | 填拍常量 0.95→0.80 时首个违例距离 10.79m（旧门不查） | ✅ |
| P2.3 `lib.rs:223` 「当前 = 9」 | 改为 10 | — | ✅ |
| P2.4 开球 `kickoff_end` 归因 | 代码注释写清：`kickoff` 非 pass；填拍只影响整数 tick 恢复判定（两版都是 t+1）与 observation `resumed_t`；事件 speed 恒 12.0、不序列化 | — | ✅ |
| P2.5 基线笔记「2 位小数仅 3 处」 | 订正为 **11 处**并列出 | 复算脚本见 §5 | ✅ |

未处理（原文 P2.5/P2.7 的剩余项，理由见 §6）：C5 的启用率单测、`viewer/game.js:33-41` 的实测数字出处。

---

## 1. P1.1：出界 pass 也接填拍（选项 a）+ 归因订正

### 1.1 代码

`engine/src/lib.rs` 的 `emit_pass_highlight_inner` 出界分支（`detail = out_goal_line /
out_sideline`）此前是**唯一**没调 `tick_filling_flight` 的 pass 分支（其余 10 个 pass
产出点全接了，`grep -n "EventType::Pass" engine/src/lib.rs` 可逐点核对）。现改为
`speed/flight = tick_filling_flight(distance_meters(from_pos,(x2,y2)), speed)`（lib.rs:4010 起，
含「因为 X 所以 Y」注释：不消耗 RNG、不改决策输入；0.95s < 1 拍 ⇒ finalize tick 仍是 t+1）。

选 (a) 而不是豁免：C3 的语义是「所有 pass 的球飞行时长填满一拍」，出界 pass 同样是
viewer 要演的球飞行；豁免会让 `speed` 在 pass 内部出现两种语义，且 L2 的填拍门必须认识
`detail` 例外（更多特判）。

### 1.2 残余复测（300 seed，口径见探针头部注释）

探针：`probe-pass-flight-residuals.mjs`（本目录）——只看 `type === "pass"`（`kickoff`
是 `type === "kickoff"`，天然不在内），距离用序列化后 x/y/x2/y2 × 105×68。

| 口径 | 修复前（`/tmp/review-branch.wasm` = 6ad3542…，`1f3394a` 构建） | 修复后（本树构建 d7b84010…（注释定稿后重建）） |
|---|---|---|
| pass 总数 | 253,813 | 253,813 |
| 原始残余 flight < 0.95−5e-3 | 2,932 | 2,017 |
| ├ 出界 pass（sideline+goal line） | **932**（821+111） | 17（11+6） |
| ├ `(none)` | 1,643 | 1,643 |
| ├ `free_kick` / `throw_in` | 287 / 70 | 287 / 70 |
| **真违例**（`0.95·speed − 距离 > 0.06m`） | **938（全是出界 pass）** | **0** |
| 残余距离 max | 23.2m | 10.2m |
| 残余最坏 \|flight−0.95\| | 0.8889s（seed 291，out_goal_line） | 0.0233s（seed 187） |

原始 JSON：`pass-flight-residuals-prefix-300seeds.json` / `pass-flight-residuals-fixed-300seeds.json`。

**读法（防再次归因错误）**：剩余的 2,017 条**不是**「没填拍」——它们是 `speed` 的
`{:.1}` 序列化量化：填拍后真实 flight 恰为 0.95，但 speed 四舍五入到 0.1 会让复算值
偏到 0.926–0.95。判「是否真违例」必须用距离空间 0.06m 硬上界（= L2 门现在的口径），
不能用「flight < 0.95」这种受 speed 量化影响的原始阈值。

### 1.3 行为等价（掩码证明在修复后重跑）

`probe-masked-speed.mjs /tmp/review-main.wasm <本树 wasm>` → `masked-speed-proof-after-p1fix.json`
（45 seed = 1–40 + 42/99/123/317/1000，5400s）：

- 未掩码流 45/45 不同；**掩码流 45/45 逐字节相同**（`allMaskedEqual=true`）；
- 掩掉 2,165,726 个 speed 字段；
- 掩码实现与 Rust 侧逐字一致（探针改为替换成 `"speed":0`）；golden 的
  `speed_masked_stream_hash` 与 JS 探针 `hashMasked` 在 seed 1–10 逐位相同（交叉核对）

⇒ 出界分支补填拍只改 `speed`：位置/决策/时间戳/计数仍与 main 逐位相同。

### 1.4 变异：把出界分支改回不填拍

`cargo test --release --test realism l2_cross_event_invariants` →
`CARGO_EXIT=101`，`panicked at tests/realism.rs:1347`（速度违例断言），seed 1 即红。
⇒ 修复不再无守卫：L2 的统一下界能抓住「有 pass 分支没接填拍」这一类回归。

### 1.5 归因订正（README §2）

原文「441 条都是开球拨球 + 距离 <0.5m」不成立：① 开球是 `type:"kickoff"`，不在 pass 统计；
② 残余 01 分位距离 2.05m；③ 300 seed 实测 32% 是出界 pass。README 已改为上表口径。

---

## 2. P1.2：gm_v10 守卫加掩码流哈希

### 2.1 实现

- `engine/tests/realism.rs`：新增 `mask_speed_fields()`（把所有 `"speed":<num>` 的数值替换为
  `0`，字段名/其它字段/顺序全保留）与 `MatchStats::speed_masked_stream_hash`
  （`fnv1a(mask_speed_fields(json))`）。
- golden 文件新增一列 `speed_masked_stream_hash`（v10 由本引擎生成；v9 见 §2.2）。
- `gm_v10_is_v9_plus_speed_field_only` 现在断言三件事：28 个计数全同、原始 `stream_hash`
  不同、**v9 与 v10 的掩码哈希逐 seed 相同**。第三条让「位置/时间戳/决策/事件序列」
  的漂移在重基线时无法被洗掉（它们都会改变掩码哈希）。

`lib.rs:242-250` 的过度声明（「v9/v10 基线逐字段相同」挂在只比计数的测试上）已改写：
现在明确写「28 个计数全同 + 原始哈希不同 + 掩码哈希相同」，并注明反证方式。

### 2.2 v9 golden 的掩码列从哪来（provenance）

在 `1c5729d` 的临时 worktree（`/tmp/fm-c3-v9`）打**同一份** helper/字段，跑
`ACCEPT_GOLDEN=1 cargo test --release --test realism gm_canary_seeds`（该树 `MODEL_VERSION=9`）。
核对（`git -C /tmp/fm-c3-v9 diff -U0 -- engine/tests/golden-v9`）：

- 10/10 seed 的 diff **只有一行新增**：`"stream_hash": N` 后加 `,` 与新行
  `"speed_masked_stream_hash": M`；
- 10/10 的计数与原始 `stream_hash` 与旧文件**逐位相同** ⇒ 该列确由 v9 引擎在 v9 流上算出，
  不是拿 v10 的数字倒填。

v9 目录因此不算「被覆盖」：行为/计数/原始哈希一字未动，只补了一列派生哈希（README §3 注明）。

### 2.3 反证：`receiver_x + 0.0007` 变异

`normal_pass_highlight` 的 `receiver_x: Some(rx)` → `Some(rx + 0.0007)`（lib.rs:4207）后：

- `gm_v10_is_v9_plus_speed_field_only`：`CARGO_EXIT=101`，
  `panicked at tests/realism.rs:1744`：
  `seed 1：掩掉 speed 后 v10 与 v9 的事件流不同——出现了 speed 以外的字段漂移…`
- `gm_canary_seeds`：`CARGO_EXIT=101`，`panicked at tests/realism.rs:1636`（流哈希漂移）
- 审阅已证：修复前的旧守卫在该变异下**绿**（review-independent §3.2）；计数断言本身在该变异
  下也绿——红的是新增的掩码哈希条。

变异已用备份还原，`git status` 除本修复外无残留。

---

## 3. P2 逐条

1. **L2 容差推导**：旧注释按「0.03s、最小 speed 0.53」推导，漏了 speed `{:.1}` 量化；
   实测最小 speed 是 1.6，最坏 |flight−0.95| = 0.0247s（审阅 §2.5）。
   新判据改到距离空间：`|距离 − 0.95·speed| ≤ 0.06m`（= 坐标 ≤0.0126m + speed 量化 0.95×0.05
   = 0.0475m，硬上界），注释写全推导与「0.52m 以下跳过」的理由（realism.rs:98-102、591-625）。
2. **覆盖盲区（≥9.5m）**：统一不变量不再按 speed<10 分流；`TICK_FILL_FLIGHT_S → 0.80` 变异下
   首个违例是距离 10.79m 的传球（旧门不会检查它），`CARGO_EXIT=101`、`panicked at realism.rs:1347`。
3. **`lib.rs:223`**：`当前 = 9` → `当前 = 10`。
4. **开球 `kickoff_end` 归因**：见 lib.rs:5956 注释——`kickoff` 不是 pass；填拍结果用于
   `advance_dead_ball` 的整数 tick 恢复判定（原飞行与 0.95 都 <1s ⇒ 恢复 tick 都是 t+1，
   事件流不变）与 observation `resumed_t`（唯一可见差异）；事件 `speed` 恒 12.0、不序列化
   ⇒ viewer 球动画零效果。
5. **基线笔记「2 位小数仅 3 处」**：复算 `git show 1c5729d:viewer/data/benchmark-baseline.json`
   对 `git show HEAD:…`，按 `f"{v:.2f}"` 比较 ⇒ **11 处**：`spread.min`、`gap.min`、
   `ballDist.avg/min`、`ballDistAllFrames.avg/min`、`possessionHome.max`、`elasticity.half.max`、
   `elasticity.centroid.avgDelta/min/max`。README §5 已列。本次 P1.1 修复后又重生成一次基线：
   相对修复前 leaf 变化 20 个、**2 位小数变化 0 个**；指纹更新为
   `wasmSha256=d7b84010…` / `sourceSha256=92991ec4…`。

---

## 4. 复验（最终树）

| 套件 | 结果 |
|---|---|
| `cd engine && cargo test --no-fail-fast`（默认套件，debug） | **EXIT=0，9 个 target 全 `ok`**：lib 201 / p124 35 / p15 11 / p16 36 / p17a 24 / p17b 33 / p18 6 / realism 5（+doc 0），**0 failed** |
| `cd engine && cargo test --release --test realism` | **5 passed / 0 failed / 9 ignored**（含 gm_v10 新断言、L2 新门） |
| `cd viewer && node --test *.test.js` | **398 passed / 0 failed** |
| `node --test tools/benchmark-{baseline,compare,crossvalidation}.test.mjs` | **39 passed / 0 failed** |
| `node tools/benchmark-compare.mjs` | exit 0（不报陈旧） |

⚠️ 记账：修复过程中**第一次**全量跑出现 p16/p17a 两个 target 红。原因是跑动期间我还在改
`engine/src/lib.rs`（注释）：这两个 target 的 fingerprint 测试用 `include_str!`（编译期源码）
对 `std::fs::read_to_string`（运行时磁盘源码）独立重建比对（`tests/p16/report.rs:39`、
`tests/p17a_behavior_chain_baseline.rs:2013`），树在编译与运行之间变脏就必红——这正是该守卫
设计上要抓的「工作树脏」。单跑该两 target 与**树稳定后的第二次全量**都绿；以上表以第二次为准
（日志 `/tmp/cargo-full-final.log`，含每 target 的 `test result`）。

复现命令：

```bash
export PATH="$HOME/.cargo/bin:$PATH"
R=<本 worktree>
(cd $R/engine && cargo build --target wasm32-unknown-unknown --release \
  && cp target/wasm32-unknown-unknown/release/fm_engine.wasm $R/viewer/engine.wasm)
cd $R
node .scratch/notes/c3-render-fixes-to-main-2026-10-29/probe-masked-speed.mjs \
  /tmp/review-main.wasm viewer/engine.wasm        # 需 1c5729d 构建的 wasm（a15c152c…）
node .scratch/notes/c3-render-fixes-to-main-2026-10-29/probe-pass-flight-residuals.mjs \
  viewer/engine.wasm 300
(cd engine && cargo test --no-fail-fast)
```

（`/tmp/review-main.wasm` 的 sha256 = `a15c152c…`，与审阅记录一致；`/tmp/review-branch.wasm`
= `6ad3542…`，即修复前的分支构建。）

## 5. 改动文件

- `engine/src/lib.rs`：出界分支填拍；`MODEL_VERSION` 注释（当前=10、v10 证据改写）；
  `kickoff_end` 归因注释；`tick_filling_flight` 背景数字标「本仓内不可自证＋出处」。
- `engine/tests/realism.rs`：`mask_speed_fields` + `speed_masked_stream_hash`（结构体/聚合/
  golden 读写）；`gm_v10…` 新断言；L2 统一不变量 + 两个容差常量；相关注释。
- `engine/tests/golden-v9/seed-{1..10}.json`：只加 `speed_masked_stream_hash` 一列。
- `engine/tests/golden-v10/seed-{1..10}.json`：重基线（出界填拍 → 原始哈希变；计数逐位不变）
  + 新列。
- `viewer/data/benchmark-baseline.json`：重生成（引擎段微漂 + 指纹）。
- 本目录：`probe-masked-speed.mjs`（掩码与 Rust 对齐）、新增 `probe-pass-flight-residuals.mjs`、
  三份新 JSON 证据、`README.md` 订正、本文件。

**未触碰**：`.gitignore`、`.scratch/notes/goal-loop-r2-acceptance-2026-10-28/`、
`.scratch/notes/probes/`、`.scratch/notes/statsbomb-volume-distribution-2026-10-28.md`、
`.scratch/statsbomb/`。

## 6. 未做的 P2（如实记录）

- **C5 缺「是否真的启用」单测**（审阅 P2.5）：本轮由审阅探针补证（32.6% 调用生效、效应 0.63m）；
  不在本次 P1 修复范围内，未新增单测。
- **`viewer/game.js:33-41` 的实测数字**（22 场真实 tracking 的 3.0°/0.059m 等，审阅 P2.7）：
  仓内未找到对应 note/脚本指针。按「记录数字硬规则」应补出处或标「本仓内不可自证」；
  但改 game.js 会触发 viewer `?v=` 缓存号更新，本轮不混入无关改动——**留作待办**：
  下次改 `game.js` 时一并给 T1 的四个数补出处/标记。
- `engine/src/lib.rs:3472` 的「约 15%」：已在注释里标「本仓内不可自证」，出处为 commit
  `6105407` 的提交信息（实施期盲测选窗统计，未落盘为可复算 note）。
