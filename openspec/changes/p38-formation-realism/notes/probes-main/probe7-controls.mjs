// probe 7：三个方案各自前提的严格对照
//  (1) 前后线随球位 —— 严格控制球位（报每格内球位均值，看混淆）
//  (2) 覆盖链：链节 Δx 与 Δy 的关系（甲3「链长随横向间距增长」的前提）
//  (3) y 方向运动量（宽度的副作用面）
//  (4) 死球/重开帧占比（最后一桶的可信度）

import { readFileSync } from 'node:fs';
import {
  PITCH_LENGTH_M, PITCH_WIDTH_M, BENCHMARK_SEEDS, ENGINE_DURATION_SEC,
  sampleEngineFrames, cutWindows, KEEPER_IDS, possessionProxy, isRawBallFrame,
} from '/home/happy/.claude/worktrees/wayfinder-realism/viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '/home/happy/.claude/worktrees/wayfinder-realism/tools/benchmark-engine.mjs';

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const pctl = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

const load = await loadEngineWasm(WASM_PATH);
const { createGame } = await import('/home/happy/.claude/worktrees/wayfinder-realism/viewer/game.js');
const EF = [];
for (const seed of BENCHMARK_SEEDS.slice(0, 3)) {
  const game = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  for (const w of cutWindows(sampleEngineFrames(game))) EF.push(...w);
}
const RF = [];
for (const f of ['1', '2']) {
  const g = JSON.parse(readFileSync(`/home/happy/.claude/worktrees/wayfinder-realism/viewer/data/real-game-${f}.json`, 'utf8'));
  const frames = g.frames.map((fr) => ({ t: fr.t, ball: fr.ball || null, players: fr.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)) }));
  for (const w of cutWindows(frames)) RF.push(...w);
}
const outfield = (f, team) => (f.players || []).filter((p) => p && !KEEPER_IDS.includes(p.id) && (team === 'home' ? p.id <= 10 : p.id >= 11));

// ── (1) 前后线随球位，控制球位 + 相位 ───────────────────────────────────
console.log('=== (1) 主队后4/前2 随球位，按控球相位拆（每格报球位均值以暴露混淆）===');
for (const [label, FR] of [['真实', RF], ['引擎', EF]]) {
  const E = [0, 10.5, 21, 31.5, 42, 52.5, 63, 73.5, 84, 94.5, 105];
  const cells = E.slice(0, -1).map(() => ({ inP: { b: [], f: [], bx: [] }, outP: { b: [], f: [], bx: [] } }));
  for (const f of FR) {
    if (!f.ball || !isRawBallFrame(f)) continue;
    const bx = f.ball[0] * 105;
    const bi = Math.max(0, Math.min(9, Math.floor(bx / 10.5)));
    const ps = outfield(f, 'home'); if (ps.length < 10) continue;
    const xs = ps.map((p) => p.x * 105).sort((a, b) => a - b);
    const pos = possessionProxy(f); if (!pos) continue;
    const c = pos === 'home' ? cells[bi].inP : cells[bi].outP;
    c.b.push(mean(xs.slice(0, 4))); c.f.push(mean(xs.slice(8, 10))); c.bx.push(bx);
  }
  console.log(`  ${label}`);
  console.log('    球区        控球:球位/后4/前2/长       丢球:球位/后4/前2/长');
  cells.forEach((c, i) => {
    const F = (o) => (o.bx.length < 80 ? '   —   ' : `${mean(o.bx).toFixed(0)}/${mean(o.b).toFixed(0)}/${mean(o.f).toFixed(0)}/${(mean(o.f) - mean(o.b)).toFixed(0)}`);
    console.log(`    [${String(E[i]).padStart(3)}–${String(E[i + 1]).padStart(3)})  ${F(c.inP).padStart(22)}   ${F(c.outP).padStart(22)}`);
  });
}

// ── (2) 覆盖链：链节 Δx vs Δy ───────────────────────────────────────────
console.log('\n=== (2) 最近邻覆盖链：链节 (Δx, Δy, 长度) ===');
for (const [label, FR] of [['真实', RF], ['引擎', EF]]) {
  const all = [];
  const byDy = [[0, 3], [3, 6], [6, 9], [9, 14], [14, 99]].map(() => []);
  for (const f of FR) {
    for (const team of ['home', 'away']) {
      const ps = outfield(f, team); if (ps.length < 10) continue;
      const pts = ps.map((p) => ({ x: (team === 'home' ? p.x : 1 - p.x) * 105, y: p.y * 68, id: p.id }));
      let cur = pts.reduce((a, b) => (a.x < b.x ? a : b));
      const used = new Set([cur.id]); const chain = [cur];
      while (chain.length < 10) {
        let best = null; let bd = Infinity;
        for (const p of pts) { if (used.has(p.id)) continue; const d = Math.hypot(p.x - cur.x, p.y - cur.y); if (d < bd) { bd = d; best = p; } }
        used.add(best.id); chain.push(best); cur = best;
      }
      for (let i = 1; i < 10; i += 1) {
        const dx = Math.abs(chain[i].x - chain[i - 1].x); const dy = Math.abs(chain[i].y - chain[i - 1].y);
        all.push([dx, dy]);
        for (let b = 0; b < byDy.length; b += 1) if (dy >= byDy[b][0] && dy < [0, 3, 6, 9, 14, 99][b + 1]) { byDy[b].push(dx); break; }
      }
    }
  }
  const mx = mean(all.map((a) => a[0])); const my = mean(all.map((a) => a[1]));
  const cov = mean(all.map((a) => a[0] * a[1])) - mx * my;
  const r = cov / (sd(all.map((a) => a[0])) * sd(all.map((a) => a[1])));
  console.log(`  ${label}  n=${all.length}  corr(Δx,Δy)=${r.toFixed(3)}  平均Δx ${mx.toFixed(1)} 平均Δy ${my.toFixed(1)}`);
  console.log(`    Δy 分档 → Δx 均值: ${byDy.map((a, i) => `Δy∈[${[0, 3, 6, 9, 14][i]},${[3, 6, 9, 14, 99][i]}) ${mean(a).toFixed(1)}m(n=${a.length})`).join('  ')}`);
}

// ── (3) y 方向运动量 ────────────────────────────────────────────────────
console.log('\n=== (3) y 方向逐帧位移（米/帧，0.2s 采样）===');
for (const [label, FR] of [['真实', RF], ['引擎', EF]]) {
  const prev = new Map(); const dy = []; const dx = [];
  for (const f of FR) {
    for (const team of ['home', 'away']) for (const p of outfield(f, team)) {
      const k = `${team}|${p.id}`; const pp = prev.get(k);
      if (pp && f.t > pp.t && f.t - pp.t < 1.0) { dy.push(Math.abs(p.y - pp.y) * 68); dx.push(Math.abs(p.x - pp.x) * 105); }
      prev.set(k, { x: p.x, y: p.y, t: f.t });
    }
  }
  console.log(`  ${label}  |Δx| 均值 ${mean(dx).toFixed(2)} p90 ${pctl(dx, 0.9).toFixed(2)}   |Δy| 均值 ${mean(dy).toFixed(2)} p90 ${pctl(dy, 0.9).toFixed(2)}   |Δy|/|Δx| = ${(mean(dy) / mean(dx)).toFixed(2)}`);
}

// ── (4) 死球/重开占比（用球的"不动"与位置近似）────────────────────────
console.log('\n=== (4) 球在 (0.5,0.5) 附近 / 球几乎不动的帧占比 ===');
for (const [label, FR] of [['真实', RF], ['引擎', EF]]) {
  let centre = 0; let n = 0;
  for (const f of FR) {
    if (!f.ball) continue; n += 1;
    if (Math.abs(f.ball[0] - 0.5) < 0.01 && Math.abs(f.ball[1] - 0.5) < 0.01) centre += 1;
  }
  console.log(`  ${label}  球在 (0.5,0.5)±1% 的帧 ${(centre / n * 100).toFixed(1)}%  n=${n}`);
}

// ── (5) 队形目标：把球位固定，看引擎各角色目标的静态预测 ────────────────
console.log('\n=== (5) 引擎当前模型的静态预测（home，球位固定）===');
console.log('  球x(m)  id1  id2  id3  id4 | id5  id6  id7  id8 | id9  id10');
const BASES = [[0.18, 1], [0.20, 2], [0.18, 3], [0.14, 4], [0.40, 5], [0.42, 6], [0.42, 7], [0.40, 8], [0.62, 9], [0.62, 10]];
for (const bxm of [5, 26, 52, 79, 100]) {
  const bx = bxm / 105;
  const press = -0.02; const shift = (bx - 0.5) * 0.06;
  const row = BASES.map(([b, id]) => {
    let t = b + shift + press;
    if (id <= 4) { const push = bx * 0.12; t = Math.max(Math.min(b + shift + press + push, bx), b); }
    return Math.min(Math.max(t, 0.04), 0.9) * 105;
  });
  console.log(`  ${String(bxm).padStart(5)}  ${row.slice(0, 4).map((v) => v.toFixed(0).padStart(5)).join('')} | ${row.slice(4, 8).map((v) => v.toFixed(0).padStart(5)).join('')} | ${row.slice(8).map((v) => v.toFixed(0).padStart(5)).join('')}`);
}
