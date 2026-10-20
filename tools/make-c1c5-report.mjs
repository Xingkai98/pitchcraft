// 交付物：C1–C5 的比赛效果对比图（旧引擎 / 新引擎 / 真实）。
//
// 三个来源并排，同一时间窗、同一采样口径（与 `contact-sheet.mjs` 完全一致，
// 否则跨工具不可比）：
//
//   1. OLD —— `realism` 全关（= main 上的引擎）
//   2. NEW —— `realism=motion+formation+marking+press`（C1–C4 全开）
//   3. REAL —— `viewer/data/real-game-1.json`（Metrica 真实帧）
//
// 用法：
//   node tools/make-c1c5-report.mjs <engine.wasm> <out.png> [seed] [win] [nFrames] [t0csv]
//
// 产物给用户白天看：每行一个时间窗，三行一组（OLD / NEW / REAL），6 帧均匀铺开。

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { SoftCanvas, canvasToPng } = await import(join(ROOT, 'viewer/soft-canvas.js'));
const { drawPanel } = await import(join(ROOT, 'tools/visual-review/render.mjs'));
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
const { createGame } = await import(join(ROOT, 'viewer/game.js'));

const PW = 300, PH = Math.round(300 * 68 / 105), G = 8, TOP = 12, HDR = 10;
const near = (a, t) => { let b = a[0], bd = Infinity; for (const f of a) { const d = Math.abs(f.t - t); if (d < bd) { bd = d; b = f; } } return b; };

/** 三源 contact sheet。纯函数：吃三组帧 + 窗表，产 canvas。 */
export function buildReport(oldFrames, newFrames, realFrames, { t0s = [200, 1200, 3000], win = 12, n = 6 } = {}) {
  const STEP = win / Math.max(1, n - 1);
  const nRows = t0s.length * 3;
  const W = n * PW + (n + 1) * G;
  const H = HDR + nRows * (PH + TOP) + G;
  const cv = new SoftCanvas(W, H); const ctx = cv.getContext();
  ctx.fillStyle = '#111'; ctx.fillRect(0, 0, W, H);
  // soft-canvas 不支持文字渲染（fillText 只会画横杠），标签交给外层 HTML。这里用**色条**区分来源。
  let y = HDR;
  const rows = [];
  for (const t0 of t0s) {
    for (const [name, frames, color] of [['OLD', oldFrames, '#ff6b6b'], ['NEW', newFrames, '#4ecdc4'], ['REAL', realFrames, '#ffd93d']]) {
      // 行首色条：红=OLD / 青=NEW / 黄=REAL
      ctx.fillStyle = color;
      ctx.fillRect(0, y + 6, 5, PH + TOP - 10);
      for (let i = 0; i < n; i++) {
        const t = t0 + i * STEP;
        const f = near(frames, t);
        const ox = G + i * (PW + G);
        const oy = y + TOP;
        if (f) drawPanel(ctx, ox, oy, PW, PH, f.players, f.ball, `t=${f.t.toFixed(1)}`);
        else { ctx.fillStyle = '#400'; ctx.fillRect(ox, oy, PW, PH); }
      }
      rows.push({ name, t0 });
      y += PH + TOP;
    }
  }
  return { canvas: cv, W, H, rows };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [wasmPath, out, seedArg, winArg, nArg, t0Arg] = process.argv.slice(2);
  if (!wasmPath || !out) {
    console.error('用法: node tools/make-c1c5-report.mjs <engine.wasm> <out.png> [seed] [win] [n] [t0csv]');
    process.exit(2);
  }
  const SEED = Number(seedArg || 42), WIN = Number(winArg || 12), N = Number(nArg || 6);
  const t0s = (t0Arg || '200,1200,3000').split(',').map(Number);
  const { wasm, ok } = await loadEngineWasm(wasmPath);
  if (!ok) { console.error(`加载 wasm 失败：${wasmPath}`); process.exit(1); }
  const dur = mm.ENGINE_DURATION_SEC;
  const oldF = mm.sampleEngineFrames(createGame(simulateStream(wasm, SEED, dur, '')));
  const newF = mm.sampleEngineFrames(createGame(simulateStream(wasm, SEED, dur, 'motion+formation+marking+press')));
  const realPath = process.env.VISUAL_REVIEW_REAL || join(ROOT, 'viewer/data/real-game-1.json');
  let realF;
  try {
    const g = JSON.parse(readFileSync(realPath, 'utf8'));
    realF = g.frames.map(f => ({ t: f.t, players: f.players.map((p, id) => p ? { id, x: p[0], y: p[1] } : null).filter(Boolean), ball: f.ball }));
  } catch (e) {
    console.error(`读真实帧失败（${realPath}）：${e.message}`); process.exit(1);
  }
  const { canvas } = buildReport(oldF, newF, realF, { t0s, win: WIN, n: N });
  writeFileSync(out, canvasToPng(canvas));
  console.log(out);
}
