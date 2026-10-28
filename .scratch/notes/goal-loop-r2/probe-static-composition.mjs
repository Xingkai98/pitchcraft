// R2 探针：球静止时间的事件级构成（seed 42 默认；可传 seeds）
// 口径：0.2s 采样帧（= viewer 实际播放的球位，createGame + sampleEngineFrames）找速度<0.5m/s 的区间，
// 用同时段时间窗内的事件类型归类。逐 seed 聚合（不跨场拼接）。只报告，不判 pass/fail。
import { join } from 'node:path';
const ROOT = process.cwd();
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const { createGame } = await import(join(ROOT, 'viewer/game.js'));
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));

const seedsArg = process.argv[2];
const seeds = seedsArg ? seedsArg.split(',').map(Number) : [42];
const { wasm, ok } = await loadEngineWasm(join(ROOT, 'viewer/engine.wasm'));
if (!ok) { console.error('wasm load failed'); process.exit(2); }

const STATIC = 0.5; const STEP = 0.2; const PITCH = [105, 68];
for (const seed of seeds) {
  const text = simulateStream(wasm, seed, mm.ENGINE_DURATION_SEC);
  const events = JSON.parse(text);
  const game = createGame(events);
  // 0.2s 采样球位
  const rows = [];
  const tEnd = game.matchEnd;
  for (let t = 0; t <= tEnd; t += STEP) {
    game.seekTo(t);
    rows.push({ t, ball: game.ball ? [game.ball.x, game.ball.y] : null });
  }
  // 事件时间索引（每个 tick 区间内的事件类型）
  const evByTick = new Map();
  for (const e of events) {
    const k = Math.floor(e.t);
    if (!evByTick.has(k)) evByTick.set(k, []);
    evByTick.get(k).push(e);
  }
  const classifyStep = (t0, t1, d) => {
    const k0 = Math.floor(t0 + 1e-6); const k1 = Math.floor(t1 - 1e-6);
    const evs = [];
    for (let k = k0; k <= k1; k += 1) if (evByTick.has(k)) evs.push(...evByTick.get(k));
    const types = evs.map((e) => e.type + (e.detail ? `:${e.detail}` : ''));
    const beats = evs.filter((e) => e.type === 'beat');
    const mainStatic = beats.some((e) => e.main && Math.hypot(e.main.x2 - e.main.x, e.main.y2 - e.main.y) < 0.005);
    const mainMoving = beats.some((e) => e.main && Math.hypot(e.main.x2 - e.main.x, e.main.y2 - e.main.y) >= 0.005);
    const looseStatic = beats.some((e) => e.ball && Math.hypot(e.ball.x2 - e.ball.x, e.ball.y2 - e.ball.y) < 0.005);
    const looseMoving = beats.some((e) => e.ball && Math.hypot(e.ball.x2 - e.ball.x, e.ball.y2 - e.ball.y) >= 0.005);
    const hasPass = evs.some((e) => e.type === 'pass');
    const hasShot = evs.some((e) => e.type === 'shot');
    const hasTackle = evs.some((e) => e.type === 'tackle' || e.type === 'interception');
    const hasFoul = evs.some((e) => e.type === 'foul');
    const hasWhistle = evs.some((e) => e.type === 'whistle');
    const prep = evs.some((e) => e.type === 'pass' && ['corner', 'throw_in', 'free_kick', 'goal_kick'].includes(e.detail));
    if (hasPass) return prep ? 'pass_restart' : 'pass';
    if (hasShot) return 'shot';
    if (hasTackle) return 'tackle_deflect';
    if (hasFoul) return 'foul';
    if (hasWhistle) return 'whistle';
    if (mainStatic) return 'carrier_hold';
    if (mainMoving) return 'carrier_move_but_ball_static?';
    if (looseStatic) return 'loose_static';
    if (looseMoving) return 'loose_roll_slow';
    if (beats.length) return 'beat_no_ball';
    return 'gap_no_event';
  };
  const byCat = new Map(); let totalSpan = 0; let staticSpan = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const a = rows[i - 1]; const b = rows[i];
    if (!a.ball || !b.ball) continue;
    const dt = b.t - a.t; if (dt <= 1e-9) continue;
    const d = Math.hypot((b.ball[0] - a.ball[0]) * PITCH[0], (b.ball[1] - a.ball[1]) * PITCH[1]);
    const v = d / dt;
    totalSpan += dt;
    if (v < STATIC) {
      staticSpan += dt;
      const cat = classifyStep(a.t, b.t, d);
      byCat.set(cat, (byCat.get(cat) || 0) + dt);
    }
  }
  console.log(`seed ${seed}: span ${totalSpan.toFixed(1)}s static ${staticSpan.toFixed(1)}s = ${(100 * staticSpan / totalSpan).toFixed(1)}%`);
  for (const [k, v] of [...byCat.entries()].sort((x, y) => y[1] - x[1])) {
    console.log(`   ${k.padEnd(28)} ${v.toFixed(1).padStart(7)}s  ${(100 * v / totalSpan).toFixed(1)}% of span  ${(100 * v / staticSpan).toFixed(1)}% of static`);
  }
}
