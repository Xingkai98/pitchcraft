// 事件流哈希：同一 wasm、同一 seed 集 → sha256(拼接后的事件流 JSON)。
// 用途：证明 ANCHOR=0 与基线**逐位相同**（行为等价），以及各扫点之间流的差异。
// 用法: node stream-hash.mjs <wasm> [seedStart] [seedEnd] [dur]
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));

const [wasmPath, s0a, s1a, durA] = process.argv.slice(2);
const s0 = Number(s0a || 42), s1 = Number(s1a || 42), dur = Number(durA || 5400);
const { wasm, ok } = await loadEngineWasm(wasmPath);
if (!ok) { console.error('wasm 加载失败'); process.exit(1); }
const h = createHash('sha256');
for (let s = s0; s <= s1; s++) {
  const stream = simulateStream(wasm, s, dur);
  h.update(`${s}:`);
  h.update(stream);
  h.update('\n');
}
console.log(`STREAM_HASH ${h.digest('hex').slice(0, 32)}  seeds=${s0}..${s1} dur=${dur}`);
