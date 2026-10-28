// 盲测包同窗口口径：对 windows.json 的 12 个引擎窗（seed, t0..t0+24），
// 用当前 wasm 重算 stats.ballPathM（0.2s 采样、原始球帧、与 replay-blind-core 同法）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const ROOT = process.cwd();
const PACKET = '.scratch/tracking-data/replay-goal-loop/base';
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const { createGame } = await import(join(ROOT, 'viewer/game.js'));
const windows = JSON.parse(readFileSync(join(ROOT, PACKET, 'windows.json'), 'utf8'));
const engWins = windows.items.filter((it) => it.source === 'engine');
const { wasm } = await loadEngineWasm(join(ROOT, 'viewer/engine.wasm'));
const bySeed = new Map();
for (const w of engWins) {
  const seed = Number(w.match.replace('seed-', ''));
  if (!bySeed.has(seed)) bySeed.set(seed, []);
  bySeed.get(seed).push(w);
}
const out = [];
for (const [seed, ws] of bySeed) {
  const game = createGame(simulateStream(wasm, seed, 5400), { smoothSamples: 5 });
  const frames = mm.sampleEngineFrames(game, { stepSec: 0.2 });
  for (const w of ws) {
    const seg = frames.filter((f) => f.t >= w.t0 - 1e-6 && f.t <= w.t1 + 1e-6);
    let path = 0;
    for (let i = 1; i < seg.length; i += 1) {
      path += Math.hypot((seg[i].ball[0] - seg[i - 1].ball[0]) * 105, (seg[i].ball[1] - seg[i - 1].ball[1]) * 68);
    }
    out.push({ seed, t0: w.t0, base: w.stats.ballPathM, now: path });
  }
}
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
for (const o of out) console.log(`seed ${o.seed} t0=${o.t0}: base=${o.base.toFixed(1)} now=${o.now.toFixed(1)}`);
console.log(`mean base=${mean(out.map((o) => o.base)).toFixed(1)} now=${mean(out.map((o) => o.now)).toFixed(1)}  min/max now=${Math.min(...out.map((o) => o.now)).toFixed(1)}/${Math.max(...out.map((o) => o.now)).toFixed(1)}`);
console.log('real windows min/max/mean = 136.5 / 192.6 / 164.6');
