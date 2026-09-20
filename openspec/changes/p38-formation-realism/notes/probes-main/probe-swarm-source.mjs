// P38 线 B：**swarm 从哪里来？** —— 把「公共信号 + 个体增益」这个假设做成可测的预测。
//
// 假设：若 `y_i(t) = a_i + g_i · s(t)`（s = 同一路**公共**信号、g_i 是各人增益），
// 那么两两相关 `corr(y_i, y_j)` 会 → 1，**与 g_i 是否各不相同无关**。
// 因为公共项 s(t) 主导了协方差。
//
// 可测的推论（三条，全部可在这里验）：
//   P1 **swarm 高 ⟺ 第一主成分解释的方差占比高**。公共信号 = 秩 1 结构。
//   P2 **各人的 y 序列与"全队 y 均值"的相关高**（公共项的直接估计）。
//   P3 **人均 y_sd 可以很高而 swarm 仍高**——即"每人动得不少，但一起动"。
//      exp5 正是这个（latSd 5.3 / swarm 0.95）。
//
// 反过来，`local` 机制的信号 s_i(t) = 我邻居的 y 均值 —— 邻居集合逐人不同，
// 所以 s_i 之间**不共享**公共项 → 秩 1 结构被打破 → P1/P2 同时下降。
//
// ⚠️ 本项目**从零写、无矩阵库**，幂迭代 20 行足够（只要第一主成分）。
//
// 用法：node probe-swarm-source.mjs <标签>        # 对当前 viewer/engine.wasm

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from '../probes/repo-root.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = findRepoRoot(HERE);
const label = process.argv[2] || 'current';

const { loadEngineWasm, simulateStream } = await import(`${ROOT}/tools/benchmark-engine.mjs`);
const { createGame } = await import(`${ROOT}/viewer/game.js`);
const { sampleEngineFrames, KEEPER_IDS, PITCH_WIDTH_M } = await import(`${ROOT}/viewer/match-metrics.js`);

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
function corr(a, b) {
  const n = Math.min(a.length, b.length);
  const A = a.slice(0, n); const B = b.slice(0, n);
  const ma = mean(A); const mb = mean(B);
  let s = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i += 1) { const x = A[i] - ma; const y = B[i] - mb; s += x * y; da += x * x; db += y * y; }
  return da > 0 && db > 0 ? s / Math.sqrt(da * db) : 0;
}

// 幂迭代求第一主成分解释的方差占比（输入 = 已中心化的 T×N 序列矩阵，按列存）
function pc1Share(cols) {
  const T = cols[0].length;
  const N = cols.length;
  const mu = cols.map((c) => mean(c));
  const X = cols.map((c, j) => c.map((v) => v - mu[j]));
  let v = new Array(N).fill(0).map((_, i) => Math.sin(i + 1)); // 确定性初值，不用随机
  const norm = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0));
  let nv = norm(v);
  if (nv === 0) return NaN;
  v = v.map((x) => x / nv);
  for (let it = 0; it < 60; it += 1) {
    // w = X^T (X v)
    const Xv = new Array(T).fill(0);
    for (let j = 0; j < N; j += 1) { const c = X[j]; const vj = v[j]; for (let t = 0; t < T; t += 1) Xv[t] += c[t] * vj; }
    const w = new Array(N).fill(0);
    for (let j = 0; j < N; j += 1) { const c = X[j]; let s = 0; for (let t = 0; t < T; t += 1) s += c[t] * Xv[t]; w[j] = s; }
    nv = norm(w);
    if (nv === 0) return NaN;
    v = w.map((x) => x / nv);
  }
  // 特征值 = v^T X^T X v / T；总方差 = Σ 列方差
  const Xv = new Array(T).fill(0);
  for (let j = 0; j < N; j += 1) { const c = X[j]; const vj = v[j]; for (let t = 0; t < T; t += 1) Xv[t] += c[t] * vj; }
  const lam = Xv.reduce((s, x) => s + x * x, 0) / T;
  const tot = cols.reduce((s, c) => s + sd(c) ** 2, 0) / N;
  return tot > 0 ? lam / (tot * N) * N / N : NaN; // lam / (N * tot) 归一化到"占总方差比例"
}

const load = await loadEngineWasm(`${ROOT}/viewer/engine.wasm`);
if (!load.ok) { console.error(load.message); process.exit(1); }
const all = [];
for (const seed of (process.env.SEEDS || '42,1,7,99,123').split(',').map(Number)) {
  const g = createGame(simulateStream(load.wasm, seed, 5400));
  all.push(...sampleEngineFrames(g));
}
const seg = all.filter((f) => f.t >= 1800 && f.t <= 1920);
const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const cols = ids.map((id) => seg.map((f) => { const p = f.players.find((x) => x.id === id); return p ? p.y * PITCH_WIDTH_M : NaN; })
  .filter((v) => Number.isFinite(v)));

const T = Math.min(...cols.map((c) => c.length));
const trimmed = cols.map((c) => c.slice(0, T));
const teamMean = [];
for (let t = 0; t < T; t += 1) teamMean.push(mean(trimmed.map((c) => c[t])));

const cors = [];
for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) cors.push(corr(trimmed[i], trimmed[j]));

const share = pc1Share(trimmed);
const r2team = mean(trimmed.map((c) => corr(c, teamMean) ** 2));
const latSd = mean(trimmed.map((c) => sd(c)));

console.log(`[${label}]  latSd(人均) = ${latSd.toFixed(2)} m   swarm(平均两两相关) = ${mean(cors).toFixed(3)}`);
console.log(`   P1 第一主成分占总方差 = ${(share * 100).toFixed(1)}%      ← 秩1结构 = 公共信号主导`);
console.log(`   P2 人均 R²(y ~ 全队y均值) = ${r2team.toFixed(3)}          ← 公共项的直接估计`);
console.log(`   P3 人均 y_sd ${latSd.toFixed(2)} vs swarm ${mean(cors).toFixed(2)}  （高 sd + 高 swarm = "一起动"）`);
