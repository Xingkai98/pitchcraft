// P38 视觉对比 2：球员**移动轨迹**图（比单帧更能看出"动法"差异）
//
// 为什么：本轮最重要的结构发现是「引擎横向移动只有真实的 1/24」。单帧看不出来，
// 轨迹图一眼就看出——真实球员的轨迹是**散开的面**，引擎是**几条竖线**。
//
// 用法：node render-trajectories.mjs <engine|real> <out.png> <label> [windowSec]

import { readFileSync, writeFileSync } from 'node:fs';

const HERE = process.env.P38_ROOT || '/home/happy/.claude/worktrees/wayfinder-realism';
const { SoftCanvas, canvasToPng } = await import(`${HERE}/viewer/soft-canvas.js`);

const [source, outPath, label, winArg] = process.argv.slice(2);
const WIN = Number(winArg || 120);   // 观察窗长度（秒）
const W = 900; const H = 620;
const MARGIN = 40;

// 球场（归一化 0-1）→ 像素。y 翻转与 renderer 一致（y=0 在下边线）。
function toPx(x, y) {
  return [MARGIN + x * (W - 2 * MARGIN), MARGIN + (1 - y) * (H - 2 * MARGIN)];
}

function drawPitchOutline(ctx) {
  ctx.strokeStyle = '#2f7d32';
  ctx.lineWidth = 2;
  const [x0, y0] = toPx(0, 1); const [x1, y1] = toPx(1, 0);
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y1); ctx.lineTo(x0, y1);
  ctx.closePath ? ctx.closePath() : ctx.lineTo(x0, y0); ctx.stroke();
  // 中线
  const [mx0, my0] = toPx(0.5, 1); const [mx1, my1] = toPx(0.5, 0);
  ctx.beginPath(); ctx.moveTo(mx0, my0); ctx.lineTo(mx1, my1); ctx.stroke();
  // 中圈
  const [ccx, ccy] = toPx(0.5, 0.5);
  ctx.beginPath(); ctx.arc(ccx, ccy, 0.09 * (W - 2 * MARGIN), 0, Math.PI * 2); ctx.stroke();
  // 两个禁区（示意）
  for (const side of [0, 1]) {
    const bx0 = side === 0 ? 0 : 0.84; const bx1 = side === 0 ? 0.16 : 1;
    const [px0, py0] = toPx(bx0, 0.8); const [px1, py1] = toPx(bx1, 0.2);
    ctx.strokeRect(Math.min(px0, px1), Math.min(py0, py1), Math.abs(px1 - px0), Math.abs(py1 - py0));
  }
}

const canvas = new SoftCanvas(W, H);
const ctx = canvas.getContext();
ctx.fillStyle = '#0d2b0f';
ctx.fillRect(0, 0, W, H);
drawPitchOutline(ctx);

// 收集轨迹：each player -> 点序列
const paths = new Map(); // id -> [[x,y],...]
const homeColor = '#e84040';
const awayColor = '#4090e8';

function addFrame(players) {
  for (const p of players) {
    if (!p) continue;
    if (!paths.has(p.id)) paths.set(p.id, []);
    paths.get(p.id).push([p.x, p.y]);
  }
}

if (source === 'engine') {
  const { loadEngineWasm, simulateStream, WASM_PATH } = await import(`${HERE}/tools/benchmark-engine.mjs`);
  const mm = await import(`${HERE}/viewer/match-metrics.js`);
  const load = await loadEngineWasm(WASM_PATH);
  const { createGame } = await import(`${HERE}/viewer/game.js`);
  const game = createGame(simulateStream(load.wasm, 42, mm.ENGINE_DURATION_SEC));
  const frames = mm.sampleEngineFrames(game);
  // 取中段一个窗口（避免开球瞬间）
  const t0 = 1800;
  for (const f of frames) if (f.t >= t0 && f.t <= t0 + WIN) addFrame(f.players);
  console.log(`引擎 t∈[${t0},${t0 + WIN}]s`);
} else {
  const g = JSON.parse(readFileSync(`${HERE}/viewer/data/real-game-1.json`, 'utf8'));
  const frames = g.frames
    .filter((f) => f.t >= 1800 && f.t <= 1800 + WIN)
    .map((f) => ({ t: f.t, players: f.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)) }));
  for (const f of frames) addFrame(f.players);
  console.log(`真实 t∈[1800,${1800 + WIN}]s（Metrica game1）`);
}

// 画轨迹
for (const [id, pts] of paths) {
  if (pts.length < 2) continue;
  ctx.strokeStyle = id <= 10 ? homeColor : awayColor;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const [sx, sy] = toPx(pts[0][0], pts[0][1]);
  ctx.moveTo(sx, sy);
  for (const [x, y] of pts.slice(1)) { const [px, py] = toPx(x, y); ctx.lineTo(px, py); }
  ctx.stroke();
}

// 画终点位置（圆点 + id）
for (const [id, pts] of paths) {
  const [x, y] = pts[pts.length - 1];
  const [px, py] = toPx(x, y);
  ctx.fillStyle = id <= 10 ? homeColor : awayColor;
  ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = '11px sans-serif';
  ctx.fillText(String(id), px + 7, py + 4);
}

writeFileSync(outPath, canvasToPng(canvas));
console.log(`→ ${outPath}  (${paths.size} 名球员的 ${WIN}s 轨迹)`);

// 横向移动量的数值（与图对应）
let sY = []; let sX = [];
for (const [id, pts] of paths) {
  if (id === 0 || id === 21 || pts.length < 10) continue;
  const ys = pts.map((p) => p[1]); const xs = pts.map((p) => p[0]);
  const mean = (a) => a.reduce((u, v) => u + v, 0) / a.length;
  const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
  sY.push(sd(ys) * 68); sX.push(sd(xs) * 105);
}
const mean = (a) => a.reduce((u, v) => u + v, 0) / a.length;
console.log(`  非门将横向位移 sd 均值: ${mean(sY).toFixed(2)} m`);
console.log(`  非门将纵向位移 sd 均值: ${mean(sX).toFixed(2)} m`);
