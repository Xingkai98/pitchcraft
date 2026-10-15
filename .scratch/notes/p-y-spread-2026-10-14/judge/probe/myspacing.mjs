// 判据镜独立最小间距探针。用法: node myspacing.mjs <wasm> <seed> [step] [dur]
// 按 p.id 取人（Game.players 过滤罚下者 ⇒ 下标≠id）。报：整场同队最小间距 + 最小的若干对（看是否「坪」）。
const { loadEngineWasm, simulateStream } = await import(new URL('../../../../tools/benchmark-engine.mjs', import.meta.url));
const { createGame } = await import(new URL('../../../../viewer/game.js', import.meta.url));
const [wasmPath, seedArg, stepArg, durArg] = process.argv.slice(2);
const SEED = Number(seedArg || 42), STEP = Number(stepArg || 0.25), DUR = Number(durArg || 5400);
const { wasm, ok } = await loadEngineWasm(wasmPath);
if (!ok) { console.error('wasm 加载失败'); process.exit(1); }
const g = createGame(simulateStream(wasm, SEED, DUR));
const pairMin = new Map(); // "a,b" -> {d,t}
let globalMin = { d: Infinity };
for (let t = 0; t <= DUR + 1e-9; t += STEP) {
  g.seekTo(Math.min(t, DUR));
  const ps = g.players.map(p => ({ id: p.id, x: p.x * 105, y: p.y * 68 }));
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    if ((ps[i].id <= 10) !== (ps[j].id <= 10)) continue;
    const d = Math.hypot(ps[i].x - ps[j].x, ps[i].y - ps[j].y);
    const k = `${ps[i].id},${ps[j].id}`;
    const cur = pairMin.get(k);
    if (!cur || d < cur.d) pairMin.set(k, { d, t });
    if (d < globalMin.d) globalMin = { d, a: ps[i].id, b: ps[j].id, t };
  }
}
const rows = [...pairMin.entries()].map(([k, v]) => ({ k, ...v })).sort((a, b) => a.d - b.d);
console.log(`[MYSP] ${wasmPath.split('/').pop()} seed=${SEED} step=${STEP}s 整场同队最小间距=${globalMin.d.toFixed(4)}m pair=(${globalMin.a},${globalMin.b}) t=${globalMin.t.toFixed(1)}s`);
console.log(`[MYSP]   <2.2m 的 pair 数=${rows.filter(r => r.d < 2.2).length}  <2.5m=${rows.filter(r => r.d < 2.5).length}`);
console.log(`[MYSP]   最小的 8 对: ` + rows.slice(0, 8).map(r => `${r.k}=${r.d.toFixed(4)}@${r.t.toFixed(1)}s`).join('  '));
