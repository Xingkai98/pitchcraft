# 独立审阅：render 修法合入 main（2026-10-29）

- 审阅者：零上下文独立审阅（未参与实现，未复用实现者的读数）
- 范围：`feat/render-fixes-to-main/2026-10-29`（off `origin/main` = `1c5729d`），4 个 commit：
  `0854fda`（C5）、`6105407`（C3）、`0306cad`（T1）、`1f3394a`（重基线 + 门改写 + 证据）
- 方法：先读代码再下结论；**两端 wasm 均由本审阅者从对应 commit 现构建**；证明重跑并与入库产物逐 seed 对哈希；
  变异测试真跑（看 `panicked at` + 目标测试名，排除编译失败）；viewer 做 main-vs-分支同事件流差分。
- 总判：**未发现 P0**。C3 的「掩 speed 后逐字节相同」证明**复算为真**；L2 门是语义改写且**非空转**；
  但发现 **2 个 P1**（C3 覆盖/归因、gm_v10 守卫强度）与若干 P2（容差推导、陈旧文档、数字出处）。

---

## 1. C3「掩 speed 流哈希逐位一致」：真

### 1.1 复算结果（本审阅者自建 wasm，未用实现者的 wasm）

- main wasm：`git worktree add --detach /tmp/fm-main-review 1c5729d` 后构建 →
  `sha256 a15c152cf9696a91768cfb2995d811f77a7a2aff5f5dcb02e6fe36ed673df352`
- 分支 wasm：当前 HEAD 构建 → `sha256 6ad3542070b77c3d12438b59993f6f620d43ababd4a4f4dbe2bc08110f705c9b`
  （与 `viewer/data/benchmark-baseline.json` 的 `engineFingerprint.wasmSha256` 逐位一致 ⇒ 证明所用 wasm 确由当前源码构建）
- 重跑 `probe-masked-speed.mjs`（45 seed = 1–40 + 42/99/123/317/1000，5400s）：

| 项 | 结果 |
|---|---|
| 未掩码流不同 | **45/45** |
| 掩码后逐字节相同 | **45/45** |
| 45 个掩码哈希两两不同 | **45/45**（防「掩成常量」假等价） |
| 掩掉的 `"speed"` 字段总数 | **2,165,726** |
| 与入库 `masked-speed-proof-wide.json` 逐 seed 对拍 | `hashRawMain/hashRawBranch/hashMasked` **0 处不一致** |

⇒ 证明脚本与产出是真的，不是事后手写结论。

### 1.2 `flight/t_end` 是否独立漂移

- `Event::to_json`（`engine/src/lib.rs:157-230`）**不序列化 `t_end`/`flight`**；`speed` 是 `{:.1}`。
  内部 `t_end` 确实从 `t+flight_old` 变为 `t+0.95`（`lib.rs:3481`），但两者的首个 `t >= t_end`
  整数 tick 都是 `t+1`（`lib.rs:3387-3390` 的 finalize 只在整数 tick 比较），且 0.95 < 1，
  跨 tick 的长传（原飞行 ≥0.95）不改写。掩码流 45 seed × 5400s 逐字节相同 ⇒ 事件层无独立漂移。
- 更严的一步（本审阅者加的）：掩码证明把 **所有** `"speed"`（pass 顶层 + beat 的 `movers/main/ball.speed`）
  一起掩掉了，可能藏住「非 pass 的 speed 也变了」。另跑 10 seed / 62,947 事件，**只删 pass 顶层 speed**：
  - `passSpeedDiff = 3,480`
  - `beatSpeedDiff = 0`
  - 其它字段差异 **0**
  ⇒ 差异面精确到 **pass 事件顶层 `speed`**，不是「所有 speed」这种宽泛口径。

结论：**C3 在 main 上位置/决策/时间戳/计数逐位不变；唯一差异是 pass 事件的 `speed`（及由它派生的 `stream_hash`）。证明为真。**

---

## 2. L2 pass-speed 门改写：诚实、非空转，但有覆盖盲区与容差问题

### 2.1 判定：是「守住 C3 语义」，不是「放宽到刚好装下」

`engine/tests/realism.rs:556-587`：原 `[10,25)` 下界被替换为
「`speed < 10` 的 pass ⇒ 由序列化 `x,y,x2,y2,speed` 复算的 `distance/speed` 必须 ≈ 0.95s」；
`speed >= 25` 仍违例。这不是把下界从 10 往下调，而是把「为什么可以 <10」写成了可证伪断言。

### 2.2 变异测试（真跑）

- 基线：`cargo test --release --test realism l2_cross_event_invariants` → `1 passed`（79.97s）。
- 变异 `TICK_FILL_FLIGHT_S: 0.95 → 0.80`：`CARGO_EXIT=101`，
  `thread 'l2_cross_event_invariants' panicked at tests/realism.rs:1272`，
  消息形如 `pass speed 7.30 <10 但不是 tick-fill（复算 flight 0.798s，want 0.95±0.03）`。
  ⇒ **真红，不是编译失败**；已 `git checkout` 还原（`git status` 干净）。
- 非空转：300 seed 量化（本审阅者 JS 探针，序列化字段口径）：
  `253,813` 条 pass 中 `speed < 10` 有 **17,885** 条 ⇒ `<10` 分支确实被大量执行，不是恒绿空转。

### 2.3 盲区 1：只检查了 <10 的填拍（即距离 <9.5m）

填拍后 `speed = 距离/0.95`；距离 ≥9.5m 的填拍传球 `speed ≥ 10`，**完全不走** `flight ≈ 0.95` 检查。
若未来把填拍规则改成「只填短传」或改长传的填拍常量，L2 不会红（只有 golden 哈希会变；重基线后即失守）。
这不是当前改动的错，但门的覆盖应写明。

### 2.4 盲区 2：出界 pass 根本没接填拍（并与证据笔记的归因冲突）

- `engine/src/lib.rs:4006`（`emit_pass_highlight_inner` 的**出界分支**）仍是
  `let flight = distance_meters(...) / speed;`，**未调用 `tick_filling_flight`**。
  该分支产出 `detail = out_goal_line / out_sideline` 的 Pass，正常比赛可达。
- 300 seed 实测：`distance/speed < 0.945s` 的 pass 残余 **2,932** 条，其中
  **821 条 `out_sideline` + 111 条 `out_goal_line` = 932 条**来自该未接填拍的分支（约 32%）。
- 证据笔记 `README.md:43-45` 说 441 条残余「都是开球拨球与距离 <0.5m 的传球」——**不成立**：
  ① 开球事件类型是 `"kickoff"`（`lib.rs:43`），根本不在 `type === "pass"` 的统计里；
  ② 残余的 01 分位距离是 2.05m，不是 <0.5m；③ 三成残余是出界 pass。
  （441 是 45 seed 口径，本审阅者 300 seed 的 2,932 按比例 ≈441，**数量对、归因错**。）

⇒ P1：要么把出界分支也接上填拍（与 C3 目标一致），要么在代码/笔记里明确写「出界 pass 有意豁免」并给出理由；
现状是「声称填满所有传球，实际漏一个可达分支，且证据把残余归错」。

### 2.5 容差推导错误 + 实际余量仅 0.005s

`realism.rs:564-566` 写：「容差 0.03s：x/y/x2/y2 量化 ≤0.0125m，除以最小 speed（≈0.53）放大约 0.024s」。
问题：
- 测试读的是**序列化后的 speed（`{:.1}`，±0.05）**，推导**漏了 speed 自身的量化项**；
  在 `s≈1.6` 时该项约 `0.95×0.05/1.55 ≈ 0.031s`，加上坐标项 ~0.008s，最坏 ~0.039s > 0.03。
- 若真达到 `dist=0.5m` 的守卫下限（`s=0.5/0.95≈0.526`，序列化后 0.5），复算 flight=1.0，误差 0.05 已超容差。
- 实际数据：300 seed 中 `speed<10` 的**最小速度 = 1.6 m/s**（seed 113），
  **最坏 `|flight-0.95| = 0.0247s`（seed 48）**，只比 0.03 低 **0.0053s**。
⇒ 门目前是绿的，但余量很薄；未来一个良性改动（更短的短传）可能假红。
建议：把容差写成随 speed 变的界（如 `0.0125/s + 0.95*0.05/(s-0.05)`），或提高容差并写对推导；
不能一边用 0.53 做推导的分母、一边实际数据最小是 1.6。

---

## 3. `gm_v10_is_v9_plus_speed_field_only`：只守计数，守不住「只有 speed 变」

### 3.1 它到底断言了什么

`engine/tests/realism.rs:1639-1651` → `assert_golden_fields_match`（`realism.rs:1487-1526`）
只比较 **28 个计数整数字段**（比分/事件数/射门/传球/抢断/犯规…），并返回 `stream_hash` 是否相同；
测试再断言 `!hash_same`。即：**「v10 与 v9 的 28 个计数全同，且流哈希不同」**。
它**没有**比较任何坐标、时间戳、`detail`、`result`、`speed` 之外的字段，也没有比较流内容。

### 3.2 对抗性证明：位置字段漂移时守卫照绿

本审阅者构造「只改序列化位置、不改计数与决策」的变异：
`normal_pass_highlight` 里 `receiver_x: Some(rx)` → `Some(rx + 0.0007)`（`lib.rs:4186` 临时探针行）。
结果：
- `gm_canary_seeds` **红**：`seed 1 事件流哈希漂移（任何静默改动）`（exit 101）⇒ 流确实变了；
- `gm_v10_is_v9_plus_speed_field_only` **绿**（exit 0）⇒ 守卫看不见这个非 speed 字段漂移。
（探针已还原，`git status` 干净。）

⇒ P1：`lib.rs:244-247` 的注释把该测试说成「v9/v10 基线**逐字段**相同、只哈希不同」并把
「位置/决策/时间戳逐位不变」的举证责任挂在它身上，**是过度声明**；该测试最多证明「计数没变」。
本次合并的真实证据是 §1 的掩码证明（它只在 `.scratch/notes`，不在 CI）。
建议：给 golden 增加 `masked_stream_hash`（把事件 JSON 的 `"speed":<num>` 掩掉后哈希），
`gm_v10` 断言「当前 masked_hash == golden.masked_hash 且 raw_hash ≠ v9 raw_hash」；
这样未来的重基线也能自证「只有 speed 变」。否则至少把注释改成「计数不变 + 流确实变了」。

---

## 4. C5 / T1 viewer 改动：锚点精确、球不动、无 snap 回归

### 4.1 事件流零改

`git show --stat`：`0854fda` 只动 `viewer/game.js`；`0306cad` 只动 `viewer/game.js`、`viewer/app.js`、
`viewer/index.html`、`viewer/game.test.js`；均不碰 `engine/`。Game 也不改写事件对象（§4.3 实测 `eventsMutated=false`）。

### 4.2 锚点位置逐位不变（真实事件流，非 fixture）

用分支 wasm 产 seed 1/7 的 5400s 事件流，创建 `Game(..., 'continuous')`，对**全部**球员锚点
`seekTo(anchor.t)` 后与锚点坐标比：

| seed | 检查锚点数 | 位置偏差 >1e-6 | 最大偏差 | main 同口径 |
|---|---|---|---|---|
| 1 | 73,900 | **0** | **0m** | 0m |
| 7 | 75,454 | **0** | **0m** | 0m |

（同刻重复锚点 21,127 / 23,864 个已按 `seekTo` 的「取同刻最后一个」语义跳过，不算违例。）

### 4.3 main vs 分支差分（同一条事件流喂两版 Game，逐帧 1/60s）

| seed | 球员最大位置差 | 球最大位置差 | C5+T1 逐帧最大跳变 | main 同口径跳变 | 重叠帧（<0.5m）分支 / main | 事件被改写 |
|---|---|---|---|---|---|---|
| 1 | 0.651m | **0** | 0.993m | 0.993m | 1,492 / 1,511 | 否 |
| 7 | 0.661m | **0** | 2.498m | 2.498m | 1,646 / 1,640 | 否 |

- 位置差 ≤0.66m，与代码注释「中段最多外扩约 1/6 邻段（≈0.7m）」一致（`game.js:533-537`）。
- **逐帧最大跳变与 main 完全相同** ⇒ C5/T1 没有引入新的 snap；2.5m/frame 的大跳是 main 既存现象
  （e2e 的豁免窗口/阈值口径另论）。
- 球位置差恒 0 ⇒ T1 只作用于球员（`game.js:605-613`），C3 改的是同一事件流里两版共用的球飞行时长。
- 重叠帧不增反略降。
- C5 非空转：instrument `_smoothNeighborPositions` 后 2,867,219 次调用中 934,523 次（32.6%）真正走平滑；
  关掉纹理（`textureAmpM:0`）后与 main 的差最大 0.63m ⇒ C5 单独确实在生效。
- T1 单测有反空转条（`game.test.js:789` 的 `maxDev > 0.01`），锚点测试覆盖 fixture 的 400 个锚点；
  本审阅者用真实流全量锚点复核通过。**但 C5 没有专门的「是否真的启用」断言**（P2）。

---

## 5. Hack 检查

- **带**：除 L2 pass-speed 这一处（§2，属协议语义变化，非放宽）外，`realism.rs` 无其它判据/带改动；
  其它测试文件无 pass-speed 断言（`grep pass speed / speed_violations` 只命中 L2 与 mover/main 既存检查）。
- **基准基线**：`viewer/data/benchmark-baseline.json` 与 `1c5729d` 版比，**只有 `engineFingerprint` 与 `engine` 段变**；
  `datasets` / `crossDataset` / `declarations` / `windows` / `metricsModule` 逐字节相同（脚本核对）。
  `engineFingerprint.sourceSha256 = 3f9432…` 与当前 `engine/src/lib.rs` 实测 sha256 **一致**（不是脏树产物）。
  漂移来自 viewer 插值层（C5/T1/C3 的球飞行时长），不是引擎事件位置变——与 §1 互证。
- **golden 重基线**：10/10 seed 的 28 个计数逐位相同，只有 `stream_hash` 不同（脚本核对）；没有把行为漂移洗进 golden。
- **判据为过门而调**：未发现。L2 的改写是唯一判据改动，且有独立动机与变异反证。
- **进程层**：本合并没有对应的 `openspec/changes/`（项目 CLAUDE.md 要求 OpenSpec 流程），证据只落在
  `.scratch/notes/`。若这是有意走「cherry-pick 修法合入」的特例，建议在 PR/笔记里写明豁免；不算代码 hack。

### 文档/数字出处问题（P2）

1. `engine/src/lib.rs:223` 仍写「当前引擎/协议模型版本（**当前 = 9**）」，而 `MODEL_VERSION = 10`（`:248`）。
2. `notes/README.md:82-83` 说基线「2 位小数下变化仅 3 处」；实际基线 JSON 有 **11 个**数值的 2 位小数变了
   （spread.min、gap.min、ballDist/ballDistAllFrames 的 avg+min、possessionHome.max、
   elasticity.half.max、elasticity.centroid 的 avgDelta/min/max）。README 表只列 5 个指标，所以「3 处」在表内成立、在基线文件层面不成立。
3. `lib.rs:3472` 的「约 15%」只在 commit message 里有上下文，仓内无文件+章节指针；
   `viewer/game.js:33-41` 的 3.0°/0.059m/2.99°/3.02° 也未在 `.scratch/notes` 找到出处。
   按项目「记录数字的硬规则」，应补指针或标「本仓内不可自证」。
4. `lib.rs:5948-5950`：开球 `kickoff_end` 被拉长到 0.95，但 kickoff 事件 `speed` 仍保持 12.0、且
   `kickoff_end` 不序列化 ⇒ 对 viewer 球动画**无效果**；对事件流也无效果（整数 tick 判定不变）。
   唯一可见影响是 observation 的 `resumed_t`（`lib.rs:5863`）。要么说明这是给观察层的，要么删掉。

---

## 6. 结论清单

**P0（必须修）：无。**

**P1（建议修）：**
1. 出界 pass 分支未接填拍（`lib.rs:4006`），且证据笔记把 441 条残余错误归因为「开球 + <0.5m」——
   实测 300 seed 中约 32% 残余是出界 pass，开球根本不是 pass 事件。要么补上，要么明确豁免并改笔记。
2. `gm_v10_is_v9_plus_speed_field_only` 只比计数；对抗探针证明它看不见 `receiver_x` 这类非 speed 字段漂移
   （canary 红、gm_v10 绿）。建议给 golden 加 `masked_stream_hash` 并断言，或把「逐字段/位置不变」的注释降级。

**P2（可留）：**
1. L2 容差推导漏 speed 量化项；实际最坏误差 0.0247s vs 0.03s（余量 0.005s），最小速度 1.6 而非注释的 0.53。
2. L2 只检查 speed<10 的填拍；距离 ≥9.5m 的填拍（speed≥10）未验 flight=0.95。
3. `lib.rs:223` 陈旧版本号「当前 = 9」。
4. 基线笔记「3 处」与基线文件 11 个 2dp 数值变化不一致（README 表口径下成立）。
5. C5 缺专门的「启用/非空转」单测（本轮由审阅探针补证：32.6% 启用、效应 0.63m）。
6. 开球 `kickoff_end` 改动对 viewer/事件流无效果，只改 observation 时间锚（需说明或删除）。
7. 15% / 真实转角等数字缺仓内出处指针。

---

## 7. 本轮实跑结果（本审阅者）

| 套件 | 结果 |
|---|---|
| `cargo test --release --lib` | **201 passed / 0 failed / 1 ignored** |
| `cargo test --release --test realism` | **5 passed / 0 failed / 9 ignored**（9 条是产物门） |
| `cargo test --test p15_behavior_observation` | **11 passed / 0 failed / 1 ignored** |
| `viewer: node --test *.test.js` | **398 passed / 0 failed** |
| `viewer/e2e-v2.mjs` | OK（6285 事件；无 snap：球 0.0075 / 球员 0.0348） |
| `tools/benchmark-{baseline,compare,crossvalidation}.test.mjs` | **39 passed / 0 failed** |

（未逐条重跑 p124/p16/p17a/p17b/p18 等与本改动无关的 integration target；默认 debug 套件在跑完
lib 前 130 条时无红，随后改跑 release 版全量 lib，结果如上。）

## 8. 复现命令（本审阅者实际执行）

```bash
export PATH="$HOME/.cargo/bin:$PATH"
REPO=<本 worktree>

# 两端 wasm
(cd $REPO/engine && cargo build --target wasm32-unknown-unknown --release \
  && cp target/wasm32-unknown-unknown/release/fm_engine.wasm /tmp/review-branch.wasm)
git worktree add --detach /tmp/fm-main-review 1c5729d
(cd /tmp/fm-main-review/engine && cargo build --target wasm32-unknown-unknown --release \
  && cp target/wasm32-unknown-unknown/release/fm_engine.wasm /tmp/review-main.wasm)

# 掩码证明（45 seed）
node $REPO/.scratch/notes/c3-render-fixes-to-main-2026-10-29/probe-masked-speed.mjs \
  /tmp/review-main.wasm /tmp/review-branch.wasm > /tmp/review-masked.json

# L2 基线 + 变异（变异后务必 git checkout 还原）
(cd $REPO/engine && cargo test --release --test realism l2_cross_event_invariants)
sed -i 's/const TICK_FILL_FLIGHT_S: f64 = 0.95;/const TICK_FILL_FLIGHT_S: f64 = 0.80;/' $REPO/engine/src/lib.rs
(cd $REPO/engine && cargo test --release --test realism l2_cross_event_invariants)  # exit 101
git -C $REPO checkout -- engine/src/lib.rs

# viewer
(cd $REPO/viewer && node --test *.test.js && node e2e-v2.mjs)
node /tmp/viewer-diff.mjs      # 本审阅者的 main-vs-分支逐帧差分探针
node /tmp/c5-isolate.mjs       # C5 启用率/单独效应
node /tmp/l2-margin.mjs /tmp/review-branch.wasm 300   # L2 余量与残余飞行分类
node /tmp/pass-speed-only.mjs  # 只删 pass 顶层 speed 的差分
```
