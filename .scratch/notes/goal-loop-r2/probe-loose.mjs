// R2 探针：松散球等待分布（事件级）。统计：每次 loose 的持续 tick 数、球已静止 tick 数、
// 起球时最近追球者距离、追球速度。逐 seed 聚合（不跨场拼接）。
import { join } from 'node:path';
const ROOT = process.cwd();
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
const seeds = (process.argv[2] || '42').split(',').map(Number);
const { wasm, ok } = await loadEngineWasm(join(ROOT, 'viewer/engine.wasm'));
if (!ok) process.exit(2);
const PC = [105, 68];
for (const seed of seeds) {
  const events = JSON.parse(simulateStream(wasm, seed, mm.ENGINE_DURATION_SEC));
  const spells = [];
  let cur = null;
  for (const e of events) {
    if (e.type !== 'beat') { if (cur && !(e.type === 'beat')) { /* 高亮/交接收割由下一 beat 反映 */ } continue; }
    const b = e.ball;
    if (b && b.loose) {
      const chase = (e.movers || []).find((m) => m.action === 'chase');
      const moveM = Math.hypot((b.x2 - b.x) * PC[0], (b.y2 - b.y) * PC[1]);
      if (!cur) cur = { t0: e.t, ticks: 0, stillTicks: 0, startDist: null, speed: 0, chaseSpeed: null };
      cur.ticks += 1;
      if (moveM < 0.01) cur.stillTicks += 1;
      if (cur.startDist == null && chase) cur.startDist = Math.hypot((chase.from_x - b.x) * PC[0], (chase.from_y - b.y) * PC[1]);
      if (chase) cur.chaseSpeed = chase.speed;
    } else if (cur) { spells.push(cur); cur = null; }
  }
  if (cur) spells.push(cur);
  const n = spells.length;
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] : 0);
  const ticks = spells.map((s) => s.ticks);
  const still = spells.map((s) => s.stillTicks);
  const dists = spells.map((s) => s.startDist).filter((v) => v != null);
  console.log(`seed ${seed}: loose spells ${n}, mean ticks ${mean(ticks).toFixed(2)} (q90 ${pct(ticks, 0.9)}), mean still-ticks ${mean(still).toFixed(2)} (q90 ${pct(still, 0.9)}), total still ${still.reduce((a, b) => a + b, 0)}s`);
  console.log(`  start chaser dist: mean ${mean(dists).toFixed(1)}m q50 ${pct(dists, 0.5).toFixed(1)} q90 ${pct(dists, 0.9).toFixed(1)} (>8m ${(100 * dists.filter((d) => d > 8).length / dists.length).toFixed(0)}%), chase speed mode ${spells.find((s) => s.chaseSpeed)?.chaseSpeed}`);
}
