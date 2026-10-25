// 从真实 Metrica 两场拟合「球队块」定律，供引擎队形机制用。
// 口径：与 viewer/match-metrics.js 一致（非门将 10 人、逐帧瞬时、米制）。
// 归一化：x 一律转成「离本方门线距离」；y 保持绝对（两队同侧坐标）。
// 输出：相位（控球/失球，代理）分桶的 块心/纵深/宽度/横移增益 + 线性拟合系数。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const L = 105; const W = 68; const KEEP = [0, 21];
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const qs = (s, p) => { const h = (s.length - 1) * p; const lo = Math.floor(h); const hi = Math.ceil(h); return s[lo] + (h - lo) * (s[hi] - s[lo]); };
const ols = (xs, ys) => { const mx = mean(xs); const my = mean(ys); let n = 0; let d = 0; for (let i = 0; i < xs.length; i += 1) { n += (xs[i] - mx) * (ys[i] - my); d += (xs[i] - mx) ** 2; } const b = d ? n / d : 0; return { slope: +b.toFixed(3), intercept: +(my - b * mx).toFixed(2) }; };

function teamOf(id) { return id <= 10 ? 0 : 1; }
function ownX(team, x) { return team === 0 ? x : 1 - x; } // 离本方门线（归一化）

function framesOf(g) {
  const d = JSON.parse(readFileSync(`${ROOT}/viewer/data/real-game-${g}.json`, 'utf8'));
  return d.frames.map((f) => ({ t: f.t, players: f.players, ball: f.ball }));
}

const buckets = [0, 15, 29, 44, 61, 76, 90, 105];
const rows = []; // {phase, ballOwnM, centroidOwnM, spanM, widthM, cy, ballY}
for (const g of [1, 2]) {
  for (const f of framesOf(g)) {
    if (!f.ball) continue;
    const pl = f.players.map((p, id) => (p == null ? null : { id, x: p[0], y: p[1] })).filter(Boolean);
    if (pl.length < 22) continue;
    const bx = f.ball[0] * L; const by = f.ball[1] * W;
    // 控球代理：离球最近者所属队
    let best = null;
    for (const p of pl) { const d = Math.hypot(p.x * L - bx, p.y * W - by); if (!best || d < best.d) best = { d, team: teamOf(p.id) }; }
    for (const team of [0, 1]) {
      const out = pl.filter((p) => teamOf(p.id) === team && !KEEP.includes(p.id));
      if (out.length < 7) continue;
      const xs = out.map((p) => ownX(team, p.x) * L);
      const ys = out.map((p) => p.y * W);
      const ballOwn = ownX(team, f.ball[0]) * L;
      rows.push({
        phase: best.team === team ? 'att' : 'def',
        ballOwn, centroidOwn: mean(xs),
        span: qs([...xs].sort((a, b) => a - b), 0.9) - qs([...xs].sort((a, b) => a - b), 0.1),
        width: Math.max(...ys) - Math.min(...ys),
        cy: mean(ys), ballY: by,
      });
    }
  }
}

console.log('rows', rows.length);
for (const phase of ['att', 'def']) {
  const r = rows.filter((x) => x.phase === phase);
  console.log(`\n## phase=${phase}  n=${r.length}`);
  console.log('ballOwn bucket   n   centroidOwn   span   width   cy-ballY(slope)');
  for (let i = 0; i < buckets.length - 1; i += 1) {
    const sel = r.filter((x) => x.ballOwn >= buckets[i] && x.ballOwn < buckets[i + 1]);
    if (sel.length < 20) continue;
    console.log(`${String(buckets[i]).padStart(3)}-${String(buckets[i + 1]).padStart(3)}  ${String(sel.length).padStart(7)}  ${mean(sel.map((x) => x.centroidOwn)).toFixed(1).padStart(10)}  ${mean(sel.map((x) => x.span)).toFixed(1).padStart(6)}  ${mean(sel.map((x) => x.width)).toFixed(1).padStart(6)}  ${ols(sel.map((x) => x.ballY), sel.map((x) => x.cy)).slope.toFixed(3)}`);
  }
  console.log('linear fit centroidOwn ~ ballOwn:', JSON.stringify(ols(r.map((x) => x.ballOwn), r.map((x) => x.centroidOwn))));
  console.log('linear fit cy ~ ballY (absolute):', JSON.stringify(ols(r.map((x) => x.ballY), r.map((x) => x.cy))));
  const cyMean = mean(r.map((x) => x.cy));
  const cySd = Math.sqrt(mean(r.map((x) => (x.cy - cyMean) ** 2)));
  console.log('mean span/width, cy sd:', mean(r.map((x) => x.span)).toFixed(2), mean(r.map((x) => x.width)).toFixed(2), cySd.toFixed(2));
}

// 两队重心间距（对照 P38 gap 口径）
const gapByFrame = [];
for (let i = 0; i < rows.length; i += 2) {
  const a = rows[i]; const b = rows[i + 1];
  if (!a || !b || a.phase === b.phase) continue;
  // 需要同一帧的两队；rows 按 frame 顺序成对（team 0, team 1）
}
console.log('\n（gap 由 teamShape 逐帧算 Euclidean；本脚本桶表已足够拟合块心律）');
