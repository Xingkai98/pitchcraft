// [探针·用完即删] 查 spacing 破点时刻的 ball.x（核「防线被 clamp 到 ball.x」机制）
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { loadEngineWasm } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const { simulateEvents } = await import(join(ROOT, 'tools/spacing-sweep-core.mjs'));
const { Game, buildGameIndex } = await import(join(ROOT, 'viewer/game.js'));
const { wasm } = await loadEngineWasm(process.argv[2]);
const seed = Number(process.argv[3] || 42);
const { events, lineup } = simulateEvents({ wasm, seed, dur: 5400 });
const idx = buildGameIndex(events, lineup, 'continuous');
const g = new Game(events, lineup, 'continuous', { index: idx });
for (const t of [4046, 4048, 4049.5, 4051, 4053]) {
  g.seekTo(t);
  const P = g.players;
  const d24 = Math.hypot((P[2].x - P[4].x) * 105, (P[2].y - P[4].y) * 68);
  console.log(`t=${t}s ball=(${g.ball.x.toFixed(4)}, ${g.ball.y.toFixed(4)}) id2=(${P[2].x.toFixed(4)},${P[2].y.toFixed(4)}) id4=(${P[4].x.toFixed(4)},${P[4].y.toFixed(4)}) d(2,4)=${d24.toFixed(3)}m`);
}
