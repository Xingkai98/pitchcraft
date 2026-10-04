// 视觉审阅：渲「引擎 vs 真实」对比图，供视觉模型判读「像不像足球」。
//
// 为什么这样渲（三条都是踩过坑才定的，别改回去）：
//   1. **短窗密采**：12s 内 6 帧（每 2.4s）。旧版 50s 稀疏 6 帧看不出「动没动」——
//      静态阵型图与「球在场上跑」在稀疏采样下长一样。
//   2. **球必须画出来**：`sampleEngineFrames` 的 `ball` 是**数组 [x,y]**，
//      真实帧的 ball 也是 [x,y]。曾用 `ball.x`（对象口径）判断 → 引擎那排的球
//      从来没画出来，视觉裁判连续多轮「看不到球」，主 session 误判成「球点太小」。
//      统一用 `ballXY()`，球画成亮黄大点（#ffe400，r=6）。
//   3. **两排同口径**：上引擎下真实，同一时间窗、同一采样——不同口径对比无意义。
//
// ⚠️ **实测依赖**（守护测试已去此依赖，见 visual-review.test.mjs）：
//   引擎帧要 `viewer/engine.wasm`（gitignore，须 cargo build 或 CI 编译）；
//   真实对照要 `viewer/data/real-game-1.json`（**gitignore，CI 不产** → CI 上本脚本跑不了）；
//   可用 `VISUAL_REVIEW_REAL` 覆盖真实帧路径。
//
// 用法：
//   node tools/visual-review/render.mjs <engine.wasm> <out.png> [seed] [t0] [winSec] [nFrames]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const { SoftCanvas, canvasToPng } = await import(join(ROOT, 'viewer/soft-canvas.js'));

// 布局常量（导出供测试算行带）
export const LAYOUT = { PW: 380, PH: 250, G: 10, TOP: 30 };

// 球坐标统一口径：引擎与真实帧都是 [x,y]；兼容 {x,y}（防御）。
export const ballXY = (b) => Array.isArray(b) ? b : (b && typeof b.x === 'number' ? [b.x, b.y] : null);

// 画一个面板。**球必须画**（漏画是本工具存在的首要原因）。
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

// 装配整张对比图（上引擎 / 下真实）。**纯函数**：吃帧序列，产 canvas + 行带坐标，
// 不加载任何数据 → 测试可用合成帧直接调（不必有 wasm / 真实数据，CI 必跑）。
export function buildComparison(engineFrames, realFrames, { t0 = 600, win = 12, n = 6 } = {}) {
  const { PW, PH, G, TOP } = LAYOUT;
  const STEP = win / Math.max(1, n - 1);
  const W = n * PW + (n + 1) * G, H = 2 * (PH + TOP) + G;
  const cv = new SoftCanvas(W, H); const ctx = cv.getContext();
  ctx.fillStyle = '#111'; ctx.fillRect(0, 0, W, H);
  const near = (a, t) => { let b = a[0], bd = Infinity; for (const f of a) { const d = Math.abs(f.t - t); if (d < bd) { bd = d; b = f; } } return b; };
  const engY = TOP, realY = TOP + PH + TOP;
  for (let c = 0; c < n; c++) {
    const t = t0 + c * STEP, e = near(engineFrames, t), r = near(realFrames, t);
    drawPanel(ctx, G + c * (PW + G), engY, PW, PH, e.players, e.ball, `ENGINE  t=${e.t.toFixed(1)}s`);
    drawPanel(ctx, G + c * (PW + G), realY, PW, PH, r.players, r.ball, `REAL  t=${r.t.toFixed(1)}s`);
  }
  ctx.fillStyle = '#fff'; ctx.font = 'bold 13px sans-serif';
  ctx.fillText(`上=引擎  下=真实  |  窗口 ${win}s 内 ${n} 帧（每 ${STEP.toFixed(1)}s）—— 看球(黄)是否移动、人是否持续跑`, G, 18);
  return { canvas: cv, ctx, bands: { engine: [engY, engY + PH], real: [realY, realY + PH] }, W, H };
}

const IS_ENTRY = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (IS_ENTRY) {
  const [wasmPath, out, seedArg, t0Arg, winArg, nArg] = process.argv.slice(2);
  if (!wasmPath || !out) {
    console.error('用法: node tools/visual-review/render.mjs <engine.wasm> <out.png> [seed] [t0] [win] [nFrames]');
    process.exit(2);
  }
  const SEED = Number(seedArg || 42), T0 = Number(t0Arg || 600), WIN = Number(winArg || 12), N = Number(nArg || 6);
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
    rf = g.frames.map(f => ({ t: f.t, players: f.players.map((p, id) => p ? { id, x: p[0], y: p[1] } : null).filter(Boolean), ball: f.ball }));
  } catch (e) {
    console.error(`读真实帧失败（${realPath}）：${e.message}\n  → 运行 tools/fetch-tracking-data.mjs && tools/convert-tracking-to-frames.mjs，或设 VISUAL_REVIEW_REAL`);
    process.exit(1);
  }
  const { canvas } = buildComparison(ef, rf, { t0: T0, win: WIN, n: N });
  writeFileSync(out, canvasToPng(canvas));
  console.log(out);
}
