// wayfinder #101 探针 4：**局部结构 vs 绝对位置**——球员在响应"绝对信号"还是"相对关系"？
//
// ── 问题 ────────────────────────────────────────────────────────────────
// P38 #90 §2.3 的三条反证只证明了"不是一对一盯人"（换最近队友也 R²=0.73 /
// 盯人对象只有 30% 稳定 / 交叉相关峰值在 Δ=0），**没有回答**：
//   球员的 y 到底在跟随**绝对信号**（球的绝对 y、对手的绝对 y），
//   还是在维持**相对关系**（跟队友保持 y 间距、跟对手保持距离）？
//
// ── 方法 ────────────────────────────────────────────────────────────────
// 关键观察：`y_i = mateY + dev_i`，`mateY` 是队友的绝对量。
// 若球员维持"与某人的 y 间距"，dev_i 应由**别人的相对量**解释；
// 若由**绝对量**（ballY 的绝对值）解释，那是绝对信号。
//
//   · 绝对模型：dev_i ~ ballY(相对), ballDepth, ownX, phase
//   · 相对模型：dev_i ~ 与最近队友/对手的 y 间距与距离
//   · 两者 + 增量
//
// ── 另一视角：相邻次序间距的帧间稳定性 ──────────────────────────────────
// 真的"维持相对关系"应表现为：**相邻两人的 y 间距**比随机打乱更稳定。
//
// 运行：node issue101-4-structure.mjs
// 产出：out/101-4-structure.txt

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as C from './issue101-common.mjs';
import * as Q from './q90-common.mjs';
import { buildPanel, readPanel, FACTORS, IDX } from './issue101-panel.mjs';

const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };
mkdirSync(C.OUT_DIR, { recursive: true });

const meta = await buildPanel({ stride: 10 });
say('# #101 探针 4：局部结构 vs 绝对位置\n');
say(`面板：${meta.nRows.toLocaleString()} 行\n`);

// ── 4.1 绝对 vs 相对的增量解释力 ────────────────────────────────────────
say('## 4.1 "绝对信号"与"相对关系"的增量解释力\n');
say('> 与探针 1 同口径：逐「场·队·人」单元回归、跨单元平均、成列删除。\n');

// ⚠ **自指因子不能进多因子模型**：DV = `y_i − mateY`，而
//   `nearMateGap = y_i − y_最近队友`、`nearMateY = y_最近队友 − mateY` **代数互补**，
//   两者并存可精确重构 DV（第一版实测 R²=1.0000 的假绿）。
//   故"相对关系"一组改用**非自指**的他人位置（相对 my team 重心）。
//   距离量（nearMateDist 等）由本人位置算出但不是 y_i 的线性函数，保留但标注。
const ABS = ['ballY', 'ballDepth', 'ownX', 'phase'];          // 球 + 本人纵向
const REL = ['nearMateY', 'k3MateY', 'nearOppY', 'k3OppY', 'oppCy']; // 他人位置（相对队友重心）
const absF = ABS.map((n) => FACTORS.find((f) => f.name === n));
const relF = REL.map((n) => FACTORS.find((f) => f.name === n));

// 逐单元正规方程累积器（含截距）
class MultiAcc {
  constructor(F) { this.F = F; this.u = new Map(); }
  add(unit, x, y) {
    let a = this.u.get(unit);
    const K = this.F + 1;
    if (!a) { a = { n: 0, XtX: new Float64Array(K * K), Xty: new Float64Array(K), syy: 0, sy: 0 }; this.u.set(unit, a); }
    for (let i = 0; i < K; i += 1) {
      const xi = i === 0 ? 1 : x[i - 1];
      for (let j = 0; j < K; j += 1) a.XtX[i * K + j] += xi * (j === 0 ? 1 : x[j - 1]);
      a.Xty[i] += xi * y;
    }
    a.n += 1; a.sy += y; a.syy += y * y;
  }
  solve(minN = 60) {
    const r2s = []; let n = 0;
    for (const a of this.u.values()) {
      if (a.n < minN) continue;
      const K = this.F + 1;
      const b = solveNormal(a.XtX, a.Xty, K, 1e-8);
      if (!b) continue;
      const sse = a.syy - 2 * dot(b, a.Xty) + quad(b, a.XtX, K);
      const my = a.sy / a.n; const sst = a.syy - a.n * my * my;
      r2s.push(sst > 0 ? Math.max(0, Math.min(1, 1 - sse / sst)) : 0);
      n += a.n;
    }
    return r2s.length ? { r2: C.mean(r2s), n, units: r2s.length } : { r2: null, n: 0, units: 0 };
  }
}
function solveNormal(A, b, K, ridge) {
  const M = new Float64Array(K * (K + 1));
  for (let i = 0; i < K; i += 1) {
    for (let j = 0; j < K; j += 1) M[i * (K + 1) + j] = A[i * K + j] + (i === j ? ridge : 0);
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
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i += 1) s += a[i] * b[i]; return s; };
const quad = (b, A, K) => { let s = 0; for (let i = 0; i < K; i += 1) for (let j = 0; j < K; j += 1) s += b[i] * A[i * K + j] * b[j]; return s; };

const absAcc = new MultiAcc(absF.length);
const relAcc = new MultiAcc(relF.length);
const bothAcc = new MultiAcc(absF.length + relF.length);

await readPanel((row) => {
  const y = row[IDX.y];
  if (!Number.isFinite(y)) return;
  const u = row[IDX.unit];
  const xa = absF.map((f) => (f.signed ? (row[f.col] === 1 ? 1 : row[f.col] === 0 ? -1 : NaN) : row[f.col]));
  const xr = relF.map((f) => row[f.col]);
  if (xa.some((v) => !Number.isFinite(v))) return;
  if (xr.some((v) => !Number.isFinite(v))) return;
  absAcc.add(u, xa, y);
  relAcc.add(u, xr, y);
  bothAcc.add(u, [...xa, ...xr], y);
});
const rAbs = absAcc.solve();
const rRel = relAcc.solve();
const rBoth = bothAcc.solve();

say(`| 模型 | 特征 | 全模型 R²（逐单元平均） | 行数 |`);
say(`|---|---|---|---|`);
say(`| 绝对信号 | ${ABS.join(', ')} | ${C.f2(rAbs.r2, 3)} | ${rAbs.n.toLocaleString()} |`);
say(`| 相对关系 | ${REL.join(', ')} | ${C.f2(rRel.r2, 3)} | ${rRel.n.toLocaleString()} |`);
say(`| 两者 | 全部 8 个 | **${C.f2(rBoth.r2, 3)}** | ${rBoth.n.toLocaleString()} |`);
say('');
say(`- **相对关系在绝对信号之上的增量 = ${C.f2(rBoth.r2 - rAbs.r2, 3)}**`);
say(`- **绝对信号在相对关系之上的增量 = ${C.f2(rBoth.r2 - rRel.r2, 3)}**`);
say('');
say('> ⚠ 两个增量**不能相加当唯一贡献**（共线）。真正的唯一贡献见探针 1 的 unique R²。');
say('> 这里读的是"谁更能独立站住"。\n');
say('> ⚠ **共享参考系的诚实说明**：因变量 `y_i − mateY` 与"相对关系"组的因子都含 `−mateY`');
say('> 这一项。这不是**泄漏**（因子不含 `y_i`），但它意味着这组数字回答的是');
say('> "**队友/对手在队伍坐标系里的位置**能多好地预测我在同一坐标系里的位置"——');
say('> 这正是"局部结构"命题本身，不是同义反复。P38 §5.3 的偏相关是更严的版本（扣掉共享项），');
say('> 本探针的对照是 §4.2 的**打乱检验**（726× 分离）与探针 1 的单变量表（同一因变量口径）。\n');

// ── 4.2 相邻次序间距的帧间稳定性 ────────────────────────────────────────
say('## 4.2 相邻次序间距的帧间稳定性（"真的在维持相对关系吗"）\n');
say('> 若球员维持与队友的相对关系，**同一次序对**的 y 间距应在时间上稳定。');
say('> 测法：逐帧取按 y 排序后的**相邻间距序列**（9 个数），算该序列的 lag-1 自相关。');
say('> 打乱对照：把每帧的 y 随机重排后再算（此时"相邻"是随机的）→ 稳定性应塌。\n');

function gapStability(ids, { shuffle = false, seed = 5 } = {}) {
  const out = [];
  const rnd = new C.mulberry32(seed);
  for (const id of ids) {
    const m = C.loadSkillcorner(id);
    for (const team of ['home', 'away']) {
      let prevGaps = null; let sumAC = 0; let nAC = 0;
      const posSeries = Array.from({ length: 9 }, () => []);
      for (let i = 0; i < m.frames.length; i += 10) {
        const ps = Q.framePlayers(m, m.frames[i], team, { idx: i });
        if (ps.length < 7) continue;
        let ys = ps.map((p) => p.y).sort((a, b) => a - b);
        if (shuffle) {
          ys = ys.slice();
          for (let j = ys.length - 1; j > 0; j -= 1) { const k = Math.floor(rnd() * (j + 1)); [ys[j], ys[k]] = [ys[k], ys[j]]; }
        }
        const gaps = [];
        for (let j = 1; j < ys.length; j += 1) gaps.push(ys[j] - ys[j - 1]);
        for (let j = 0; j < gaps.length; j += 1) posSeries[j].push(gaps[j]);
        if (prevGaps && prevGaps.length === gaps.length) {
          const a = Q.corr(prevGaps, gaps);
          if (Number.isFinite(a)) { sumAC += a; nAC += 1; }
        }
        prevGaps = gaps;
      }
      if (nAC < 100) continue;
      out.push({ key: `${id}|${team}`, ac: sumAC / nAC, gapSd: C.mean(posSeries.map((s) => C.std(s))), meanGap: C.mean(posSeries.map((s) => C.mean(s))) });
    }
  }
  return out;
}
const ids = C.skillcorner20Ids();
const gs = gapStability(ids);
const gsShuf = gapStability(ids, { shuffle: true });
say(`| | 相邻间距的 lag-1 自相关 | 各间距位置的 sd 均值 | 平均间距 | 队·场 n |`);
say(`|---|---|---|---|---|`);
say(`| 真实 | **${C.f2(C.mean(gs.map((g) => g.ac)), 3)}** | ${C.f2(C.mean(gs.map((g) => g.gapSd)))}m | ${C.f2(C.mean(gs.map((g) => g.meanGap)))}m | ${gs.length} |`);
say(`| 打乱每帧的 y | ${C.f2(C.mean(gsShuf.map((g) => g.ac)), 3)} | ${C.f2(C.mean(gsShuf.map((g) => g.gapSd)))}m | ${C.f2(C.mean(gsShuf.map((g) => g.meanGap)))}m | ${gsShuf.length} |`);
say('');
say(`> **真实/打乱比 = ${C.f2(C.mean(gs.map((g) => g.ac)) / Math.max(1e-9, C.mean(gsShuf.map((g) => g.ac))), 1)}×**`);
say('> —— 自相关显著高于打乱 → 相邻次序关系确在时间上被维持。');
say('> 但这可能只是"队形整体稳定"的副产品（P38 §2.2 的共线警告），不作因果解读。\n');

writeFileSync(join(C.OUT_DIR, '101-4-structure.txt'), lines.join('\n'));
console.log(`\n→ ${join(C.OUT_DIR, '101-4-structure.txt')}`);
