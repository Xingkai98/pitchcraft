// wayfinder #101 探针 9：**情境因子集敏感性**——A/B/C 随因子集怎么变。
//
// 动机：报告 §5.1b 的第一版编造了一行"只用队友/对手的非自指因子 = 56.4/21.7/21.9"，
// 第二轮审阅指出该组合不存在。本探针把**所有候选因子集**在同一份面板上跑一遍，
// 给出实测区间（B 23.3–36.1%、C 9.7–20.3%），取代那行编造值。
//
// 运行：node issue101-9-factor-sets.mjs
// 产出：out/101-9-factor-sets.txt

import * as P from './issue101-panel.mjs';
import * as C from './issue101-common.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const meta = await P.buildPanel({ stride: 10 });
const lines = [];
const say = (x = '') => { lines.push(x); console.log(x); };
mkdirSync(C.OUT_DIR, { recursive: true });
say('# #101 探针 9：情境因子集敏感性\n');

const SETS = {
  '第一版（含自指 nearMateGap）': ['ballY', 'ballDepth', 'phase', 'nearOppY', 'oppCy', 'nearMateGap', 'ownX'],
  '现版 7 个（球+对手+本人x）': ['ballY', 'ballDepth', 'phase', 'nearOppY', 'k3OppY', 'oppCy', 'ownX'],
  '队/对手位置 5 个（§4.2 的 REL）': ['nearMateY', 'k3MateY', 'nearOppY', 'k3OppY', 'oppCy'],
  'REL5 + 球 3 个': ['nearMateY', 'k3MateY', 'nearOppY', 'k3OppY', 'oppCy', 'ballY', 'ballDepth'],
  'REL5 + 球 + 相位 + 本人x（10 个）': ['nearMateY', 'k3MateY', 'nearOppY', 'k3OppY', 'oppCy', 'ballY', 'ballDepth', 'phase', 'ownX'],
};
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
  let A_sum = 0, dev_sum = 0, ctx_sum = 0, N = 0;
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
    const beta = solve(XtX, Xty, K, 1e-6 * tr / K); if (!beta) continue;
    let vc = 0;
    for (let i = 0; i < n; i += 1) { let p = beta[0]; for (let f = 0; f < F; f += 1) p += beta[f + 1] * Xc[i][f]; vc += p * p; }
    vc /= n;
    const vd = C.mean([...devY].map((v) => v ** 2));
    A_sum += n * A; dev_sum += n * vd; ctx_sum += n * vc; N += n;
  }
  const A = A_sum / N, dev = dev_sum / N, ctx = ctx_sum / N, tot = A + dev;
  say(`${label.padEnd(34)} A=${(100 * A / tot).toFixed(1)}%  B=${(100 * ctx / tot).toFixed(1)}%  C=${(100 * (dev - ctx) / tot).toFixed(1)}%`);
}

writeFileSync(join(C.OUT_DIR, '101-9-factor-sets.txt'), lines.join('\n'));
console.log(`\n→ ${join(C.OUT_DIR, '101-9-factor-sets.txt')}`);
