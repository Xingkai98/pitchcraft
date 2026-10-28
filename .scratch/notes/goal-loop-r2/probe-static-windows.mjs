// R2 探针：盲测包 12 个引擎窗（24s，t0 来自 windows.json）内的球静止构成。
// 口径：0.2s 采样帧（viewer 实际播放）速度<0.5m/s 的步；按重叠 tick 的事件类型归类。逐窗算再均值。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const ROOT = process.cwd();
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const { createGame } = await import(join(ROOT, 'viewer/game.js'));
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));

const packet = process.argv[2] || '.scratch/tracking-data/replay-goal-loop/base/windows.json';
const wj = JSON.parse(readFileSync(join(ROOT, packet), 'utf8'));
const wins = wj.items.filter((it) => it.source === 'engine').map((it) => ({ seed: it.seed, t0: it.t0, t1: it.t1 }));
const { wasm, ok } = await loadEngineWasm(join(ROOT, 'viewer/engine.wasm'));
if (!ok) { console.error('wasm load failed'); process.exit(2); }
const STATIC = 0.5; const STEP = 0.2; const PITCH = [105, 68];

const readEps = (process.argv[3] ? Number(process.argv[3]) : 0.005);
let aggByCat = new Map(); let aggStatic = 0; let aggSpan = 0; let aggPath = 0;
for (const w of wins) {
  const events = JSON.parse(simulateStream(wasm, w.seed, mm.ENGINE_DURATION_SEC));
  const game = createGame(events);
  const evByTick = new Map();
  for (const e of events) { const k = Math.floor(e.t); if (!evByTick.has(k)) evByTick.set(k, []); evByTick.get(k).push(e); }
  const classify = (t) => {
    const evs = evByTick.get(Math.floor(t + 1e-6)) || [];
    const beats = evs.filter((e) => e.type === 'beat');
    const stat = (v) => Math.hypot(v.x2 - v.x, v.y2 - v.y) < readEps;
    const prep = evs.some((e) => e.type === 'pass' && ['corner', 'throw_in', 'free_kick', 'goal_kick'].includes(e.detail));
    if (evs.some((e) => e.type === 'pass')) return prep ? 'pass_restart' : 'pass';
    if (evs.some((e) => e.type === 'shot')) return 'shot';
    if (evs.some((e) => e.type === 'tackle' || e.type === 'interception')) return 'tackle_deflect';
    if (evs.some((e) => e.type === 'foul')) return 'foul';
    if (evs.some((e) => e.type === 'whistle')) return 'whistle';
    if (beats.some((e) => e.main)) return beats.some((e) => e.main && !stat(e.main)) ? 'carrier_slow' : 'carrier_hold';
    if (beats.some((e) => e.ball)) return beats.some((e) => e.ball && !stat(e.ball)) ? 'loose_slow' : 'loose_static';
    if (beats.length) return 'beat_no_ball';
    return 'gap_no_event';
  };
  let prev = null; let span = 0; let statS = 0; let path = 0;
  for (let t = w.t0; t <= w.t1 + 1e-9; t += STEP) {
    game.seekTo(t);
    const b = [game.ball.x, game.ball.y];
    if (prev) {
      const dt = t - prev.t;
      const d = Math.hypot((b[0] - prev.b[0]) * PITCH[0], (b[1] - prev.b[1]) * PITCH[1]);
      span += dt; path += d;
      if (d / dt < STATIC) {
        statS += dt;
        const c = classify(prev.t);
        aggByCat.set(c, (aggByCat.get(c) || 0) + dt);
      }
    }
    prev = { t, b };
  }
  aggStatic += statS; aggSpan += span; aggPath += path;
  console.log(`seed ${w.seed} t0=${w.t0}: span ${span.toFixed(1)}s static ${statS.toFixed(1)}s (${(100 * statS / span).toFixed(1)}%) path ${path.toFixed(1)}m`);
}
console.log(`\n合计: span ${aggSpan.toFixed(1)}s static ${aggStatic.toFixed(1)}s = ${(100 * aggStatic / aggSpan).toFixed(1)}%  path ${aggPath.toFixed(1)}m (${(aggPath / aggSpan * 24).toFixed(1)} m/24s)`);
for (const [k, v] of [...aggByCat.entries()].sort((x, y) => y[1] - x[1])) {
  console.log(`   ${k.padEnd(22)} ${v.toFixed(1).padStart(6)}s  ${(100 * v / aggSpan).toFixed(1)}% of span  ${(100 * v / aggStatic).toFixed(1)}% of static`);
}
