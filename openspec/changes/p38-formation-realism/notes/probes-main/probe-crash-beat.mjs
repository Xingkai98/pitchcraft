// P38 线 A：定位 `beat mover id duplicate` 的**产生路径**（不靠读代码，靠事件流实跑）。
//
// 背景：`engine/src/lib.rs` 的 `beat_movers(...)` 之后，tackle 路径（约 3460 行）
// 又往同一个 `movers` 里 `push` 了一批「被推开的队友」。两处都可能为**同一个 id**
// 产 mover → 违反 `viewer/protocol.js` 的 `validateBeat` 唯一性契约 → `createGame` 抛错。
//
// 本探针**吞掉** `createGame` 的校验异常，直接在**原始 JSON 事件流**上找那条坏 beat，
// 打印同 id 两条 mover 的 action/from/to —— action 字段直接指认是哪个 push 点产出的。
//
// 用法：node probe-crash-beat.mjs <种子> <时长秒>
// 输出：坏 beat 的 t、重复 id、两条 mover 明细；以及该帧前后的事件类型。

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from '../probes/repo-root.mjs';

// 上溯找仓库根，别数 `../..` 层数（数错过一次，报 ERR_MODULE_NOT_FOUND，像"文件不存在"）
const P = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const { loadEngineWasm, simulateStream } = await import(`${P}/tools/benchmark-engine.mjs`);

const seed = Number(process.argv[2] || 123);
const dur = Number(process.argv[3] || 5400);

const load = await loadEngineWasm(`${P}/viewer/engine.wasm`);
if (!load.ok) { console.error(load.message); process.exit(1); }
const json = JSON.parse(simulateStream(load.wasm, seed, dur));
const events = json.events || json;

console.log(`seed=${seed} 事件总数 ${events.length}`);

let found = 0;
for (let i = 0; i < events.length; i += 1) {
  const e = events[i];
  if (e.type !== 'beat' || !Array.isArray(e.movers)) continue;
  const seen = new Map();
  for (const m of e.movers) {
    if (seen.has(m.id)) {
      found += 1;
      console.log(`\n=== 坏 beat #${i} @ t=${e.t}  重复 id=${m.id} ===`);
      console.log('  第一条:', JSON.stringify(seen.get(m.id)));
      console.log('  第二条:', JSON.stringify(m));
      console.log('  该 beat 全部 movers:');
      for (const x of e.movers) console.log('   ', JSON.stringify(x));
      // 前后事件（看是哪种重开/结算上下文）
      console.log('  前 3 条事件:');
      for (let k = Math.max(0, i - 3); k < i; k += 1) {
        const q = events[k];
        console.log(`    [${k}] t=${q.t} type=${q.type}${q.action ? ` action=${q.action}` : ''}${q.detail ? ` detail=${q.detail}` : ''}${q.subject != null ? ` subject=${q.subject}` : ''}`);
      }
      // 场上人数（看是否少人）
      if (e.movers.length) {
        console.log(`  该 beat movers 数=${e.movers.length}`);
      }
      if (found >= 3) { process.exit(0); }
    }
    seen.set(m.id, m);
  }
}
console.log(found ? '' : '未发现坏 beat（该种子在原始事件流上干净）');
