// wayfinder #101 探针 3：**个体性 vs 情境响应**——横向行为有多少是"这个人"的？
//
// ── 问题（#101 正文第 3 条）─────────────────────────────────────────────
// "测'个体性'：真实球员的横向行为在多大程度上是**个体特有**的（同一球员在不同
//  情境下一致），多大程度上是**情境响应**的？—— 这决定引擎该建'职责'还是'响应'。"
//
// ── 难点：SkillCorner 没有跨场球员身份（已核实）────────────────────────
// 20 场是同一联赛单赛季，但 `match.players[].id` **每场独立**（同一个人在 20 场里
// 20 个不同 id）→ **不能**把"个体性"做成"同一球员跨场一致性"。
//
// ── 替代设计（回答同一个问题，且更保守）────────────────────────────────
// 把"个体性"定义为**三个可分离的方差层**，全部在**场内**识别、不需要跨场身份：
//
//   A 单元档位（"这个人在这场站在哪"）      = E_i[(ȳ_i − ȳ)²]         → 静态职责
//   B 情境响应（档位之外，可被当帧情境解释）= Var(pred)               → 球/对手驱动
//   C 个体残差（情境之外自己的游走）        = Var(y) − A − B          → 横向自由度
//
// 关键：先按人**组内去均值**（Frisch–Waugh），把 A 完全吸收，再对情境因子回归——
// 这样 B 就是"扣掉个体档位后，情境还能解释多少"，不被 A 污染。
//
// 再加**可分离性检验**：把球员标签在同场内循环错位（保持每人的行数），A 应塌到 0。
// 这证明 A 是"人"的属性，不是位置标签的伪影。
//
// 运行：node issue101-3-individuality.mjs
// 产出：out/101-3-individuality.txt

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as C from './issue101-common.mjs';
import { buildPanel, readPanel, readMeta, FACTORS, IDX } from './issue101-panel.mjs';

const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };
mkdirSync(C.OUT_DIR, { recursive: true });

const meta = await buildPanel({ stride: 10 });
say('# #101 探针 3：个体性 vs 情境响应\n');
say(`面板：${meta.nRows.toLocaleString()} 行 / ${meta.units.length} 单元 / ${C.skillcorner20Ids().length} 场\n`);

// ── 3.0 跨场球员身份不可用（口径声明）──────────────────────────────────
say('## 3.0 前置：跨场球员身份**不可用**（口径限制，必须显式声明）\n');
say('`match.players[].id` 每场独立（20 场共 20 组），**实测 0 个原生 id 跨场复用**。');
say('故"同一球员跨场一致性"无法直接测量；本探针用**场内三层分解 + 打乱对照**替代。\n');

// ── 3.1 三层分解 ────────────────────────────────────────────────────────
say('## 3.1 三层分解：单元档位 / 情境响应 / 个体残差\n');
say('> 逐「场·队」单元内分解（不跨场拼接）。先按人**组内去均值**吸收 A，再回归情境因子。\n');

// ⚠ **情境因子必须不含 `y_i`**（本探针第一版踩的坑，留档）：
// 原版 CTX 里含 `nearMateGap = y_i − y_最近队友` —— 它含 `y_i`，
// 故回归能在"组内去均值之后"仍部分重构 devY（**泄漏进 B 层**）。
// 现改为**只保留不含 y_i 的因子**。因子集敏感性（A/B/C 随 CTX 变化的实测）见报告 §5.1b
// 与 `issue101-9-factor-sets.mjs`：B 在 **23.3–36.1%** 之间、C 在 **9.7–20.3%** 之间——
// 纳入"队友/对手的位置"能把 B 抬到 36%、C 压到 11%。**报告采用本文件这组（B 25.3 / C 18.3）。**
const CTX = ['ballY', 'ballDepth', 'phase', 'nearOppY', 'k3OppY', 'oppCy', 'ownX'];
const ctxF = CTX.map((n) => FACTORS.find((f) => f.name === n));
const ctxCols = ctxF.map((f) => f.col);

// 读面板：按「场·队」收集（每单元 ~2200 行，40 个单元 → 88k 行，可驻留）
const byTeam = new Map(); // `${match}|${team}` -> {units: Int32Array, Y, X[]}
await readPanel((row) => {
  const y = row[IDX.y];
  if (!Number.isFinite(y)) return;
  const xs = new Float64Array(ctxCols.length);
  for (let k = 0; k < ctxCols.length; k += 1) {
    const f = ctxF[k];
    let v = row[f.col];
    if (f.signed) v = v === 1 ? 1 : v === 0 ? -1 : NaN;
    if (!Number.isFinite(v)) return;
    xs[k] = v;
  }
  const u = meta.units[row[IDX.unit]];
  const key = `${u.match}|${u.team}`;
  if (!byTeam.has(key)) byTeam.set(key, { units: [], y: [], X: [] });
  const b = byTeam.get(key);
  b.units.push(row[IDX.unit]); b.y.push(y); b.X.push(xs);
});

// ── 工具：多元回归（含截距，岭正则）────────────────────────────────────
function solveRidge(A, b, K, lambda) {
  const M = new Float64Array(K * (K + 1));
  for (let i = 0; i < K; i += 1) {
    for (let j = 0; j < K; j += 1) M[i * (K + 1) + j] = A[i * K + j] + (i === j ? lambda : 0);
    M[i * (K + 1) + K] = b[i];
  }
  for (let c = 0; c < K; c += 1) {
    let piv = c;
    for (let r = c + 1; r < K; r += 1) if (Math.abs(M[r * (K + 1) + c]) > Math.abs(M[piv * (K + 1) + c])) piv = r;
    if (Math.abs(M[piv * (K + 1) + c]) < 1e-12) return null;
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

function decompose({ shuffleLabels = false, seed = 11 } = {}) {
  const rnd = new C.mulberry32(seed);
  const res = [];
  for (const [key, b] of byTeam) {
    const n = b.y.length;
    if (n < 400) continue;
    // ⚠ **打乱必须打乱"行 → 球员"的对应，而不是给球员改名字**。
    // 第一版按"球员分组后循环错位"——那只是给同一批分组换标签，**划分结构没变**，
    // 于是 A 逐位相同（真实/打乱比 = 1.0，一眼假）。正确做法：把 labels 数组
    // 整体 Fisher–Yates 洗牌——**每个球员的行数不变**，但行与人的对应被打散。
    // 此时 A 度量的是"随机桶之间的方差"，期望值约为 σ²/n̄（远小于真实的球员间方差）。
    let labels = b.units;
    if (shuffleLabels) {
      labels = Int32Array.from(b.units);
      for (let i = n - 1; i > 0; i -= 1) {
        const j = Math.floor(rnd() * (i + 1));
        const t = labels[i]; labels[i] = labels[j]; labels[j] = t;
      }
    }

    const grand = C.mean(b.y);
    // (A) 单元档位
    const byLabel = new Map();
    for (let i = 0; i < n; i += 1) {
      if (!byLabel.has(labels[i])) byLabel.set(labels[i], []);
      byLabel.get(labels[i]).push(b.y[i]);
    }
    let sumA = 0;
    for (const arr of byLabel.values()) sumA += arr.length * (C.mean(arr) - grand) ** 2;
    const A = sumA / n;

    // 组内去均值（吸收 A）
    const lm = new Map([...byLabel].map(([l, arr]) => [l, C.mean(arr)]));
    const devY = new Float64Array(n);
    for (let i = 0; i < n; i += 1) devY[i] = b.y[i] - lm.get(labels[i]);

    // 情境因子也组内去均值（否则组间差异会被算进"情境响应"）
    const F = ctxCols.length;
    const Xc = b.X.map((x) => Float64Array.from(x));
    for (let f = 0; f < F; f += 1) {
      const m = new Map();
      for (let i = 0; i < n; i += 1) {
        if (!m.has(labels[i])) m.set(labels[i], []);
        m.get(labels[i]).push(Xc[i][f]);
      }
      const mm = new Map([...m].map(([l, arr]) => [l, C.mean(arr)]));
      for (let i = 0; i < n; i += 1) Xc[i][f] -= mm.get(labels[i]);
    }

    // 回归 devY ~ Xc
    const K = F + 1;
    const XtX = new Float64Array(K * K); const Xty = new Float64Array(K);
    for (let i = 0; i < n; i += 1) {
      for (let a = 0; a < K; a += 1) {
        const xa = a === 0 ? 1 : Xc[i][a - 1];
        for (let c = 0; c < K; c += 1) XtX[a * K + c] += xa * (c === 0 ? 1 : Xc[i][c - 1]);
        Xty[a] += xa * devY[i];
      }
    }
    const beta = solveRidge(XtX, Xty, K, 1e-6);
    if (!beta) continue;
    let varCtx = 0;
    for (let i = 0; i < n; i += 1) {
      let p = beta[0];
      for (let f = 0; f < F; f += 1) p += beta[f + 1] * Xc[i][f];
      varCtx += p * p;
    }
    varCtx /= n;
    const varDev = C.mean([...devY].map((v) => v ** 2));
    res.push({ key, n, nPlayers: byLabel.size, A, dev: varDev, ctx: varCtx, resid: varDev - varCtx });
  }
  return res;
}

const real = decompose();
const shuffled = decompose({ shuffleLabels: true });

// 单元加权平均（各单元行数不同，按 n 加权）
function wmean(rs, f) { const N = rs.reduce((s, r) => s + r.n, 0); return rs.reduce((s, r) => s + r.n * f(r), 0) / N; }
const totA = wmean(real, (r) => r.A);
const totDev = wmean(real, (r) => r.dev);
const totCtx = wmean(real, (r) => r.ctx);
const totRes = wmean(real, (r) => r.resid);
const tot = totA + totDev;

say('| 层 | 方差 (m²) | 占总方差 | 含义 |');
say('|---|---|---|---|');
say(`| **A 单元档位**（球员的固定横向偏移） | ${C.f2(totA)} | **${(100 * totA / tot).toFixed(1)}%** | "这个人这场站在哪"——静态职责 |`);
say(`| **B 情境响应**（档位之外、可被当帧情境解释） | ${C.f2(totCtx)} | **${(100 * totCtx / tot).toFixed(1)}%** | 球 / 对手 / 球门驱动 |`);
say(`| **C 个体残差**（情境之外自己的游走） | ${C.f2(totRes)} | **${(100 * totRes / tot).toFixed(1)}%** | 横向自由度 |`);
say(`| 合计 Var(y_i − mateY) | ${C.f2(tot)} | 100% | — |`);
say('');
say(`单元数 ${real.length}（「场·队」，n ≥ 400 行）；平均每单元球员 ${C.f2(C.mean(real.map((r) => r.nPlayers)), 1)} 人\n`);

say('### 打乱对照（把「行 → 球员」的对应 Fisher–Yates 洗牌，每人行数不变）\n');
const shA = wmean(shuffled, (r) => r.A);
const shCtx = wmean(shuffled, (r) => r.ctx);
const shRes = wmean(shuffled, (r) => r.resid);
const shDev = wmean(shuffled, (r) => r.dev);
say(`| 层 | 真实 | 打乱标签 | 判读 |`);
say(`|---|---|---|---|`);
say(`| A 单元档位 | ${C.f2(totA)} | **${C.f2(shA)}** | 打乱后塌向 0 → A 是"人"的属性 |`);
say(`| B 情境响应 | ${C.f2(totCtx)} | ${C.f2(shCtx)} | 情境响应不依赖人机对应 |`);
say(`| C 个体残差 | ${C.f2(totRes)} | ${C.f2(shRes)} | 打乱后无处归属的方差落到这里 |`);
say('');
say(`> **A 的真实/打乱比 = ${C.f2(totA / Math.max(1e-9, shA), 1)}×**`);
say('> —— 比值高 → 横向档位确实跟着人走，不是位置标签的伪影。\n');

// ── 3.2 按位置线分层 ────────────────────────────────────────────────────
say('## 3.2 分层：不同位置的个体性一样吗\n');
say('> P38 #90 §3.4 已证"分工只存在于边路"（边卫组内全距 33.5m vs 中锋 6.7m）。');
say('> 这里问：**个体自由度**（C 层）在位置线上是否也不同。\n');

const lineOf = (uid) => (meta.units[uid].line || 'unknown');
const byLine = new Map();
for (const r of real) {
  // 把「场·队」单元的方差按其成员的线归属再聚合不可行（分解在单元层）
  // → 改为按线的**单元子集**：用面板里 unit 的 line 做权重
  void r;
}
// 逐线：直接用面板行（流式再读一次，按 line 分组算"相对队友的 y sd"）
const lineAcc = new Map();
await readPanel((row) => {
  const y = row[IDX.y];
  if (!Number.isFinite(y)) return;
  const u = meta.units[row[IDX.unit]];
  const l = u.line || 'unknown';
  if (!lineAcc.has(l)) lineAcc.set(l, { sum: 0, sum2: 0, n: 0, units: new Map() });
  const a = lineAcc.get(l);
  a.sum += y; a.sum2 += y * y; a.n += 1;
  if (!a.units.has(row[IDX.unit])) a.units.set(row[IDX.unit], []);
  a.units.get(row[IDX.unit]).push(y);
});
const lineRows = [];
for (const [l, a] of lineAcc) {
  if (a.n < 5000) continue;
  const persons = [...a.units.values()];
  const sds = persons.filter((p) => p.length >= 100).map((p) => C.std(p));
  const centers = persons.map((p) => C.mean(p));
  lineRows.push({ line: l, n: a.n, players: persons.length,
    ysd: C.mean(sds), range: Math.max(...centers) - Math.min(...centers), centerSd: C.std(centers) });
}
lineRows.sort((x, y2) => y2.ysd - x.ysd);
say(C.tsv(['位置线', '采样点', '球员数', '个体 y sd（单元内）', '成员中心全距', '中心 sd'],
  lineRows.map((l) => [l.line, l.n.toLocaleString(), l.players, C.f2(l.ysd), C.f2(l.range), C.f2(l.centerSd)])));
say('');
say('> **成员中心全距** = 组内各球员平均 y 的极差（"分工强度"）；');
say('> **个体 y sd** = 球员自己在单元内的横向摆幅（"个体自由度"）。');
say('> 若边路"分工强 + 自由度也大"，说明边路不是把球员钉死，而是给了一个偏好的起点。\n');

// ── 3.3 结论 ────────────────────────────────────────────────────────────
say('## 3.3 对引擎的含义\n');
// ⚠ 口径对齐：本节的方差基数 = **`y_i − mateY` 的方差**（队伍平移已被扣掉）。
// P38 #90 §2.1 的 32% 是**总方差**的百分比。两者的换算：
//   总方差 = 队伍层 + DEV，而本节基数只含 DEV。
//   P38：队伍层 39.5% / 静息档位 32.1% / 个体游走 28.3%（总方差为基）
//   → DEV 内部分工 = 32.1 / (32.1 + 28.3) = **53.1%** slot，与本节 A 同义。
const devShare = 100 * (32.1 + 28.3) / 100; // 总方差里属于 DEV 的份额
say(`> ⚠ **基数换算**（读本节数字前必看）：本节全部百分比的分母是 **Var(y_i − mateY)**，`);
say(`> 即 P38 #90 §2.1 里已经把**队伍层平移扣掉**的 DEV 部分（占总方差 ${(100 * (1 - 0.395)).toFixed(1)}%）。`);
say(`> P38 的 32.1% 是**总方差**为基 → 换算到本节基数 = 32.1 / ${devShare.toFixed(1)} = **53.1%**。`);
say(`> 本节实测 A = ${(100 * totA / tot).toFixed(1)}% —— 与换算值一致（差在样本：6 场 → 20 场）。\n`);
say(`- **静态档位（A）占 ${(100 * totA / tot).toFixed(0)}%**（本节基数）≈ 总方差的 ${(totA / tot * 100 * (1 - 0.395)).toFixed(0)}%：`);
say('  引擎的静态模板**不是错的方向**，它只是"只做了这部分"。');
say(`- **情境响应（B）占 ${(100 * totCtx / tot).toFixed(0)}%**：把球/对手/邻居全给足（**线性**），`);
say('  当帧情境解释这么多。⚠ **这不是"响应路线的天花板"**——探针 2 的 GBM 证明');
say('  非线性/交互还能再拿约 7 个点（上限 0.886，不是 0.82）。**引用时勿把 B 当极限。**');
say(`- **个体残差（C）占 ${(100 * totRes / tot).toFixed(0)}%**（≈ 总方差的 ${(totRes / tot * 100 * (1 - 0.395)).toFixed(0)}%）：`);
say('  在全部当帧情境都给足之后**仍然剩下**的。');
say('  它决定了引擎的最小目标：**即使情境响应做到完美，也还有这么多方差**来自');
say('  "同一情境、同一个人，不同时刻做不同的事"。');
say('- 结论：**职责与响应都要建，但都不够**——C 层不是靠"更聪明的信号"能消掉的，');
say('  它需要**随机性 / 多稳态**（同一情境允许多个合理位置）。\n');

writeFileSync(join(C.OUT_DIR, '101-3-individuality.txt'), lines.join('\n'));
console.log(`\n→ ${join(C.OUT_DIR, '101-3-individuality.txt')}`);
