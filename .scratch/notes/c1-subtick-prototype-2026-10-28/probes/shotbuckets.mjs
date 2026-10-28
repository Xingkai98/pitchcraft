import { join } from 'node:path';
const ROOT = process.cwd();
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const { parseEventStream } = await import(join(ROOT, 'viewer/protocol.js'));
const wasmPath = process.argv[2] || join(ROOT, 'viewer/engine.wasm');
const { wasm } = await loadEngineWasm(wasmPath);
for (const seed of [42, 7]) {
  const { events } = parseEventStream(simulateStream(wasm, seed, 5400));
  let box = 0, arc = 0, far = 0, total = 0, header = 0;
  for (const e of events) {
    if (e.type !== 'shot') continue;
    total += 1;
    const d = e.subject <= 10 ? (1 - e.x) * 105 : e.x * 105;
    if (d <= 16.5) box += 1; else if (d <= 25) arc += 1; else far += 1;
    if (e.detail === 'header') header += 1;
  }
  console.log(`seed ${seed}: shots=${total} box=${box} arc=${arc} far=${far} header=${header}`);
}
