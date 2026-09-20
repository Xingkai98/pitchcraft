// 用**canonical 代码路径**（sampleEngineStats）算引擎指标，与入库基线对照
import { loadEngineWasm, sampleEngineStats, WASM_PATH } from '../../../../../tools/benchmark-engine.mjs';
const load = await loadEngineWasm(WASM_PATH);
const s = await sampleEngineStats({ wasm: load.wasm });
const p = s.perMetric;
console.log('canonical sampleEngineStats（当前 wasm）:');
for (const k of ['hd','ad','spread','gap','width']) console.log(`  ${k.padEnd(7)} avg=${p[k].avg.toFixed(2)}  n=${p[k].n}`);
console.log('  elasticity half avgDelta=', s.elasticity.half?.avgDelta?.toFixed(2));
console.log('\n入库基线 engine:');
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('../../../../..', import.meta.url));
const b = JSON.parse(readFileSync(`${HERE}/viewer/data/benchmark-baseline.json`,'utf8'));
for (const k of ['hd','ad','spread','gap','width']) console.log(`  ${k.padEnd(7)} avg=${b.engine.perMetric[k].avg.toFixed(2)}`);
console.log('  elasticity half avgDelta=', b.engine.elasticity.half.avgDelta.toFixed(2));
