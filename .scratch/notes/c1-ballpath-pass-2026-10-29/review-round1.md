# C1-ballpath-pass · 独立审阅 Round 1（2026-10-29）

审阅者：零上下文独立审阅（只读，未改代码；golden 变异已还原）。
范围：`git diff origin/main..HEAD`（`347e595` 工具链 / `b86c34e` 引擎 / `8f730a0` viewer / `ee7a203` 基线+测试维护）。
环境：worktree `.../worktrees/in-box-shot-priority-2026-10-28`，审阅时点 HEAD `ee7a203`，`viewer/engine.wasm` sha256 `ca99edfd…`（= 基线 `engineFingerprint` / 验收包 wasm），`engine/src/lib.rs` sha256 `240f6900…`。

> ⚠️ **审阅时点与并发变更**：审阅期间该 worktree 被另一进程并行使用——HEAD 已新增
> `9abc7b0 docs(notes): R6 记录 + held-out 验收产物`，且工作树出现**未提交**的修复改动
> （`engine/tests/realism.rs` 的 `l2_pass_fill_constant_matches_engine_tick`、
> `viewer/{renderer,e2e-v2,*.test}.js|mjs` 的 config 说明符换成 `?v=20261029-1`、
> RECORD 地板段落更新、`.gitignore` 加 StatsBomb）。这些改动**不在本报告的审阅范围**
> （本报告钉在 `ee7a203` 的四个代码提交 + 当时读到的 RECORD）；它们看起来正对应
> P2-1 / P2-3 / P3-5。合并前请以当时最新树复核。
> 提醒（未审）：`viewer/renderer.js` 内容若因这次修复而改变，`viewer/app.js:9` 对
> `renderer.js?v=20260913-1` 的版本号也必须一起 bump，否则浏览器仍拿旧 renderer。

## 总结

- **P1：0 条**（未发现会直接破坏事件流、门禁判据或 2 Hz 语义的功能缺陷）。
- **P2：4 条**（e2e 的 config 双实例 → 测试前置条件静默失效；v11 掩码哈希自证条可被伪造；`PASS_FILL_FLIGHT_S` 的「同步断言」不存在；5+ 处标定常量注释仍描述旧取值）。
- **P3：8 条**（tick 单位注释过期、finalize 时刻注释错误、RECORD 指针/验收结果缺口、缓存版本号不完整、已知 2 Hz 视觉残差等）。

已实跑（命令与读数见各节）：

| 命令 | 结果 |
|---|---|
| `cargo test --release --test realism gm_` | **4 passed**（v11 golden 与当前引擎逐 seed 对齐） |
| 并发全量 `cargo test --release --no-fail-fast`（本 worktree，日志 `/tmp/full-suite-final.log`） | lib **201 passed / 2 failed**（仅 observation×2）→ p31×3、p53 已绿；p124 5 / p15 3 / p16 2（+1 ignored）/ p17b 2 / p17a 0 / p18 0 |
| `node --test viewer/*.test.js` | **401/401** |
| `node viewer/e2e-v2.mjs` | **OK**（11737 事件；无 snap：球 0.0305 / 球员 0.0368） |
| `node --test tools/ratchet.test.mjs tools/benchmark-baseline.test.mjs tools/benchmark-compare.test.mjs` | **36/36** |
| `node --test tools/visual-review/*.test.mjs` | **74/74** |
| 变异：改 `engine/tests/golden-v11/seed-1.json` 的 `speed_masked_stream_hash` → `gm_` 4 tests | **仍全绿**（→ P2-2），文件已还原（`git diff` 空） |
| 4-seed wasm 探针（红牌 fixture / 抢断锚点） | 见 P3-6、P3-5 |

未复跑：L1 200 场（长跑，按 R6 记录采信，**本审阅未自证**）；并发全量跑的报告时点 realism 的 `l2_*` 仍 >60s 未结束（gm 4 条已绿）。

---

## P1

无。

---

## P2

### P2-1 `viewer/e2e-v2.mjs` 的 config 设置不再作用于 `Game`（模块双实例）

- 位置：`viewer/e2e-v2.mjs:5`（`import { config } from './config.js'`）、`:9`（`config.debug.enabled = false`）、`:12`（`config.playback.skipThresholdSeconds = Infinity`）；对照 `viewer/game.js:10`（`import { config } from './config.js?v=20261029-1'`）。
- 机制：本分支把 `game.js` 的 config 说明符改成带 `?v=` 的版本，Node 里 `./config.js` 与 `./config.js?v=20261029-1` 是**两个模块实例**。e2e 改的是裸实例，`Game` 读的是带版本实例 ⇒ 两条设置都无效。默认 `debug.enabled=true`（`viewer/config.js:97-98`）、`skipThresholdSeconds=5`（`:39`）。
- 复现（已跑）：

```bash
node --input-type=module -e "
const a = await import('./viewer/config.js');
const b = await import('./viewer/config.js?v=20261029-1');
console.log('same instance?', a.config === b.config);      // false
a.config.debug.enabled = false;
console.log('versioned debug.enabled =', b.config.debug.enabled); // true
"
```

  同时 `node viewer/e2e-v2.mjs` 的输出里仍有大量 `[EVENT #…]` / `[t=…] 球=…` 调试行——直接证明 `:9` 未生效；`config.js:9-12` 的注释（「关闭调试日志」「关闭跳过机制」）因此是假的。
- 影响：verify.sh 第 4 步的 e2e **不再在文档声明的「skip 关闭」条件下运行**。skip（`skipMode:'fast'`，阈值 5 s）会在非高亮段加速/跳过 playTime，而「无 snap」检查是按 1/60 s 步进采样事件边界的——被跳过的段可能整段不采样，gate 的实际覆盖与注释不符（本次 4 seed 仍过，读数见上表）。另有调试日志污染。
- 最小修法：按 `viewer/interpretation.test.js:163` 的做法从 `game.js` 源码抠出实际说明符再 import；或给 `new Game(...)` 传 `opts`（`game.js:176` 已支持 `opts.skipThreshold`）；或同时改两处实例。
- 并发注记：审阅收口时工作树已有未提交修复（`e2e-v2.mjs:4` 改为 `?v=20261029-1`），本报告未审该改动。

### P2-2 v11「掩码流」自证条没有和当前引擎绑定；指定的 golden 变异不被检出

- 位置：`engine/tests/realism.rs:1776-1785`（`gm_v11_changes_behavior_not_just_speed`）、`:1582-1620`（`assert_golden_fields_match` 的 28 字段列表）、`:1636-1655`（`gm_canary_seeds`）。
- 事实：
  1. golden 文件**不含事件流**，只含 28 个计数 + `stream_hash` + `speed_masked_stream_hash`（`engine/tests/golden-v11/seed-1.json`）——审阅要求里「把 speed 掩码流手动改一个字段」在产物上不可表达，能改的只有哈希本身。
  2. `assert_golden_fields_match` 比对 28 个计数；`gm_canary_seeds` 另外只判 `gold.stream_hash == st.stream_hash`。**`speed_masked_stream_hash` 从不与当前引擎重算值比较**。
  3. 变异复现（已跑，已还原）：把 `golden-v11/seed-1.json` 的 `speed_masked_stream_hash` 改一个值 → `./target/release/deps/realism-… gm_` **4 passed**。即该字段可被任意伪造而不被任何测试发现。
- 仍成立的部分（不是缺陷）：v11 的**来源**由 `gm_canary_seeds` 守住（28 计数 + 全流哈希对当前引擎；本次 4 passed）。所以「v11 不是当前引擎生成的」会被抓；被抓不到的是「掩码哈希字段是不是真的」——这让 `gm_v11` 作为「行为真的变了，不是只改 speed」的证据可被改文件绕过。
- 最小修法：在 `gm_canary_seeds` 加一条 `assert_eq!(st.speed_masked_stream_hash, gold.speed_masked_stream_hash)`（或在读 golden 时重算并比对），与 28 计数同一层。

### P2-3 `PASS_FILL_FLIGHT_S` 的「与引擎常量同步」断言不存在（假覆盖声明）

- 位置：`engine/tests/realism.rs:100-102`

```rust
/// 本引擎的传球飞行填拍时长（秒）：`0.95 × TICK_SECONDS`（见 `lib.rs::tick_filling_flight`）。
/// 测试侧显式写死并在 `l2` 断言与引擎常量同步——拍频改动时这里会红，不会静默漂移。
const PASS_FILL_FLIGHT_S: f64 = 0.95 * 0.5;
```

- 事实：全文件只有 `:644`、`:654` 两处使用该常量，**没有任何 `assert_eq!(PASS_FILL_FLIGHT_S, 0.95*TICK_SECONDS)` 或等价检查**（`TICK_SECONDS` 在 realism.rs 的 `:19` 被 import，但只用于 `:452-453` 的 beat 间隔检查）。
- 另外它只**单边**：填拍变长（如 `TICK_SECONDS` 改回 1.0、FILL 变 0.95）时 `dist ≥ 0.475·speed` 仍成立，gate 不会红；只有填拍变短才会红。所以「拍频改动时这里会红」两种方向都不完整。
- 对照：viewer 侧**有**真实同步断言（`viewer/interpretation.test.js:163-169` 读 `engine/src/lib.rs` 的 `TICK_SECONDS` 与 `config.interpretation.tickSeconds` 比较）；缺口在引擎测试侧。
- 最小修法：加 `assert_eq!(PASS_FILL_FLIGHT_S, 0.95 * TICK_SECONDS)`（放在 l2 测试开头即可），并把注释改成与实际断言一致的措辞。
- 并发注记：审阅收口时工作树已有未提交修复（新增 `l2_pass_fill_constant_matches_engine_tick`，见文件头「并发变更」），本报告未审该改动。

### P2-4 标定常量的注释仍描述旧取值（数值与机制双重矛盾，5+ 处）

本仓纪律：写进注释的每个数必须有出处且为真。以下注释与代码**在同一文件内直接冲突**，且多数是「机制叙述」（不只是数字过期）：

| 常量/函数 | 注释说 | 代码是 | 位置 |
|---|---|---|---|
| `OPEN_PLAY_SHOT_ENGAGE_SHIFT` | 「C1 2 Hz 重标定：−4.15 → **−4.50**」，并以 −4.50 的读数（regular 15–26/场、均值 21.0）论证 | `-4.2`（R5c 的 −4.50→−4.20 重锚未写进注释） | `engine/src/lib.rs:827-833` |
| `BASE_DEF_TACKLE` | 「『**−0.92** 是刚清 ratio 且留在带内的最轻点』这个取值仍成立」 | `-1.47` | `engine/src/lib.rs:482-484` |
| `BASE_DEF_FOUL` | 「**−0.22/−0.92** 是 T2 可行矩形…里最轻的一点」 | `-0.30` | `engine/src/lib.rs:514-517` |
| `CLINICAL_GOAL_PP_HOME` | 「主队单向更强（**home +2pp** / away 不压）」 | `0`（主客对称，测试也已改成断言相等） | `engine/src/lib.rs:859-862` |
| `shot_bucket` | 文档「禁区内 **(15,30) 不动**」；行内「禁区内 **saved 30→27**；禁区弧 3/22→3/23」 | box `(7,48)`、arc `(2,32)`、far `(1,14)` | `engine/src/lib.rs:7112-7121` |
| `emit_shot_highlight` 行内 | 「按起脚距离分桶（禁区内 **15/30**、禁区弧 **3/22**、远射 **2/11**）」 | 同上 | `engine/src/lib.rs:4705` |

- 影响：这些是校准面的「规范正文」——后续标定者会按 −0.92 / −0.22 / 15/30 / −4.50 推理，全部指向不存在的取值；`shot_bucket` 更没有任何测试钉住这三个概率对（`p29_distance_quality_reuses_shot_bucket_bands` 只测 6-16.5 / 16.5-25 的**桶边界**，不测 goal/saved 概率），改错不会红。
- 本审阅未要求本轮修，但按仓内既有纪律（注释里的数=规范）建议合入前修：要么更新注释到当前值+出处（RECORD R5c/R6 有 −4.20、−1.47、−0.30；shot_bucket 需补一条出处或钉值测试），要么把旧段落显式标成「历史取值」。

---

## P3

1. **tick 单位注释过期（2 Hz 后未换算）**——数值本身正确（`秒数×TPF`），但注释仍按 1 Hz 说 tick 数：
   - `SHOT_DRIVE_MAX_TICKS`：注释「（5 tick × 5m = 25m 覆盖）」，实际 `8 * TPF` = 16 tick × 2.5 m = **40 m**（`engine/src/lib.rs:724-725`；8 s 是 R0 的意图，但注释没更新）。
   - `PRESSURE_STATE_HOLD_TICKS`：注释「取 8 ≈ 机会点平均间距（~7 tick）」，实际 16 tick（`:531-532`）。
   - `BASE_ACTION_DEADLINE_TICKS`：注释「现落在 `[2, 7]`（tick）」，实际 `[4, 14]` tick（`:1311-1312`）。
   - `LIVENESS_STAGE_*`：注释「压到 2/4/7」，实际 4/8/14 tick（`:1018-1023`）。
   - `FOUL_MIN_GAP_TICKS`：注释「>11 tick（≥11s）」，实际 22 tick（`:2706-2707`）。
   - `CARRIER_SPEED_MS`：注释「main 每拍推进 ≤ speed×1s」，2 Hz 下是 ×0.5 s（`:638-639`）。
2. **`tick_filling_flight` 文档说「finalize tick = t + 填充时长」，与实际不符**：finalize 在**下一个 tick 边界**发生（同文件出界分支的注释 `:4443-4444` 自己写对了：「finalize tick 照旧是下一个 tick 边界」）。`engine/src/lib.rs:3611`。
3. **L2 注释指向不存在的实测读数**：`engine/tests/realism.rs:628` 写「实测余量见 `.scratch/notes/RECORD.md`」，但 RECORD R6（`:919-1005`）没有 2 Hz 填拍余量（最坏 |flight−0.475| 之类）的读数。按「记录数字硬规则」，这是悬空出处。
4. **RECORD R6 没有验收结果，而验收产物已存在**：`acceptance/summary-2judges.json` 已有 2 裁判（sonnet 8/24=33.3%，fable 13/24=54.2%，mean 43.75%，负控 100%），R6 正文只写到「如实回答 brief 的三问」，没有记录裁判结果与 held-out 结论。若本轮记录要作为合并依据，需补上（或显式标注「验收进行中」）。
5. **viewer 缓存版本号只覆盖了部分 config 消费者**：`viewer/renderer.js:4` 仍 `import { config } from './config.js'`（裸路径），而 `config.js` 本轮新增了 `tickSeconds`；`viewer/app.js:6-8` 的注释「传递依赖（game.js/renderer.js 内部 import）未带版本号」也已与 `game.js:10-11` / `interpretation.js:5` 的现状矛盾。renderer 不读 `tickSeconds`，所以当前无用户可见影响，但按 CLAUDE.md 的缓存规则这是不完整更新。（并发注记：工作树已有未提交修复把 renderer/tests 的说明符改成 `?v=20261029-1`；本报告未审。若 renderer.js 内容改变，`app.js:9` 的 `renderer.js?v=20260913-1` 也须一起 bump。）
6. **2 Hz 已知视觉残差（已记录、未验收）**：`viewer/game.js:619-620` 明说 Catmull–Rom 邻点窗口 `[0.5,1.5] s` 是 1 Hz 标定；beat 间距 0.5 s 卡下界、fill-to-tick 的 0.475 s 传球锚点落在窗外 → 静默退回线性。本轮未做视觉验收，作为已知限制保留（审阅确认注释与代码一致，不是缺陷，但必须在视觉验收里覆盖）。
7. **抢断锚点在极端 `carrier_from` 下会塌成零时长捅球（当前不可达）**：`viewer/interpretation.js:191-193` 把 `tContact` 钳到 `t0+tick−0.05`，`:226` 再把 `tLoose` 钳到同一上界；若 `carrierMoveDur > 0.45 s`，会出现两个**同时间戳、不同位置**的球锚点（构造用例：0.7 s 带球 → `tContact=tLoose=27.45`，两锚点相距 ≈5.6 m）。4 seed 探针（seeds 1/7/15/42，success tackle 12–16）显示 `carrierMoveDur` 恒为 0，因此当前事件流不可达；作为未来数据形态变化的边界记录。
8. **ratchet `noiseTol` 的噪声是从「带内值」量的**：`p38.latSd` 7.07–8.60、`p38.shotsReg` 39.0/37.8/35.4/37.3（RECORD R2）给的是**带内/上尾**样本的半差，现在被用作「出带 ≤ tol 也算 same」的容差（`tools/ratchet.mjs:54,59,121`）。与记录一致、有出处，语义可接受；但把带内噪声外推为越界容差是近似，记录里没有这一步推导。

---

## 已验证通过（非缺陷，逐项给证据）

### 1. C3 修复确已保留

- 出界 pass 分支调用填拍：`engine/src/lib.rs:4445`（`let (speed, flight) = tick_filling_flight(distance_meters(from_pos, (x2, y2)), speed);`），`t_end = t + flight`（`:4446`）。
- `tick_filling_flight` 的填充时长 = `0.95 * TICK_SECONDS`（`:3622`），2 Hz 下 0.475 s；注释明确 A 案（fill-to-tick）与代价。
- **所有 pass 生成分支都接了填拍**：`grep -n 'type_: EventType::Pass'` 共 11 处（出界 `:4448`、拦截 `:4520`、传失 `:4575`、正常 `:4631`、起脚窗口转出球 `:4978`、门球 `:5548`、角球 `:5700`、界外 `:5738`、任意球 `:5784`、头球摆渡 `:6082`、解围 `:6254`），每处上方都有 `tick_filling_flight(...)`。开球 `kickoff` 只拿 flight、不改事件 `speed=12.0`（`:6391-6393`），注释已说明它不算 pass、viewer 不受影响。
- L2 不变量推导成立：填拍后内部恒有 `dist = FILL·speed`（填拍）或 `dist ≥ FILL·speed`（未填拍）；序列化误差 = 坐标重算 ≤0.0126 m + `speed` `{:.1}` 的 ±0.05×0.475 = 0.02375 m ⇒ ≤0.0364 m → 取 0.04 m（`engine/tests/realism.rs:619-623`、`:102`）。这与 `Event::to_json` 的 `speed:{:.1}`、`x/y/x2/y2` 四位小数一致（`engine/src/lib.rs:163-199`）。

### 2. 2 Hz 重标：命名常量没有漏 scale

- 全部 tick 常量均为 `秒数 × TPF`：`LOOSE_MAX / SHOT_DRIVE / SHOT_WINDOW / SHOT_COOLDOWN / CORNER_SETUP / TRANSITION / LIVENESS{1,2,3} / LIVENESS_STAGE_DEADLINE / BASE·MIN·MAX_ACTION_DEADLINE / GK_DEADLINE / TACKLE_COOLDOWN / CONTACT_PAIR_COOLDOWN / PRESSURE_STATE_HOLD / FOUL_MIN_GAP / 进球死球 remaining`（`grep -n '_TICKS' engine/src/lib.rs`；`:5261` 的 `remaining: 2 * TPF`）。
- 三个 deadline 调制系数（`DANGER_URGENCY / PRESSURE_URGENCY / ESCAPE_BONUS`）已 ×TPF（`:1315-1319`），与 c1-subtick note §2 的自查记录一致。
- 秒语义的其它处：`shot_hazard_hits` 的 window = `TICK_SECONDS`（`:2197`）；个体相位 `ticks*TICK_SECONDS`（`:3782`）；抖动 `wob = TICK_SECONDS`（`:3647`）；松散球阻尼 `0.5f64.powf(TICK_SECONDS)`（`:5928`）；推进/跑位步长 `speed*TICK_SECONDS`（`:4281`、`:4866` 等）。
- **两处刻意不 scale 的「每拍位移」**：`carrier_move` 的 `0.03`（普通带球）与 `0.05`（transition）保持每拍值，被 `CARRIER_SPEED_MS×TICK_SECONDS` 截流——这是 c1-subtick note §2 明写的 D2 主杠杆（`.scratch/notes/c1-subtick-prototype-2026-10-28.md:105`），不是漏 scale。
- `TPF`/`TICK_SECONDS` 手工同步有**间接**守卫：`p31_liveness_profile_three_stages_monotone` 用 `(1.0/TICK_SECONDS)` 反推 ticks/sec 再断言三档常量（`:12583-12586`）；任一者单独漂移都会红。未发现只靠人眼的死 sync。

### 3. golden v11 来源与门禁

- `cargo test --release --test realism gm_` → `gm_canary_seeds`、`gm_legacy_baselines_preserved_and_differs`、`gm_v10_is_v9_plus_speed_field_only`、`gm_v11_changes_behavior_not_just_speed` **4 passed**。`gm_canary_seeds` 用当前引擎逐 seed 比 28 计数 + `stream_hash`，因此“v11 目录 = 当前引擎生成”成立。
- `gm_v10_is_v9_plus_speed_field_only` 已改为两份冻结 golden 的静态比对（不依赖当前引擎），语义正确：v9/v10 掩码哈希逐 seed 相同、`stream_hash` 不同。

### 4. golden v11 行为差异条（正向部分）

- `gm_v11_changes_behavior_not_just_speed` 断言 v10 vs v11 掩码哈希逐 seed 不同——若有人用「只改 speed」的树重基线，该条会红。配合 P2-2 的缺口一起看：**关系守住了，字段真实性没守住**。

### 5. 测试维护没有被偷偷放宽

- **p31×3 / p53**：并发全量跑 lib 结果 `201 passed; 2 failed`，2 条失败均为 `observation::tests::*` ⇒ p31 三档/余量、p53 的改动在真实跑里是**绿**的；余量改秒语义（`12.0/TICK_SECONDS`、`8.0/TICK_SECONDS`）与 1 Hz 的 12 s/8 s 等值，不是放宽。
- **l2 红牌 fixture 重扫**：4-seed wasm 探针（`/tmp/probe_red.mjs`，5400 s）：
  - 新集 8/13/163/232 → red **1 / 1 / 2 / 1**；
  - 旧集 33/187/246/269 → red **0 / 0 / 0 / 0**。
  旧 fixture 的前提确实失效（不是 sent-off 机制坏了），新集覆盖更宽（232 有 31 犯规）。
- **D3 哨兵不是空转**：把新断言回放到 `origin/main` 的基线（`git show origin/main:viewer/data/benchmark-baseline.json`）：
  - hd engine [36.52, 40.20] vs real [11.55, 23.95]；spread [19.77, 21.04] vs [9.70, 15.95]；gap [16.60, 19.59] vs [3.22, 8.32]；
  - 三项 `eng.min <= real.max` **全为 False** ⇒ 新断言会红；当前基线三项全过（`tools/benchmark-baseline.test.mjs:122-125`）。即它确实钉住了「结论从分离变成重叠」。
- **e2e 首个 beat / 角球豁免**：`firstBeat.t ∈ [0.5,1.0]` 与 2 Hz 一致；角球豁免从「整秒时刻集」改为 `[startT, cornerPass]` 区间（`viewer/e2e-v2.mjs:101-133`），语义是准备期区间、不是判据放宽；`node viewer/e2e-v2.mjs` OK。
- **D3 数值与注释一致**：`viewer/data/benchmark-baseline.json` 的 engine hd 21.40–28.86 / spread 14.51–16.74 / gap 6.22–7.23，real 11.55–23.95 / 9.70–15.95 / 3.22–8.32，与测试注释逐项相同；`engineFingerprint`（`ca99edfd…` / `240f6900…`）与本地文件一致；metrics 模块/转换器 sha256 与文件一致。

### 6. 软 ratchet 的 band/noiseTol 与记录一致

- band = 真实值 ×[0.75,1.25]：disp 13.46→[10.1,16.8]、lat 0.43→[0.32,0.54]、mix 0.80→[0.60,1.00]、hd/ad/spread/gap 用 SkillCorner **allPoints** 25.82/25.63/14.78/6.88（出处在 RECORD D 节口径表）、ballDist ≈15→[11.2,18.7]，逐项与 `tools/ratchet.mjs:40-48` 相同。
- noiseTol：`shotsReg 1.8` 对应 RECORD R2 的 38.997/37.796/35.395/37.300（半差 1.801）；`latSd 0.8` 对应 7.07–8.60（半差 0.765）。`node --test tools/ratchet.test.mjs` 36/36 通过。

### 7. 工具移植（replay-blind / c2 可选 import）

- `c2-shadow-target.mjs` 的 try/catch 只在 `metricsFor()` 内（`tools/visual-review/replay-blind-build.mjs:309-334`），结果只进 `diagnostics.json` 的 `common` 列；packet 的 manifest/score-sheet、`windows.json` 冻结、`render-selfcheck`、`replay-blind-analyze` 均不 import 它。
- `node --test tools/visual-review/*.test.mjs` → 74/74。

### 8. 验收产物自洽

- `windows.sha256` = 实际 sha256 `6422db8f…`；`blind-key.json` 的 `preregistration_sha256`/`windows_sha256`/`engine.wasm_sha256` 与对应文件逐一相等（prereg `69a176af…`、windows `6422db8f…`、wasm `ca99edfd…`，= 基线/验收共用构建）。
- packet：24 items + 3 controls；manifest/README/score-sheet 中检索 `metrica|skillcorner|seed6|"engine"|"real"` **0 命中**；blind-key 在 packet 之外；`render-selfcheck.summary`：`allImagePass=true allPngPass=true`，contact/trajectory 各 30 张等长化（21390 / 22258 bytes），`calibration.pass=true`（ballErr=0）。
- 与 P3-4 一起：2 裁判结果已产出但未进 RECORD R6。

### 9. viewer 2 Hz 传播与抢断终点

- `config.interpretation.tickSeconds=0.5`（`viewer/config.js:44-47`）；`interpretation.js` 的 beat 铺满 `[t,t+tick]`（`:304`）、tackle 高亮终点 `end=t0+tick`（`:219`）、`highlightEndTime` 的 tackle 分支 `t+tick`（`:350`）、audit 区间 `t+tick`（`derive-audit-features.js:122-130`）——引擎 `emit_tackle_highlight_impl` 的 `t_end = t + TICK_SECONDS`（`engine/src/lib.rs:5059`）与之相同。
- 同步有自证：`viewer/interpretation.test.js:163-169` 读引擎源码的 `TICK_SECONDS` 与 viewer config 比较；新增的 tackle 终点/排除测试在 `:137-176`。
- `?v=` 更新覆盖：`index.html` → `app.js?v=20261029-1`；`app.js` → `config/game/observation?v=20261029-1`；`game.js` → `config/interpretation?v=20261029-1`；`interpretation.js`/`derive-audit-features.js` → `config?v=20261029-1`；`observation.js` → `derive-audit-features?v=20261029-1`。缺口见 P3-5。
- `node --test viewer/*.test.js` 401/401；`node viewer/e2e-v2.mjs` OK（11737 事件，球/球员最大步进 0.0305/0.0368）。

### 10. p17b 归因修复

- `engine/tests/p17b/episode.rs:623-633` 对 `FullTime/HalfTime` 收束段提前返回 None，即「哨声收束的段不认领同刻争抢成因」。与同函数已有的 seed 24 多段 tie-break 逻辑（`:641-655`）同源、方向一致；属于报告工具归因，不改引擎事件流。并发全量跑 p17b 2 红与 R6 记录一致（未新增）。

---

## 复现命令备忘

```bash
# golden / v11 来源（本审阅已跑）
(cd engine && cargo test --release --test realism gm_)          # 4 passed
# 变异（已还原）：
#   python 改 golden-v11/seed-1.json 的 speed_masked_stream_hash += 1234567 → gm_ 仍 4 passed
#   git diff -- engine/tests/golden-v11  # 空

# 全量（并发跑日志，本 worktree）
grep -E 'Running (tests|unittests)|test result|FAILED' /tmp/full-suite-final.log

# viewer / tools
node --test viewer/*.test.js                                   # 401/401
node viewer/e2e-v2.mjs                                         # OK
node --test tools/ratchet.test.mjs tools/benchmark-baseline.test.mjs tools/benchmark-compare.test.mjs  # 36/36
node --test tools/visual-review/*.test.mjs                     # 74/74

# config 双实例（P2-1）
node --input-type=module -e "const a=await import('./viewer/config.js');const b=await import('./viewer/config.js?v=20261029-1');console.log(a.config===b.config);a.config.debug.enabled=false;console.log(b.config.debug.enabled)"

# l2 fixture 红牌（P3 证据）
node /tmp/probe_red.mjs   # 8/13/163/232 → 1/1/2/1；33/187/246/269 → 0/0/0/0
```

## 审阅边界（如实）

- 未复跑 L1 200 场（长跑）；R6 的「5 绿 / 4 红、红集同 R5c」在本审阅中是**未经自证**的引用。
- 并发全量跑在报告时点尚未跑完 realism 的 `l2_*`（>60 s），因此 L2 行为门只做了代码/推导核验，未拿到本次完整读数；gm 4 条已跑。
- 未做视觉验收（轨迹图/盲测判读）；P3-6 的 2 Hz 平滑缺口与 P3-8 的验收结果均按“记录一致性”处理，不代替视觉裁决。
