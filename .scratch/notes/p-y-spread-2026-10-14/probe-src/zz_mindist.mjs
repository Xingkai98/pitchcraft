// [y 轴探索探针] 整场**同队最小间距**（米）——复现 C5 判据镜的 2.137 m 口径。
// 用法: node zz_mindist.mjs <wasm> <seed> [step=0.5] [dur=5400]
// 按 p.id 取人（Game.players 过滤已罚下者 ⇒ 下标 ≠ id）。只读，用完即删。
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const { createGame } = await import(join(ROOT, 'viewer/game.js'));

const [wasmPath, seedArg, stepArg, durArg] = process.argv.slice(2);
const SEED = Number(seedArg || 42), STEP = Number(stepArg || 0.5), DUR = Number(durArg || 5400);
const { wasm, ok } = await loadEngineWasm(wasmPath);
if (!ok) { console.error('wasm 加载失败'); process.exit(1); }
const g = createGame(simulateStream(wasm, SEED, DUR));
let best = { d: Infinity };
const samples = [];
for (let t = 0; t <= DUR; t += STEP) {
  g.seekTo(t);
  const ps = g.players.map((p) => ({ id: p.id, x: p.x * 105, y: p.y * 68 }));
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      if ((ps[i].id <= 10) !== (ps[j].id <= 10)) continue; // 同队
      const d = Math.hypot(ps[i].x - ps[j].x, ps[i].y - ps[j].y);
      if (d < best.d) best = { d, a: ps[i].id, b: ps[j].id, t };
    }
  }
  samples.push(ps);
}
console.log(`[MINDIST] seed=${SEED} step=${STEP}s dur=${DUR}s  整场同队最小间距 = ${best.d.toFixed(4)} m  pair=(${best.a},${best.b})  t=${best.t}s`);
