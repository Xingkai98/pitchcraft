// P38 线 B 核心测量：**什么驱动了真实球员的横向位置**？
//
// 线 B 的问题：`formation_target(st, id)` 不读任何其他球员的位置，每个人的目标独立算出。
// 但在做机制设计之前必须先量清楚：真实球员的 y **最能被哪个可观测量的函数解释**。
// 备选驱动（都是引擎手里有的状态）：
//
//   D1 静态职责基准    y ≈ 自己的整场均值            （纯角色，零自由度）
//   D2 球的位置        y ≈ 球 y                       （当前引擎唯一用的项，系数 0.036）
//   D3 球队重心        y ≈ 全队 y 均值                （"整队一起动" = swarm）
//   D4 局部球响应      y ≈ 球y，但**强度随该球员到球的距离衰减**
//                      （真实"压缩"：近球者反应大、远球者守形）
//   D5 盯人             y ≈ **最近对手**的 y          （相互作用，天然个体化）
//   D6 职责 + 球侧      y ≈ 个人均值 + β·球y          （当前设计的正确版）
//
// 判据是各模型的 R²（解释了多少 y 方差）。**R² 低的驱动做不成主项**——
// 这正是 exp7（远端内收，R²(球y) 只有 0.17）力度不够的根本原因：
// 球位项最多只能解释 17% 的横向方差，剩下的 83% 必须来自别处。
//
// 用法：node probe-lateral-drivers.mjs

import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from '../probes/repo-root.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = findRepoRoot(HERE);
const { KEEPER_IDS, PITCH_WIDTH_M } = await import(`${ROOT}/viewer/match-metrics.js`);

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function corr(a, b) {
  const ma = mean(a); const mb = mean(b);
  let n = 0; let da = 0; let db = 0;
  for (let i = 0; i < a.length; i += 1) { const x = a[i] - ma; const y = b[i] - mb; n += x * y; da += x * x; db += y * y; }
  return da > 0 && db > 0 ? n / Math.sqrt(da * db) : 0;
}
// 最小二乘 y ~ a*x1 + b*x2 + c
function r2multi(y, xs) {
  const n = y.length; const k = xs.length;
  if (n < k + 2) return NaN;
  const m = mean(y);
  // 正规方程（k+1 阶小矩阵，高斯消元）
  const A = Array.from({ length: k + 1 }, () => new Array(k + 2).fill(0));
  for (let r = 0; r <= k; r += 1) {
    for (let c = 0; c <= k; c += 1) {
      let s = 0;
      for (let i = 0; i < n; i += 1) s += (r === 0 ? 1 : xs[r - 1][i]) * (c === 0 ? 1 : xs[c - 1][i]);
      A[r][c] = s;
    }
    let s = 0;
    for (let i = 0; i < n; i += 1) s += (r === 0 ? 1 : xs[r - 1][i]) * y[i];
    A[r][k + 1] = s;
  }
  for (let c = 0; c < k + 1; c += 1) {
    let p = c;
    for (let r = c + 1; r < k + 1; r += 1) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-9) continue;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < k + 1; r += 1) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let q = c; q <= k + 1; q += 1) A[r][q] -= f * A[c][q];
    }
  }
  const beta = A.map((row, i) => (Math.abs(row[i]) < 1e-9 ? 0 : row[k + 1] / row[i]));
  let ssRes = 0; let ssTot = 0;
  for (let i = 0; i < n; i += 1) {
    let pred = beta[0];
    for (let j = 0; j < k; j += 1) pred += beta[j + 1] * xs[j][i];
    ssRes += (y[i] - pred) ** 2; ssTot += (y[i] - m) ** 2;
  }
  return ssTot > 0 ? 1 - ssRes / ssTot : NaN;
}

for (const g of ['1', '2']) {
  const d = JSON.parse(readFileSync(`${ROOT}/viewer/data/real-game-${g}.json`, 'utf8'));
  const frames = d.frames.filter((f) => f.ball);
  const ids = [...new Set(frames.flatMap((f) => f.players.map((_, i) => i)))].filter((i) => !KEEPER_IDS.includes(i));

  const rec = new Map(ids.map((i) => [i, { y: [], ball: [], cent: [], mark: [], dist: [] }]));
  for (const f of frames) {
    const ballY = f.ball[1] * PITCH_WIDTH_M;
    const ball = f.ball;
    const pts = f.players.map((p, i) => (p && !KEEPER_IDS.includes(i) ? { i, p } : null)).filter(Boolean);
    if (pts.length < 14) continue;
    const cy = mean(pts.map((o) => o.p[1])) * PITCH_WIDTH_M;
    for (const { i, p } of pts) {
      const r = rec.get(i);
      // 最近对手（用米制欧氏距离）
      let best = null; let bestD = Infinity;
      for (const o of pts) {
        if ((o.i <= 10) === (i <= 10)) continue;
        const dd = Math.hypot((o.p[0] - p[0]) * 105, (o.p[1] - p[1]) * 68);
        if (dd < bestD) { bestD = dd; best = o.p; }
      }
      r.y.push(p[1] * PITCH_WIDTH_M);
      r.ball.push(ballY);
      r.cent.push(cy);
      r.mark.push(best ? best[1] * PITCH_WIDTH_M : ballY);
      r.dist.push(Math.hypot((ball[0] - p[0]) * 105, (ball[1] - p[1]) * 68));
    }
  }

  console.log(`\n=== Metrica game${g}：真实球员 y 的可解释性（R²，合并所有非门将）===`);
  const allY = []; const allBall = []; const allCent = []; const allMark = []; const allDist = [];
  const perId = [];
  for (const i of ids) {
    const r = rec.get(i);
    if (r.y.length < 500) continue;
    perId.push({
      id: i,
      my: mean(r.y),
      sd: Math.sqrt(mean(r.y.map((v) => (v - mean(r.y)) ** 2))),
      r2ball: corr(r.y, r.ball) ** 2,
      r2cent: corr(r.y, r.cent) ** 2,
      r2mark: corr(r.y, r.mark) ** 2,
      // D4：局部球响应 = 球y 加权 by 1/(1+dist/20)
      r2local: corr(r.y, r.ball.map((b, k) => b * (1 / (1 + r.dist[k] / 20)))) ** 2,
    });
    allY.push(...r.y); allBall.push(...r.ball); allCent.push(...r.cent); allMark.push(...r.mark); allDist.push(...r.dist);
  }
  console.log(`  D2 球 y             R² = ${(corr(allY, allBall) ** 2).toFixed(3)}`);
  console.log(`  D3 球队重心 y       R² = ${(corr(allY, allCent) ** 2).toFixed(3)}`);
  console.log(`  D5 最近对手 y       R² = ${(corr(allY, allMark) ** 2).toFixed(3)}   ← 盯人`);
  const local = allBall.map((b, k) => b * (1 / (1 + allDist[k] / 20)));
  console.log(`  D4 局部球响应       R² = ${(corr(allY, local) ** 2).toFixed(3)}`);
  console.log(`  D6 职责+球侧        R² = ${r2multi(allY, [allBall]).toFixed(3)}  （= D2）`);
  console.log(`  D2+D3+D5 三者       R² = ${r2multi(allY, [allBall, allCent, allMark]).toFixed(3)}`);
  console.log(`\n  人均：y_sd ${mean(perId.map((r) => r.sd)).toFixed(1)}m | R²(球) ${mean(perId.map((r) => r.r2ball)).toFixed(3)}`
    + ` | R²(重心) ${mean(perId.map((r) => r.r2cent)).toFixed(3)} | R²(盯人) ${mean(perId.map((r) => r.r2mark)).toFixed(3)}`);
  const sdArr = perId.map((r) => r.sd);
  console.log(`  y_sd 的球员间离散：min ${Math.min(...sdArr).toFixed(1)} / max ${Math.max(...sdArr).toFixed(1)}`
    + ` / 极差 ${(Math.max(...sdArr) - Math.min(...sdArr)).toFixed(1)}m  ← 个体性 = 这个离散`);
}
