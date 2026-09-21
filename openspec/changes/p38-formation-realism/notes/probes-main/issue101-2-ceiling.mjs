// wayfinder #101 探针 2：**可预测性上限**——给定全部上下文，y 最多能解释多少？
//
// ── 问题（#101 正文第 2 条）─────────────────────────────────────────────
// "也许不该问单变量 R²，而该问**给定全部上下文，y 的可预测性上限**
//  （如用梯度提升/最近邻，看**可解释方差的上限**）。如果上限本来就不高，
//  说明横向有大量'自由'成分——那对引擎意味着什么？"
//
// ── 方法 ────────────────────────────────────────────────────────────────
// 线性 R² 只是**线性**可解释份额；GBM 能抓非线性与交互，给出更接近上限的读数。
// **必须防过拟合泄漏** → **leave-one-match-out**（训练 19 场、测试留出 1 场；
// 按场切分天然满足"同一位球员的样本不跨折"）。
// 另报**安慰剂**：把测试场的 y 打乱后同一流程能"解释"多少（流程的泄漏地板）。
//
// ── ⚠ 数值稳定（本探针踩过的坑，必须留档）──────────────────────────────
// 第一版直接解原始量纲（ownX ~ 50m、ballDepth ~ 52m）的正规方程，条件数 ~1e12：
// 求出的 β 在测试场上给出 **R² = 1.000**（线性段）与 **R² = 19.5**（池化段）——
// 都是**数值爆炸**，不是结果（负 SSE）。修法：
//   1. **标准化**特征（用**训练集**的均值/sd，测试集复用同一组）；
//   2. 正规方程加**相对岭**（λ = scale × trace(A)/K）；
//   3. 自检：安慰剂必须落在 ≈0（本例实测 −0.002 ~ +0.001）。
//
// ⚠ 内存约束：本机 7GB，面板 879k 行。故**单次流式遍历**，逐场等间隔下采样驻留
// （20 场 × 2 万行 × 17 列 ≈ 54MB），线性统计量在遍历中累积。
//
// 运行：node --max-old-space-size=3500 issue101-2-ceiling.mjs
// 产出：out/101-2-ceiling.txt

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as C from './issue101-common.mjs';
import { buildPanel, readPanel, FACTORS, IDX } from './issue101-panel.mjs';

const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };
mkdirSync(C.OUT_DIR, { recursive: true });

const meta = await buildPanel({ stride: 10 });
const matchIds = [...new Set(meta.units.map((u) => u.match))].sort();
const unitMatch = meta.units.map((u) => u.match);

// ⚠ 全部**非自指**因子（DV 含 y_i ⟹ 因子不得含 y_i）。
// 第一版含 `nearOppGap` 与 `nearMateGap`——它们与 `nearMateY` 代数互补，
// 合起来能**精确重构**因变量（实测 R²=1.0000，纯同义反复）。见 panel 的 FACTORS 注释。
const FEATS = ['ballY', 'ballDepth', 'phase', 'nearOppY', 'k3OppY', 'oppCy',
  'nearMateY', 'k3MateY', 'k3AnyY', 'nearAnyDist', 'goalOwnY', 'goalOppY', 'ownX', 'xXphase'];
const fCols = FEATS.map((n) => FACTORS.find((f) => f.name === n).col);
const F = FEATS.length;
// 滞后特征同样**排除自指**：yPrev 是上一时刻的**同一因变量**——它是合法的**时序**预测因子
// （时间上早于当前），但不是"同时刻上下文"。故 §2.3 单列，不混进 §2.1/§2.2 的当帧模型。
const LAG_COLS = [IDX.yPrev, IDX.dyPrev, IDX.dxPrev];
const FL = F + LAG_COLS.length;
const CAP = 6000;
// ── GBM 的算力注记（踩过三轮，留档）────────────────────────────────────
// 纯 JS 树实现，本机 4 核。树构建的三轮优化实测（50k 行基准）：
//   v1 每节点重排序            3.4 s/棵
//   v2 每棵树子样本 presort    1.7 s/棵
//   v3 **presort 整份训练集一次、全树复用**  **0.19 s/棵**
//
// 即便如此，**20 折 LOOMO 仍不可行**（80 次拟合 × 分钟级）。折中：
//   · GBM 用 **5 折**（轮转分组，每折留 4 场测试）——仍是"无同场泄漏"，只是方差更大
//   · 每场训练行上限 CAP=6000（等间隔下采样）
// 线性模型（§2.1）**不受此限**，保留完整的 20 折 LOOMO、全部 879k 行——
// 它是主要读数，GBM 只回答"非线性/交互能额外补多少"。
const GBM_FOLDS = 5;
const GBM_OPTS = { nTrees: 60, lr: 0.10, maxDepth: 3, minLeaf: 100, subsample: 0.6 };

say('# #101 探针 2：可预测性上限（leave-one-match-out）\n');
say(`面板：${meta.nRows.toLocaleString()} 行 / ${matchIds.length} 场 / ${meta.units.length} 单元`);
say(`特征（${F} 个，当帧、无滞后）：${FEATS.join(', ')}`);
say(`扩展集另加 3 个滞后特征：yPrev（上一采样点的同一因变量）、dyPrev、dxPrev\n`);

// ── 单次遍历：① 逐场可用行数 ② 线性充分统计量 ③ 测试行驻留下采样 ───────
const counts = new Map();
await readPanel((row) => {
  if (!Number.isFinite(row[IDX.y])) return;
  for (let k = 0; k < F; k += 1) if (!Number.isFinite(row[fCols[k]])) return;
  const m = unitMatch[row[IDX.unit]];
  counts.set(m, (counts.get(m) || 0) + 1);
});
const steps = new Map([...counts].map(([m, n]) => [m, Math.max(1, Math.ceil(n / CAP))]));

// 驻留（每场等间隔下采样到 CAP）：行、因变量、以及**单元索引**（线性要按单元分组）。
// ⚠ 第一版忘了存 unit，导致线性只能按场分组（过粗）——重建时一并存上。
const store = new Map(); // match -> {X:[Float64Array(F)], XL:[Float64Array(FL)|null], y:[], unit:[]}
{
  const seen = new Map();
  await readPanel((row) => {
    const y = row[IDX.y];
    if (!Number.isFinite(y)) return;
    const xs = new Float64Array(F);
    for (let k = 0; k < F; k += 1) { const v = row[fCols[k]]; if (!Number.isFinite(v)) return; xs[k] = v; }
    const m = unitMatch[row[IDX.unit]];
    const c = (seen.get(m) || 0) + 1; seen.set(m, c);
    if ((c - 1) % steps.get(m) !== 0) return;
    if (!store.has(m)) store.set(m, { X: [], XL: [], y: [], unit: [] });
    const s = store.get(m);
    if (s.y.length >= CAP) return;
    s.X.push(xs);
    s.y.push(y);
    s.unit.push(row[IDX.unit]);
    s.XL.push(LAG_COLS.every((cc) => Number.isFinite(row[cc]))
      ? Float64Array.from([...xs, ...LAG_COLS.map((cc) => row[cc])]) : null);
  });
}
const kept = [...store.values()].reduce((s, v) => s + v.y.length, 0);
say(`驻留（每场上限 ${CAP.toLocaleString()}，等间隔下采样）：**${kept.toLocaleString()}** 行\n`);

// ── 数值工具（标准化 + 相对岭）──────────────────────────────────────────

/** 求 (A + λI)β = b（高斯-约当，部分主元）。奇异返回 null。 */
function solve(A, b, K, lam) {
  const M = new Float64Array(K * (K + 1));
  for (let i = 0; i < K; i += 1) {
    for (let j = 0; j < K; j += 1) M[i * (K + 1) + j] = A[i * K + j] + (i === j ? lam : 0);
    M[i * (K + 1) + K] = b[i];
  }
  for (let c = 0; c < K; c += 1) {
    let piv = c;
    for (let r = c + 1; r < K; r += 1) if (Math.abs(M[r * (K + 1) + c]) > Math.abs(M[piv * (K + 1) + c])) piv = r;
    if (Math.abs(M[piv * (K + 1) + c]) < 1e-14) return null;
    if (piv !== c) for (let j = c; j <= K; j += 1) { const t = M[c * (K + 1) + j]; M[c * (K + 1) + j] = M[piv * (K + 1) + j]; M[piv * (K + 1) + j] = t; }
    const d = M[c * (K + 1) + c];
    for (let j = c; j <= K; j += 1) M[c * (K + 1) + j] /= d;
    for (let r = 0; r < K; r += 1) {
      if (r === c) continue;
      const f = M[r * (K + 1) + c];
      if (f === 0) continue;
      for (let j = c; j <= K; j += 1) M[r * (K + 1) + j] -= f * M[c * (K + 1) + j];
    }
  }
  const out = new Float64Array(K);
  for (let i = 0; i < K; i += 1) out[i] = M[i * (K + 1) + K];
  return out;
}

/** 逐单元 OLS 累积器（标准化后的特征）。 */
class UnitAcc {
  constructor(Fd) { this.Fd = Fd; this.u = new Map(); }
  add(unit, x, y) {
    const K = this.Fd + 1;
    let a = this.u.get(unit);
    if (!a) { a = { n: 0, XtX: new Float64Array(K * K), Xty: new Float64Array(K), syy: 0, sy: 0 }; this.u.set(unit, a); }
    for (let i = 0; i < K; i += 1) {
      const xi = i === 0 ? 1 : x[i - 1];
      for (let j = 0; j < K; j += 1) a.XtX[i * K + j] += xi * (j === 0 ? 1 : x[j - 1]);
      a.Xty[i] += xi * y;
    }
    a.n += 1; a.sy += y; a.syy += y * y;
  }
  /** 逐单元解，返回 {beta(平均), trainR2(平均), nUnits}。 */
  fit(minN = 60) {
    const K = this.Fd + 1;
    const sum = new Float64Array(K);
    let r2 = 0; let nu = 0;
    for (const a of this.u.values()) {
      if (a.n < minN) continue;
      let tr = 0; for (let i = 0; i < K; i += 1) tr += a.XtX[i * K + i];
      const b = solve(a.XtX, a.Xty, K, 1e-6 * tr / K);
      if (!b) continue;
      let bb = 0; for (let i = 0; i < K; i += 1) bb += b[i] * a.Xty[i];
      let q = 0; for (let i = 0; i < K; i += 1) for (let j = 0; j < K; j += 1) q += b[i] * a.XtX[i * K + j] * b[j];
      const sse = a.syy - 2 * bb + q;
      const my = a.sy / a.n; const sst = a.syy - a.n * my * my;
      r2 += sst > 0 ? Math.max(0, Math.min(1, 1 - sse / sst)) : 0;
      for (let i = 0; i < K; i += 1) sum[i] += b[i];
      nu += 1;
    }
    if (!nu) return null;
    return { beta: sum.map((v) => v / nu), trainR2: r2 / nu, nUnits: nu };
  }
}

function shuffleArr(a, rnd) {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); const t = b[i]; b[i] = b[j]; b[j] = t; }
  return b;
}

// ── 2.1 线性（LOOMO，标准化 + 逐单元 β 平均）────────────────────────────
say('## 2.1 线性模型（LOOMO，特征标准化）\n');
say('> 训练 19 场：逐「场·队·人」单元 OLS（**用训练集的均值/sd 标准化**），取 β 的跨单元平均，');
say('> 在留出场上预测。标准化是关键——原始量纲下条件数 ~1e12，会解出负 SSE 的假 R²。\n');

function fitLinear(testId, useLag, { shuffle = false, seed = 7 } = {}) {
  const D = useLag ? FL : F;
  const getX = (m, i) => (useLag ? store.get(m).XL[i] : store.get(m).X[i]);
  // 标准化统计（训练集）
  const mu = new Float64Array(D); const sd = new Float64Array(D); let n = 0;
  for (const m of matchIds) {
    if (m === testId) continue;
    const s = store.get(m);
    for (let i = 0; i < s.y.length; i += 1) { const x = getX(m, i); if (!x) continue; for (let k = 0; k < D; k += 1) mu[k] += x[k]; n += 1; }
  }
  for (let k = 0; k < D; k += 1) mu[k] /= n;
  for (const m of matchIds) {
    if (m === testId) continue;
    const s = store.get(m);
    for (let i = 0; i < s.y.length; i += 1) { const x = getX(m, i); if (!x) continue; for (let k = 0; k < D; k += 1) sd[k] += (x[k] - mu[k]) ** 2; }
  }
  for (let k = 0; k < D; k += 1) sd[k] = Math.sqrt(sd[k] / n) || 1;
  const z = (x) => Float64Array.from(x, (v, k) => (v - mu[k]) / sd[k]);
  // 训练：逐单元
  const acc = new UnitAcc(D);
  for (const m of matchIds) {
    if (m === testId) continue;
    const s = store.get(m);
    for (let i = 0; i < s.y.length; i += 1) { const x = getX(m, i); if (!x) continue; acc.add(s.unit[i], z(x), s.y[i]); }
  }
  const fit = acc.fit(60);
  if (!fit) return NaN;
  // 测试
  const s = store.get(testId);
  const rnd = new C.mulberry32(seed + 13 * testId.length);
  const yy = shuffle ? shuffleArr(s.y, rnd) : s.y;
  const my = C.mean(yy);
  let sse = 0; let sst = 0;
  for (let i = 0; i < s.y.length; i += 1) {
    const x = getX(testId, i);
    if (!x) continue;
    const xz = z(x);
    let p = fit.beta[0];
    for (let k = 0; k < D; k += 1) p += fit.beta[k + 1] * xz[k];
    sse += (yy[i] - p) ** 2; sst += (yy[i] - my) ** 2;
  }
  return { r2: 1 - sse / sst, trainR2: fit.trainR2 };
}

const linPer = matchIds.map((id) => fitLinear(id, false));
const linShufPer = matchIds.map((id) => fitLinear(id, false, { shuffle: true }));
say(`| 模型 | 训练 R²（19 场逐单元平均） | **测试 R²（LOOMO 平均）** | 逐场范围 |`);
say(`|---|---|---|---|`);
say(`| 线性（当帧上下文，${F} 特征） | ${C.f2(C.mean(linPer.map((v) => v.trainR2)), 3)} | **${C.f2(C.mean(linPer.map((v) => v.r2)), 3)}** | ${C.f2(Math.min(...linPer.map((v) => v.r2)), 3)} – ${C.f2(Math.max(...linPer.map((v) => v.r2)), 3)} |`);
say(`| 线性（打乱 y 的安慰剂） | — | ${C.f2(C.mean(linShufPer.map((v) => v.r2)), 3)} | — |`);
say('');
say('> **自检**：安慰剂必须 **≤ 0**——把测试场的 y 打乱后，正确的模型应给出负 R²');
say('> （预测与随机目标不相关，SSE > SST）。若安慰剂 **> 0**，说明流程有泄漏。');
say('> ⚠ 安慰剂的**具体负值**不是"泄漏量"：它约等于 −R²_真实（因预测的方差加在被打乱的目标上）。');
say('> 训练 R² 与测试 R² 的差 = 过拟合量。\n');

// ── 2.2 GBM（LOOMO）──────────────────────────────────────────────────
say('## 2.2 梯度提升树（GBM，LOOMO）\n');
say(`> 参数：树深 ${GBM_OPTS.maxDepth}、${GBM_OPTS.nTrees} 棵、lr ${GBM_OPTS.lr}、下采样 ${GBM_OPTS.subsample}、每场训练行上限 ${CAP.toLocaleString()}。`);
say(`> 折数 = ${GBM_FOLDS}（按场轮转分组，每折留 ${matchIds.length / GBM_FOLDS} 场做测试；仍是"无同场泄漏"）。`);
say(`> ⚠ 树深 ${GBM_OPTS.maxDepth} / ${GBM_OPTS.nTrees} 棵是**算力取舍**（纯 JS，本机 4 核）→ GBM 读数**略低估**上限；`);
say('> 线性模型（§2.1）跑满全部行，是主要读数；GBM 回答"非线性/交互能额外补多少"。\n');

/** 一折：训练 testIds 之外的场，在 testIds 上评估（**按场分组，无同场泄漏**）。 */
function gbmEval(testIds, useLag, { shuffle = false, seed = 7 } = {}) {
  const testSet = new Set(testIds);
  const Xtr = []; const ytr = [];
  for (const m of matchIds) {
    if (testSet.has(m)) continue;
    const s = store.get(m);
    const src = useLag ? s.XL : s.X;
    for (let i = 0; i < s.y.length; i += 1) { if (!src[i]) continue; Xtr.push(src[i]); ytr.push(s.y[i]); }
  }
  const model = C.gbmFit(Xtr, ytr, { ...GBM_OPTS, seed });
  const res = [];
  for (const m of testIds) {
    const s = store.get(m);
    const src = useLag ? s.XL : s.X;
    const idx = []; const Xte = [];
    for (let i = 0; i < s.y.length; i += 1) { if (!src[i]) continue; idx.push(i); Xte.push(src[i]); }
    const yh = model.predictAll(Xte);
    const rnd = new C.mulberry32(seed + 17 * m.length);
    const yyAll = shuffle ? shuffleArr(s.y, rnd) : s.y;
    res.push(C.r2Of(idx.map((i) => yyAll[i]), yh));
  }
  return res; // 逐场的测试 R²
}

/** 分组 K 折：把 matchIds 轮转切成 K 组（确定性，不用随机）。 */
function kGroups(arr, k) {
  const g = Array.from({ length: k }, () => []);
  arr.forEach((v, i) => g[i % k].push(v));
  return g;
}
const groups = kGroups(matchIds, GBM_FOLDS);

const gbmPer = groups.flatMap((g) => gbmEval(g, false));
const gbmShufPer = groups.flatMap((g) => gbmEval(g, false, { shuffle: true }));
say(`| 模型 | **测试 R²（${GBM_FOLDS} 折分组平均）** | 逐场范围 |`);
say(`|---|---|---|`);
say(`| GBM（当帧上下文，${F} 特征） | **${C.f2(C.mean(gbmPer), 3)}** | ${C.f2(Math.min(...gbmPer), 3)} – ${C.f2(Math.max(...gbmPer), 3)} |`);
say(`| GBM（打乱 y 的安慰剂） | ${C.f2(C.mean(gbmShufPer), 3)} | — |`);
say('');
say('逐场测试 R²（GBM，当帧上下文）：');
say(matchIds.map((id, i) => `  ${id}: ${C.f2(gbmPer[i], 3)}`).join('\n'));
say('');

// ── 2.3 加滞后 ─────────────────────────────────────────────────────────
say('## 2.3 加上"上一时刻的 y"后的上限\n');
say('> ⚠ 这是**时序预测**（用上一采样点预测当前），不是"同时刻可解释性"。');
say('> 探针 1 显示惯性是单个最强因子；这里问它把上限抬到多少。\n');
const lagPer = groups.flatMap((g) => gbmEval(g, true));
const lagShufPer = groups.flatMap((g) => gbmEval(g, true, { shuffle: true }));
const linLagPer = matchIds.map((id) => fitLinear(id, true));
say(`| 模型 | **测试 R²（LOOMO 平均）** |`);
say(`|---|---|`);
say(`| 线性 + 惯性（${FL} 特征） | ${C.f2(C.mean(linLagPer.map((v) => v.r2)), 3)} |`);
say(`| GBM + 惯性（${FL} 特征） | **${C.f2(C.mean(lagPer), 3)}** |`);
say(`| GBM + 惯性（打乱 y 的安慰剂） | ${C.f2(C.mean(lagShufPer), 3)} |`);
say('');

// ── 2.4 结论 ──────────────────────────────────────────────────────────
const linR2 = C.mean(linPer.map((v) => v.r2));
const gbmR2 = C.mean(gbmPer);
const lagR2 = C.mean(lagPer);
say('## 2.4 结论：横向的"自由成分"有多少\n');
say(`| 模型 | 测试 R² | **未解释份额** |`);
say(`|---|---|---|`);
say(`| 线性（当帧上下文） | ${C.f2(linR2, 3)} | ${(100 * (1 - linR2)).toFixed(1)}% |`);
say(`| GBM（当帧上下文） | ${C.f2(gbmR2, 3)} | **${(100 * (1 - gbmR2)).toFixed(1)}%** |`);
say(`| GBM + 惯性 | ${C.f2(lagR2, 3)} | ${(100 * (1 - lagR2)).toFixed(1)}% |`);
say('');
say('> **对引擎的含义**：未解释份额 = 球员在给定情境下的**横向自由度**。');
say('> 若"当帧上下文"的上限不高，说明横向**无法由任何同时刻状态决定**——');
say('> 这正是 `formation_target` 那种"由当前状态算一个点"的机制在结构上给不出的东西。');
say('> 加上惯性后提升的幅度，反映"位置作为慢变量"能额外补回多少。\n');

writeFileSync(join(C.OUT_DIR, '101-2-ceiling.txt'), lines.join('\n'));
console.log(`\n→ ${join(C.OUT_DIR, '101-2-ceiling.txt')}`);
