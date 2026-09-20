// probe 4：把「纵深差」拆成结构性事实——(1) 次序间距的刚性/柔性 (2) 防线随球的增益与 clamp
// (3) 控球相位下的形状 (4) y 方向（宽度）结构 (5) 逐槽位移动量
// 与 probe2 同一口径（每帧瞬时排序 → 对帧取均值）。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PITCH_LENGTH_M, PITCH_WIDTH_M, BENCHMARK_SEEDS, ENGINE_DURATION_SEC,
  sampleEngineFrames, cutWindows, KEEPER_IDS, possessionProxy,
} from '../../../../../viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '../../../../../tools/benchmark-engine.mjs';

const HERE = fileURLToPath(new URL('../../../../..', import.meta.url));

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const std = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

function outfield(frame, team) {
  const isHome = team === 'home';
  return (frame.players || []).filter((p) => p && !KEEPER_IDS.includes(p.id) && (isHome ? p.id <= 10 : p.id >= 11));
}
// 统一到「离本方门线距离」坐标
function xsSorted(frame, team) {
  const ps = outfield(frame, team);
  if (ps.length < 7) return null;
  const v = ps.map((p) => (team === 'home' ? p.x * PITCH_LENGTH_M : (1 - p.x) * PITCH_LENGTH_M));
  return v.sort((a, b) => a - b);
}
function ysOf(frame, team) {
  const ps = outfield(frame, team);
  if (ps.length < 7) return null;
  return ps.map((p) => p.y * PITCH_WIDTH_M).sort((a, b) => a - b);
}
function mirrorX(frame, team) {
  const ps = outfield(frame, team);
  if (ps.length < 7) return null;
  return ps.map((p) => (team === 'home' ? p.x : 1 - p.x));
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
for (const f of ['1', '2']) {
  const g = JSON.parse(readFileSync(`${HERE}/viewer/data/real-game-${f}.json`, 'utf8'));
  const frames = g.frames.map((fr) => ({
    t: fr.t, ball: fr.ball || null,
    players: fr.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)),
  }));
  for (const w of cutWindows(frames)) realFrames.push(...w);
}
console.log(`引擎 ${engineFrames.length} 帧 / 真实 ${realFrames.length} 帧\n`);

// ── M1 次序间距的均值与标准差（刚性检验）───────────────────────────────
function gapStats(frames, label) {
  const acc = Array.from({ length: 9 }, () => []);
  const maxGap = [];
  const hs = []; // 全队跨度（slot1..slot10）
  for (const f of frames) {
    for (const team of ['home', 'away']) {
      const xs = xsSorted(f, team);
      if (!xs) continue;
      let mx = 0;
      for (let i = 1; i < xs.length; i += 1) { const g = xs[i] - xs[i - 1]; acc[i - 1].push(g); if (g > mx) mx = g; }
      maxGap.push(mx);
      hs.push(xs[xs.length - 1] - xs[0]);
    }
  }
  const names = ['1-2', '2-3', '3-4', '4-5', '5-6', '6-7', '7-8', '8-9', '9-10'];
  console.log(`=== ${label}：相邻次序间距 均值±标准差 ===`);
  console.log('   ' + names.map((n, i) => `${n}:${mean(acc[i]).toFixed(1)}±${std(acc[i]).toFixed(1)}`).join('  '));
  console.log(`   全队跨度 ${mean(hs).toFixed(1)}m   每帧最大间距 均值 ${mean(maxGap).toFixed(1)}m  p50 ${pct(maxGap, 0.5).toFixed(1)}  p90 ${pct(maxGap, 0.9).toFixed(1)}  P(>10m)=${(maxGap.filter((g) => g > 10).length / maxGap.length * 100).toFixed(0)}%  P(>15m)=${(maxGap.filter((g) => g > 15).length / maxGap.length * 100).toFixed(0)}%\n`);
}
gapStats(realFrames, '真实 Metrica');
gapStats(engineFrames, '引擎');

// ── M2 防线/中场/锋线 x 随球 x（细桶）+ clamp 模型预测 ─────────────────
const edges = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
function ballLink(frames, label, useIds) {
  const acc = edges.slice(0, -1).map(() => ({ ball: [], back: [], mid: [], front: [] }));
  for (const f of frames) {
    if (!f.ball || !Number.isFinite(f.ball[0])) continue;
    const isHomeBall = f.ball[0];
    const teams = [['home', isHomeBall], ['away', 1 - isHomeBall]];
    for (const [team, bx] of teams) {
      const bi = Math.max(0, Math.min(9, Math.floor(bx * 10)));
      const xs = xsSorted(f, team);
      if (!xs) continue;
      acc[bi].ball.push(bx * PITCH_LENGTH_M);
      acc[bi].back.push(mean(xs.slice(0, 4)));
      acc[bi].mid.push(mean(xs.slice(4, 8)));
      acc[bi].front.push(mean(xs.slice(8, 10)));
    }
  }
  console.log(`=== ${label}：各块随球位（米）===`);
  console.log('球区    球位  后4(x±sd)         中4    前2    纵深      n');
  acc.forEach((a, i) => {
    if (a.ball.length < 200) { console.log(`[${(edges[i] * 105) | 0}–${(edges[i + 1] * 105) | 0})`.padEnd(8) + ' 样本不足'); return; }
    const b = mean(a.back); const fr = mean(a.front);
    console.log(`[${String((edges[i] * 105) | 0).padStart(3)}–${String((edges[i + 1] * 105) | 0).padStart(3)})`
      + `${mean(a.ball).toFixed(0).padStart(7)}  ${b.toFixed(1).padStart(6)}±${std(a.back).toFixed(1)}`
      + `${mean(a.mid).toFixed(1).padStart(8)}${mean(a.front).toFixed(1).padStart(8)}${(fr - b).toFixed(1).padStart(8)}${String(a.ball.length).padStart(7)}`);
  });
  console.log('');
}
ballLink(realFrames, '真实 Metrica');
ballLink(engineFrames, '引擎');

// 预测：引擎 home 防线（base x = 0.18,0.20,0.18,0.14）在三种模型下的均值 x（米）
console.log('=== 引擎防线模型预测（base 均 0.175）===');
console.log('球位x   模板(base)  clamp 模型   无 clamp 模型');
for (const bx of [0.0, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9, 1.0]) {
  const press = -0.02, shift = (bx - 0.5) * 0.06, push = Math.abs(bx - 0) * 0.12;
  const bases = [0.18, 0.20, 0.18, 0.14];
  const clamped = mean(bases.map((b) => Math.max(Math.min(b + shift + press + push, bx), b)));
  const raw = mean(bases.map((b) => b + shift + press + push));
  console.log(`${(bx * 105).toFixed(0).padStart(6)}${(105 * 0.175).toFixed(1).padStart(11)}${(clamped * 105).toFixed(1).padStart(12)}${(raw * 105).toFixed(1).padStart(14)}`);
}
console.log('');

// ── M3 控球相位 ────────────────────────────────────────────────────────
function byPhase(frames, label) {
  const rows = { inPoss: { d: [], b: [], f: [], sp: [] }, outPoss: { d: [], b: [], f: [], sp: [] } };
  for (const f of frames) {
    const pos = possessionProxy(f);
    if (!pos) continue;
    const xs = xsSorted(f, 'home');
    if (!xs) continue;
    const k = pos === 'home' ? 'inPoss' : 'outPoss';
    rows[k].d.push(xs[8] - xs[1]); // q~10-90 近似（n=10: q10≈插值）——这里用次序 2..9 做一致性对照
    rows[k].b.push(mean(xs.slice(0, 4)));
    rows[k].f.push(mean(xs.slice(8, 10)));
    rows[k].sp.push(mean(xs.map((v) => Math.abs(v - mean(xs)))));
  }
  console.log(`=== ${label}：主队控球/非控球（球相关量已用原始球帧？possessionProxy 不过滤——仅方向性参考）===`);
  for (const k of ['inPoss', 'outPoss']) {
    const r = rows[k];
    if (!r.d.length) { console.log(`  ${k} 样本不足`); continue; }
    console.log(`  ${k === 'inPoss' ? '控球  ' : '非控球'}  纵深(2..9) ${mean(r.d).toFixed(1)}  后4 ${mean(r.b).toFixed(1)}  前2 ${mean(r.f).toFixed(1)}  前-后 ${(mean(r.f) - mean(r.b)).toFixed(1)}  到重心 ${mean(r.sp).toFixed(1)}  n=${r.d.length}`);
  }
  console.log('');
}
byPhase(realFrames, '真实 Metrica');
byPhase(engineFrames, '引擎');

// ── M4 y 方向（宽度）次序统计量 ────────────────────────────────────────
function yOrder(frames, label) {
  const acc = Array.from({ length: 10 }, () => []);
  for (const f of frames) for (const team of ['home', 'away']) {
    const ys = ysOf(f, team);
    if (!ys) continue;
    for (let i = 0; i < 10; i += 1) acc[i].push(ys[i]);
  }
  const m = acc.map(mean);
  const span = m[9] - m[0];
  const gaps = m.slice(1).map((v, i) => v - m[i]);
  console.log(`=== ${label}：y 次序统计量（米）===`);
  console.log('  ' + m.map((v, i) => `${i + 1}:${v.toFixed(1)}`).join(' '));
  console.log(`  y 跨度 ${span.toFixed(1)}m  相邻间距 ${gaps.map((g) => g.toFixed(1)).join('/')}`);
  console.log(`  y 标准差（逐槽位） ${acc.map((a) => std(a).toFixed(1)).join('/')}\n`);
}
yOrder(realFrames, '真实 Metrica');
yOrder(engineFrames, '引擎');

// ── M5 逐槽位帧间位移（移动量） ────────────────────────────────────────
function mobility(frames, label) {
  // 用「按整场平均深度固定槽位」的 id 槽位（真实侧 id 是按整场 depth 定的，稳定）
  const prev = new Map(); const acc = Array.from({ length: 10 }, () => []);
  for (const f of frames) {
    for (const team of ['home', 'away']) {
      for (const p of outfield(f, team)) {
        const k = `${team}|${p.id}${f.winKey || ''}`;
        const key = `${f.t}|${k}`;
        const v = team === 'home' ? p.x * 105 : (1 - p.x) * 105;
        const pp = prev.get(k);
        if (pp && f.t - pp.t > 0 && f.t - pp.t < 1.0) acc[(team === 'home' ? p.id - 1 : 21 - p.id - 11 + 9) % 10].push(Math.abs(v - pp.v) / (f.t - pp.t));
        prev.set(k, { v, t: f.t });
      }
    }
  }
  console.log(`=== ${label}：逐槽位平均速度（m/s，按 id 槽位近似）===`);
  console.log('  ' + acc.map((a, i) => `${i + 1}:${mean(a).toFixed(2)}`).join(' '));
  console.log(`  全员均值 ${mean(acc.flat()).toFixed(2)} m/s\n`);
}
// 槽位排序不可靠 → 用整体速度分布替代
function speedDist(frames, label) {
  const prev = new Map(); const v = [];
  for (const f of frames) {
    for (const team of ['home', 'away']) {
      for (const p of outfield(f, team)) {
        const k = `${team}|${p.id}`;
        const px = p.x; const py = p.y;
        const pp = prev.get(k);
        if (pp && f.t > pp.t && f.t - pp.t < 1.0) v.push(Math.hypot(px - pp.px, py - pp.py) / (f.t - pp.t));
        prev.set(k, { px, py, t: f.t });
      }
    }
  }
  v.sort((a, b) => a - b);
  console.log(`=== ${label}：非门将瞬时速度（归一化/秒，含 y）n=${v.length} ===`);
  console.log(`  均值 ${mean(v).toFixed(4)}  p50 ${pct(v, 0.5).toFixed(4)}  p90 ${pct(v, 0.9).toFixed(4)}  p99 ${pct(v, 0.99).toFixed(4)}  max ${v[v.length - 1].toFixed(3)}`);
  console.log(`  折合 m/s：均值 ${(mean(v) * 105).toFixed(2)}  p90 ${(pct(v, 0.9) * 105).toFixed(2)}  p99 ${(pct(v, 0.99) * 105).toFixed(2)}\n`);
}
speedDist(realFrames, '真实 Metrica');
speedDist(engineFrames, '引擎');
