// Debug: gap distribution between consecutive action events.
import { loadEngineWasm, simulateStream } from '../../../tools/benchmark-engine.mjs';
const w = await loadEngineWasm(process.argv[2]);
const events = JSON.parse(simulateStream(w.wasm, 401, 5400));
const acts = events.filter((e) => ['pass', 'shot', 'tackle', 'foul', 'whistle', 'interception'].includes(e.type));
console.log('acts', acts.length, 'first t', acts.slice(0, 5).map((e) => e.t).join(','));
const gaps = [];
for (let i = 1; i < acts.length; i += 1) gaps.push(+(acts[i].t - acts[i - 1].t).toFixed(2));
gaps.sort((a, b) => a - b);
const q = (p) => gaps[Math.floor(p * (gaps.length - 1))];
console.log('gap p10/50/90/max', q(0.1), q(0.5), q(0.9), gaps[gaps.length - 1]);
console.log('share gap>=4', (gaps.filter((g) => g >= 4).length / gaps.length).toFixed(3));
console.log('sample first 20 gaps', gaps.slice(0, 20).join(','));
