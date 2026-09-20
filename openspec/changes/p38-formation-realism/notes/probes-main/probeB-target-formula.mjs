// 方案设计 agent（乙）探针 B2：**目标形状 vs 跟随滞后**的分离
//
// B1 的困惑：事件流里 mover 的 to_x 分布 vs 采样到的实际位置对不上。
// 本探针做两件正交的事：
//   (1) 把 formation_target **在 JS 里忠实复刻**，扫描球位 → 得到「纯目标形状」随球怎么变。
//       这是无运动学、无滞后的理想形状。
//   (2) 读事件流里 id=9/10（前锋）与 id=1..4（后卫）**实际发射的 mover.to_x**，
//       看它们落在哪 —— 若与 (1) 复刻的公式区间不符，说明还有别的机制在改写目标。

import {
  PITCH_LENGTH_M, BENCHMARK_SEEDS, ENGINE_DURATION_SEC,
  quantileSorted,
} from '../../../../../viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '../../../../../tools/benchmark-engine.mjs';

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const span = (xs) => {
  if (xs.length < 3) return null;
  const s = [...xs].sort((a, b) => a - b);
  return quantileSorted(s, 0.9) - quantileSorted(s, 0.1);
};

// ── (1) formation_target 忠实复刻（engine/src/lib.rs:2631）────────────────
const SIDE_SHIFT_FACTOR = 0.06;
const DEFENSE_PUSH_FACTOR = 0.12;
const PRESS_UP_OFFSET = 0.02;
// default_lineup home（id: x,y）
const HOME = [
  [0.5, 0.02], // 0 GK
  [0.3, 0.18], [0.5, 0.20], [0.7, 0.18], [0.5, 0.14], // 1-4 后卫
  [0.2, 0.40], [0.4, 0.42], [0.6, 0.42], [0.8, 0.40], // 5-8 中场
  [0.35, 0.62], [0.65, 0.62], // 9-10 前锋
];
const DEFENDERS = [1, 2, 3, 4];
const clamp01 = (v) => Math.min(1, Math.max(0, v));

function formationTarget(id, ball, { homeHasBall = true, transition = false } = {}) {
  const base = HOME[id];
  const home = true;
  const attackDir = 1.0;
  const shift = (ball[0] - 0.5) * SIDE_SHIFT_FACTOR;
  let press = homeHasBall ? PRESS_UP_OFFSET : -PRESS_UP_OFFSET;
  if (transition) press *= 2.0;
  let tx = base[0] + shift + attackDir * press;
  if (DEFENDERS.includes(id)) {
    const ownGoalX = 0.0;
    const push = Math.abs(ball[0] - ownGoalX) * DEFENSE_PUSH_FACTOR;
    const txFull = base[0] + shift + attackDir * press + attackDir * push;
    tx = Math.min(Math.max(txFull, base[0]), ball[0]); // home: tx_full.min(ball).max(base)
  }
  const ty = base[1] + (ball[1] - 0.5) * SIDE_SHIFT_FACTOR * 0.6;
  return [Math.min(0.9, Math.max(0.04, clamp01(tx))), clamp01(ty)];
}

const OUTFIELD = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
function targetProfile(ball, opts) {
  const xs = OUTFIELD.map((id) => formationTarget(id, ball, opts)[0] * PITCH_LENGTH_M);
  return xs;
}

console.log('=== (1) 纯目标形状（无运动学）随球 x 的变化 [主队持球] ===');
console.log('球x(归) 球x(m)  后卫线   中场线   前锋线   纵深q10-q90  队宽(最前-最深)');
for (const bx of [0.02, 0.08, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95, 1.0]) {
  const xs = targetProfile([bx, 0.5], {});
  const back = mean(xs.slice(0, 4)); const mid = mean(xs.slice(4, 8)); const front = mean(xs.slice(8, 10));
  const s = [...xs].sort((a, b) => a - b);
  const d = quantileSorted(s, 0.9) - quantileSorted(s, 0.1);
  console.log(`  ${bx.toFixed(2)}  ${(bx * 105).toFixed(1).padStart(6)}  ${back.toFixed(1).padStart(6)}  ${mid.toFixed(1).padStart(7)}  ${front.toFixed(1).padStart(7)}  ${d.toFixed(1).padStart(12)}  ${(s[9] - s[0]).toFixed(1).padStart(14)}`);
}
const dEff = [0.02, 0.08, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95, 1.0].map((bx) => {
  const xs = targetProfile([bx, 0.5], {}); const s = [...xs].sort((a, b) => a - b);
  return quantileSorted(s, 0.9) - quantileSorted(s, 0.1);
});
console.log(`  → 目标纵深跨度（纯公式，随球）= ${(Math.max(...dEff) - Math.min(...dEff)).toFixed(1)}m`);

// ── (2) 事件流里实际发射的 mover.to_x ──────────────────────────────
const load = await loadEngineWasm(WASM_PATH);
if (!load.ok) { console.error(load.message); process.exit(1); }

console.log('\n=== (2) 引擎实际发射的 mover.to_x 分布（主队 id）===');
for (const seed of BENCHMARK_SEEDS.slice(0, 2)) {
  const stream = JSON.parse(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  const events = Array.isArray(stream) ? stream : stream.events;
  const acc = new Map();
  for (const ev of events) {
    if (!ev || ev.type !== 'beat' || !Array.isArray(ev.movers)) continue;
    for (const m of ev.movers) {
      if (m.id < 0 || m.id > 10) continue;
      const k = `${m.action}`;
      if (!acc.has(k)) acc.set(k, []);
      acc.get(k).push(m.to_x * PITCH_LENGTH_M);
    }
  }
  console.log(`seed ${seed}:`);
  for (const id of [1, 2, 9, 10]) {
    const vals = [];
    for (const ev of events) {
      if (!ev || ev.type !== 'beat' || !Array.isArray(ev.movers)) continue;
      for (const m of ev.movers) if (m.id === id) vals.push(m.to_x * PITCH_LENGTH_M);
    }
    if (!vals.length) { console.log(`  id ${id}: 无 mover`); continue; }
    const s = [...vals].sort((a, b) => a - b);
    console.log(`  id ${id} (${id <= 4 ? '后卫' : '前锋'}) n=${vals.length}  min=${s[0].toFixed(1)} p10=${quantileSorted(s, 0.1).toFixed(1)} 中位=${quantileSorted(s, 0.5).toFixed(1)} p90=${quantileSorted(s, 0.9).toFixed(1)} max=${s[s.length - 1].toFixed(1)}`);
  }
  const acts = [...acc.entries()].map(([k, v]) => {
    const s = v.sort((a, b) => a - b);
    return { k, n: v.length, p10: quantileSorted(s, 0.1), p50: quantileSorted(s, 0.5), p90: quantileSorted(s, 0.9) };
  }).sort((a, b) => b.n - a.n).slice(0, 8);
  console.log('  action 分布:');
  for (const a of acts) console.log(`    ${a.k.padEnd(14)} n=${String(a.n).padStart(6)}  to_x p10=${a.p10.toFixed(1)} 中位=${a.p50.toFixed(1)} p90=${a.p90.toFixed(1)}`);
}
