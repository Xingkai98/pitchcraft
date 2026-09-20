// 诊断：球为什么不去边路 —— 查球员 y 分布与球的 y 分布
import { BENCHMARK_SEEDS, ENGINE_DURATION_SEC, sampleEngineFrames } from '../../../../../viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '../../../../../tools/benchmark-engine.mjs';

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };

const load = await loadEngineWasm(WASM_PATH);
const { createGame } = await import('../../../../../viewer/game.js');

for (const seed of [42, 1]) {
  const game = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  const frames = sampleEngineFrames(game);

  const allY = [];
  const bySlot = {};
  for (const f of frames) {
    for (const p of f.players) {
      if (p.id === 0 || p.id === 21) continue;
      const y = p.y * 68;
      allY.push(y);
      (bySlot[p.id] = bySlot[p.id] || []).push(y);
    }
  }
  const bally = frames.map((f) => f.ball[1] * 68);

  console.log(`\n=== seed ${seed} ===`);
  let lo = Infinity; let hi = -Infinity;
  for (const y of allY) { if (y < lo) lo = y; if (y > hi) hi = y; }
  console.log(`球员 y: 全距 ${(hi - lo).toFixed(1)}m  sd=${sd(allY).toFixed(1)}m`);
  for (const id of [1, 5, 9, 11, 15, 19]) {
    if (bySlot[id]) console.log(`  id${String(id).padStart(2)}: y均值=${mean(bySlot[id]).toFixed(1)}  sd=${sd(bySlot[id]).toFixed(1)}`);
  }
  const wide = allY.filter((y) => Math.abs(y - 34) > 20).length / allY.length;
  console.log(`球员在边路(|y-34|>20m)比例: ${(100 * wide).toFixed(1)}%`);
  console.log(`球 y: sd=${sd(bally).toFixed(1)}m  范围 ${(Math.max(...bally) - Math.min(...bally)).toFixed(1)}m`);
  const bwide = bally.filter((y) => Math.abs(y - 34) > 20).length / bally.length;
  console.log(`球在边路比例: ${(100 * bwide).toFixed(1)}%`);
}
console.log('\n真实参照：球员 y sd 12.5-12.9m；球 y sd 19-21m；球五通道各约 20%');
