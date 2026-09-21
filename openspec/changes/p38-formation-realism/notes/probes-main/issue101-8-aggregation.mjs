// §5.5 需要的正确量：对 {7,14} 因子集，各算
//   (a) pooled（含**个人固定效应** + 情境）解释 devY 的份额 = 1 − C  ← §5 口径
//   (b) mean-of-per-person（每个「场·队·人」单元各自回归的 R² 再平均）← §2 口径
import * as P from './issue101-panel.mjs';
import * as C from './issue101-common.mjs';
const meta = await P.buildPanel({ stride: 10 });

const SETS = {
  '7 个（§5 用）': ['ballY', 'ballDepth', 'phase', 'nearOppY', 'k3OppY', 'oppCy', 'ownX'],
  '14 个（§2 用）': ['ballY', 'ballDepth', 'phase', 'nearOppY', 'k3OppY', 'oppCy', 'nearMateY', 'k3MateY', 'k3AnyY', 'nearAnyDist', 'goalOwnY', 'goalOppY', 'ownX', 'xXphase'],
};

for (const [label, CTX] of Object.entries(SETS)) {
  const ctxF = CTX.map((n) => P.FACTORS.find((f) => f.name === n));
  const cols = ctxF.map((f) => f.col);
  const byTeam = new Map();
  await P.readPanel((row) => {
    const y = row[P.IDX.y]; if (!Number.isFinite(y)) return;
    const xs = [];
    for (let k = 0; k < cols.length; k += 1) {
      const f = ctxF[k]; let v = row[f.col];
      if (f.signed) v = v === 1 ? 1 : v === 0 ? -1 : NaN;
      if (!Number.isFinite(v)) return;
      xs.push(v);
    }
    const u = meta.units[row[P.IDX.unit]];
    const key = `${u.match}|${u.team}`;
    if (!byTeam.has(key)) byTeam.set(key, { u: [], y: [], X: [] });
    const b = byTeam.get(key); b.u.push(row[P.IDX.unit]); b.y.push(y); b.X.push(xs);
  });
  const F = cols.length, K = F + 1;
  // pooled: 先组内去均值（个人固定效应），再回归 → 1 − C
  let A_sum = 0, dev_sum = 0, ctx_sum = 0, N = 0;
  // mean-of-per-person: 逐单元直接 R²（含截距）
  const perUnitR2 = [];
  for (const [, b] of byTeam) {
    const n = b.y.length; if (n < 400) continue;
    const grand = C.mean(b.y);
    const byLabel = new Map();
    for (let i = 0; i < n; i += 1) { if (!byLabel.has(b.u[i])) byLabel.set(b.u[i], []); byLabel.get(b.u[i]).push(b.y[i]); }
    let sumA = 0;
    for (const arr of byLabel.values()) sumA += arr.length * (C.mean(arr) - grand) ** 2;
    const A = sumA / n;
    const lm = new Map([...byLabel].map(([l, arr]) => [l, C.mean(arr)]));
    const devY = new Float64Array(n);
    for (let i = 0; i < n; i += 1) devY[i] = b.y[i] - lm.get(b.u[i]);
    const Xc = b.X.map((x) => Float64Array.from(x));
    for (let f = 0; f < F; f += 1) {
      const m = new Map();
      for (let i = 0; i < n; i += 1) { if (!m.has(b.u[i])) m.set(b.u[i], []); m.get(b.u[i]).push(Xc[i][f]); }
      const mm = new Map([...m].map(([l, arr]) => [l, C.mean(arr)]));
      for (let i = 0; i < n; i += 1) Xc[i][f] -= mm.get(b.u[i]);
    }
    const XtX = new Float64Array(K * K), Xty = new Float64Array(K);
    for (let i = 0; i < n; i += 1) for (let a = 0; a < K; a += 1) {
      const xa = a === 0 ? 1 : Xc[i][a - 1];
      for (let c = 0; c < K; c += 1) XtX[a * K + c] += xa * (c === 0 ? 1 : Xc[i][c - 1]);
      Xty[a] += xa * devY[i];
    }
    let tr = 0; for (let i = 0; i < K; i += 1) tr += XtX[i * K + i];
    const beta = solve(XtX, Xty, K, 1e-6 * tr / K);
    if (!beta) continue;
    let vc = 0;
    for (let i = 0; i < n; i += 1) { let p = beta[0]; for (let f = 0; f < F; f += 1) p += beta[f + 1] * Xc[i][f]; vc += p * p; }
    vc /= n;
    const vd = C.mean([...devY].map((v) => v ** 2));
    A_sum += n * A; dev_sum += n * vd; ctx_sum += n * vc; N += n;

    // (b) 逐单元（人）直接 R²：y ~ 1 + X
    const A2 = new Float64Array(K * K), b2 = new Float64Array(K);
    let sy = 0, syy = 0;
    for (let i = 0; i < n; i += 1) {
      for (let a = 0; a < K; a += 1) {
        const xa = a === 0 ? 1 : b.X[i][a - 1];
        for (let c = 0; c < K; c += 1) A2[a * K + c] += xa * (c === 0 ? 1 : b.X[i][c - 1]);
        b2[a] += xa * b.y[i];
      }
      sy += b.y[i]; syy += b.y[i] * b.y[i];
    }
    let tr2 = 0; for (let i = 0; i < K; i += 1) tr2 += A2[i * K + i];
    const bt = solve(A2, b2, K, 1e-6 * tr2 / K);
    if (!bt) continue;
    let bb = 0; for (let i = 0; i < K; i += 1) bb += bt[i] * b2[i];
    let q = 0; for (let i = 0; i < K; i += 1) for (let j = 0; j < K; j += 1) q += bt[i] * A2[i * K + j] * bt[j];
    const my = sy / n, sse = syy - 2 * bb + q, sst = syy - n * my * my;
    perUnitR2.push(sst > 0 ? Math.max(0, Math.min(1, 1 - sse / sst)) : 0);
  }
  const A = A_sum / N, dev = dev_sum / N, ctx = ctx_sum / N;
  const pooledC = (dev - ctx) / (A + dev);
  const mop = perUnitR2.reduce((a, b) => a + b, 0) / perUnitR2.length;
  console.log(`${label}`);
  console.log(`  (a) pooled（含个人固定效应）解释份额 = ${(100 * (1 - pooledC)).toFixed(1)}%   → C = ${(100 * pooledC).toFixed(1)}%`);
  console.log(`  (b) mean-of-per-person R²         = ${(100 * mop).toFixed(1)}%   → 未解释 = ${(100 * (1 - mop)).toFixed(1)}%`);
  console.log(`  聚合差 = ${(100 * (mop - (1 - pooledC))).toFixed(1)}pp`);
}
function solve(A, b, K, lam) {
  const M = new Float64Array(K * (K + 1));
  for (let i = 0; i < K; i += 1) { for (let j = 0; j < K; j += 1) M[i * (K + 1) + j] = A[i * K + j] + (i === j ? lam : 0); M[i * (K + 1) + K] = b[i]; }
  for (let c = 0; c < K; c += 1) {
    let p = c; for (let r = c + 1; r < K; r += 1) if (Math.abs(M[r * (K + 1) + c]) > Math.abs(M[p * (K + 1) + c])) p = r;
    if (Math.abs(M[p * (K + 1) + c]) < 1e-14) return null;
    if (p !== c) for (let j = c; j <= K; j += 1) { const t = M[c * (K + 1) + j]; M[c * (K + 1) + j] = M[p * (K + 1) + j]; M[p * (K + 1) + j] = t; }
    const d = M[c * (K + 1) + c]; for (let j = c; j <= K; j += 1) M[c * (K + 1) + j] /= d;
    for (let r = 0; r < K; r += 1) { if (r === c) continue; const f = M[r * (K + 1) + c]; if (f === 0) continue; for (let j = c; j <= K; j += 1) M[r * (K + 1) + j] -= f * M[c * (K + 1) + j]; }
  }
  const o = new Float64Array(K); for (let i = 0; i < K; i += 1) o[i] = M[i * (K + 1) + K]; return o;
}
