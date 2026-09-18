// P38 结构健康检查：判定一个改动是「真修复」还是「拟合均值」
//
// 动机：实验 2（只改 DEFENSE_PUSH_FACTOR 0.12→0.45）让**全部四项指标**落到 Metrica 目标。
// 单常数拟合四项均值 = 典型的 hack 征兆。本脚本用**结构判据**判定它。
//
// 结构判据（都不在 P36 的三项采用指标里）：
//   S1 断层：相邻次序间距的最大值（真实 5.2m；基线引擎 19.2m）
//   S2 逐槽位移动比：中场 x-sd / 后防 x-sd（真实 1.08；基线引擎 2.55）
//   S3 横向移动：后防 y-sd（真实 22.8m；基线引擎 5.2m）
//   S4 块跨度形状：纵深随球位的曲线是否 U 形（真实近平；基线引擎 51.6→40.2→65.4）
//   S5 锋线回防：球在 x∈[0,21)m 时最前一人位置（真实 39.3m；基线引擎 51.3m）
//   S6 弹性跨度：纵深随球位跨度的极差（真实 10.3m；基线引擎 31.6m）
//
// 用法：node structural-check.mjs <label>

import { readFileSync } from 'node:fs';
import {
  PITCH_LENGTH_M, PITCH_WIDTH_M, BENCHMARK_SEEDS, ENGINE_DURATION_SEC,
  sampleEngineFrames, cutWindows, KEEPER_IDS,
} from '/home/happy/.claude/worktrees/wayfinder-realism/viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '/home/happy/.claude/worktrees/wayfinder-realism/tools/benchmark-engine.mjs';

const label = process.argv[2] || 'current';
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const qsorted = (s, p) => { const h = (s.length - 1) * p; const lo = Math.floor(h); const hi = Math.ceil(h); return s[lo] + (h - lo) * (s[hi] - s[lo]); };

function teamXs(frame, team) {
  const isHome = team === 'home';
  const out = (frame.players || [])
    .filter((p) => p && !KEEPER_IDS.includes(p.id) && (isHome ? p.id <= 10 : p.id >= 11))
    .map((p) => p.x * PITCH_LENGTH_M);
  if (out.length < 7) return null;
  const xs = out.sort((a, b) => a - b);
  return team === 'home' ? xs : xs.map((v) => PITCH_LENGTH_M - v).reverse();
}

function outfield(frame, team) {
  const isHome = team === 'home';
  return (frame.players || []).filter((p) => p && !KEEPER_IDS.includes(p.id) && (isHome ? p.id <= 10 : p.id >= 11));
}

const load = await loadEngineWasm(WASM_PATH);
const { createGame } = await import('/home/happy/.claude/worktrees/wayfinder-realism/viewer/game.js');
const E = [];
for (const seed of BENCHMARK_SEEDS.slice(0, 3)) {
  const game = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  for (const w of cutWindows(sampleEngineFrames(game))) E.push(...w);
}
const R = [];
for (const f of ['1', '2']) {
  const g = JSON.parse(readFileSync(`/home/happy/.claude/worktrees/wayfinder-realism/viewer/data/real-game-${f}.json`, 'utf8'));
  const frames = g.frames.map((fr) => ({ t: fr.t, ball: fr.ball || null, players: fr.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)) }));
  for (const w of cutWindows(frames)) R.push(...w);
}

function analyze(frames) {
  // S1 断层 + S6 弹性 + S4 块跨度形状 + S5 锋线回防
  const acc = Array.from({ length: 10 }, () => []);
  const spanByBall = [[], [], [], [], []];
  const frontInOwnBox = [];
  const edges = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
  for (const f of frames) {
    for (const team of ['home', 'away']) {
      const xs = teamXs(f, team);
      if (!xs) continue;
      for (let i = 0; i < 10; i += 1) acc[i].push(xs[i]);
      if (!f.ball || !Number.isFinite(f.ball[0])) continue;
      const bx = team === 'home' ? f.ball[0] : 1 - f.ball[0];
      const bi = Math.max(0, Math.min(4, Math.floor(bx * 5)));
      spanByBall[bi].push(xs[9] - xs[0]);
      if (bx < 0.2) frontInOwnBox.push(xs[9]);
    }
  }
  const P = acc.map(mean);
  const gaps = P.slice(1).map((v, i) => v - P[i]);
  // S2/S3 逐槽位移动
  const byId = new Map();
  for (const f of frames) {
    for (const team of ['home', 'away']) {
      for (const p of outfield(f, team)) {
        const key = team + '-' + p.id;
        if (!byId.has(key)) byId.set(key, { team, id: p.id, x: [], y: [] });
        const a = byId.get(key);
        a.x.push(team === 'home' ? p.x * PITCH_LENGTH_M : (1 - p.x) * PITCH_LENGTH_M);
        a.y.push(p.y * PITCH_WIDTH_M);
      }
    }
  }
  const slotSd = [];
  for (const a of byId.values()) {
    if (a.x.length < 200) continue;
    slotSd.push({ team: a.team, id: a.id, sdX: sd(a.x), sdY: sd(a.y) });
  }
  const grp = (t, lo, hi) => {
    const sel = slotSd.filter((r) => r.team === t && r.id >= lo && r.id <= hi);
    return sel.length ? { x: mean(sel.map((r) => r.sdX)), y: mean(sel.map((r) => r.sdY)), n: sel.length } : null;
  };
  const back = grp('home', 1, 4); const mid = grp('home', 5, 8);
  const spans = spanByBall.filter((a) => a.length > 50).map(mean);
  return {
    fault: Math.max(...gaps),
    faultAt: gaps.indexOf(Math.max(...gaps)) + 1,
    gaps,
    midBackRatio: back && mid ? mid.x / back.x : NaN,
    backSdY: back ? back.y : NaN,
    spans,
    spanRange: Math.max(...spans) - Math.min(...spans),
    frontInOwnBox: frontInOwnBox.length ? mean(frontInOwnBox) : NaN,
  };
}

const r = analyze(R); const e = analyze(E);
const row = (name, rv, ev, fmt = (v) => v.toFixed(1)) => {
  console.log(`  ${name.padEnd(26)} 真实 ${fmt(rv).padStart(8)}   本变体 ${fmt(ev).padStart(8)}`);
};

console.log(`\n===== 结构健康检查：${label} =====`);
console.log('\nS1 断层（相邻次序间距最大值）');
row('最大间距 (m)', r.fault, e.fault);
row('出现在次序', r.faultAt, e.faultAt, (v) => String(v));
console.log('  间距序列：');
console.log(`    真实 ${r.gaps.map((v) => v.toFixed(1)).join(' / ')}`);
console.log(`    本变体 ${e.gaps.map((v) => v.toFixed(1)).join(' / ')}`);

console.log('\nS2/S3 移动结构');
row('中场/后防 x-sd 比', r.midBackRatio, e.midBackRatio, (v) => v.toFixed(2));
row('后防 y-sd (m)', r.backSdY, e.backSdY);

console.log('\nS4 块跨度随球位（球从本方后场 → 对方后场）');
console.log(`    真实   ${r.spans.map((v) => v.toFixed(1)).join('  ')}`);
console.log(`    本变体 ${e.spans.map((v) => v.toFixed(1)).join('  ')}`);
row('跨度极差 (m)', r.spanRange, e.spanRange);

console.log('\nS5 锋线回防（球在本方后场 x<21m 时最前一人）');
row('最前一人 (m)', r.frontInOwnBox, e.frontInOwnBox);
