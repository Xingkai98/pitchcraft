import { BENCHMARK_SEEDS, ENGINE_DURATION_SEC, KEEPER_IDS, quantileSorted, sampleEngineFrames, cutWindows, teamShape } from '../../../../../viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH, sampleEngineStats } from '../../../../../tools/benchmark-engine.mjs';
const mean=(a)=>a.reduce((x,y)=>x+y,0)/a.length;
const q=quantileSorted;
const load=await loadEngineWasm(WASM_PATH);
const { createGame }=await import('../../../../../viewer/game.js');
const fr=[];
for(const seed of BENCHMARK_SEEDS.slice(0,3)){
  const g=createGame(simulateStream(load.wasm,seed,ENGINE_DURATION_SEC));
  for(const w of cutWindows(sampleEngineFrames(g))) fr.push(...w);
}
// method 1: raw quantile of sorted u
const a=[];
for(const f of fr) for(const team of ['home','away']){
  const isHome=team==='home'; const us=[];
  for(let id=0;id<22;id++){ if(KEEPER_IDS.includes(id))continue; if((id<=10)!==isHome)continue; const p=f.players[id]; if(!p)continue; us.push((isHome?p.x:1-p.x)*105); }
  if(us.length>=7){const s=us.sort((x,y)=>x-y); a.push(q(s,0.9)-q(s,0.1));}
}
// method 2: teamShape
const b=[];
for(const f of fr) for(const team of ['home','away']){ const sh=teamShape(f,team); if(sh) b.push(sh.depth); }
console.log('method1 raw u-quantile depth mean =', mean(a).toFixed(2), 'n=',a.length);
console.log('method2 teamShape.depth  mean =', mean(b).toFixed(2), 'n=',b.length);
const s=await sampleEngineStats({wasm:load.wasm});
console.log('canonical hd =', s.perMetric.hd.avg.toFixed(2), 'spread=',s.perMetric.spread.avg.toFixed(2),'gap=',s.perMetric.gap.avg.toFixed(2),'width=',s.perMetric.width.avg.toFixed(2));
