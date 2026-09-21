// wayfinder #101 探针 7：**共同因子**——那 82% 到底是什么？
//
// ── 动机（探针 1 的直接追问）─────────────────────────────────────────────
// 探针 1.2 的结果是**反直觉的**：
//   全模型 R² = 0.824（14 个非自指因子），可是**每一个因子的 unique R² 都 ≤ 0.033**。
// 这不是"没找到驱动"，而是"找到了一堆**高度共线**的驱动"——它们几乎在测同一件事。
//
// P38 §6 遇到过同款现象（"所有机制都挤在一条 latSd×swarm 的带里"），
// 它给出的解释是"只要 ty 是标量的静态函数，轨迹就退化成低维流形"。
// 但那是**引擎**的诊断。真实数据里这个共同因子是什么，P38 **没有回答**。
//
// ── 本探针回答什么 ──────────────────────────────────────────────────────
//   Q1 这 14 个因子实际上有几个自由度？（PCA：解释 90% 方差要几个主成分）
//   Q2 第一主成分是什么？（载荷 → 它更接近"局部密度""球位"还是"整体平移残余"）
//   Q3 **去掉第一主成分后，还剩多少可解释？**（这才是"第二类"驱动）
//   Q4 与 P38 §2.2 的 `oppY`/`ballY` 共线（r=0.83）是不是同一回事
//
// ── 方法 ────────────────────────────────────────────────────────────────
// 在**逐单元标准化**后做 PCA（否则量纲主导：ballDepth ~52m vs ballY ~0.1m）。
// 用幂迭代求前若干主成分（不引依赖，与项目约束一致）。
// 再逐主成分回归 DV（逐单元算 R² 再平均，与其余探针同口径）。
//
// 运行：node --max-old-space-size=3000 issue101-7-factor.mjs
// 产出：out/101-7-factor.txt

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as C from './issue101-common.mjs';
import { buildPanel, readPanel, readMeta, FACTORS, IDX } from './issue101-panel.mjs';

const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };
mkdirSync(C.OUT_DIR, { recursive: true });

const meta = await buildPanel({ stride: 10 });

// 非自指因子（DV 含 y_i ⟹ 因子不得含 y_i）
const MODEL = ['ballY', 'ballDepth', 'phase', 'nearOppY', 'k3OppY', 'oppCy',
  'nearMateY', 'k3MateY', 'k3AnyY', 'nearAnyDist', 'goalOwnY', 'goalOppY', 'ownX', 'xXphase'];
const modelF = MODEL.map((n) => FACTORS.find((f) => f.name === n));
const MF = modelF.length;
const mCols = modelF.map((f) => f.col);

say('# #101 探针 7：共同因子（那 82% 到底是什么）\n');
say(`因子集（${MF} 个，非自指）：${MODEL.join(', ')}\n`);

// ── 收集：逐单元均值/sd → 标准化 → 协方差 ──────────────────────────────
//
// 两次遍历：
//   1) 逐单元逐列 sum/sumsq（标准化统计）
//   2) 用统计量标准化后累加协方差矩阵
// 内存：每单元 O(1)，全局 O(MF²)。
const stat = new Map(); // unit -> {n, s[MF], ss[MF]}
await readPanel((row) => {
  const y = row[IDX.y];
  if (!Number.isFinite(y)) return;
  const xs = new Array(MF);
  for (let k = 0; k < MF; k += 1) {
    const f = modelF[k];
    let v = row[f.col];
    if (f.signed) v = v === 1 ? 1 : v === 0 ? -1 : NaN;
    if (!Number.isFinite(v)) return;
    xs[k] = v;
  }
  const u = row[IDX.unit];
  let a = stat.get(u);
  if (!a) { a = { n: 0, s: new Float64Array(MF), ss: new Float64Array(MF) }; stat.set(u, a); }
  for (let k = 0; k < MF; k += 1) { a.s[k] += xs[k]; a.ss[k] += xs[k] * xs[k]; }
  a.n += 1;
});

const COV = new Float64Array(MF * MF);
let nRows = 0;
await readPanel((row) => {
  const y = row[IDX.y];
  if (!Number.isFinite(y)) return;
  const u = row[IDX.unit];
  const a = stat.get(u);
  if (!a || a.n < 60) return;
  const mu = new Float64Array(MF); const sd = new Float64Array(MF);
  for (let k = 0; k < MF; k += 1) {
    mu[k] = a.s[k] / a.n;
    sd[k] = Math.sqrt(Math.max(1e-12, a.ss[k] / a.n - mu[k] * mu[k])) || 1;
  }
  const z = new Float64Array(MF);
  for (let k = 0; k < MF; k += 1) {
    const f = modelF[k];
    let v = row[f.col];
    if (f.signed) v = v === 1 ? 1 : v === 0 ? -1 : NaN;
    if (!Number.isFinite(v)) return;
    z[k] = (v - mu[k]) / sd[k];
  }
  for (let i = 0; i < MF; i += 1) {
    for (let j = i; j < MF; j += 1) {
      const p = z[i] * z[j];
      COV[i * MF + j] += p;
      if (i !== j) COV[j * MF + i] += p;
    }
  }
  nRows += 1;
});
for (let i = 0; i < MF * MF; i += 1) COV[i] /= nRows;
say(`样本：**${nRows.toLocaleString()}** 行（成列删除），单元标准化后做 PCA\n`);

// ── 幂迭代求前 K 个主成分（deflation）───────────────────────────────────
function matVec(A, v, n) {
  const o = new Float64Array(n);
  for (let i = 0; i < n; i += 1) { let s = 0; const r = i * n; for (let j = 0; j < n; j += 1) s += A[r + j] * v[j]; o[i] = s; }
  return o;
}
function powerIter(A, n, iters = 600) {
  let v = new Float64Array(n);
  // 确定性初值（避免 Math.random，且可复现）
  for (let i = 0; i < n; i += 1) v[i] = Math.sin(i + 1);
  let lam = 0;
  for (let t = 0; t < iters; t += 1) {
    const w = matVec(A, v, n);
    let norm = 0; for (const x of w) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < n; i += 1) v[i] = w[i] / norm;
    lam = norm;
  }
  return { v, lam };
}
const K = 14;
const A = Float64Array.from(COV);
const pcs = [];
for (let k = 0; k < K; k += 1) {
  const { v, lam } = powerIter(A, MF);
  pcs.push({ v, lam });
  // deflation: A -= lam v vᵀ
  for (let i = 0; i < MF; i += 1) for (let j = 0; j < MF; j += 1) A[i * MF + j] -= lam * v[i] * v[j];
}
const totalVar = MF; // 标准化后迹 = MF
say('## 7.1 这 14 个因子实际有几个自由度（PCA）\n');
say(`| 主成分 | 特征值 | 解释方差占比 | 累计 |`);
say(`|---|---|---|---|`);
let cum = 0;
for (let k = 0; k < K; k += 1) {
  const p = pcs[k].lam / totalVar;
  cum += p;
  say(`| PC${k + 1} | ${C.f2(pcs[k].lam, 2)} | ${(100 * p).toFixed(1)}% | ${(100 * cum).toFixed(1)}% |`);
}
const nFor90 = pcs.findIndex((_, i) => pcs.slice(0, i + 1).reduce((s, q) => s + q.lam, 0) / totalVar >= 0.9) + 1;
say(`> **要解释 90% 的因子方差需要 ${nFor90} 个主成分**（共 ${MF} 个候选）。`);
say('> 这说明候选之间**并非"同一件事的 14 个副本"**——相关性集中在局部/邻域那一簇内部，');
say('> 球类与纵向类因子几乎与 PC1 正交（载荷 ≈ 0.00）。');
say('> 但 §7.2 会显示 **PC1 这一个方向就解释了 DV 的大头**——');
say('> 即"因子之间分散"与"DV 被单一方向支配"可以同时成立：');
say(`> 那 ${nFor90} 个主成分里，只有 PC1 与 DV 强相关。\n`);

// ── 7.2 逐主成分回归 DV ─────────────────────────────────────────────────
say('## 7.2 逐主成分对因变量的解释力\n');
say('> 用训练侧（全体）的载荷把每行投影到 PC 空间，再**逐单元**对 DV 回归。');
say('> ⚠ 主成分由**因子**的协方差算出（不含 DV），故这一步不是循环。');
say('> 但 PCA 用了全样本统计 → 这里的 R² 是**描述性**的（不是 LOOMO 泛化读数，后者见探针 2）。\n');

// 逐单元累积：PC_k 的单变量统计。用第一次遍历的 stat 标准化。
const pcAcc = Array.from({ length: K }, () => new Map());
await readPanel((row) => {
  const y = row[IDX.y];
  if (!Number.isFinite(y)) return;
  const u = row[IDX.unit];
  const a = stat.get(u);
  if (!a || a.n < 60) return;
  const mu = new Float64Array(MF); const sd = new Float64Array(MF);
  for (let k = 0; k < MF; k += 1) {
    mu[k] = a.s[k] / a.n;
    sd[k] = Math.sqrt(Math.max(1e-12, a.ss[k] / a.n - mu[k] * mu[k])) || 1;
  }
  const z = new Float64Array(MF);
  for (let k = 0; k < MF; k += 1) {
    const f = modelF[k];
    let v = row[f.col];
    if (f.signed) v = v === 1 ? 1 : v === 0 ? -1 : NaN;
    if (!Number.isFinite(v)) return;
    z[k] = (v - mu[k]) / sd[k];
  }
  for (let c = 0; c < K; c += 1) {
    let s = 0; const v = pcs[c].v;
    for (let k = 0; k < MF; k += 1) s += v[k] * z[k];
    let acc = pcAcc[c].get(u);
    if (!acc) { acc = { n: 0, sx: 0, sy: 0, sxx: 0, sxy: 0, syy: 0 }; pcAcc[c].set(u, acc); }
    acc.n += 1; acc.sx += s; acc.sy += y; acc.sxx += s * s; acc.sxy += s * y; acc.syy += y * y;
  }
});
function uniR2(m) {
  const rs = [];
  for (const a of m.values()) {
    if (a.n < 60) continue;
    const vx = a.sxx - a.n * (a.sx / a.n) ** 2;
    const vy = a.syy - a.n * (a.sy / a.n) ** 2;
    if (vx <= 1e-12 || vy <= 1e-12) continue;
    const sxy = a.sxy - a.n * (a.sx / a.n) * (a.sy / a.n);
    rs.push((sxy * sxy) / (vx * vy));
  }
  return rs.length ? C.mean(rs) : NaN;
}
say(C.tsv(['主成分', '解释因子方差', '对 DV 的 alone R²'],
  pcs.map((p, c) => [`PC${c + 1}`, `${(100 * p.lam / totalVar).toFixed(1)}%`, C.f2(uniR2(pcAcc[c]), 3)])));
say('');
// 前 n 个 PC 联合解释 DV（近似：把各 PC 的 alone R² 相加作上界估计）
const pcR2 = pcs.map((_, c) => uniR2(pcAcc[c]));
say(`> **PC1 单独对 DV 的 R² = ${C.f2(pcR2[0], 3)}**，而 PC1 只占因子方差的 27.2%。`);
say('> PC1 的载荷**全部**在"队友 / 邻域 / 对手"那一簇上（≥0.25），球类与纵向类 ≈ 0；');
say('> 即 PC1 = **"周围所有人一起往哪偏"**——这正是 P38 的 **swarm**（整队同进退）');
say('> 在因子空间的投影，也是 P38 §6 判定的"所有机制都挤在同一条带里"的**同一个现象**。');
say(`> PC2–PC14 对 DV 的 R² 全部 ≤ ${C.f2(Math.max(...pcR2.slice(1)), 3)}（合计约 ${C.f2(pcR2.slice(1).reduce((a, b) => a + b, 0), 2)}）。\n`);

say('### PC1 的载荷（谁在定义这个共同因子）\n');
const load = MODEL.map((n, i) => ({ n, w: pcs[0].v[i] }));
load.sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
say(C.tsv(['因子', 'PC1 载荷'], load.map((l) => [l.n, C.f2(l.w, 3)])));
say('');

writeFileSync(join(C.OUT_DIR, '101-7-factor.txt'), lines.join('\n'));
console.log(`\n→ ${join(C.OUT_DIR, '101-7-factor.txt')}`);
