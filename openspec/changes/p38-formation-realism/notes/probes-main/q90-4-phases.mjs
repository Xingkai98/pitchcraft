// P38 #90 探针 4：**攻防差异（个体层面）**（Q4）。
//
// 已知（`real-formation-laws.md` §5）：同一球位置下，控球时宽度比失球时大 2.8–5.3m。
// 本探针问的是**个体层面**：
//   4a 每条位置线（后防/中场/锋线）各自的横向展开差；
//   4b **同一名球员**（固定槽位）在两种相位下的 y 分布差——不是"哪些人在场上"的构成效应；
//   4c 相位对"横向分散度"的效应是否独立于球位（分球位档后仍在？）；
//   4d 边路球员 vs 中路球员的相位效应是否不同（谁在相位切换时横向移动更多）。
//
// 相位：SkillCorner 用源真值（`possession.group`）；Metrica 用最近球员代理（分列，不混池）。
//
// 运行：node openspec/changes/p38-formation-realism/notes/probes-main/q90-4-phases.mjs

import * as Q from './q90-common.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const P = Q.PITCH_WIDTH_M;
const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };

const ms = Q.loadReal();
const eng = await Q.loadEngineFrames({ seeds: [42] });
say('样本：Metrica 2 场（代理相位）+ SkillCorner 6 场（源真值相位）；引擎 1 种子对照。\n');

// ── 收集：逐帧逐人面板 ──────────────────────────────────────────────────
function panel(m) {
  const rows = []; // {team, id, line, y, ballY, ballX, phase, cy}
  for (let i = 0; i < m.frames.length; i += 1) {
    const f = m.frames[i];
    if (!f.ball) continue;
    if (m.phase && m.phase.ballDet[i] !== 1) continue;
    for (const team of ['home', 'away']) {
      const ps = Q.framePlayers(m, f, team, { idx: i, includeExtrapolated: true });
      if (ps.length < 7) continue;
      const ph = Q.phaseOf(m, f, team, i);
      if (ph == null) continue;
      const cy = Q.mean(ps.map((p) => p.y));
      const by = Q.ballYCanon(m, f, team, i);
      const bx = Q.ballXCanon(m, f, team, i);
      for (const p of ps) rows.push({ team, id: p.id, line: p.line, y: p.y, cy, ballY: by, ballX: bx, phase: ph });
    }
  }
  return rows;
}
const pan = new Map();
for (const m of [...ms, ...eng]) pan.set(`${m.dataset}|${m.id}`, { m, rows: panel(m) });

const sd = (a) => Math.sqrt(Q.variance(a));
const span = (a) => { const s = [...a].sort((x, y) => x - y); return Q.quantile(s, 0.9) - Q.quantile(s, 0.1); };

// ── Q4a. 球队层：同一球位档下控球/失球的宽度与重心 ──────────────────────
say('## Q4a. 同一球位下，控球 vs 失球的横向展开（球队层，复算并分线）\n');
say('球 y 分 5 档；每档内比较两相位的宽度（q10–q90，米）与重心离中轴距离。');
say('分线只看 SkillCorner（有真实位置标签）。\n');
{
  const EDGES = [0, 1 / 5, 2 / 5, 3 / 5, 4 / 5, 1];
  for (const [label, dsSel] of [['SkillCorner（源真值相位）', (d) => d === 'skillcorner'],
    ['Metrica（最近球员代理）', (d) => d === 'metrica']]) {
    const acc = EDGES.slice(0, -1).map(() => ({ own: [], opp: [] }));
    for (const [key, { m, rows }] of pan) {
      if (!dsSel(m.dataset)) continue;
      // 需要"当帧该队全队"的 width → 从 rows 按帧重组
      const byFrame = new Map();
      for (const r of rows) {
        const k = `${r.team}|${r.phase}|${r.ballY.toFixed(3)}|${r.ballX.toFixed(3)}`;
        if (!byFrame.has(k)) byFrame.set(k, []);
        byFrame.get(k).push(r);
      }
      for (const [k, rs] of byFrame) {
        const bi = Q.corpus.bucketIndex(rs[0].ballY / P, EDGES);
        if (bi < 0) continue;
        const a = acc[bi];
        (rs[0].phase === 1 ? a.own : a.opp).push(span(rs.map((r) => r.y)));
      }
    }
    say(`${label}`);
    say(Q.table(['球 y 档', 'n 控球', '宽度 控球', 'n 失球', '宽度 失球', 'Δ(控−失)'],
      acc.map((a, i) => [`[${(EDGES[i] * 68).toFixed(0)}–${(EDGES[i + 1] * 68).toFixed(0)})m`,
        a.own.length, Q.fmt(Q.mean(a.own), 2), a.opp.length, Q.fmt(Q.mean(a.opp), 2),
        Q.fmt(Q.mean(a.own) - Q.mean(a.opp), 2)]), [14, 9, 10, 9, 10, 10]));
    const ok = acc.filter((a) => a.own.length > 200 && a.opp.length > 200);
    say(`  逐档均值：控球 ${Q.fmt(Q.mean(ok.map((a) => Q.mean(a.own))), 2)}`
      + `　失球 ${Q.fmt(Q.mean(ok.map((a) => Q.mean(a.opp))), 2)}`
      + `　**Δ = ${Q.fmt(Q.mean(ok.map((a) => Q.mean(a.own) - Q.mean(a.opp))), 2)}m**`
      + `（正 = 控球更宽）\n`);
  }
}

// ── Q4b. 逐人：同一球员在两相位下的 y 均值差 ────────────────────────────
say('## Q4b. **同一名球员**在两相位下的横向位置差（个体层面，排除构成效应）\n');
say('对每个「人·场」序列算 E[y|控球] − E[y|失球]（米），再跨人取均值/分布。');
say('正值 = 控球时他更偏 y 大的一侧；**这个量本身不是重点，重点是它的离散**——');
say('若所有人在相位切换时同向平移，则该值应几乎相同（离散小）；若各人有各自的偏移方向，');
say('则离散大。**同时给打散对照**（把相位标签随机重排）作"无效应"基线。\n');
{
  const rnd = Q.lcg(90);
  const rows = [];
  for (const ds of ['metrica', 'skillcorner', 'engine']) {
    const deltas = []; const shifts = []; const within = [];
    for (const [key, { rows: rs }] of pan) {
      if (!key.startsWith(`${ds}|`)) continue;
      const per = new Map();
      for (const r of rs) {
        const k = `${r.team}|${r.id}`;
        if (!per.has(k)) per.set(k, { own: [], opp: [], phase: [] });
        const P2 = per.get(k);
        (r.phase === 1 ? P2.own : P2.opp).push(r.y);
        P2.phase.push(r.phase);
      }
      for (const s of per.values()) {
        if (s.own.length < 150 || s.opp.length < 150) continue;
        deltas.push(Q.mean(s.own) - Q.mean(s.opp));
        // 打散：相位标签随机重排后同样算
        const all = [...s.own, ...s.opp];
        const sh = [...s.phase];
        for (let i = sh.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; }
        const a = []; const b = [];
        for (let i = 0; i < all.length; i += 1) (sh[i] === 1 ? a : b).push(all[i]);
        if (a.length > 100 && b.length > 100) shifts.push(Q.mean(a) - Q.mean(b));
        within.push(Math.abs(Q.mean(s.own) - Q.mean(s.opp)));
      }
    }
    if (!deltas.length) continue;
    rows.push([ds, deltas.length, Q.fmt(Q.mean(deltas), 2), Q.fmt(sd(deltas), 2),
      Q.fmt(span(deltas), 2), Q.fmt(Q.mean(shifts), 2), Q.fmt(sd(shifts), 2),
      (Math.abs(Q.mean(deltas)) / (sd(deltas) || 1)).toFixed(2)]);
  }
  say(Q.table(['数据集', '人·场 n', 'Δ 均值(m)', 'Δ sd(m)', 'Δ q10–q90 跨度', '打散对照均值', '打散 sd', '|mean|/sd'],
    rows, [12, 9, 13, 9, 13, 12, 8, 9]));
  say('');
  say('**读法**：真实 Δ 的均值近 0 而 sd 大 → **不同球员在相位切换时偏**：');
  say('不是"全队一起往左/往右挪"，而是"各自的横向位置都变了，但方向不一致"。');
  say('|mean|/sd 小 = 几乎没有共同的横移方向；大 = 全队同向。');
  say('（注意：这里量的是"横向位置"，不是"横向展开"。展开的个体版本见 Q4c。）');
}
say('');

// ── Q4c. 相位的"个体横向活动半径"效应，是否独立于球位 ──────────────────
//
// 指标必须是**个体**的（票据要求"个体层面"）：对每个「人·场」，在**同一球位档内**
// 分相位算他的 `sd(y)`，再对两种相位取差。这样"哪些球员在场"和"球在哪"都被控住，
// 剩下的差只能是相位本身。
say('## Q4c. 相位的「个体横向活动半径」效应，分球位档后仍在吗？\n');
say('对每个「人·场」，在**每个球位档内、每个相位下**分别算该人的 `sd(y)`（他的横向活动半径），');
say('再取 `sd(y)|控球 − sd(y)|失球`。逐档给出跨人均值——**若每档都为正**，相位效应独立于球位。\n');
{
  const EDGES = [0, 1 / 5, 2 / 5, 3 / 5, 4 / 5, 1];
  const rows = [];
  for (const ds of ['metrica', 'skillcorner']) {
    const acc = EDGES.slice(0, -1).map(() => ({ own: [], opp: [] }));
    for (const [key, { rows: rs }] of pan) {
      if (!key.startsWith(`${ds}|`)) continue;
      // team|id -> 每球位档的 {own:[y], opp:[y]}
      const per = new Map();
      for (const r of rs) {
        const bi = Q.corpus.bucketIndex(r.ballY / P, EDGES);
        if (bi < 0) continue;
        const k = `${r.team}|${r.id}`;
        if (!per.has(k)) per.set(k, EDGES.slice(0, -1).map(() => ({ own: [], opp: [] })));
        (r.phase === 1 ? per.get(k)[bi].own : per.get(k)[bi].opp).push(r.y);
      }
      for (const [, arr] of per) {
        arr.forEach((s, bi) => {
          if (s.own.length < 40 || s.opp.length < 40) return;
          // 同一球位档内比较两种相位：球位分布相同，是可比的条件对比
          acc[bi].own.push(Math.sqrt(Q.variance(s.own)));
          acc[bi].opp.push(Math.sqrt(Q.variance(s.opp)));
        });
      }
    }
    if (!acc.some((a) => a.own.length)) continue;
    const cells = acc.map((a) => {
      if (a.own.length < 30) return '—';
      return `${Q.fmt(Q.mean(a.own) - Q.mean(a.opp), 2)}(${a.own.length})`;
    });
    rows.push([ds, ...cells]);
  }
  say(Q.table(['数据集', ...[0, 1, 2, 3, 4].map((i) => `${(EDGES[i] * 68).toFixed(0)}-${(EDGES[i + 1] * 68).toFixed(0)}m`)],
    rows, [12, 14, 14, 14, 14, 14]));
  say('（单元格 = `sd(y)|控球 − sd(y)|失球` 的跨人均值（米）；括号内是人·场样本数。）');
  say('');
  say('**读法**：正的列 = 该球位档下、控球时**个体**的横向活动半径更大（不只是队形更宽）。');
  say('若每档都为正，则"控球时球员横向跑得更多"独立于球在哪。');
  say('（引擎缺席此表：它的个体 sd 在两相位下都 ≈0，差值无统计意义。）');
}
say('');

// ── Q4d. 谁在相位切换时横向动得多？─────────────────────────────────────
say('## Q4d. 相位效应按"球侧 / 反侧"分解（个体层面）\n');
say('把每个「人·场」的帧按"球在他这一侧 / 不在他那侧"分（以本队重心为界），');
say('看两相位下的 y 均值差。若"球侧的人压上、反侧的人收中"是同向平移，则两侧的 Δ 符号应相反。\n');
{
  const rows = [];
  for (const ds of ['metrica', 'skillcorner']) {
    const near = []; const far = [];
    for (const [key, { rows: rs }] of pan) {
      if (!key.startsWith(`${ds}|`)) continue;
      const per = new Map();
      for (const r of rs) {
        const k = `${r.team}|${r.id}`;
        if (!per.has(k)) per.set(k, { ownN: [], oppN: [], ownF: [], oppF: [] });
        const s = per.get(k);
        const isNear = Math.abs(r.y - r.ballY) < P / 4; // 球在他四分之一场宽内
        if (r.phase === 1) (isNear ? s.ownN : s.ownF).push(r.y);
        else (isNear ? s.oppN : s.oppF).push(r.y);
      }
      for (const s of per.values()) {
        if (s.ownN.length > 80 && s.oppN.length > 80) near.push(Q.mean(s.ownN) - Q.mean(s.oppN));
        if (s.ownF.length > 80 && s.oppF.length > 80) far.push(Q.mean(s.ownF) - Q.mean(s.oppF));
      }
    }
    if (!near.length) continue;
    rows.push([ds, near.length, Q.fmt(Q.mean(near), 2), Q.fmt(sd(near), 2),
      far.length, Q.fmt(Q.mean(far), 2), Q.fmt(sd(far), 2),
      Q.fmt(Q.mean(near) - Q.mean(far), 2)]);
  }
  say(Q.table(['数据集', 'n(球侧)', 'Δ 球侧', 'sd', 'n(反侧)', 'Δ 反侧', 'sd', 'Δ(球侧−反侧)'],
    rows, [12, 9, 9, 8, 9, 9, 8, 14]));
  say('');
  say('**读法**：`Δ(球侧−反侧)` 显著为正 = 控球时**球侧的人比反侧的人更往"外"推**');
  say('（即横向展开不只是整体平移，还有形变）；≈0 = 相位只是整体平移。');
}

writeFileSync(join(Q.OUT_DIR, '04-phases.txt'), lines.join('\n'));
console.error('\n→ 已写入 out/04-phases.txt');
