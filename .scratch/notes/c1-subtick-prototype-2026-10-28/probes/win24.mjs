// 24s 窗、盲测选窗口径（path>=30m 才入包）：引擎侧逐窗算再均值。
import { join } from 'node:path';
const ROOT = process.cwd();
const { travelWindows } = await import(join(ROOT, 'tools/visual-review/ball-travel.mjs'));
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const { createGame } = await import(join(ROOT, 'viewer/game.js'));
const { wasm } = await loadEngineWasm(join(ROOT, 'viewer/engine.wasm'));
const seeds = (process.argv[2] || '42,7,23,11').split(',').map(Number);
const wins = [];
for (const seed of seeds) {
  const frames = mm.sampleEngineFrames(createGame(simulateStream(wasm, seed, mm.ENGINE_DURATION_SEC)))
    .map((f) => ({ t: f.t, pitchMeters: [105, 68], ball: f.ball }));
  wins.push(...travelWindows(frames, { win: 24 }));
}
const sel = wins.filter((w) => w.path >= 30);
const mean = (a, k) => a.reduce((s, w) => s + w[k], 0) / a.length;
const stat = (arr) => ({
  n: arr.length,
  path: mean(arr, 'path').toFixed(1), fast: mean(arr, 'fast').toFixed(1), slow: mean(arr, 'slow').toFixed(1),
  static: (mean(arr, 'staticShare') * 100).toFixed(1),
  min: Math.min(...arr.map((w) => w.path)).toFixed(1), max: Math.max(...arr.map((w) => w.path)).toFixed(1),
});
console.log('all 24s windows:', JSON.stringify(stat(wins)));
console.log('selected (path>=30m):', JSON.stringify(stat(sel)));
