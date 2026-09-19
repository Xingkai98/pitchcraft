// 方案设计 agent（乙）探针 B3：**修正后的目标形状** + 「目标能否解释观测」的决定性测试
//
// B2 的 bug：default_lineup 的元组是 (y, x)，我按 [x, y] 读了 → x/y 互换。
// 本探针修正后回答三个问题：
//   Q1 纯目标公式（无运动学）的形状随球怎么变？纵深跨度多少？
//   Q2 把**观测到的球位**代进目标公式，得到的「理想形状纵深」 vs 「实际观测纵深」——
//      若接近 ⇒ 队形差就是目标公式的形状差，运动学（速度/节拍/死区）不是主因。
//   Q3 真实球队是不是「整体平移」而引擎是「原地拉伸」？量化：防线高度 vs 球位 的斜率。

import { readFileSync } from 'node:fs';
import {
  PITCH_LENGTH_M, BENCHMARK_SEEDS, ENGINE_DURATION_SEC, KEEPER_IDS,
  quantileSorted, sampleEngineFrames, cutWindows,
} from '/home/happy/.claude/worktrees/wayfinder-realism/viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '/home/happy/.claude/worktrees/wayfinder-realism/tools/benchmark-engine.mjs';

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const q = quantileSorted;

// ── default_lineup 修正版（元组是 (y, x)）──────────────────────────
const HOME_X = { 0: 0.02, 1: 0.18, 2: 0.20, 3: 0.18, 4: 0.14, 5: 0.40, 6: 0.42, 7: 0.42, 8: 0.40, 9: 0.62, 10: 0.62 };
const HOME_Y = { 0: 0.50, 1: 0.30, 2: 0.50, 3: 0.70, 4: 0.50, 5: 0.20, 6: 0.40, 7: 0.60, 8: 0.80, 9: 0.35, 10: 0.65 };
const DEFENDERS = [1, 2, 3, 4];
const OUTFIELD = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const SIDE_SHIFT_FACTOR = 0.06, DEFENSE_PUSH_FACTOR = 0.12, PRESS_UP_OFFSET = 0.02;

function formationTarget(id, ball, { homeHasBall = true, transition = false } = {}) {
  const bx = bX(ball); const by = bY(ball);
  const baseX = HOME_X[id]; const baseY = HOME_Y[id];
  const shift = (bx - 0.5) * SIDE_SHIFT_FACTOR;
  let press = homeHasBall ? PRESS_UP_OFFSET : -PRESS_UP_OFFSET;
  if (transition) press *= 2.0;
  let tx = baseX + shift + press;
  if (DEFENDERS.includes(id)) {
    const push = Math.abs(bx - 0.0) * DEFENSE_PUSH_FACTOR;
    const txFull = baseX + shift + press + push;
    tx = Math.max(Math.min(txFull, bx), baseX); // Rust: tx_full.min(ball).max(base)
  }
  const ty = baseY + (by - 0.5) * SIDE_SHIFT_FACTOR * 0.6;
  return [Math.min(0.9, Math.max(0.04, clamp01(tx))), clamp01(ty)];
}
// ball 可能是 [x,y] 或 {x,y}
const bX = (b) => (Array.isArray(b) ? b[0] : b.x);
const bY = (b) => (Array.isArray(b) ? b[1] : b.y);

const targetXs = (ball, opts) => OUTFIELD.map((id) => formationTarget(id, ball, opts)[0] * PITCH_LENGTH_M);
const depth = (xs) => q([...xs].sort((a, b) => a - b), 0.9) - q([...xs].sort((a, b) => a - b), 0.1);

// ── Q1 纯目标形状 ─────────────────────────────────────────────────
console.log('=== Q1 纯目标形状（无运动学，主队持球）===');
console.log(' 球x(m)   后卫线   中场线   前锋线   目标纵深');
for (const bx of [0.02, 0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 1.0]) {
  const xs = targetXs([bx, 0.5], {});
  const back = mean(xs.slice(0, 4)); const mid = mean(xs.slice(4, 8)); const front = mean(xs.slice(8, 10));
  console.log(`  ${(bx * 105).toFixed(1).padStart(6)}  ${back.toFixed(1).padStart(7)}  ${mid.toFixed(1).padStart(7)}  ${front.toFixed(1).padStart(7)}  ${depth(xs).toFixed(1).padStart(8)}`);
}
const dAll = [0.02, 0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 1.0].map((bx) => depth(targetXs([bx, 0.5], {})));
console.log(`  → 目标纵深跨度 = ${(Math.max(...dAll) - Math.min(...dAll)).toFixed(1)}m   （真实弹性 10.3m，引擎实测 31.6m）`);
// 静止队形（无球影响）：球在中线、主队持球
console.log(`  静止模板纵深（球 x=0.5 主队持球）= ${depth(targetXs([0.5, 0.5], {})).toFixed(1)}m`);
console.log(`  模板原始纵深（x 0.14→0.62）= ${((0.62 - 0.14) * 105).toFixed(1)}m`);

// ── Q2 目标能否解释观测 ────────────────────────────────────────────
const load = await loadEngineWasm(WASM_PATH);
if (!load.ok) { console.error(load.message); process.exit(1); }
const { createGame } = await import('/home/happy/.claude/worktrees/wayfinder-realism/viewer/game.js');

const engineFrames = [];
for (const seed of BENCHMARK_SEEDS.slice(0, 3)) {
  const game = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  for (const w of cutWindows(sampleEngineFrames(game))) engineFrames.push(...w);
}

// 观测纵深 vs 理想目标纵深（同一球位）
{
  const obs = []; const ideal = []; const idealDef = [];
  const idealAtk = []; const obsAtk = [];
  const idealDefend = []; const obsDefend = [];
  for (const f of engineFrames) {
    if (!f.ball) continue;
    const xs = f.players.filter((p) => p && !KEEPER_IDS.includes(p.id) && p.id <= 10).map((p) => p.x * PITCH_LENGTH_M);
    if (xs.length < 7) continue;
    // 控球代理：离球最近者（含门将）
    let bi = -1; let bd = Infinity;
    for (const p of f.players) {
      if (!p) continue;
      const dx = (p.x - f.ball[0]) * PITCH_LENGTH_M; const dy = (p.y - f.ball[1]) * 68;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; bi = p.id; }
    }
    const homeHas = bi <= 10;
    const ix = targetXs(f.ball, { homeHasBall: homeHas });
    obs.push(depth(xs)); ideal.push(depth(ix));
    if (homeHas) { idealAtk.push(depth(ix)); obsAtk.push(depth(xs)); } else { idealDefend.push(depth(ix)); obsDefend.push(depth(xs)); }
  }
  console.log('\n=== Q2 观测纵深 vs 理想目标纵深（同一球位代入公式，主队，全部相位）===');
  console.log(`  观测（采样位置）      ${mean(obs).toFixed(2)}m   n=${obs.length}`);
  console.log(`  理想（目标公式）      ${mean(ideal).toFixed(2)}m`);
  console.log(`  → 差 ${(mean(obs) - mean(ideal)).toFixed(2)}m（≈0 ⇒ 目标即形状；>0 ⇒ 有滞后/跟随成分）`);
  console.log(`  分相位：主队控球 观测 ${mean(obsAtk).toFixed(2)} vs 理想 ${mean(idealAtk).toFixed(2)} (n=${obsAtk.length})`);
  console.log(`          对方控球 观测 ${mean(obsDefend).toFixed(2)} vs 理想 ${mean(idealDefend).toFixed(2)} (n=${obsDefend.length})`);
  // 逐帧差的中位数（避免相位混叠）
  const diffs = obs.map((o, i) => o - ideal[i]).sort((a, b) => a - b);
  console.log(`  逐帧差 中位=${q(diffs, 0.5).toFixed(2)}m  p10=${q(diffs, 0.1).toFixed(2)}  p90=${q(diffs, 0.9).toFixed(2)}`);
}

// ── Q3 平移 vs 拉伸（真实 Metrica 对照）──────────────────────────
console.log('\n=== Q3 平移 vs 拉伸：防线高度 对 球位 的响应 ===');
function lineTable(frames, label, mode) {
  const edges = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
  const acc = edges.slice(0, -1).map(() => ({ back: [], front: [] }));
  for (const f of frames) {
    if (!f.ball) continue;
    const bi = Math.min(acc.length - 1, Math.max(0, Math.floor(f.ball[0] * 5)));
    const ps = [];
    for (let id = 0; id < 11; id += 1) {
      const p = f.players[id];
      if (!p || KEEPER_IDS.includes(id)) continue;
      ps.push({ id, x: p.x * PITCH_LENGTH_M });
    }
    if (ps.length < 7) continue;
    ps.sort((a, b) => a.x - b.x);
    if (mode === 'id') {
      const b = ps.filter((p) => p.id >= 1 && p.id <= 4); const fr = ps.filter((p) => p.id >= 9);
      if (!b.length || !fr.length) continue;
      acc[bi].back.push(mean(b.map((p) => p.x))); acc[bi].front.push(mean(fr.map((p) => p.x)));
    } else {
      acc[bi].back.push(mean(ps.slice(0, 4).map((p) => p.x)));
      acc[bi].front.push(mean(ps.slice(-2).map((p) => p.x)));
    }
  }
  const rows = acc.map((a, i) => (a.back.length > 30 ? { lo: (edges[i] * 105).toFixed(0), hi: (edges[i + 1] * 105).toFixed(0), b: mean(a.back), f: mean(a.front), n: a.back.length } : null)).filter(Boolean);
  console.log(`  ${label}:`);
  for (const r of rows) console.log(`    球 [${r.lo}-${r.hi})m  防线 ${r.b.toFixed(1)}  锋线 ${r.f.toFixed(1)}  跨度 ${(r.f - r.b).toFixed(1)}`);
  if (rows.length >= 2) {
    console.log(`    → 防线随球位移 ${(rows[rows.length - 1].b - rows[0].b).toFixed(1)}m，锋线 ${(rows[rows.length - 1].f - rows[0].f).toFixed(1)}m（平移度）`);
    console.log(`    → 跨度变化 ${(rows[rows.length - 1].f - rows[rows.length - 1].b - (rows[0].f - rows[0].b)).toFixed(1)}m（拉伸度）`);
  }
}
lineTable(engineFrames, '引擎（防线=id1-4 / 锋线=id9-10）', 'id');
const realFrames = [];
for (const fn of ['1', '2']) {
  const g = JSON.parse(readFileSync(`/home/happy/.claude/worktrees/wayfinder-realism/viewer/data/real-game-${fn}.json`, 'utf8'));
  const frames = g.frames.map((fr) => ({ t: fr.t, ball: fr.ball || null, players: fr.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)) }));
  for (const w of cutWindows(frames)) realFrames.push(...w);
}
lineTable(realFrames, '真实 Metrica（防线=最深4 / 锋线=最前2）', 'order');
