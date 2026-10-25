# Pitchcraft 当前基线（引擎改造前）— 2026-10-25

> **用途**：给后续引擎改造（C1–C5 / #89 队形机制 / #19 行为生成）提供**可复现的「改前」对照**：
> wasm 产物 + 真实数据 + P38 八条判据现值 + P18 行为门现值 + 标尺/损失表 + ratchet 基线 + 轨迹图。
> **本文所有数字都是本次实测**，每个数字带命令、时间（Asia/Shanghai）、产物路径与 sha256。
> **未修改任何 tracked 源文件**（`git diff --stat` 为空；收口见 §12）。执行者：`baseline-verifier`。
> 本次任务窗口：2026-10-25 12:04:33 → 12:1x。
>
> 同目录 `current-engine-anatomy.md` 与 `analysis/` 属于**另一并行任务**，不在本文范围。
> 本文产物的原始输出全部在 `out/`（§11 有逐文件 sha256）。

---

## 0. 身份与环境

| 项 | 值 |
|---|---|
| 仓库 | `D:\code\pitchcraft`（main） |
| HEAD | `1c5729d08fd8e1270d52005658bbed18802c1158`（`1c5729d`，2026-10-18 01:00:26 +0800，"Merge pull request #185 from Xingkai98/docs/close-review-loop/2026-10-17"） |
| 开始前工作树 | `git status --porcelain` 为空（干净） |
| Node（跑工具用的） | `D:\Software\node-v24.22.1-win-x64\node.exe`，**v24.22.1**（系统默认 `D:\Program Files\node.exe` 是 v25.9.0，**未用于任何工具运行**） |
| WSL | Ubuntu 24.04.4 LTS，4 核，kernel `6.18.33.2-microsoft-standard-WSL2` |
| Rust（WSL） | `cargo 1.99.1 (5f94df478 2026-08-27)` / `rustc 1.99.1 (58cf8f9c3 2026-10-13)`；target：`wasm32-unknown-unknown`、`x86_64-unknown-linux-gnu` |
| git | `2.38.0.windows.1`（**`core.autocrlf=true`**，来自 `C:/Program Files/Git/etc/gitconfig` —— 这会影响 sha256 哨兵，见 §5b/§9.3） |
| Windows / PowerShell | `Microsoft Windows NT 10.0.26340.0` / PowerShell 5.1 |

⚠ **Windows 本机跑这批工具需要两个环境 shim**（均放在 gitignored 的 `.scratch/tracking-data/`，不改源文件；原因与证据见 §9）：
`run-main.mjs`（修 `file://${argv[1]}` main 守卫在 Windows 恒假）与 `winpath-hook.mjs`+`winpath-resolve.mjs`（修绝对 Windows 路径动态 import）。

---

## 1. wasm 构建

**命令**
```powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc 'export PATH=$HOME/.cargo/bin:$PATH; cd /mnt/d/code/pitchcraft/engine && cargo build --target wasm32-unknown-unknown --release'
wsl.exe -d Ubuntu-24.04 -- bash -lc 'cd /mnt/d/code/pitchcraft && cp engine/target/wasm32-unknown-unknown/release/fm_engine.wasm viewer/engine.wasm'
```
**结果**：exit 0；`Finished release profile [optimized] target(s) in 2.84s`（target 有暖缓存）。
只有 2 条 `static_mut_refs` 警告（`engine/src/wasm.rs:65,70`，**pre-existing**，与产物无关）。

| 产物 | 大小（B） | sha256 | 时间 |
|---|---:|---|---|
| `viewer/engine.wasm` | 267,627 | `bc2f2b2beac7553489eb7243f6ceb0713797a4caf70335cb10bd1aefafcfab40` | 12:05:02 |
| `engine/src/lib.rs` | 693,304 | `eb675c14cd962bbac5718476865bafffe3578d931b9b41111edeb1be63f9591c` | — |
| `engine/Cargo.toml` | — | `1f81e82c46a686860147f021b20bc5a9035ed87a5fe52e69e22a4bcb68f3baa0` | — |
| `engine/Cargo.lock` | — | `7e4aa46e7e839f7cd60be925d0ba1ed8c4b6306feff47226d77a2fb6477bc579` | — |

> ⚠ wasm 文件哈希会随**注释行数**变化（CLAUDE.md §6 / design §D0 的 #104 教训），不要拿它当行为判据；
> 行为等价要看事件流。本文同时记 `engine/src/lib.rs` 哈希，ratchet 用它做「源码变了但 wasm 没重建」哨兵。
> `viewer/engine.wasm` 是 gitignored 构建产物，干净 clone 上不存在。

---

## 2. 真实数据（Metrica 两场）

**命令**（本机 `tools/fetch-tracking-data.mjs` 的 main 守卫在 Windows 恒假 → 用 shim 调用，见 §9.1）：
```powershell
$env:Path = 'D:\Software\node-v24.22.1-win-x64;' + $env:Path
node .scratch\tracking-data\run-main.mjs tools\fetch-tracking-data.mjs --dataset metrica-sample-data
node .scratch\tracking-data\run-main.mjs tools\convert-tracking-to-frames.mjs --in .scratch\tracking-data\sample-data\data\Sample_Game_1 --out viewer\data\real-game-1.json --keyframe-hz 5
node .scratch\tracking-data\run-main.mjs tools\convert-tracking-to-frames.mjs --in .scratch\tracking-data\sample-data\data\Sample_Game_2 --out viewer\data\real-game-2.json --keyframe-hz 5
```
（脚本内部等价于 `git clone --depth 1 --filter=blob:none --sparse …` + `sparse-checkout set data documentation`；本机 git 2.38 支持 sparse，**没有**走 START-HERE §3 的手工 clone 分支。）

**结果**：exit 0 / 0 / 0。拉取目录 `.scratch/tracking-data/sample-data/`（含 `Sample_Game_1/2/3`，**只转换了 1、2**，与验收口径一致）。

| 产物 | 大小（B） | sha256 | 时间 |
|---|---:|---|---|
| `viewer/data/real-game-1.json` | 17,980,866 | `46c041fd81faa310726617be81be865aebc0364acdc33079b4f699088df76047` | 12:06:44 |
| `viewer/data/real-game-2.json` | 17,187,632 | `6911a12ba363ebd745ef4ddefb7e5659900ee2035ba6f5362000b3d4f8395c45` | 12:06:46 |

转换器自报（`out/convert-game1.txt` / `out/convert-game2.txt`，sha256 见 §11）：

| 场 | 帧数 @5Hz | 时长 | 球员填充率 | 球缺失率 |
|---|---|---|---|---|
| game1 | 29,002 | 0.0–5800.2 s | 100% | 39.13% |
| game2 | 28,232 | 0.0–5646.2 s | 100% | 41.01% |

✅ **两场都在**（START-HERE §3 的坑：`like-football.mjs` 会静默跳过缺失文件、标题仍印两场；
本次已 `ls viewer/data/real-game-*.json` 确认两文件都非空，§5a 的运动锚 `disp=13.46 / lat=0.43 / 距离 0.542` 也是「两场口径」的值）。

---

## 3. P38 八条队形判据（现值）

**命令**（`eval-criteria.mjs` 用绝对 Windows 路径动态 import，Windows 上须 `NODE_OPTIONS` 注入 hook，见 §9.2）：
```powershell
$env:Path = 'D:\Software\node-v24.22.1-win-x64;' + $env:Path
$env:NODE_OPTIONS = '--import=file:///D:/code/pitchcraft/.scratch/tracking-data/winpath-hook.mjs'
node openspec\changes\p38-formation-realism\notes\criteria\check-criteria.mjs
```
**结果**：该工具**报告期，退出码 0**（不阻塞）。**5/8 条不达标**（与 START-HERE 记的「当前 5/8 不达标」一致）。
原始输出：`out/p38-criteria.txt`；评测器原始 JSON：`out/p38-eval-current.json`（10 seeds，`matches=10`、`nWin=6`、`crashedSeeds=0`）。

| key | 名称 | 组 | 引擎当前 | 目标（band 或 min） | 判定 |
|---|---|---|---:|---|---|
| `hd` | 纵深 | 纵向 | **38.736** | [23.385, 28.385] | ❌ |
| `spread` | 紧凑度 | 纵向 | **20.722** | [13.41, 17.01] | ❌ |
| `gap` | 重心间距 | 纵向 | **18.905** | [6.54, 10.14] | ❌ |
| `latSd` | 横向位移 sd | 横向 | **3.219** | [7.015, 14.015] | ❌ |
| `swarm` | y 两两相关 | 整体性 | 0.678 | [0.451, 0.891] | ✅ |
| `fault` | 断层幅度 | 结构 | **12.220** | [2.45, 7.45] | ❌ |
| `midBack` | 各线均衡 | 结构 | 0.984 | [0.84, 1.28] | ✅ |
| `shotsReg` | 普通射门/场 | 行为 | 23.400 | ≥ 5.5（单边；真实参照 16.51） | ✅ |

评测器完整读数（`out/p38-eval-current.json`，单位 m 除 swarm/straight）：`hd 38.736 / spread 20.722 / gap 18.905 / width 49.554 / latSd 3.219 / lonSd 7.852 / swarm 0.678 / straight 0.069 / fault 12.220 / midBack 0.984 / shotsReg 23.400`。

> 口径提醒（criteria/README）：`hd/spread/gap/latSd/fault` 是「逐场 3 窗口（300s 窗、步长 900s）→ 窗内 q10–q90 → 逐场再平均」，`latSd` 是 120s 窗内个体横向位移 sd 的均值（**逐场再平均**，不是跨场拼接）。

---

## 4. P18 行为门（现值）

### 4.1 生成引擎侧 canary 产物

**命令**（`verify.sh` P18 段同款；`P18_SOURCE_COMMIT` 必须是**已提交** HEAD；该测试**没有**脏树守卫，只有 env provenance 断言，grep 确认无 `worktree` 检查）：
```powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc 'export PATH=$HOME/.cargo/bin:$PATH; cd /mnt/d/code/pitchcraft/engine && P18_SOURCE_COMMIT=1c5729d08fd8e1270d52005658bbed18802c1158 cargo test --release --test p18_behavior_gates -- --ignored --nocapture p18_canary'
```
**结果**：exit 0，`test result: ok. 1 passed … finished in 1.41s`。

| 产物 | 大小（B） | sha256 | 时间 |
|---|---:|---|---|
| `engine/target/p18-gates/canary.json` | 15,678 | `5ed0136bde18591cce038eba90c6a831e8b19982a6a4a37aeb5c9c19e3ffa35c` | 12:07:24（重跑 12:09:55，**同哈希 ⇒ 确定性**） |

canary provenance（从产物读出）：`mode=canary`、`source_commit=1c5729d08f…`、`model_version=9`、`caliber_version=p18-engine-v1`、
`engine_source_fingerprint=fnv1a64:69d438e67b08239b`、`test_source_fingerprint=fnv1a64:44502befc38cab9b`、`seed_first=1 / seed_last=30`、`match_duration_seconds=5400`、`generated_by=engine/tests/p18_behavior_gates.rs`。

### 4.2 判据器

**命令**：
```powershell
node openspec\changes\p18-behavior-verification-layer\notes\criteria\check-behavior-gates.mjs
```
**结果**：**报告期，退出码 0**；整体**不通过**（2 条真判据不达标；2 条护栏按定义只报信息）。
真实侧：`real-behavior-reference.json`，`caliber=p18-real-v1`，`games=20`，A-League 2024/2025。
原始输出：`out/p18-behavior-gates.txt`。

| key | 名称 | 引擎 | 真实 | 倍数 E/R | 判定 |
|---|---|---:|---:|---:|---|
| A1 | 链墙钟时长 (s) | 29.4866 | 10.1814 | 2.90× | ❌ > 1.5× |
| A2 | 链内动作间隔 (s) start→start | 5.8440 | 3.2010 | 1.83× | ❌ > 1.5× |
| B4 | 持球时间被防守方逼近覆盖占比 | 0.6458 | 0.5609 | 1.15× | ✅ ≥ 0.5×（**现在通过**） |
| A3 | 链内动作数（护栏，min） | 5.1045 | 3.1081 | 1.64× | 护栏：floor = 现状×0.8 = 4.0836 |
| C1 | 以射门收尾的链占比（护栏，min） | 0.1412 | 0.0749 | 1.88× | 护栏：floor = 0.1130；对照栏 `C_shotLastChains` 引擎 23.40 vs 真实 22.75（**1.03×，这才是可比栏**） |

> ⚠ **`gates-spec.json` 里的 `engineCenter` 已陈旧，勿再引用**（判据器只读产物，不受影响）：
> spec 记 A1 49.6507 / A2 12.6355 / B4 0.0581 / A3 3.9016 / C1 0.1767，而本次实际产物是
> A1 29.4866 / A2 5.8440 / **B4 0.6458**（差 ~11×，KNOWN-ISSUES 提的 B4 陈旧得到确认）/ A3 5.1045 / C1 0.1412。
> 因此「链时长 4.88×、间隔 3.95×、压迫覆盖 9.7×」这组老数字**描述的是旧产物**，当前值是上表。

---

## 5. 标尺与损失表

### 5a. `like-football` 损失表（8 行口径）

**命令**
```powershell
$env:Path = 'D:\Software\node-v24.22.1-win-x64;' + $env:Path
node tools\visual-review\like-football.mjs viewer/engine.wasm 5 12
```
**结果**：exit 0。原始输出 `out/like-football.txt`。wasm sha8=`bc2f2b2b`，5 seed × 12s 窗，真实锚 = Metrica real-game-1/2（两场都在）。

| 类别 | 指标 | 引擎 | 真实 | E/R | \|ln(E/R)\| |
|---|---|---:|---:|---:|---:|
| 结构 | 纵深(主) | 38.70 | 18.31 | 2.11 | 0.75 |
| 结构 | 纵深(客) | 36.39 | 18.45 | 1.97 | 0.68 |
| 结构 | 紧凑度 | 20.73 | 12.76 | 1.62 | 0.49 |
| 结构 | 分边★ | 18.88 | 5.24 | 3.61 | 1.28 |
| 结构 | 宽度（※报告行，不进距离） | 49.62 | 35.96 | 1.38 | 0.32 |
| 结构 | 球距 | 18.62 | 14.97 | 1.24 | 0.22 |
| 运动 | 位移/窗★ | 6.27 | 13.46 | 0.47 | 0.76 |
| 运动 | 横向占比★ | 0.37 | 0.43 | 0.85 | 0.16 |
| 运动 | 混队度★ | 0.80 | 0.80 | 1.00 | 0.00 |

**距离（幅度量 mean\|ln(E/R)\|，8/8 行） = 0.542**（旧口径含 width 的 9 行为 0.517）。
性质旗标：方向一致性 dir 0.79 vs 真实 0.70；位移/真实比 0.47；静止占比<0.5m 两侧均 0.00%。
> 与 START-HERE §5 的「两场口径：disp 13.46、lat 0.43、距离 0.542」完全一致，说明本次真实侧数据生成正确。

### 5b. `benchmark-compare`（比赛标尺）—— 本机有 **CRLF 伪影**，两种输出都记

**现象**：直接跑 `node tools/benchmark-compare.mjs` → `P36 标尺：跳过（基线陈旧）`，exit 0，原始输出 `out/benchmark-compare.txt`：
```
基线陈旧：viewer/match-metrics.js 已变更（sha256 d15327f39e91… ≠ 基线记录的 5fc00e9e7a1e…）。
  指标口径变了，旧基线不再可比 —— 重生成：node tools/benchmark-baseline.mjs
```
**根因（已证明）**：**不是基线陈旧，是本机 `core.autocrlf=true` 检出成 CRLF**（入库基线记录的是 LF 形式哈希，CI/Linux 口径）：
```
# git blob（LF）的 sha256 与基线记录逐位相同：
git show HEAD:viewer/match-metrics.js | sha256sum            # 5fc00e9e… = 基线 metricsModule.sha256
git show HEAD:tools/convert-tracking-to-frames.mjs | sha256sum # 8d7634eb… = 基线 converters 记录
# 工作树文件（CRLF）的 sha256 是 d15327f3… ⇒ 只是换行符差异
```
同因导致 `node --test tools/benchmark-baseline.test.mjs` 在本机 8 pass / 2 fail（仅两条陈旧性哨兵红）：
`out/benchmark-baseline-test.txt`（本机 CRLF，2 fail）vs `out/benchmark-baseline-test-lf.txt`（LF 归一化后 **10/10 pass**）。

**处置（临时、可逆、不改 tracked 内容）**：把 3 个被 sha256 的源文件**临时**由 CRLF 写成 LF → 跑工具 → 逐字节还原。
```
临时归一化：viewer/match-metrics.js、tools/convert-tracking-to-frames.mjs、tools/convert-skillcorner-to-frames.mjs
跑：node tools/benchmark-compare.mjs 与 node --test tools/benchmark-baseline.test.mjs
还原后三文件 sha256 与运行前逐位相同（restored=True ×3）；git status 仍干净。
```
> 也试过「patch node:fs.readFileSync 的 preload shim」，**无效**（`node:fs` 内建模块的 ESM 具名导出是快照，后置 patch 不生效），已弃用并删除；证据 `out/benchmark-compare-shimmed.txt`（与未 shim 输出同哈希）。

**LF 归一化后的完整报告**（exit 0，`out/benchmark-compare-lf.txt`）：

Metrica（2 场 / 13 窗，非主数据集）：
| 三项采用指标 | 引擎（5 seed×6 窗） | 真实观测范围 | 结论 |
|---|---|---|---|
| 主队纵深(q10-q90) | 38.70 [36.52–40.20] | 25.94 [16.76–30.19] | 高于真实范围，均值 +49.2%，余量 6.33m |
| 紧凑度(到重心) | 20.73 [19.76–21.04] | 15.24 [10.75–17.15] | 高于，+36.1%，余量 2.61m |
| 两队重心间距 | 18.88 [16.59–19.59] | 8.32 [6.80–10.54] | 高于，+126.8%，余量 6.05m |

SkillCorner（20 场 / 139 窗，**主数据集**；真实摘要来自**入库基线**，本机未拉 20 场原始数据）：
| 三项采用指标 | 引擎 | 真实观测范围 | 结论 / 冻结漂移 |
|---|---|---|---|
| 主队纵深(q10-q90) | 38.70 [36.52–40.20] | 18.31 [11.55–23.95] | 高于，+111.4%，余量 12.58m；冻结基线 38.70（漂移 **+0.0%**） |
| 紧凑度(到重心) | 20.73 [19.76–21.04] | 12.76 [9.70–15.95] | 高于，+62.5%，余量 3.82m；冻结 20.73（**+0.0%**） |
| 两队重心间距 | 18.88 [16.59–19.59] | 5.24 [3.22–8.32] | 高于，+260.6%，余量 8.27m；冻结 18.88（**+0.0%**） |

报告项（主数据集）：客队纵深 36.39 vs 18.45（+97.2%）；宽度 49.62 vs 35.96（+38.0%）；重心到球 18.62 vs 14.97（**重叠**，+24.4%）。
全点口径对照：hd 真实 25.82 [17.05–31.12]；spread 14.78；gap 6.88。
弹性（口径敏感，不作目标）：球在半场 Δ 真实 0.87 / 引擎 −2.42；球相对重心前后 Δ 真实 −1.07 / 引擎 −1.14。
跨数据集可比性（仓库自带检查）：hd/spread/gap/width 重叠但互不包含；ad、ballDist 为 Metrica ⊆ SkillCorner。

> ✅ 「冻结漂移 +0.0%」是**重要交叉验证**：本次 `viewer/engine.wasm`（sha `bc2f2b2b…`、lib.rs `eb675c14…`）产出的引擎侧三项指标与入库基线的引擎值**逐位一致** ⇒ 本 wasm 与「基线当时的 main 引擎行为」等价。

### 5c. 说明
- `like-football` 自 2026-10-16 起是**报告项**（距离不是优化目标，有退化方向）；
- `benchmark-compare` 同样是报告期工具（只打印，不产生 pass/fail）；
- 上面两处「引擎值」来自**两个不同口径**（5 seed×12s 窗 vs 5 seed×6×300s 窗），**不可互比**——ratchet 已把二者分列。

---

## 6. ratchet 基线

**命令**（`tools/ratchet.mjs` 的 main 守卫在 Windows 恒假 → 用 shim；它内部以 `spawnSync('node', …)` 依次跑 like-football / check-criteria / check-behavior-gates，故 `NODE_OPTIONS` 这个 hook 必须设，子进程会继承）：
```powershell
$env:Path = 'D:\Software\node-v24.22.1-win-x64;' + $env:Path
$env:NODE_OPTIONS = '--import=file:///D:/code/pitchcraft/.scratch/tracking-data/winpath-hook.mjs'
node .scratch\tracking-data\run-main.mjs tools/ratchet.mjs save .scratch\notes\team-shape-2026-10-25\ratchet-before.json
```
**结果**：exit 0；落盘 22 项。原始输出 `out/ratchet-save.txt`。

| 产物 | 大小（B） | sha256 | 时间 |
|---|---:|---|---|
| `.scratch/notes/team-shape-2026-10-25/ratchet-before.json` | 1,701 | `7738d4e2f1880f5deee02f326f81ccc53a38aa1a8703745d136629e10f9287bd` | 12:09:35 |

provenance：`commit=1c5729d`、`wasmSha=bc2f2b2beac75534`、`libSha=eb675c14cd962bba`、`node=v24.22.1`、`realGames=2`、`at=2026-10-25T04:09:35.637Z`（=12:09:35+08:00）。

22 项现值（`dir` 方向见 ratchet.mjs 的 METRICS 登记表）：

| id | 值 | 真实/参照 | 方向 |
|---|---:|---:|---|
| lf.disp | 6.27 | 13.46 | higher |
| lf.lat | 0.37 | 0.43 | higher |
| lf.mix | 0.80 | 0.80 | higher |
| lf.hd | 38.70 | 18.31 | lower |
| lf.ad | 36.39 | 18.45 | lower |
| lf.spread | 20.73 | 12.76 | lower |
| lf.gap | 18.88 | 5.24 | lower |
| lf.ballDist | 18.62 | 14.97 | lower |
| lf.distance | 0.542 | — | lower |
| p38.hd | 38.736 | [23.385, 28.385] | band |
| p38.spread | 20.722 | [13.41, 17.01] | band |
| p38.gap | 18.905 | [6.54, 10.14] | band |
| p38.latSd | 3.219 | [7.015, 14.015] | band |
| p38.swarm | 0.678 | [0.451, 0.891] | band |
| p38.fault | 12.220 | [2.45, 7.45] | band |
| p38.balance | 0.984 | [0.84, 1.28] | band |
| p38.shotsReg | 23.400 | — | higher |
| p18.a1 | 29.4866 | 10.1814 | lower |
| p18.a2 | 5.844 | 3.201 | lower |
| p18.b4 | 0.6458 | 0.5609 | lower |
| p18.a3 | 5.1045 | 3.1081 | report |
| p18.c1 | 0.1412 | 0.0749 | report |

**可复现性自检（已做）**：落盘后立刻用同一份基线跑 `diff` → **22/22 全部「持平」、exit 0、`✓ 无退化`**
（`out/ratchet-diff-selfcheck.txt`）。说明采集链路是确定性的、基线可作改前对照。

**改动后对照**（给后续 agent，命令照抄）：
```powershell
# 前提：① 已从**新源码**重建 viewer/engine.wasm；② viewer/data/real-game-1/2.json 都在（2 场）；
#       ③ 已用新 HEAD 重新生成 P18 canary！否则 p18.* 行会拿旧 canary 比，出现假「持平」。
wsl.exe -d Ubuntu-24.04 -- bash -lc 'export PATH=$HOME/.cargo/bin:$PATH; cd /mnt/d/code/pitchcraft/engine && P18_SOURCE_COMMIT=$(cd /mnt/d/code/pitchcraft && git rev-parse HEAD) cargo test --release --test p18_behavior_gates -- --ignored --nocapture p18_canary'
node .scratch\tracking-data\run-main.mjs tools/ratchet.mjs diff .scratch\notes\team-shape-2026-10-25\ratchet-before.json
```
> 退出码语义：0=无退化；1=有退化；2=采集失败（缺数据/产物）。`diff` 只判「不比基线差」，**没有** `×factor` 参数；
> 它只对 `engine/src/lib.rs`↔`viewer/engine.wasm` 做防假绿，**不检查 canary 是否陈旧**（所以 ③ 必须手动保证）。
> 专项目标（如 P38 `hd∈[23.385,28.385]`）不在 ratchet 里，需单独看 §3 的值。

---

## 7. 轨迹图（120s 窗口，t∈[1800,1920]s）

**命令**（`render-trajectories.mjs` 用绝对路径动态 import，Windows 需要 hook）：
```powershell
$env:Path = 'D:\Software\node-v24.22.1-win-x64;' + $env:Path
$env:NODE_OPTIONS = '--import=file:///D:/code/pitchcraft/.scratch/tracking-data/winpath-hook.mjs'
node openspec\changes\p38-formation-realism\notes\probes-main\render-trajectories.mjs engine .scratch\notes\team-shape-2026-10-25\out\traj-baseline.png engine-main-baseline 120
node openspec\changes\p38-formation-realism\notes\probes-main\render-trajectories.mjs real   .scratch\notes\team-shape-2026-10-25\out\traj-real-game1.png metrica-game1 120
```
**结果**：均 exit 0，900×620 PNG。

| 产物 | 大小（B） | sha256 | 脚本读数 |
|---|---:|---|---|
| `out/traj-baseline.png`（引擎 seed 42） | 28,806 | `b439bfbea72fada37ed546c9dab6f99f38cd9eb4485e0178c5faf33987d86bfa` | 22 名球员；非门将横向位移 sd **2.96 m**，纵向 sd **7.65 m** |
| `out/traj-real-game1.png`（Metrica game1） | 40,907 | `349c1de7c98655dc75d822b9c9f3099d82d4e6ef2989a1797e60f1e8b4850957` | 22 名球员；横向 sd **10.04 m**，纵向 sd **14.35 m** |

横向/纵向比（引擎/真实）：**2.96/10.04 = 0.295**、7.65/14.35 = 0.533。
> ⚠ 与 §5a 的 `lat=0.37` **不同口径**（这里是 120s 单窗个体 sd；like-football 是 5 seed×12s 窗的运动学占比），不要混用。
> 看图：真实图是「平滑弧线 + 全队成块平移」；引擎图是「每条轨迹锯齿往返、队形整体摊开」——这是改造后要盯的形态（CLAUDE.md §2：图能发现数字看不到的东西）。
> 图中红色 = id≤10（主队），蓝色 = id>10（客队），白字为 id。

---

## 8. L1 统计门（`realism` 全套 `--ignored`）

**命令**（= `verify.sh` 第 7 步同款）：
```powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc 'export PATH=$HOME/.cargo/bin:$PATH; cd /mnt/d/code/pitchcraft/engine && cargo test --test realism --release -- --ignored'
```
**结果**：exit 0，**9 passed / 0 failed / 0 ignored / 4 filtered out**，两次实测耗时 **85.08s / 84.52s**（比 START-HERE 记的 194s 快，机器不同）。
原始输出：`out/l1-realism-raw.txt`（无 nocapture，只有 pass/fail）与 `out/l1-realism-nocapture.txt`（含关键数字）。

关键数字（`--nocapture` 打印，200 seed 90min，除注明）：
- 每场副作用（P13+pilot3，200 seed）：进球 主1.42/客1.38（H/A=1.025）、pass_evt 847.0、射门 22.23(+header 1.46)、tackle 41.84(succ 19.07)、corner 4.91、throw_in 21.05、goal_kick 27.14、foul 20.86（yellow 2.72 / red 0.08）
- 角球峰值：单场 max=13（界 15，余量 2），均值 4.91/场
- L3 汇总：shots=4738、regular=4447、header=291、goals=559、saved=1259、box_goals_rect=469、禁区占比_rect=0.8390、sot=0.3837、conv=0.1180
- P31 5min cohort（n=1000）：射门/场 1.26、出界重开/场 2.83（角球+界外球 1.34）、犯规/场 1.52、进球/场 0.16
- 主场优势：600 场，home_goals=849 / away_goals=799，H/A=1.063，log(H/A)=0.061，95% CI=[0.965, 1.170]

> 说明：`--ignored` 只跑 `#[ignore]` 的 9 条 L1/L3 统计门；`4 filtered out` 是默认套件测试（不属本步）。
> 全量默认 `cargo test`（含 golden/p124，首次 ~40 min）**没有跑**（任务明确不跑，另有专人）。

---

## 9. Windows 本机环境不兼容（不是仓库缺陷，但会误导；后续 agent 必读）

### 9.1 `main` 守卫 `if (import.meta.url === \`file://${process.argv[1]}\`)` 在 Windows **恒假**
- 现象：脚本**静默什么都不做，退出码 0、零输出**。首跑 `node tools/fetch-tracking-data.mjs --dataset metrica-sample-data` 就是空输出。
- 原因：Node 的 `process.argv[1]` 是 `D:\code\...\x.mjs`（反斜杠），`import.meta.url` 是 `file:///D:/code/.../x.mjs`，字符串永不相等。
- 受影响（grep 实测）：`tools/fetch-tracking-data.mjs`、`tools/convert-tracking-to-frames.mjs`、`tools/convert-skillcorner-to-frames.mjs`、`tools/ratchet.mjs`、`openspec/.../probes-main/check-criteria-local.mjs` 等。
  用 `pathToFileURL(process.argv[1]).href` 的（`tools/benchmark-*.mjs`、`queue-cli.mjs`、`service.mjs`）**不受影响**。
- 处置：`.scratch/tracking-data/run-main.mjs <target.mjs> [args...]`（把 `argv[1]` 改成 URL 去掉 `file://` 前缀的字符串再 `import` 目标模块，令守卫成立）。**未改源文件。**

### 9.2 绝对 Windows 路径动态 import 被 ESM loader 拒绝
- 现象：`Error [ERR_UNSUPPORTED_ESM_URL_SCHEME] ... Received protocol 'd:'`（`eval-criteria.mjs` 的 `import(\`${HERE}/viewer/game.js\`)`）。
- 处置：`.scratch/tracking-data/winpath-hook.mjs` + `winpath-resolve.mjs`（ESM resolve hook：`^[A-Za-z]:[\\/]` 的 specifier 转 `pathToFileURL`），通过 `NODE_OPTIONS=--import=file:///…/winpath-hook.mjs` 注入；spawnSync 的子 node 也会继承。

### 9.3 `core.autocrlf=true` ⇒ sha256 陈旧性哨兵假红（本机检出伪影）
- 现象：`tools/benchmark-compare.mjs` 报「基线陈旧」；`tools/benchmark-baseline.test.mjs` 2/10 红（指标模块哈希、转换器指纹）。
- 证明：`git show HEAD:<file> | sha256sum`（LF）与基线记录**逐位相同**；工作树 CRLF 哈希不同。
- 处置：跑这两个工具前**临时**把 3 个文件写成 LF，跑完逐字节还原（见 §5b）。**未提交任何改动。**

> 前两条是**真实的跨平台缺陷**（Windows 上这些验收工具静默失效），值得单开 ticket；第三条是环境差异（CI/Linux 无此问题）。
> 所有 shim 均在 gitignored 的 `.scratch/tracking-data/`（`run-main.mjs` 1,312 B / `winpath-hook.mjs` 1,246 B / `winpath-resolve.mjs` 619 B），不随仓库提交。

---

## 10. 不可得 / 未做项（显式清单）

| 项 | 状态 | 原因 |
|---|---|---|
| SkillCorner 20 场原始数据（~1.8 GB） | ❌ 未拉 | 任务范围只要求 Metrica 两场；`benchmark-crossvalidation.mjs` 因此未跑（§5b 的 SkillCorner 真实摘要来自**入库基线**，不需要本地原始数据） |
| `tools/benchmark-crossvalidation.mjs` | ❌ 未跑 | 不在本次步骤清单；且它是报告项非门（CLAUDE.md §6/verify.sh 第 8 步说明） |
| `./verify.sh` 全量 9 步 | ❌ 未跑 | 任务明确不跑（第 1 步 debug cargo 测试约 40 min，另有专人）；本文覆盖的步骤已单跑 |
| P38 `drive-criteria.mjs` 变异自证（16 变体） | ❌ 未跑 | 重量级开发期工具（逐变体重建 wasm），不在本次步骤清单 |
| P18 `gates.test.mjs` 反证条 / P38 `shot-criterion.test.mjs` | ❌ 未跑 | 不在本次步骤清单（它们是「判据没被改坏」的门，非现值采集） |
| `gates-spec.json` 的 `engineCenter` | ⚠ 已陈旧 | §4.2；判据器不读它，但文档数字勿引用 |
| P38 `latSd` 在 CLI 表里只显示 2 位 | ⚠ 已知限制 | README 记过；本文用 `eval-criteria` JSON 的 3 位值（3.219） |
| 干净 clone 上的 `benchmark-compare` | ⚠ 本机需 LF 归一化 | §5b（Linux/CI 上直接可跑） |

---

## 11. 本次产物清单（本 note 目录，sha256）

| 文件 | 大小（B） | sha256 |
|---|---:|---|
| `ratchet-before.json` | 1,701 | `7738d4e2f1880f5deee02f326f81ccc53a38aa1a8703745d136629e10f9287bd` |
| `out/fetch-tracking-data.txt` | 2,548 | `8d5e1c2f2599b0c22d2598a01b4538f35993c6565e5c874eb6ae5190db9f2ef2` |
| `out/convert-game1.txt` | 894 | `93b515a2b593a9bab8167b214e691bbc124afaf25d3376fec57e1bb2c49afae0` |
| `out/convert-game2.txt` | 894 | `635cc5b17d9965a47ced1093fbd93619f813dc8588f8527eb3ad9dffd61d0fe8` |
| `out/p38-criteria.txt` | 1,250 | `77551f785c4ae83550a75aa493f24600607c86a669429edf4f4b82a2ed0f76f0` |
| `out/p38-eval-current.json` | 440 | `ec56d75880a7e944a6027a39b1a9f93b04dc6c070ff1b7f6092febd4503f22a7` |
| `out/p18-canary-gen.txt` | 479 | `fabc15586afb584e648611c4bae40a47e9646c1b04ecb859104556236d3011e7` |
| `out/p18-behavior-gates.txt` | 3,522 | `10f94e435f6c884206493132ec89b5cb604c8df8356579ca6ed055812670796f` |
| `out/like-football.txt` | 2,774 | `b16938bd126389315825827d82481c265783458666966d2db68b0897258bca16` |
| `out/benchmark-compare.txt`（未处理，skip 原文） | 312 | `40e1b9975bda5217a6d13c401005b0aa89717d25a86a069e9c0575e5224ba11e` |
| `out/benchmark-compare-shimmed.txt`（失败尝试证据，同哈希） | 312 | `40e1b9975bda5217a6d13c401005b0aa89717d25a86a069e9c0575e5224ba11e` |
| `out/benchmark-compare-lf.txt`（LF 归一化后完整报告） | 6,152 | `e29cd3c175602c27ed01c05963afe3fb6e482ee1b358c61dc21c7782773d3bb2` |
| `out/benchmark-baseline-test.txt`（本机 CRLF，2 fail） | 5,682 | `987ea85e23c82dcee98a6d4248c27f8a22af77b7e9a21cefd78e83df0ab0edd3` |
| `out/benchmark-baseline-test-shimmed.txt`（失败尝试证据） | 5,684 | `c4463e692fec2efeed2ebe53e6a1327e7285fdd91b0ba0ee975eb421a0d9bf64` |
| `out/benchmark-baseline-test-lf.txt`（LF 归一化后 10/10 pass） | 1,270 | `090a04b29be9ce5a0fcb4dac9e6ae8a14e832fc0dccb7a8fa65a4ea326bd2f27` |
| `out/traj-engine.txt` | 1,090 | `3dd6ca801dd0e3ec4550a2def3049e99c463ad9e6f056153a5a4ec10d85d694e` |
| `out/traj-real.txt` | 1,128 | `54027f652c2551af322cbf8e4a2527b7589cc2c7bf8dbc89ffa8544e95cbb3b8` |
| `out/traj-baseline.png` | 28,806 | `b439bfbea72fada37ed546c9dab6f99f38cd9eb4485e0178c5faf33987d86bfa` |
| `out/traj-real-game1.png` | 40,907 | `349c1de7c98655dc75d822b9c9f3099d82d4e6ef2989a1797e60f1e8b4850957` |
| `out/ratchet-save.txt` | 1,556 | `5f75550d4023ca9f6fd524358c39a412536caba50abec76625a00794785c2739` |
| `out/ratchet-diff-selfcheck.txt` | 2,970 | `1c5f00adc13f1bbf995a87c4ffdaf81f9d630690f679f73de1c76a3e1786eaa9` |
| `out/l1-realism-raw.txt` | 726 | `e341ff7ecb756f17b637a1c44e5c30ec5b230f906e0e93f499f2b630cbade5f0` |
| `out/l1-realism-nocapture.txt` | 1,615 | `fb45a84605fb5436c26f6f1c4f2e32c364174bbe67ac0fef8a6942df04a3b9f0` |

仓库内 gitignored 产物（不入库，本次生成/使用）：
`viewer/engine.wasm`（`bc2f2b2b…`，§1）、`viewer/data/real-game-1/2.json`（§2）、`engine/target/p18-gates/canary.json`（`5ed0136b…`，§4）、`.scratch/tracking-data/sample-data/**`（Metrica 源数据）、`.scratch/tracking-data/{run-main,winpath-hook,winpath-resolve}.mjs`（§9 的 shim）。

---

## 12. git 收口

结束时：
```
$ git status --porcelain
?? .scratch/notes/team-shape-2026-10-25/
$ git diff --stat        # 空
```
即：**唯一新增的非忽略路径就是本 note 目录**（本次任务产出）；所有 gitignored 产物（`viewer/engine.wasm`、`viewer/data/real-game-*.json`、`engine/target/**`、`.scratch/tracking-data/**`）不出现在 status 里。
**未修改任何 tracked 源文件**（`engine/src/**`、`viewer/*.js`、`openspec/**`、`tools/**` 全部未动；§5b 的临时 LF 归一化已逐字节还原，三文件 sha256 与运行前一致）。
> 同目录下的 `current-engine-anatomy.md` / `analysis/` 是另一并行任务的产物，不是本次 baseline 的交付物（也不在本进度内）。

---

## 13. 复跑 TL;DR（照抄即可重建本基线）

```powershell
# ── 环境 ──
$env:Path = 'D:\Software\node-v24.22.1-win-x64;' + $env:Path
$env:NODE_OPTIONS = '--import=file:///D:/code/pitchcraft/.scratch/tracking-data/winpath-hook.mjs'

# ── 1) wasm → viewer/engine.wasm（WSL，记录 sha256 与 engine/src/lib.rs sha256）──
wsl.exe -d Ubuntu-24.04 -- bash -lc 'export PATH=$HOME/.cargo/bin:$PATH; cd /mnt/d/code/pitchcraft/engine && cargo build --target wasm32-unknown-unknown --release && cp target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/engine.wasm'

# ── 2) 真实数据两场（Windows 走 run-main shim）──
node .scratch\tracking-data\run-main.mjs tools\fetch-tracking-data.mjs --dataset metrica-sample-data
node .scratch\tracking-data\run-main.mjs tools\convert-tracking-to-frames.mjs --in .scratch\tracking-data\sample-data\data\Sample_Game_1 --out viewer\data\real-game-1.json --keyframe-hz 5
node .scratch\tracking-data\run-main.mjs tools\convert-tracking-to-frames.mjs --in .scratch\tracking-data\sample-data\data\Sample_Game_2 --out viewer\data\real-game-2.json --keyframe-hz 5

# ── 3) P38 八条（报告期）──
node openspec\changes\p38-formation-realism\notes\criteria\check-criteria.mjs

# ── 4) P18 canary + 行为判据（报告期；canary 确定性可重跑）──
wsl.exe -d Ubuntu-24.04 -- bash -lc 'export PATH=$HOME/.cargo/bin:$PATH; cd /mnt/d/code/pitchcraft/engine && P18_SOURCE_COMMIT=1c5729d08fd8e1270d52005658bbed18802c1158 cargo test --release --test p18_behavior_gates -- --ignored --nocapture p18_canary'
node openspec\changes\p18-behavior-verification-layer\notes\criteria\check-behavior-gates.mjs

# ── 5) 标尺 + 损失表（benchmark-compare 需先按 §5b 临时 LF 归一化 3 个文件）──
node tools\visual-review\like-football.mjs viewer/engine.wasm 5 12
node tools\benchmark-compare.mjs

# ── 6) ratchet 基线 ──
node .scratch\tracking-data\run-main.mjs tools\ratchet.mjs save .scratch\notes\team-shape-2026-10-25\ratchet-before.json

# ── 7) 轨迹图 ──
node openspec\changes\p38-formation-realism\notes\probes-main\render-trajectories.mjs engine .scratch\notes\team-shape-2026-10-25\out\traj-baseline.png engine-main-baseline 120
node openspec\changes\p38-formation-realism\notes\probes-main\render-trajectories.mjs real   .scratch\notes\team-shape-2026-10-25\out\traj-real-game1.png metrica-game1 120

# ── 8) L1 统计门（~85 s）──
wsl.exe -d Ubuntu-24.04 -- bash -lc 'export PATH=$HOME/.cargo/bin:$PATH; cd /mnt/d/code/pitchcraft/engine && cargo test --test realism --release -- --ignored'
```
