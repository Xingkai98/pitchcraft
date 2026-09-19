// Wayfinder 探索探针 2：队形「瞬时形状」对比（修正版）
//
// 探针 1 的缺陷：真实侧槽位按**整场平均深度**分配，所以「槽位 4 的瞬时 x」不等于
// 「该帧第 4 深的球员 x」。本探针改为**每帧瞬时排序**后取次序统计量，两侧口径一致。
//
// 产出：每帧把 10 名非门将的 x 排序 → 取 10 个次序统计量 → 对帧取均值。
// 这是「典型瞬时形状」，直接可比。另给防线/中场/锋线的分线位置（用引擎的固定 id 分组，
// 真实侧用 Metrica 事件数据的球衣号分组不可得，故改用「前 4 深 / 中间 4 / 最前 2」的
// 次序分组——对两侧同样适用，是形状描述而非身份描述）。

import { readFileSync } from 'node:fs';
import {
  PITCH_LENGTH_M, BENCHMARK_SEEDS, ENGINE_DURATION_SEC,
  sampleEngineFrames, cutWindows, KEEPER_IDS,
} from '/home/happy/.claude/worktrees/wayfinder-realism/viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '/home/happy/.claude/worktrees/wayfinder-realism/tools/benchmark-engine.mjs';

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const qsorted = (s, p) => {
  const n = s.length;
  const h = (n - 1) * p;
  const lo = Math.floor(h); const hi = Math.ceil(h);
  return s[lo] + (h - lo) * (s[hi] - s[lo]);
};

// 该帧该队的 10 名非门将 x（米），升序
function outfieldXs(frame, team) {
  const isHome = team === 'home';
  const out = (frame.players || [])
    .filter((p) => p && !KEEPER_IDS.includes(p.id) && (isHome ? p.id <= 10 : p.id >= 11))
    .map((p) => p.x * PITCH_LENGTH_M);
  return out.length >= 7 ? out.sort((a, b) => a - b) : null;
}

// 客队镜像：把「离本方门线的距离」作为统一坐标
function teamXs(frame, team) {
  const xs = outfieldXs(frame, team);
  if (!xs) return null;
  return team === 'home' ? xs : xs.map((v) => PITCH_LENGTH_M - v).reverse();
}

const load = await loadEngineWasm(WASM_PATH);
if (!load.ok) { console.error(load.message); process.exit(1); }
const { createGame } = await import('/home/happy/.claude/worktrees/wayfinder-realism/viewer/game.js');

const engineFrames = [];
for (const seed of BENCHMARK_SEEDS.slice(0, 3)) {
  const game = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  for (const w of cutWindows(sampleEngineFrames(game))) engineFrames.push(...w);
}
const realFrames = [];
for (const f of ['1', '2']) {
  const g = JSON.parse(readFileSync(`/home/happy/.claude/worktrees/wayfinder-realism/viewer/data/real-game-${f}.json`, 'utf8'));
  const frames = g.frames.map((fr) => ({
    t: fr.t, ball: fr.ball || null,
    players: fr.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)),
  }));
  for (const w of cutWindows(frames)) realFrames.push(...w);
}

// 每帧的 10 个次序统计量 → 对帧取均值
function orderStats(frames) {
  const acc = Array.from({ length: 10 }, () => []);
  for (const f of frames) {
    for (const team of ['home', 'away']) {
      const xs = teamXs(f, team);
      if (!xs) continue;
      for (let i = 0; i < 10; i += 1) acc[i].push(xs[i]);
    }
  }
  return acc.map(mean);
}

const R = orderStats(realFrames);
const E = orderStats(engineFrames);

console.log('=== 瞬时次序统计量（每帧把 10 名非门将按「离本方门线距离」排序，再对帧取均值）===');
console.log('次序      真实    引擎     差');
for (let i = 0; i < 10; i += 1) {
  console.log(`  ${String(i + 1).padStart(2)}   ${R[i].toFixed(1).padStart(6)}  ${E[i].toFixed(1).padStart(6)}  ${(E[i] - R[i]).toFixed(1).padStart(6)}`);
}

console.log('\n=== 相邻次序间距（米）===');
console.log('次序对     真实    引擎     差');
for (let i = 1; i < 10; i += 1) {
  const gr = R[i] - R[i - 1]; const ge = E[i] - E[i - 1];
  console.log(`  ${i}→${i + 1}   ${gr.toFixed(1).padStart(6)}  ${ge.toFixed(1).padStart(6)}  ${(ge - gr).toFixed(1).padStart(6)}`);
}

console.log('\n=== 分块位置（次序 1-4 = 后块 / 5-8 = 中块 / 9-10 = 前块）===');
const blk = (p, a, b) => mean(p.slice(a, b));
for (const [name, P] of [['真实', R], ['引擎', E]]) {
  const back = blk(P, 0, 4); const mid = blk(P, 4, 8); const front = blk(P, 8, 10);
  console.log(`  ${name}  后块 ${back.toFixed(1)}  中块 ${mid.toFixed(1)}  前块 ${front.toFixed(1)}  |  后→中 ${(mid - back).toFixed(1)}  中→前 ${(front - mid).toFixed(1)}`);
}

console.log('\n=== 纵深（q10–q90，每帧算再取均值）===');
function depthStats(frames) {
  const v = [];
  for (const f of frames) {
    for (const team of ['home', 'away']) {
      const xs = teamXs(f, team);
      if (xs) v.push(qsorted(xs, 0.9) - qsorted(xs, 0.1));
    }
  }
  return { avg: mean(v), min: Math.min(...v), max: Math.max(...v), p25: qsorted([...v].sort((a, b) => a - b), 0.25), p75: qsorted([...v].sort((a, b) => a - b), 0.75), n: v.length };
}
const dr = depthStats(realFrames); const de = depthStats(engineFrames);
console.log(`  真实  ${dr.avg.toFixed(2)} [p25 ${dr.p25.toFixed(1)} – p75 ${dr.p75.toFixed(1)}]  全距 [${dr.min.toFixed(1)}–${dr.max.toFixed(1)}] n=${dr.n}`);
console.log(`  引擎  ${de.avg.toFixed(2)} [p25 ${de.p25.toFixed(1)} – p75 ${de.p75.toFixed(1)}]  全距 [${de.min.toFixed(1)}–${de.max.toFixed(1)}] n=${de.n}`);

// ── 球位置 → 纵深（弹性）────────────────────────────────────────────────
console.log('\n=== 弹性：球在本方后场 → 前场，纵深如何变化（主队）===');
function elasticity(frames, label) {
  const edges = [-0.2, 0.2, 0.4, 0.6, 0.8, 1.2];
  const acc = edges.slice(0, -1).map(() => []);
  for (const f of frames) {
    if (!f.ball || !Number.isFinite(f.ball[0])) continue;
    const b = f.ball[0];
    let bi = -1;
    for (let i = 0; i < acc.length; i += 1) if (b >= edges[i] && b < edges[i + 1]) { bi = i; break; }
    if (bi < 0) continue;
    const xs = outfieldXs(f, 'home');
    if (!xs) continue;
    acc[bi].push(qsorted(xs, 0.9) - qsorted(xs, 0.1));
  }
  const parts = acc.map((a, i) => (a.length > 50 ? `[${edges[i].toFixed(1)},${edges[i + 1].toFixed(1)}) ${mean(a).toFixed(1)}m` : `[${edges[i].toFixed(1)},${edges[i + 1].toFixed(1)}) —`));
  console.log(`  ${label}: ${parts.join('  ')}`);
  const full = acc.filter((a) => a.length > 50).map(mean);
  console.log(`     跨度 = ${(Math.max(...full) - Math.min(...full)).toFixed(1)}m`);
}
elasticity(realFrames, '真实');
elasticity(engineFrames, '引擎');
