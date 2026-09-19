import { loadEngineWasm, simulateStream, WASM_PATH } from '/home/happy/.claude/worktrees/wayfinder-realism/tools/benchmark-engine.mjs';
const load = await loadEngineWasm(WASM_PATH);
const evs = JSON.parse(simulateStream(load.wasm, 42, 300));
const acts = new Set();
let sample = null;
for (const e of evs) if (e.type === 'beat' && e.movers) for (const m of e.movers) { acts.add(m.action); if (m.action === 'screen' && !sample) sample = m; }
console.log('actions:', [...acts].sort().join(', '));
console.log('sample screen mover:', JSON.stringify(sample));
console.log('event count:', evs.length);
