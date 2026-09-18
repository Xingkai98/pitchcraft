// adv9: 独立复算（不复用 match-metrics 的聚合），核验 adv7 的两个承重数字。
import { readFileSync } from 'node:fs';
const ROOT='/home/happy/.claude/worktrees/wayfinder-realism';
const q=(s,p)=>{const h=(s.length-1)*p,i=Math.floor(h);return i+1>=s.length?s[s.length-1]:s[i]+(h-i)*(s[i+1]-s[i]);};
const mean=a=>a.reduce((x,y)=>x+y,0)/a.length;
function depth(frames,team,opts){ const skipExt=(opts||{}).skipExt; //{
  const out=[];
  for(const f of frames){
    const L=f.__L;
    const ps=(f.players||[]).filter(p=>p&&![0,21].includes(p.id)&&(team==='home'?p.id<=10:p.id>=11)&&(!skipExt||!p.extrapolated));
    if(ps.length<7)continue;
    const xs=ps.map(p=>(team==='home'?p.x:1-p.x)*L).sort((a,b)=>a-b);
    out.push(q(xs,0.9)-q(xs,0.1));
  }
  return out;
}
// Metrica
{
  const all=[];
  for(const n of ['1','2']){
    const g=JSON.parse(readFileSync(`${ROOT}/viewer/data/real-game-${n}.json`,'utf8'));
    let cur=null,win=null;
    for(const fr of g.frames){
      const f={t:fr.t,__L:105,players:fr.players.map((p,id)=>(p?{id,x:p[0],y:p[1]}:null))};
      // 手工切 300s 窗 / 900s 步长
      if(fr.t%900===0&&!win){win=[[]];}
      // 简化：直接取 t in [0,300) U [900,1200) ... 只用第一个窗做交叉验证
      if(fr.t<300) all.push(f);
      else if(fr.t>=900&&fr.t<1200) all.push(f);
    }
  }
  console.log(`Metrica (窗0+窗1)  主队纵深 ${mean(depth(all,'home',{skipExt:false})).toFixed(2)}  （adv7 全窗 25.94）`);
}
// SkillCorner
{
  const prim=[],allp=[];
  for(const id of ['1874553','1886347','1899585','1959846','2007448','2013725']){
    const g=JSON.parse(readFileSync(`${ROOT}/.scratch/p38-frames/skillcorner-${id}.json`,'utf8'));
    const L=g.meta.pitchMeters.length;
    for(const fr of g.frames){
      if(fr.t>=300&&fr.t<600)continue; // 只取 t<300
      if(fr.t>=300)continue;
      const mk=ext=>({t:fr.t,__L:L,players:fr.players.map((p,i)=>p?(ext?{id:i,x:p[0],y:p[1]}:{id:i,x:p[0],y:p[1],extrapolated:p.length>2&&p[2]===1}):null)});
      prim.push(mk(false)); allp.push(mk(true));
    }
  }
  console.log(`SC (窗0)  主口径 ${mean(depth(prim,'home',{skipExt:true})).toFixed(2)}   全点 ${mean(depth(allp,'home',{skipExt:false})).toFixed(2)}   （adv7 全窗 17.60 / 25.23）`);
}
