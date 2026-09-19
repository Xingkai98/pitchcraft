// P38 问题 5 + 7：
//   Q5 控球权的影响——本方持球 vs 对方持球时，同样球位置下队形有何不同？
//   Q7 场次间差异——上述规律在不同场次间稳定吗？
//
// ⚠ **控球是代理**（复用 match-metrics.possessionProxy：离球最近者所属队，含门将参与判定）。
//   它不等于真实持球权：传球在途、二点球、以及"离球最近的是被过掉的人"都会误判。
//   本报告所有涉及"控球"的结论都必须带这个标签。SkillCorner 源数据自带 possession 字段，
//   但转换器**未透传**（统一帧无此字段）——用代理是为了两侧同口径；真实持球权对照
//   留作"未验证"项列在报告里。
//
// Q7 的做法：**逐场**重跑 Q2/Q3/Q4 的核心量，看符号与量级是否在 6 场间一致
//   （不是把 6 场混池后报一个总均值——混池会把场间差异藏进样本量里）。
//
// 运行：node openspec/changes/p38-formation-realism/notes/probes/05-possession-stability.mjs

import {
  loadAllReal, SKILLCORNER_IDS, ownXs, poss, teamYs, mean, std, q, fmt, isRawBallFrame,
  bucketIndex, ballDepthFor, framePitchMeters,
} from './corpus.mjs';
import { loadAllSkillcornerRoles, linesOfFrame, LINE_NAMES } from './roles.mjs';

const matches = loadAllReal();
const scMatches = matches.filter((m) => m.dataset === 'skillcorner');
const metrica = matches.filter((m) => m.dataset === 'metrica');
const roles = loadAllSkillcornerRoles(SKILLCORNER_IDS);

if (process.env.P38_SKILLCORNER_IDS) console.error('⚠ 冒烟模式：数字不得进报告\n');
console.log(`样本：Metrica ${metrica.length} 场 + SkillCorner ${scMatches.length} 场\n`);

const EDGES = [0, 0.14, 0.28, 0.42, 0.58, 0.72, 0.86, 1.0];
const NB = EDGES.length - 1;
const lbl = (i) => `[${(EDGES[i] * 105).toFixed(0)}–${(EDGES[i + 1] * 105).toFixed(0)})`;

// ── Q5. 控球代理的影响 ──────────────────────────────────────────────────
// 在**同一球位置桶**内，比较"我方控球（代理）"与"对方控球（代理）"的队形。
// 这是配对比较：球位置已条件住，剩下的差异归因于控球相位（若代理有效）。
console.log('=== Q5. 控球代理（离球最近者所属队）对队形的影响 ===');
console.log('⚠ 代理非真实持球权（传球在途/二点球不处理）\n');

for (const [label, subset] of [['SkillCorner 6 场', scMatches], ['Metrica 2 场', metrica]]) {
  console.log(`\n-- ${label} --`);
  const byBucket = EDGES.slice(0, -1).map(() => ({ own: [], opp: [], ownW: [], oppW: [] }));
  let posFrames = 0; let posHome = 0;
  for (const m of subset) {
    for (const f of m.frames) {
      if (!f.ball || !isRawBallFrame(f)) continue;
      const p = poss(f);
      if (!p) continue;
      posFrames += 1; if (p === 'home') posHome += 1;
      const [L] = framePitchMeters(f);
      for (const team of ['home', 'away']) {
        const depth = ballDepthFor(f, team);
        if (depth == null) continue;
        const bi = bucketIndex(depth / L, EDGES);
        if (bi < 0) continue;
        const xs = ownXs(f, team);
        if (!xs) continue;
        // 宽度复用 corpus.teamYs（与 probe04 同一份实现）——不在这里重写一份
        const ys = teamYs(f, team);
        const d = q(xs, 0.9) - q(xs, 0.1);
        const w = ys ? q([...ys].sort((a, b) => a - b), 0.9) - q([...ys].sort((a, b) => a - b), 0.1) : null;
        const mine = p === team; // 我方控球
        (mine ? byBucket[bi].own : byBucket[bi].opp).push(d);
        if (w != null) (mine ? byBucket[bi].ownW : byBucket[bi].oppW).push(w);
      }
    }
  }
  console.log(`控球代理帧：主队 ${posHome} / ${posFrames} = ${(100 * posHome / posFrames).toFixed(1)}%`);
  console.log('球深度区间   控球纵深   n      失球纵深   n      Δ(失−控)   控球宽度  失球宽度');
  for (let i = 0; i < NB; i += 1) {
    const o = byBucket[i].own; const p2 = byBucket[i].opp;
    if (o.length < 30 || p2.length < 30) { console.log(`${lbl(i).padEnd(11)}  样本不足`); continue; }
    console.log(`${lbl(i).padEnd(11)}${fmt(mean(o), 1).padStart(9)}${String(o.length).padStart(7)}`
      + `${fmt(mean(p2), 1).padStart(11)}${String(p2.length).padStart(7)}${fmt(mean(p2) - mean(o), 1).padStart(11)}`
      + `${fmt(mean(byBucket[i].ownW), 1).padStart(11)}${fmt(mean(byBucket[i].oppW), 1).padStart(11)}`);
  }
  // 全区间（控制球深度后的加权差）
  const O = byBucket.flatMap((b) => b.own); const P = byBucket.flatMap((b) => b.opp);
  console.log(`  全区间：控球纵深 ${fmt(mean(O), 1)}m（n=${O.length}）  失球纵深 ${fmt(mean(P), 1)}m（n=${P.length}）  Δ ${fmt(mean(P) - mean(O), 1)}m`);
}

// ── Q7. 场次间稳定性 ────────────────────────────────────────────────────
console.log('\n\n=== Q7. 场次间稳定性：核心量逐场 ===\n');
console.log('每格：该场该量的值。看**符号是否一致**（规律是否稳定）与量级离散度。\n');

function perMatchSummary(m, dataset) {
  const r = dataset === 'skillcorner' ? roles.get(m.id) : null;
  const ownD = []; const oppD = [];
  const frontOwn = []; const frontOpp = [];
  const bmOwn = []; const bmOpp = [];
  const maOwn = []; const maOpp = [];
  for (const f of m.frames) {
    if (!f.ball || !isRawBallFrame(f)) continue;
    const [L] = framePitchMeters(f);
    for (const team of ['home', 'away']) {
      const depth = ballDepthFor(f, team);
      if (depth == null) continue;
      const xs = ownXs(f, team);
      if (!xs) continue;
      const d = q(xs, 0.9) - q(xs, 0.1);
      const front = xs[xs.length - 1];
      const isOwn = depth < L / 2;
      (isOwn ? ownD : oppD).push(d);
      (isOwn ? frontOwn : frontOpp).push(front);
      if (r) {
        const Ln = linesOfFrame(f, team, r.roleById);
        const bm = (Ln.defence.length && Ln.midfield.length) ? mean(Ln.midfield) - mean(Ln.defence) : null;
        const ma = (Ln.midfield.length && Ln.attack.length) ? mean(Ln.attack) - mean(Ln.midfield) : null;
        if (bm != null) (isOwn ? bmOwn : bmOpp).push(bm);
        if (ma != null) (isOwn ? maOwn : maOpp).push(ma);
      }
    }
  }
  return {
    id: m.id, dataset,
    deltaDepth: mean(oppD) - mean(ownD), nA: ownD.length, nB: oppD.length,
    frontOwn: mean(frontOwn), frontOpp: mean(frontOpp),
    bmOwn: mean(bmOwn), bmOpp: mean(bmOpp),
    maOwn: mean(maOwn), maOpp: mean(maOpp),
  };
}

const all = matches.map((m) => perMatchSummary(m, m.dataset));
const hdr = ['场次', 'Δ纵深(对−本)', '锋线(本方球)', '锋线(对方球)', '后→中(本)', '后→中(对)', '中→前(本)', '中→前(对)', 'n'];
console.log(hdr.map((h, i) => h.padStart([14, 14, 13, 13, 11, 11, 11, 11, 9][i])).join(''));
for (const s of all) {
  console.log(`${s.dataset.slice(0, 4)}-${s.id}`.padStart(14)
    + `${fmt(s.deltaDepth, 1).padStart(14)}`
    + `${fmt(s.frontOwn, 1).padStart(13)}${fmt(s.frontOpp, 1).padStart(13)}`
    + `${fmt(s.bmOwn, 1).padStart(11)}${fmt(s.bmOpp, 1).padStart(11)}`
    + `${fmt(s.maOwn, 1).padStart(11)}${fmt(s.maOpp, 1).padStart(11)}`
    + `${String(s.nA).padStart(9)}`);
}
console.log('');
console.log('逐场离散度（仅 SkillCorner，6 场）：');
const sc = all.filter((s) => s.dataset === 'skillcorner');
for (const k of ['deltaDepth', 'frontOwn', 'frontOpp', 'bmOwn', 'bmOpp', 'maOwn', 'maOpp']) {
  const v = sc.map((s) => s[k]).filter((x) => x != null);
  console.log(`  ${k.padEnd(12)} 均值 ${fmt(mean(v), 2).padStart(6)}  标准差 ${fmt(std(v), 2).padStart(5)}`
    + `  全距 [${fmt(Math.min(...v), 2)} – ${fmt(Math.max(...v), 2)}]  符号一致=${v.every((x) => x > 0) || v.every((x) => x < 0) ? '是' : '否'}`);
}
