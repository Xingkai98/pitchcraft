// P38 线 B 前置测量：真实球员的 y 到底**围绕什么**波动？
//
// 线 B 的问题是「队形的表示方式」：`formation_target(st, id)` **不读任何其他球员的位置**，
// 每个人的目标是独立算的。本探针先量清楚：真实球员的 y 是（a）围绕**自己的职责基准**
// 波动，还是（b）围绕**球的位置**波动，还是（c）围绕**球队整体重心**波动。
//
// 三种模型各自"能解释多少 y 的方差" = 它们的 R²。这个数决定线 B 该把哪个量做成主驱动。
//
// 口径（与 q90 系列一致，见 q90-common 头注释）：
//   - 客队镜像 x；y 不镜像。槽位 = 转换器按整场平均深度排的**静态身份槽位**（不是瞬时位置）。
//   - 只取 Metrica 两场（有球帧、无外推问题），避免与 SkillCorner 的口径差异混进来。
//
// 用法：node probe-duty-baseline.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from '../probes/repo-root.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = findRepoRoot(HERE);
const { KEEPER_IDS, PITCH_WIDTH_M } = await import(`${ROOT}/viewer/match-metrics.js`);

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
function corr(a, b) {
  const ma = mean(a); const mb = mean(b);
  let n = 0; let da = 0; let db = 0;
  for (let i = 0; i < a.length; i += 1) { const x = a[i] - ma; const y = b[i] - mb; n += x * y; da += x * x; db += y * y; }
  return da > 0 && db > 0 ? n / Math.sqrt(da * db) : 0;
}

// 逐球员取 y 序列 + 同步的球 y、球队重心 y
function series(players, n) {
  const out = new Map(); // id -> { y: [], slot: [] }
  for (let i = 0; i < n; i += 1) out.set(players[i].id, { y: [], ball: [], cent: [], slot: [] });
  return out;
}

for (const g of ['1', '2']) {
  const d = JSON.parse(readFileSync(`${ROOT}/viewer/data/real-game-${g}.json`, 'utf8'));
  const frames = d.frames;

  // 主队非门将；槽位 = 该球员在**整场平均 y** 上的排名（静态职责近似）
  const ids = [...new Set(frames.flatMap((f) => f.players.map((_, i) => i)))].filter((i) => !KEEPER_IDS.includes(i));
  const byId = new Map();
  for (const i of ids) byId.set(i, { y: [], ball: [], cx: [], cy: [] });

  for (const f of frames) {
    if (!f.ball) continue;
    const ballY = f.ball[1] * PITCH_WIDTH_M;
    // 全体非门将重心（含门将也可，但与非门将口径一致更干净）
    const pts = f.players.map((p, i) => (p && !KEEPER_IDS.includes(i) ? p : null)).filter(Boolean);
    if (pts.length < 14) continue;
    const cy = mean(pts.map((p) => p[1])) * PITCH_WIDTH_M;
    for (const i of ids) {
      const p = f.players[i];
      if (!p) continue;
      const rec = byId.get(i);
      rec.y.push(p[1] * PITCH_WIDTH_M);
      rec.ball.push(ballY);
      rec.cy.push(cy);
    }
  }

  // 职责基准 = 该球员自己的 y 均值（这是"职责"的**代理**：整场平均位置）
  console.log(`\n=== Metrica game${g}（n=${frames.length} 帧）===`);
  console.log('id   个人y均值  个人y_sd  R²(球y)  R²(重心y)  职责均值|球侧回归斜率');
  const rows = [];
  for (const i of ids) {
    const r = byId.get(i);
    if (r.y.length < 500) continue;
    const r2ball = corr(r.y, r.ball) ** 2;
    const r2cent = corr(r.y, r.cy) ** 2;
    // 职责模型：y ~ 自己的均值（截距） + 球侧项。残差 sd 反映"除球侧外的个体自由度"
    const my = mean(r.y); const mb = mean(r.ball);
    let num = 0; let den = 0;
    for (let k = 0; k < r.y.length; k += 1) { num += (r.ball[k] - mb) * (r.y[k] - my); den += (r.ball[k] - mb) ** 2; }
    const slope = den > 0 ? num / den : 0;
    rows.push({ id: i, my, sd: sd(r.y), r2ball, r2cent, slope });
    console.log(`${String(i).padStart(2)}   ${my.toFixed(1).padStart(8)}  ${sd(r.y).toFixed(1).padStart(7)}   ${r2ball.toFixed(3)}    ${r2cent.toFixed(3)}     ${slope.toFixed(3)}`);
  }
  // 队伍级
  const allY = []; const allBall = []; const allCent = [];
  for (const i of ids) { const r = byId.get(i); allY.push(...r.y); allBall.push(...r.ball); allCent.push(...r.cy); }
  console.log(`\n  合并 R²(y~球y) = ${(corr(allY, allBall) ** 2).toFixed(3)}`);
  console.log(`  合并 R²(y~重心y) = ${(corr(allY, allCent) ** 2).toFixed(3)}`);
  console.log(`  人均 |球侧斜率| 均值 = ${mean(rows.map((r) => Math.abs(r.slope))).toFixed(3)}`);
  console.log(`  人均 y_sd = ${mean(rows.map((r) => r.sd)).toFixed(2)} m`);
  console.log(`  球员间 y 均值极差 = ${(Math.max(...rows.map((r) => r.my)) - Math.min(...rows.map((r) => r.my))).toFixed(1)} m`);
}
