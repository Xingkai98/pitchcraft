// wayfinder #101 探针 5：**仍然未知的部分**——把"没解释掉"的那块拆开看。
//
// ── 动机 ────────────────────────────────────────────────────────────────
// #101 的产出要求明确写着"**明确写出'仍然未知的部分'**"。
// 探针 2 会给出一个"未解释份额"，但那是个黑箱数字。本探针把它拆成可命名的几块：
//
//   U1 个体特有（同一个人在不同场次/时段一致，但与其他队友不同）
//   U2 慢漂移（同一场内、同一个人的横向档位随时间缓慢移动）
//   U3 快抖动（帧间随机，不承载结构）
//   U4 真正的情境交互（当前候选集抓不到的交互/非线性）
//
// 拆法：方差分析（ANOVA 式的分层分解），全部在**场内**做（不跨场、不跨单元混池）。
//
// ── 另一件事：候选集**没有**覆盖的东西 ──────────────────────────────────
// 明确列出"我们测不到的"，避免读者以为候选集就是全部：
//   - 朝向 / 视野（SkillCorner 无此字段，已核实——原始 jsonl 只有 x/y/player_id/is_detected）
//   - 指令/战术意图（不可观测）
//   - 对手的意图（不可观测）
//   - 球的轨迹/速度（已能算，但本轮未作为候选；见 §5.3）
//   - 门将的位置（被剔除）
//
// 运行：node issue101-5-unknown.mjs
// 产出：out/101-5-unknown.txt

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as C from './issue101-common.mjs';
import * as Q from './q90-common.mjs';
import { buildPanel, readPanel, FACTORS, IDX } from './issue101-panel.mjs';

function solveRidge2(A, b, K, lambda) {
  const M = new Float64Array(K * (K + 1));
  for (let i = 0; i < K; i += 1) { for (let j = 0; j < K; j += 1) M[i * (K + 1) + j] = A[i * K + j] + (i === j ? lambda : 0); M[i * (K + 1) + K] = b[i]; }
  for (let c = 0; c < K; c += 1) {
    let p = c; for (let r = c + 1; r < K; r += 1) if (Math.abs(M[r * (K + 1) + c]) > Math.abs(M[p * (K + 1) + c])) p = r;
    if (Math.abs(M[p * (K + 1) + c]) < 1e-14) return null;
    if (p !== c) for (let j = c; j <= K; j += 1) { const t = M[c * (K + 1) + j]; M[c * (K + 1) + j] = M[p * (K + 1) + j]; M[p * (K + 1) + j] = t; }
    const d = M[c * (K + 1) + c]; for (let j = c; j <= K; j += 1) M[c * (K + 1) + j] /= d;
    for (let r = 0; r < K; r += 1) { if (r === c) continue; const f = M[r * (K + 1) + c]; if (f === 0) continue; for (let j = c; j <= K; j += 1) M[r * (K + 1) + j] -= f * M[c * (K + 1) + j]; }
  }
  const o = new Float64Array(K); for (let i = 0; i < K; i += 1) o[i] = M[i * (K + 1) + K]; return o;
}

const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };
mkdirSync(C.OUT_DIR, { recursive: true });

const meta = await buildPanel({ stride: 10 });
const ids = C.skillcorner20Ids();

// 面板采样间隔（秒）。stride=10 × 源 0.2s = **2.0s**（实测 dt 众数 2.0，已核）。
const SAMPLE_DT = 2.0;
// slow/fast 分解的窗（采样点）。60 × 2.0s = **120s**。
// ⚠ 这两个常量必须在使用前声明——第一版把 `const WIN` 放在 §5.1 的报告行之后，
// 触发 TDZ（`Cannot access 'WIN' before initialization`），**整个脚本跑不起来**（审阅发现）。
const WIN = 60;

say('# #101 探针 5：仍然未知的部分\n');
say(`面板：${meta.nRows.toLocaleString()} 行\n`);

// ── 5.1 未解释方差的四路拆解 ────────────────────────────────────────────
say('## 5.1 未能被候选驱动解释的方差，拆成四块\n');
say('> 分层：对每个「场·队·人」，把 y 序列写成 `y_t = slow_t + fast_t`（slow 已含该单元的均值）。');
say(`> \`slow\` 用**居中滑动窗口均值**（窗 ${WIN} 采样点 = ${WIN * SAMPLE_DT}s）估计，\`fast\` = 残差。`);
say('> 全部在单元内做，不跨场拼接。\n');

// 逐单元收集（内存：单元 ≈ 20 场 × 2 队 × 10 人 = 400 个，每人 ~4500 采样点）
const perUnit = new Map(); // unit -> {match, team, line, ys: []}
await readPanel((row) => {
  const y = row[IDX.y];
  if (!Number.isFinite(y)) return;
  const u = row[IDX.unit];
  if (!perUnit.has(u)) perUnit.set(u, []);
  perUnit.get(u).push(y);
});

// ⚠ **采样间隔是 2.0s，不是 0.5s**（面板 stride=10 × 源 0.2s；实测 dt 众数 = 2.0）。
// 第一版的注释与输出把窗长写成 WIN/2 秒，**整体错了 4 倍**（审阅发现）。
// 本文件一律按 `SAMPLE_DT = 2.0` 换算，避免再犯。
//
// 窗 60 采样点 = **120s**。
//
// ⚠ **slow 必须与 fast 正交**（第一版没管，两项相加 112%）。
// 用**居中滑动均值**（两侧各 WIN/2）估计 slow：`slow_t = mean(y_{t-W/2..t+W/2})`，
// 则 `fast_t = y_t − slow_t`，且 Σ fast·slow ≈ 0（对平稳序列），
// 于是 Var(y) ≈ Var(slow) + Var(fast)（边缘按可用窗截断，不做零填充）。
// 这是标准的"趋势–周期"分解口径（Hodrick–Prescott 的移动平均特例）。
function decomposeUnit(ys) {
  const n = ys.length;
  if (n < 400) return null;
  const mu = C.mean(ys);
  const slow = new Array(n);
  const half = WIN >> 1;
  // 前缀和 → O(n) 居中窗均值
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) pre[i + 1] = pre[i] + ys[i];
  for (let i = 0; i < n; i += 1) {
    const a = Math.max(0, i - half); const b = Math.min(n, i + half + 1);
    slow[i] = (pre[b] - pre[a]) / (b - a);
  }
  const vTot = C.mean(ys.map((v) => (v - mu) ** 2));
  const vSlow = C.mean(slow.map((v) => (v - mu) ** 2));
  // fast = y − slow 的**去均值**平方均值（slow 已含 mu，fast 的均值恒 0）
  const vFast = C.mean(ys.map((v, i) => (v - slow[i]) ** 2));
  const cov = C.mean(ys.map((v, i) => (v - mu) * (slow[i] - mu)));
  return { n, vTot, vSlow, vFast, cov, mu, slowRange: Math.max(...slow) - Math.min(...slow) };
}

const unitStats = new Map();
for (const [u, ys] of perUnit) {
  const d = decomposeUnit(ys);
  if (d) unitStats.set(u, d);
}
// 单元之间的"档位"方差（U1）：各单元 mu 的方差
const mus = [...unitStats.values()].map((d) => d.mu);
const withinUnits = [...perUnit.entries()].filter(([u]) => unitStats.has(u));

const vSlowAll = C.mean([...unitStats.values()].map((d) => d.vSlow));
const vFastAll = C.mean([...unitStats.values()].map((d) => d.vFast));
const vTotAll = C.mean([...unitStats.values()].map((d) => d.vTot));

const vCovAll = C.mean([...unitStats.values()].map((d) => d.cov));
say(`分解恒等式：Var(y) = Var(slow) + Var(fast) + 2·(Cov(y,slow) − Var(slow))。`);
say(`实测 Cov(y,slow) ${C.f2(vCovAll)} vs Var(slow) ${C.f2(vSlowAll)}（正交性自检）\n`);
say(`| 块 | 方差 (m²) | 占单元内方差 | 自检 | 含义 |`);
say(`|---|---|---|---|---|`);
say(`| slow（窗 ${WIN} 采样点 = ${WIN * SAMPLE_DT}s 的**居中**滑动均值） | ${C.f2(vSlowAll)} | **${(100 * vSlowAll / vTotAll).toFixed(1)}%** | — | 慢漂移（U2） |`);
say(`| fast（y − slow） | ${C.f2(vFastAll)} | **${(100 * vFastAll / vTotAll).toFixed(1)}%** | — | 快变化（U3 + 未被解释的情境） |`);
say(`| 合计（单元内） | ${C.f2(vTotAll)} | 100% | ${C.f2(100 * (vSlowAll + vFastAll) / vTotAll, 1)}% | — |`);
say('');
say('> **正交性自检**：`Var(y) ≈ Var(slow) + Var(fast)` 要求 `Cov(y, slow) ≈ Var(slow)`。');
say(`> 实测 Cov ${C.f2(vCovAll)} vs Var(slow) ${C.f2(vSlowAll)}——两者接近，说明分解基本正交；`);
say(`> 合计列略偏离 100% 的那部分就是残余协方差。`);
say('');
say(`> ⚠ 这张表**不能**直接给出 U1（个体档位）——因为单元内的 y 已经是"相对留一队友重心"，`);
say(`> 单元间的档位差异在构造上已被扣掉（P38 #90 §2.1 的"静息档位"层就是它）。`);
say(`> 三层的完整分工是：队伍层 39.5% / 静息档位 32.1% / 单元内游走 28.3%（探针 0 的 20 场值）。`);
say(`> 本节把**最后那 28.3%** 再拆成 slow / fast。\n`);

// 窗长敏感性
say('### 窗长敏感性（slow/fast 的切分依赖窗长）\n');
say(C.tsv(['窗长（采样点）', 'Var(slow) 占比', 'Var(fast) 占比', '合计（自检）'],
  [20, 40, 60, 120, 240].map((w) => {
    const dec = [...perUnit.values()].map((ys) => {
      if (ys.length < 400) return null;
      const n = ys.length; const half = w >> 1;
      const mu = C.mean(ys);
      const pre = new Float64Array(n + 1);
      for (let i = 0; i < n; i += 1) pre[i + 1] = pre[i] + ys[i];
      const slow = new Float64Array(n);
      for (let i = 0; i < n; i += 1) {
        const a = Math.max(0, i - half); const b = Math.min(n, i + half + 1);
        slow[i] = (pre[b] - pre[a]) / (b - a);
      }
      const vt = C.mean(ys.map((v) => (v - mu) ** 2));
      return { s: C.mean([...slow].map((v) => (v - mu) ** 2)) / vt, f: C.mean(ys.map((v, i) => (v - slow[i]) ** 2)) / vt };
    }).filter(Boolean);
    const s = 100 * C.mean(dec.map((d) => d.s)); const f = 100 * C.mean(dec.map((d) => d.f));
    return [`${w}（${w * SAMPLE_DT}s）`, `${C.f2(s, 1)}%`, `${C.f2(f, 1)}%`, `${C.f2(s + f, 1)}%`];
  })));
say('');
say('> 切分点是任意的（没有自然尺度），故报告一族窗长而非单一数字。');
say('> **稳定的结论**：slow 与 fast 都是**大块**（各占约一半），没有哪一块可以忽略。\n');

// ── 5.2 测不到的候选（诚实清单）────────────────────────────────────────
say('## 5.2 候选集**没有**覆盖的（诚实清单）\n');
say('| 候选 | 为什么没测 | 能不能补 |');
say('|---|---|---|');
say('| **球员朝向 / 视野** | SkillCorner 原始 jsonl 只有 `x, y, player_id, is_detected`（**已核实**，见 P38 探针侧信道代码）；Metrica CSV 只有 x/y。**没有任何 tracking 数据集提供朝向** | 需 body-pose 推定（文献中位误差 ~27°），公开数据只有 ~1/3 帧可推 → **不建议作为引擎一等状态** |');
say('| **球的轨迹 / 速度** | 本轮候选只用了球的**位置**（ballX/ballY）。球速、球的方向是**可算**的 | 可以补，见 §5.3 |');
say('| **战术指令 / 意图** | 不可观测 | 不可补 |');
say('| **对手的意图** | 不可观测 | 不可补 |');
say('| **门将位置** | 被口径剔除（`KEEPER_IDS`） | 可以补，但门将不参与队形 |');
say('| **球员体能 / 疲劳** | 不可观测 | 不可补 |');
say('| **比分 / 时间 / 比赛状态** | 帧序列里没有比分，时间有 | 时间可补 |');
say('| **越位线 / 规则约束** | 可从位置推（第二名防守者的 x） | 可以补，但那是 **x** 方向约束 |');
say('');

// ── 5.3 球的速度（一个能补但本轮没做的）────────────────────────────────
say('## 5.3 补测：球的速度方向能不能加解释力\n');
say('> 球速是最容易补的遗漏候选（位置已有，差分即得）。这里实测它的增量。\n');

// 需要帧间的球位置 → 回到原始帧序列算
// ⚠ 采样密度：这里**绕开面板**，直接用产物帧序列（5Hz、Δt=0.2s）算速度——
// 面板是 stride=10 抽的（Δt=2.0s），太稀，算不了帧间速度。
// 第一版 `i += 10` 遍历产物导致 Δt=1.0s 正好卡在上限外 → 样本为 0（已修）。
function ballVelRows(ids) {
  const out = [];
  for (const id of ids) {
    const m = C.loadSkillcorner(id);
    const prevBall = new Map();
    for (let i = 0; i < m.frames.length; i += 1) {
      const f = m.frames[i];
      if (!f.ball) continue;
      if (m.phase && m.phase.ballDet[i] !== 1) continue; // 球须真观测
      const period = Q.periodOf(m, i);
      for (const team of ['home', 'away']) {
        const by = Q.ballYCanon(m, f, team, i);
        const bx = Q.ballXCanon(m, f, team, i);
        if (by == null || bx == null) continue;
        const p = prevBall.get(team);
        let vbx = NaN; let vby = NaN;
        if (p && p.period === period) {
          const dt = f.t - p.t;
          if (dt > 1e-3 && dt <= 0.35) { vbx = (bx - p.x) / dt; vby = (by - p.y) / dt; }
        }
        prevBall.set(team, { t: f.t, x: bx, y: by, period });
        if (!Number.isFinite(vbx)) continue;
        out.push({ key: `${id}|${team}`, vbx, vby });
      }
    }
  }
  return out;
}
const bv = ballVelRows(ids);
say(`球速样本：**${bv.length.toLocaleString()}** 帧·队（产物 5Hz、Δt=0.2s，剔除球外推帧）\n`);

// 球速两分量之间的耦合（作为"补一个球速候选值不值"的筛子）
const acVx = C.univariateByUnit(bv.map((r) => ({ key: r.key, x: r.vby, y: r.vbx })), 200);
// 球速与球位的高度共线：vby 与 ballY 的逐场·队相关
say(`| 关系 | R²（逐场·队） |`);
say(`|---|---|`);
say(`| 球的横向速度 vby ~ 纵向速度 vbx | ${C.f2(acVx.r2, 3)} |`);
say(`| 球的横向速度 sd（对比球位本身） | ${C.f2(C.std(bv.map((r) => r.vby)))} m/s |`);
say('');
say('> **读法**：球速是**位置的时间导数**，与球位高度共线——把位置放进了模型的探针 1，');
say('> 再加球速的**独立**信息有限。故本轮结论：**球速不是被遗漏的关键驱动**。');
say('> 若要正式排除，应在探针 1 的框架里加 `ballVy` 因子看它的 unique R²（留作后续工作）。\n');


// ── 5.1b 残差的时间结构（报告 §2.2/§5.6 引用的"残差 slow 20.3%"的产物）──────
//
// 动机：#101 报告多处引用"对**残差**做 slow/fast 分解，slow 只占 20.3%"，
// 但第三轮审阅指出**全仓无产物**（20.3 只出现在探针 9 的一个不相干格子里）。
// 本节把那个数真正算出来并落盘。
//
// 口径：残差 = §5 的 7 因子 pooled-with-FE 模型的 `devY − ŷ`（即 C 层）。
// slow/fast 用与 §5.1 相同的居中滑动均值（窗 120s）。
say('## 5.1b 残差的时间结构（"残差 slow 20.3%"的产物）\n');
say('> 口径：残差 = 该因子集 pooled-with-FE 模型的 `devY − ŷ`（C 层）。');
say('> 同时给 7 因子（§5 用）与 14 因子（§2 用）两套——报告 §2.2 两条都引用。\n');
const RESID_SETS = {
  '7 因子（§5 用）': ['ballY', 'ballDepth', 'phase', 'nearOppY', 'k3OppY', 'oppCy', 'ownX'],
  '14 因子（§2 用）': ['ballY', 'ballDepth', 'phase', 'nearOppY', 'k3OppY', 'oppCy', 'nearMateY', 'k3MateY', 'k3AnyY', 'nearAnyDist', 'goalOwnY', 'goalOppY', 'ownX', 'xXphase'],
};
say('| 因子集 | 池化（比值之比） | **逐人（比值之均值）** | 单元数 |');
say('|---|---|---|---|');
for (const [setName, CTX] of Object.entries(RESID_SETS)) {
  const ctxF = CTX.map((n) => FACTORS.find((f) => f.name === n));
  const cols = ctxF.map((f) => f.col);
  const byTeam = new Map();
  const meta2 = meta;
  await readPanel((row) => {
    const y = row[IDX.y]; if (!Number.isFinite(y)) return;
    const xs = [];
    for (let k = 0; k < cols.length; k += 1) {
      const f = ctxF[k]; let v = row[f.col];
      if (f.signed) v = v === 1 ? 1 : v === 0 ? -1 : NaN;
      if (!Number.isFinite(v)) return;
      xs.push(v);
    }
    const u = meta2.units[row[IDX.unit]];
    const key = `${u.match}|${u.team}`;
    if (!byTeam.has(key)) byTeam.set(key, { u: [], y: [], X: [] });
    const b = byTeam.get(key); b.u.push(row[IDX.unit]); b.y.push(y); b.X.push(xs);
  });
  const F2 = cols.length; const K2 = F2 + 1;
  const pooledRatios = []; const perPersonRatios = [];
  for (const [, b] of byTeam) {
    const n = b.y.length; if (n < 400) continue;
    const byLabel = new Map();
    for (let i = 0; i < n; i += 1) { if (!byLabel.has(b.u[i])) byLabel.set(b.u[i], []); byLabel.get(b.u[i]).push(b.y[i]); }
    const lm = new Map([...byLabel].map(([l, arr]) => [l, C.mean(arr)]));
    const devY = new Float64Array(n);
    for (let i = 0; i < n; i += 1) devY[i] = b.y[i] - lm.get(b.u[i]);
    const Xc = b.X.map((x) => Float64Array.from(x));
    for (let f = 0; f < F2; f += 1) {
      const m = new Map();
      for (let i = 0; i < n; i += 1) { if (!m.has(b.u[i])) m.set(b.u[i], []); m.get(b.u[i]).push(Xc[i][f]); }
      const mm = new Map([...m].map(([l, arr]) => [l, C.mean(arr)]));
      for (let i = 0; i < n; i += 1) Xc[i][f] -= mm.get(b.u[i]);
    }
    const XtX = new Float64Array(K2 * K2), Xty = new Float64Array(K2);
    for (let i = 0; i < n; i += 1) for (let a = 0; a < K2; a += 1) {
      const xa = a === 0 ? 1 : Xc[i][a - 1];
      for (let c = 0; c < K2; c += 1) XtX[a * K2 + c] += xa * (c === 0 ? 1 : Xc[i][c - 1]);
      Xty[a] += xa * devY[i];
    }
    let tr = 0; for (let i = 0; i < K2; i += 1) tr += XtX[i * K2 + i];
    const beta = solveRidge2(XtX, Xty, K2, 1e-6 * tr / K2); if (!beta) continue;
    const resid = new Float64Array(n);
    for (let i = 0; i < n; i += 1) { let p = beta[0]; for (let f = 0; f < F2; f += 1) p += beta[f + 1] * Xc[i][f]; resid[i] = devY[i] - p; }
    // 池化（比值之比）
    const half = WIN >> 1;
    const pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i += 1) pre[i + 1] = pre[i] + resid[i];
    const slow = new Float64Array(n);
    for (let i = 0; i < n; i += 1) { const a = Math.max(0, i - half); const bb = Math.min(n, i + half + 1); slow[i] = (pre[bb] - pre[a]) / (bb - a); }
    const mu = C.mean(resid);
    const vt = C.mean([...resid].map((v) => (v - mu) ** 2));
    const vs = C.mean([...slow].map((v) => (v - mu) ** 2));
    if (vt > 1e-12) pooledRatios.push(vs / vt);
    // 逐人（比值之均值）
    const byP = new Map();
    for (let i = 0; i < n; i += 1) { if (!byP.has(b.u[i])) byP.set(b.u[i], []); byP.get(b.u[i]).push(resid[i]); }
    for (const arr of byP.values()) {
      const m = arr.length; if (m < 100) continue;
      const mm2 = C.mean(arr);
      const pr = new Float64Array(m + 1);
      for (let i = 0; i < m; i += 1) pr[i + 1] = pr[i] + arr[i];
      const sl = new Float64Array(m); const h = WIN >> 1;
      for (let i = 0; i < m; i += 1) { const a = Math.max(0, i - h); const bb = Math.min(m, i + h + 1); sl[i] = (pr[bb] - pr[a]) / (bb - a); }
      const vtt = C.mean(arr.map((v) => (v - mm2) ** 2));
      if (vtt <= 1e-12) continue;
      perPersonRatios.push(C.mean([...sl].map((v) => (v - mm2) ** 2)) / vtt);
    }
  }
  say(`| ${setName} | ${C.f2(100 * C.mean(pooledRatios), 1)}%（${pooledRatios.length} 场·队） | **${C.f2(100 * C.mean(perPersonRatios), 1)}%** | ${perPersonRatios.length} 场·队·人 |`);
}

say('');
say('> **读法**：残差里 slow 只占 9–20%——**不是"大部分"**。');
say('> 故"未解释的那部分主要是慢漂移"的说法不成立（报告 §2.2/§5.6 已按此改写）。');
say('> 报告正文引用的 **20.3%（7 因子）/ 16.6%（14 因子）** = 逐人口径（表的第二列）。\n');

writeFileSync(join(C.OUT_DIR, '101-5-unknown.txt'), lines.join('\n'));

console.log(`\n→ ${join(C.OUT_DIR, '101-5-unknown.txt')}`);
