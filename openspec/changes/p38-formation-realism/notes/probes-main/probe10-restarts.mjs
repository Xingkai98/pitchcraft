// probe 10：引擎「深度尾巴」里有多少是重开（角球准备）几何而不是开放比赛
import { readFileSync } from 'node:fs';
import {
  PITCH_LENGTH_M, BENCHMARK_SEEDS, ENGINE_DURATION_SEC,
  sampleEngineFrames, cutWindows, KEEPER_IDS, teamShape,
} from '/home/happy/.claude/worktrees/wayfinder-realism/viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '/home/happy/.claude/worktrees/wayfinder-realism/tools/benchmark-engine.mjs';

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

const load = await loadEngineWasm(WASM_PATH);
const { createGame } = await import('/home/happy/.claude/worktrees/wayfinder-realism/viewer/game.js');
const EF = [];
// 同时记录事件类型，用于标记重开帧
const stream = simulateStream(load.wasm, BENCHMARK_SEEDS[0], ENGINE_DURATION_SEC);
const evs = JSON.parse(stream).events || JSON.parse(stream);
for (const seed of BENCHMARK_SEEDS.slice(0, 3)) {
  const game = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  for (const w of cutWindows(sampleEngineFrames(game))) EF.push(...w);
}
console.log(`引擎 ${EF.length} 帧`);

// 事件类型计数（种子 42）
const arr = Array.isArray(evs) ? evs : (evs.events || []);
const counts = new Map();
for (const e of arr) counts.set(e.type, (counts.get(e.type) || 0) + 1);
console.log('事件计数（种子 42，5400s）：', [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '));
const corner = arr.filter((e) => e.type === 'corner' || (e.detail && String(e.detail).includes('corner')));
console.log(`  corner 相关事件 ${corner.length}  → 每场 ${(corner.length).toFixed(0)} 次（5400s）`);

// 每帧最大 x（主队非门将）分布
const maxX = []; const deepFrac = [];
let n = 0;
for (const f of EF) {
  const ps = f.players.filter((p) => p && p.id >= 1 && p.id <= 10);
  if (ps.length < 7) continue;
  n += 1;
  const mx = Math.max(...ps.map((p) => p.x));
  maxX.push(mx);
  deepFrac.push(ps.filter((p) => p.x > 0.9).length);
}
maxX.sort((a, b) => a - b);
console.log(`\n主队最前者的 x 分位（归一）: p10 ${maxX[(n * 0.1) | 0].toFixed(2)} p25 ${maxX[(n * 0.25) | 0].toFixed(2)} p50 ${maxX[(n * 0.5) | 0].toFixed(2)} p75 ${maxX[(n * 0.75) | 0].toFixed(2)} p90 ${maxX[(n * 0.9) | 0].toFixed(2)} p99 ${maxX[(n * 0.99) | 0].toFixed(2)}`);
console.log(`主队 x>0.9 的人数：均值 ${mean(deepFrac).toFixed(2)}  中位 ${[ ...deepFrac ].sort((a,b)=>a-b)[(n*0.5)|0]}  P(≥1 人) ${(deepFrac.filter((c) => c >= 1).length / n * 100).toFixed(1)}%  P(≥4 人) ${(deepFrac.filter((c) => c >= 4).length / n * 100).toFixed(1)}%`);

// 剔除「有 ≥4 人在对方最后 10m」的帧后，重算纵深
function depthStats(frames, filter) {
  const v = [];
  for (const f of frames) for (const t of ['home', 'away']) {
    if (filter && !filter(f)) continue;
    const s = teamShape(f, t); if (s) v.push(s.depth);
  }
  return { avg: mean(v), n: v.length };
}
const all = depthStats(EF, null);
const noBox = depthStats(EF, (f) => {
  for (const t of ['home', 'away']) {
    const ps = (f.players || []).filter((p) => p && !KEEPER_IDS.includes(p.id) && (t === 'home' ? p.id <= 10 : p.id >= 11));
    const deep = t === 'home' ? ps.filter((p) => p.x > 0.9).length : ps.filter((p) => p.x < 0.1).length;
    if (deep >= 4) return false;
  }
  return true;
});
console.log(`\n引擎纵深：全部帧 ${all.avg.toFixed(1)}m (n=${all.n})  剔除「有队 ≥4 人在对方最后 10m」后 ${noBox.avg.toFixed(1)}m (n=${noBox.n})`);

// 真实侧同样处理
const RF = [];
for (const f of ['1', '2']) {
  const g = JSON.parse(readFileSync(`/home/happy/.claude/worktrees/wayfinder-realism/viewer/data/real-game-${f}.json`, 'utf8'));
  const frames = g.frames.map((fr) => ({ t: fr.t, ball: fr.ball || null, players: fr.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)) }));
  for (const w of cutWindows(frames)) RF.push(...w);
}
const rAll = depthStats(RF, null);
const rNoBox = depthStats(RF, (f) => {
  for (const t of ['home', 'away']) {
    const ps = (f.players || []).filter((p) => p && !KEEPER_IDS.includes(p.id) && (t === 'home' ? p.id <= 10 : p.id >= 11));
    const deep = t === 'home' ? ps.filter((p) => p.x > 0.9).length : ps.filter((p) => p.x < 0.1).length;
    if (deep >= 4) return false;
  }
  return true;
});
console.log(`真实纵深：全部帧 ${rAll.avg.toFixed(1)}m (n=${rAll.n})  剔除后 ${rNoBox.avg.toFixed(1)}m (n=${rNoBox.n})`);
