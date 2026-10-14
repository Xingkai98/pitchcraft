// C2 轴只读探针：**同窗**轨迹形态的客观量——补 `lat`（12s 窗）看不到的「90s 窗里轨迹有多长、
// 多水平、多宽」。与 stack-engines.mjs 看的是同一批点（同一 seed/窗/采样），故「眼看的」与
// 「量的」同口径，可对照。
// 用法：node probe-rail.mjs <label:wasm> [<label:wasm> ...] [-- seed t0 win]
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
const { createGame } = await import(join(ROOT, 'viewer/game.js'));
const argv = process.argv.slice(2);
const SEP = argv.indexOf('--');
const specs = (SEP < 0 ? argv : argv.slice(0, SEP)).map((s) => { const i = s.indexOf(':'); return { label: s.slice(0, i), path: s.slice(i + 1) }; });
const [SEED, T0, WIN] = (SEP < 0 ? [] : argv.slice(SEP + 1)).map(Number);
const seed = SEED || 42, t0 = T0 || 1800, win = WIN || 90;
const mean = (a) => a.reduce((u, v) => u + v, 0) / a.length;
console.log(`probe-rail  seed=${seed} 窗=[${t0},${t0 + win}]  （逐球员 90s 窗内的路径形态）`);
console.log('label      路径长m  净位移m  |dx|/(|dx|+|dy|)  x跨度m  y跨度m  东西向?');
for (const { label, path } of specs) {
  const { wasm, ok } = await loadEngineWasm(path);
  if (!ok) { console.log(`${label}  wasm 加载失败`); continue; }
  const frames = mm.sampleEngineFrames(createGame(simulateStream(wasm, seed, mm.ENGINE_DURATION_SEC)))
    .filter((f) => f.t >= t0 && f.t <= t0 + win);
  const per = new Map();
  for (const f of frames) for (const p of f.players) { if (!p) continue; if (!per.has(p.id)) per.set(p.id, []); per.get(p.id).push([p.x, p.y]); }
  const pl = [], net = [], hor = [], xsp = [], ysp = [];
  for (const [id, pts] of per) {
    if (id === 0 || id === 21 || pts.length < 2) continue;
    let len = 0, dx = 0, dy = 0;
    for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i]; len += Math.hypot((b[0] - a[0]) * 105, (b[1] - a[1]) * 68); dx += Math.abs(b[0] - a[0]) * 105; dy += Math.abs(b[1] - a[1]) * 68; }
    pl.push(len); net.push(Math.hypot((pts.at(-1)[0] - pts[0][0]) * 105, (pts.at(-1)[1] - pts[0][1]) * 68));
    hor.push(dx / (dx + dy));
    const xs = pts.map((p) => p[0] * 105), ys = pts.map((p) => p[1] * 68);
    xsp.push(Math.max(...xs) - Math.min(...xs)); ysp.push(Math.max(...ys) - Math.min(...ys));
  }
  console.log(`${label.padEnd(10)} ${mean(pl).toFixed(1).padStart(6)} ${mean(net).toFixed(1).padStart(7)} ${mean(hor).toFixed(3).padStart(14)} ${mean(xsp).toFixed(1).padStart(8)} ${mean(ysp).toFixed(1).padStart(8)}   ${(mean(xsp) / mean(ysp)).toFixed(2)}×`);
}
