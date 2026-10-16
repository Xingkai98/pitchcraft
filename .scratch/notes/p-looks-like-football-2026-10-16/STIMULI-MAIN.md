# 刺激集用 main 现构建重渲——结果：**逐字节无变化**

**日期**：2026-10-16 · **执行**：主 session（零上下文任务）
**任务**：把双盲判别测试的刺激集（SET-CLEAN，24 张）用 **origin/main 净树现构建**的 wasm 重渲一遍，
回答「main 现在还能不能被裁判一眼分出」。

---

## 0. 结论先行（一句话）

**能重渲，且重渲后 24 张 PNG 与旧那批逐字节完全相同** ——
因为刺激集当初用的那份 wasm（`9ea317b2…`）与 main 现构建（`b0bc4796…`）
**在事件流上逐位等价**（扫 seed 0–23 全部相同）。任务书里「两者行为差很多」的前提
**不成立**：那组对照数（P1 1.00 / P5 0.00 / 静止率 26–60%）与 main 现在的读数（P1 0.971 /
P5 0.0570 / 静止率 0.751%）**不是两次构建之差，是两套取样口径之差 + 一条已被撤回的陈旧数字**。
详见 §4、§5。

---

## 1. 净树指纹

```
git worktree add /tmp/stim-main origin/main      # HEAD = d601f00573d9757265f4ac1a3f2126b7473f95b2（detached）
export PATH="$HOME/.cargo/bin:$PATH"
cd engine && cargo build --target wasm32-unknown-unknown --release
cp engine/target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/engine.wasm
```

| 文件 | sha256 | sha16 | 大小 |
|---|---|---|---|
| `engine/src/lib.rs` | `75190e51f5b28876883b07295c06f8d485eaeee4a2a343bd6b4256cf8f9b3a7a` | `75190e51f5b28876` | — |
| `viewer/engine.wasm` | `b0bc479678af53aadd7b0f3c7659b7f9232891b90a038f02c01dc1bd59518f24` | `b0bc479678af53aa` | 264 953 B |

`lib.rs` 的 sha16 `75190e51…` **与任务书里写的一致**（⇒ 这就是任务书所指的「main 现构建」）。
干净的 `git status --short` 在净树里为空（只有 gitignore 的 `viewer/data/*.json` 与 `viewer/engine.wasm`，
未跟踪也不显示）；`cargo build` 无新增改动。**未修改仓里任何 tracked 文件**。

> 三份证据 wasm 已留存：`/tmp/stim-evidence/{main-d601f00-b0bc4796, baseline-cd42b0a-574b653f, dirty-worktree-9ea317b2}.wasm`

---

## 2. 口径问题：现构建 / 基线记录 / 【入库文件】三者的关系

### 2.1 先纠正一个前提

**`viewer/engine.wasm` 不是「checked-in 文件」——它从未入过库。**

```
$ git ls-files viewer/engine.wasm                  # 空
$ git log --all --oneline -- viewer/engine.wasm    # 空
$ git ls-tree -r origin/main --name-only | grep -c viewer/engine.wasm   # 0
$ git check-ignore -v viewer/engine.wasm
  .gitignore:4:viewer/engine.wasm    viewer/engine.wasm
```

它的定位是**本地构建产物**（`.gitignore:4` 明写「WASM 产物（由 cargo build 生成）」）。
所以第三项只能问「**仓里能找到的那份**」（主仓工作树 `/tmp/tackle-el/viewer/engine.wasm`）：
sha256 `9ea317b28ccef327a4c1006ea6f202a03ae3e0c02cfc221f290166f145b4d10b`（265 174 B，2026-10-16 10:06），
它对应的源码是**脏工作树**的 `lib.rs` sha256 `9474b87c…`（= `M engine/src/lib.rs` 那份）。

### 2.2 三者两两不等，但行为上分两组

| | 源码 lib.rs sha256 | wasm sha256 |
|---|---|---|
| **① 现构建**（净树 origin/main @ d601f00） | `75190e51…` | `b0bc4796…` |
| **② 基线记录**（`benchmark-baseline.json → engineFingerprint`） | `ed9c23f5…` | `574b653f…` |
| **③ 仓里那份**（主仓工作树，gitignored） | `9474b87c…`（脏） | `9ea317b2…` |

**① ≠ ②（任务书问的那条）：是，确不相等。** 而且不是「只差一行」——两者源码 sha256 都不同。

### 2.3 基线那对哈希的出处已溯源（可复现）

基线 `sourceSha256 = ed9c23f5…` 对应 **`lib.rs` @ `cd42b0a0`**（p143r-v4 整合提交，PR #148，
`git merge-base --is-ancestor cd42b0a origin/main` 通过 ⇒ 是 main 的祖先）。在该提交上重建：

```
$ git worktree add --detach /tmp/stim-cd42b0a cd42b0a && (cd engine && cargo build --release --target wasm32-unknown-unknown)
engine/src/lib.rs   = ed9c23f59f7d9007d880bb2beebd3492801326eac5fdcd15649fbe539f4e0d69   ← 与基线 sourceSha256 逐位相同
fm_engine.wasm      = 574b653f7d8e31809be04b15fc6cdc9cf071fde1d7c3d2b5df603091d3c778c5   ← 与基线 wasmSha256 逐位相同
```

⇒ **基线记录的那对哈希 = `cd42b0a` 的构建，可逐位复现**（不是丢失的构建，不是 toolchain 漂移）。

### 2.4 但「基线陈旧」这件事本身要订正：它是**真的行为陈旧**，不是注释

仓里的哨兵 `tools/benchmark-baseline.test.mjs` 在净树里 **10/10 通过**，并打印：

> `注：engine/src/lib.rs 已变更但引擎指标逐位一致（仅注释/重构）。`

**这条打印是误判。** 把三份 wasm 各跑 24 个 seed 的 5400 s 全流 sha256：

```
扫 seed 0..23（各 5400 s 全流 sha256）
  main(b0bc4796) vs 基线(cd42b0a / 574b653f): 不同 seed 3/24 -> [2, 20, 23]
  main(b0bc4796) vs 仓里那份(9ea317b2)      : 不同 seed 0/24 -> []
  基线哨兵用的 BENCHMARK_SEEDS = [42,1,7,99,123]；其中差异 seed 数 = 0
  刺激集用的  ENGINE_SEEDS    = [42,1,7,99,123,2]；其中差异 = [2]
```

- 哨兵只跑 `BENCHMARK_SEEDS = [42,1,7,99,123]` —— **三个真正有差异的 seed（2/20/23）一个都不在采样面里**，
  于是它看到的永远是「逐位一致」，落进「放行」分支并给出「仅注释/重构」的结论。
  ⇒ 这是**哨兵盲区**（5 个种子覆盖不到行为面），不是「源码只改了注释」的证据。
- **注意种子 2 恰好在刺激集的 `ENGINE_SEEDS` 里**：如果刺激集当初用的是基线那份 wasm，
  6 张 seed-2 的引擎图会不一样。实际用的是脏树那份，而它 ≡ main。

---

## 3. 保留旧套 + 重跑生成器

```
mv /tmp/discrim-clean /tmp/discrim-clean-old      # 旧套原样保留
cd /tmp/stim-main && node .scratch/notes/p-discrimination-2026-10-15/gen-stimuli.mjs clean
```

生成器**取自净树（= origin/main 入库版），一字未改**：sha256 `7ca96905e1a4e811…`
与旧 `KEY.json` 里记的 `generatorSha256` **逐位相同**。它的 `ROOT` 由脚本自身路径解析
（`import.meta.url` + `../../..`）⇒ 在净树里跑，wasm 读的正是 §1 那份、真实数据从
`/tmp/stim-main/viewer/data/` 读（`real-game-{1,2}.json` 是 gitignored，已从主仓拷入；
两份与主仓逐位相同）。日志 `/tmp/stim-run.log`。

生成器自报指纹：`# [SET-CLEAN] 引擎源码指纹 lib.rs=75190e51… wasm=b0bc4796…`。

---

## 4. 验收（逐条实测，不只看日志）

| # | 判据 | 实测 | |
|---|---|---|---|
| ① | 24 张、非 png 0 | `stimuli/` 24 个条目，非 `.png` **0**，非普通文件 **0**；24 个文件头均为 PNG magic `89504e470d0a1a0a`；`presentation-order.txt` 的 24 个名字集合与 `stimuli/` 完全一致；`KEY.json` 条目数 = 24 | ✅ |
| ② | `audit-clean.json` 四类瑕疵全 0 | `outOfRangePanels=0`、`ballMissingPanels=0`、`ballOutOfRangePanels=0`、`dupCoordPanels=0`、`not22Panels=0`（面板 84 = 真实 42 + 引擎 42） | ✅ |
| ③ | 独立性检验：前 12 里真实张数 ∈ [4,8] | 前 12：**真实 8 / 静止帧 7**（规则 real∈[4,8] **且** still∈[4,8] ⇒ 通过）；洗牌种子 1（否掉 0 个），`KEY.json` 自记一致 | ✅ |
| ④ | `KEY.json` 记的 wasm sha256 = §1 构建的那份 | `KEY.json → meta.engineFingerprint.wasmSha256` = `b0bc479678af53aadd7b0f3c7659b7f9232891b90a038f02c01dc1bd59518f24` = §1 现构建；`libRsSha256` 亦 = 实测 `75190e51…` | ✅ |

**四条全绿。**

---

## 5. 与旧那套的差异（`/tmp/discrim-clean-old/KEY.json` vs 新 `KEY.json`）

| 项 | 结果 |
|---|---|
| 同源窗口/seed（逐 stim 比 `source/match/t0/seed/kind`） | **24/24 一致，0 处不同** |
| 球位移 `ballDisp` | **24/24 无变化**（引擎侧如 seed42/still 0.563 m、seed1/still 19.387 m，逐位相同） |
| `resolvedTimes` / 可用性 / 修复动作 | 无变化（真实侧同样只弃 2 个窗：`game1/still@1800`、`game1/sheet@1800`，理由同为死球） |
| `presentation-order.txt` | **逐字节相同** |
| 真实侧 12 张 PNG | **逐字节相同**（真实侧与 wasm 无关，本应如此） |
| **引擎侧 12 张 PNG** | **逐字节相同** ← 本任务的关键结果 |
| 24 张 PNG 合计 | **24/24 sha256 相同** |
| 引擎指纹 | 旧 `wasm 9ea317b2 / lib.rs 9474b87c` → 新 `wasm b0bc4796 / lib.rs 75190e51`；其余三项指纹（`metricsJsSha256`/`renderMjsSha256`/`generatorSha256`）**不变** |

**为什么引擎图会一模一样**（不是没重跑）：重跑本身是实测过的——日志里 6 个 seed 都重新
`simulateStream` 过（12 张引擎图由 6 次 5400 s 全新模拟的帧渲染）。相同的根因是：

1. 两份 wasm 的**事件流逐位相同**（seed 0–23 全同，§2.4）；
2. 脏树 `lib.rs` 的改动（`git diff` 213 增 42 删）**全是开关置 0 的实验**与等价重构：
   `RANK_MARGIN_M = 0.0`（秩门槛关）、`FORM_BALL_ANCHOR = 0.0`（球锚块关，且代码里写成
   **显式分支** `if FORM_BALL_ANCHOR == 0.0 { return 原文; }`，不是「乘 0 再相加」）、
   以及把 `second_nearest_defender_m()` 并入 `two_nearest_defenders()` 的**单次扫描**。
   这些改动的源码注释本身就写着「逐位等价，由事件流哈希守」。

⇒ **「用 main 现构建重渲」对这批刺激集是一个严格的空操作。**

---

## 6. 顺带：那些「两者差很多」的数字，到底在比什么

任务书对比的两组数，来源可查：（a）**旧刺激集**的 `P1=1.00 / P5=0.00 / 静止率 26–60%`
来自 `PANEL-v1-FROZEN.md §1` 的「引擎现状」列；（b）**main 现构建**的 `P1=0.971 /
P5=0.0570·0.1019 / 静止率 0.751%` 来自仓里工具 `tools/visual-review/panel.mjs`。

我在净树里用**同一份现构建 wasm** 把两者都算了一遍：

```
$ node tools/visual-review/panel.mjs --dataset engine --wasm viewer/engine.wasm --lib engine/src/lib.rs
   引擎指纹：lib.rs 75190e51f5b28876  wasm b0bc479678af53aa  seeds=42,1,7,99,123
   P1  命中帧占比   n=30  mean 0.971  med 0.980  q10 0.934  q90 0.999  [0.891 … 1.000]
   P5  <2 m 帧占比  n=30  mean 0.0570 med 0.0583 q10 0.0272 q90 0.0947 [0.0107 … 0.1080]
   P3b 静止占比(%)  n=2250 mean 0.751  med 0.000  q10 0.000 q90 0.000 [0.000 … 75.000]
```

同时，在**刺激集那 12 个窗（42 面板）**的坐标上复算冻结口径（探针 `/tmp/stim-main/zz_probe_panel*.mjs`，用完已删）：

| 口径 | 样本 | P1 命中 | 较窄队 y 跨度 (m) | P5 `<2 m` |
|---|---|---|---|---|
| **刺激集 12 窗**（6 seed × {t=1800 still} ∪ {t=3600–3612 sheet}） | 42 帧 | **42/42 = 1.00** | min 45.85 / med 49.73 / max 49.95 | **3/42**（min 1.000 m，全部是 seed123/sheet，对 ids 3–11） |
| **标尺 30 粗窗**（5 seed × 6×300 s） | 45 000 帧 | mean 0.971，最坏窗 0.891 | mean 49.09 | mean 0.0570 帧占比 |

**读法**：

- **`P1 1.00` 与 `P1 0.971` 是同一份 wasm 的两个样本**——刺激集的 12 个窗全部落在
  「两队同时宽」的命中区（比率 1.00），而 30 个标尺粗窗里有窗低到 0.891。
  ⇒ 差的是**窗选择**，不是构建。（附带的一条诚实记录：刺激集的引擎窗在 P1 上位于**最像引擎**的一端，
  即判别线索最强的子样本。）
- **`P5 引擎 0.00` 复算不出来**：现构建在刺激面板上是 **3/42**，工具在粗窗上是 **mean 0.0570**。
  ⇒ `PANEL-v1-FROZEN.md §1` 的引擎列在这一行**不成立**（不是「0 就是很干净」的口径差异，
  是同一批图上能测到 <2 m 的对）。
- **`静止占比 26–60%` 已由上游自己撤回**：`PANEL-CALIBRATION.md §3.3` 原文
  「FROZEN v1 的引擎 26–60% vs 真实 5–14% 已经不存在：两侧中位数都是 0 …… 现在连『引擎静止率高』
  这个前提都没了」。我按 12 s 窗位移口径复算是 mean 9.456%（中位 5.436 m/12 s），
  与工具 `still` 口径（mean 0.751%、中位 5.999 m）**不一致**——两种口径我都没能重建出 26–60%，
  故**这一格我判为「不可复现的陈旧数字」**，不判为口径差异（差异的具体写法我没拿到，如实留白）。

⇒ 结论：**`PANEL-v1-FROZEN.md §1` 的引擎列有两行（P5、P3b）不可复现，只有 P1 复现**；
把它当「旧刺激集引擎侧」的描述并据此推出「两者行为差很多」，是**结论对但机制错**的又一例
（本仓反复出现的形态）。

---

## 7. 交付与一句话判定

**这一批是否可以交裁判？** —— **是，但要知道它等于旧那批。**

- 四条验收全绿（§4），刺激集本身干净、可交；
- 但重渲是空操作（§5）：24 张与原批**逐字节相同**，引擎侧已证明与 main 现构建**逐位等价**
  （seed 0–23 全同，§2.4）；
- ⇒ **旧那轮「3 位裁判全部 24/24 + 用户 8/8」的结果原样适用于 main 现构建**，
  「main 现在还能不能被一眼分出」的答案是：**能，而且和当时一样**——因为 main 就是当时那份行为。
- ⚠️ **推论**：拿这批去重跑判别测试**不会**得到新的信息量（同一套图、同一个答案）。
  若目的是「排除裁判其实在认 Metrica 那两场」，需要的是**换样本**（SkillCorner 场次 + 新窗新 seed），
  不是换 wasm——这正是 `PANEL-v1-FROZEN.md §6.4` 已经写下的下一步。

**残余风险 / 我没覆盖的**：等价性判据是**事件流 sha256**（坐标层可见行为）；我没有对 wasm
做反汇编级比对，也没覆盖事件流之外的面（例如某个未被 5400 s 模拟触发的分支）。

---

## 8. 复现命令清单

```bash
git worktree add /tmp/stim-main origin/main
export PATH="$HOME/.cargo/bin:$PATH"
(cd /tmp/stim-main/engine && cargo build --target wasm32-unknown-unknown --release)
cp /tmp/stim-main/engine/target/wasm32-unknown-unknown/release/fm_engine.wasm /tmp/stim-main/viewer/engine.wasm
sha256sum /tmp/stim-main/engine/src/lib.rs /tmp/stim-main/viewer/engine.wasm
cp /tmp/tackle-el/viewer/data/real-game-{1,2}.json /tmp/stim-main/viewer/data/
mv /tmp/discrim-clean /tmp/discrim-clean-old
(cd /tmp/stim-main && node .scratch/notes/p-discrimination-2026-10-15/gen-stimuli.mjs clean)
(cd /tmp/stim-main && node tools/visual-review/panel.mjs --dataset engine --wasm viewer/engine.wasm --lib engine/src/lib.rs)
```

**产出位置**：新套 `/tmp/discrim-clean/`、旧套 `/tmp/discrim-clean-old/`、
证据 wasm `/tmp/stim-evidence/`、日志 `/tmp/stim-run.log`、`/tmp/panel-engine.log`。
