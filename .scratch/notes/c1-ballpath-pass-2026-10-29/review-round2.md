# C1-ballpath-pass · 独立审阅 Round 2（2026-10-29，复审修复提交）

审阅者：零上下文独立审阅（只读；所有变异已还原）。
审阅目标：`3592774 fix(review): Round 1 审阅修复——config 单实例、掩码流自证、填拍同步断言、标定注释对齐`。
delta 范围：`git diff 9abc7b0..3592774`。
审阅时点：HEAD 在审阅期间先为 `3592774`，后被并行进程推进到 `15fcf1e chore(notes): 删除中间态 summary-2judges`（仅删一个 notes 文件）；工作树出现**未提交**的 `viewer/index.html` 版本号改动（见 P2-R2-1）。本报告结论钉在 `3592774`；并行改动未审，只在相关条目注明。

## 结论

- **P1：0 条。**
- **P2：1 条（本轮新发现）**——P2-R2-1：`viewer/index.html` 未随 `app.js` 内容改动 bump 版本号（`3592774` 的修复链在浏览器缓存面不完整；审阅时工作树已有未提交的 `20261029-2`，需确认入库）。
- **上轮 P2-1 / P2-2 / P2-3 / P2-4：全部验证修复**（逐条证据见下）。
- 上轮 P3：6 条已修/接受、2 条维持「接受·残余风险」，另有 4 条新 P3（注释精度/测试完备性，不阻塞）。

已实跑（本机、HEAD 树）：

| 命令/探针 | 结果 |
|---|---|
| `cargo test --release --test realism gm_` | **4 passed** |
| `cargo test --release --test realism l2_pass_fill_constant_matches_engine_tick` | **1 passed** |
| `cargo test --release --lib c1_shot_bucket_probabilities_are_pinned` | **1 passed** |
| `node --test viewer/*.test.js` | **401/401** |
| `node viewer/e2e-v2.mjs` | **OK**；`[EVENT` 调试行 **0**；max jump 球 **0.0161** / 球员 **0.0301**（修复前 0.0305/0.0368） |
| `node --test tools/benchmark-baseline.test.mjs` | **10/10** |
| 事件流哈希：验收 wasm（`ca99edfd`，pre-fix）vs HEAD wasm（`e80dc134`） | seed 42/7/601 **逐位相同**（`14bccb4a…` / `813de9da…` / `c4871bf2…`） |
| 从 HEAD 源码重建 wasm | `e80dc134…`，与 `viewer/engine.wasm` **相同** |
| `/tmp/probe-fillres.mjs` | `passes=7155 worst=-0.02823m (seed 11) violations=0` |
| `/tmp/probe-determinism.mjs` | seed 42/7/601 两次运行哈希相同 |
| 变异：golden-v11 seed-1 `speed_masked_stream_hash` +1234567 | `gm_canary_seeds` **FAILED**（panic = 掩码流哈希漂移，left/right 见下）；已还原 |
| 变异：`PASS_FILL_FLIGHT_S = 0.95*0.4` | `l2_pass_fill_constant_matches_engine_tick` **FAILED**（0.38 vs 0.475）；已还原 |
| `l2_cross_event_invariants`（300 seed） | **1 passed**（257.43s）；填拍门在整段 300 seed 上无违例 |

---

## P1

无。

---

## P2

### P2-R2-1（新）：`viewer/index.html` 的 `app.js?v=` 未 bump —— 修复链在浏览器缓存面不完整

- 位置：`viewer/index.html:537`（`<script type="module" src="./app.js?v=20261029-1">`）；`viewer/app.js` 在 `3592774` **有内容改动**（`:8-16`，renderer 说明符 `?v=20260913-1 → ?v=20261029-1`，另加顶部注释）。
- 证据：

```bash
git diff --stat 9abc7b0..3592774 -- viewer/app.js viewer/index.html
#  viewer/app.js | 7 ++++---
#  （index.html 无改动）
git show 3592774:viewer/index.html | grep 'app.js?v='
#  <script type="module" src="./app.js?v=20261029-1"></script>
```

- 影响：`app.js` 的 URL 与 `8f730a0` 起完全相同，已加载过旧版本的浏览器会继续用**旧 app.js**；旧 app.js 仍 import `renderer.js?v=20260913-1`，而旧 renderer 又 import 裸 `./config.js`——**P2-1 修的二实例链在缓存客户端上原样复现**。这也直接违反 CLAUDE.md 第 4 条「改 JS 后必须更新 `?v=`（含每一处 import specifier），忘改视为遗漏」。
- 最小修法：`viewer/index.html` 改为 `app.js?v=20261029-2`（同日序号 +1）。
- **并发注记（审阅时点）**：工作树中已有**未提交**的同一修复（`viewer/index.html` → `20261029-2`，`git diff` 可见）。它不在 `3592774` 里；合并前须确认该改动被提交，并再查一遍「改动的模块 → 所有引用处版本号」链条。
- 备注：`renderer.js` 自身的链是完整的——`app.js` 对它的说明符已 bump 到 `?v=20261029-1`（旧 URL 是 `?v=20260913-1`，属新 URL，不会命中旧缓存）。缺的只是入口 `app.js`。

---

## 上轮 P2 的修复复核

### P2-1：config 双实例 —— **已修**

- `viewer/` 内全部 `from './config.js…'` 说明符统一为 `?v=20261029-1`（11 处：`app.js:9`、`game.js:10`、`interpretation.js:5`、`renderer.js:4`、`derive-audit-features.js:15`、`visual-probe.js:16`、`e2e-v2.mjs:4`、4 个 `*.test.js`）；`grep` 无裸 `./config.js` 残留。
- 行为证据：`node viewer/e2e-v2.mjs` → `[EVENT` 调试行 **0 条**（修复前刷屏）；无 snap 读数 **0.0161/0.0301**（修复前 0.0305/0.0368）——说明 `debug.enabled=false` 与 `skipThresholdSeconds=Infinity` 真正作用于 `Game`。
- `node --test viewer/*.test.js` → **401/401**。
- 余留：入口版本链见 P2-R2-1（不是配置链本身的问题）。

### P2-2：v11 掩码流自证 —— **已修且可判别**

- 新增断言：`engine/tests/realism.rs:1659-1689`（`gm_canary_seeds` 内 `assert_ne!(gold.speed_masked_stream_hash, 0)` + `assert_eq!(gold…, st.speed_masked_stream_hash)`）。
- 变异复现（已跑、已还原）：把 `engine/tests/golden-v11/seed-1.json` 的 `speed_masked_stream_hash` +1234567 → `gm_canary_seeds` **FAILED**：

```
panicked at tests/realism.rs:1685: assertion `left == right` failed: seed 1：掩码流哈希漂移…
  left: 410543833820339502
 right: 410543833819104935
```

  `git checkout`/备份还原后 `git diff -- engine/tests/golden-v11` 为空；未变异时 `gm_` 4 passed。
- 上轮「golden 不含流、只能改哈希」的语义不变；现在该列与当前引擎值绑定，不再可任意伪造。

### P2-3：`PASS_FILL_FLIGHT_S` 同步断言 —— **已修且可判别**

- 新增测试：`engine/tests/realism.rs:1327-1345`（`l2_pass_fill_constant_matches_engine_tick`）；`PASS_FILL_FLIGHT_S == 0.95×TICK_SECONDS`（`:1331-1337`）并检查容差覆盖 speed 量化项（`:1339-1342`）。原注释改为指向该测试（`:100-102`）。
- 变异复现（已跑、已还原）：把常量改成 `0.95*0.4` → **FAILED**：

```
panicked at tests/realism.rs:1331:
测试侧的填拍时长 0.38s 与引擎 0.95×TICK_SECONDS=0.475s 不同步…
```

- 2 Hz 实测余量：`/tmp/probe-fillres.mjs` → `passes=7155 worst_residual_m=-0.02823 (seed 11) violations_below_-0.04=0`，与 RECORD R6「填拍门余量」行（`.scratch/notes/RECORD.md:1044`）**逐项一致**。
- L2 行为门：`cargo test --release --test realism l2_cross_event_invariants` → **1 passed**（257.43s，300 seed；`speed_violations` 为空）。
- 小残余（P3-R2-3）：容差断言只覆盖 `FILL×0.05`（0.02375），未含坐标量化 0.0126（`realism.rs:1340`）；推导总和 0.0364 → 0.04。方向上是「更严」不会漏 bug，但若未来把 EPS 改到 0.03（>=0.02375 但 <0.0364）该测试仍绿而门会误红——建议断言 `>= FILL*0.05 + 0.0126` 或直接钉 0.04。

### P2-4：标定常量注释与代码 —— **已修（当前值均在位，且有出处/钉值）**

逐项核对（`engine/src/lib.rs`）：

| 项 | 代码 | 当前注释 | 判定 |
|---|---|---|---|
| `OPEN_PLAY_SHOT_ENGAGE_SHIFT` | `-4.2`（`:848`） | R5c 段「−4.50 → **−4.20（当前取值）**」`：845-847` | ✓ |
| `BASE_DEF_TACKLE` | `-1.47`（`:489`） | 「当前取值是 **−1.47**」`:485-488`，旧 −0.92 论证被明确标为「那一代」 | ✓ |
| `BASE_DEF_FOUL` | `-0.30`（`:526`） | 「当前取值是 **−0.30**」`:523-525` | ✓ |
| `CLINICAL_GOAL_PP_HOME` | `0`（`:881`） | 「当前两通道均关闭（= 0）」`:878-880` | ✓ |
| `shot_bucket` | `(7,48)/(2,32)/(1,14)`（`:7142-7149`） | 「当前取值 …」段 `:7135-7141`；`emit_shot_highlight` 行内也改为 7/48 等 `:4727` | ✓ |
| `shot_bucket` 钉值 | — | 新测试 `c1_shot_bucket_probabilities_are_pinned`（`:10818-10830`）；实跑 **1 passed**；`p29_distance_quality_reuses_shot_bucket_bands` 也 green | ✓ |

- 出处核验：注释引用的 `3cab5f9` / `ca889fc` 两个提交对象**存在且确实改过对应常量**（`git show 3cab5f9 -- engine/src/lib.rs`：`BASE_DEF_TACKLE -0.92→-1.47`、`BASE_DEF_FOUL -0.22→-0.30`；`ca889fc`：`CLINICAL_GOAL_PP_HOME 2→0`、shot_bucket 加 `(7,48)`）。RECORD R0「机制现状 #3」含同一组常量。
- 残余精度问题（P3-R2-1/R2-2，见下）。

---

## delta（9abc7b0..3592774）新问题审查

### 行为不变的说法 —— 用事件流哈希核验（不引 wasm 文件哈希）

- 静态：`git diff 9abc7b0..3592774 -- engine/src/lib.rs` 共 70 条增删行，**非注释行仅 7 条，全部是新测试 `c1_shot_bucket_probabilities_are_pinned` 内部**（脚本判定：`changed=70, non-comment=7`）。生产代码零改动。
- 动态：用两个 wasm 各跑 seed 42/7/601（`/tmp/r2-stream-hash.mjs`，对 `get_json_ptr` 的**原始 JSON 字节**取 sha256）：
  - 验收包 wasm `ca99edfd…`（pre-fix，lib 240f6900） vs HEAD wasm `e80dc134…`（lib e822c2bb）：**三 seed 逐位相同**
  - `14bccb4ab2f66b42` / `813de9da86b8c93b` / `c4871bf28386e604` —— 与 RECORD `:959-963` 的记录**一致**。
- 另从 HEAD 源码重建 wasm：`target/.../fm_engine.wasm` sha256 = `e80dc134…`，与 `viewer/engine.wasm` 相同 ⇒ 行为核验用的就是 HEAD 源码的构建（文件哈希只用于确认构建对应关系，不作为行为证据）。
- 基线：`viewer/data/benchmark-baseline.json` 相对 9abc7b0 只改了 `engineFingerprint` 两行（e80/e822），指标未变；`benchmark-baseline.test.mjs` **10/10**。

### viewer 说明符统一后的遗漏检查

- `grep -rn "from './config.js" viewer/*.js viewer/*.mjs` → 11 处全部带 `?v=20261029-1`，**无裸 config import**。
- `app.js` 对 `renderer.js` 的说明符已 bump（`?v=20260913-1 → ?v=20261029-1`），renderer → config 也已版本化；renderer 的浏览器链完整。
- **唯一遗漏是入口 `app.js` 自身的 `?v=`**（P2-R2-1）。
- 测试/工具里仍有裸的 `./renderer.js` / `./game.js` import（`renderer.test.js`、`micro-motion.test.js`、`tracking-e2e.test.js`、`visual-probe.js`），但它们在 Node 下与 `config?v=` 同实例（测试均绿），不是浏览器路径。
- 新注释「传递依赖也带 `?v=`（v11 起统一）」（`app.js:6-7`）字面上过度：`geometry.js` / `micro-motion.js` / `protocol.js` 等仍是裸路径；实际统一的是 **config 链**。建议改成精确措辞（P3-R2-4）。

### RECORD / 验收产物一致性

- RECORD 新增：两代 wasm 行为同（`:959`）、e2e 读数（`:975-977`）、填拍余量（`:1044`）、Round 1 闭环（`:1048`）、残余缺口（`:1065`）。
- 三裁判汇总存在于 `acceptance/summary.json`（sonnet 33.3% / opus 50.0% / fable 54.2%，mean 45.83%；opus 的 mixed 负控判错 → balanced 0.5）——RECORD `:1073`「字面 ≤0.55 ×3；sonnet 反转；opus 负控 mixed 判错（50%）」**逐项对上**。中间态 `summary-2judges.json` 已被 `15fcf1e` 删除（在 3592774 之后、不在本次 delta 内）。
- `viewer/data/benchmark-baseline.json` 与 `engine/src/lib.rs`（e822c2bb）、`viewer/engine.wasm`（e80dc134）三哈希一致；`node --test tools/benchmark-baseline.test.mjs` 10/10。

---

## 上轮 P3 的表态

| 上轮 P3 | 本轮状态 | 表态 |
|---|---|---|
| P3-1 tick 单位注释（SHOT_DRIVE/PRESSURE_HOLD/DEADLINE/LIVENESS/FOUL_GAP/CARRIER_SPEED） | 已改（`lib.rs:540/648/734/1037/1331/2726/3618`） | **接受（已修）** |
| P3-2 `tick_filling_flight` 的 finalize 时刻注释 | 已改为「t_end = t + 填充时长，其后第一个 tick 边界 finalize」（`:3632-3633`） | **接受（已修）** |
| P3-3 L2 余量读数出处 | RECORD `:1044` 已落盘 8 seed/7155 pass/最坏 −0.02823；本审阅用 `/tmp/probe-fillres.mjs` 复算一致 | **接受**；残余风险：探针只在 `/tmp`，未入库——建议把探针落到 note（不阻塞） |
| P3-4 RECORD 缺验收结果 | RECORD `:1073` 已记录三裁判结果；`summary.json` + `judges/r6-{sonnet,opus,fable}.json` 自洽 | **接受（已修）** |
| P3-5 缓存版本号不完整 | config 链已全量统一；renderer 链已补；**app.js 入口遗漏** | **升级为 P2-R2-1**；其余接受 |
| P3-6 2 Hz Catmull–Rom 邻窗 `[0.5,1.5]`（fill 锚点 0.475 落窗外） | 未改，仍在 `game.js` 注释与 RECORD 残余缺口 #3 | **接受·残余风险**（需视觉验收时覆盖） |
| P3-7 抢断 `tContact/tLoose` 钳制（`carrierMoveDur>0.45s` 时同时间戳双锚点） | 未改；4 seed 实测 `carrierMoveDur=0`，当前不可达；RECORD 残余缺口 #3 已记 | **接受·残余风险** |
| P3-8 ratchet noiseTol 由带内噪声外推 | 未改；RECORD 残余缺口 #5 已记 | **接受·残余风险** |

## 新 P3（不阻塞）

1. **P3-R2-1 注释出处精度**：`OPEN_PLAY_SHOT_ENGAGE_SHIFT` 新段「R5c 读数 regular **19.6–23.1**/场」把两个时代的读数并成一个区间：19.6 是 **V1**（RECORD `:765`），23.1 是 **R5c**（RECORD `:889`）。建议写成「V1 19.6 → R5c 23.1」。
2. **P3-R2-2 `shot_bucket` 文档首行仍是旧值**：`:7100`「禁区内 15/30、禁区弧 3/22、远射 2/11」没有行内历史标记；当前值在 `:7135-7141` 且该段写明「与上文 M5 时代相比」。结论正确，但 skim 首行会读到旧值——建议首行直接写当前值，历史段移到下方。
3. **P3-R2-3 `l2_pass_fill_constant_matches_engine_tick` 的容差断言只覆盖 speed 量化项**（`realism.rs:1340`，0.02375），未含坐标项 0.0126；见 P2-3 的说明。方向是更严（会误红而非漏检），建议补全推导式。
4. **P3-R2-4 `app.js` 注释「传递依赖也带 `?v=`（v11 起统一）」过度概括**（`app.js:6-7`）：实际只统一了 config 链；`geometry.js`/`micro-motion.js`/`protocol.js` 仍是裸 import。建议按事实改写（或真的统一全部，但那会扩大改动面）。

---

## 复现命令清单

```bash
# P2-R2-1（入口版本链）
git diff --stat 9abc7b0..3592774 -- viewer/app.js viewer/index.html   # 只有 app.js
git show 3592774:viewer/index.html | grep 'app.js?v='                  # 20261029-1（应为 -2）

# P2-1
grep -rn "from './config.js" viewer/*.js viewer/*.mjs                 # 11 处全带 ?v=20261029-1
node viewer/e2e-v2.mjs                                               # 0 条 [EVENT；max jump 0.0161/0.0301
node --test viewer/*.test.js                                         # 401/401

# P2-2（变异；已还原）
python3 - <<'PY'
import json;p='engine/tests/golden-v11/seed-1.json';d=json.load(open(p));d['speed_masked_stream_hash']=(d['speed_masked_stream_hash']+1234567)%(2**64);open(p,'w').write(json.dumps(d,indent=2))
PY
engine/target/release/deps/realism-* gm_canary_seeds                    # FAILED（掩码流哈希漂移）
cp /tmp/r2-seed1-v11.json engine/tests/golden-v11/seed-1.json          # 还原

# P2-3（变异；已还原）
#   PASS_FILL_FLIGHT_S = 0.95 * 0.4 → cargo test --release --test realism l2_pass_fill_constant_matches_engine_tick
#   → FAILED 0.38 vs 0.475；git checkout -- engine/tests/realism.rs 还原
node /tmp/probe-fillres.mjs                                           # 7155 / -0.02823（seed 11）/ 0 violations

# 行为不变（事件流哈希）
(cd engine && cargo build --target wasm32-unknown-unknown --release)
sha256sum engine/target/wasm32-unknown-unknown/release/fm_engine.wasm # e80dc134… == viewer/engine.wasm
node /tmp/r2-stream-hash.mjs                                          # seed 42/7/601 SAME（对原始 JSON 字节取 sha256）

# 门禁
(cd engine && cargo test --release --test realism gm_)                # 4 passed
(cd engine && cargo test --release --lib c1_shot_bucket_probabilities_are_pinned)  # 1 passed
node --test tools/benchmark-baseline.test.mjs                         # 10/10
```

## 审阅边界

- `l2_cross_event_invariants`（300 seed）已跑完：**1 passed / 257.43s**（填拍门 + 跨事件不变量在整段 seed 集上无违例）。「行为不变」同时由「静态仅注释/测试 + 3 seed 原始事件流哈希逐位相同」支撑。
- 未重跑 L1 200 场（长跑）；本轮修复不触及生产代码（静态已证），L1 不受影响。
- 未做视觉验收；P3-6/7 的视觉残差仍是已知风险。
- 审阅期间工作树被并行进程改动（HEAD 3592774→15fcf1e；`viewer/index.html` 未提交 bump）；P2-R2-1 的结论以 `3592774` 为准，合并前请以最新树复核。
