// 「因为」检验：抢断爆炸是不是「球 12m 内的防守者变多」造成的？
// 引擎的抢断资格是**抢断者到持球者的米制距离 ≤ 12 m**（`score_tackle` 用 dist_m=13.0 → NEG_INFINITY；
// 见 engine/src/lib.rs 的 p30_tackle_score_directions）。持球者≈球位 ⇒ 用「球 12m 内的对手数」代理。
// 用法: node tackle-eligibility.mjs <wasm> <seeds> [dur]
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const { createGame } = await import(join(ROOT, 'viewer/game.js'));
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
const L = 105, W = 68;
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

const [wasmPath, nSeedA, durA] = process.argv.slice(2);
const NS = Number(nSeedA || 5), DUR = Number(durA || 5400);
const { wasm } = await loadEngineWasm(wasmPath);

const per = [];
for (let i = 0; i < NS; i++) {
  const seed = mm.BENCHMARK_SEEDS[i % mm.BENCHMARK_SEEDS.length];
  const stream = simulateStream(wasm, seed, DUR);
  const frames = mm.sampleEngineFrames(createGame(stream), { stepSec: 0.2 });
  const h = [], a = [], mn = [], mx = [];
  for (const f of frames) {
    if (!f.ball) continue;
    const bx = f.ball[0] * L, by = f.ball[1] * W;
    let nh = 0, na = 0;
    for (const p of f.players) {
      if (mm.KEEPER_IDS.includes(p.id)) continue;
      if (Math.hypot(p.x * L - bx, p.y * W - by) <= 12) { if (p.id <= 10) nh++; else na++; }
    }
    h.push(nh); a.push(na); mn.push(Math.min(nh, na)); mx.push(Math.max(nh, na));
  }
  // 抢断事件数（从流里数）
  const evs = JSON.parse(stream);
  const nTackle = evs.filter((e) => e.type === 'tackle').length;
  per.push({ seed, h12: mean(h), a12: mean(a), min12: mean(mn), max12: mean(mx), nTackle, nFrame: h.length, tacklePerFrame: nTackle / h.length });
}
console.log(JSON.stringify({
  wasmPath,
  homeWithin12: mean(per.map((p) => p.h12)),
  awayWithin12: mean(per.map((p) => p.a12)),
  minWithin12: mean(per.map((p) => p.min12)),
  maxWithin12: mean(per.map((p) => p.max12)),
  tacklePerFrame: mean(per.map((p) => p.tacklePerFrame)),
  per,
}, null, 1));
