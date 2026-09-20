// P38 #89：真实「贴身射门 vs 贴身传球」的**多变量模型**。
//
// `analyze-shot-pass.mjs` 给的是单变量 AUC。单变量会误导：
// 「禁区内」与「到球门距离」高度共线，两个都高分不代表有两个独立维度。
// 本脚本补逻辑回归（偏效应）+ **真留一交叉验证**（防小样本过拟合）。
//
// ★★ **两个球门距离口径都要跑，且必须并列报告**（审阅发现）：
//   `dGoal`  = 到球门中心的**欧氏**距离（物理真值，球员感知的就是这个）
//   `dGoalX` = **只按纵深** = Rust `dist_to_goal_m`（lib.rs:4762），引擎实际喂进
//              `distance_quality` 的那个数（引擎的简化：y 角向建模留给 B 档 xG 升级）
//   中位差 4.31m。**结论对口径敏感**——只报一个就是选择性报告。
//   实测（真留一）：欧氏口径 仅距离 0.792 / 仅 d1 0.516（位置明显更强）；
//                  引擎口径 仅距离 0.626 / 仅 d1 0.516（差距小得多）。
//   所以要同时看：**去掉 d1 几乎不掉**（两种口径都是）——压力维度不承载独有信息，
//   **这条稳**；但"球门距离单独能解释多少"**取决于你怎么量距离**——这条不稳，必须如实说。
//
// 用法：node analyze-shot-pass-model.mjs [jsonl 路径]

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const path = process.argv[2] || join(HERE, 'out/real-shot-pass.jsonl');
if (!existsSync(path)) { console.error(`缺 ${path}，先跑 probe-real-shot-pass.mjs`); process.exit(1); }
const all = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// 射程筛选用**欧氏**（物理真值；两口径都 ≤30 的子集更干净，但保持与标定表同口径）
const rows = all.filter((r) => r.dGoal <= 30);
console.log(`样本 ${rows.length}（射门 ${rows.filter((r) => r.action === 'shot').length} / 传球 ${rows.filter((r) => r.action === 'pass').length}）—— 全部 dGoal ≤ 30m`);

const FEAT = ['angleCos', 'd1', 'd2', 'oppGoalSide', 'nMate10', 'nOpp8', 'inBox'];
const label = { dGoal: '到球门距离(欧氏)', dGoalX: '到球门距离(仅纵深)', angleCos: '射门角度 cos',
  d1: '第1近防守者', d2: '第2近防守者', oppGoalSide: '球门侧对手数',
  nMate10: '10m内队友数', nOpp8: '8m内对手数', inBox: '禁区内' };

const sigmoid = (v) => 1 / (1 + Math.exp(-v));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

/** 对给定距离口径跑一整套：回归 → 留一 → 单变量对照。 */
function run(distKey) {
  const cols = [distKey, ...FEAT];
  const design = rows.map((r) => ({ x: cols.map((k) => r[k]), y: r.action === 'shot' ? 1 : 0 }));
  const mu = cols.map((_, j) => mean(design.map((d) => d.x[j])));
  const sd = cols.map((_, j) => {
    const m = mu[j];
    return Math.sqrt(mean(design.map((d) => (d.x[j] - m) ** 2))) || 1;
  });
  const z = (x) => x.map((v, j) => (v - mu[j]) / sd[j]);
  /** L2 逻辑回归（全批梯度下降；截距不正则化）。返回 [截距, ...系数]。 */
  const fit = (train) => {
    const w = new Array(cols.length + 1).fill(0);
    const X = train.map((d) => z(d.x));
    for (let it = 0; it < 4000; it += 1) {
      const g = new Array(w.length).fill(0);
      for (let i = 0; i < X.length; i += 1) {
        const e = sigmoid(w[0] + X[i].reduce((a, v, j) => a + v * w[j + 1], 0)) - train[i].y;
        g[0] += e;
        for (let j = 0; j < X[i].length; j += 1) g[j + 1] += e * X[i][j];
      }
      for (let k = 0; k < w.length; k += 1) w[k] -= 0.5 * (g[k] / X.length + (k === 0 ? 0 : 0.05 * w[k]));
    }
    return w;
  };
  /** AUC（并列取平均秩） */
  const auc = (pairs) => {
    const a = [...pairs].sort((x, y) => x[0] - y[0]);
    const rank = new Array(a.length); let i = 0;
    while (i < a.length) {
      let j = i; while (j + 1 < a.length && a[j + 1][0] === a[i][0]) j += 1;
      const r = (i + j) / 2 + 1;
      for (let k = i; k <= j; k += 1) rank[k] = r;
      i = j + 1;
    }
    let sp = 0; let n1 = 0; let n0 = 0;
    for (let k = 0; k < a.length; k += 1) { if (a[k][1] === 1) { sp += rank[k]; n1 += 1; } else n0 += 1; }
    return n1 && n0 ? (sp - n1 * (n1 + 1) / 2) / (n1 * n0) : NaN;
  };
  const pred = (w, x) => sigmoid(w[0] + z(x).reduce((a, v, j) => a + v * w[j + 1], 0));
  /**
   * **真留一**：每次丢掉一个样本重新拟合。`mode`：
   *   { type: 'all' }           全特征
   *   { type: 'only', idx }     **真单变量**：只保留 `idx` 这一列
   *   { type: 'drop', idx }     去掉 `idx`，其余全留
   * ⚠️ 审阅教训（两条，都在这里栽过）：
   *   ① 上一版把 `drop` 打印成「仅 X」——单变量与去一法不是一回事。
   *   ② 上一版把没用到的那 7 列**置 0** 来实现"单变量"，那是**错的**：
   *      7 列常量彼此共线、又与截距共线 → 参数落在一条**平坦脊**上，
   *      全批梯度下降每次停在不同点，**同一个设计矩阵会给出随口径漂移的 AUC**
   *      （实测同一份 d1-only 数据打出 0.410 / 0.546 / 0.516，取决于学习率与迭代数）。
   *      → 现在"单变量"**真的只拟合 1 个特征**（cols 截断），不是靠置 0 掩盖。
   */
  const mask = (x, mode) => x.map((v, j) => {
    if (mode.type === 'all') return v;
    if (mode.type === 'only') return j === mode.idx ? v : 0;
    return j === mode.idx ? 0 : v;
  });
  const loo = (mode) => {
    // 单变量模式：只保留那一列（真正降维，避免共线脊）
    const use = mode.type === 'only' ? [mode.idx] : cols.map((_, j) => j);
    const d1 = design.map((d) => ({ x: use.map((j) => d.x[j]), y: d.y }));
    const mu2 = use.map((_, k) => mean(d1.map((d) => d.x[k])));
    const sd2 = use.map((_, k) => Math.sqrt(mean(d1.map((d) => (d.x[k] - mu2[k]) ** 2))) || 1);
    const z2 = (x) => x.map((v, k) => (v - mu2[k]) / sd2[k]);
    const fit2 = (train) => {
      const w = new Array(use.length + 1).fill(0);
      const X = train.map((d) => z2(d.x));
      for (let it = 0; it < 20000; it += 1) {
        const g = new Array(w.length).fill(0);
        for (let i = 0; i < X.length; i += 1) {
          const e = sigmoid(w[0] + X[i].reduce((a, v, j) => a + v * w[j + 1], 0)) - train[i].y;
          g[0] += e;
          for (let j = 0; j < X[i].length; j += 1) g[j + 1] += e * X[i][j];
        }
        for (let k = 0; k < w.length; k += 1) w[k] -= 0.5 * (g[k] / X.length + (k === 0 ? 0 : 0.05 * w[k]));
      }
      return w;
    };
    const pred2 = (w, x) => sigmoid(w[0] + z2(x).reduce((a, v, j) => a + v * w[j + 1], 0));
    const pairs = [];
    for (let i = 0; i < d1.length; i += 1) {
      const held = d1.filter((_, j) => j !== i);
      const w = fit2(held);
      pairs.push([pred2(w, d1[i].x), d1[i].y]);
    }
    return auc(pairs);
  };

  const wAll = fit(design);
  const iD1 = cols.indexOf('d1');
  const iDist = cols.indexOf(distKey);
  console.log(`\n${'─'.repeat(72)}\n█ 距离口径 = ${label[distKey]}\n`);
  console.log('  标准化系数（= 该维每 1 个标准差的优势比）：');
  const byAbs = cols.map((k, j) => ({ k, c: wAll[j + 1] })).sort((a, b) => Math.abs(b.c) - Math.abs(a.c));
  for (const { k, c } of byAbs) {
    console.log(`    ${label[k].padEnd(16)} ${c >= 0 ? '+' : '-'}${Math.abs(c).toFixed(2).padStart(5)}  OR=${Math.exp(c).toFixed(2).padStart(6)}`);
  }
  console.log(`\n  ★ 偏效应：${label[distKey]} ${wAll[iDist + 1].toFixed(2)}  vs  d1 ${wAll[iD1 + 1].toFixed(2)}`);

  const full = loo({ type: 'all' });
  const onlyDist = loo({ type: 'only', idx: iDist });
  const onlyD1 = loo({ type: 'only', idx: iD1 });
  const dropDist = loo({ type: 'drop', idx: iDist });
  const dropD1 = loo({ type: 'drop', idx: iD1 });
  console.log('\n  留一交叉验证 AUC（全部真留一）：');
  console.log(`    全特征                      ${full.toFixed(3)}`);
  console.log(`    仅 ${label[distKey].padEnd(19)} ${onlyDist.toFixed(3)}   ← 真单变量`);
  console.log(`    仅 d1                       ${onlyD1.toFixed(3)}   ← 真单变量`);
  console.log(`    去掉 ${label[distKey].padEnd(17)} ${dropDist.toFixed(3)}   ← 去一法（其余全留）`);
  console.log(`    去掉 d1                     ${dropD1.toFixed(3)}   ← 去一法（其余全留）`);
  return { distKey, full, onlyDist, onlyD1, dropDist, dropD1 };
}

const res = [run('dGoal'), run('dGoalX')];

console.log(`\n${'═'.repeat(72)}\n★ 口径敏感性（这是本节最该看的一张表）\n`);
console.log(`  ${'距离口径'.padEnd(18)} ${'全特征'.padStart(7)} ${'仅距离'.padStart(7)} ${'仅d1'.padStart(7)} ${'去距离'.padStart(7)} ${'去d1'.padStart(7)}`);
for (const r of res) {
  console.log(`  ${label[r.distKey].padEnd(18)} ${r.full.toFixed(3).padStart(7)} ${r.onlyDist.toFixed(3).padStart(7)} ${r.onlyD1.toFixed(3).padStart(7)} ${r.dropDist.toFixed(3).padStart(7)} ${r.dropD1.toFixed(3).padStart(7)}`);
}
console.log('\n  读法（三条，都要说）：');
console.log('   1. **仅 d1 是弱判别器**（0.516，两口径必然相同——单变量设计矩阵与口径无关），');
console.log('      但**不是抛硬币**。注意区分三处不同的数：');
console.log('        · 全体本单变量留一 0.516（本表）');
console.log('        · 贴身子集内的单变量 AUC 0.499（§1.2）');
console.log('        · 偏效应系数（在距离也在模型里时）0.39–0.45（§1.4 上半）');
console.log('   2. **去掉 d1 几乎不掉**（0.844 vs 0.844；0.806 vs 0.806）→');
console.log('      压力维度不承载独有信息。**这是本节最稳的一条。**');
console.log('   3. 但"球门距离能解释多少"**依赖量距离的方式**：欧氏口径下仅距离 0.792（接近全特征），');
console.log('      引擎的仅纵进口径下只有 0.626。**不要只报对自己有利的那个口径。**');

// ── 标定表（欧氏口径：物理真值；与 probe 的 dGoal 同义）───────────────
console.log('\n[★ 标定表：P(射门) 在同一 dGoal 桶内，随 d1 怎么变]');
console.log('  引擎的假设是「d1 小 → 不射」。真实数据说什么？\n');
const goalBins = [[0, 11], [11, 16.5], [16.5, 22], [22, 30]];
const d1Bins = [[0, 2], [2, 4], [4, 8], [8, 999]];
console.log(`  ${'dGoal\\d1'.padEnd(12)}${d1Bins.map(([a, b]) => (b === 999 ? `>${a}m` : `${a}–${b}m`).padStart(14)).join('')}`);
for (const [glo, ghi] of goalBins) {
  let line = `  ${`${glo}–${ghi}m`.padEnd(12)}`;
  for (const [dlo, dhi] of d1Bins) {
    const sub = rows.filter((r) => r.dGoal >= glo && r.dGoal < ghi && r.d1 >= dlo && r.d1 < dhi);
    const s = sub.filter((r) => r.action === 'shot').length;
    line += (sub.length === 0 ? '—' : `${(100 * s / sub.length).toFixed(0)}% (${s}/${sub.length})`).padStart(14);
  }
  console.log(line);
}
console.log('\n  ⚠️ 每格样本量很小（全样本仅 99 个射程内事件）——读**格局**，不要读具体百分点。');
console.log('  ⚠️ 22–30m 行内 0–2m 格只有 5%（1/19），是该行**最低**的一格——与"压力无关"的读法相反。');
console.log('     该行样本量也是四行里最大的，不能当噪声一笔带过（审阅发现）。');
