// P38 视觉对比：把同一「球位时刻」的三份来源渲染成 PNG，直接看队形形状。
//
// 来源：baseline（干净 main 引擎）/ exp4b（等间距次序目标）/ real（Metrica 真实比赛）
// 用法：node render-compare.mjs <engine|real> <outdir> <label>
//
// 只做探索性观察——项目约束「验证不得依赖模型视觉」指的是**门槛**，看画面用于发现问题是正当的。

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = '/home/happy/.claude/worktrees/wayfinder-realism';
const { config } = await import(`${HERE}/viewer/config.js`);
const { renderFrame } = await import(`${HERE}/viewer/renderer.js`);
const { SoftCanvas, canvasToPng } = await import(`${HERE}/viewer/soft-canvas.js`);

const W = config.canvas.width;
const H = config.canvas.height;

const [source, outDir, label] = process.argv.slice(2);
if (!source || !outDir) { console.error('用法: node render-compare.mjs <engine|real> <outdir> <label>'); process.exit(1); }
mkdirSync(outDir, { recursive: true });

// 目标球位（归一化 x）：中场 / 主队进攻三区 / 主队本方后场
const TARGETS = [
  { name: 'ball-own-half-x20', x: 0.20 },
  { name: 'ball-mid-x50', x: 0.50 },
  { name: 'ball-att-third-x75', x: 0.75 },
];

function stateOf(playersArr, ball) {
  // playersArr: [{id,x,y}|null × 22]
  return {
    players: playersArr.filter(Boolean).map((p) => ({ id: p.id, x: p.x, y: p.y })),
    ball: ball ? { x: ball[0], y: ball[1] } : { x: 0.5, y: 0.5 },
  };
}

function render(state, outPath) {
  const c = new SoftCanvas(W, H);
  renderFrame(c.getContext(), state, W, H, {});
  writeFileSync(outPath, canvasToPng(c));
}

if (source === 'engine') {
  const { loadEngineWasm, simulateStream, WASM_PATH } = await import(`${HERE}/tools/benchmark-engine.mjs`);
  const mm = await import(`${HERE}/viewer/match-metrics.js`);
  const load = await loadEngineWasm(WASM_PATH);
  if (!load.ok) { console.error(load.message); process.exit(1); }
  const { createGame } = await import(`${HERE}/viewer/game.js`);
  const game = createGame(simulateStream(load.wasm, 42, mm.ENGINE_DURATION_SEC));
  const frames = mm.sampleEngineFrames(game);

  for (const t of TARGETS) {
    // 找球位最接近目标的采样帧
    let best = null;
    for (const f of frames) {
      const d = Math.abs(f.ball[0] - t.x);
      if (!best || d < best.d) best = { d, f };
    }
    const st = { players: best.f.players.map((p) => ({ id: p.id, x: p.x, y: p.y })), ball: { x: best.f.ball[0], y: best.f.ball[1] } };
    const out = join(outDir, `${label}-${t.name}.png`);
    render(st, out);
    console.log(`${out}  t=${best.f.t.toFixed(1)}s ball.x=${best.f.ball[0].toFixed(3)}`);
  }
} else if (source === 'real') {
  // 真实：用 Metrica game1，按同样球位挑帧
  const g = JSON.parse(readFileSync(`${HERE}/viewer/data/real-game-1.json`, 'utf8'));
  const frames = g.frames.filter((f) => f.ball && Number.isFinite(f.ball[0]));
  for (const t of TARGETS) {
    let best = null;
    for (const f of frames) {
      const d = Math.abs(f.ball[0] - t.x);
      if (!best || d < best.d) best = { d, f };
    }
    const st = stateOf(best.f.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)), best.f.ball);
    const out = join(outDir, `${label}-${t.name}.png`);
    render(st, out);
    console.log(`${out}  t=${best.f.t.toFixed(1)}s ball.x=${best.f.ball[0].toFixed(3)}`);
  }
}
