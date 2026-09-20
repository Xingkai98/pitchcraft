// 探针 L：补上 design-b §4.2 #4 的空缺 —— 越位锚定（B）到底把 gap 带到哪？
import { PITCH_LENGTH_M, BENCHMARK_SEEDS, ENGINE_DURATION_SEC, KEEPER_IDS, quantileSorted, sampleEngineFrames, cutWindows, teamShape } from '../../../../../viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '../../../../../tools/benchmark-engine.mjs';
const mean=(a)=>a.length?a.reduce((x,y)=>x+y,0)/a.length:NaN;
const load=await loadEngineWasm(WASM_PATH);
const { createGame }=await import('../../../../../viewer/game.js');
const fr=[];
for(const seed of BENCHMARK_SEEDS.slice(0,3)){const g=createGame(simulateStream(load.wasm,seed,ENGINE_DURATION_SEC));for(const w of cutWindows(sampleEngineFrames(g)))fr.push(...w);}
const TPL=[0.14,0.18,0.20,0.18,0.40,0.42,0.42,0.40,0.62,0.62];
function mk(ids,offsideOn){
  const cens=[];
  for(const f of fr){
    if(!f.ball||!Number.isFinite(f.ball[0]))continue;
    const T={};
    for(const team of ['home','away']){
      const isHome=team==='home'; const ps=[];
      for(let id=0;id<22;id++){if(KEEPER_IDS.includes(id))continue;if((id<=10)!==isHome)continue;const p=f.players[id];if(!p)continue;const x=Array.isArray(p)?p[0]:p.x;if(!Number.isFinite(x))continue;ps.push({id,u:(isHome?x:1-x)*105});}
      if(ps.length>=7){ps.sort((a,b)=>a.u-b.u);T[team]={ps,u:ps.map(q=>q.u),ballU:(isHome?f.ball[0]:1-f.ball[0])*105};}
    }
    if(!T.home||!T.away)continue;
    for(const [me,opp] of [['home','away'],['away','home']]){
      const bx=T[me].ballU/105;
      const center=0.115+0.59*bx;
      let xs=TPL.map(v=>center+(v-0.38)*0.55);
      if(offsideOn){
        const oppLineFromOppGoals=105-opp.u[1];
        const oppLineFromMyGoal=105-oppLineFromOppGoals;
        const cap=Math.max(0.04,(oppLineFromMyGoal-1.0)/105);
        xs[8]=Math.min(xs[8],cap);xs[9]=Math.min(xs[9],cap);
        for(let i=7;i>=0;i--)xs[i]=Math.min(xs[i],xs[i+1]);
      }
      const xsM=xs.map(v=>v*105);
      cens.push({cx:mean(xsM)});
    }
  }
  // gap: 重建每帧两队的 cx 差 —— 用同一帧配对
  return cens;
}
// 简化：直接在帧循环里配对算 gap
function gapOf(offsideOn){
  const gaps=[],depths=[];
  for(const f of fr){
    if(!f.ball||!Number.isFinite(f.ball[0]))continue;
    const got={};
    for(const team of ['home','away']){
      const isHome=team==='home';const ps=[];
      for(let id=0;id<22;id++){if(KEEPER_IDS.includes(id))continue;if((id<=10)!==isHome)continue;const p=f.players[id];if(!p)continue;const x=Array.isArray(p)?p[0]:p.x;if(!Number.isFinite(x))continue;ps.push({u:(isHome?x:1-x)*105});}
      if(ps.length<7)continue;ps.sort((a,b)=>a.u-b.u);
      const bx=(isHome?f.ball[0]:1-f.ball[0]);
      let xs=TPL.map(v=>0.115+0.59*bx+(v-0.38)*0.55);
      if(offsideOn){
        const oU=[];const oisHome=!isHome;
        for(let id=0;id<22;id++){if(KEEPER_IDS.includes(id))continue;if((id<=10)!==oisHome)continue;const p=f.players[id];if(!p)continue;const x=Array.isArray(p)?p[0]:p.x;if(!Number.isFinite(x))continue;oU.push((oisHome?x:1-x)*105);}
        if(oU.length>=7){oU.sort((a,b)=>a-b);const cap=Math.max(0.04,(oU[1]-1.0)/105);xs[8]=Math.min(xs[8],cap);xs[9]=Math.min(xs[9],cap);for(let i=7;i>=0;i--)xs[i]=Math.min(xs[i],xs[i+1]);}
      }
      const m=xs.map(v=>v*105);
      // 转回绝对 x 以便算两队真实间距
      got[team]=isHome?mean(m):105-mean(m);
      got[team+'d']=quantileSorted([...m].sort((a,b)=>a-b),0.9)-quantileSorted([...m].sort((a,b)=>a-b),0.1);
    }
    if(got.home==null||got.away==null)continue;
    gaps.push(Math.abs(got.home-got.away));depths.push((got.homed+got.awayd)/2);
  }
  return {gap:mean(gaps),depth:mean(depths),n:gaps.length};
}
const off=gapOf(false), on=gapOf(true);
console.log('块模型 无越位锚定: gap', off.gap.toFixed(1),'m  纵深',off.depth.toFixed(1),'m  n=',off.n);
console.log('块模型 + 越位锚定: gap', on.gap.toFixed(1),'m  纵深',on.depth.toFixed(1),'m  n=',on.n);
console.log('真实 Metrica:      gap 7.4m   纵深 25.9m');
