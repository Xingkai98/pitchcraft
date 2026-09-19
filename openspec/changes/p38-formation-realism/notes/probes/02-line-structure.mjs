// P38 问题 1：**线间距结构**——真实的 10 名非门将按纵向排序后，相邻次序的间距分布
// 是均匀的，还是有清晰的「线」结构？各线间距随球的位置如何变化？
//
// 三个互补视角（单一视角各带一种偏差，缺一不可）：
//
//  A. **次序位置**（与引擎可比的口径）：每帧把非门将按「离本方门线距离」排序，
//     取 10 个**分位位置** p=(i−1)/9（n=10 时逐位等于 probe2 的次序统计量，
//     n≠10 时仍稳健——见 corpus.mjs ORDER_QUANTILE_P 注释），再对帧取均值。
//     相邻次序间距 = 一阶差分。
//
//  B. **最大间隙切分检验**（结构证据）：对每帧找相邻次序间距里最大的那一个。
//     若呈"后卫线—中场线—锋线"三段式，最大间隙应**系统性**落在两条线之间；
//     若队形连续绵延，落点应近似均匀（下标 1..9 上等可能）。
//
//  C. **真实位置标签**（SkillCorner 独有，判据最强）：用 match.json 的
//     player_role.position_group 分成 后防（中卫+边卫）/ 中场 / 锋线（边锋+中锋），
//     直接量三条线各自位置与线间间距，并检验"按位置分组"与"按次序分组"是否一致。
//
// 运行：node openspec/changes/p38-formation-realism/notes/probes/02-line-structure.mjs
// 前置：00-fetch-subset.mjs + 01-convert-subset.mjs 已跑。

import {
  loadAllReal, SKILLCORNER_IDS, ownXs, ballDepthFor, mean, std, q, fmt, isRawBallFrame,
  orderGaps, orderPositions, bucketIndex, framePitchMeters,
} from './corpus.mjs';
import { loadAllSkillcornerRoles, linesOfFrame, labelledEntries, LINE_NAMES } from './roles.mjs';

const matches = loadAllReal();
const scMatches = matches.filter((m) => m.dataset === 'skillcorner');
const roles = loadAllSkillcornerRoles(SKILLCORNER_IDS);
const metrica = matches.filter((m) => m.dataset === 'metrica');

if (process.env.P38_SKILLCORNER_IDS) {
  console.error('⚠ 冒烟模式（P38_SKILLCORNER_IDS 已设）：样本被子集替代，数字不得进报告\n');
}
console.log(`样本：Metrica ${metrica.length} 场 + SkillCorner ${scMatches.length} 场（${SKILLCORNER_IDS.join(', ')}）`);
console.log('口径：非门将、跳过外推点、逐场球场尺寸；球相关量仅原始观测球帧（corpus.mjs）');
console.log('次序位置用分位口径 p=(i−1)/9（n=10 时逐位等于 probe2 的次序统计量）\n');

// ── A. 次序位置与相邻间距 ───────────────────────────────────────────────
function meanOrderPositions(subset) {
  const acc = Array.from({ length: 10 }, () => []);
  for (const m of subset) {
    for (const f of m.frames) {
      for (const team of ['home', 'away']) {
        const xs = ownXs(f, team);
        if (!xs) continue;
        const pos = orderPositions(xs);
        for (let i = 0; i < 10; i += 1) acc[i].push(pos[i]);
      }
    }
  }
  return acc.map(mean);
}

function meanOrderGaps(subset) {
  const acc = Array.from({ length: 9 }, () => []);
  for (const m of subset) {
    for (const f of m.frames) {
      for (const team of ['home', 'away']) {
        const xs = ownXs(f, team);
        if (!xs) continue;
        const g = orderGaps(xs);
        for (let i = 0; i < 9; i += 1) acc[i].push(g[i]);
      }
    }
  }
  return acc.map(mean);
}

console.log('=== A. 次序位置（米）与相邻间距 ===');
for (const [label, subset] of [['Metrica 2 场', metrica], ['SkillCorner 6 场', scMatches]]) {
  const P = meanOrderPositions(subset);
  console.log(`\n-- ${label} --`);
  console.log('次序   位置    相邻间距');
  for (let i = 0; i < 10; i += 1) {
    const g = i === 0 ? null : P[i] - P[i - 1];
    console.log(`${String(i + 1).padStart(4)}${P[i].toFixed(1).padStart(8)}${(g == null ? '—' : g.toFixed(2)).padStart(12)}`);
  }
}

console.log('\n=== A2. 相邻间距：逐场（SkillCorner）===');
const perMatchGaps = scMatches.map((m) => ({ id: m.id, gaps: meanOrderGaps([m]) }));
process.stdout.write('场次      ');
for (let i = 1; i < 10; i += 1) process.stdout.write(`${i}→${i + 1}`.padStart(8));
process.stdout.write('\n');
for (const pm of perMatchGaps) {
  process.stdout.write(`${pm.id}  `);
  for (const g of pm.gaps) process.stdout.write(g.toFixed(1).padStart(8));
  process.stdout.write('\n');
}
process.stdout.write('均值      ');
for (let i = 0; i < 9; i += 1) process.stdout.write(mean(perMatchGaps.map((p) => p.gaps[i])).toFixed(1).padStart(8));
process.stdout.write('\n');
process.stdout.write('标准差    ');
for (let i = 0; i < 9; i += 1) {
  const s = std(perMatchGaps.map((p) => p.gaps[i]));
  process.stdout.write((s == null ? '—' : s.toFixed(1)).padStart(8));
}
process.stdout.write('\n');

// ── B. 最大间隙落点直方图 ───────────────────────────────────────────────
console.log('\n=== B. 每帧「最大相邻间距」落在哪个次序对（1..9）===');
console.log('若队形连续绵延 → 落点近似均匀（各 11.1%）；若三段式线结构 → 落点集中在两线之间');
for (const [label, subset] of [['Metrica 2 场', metrica], ['SkillCorner 6 场', scMatches]]) {
  const hist = Array.from({ length: 10 }, () => 0);
  let nFrames = 0; const maxGapVals = [];
  for (const m of subset) {
    for (const f of m.frames) {
      for (const team of ['home', 'away']) {
        const xs = ownXs(f, team);
        if (!xs) continue;
        const g = orderGaps(xs);
        let best = -1; let bi = 1;
        for (let i = 1; i < 10; i += 1) if (g[i - 1] > best) { best = g[i - 1]; bi = i; }
        hist[bi] += 1; nFrames += 1; maxGapVals.push(best);
      }
    }
  }
  console.log(`\n-- ${label} --  n=${nFrames} 队帧；最大间距均值 ${fmt(mean(maxGapVals), 2)}m，中位 ${fmt(q([...maxGapVals].sort((a, b) => a - b), 0.5), 2)}m`);
  console.log('落点 i→i+1    次数    占比    均匀期望');
  for (let i = 1; i <= 9; i += 1) {
    console.log(`     ${String(i).padStart(2)}→${String(i + 1).padEnd(2)}  ${String(hist[i]).padStart(7)}  ${(100 * hist[i] / nFrames).toFixed(1).padStart(6)}% ${(100 / 9).toFixed(1).padStart(7)}%`);
  }
}

// ── C. 真实位置标签（SkillCorner）──────────────────────────────────────
console.log('\n=== C. 真实位置标签：线内位置与线间间距（SkillCorner 6 场）===');
console.log('分组：后防 = 中卫+边卫 / 中场 / 锋线 = 边锋+中锋（match.json player_role.position_group）');

const linePos = { defence: [], midfield: [], attack: [] };
const gapBM = []; const gapMA = [];
const lineUnknown = []; const lineCounts = [];
let labelledFrames = 0;
for (const m of scMatches) {
  const r = roles.get(m.id);
  for (const f of m.frames) {
    for (const team of ['home', 'away']) {
      const L = linesOfFrame(f, team, r.roleById);
      if (L.outfieldKnown < 7) continue;
      labelledFrames += 1;
      for (const ln of LINE_NAMES) if (L[ln].length) linePos[ln].push(mean(L[ln]));
      if (L.defence.length && L.midfield.length) gapBM.push(mean(L.midfield) - mean(L.defence));
      if (L.midfield.length && L.attack.length) gapMA.push(mean(L.attack) - mean(L.midfield));
      lineUnknown.push(L.unknown);
      lineCounts.push({ d: L.defence.length, m: L.midfield.length, a: L.attack.length });
    }
  }
}
console.log(`可用帧（两队合计，已知位置的非门将 ≥7）n=${labelledFrames}`);
console.log(`每帧每队人数均值：后防 ${fmt(mean(lineCounts.map((c) => c.d)), 2)}`
  + ` / 中场 ${fmt(mean(lineCounts.map((c) => c.m)), 2)}`
  + ` / 锋线 ${fmt(mean(lineCounts.map((c) => c.a)), 2)}`
  + ` / 位置未知 ${fmt(mean(lineUnknown), 2)}`);
for (const ln of LINE_NAMES) {
  const a = [...linePos[ln]].sort((x, y) => x - y);
  console.log(`  ${ln.padEnd(9)} 均值 ${fmt(mean(a), 1)}m  中位 ${fmt(q(a, 0.5), 1)}m  [p10 ${fmt(q(a, 0.1), 1)} – p90 ${fmt(q(a, 0.9), 1)}]  n=${a.length}`);
}
for (const [name, arr] of [['后防→中场', gapBM], ['中场→锋线', gapMA]]) {
  const a = [...arr].sort((x, y) => x - y);
  console.log(`  ${name} 间距  均值 ${fmt(mean(a), 2)}m  中位 ${fmt(q(a, 0.5), 2)}m  [p25 ${fmt(q(a, 0.25), 1)} – p75 ${fmt(q(a, 0.75), 1)}]  n=${a.length}`);
}

// C2：位置标签 ↔ 纵向次序排名的对应（线结构真实性的判据，n 稳健）
//
// 做法：每帧把该队**所有非门将**按 x 排序，给每人一个**归一化排名** r = rank/(n−1)
// ∈ [0,1]（0 = 本方最靠后，1 = 最靠前）。再按位置线分组，看各组 r 的分布。
//   - 若线结构真实且与"纵向排位"一致 → 后防的 r 集中在低段、锋线集中在高段、
//     中场居中，三组分布**相互分离**；
//   - 若队形只是连续绵延的一坨 → 三组的 r 分布会**大幅重叠**。
// 归一化排名对 n 稳健（跨帧可比），故不像"最深 4 人"那样被外推过滤削到只剩 17% 的帧。
console.log('\n=== C2. 位置线 ↔ 归一化纵向排名（0=本方最靠后，1=最靠前）===');
const rankByLine = { defence: [], midfield: [], attack: [] };
const blend = []; // 相邻两线的排名重叠度：后防最大排名 − 中场最小排名 等的平均
for (const m of scMatches) {
  const r = roles.get(m.id);
  for (const f of m.frames) {
    for (const team of ['home', 'away']) {
      const ent = labelledEntries(f, team, r.roleById);
      if (ent.length < 7) continue;
      const sorted = [...ent].sort((a, b) => a.x - b.x);
      const n = sorted.length;
      sorted.forEach((e, i) => { e.r = n === 1 ? 0.5 : i / (n - 1); });
      for (const e of ent) if (e.line) rankByLine[e.line].push(e.r);
      // 重叠：后防最大排名 vs 中场最小排名（重叠越负 = 分离越干净）
      const byLine = { defence: [], midfield: [], attack: [] };
      for (const e of ent) if (e.line) byLine[e.line].push(e.r);
      for (const [a, b] of [['defence', 'midfield'], ['midfield', 'attack']]) {
        if (byLine[a].length && byLine[b].length) {
          blend.push({ a, b, overlap: Math.max(...byLine[a]) - Math.min(...byLine[b]) });
        }
      }
    }
  }
}
for (const ln of LINE_NAMES) {
  const a = [...rankByLine[ln]].sort((x, y) => x - y);
  console.log(`  ${ln.padEnd(9)} 归一化排名 均值 ${fmt(mean(a), 2)}  中位 ${fmt(q(a, 0.5), 2)}`
    + `  [p10 ${fmt(q(a, 0.1), 2)} – p90 ${fmt(q(a, 0.9), 2)}]  n=${a.length}`);
}
for (const [a, b] of [['defence', 'midfield'], ['midfield', 'attack']]) {
  const ov = blend.filter((x) => x.a === a && x.b === b).map((x) => x.overlap);
  console.log(`  ${a}↔${b} 排名重叠量（>0 = 两线纵向交错，<0 = 分离）：均值 ${fmt(mean(ov), 3)}`
    + `  中位 ${fmt(q([...ov].sort((x, y) => x - y), 0.5), 3)}  n=${ov.length}`);
}

// ── D. 线间距随球位置的变化 ─────────────────────────────────────────────
// **两侧球队都进同一张表**：球位统一到「离该队本方门线」的米制深度（ballDepthFor），
// 于是"球在本方后场"对主客两队是同一件事——否则主队表里 x 小 = 自家后场，
// 客队却相反，两队得分桶含义相反（镜像口径在球上的对应物）。
console.log('\n=== D. 线间距随球位置的变化（两队合计；球位已统一到「离本方门线」深度）===');
const edges = [0, 0.14, 0.28, 0.42, 0.58, 0.72, 0.86, 1.0];
// Metrica 没有位置标签，只能给纵深一列（后→中/中→前/防线/锋线 留空）——
// 它的价值是"换一个数据源，弹性方向是否同号"的独立佐证。
for (const [label, subset] of [['SkillCorner 6 场', scMatches], ['Metrica 2 场（无位置标签，仅纵深）', metrica]]) {
  console.log(`\n-- ${label} --`);
  const acc = edges.slice(0, -1).map(() => ({ bm: [], ma: [], front: [], back: [], depth: [], ball: [] }));
  for (const m of subset) {
    const r = label.startsWith('SkillCorner') ? roles.get(m.id) : null;
    const [Lm] = m.frames[0] ? framePitchMeters(m.frames[0]) : [105, 68];
    for (const f of m.frames) {
      if (!f.ball || !isRawBallFrame(f)) continue;
      for (const team of ['home', 'away']) {
        // 桶按**该队自己的**球深度分（不是主队 x）——否则主客两队的桶含义相反，
        // 混池后"球在本方后场"这一条对两队不是同一件事（实测会把球位均值钉在 L/2）。
        const depth = ballDepthFor(f, team);
        if (depth == null) continue;
        const bi = bucketIndex(depth / Lm, edges);
        if (bi < 0) continue;
        const xs = ownXs(f, team);
        if (!xs) continue;
        acc[bi].ball.push(depth);
        acc[bi].depth.push(q(xs, 0.9) - q(xs, 0.1));
        if (r) {
          const Ln = linesOfFrame(f, team, r.roleById);
          if (Ln.defence.length && Ln.midfield.length) acc[bi].bm.push(mean(Ln.midfield) - mean(Ln.defence));
          if (Ln.midfield.length && Ln.attack.length) acc[bi].ma.push(mean(Ln.attack) - mean(Ln.midfield));
          if (Ln.attack.length) acc[bi].front.push(mean(Ln.attack));
          if (Ln.defence.length) acc[bi].back.push(mean(Ln.defence));
        }
      }
    }
  }
  console.log('球深度区间(m)    球位   纵深q10-90  后→中   中→前   防线   锋线      n');
  acc.forEach((a, i) => {
    const lbl = (() => { // 桶边界用名义 105m 标注（分桶本身是归一化 x，与场地无关）
      const lo = (edges[i] * 105).toFixed(0); const hi = (edges[i + 1] * 105).toFixed(0);
      return `  [${lo}–${hi})`;
    })();
    if (a.depth.length < 30) { console.log(lbl.padEnd(17) + '  样本不足'); return; }
    console.log(lbl.padEnd(17)
      + `${fmt(mean(a.ball), 1).padStart(6)}${fmt(mean(a.depth), 1).padStart(11)}`
      + `${fmt(mean(a.bm), 1).padStart(8)}${fmt(mean(a.ma), 1).padStart(8)}`
      + `${fmt(mean(a.back), 1).padStart(7)}${fmt(mean(a.front), 1).padStart(7)}`
      + `${String(a.depth.length).padStart(8)}`);
  });
}
