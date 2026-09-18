// 最终口径（trim1 = 掐头去尾各1人取中间8人跨度）× 最终采样（引擎 5400s 切 5min 窗口）
// 一次性生成所有文档要引用的数字。
import { readFileSync, writeFileSync } from 'node:fs';
import { createGame } from './game.js';
const L=105,W=68, isKeeper=id=>id===0||id===21;
const avg=a=>a.reduce((x,y)=>x+y,0)/a.length;
const rng=a=>`${Math.min(...a).toFixed(1)}–${Math.max(...a).toFixed(1)}`;
const pct=(s,p)=>{const i=p*(s.length-1),lo=Math.floor(i),hi=Math.ceil(i);return s[lo]+(s[hi]-s[lo])*(i-lo);};

// trim1：掐头去尾各 1，取剩余 8 人跨度（两侧对称、无分位约定歧义）
const span = s => s.length<9 ? null : s[s.length-2]-s[1];

function metrics(f){
  const home=f.players.filter(p=>p&&!isKeeper(p.id)&&p.id<=10);
  const away=f.players.filter(p=>p&&!isKeeper(p.id)&&p.id>=11);
  const sh=(ps)=>{ if(ps.length<7)return null;
    const xs=ps.map(p=>p.x*L).sort((a,b)=>a-b), ys=ps.map(p=>p.y*W);
    const cx=xs.reduce((a,b)=>a+b,0)/xs.length, cy=ys.reduce((a,b)=>a+b,0)/ys.length;
    return { depth:span(xs), cx, cy,
             spread: xs.map((x,i)=>Math.hypot(x-cx,ys[i]-cy)).reduce((a,b)=>a+b,0)/xs.length }; };
  const h=sh(home), a=sh(away);
  return h&&a ? { hd:h.depth, ad:a.depth, spread:h.spread, gap:Math.hypot(h.cx-a.cx,h.cy-a.cy) } : null;
}
const avgOf=(frames)=>{ const H=[]; for(const f of frames){const m=metrics(f); if(m)H.push(m);} 
  return H.length? { hd:avg(H.map(x=>x.hd)), ad:avg(H.map(x=>x.ad)), spread:avg(H.map(x=>x.spread)), gap:avg(H.map(x=>x.gap)) } : null; };
const mk=d=>d.frames.map(f=>({t:f.t,players:f.players.map((p,i)=>p?{id:i,x:p[0],y:p[1]}:null),ball:f.ball}));
const cut=(frames,size=300,step=900)=>{const o=[];const T=frames[frames.length-1].t;
  for(let s=0;s+size<=T+1;s+=step)o.push(frames.filter(f=>f.t>=s&&f.t<s+size));return o.filter(w=>w.length>100);};

// 真实：2 场 × 7 窗 = 14
const realW=[]; for(const g of [1,2]){ const d=JSON.parse(readFileSync(`./data/real-game-${g}.json`,'utf8'));
  for(const w of cut(mk(d))) realW.push({g, m:avgOf(w), dur: w.length/5}); }

// 引擎：5 种子 × 5400s，切 6 窗 = 30
const bytes=readFileSync('./engine.wasm');const {instance}=await WebAssembly.instantiate(bytes,{});
const wasm=instance.exports;const enc=new TextEncoder(),dec=new TextDecoder();
const engW=[];
for(const seed of [42,1,7,99,123]){
  const b=enc.encode(JSON.stringify({demo_mode:false,off_ball_movement_demo:true,match_duration_seconds:5400}));
  new Uint8Array(wasm.memory.buffer,1024,b.length).set(b);wasm.simulate(BigInt(seed),1024,b.length);
  const p=wasm.get_json_ptr(),n=wasm.get_json_length();const s=dec.decode(new Uint8Array(wasm.memory.buffer,p,n));wasm.free_json();
  const g=createGame(s);const fr=[];for(let t=0;t<=g.matchEnd;t+=0.2){g.seekTo(t);fr.push({t,players:g.players.map(x=>({id:x.id,x:x.x,y:x.y})),ball:[g.ball.x,g.ball.y]});}
  for(const w of cut(fr)) engW.push({seed, m:avgOf(w)});
}

const R=realW.map(w=>w.m), E=engW.map(w=>w.m);
const col=(arr,k)=>arr.map(m=>m[k]);
console.log('=== 最终口径（trim1 纵深） × 最终采样（真实 14 窗 / 引擎 30 窗）===\n');
console.log('指标        真实(14窗)                引擎(30窗)                偏离');
for(const [k,name] of [['hd','主队纵深'],['ad','客队纵深'],['spread','紧凑度'],['gap','重心间距']]){
  const r=col(R,k), e=col(E,k);
  const sep = Math.max(...r)<Math.min(...e) || Math.max(...e)<Math.min(...r);
  console.log(`${name.padEnd(10)} ${avg(r).toFixed(1)}m [${rng(r)}]     ${avg(e).toFixed(1)}m [${rng(e)}]     ${((avg(e)/avg(r)-1)*100).toFixed(0)}%  ${sep?'✓分离':'✗重叠'}`);
}

// 留一交叉验证（最终口径）
console.log('\n=== 留一交叉验证：用 game1 的观测范围检查 game2 ===');
for(const [k,name] of [['hd','纵深'],['spread','紧凑度'],['gap','重心间距']]){
  const g1=realW.filter(w=>w.g===1).map(w=>w.m[k]), g2=realW.filter(w=>w.g===2).map(w=>w.m[k]);
  const lo=Math.min(...g1), hi=Math.max(...g1);
  const inside=g2.filter(v=>v>=lo&&v<=hi).length;
  console.log(`  ${name.padEnd(8)} game1 范围 [${lo.toFixed(1)}, ${hi.toFixed(1)}] → game2 ${inside}/${g2.length} 落入`);
}

// 引擎 300s vs 5400s 一致性
console.log('\n=== 引擎采样方案变更的前缀一致性（[0,300] 窗 vs 独立 300s 跑）===');
const e300 = E[0]; // seed42 的第一窗
console.log(`  seed42 5400s 的 [0,300] 窗 主队纵深 ${e300.hd.toFixed(2)}m`);

writeFileSync('/tmp/p36-final-numbers.json', JSON.stringify({
  convention: 'trim1 (drop 1 deepest + 1 highest, span of remaining 8)',
  engineSampling: '5400s default duration, cut into 300s windows step 900s',
  real: { nWindows: realW.length, perMetric: Object.fromEntries(['hd','ad','spread','gap'].map(k=>[k,{avg:avg(col(R,k)),min:Math.min(...col(R,k)),max:Math.max(...col(R,k))}])) },
  engine: { nWindows: engW.length, perMetric: Object.fromEntries(['hd','ad','spread','gap'].map(k=>[k,{avg:avg(col(E,k)),min:Math.min(...col(E,k)),max:Math.max(...col(E,k))}])) },
  realWindowSecs: realW.map(w=>+w.dur.toFixed(0)),
}, null, 2));
console.log('\n→ /tmp/p36-final-numbers.json');
