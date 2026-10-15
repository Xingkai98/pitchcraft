// [y 轴探索探针] 两条「因为」的直接检验：
//   A) 抢断体量↑：窄 y 是否让**防守方离球 12m 内的人更多**（tackle 资格半径 = 12m）
//   B) 界外球↓：窄 y 是否让**传球落点更靠中路**（边线出界通道的几何前提）
// 用法: node zz_mech.mjs <wasm> <seed> [dur=5400]
// 按 p.id 取人。只读，用完即删。
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const { createGame } = await import(join(ROOT, 'viewer/game.js'));

const [wasmPath, seedArg, durArg] = process.argv.slice(2);
const SEED = Number(seedArg || 42), DUR = Number(durArg || 5400);
const { wasm, ok } = await loadEngineWasm(wasmPath);
if (!ok) { console.error('wasm 加载失败'); process.exit(1); }
const stream = simulateStream(wasm, SEED, DUR);
const evs = JSON.parse(stream);

// ── A) 逐帧：球 12m 内的球员数（按队） ──
const g = createGame(stream);
let nHome = 0, nAway = 0, nFrames = 0;
for (let t = 0; t <= DUR; t += 0.5) {
  g.seekTo(t);
  const ps = g.players.map((p) => ({ id: p.id, x: p.x * 105, y: p.y * 68 }));
  if (ps.length < 14) continue;
  const b = [g.ball.x * 105, g.ball.y * 68];
  let h = 0, a = 0;
  for (const p of ps) {
    const d = Math.hypot(p.x - b[0], p.y - b[1]);
    if (d <= 12) { if (p.id <= 10) h++; else a++; }
  }
  nHome += h; nAway += a; nFrames++;
}
console.log(`[MECH] 12m 内球员数/帧 (均值)  主=${(nHome / nFrames).toFixed(3)}  客=${(nAway / nFrames).toFixed(3)}  帧=${nFrames}`);

// ── B) 传球落点与球的横向偏离 ──
const r = [];
const balls = [];
for (const e of evs) {
  if (e.type === 'pass' && e.to && typeof e.x2 === 'number' && typeof e.y2 === 'number') {
    r.push(Math.abs(e.y2 - 0.5) * 68);
  }
  if (typeof e.ball === 'object' && e.ball && typeof e.ball.y === 'number') balls.push(Math.abs(e.ball.y - 0.5) * 68);
}
const mean = (a) => a.reduce((u, v) => u + v, 0) / Math.max(1, a.length);
const sorted = (a) => [...a].sort((x, y) => x - y);
const q = (a, p) => { const s = sorted(a); return s[Math.floor((s.length - 1) * p)]; };
console.log(`[MECH] 传球落点 |y-0.5|·68 (m)  均值=${mean(r).toFixed(2)}  p50=${q(r, 0.5).toFixed(2)}  p90=${q(r, 0.9).toFixed(2)}  n=${r.length}`);
console.log(`[MECH] 球位      |y-0.5|·68 (m)  均值=${mean(balls).toFixed(2)}  p50=${q(balls, 0.5).toFixed(2)}  p90=${q(balls, 0.9).toFixed(2)}  n=${balls.length}`);
// 事件端点（movers / main 的 x2,y2）横向偏离 —— 「球员去哪儿」
const rest = [];
for (const e of evs) {
  for (const mv of (e.movers || [])) if (typeof mv.to_y === 'number') rest.push(Math.abs(mv.to_y - 0.5) * 68);
}
console.log(`[MECH] mover 目标 |y-0.5|·68 (m)  均值=${mean(rest).toFixed(2)}  n=${rest.length}`);
