// adv3: 靶子调查 —— Metrica vs SkillCorner 的"纵深"到底差多少，差在哪。
// 用**同一份** match-metrics 口径，逐数据集、逐口径（主/全点）打印。
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const M = await import(pathToFileURL('../../../../../viewer/match-metrics.js').href);
const { fromTrackingFrame, cutWindows, windowMetrics, summarizeWindowMetrics, framePitchMeters } = M;
const ROOT = '../../../../..';
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

function loadMetrica(n) {
  const g = JSON.parse(readFileSync(`${ROOT}/viewer/data/real-game-${n}.json`, 'utf8'));
  return g.frames.map((fr) => fromTrackingFrame({ t: fr.t, ball: fr.ball || null,
    players: fr.players.map((p, id) => (p ? [p[0], p[1]] : null)) }, { pitchMeters: [105, 68] }));
}
function loadSC(id) {
  const g = JSON.parse(readFileSync(`${ROOT}/.scratch/p38-frames/skillcorner-${id}.json`, 'utf8'));
  const pm = [g.meta.pitchMeters.length, g.meta.pitchMeters.width];
  return g.frames.map((fr) => fromTrackingFrame(fr, { pitchMeters: pm }));
}

const SC = ['1874553', '1886347', '1899585', '1959846', '2007448', '2013725'];

function report(name, frames, pm) {
  const w = cutWindows(frames);
  const s = summarizeWindowMetrics(w.map((x) => windowMetrics(x, { pitchMeters: pm }).primary));
  const ratio = (s.hd.avg / s.width.avg);
  console.log(`${name.padEnd(28)} 窗 ${String(w.length).padStart(3)}  纵深主 ${s.hd.avg.toFixed(2)} (n${s.hd.n})  全点 ${s.hdAll?.avg?.toFixed(2)}  宽 ${s.width.avg.toFixed(2)}  gap ${s.gap.avg.toFixed(2)}  spread ${s.spread.avg.toFixed(2)}  球距 ${s.ballDist?.avg?.toFixed(2)}  深/宽 ${ratio.toFixed(3)}`);
  return { w: w.length, s };
}

console.log('=== 靶子调查：同一份 match-metrics 口径 ===');
for (const n of ['1', '2']) report(`Metrica g${n}`, loadMetrica(n), [105, 68]);
const mAll = [];
for (const n of ['1', '2']) mAll.push(...loadMetrica(n));
// 合并 Metrica 两场（分层：逐场换算已是 105）
{
  const w = [];
  for (const n of ['1', '2']) { for (const x of cutWindows(loadMetrica(n))) w.push(x); }
  const s = summarizeWindowMetrics(w.map((x) => windowMetrics(x, { pitchMeters: [105, 68] }).primary));
  console.log(`Metrica 合并(逐场窗)        窗 ${String(w.length).padStart(3)}  纵深主 ${s.hd.avg.toFixed(2)} (n${s.hd.n})  宽 ${s.width.avg.toFixed(2)}  gap ${s.gap.avg.toFixed(2)}  spread ${s.spread.avg.toFixed(2)}  球距 ${s.ballDist?.avg?.toFixed(2)}`);
}
for (const id of SC) {
  const g = JSON.parse(readFileSync(`${ROOT}/.scratch/p38-frames/skillcorner-${id}.json`, 'utf8'));
  report(`SC ${id}(${g.meta.pitchMeters.length})`, loadSC(id), [g.meta.pitchMeters.length, g.meta.pitchMeters.width]);
}
// SkillCorner 合并
{
  const w = [];
  for (const id of SC) { const g = JSON.parse(readFileSync(`${ROOT}/.scratch/p38-frames/skillcorner-${id}.json`, 'utf8'));
    for (const x of cutWindows(loadSC(id))) w.push({ x, pm: [g.meta.pitchMeters.length, g.meta.pitchMeters.width] }); }
  const s = summarizeWindowMetrics(w.map(({ x, pm }) => windowMetrics(x, { pitchMeters: pm }).primary));
  console.log(`SC 6 场合并(逐场窗)          窗 ${String(w.length).padStart(3)}  纵深主 ${s.hd.avg.toFixed(2)} (n${s.hd.n})  宽 ${s.width.avg.toFixed(2)}  gap ${s.gap.avg.toFixed(2)}  spread ${s.spread.avg.toFixed(2)}  球距 ${s.ballDist?.avg?.toFixed(2)}`);
}
// 关键：主口径 vs 全点口径的纵深
console.log('\n=== 同一批窗，主口径 vs 全点口径（纵深 hd）===');
{
  const w = [];
  for (const id of SC) { const g = JSON.parse(readFileSync(`${ROOT}/.scratch/p38-frames/skillcorner-${id}.json`, 'utf8'));
    for (const x of cutWindows(loadSC(id))) w.push({ x, pm: [g.meta.pitchMeters.length, g.meta.pitchMeters.width] }); }
  const prim = summarizeWindowMetrics(w.map(({ x, pm }) => windowMetrics(x, { pitchMeters: pm }).primary));
  const all = summarizeWindowMetrics(w.map(({ x, pm }) => windowMetrics(x, { pitchMeters: pm }).allPoints));
  console.log(`SC 主口径 纵深 ${prim.hd.avg.toFixed(2)}  宽 ${prim.width.avg.toFixed(2)}  spread ${prim.spread.avg.toFixed(2)}  gap ${prim.gap.avg.toFixed(2)}`);
  console.log(`SC 全点口径 纵深 ${all.hd.avg.toFixed(2)}  宽 ${all.width.avg.toFixed(2)}  spread ${all.spread.avg.toFixed(2)}  gap ${all.gap.avg.toFixed(2)}`);
  // 逐帧有效人数
  let hist = new Map();
  for (const { x: win, pm } of w) for (const f of win) {
    const n = f.players.filter((p) => p && p.id <= 10 && !p.extrapolated).length;
    hist.set(n, (hist.get(n) || 0) + 1);
  }
  console.log('  主队逐帧有效非门将人数分布:', [...hist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(' '));
}
