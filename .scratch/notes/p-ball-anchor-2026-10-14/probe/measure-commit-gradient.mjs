// 从 Metrica 真实帧量「球员跟球的强度 vs 离球距离」——把机制要求的**个体差异化**锚在真实数据上，
// 而不是拍脑袋给全队一个 k。
//
// 做法：把**客队镜像**（x' = 1−x，ball_x' = 1−ball_x），使两队的「跟球」都变成沿 +x。
// 按球员到球的**米制距离**分箱，箱内做 OLS：x_player = α + β·ball_x。
// β_bin = 该距离档的球员「球每移动 1 m，他跟着移动几 m」。
//
// 口径：只用**原始球帧**（ballFill == null）；0.2s 抽样（与 match-metrics SAMPLE_INTERVAL_SEC 一致，
// 降自相关）；外场（剔门将）；105×68。
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
const L = 105, W = 68;
const KEEP = mm.KEEPER_IDS;
const GAMES = ['viewer/data/real-game-1.json', 'viewer/data/real-game-2.json'].map((p) => join(ROOT, p));

const BINS = [[0, 5], [5, 10], [10, 15], [15, 20], [20, 25], [25, 30], [30, 40], [40, 60], [60, 200]];
const acc = BINS.map(() => ({ n: 0, sx: 0, sy: 0, sxx: 0, sxy: 0 }));

for (const gp of GAMES) {
  const g = JSON.parse(readFileSync(gp, 'utf8'));
  // 0.2s 抽样：t 起点 0，步长 0.2，按最近帧取
  const all = g.frames;
  const step = 0.2;
  let idx = 0;
  for (let t = 0; t <= all[all.length - 1].t; t += step) {
    while (idx + 1 < all.length && Math.abs(all[idx + 1].t - t) < Math.abs(all[idx].t - t)) idx++;
    const f0 = all[idx];
    if (!f0 || !f0.ball || f0.ballFill !== undefined) continue; // 原始球帧
    const bx = f0.ball[0] * L, by = f0.ball[1] * W;
    for (const id of [...Array(22).keys()]) {
      if (KEEP.includes(id)) continue;
      const p = f0.players[id];
      if (!p || p[2] === 1) continue;
      const home = id <= 10;
      // 镜像：让两队都沿 +x 进攻
      const px = (home ? p[0] : 1 - p[0]) * L;
      const py = p[1] * W;
      const bxm = home ? bx : L - bx;
      const d = Math.hypot(px - bx, py - by);
      const k = BINS.findIndex(([a, b]) => d >= a && d < b);
      if (k < 0) continue;
      const a = acc[k];
      a.n++; a.sx += bxm; a.sy += px; a.sxx += bxm * bxm; a.sxy += bxm * px;
    }
  }
}

const out = BINS.map((b, k) => {
  const a = acc[k];
  const den = a.n * a.sxx - a.sx * a.sx;
  const beta = den > 1e-9 ? (a.n * a.sxy - a.sx * a.sy) / den : null;
  return { binM: `${b[0]}-${b[1]}`, n: a.n, beta };
});
console.log(JSON.stringify(out, null, 1));
