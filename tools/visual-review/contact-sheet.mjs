// 视觉审阅：**多窗 contact sheet**——「像裁判那样渲多张图」的网格图。
//
// ── 为什么有它（用户 2026-10-05 的要求）─────────────────────────────────────
// 单张 12s 对比图**装不下跨时间的形态**。用户的抱怨「机械分边」（红队钉左、蓝队钉右）是一个
// **贯穿全场的模式**——单帧可能碰巧不像、单窗可能碰巧像；要证它「一直在」，必须**多窗同看**。
// 主 session 之前只渲 1 张图 → 主 session 自己看不出「一直机械」→ 飞轮空转。
// 本工具把 **N 个时间窗 × M 帧** 铺成一张网格（引擎与真实逐窗并列），
// 让「形态是否持续」一眼可见，供主 session 迭代 + 视觉裁判判读。
//
// 布局：每个时间窗 → 上面是 [ENGINE 该窗 M 帧]、下面是 [REAL 该窗 M 帧]。
// 口径与 render.mjs 完全一致（同一 drawPanel / ballXY / 采样），否则跨工具不可比。
//
// 用法：node tools/visual-review/contact-sheet.mjs <engine.wasm> <out.png> \
//        [seed=42] [winSec=12] [nFrames=6] [t0csv=200,1200,3000]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { SoftCanvas, canvasToPng } = await import(join(ROOT, 'viewer/soft-canvas.js'));
const { drawPanel, ballXY } = await import(join(ROOT, 'tools/visual-review/render.mjs'));

// 面板小一号（网格要塞 N 窗 × 2 源）。
export const CS_PW = 300, CS_PH = Math.round(300 * 68 / 105), CS_G = 8, CS_TOP = 26, CS_HDR = 34;

const IS_ENTRY = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
const near = (a, t) => { let b = a[0], bd = Infinity; for (const f of a) { const d = Math.abs(f.t - t); if (d < bd) { bd = d; b = f; } } return b; };

// 装配网格。**纯函数**：吃引擎帧 + 真实帧 + 窗表，产 canvas。测试可用合成帧直调。
// 返回 `rows`：**每一条真正画出来的行**的元数据（源/窗/行带 y 区间）——测试用它**分排数内容**
// （见 contact-sheet.test.mjs：删掉整条 REAL 行必须红，这是 render.mjs 的「单排丢球」纪律，
// 网格图更不能丢——见飞轮 review P1）。rows 与「画了几行」同源，不可能「声称画了却没画」。
export function buildContactSheet(engineFrames, realFrames, { t0s = [200, 1200, 3000], win = 12, n = 6 } = {}) {
  const PW = CS_PW, PH = CS_PH, G = CS_G, TOP = CS_TOP;
  const STEP = win / Math.max(1, n - 1);
  const nRows = t0s.length * 2;
  const W = n * PW + (n + 1) * G;
  const H = CS_HDR + nRows * (PH + TOP) + G;
  const cv = new SoftCanvas(W, H); const ctx = cv.getContext();
  ctx.fillStyle = '#111'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 14px sans-serif';
  ctx.fillText(`CONTACT SHEET  ${t0s.length} 窗 × ${n} 帧（每窗 ${win}s）| 每窗上下：引擎 / 真实 | 看「形态(如红蓝是否各钉半场)是否**每窗都在**」`, G, 20);
  const rows = [];
  let row = 0;
  for (const t0 of t0s) {
    for (const [src, frames, tag] of [['E', engineFrames, 'ENGINE'], ['R', realFrames, 'REAL']]) {
      const oy = CS_HDR + row * (PH + TOP);
      ctx.fillStyle = src === 'E' ? '#ffd0d0' : '#cfe0ff'; ctx.font = 'bold 11px sans-serif';
      ctx.fillText(`${tag}  窗 t0=${t0}s`, G + 2, oy - 4);
      for (let c = 0; c < n; c++) {
        const t = t0 + c * STEP, f = near(frames, t);
        drawPanel(ctx, G + c * (PW + G), oy, PW, PH, f.players, f.ball, `t=${f.t.toFixed(0)}s`);
      }
      rows.push({ src, t0, y0: oy, y1: oy + PH });
      row++;
    }
  }
  return { canvas: cv, W, H, rows };
}

if (IS_ENTRY) {
  const [wasmPath, out, seedArg, winArg, nArg, t0Arg] = process.argv.slice(2);
  if (!wasmPath || !out) {
    console.error('用法: node contact-sheet.mjs <engine.wasm> <out.png> [seed] [win] [nFrames] [t0csv]');
    process.exit(2);
  }
  const SEED = Number(seedArg || 42), WIN = Number(winArg || 12), N = Number(nArg || 6);
  const t0s = (t0Arg || '200,1200,3000').split(',').map(Number);
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
    console.error(`读真实帧失败（${realPath}）：${e.message}`); process.exit(1);
  }
  const { canvas } = buildContactSheet(ef, rf, { t0s, win: WIN, n: N });
  writeFileSync(out, canvasToPng(canvas));
  console.log(out);
}
