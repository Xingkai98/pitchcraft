// 诊断：一个 wasm 的逐窗 / 逐帧队形，以及「球员到球距离」的分布。
// 用法: node diag-shape.mjs <wasm> [seed] [dur]
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const { createGame } = await import(join(ROOT, 'viewer/game.js'));
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
const L = 105, W = 68, KEEP = mm.KEEPER_IDS;
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

const [wasmPath, seedA, durA] = process.argv.slice(2);
const SEED = Number(seedA || 42), DUR = Number(durA || 5400);
const { wasm } = await loadEngineWasm(wasmPath);
const frames = mm.sampleEngineFrames(createGame(simulateStream(wasm, SEED, DUR)), { stepSec: 0.2 });

const shape = (f, home) => {
  const ps = f.players.filter((p) => p && !KEEP.includes(p.id) && ((p.id <= 10) === home));
  if (ps.length < 7) return null;
  const xs = ps.map((p) => p.x * L).sort((a, b) => a - b);
  const ys = ps.map((p) => p.y * W);
  return { depth: mm.quantileSpan(xs), yspan: Math.max(...ys) - Math.min(...ys), cx: mean(ps.map((p) => p.x * L)), cy: mean(ys), n: ps.length };
};
const distToBall = (f, home) => {
  const ps = f.players.filter((p) => p && !KEEP.includes(p.id) && ((p.id <= 10) === home));
  const b = [f.ball[0] * L, f.ball[1] * W];
  return ps.map((p) => Math.hypot(p.x * L - b[0], p.y * W - b[1])).sort((a, b) => a - b);
};

console.log("=== 逐窗（300s 窗，900s 步长）===");
const wins = mm.cutWindows(frames);
wins.forEach((w, i) => {
  const hd = [], ad = [], hw = [], aw = [];
  for (const f of w) { const h = shape(f, true), a = shape(f, false); if (h && a) { hd.push(h.depth); ad.push(a.depth); hw.push(h.yspan); aw.push(a.yspan); } }
  console.log(` win${i} t=${w[0].t}..${w[w.length - 1].t}  hd=${mean(hd).toFixed(2)} ad=${mean(ad).toFixed(2)}  hWidth=${mean(hw).toFixed(2)} aWidth=${mean(aw).toFixed(2)}`);
});

console.log("=== 瞬时抽样 ===");
for (const t of [30, 60, 300, 1000, 2000, 3000, 4000, 5000]) {
  const idx = Math.min(frames.length - 1, Math.round(t / 0.2));
  const f = frames[idx];
  if (!f) continue;
  const h = shape(f, true), a = shape(f, false);
  const dh = distToBall(f, true), da = distToBall(f, false);
  console.log(` t=${String(f.t).padStart(7)} ballX=${(f.ball[0] * L).toFixed(1).padStart(5)} ballY=${(f.ball[1] * W).toFixed(1).padStart(5)} | home: depth=${h.depth.toFixed(1)} span=${h.yspan.toFixed(1)} cx=${h.cx.toFixed(1)} cy=${h.cy.toFixed(1)} | away: depth=${a.depth.toFixed(1)} span=${a.yspan.toFixed(1)} cx=${a.cx.toFixed(1)} cy=${a.cy.toFixed(1)}`);
  console.log(`         home 到球距离 ${dh.map((v) => v.toFixed(1)).join(' ')}`);
  console.log(`         away 到球距离 ${da.map((v) => v.toFixed(1)).join(' ')}`);
}
