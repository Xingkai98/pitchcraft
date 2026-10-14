// C2 轴只读探针：逐帧拆解「分边」——两队**外场**球员重心（口径直接复用
// `match-metrics.teamShape`，与 like-football/基线同一实现）、球在哪、以及沿进攻轴/横向的分解。
// **不改任何判据**，只 println。
// 用法：node probe-center-gap.mjs <engine.wasm> [seed=42] [t0=1800] [t1=2700]
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
const { createGame } = await import(join(ROOT, 'viewer/game.js'));

const [wasmPath, seedArg, t0Arg, t1Arg] = process.argv.slice(2);
const SEED = Number(seedArg || 42), T0 = Number(t0Arg || 1800), T1 = Number(t1Arg || 2700);
const { wasm, ok } = await loadEngineWasm(wasmPath);
if (!ok) { console.error('wasm 加载失败'); process.exit(1); }

const frames = mm.sampleEngineFrames(createGame(simulateStream(wasm, SEED, mm.ENGINE_DURATION_SEC)))
  .filter((f) => f.t >= T0 && f.t < T1);
const mean = (a) => a.reduce((u, v) => u + v, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };

const hx = [], ax = [], gx = [], gy = [], gap = [], ballx = [], bdHome = [];
for (const f of frames) {
  const h = mm.teamShape(f, 'home'), a = mm.teamShape(f, 'away');
  if (!h || !a || !f.ball) continue;
  hx.push(h.cx); ax.push(a.cx);
  gx.push(a.cx - h.cx); gy.push(a.cy - h.cy);
  gap.push(Math.hypot(h.cx - a.cx, h.cy - a.cy));
  ballx.push(f.ball[0] * 105);
  bdHome.push(Math.hypot(h.cx - f.ball[0] * 105, h.cy - f.ball[1] * 68));
}
console.log(`probe-center-gap  seed=${SEED}  窗=[${T0},${T1})  采信帧=${gap.length}（0.2s）`);
console.log(`主队外场重心 x      ${mean(hx).toFixed(2)} m  (sd ${sd(hx).toFixed(2)})`);
console.log(`客队外场重心 x      ${mean(ax).toFixed(2)} m  (sd ${sd(ax).toFixed(2)})`);
console.log(`分边 gap（2D）      ${mean(gap).toFixed(2)} m  (sd ${sd(gap).toFixed(2)})`);
console.log(`  ├ 沿进攻轴 Δx     ${mean(gx).toFixed(2)} m  (sd ${sd(gx).toFixed(2)})`);
console.log(`  └ 横向     Δy     ${mean(gy).toFixed(2)} m  (sd ${sd(gy).toFixed(2)})`);
console.log(`球 x 均值           ${mean(ballx).toFixed(2)} m  (sd ${sd(ballx).toFixed(2)})`);
console.log(`主队重心到球距离    ${mean(bdHome).toFixed(2)} m`);
console.log(`corr(Δx, 球x)       ${(() => { const m1 = mean(gx), m2 = mean(ballx); const c = mean(gx.map((v, i) => (v - m1) * (ballx[i] - m2))); return (c / (sd(gx) * sd(ballx))).toFixed(3); })()}`);
