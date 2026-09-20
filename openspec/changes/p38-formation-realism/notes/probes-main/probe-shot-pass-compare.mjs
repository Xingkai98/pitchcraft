// P38 #89：**真实 vs 引擎**的「持球决策」几何剖面 —— 同一张标定表，两套数据。
//
// `probe-real-shot-pass.mjs` 给出真实侧；本脚本把**引擎侧**算成同一个形状，
// 于是「引擎的决策规则长什么样」变成可读的数字，而不是读 Rust 源码去猜。
//
// 引擎侧口径：取引擎事件流里的**持球决策事件**（普通射门 + 开放比赛传球），
// 在事件时刻算与真实侧**逐字相同**的几何量（dGoal / d1 / d2 / …）。
// 排除重开球派生（corner / throw_in / free_kick / header）——那些不是「持球者选射还是传」。
//
// 用法：node probe-shot-pass-compare.mjs [标签]
// 环境：SEEDS=42,1,7,99,123,2,3,5,11,17

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findRepoRoot } from '../probes/repo-root.mjs';
import { KEEPER_IDS, PITCH_LENGTH_M, PITCH_WIDTH_M, ENGINE_DURATION_SEC }
  from '../../../../../viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '../../../../../tools/benchmark-engine.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = findRepoRoot(HERE);
const label = process.argv[2] || 'current';
const seeds = (process.env.SEEDS || '42,1,7,99,123,2,3,5,11,17').split(',').map(Number);

const dist = (ax, ay, bx, by) => Math.hypot((ax - bx) * PITCH_LENGTH_M, (ay - by) * PITCH_WIDTH_M);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

function features(frame, carrierId, isHome) {
  const c = frame.players[carrierId];
  if (!c) return null;
  const [cx, cy] = [c.x, c.y];
  const goalX = isHome ? 1.0 : 0.0;
  const dGoal = dist(cx, cy, goalX, 0.5);
  const dx = (isHome ? 1.0 - cx : cx) * PITCH_LENGTH_M;
  const dy = (isHome ? 0.5 - cy : cy - 0.5) * PITCH_WIDTH_M;
  const angleCos = (dx === 0 && dy === 0) ? 1.0 : dx / Math.hypot(dx, dy);
  const opp = []; const mate = [];
  for (const p of frame.players) {
    if (!p) continue;
    if (KEEPER_IDS.includes(p.id)) continue;
    const d = dist(cx, cy, p.x, p.y);
    (p.id <= 10 === isHome ? mate : opp).push({ d, depth: (isHome ? p.x - cx : cx - p.x) * PITCH_LENGTH_M });
  }
  opp.sort((a, b) => a.d - b.d); mate.sort((a, b) => a.d - b.d);
  return {
    dGoal,
    angleCos,
    d1: opp.length ? opp[0].d : NaN,
    d2: opp.length > 1 ? opp[1].d : NaN,
    nOpp8: opp.filter((o) => o.d <= 8).length,
    nOpp16: opp.filter((o) => o.d <= 16).length,
    oppGoalSide: opp.filter((o) => o.depth > 0 && o.depth <= 15).length,
    mateDist: mate.length ? mate[0].d : NaN,
    nMate10: mate.filter((m) => m.d <= 10).length,
    inBox: (Math.abs(cx - goalX) * PITCH_LENGTH_M <= 16.5 && Math.abs(cy - 0.5) * PITCH_WIDTH_M <= 20.16) ? 1 : 0,
  };
}

// ── 引擎侧：跑 10 种子，提取持球决策事件的几何 ──────────────────────────
const load = await loadEngineWasm(WASM_PATH);
if (!load.ok) { console.error(load.message); process.exit(1); }
const { createGame } = await import(`${ROOT}/viewer/game.js`);
const { sampleEngineFrames } = await import(`${ROOT}/viewer/match-metrics.js`);

const RESTART = new Set(['corner', 'throw_in', 'free_kick', 'header']);
const engineRows = [];
let crashed = 0;
for (const seed of seeds) {
  const stream = simulateStream(load.wasm, seed, ENGINE_DURATION_SEC);
  let game;
  try { game = createGame(stream); } catch { crashed += 1; continue; }
  const frames = sampleEngineFrames(game);
  for (const e of JSON.parse(stream)) {
    const isShot = e.type === 'shot' && e.detail !== 'header';
    const isPass = e.type === 'pass' && !RESTART.has(e.detail);
    if (!isShot && !isPass) continue;
    if (e.x == null || e.subject == null) continue;
    let best = null;
    for (const f of frames) { const d = Math.abs(f.t - e.t); if (!best || d < best.d) best = { d, f }; }
    if (!best || best.d > 1.0) continue;
    const ft = features(best.f, e.subject, e.subject <= 10);
    if (!ft || !Number.isFinite(ft.d1)) continue;
    engineRows.push({ action: isShot ? 'shot' : 'pass', ...ft });
  }
}
if (crashed) console.log(`⚠ ${crashed}/${seeds.length} 种子崩溃`);

// ── 真实侧 ──────────────────────────────────────────────────────────────
const realPath = join(HERE, 'out/real-shot-pass.jsonl');
if (!existsSync(realPath)) { console.error(`缺 ${realPath}，先跑 probe-real-shot-pass.mjs`); process.exit(1); }
const realRows = readFileSync(realPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

mkdirSync(join(HERE, 'out'), { recursive: true });
writeFileSync(join(HERE, `out/engine-shot-pass-${label}.jsonl`),
  `${engineRows.map((r) => JSON.stringify(r)).join('\n')}\n`);

// ── 同一张表：P(射门 | dGoal 桶 × d1 桶) ───────────────────────────────
const goalBins = [[0, 11], [11, 16.5], [16.5, 22], [22, 30]];
const d1Bins = [[0, 2], [2, 4], [4, 8], [8, 999]];
const table = (rows, title) => {
  console.log(`\n── ${title}（射程内 n=${rows.filter((r) => r.dGoal <= 30).length}）`);
  const head = `  ${'dGoal\\d1'.padEnd(12)}${d1Bins.map(([a, b]) => (b === 999 ? `>${a}m` : `${a}–${b}m`).padStart(14)).join('')}`;
  console.log(head);
  for (const [glo, ghi] of goalBins) {
    let line = `  ${`${glo}–${ghi}m`.padEnd(12)}`;
    for (const [dlo, dhi] of d1Bins) {
      const sub = rows.filter((r) => r.dGoal >= glo && r.dGoal < ghi && r.d1 >= dlo && r.d1 < dhi);
      const s = sub.filter((r) => r.action === 'shot').length;
      line += (sub.length === 0 ? '—' : `${(100 * s / sub.length).toFixed(0)}% (${s}/${sub.length})`).padStart(14);
    }
    console.log(line);
  }
};
console.log('=== P(射门 | 到球门距离 × 最近防守者距离) ===');
table(realRows, '真实 Metrica ×2');
table(engineRows, `引擎 ${label} ×${seeds.length} 种子`);

// ── 边缘分布：门在真实数据上会掐掉多少 ─────────────────────────────────
console.log('\n[边缘：持球决策时刻的几何分布]');
const stat = (rows, name) => {
  const s = (k) => [...rows.map((r) => r[k]).filter(Number.isFinite)].sort((a, b) => a - b);
  const q = (a, p) => { const h = (a.length - 1) * p; const lo = Math.floor(h); const hi = Math.ceil(h); return a[lo] + (h - lo) * (a[hi] - a[lo]); };
  console.log(`  ${name.padEnd(22)} d1 中位 ${q(s('d1'), 0.5).toFixed(1)}m  `
    + `d1≤8 占比 ${(100 * rows.filter((r) => r.d1 <= 8).length / rows.length).toFixed(0)}%  `
    + `dGoal≤16.5 占比 ${(100 * rows.filter((r) => r.dGoal <= 16.5).length / rows.length).toFixed(0)}%  `
    + `dGoal≤22 占比 ${(100 * rows.filter((r) => r.dGoal <= 22).length / rows.length).toFixed(0)}%`);
};
stat(realRows, '真实');
stat(engineRows, `引擎 ${label}`);

// ★ 关键量：真实球员「贴身（d1≤4m）」的决策里有多少是射门，按射程分层
console.log('\n[★ 贴身（d1 ≤ 4m）时，射门占该射程段决策的比例]');
for (const [glo, ghi] of [[0, 11], [11, 16.5], [16.5, 22], [22, 30], [30, 55]]) {
  const cell = (rows) => {
    const sub = rows.filter((r) => r.d1 <= 4 && r.dGoal >= glo && r.dGoal < ghi);
    const s = sub.filter((r) => r.action === 'shot').length;
    return sub.length ? `${(100 * s / sub.length).toFixed(0)}% (${s}/${sub.length})` : '—';
  };
  console.log(`  dGoal ${String(glo).padStart(2)}–${String(ghi).padEnd(4)}m   真实 ${cell(realRows).padEnd(16)} 引擎 ${cell(engineRows)}`);
}
