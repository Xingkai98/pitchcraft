// 探针 K：断层是不是**模板线结构**的直接后果？
// 真实相邻间距均匀（3-5m）→ 真实 10 人纵深 ≈ 10 条 3.5m 的缝 ≈ 32m。
// 引擎模板：后卫线 4 人在 0.14-0.20（跨度 6.3m）、中场线 0.40-0.42（2.1m）、前锋 0.62（0m），
// 线内是均匀的，**线间**是 0.20/0.20 → 21m 两个洞。
// 检验：若把 10 人的**目标位置按等间距（无分线）重排**，断层是否消失、纵深落到哪？
const mean=(a)=>a.reduce((x,y)=>x+y,0)/a.length;
import { PITCH_LENGTH_M, BENCHMARK_SEEDS, ENGINE_DURATION_SEC, KEEPER_IDS, quantileSorted, sampleEngineFrames, cutWindows } from '/home/happy/.claude/worktrees/wayfinder-realism/viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '/home/happy/.claude/worktrees/wayfinder-realism/tools/benchmark-engine.mjs';
const load=await loadEngineWasm(WASM_PATH);
const { createGame }=await import('/home/happy/.claude/worktrees/wayfinder-realism/viewer/game.js');
const fr=[];
for(const seed of BENCHMARK_SEEDS.slice(0,3)){ const g=createGame(simulateStream(load.wasm,seed,ENGINE_DURATION_SEC)); for(const w of cutWindows(sampleEngineFrames(g))) fr.push(...w); }
const TPL=[0.14,0.18,0.20,0.18,0.40,0.42,0.42,0.40,0.62,0.62];
// 用引擎自己的球位驱动：以模板中位为中心平移、等间距排布
const gaps9=Array.from({length:9},()=>[]); const dep=[];
for(const f of fr){
  if(!f.ball||!Number.isFinite(f.ball[0]))continue;
  const bx=f.ball[0]; const sh=(bx-0.5)*0.06; const press=0.02;
  const center=0.38+sh+press+0.59*(bx-0.5)*0.55; // 粗略：块中心随球平移
  const span=0.32; // 目标块跨度 0.32 归一化 ≈ 33.6m
  const xs=Array.from({length:10},(_,i)=>Math.min(0.98,Math.max(0.04,center-span/2+span*i/9))).map(v=>v*105);
  for(let i=1;i<10;i++) gaps9[i-1].push(xs[i]-xs[i-1]);
  const s=[...xs].sort((a,b)=>a-b); dep.push(quantileSorted(s,0.9)-quantileSorted(s,0.1));
}
console.log('等间距块（无分线结构，跨度 0.32≈33.6m）:');
console.log('  纵深', mean(dep).toFixed(1),'m');
console.log("  相邻次序间距", gaps9.map(mean).map(v=>v.toFixed(1)).join(' / '));
console.log('  （真实 2.7/3.1/3.1/3.9/3.1/3.4/3.4/5.3/4.5，纵深 25.9；引擎现状 4.1/0.1/2.3/14.2/0.2/1.9/2.0/19.1/2.7，纵深 40.5）');
console.log('\n注：q10-q90 掐掉两端各约 1 人 → 纵深 ≈ 8 个间距 ≈ 8×3.7=29.8m（与 32.2 接近）');
