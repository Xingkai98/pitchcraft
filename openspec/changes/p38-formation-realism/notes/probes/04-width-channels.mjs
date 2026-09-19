// P38 问题 6：**横向（y）方向**——宽度随球位置的变化；球员横向分布是否有「通道」结构。
//
// 口径（与 match-metrics 一致 + 必要的坐标统一）：
//   - y 用**该场自己的**球场宽度换算（P37 D4，SkillCorner 有 104/105/106 的**长**，
//     但**宽**恒 68——实测 20 场全部 pitch_width=68）。宽度量与球位置无关的方向上
//     不需要镜像（y 轴主客共用）。
//   - 统计量用**两侧**：max−min（match-metrics.width 的口径，历史保留）与 q10–q90。
//     两者并列——max−min 对单个越界/外推点敏感，q10–q90 稳健。**主引用 q10–q90**，
//     max−min 仅作与既有基线的对接。
//   - 球深度用 team-relative（ballDepthFor），两队可比。
//
// 「通道」结构检验：把球员的 y 分成 5 条纵向通道（左翼/左半空间/中路/右半空间/右翼，
// 各 1/5 宽），看落点分布是否均匀。均匀 → 无通道结构；集中在中路 → 有中路结构。
// 同时看**通道占用随球位置的变化**（球在边路时是否更多人去那侧）。
//
// 运行：node openspec/changes/p38-formation-realism/notes/probes/04-width-channels.mjs

import {
  loadAllReal, SKILLCORNER_IDS, teamYs, teamXY, mean, std, q, fmt, isRawBallFrame,
  bucketIndex, ballDepthFor, framePitchMeters,
} from './corpus.mjs';
import { loadAllSkillcornerRoles, labelledEntries, LINE_NAMES } from './roles.mjs';

const matches = loadAllReal();
const scMatches = matches.filter((m) => m.dataset === 'skillcorner');
const metrica = matches.filter((m) => m.dataset === 'metrica');
const roles = loadAllSkillcornerRoles(SKILLCORNER_IDS);

if (process.env.P38_SKILLCORNER_IDS) console.error('⚠ 冒烟模式：数字不得进报告\n');
console.log(`样本：Metrica ${metrica.length} 场 + SkillCorner ${scMatches.length} 场\n`);

// 先确认球场宽度是否真的恒定（若某场不是 68，下面按 105 的标签就会错）
{
  const widths = new Set();
  for (const m of matches) for (const f of m.frames.slice(0, 1)) widths.add(framePitchMeters(f)[1]);
  console.log(`所有场的球场**宽度**（米）：${[...widths].join(', ')}`
    + `${widths.size === 1 ? '（恒定，故 y 分量无需逐场标签）' : ' ⚠ 不恒定——下方标签须逐场换算'}\n`);
}

const EDGES = [0, 0.14, 0.28, 0.42, 0.58, 0.72, 0.86, 1.0];
const NB = EDGES.length - 1;
const lbl = (i) => `[${(EDGES[i] * 105).toFixed(0)}–${(EDGES[i + 1] * 105).toFixed(0)})`;

// ── Q6a. 宽度随球深度 ───────────────────────────────────────────────────
function widthRows(subset, { includeExtrapolated }) {
  const rows = [];
  for (const m of subset) {
    for (const f of m.frames) {
      if (!f.ball || !isRawBallFrame(f)) continue;
      const [L] = framePitchMeters(f);
      for (const team of ['home', 'away']) {
        const depth = ballDepthFor(f, team);
        if (depth == null) continue;
        const bi = bucketIndex(depth / L, EDGES);
        if (bi < 0) continue;
        const ys = teamYs(f, team, { includeExtrapolated });
        if (!ys) continue;
        const s = [...ys].sort((a, b) => a - b);
        rows.push({
          m: m.id, dataset: m.dataset, team, bi, ballDepth: depth,
          widthMM: s[s.length - 1] - s[0],
          widthQ: q(s, 0.9) - q(s, 0.1),
          cy: mean(ys),
        });
      }
    }
  }
  return rows;
}

const rowsP = widthRows(matches, { includeExtrapolated: false });
const rowsA = widthRows(matches, { includeExtrapolated: true });

console.log('=== Q6a. 宽度随球深度（主口径跳过外推；主引用 q10–q90）===');
for (const [label, subset] of [['Metrica 2 场', metrica], ['SkillCorner 6 场', scMatches]]) {
  const rows = rowsP.filter((r) => (label.startsWith('Metrica') ? r.dataset === 'metrica' : r.dataset === 'skillcorner'));
  const rowsAll = rowsA.filter((r) => (label.startsWith('Metrica') ? r.dataset === 'metrica' : r.dataset === 'skillcorner'));
  console.log(`\n-- ${label} --`);
  console.log('球深度区间   宽q10-90   n      宽max-min   n      重心y   n');
  for (let i = 0; i < NB; i += 1) {
    const a = rows.filter((r) => r.bi === i);
    const b = rowsAll.filter((r) => r.bi === i);
    if (a.length < 30) { console.log(`${lbl(i).padEnd(11)}  样本不足`); continue; }
    console.log(`${lbl(i).padEnd(11)}${fmt(mean(a.map((r) => r.widthQ)), 1).padStart(9)}${String(a.length).padStart(7)}`
      + `${fmt(mean(a.map((r) => r.widthMM)), 1).padStart(11)}${String(b.length).padStart(7)}`
      + `${fmt(mean(a.map((r) => r.cy)), 1).padStart(9)}${String(a.length).padStart(7)}`);
  }
  for (const [cal, rr] of [['主口径', rows], ['全点口径', rowsAll]]) {
    const w = rr.map((r) => r.widthQ);
    console.log(`  ${cal}：宽度 q10–q90 全区间均值 ${fmt(mean(w), 1)}m`
      + ` [p25 ${fmt(q([...w].sort((x, y) => x - y), 0.25), 1)} – p75 ${fmt(q([...w].sort((x, y) => x - y), 0.75), 1)}] n=${w.length}`);
  }
}

// ── Q6b. 横向通道结构 ───────────────────────────────────────────────────
// 5 条纵向通道，各 1/5 宽（0 = 下边线/左翼 … 4 = 上边线/右翼）。
// 按**位置线**分别看落点：若是"后卫线要覆盖宽度、中场聚中路"，则通道分布逐线不同。
console.log('\n\n=== Q6b. 横向通道结构（y 分 5 通道，各 13.6m）===');
console.log('通道：0 = 左翼 | 1 = 左半空间 | 2 = 中路 | 3 = 右半空间 | 4 = 右翼');
const chanOf = (y, W) => Math.min(4, Math.max(0, Math.floor((y / W) * 5)));

{
  // 全体非门将（次序口径，两侧都有）
  const hist = Array.from({ length: 5 }, () => 0);
  let n = 0;
  for (const m of matches) {
    for (const f of m.frames) {
      for (const team of ['home', 'away']) {
        const ys = teamYs(f, team);
        if (!ys) continue;
        const [L, W] = framePitchMeters(f);
        for (const y of ys) { hist[chanOf(y, W)] += 1; n += 1; }
      }
    }
  }
  console.log(`\n全体非门将（主口径）n=${n} 人次；均匀期望各 20.0%`);
  for (let i = 0; i < 5; i += 1) {
    console.log(`  通道 ${i}   ${String(hist[i]).padStart(8)}  ${(100 * hist[i] / n).toFixed(1).padStart(5)}%`);
  }
}

// 按位置线 × 通道（SkillCorner）
console.log('\n按位置线的通道分布（SkillCorner，主口径）：');
{
  const perLine = { defence: Array(5).fill(0), midfield: Array(5).fill(0), attack: Array(5).fill(0) };
  const tot = { defence: 0, midfield: 0, attack: 0 };
  for (const m of scMatches) {
    const r = roles.get(m.id);
    for (const f of m.frames) {
      const [L, W] = framePitchMeters(f);
      for (const team of ['home', 'away']) {
        for (const e of labelledEntries(f, team, r.roleById)) {
          if (!e.line) continue;
          perLine[e.line][chanOf(e.y, W)] += 1;
          tot[e.line] += 1;
        }
      }
    }
  }
  console.log('线         通道0    通道1    通道2    通道3    通道4     n');
  for (const ln of LINE_NAMES) {
    const cells = perLine[ln].map((c) => `${(100 * c / tot[ln]).toFixed(1)}%`.padStart(8));
    console.log(`${ln.padEnd(10)}${cells.join('')}${String(tot[ln]).padStart(8)}`);
  }
}

// 通道占用随球位置：球的 y 分 3 档（左/中/右），看球队重心 y 的位移
console.log('\n\n=== Q6c. 球的横向位置 → 球队横向重心（谁跟着球横移）===');
console.log('球 y 分 3 档：左 (<1/3)、中、右 (>2/3)。看**球队重心 cy** 与**宽度**的变化。');
{
  for (const [label, subset] of [['SkillCorner 6 场', scMatches], ['Metrica 2 场', metrica]]) {
    const acc = [[], [], []];
    const wacc = [[], [], []];
    for (const m of subset) {
      for (const f of m.frames) {
        if (!f.ball || !isRawBallFrame(f)) continue;
        const [L, W] = framePitchMeters(f);
        const band = f.ball[1] < 1 / 3 ? 0 : (f.ball[1] > 2 / 3 ? 2 : 1);
        for (const team of ['home', 'away']) {
          const ys = teamYs(f, team);
          if (!ys) continue;
          const s = [...ys].sort((a, b) => a - b);
          acc[band].push(mean(ys));
          wacc[band].push(q(s, 0.9) - q(s, 0.1));
        }
      }
    }
    console.log(`\n-- ${label} --`);
    console.log('球横向档   球队重心y   距离中轴   宽度    n');
    for (let b = 0; b < 3; b += 1) {
      if (acc[b].length < 30) { console.log(`  ${['左', '中', '右'][b]}  样本不足`); continue; }
      const W = label.startsWith('SkillCorner') ? 68 : 68;
      console.log(`  ${['左', '中', '右'][b]}${fmt(mean(acc[b]), 1).padStart(13)}`
        + `${fmt(mean(acc[b]) - W / 2, 2).padStart(11)}${fmt(mean(wacc[b]), 1).padStart(8)}${String(acc[b].length).padStart(7)}`);
    }
  }
}
