// probe 6：三个候选方案各自依赖的机制事实
//  (a) 球侧压缩 / 远端宽度：宽度结构随球 y 的变化
//  (b) 最近邻链：真实球队是"线"还是"链"
//  (c) 球到最近防守者 / 到全队重心的距离分布（压迫与整体性）
//  (d) 真实锋线回撤：球深入后场时前 2 人的位置（带相位）
//  (e) 真实转向：球权转换时队形怎么动

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PITCH_LENGTH_M, PITCH_WIDTH_M, BENCHMARK_SEEDS, ENGINE_DURATION_SEC,
  sampleEngineFrames, cutWindows, KEEPER_IDS, possessionProxy, isRawBallFrame,
} from '../../../../../viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '../../../../../tools/benchmark-engine.mjs';

const HERE = fileURLToPath(new URL('../../../../..', import.meta.url));

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const pctl = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

const load = await loadEngineWasm(WASM_PATH);
const { createGame } = await import('../../../../../viewer/game.js');
const EF = [];
for (const seed of BENCHMARK_SEEDS.slice(0, 3)) {
  const game = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  for (const w of cutWindows(sampleEngineFrames(game))) EF.push(...w);
}
const RF = [];
for (const f of ['1', '2']) {
  const g = JSON.parse(readFileSync(`${HERE}/viewer/data/real-game-${f}.json`, 'utf8'));
  const frames = g.frames.map((fr) => ({ t: fr.t, ball: fr.ball || null, players: fr.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)) }));
  for (const w of cutWindows(frames)) RF.push(...w);
}
const outfield = (f, team) => (f.players || []).filter((p) => p && !KEEPER_IDS.includes(p.id) && (team === 'home' ? p.id <= 10 : p.id >= 11));

// ── (a) 球侧压缩 / 远端宽度 ─────────────────────────────────────────────
console.log('=== (a) 宽度结构随球 y（主队，ballY 归一化）===');
console.log('  口径：球侧 = 球的 y 一侧；把球员 y 按「同侧/异侧」分组，量各自到中线的距离与跨度');
for (const [label, FR] of [['真实', RF], ['引擎', EF]]) {
  const res = { nearSpan: [], farSpan: [], nearMean: [], farMean: [], span: [] };
  for (const f of FR) {
    if (!f.ball || !Number.isFinite(f.ball[1])) continue;
    const by = f.ball[1];
    const ps = outfield(f, 'home');
    if (ps.length < 7) continue;
    const ys = ps.map((p) => p.y);
    const near = ys.filter((y) => (by < 0.5 ? y < 0.5 : y >= 0.5));
    const far = ys.filter((y) => (by < 0.5 ? y >= 0.5 : y < 0.5));
    if (near.length < 3 || far.length < 3) continue;
    res.nearSpan.push(Math.max(...near) - Math.min(...near));
    res.farSpan.push(Math.max(...far) - Math.min(...far));
    // 到球侧边线（y=0 或 y=1）的距离：越小 = 越贴边
    res.nearMean.push(mean(near.map((y) => (by < 0.5 ? y : 1 - y))) * PITCH_WIDTH_M);
    res.farMean.push(mean(far.map((y) => (by < 0.5 ? 1 - y : y))) * PITCH_WIDTH_M);
    res.span.push((Math.max(...ys) - Math.min(...ys)) * PITCH_WIDTH_M);
  }
  console.log(`  ${label}  全宽 ${mean(res.span).toFixed(1)}  球侧组内跨度 ${mean(res.nearSpan).toFixed(1)}  远端组内跨度 ${mean(res.farSpan).toFixed(1)}`
    + `  |  球侧组平均离近边 ${mean(res.nearMean).toFixed(1)}m  远端组平均离远边 ${mean(res.farMean).toFixed(1)}m  n=${res.span.length}`);
}

// ── (b) 最近邻链 ────────────────────────────────────────────────────────
console.log('\n=== (b) 最近邻链：从本方最深的外场出发，逐个跳到最近的未访问队友 ===');
console.log('  链上第 i 个点的 x（米，已按本方门线归一）与相邻链间距');
for (const [label, FR] of [['真实', RF], ['引擎', EF]]) {
  const acc = Array.from({ length: 10 }, () => []);
  const gaps = Array.from({ length: 9 }, () => []);
  let n = 0;
  for (const f of FR) {
    for (const team of ['home', 'away']) {
      const ps = outfield(f, team);
      if (ps.length < 10) continue;
      const pts = ps.map((p) => ({ x: team === 'home' ? p.x : 1 - p.x, y: p.y, id: p.id }));
      let cur = pts.reduce((a, b) => (a.x < b.x ? a : b));
      const used = new Set([cur.id]);
      const chain = [cur];
      while (chain.length < 10) {
        let best = null; let bd = Infinity;
        for (const p of pts) {
          if (used.has(p.id)) continue;
          const d = Math.hypot((p.x - cur.x) * PITCH_LENGTH_M, (p.y - cur.y) * PITCH_WIDTH_M);
          if (d < bd) { bd = d; best = p; }
        }
        if (!best) break;
        used.add(best.id); chain.push(best); cur = best;
      }
      if (chain.length !== 10) continue;
      n += 1;
      for (let i = 0; i < 10; i += 1) acc[i].push(chain[i].x * PITCH_LENGTH_M);
      for (let i = 1; i < 10; i += 1) gaps[i - 1].push(Math.hypot((chain[i].x - chain[i - 1].x) * PITCH_LENGTH_M, (chain[i].y - chain[i - 1].y) * PITCH_WIDTH_M));
    }
  }
  console.log(`  ${label}  x: ${acc.map((a) => mean(a).toFixed(1)).join(' ')}`);
  console.log(`        链间距: ${gaps.map((a) => mean(a).toFixed(1)).join('/')}`);
  const lastGap = acc.map((a, i) => (i ? 0 : 0));
  console.log(`        跨度 ${(mean(acc[9]) - mean(acc[0])).toFixed(1)}m  n=${n}`);
}

// ── (c) 球到防守者 / 全队重心 ───────────────────────────────────────────
console.log('\n=== (c) 球到最近的非门将（两队各自）与到本队重心的距离（米）===');
for (const [label, FR] of [['真实', RF], ['引擎', EF]]) {
  const nd = []; const cd = []; const nTeam = [];
  for (const f of FR) {
    if (!f.ball) continue;
    const bx = f.ball[0] * 105; const by = f.ball[1] * 68;
    for (const team of ['home', 'away']) {
      const ps = outfield(f, team);
      if (ps.length < 7) continue;
      const ds = ps.map((p) => Math.hypot(p.x * 105 - bx, p.y * 68 - by));
      nd.push(Math.min(...ds));
      const cx = mean(ps.map((p) => p.x)) * 105; const cy = mean(ps.map((p) => p.y)) * 68;
      cd.push(Math.hypot(cx - bx, cy - by));
      const within = ds.filter((d) => d < 15).length;
      nTeam.push(within);
    }
  }
  console.log(`  ${label}  最近者 ${mean(nd).toFixed(1)} (p10 ${pctl(nd, 0.1).toFixed(1)} p50 ${pctl(nd, 0.5).toFixed(1)} p90 ${pctl(nd, 0.9).toFixed(1)})`
    + `  重心到球 ${mean(cd).toFixed(1)}  15m 内人数 ${mean(nTeam).toFixed(2)}`);
}

// ── (d) 锋线回撤（带相位）──────────────────────────────────────────────
console.log('\n=== (d) 主队前 2 人的 x（米）随球 x，分控球/丢球 ===');
for (const [label, FR] of [['真实', RF], ['引擎', EF]]) {
  const edges = [0, 11, 21, 32, 42, 53, 63, 74, 84, 95, 105];
  const rows = edges.slice(0, -1).map(() => ({ inP: [], outP: [] }));
  for (const f of FR) {
    if (!f.ball) continue;
    const raw = isRawBallFrame(f);
    if (!raw) continue;
    const bx = f.ball[0] * 105;
    const bi = Math.max(0, Math.min(9, Math.floor(bx / 10.5)));
    const ps = outfield(f, 'home');
    if (ps.length < 10) continue;
    const xs = ps.map((p) => p.x * 105).sort((a, b) => a - b);
    const pos = possessionProxy(f);
    const front = mean(xs.slice(8, 10));
    if (pos === 'home') rows[bi].inP.push(front); else if (pos === 'away') rows[bi].outP.push(front);
  }
  console.log(`  ${label}  球区  控球时前2   丢球时前2    差`);
  rows.forEach((r, i) => {
    if (r.inP.length < 100 || r.outP.length < 100) return;
    const a = mean(r.inP); const b = mean(r.outP);
    console.log(`         [${edges[i]}–${edges[i + 1]})  ${a.toFixed(1).padStart(8)}  ${b.toFixed(1).padStart(8)}  ${(b - a).toFixed(1).padStart(6)}`);
  });
}

// ── (e) 全队跨度 vs 纵深 ────────────────────────────────────────────────
console.log('\n=== (e) 全队跨度（最深到最前，米）与 q10-q90 之比 ===');
for (const [label, FR] of [['真实', RF], ['引擎', EF]]) {
  const span = []; const q = [];
  for (const f of FR) {
    for (const team of ['home', 'away']) {
      const ps = outfield(f, team);
      if (ps.length < 10) continue;
      const xs = ps.map((p) => (team === 'home' ? p.x : 1 - p.x) * 105).sort((a, b) => a - b);
      span.push(xs[9] - xs[0]);
      const h = 9 * 0.9; const lo = 9 * 0.1;
      q.push((xs[8] + 0.1 * (xs[9] - xs[8])) - (xs[0] + 0.9 * (xs[1] - xs[0])));
    }
  }
  console.log(`  ${label}  全跨度 ${mean(span).toFixed(1)}  q10-q90 ${mean(q).toFixed(1)}  比 ${(mean(span) / mean(q)).toFixed(2)}`);
}
