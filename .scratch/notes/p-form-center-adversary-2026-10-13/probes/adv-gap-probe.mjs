// 对抗镜自写逐帧探针：直接调 viewer/game.js + match-metrics.teamShape（与 like-football 同口径）。
// 只读，不写任何仓内文件。
import { readFileSync } from 'node:fs';
const ROOT='/home/happy/.paseo/worktrees/1g1x3st4/table-c2-center-adversary-2026-10-13';
const { loadEngineWasm, simulateStream } = await import(ROOT+'/tools/benchmark-engine.mjs');
const mm = await import(ROOT+'/viewer/match-metrics.js');
const { createGame } = await import(ROOT+'/viewer/game.js');
const [wasmPath, seed, t0, span, step] = [process.argv[2], +process.argv[3], +process.argv[4], +process.argv[5], +(process.argv[6]||0.2)];
const { wasm } = await loadEngineWasm(wasmPath);
const game = createGame(simulateStream(wasm, seed, 5400));
const mean = a => a.reduce((u,v)=>u+v,0)/a.length;
const dxs=[], dys=[], gaps=[], cxs=[];
for (let t=t0; t<=t0+span; t+=step) {
  game.seekTo(t);
  const f = { players: game.players.map(p=>({id:p.id,x:p.x,y:p.y})), ball:[game.ball.x,game.ball.y] };
  const h = mm.teamShape(f,'home'), a = mm.teamShape(f,'away');
  if (!h||!a) continue;
  dxs.push(a.cx-h.cx); dys.push(a.cy-h.cy); gaps.push(Math.hypot(a.cx-h.cx,a.cy-h.cy));
  cxs.push((h.cx+a.cx)/2);
}
console.log(JSON.stringify({seed,t0,span,n:dxs.length,
  dx:mean(dxs), dy:mean(dys), gap:mean(gaps), midx:mean(cxs),
  dxsd:Math.sqrt(mean(dxs.map(v=>(v-mean(dxs))**2)))}));
