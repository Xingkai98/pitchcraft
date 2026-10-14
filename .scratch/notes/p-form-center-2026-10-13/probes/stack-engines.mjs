// C2 轴视觉对比：把 N 个 wasm 在**同一个窗**上的引擎轨迹面板纵向叠起来（+ 底部一条真实参照），
// 消掉「单窗高方差」的误判——同一张图里横向比配置、纵向比窗。
// 复用 `trajectory.mjs` 的 collectPaths / 画布尺寸常量，保证与单张图同口径。
// 用法：node stack-engines.mjs <out.png> <seed> <t0> <win> <label:wasm> [<label:wasm> ...]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const { SoftCanvas, canvasToPng } = await import(join(ROOT, 'viewer/soft-canvas.js'));
const { collectPaths, T } = await import(join(ROOT, 'tools/visual-review/trajectory.mjs'));
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
const { createGame } = await import(join(ROOT, 'viewer/game.js'));

const [out, seedArg, t0Arg, winArg, ...specs] = process.argv.slice(2);
const SEED = Number(seedArg || 42), T0 = Number(t0Arg || 1800), WIN = Number(winArg || 90);
const { PW, PH, G, TOP } = T;
const pairs = specs.map((s) => { const i = s.lastIndexOf(':'); return { label: s.slice(0, i), path: s.slice(0, i) && s.slice(i + 1) }; });
// 真实参照
const realPath = process.env.VISUAL_REVIEW_REAL || join(ROOT, 'viewer/data/real-game-1.json');
const g = JSON.parse(readFileSync(realPath, 'utf8'));
const rf = g.frames.map((f) => ({ t: f.t, players: f.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)).filter(Boolean) }));

const rows = [];
for (const { label, path } of pairs) {
  const { wasm, ok } = await loadEngineWasm(path);
  if (!ok) throw new Error(`wasm 加载失败：${path}`);
  const frames = mm.sampleEngineFrames(createGame(simulateStream(wasm, SEED, mm.ENGINE_DURATION_SEC)));
  rows.push({ label, paths: collectPaths(frames, { t0: T0, win: WIN }) });
}
rows.push({ label: 'REAL（参照）', paths: collectPaths(rf, { t0: T0, win: WIN }), real: true });

const W = PW + 2 * G, H = 26 + rows.length * (PH + 26) + G;
const cv = new SoftCanvas(W, H); const ctx = cv.getContext();
ctx.fillStyle = '#111'; ctx.fillRect(0, 0, W, H);
ctx.fillStyle = '#fff'; ctx.font = 'bold 14px sans-serif';
ctx.fillText(`C2 轴 · 同窗对比  seed=${SEED}  t∈[${T0},${T0 + WIN}]s`, G, 18);

const toPx = (ox, oy) => (x, y) => [ox + x * PW, oy + (1 - y) * PH];
rows.forEach((r, i) => {
  const ox = G, oy = 26 + i * (PH + 26);
  const px = toPx(ox, oy);
  ctx.fillStyle = '#0d2b0f'; ctx.fillRect(ox, oy, PW, PH);
  ctx.strokeStyle = '#2f7d32'; ctx.lineWidth = 1.2; ctx.strokeRect(ox, oy, PW, PH);
  ctx.beginPath(); const [m0x, m0y] = px(0.5, 0), [m1x, m1y] = px(0.5, 1); ctx.moveTo(m0x, m0y); ctx.lineTo(m1x, m1y); ctx.stroke();
  ctx.beginPath(); const [ccx, ccy] = px(0.5, 0.5); ctx.arc(ccx, ccy, 0.09 * PW, 0, Math.PI * 2); ctx.stroke();
  let n = 0;
  for (const { id, pts } of r.paths) {
    if (pts.length < 2) continue; n++;
    ctx.strokeStyle = id <= 10 ? '#e84040' : '#4090e8'; ctx.lineWidth = 1.3;
    const [sx, sy] = px(pts[0][0], pts[0][1]); ctx.beginPath(); ctx.moveTo(sx, sy);
    for (const [x, y] of pts.slice(1)) { const [qx, qy] = px(x, y); ctx.lineTo(qx, qy); }
    ctx.stroke();
    const [ex, ey] = pts[pts.length - 1]; const [rx, ry] = px(ex, ey);
    ctx.fillStyle = id <= 10 ? '#e84040' : '#4090e8'; ctx.beginPath(); ctx.arc(rx, ry, 3.5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = r.real ? '#9fd0ff' : '#ffe08a'; ctx.font = 'bold 12px sans-serif';
  ctx.fillText(`${r.label}   （画 ${n} 人）`, ox + 3, oy - 5);
});
writeFileSync(out, canvasToPng(cv));
console.log(out);
