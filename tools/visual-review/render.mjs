// 视觉审阅：渲「引擎 vs 真实」对比图，供视觉模型判读「像不像足球」。
//
// 为什么这样渲（三条都是踩过坑才定的，别改回去）：
//   1. **短窗密采**：12s 内 6 帧（每 2.4s）。旧版 50s 稀疏 6 帧看不出「动没动」——
//      静态阵型图与「球在场上跑」在稀疏采样下长一样。
//   2. **球必须画出来**：`sampleEngineFrames` 的 `ball` 是**数组 [x,y]**，
//      真实帧的 ball 也是 [x,y]。曾用 `ball.x`（对象口径）判断 → 引擎那排的球
//      从来没画出来，视觉裁判连续多轮「看不到球/读成无球」，主 session 误判成「球点太小」。
//      统一用 `ballXY()`，球画成亮黄大点（#ffe400，r=6）。
//   3. **两排同口径**：上引擎下真实，同一时间窗、同一采样——不同口径对比无意义。
//
// 用法：
//   node tools/visual-review/render.mjs <engine.wasm> <out.png> [seed] [t0] [winSec] [nFrames]
//   node tools/visual-review/render.mjs viewer/engine.wasm /tmp/cmp.png 42 600 12 6
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const { SoftCanvas, canvasToPng } = await import(join(ROOT, 'viewer/soft-canvas.js'));
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
const { createGame } = await import(join(ROOT, 'viewer/game.js'));

const [wasmPath, out, seedArg, t0Arg, winArg, nArg] = process.argv.slice(2);
if (!wasmPath || !out) {
  console.error('用法: node tools/visual-review/render.mjs <engine.wasm> <out.png> [seed] [t0] [win] [nFrames]');
  process.exit(2);
}
const SEED = Number(seedArg || 42), T0 = Number(t0Arg || 600);
const WIN = Number(winArg || 12), COLS = Number(nArg || 6);
const STEP = WIN / (COLS - 1);
const PW = 380, PH = 250, G = 10, TOP = 30;
const W = COLS * PW + (COLS + 1) * G, H = 2 * (PH + TOP) + G;

// 球坐标统一口径：引擎与真实帧都是 [x,y]；兼容 {x,y}（防御）。
export const ballXY = (b) => Array.isArray(b) ? b : (b && typeof b.x === 'number' ? [b.x, b.y] : null);

const cv = new SoftCanvas(W, H); const ctx = cv.getContext();
ctx.fillStyle = '#111'; ctx.fillRect(0, 0, W, H);

export function drawPanel(ctx, ox, oy, PW, PH, players, ball, label) {
  const toPx = (x, y) => [ox + x * PW, oy + (1 - y) * PH];
  ctx.fillStyle = '#0d2b0f'; ctx.fillRect(ox, oy, PW, PH);
  ctx.strokeStyle = '#3a8a3a'; ctx.lineWidth = 1.2; ctx.strokeRect(ox, oy, PW, PH);
  ctx.beginPath(); ctx.moveTo(ox + PW / 2, oy); ctx.lineTo(ox + PW / 2, oy + PH); ctx.stroke();
  ctx.beginPath(); ctx.arc(ox + PW / 2, oy + PH / 2, 0.09 * PW, 0, Math.PI * 2); ctx.stroke();
  for (const p of players) {
    const [px, py] = toPx(p.x, p.y);
    ctx.fillStyle = p.id <= 10 ? '#e84040' : '#4090e8';
    ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fill();
  }
  const bxy = ballXY(ball);
  if (bxy) {
    const [bx, by] = toPx(bxy[0], bxy[1]);
    ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(bx, by, 8.5, 0, Math.PI * 2); ctx.fill(); // 深色描边
    ctx.fillStyle = '#ffe400'; ctx.beginPath(); ctx.arc(bx, by, 6, 0, Math.PI * 2); ctx.fill(); // 亮黄球
  }
  ctx.fillStyle = '#cfe8cf'; ctx.font = 'bold 12px sans-serif'; ctx.fillText(label, ox + 3, oy - 5);
}

// 引擎帧
const { wasm, ok } = await loadEngineWasm(wasmPath);
if (!ok) { console.error(`加载 wasm 失败：${wasmPath}`); process.exit(1); }
const ef = mm.sampleEngineFrames(createGame(simulateStream(wasm, SEED, mm.ENGINE_DURATION_SEC)));

// 真实帧（对照通路，绕过引擎与演绎层，是参照物）—— P35 的 Metrica 通路，入库在 viewer/data/。
// 可用 VISUAL_REVIEW_REAL 覆盖（如指向 .scratch/p38-frames/ 里自建的帧序列）。
const realPath = process.env.VISUAL_REVIEW_REAL || join(ROOT, 'viewer/data/real-game-1.json');
let rf;
try {
  const g = JSON.parse(readFileSync(realPath, 'utf8'));
  rf = g.frames.map(f => ({ t: f.t, players: f.players.map((p, id) => p ? { id, x: p[0], y: p[1] } : null).filter(Boolean), ball: f.ball }));
} catch (e) {
  console.error(`读真实帧失败（${realPath}）：${e.message}\n  → 运行 tools/convert-tracking-to-frames.mjs，或设 VISUAL_REVIEW_REAL 指向你的帧文件`);
  process.exit(1);
}
const near = (a, t) => { let b = a[0], bd = Infinity; for (const f of a) { const d = Math.abs(f.t - t); if (d < bd) { bd = d; b = f; } } return b; };

for (let c = 0; c < COLS; c++) {
  const t = T0 + c * STEP, e = near(ef, t), r = near(rf, t);
  drawPanel(ctx, G + c * (PW + G), TOP, PW, PH, e.players, e.ball, `ENGINE  t=${e.t.toFixed(1)}s`);
  drawPanel(ctx, G + c * (PW + G), TOP + PH + TOP, PW, PH, r.players, r.ball, `REAL  t=${r.t.toFixed(1)}s`);
}
ctx.fillStyle = '#fff'; ctx.font = 'bold 13px sans-serif';
ctx.fillText(`上=引擎  下=真实  |  窗口 ${WIN}s 内 ${COLS} 帧（每 ${STEP.toFixed(1)}s）—— 看球(黄)是否移动、人是否持续跑`, G, 18);
writeFileSync(out, canvasToPng(cv));
console.log(out);
