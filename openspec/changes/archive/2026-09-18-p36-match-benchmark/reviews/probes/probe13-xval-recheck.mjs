// 实现期复核 3/3：D5 留一交叉验证表在「配对修正 + 13 满窗」下的重算。
// 跑法：拷到 viewer/ 下 node 运行。
import { readFileSync } from 'node:fs';
const L = 105, W = 68;
const isKeeper = id => id === 0 || id === 21;
const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
const games = [1, 2].map(g => JSON.parse(readFileSync(`./data/real-game-${g}.json`, 'utf8')));
const cut = (frames, size = 300, step = 900) => {
  const o = []; const T = frames[frames.length - 1].t;
  for (let s = 0; s + size <= T + 1; s += step) o.push(frames.filter(f => f.t >= s && f.t < s + size));
  return o.filter(w => w.length > 100);
};
function wm(frames) {
  const H = [], A = [], S = [], G = [];
  for (const f of frames) {
    const ps = f.players.map((p, i) => p ? { id: i, x: p[0], y: p[1] } : null);
    const team = (lo, hi) => { const q = ps.filter(p => p && !isKeeper(p.id) && p.id >= lo && p.id <= hi); if (q.length < 7) return null;
      const xs = q.map(p => p.x * L); const ys = q.map(p => p.y * W);
      const cx = avg(xs), cy = avg(ys);
      return { depth: [...xs].sort((a,b)=>a-b)[xs.length-2] - [...xs].sort((a,b)=>a-b)[1], cx, cy,
        spread: avg(q.map(p => Math.hypot(p.x*L-cx, p.y*W-cy))) }; };
    const h = team(1,10), a = team(11,20);
    if (h && a) { H.push(h.depth); A.push(a.depth); S.push(h.spread); G.push(Math.hypot(h.cx-a.cx,h.cy-a.cy)); }
  }
  return H.length ? { hd: avg(H), spread: avg(S), gap: avg(G) } : null;
}
const per = { 1: [], 2: [] };
for (const g of [1,2]) for (const w of cut(games[g-1].frames)) per[g].push(wm(w));
for (const [k,name] of [['hd','纵深'],['spread','紧凑度'],['gap','重心间距']]) {
  const g1 = per[1].map(m=>m[k]), g2 = per[2].map(m=>m[k]);
  const lo = Math.min(...g1), hi = Math.max(...g1);
  const inside = g2.filter(v=>v>=lo&&v<=hi).length;
  console.log(`${name}: game1 范围 [${lo.toFixed(1)}, ${hi.toFixed(1)}] → game2 ${inside}/${g2.length} 落入`);
}
