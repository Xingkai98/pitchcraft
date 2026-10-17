---
title: 开工必读（C1–C5 通用）
date: 2026-10-17
audience: 零上下文开发者 / 新会话
---

# 开工必读（C1–C5 通用）

> 面向**零上下文**会话。读完这一页 + 对应票据，就够了。
> 地图：[#175](https://github.com/Xingkai98/pitchcraft/issues/175) ｜ 票据：[#170](https://github.com/Xingkai98/pitchcraft/issues/170)–[#174](https://github.com/Xingkai98/pitchcraft/issues/174)

---

## 0. 先判断你要做的是哪一类工作

| 类型 | 走法 |
|---|---|
| **改引擎行为**（C1–C5 都是） | 走 OpenSpec：先建 `openspec/changes/<name>/`（proposal / design / specs / tasks），`validate` 通过、**用户确认 design 后**再写实现 |
| 改文档 / 探针 / 一次性实验 | 直接改，PR 走 CI 即可 |

**C1–C4 的第一产物是 design，不是代码。** 没有批准过的 design 就开写，会被打回。

---

## 1. 环境

- **Node ≥ 22**（CI 用 22；本机 24 也可以）
- **Rust stable**（`edition = "2021"`，需要 ≥ 1.56）+ `wasm32-unknown-unknown` target
- `git`：本机实测 2.19，**缺 `git clone --sparse`**（2.25 才有）。拉数据见 §3
- 依赖：`npm ci`（有 `package-lock.json`）
  - `node_modules` 是忽略项。仓库历史上曾把它提交成一个软链接，2026-10-17 已移除

---

## 2. 构建与验证

```sh
# 1) WASM 产物（viewer/*.mjs 的验收工具都要它；被 .gitignore 排除）
cd engine && cargo build --target wasm32-unknown-unknown --release \
  && cp target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/engine.wasm && cd ..

# 2) 全套验证（9 步）
./verify.sh

# 3) 日常快速循环（不要每次都跑 verify.sh 第 1 步）
cd engine && cargo test --release            # 7m38s（本机 M 系列实测）
cargo test --test realism --release -- --ignored   # 194s，L1/L3 统计门
```

**verify.sh 第 1 步是 debug 版 `cargo test`**，其中 `p124_intent_observations` 要跑 30 seed × 5400 s
——首次约 **40 分钟**。这不是卡死，别 kill。

---

## 3. 真实对照数据（验收要用）

`viewer/data/*.json` 全部被 gitignore，**干净 clone 上没有**。

### Metrica（C1 的 `disp` / `lat` 锚，C2–C4 的结构对照）

```sh
node tools/fetch-tracking-data.mjs --dataset metrica-sample-data
# 若报 "git: 'clone' ... unknown option `--sparse'"（git < 2.25），手工替代：
#   cd .scratch/tracking-data && git clone --depth 1 https://github.com/metrica-sports/sample-data

# 两场都要转，否则运动锚只来自 1 场
node tools/convert-tracking-to-frames.mjs --in .scratch/tracking-data/sample-data/data/Sample_Game_1 \
  --out viewer/data/real-game-1.json --keyframe-hz 5
node tools/convert-tracking-to-frames.mjs --in .scratch/tracking-data/sample-data/data/Sample_Game_2 \
  --out viewer/data/real-game-2.json --keyframe-hz 5
```

⚠️ **`like-football.mjs` 会静默跳过缺失的真实帧文件**，但标题仍印「Metrica real-game-1/2 帧」。
只看数字前先 `ls viewer/data/real-game-*.json`——否则「真实锚」其实只来自 1 场。

### SkillCorner（20 场，1.8GB）

```sh
node tools/fetch-tracking-data.mjs --dataset skillcorner-opendata
```

⚠️ **目前会失败**（[#164](https://github.com/Xingkai98/pitchcraft/issues/164)：骨架步骤的 `curl` 缺 `await`）。
C1–C4 的验收**不依赖**它（结构锚用的是入库的 `viewer/data/benchmark-baseline.json`）。

---

## 4. 验收怎么跑

| 工具 | 命令 | 看什么 |
|---|---|---|
| 损失表 | `node tools/visual-review/like-football.mjs viewer/engine.wasm 5 12` | 8 行 `mean\|ln\|`、`disp`、`lat`、`mix`、总距离 |
| 比赛标尺 | `node tools/benchmark-compare.mjs` | 结构量 vs 真实观测范围 |
| P38 判据 | `node openspec/changes/p38-formation-realism/notes/criteria/check-criteria.mjs` | 8 条，当前 5/8 不达标 |
| P18 行为门 | `node openspec/changes/p18-behavior-verification-layer/notes/criteria/check-behavior-gates.mjs` | A1/A2/B4 |
| 轨迹图 | `node openspec/changes/p38-formation-realism/notes/probes-main/render-trajectories.mjs engine /tmp/t.png x 120` | 锯齿 vs 弧线 |
| 单帧对比 | `node tools/visual-review/render.mjs viewer/engine.wasm /tmp/c.png 42 600 12 6` | 上引擎下真实 |

### ratchet 约定（**必须自己做，没有工具兜底**）

「现状 × factor」的门目前**没有工具实现**——`check-criteria.mjs` 只按绝对带打印、且恒 `exit 0`。
所以每个 change 开工前：

```sh
# 改之前，把现状落盘
mkdir -p openspec/changes/<name>/notes
node tools/visual-review/like-football.mjs viewer/engine.wasm 5 12 > openspec/changes/<name>/notes/ratchet-before.txt
node openspec/changes/p38-formation-realism/notes/criteria/check-criteria.mjs >> openspec/changes/<name>/notes/ratchet-before.txt
```

改完再跑一遍逐行对照，把对照表写进 PR。

---

## 5. 口径（别踩）

- **纵深 / 紧凑度 = q10–q90 跨度**，**剔门将**（id `0` / `21`）
- **两个口径都报**：`primary` 跳过外推点（`is_detected=false`），`allPoints` 采信外推点。
  同一个靶子两个数（例：主队纵深 18.31 vs 25.82）——**引用任何数字必须标口径**
- P38 判据是**报告期**：红了不会让 CI 红
- `lat` 只打印 2 位小数（`0.37`），判不了「不低于 0.370」这种阈值；要么改工具位数，要么阈值写 2 位

---

## 6. 已知陷阱（改 tick 时必读）

1. **主 spec 硬写 1 Hz**
   - `openspec/specs/event-stream-protocol/spec.md`：「beat 节拍事件 SHALL 描述一个 **tick（1s）**」
   - `openspec/specs/match-engine/spec.md`：「相邻 beat 的 t 差 SHALL ∈ **{1.0, 2.0}** ± 0.001」

   ⇒ 改 `TICK_SECONDS` 必须**同步出 spec delta**，否则代码对了、规格违约。

2. **`realism.rs` 用符号断言 ⇒ 假绿**
   ```rust
   let ok_step = (dt - TICK_SECONDS).abs() <= 0.001;   // 用的是符号，不是字面量 1.0
   ```
   把 `TICK_SECONDS` 改成 0.1 后，**测试自动通过，而 spec 里写的 {1.0, 2.0} 仍然违约**。
   这条必须显式改成取自 spec 的常量，或同步改 spec。

3. **`*_TICKS` 常量按 tick 计**：`TRANSITION_TICKS`、`SHOT_COOLDOWN_TICKS`、`MAX_ACTION_DEADLINE_TICKS`、
   `HOLD_MIN/MAX_TICKS`、`LOOSE_MAX_TICKS`、`LIVENESS_*_TICKS` 等（共 16 个）——tick 变 0.1 s 后
   **它们的真实秒数全部变 1/10**。改 tick 必须交一份「换算表 + 是否重标定」的说明。

4. **golden 会变红**：`MODEL_VERSION`（`engine/src/lib.rs:243`，当前 `9`）bump 后要新建
   `engine/tests/golden-v10/`，并用 `ACCEPT_GOLDEN=1` 重基线。

5. **`openspec` CLI**：`npx openspec` 不可用（包无 bin）。用
   `npx --yes @fission-ai/openspec@<version> ...`。注意 main 上 `validate --all` **本来就有一批失败**
   （含 p38 缺 delta），别把既有红算到你头上。

6. **`CLAUDE.md` 提到的 `batch-grill-me` skill 在 `.claude/skills/` 里不存在**（只有历史产物）。

---

## 7. 提交

- 分支：`p<编号>-<slug>/<日期>` 或 `docs/<slug>/<日期>`
- CI 跑 `verify.sh`（Node 22）；本地跑过什么、结论如何，写进 PR 描述
- 本仓要求**代码审阅闭环**：实现完成后起零上下文 subagent 审阅，发现问题→修→再审，
  直到无遗留（见 `CLAUDE.md` §3）
