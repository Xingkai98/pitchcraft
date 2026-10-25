// Debug: simulate one seed with a wasm and report timing/event volume.
import { loadEngineWasm, simulateStream } from '../../../tools/benchmark-engine.mjs';

const wasmPath = process.argv[2];
const seed = Number(process.argv[3] ?? 42);
const w = await loadEngineWasm(wasmPath);
if (!w.ok) { console.log(w.message); process.exit(1); }
console.error('loaded');
const t0 = Date.now();
const txt = simulateStream(w.wasm, seed, 5400);
console.error('sim done bytes=' + txt.length + ' ms=' + (Date.now() - t0));
const m = JSON.parse(txt);
const events = m.events || m;
console.error('events=' + events.length);
