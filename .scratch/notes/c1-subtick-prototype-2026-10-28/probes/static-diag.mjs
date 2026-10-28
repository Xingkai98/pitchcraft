// 诊断：0.1s 采样 vs 0.2s 采样的球静止占比；并把静止段映射到当时的事件上下文
import { readFileSync } from 'node:fs';
const ROOT = process.argv[2];
const { loadEngineWasm, simulateStream } = await import(`${ROOT}/tools/benchmark-engine.mjs`);
const { createGame } = await import(`${ROOT}/viewer/game.js`);
const { parseEventStream } = await import(`${ROOT}/viewer/protocol.js`);
const seed = Number(process.argv[3] || 42);
const { wasm } = await loadEngineWasm(`${ROOT}/viewer/engine.wasm`);
const stream = simulateStream(wasm, seed, 5400);
const game = createGame(stream);
const { events } = parseEventStream(stream);
// 建事件时间索引（类型 + 飞行终点）
const evs = events.filter(e => e.type !== 'beat').map(e => {
  let end = e.t;
  if ((e.type === 'pass' || e.type === 'shot' || e.type === 'goal_kick') && e.speed && e.x2 !== undefined) {
    const m = Math.hypot((e.x2 - e.x) * 105, (e.y2 - e.y) * 68); end = e.t + m / e.speed;
  }
  return { t: e.t, end, type: e.type, result: e.result };
}).sort((a, b) => a.t - b.t);
function ctx(t) {
  let cur = null;
  for (const e of evs) { if (e.t <= t + 1e-9) cur = e; else break; }
  return cur ? `${cur.type}${cur.result ? '/' + cur.result : ''}` : 'none';
}
for (const step of [0.1, 0.2]) {
  const steps = Math.round(game.matchEnd / step);
  let prev = null, staticT = 0, span = 0;
  const staticByCtx = {};
  for (let i = 0; i <= steps; i++) {
    const t = Math.round(i * step * 1e6) / 1e6;
    game.seekTo(t);
    const b = [game.ball.x, game.ball.y];
    if (prev) {
      const dt = t - prev.t;
      const d = Math.hypot((b[0] - prev.x) * 105, (b[1] - prev.y) * 68);
      span += dt;
      if (d / dt < 0.5) { staticT += dt; const k = ctx(t); staticByCtx[k] = (staticByCtx[k] || 0) + dt; }
    }
    prev = { t, x: b[0], y: b[1] };
  }
  const top = Object.entries(staticByCtx).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([k, v]) => `${k}:${(v / span * 100).toFixed(1)}`).join('  ');
  console.log(`step=${step}s static=${(staticT / span * 100).toFixed(1)}%  topCtx: ${top}`);
}
