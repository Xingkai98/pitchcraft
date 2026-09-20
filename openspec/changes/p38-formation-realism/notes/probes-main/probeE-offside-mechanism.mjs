// 方案设计 agent（乙）探针 E：**越位线是不是真实锋线的主要约束**（机制验证）
//
// 我要提的机制是「进攻方最前线锚定在对方最后一名防守者（越位线）」，而不是「锚定在球」。
// 在写进方案前必须验证：真实数据里，锋线位置到底更听球的话，还是更听对方防线的话？
//
// 做法：对真实帧做回归
//   front_depth ~ ball            （球模型）
//   front_depth ~ opp_line        （越位线模型）
//   front_depth ~ ball + opp_line （联合）
// 比较偏 R² 与系数。若越位线的偏解释力显著 > 0（且远大于球的），机制成立。
// 同口径跑引擎做对照。
//
// 坐标：一律用「离本方门线的距离」u ∈ [0,105]，主客统一。
//   · 我的锋线高度  f_u = 105 - my_xs[9]（我队最前者的 u）
//   · 对方越位线     o_u = 对方 xs[1]（对方第 2 深者的 u，= 对方越位线的位置）
//   · 球离我门线     b_u
// 注意 o_u 与 f_u 是**同一坐标**（都是从各自门线量），但我要的是**空间冲突量**：
//   gap = (对方的 o_u 换算到我攻向的球门) 。对方 o_u 意味着离它所守球门 o_u，
//   该球门就是我所攻的球门 → 离我攻向球门的距离 = o_u。而我的前锋离我攻向球门 = 105 - f_u。
//   ⇒ 越位余量 = (105 − f_u) − o_u，我探针 D1 已算过。
// 本探针要的是**预测**：用同一坐标系的量预测 f_u。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PITCH_LENGTH_M, BENCHMARK_SEEDS, ENGINE_DURATION_SEC, KEEPER_IDS,
  sampleEngineFrames, cutWindows,
} from '../../../../../viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '../../../../../tools/benchmark-engine.mjs';

const HERE = fileURLToPath(new URL('../../../../..', import.meta.url));

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
function ols(X, y) { // X: n×k（含截距列）
  const n = X.length; const k = X[0].length;
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < n; i += 1) {
    for (let a = 0; a < k; a += 1) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b += 1) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  // 高斯消元
  const M = XtX.map((r, i) => [...r, Xty[i]]);
  for (let c = 0; c < k; c += 1) {
    let p = c; for (let r = c + 1; r < k; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const pv = M[c][c];
    for (let j = c; j <= k; j += 1) M[c][j] /= pv;
    for (let r = 0; r < k; r += 1) { if (r === c) continue; const f = M[r][c]; for (let j = c; j <= k; j += 1) M[r][j] -= f * M[c][j]; }
  }
  const beta = M.map((r) => r[k]);
  const pred = X.map((row) => row.reduce((s, v, i) => s + v * beta[i], 0));
  const ybar = mean(y);
  const sst = y.reduce((s, v) => s + (v - ybar) ** 2, 0);
  const sse = y.reduce((s, v, i) => s + (v - pred[i]) ** 2, 0);
  return { beta, r2: 1 - sse / sst, pred };
}

function build(frames) {
  const out = [];
  for (const f of frames) {
    if (!f.ball || !Number.isFinite(f.ball[0])) continue;
    const teams = {};
    for (const team of ['home', 'away']) {
      const isHome = team === 'home';
      const us = [];
      for (let id = 0; id < 22; id += 1) {
        if (KEEPER_IDS.includes(id)) continue;
        if ((id <= 10) !== isHome) continue;
        const p = f.players[id]; if (!p) continue;
        const x = Array.isArray(p) ? p[0] : p.x;
        if (!Number.isFinite(x)) continue;
        us.push((isHome ? x : 1 - x) * PITCH_LENGTH_M);
      }
      if (us.length < 7) continue;
      us.sort((a, b) => a - b);
      teams[team] = { u: us, ballU: (isHome ? f.ball[0] : 1 - f.ball[0]) * PITCH_LENGTH_M };
    }
    if (!teams.home || !teams.away) continue;
    for (const [me, opp] of [['home', 'away'], ['away', 'home']]) {
      out.push({
        t: f.t,
        front: teams[me].u[9],          // 我的锋线高度（离我门线）
        oppLine: teams[opp].u[1],       // 对方越位线（离对方门线）—— 与 front 同尺度但门线不同
        oppLast: teams[opp].u[0],       // 对方最后一人
        ball: teams[me].ballU,          // 球离我门线
        // 冲突量：我的前锋离我攻向球门 = 105 - front；对方越位线离同一球门 = oppLine
        offMargin: (105 - teams[me].u[9]) - teams[opp].u[1],
      });
    }
  }
  return out;
}

const load = await loadEngineWasm(WASM_PATH);
if (!load.ok) { console.error(load.message); process.exit(1); }
const { createGame } = await import('../../../../../viewer/game.js');
const engineFrames = [];
for (const seed of BENCHMARK_SEEDS.slice(0, 3)) {
  const game = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  for (const w of cutWindows(sampleEngineFrames(game))) engineFrames.push(...w);
}
const realFrames = [];
for (const fn of ['1', '2']) {
  const g = JSON.parse(readFileSync(`${HERE}/viewer/data/real-game-${fn}.json`, 'utf8'));
  const frames = g.frames.map((fr) => ({ t: fr.t, ball: fr.ball || null, players: fr.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)) }));
  for (const w of cutWindows(frames)) realFrames.push(...w);
}

const N = (a) => a / 105.0;
function analyse(rows, label) {
  const y = rows.map((r) => r.front);
  const one = rows.map(() => 1);
  const ball = rows.map((r) => r.ball);
  const oline = rows.map((r) => 105 - r.oppLine); // 换算到「离我门线」的同一坐标
  const mBall = ols(rows.map((_, i) => [1, N(ball[i])]), y);
  const mLine = ols(rows.map((_, i) => [1, N(oline[i])]), y);
  const mBoth = ols(rows.map((_, i) => [1, N(ball[i]), N(oline[i])]), y);
  console.log(`\n  ${label}  (n=${rows.length})`);
  console.log(`    锋线 ~ 球        : R²=${mBall.r2.toFixed(4)}  斜率=${mBall.beta[1].toFixed(3)}`);
  console.log(`    锋线 ~ 对方防线  : R²=${mLine.r2.toFixed(4)}  斜率=${mLine.beta[1].toFixed(3)}`);
  console.log(`    锋线 ~ 球 + 防线 : R²=${mBoth.r2.toFixed(4)}  球=${mBoth.beta[1].toFixed(3)} 防线=${mBoth.beta[2].toFixed(3)}`);
  console.log(`    ⇒ 防线的**偏**解释力 = R²(球+防线) − R²(球) = ${(mBoth.r2 - mBall.r2).toFixed(4)}`);
  console.log(`    ⇒ 球的**偏**解释力   = R²(球+防线) − R²(防线) = ${(mBoth.r2 - mLine.r2).toFixed(4)}`);
  // 越位余量分布
  const ms = rows.map((r) => r.offMargin).sort((a, b) => a - b);
  const qq = (p) => ms[Math.floor((ms.length - 1) * p)];
  console.log(`    越位余量（正=越位）p10=${qq(0.1).toFixed(1)} 中位=${qq(0.5).toFixed(1)} p90=${qq(0.9).toFixed(1)}  标准差≈${Math.sqrt(mean(ms.map((v) => (v - mean(ms)) ** 2))).toFixed(1)}m`);
}

console.log('=== E 真实锋线位置：球 vs 对方防线，谁在约束？===');
analyse(build(realFrames), '真实 Metrica');
analyse(build(engineFrames), '引擎');
