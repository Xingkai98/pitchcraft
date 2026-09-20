import { loadEngineWasm, simulateStream, ENGINE_DURATION_SEC } from '../../../../../../tools/benchmark-engine.mjs';
import { createHash } from 'node:crypto';
const wasm = process.argv[2];
const load = await loadEngineWasm(wasm);
if (!load.ok) { console.error(load.message); process.exit(1); }
for (const seed of [42, 7, 99, 300, 544]) {
  const s = simulateStream(load.wasm, seed, ENGINE_DURATION_SEC);
  const txt = JSON.stringify(s);
  console.log(seed, createHash('sha256').update(txt).digest('hex').slice(0,16), txt.length);
}
