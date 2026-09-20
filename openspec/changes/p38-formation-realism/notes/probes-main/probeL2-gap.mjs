// 探针 L2：修正方向 —— 越位线必须在**绝对球场坐标**里比较。
// home 攻向 x=1：cap（home 的前锋不得越过的 x） = away 第 2 深的**绝对 x**
// away 攻向 x=0：cap（away 的前锋不得越过的 x） = home 第 2 深的**绝对 x**
// 我上一版把「离本方门线」坐标混进了绝对坐标，导致 cap 反向、全队塌成一条线。
import { PITCH_LENGTH_M, BENCHMARK_SEEDS, ENGINE_DURATION_SEC, KEEPER_IDS, quantileSorted, sampleEngineFrames, cutWindows } from '../../../../../viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '../../../../../tools/benchmark-engine.mjs';
const mean=(a)=>a.length?a.reduce((x,y)=>x+y,0)/a.length:NaN;
const load=await loadEngineWasm(WASM_PATH);
const { createGame }=await import('../../../../../viewer/game.js');
const fr=[];
for(const seed of BENCHMARK_SEEDS.slice(0,3)){const g=createGame(simulateStream(load.wasm,seed,ENGINE_DURATION_SEC));for(const w of cutWindows(sampleEngineFrames(g)))fr.push(...w);}
const TPL=[0.14,0.18,0.20,0.18,0.40,0.42,0.42,0.40,0.62,0.62];

function absPlayers(f, team){
  const isHome=team==='home'; const ps=[];
  for(let id=0;id<22;id++){ if(KEEPER_IDS.includes(id))continue; if((id<=10)!==isHome)continue;
    const p=f.players[id]; if(!p)continue; const x=Array.isArray(p)?p[0]:p.x; if(!Number.isFinite(x))continue;
    ps.push({id, x}); }
  return ps.length>=7?ps:null;
}
// 目标 = 绝对 x 数组（10 个，按模板档位，home 序）
function targets(f, team, offsideOn){
  const isHome=team==='home';
  const ps=absPlayers(f,team); if(!ps)return null;
  const ballAbs=f.ball[0];
  const ballU=isHome?ballAbs:1-ballAbs;       // 球离本方门线
  const center=0.115+0.59*ballU;               // 块中心（离本方门线，归一化）
  let rel=TPL.map(v=>center+(v-0.38)*0.55);     // 离本方门线的相对档位（升序）
  if(offsideOn){
    const opp=absPlayers(f,isHome?'away':'home');
    if(opp){
      const oppSorted=[...opp].sort((a,b)=> isHome ? (b.x-a.x) : (a.x-b.x)); // 离对方门线近→远
      const lineAbs=oppSorted[1].x;              // 对方第 2 深者的**绝对 x**
      // home: 前锋不得超过 lineAbs；away: 不得低于 lineAbs
      if(isHome){ rel[8]=Math.min(rel[8],lineAbs); rel[9]=Math.min(rel[9],lineAbs); }
      else      { rel[8]=Math.max(rel[8],lineAbs); rel[9]=Math.max(rel[9],lineAbs); }
      // 保序
      if(isHome){ for(let i=7;i>=0;i--) rel[i]=Math.min(rel[i],rel[i+1]); }
      else      { for(let i=7;i>=0;i--) rel[i]=Math.max(rel[i],rel[i+1]); }
    }
  }
  // rel 是「离本方门线」的归一化 → 转绝对 x
  return rel.map(v=> (isHome ? v : 1-v) * PITCH_LENGTH_M);
}
function stats(offsideOn){
  const gaps=[],depths=[],spansArr=[];
  const byBall=new Map();
  for(const f of fr){
    if(!f.ball||!Number.isFinite(f.ball[0]))continue;
    const th=targets(f,'home',offsideOn), ta=targets(f,'away',offsideOn);
    if(!th||!ta)continue;
    const cx=(a)=>mean(a);
    gaps.push(Math.abs(cx(th)-cx(ta)));
    // 纵深（q10-q90，绝对 x）
    const d=(a)=>{const s=[...a].sort((x,y)=>x-y);return quantileSorted(s,0.9)-quantileSorted(s,0.1);};
    depths.push((d(th)+d(ta))/2);
    spansArr.push((Math.max(...th)-Math.min(...th)+Math.max(...ta)-Math.min(...ta))/2);
    const k=Math.min(4,Math.floor(f.ball[0]*5));
    if(!byBall.has(k))byBall.set(k,[]); byBall.get(k).push((d(th)+d(ta))/2);
  }
  const b=[...byBall.entries()].sort((x,y)=>x[0]-y[0]).map(([,v])=>mean(v));
  return {gap:mean(gaps),depths:mean(depths),span:mean(spansArr),el:Math.max(...b)-Math.min(...b),n:gaps.length};
}
const a=stats(false), b=stats(true);
console.log('                       gap     纵深    块跨度   弹性');
console.log(`块模型（无越位锚定）   ${a.gap.toFixed(1).padStart(6)} ${a.depths.toFixed(1).padStart(8)} ${a.span.toFixed(1).padStart(8)} ${a.el.toFixed(1).padStart(6)}  n=${a.n}`);
console.log(`块模型 + 越位锚定      ${b.gap.toFixed(1).padStart(6)} ${b.depths.toFixed(1).padStart(8)} ${b.span.toFixed(1).padStart(8)} ${b.el.toFixed(1).padStart(6)}`);
console.log(`真实 Metrica           ${'7.4'.padStart(6)} ${'25.9'.padStart(8)} ${'32.5'.padStart(8)} ${'10.3'.padStart(6)}`);
