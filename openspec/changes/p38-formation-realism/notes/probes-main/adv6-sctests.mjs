// adv6: SkillCorner 的规律在 Metrica 上成立吗？反之？用**同一份** order-gap 口径两侧对照。
// 同时检验 real-formation-laws §1.1 的 SK 列（均匀 2.0–2.9m）是否被 42% 外推点的过滤口径歪曲。
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const M = await import(pathToFileURL('../../../../../viewer/match-metrics.js').href);
const { fromTrackingFrame, cutWindows, KEEPER_IDS, framePitchMeters } = M;
const ROOT = '../../../../..';
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const pos = (sorted, p) => { const h = (sorted.length - 1) * p; const i = Math.floor(h); return i + 1 >= sorted.length ? sorted[sorted.length - 1] : sorted[i] + (h - i) * (sorted[i + 1] - sorted[i]); };
const P10 = Array.from({ length: 10 }, (_, i) => i / 9);

// 两侧**同口径**：ownXs 语义 —— 主队直取、客队镜像；跳过外推与否作为开关。
function gapsOf(frames, { includeExtrapolated = false, home = true, away = true } = {}) {
  const acc = Array.from({ length: 10 }, () => []);
  for (const f of frames) {
    for (const team of [home && 'home', away && 'away'].filter(Boolean)) {
      const isHome = team === 'home';
      const o = (f.players || []).filter((p) => p && !KEEPER_IDS.includes(p.id) && (isHome ? p.id <= 10 : p.id >= 11)
        && (includeExtrapolated || !p.extrapolated));
      if (o.length < 10) continue;
      const [L] = framePitchMeters(f);
      let xs = o.map((p) => (isHome ? p.x : 1 - p.x) * L).sort((a, b) => a - b);
      for (let i = 0; i < 10; i += 1) acc[i].push(pos(xs, P10[i]));
    }
  }
  const P = acc.map(mean); return P.slice(1).map((v, i) => v - P[i]);
}
// 分位口径（n 浮动也成立）
function gapsOfQ(frames, { includeExtrapolated = false } = {}) {
  const acc = Array.from({ length: 10 }, () => []);
  for (const f of frames) {
    for (const team of ['home', 'away']) {
      const isHome = team === 'home';
      const o = (f.players || []).filter((p) => p && !KEEPER_IDS.includes(p.id) && (isHome ? p.id <= 10 : p.id >= 11)
        && (includeExtrapolated || !p.extrapolated));
      if (o.length < 7) continue;
      const [L] = framePitchMeters(f);
      const xs = o.map((p) => (isHome ? p.x : 1 - p.x) * L).sort((a, b) => a - b);
      for (let i = 0; i < 10; i += 1) acc[i].push(pos(xs, P10[i]));
    }
  }
  const P = acc.map(mean); return P.slice(1).map((v, i) => v - P[i]);
}

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
const p = (v) => v.map((x) => x.toFixed(2)).join('/');
const argmax = (v) => v.indexOf(Math.max(...v)) + 1;

console.log('=== 相邻次序间距：两数据集 × 两口径（两侧同代码）===');
const mAll = [];
for (const n of ['1', '2']) for (const w of cutWindows(loadMetrica(n))) mAll.push(...w);
const scAll = [];
const scBy = {};
for (const id of SC) { scBy[id] = []; for (const w of cutWindows(loadSC(id))) scBy[id].push(...w); scAll.push(...scBy[id]); }

console.log(`Metrica 2 场  n=${mAll.length}  主+客 10人帧:  ${p(gapsOf(mAll))}   最大 @${argmax(gapsOf(mAll))}`);
console.log(`SC 6 场       n=${scAll.length}`);
console.log(`  仅 10 人帧（主口径，跳外推）      ${p(gapsOf(scAll))}   最大 @${argmax(gapsOf(scAll))}`);
console.log(`  全点口径（采信外推，恒 10 人）    ${p(gapsOf(scAll, { includeExtrapolated: true }))}   最大 @${argmax(gapsOf(scAll, { includeExtrapolated: true }))}`);
console.log(`  分位口径(≥7人, 跳外推)           ${p(gapsOfQ(scAll))}   最大 @${argmax(gapsOfQ(scAll))}`);
console.log(`  分位口径(≥7人, 全点)             ${p(gapsOfQ(scAll, { includeExtrapolated: true }))}   最大 @${argmax(gapsOfQ(scAll, { includeExtrapolated: true }))}`);

// 主队 only vs 主客合并（findings 2.9... vs design-b 2.7... 的差异来源）
console.log('\n=== Metrica：主队 only vs 主客合并（解释 findings 与 design-b 的真实列不一致）===');
console.log(`  主队 only   ${p(gapsOf(mAll, { away: false }))}`);
console.log(`  主客合并    ${p(gapsOf(mAll))}`);
console.log(`  客队 only   ${p(gapsOf(mAll, { home: false }))}`);

console.log('\n=== SkillCorner 逐场：间距形状稳吗？===');
for (const id of SC) console.log(`  ${id}  ${p(gapsOf(scBy[id]))}  最大@${argmax(gapsOf(scBy[id]))}  10人帧占比 ${(100 * scBy[id].filter((f) => f.players.filter((q) => q && !KEEPER_IDS.includes(q.id) && q.id <= 10 && !q.extrapolated).length === 10).length / scBy[id].length).toFixed(1)}%`);

console.log('\n=== 「最前一人脱离大部队」：最大间隙落点分布 ===');
function maxAt(frames, opts) {
  const hist = new Array(9).fill(0); let n = 0;
  for (const f of frames) for (const team of ['home', 'away']) {
    const isHome = team === 'home';
    const o = (f.players || []).filter((q) => q && !KEEPER_IDS.includes(q.id) && (isHome ? q.id <= 10 : q.id >= 11) && (opts.includeExtrapolated || !q.extrapolated));
    if (o.length < 10) continue;
    const [L] = framePitchMeters(f);
    const xs = o.map((q) => (isHome ? q.x : 1 - q.x) * L).sort((a, b) => a - b);
    const g = P10.slice(1).map((pp, i) => pos(xs, pp) - pos(xs, P10[i]));
    hist[g.indexOf(Math.max(...g))] += 1; n += 1;
  }
  return hist.map((v) => (100 * v / n).toFixed(1));
}
console.log(`  Metrica            ${maxAt(mAll, {}).join(' / ')}   (均匀 11.1)`);
console.log(`  SC 主口径(即10人)   ${maxAt(scAll, {}).join(' / ')}`);
console.log(`  SC 全点口径         ${maxAt(scAll, { includeExtrapolated: true }).join(' / ')}`);
