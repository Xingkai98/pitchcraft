// adv7: 决定性检验 —— Metrica 25.9 vs SkillCorner 18.3 的差，是"数据集尺度差"还是"外推过滤口径差"？
//   (A) 外推率是否随队形纵深位置系统性变化（若是 → 主口径按构造截断两端）
//   (B) Metrica（无外推概念 ≡ 全点口径）对 SkillCorner allPoints 的对照
//   (C) 两侧分组口径等价性：固定 id 组 == 最深 4 人的帧占比（引擎 vs 真实）
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const M = await import(pathToFileURL('../../../../../viewer/match-metrics.js').href);
const { fromTrackingFrame, cutWindows, KEEPER_IDS, PITCH_LENGTH_M, framePitchMeters,
  BENCHMARK_SEEDS, ENGINE_DURATION_SEC, sampleEngineFrames, teamShape, windowMetrics, summarizeWindowMetrics } = M;
const { loadEngineWasm, simulateStream } = await import(pathToFileURL('../../../../../tools/benchmark-engine.mjs').href);
const { createGame } = await import(pathToFileURL('../../../../../viewer/game.js').href);
const ROOT = '../../../../..';
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

function loadMetrica(n) {
  const g = JSON.parse(readFileSync(`${ROOT}/viewer/data/real-game-${n}.json`, 'utf8'));
  return g.frames.map((fr) => fromTrackingFrame({ t: fr.t, ball: fr.ball || null,
    players: fr.players.map((p, id) => (p ? [p[0], p[1]] : null)) }, { pitchMeters: [105, 68] }));
}
function loadSC(id) {
  const g = JSON.parse(readFileSync(`${ROOT}/.scratch/p38-frames/skillcorner-${id}.json`, 'utf8'));
  return g.frames.map((fr) => fromTrackingFrame(fr, { pitchMeters: [g.meta.pitchMeters.length, g.meta.pitchMeters.width] }));
}
const SC = ['1874553', '1886347', '1899585', '1959846', '2007448', '2013725'];
const scW = []; for (const id of SC) scW.push(...cutWindows(loadSC(id)));
const mW = []; for (const n of ['1', '2']) mW.push(...cutWindows(loadMetrica(n)));

console.log('=== (A) SkillCorner：外推率 vs 队形内的纵深排名 ===');
{
  // 每帧每队：把 11 人（含门将）按 x 排名 0..10，统计每档的外推率
  const byRank = Array.from({ length: 11 }, () => ({ ext: 0, n: 0 }));
  const byGap = { rear: { ext: 0, n: 0 }, front: { ext: 0, n: 0 }, mid: { ext: 0, n: 0 } };
  for (const w of scW) for (const f of w) for (const team of ['home', 'away']) {
    const isHome = team === 'home';
    const o = (f.players || []).filter((p) => p && !KEEPER_IDS.includes(p.id) && (isHome ? p.id <= 10 : p.id >= 11));
    if (o.length !== 10) continue;
    const [L] = framePitchMeters(f);
    const sorted = o.map((p) => ({ p, x: (isHome ? p.x : 1 - p.x) * L })).sort((a, b) => a.x - b.x);
    sorted.forEach((e, k) => { byRank[k].n += 1; if (e.p.extrapolated) byRank[k].ext += 1; });
    // 只统计"球在附近"的中场？先不做。分组：最深/中间/最前
    const mark = (grp) => { };
    for (const k of [0, 1]) { byGap.rear.n += 1; if (sorted[k].p.extrapolated) byGap.rear.ext += 1; }
    for (const k of [2, 3, 4, 5, 6, 7]) { byGap.mid.n += 1; if (sorted[k].p.extrapolated) byGap.mid.ext += 1; }
    for (const k of [8, 9]) { byGap.front.n += 1; if (sorted[k].p.extrapolated) byGap.front.ext += 1; }
  }
  console.log('  按深度排名（0=最靠后）的外推率：');
  console.log('  ' + byRank.map((v, k) => `r${k}:${(100 * v.ext / v.n).toFixed(1)}%`).join('  '));
  console.log(`  最深 2 人 ${(100 * byGap.rear.ext / byGap.rear.n).toFixed(1)}%   中间 6 人 ${(100 * byGap.mid.ext / byGap.mid.n).toFixed(1)}%   最前 2 人 ${(100 * byGap.front.ext / byGap.front.n).toFixed(1)}%`);
}

console.log('\n=== (B) 靶子：同一份指标，三个候选目标值 ===');
function summ(W, pm) { return summarizeWindowMetrics(W.map((w) => windowMetrics(w, { pitchMeters: pm }).primary)); }
function summAll(W, pm) { return summarizeWindowMetrics(W.map((w) => windowMetrics(w, { pitchMeters: pm }).allPoints)); }
const mP = summ(mW, [105, 68]);
console.log(`  Metrica 2 场   (无外推概念 → 等价于"全点")`);
console.log(`     纵深 ${mP.hd.avg.toFixed(2)}  宽 ${mP.width.avg.toFixed(2)}  紧凑 ${mP.spread.avg.toFixed(2)}  重心距 ${mP.gap.avg.toFixed(2)}  球距 ${mP.ballDist.avg.toFixed(2)}`);
const scP = summ(scW, null), scA = summAll(scW, null);
console.log(`  SkillCorner 6 场 主口径（跳外推，P37 默认 = 基线 primaryDataset）`);
console.log(`     纵深 ${scP.hd.avg.toFixed(2)}  宽 ${scP.width.avg.toFixed(2)}  紧凑 ${scP.spread.avg.toFixed(2)}  重心距 ${scP.gap.avg.toFixed(2)}  球距 ${scP.ballDist.avg.toFixed(2)}`);
console.log(`  SkillCorner 6 场 全点口径（采信外推，与 Metrica 同处置）`);
console.log(`     纵深 ${scA.hd.avg.toFixed(2)}  宽 ${scA.width.avg.toFixed(2)}  紧凑 ${scA.spread.avg.toFixed(2)}  重心距 ${scA.gap.avg.toFixed(2)}  球距 ${scA.ballDist.avg.toFixed(2)}`);
console.log(`  → Metrica vs SC主口径 纵深差 ${(mP.hd.avg - scP.hd.avg).toFixed(2)}m (${(mP.hd.avg / scP.hd.avg).toFixed(2)}x)`);
console.log(`  → Metrica vs SC全点   纵深差 ${(mP.hd.avg - scA.hd.avg).toFixed(2)}m (${(mP.hd.avg / scA.hd.avg).toFixed(2)}x)`);

// 引擎
const load = await loadEngineWasm('/tmp/wf-probe/eng-PRISTINE.wasm');
const EW = [];
for (const seed of BENCHMARK_SEEDS) { const g = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC)); EW.push(...cutWindows(sampleEngineFrames(g))); }
const eP = summ(EW, [105, 68]);
console.log(`  引擎 main（无外推概念 → 等价于"全点"）`);
console.log(`     纵深 ${eP.hd.avg.toFixed(2)}  宽 ${eP.width.avg.toFixed(2)}  紧凑 ${eP.spread.avg.toFixed(2)}  重心距 ${eP.gap.avg.toFixed(2)}  球距 ${eP.ballDist.avg.toFixed(2)}`);
console.log(`  → 引擎 vs Metrica 纵深 ${(eP.hd.avg / mP.hd.avg).toFixed(2)}x   引擎 vs SC主口径 ${(eP.hd.avg / scP.hd.avg).toFixed(2)}x   引擎 vs SC全点 ${(eP.hd.avg / scA.hd.avg).toFixed(2)}x`);

console.log('\n=== (C) 分组口径等价性：固定 id 组 == 最深 4 人 的帧占比 ===');
function idOrderMatch(W, team, ids) {
  let same = 0; let tot = 0;
  for (const w of W) for (const f of w) {
    const isHome = team === 'home';
    const o = (f.players || []).filter((p) => p && !KEEPER_IDS.includes(p.id) && (isHome ? p.id <= 10 : p.id >= 11) && !p.extrapolated);
    if (o.length !== 10) continue;
    const a = o.filter((p) => ids.includes(p.id)).map((p) => p.id).sort((x, y) => x - y);
    const b = o.slice().sort((p, q) => p.x - q.x).slice(0, 4).map((p) => p.id).sort((x, y) => x - y);
    tot += 1; if (JSON.stringify(a) === JSON.stringify(b)) same += 1;
  }
  return { pct: 100 * same / tot, tot };
}
console.log(`  Metrica home id1-4   ${idOrderMatch(mW, 'home', [1, 2, 3, 4]).pct.toFixed(1)}%  (n=${idOrderMatch(mW, 'home', [1, 2, 3, 4]).tot})`);
console.log(`  Metrica away id17-20 ${idOrderMatch(mW, 'away', [17, 18, 19, 20]).pct.toFixed(1)}%`);
console.log(`  引擎    home id1-4   ${idOrderMatch(EW, 'home', [1, 2, 3, 4]).pct.toFixed(1)}%  (n=${idOrderMatch(EW, 'home', [1, 2, 3, 4]).tot})`);
console.log(`  SkillCorner home id1-4 (主口径恒10人帧) ${idOrderMatch(scW, 'home', [1, 2, 3, 4]).pct.toFixed(1)}%`);
console.log(`  SkillCorner home id1-4 (全点口径) ${idOrderMatch(scW.map((w) => w.map((f) => ({ ...f, players: f.players.map((p) => (p ? { ...p, extrapolated: false } : null)) }))), 'home', [1, 2, 3, 4]).pct.toFixed(1)}%`);
