// 快速指标脚本：跑 N 个 seed（默认 1）算三项采用指标，用于改引擎后的快速反馈。
// 用法：node quick-metrics.mjs [seed] [--quiet]
//
// ⚠️ P37 后 windowMetrics 返回 { primary, allPoints }（主口径跳过外推点 / 全点对照）。
// 引擎侧无外推点，两者相同，这里取 primary。
import {
  BENCHMARK_SEEDS, ENGINE_DURATION_SEC, sampleEngineFrames, cutWindows,
  windowMetrics, summarizeWindowMetrics,
} from '/home/happy/.claude/worktrees/wayfinder-realism/viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '/home/happy/.claude/worktrees/wayfinder-realism/tools/benchmark-engine.mjs';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const seeds = args.length ? args.map(Number) : [42];

const load = await loadEngineWasm(WASM_PATH);
if (!load.ok) { console.error(load.message); process.exit(1); }
const { createGame } = await import('/home/happy/.claude/worktrees/wayfinder-realism/viewer/game.js');

const all = [];
for (const seed of seeds) {
  const game = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  const frames = sampleEngineFrames(game);
  const per = cutWindows(frames).map((w) => windowMetrics(w).primary).filter(Boolean);
  all.push(...per);
}
const s = summarizeWindowMetrics(all);
const f = (k, d = 2) => (s[k] ? `${s[k].avg.toFixed(d)} [${s[k].min.toFixed(d)}–${s[k].max.toFixed(d)}]` : '—');

console.log(`seeds=[${seeds.join(',')}] 窗=${all.length}`);
console.log(`  hd  (主纵深)  ${f('hd').padEnd(22)} 目标 25.94(Metrica) / 18.31(SC)`);
console.log(`  spread(紧凑)  ${f('spread').padEnd(22)} 目标 15.24 / 12.76`);
console.log(`  gap (重心距)  ${f('gap').padEnd(22)} 目标  8.32 /  5.24`);
console.log(`  width(宽度)   ${f('width').padEnd(22)} 目标 39.58 / 35.96`);
