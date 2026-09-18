// adv1: 在 pinned wasm 上重算 P38 头条 + 结构判据 S1–S5，与 findings/design 的数字逐位对照。
// 用法: node adv1-baseline.mjs <wasmPath> <label>
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { loadEngineWasm, simulateStream } from '/home/happy/.claude/worktrees/wayfinder-realism/tools/benchmark-engine.mjs';
const M = await import(pathToFileURL('/home/happy/.claude/worktrees/wayfinder-realism/viewer/match-metrics.js').href);
const { createGame } = await import(pathToFileURL('/home/happy/.claude/worktrees/wayfinder-realism/viewer/game.js').href);
const ROOT = '/home/happy/.claude/worktrees/wayfinder-realism';

const wasmPath = process.argv[2];
const label = process.argv[3] || 'x';
const buf = readFileSync(wasmPath);
console.log(`### ${label}  sha256 ${createHash('sha256').update(buf).digest('hex').slice(0, 12)}  bytes ${buf.length}`);

const load = await loadEngineWasm(wasmPath);
if (!load.ok) { console.error(load.message); process.exit(1); }
const { BENCHMARK_SEEDS, ENGINE_DURATION_SEC, sampleEngineFrames, cutWindows, KEEPER_IDS,
  PITCH_LENGTH_M, PITCH_WIDTH_M, windowMetrics, summarizeWindowMetrics, elasticity } = M;

const SEEDS = process.argv[4] ? process.argv[4].split(',').map(Number) : BENCHMARK_SEEDS;
const E = [];
for (const seed of SEEDS) {
  const game = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  E.push(...sampleEngineFrames(game));
}
const windows = cutWindows(E);
const sums = summarizeWindowMetrics(windows.map((w) => windowMetrics(w, { pitchMeters: [PITCH_LENGTH_M, PITCH_WIDTH_M] }).primary));
const el = windows.map((w) => elasticity(w, { divider: 'half' })).filter(Boolean);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
console.log(`seeds ${SEEDS.join(',')}  frames ${E.length}  windows ${windows.length}`);
console.log(`  纵深 hd      ${sums.hd.avg.toFixed(2)}  (findings 40.40)`);
console.log(`  客队纵深 ad  ${sums.ad.avg.toFixed(2)}`);
console.log(`  紧凑度 spread ${sums.spread.avg.toFixed(2)}  (findings 18.65)`);
console.log(`  重心间距 gap ${sums.gap.avg.toFixed(2)}  (findings 23.53)`);
console.log(`  宽度 width   ${sums.width.avg.toFixed(2)}  (findings 40.85)`);
console.log(`  球到重心     ${sums.ballDist.avg.toFixed(2)}`);
console.log(`  弹性 half Δ  ${mean(el.map((e) => e.delta)).toFixed(2)}  (design-a 13.3 / 4.7real)`);
console.log(`  控球占比home ${sums.possessionHome.avg.toFixed(3)}`);
