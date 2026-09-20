// P38 线 B：**盯人 R²=0.85 是不是假的？**（对 probe-lateral-drivers 的反证条）
//
// 上一支探针测到「y ~ 最近对手的 y」R² = 0.85（球位只有 0.17）。**但这个数有一个明显的
// 混淆**：「最近对手」是**用含 y 的 2D 距离**选出来的——选出来的那个人天然就在我旁边，
// 他的 y 当然接近我的 y。这可能是**选择偏倚**（by construction），不是"我在盯他"。
//
// 本探针做三条反证，只有全部通过，0.85 才能当机制依据：
//
//   T1 基线对照：换成「最近的**队友**」→ 若也高，说明 R² 高只反映"两人靠近"（两队都成块）
//   T2 固定配对：把每人的盯人对象**在窗口开始时定死**（不逐帧重选），再算 R²。
//      真的盯人 → 配对会保持，R² 仍高；纯粹的邻近假象 → 对象漂走，R² 塌。
//   T3 身份稳定性：统计「逐帧最近对手」是同一个人的帧占比。真盯人应长时间稳定。
//
// 另加 T4：**交叉相关**——我的 y(t) 与对手的 y(t+Δ)，Δ>0 时若更高，说明我在**跟随**他
//（跟随是机制，同步只是相关）。
//
// 用法：node probe-marking-confound.mjs

import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from '../probes/repo-root.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = findRepoRoot(HERE);
const { KEEPER_IDS, PITCH_WIDTH_M } = await import(`${ROOT}/viewer/match-metrics.js`);

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function corr(a, b) {
  const n = Math.min(a.length, b.length);
  const A = a.slice(0, n); const B = b.slice(0, n);
  const ma = mean(A); const mb = mean(B);
  let s = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i += 1) { const x = A[i] - ma; const y = B[i] - mb; s += x * y; da += x * x; db += y * y; }
  return da > 0 && db > 0 ? s / Math.sqrt(da * db) : 0;
}
const dist = (a, b) => Math.hypot((a[0] - b[0]) * 105, (a[1] - b[1]) * 68);

for (const g of ['1', '2']) {
  const d = JSON.parse(readFileSync(`${ROOT}/viewer/data/real-game-${g}.json`, 'utf8'));
  const frames = d.frames.filter((f) => f.ball);
  const ids = [...new Set(frames.flatMap((f) => f.players.map((_, i) => i)))].filter((i) => !KEEPER_IDS.includes(i));

  // 逐球员三条序列：自己的 y、逐帧最近对手的 y、逐帧最近队友的 y
  const rec = new Map(ids.map((i) => [i, { y: [], opp: [], mate: [], oppId: [] }]));
  for (const f of frames) {
    const pts = f.players.map((p, i) => (p && !KEEPER_IDS.includes(i) ? { i, p } : null)).filter(Boolean);
    if (pts.length < 14) continue;
    for (const { i, p } of pts) {
      let bo = null; let boD = Infinity; let bm = null; let bmD = Infinity;
      for (const o of pts) {
        if (o.i === i) continue;
        const dd = dist(o.p, p);
        if ((o.i <= 10) !== (i <= 10)) { if (dd < boD) { boD = dd; bo = o; } }
        else if (dd < bmD) { bmD = dd; bm = o; }
      }
      const r = rec.get(i);
      r.y.push(p[1] * PITCH_WIDTH_M);
      r.opp.push(bo ? bo.p[1] * PITCH_WIDTH_M : NaN);
      r.mate.push(bm ? bm.p[1] * PITCH_WIDTH_M : NaN);
      r.oppId.push(bo ? bo.i : -1);
    }
  }

  let sOpp = 0; let sOppN = 0; let sMate = 0; let sMateN = 0;
  let sFix = 0; let sFixN = 0; let sStable = 0; let sStableN = 0;
  const lagCorr = new Map(); // Δ -> 累加
  for (const i of ids) {
    const r = rec.get(i);
    if (r.y.length < 500) continue;
    // T2：固定配对 = 该球员**出现次数最多**的最近对手（窗口内定死）
    const tally = new Map();
    for (const oid of r.oppId) tally.set(oid, (tally.get(oid) || 0) + 1);
    let fixedId = -1; let bestN = 0;
    for (const [k, v] of tally) if (k >= 0 && v > bestN) { bestN = v; fixedId = k; }
    sStable += bestN / r.oppId.length; sStableN += 1;

    // 固定配对序列：取该对手的 y（按帧对齐）
    const fixedY = [];
    for (let k = 0; k < r.oppId.length; k += 1) {
      const oid = r.oppId[k];
      if (oid !== fixedId) { fixedY.push(NaN); continue; }
      fixedY.push(r.opp[k]);
    }
    const okIdx = fixedY.map((v, k) => (Number.isFinite(v) ? k : -1)).filter((k) => k >= 0);
    if (okIdx.length > 300) {
      sFix += corr(okIdx.map((k) => r.y[k]), okIdx.map((k) => fixedY[k])) ** 2;
      sFixN += 1;
    }
    // T1 队友
    const mIdx = r.mate.map((v, k) => (Number.isFinite(v) ? k : -1)).filter((k) => k >= 0);
    if (mIdx.length > 300) { sMate += corr(mIdx.map((k) => r.y[k]), mIdx.map((k) => r.mate[k])) ** 2; sMateN += 1; }
    // D5 逐帧
    const oIdx = r.opp.map((v, k) => (Number.isFinite(v) ? k : -1)).filter((k) => k >= 0);
    if (oIdx.length > 300) { sOpp += corr(oIdx.map((k) => r.y[k]), oIdx.map((k) => r.opp[k])) ** 2; sOppN += 1; }
    // T4 交叉相关：我的 y(t) vs 对手 y(t+Δ)，Δ ∈ {-10..10} tick（1 tick = 0.2s？帧间隔见下）
    for (let dlt = -8; dlt <= 8; dlt += 1) {
      const a = []; const b = [];
      for (let k = 0; k + dlt >= 0 && k + dlt < r.opp.length; k += 1) {
        if (!Number.isFinite(r.opp[k + dlt])) continue;
        a.push(r.y[k]); b.push(r.opp[k + dlt]);
      }
      if (a.length > 300) lagCorr.set(dlt, (lagCorr.get(dlt) || 0) + corr(a, b));
    }
  }

  console.log(`\n=== Metrica game${g} ===`);
  console.log(`  T1 逐帧最近**队友** y      R² = ${(sMate / sMateN).toFixed(3)}   （对照：最近对手 ${(sOpp / sOppN).toFixed(3)}）`);
  console.log(`  T2 固定配对（窗口定死）    R² = ${(sFix / (sFixN || 1)).toFixed(3)}   （n=${sFixN} 人）`);
  console.log(`  T3 最近对手身份稳定占比    ${(100 * sStable / sStableN).toFixed(1)}%`);
  const lags = [...lagCorr.entries()].sort((a, b) => a[0] - b[0]);
  const peak = lags.reduce((m, v) => (v[1] > m[1] ? v : m), lags[0]);
  console.log(`  T4 交叉相关峰值在 Δ=${peak[0]} 帧（${(peak[0] * 0.04).toFixed(2)}s），corr=${(peak[1] / sOppN).toFixed(3)}`);
  console.log(`     Δ<0（我领先）/ Δ=0 / Δ>0（我跟随）: `
    + `${(lagCorr.get(-2) / sOppN).toFixed(3)} / ${(lagCorr.get(0) / sOppN).toFixed(3)} / ${(lagCorr.get(2) / sOppN).toFixed(3)}`);
  console.log(`     全 Δ 曲线: ${lags.map(([k, v]) => `${k}:${(v / sOppN).toFixed(2)}`).join(' ')}`);
}
