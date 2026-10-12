// 同队间距**整场滑窗**扫描（#53 / P34 的真实门，比 P26 的稀疏 fixture 密得多）。
//
// 为什么需要它：P26 的 `tools/fixtures/real-audit-input.json` 只在 6–7 个手工挑的窗口上
// 采快照，样本稀疏——引擎可能有大量未采样时刻的同队重叠而不被发现（P34 审阅 P0-1 的教训：
// 实现者曾据此误报「detector 归零」）。本脚本把真实采集窗口（±5s）**滑过整场**，
// 每 `STEP` 秒一窗，用真实采集管线（`captureObservation`）产出 audit_input 再跑 detector，
// 给出「整场口径」的 finding 数与最恶劣间距。
//
// 用法（仓库根，需先构建 viewer/engine.wasm）：
//   (cd engine && cargo build --target wasm32-unknown-unknown --release \
//     && cp target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/engine.wasm)
//   node tools/spacing-sweep.mjs            # 默认 seed 42 1 2 3 7 59 18 94
//   node tools/spacing-sweep.mjs 42 1 2     # 指定 seed
//   SWEEP_CONCURRENCY=1 node tools/spacing-sweep.mjs   # 强制串行（默认并发跑 seed）
//
// 退出码：任一 seed 出现 finding 即 1（可作 CI 门；默认 seed 集下当前应为 0）；缺 wasm 2。
//
// **#152 提速**：每 seed 互相独立，默认以 worker_threads 并发跑（`SWEEP_CONCURRENCY`，
// 默认 `min(4, CPU 数)`）。并发与串行的结果**逐位一致**——两条路径跑的是同一个 `runSeed`
// （`tools/spacing-sweep-core.mjs`），差别只在「在哪个线程里跑」；输出仍按**入参 seed 序**
// 打印。**判据、采样密度（`DUR`/`STEP`）、detector 阈值一律未动**。见
// `openspec/changes/p152-sweep-perf/`。
//
// 本文件只做「解析 argv/env → 交给 `runSweep` → `process.exit(退出码)`」。**sweep 的主体
// 逻辑在 core 里**（可 import），这样「打印顺序 / OK·FAIL / 退出码 0·1」能在单测里被真正执行
// ——否则 CLI 只有「非法 SWEEP_CONCURRENCY → exit 2」这一条分支被跑到（#152 审阅 P1-2）。

import {
  WASM_PATH,
  parseSeeds,
  resolveConcurrency,
  runSweep,
} from './spacing-sweep-core.mjs';

const seeds = parseSeeds(process.argv.slice(2));

let concurrency;
try {
  concurrency = resolveConcurrency({ env: process.env.SWEEP_CONCURRENCY, seedCount: seeds.length });
} catch (err) {
  console.error(String((err && err.message) || err));
  process.exit(2);
}

process.exit(await runSweep({ seeds, concurrency, wasmPath: WASM_PATH }));
