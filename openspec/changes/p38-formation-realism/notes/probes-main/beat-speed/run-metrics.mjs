// 用指定 wasm 跑 quick-metrics 口径
import {
  BENCHMARK_SEEDS, ENGINE_DURATION_SEC, sampleEngineFrames, cutWindows,
  windowMetrics, summarizeWindowMetrics,
} from '../../../../../../viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '../../../../../../tools/benchmark-engine.mjs';
const wasmPath = process.argv[2] || WASM_PATH;
const seeds = process.argv.slice(3).map(Number);
const load = await loadEngineWasm(wasmPath);
if (!load.ok) { console.error(load.message); process.exit(1); }
const { createGame } = await import('../../../../../../viewer/game.js');
const all = [];
for (const seed of (seeds.length?seeds:BENCHMARK_SEEDS)) {
  const game = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  for (const w of cutWindows(sampleEngineFrames(game))) {
    const m = windowMetrics(w).primary; if (m) all.push(m);
  }
}
const s = summarizeWindowMetrics(all);
const f = (k,d=2)=> s[k] ? `${s[k].avg.toFixed(d)} [${s[k].min.toFixed(d)}-${s[k].max.toFixed(d)}]` : '—';
console.log(`wasm=${wasmPath.split('/').slice(-1)[0]} 个种子=${(seeds.length?seeds:BENCHMARK_SEEDS).join(',')} 窗=${all.length}`);
console.log(`  hd     ${f('hd').padEnd(22)} 目标 25.94`);
console.log(`  spread ${f('spread').padEnd(22)} 目标 15.24`);
console.log(`  gap    ${f('gap').padEnd(22)} 目标  8.32`);
console.log(`  width  ${f('width').padEnd(22)} 目标 39.58`);
