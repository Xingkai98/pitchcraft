// Wayfinder 探索探针 1：队形「形状剖面」对比
//
// 目的：把「引擎纵深 40.5m vs 真实 18-26m」这个标量差，拆成**逐槽位的形状差**——
// 到底是防线太深、锋线太靠前、还是每条线之间都均匀地拉大？
//
// 关键便利：两侧的 id 语义都是「按深度排序」（引擎 default_lineup 固定顺序；
// Metrica 转换器的 assignIds 按 depth 升序填槽位）。所以第 i 号槽位可以直接对比。
//
// 用法：node probe-shape-profile.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PITCH_LENGTH_M, BENCHMARK_SEEDS, ENGINE_DURATION_SEC,
  sampleEngineFrames, cutWindows, teamShape, KEEPER_IDS,
} from '../../../../../viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '../../../../../tools/benchmark-engine.mjs';

const HERE = fileURLToPath(new URL('../../../../..', import.meta.url));

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const q = (sorted, p) => {
  const n = sorted.length;
  if (n === 0) return NaN;
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
};

// 一帧一队 → 按深度升序的 10 个非门将 x（米）
function slotXs(frame, team) {
  const isHome = team === 'home';
  const out = (frame.players || [])
    .filter((p) => p && !KEEPER_IDS.includes(p.id) && (isHome ? p.id <= 10 : p.id >= 11))
    .map((p) => p.x * PITCH_LENGTH_M);
  if (out.length < 7) return null;
  return out.sort((a, b) => a - b);
}

// ── 真实侧（Metrica，已转换产物）─────────────────────────────────────────
function loadReal() {
  const g1 = JSON.parse(readFileSync(`${HERE}/viewer/data/real-game-1.json`, 'utf8'));
  const g2 = JSON.parse(readFileSync(`${HERE}/viewer/data/real-game-2.json`, 'utf8'));
  return [g1, g2];
}

// ── 引擎侧 ──────────────────────────────────────────────────────────────
const load = await loadEngineWasm(WASM_PATH);
if (!load.ok) { console.error(load.message); process.exit(1); }
const { createGame } = await import('../../../../../viewer/game.js');

const engineFrames = [];
for (const seed of BENCHMARK_SEEDS.slice(0, 3)) {
  const game = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  const all = sampleEngineFrames(game);
  for (const w of cutWindows(all)) engineFrames.push(...w);
}
console.log(`引擎采样 ${engineFrames.length} 帧（${BENCHMARK_SEEDS.slice(0,3).join(',')} × 6 窗）`);

const realFrames = [];
for (const g of loadReal()) {
  const frames = g.frames.map((f) => ({
    t: f.t,
    players: f.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)),
    ball: f.ball || null,
  }));
  for (const w of cutWindows(frames)) realFrames.push(...w);
}
console.log(`真实采样 ${realFrames.length} 帧（Metrica 2 场 × 13 窗）`);

// ── 逐槽位剖面 ──────────────────────────────────────────────────────────
// 对每帧每队取「按深度升序的第 i 个非门将」的 x，再对帧取均值。
function profile(frames, team) {
  const acc = Array.from({ length: 10 }, () => []);
  for (const f of frames) {
    const xs = slotXs(f, team);
    if (!xs) continue;
    for (let i = 0; i < 10; i += 1) acc[i].push(xs[i]);
  }
  return acc.map((a) => (a.length ? mean(a) : NaN));
}

function depthOf(frames, team) {
  const v = [];
  for (const f of frames) {
    const xs = slotXs(f, team);
    if (xs) v.push(q(xs, 0.9) - q(xs, 0.1));
  }
  return { avg: mean(v), min: Math.min(...v), max: Math.max(...v), n: v.length };
}

console.log('\n=== 逐槽位平均 x（米，0 = 本方门线；按深度升序，槽位 1 = 最深的后卫）===');
console.log('槽位     真实(主)   引擎(主)   差     | 真实(客)   引擎(客)   差');
const rpH = profile(realFrames, 'home'); const epH = profile(engineFrames, 'home');
const rpA = profile(realFrames, 'away'); const epA = profile(engineFrames, 'away');
// 客队要镜像：客队攻向 x=0，所以其「深度」是 1-x
const mirror = (arr) => arr.map((v) => PITCH_LENGTH_M - v).reverse();
const rpAm = mirror(rpA); const epAm = mirror(epA);
for (let i = 0; i < 10; i += 1) {
  console.log(
    `  ${String(i + 1).padStart(2)}    ${rpH[i].toFixed(1).padStart(7)}  ${epH[i].toFixed(1).padStart(8)}  ${(epH[i] - rpH[i]).toFixed(1).padStart(6)}  |`
    + ` ${rpAm[i].toFixed(1).padStart(7)}  ${epAm[i].toFixed(1).padStart(8)}  ${(epAm[i] - rpAm[i]).toFixed(1).padStart(6)}`,
  );
}

console.log('\n=== 逐档间距（相邻槽位 x 之差，米）===');
const gaps = (p) => p.slice(1).map((v, i) => v - p[i]);
const gh = gaps(rpH); const geh = gaps(epH);
const ga = gaps(rpAm); const gea = gaps(epAm);
console.log('档位        真实(主)  引擎(主)   | 真实(客)  引擎(客)');
const names = ['最深-次深', '2-3', '3-4', '4-5(防线→中场)', '5-6', '6-7', '7-8', '8-9(中场→锋线)', '9-最前'];
for (let i = 0; i < 9; i += 1) {
  console.log(`  ${names[i].padEnd(12)} ${gh[i].toFixed(1).padStart(6)}   ${geh[i].toFixed(1).padStart(7)}   | ${ga[i].toFixed(1).padStart(6)}   ${gea[i].toFixed(1).padStart(7)}`);
}

console.log('\n=== 纵深（q10–q90）===');
for (const [name, frames, team] of [['真实主', realFrames, 'home'], ['引擎主', engineFrames, 'home'], ['真实客', realFrames, 'away'], ['引擎客', engineFrames, 'away']]) {
  const d = depthOf(frames, team);
  console.log(`  ${name}  ${d.avg.toFixed(2)} [${d.min.toFixed(2)}–${d.max.toFixed(2)}] n=${d.n}`);
}

// ── 球位置对纵深的影响（弹性）────────────────────────────────────────────
console.log('\n=== 弹性：按球所在 x 分桶的纵深均值（主队）===');
const buckets = [[0, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 1.0]];
function elasticityTable(frames, label) {
  const acc = buckets.map(() => []);
  for (const f of frames) {
    if (!f.ball) continue;
    const xs = slotXs(f, 'home');
    if (!xs) continue;
    const d = q(xs, 0.9) - q(xs, 0.1);
    const bi = Math.min(3, Math.floor(f.ball[0] * 4));
    acc[bi].push(d);
  }
  console.log(`  ${label}`);
  acc.forEach((a, i) => {
    if (a.length) console.log(`    球 x∈[${buckets[i][0]},${buckets[i][1]})  纵深 ${mean(a).toFixed(1)}m  n=${a.length}`);
  });
}
elasticityTable(realFrames, '真实（Metrica）');
elasticityTable(engineFrames, '引擎');
