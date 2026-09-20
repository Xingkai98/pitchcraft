// probe 13：A/B 对照——把 default_lineup 的模板整体压缩后，差距改善了多少？
// 对照对象不是"别人的工作"，而是本文 §4.1 判定的那类改动（"把模板 x 乘系数"）到底有多大用。

import { readFileSync } from 'node:fs';
import {
  BENCHMARK_SEEDS, ENGINE_DURATION_SEC, sampleEngineFrames, cutWindows,
  windowMetrics, elasticity, teamShape, KEEPER_IDS,
} from '../../../../../viewer/match-metrics.js';
import { loadEngineWasm, simulateStream } from '../../../../../tools/benchmark-engine.mjs';

const ROOT = '../../../../..';
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

async function run(wasmPath, label) {
  const load = await loadEngineWasm(wasmPath);
  if (!load.ok) { console.error(load.message); return null; }
  const { createGame } = await import(`${ROOT}/viewer/game.js`);
  const frames = [];
  for (const seed of BENCHMARK_SEEDS.slice(0, 3)) {
    const game = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
    for (const w of cutWindows(sampleEngineFrames(game))) frames.push(...w);
  }
  const m = windowMetrics(frames).primary;
  const sp = [];
  for (const f of frames) for (const t of ['home', 'away']) { const s = teamShape(f, t); if (s) sp.push(s.spread); }
  const el = elasticity(frames);
  const w = windowMetrics(frames); void w;

  // 次序间距
  const acc = Array.from({ length: 9 }, () => []);
  const depthByBall = Array.from({ length: 10 }, () => []);
  for (const f of frames) {
    for (const team of ['home', 'away']) {
      const isHome = team === 'home';
      const ps = (f.players || []).filter((p) => p && !KEEPER_IDS.includes(p.id) && (isHome ? p.id <= 10 : p.id >= 11));
      if (ps.length < 10) continue;
      const xs = ps.map((p) => (isHome ? p.x : 1 - p.x) * 105).sort((a, b) => a - b);
      for (let i = 1; i < 10; i += 1) acc[i - 1].push(xs[i] - xs[i - 1]);
    }
    if (f.ball && Number.isFinite(f.ball[0])) {
      const s = teamShape(f, 'home');
      if (s) depthByBall[Math.max(0, Math.min(9, Math.floor(f.ball[0] * 105 / 10.5)))].push(s.depth);
    }
  }
  const row = {
    label,
    hd: m.hd, ad: m.ad, spread: mean(sp), gap: m.gap, width: m.width,
    el: el ? el.delta : NaN, ballDist: m.ballDist,
    gaps: acc.map(mean),
    depthCurve: depthByBall.map(mean),
  };
  return row;
}

const base = await run(`${ROOT}/viewer/engine.wasm`, '引擎（基线 wasm 00:51）');
const comp = await run('/tmp/wf-probe/engine-template-compressed.wasm', '引擎（模板压缩后）');

// 真实侧
function realRow() {
  const frames = [];
  for (const f of ['1', '2']) {
    const g = JSON.parse(readFileSync(`${ROOT}/viewer/data/real-game-${f}.json`, 'utf8'));
    const fr = g.frames.map((x) => ({ t: x.t, ball: x.ball || null, players: x.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)) }));
    for (const w of cutWindows(fr)) frames.push(...w);
  }
  const m = windowMetrics(frames).primary;
  const sp = [];
  for (const f of frames) for (const t of ['home', 'away']) { const s = teamShape(f, t); if (s) sp.push(s.spread); }
  const el = elasticity(frames);
  const acc = Array.from({ length: 9 }, () => []);
  const depthByBall = Array.from({ length: 10 }, () => []);
  for (const f of frames) {
    for (const team of ['home', 'away']) {
      const isHome = team === 'home';
      const ps = (f.players || []).filter((p) => p && !KEEPER_IDS.includes(p.id) && (isHome ? p.id <= 10 : p.id >= 11));
      if (ps.length < 10) continue;
      const xs = ps.map((p) => (isHome ? p.x : 1 - p.x) * 105).sort((a, b) => a - b);
      for (let i = 1; i < 10; i += 1) acc[i - 1].push(xs[i] - xs[i - 1]);
    }
    if (f.ball && Number.isFinite(f.ball[0])) {
      const s = teamShape(f, 'home');
      if (s) depthByBall[Math.max(0, Math.min(9, Math.floor(f.ball[0] * 105 / 10.5)))].push(s.depth);
    }
  }
  return { label: '真实 Metrica', hd: m.hd, ad: m.ad, spread: mean(sp), gap: m.gap, width: m.width, el: el ? el.delta : NaN, ballDist: m.ballDist, gaps: acc.map(mean), depthCurve: depthByBall.map(mean) };
}
const real = realRow();

const f2 = (v) => (Number.isFinite(v) ? v.toFixed(1).padStart(6) : '   n/a');
console.log('\n=== 头条指标 ===');
console.log('                     纵深(主) 纵深(客) 紧凑度 重心间距 宽度   弹性Δ');
for (const r of [real, base, comp]) console.log(`${r.label.padEnd(22)}${f2(r.hd)}${f2(r.ad)}${f2(r.spread)}${f2(r.gap)}${f2(r.width)}${f2(r.el)}`);
console.log('\n  相对真实的偏差：');
for (const r of [base, comp]) {
  const d = (a, b) => (a - b);
  console.log(`  ${r.label.padEnd(22)} 纵深 ${(d(r.hd, real.hd)).toFixed(1).padStart(6)}  紧凑 ${(d(r.spread, real.spread)).toFixed(1).padStart(5)}  间距 ${(d(r.gap, real.gap)).toFixed(1).padStart(5)}  宽度 ${(d(r.width, real.width)).toFixed(1).padStart(6)}  弹性 ${(d(r.el, real.el)).toFixed(1).padStart(5)}`);
}
const tot = (r) => Math.abs(r.hd - real.hd) + Math.abs(r.spread - real.spread) + Math.abs(r.gap - real.gap) + Math.abs(r.width - real.width) + Math.abs(r.el - real.el);
console.log(`\n  总绝对偏差：基线 ${tot(base).toFixed(1)}  模板压缩 ${tot(comp).toFixed(1)}  改善 ${((1 - tot(comp) / tot(base)) * 100).toFixed(1)}%`);

console.log('\n=== 相邻次序间距（关键：4→5 断层有没有消失）===');
console.log('                     1-2   2-3   3-4   4-5   5-6   6-7   7-8   8-9  9-10');
for (const r of [real, base, comp]) console.log(`${r.label.padEnd(22)}${r.gaps.map((g) => g.toFixed(1).padStart(5)).join(' ')}`);
console.log(`  4→5 断层：基线 ${base.gaps[3].toFixed(1)}m → 压缩后 ${comp.gaps[3].toFixed(1)}m （真实 ${real.gaps[3].toFixed(1)}m）`);

console.log('\n=== 纵深随球位（10 桶，m）===');
const cent = [5, 16, 26, 37, 47, 58, 68, 79, 89, 100];
console.log('  球位(m): ' + cent.map((c) => String(c).padStart(6)).join(''));
for (const r of [real, base, comp]) console.log(`  ${r.label.slice(0, 18).padEnd(22)}` + r.depthCurve.map((v) => v.toFixed(1).padStart(6)).join(''));
const mono = (c) => { let bad = 0; for (let i = 1; i < c.length; i += 1) if (c[i] < c[i - 1] - 1.0) bad += 1; return bad; };
console.log(`  非单调（下跌>1m 的桶数）：真实 ${mono(real.depthCurve)}  基线 ${mono(base.depthCurve)}  压缩后 ${mono(comp.depthCurve)}`);
