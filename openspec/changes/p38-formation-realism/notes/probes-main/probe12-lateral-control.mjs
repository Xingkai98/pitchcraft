// probe 12：横向刚性的**窗内**对照（消除「真实侧 2 场 vs 引擎 3 种子」的场间差异膨胀）
// 对每个 300s 窗单独算「每个深度次序槽位的 y 标准差」，再跨窗平均。窗内无场间膨胀。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PITCH_LENGTH_M, PITCH_WIDTH_M, BENCHMARK_SEEDS, ENGINE_DURATION_SEC,
  sampleEngineFrames, cutWindows, KEEPER_IDS,
} from '../../../../../viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '../../../../../tools/benchmark-engine.mjs';

const HERE = fileURLToPath(new URL('../../../../..', import.meta.url));

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };

const load = await loadEngineWasm(WASM_PATH);
const { createGame } = await import('../../../../../viewer/game.js');
const engineWindows = [];
for (const seed of BENCHMARK_SEEDS.slice(0, 3)) {
  const game = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  for (const w of cutWindows(sampleEngineFrames(game))) engineWindows.push(w);
}
const realWindows = [];
for (const f of ['1', '2']) {
  const g = JSON.parse(readFileSync(`${HERE}/viewer/data/real-game-${f}.json`, 'utf8'));
  const frames = g.frames.map((fr) => ({ t: fr.t, ball: fr.ball || null, players: fr.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)) }));
  for (const w of cutWindows(frames)) realWindows.push(w);
}
console.log(`引擎 ${engineWindows.length} 窗 / 真实 ${realWindows.length} 窗`);

// 窗内：按深度次序槽位取 y，算窗内 sd；同时算 x 的窗内 sd 作对照
function withinWindow(windows, label) {
  const ys = Array.from({ length: 10 }, () => []);
  const xs = Array.from({ length: 10 }, () => []);
  const yRange = [];
  for (const w of windows) {
    const accY = Array.from({ length: 10 }, () => []);
    const accX = Array.from({ length: 10 }, () => []);
    const rng = [];
    for (const f of w) {
      for (const team of ['home', 'away']) {
        const isHome = team === 'home';
        const ps = (f.players || []).filter((p) => p && !KEEPER_IDS.includes(p.id) && (isHome ? p.id <= 10 : p.id >= 11));
        if (ps.length < 10) continue;
        const sorted = [...ps].sort((a, b) => (isHome ? a.x - b.x : b.x - a.x));
        for (let i = 0; i < 10; i += 1) { accY[i].push(sorted[i].y * PITCH_WIDTH_M); accX[i].push((isHome ? sorted[i].x : 1 - sorted[i].x) * PITCH_LENGTH_M); }
        const yy = ps.map((p) => p.y * PITCH_WIDTH_M);
        rng.push(Math.max(...yy) - Math.min(...yy));
      }
    }
    for (let i = 0; i < 10; i += 1) { if (accY[i].length > 20) { ys[i].push(sd(accY[i])); xs[i].push(sd(accX[i])); } }
    if (rng.length > 20) yRange.push(mean(rng));
  }
  console.log(`  ${label}`);
  console.log(`    窗内 y sd（逐槽位平均）  ${(mean(ys.map(mean))).toFixed(1)}m   逐槽位 ${ys.map((a) => mean(a).toFixed(1)).join('/')}`);
  console.log(`    窗内 x sd（逐槽位平均）  ${(mean(xs.map(mean))).toFixed(1)}m   逐槽位 ${xs.map((a) => mean(a).toFixed(1)).join('/')}`);
  console.log(`    窗内宽度（y 全距）均值   ${mean(yRange).toFixed(1)}m`);
  return { y: mean(ys.map(mean)), x: mean(xs.map(mean)), w: mean(yRange) };
}
const R = withinWindow(realWindows, '真实 Metrica（窗内）');
const E = withinWindow(engineWindows, '引擎（窗内）');
console.log(`\n  比值：y sd ${(R.y / E.y).toFixed(2)}×  x sd ${(R.x / E.x).toFixed(2)}×  宽度 ${(R.w / E.w).toFixed(2)}×`);
console.log('  解读：若 y sd 比值远大于 x sd 比值 → 引擎横向刚性是**独立于**整体收缩的缺陷');

// 另一角度：单个球员（id 槽位）在窗内的位置方差——排除"排序槽位轮换"的影响
function perId(windows, label) {
  const acc = new Map();
  for (const w of windows) {
    const per = new Map();
    for (const f of w) for (const p of (f.players || [])) {
      if (!p || KEEPER_IDS.includes(p.id)) continue;
      const team = p.id <= 10 ? 'h' : 'a';
      const k = `${team}${p.id}`;
      if (!per.has(k)) per.set(k, { x: [], y: [] });
      per.get(k).x.push(team === 'h' ? p.x * 105 : (1 - p.x) * 105); per.get(k).y.push(p.y * 68);
    }
    for (const [k, v] of per) { if (v.x.length > 20) { if (!acc.has(k)) acc.set(k, { x: [], y: [] }); acc.get(k).x.push(sd(v.x)); acc.get(k).y.push(sd(v.y)); } }
  }
  const xs = [...acc.values()].map((v) => mean(v.x)); const ys = [...acc.values()].map((v) => mean(v.y));
  console.log(`  ${label}  逐 id：x 窗内 sd 均值 ${mean(xs).toFixed(1)}m  y 窗内 sd 均值 ${mean(ys).toFixed(1)}m  y/x = ${(mean(ys) / mean(xs)).toFixed(2)}`);
  return { x: mean(xs), y: mean(ys) };
}
console.log('\n=== 逐 id（不受排序槽位轮换影响）===');
const ri = perId(realWindows, '真实');
const ei = perId(engineWindows, '引擎');
console.log(`  比值：x ${(ri.x / ei.x).toFixed(2)}×  y ${(ri.y / ei.y).toFixed(2)}×`);
