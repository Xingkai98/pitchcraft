// 视觉审阅：**引擎 vs 真实 球员轨迹并排图**——看「怎么动」，一眼看出「铁轨」。
//
// ── 为什么有它（2026-10-05，用户第二次强调「得看图、不能只靠指标」）──────────────
// P143r 三版「指标变好、用户看不出」的根因之一：**开发时只跑数字、从不渲这张图**。
// 这张图一渲就露馅——两个引擎版本（main/FB4）的 90s 轨迹都是**水平短线**（球员在各自
// 车道上左右滑，横向几乎冻结）；真实是**一团纠缠的弧线**（球员跑向球、绕行、回追，
// 红蓝混在一起、集中在中路）。而当时我引的指标（方向一致性/静止率/甚至横向 sd）
// 都是这个结构的**弱代理**——`sd 0.37→1.34` 会把 FB4 的「横向抖动」误报成「改善」。
//
// **纪律（本工具的用途，别当摆设）**：改移动层后**第一步跑它、Read 它、把看到的写下来**，
// **然后**才引 like-football 的数字。顺序是「**先看后量**」——本仓 CLAUDE.md 早写过
// 「图用于发现问题和验收；能被算出来的量写成数值断言进 CI」= **图能发现，数值能守护**。
// 我（主 session）在 P143r 违反了它（只跑 motion-metrics、从不渲轨迹），所以飞轮空转三版。
//
// 用法：node tools/visual-review/trajectory.mjs <engine.wasm> <out.png> [seed=42] [t0=1800] [winSec=90]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { SoftCanvas, canvasToPng } = await import(join(ROOT, 'viewer/soft-canvas.js'));

const IS_ENTRY = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
export const T = { PW: 430, PH: 280, G: 12, TOP: 30 };

// 单个面板：画 90s 轨迹（线）+ 终点（点+id）。y 翻转与 renderer 一致。
function drawTrajPanel(ctx, ox, oy, players, label) {
  const { PW, PH } = T;
  const toPx = (x, y) => [ox + x * PW, oy + (1 - y) * PH];
  ctx.fillStyle = '#0d2b0f'; ctx.fillRect(ox, oy, PW, PH);
  ctx.strokeStyle = '#2f7d32'; ctx.lineWidth = 1.2; ctx.strokeRect(ox, oy, PW, PH);
  ctx.beginPath(); const [m0x, m0y] = toPx(0.5, 0); const [m1x, m1y] = toPx(0.5, 1);
  ctx.moveTo(m0x, m0y); ctx.lineTo(m1x, m1y); ctx.stroke();
  ctx.beginPath(); const [ccx, ccy] = toPx(0.5, 0.5); ctx.arc(ccx, ccy, 0.09 * PW, 0, Math.PI * 2); ctx.stroke();
  let n = 0;
  for (const { id, pts } of players) {
    if (pts.length < 2) continue;
    n++;
    ctx.strokeStyle = id <= 10 ? '#e84040' : '#4090e8'; ctx.lineWidth = 1.3;
    ctx.beginPath(); const [sx, sy] = toPx(pts[0][0], pts[0][1]); ctx.moveTo(sx, sy);
    for (const [x, y] of pts.slice(1)) { const [px, py] = toPx(x, y); ctx.lineTo(px, py); }
    ctx.stroke();
    const [ex, ey] = pts[pts.length - 1]; const [px, py] = toPx(ex, ey);
    ctx.fillStyle = id <= 10 ? '#e84040' : '#4090e8'; ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '10px sans-serif'; ctx.fillText(String(id), px + 5, py + 3);
  }
  ctx.fillStyle = '#cfe8cf'; ctx.font = 'bold 12px sans-serif'; ctx.fillText(label, ox + 3, oy - 5);
  return n;
}

// 帧序列 + 窗 → 每球员的点序列。**纯函数**（测试用合成帧直调）。
export function collectPaths(frames, { t0, win }) {
  const paths = new Map();
  for (const f of frames) {
    if (f.t < t0 || f.t > t0 + win) continue;
    for (const p of f.players) {
      if (!p) continue;
      if (!paths.has(p.id)) paths.set(p.id, []);
      paths.get(p.id).push([p.x, p.y]);
    }
  }
  return [...paths.entries()].map(([id, pts]) => ({ id, pts }));
}

// 装配并排图（左引擎 / 右真实）。**纯函数**：吃帧序列，产 canvas + 每面板路径数。测试直调。
export function buildTrajectoryComparison(engineFrames, realFrames, { t0 = 1800, win = 90 } = {}) {
  const { PW, PH, G, TOP } = T;
  const W = 2 * PW + 3 * G, H = TOP + PH + G;
  const cv = new SoftCanvas(W, H); const ctx = cv.getContext();
  ctx.fillStyle = '#111'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 13px sans-serif';
  ctx.fillText(`球员 90s 轨迹  |  左=引擎  右=真实  |  t∈[${t0},${t0 + win}]s  —— 看「铁轨(水平短线) vs 团(纠缠弧线)」、两队是否混`, G, 18);
  const ePaths = collectPaths(engineFrames, { t0, win });
  const rPaths = collectPaths(realFrames, { t0, win });
  const ne = drawTrajPanel(ctx, G, TOP, ePaths, 'ENGINE');
  const nr = drawTrajPanel(ctx, G + PW + G, TOP, rPaths, 'REAL');
  return { canvas: cv, W, H, panels: { engine: { n: ne, paths: ePaths }, real: { n: nr, paths: rPaths } } };
}

if (IS_ENTRY) {
  const [wasmPath, out, seedArg, t0Arg, winArg] = process.argv.slice(2);
  if (!wasmPath || !out) { console.error('用法: node trajectory.mjs <engine.wasm> <out.png> [seed=42] [t0=1800] [winSec=90]'); process.exit(2); }
  const SEED = Number(seedArg || 42), T0 = Number(t0Arg || 1800), WIN = Number(winArg || 90);
  const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
  const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
  const { createGame } = await import(join(ROOT, 'viewer/game.js'));
  const { wasm, ok } = await loadEngineWasm(wasmPath);
  if (!ok) { console.error(`加载 wasm 失败：${wasmPath}`); process.exit(1); }
  const ef = mm.sampleEngineFrames(createGame(simulateStream(wasm, SEED, mm.ENGINE_DURATION_SEC)));
  const realPath = process.env.VISUAL_REVIEW_REAL || join(ROOT, 'viewer/data/real-game-1.json');
  let rf;
  try {
    const g = JSON.parse(readFileSync(realPath, 'utf8'));
    rf = g.frames.map(f => ({ t: f.t, players: f.players.map((p, id) => p ? { id, x: p[0], y: p[1] } : null).filter(Boolean) }));
  } catch (e) { console.error(`读真实帧失败（${realPath}）：${e.message}`); process.exit(1); }
  const { canvas } = buildTrajectoryComparison(ef, rf, { t0: T0, win: WIN });
  writeFileSync(out, canvasToPng(canvas));
  console.log(out);
}
