// P38：把真实侧量到的「队形规律」与**引擎当前行为**并列在同一张表里。
//
// 为什么需要：本报告的经验事实（真实队形规律）要能当"标尺"，必须与引擎在**同一口径**
//   下对照——这正是 P36/P37 的核心教训（两份"看起来一样"的实现会在细节里分叉）。
//   引擎侧采样完全复用 tools/benchmark-engine.mjs（wasm 加载 + 事件流 + seekTo 采样）
//   与 viewer/match-metrics.js 的常数（种子集、时长、采样间隔），**零新建口径**。
//
// ⚠ 引擎侧没有「位置标签」也没有「外推点」概念（每帧恒 11 人真观测），故：
//   - 位置分线（后防/中场/锋线）**只对 SkillCorner 成立**，引擎侧用次序分块（最深 4/中 4/最前 2）；
//     两者在报告里分开陈述，不混为一谈。
//   - 引擎侧无外推，故 primary 与 allPoints 逐位相同（表中只印一列）。
//
// 运行：node openspec/changes/p38-formation-realism/notes/probes/06-engine-contrast.mjs
// 前置：viewer/engine.wasm 存在（构建方式见 tools/benchmark-engine.mjs 的提示）。

import {
  loadAllReal, SKILLCORNER_IDS, ownXs, mean, q, fmt, bucketIndex, ballDepthFor, framePitchMeters,
  orderGaps,
} from './corpus.mjs';
import { loadAllSkillcornerRoles, linesOfFrame } from './roles.mjs';
import { P38_REPO } from './repo-root.mjs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const { loadEngineWasm, simulateStream, WASM_PATH } = await import(
  pathToFileURL(join(P38_REPO, 'tools', 'benchmark-engine.mjs')).href);
const metrics = await import(pathToFileURL(join(P38_REPO, 'viewer', 'match-metrics.js')).href);
const { BENCHMARK_SEEDS, ENGINE_DURATION_SEC, sampleEngineFrames, KEEPER_IDS } = metrics;

const load = await loadEngineWasm(WASM_PATH);
if (!load.ok) { console.error(load.message); process.exit(1); }
const { createGame } = await import(pathToFileURL(join(P38_REPO, 'viewer', 'game.js')).href);

// **引擎指纹 + 时间戳**（必读）：调研期间实测发现 `viewer/engine.wasm` 会被**并发重建**
// （本次调研中 01:18 的一次重建让弹性 Δ 从 +12.1m 变成 −2.8m、4→5 间距从 19.0m 变成 14.2m
// ——同一份探针代码、同一份数据，仅引擎二进制不同）。固此处把引擎的 sha256 与 mtime
// **打进输出**：任何引用本节数字的地方，都能凭指纹判断"这组数是哪个引擎跑出来的"。
// 真实侧（SkillCorner/Metrica）不受影响——本探针的引擎列才是会漂的那一列。
{
  const { createHash } = await import('node:crypto');
  const { readFileSync, statSync } = await import('node:fs');
  const buf = readFileSync(WASM_PATH);
  console.log(`引擎指纹 sha256 ${createHash('sha256').update(buf).digest('hex')}`);
  console.log(`引擎文件 mtime ${statSync(WASM_PATH).mtime.toISOString()}  字节 ${buf.length}`);
}

// 引擎帧：与 probe2/probe3 一致取前 3 个种子（口径与主 session 的探针相同）
const engineFrames = [];
for (const seed of BENCHMARK_SEEDS.slice(0, 3)) {
  const game = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  engineFrames.push(...sampleEngineFrames(game));
}
console.log(`引擎样本：种子 ${BENCHMARK_SEEDS.slice(0, 3).join(', ')}，${engineFrames.length} 帧 @0.2s`);
console.log('（引擎无外推概念，故无主/全点之分；真实侧取主口径）\n');

const EDGES = [0, 0.14, 0.28, 0.42, 0.58, 0.72, 0.86, 1.0];
const NB = EDGES.length - 1;
const lbl = (i) => `[${(EDGES[i] * 105).toFixed(0)}–${(EDGES[i + 1] * 105).toFixed(0)})`;

// 引擎帧的队形读数（与真实侧同构：ownXs 的镜像口径、q10–q90 纵深、最深 4/最前 2 分块）
function engineRows() {
  const rows = [];
  for (const f of engineFrames) {
    if (!f.ball || !Number.isFinite(f.ball[0])) continue;
    for (const team of ['home', 'away']) {
      const xs = ownXs(f, team);
      if (!xs) continue;
      const [L] = framePitchMeters(f);
      const depth = ballDepthFor(f, team);
      const bi = bucketIndex(depth / L, EDGES);
      if (bi < 0) continue;
      rows.push({
        bi, ballDepth: depth,
        depth: q(xs, 0.9) - q(xs, 0.1),
        back4: mean(xs.slice(0, 4)),
        front2: mean(xs.slice(-2)),
        frontmost: xs[xs.length - 1],
        gaps: orderGaps(xs),
        n: xs.length,
      });
    }
  }
  return rows;
}
const eRows = engineRows();

const matches = loadAllReal();
const scMatches = matches.filter((m) => m.dataset === 'skillcorner');
const metrica = matches.filter((m) => m.dataset === 'metrica');
const roles = loadAllSkillcornerRoles(SKILLCORNER_IDS);

// 真实侧逐桶（主口径）
function realRows(subset) {
  const rows = [];
  for (const m of subset) {
    for (const f of m.frames) {
      if (!f.ball || !metrics.isRawBallFrame(f)) continue;
      const [L] = framePitchMeters(f);
      for (const team of ['home', 'away']) {
        const depth = ballDepthFor(f, team);
        if (depth == null) continue;
        const bi = bucketIndex(depth / L, EDGES);
        if (bi < 0) continue;
        const xs = ownXs(f, team);
        if (!xs) continue;
        const rec = {
          bi, ballDepth: depth, depth: q(xs, 0.9) - q(xs, 0.1),
          back4: mean(xs.slice(0, 4)), front2: mean(xs.slice(-2)),
          frontmost: xs[xs.length - 1],
          gaps: orderGaps(xs),
          lineDef: null, lineMid: null, lineAtt: null,
        };
        if (m.dataset === 'skillcorner') {
          const Ln = linesOfFrame(f, team, roles.get(m.id).roleById);
          if (Ln.defence.length) rec.lineDef = mean(Ln.defence);
          if (Ln.midfield.length) rec.lineMid = mean(Ln.midfield);
          if (Ln.attack.length) rec.lineAtt = mean(Ln.attack);
        }
        rows.push(rec);
      }
    }
  }
  return rows;
}
const rSc = realRows(scMatches);
const rMet = realRows(metrica);

console.log('=== 对照 1：球队纵深（q10–q90）随球深度——引擎 vs 真实 ===\n');
console.log('球深度区间     引擎      n        SkillCorner   n        Metrica    n');
for (let i = 0; i < NB; i += 1) {
  const e = eRows.filter((r) => r.bi === i).map((r) => r.depth);
  const s = rSc.filter((r) => r.bi === i).map((r) => r.depth);
  const mm = rMet.filter((r) => r.bi === i).map((r) => r.depth);
  if (e.length < 30) continue;
  console.log(`${lbl(i).padEnd(12)}${fmt(mean(e), 1).padStart(8)}${String(e.length).padStart(8)}`
    + `${fmt(mean(s), 1).padStart(13)}${String(s.length).padStart(8)}${fmt(mean(mm), 1).padStart(12)}${String(mm.length).padStart(7)}`);
}
{
  const e = eRows.map((r) => r.depth); const s = rSc.map((r) => r.depth); const mm = rMet.map((r) => r.depth);
  console.log(`\n全区间均值：引擎 ${fmt(mean(e), 1)}m（n=${e.length}）`
    + ` | SkillCorner ${fmt(mean(s), 1)}m | Metrica ${fmt(mean(mm), 1)}m`);
  console.log(`引擎/真实 比：SkillCorner ${fmt(mean(e) / mean(s), 2)}×  Metrica ${fmt(mean(e) / mean(mm), 2)}×`);
}

console.log('\n=== 对照 2：锋线（最前 1 人）随球深度 ===\n');
console.log('球深度区间     引擎最前1人   n      SkillCorner   n      Metrica    n');
for (let i = 0; i < NB; i += 1) {
  const e = eRows.filter((r) => r.bi === i).map((r) => r.frontmost);
  const s = rSc.filter((r) => r.bi === i).map((r) => r.frontmost);
  const mm = rMet.filter((r) => r.bi === i).map((r) => r.frontmost);
  if (e.length < 30) continue;
  console.log(`${lbl(i).padEnd(12)}${fmt(mean(e), 1).padStart(12)}${String(e.length).padStart(8)}`
    + `${fmt(mean(s), 1).padStart(13)}${String(s.length).padStart(8)}${fmt(mean(mm), 1).padStart(12)}${String(mm.length).padStart(7)}`);
}
{
  // 回撤幅度：球在对方最深桶 vs 球在本方最深桶
  const eHi = mean(eRows.filter((r) => r.bi === NB - 1).map((r) => r.frontmost));
  const eLo = mean(eRows.filter((r) => r.bi === 0).map((r) => r.frontmost));
  const sHi = mean(rSc.filter((r) => r.bi === NB - 1).map((r) => r.frontmost));
  const sLo = mean(rSc.filter((r) => r.bi === 0).map((r) => r.frontmost));
  const mHi = mean(rMet.filter((r) => r.bi === NB - 1).map((r) => r.frontmost));
  const mLo = mean(rMet.filter((r) => r.bi === 0).map((r) => r.frontmost));
  console.log(`\n锋线回撤幅度（球在[90–105) − 球在[0–15)）：引擎 ${fmt(eHi - eLo, 1)}m`
    + ` | SkillCorner ${fmt(sHi - sLo, 1)}m | Metrica ${fmt(mHi - mLo, 1)}m`);
}

console.log('\n=== 对照 3：相邻次序间距（分位口径 p=(i−1)/9，全区间）===\n');
// 与 02-line-structure 同一估计量：每帧 10 个分位位置的一阶差分，对帧取均值。
// 引擎侧 n 恒 11（含门将？不——ownXs 剔门将后恒 10），故 n=10，与 probe2 逐位一致。
console.log('次序对    引擎     SkillCorner   Metrica');
{
  const gapAcc = (rowsLike) => {
    const acc = Array.from({ length: 9 }, () => []);
    for (const r of rowsLike) for (let i = 0; i < 9; i += 1) acc[i].push(r.gaps[i]);
    return acc.map(mean);
  };
  const eG = gapAcc(eRows); const sG = gapAcc(rSc); const mG = gapAcc(rMet);
  for (let i = 0; i < 9; i += 1) {
    console.log(`  ${i + 1}→${i + 2}${fmt(eG[i], 2).padStart(9)}${fmt(sG[i], 2).padStart(13)}${fmt(mG[i], 2).padStart(10)}`);
  }
  console.log(`  总计${fmt(mean(eG), 2).padStart(9)}${fmt(mean(sG), 2).padStart(13)}${fmt(mean(mG), 2).padStart(10)}  （= 各次序对间距的均值）`);
  console.log('  最大单对：引擎 ' + `${
    eG.indexOf(Math.max(...eG)) + 1}→${eG.indexOf(Math.max(...eG)) + 2} (${fmt(Math.max(...eG), 1)}m)`
    + `  SkillCorner ${sG.indexOf(Math.max(...sG)) + 1}→${sG.indexOf(Math.max(...sG)) + 2} (${fmt(Math.max(...sG), 1)}m)`
    + `  Metrica ${mG.indexOf(Math.max(...mG)) + 1}→${mG.indexOf(Math.max(...mG)) + 2} (${fmt(Math.max(...mG), 1)}m)`);
}

console.log('\n=== 对照 4：弹性口径（match-metrics.elasticity, divider=half）===\n');
{
  const own = []; const opp = [];
  for (const r of eRows) (r.ballDepth < 52.5 ? own : opp).push(r.depth);
  console.log(`引擎：本方半场纵深 ${fmt(mean(own), 1)}m（n=${own.length}）  对方半场 ${fmt(mean(opp), 1)}m（n=${opp.length}）  Δ ${fmt(mean(opp) - mean(own), 1)}m`);
  const ro = rSc.filter((r) => r.ballDepth < 52.5).map((r) => r.depth);
  const rp = rSc.filter((r) => r.ballDepth >= 52.5).map((r) => r.depth);
  console.log(`SkillCorner：本方半场 ${fmt(mean(ro), 1)}m（n=${ro.length}）  对方半场 ${fmt(mean(rp), 1)}m（n=${rp.length}）  Δ ${fmt(mean(rp) - mean(ro), 1)}m`);
  const mo = rMet.filter((r) => r.ballDepth < 52.5).map((r) => r.depth);
  const mp = rMet.filter((r) => r.ballDepth >= 52.5).map((r) => r.depth);
  console.log(`Metrica：本方半场 ${fmt(mean(mo), 1)}m（n=${mo.length}）  对方半场 ${fmt(mean(mp), 1)}m（n=${mp.length}）  Δ ${fmt(mean(mp) - mean(mo), 1)}m`);
}
