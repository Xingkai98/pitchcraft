// probe 11：offside-line 假说的**对照检验**
//
// 隐患：probe9 (A) 中 corr(本方后4, 对方前2) = −0.96 可能完全是机械的——
// 两队一起随球上下移动时，两个「离各自门线的距离」本来就负相关（斜率 −1）。
// 正确的检验：控制球位后，对方锋线是否**还有**额外解释力（偏相关 / 增量 R²）。
//   M0: own_rear ~ ball
//   M1: own_rear ~ ball + opp_front
// 若 β_opp 显著且 R² 明显上升 → 盯人/越位线是独立信号；否则 → 只是球位的影子。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PITCH_LENGTH_M, BENCHMARK_SEEDS, ENGINE_DURATION_SEC,
  sampleEngineFrames, cutWindows, KEEPER_IDS, isRawBallFrame,
} from '../../../../../viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '../../../../../tools/benchmark-engine.mjs';

const HERE = fileURLToPath(new URL('../../../../..', import.meta.url));

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const cov = (a, b) => mean(a.map((v, i) => v * b[i])) - mean(a) * mean(b);
const corr = (a, b) => cov(a, b) / (sd(a) * sd(b));

// 多元最小二乘（两个自变量 + 截距），返回 {b1,b2,a,R2}
function reg2(y, x1, x2) {
  const n = y.length;
  const m = [mean(y), mean(x1), mean(x2)];
  const X = [x1.map((v) => v - m[1]), x2.map((v) => v - m[2])];
  const yc = y.map((v) => v - m[0]);
  const s11 = mean(X[0].map((v) => v * v)); const s22 = mean(X[1].map((v) => v * v));
  const s12 = mean(X[0].map((v, i) => v * X[1][i]));
  const s1y = mean(X[0].map((v, i) => v * yc[i])); const s2y = mean(X[1].map((v, i) => v * yc[i]));
  const det = s11 * s22 - s12 * s12;
  const b1 = (s22 * s1y - s12 * s2y) / det;
  const b2 = (s11 * s2y - s12 * s1y) / det;
  const a = m[0] - b1 * m[1] - b2 * m[2];
  const pred = x1.map((v, i) => a + b1 * v + b2 * x2[i]);
  const ss = mean(yc.map((v, i) => (v - (pred[i] - m[0])) ** 2));
  const R2 = 1 - ss / (sd(y) ** 2);
  // 偏相关 r(y, x2 | x1)
  const r12 = corr(x1, x2); const r1y = corr(x1, y); const r2y = corr(x2, y);
  const pr = (r2y - r1y * r12) / Math.sqrt((1 - r1y ** 2) * (1 - r12 ** 2));
  return { b1, b2, a, R2, pr, r1y, r2y, r12, n };
}
function reg1(y, x) {
  const b = cov(x, y) / (sd(x) ** 2); const a = mean(y) - b * mean(x);
  const pred = x.map((v) => a + b * v);
  const R2 = 1 - mean(y.map((v, i) => (v - pred[i]) ** 2)) / (sd(y) ** 2);
  return { b, a, R2 };
}

const load = await loadEngineWasm(WASM_PATH);
const { createGame } = await import('../../../../../viewer/game.js');
const EF = [];
for (const seed of BENCHMARK_SEEDS.slice(0, 3)) {
  const game = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  for (const w of cutWindows(sampleEngineFrames(game))) EF.push(...w);
}
const RF = [];
for (const f of ['1', '2']) {
  const g = JSON.parse(readFileSync(`${HERE}/viewer/data/real-game-${f}.json`, 'utf8'));
  const frames = g.frames.map((fr) => ({ t: fr.t, ball: fr.ball || null, players: fr.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)) }));
  for (const w of cutWindows(frames)) RF.push(...w);
}
function xsSorted(f, team) {
  const isHome = team === 'home';
  const ps = (f.players || []).filter((p) => p && !KEEPER_IDS.includes(p.id) && (isHome ? p.id <= 10 : p.id >= 11));
  if (ps.length < 10) return null;
  return ps.map((p) => (isHome ? p.x : 1 - p.x) * PITCH_LENGTH_M).sort((a, b) => a - b);
}

console.log('=== 控制球位后，对方锋线对「本方后4」是否还有增量解释力 ===');
console.log('  M0: own_rear ~ ball_own     M1: own_rear ~ ball_own + opp_front\n');
for (const [label, FR] of [['真实 Metrica', RF], ['引擎', EF]]) {
  const y = []; const xb = []; const xo = [];
  for (const f of FR) {
    if (!f.ball || !Number.isFinite(f.ball[0]) || !isRawBallFrame(f)) continue;
    const h = xsSorted(f, 'home'); const a = xsSorted(f, 'away');
    if (!h || !a) continue;
    y.push(mean(h.slice(0, 4)));                 // 主队后4（离主队门线）
    xb.push(f.ball[0] * 105);                     // 球位（统一到主队攻向右）
    xo.push(mean(a.slice(8, 10)));                // 客队前2（离客队门线）→ 越位线的代理
  }
  const m0 = reg1(y, xb); const m1 = reg2(y, xb, xo);
  console.log(`  ${label}  n=${y.length}`);
  console.log(`    M0  β_ball = ${m0.b.toFixed(3)}   R² = ${m0.R2.toFixed(3)}`);
  console.log(`    M1  β_ball = ${m1.b1.toFixed(3)}  β_oppFront = ${m1.b2.toFixed(3)}   R² = ${m1.R2.toFixed(3)}`);
  console.log(`    增量 R² = ${(m1.R2 - m0.R2).toFixed(3)}   偏相关 r(own_rear, opp_front | ball) = ${m1.pr.toFixed(3)}`);
  console.log(`    零阶相关：r(ball, own_rear)=${m1.r1y.toFixed(3)}  r(oppfront, own_rear)=${m1.r2y.toFixed(3)}  r(ball, oppfront)=${m1.r12.toFixed(3)}\n`);
}

console.log('=== 对照：把「对方前2」换成「对方重心」（一个与球高度共线的量）===');
for (const [label, FR] of [['真实', RF], ['引擎', EF]]) {
  const y = []; const xb = []; const xo = [];
  for (const f of FR) {
    if (!f.ball || !Number.isFinite(f.ball[0]) || !isRawBallFrame(f)) continue;
    const h = xsSorted(f, 'home'); const a = xsSorted(f, 'away');
    if (!h || !a) continue;
    y.push(mean(h.slice(0, 4))); xb.push(f.ball[0] * 105); xo.push(mean(a));
  }
  const m0 = reg1(y, xb); const m1 = reg2(y, xb, xo);
  console.log(`  ${label}  M0 R²=${m0.R2.toFixed(3)} → M1 R²=${m1.R2.toFixed(3)}  增量 ${(m1.R2 - m0.R2).toFixed(3)}  偏相关 ${m1.pr.toFixed(3)}`);
}

console.log('\n=== 反向对照：本方后4 的**绝对位置** vs 对方前2 的**绝对位置**（换算到同一球场坐标）===');
console.log('  若两队真的在同一条越位线上，两条线在球场坐标下的**间隙**应显著小于随机');
for (const [label, FR] of [['真实', RF], ['引擎', EF]]) {
  const gap = []; const rnd = [];
  for (let i = 0; i < FR.length; i += 1) {
    const f = FR[i]; if (!f.ball || !isRawBallFrame(f)) continue;
    const h = xsSorted(f, 'home'); const a = xsSorted(f, 'away');
    if (!h || !a) continue;
    // 主队后4 在球场坐标 = mean(h[0..4])；客队前2 在球场坐标 = 105 − mean(a[8..10])
    gap.push(105 - mean(a.slice(8, 10)) - mean(h.slice(0, 4)));
    const g = FR[(i * 7919) % FR.length]; // 确定性伪随机配对
    const hg = xsSorted(g, 'home'); const ag = xsSorted(g, 'away');
    if (!hg || !ag) continue;
    rnd.push(105 - mean(ag.slice(8, 10)) - mean(hg.slice(0, 4)));
  }
  console.log(`  ${label}  真实配对间隙 均值 ${mean(gap).toFixed(1)}m p10 ${[...gap].sort((a, b) => a - b)[(gap.length * 0.1) | 0].toFixed(1)} p90 ${[...gap].sort((a, b) => a - b)[(gap.length * 0.9) | 0].toFixed(1)}`);
  console.log(`            随机配对间隙 均值 ${mean(rnd).toFixed(1)}m（若两者无关联，应与真实配对同分布）`);
}
