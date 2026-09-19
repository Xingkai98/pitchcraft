// P38 问题 2/3/4：
//   Q2 压缩的方向性——球在本方后场 vs 对方后场时，球队纵深分别是多少？
//   Q3 锋线回防——球深入本方后场时，最前面的球员回撤到什么位置？回撤幅度与球位置的关系。
//   Q4 两线之间的间距（防线↔中场、中场↔锋线）随球位置如何变化？
//
// ⚠ **口径敏感性（本探针的核心交代）**：SkillCorner 主口径跳过外推点（P37 D2），
//   使每帧有效人数浮动（实测 6–10，中位 ~8.4）。q10–q90 在**子样本**上是方差更大、
//   且**系统性偏小**的估计量（抽不到两端的人）；更关键的是，**未被检测到的点与球位置相关**
//   （球在一端禁区时，另一端的高位球员常在转播画面外 → 被标外推）。于是主口径会
//   **按球位置系统性地截断纵深**，把"球位置→纵深"的形状整体扭曲。
//   实测：SkillCorner 主口径呈倒 U（12.0→20.1→14.5），全点口径呈单调上升（23.7→30.3），
//   而 Metrica（恒 10 人真观测）呈 U/上升混合。**两个口径给出的形状不同号**。
//   故本探针三个问题都**并列两个口径**，并在报告里按「可比性」分别引用：
//     - primary（跳过外推）= P37 基线的口径，用于与既有基线数字对接；
//     - allPoints（采信外推）= 「恒 10 人」口径，与 Metrica/引擎在"几点定义跨度"上同构，
//       用于跨数据集比较形状。
//   两者都不是"错的"，但它们回答的不是同一个问题。任何用 SkillCorner 主口径做的
//   球位置条件结论，都必须先看全点口径是否同号。
//
// 运行：node openspec/changes/p38-formation-realism/notes/probes/03-compression-lines.mjs

import {
  loadAllReal, SKILLCORNER_IDS, ownXs, mean, std, q, fmt, isRawBallFrame,
  bucketIndex, ballDepthFor, framePitchMeters,
} from './corpus.mjs';
import { loadAllSkillcornerRoles, linesOfFrame, LINE_NAMES } from './roles.mjs';

const matches = loadAllReal();
const scMatches = matches.filter((m) => m.dataset === 'skillcorner');
const metrica = matches.filter((m) => m.dataset === 'metrica');
const roles = loadAllSkillcornerRoles(SKILLCORNER_IDS);

if (process.env.P38_SKILLCORNER_IDS) console.error('⚠ 冒烟模式：样本被子集替代，数字不得进报告\n');
console.log(`样本：Metrica ${metrica.length} 场 + SkillCorner ${scMatches.length} 场（${SKILLCORNER_IDS.join(', ')}）`);
console.log('球位置统一为「离该队本方门线的深度」（两队可比：球深度小 = 该队在本方后场）\n');

const EDGES = [0, 0.14, 0.28, 0.42, 0.58, 0.72, 0.86, 1.0];
const NB = EDGES.length - 1;
const lbl = (i) => `[${(EDGES[i] * 105).toFixed(0)}–${(EDGES[i + 1] * 105).toFixed(0)})`;

// 每帧每队一行记录（一次遍历，三个问题共用——避免各问各遍历、口径漂移）
function collect(matchesSubset, { includeExtrapolated }) {
  const rows = [];
  for (const m of matchesSubset) {
    const r = m.dataset === 'skillcorner' ? roles.get(m.id) : null;
    for (const f of m.frames) {
      if (!f.ball || !isRawBallFrame(f)) continue;
      const [L] = framePitchMeters(f);
      for (const team of ['home', 'away']) {
        const depth = ballDepthFor(f, team);
        if (depth == null) continue;
        const bi = bucketIndex(depth / L, EDGES);
        if (bi < 0) continue;
        const xs = ownXs(f, team, { includeExtrapolated });
        if (!xs) continue;
        const rec = {
          m: m.id, dataset: m.dataset, team, bi, ballDepth: depth,
          n: xs.length,
          depth: q(xs, 0.9) - q(xs, 0.1),
          back4: mean(xs.slice(0, 4)),          // 最深 4 人（probe2 口径，n=10 时精确）
          front2: mean(xs.slice(-2)),           // 最前 2 人
          frontmost: xs[xs.length - 1],         // 最前面的那个人
          lineDef: null, lineMid: null, lineAtt: null,
        };
        if (r) {
          const Ln = linesOfFrame(f, team, r.roleById, { includeExtrapolated });
          if (Ln.defence.length) rec.lineDef = mean(Ln.defence);
          if (Ln.midfield.length) rec.lineMid = mean(Ln.midfield);
          if (Ln.attack.length) rec.lineAtt = mean(Ln.attack);
        }
        rows.push(rec);
      }
    }
  }
  return rows;
}

const rowsP = collect(matches, { includeExtrapolated: false });
const rowsA = collect(matches, { includeExtrapolated: true });

// ── Q2. 压缩的方向性 ────────────────────────────────────────────────────
console.log('=== Q2. 压缩的方向性：球在本方后场 vs 对方后场时的球队纵深 ===\n');
console.log('(a) 半场口径（与 match-metrics.elasticity divider=half 同口径）');
console.log('数据集/场次      本方半场纵深  n       对方半场纵深  n      Δ(对−本)');
for (const [label, subset] of [['Metrica', metrica], ['SkillCorner', scMatches]]) {
  for (const m of subset) {
    const rows = rowsP.filter((r) => r.m === m.id);
    const own = rows.filter((r) => r.ballDepth < 52.5).map((r) => r.depth);
    const opp = rows.filter((r) => r.ballDepth >= 52.5).map((r) => r.depth);
    console.log(`${label.padEnd(12)} ${m.id}  ${fmt(mean(own), 1).padStart(11)} ${String(own.length).padStart(7)}`
      + `${fmt(mean(opp), 1).padStart(14)} ${String(opp.length).padStart(7)}${fmt(mean(opp) - mean(own), 1).padStart(10)}`);
  }
  const rows = label === 'Metrica' ? rowsP.filter((r) => r.dataset === 'metrica') : rowsP.filter((r) => r.dataset === 'skillcorner');
  const own = rows.filter((r) => r.ballDepth < 52.5).map((r) => r.depth);
  const opp = rows.filter((r) => r.ballDepth >= 52.5).map((r) => r.depth);
  console.log(`${label.padEnd(12)} 合计  ${fmt(mean(own), 1).padStart(11)} ${String(own.length).padStart(7)}`
    + `${fmt(mean(opp), 1).padStart(14)} ${String(opp.length).padStart(7)}${fmt(mean(opp) - mean(own), 1).padStart(10)}`);
}

console.log('\n(b) 分桶口径：纵深随球深度（米）——**两个口径并列**');
for (const [label, subset] of [['Metrica 2 场', metrica], ['SkillCorner 6 场', scMatches]]) {
  console.log(`\n-- ${label} --`);
  const rp = rowsP.filter((r) => (label.startsWith('Metrica') ? r.dataset === 'metrica' : r.dataset === 'skillcorner'));
  const ra = rowsA.filter((r) => (label.startsWith('Metrica') ? r.dataset === 'metrica' : r.dataset === 'skillcorner'));
  console.log('球深度区间   primary(跳过外推)  n      allPoints(采信外推)  n     平均有效人数');
  for (let i = 0; i < NB; i += 1) {
    const a = rp.filter((r) => r.bi === i).map((r) => r.depth);
    const b = ra.filter((r) => r.bi === i).map((r) => r.depth);
    const nAvg = mean(ra.filter((r) => r.bi === i).map((r) => r.n));
    if (a.length < 30 && b.length < 30) { console.log(`${lbl(i).padEnd(11)}  样本不足`); continue; }
    console.log(`${lbl(i).padEnd(11)}${fmt(mean(a), 1).padStart(15)}${String(a.length).padStart(8)}`
      + `${fmt(mean(b), 1).padStart(18)}${String(b.length).padStart(8)}${fmt(nAvg, 2).padStart(14)}`);
  }
  const da = rp.map((r) => r.depth);
  console.log(`全区间：primary 均值 ${fmt(mean(da), 1)}m [p25 ${fmt(q([...da].sort((x, y) => x - y), 0.25), 1)}`
    + ` – p75 ${fmt(q([...da].sort((x, y) => x - y), 0.75), 1)}] n=${da.length}`);
}

// ── Q3. 锋线回防 ────────────────────────────────────────────────────────
console.log('\n\n=== Q3. 锋线回防：球深入本方后场时，最前面的球员回撤到哪 ===\n');
console.log('(a) 次序口径：最前面 1 人 / 最前 2 人均值（米，离本方门线）随球深度');
for (const [label, subset] of [['SkillCorner 6 场', scMatches], ['Metrica 2 场', metrica]]) {
  const rows = rowsP.filter((r) => (label.startsWith('SkillCorner') ? r.dataset === 'skillcorner' : r.dataset === 'metrica'));
  console.log(`\n-- ${label} --`);
  console.log('球深度区间   最前1人   最前2人均   最深4人均   纵深      n');
  for (let i = 0; i < NB; i += 1) {
    const a = rows.filter((r) => r.bi === i);
    if (a.length < 30) { console.log(`${lbl(i).padEnd(11)}  样本不足`); continue; }
    console.log(`${lbl(i).padEnd(11)}${fmt(mean(a.map((r) => r.frontmost)), 1).padStart(9)}`
      + `${fmt(mean(a.map((r) => r.front2)), 1).padStart(11)}${fmt(mean(a.map((r) => r.back4)), 1).padStart(12)}`
      + `${fmt(mean(a.map((r) => r.depth)), 1).padStart(9)}${String(a.length).padStart(7)}`);
  }
  // 回撤幅度：球最深桶 vs 球最浅桶
  const deep = rows.filter((r) => r.bi === 0); const high = rows.filter((r) => r.bi === NB - 1);
  if (deep.length > 30 && high.length > 30) {
    console.log(`  回撤幅度（球在本方最深桶 [0–15) 相对球在对方最深桶 [90–105)）：`
      + ` 最前1人 ${fmt(mean(high.map((r) => r.frontmost)) - mean(deep.map((r) => r.frontmost)), 1)}m`
      + `，最前2人均 ${fmt(mean(high.map((r) => r.front2)) - mean(deep.map((r) => r.front2)), 1)}m`);
  }
}

console.log('\n(a2) **口径敏感性**：最前 1 人位置，主口径 vs 全点口径（SkillCorner）');
console.log('⚠ 主口径的「最前 1 人」在球深入本方后场时**系统性偏低**——因为最前的那名球员');
console.log('  正是转播画面外、被标外推的那个；跳过他就等于把锋线高度截断。');
{
  const rp = rowsP.filter((r) => r.dataset === 'skillcorner');
  const ra = rowsA.filter((r) => r.dataset === 'skillcorner');
  console.log('球深度区间   主口径最前1人   全点口径最前1人   差');
  for (let i = 0; i < NB; i += 1) {
    const a = rp.filter((r) => r.bi === i).map((r) => r.frontmost);
    const b = ra.filter((r) => r.bi === i).map((r) => r.frontmost);
    if (a.length < 30) { console.log(`${lbl(i).padEnd(11)}  样本不足`); continue; }
    console.log(`${lbl(i).padEnd(11)}${fmt(mean(a), 1).padStart(14)}${fmt(mean(b), 1).padStart(17)}${fmt(mean(b) - mean(a), 1).padStart(7)}`);
  }
  const d0 = rp.filter((r) => r.bi === 0).map((r) => r.frontmost);
  const d0a = ra.filter((r) => r.bi === 0).map((r) => r.frontmost);
  const d6 = rp.filter((r) => r.bi === NB - 1).map((r) => r.frontmost);
  const d6a = ra.filter((r) => r.bi === NB - 1).map((r) => r.frontmost);
  console.log(`  回撤幅度（[90–105) − [0–15)）：主口径 ${fmt(mean(d6) - mean(d0), 1)}m，`
    + `全点口径 ${fmt(mean(d6a) - mean(d0a), 1)}m`);
}

console.log('\n(b) 位置口径（仅 SkillCorner）：锋线（边锋+中锋）均位置随球深度');
{
  const rows = rowsP.filter((r) => r.dataset === 'skillcorner' && r.lineAtt != null);
  console.log('球深度区间    锋线位置   防线位置   中场位置     n');
  for (let i = 0; i < NB; i += 1) {
    const a = rows.filter((r) => r.bi === i);
    if (a.length < 30) { console.log(`${lbl(i).padEnd(11)}  样本不足`); continue; }
    console.log(`${lbl(i).padEnd(11)}${fmt(mean(a.map((r) => r.lineAtt)), 1).padStart(10)}`
      + `${fmt(mean(a.filter((r) => r.lineDef != null).map((r) => r.lineDef)), 1).padStart(11)}`
      + `${fmt(mean(a.filter((r) => r.lineMid != null).map((r) => r.lineMid)), 1).padStart(11)}`
      + `${String(a.length).padStart(7)}`);
  }
}

// ── Q4. 两线间距随球位置 ────────────────────────────────────────────────
console.log('\n\n=== Q4. 线间距（位置口径，仅 SkillCorner）随球深度 ===\n');
{
  const rows = rowsP.filter((r) => r.dataset === 'skillcorner');
  console.log('球深度区间   后防→中场   中场→锋线   防线→锋线    n');
  for (let i = 0; i < NB; i += 1) {
    const a = rows.filter((r) => r.bi === i);
    const bm = a.filter((r) => r.lineDef != null && r.lineMid != null).map((r) => r.lineMid - r.lineDef);
    const ma = a.filter((r) => r.lineMid != null && r.lineAtt != null).map((r) => r.lineAtt - r.lineMid);
    const da = a.filter((r) => r.lineDef != null && r.lineAtt != null).map((r) => r.lineAtt - r.lineDef);
    if (bm.length < 30) { console.log(`${lbl(i).padEnd(11)}  样本不足`); continue; }
    console.log(`${lbl(i).padEnd(11)}${fmt(mean(bm), 1).padStart(11)}${fmt(mean(ma), 1).padStart(12)}${fmt(mean(da), 1).padStart(12)}${String(bm.length).padStart(7)}`);
  }
  // **全点口径并列**（关键：主口径的线间距形状是否只是外推过滤的产物）
  console.log('\n-- 同一张表的**全点口径**（采信外推）——与上表对比形状是否同号 --');
  const rowsAllSc = rowsA.filter((r) => r.dataset === 'skillcorner');
  console.log('球深度区间   后防→中场   中场→锋线   防线→锋线    n');
  for (let i = 0; i < NB; i += 1) {
    const a = rowsAllSc.filter((r) => r.bi === i);
    const bm = a.filter((r) => r.lineDef != null && r.lineMid != null).map((r) => r.lineMid - r.lineDef);
    const ma = a.filter((r) => r.lineMid != null && r.lineAtt != null).map((r) => r.lineAtt - r.lineMid);
    const da = a.filter((r) => r.lineDef != null && r.lineAtt != null).map((r) => r.lineAtt - r.lineDef);
    if (bm.length < 30) { console.log(`${lbl(i).padEnd(11)}  样本不足`); continue; }
    console.log(`${lbl(i).padEnd(11)}${fmt(mean(bm), 1).padStart(11)}${fmt(mean(ma), 1).padStart(12)}${fmt(mean(da), 1).padStart(12)}${String(bm.length).padStart(7)}`);
  }

  // 逐场稳定性
  console.log('\n逐场（球在本方半场 vs 对方半场 的 后防→中场 间距）：');
  console.log('场次        本方半场   对方半场     Δ     中场→锋线(本)  中场→锋线(对)');
  for (const m of scMatches) {
    const rows2 = rowsP.filter((r) => r.m === m.id && r.lineDef != null && r.lineMid != null);
    const own = rows2.filter((r) => r.ballDepth < 52.5); const opp = rows2.filter((r) => r.ballDepth >= 52.5);
    const bmO = mean(own.map((r) => r.lineMid - r.lineDef)); const bmP = mean(opp.map((r) => r.lineMid - r.lineDef));
    const maO = mean(own.filter((r) => r.lineAtt != null).map((r) => r.lineAtt - r.lineMid));
    const maP = mean(opp.filter((r) => r.lineAtt != null).map((r) => r.lineAtt - r.lineMid));
    console.log(`${m.id} ${fmt(bmO, 2).padStart(10)}${fmt(bmP, 2).padStart(11)}${fmt(bmP - bmO, 2).padStart(8)}${fmt(maO, 2).padStart(14)}${fmt(maP, 2).padStart(15)}`);
  }
}
