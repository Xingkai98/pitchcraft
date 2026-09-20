// P38 #89：真实「贴身射门 vs 贴身传球」的**多变量模型**与**标定概率**。
//
// `analyze-shot-pass.mjs` 给的是单变量 AUC。单变量会误导：
// 「禁区内」与「到球门距离」高度共线，两个都高分不代表有两个独立维度。
// 本脚本补三件事：
//
//   1. **逻辑回归**（梯度下降 + L2，特征标准化）：给出各维度的**偏**效应。
//      若加进 dGoal 后 d1 的系数 ≈0，则「压力维度」在真实数据里**不承载信息**。
//   2. **留一交叉验证 AUC**：模型是不是过拟合小样本。
//   3. **★ 标定表 P(射门 | dGoal 桶, d1 桶)**：这才是引擎要的东西——
//      不是「能不能分类」，而是「在这个几何下，射门该多久发生一次」。
//      引擎现在的答案是一个阶跃（d1≤8 → 永不射门）。
//
// 用法：node analyze-shot-pass-model.mjs [jsonl 路径]

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const path = process.argv[2] || join(HERE, 'out/real-shot-pass.jsonl');
if (!existsSync(path)) { console.error(`缺 ${path}，先跑 probe-real-shot-pass.mjs`); process.exit(1); }
const all = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// 只保留射程内（>30m 的传球与射门决策无关：那里从不射门，混进来只会把截距压低）
const rows = all.filter((r) => r.dGoal <= 30);
console.log(`样本 ${rows.length}（射门 ${rows.filter((r) => r.action === 'shot').length} / 传球 ${rows.filter((r) => r.action === 'pass').length}）—— 全部 dGoal ≤ 30m\n`);

const FEATS = ['dGoal', 'angleCos', 'd1', 'd2', 'oppGoalSide', 'nMate10', 'nOpp8', 'inBox'];
const label = { dGoal: '到球门距离', angleCos: '射门角度 cos', d1: '第1近防守者', d2: '第2近防守者', oppGoalSide: '球门侧对手数', nMate10: '10m内队友数', nOpp8: '8m内对手数', inBox: '禁区内' };

const design = rows.map((r) => {
  const x = FEATS.map((k) => r[k]);
  return { x, y: r.action === 'shot' ? 1 : 0, row: r };
});
// 标准化（用全样本均值/标准差——交叉验证里略有泄漏，但只影响标准化尺度，不影响结论）
const mu = FEATS.map((_, j) => design.reduce((a, d) => a + d.x[j], 0) / design.length);
const sd = FEATS.map((_, j) => {
  const m = mu[j];
  return Math.sqrt(design.reduce((a, d) => a + (d.x[j] - m) ** 2, 0) / design.length) || 1;
});
const z = (d) => d.x.map((v, j) => (v - mu[j]) / sd[j]);

const sigmoid = (v) => 1 / (1 + Math.exp(-v));
/** L2 逻辑回归，全批梯度下降。返回 [截距, ...系数]（作用在标准化特征上）。 */
function fit(train, { l2 = 0.05, iters = 4000, lr = 0.5 } = {}) {
  const w = new Array(FEATS.length + 1).fill(0);
  const X = train.map(z);
  for (let it = 0; it < iters; it += 1) {
    const g = new Array(w.length).fill(0);
    for (let i = 0; i < X.length; i += 1) {
      const s = w[0] + X[i].reduce((a, v, j) => a + v * w[j + 1], 0);
      const e = sigmoid(s) - train[i].y;
      g[0] += e;
      for (let j = 0; j < X[i].length; j += 1) g[j + 1] += e * X[i][j];
    }
    for (let k = 0; k < w.length; k += 1) {
      w[k] -= lr * (g[k] / X.length + (k === 0 ? 0 : l2 * w[k]));
    }
  }
  return w;
}
/** AUC */
function auc(pairs) {
  const all2 = [...pairs].sort((a, b) => a[0] - b[0]);
  const rank = new Array(all2.length);
  let i = 0;
  while (i < all2.length) {
    let j = i; while (j + 1 < all2.length && all2[j + 1][0] === all2[i][0]) j += 1;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) rank[k] = r;
    i = j + 1;
  }
  let sp = 0; let n1 = 0; let n0 = 0;
  for (let k = 0; k < all2.length; k += 1) { if (all2[k][1] === 1) { sp += rank[k]; n1 += 1; } else n0 += 1; }
  return n1 && n0 ? (sp - n1 * (n1 + 1) / 2) / (n1 * n0) : NaN;
}
const pred = (w, d) => sigmoid(w[0] + z(d).reduce((a, v, j) => a + v * w[j + 1], 0));

// ── 1. 全样本拟合（报告系数）──────────────────────────────────────────
const wAll = fit(design);
console.log('[逻辑回归：标准化系数 = 该维每 1 个标准差的优势比]');
console.log(`  截距 ${wAll[0].toFixed(2)}`);
const byAbs = FEATS.map((k, j) => ({ k, c: wAll[j + 1] })).sort((a, b) => Math.abs(b.c) - Math.abs(a.c));
for (const { k, c } of byAbs) {
  const bar = '█'.repeat(Math.min(30, Math.round(Math.abs(c) * 12)));
  console.log(`  ${label[k].padEnd(14)} ${c >= 0 ? '+' : '-'}${Math.abs(c).toFixed(2).padStart(5)}  OR=${Math.exp(c).toFixed(2).padStart(6)}  ${bar}`);
}
// 关注维度：d1 的偏效应（在 dGoal 已在模型里的前提下）
const iD1 = FEATS.indexOf('d1'); const iGoal = FEATS.indexOf('dGoal');
console.log(`\n  ★ 关键读法：dGoal 系数 ${wAll[iGoal + 1].toFixed(2)}，d1 系数 ${wAll[iD1 + 1].toFixed(2)}`);
{
  const wNoGoal = fit(design.map((d) => ({ ...d, x: d.x.map((v, j) => (j === iGoal ? 0 : v)) })));
  console.log(`    去掉 dGoal 后 d1 系数 = ${wNoGoal[iD1 + 1].toFixed(2)}（对照：单变量时 d1 有多大）`);
}

// ── 2. 留一交叉验证 ────────────────────────────────────────────────────
{
  const pairs = [];
  for (let i = 0; i < design.length; i += 1) {
    const w = fit(design.filter((_, j) => j !== i));
    pairs.push([pred(w, design[i]), design[i].y]);
  }
  console.log(`\n[留一交叉验证 AUC] 全特征 ${auc(pairs).toFixed(3)}`);
  // 只用 d1（引擎的现状：唯一致命标量）
  const wD1 = fit(design.map((d) => ({ ...d, x: d.x.map((v, j) => (j === iD1 ? v : 0)) })));
  const pD1 = design.map((d) => [pred(wD1, d), d.y]);
  console.log(`                     仅 d1（引擎现状） ${auc(pD1).toFixed(3)}`);
  // 只用 dGoal
  const wDg = fit(design.map((d) => ({ ...d, x: d.x.map((v, j) => (j === iGoal ? v : 0)) })));
  const pDg = design.map((d) => [pred(wDg, d), d.y]);
  console.log(`                     仅 dGoal         ${auc(pDg).toFixed(3)}`);
}

// ── 3. ★ 标定表 P(射门 | dGoal 桶 × d1 桶)────────────────────────────
console.log('\n[★ 标定表：P(射门) 在同一 dGoal 桶内，随 d1 怎么变]');
console.log('  这是本探针的核心：引擎的假设是「d1 小 → 不射」。真实数据说什么？\n');
const goalBins = [[0, 11], [11, 16.5], [16.5, 22], [22, 30]];
const d1Bins = [[0, 2], [2, 4], [4, 8], [8, 999]];
const head = `  ${'dGoal\\d1'.padEnd(12)}${d1Bins.map(([a, b]) => (b === 999 ? `>${a}m` : `${a}–${b}m`).padStart(14)).join('')}`;
console.log(head);
for (const [glo, ghi] of goalBins) {
  let line = `  ${`${glo}–${ghi}m`.padEnd(12)}`;
  for (const [dlo, dhi] of d1Bins) {
    const sub = rows.filter((r) => r.dGoal >= glo && r.dGoal < ghi && r.d1 >= dlo && r.d1 < dhi);
    const s = sub.filter((r) => r.action === 'shot').length;
    const cell = sub.length === 0 ? '—' : `${(100 * s / sub.length).toFixed(0)}% (${s}/${sub.length})`;
    line += cell.padStart(14);
  }
  console.log(line);
}
console.log('\n  ⚠️ 每格样本量很小（全样本仅 99 个射程内事件）——读**格局**，不要读具体百分点。');
