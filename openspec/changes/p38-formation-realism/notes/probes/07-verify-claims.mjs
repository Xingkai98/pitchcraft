// P38：**独立复核**——把报告里"结论速查"的每条数字，用**另行组织的代码**重算一遍，
// 与报告值逐条比对。目的不是再算一遍（那只是重复），而是抓**转录错误**：
// 报告里的数字是从多个探针输出里手抄的，抄错一位在报告里看不出来。
//
// 设计原则：本文件**不复用** 02–06 的聚合函数，只复用 corpus 的底层口径
// （ownXs / ballDepthFor / bucketIndex / teamYs 等），聚合逻辑在本地重写。
// 若两套独立实现给出同一个数，则该数是稳的；不一致就是某处有错。
//
// 运行：node openspec/changes/p38-formation-realism/notes/probes/07-verify-claims.mjs
// 退出码：有任一条不符 → 1（可当门用）。

import {
  loadAllReal, SKILLCORNER_IDS, ownXs, teamYs, mean, q, fmt, isRawBallFrame,
  bucketIndex, ballDepthFor, framePitchMeters, orderGaps,
} from './corpus.mjs';
import { loadAllSkillcornerRoles, labelledEntries, linesOfFrame } from './roles.mjs';

const matches = loadAllReal();
const scMatches = matches.filter((m) => m.dataset === 'skillcorner');
const metrica = matches.filter((m) => m.dataset === 'metrica');
const roles = loadAllSkillcornerRoles(SKILLCORNER_IDS);
const EDGES = [0, 0.14, 0.28, 0.42, 0.58, 0.72, 0.86, 1.0];

const fails = [];
const TOL = { m: 0.15, pct: 0.15, m2: 0.05 };
function check(label, got, want, tol) {
  const ok = (got == null || want == null) ? (got === want) : Math.abs(got - want) <= tol;
  if (!ok) fails.push({ label, got, want, tol });
  console.log(`${ok ? '✔' : '✘'} ${label.padEnd(52)} 报告 ${fmt(want, 2).padStart(7)}  复算 ${fmt(got, 2).padStart(7)}`);
}

// ── 通用遍历（本地重写，不复用探针的 collect）────────────────────────────
function forEachTeamFrame(subset, fn, { includeExtrapolated = false } = {}) {
  for (const m of subset) {
    const r = m.dataset === 'skillcorner' ? roles.get(m.id) : null;
    for (const f of m.frames) {
      const [L] = framePitchMeters(f);
      for (const team of ['home', 'away']) {
        fn({ m, f, team, L, roleById: r ? r.roleById : null });
      }
    }
  }
}

// ── 速查 #1：位置线均位置（SkillCorner）────────────────────────────────
// ⚠ 与 02 §C **同一条丢帧规则**：该帧该队已知位置的非门将 ≥7（`outfieldKnown`）。
// 漏掉这条会混入位置标签残缺的帧（复算曾得 43.0/48.9/58.3 而非 40.6/45.7/53.2）。
{
  const acc = { defence: [], midfield: [], attack: [] };
  forEachTeamFrame(scMatches, ({ f, team, roleById }) => {
    const L = linesOfFrame(f, team, roleById);
    if (L.outfieldKnown < 7) return;
    for (const ln of ['defence', 'midfield', 'attack']) if (L[ln].length) acc[ln].push(mean(L[ln]));
  });
  check('速查#1 后防均位置 m', mean(acc.defence), 40.6, TOL.m);
  check('速查#1 中场均位置 m', mean(acc.midfield), 45.7, TOL.m);
  check('速查#1 锋线均位置 m', mean(acc.attack), 53.2, TOL.m);
}

// ── 速查 #2：最大间隙落点 9→10 占比（两数据集合计）────────────────────
// ⚠ 与 02 §B 同一条取帧规则：**球位为该队纵深桶所需**（这里等价于"有原始球帧"）。
// 02 §B 其实**不**以球为条件（它只看队形）——故本复核也只看队形，n 与 02 一致。
{
  let n = 0; let hit = 0;
  forEachTeamFrame(matches, ({ f, team }) => {
    const xs = ownXs(f, team);
    if (!xs) return;
    const g = orderGaps(xs);
    let bi = 1; let best = -1;
    for (let i = 0; i < 9; i += 1) if (g[i] > best) { best = g[i]; bi = i + 1; }
    n += 1; if (bi === 9) hit += 1;
  });
  check('速查#2 队帧数 n', n, 253357, 1);
  // 逐数据集分别对（报告 22.5% 是 SkillCorner 6 场值，n=138889）
  const scHit = (() => {
    let n2 = 0; let h2 = 0;
    forEachTeamFrame(scMatches, ({ f, team }) => {
      const xs = ownXs(f, team); if (!xs) return;
      const g = orderGaps(xs); let bi = 1; let best = -1;
      for (let i = 0; i < 9; i += 1) if (g[i] > best) { best = g[i]; bi = i + 1; }
      n2 += 1; if (bi === 9) h2 += 1;
    });
    return { pct: 100 * h2 / n2, n: n2 };
  })();
  check('速查#2 SkillCorner 落 9→10 %', scHit.pct, 22.5, TOL.pct);
  check('速查#2 SkillCorner 队帧 n', scHit.n, 138889, 1);
}

// ── 速查 #3：半场口径 Δ 纵深 ───────────────────────────────────────────
function halfDelta(subset) {
  const own = []; const opp = [];
  forEachTeamFrame(subset, ({ f, team, L }) => {
    if (!f.ball || !isRawBallFrame(f)) return;
    const xs = ownXs(f, team);
    if (!xs) return;
    const d = q(xs, 0.9) - q(xs, 0.1);
    (ballDepthFor(f, team) < L / 2 ? own : opp).push(d);
  });
  return { d: mean(opp) - mean(own), n: own.length + opp.length };
}
{
  const s = halfDelta(scMatches); const m = halfDelta(metrica);
  check('速查#3 Δ纵深 SkillCorner m', s.d, 1.3, TOL.m);
  check('速查#3 Δ纵深 Metrica m', m.d, 1.8, TOL.m);
}

// ── 速查 #4：球在本方最深桶时最前 1 人（SkillCorner 全点口径）──────────
{
  const acc = [];
  forEachTeamFrame(scMatches, ({ f, team, L }) => {
    if (!f.ball || !isRawBallFrame(f)) return;
    const d = ballDepthFor(f, team);
    if (bucketIndex(d / L, EDGES) !== 0) return;
    const xs = ownXs(f, team, { includeExtrapolated: true });
    if (!xs) return;
    acc.push(xs[xs.length - 1]);
  });
  check('速查#4 锋线@本方最深桶(全点) m', mean(acc), 39.4, TOL.m);
}

// ── 速查 #5：控球代理下的 Δ 纵深 ───────────────────────────────────────
{
  const { pathToFileURL } = await import('node:url');
  const { join } = await import('node:path');
  const { P38_REPO } = await import('./repo-root.mjs');
  const { possessionProxy } = await import(pathToFileURL(join(P38_REPO, 'viewer', 'match-metrics.js')).href);
  const A = []; const B = [];
  forEachTeamFrame(scMatches, ({ f, team, L }) => {
    if (!f.ball || !isRawBallFrame(f)) return;
    const xs = ownXs(f, team);
    if (!xs) return;
    const p = possessionProxy(f);
    if (!p) return;
    (p === team ? A : B).push(q(xs, 0.9) - q(xs, 0.1));
  });
  check('速查#5 控球纵深 m', mean(A), 18.5, TOL.m);
  check('速查#5 失球纵深 m', mean(B), 16.3, TOL.m);
  check('速查#5 Δ(失−控) m', mean(B) - mean(A), -2.1, TOL.m);
}

// ── 速查 #6：宽度倒 U（逐数据集，不混池）──────────────────────────────
{
  const widthAt = (subset) => {
    const bt = [[], [], []];
    forEachTeamFrame(subset, ({ f, team, L }) => {
      if (!f.ball || !isRawBallFrame(f)) return;
      const ys = teamYs(f, team);
      if (!ys) return;
      const bi = bucketIndex(ballDepthFor(f, team) / L, EDGES);
      const slot = [0, 3, 6].indexOf(bi);
      if (slot < 0) return;
      const s = [...ys].sort((a, b) => a - b);
      bt[slot].push(q(s, 0.9) - q(s, 0.1));
    });
    return bt.map(mean);
  };
  const M = widthAt(metrica); const S = widthAt(scMatches);
  check('速查#6 Metrica 宽度@本方最深 m', M[0], 28.2, TOL.m);
  check('速查#6 Metrica 宽度@中场 m', M[1], 34.3, TOL.m);
  check('速查#6 Metrica 宽度@对方最深 m', M[2], 28.5, TOL.m);
  check('速查#6 SkillCorner 宽度@本方最深 m', S[0], 21.2, TOL.m);
  check('速查#6 SkillCorner 宽度@中场 m', S[1], 29.0, TOL.m);
  check('速查#6 SkillCorner 宽度@对方最深 m', S[2], 25.2, TOL.m);
}

// ── 速查 #7：横向通道结构（中路占比）──────────────────────────────────
{
  let mid = 0; let n = 0;
  forEachTeamFrame(matches, ({ f, team }) => {
    const ys = teamYs(f, team);
    if (!ys) return;
    const [, W] = framePitchMeters(f);
    for (const y of ys) { n += 1; const c = Math.floor((y / W) * 5); if (c === 2) mid += 1; }
  });
  check('速查#7 中路通道占比 %', 100 * mid / n, 33.8, TOL.pct);
  check('速查#7 人次 n', n, 2296728, 1);
}

// ── 速查 #8：球的横向位置 → 球队重心 y（SkillCorner）──────────────────
{
  const bt = [[], [], []];
  forEachTeamFrame(scMatches, ({ f, team }) => {
    if (!f.ball || !isRawBallFrame(f)) return;
    const ys = teamYs(f, team);
    if (!ys) return;
    bt[f.ball[1] < 1 / 3 ? 0 : (f.ball[1] > 2 / 3 ? 2 : 1)].push(mean(ys));
  });
  check('速查#8 球左时重心 y m', mean(bt[0]), 23.9, TOL.m);
  check('速查#8 球右时重心 y m', mean(bt[2]), 44.2, TOL.m);
}

// ── 速查 #10：逐场 Δ纵深 的符号一致性 ─────────────────────────────────
{
  const vals = scMatches.map((m) => halfDelta([m]).d);
  check('速查#10 逐场 Δ 全为正', vals.every((v) => v > 0) ? 1 : 0, 1, 0);
  check('速查#10 Δ 均值 m', mean(vals), 1.31, TOL.m);
  // ⚠ 必须先把均值算出来再平方差。写成 `(v - mean(v))` 是**静默错**：`mean` 对非数组
  // 输入返回 `null`（数字没有 `.length`），于是 `v - null` = `v`，整式退化成 `Σv²/(n−1)`
  // 的平方根（复算曾因此得 1.66 而非 0.82），且**不报错**。这类"看起来对"的式子正是
  // 本报告 §10 要防的。用 corpus 的 std（同一实现的权威版）。
  const mu = mean(vals);
  const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mu) ** 2, 0) / (vals.length - 1));
  check('速查#10 Δ 标准差 m', sd, 0.82, TOL.m);
}

console.log('');
if (fails.length) {
  console.error(`✘ ${fails.length} 条与报告不符：`);
  for (const f of fails) console.error(`   ${f.label}：报告 ${fmt(f.want, 2)}，复算 ${fmt(f.got, 2)}（容差 ${f.tol}）`);
  process.exitCode = 1;
} else {
  console.log('✔ 全部速查条目与报告一致');
}
