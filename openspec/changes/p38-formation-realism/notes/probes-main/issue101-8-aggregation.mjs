// wayfinder #101 探针 8：**聚合口径对照**——pooled（含个人固定效应）vs mean-of-per-person。
//
// ── 为什么需要这个探针 ──────────────────────────────────────────────────
// §5（`issue101-3-individuality.mjs`）与 §2（`UnitOLS`）用了**两种不同的聚合**，
// 第一版报告把它们当成同一口径来对账，得出的"互证"是巧合。本探针把两者
// 在**同一份面板、同一因子集、同一行集**上并列算出，供 §5.5 引用。
//
// ── ⚠ 本探针第一版把 (b) 列写错了（第二轮审阅发现，留档）──────────────
// 第一版的 (b) 循环 `byTeam`（key = `match|team`，**40 个「场·队」单元**），
// 却把结果标成 "mean-of-per-person"（应为 **400 个「场·队·人」单元**）。
// 后果：报出 75.2% / 88.3%，据此**错误地否定了第一轮审阅者的 0.539 / 0.824**——
// 审阅者是对的。本版改为按 `row[IDX.unit]` 累积，真值 **57.8% / 82.4%**。
//
// ── 两者的关系是近似，不是恒等式 ────────────────────────────────────────
// `B/(B+C)` = **共享 β** 的**比值之比**；`MoP` = **逐人 β** 的**比值之均值**。
// 二者只在"SST 跨人齐性 + β 齐性"时相等。实测净值：7 因子差 −0.21pp、14 因子差 +3.40pp。
// ⚠ 这两个净值**不是**任一处的真实量级——模型（共享β vs 逐人β）与聚合（比值之比 vs
//   比值之均值）两处同时不同、方向相反，净值是抵消后的残值。本探针**未分离**这两个来源。
// ⚠ 本文件第二版曾把它写成 `MoP R² ≡ B/(B+C)`——**第三轮审阅实测证伪**，已改。
// ⚠ 第二版还把 14 因子的 3.4pp 缺口解释为"成列删除与加权"——**错**：
//   (a)(b) 读的是同一批 byPerson 行，不存在行集差异。
//
// 运行：node issue101-8-aggregation.mjs
// 产出：out/101-8-aggregation.txt

import * as P from './issue101-panel.mjs';
import * as C from './issue101-common.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const meta = await P.buildPanel({ stride: 10 });
const lines = [];
const say = (x = '') => { lines.push(x); console.log(x); };
mkdirSync(C.OUT_DIR, { recursive: true });
say('# #101 探针 8：聚合口径对照\n');

const SETS = {
  '7 个（§5 用）': ['ballY', 'ballDepth', 'phase', 'nearOppY', 'k3OppY', 'oppCy', 'ownX'],
  '14 个（§2 用）': ['ballY', 'ballDepth', 'phase', 'nearOppY', 'k3OppY', 'oppCy', 'nearMateY', 'k3MateY', 'k3AnyY', 'nearAnyDist', 'goalOwnY', 'goalOppY', 'ownX', 'xXphase'],
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

const summary = [];
for (const [label, CTX] of Object.entries(SETS)) {
  const ctxF = CTX.map((n) => P.FACTORS.find((f) => f.name === n));
  const cols = ctxF.map((f) => f.col);
  // 按「场·队·人」单元收集；pooled 的"队"由 `bp.team` 字段在下方重建
  const byPerson = new Map();
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
    const ku = row[P.IDX.unit];
    if (!byPerson.has(ku)) byPerson.set(ku, { team: `${u.match}|${u.team}`, X: [], y: [] });
    const bp = byPerson.get(ku); bp.X.push(xs); bp.y.push(y);
  });
  const F = cols.length, K = F + 1;

  // ── (a) pooled（§5 口径）：组内去均值（个人固定效应）后回归 devY ──
  {
    // 组内去均值 = 减去该 person 的均值（person 即 byPerson 的 key）
    let A_sum = 0, dev_sum = 0, ctx_sum = 0, N = 0;
    const teamGroups = new Map();
    for (const [k, bp] of byPerson) {
      const t = bp.team;
      if (!teamGroups.has(t)) teamGroups.set(t, []);
      teamGroups.get(t).push(k);
    }
    for (const [, keys] of teamGroups) {
      // 该队全部行
      const uArr = []; const yArr = []; const XArr = [];
      for (const k of keys) { const bp = byPerson.get(k); for (let i = 0; i < bp.y.length; i += 1) { uArr.push(k); yArr.push(bp.y[i]); XArr.push(bp.X[i]); } }
      const n = yArr.length; if (n < 400) continue;
      const grand = C.mean(yArr);
      const byLabel = new Map();
      for (let i = 0; i < n; i += 1) { if (!byLabel.has(uArr[i])) byLabel.set(uArr[i], []); byLabel.get(uArr[i]).push(yArr[i]); }
      let sumA = 0;
      for (const arr of byLabel.values()) sumA += arr.length * (C.mean(arr) - grand) ** 2;
      const A = sumA / n;
      const lm = new Map([...byLabel].map(([l, arr]) => [l, C.mean(arr)]));
      const devY = new Float64Array(n);
      for (let i = 0; i < n; i += 1) devY[i] = yArr[i] - lm.get(uArr[i]);
      const Xc = XArr.map((x) => Float64Array.from(x));
      for (let f = 0; f < F; f += 1) {
        const m = new Map();
        for (let i = 0; i < n; i += 1) { if (!m.has(uArr[i])) m.set(uArr[i], []); m.get(uArr[i]).push(Xc[i][f]); }
        const mm = new Map([...m].map(([l, arr]) => [l, C.mean(arr)]));
        for (let i = 0; i < n; i += 1) Xc[i][f] -= mm.get(uArr[i]);
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
    var pooledA = A_sum / N; var pooledDev = dev_sum / N; var pooledCtx = ctx_sum / N;
  }
  // pooled 的"可解释份额" = (A + B) / (A + DEV)：个人固定效应 + 情境，一起算进去。
  // ⚠ 第一版写成 `ctx / (A + dev)`——那是 **B 占总方差**的比，不是"可解释份额"，
  // 报出的 25.3% / 34.3% 因此不是这个量（审阅第二轮发现的同一处混乱）。
  const pooledExplained = (pooledA + pooledCtx) / (pooledA + pooledDev);   // = 1 − C
  const pooledC = 1 - pooledExplained;

  // ── (b) mean-of-per-person（§2 口径）：逐「场·队·人」单元各算 R² 再平均 ──
  const rs = [];
  for (const [, b] of byPerson) {
    const n = b.y.length; if (n < 60) continue;
    const A = new Float64Array(K * K), bv = new Float64Array(K);
    let sy = 0, syy = 0;
    for (let i = 0; i < n; i += 1) {
      for (let a = 0; a < K; a += 1) {
        const xa = a === 0 ? 1 : b.X[i][a - 1];
        for (let c = 0; c < K; c += 1) A[a * K + c] += xa * (c === 0 ? 1 : b.X[i][c - 1]);
        bv[a] += xa * b.y[i];
      }
      sy += b.y[i]; syy += b.y[i] * b.y[i];
    }
    let tr = 0; for (let i = 0; i < K; i += 1) tr += A[i * K + i];
    const beta = solve(A, bv, K, 1e-6 * tr / K); if (!beta) continue;
    let bb = 0; for (let i = 0; i < K; i += 1) bb += beta[i] * bv[i];
    let q = 0; for (let i = 0; i < K; i += 1) for (let j = 0; j < K; j += 1) q += beta[i] * A[i * K + j] * beta[j];
    const my = sy / n, sse = syy - 2 * bb + q, sst = syy - n * my * my;
    rs.push(sst > 0 ? Math.max(0, Math.min(1, 1 - sse / sst)) : 0);
  }
  const mop = rs.reduce((a, b) => a + b, 0) / rs.length;

  const B = pooledCtx, Cc = pooledDev - pooledCtx;
  say(`## ${label}\n`);
  say(`**pooled 分解**（§5 口径，占总方差）：A 静态档位 **${(100 * pooledA / (pooledA + pooledDev)).toFixed(1)}%**`);
  say(`/ B 情境响应 **${(100 * B / (pooledA + pooledDev)).toFixed(1)}%** / C 个体残差 **${(100 * Cc / (pooledA + pooledDev)).toFixed(1)}%**`);
  say(`→ 可解释份额 (A+B)/总 = **${(100 * pooledExplained).toFixed(1)}%**\n`);
  say(`**mean-of-per-person**（§2 口径）：**${(100 * mop).toFixed(1)}%**（${rs.length} 个「场·队·人」单元）\n`);
  say(`> **两者的关系是近似，不是恒等式**（第三轮实测证伪了第二轮的 \`MoP ≡ B/(B+C)\`）：`);
  say(`> \`B/(B+C)\` = **共享 β** 的**比值之比**；\`MoP\` = **逐人 β** 的**比值之均值**。`);
  say(`> 本因子集 B/(B+C) = ${C.f2(B, 3)}/${C.f2(B + Cc, 3)} = **${(100 * B / (B + Cc)).toFixed(2)}%**，实测 MoP = **${(100 * mop).toFixed(2)}%**，差 **${(100 * (mop - B / (B + Cc))).toFixed(2)}pp**。`);
  say(`> ⚠ 故 pooled 的"可解释份额"（${(100 * pooledExplained).toFixed(1)}%）与 MoP（${(100 * mop).toFixed(1)}%）**不是同一个量**：`);
  say(`> 前者含 A（个人固定效应），后者**不含**——MoP 只对应 B/(B+C)。`);
  say('');
  summary.push({ label, pooledExplained, mop, B, C: Cc, pooledA, pooledDev });

}

say('## 结论\n');
say('| 因子集 | pooled A/B/C（占比） | pooled 可解释 (A+B) | MoP（≈ B/(B+C)） |');
say('|---|---|---|---|');
for (const s of summary) {
  const tot = s.pooledA + s.pooledDev;
  say(`| ${s.label} | ${(100 * s.pooledA / tot).toFixed(1)} / ${(100 * s.B / tot).toFixed(1)} / ${(100 * s.C / tot).toFixed(1)}%`
    + ` | ${(100 * s.pooledExplained).toFixed(1)}% | ${(100 * s.mop).toFixed(1)}% |`);
}
say('');
say('> **读法**：两个口径**回答不同问题**，不是同一量的两种算法：');
say('> - `pooled` 把**个人固定效应（A）**算进"可解释"，给出 A/B/C 三层。');
say('> - `MoP` 的截距吸收了 A，故它**近似** B/(B+C)（本数据 7 因子差 −0.21pp、14 因子差 +3.40pp；');
say('> - 因此"聚合差"不是一个有意义的量；有意义的是 **A+B**（pooled，81.7%）与');
say('>   这两个数**不能**读成"两口径差距"——模型与聚合两处同时不同、方向相反，净值是抵消后的残值）。');
say('');
say('> ⚠ **本探针第一版报的 75.2% / 88.3% 是错的**（循环 `byTeam` 而非 `byPerson`，');
say('> 40 单元而非 400；且 (a) 列误写成 B/总）。第一轮审阅者的 **0.824（14 因子）在新口径下正确**；');
say('> 7 因子 0.539 vs 本版 0.578 差 3.9pp（成列删除行集之别）。**本版为准。**');

writeFileSync(join(C.OUT_DIR, '101-8-aggregation.txt'), lines.join('\n'));
console.log(`\n→ ${join(C.OUT_DIR, '101-8-aggregation.txt')}`);
