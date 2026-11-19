# Change 0 合并独立审阅（Round 1）

日期：2026-11-19。审阅者：零上下文 paseo agent（Claude Sonnet 5.5）。
对象：`p155-measurement-instrument/2026-11-19`（`main..HEAD` 8 commits）。
结论：**P0 = 0；P1 = 7；P2 = 11。**

## P0（必须修）

无。

## P1（应修）

### P1-1 `ballStaticFrac` 的「引擎 10×」是 viewer 链读数，viewer 贡献未分离

- 位置：`notes/change0-verdict.md:9-11,116-126`；`notes/ablation.md:12,151-153`；`notes/ball-static-decomposition.md:18-19`；`notes/motion-census.md:184-187`
- 问题：引擎侧球位来自 `replay-blind-core.loadEngineFrames` → `viewer/game.js` 的 `createGame` + `sampleEngineFrames`，是 viewer 对 pass/shot 锚点的插值/演绎，不是引擎 raw 球位。A 明确说 `movers` 的球位与 viewer 同源、本次无法分离；B 又把责任转回 A，实际无人回答。
- 证据：A 的 `direct` 0.698 vs `linear` 0.216 已证明采样/渲染口径对 `ballStaticFrac` 影响巨大。
- 处置：把该读数明确标为「viewer 链引擎 vs 真实原始球帧」；在 verdict 写明 Change 1 不应把 `ballStaticFrac` 当纯引擎运动层目标，除非先加 raw ball-anchor 模式。

### P1-2 verdict 的 L1「当前值」挑了与 L1 审计冲突的记录

- 位置：`notes/change0-verdict.md:99-104`；`notes/l1-band-audit.md:48-49,85,143-145`
- 问题：verdict 用单个「当前值」表述，但审计明确说这些记录互相冲突、不能挑一个当当前真值：
  - 角球均值：verdict 写「当前 7.7–8.3 红」；审计 §11.3 记录 2.15 / 3.44 / 4.83 / 7.7–8.3 多值，要求并列。
  - 角球单场 max：verdict 写「余量只有 1」；审计 row 26 是旧记录 14（余量 1），main v11 峰值 >15（红）。
  - 射正率：verdict 写「当前 ~0.47–0.49」；审计 row 42 另记 M5 块 201..400 实测 0.3921 破上沿。
- 处置：verdict 对这些数写「转述（记录冲突，本 change 未重跑）」并并列；不要把旧余量 1 当当前余量。

### P1-3 真实侧外推点未按 design D3 跳过

- 位置：`design.md:68`；`tools/visual-review/motion-census.mjs:106-160,232-240`；`viewer/match-metrics.js:201-221`
- 问题：`censusOfWindow` 把 SkillCorner 转换器标记的 `extrapolated` 点当真实观测计入。SkillCorner 约 42% 球员点带外推标记；24 个 frozen 真实窗中 20 个是 SkillCorner。
- 证据（同一批 24 窗复算）：跳过外推后 old turn 0.2438→0.2212、staticFrac 0.0400→0.0369、speed p50 2.30→2.44；**条件 @0.5 仍 0.0104，79.6× 不变**。
- 处置：在 `censusOfWindow` 过滤 `!p.extrapolated`（或加 `includeExtrapolated` 默认 false），重跑并标注；至少要在 `motion-census.md` 写这不是设计口径。

### P1-4 `motion-census.md` §4.3 的 active 列混了「首场」与「逐场等权」两种聚合

- 位置：`notes/motion-census.md:42-44,143-158`；`notes/motion-census-active-windows.json`
- 证据（复算）：
  - engine 转移：note 5.4 / 5.3 / 73.5 / 15.9；逐场等权 5.3 / 5.3 / 73.3 / 16.2（note = seed 42 单场）。
  - real 速度/加速度：note 2.23 / 4.29 / 6.18 / 2.98 / 4.27；逐场等权 2.17 / 4.19 / 6.02 / 2.99 / 4.34（note = `real-game-1` 单场）。
  - real 转移：note 1.0 / 1.0 / 93.9 / 4.1；逐场等权 1.0 / 1.0 / 94.5 / 3.5。
  - real 条件 @0.5：note 0.0266 是窗池化，逐场等权 0.0275；§2 说「两种聚合只差 ~0.1%」，对 real 实际差 ~3%。
  - 同表 real static / ball / symmetry 却用逐场等权 ⇒ 逐行混口径。
- 处置：整表重算为逐场等权（或逐行标 `单场/逐场等权/窗池化`），修正 §2 的「~0.1%」。

### P1-5 `ball-static-decomposition.md` 的窗级百分位与所引 JSON 的 type-7 不一致

- 位置：`notes/ball-static-decomposition.md:38-48`；`notes/motion-census-frozen-anchors.json` 的 `summary.engineDecomposition.sources.*.staticContribution`
- 证据：carrier_hold note 0 / 60.7 / 82.5 vs JSON type-7 3.1 / 61.6 / 84.8；highlight 2.1 / 14.3 / 26.7 vs 2.3 / 15.5 / 29.0；loose 0 / 20.0 / 73.7 vs 0 / 20.7 / 80.2；restart 0 / 0 / 6.4 vs 0 / 0 / 9.8。note 用的是 floor 下位分位，仓库标准是 R type-7。
- 处置：按 type-7 重算，或显式标注「本文用 floor 分位，与 JSON summary 的 type-7 不同」。

### P1-6 design D7 的用户尺度基线不完整

- 位置：`design.md:116`；`proposal.md:16`；`tools/visual-review/viewer-match.mjs`；`notes/change0-verdict.md:116-124`
- 问题：D7/D9 要求「最长无动作段、墙钟、逼近/推进可读性」，verdict 只列了事件计数。
- 处置：补最长无动作段与墙钟（可从 5min 事件流算）；「逼近/推进可读性」若无法量化，明确写「未量化，留给用户视觉验收」，不要静默省略。

### P1-7 冻结刺激集的 source-hash 没有在工具里强制

- 位置：`specs/match-measurement/spec.md:14-17`；`tools/visual-review/render-ablation.mjs:664-693`；`tools/visual-review/motion-census.mjs:500-524`；`notes/stimulus.json`
- 问题：spec 要求「源不一致时拒绝拼表」，但工具只校验 wasm/event SHA，没校验 `stimulus.json` 里的 `engine/src/lib.rs` / `viewer/*.js` sourceHashes；viewer 代码变而 wasm 不变时，消融数字可能不可比而不报错。
- 处置：在 `runAction` / `runStimulus` 加 sourceHashes 校验（或至少把不匹配写成硬错误/显式警告）；补测试。

## P2（可选）

1. `change0-verdict.md:97` 写「42 条断言」，实际 L1 审计 50 条（1–50）；`l1-band-audit.md:114-119` 的护栏清单漏了 row 31（`gh>=60/ga>=40`）。
2. `motion-census.md:184-187,225-247` / `ball-static-decomposition.md:69-79` 的一次性 highlight probe 命令不在 §7；数字可复算（740/134.5/0.20 一致），但指针错。
3. 日志/JSON 指向 `.scratch/mc-*-full.json` 与旧 paseo worktree 绝对路径（`motion-census-*-windows.log:28`、`motion-census-frozen-anchors.json:3`、`motion-census-stimulus-engine.log:2`）。
4. `stimulus.json` 的 `engine.config.off_ball_movement_demo: true` 不是 `MatchConfig` 字段（`engine/src/lib.rs:264-273`）。
5. `windows.sha256` 的切片哈希是 parsed event object，不是 raw JSON（`render-ablation.mjs:489-495`）；复算 parsed = recorded，raw 不同。
6. `motion-census-frozen-anchors.json` 无 `wasmSha`/`eventSha`；79.6× 产物不能机械绑到 wasm（`motion-census.mjs runWindows`）。
7. `staticRate` n=21/14，表写「24 窗」（`ball-static-decomposition.md:38-45`）。
8. 本 worktree `viewer/data` 缺 Metrica 两场；note 只标 SkillCorner 在旧 worktree（`motion-census.md:70-73,243-246`）。
9. verdict §0 的 79.6× 同句没有 `frozen`；§3「口径不同」实为窗口/数据集不同（`change0-verdict.md:9-11,64-65`）。
10. A 的「real conditional 未测（待 B）」合并后未回填（`ablation.md:119`）。
11. `tasks.md:71`「产物/notes 全部入库」与 `.scratch` raw full JSON 未入库不完全一致。

## PASS（已核）

- 合并完整性：`git diff --stat main..HEAD -- engine/ viewer/` 空；`git status --porcelain` 空；改动仅 change 目录 + 4 个新 `tools/visual-review/` 文件；无未跟踪/临时文件。
- OpenSpec：`validate --strict` valid；测试 107/107；新测试在 verify.sh step 3 glob 内；`motion-census.test.mjs` 零步反证条绑定条件分支（读断言语体）。
- 冻结身份：wasm `f6a9…` 与 `viewer/engine.wasm` 一致；7 个 sourceHashes 全 MATCH；12/12 event SHA 与 stimulus 一致；24 窗 121 帧；`eng-1201-36` slice hash 用 parsed event 复算 = `b604…`；`stimulus.json == stimulus-A.json`。
- 数字：ablation 5.983/0.908/0.239/0.216 等全部由 `ablation.json` 复算；288 图 hash 全 OK；t1/current 2904 帧 0 差；视觉抽看 `eng-1201-36` 的 movers/current/direct/linear 与「肉眼不可区分 + 零阶保持台阶不可见」一致。
- B：frozen 5.885/0.829/0.239/0.216 vs real 0.244/0.0104/0.040/0.0215；79.6×/109.5×/64.7×；宽扫 1125/476、active 465/107；分解 22.3/32.7/51.4 等全部可复算。
- 用户尺度：5min 48/2/3/0 和 90min 11737/913/28/24/24/10743 用记录 wasm 复算一致。
- 守卫：无删红门/放宽阈值；`git diff main..HEAD -- engine/` 空；guard-audit 行号抽样全对；角球/界外球/抢断被标为护栏，未当真实锚；射门/犯规/传球带的真实锚结论与 L1 审计一致。
- 结论边界：「viewer 不是第一优先」未写成「viewer 无关」；79.6×/10× 的普适性在 §8.1/§8.2 明确否定；L1 当前值标「转述」；tasks 4.1–4.4/5.1–5.3/5.5 勾选与实测一致；5.4/5.6 如实未勾。

## Fix log（Round 1）

日期：2026-11-19。修复者：本分支实现会话。**未改 `engine/`、`viewer/` 行为；未删/放宽任何门；未 push。**

### P1

- **P1-1 ballStatic viewer-chain**：在 `change0-verdict.md` §0/§4（表前）/§7.1/§8 与
  `ball-static-decomposition.md` 文首/§1/§6 明确写：`ballStaticFrac` = **viewer 链引擎
  （`loadEngineFrames` → `viewer/game.js` 插值）vs 真实原始球帧**，viewer 贡献未分离；
  Change 1 不应把它当纯引擎运动层目标，除非先加 raw ball-anchor 模式。`ablation.md` 的
  「归 B」处也补了同一说明。**没有**声称已分离。
- **P1-2 L1 当前值冲突**：`change0-verdict.md` §5 改为「转述（记录冲突，本 change 未重跑）」，
  并列角球均值 2.15 / 3.44 / 4.83 / 7.7–8.3、角球 max 旧 14（余量 1）vs main v11 >15（红）、
  射正率 ~0.47–0.49 vs M5 0.3921。不再把旧余量 1 当当前余量。
- **P1-3 外推点**：`tools/visual-review/motion-census.mjs` 的 `censusOfWindow` 默认跳过
  `p.extrapolated`（按缺帧处理：断开步/步对、不进对称性样本），新增 `includeExtrapolated`
  （默认 false）。重跑 frozen / all / active 三套（JSON + log + notes + verdict 同步）。
  关键数：条件 @0.5 frozen 仍 **0.010416（79.6×）**；旧 turn120 real **0.244→0.221（26.6×）**、
  staticFrac **4.0%→3.69%（6.5×）**、速度 p50 **2.30→2.44**、加速度 p95 **3.23→3.44**；
  每有效步对/每米比值变为 **107.3× / 63.6×**。补测试：构造 `extrapolated:true` 帧，断言默认不参与、
  `includeExtrapolated:true` 才参与。
- **P1-4 active 表聚合**：`motion-census.md` §4.3 整表改为逐场等权并逐行标明口径
  （引擎 93/97/87/93/95 窗、真实 57/50 窗）；§2 的「两种聚合只差 ~0.1%」改为
  引擎 0.09%、真实 active **−3.0%**（0.0275 vs 0.0266）。
- **P1-5 分位口径**：`ball-static-decomposition.md` §2 的窗级 p10/p50/p90 全部改为
  **R type-7**（与 JSON summary 一致），并按来源补「有区间的窗」n：hold 21/24、loose 14/24、
  restart 5/24、highlight 24/24。
- **P1-6 用户尺度基线**：`viewer-match.mjs` 新增 `longestEventGapSec` 与墙钟输出；
  `change0-verdict.md` §6 补「最长无动作段 0.50s」「墙钟 ≈0.1s（本机，仅量级）」；
  「接近/推进可读性」明确写「未量化，留给用户视觉验收」。
- **P1-7 source-hash 强制**：`render-ablation.mjs` 新增并导出
  `assertStimulusSourcesMatch`（校验 `stimulus.json` 的 `viewer.sourceHashes` 对
  `engine/src/lib.rs` + `viewer/*.js`；缺清单/漏文件/任一不符 → 硬错误）。
  `runAction` 与 `motion-census.mjs` 的 `runStimulus` 都调用它。补测试：改一个 viewer 哈希、
  删清单、漏一个已跟踪文件都必须抛错。

### P2（cheap doc）

- verdict「42 条断言」→ **50 条**；`l1-band-audit.md` §9 护栏清单补 row **31**。
- `stimulus.md` 注明 `off_ball_movement_demo` 不是 `MatchConfig` 字段、wasm `parse_config` 忽略。
- `stimulus.md` 注明 `windows.sha256` 切片哈希是 **parsed event object** 的 `JSON.stringify`，不是 raw 文本。
- `motion-census-frozen-anchors.json` 重跑后含 `wasmSha256` 与 `eventShaBySeed`（与 `stimulus.json` 12 seed 全部一致）。
- `ball-static-decomposition.md` 的窗级表补实际 n（21/14/5/24），不再笼统写「24 窗」。
- verdict §0 的 79.6× 标 **frozen**；§3「口径不同」改为「窗口/数据集不同」。
- `ablation.md:119` 的「real conditional 未测（待 B）」回填 **0.0104（79.6×）**；§4 真实列同步 B 的复算。
- `tasks.md` 5.5 改为「本分支入库；SkillCorner/旧 worktree 为已知例外」；§6 记录本轮修复。
- `.scratch` / 旧 worktree 路径：`motion-census.md` §3.1/§3.2 加「历史路径，不要求可复现」。
- highlight 一次性探针：指向不再假装在 §7，明确标「脚本未入库，本树内不可独立复现，只作量级参考」。

### 验证

- `node --test tools/visual-review/*.test.mjs` → **110/110 pass**。
- `openspec validate p155-measurement-instrument --strict` → valid。
- `git diff --stat main..HEAD -- engine/ viewer/` → 空。
- frozen 的 `eventShaBySeed` 与 `stimulus.json` 的 12 个 per-seed 流哈希逐一一致。

## Fix log（Round 2）

日期：2026-11-19。零上下文复审 P0=0 / P1=2（均为 P1-7 残留）。**未改 engine/viewer、未 push。**

### P1

- **P1-A `viewer/match-metrics.js` 漏入 sourceHashes**：`render-ablation.mjs` 的
  `sourceHashes()` 现包含 `viewer/match-metrics.js`（`sampleEngineFrames` 的实现，
  直接决定全部运动读数）。`notes/stimulus.json` 与 `notes/stimulus-A.json` 各加这一条
  （`5fc00e9e…`），其他值未动。`render-ablation.test.mjs` 的 tamper 测试扩到该文件：
  改它会抛错。
- **P1-B `--windows` 无源身份校验**：`runWindows` 现接受 `--stimulus`（缺省读
  `notes/stimulus.json`，缺失即抛错），并硬校验：
  ① `viewer.sourceHashes`；② wasm SHA；③ 逐 seed 事件流 SHA。
  新增纯函数 `assertStimulusWasmIdentity` / `assertStimulusEventIdentity` 并单测
  （错 wasm、错事件流、未登记 seed、缺 wasm 身份都抛错）。
  R7i `r7i-windows.json` 的 `eventHash` 是旧树（`c1-trajectory-morphology-2026-10-29`）口径：
  工具逐 seed 打印差异警告，身份以 `stimulus.perSeed` 为准；JSON 的 `note` 已登记。
  重跑 frozen anchors 后，JSON 的 `windowsPath` / `wasmPath` / `stimulusPath` 改为**仓内相对路径**。
- **P2**：
  - `motion-census.md` §7 的身份校验说明改为代码实际行为：`--stimulus` 的 wasm 不符**只 WARN**
    （事件流才是行为哨兵），源码/事件流不符才抛错；`--windows` 三者都硬校验。
  - 分支名 `p155-instrument/…` → `p155-measurement-instrument/…`；测试数统一为 **19/19**
    （motion-census）/ **111/111**（全部）；`tasks.md` 5.2 标「合并时点 107，当前 111」。
  - `includeExtrapolated` 明确为**函数选项，CLI 未暴露 flag**。
  - `motion-census.md` §4.2 表前补「ballStatic 是 viewer 链、贡献未分离」caveat。
  - `carrier_dribble` 的 active 贡献 `0.1%` → **<0.01%**（复算 0.0094%），两处。
  - `motion-census-diagnostics.json` 的 `generatedFrom` 加「历史路径，不要求可复现」；
    frozen JSON 已改相对路径（见上）。

### 验证

- `node --test tools/visual-review/*.test.mjs` → **111/111 pass**。
- `openspec validate p155-measurement-instrument --strict` → valid。
- `git diff --stat main..HEAD -- engine/ viewer/` → 空。
- 手工反证：坏 wasm / 坏事件流 / 缺 stimulus 三种 `--windows` 调用均以退出码 1 拒绝；
  frozen 重跑的 12 个 `eventShaBySeed` 与 `stimulus.json` 逐一一致。
