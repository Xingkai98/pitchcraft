// 方案设计 agent（乙）探针 H：收尾的两件事
//   H1 滞后交叉相关：真实锋线是「跟着对方防线动」还是「跟着球动」？
//      （E 的偏 R² 有共线性隐患——三方都在随比赛整体移动。滞后能分离方向：
//       若"对方防线(t−1) → 我方锋线(t)"强于"球(t−1) → 我方锋线(t)"，则约束成立。）
//   H2 反事实：把候选机制挂在引擎自己的球/对手轨迹上，算目标集合纵深 —— 实现前先看落点。

import { readFileSync } from 'node:fs';
import {
  PITCH_LENGTH_M, BENCHMARK_SEEDS, ENGINE_DURATION_SEC, KEEPER_IDS,
  quantileSorted, sampleEngineFrames, cutWindows,
} from '/home/happy/.claude/worktrees/wayfinder-realism/viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '/home/happy/.claude/worktrees/wayfinder-realism/tools/benchmark-engine.mjs';

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const q = quantileSorted;
const depth = (xs) => { const s = [...xs].sort((a, b) => a - b); return q(s, 0.9) - q(s, 0.1); };

const load = await loadEngineWasm(WASM_PATH);
const { createGame } = await import('/home/happy/.claude/worktrees/wayfinder-realism/viewer/game.js');
const engineFrames = [];
for (const seed of BENCHMARK_SEEDS.slice(0, 3)) {
  const game = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  for (const w of cutWindows(sampleEngineFrames(game))) engineFrames.push(...w);
}
const realFrames = [];
for (const fn of ['1', '2']) {
  const g = JSON.parse(readFileSync(`/home/happy/.claude/worktrees/wayfinder-realism/viewer/data/real-game-${fn}.json`, 'utf8'));
  const frames = g.frames.map((fr) => ({ t: fr.t, ball: fr.ball || null, players: fr.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)) }));
  for (const w of cutWindows(frames)) realFrames.push(...w);
}

// 逐帧序列（连续 0.2s），供滞后分析
function series(frames) {
  const rows = [];
  for (let i = 0; i < frames.length; i += 1) {
    const f = frames[i];
    if (!f.ball || !Number.isFinite(f.ball[0])) continue;
    const t = { };
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
      t[team] = { u: us, ballU: (isHome ? f.ball[0] : 1 - f.ball[0]) * PITCH_LENGTH_M, dt: f.t };
    }
    if (t.home && t.away) rows.push(t);
  }
  return rows;
}
// 主队视角：my front = home.u[9]；opp line(换算到同一坐标「离我的门线」) = 105 - away.u[1]；
// 注意 away.u[1] 是离 away 门线的距离，而 away 门线 = 我攻向的门线 → 离我的门线 = 105 - away.u[1]
function pairs(rows) {
  return rows.map((r) => ({
    front: r.home.u[9],
    oline: PITCH_LENGTH_M - r.away.u[1],
    ball: r.home.ballU,
    t: r.home.dt,
  }));
}
function dcorr(a, b, lag) { // corr(Δa(t), Δb(t-lag))
  const A = []; const B = [];
  for (let i = Math.max(1, lag); i < a.length; i += 1) {
    if (a[i].t - a[i - 1].t > 0.35) continue;
    const j = i - lag;
    if (j < 1 || b[j].t - b[j - 1].t > 0.35) continue;
    A.push(a[i].front - a[i - 1].front);
    B.push(b[j].front - b[j - 1].front);
  }
  const ma = mean(A); const mb = mean(B);
  let sab = 0; let sa = 0; let sb = 0;
  for (let i = 0; i < A.length; i += 1) { sab += (A[i] - ma) * (B[i] - mb); sa += (A[i] - ma) ** 2; sb += (B[i] - mb) ** 2; }
  return { r: sab / Math.sqrt(sa * sb), n: A.length };
}

console.log('=== H1 滞后交叉相关：Δ我方锋线(t) vs ΔX(t−lag) ===');
function lagTest(rows, label, field, fieldName) {
  const out = [];
  for (const lag of [1, 2, 3, 5]) out.push(`${lag}拍=${dcorr(rows, rows.map((r) => ({ ...r, front: r[field] })), lag).r.toFixed(3)}`);
  console.log(`  ${label} 预测变量=${fieldName}: ${out.join('  ')}`);
}
const R = pairs(series(realFrames));
const E = pairs(series(engineFrames));

// 重新写：需要 a=锋线序列，b=预测变量序列
function dcorr2(aFront, bVar, lag) {
  const A = []; const B = [];
  for (let i = Math.max(1, lag); i < aFront.length; i += 1) {
    const j = i - lag;
    if (aFront[i].t - aFront[i - 1].t > 0.35) continue;
    if (j < 1 || bVar[j].t - bVar[j - 1].t > 0.35) continue;
    A.push(aFront[i].front - aFront[i - 1].front);
    B.push(bVar[j].front - bVar[j - 1].front);
  }
  const ma = mean(A); const mb = mean(B);
  let sab = 0; let sa = 0; let sb = 0;
  for (let i = 0; i < A.length; i += 1) { sab += (A[i] - ma) * (B[i] - mb); sa += (A[i] - ma) ** 2; sb += (B[i] - mb) ** 2; }
  return { r: sab / Math.sqrt(sa * sb), n: A.length };
}
for (const [name, S] of [['真实', R], ['引擎', E]]) {
  const front = S.map((r) => ({ front: r.front, t: r.t }));
  const olineToFront = S.map((r) => ({ front: r.oline, t: r.t }));
  const ballToFront = S.map((r) => ({ front: r.ball, t: r.t }));
  const parts = [];
  for (const lag of [1, 2, 3, 5, 10]) {
    parts.push(`lag${lag}: 防线领先=${dcorr2(front, olineToFront, lag).r.toFixed(3)} 球领先=${dcorr2(front, ballToFront, lag).r.toFixed(3)}`);
  }
  console.log(`  ${name}`);
  for (const p of parts) console.log(`    ${p}   (n=${dcorr2(front, ballToFront, 1).n})`);
}

// ── H2 反事实 ─────────────────────────────────────────────────────
console.log('\n=== H2 反事实：候选机制下的目标集合纵深（挂在引擎自己的球/对手轨迹上）===');
const TPL = [0.14, 0.18, 0.20, 0.18, 0.40, 0.42, 0.42, 0.40, 0.62, 0.62];
const obsE = []; const obsR = [];
for (const { rows } of [{ rows: [] }]) break;
{
  const rowsE = [];
  for (const f of engineFrames) {
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
      if (us.length >= 7) rowsE.push({ xs: us, ballU: (isHome ? f.ball[0] : 1 - f.ball[0]) * PITCH_LENGTH_M });
    }
  }
  for (const r of rowsE) obsE.push(depth(r.xs));
  const rowsR = [];
  for (const f of realFrames) {
    if (!f.ball || !Number.isFinite(f.ball[0])) continue;
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
      if (us.length >= 7) rowsR.push({ xs: us, ballU: (isHome ? f.ball[0] : 1 - f.ball[0]) * PITCH_LENGTH_M });
    }
  }
  for (const r of rowsR) obsR.push(depth(r.xs));
  console.log(`  观测基准：引擎 ${mean(obsE).toFixed(1)}m   真实 ${mean(obsR).toFixed(1)}m`);

  function cand(name, fn) {
    const ds = []; const byBall = new Map();
    for (const r of rowsE) {
      const bx = r.ballU / 105;
      const g = fn(bx);
      const xs = g.map((v) => v * 105);
      ds.push(depth(xs));
      const k = Math.min(4, Math.floor(r.ballU / 21));
      if (!byBall.has(k)) byBall.set(k, []);
      byBall.get(k).push(depth(xs));
    }
    const b = [...byBall.entries()].sort((x, y) => x[0] - y[0]).map(([, v]) => mean(v));
    console.log(`  ${name.padEnd(40)} 纵深 ${mean(ds).toFixed(1)}m  弹性 ${(Math.max(...b) - Math.min(...b)).toFixed(1)}m`);
  }
  // 现状复刻
  cand('现状（模板 + clamp + g_def=0.12）', (bx) => TPL.map((base, i) => {
    const sh = (bx - 0.5) * 0.06; const press = 0.02;
    if (i >= 4) return Math.min(0.9, Math.max(0.04, base + sh + press));
    return Math.min(0.9, Math.max(0.04, Math.min(Math.max(base + sh + press + Math.abs(bx) * 0.12, base), bx)));
  }));
  // 块模型：块中心随球平移 g，块内相对偏移固定（K = 压缩系数）
  for (const [g, K] of [[0.59, 0.55], [0.59, 0.6], [0.5, 0.55]]) {
    cand(`块模型 g=${g} K=${K}`, (bx) => {
      const center = 0.115 + g * bx;
      return TPL.map((v) => center + (v - 0.38) * K);
    });
  }
}
