import { join } from 'node:path';
const ROOT = process.cwd();
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const { parseEventStream } = await import(join(ROOT, 'viewer/protocol.js'));
const wasmPath = process.argv[2] || join(ROOT, 'viewer/engine.wasm');
const { wasm } = await loadEngineWasm(wasmPath);
const { events } = parseEventStream(simulateStream(wasm, 1, 5400));
const byDetail = {};
const short = [];
for (const e of events) {
  if (e.type !== 'pass') continue;
  const m = Math.hypot((e.x2 - e.x) * 105, (e.y2 - e.y) * 68);
  if (e.speed < 10 || e.speed >= 25) {
    const k = `${e.result}/${e.detail || '-'}/h${e.h ?? '-'}`;
    byDetail[k] = (byDetail[k] || 0) + 1;
    if (short.length < 8) short.push({ t: e.t, speed: e.speed, dist: m.toFixed(1), result: e.result, detail: e.detail, h: e.h });
  }
}
console.log('violating passes:', Object.values(byDetail).reduce((a, b) => a + b, 0));
console.log(byDetail);
console.log(short);
