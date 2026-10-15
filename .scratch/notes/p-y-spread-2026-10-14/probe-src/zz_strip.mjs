// 引擎-only 轨迹条带：同一窗、多个 wasm 并排（+1 真实面板）。给人一眼看「y 变窄」的形态。
// 用法: node zz_strip.mjs <out.png> <t0> <win> <tag=wasm>...
import { writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { SoftCanvas, canvasToPng } = await import(join(ROOT, 'viewer/soft-canvas.js'));
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const { createGame } = await import(join(ROOT, 'viewer/game.js'));

const PW = 250, PH = Math.round(250 * 68 / 105), G = 8, TOP = 26;
const [out, t0Arg, winArg, ...specs] = process.argv.slice(2);
const T0 = Number(t0Arg), WIN = Number(winArg);

function draw(ctx, ox, oy, frames, label, seed) {
  const toPx = (x, y) => [ox + x * PW, oy + (1 - y) * PH];
  ctx.fillStyle = '#0d2b0f'; ctx.fillRect(ox, oy, PW, PH);
  ctx.strokeStyle = '#2f7d32'; ctx.lineWidth = 1; ctx.strokeRect(ox, oy, PW, PH);
  const [a, b] = [toPx(0.5, 0), toPx(0.5, 1)];
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  const paths = new Map();
  for (const f of frames) {
    if (f.t < T0 || f.t > T0 + WIN) continue;
    for (const p of f.players) { if (!p) continue; if (!paths.has(p.id)) paths.set(p.id, []); paths.get(p.id).push([p.x, p.y]); }
  }
  for (const [id, pts] of paths) {
    if (pts.length < 2) continue;
    ctx.strokeStyle = id <= 10 ? '#e84040' : '#4090e8'; ctx.lineWidth = 1.1;
    ctx.beginPath(); const [sx, sy] = toPx(pts[0][0], pts[0][1]); ctx.moveTo(sx, sy);
    for (const [x, y] of pts.slice(1)) { const [px, py] = toPx(x, y); ctx.lineTo(px, py); }
    ctx.stroke();
  }
  ctx.fillStyle = '#cfe8cf'; ctx.font = 'bold 11px sans-serif'; ctx.fillText(label, ox + 3, oy - 5);
}

const panels = [];
for (const s of specs) {
  const [tag, wasm] = s.split('|');
  const { wasm: w, ok } = await loadEngineWasm(wasm);
  if (!ok) { console.error('加载失败', wasm); continue; }
  panels.push({ tag, frames: mm.sampleEngineFrames(createGame(simulateStream(w, 42, mm.ENGINE_DURATION_SEC))) });
}
const g = JSON.parse(readFileSync(join(ROOT, 'viewer/data/real-game-1.json'), 'utf8'));
panels.push({ tag: 'REAL', frames: g.frames.map((f) => mm.fromTrackingFrame(f)) });

const W = panels.length * PW + (panels.length + 1) * G, H = TOP + PH + G;
const cv = new SoftCanvas(W, H); const ctx = cv.getContext();
ctx.fillStyle = '#111'; ctx.fillRect(0, 0, W, H);
ctx.fillStyle = '#fff'; ctx.font = 'bold 12px sans-serif';
ctx.fillText(`引擎 vs 真实 · 90s 轨迹 · t∈[${T0},${T0 + WIN}]s · seed 42`, G, 17);
panels.forEach((p, i) => draw(ctx, G + i * (PW + G), TOP, p.frames, p.tag, 42));
writeFileSync(out, canvasToPng(cv));
console.log(out);
