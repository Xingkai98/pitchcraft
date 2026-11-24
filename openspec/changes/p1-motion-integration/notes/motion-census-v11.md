# motion-census 移植与 v11 复算（P1 Phase 0 / 2.11）

日期：2026-11-23
分支：`p1-phase0/2026-11-23`（基于 `p1-motion-integration/2026-11-21` HEAD `8653455`）
任务：`tasks.md` 2.11 / design D7.1（G1-Q4）

## 1. 移植

从 `main de239d1`（= `p155-measurement-instrument/2026-11-19` 合入后）移植并**增补**（见 §2）：

- `tools/visual-review/motion-census.mjs`（878 → 增补，见 §2）
- `tools/visual-review/motion-census.test.mjs`（20 → 22 条测试）

`tools/visual-review/motion-metrics.mjs`、`viewer/`、`engine/src/` 零改动。

**未移植的依赖（如实记录）**：原工具的 `--stimulus` / `--windows` 模式会懒加载
`tools/visual-review/render-ablation.mjs` 和 p155 的 `notes/stimulus.json`；这两者不在本分支，
Phase 0 也不使用这两个模式。调用它们会报模块/文件缺失。主口径（宽扫）与新增的 `--anchors`
模式不依赖它们，`node --test` 也不加载它们。

## 2. 引擎侧过滤 `action:"highlight"`（G1-Q4）

C1 起高亮参与者以 `action:"highlight"` 进入 `movers`；Change 0 的 frozen 24 窗与
0.829/0.239/0.216 是 v11（参与者不在 movers）口径。为保持可比，新增：

- `highlightIntervals(events)`：只认 `beat.movers[].action === "highlight"`，段长取 `beat.dt`
  （缺失时退回 0.5s；v11 没有 highlight，走不到）。
- `stripHighlightPlayers(frames, events)`：把命中 id 在 `[t0,t1)` 内从**引擎侧**帧里剔除；
  纯函数、不改入参。**只用于引擎帧**（真实 tracking 无 action 字段，不受影响）。

接入四处引擎路径：主口径宽扫、`--stimulus`、`--windows`、`--anchors`；每处 payload 记录
`highlightFramesRemoved`（v11 应为 0）。

**口径守护测试**（`motion-census.test.mjs` 21/22 条）：

- `highlightIntervals`：只认 beat + highlight，非高亮 mover 不入选，dt 缺失回退。
- `★ stripHighlightPlayers`：v11 的 action 只有 `run`/`chase` ⇒ `removed=0` 且 frames 逐位恒等；
  C1 流 ⇒ 只在区间内剔除命中 id、其它球员保留、入参不被修改。
- **定向变异**：① 把 `stripHighlightPlayers` 改成恒等返回 → 第 22 条红；② 把过滤条件从
  `action === "highlight"` 改成「`action` 非空」→ 第 21、22 条同时红（v11 的 `run`/`chase`
  会被误剔）。两次还原后 22/22 绿。

## 3. v11 复算：frozen 24 窗

**锚点**：`notes/frozen-24-anchors.json`，抽自
`main de239d1:openspec/changes/p155-measurement-instrument/notes/motion-census-frozen-anchors.json`
的 `engineWindows`：**12 seed（1201..1237）× 2 anchor = 24 窗**，24s @5Hz = 121 帧。

**复现命令**：

```bash
node tools/visual-review/motion-census.mjs viewer/engine.wasm \
  --anchors openspec/changes/p1-motion-integration/notes/frozen-24-anchors.json \
  --out openspec/changes/p1-motion-integration/notes/motion-census-v11-frozen24.json
```

（`viewer/engine.wasm` 为本 worktree 现构建；`cargo build --target wasm32-unknown-unknown --release`。）

**源身份（强一致，不是只对齐读数）**：

| 身份 | Change 0（p155 记录） | 本次 v11 复算 |
|---|---|---|
| wasm SHA256 | `f6a9f9ec7a5effaa3b3df6d68e380263f308e7c86e54ad09ea5febb9760ec92f` | **逐位相同** |
| 12 seed 事件流 SHA256 | 记录值 | **逐 seed 逐位相同**（见 JSON `eventShaBySeed`） |
| 高亮剔除帧数 | —（v11 的 action 只有 `run`/`chase`） | **0** |

**读数（24 窗等权；Change 0 记录见 `p155 …/notes/motion-census.md` §3.1/§4）**：

| 指标 | Change 0 | 本次 | 对齐 |
|---|---:|---:|---|
| 旧 turn120（每球员/窗） | 5.885 | **5.8854** | ✅ |
| `conditional['0.5'].turnsPerPlayer` | 0.829 | **0.82917** | ✅ |
| `staticFrac[0.5]` | 0.239 | **0.23924** | ✅ |
| `ballStaticFrac[0.5]` | 0.216 | **0.21597** | ✅ |
| `turnsPerEffectivePair` @0.5 | 0.0100 | **0.010014** | ✅ |
| 条件 turn120 @0.3 / @1.0 | 0.908 / 0.692 | **0.9083 / 0.6917** | ✅ |
| `staticFrac[0.2] / [1.0]` | — | 0.2354 / 0.2484 | — |
| `ballStaticFrac[0.2] / [2.0]` | — | 0.1576 / 0.3781 | — |
| 速度 p50/p90/p99 (m/s) | — | 3.660 / 5.879 / 7.309 | — |
| 加速度 p95/p99 (m/s²) | — | 21.676 / 29.982 | — |
| 对称性 底−顶 / 左−右 | — | −0.0154 / +0.1430 | — |
| 有效步对 @0.5 | — | 1698.3 / 窗 | — |

**结论：v11 复算与 Change 0 逐位对齐，不需要「停止并说明口径差异」，也没有换锚。**

## 4. 边界与后续

- 本文件只覆盖**引擎** frozen 24 窗；真实 24 窗（R7i 锚点）依赖 gitignored 的真实数据，
  Phase 0 不重算（Change 0 记录的真实读数：旧 turn120 0.221、staticFrac 0.0369、
  ballStaticFrac 0.0215，跳过外推点）。
- C1 实施后应重跑同一 `--anchors` 命令；引擎侧会因 `action:"highlight"` 过滤而剔除高亮
  参与者帧，`highlightFramesRemoved > 0` 是预期，届时读数与 v11 的差才是「运动层改动」的效应。
- 24 窗是**公开回归集**（已看过，不算留出）；验收统计口径见 design D9.1。
