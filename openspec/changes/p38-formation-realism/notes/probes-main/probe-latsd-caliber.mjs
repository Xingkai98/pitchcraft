// P38：**`latSd` 的口径分叉**——判据组的引擎侧数字被"跨场拼接"灌水。
//
// ── 发现 ──────────────────────────────────────────────────────────────
//
// `render-trajectories.mjs`（单场 seed 42）对某个配置报横向 sd **0.37m**，
// 而 `p38-eval.mjs` / `eval-criteria.mjs` 对**同一个 wasm** 报 **11.26m**。差了 30 倍。
//
// 根因：评测器把**多个种子的帧拼接成一个序列**再算 sd：
//
//     const all = [];
//     for (const seed of seeds) all.push(...r.frames);      // ← 3 场拼在一起
//     const seg = all.filter(f => f.t >= 1800 && f.t <= 1920);
//     latSd.push(sd(seg.map(...)));                          // ← 跨场 sd
//
// 不同场次的球员 y **均值不同**（每场各自的战术相位/初始条件），拼接后这些
// **场间偏移全部计入 sd** → 方差被抬高。抬高的幅度**随球员实际移动量增长**。
//
// ⚠️ **这正好惩罚不了 hack、反而奖励 hack**：动得越多的配置，场间偏移越大，
// 虚高越多。exp5（"一群鱼"）报的 latSd 5.30 就含有这个成分。
//
// ── 真实侧的对照 ───────────────────────────────────────────────────────
//
// `eval-criteria.mjs --real` 是**逐场**算再平均（real-game1 10.81 / real-game2 10.22
// → 均值 10.515 进 criteria-spec）。**引擎侧拼接、真实侧逐场 = 口径分叉**，
// 与 P36「口径分叉 = 数字不可比」是同一个错误，只是这轮发生在时间轴上。
//
// 本探针给出两种口径的对照，作为判据组 `latSd` 的修正依据。
//
// 用法：node probe-latsd-caliber.mjs [种子列表]

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from '../probes/repo-root.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = findRepoRoot(HERE);
const seeds = (process.argv[2] || '42,1,7,99,123').split(',').map(Number);

const { loadEngineWasm, simulateStream } = await import(`${ROOT}/tools/benchmark-engine.mjs`);
const { createGame } = await import(`${ROOT}/viewer/game.js`);
const { sampleEngineFrames, PITCH_WIDTH_M } = await import(`${ROOT}/viewer/match-metrics.js`);

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };

const load = await loadEngineWasm(`${ROOT}/viewer/engine.wasm`);
if (!load.ok) { console.error(load.message); process.exit(1); }

const perMatch = [];   // 每场：该场 120s 窗内每人的 y sd，再对该场球员取均值
let pooledFrames = [];
for (const seed of seeds) {
  const g = createGame(simulateStream(load.wasm, seed, 5400));
  const frames = sampleEngineFrames(g);
  pooledFrames = pooledFrames.concat(frames);
  const seg = frames.filter((f) => f.t >= 1800 && f.t <= 1920);
  const s = [];
  for (let id = 1; id <= 10; id += 1) {
    const pts = seg.map((f) => f.players.find((x) => x.id === id)).filter(Boolean);
    if (pts.length < 50) continue;
    s.push(sd(pts.map((p) => p.y * PITCH_WIDTH_M)));
  }
  perMatch.push(mean(s));
}
// 拼接口径（= 评测器现状）
const segP = pooledFrames.filter((f) => f.t >= 1800 && f.t <= 1920);
const pooled = [];
for (let id = 1; id <= 10; id += 1) {
  const pts = segP.map((f) => f.players.find((x) => x.id === id)).filter(Boolean);
  if (pts.length < 50) continue;
  pooled.push(sd(pts.map((p) => p.y * PITCH_WIDTH_M)));
}

console.log(`种子 ${seeds.join(',')}`);
console.log(`  逐场算再平均（正确口径）  latSd = ${mean(perMatch).toFixed(2)} m   [${perMatch.map((v) => v.toFixed(1)).join(', ')}]`);
console.log(`  拼接多场再算（评测器现状）latSd = ${mean(pooled).toFixed(2)} m`);
console.log(`  虚高倍数 = ${(mean(pooled) / mean(perMatch)).toFixed(2)}×`);
