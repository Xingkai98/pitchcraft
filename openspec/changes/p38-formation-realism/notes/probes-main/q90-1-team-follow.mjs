// P38 #90 探针 1：**球队整体横向跟随**（Q1）。
//
// 问题：真实球队的横向重心随球横向位置移动多少？回归斜率与 R² 是多少？
//       引擎的对应机制（`formation_target` 的 `ty` 项）上限只有 ~1.2m。
//
// 口径：
//   - 逐场逐队逐帧：cy（非门将 10 人 y 均值，米）、by（球 y，米，同一 y 轴不镜像）。
//   - 回归 cy ~ by **逐场做**，再报跨场均值/范围（跨场混池会把场间尺度差当信号）。
//   - 相位列用 SkillCorner 源真值 / Metrica 代理（见 00-caliber）。
//   - 球只用原始观测帧。
//   - 引擎侧：3 种子 × 5400s，同一装载路径（引擎帧无 pitchMeters → 105×68）。
//
// 运行：node openspec/changes/p38-formation-realism/notes/probes-main/q90-1-team-follow.mjs

import * as Q from './q90-common.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const P = Q.PITCH_WIDTH_M;
const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };

const ms = Q.loadReal();
const eng = await Q.loadEngineFrames({ seeds: [42, 1, 7] });
say(`样本：Metrica 2 场 + SkillCorner 6 场 + 引擎 3 种子（各 5400s，5Hz 采样）\n`);

// 收集：每场每队 → 每帧 (cy, by, phase)
function collect(m) {
  const rec = { home: { all: [], own: [], opp: [] }, away: { all: [], own: [], opp: [] } };
  for (let i = 0; i < m.frames.length; i += 1) {
    const f = m.frames[i];
    if (!f.ball) continue;
    if (m.phase && m.phase.ballDet[i] !== 1) continue; // 球须真观测
    for (const team of ['home', 'away']) {
      const by = Q.ballYCanon(m, f, team, i);
      const ps = Q.framePlayers(m, f, team, { idx: i, includeExtrapolated: true });
      if (ps.length < 7) continue;
      const cy = Q.mean(ps.map((p) => p.y));
      const ph = Q.phaseOf(m, f, team, i);
      rec[team].all.push([cy, by]);
      if (ph === 1) rec[team].own.push([cy, by]);
      else if (ph === 0) rec[team].opp.push([cy, by]);
    }
  }
  return rec;
}

const perMatch = [];
for (const m of [...ms, ...eng]) perMatch.push({ m, rec: collect(m) });

// ── Q1a. cy ~ by 逐场回归 ────────────────────────────────────────────────
say('## Q1a. 球队横向重心 cy 对球 y 的回归（逐场逐队；主口径）\n');
say('cy = 非门将 10 人 y 均值（米）；by = 球 y（米）。斜率 = 球队重心横移 / 球横移。');
say('球 y 的样本 sd 一并给出（斜率 × sd = 重心的**可解释横移幅度**，与"档心跨度"同量级）。\n');
{
  const rows = [];
  for (const { m, rec } of perMatch) {
    for (const team of ['home', 'away']) {
      const d = rec[team].all;
      if (d.length < 300) continue;
      const y = d.map((x) => x[0]); const x = d.map((v) => v[1]);
      const r = Q.uni(y, x);
      const sd = (a) => Math.sqrt(Q.variance(a));
      rows.push([`${m.dataset === 'engine' ? 'eng' : m.dataset.slice(0, 3)} ${m.id}`, team, d.length,
        Q.fmt(r.slope, 3), Q.fmt(r.r2, 3), Q.fmt(sd(x), 1), Q.fmt(sd(y), 1),
        Q.fmt(r.slope * sd(x), 1)]);
    }
  }
  say(Q.table(['场次', '队', 'n', '斜率', 'R²', '球 y sd', '重心 y sd', '斜率×球sd(m)'],
    rows, [16, 5, 9, 8, 7, 9, 10, 13]));
  const byDs = (k) => {
    const v = rows.filter((r) => r[0].startsWith(k)).map((r) => Number(r[3]));
    return { mean: Q.mean(v), min: Math.min(...v), max: Math.max(...v), n: v.length };
  };
  const met = byDs('met'); const sc = byDs('ski'); const en = byDs('eng');
  say('');
  say(`**跨场汇总**  斜率：Metrica ${Q.fmt(met.mean, 3)} [${Q.fmt(met.min, 3)}–${Q.fmt(met.max, 3)}] n=${met.n} 队·场`
    + `　SkillCorner ${Q.fmt(sc.mean, 3)} [${Q.fmt(sc.min, 3)}–${Q.fmt(sc.max, 3)}] n=${sc.n}`
    + `　**引擎 ${Q.fmt(en.mean, 3)} [${Q.fmt(en.min, 3)}–${Q.fmt(en.max, 3)}] n=${en.n}**`);
  const r2m = Q.mean(rows.filter((r) => r[0].startsWith('met')).map((r) => Number(r[4])));
  const r2s = Q.mean(rows.filter((r) => r[0].startsWith('ski')).map((r) => Number(r[4])));
  const r2e = Q.mean(rows.filter((r) => r[0].startsWith('eng')).map((r) => Number(r[4])));
  say(`**R²**：Metrica ${Q.fmt(r2m, 3)}　SkillCorner ${Q.fmt(r2s, 3)}　引擎 ${Q.fmt(r2e, 3)}`);
  say('');
  say(`引擎斜率 ≈ ${Q.fmt(en.mean, 3)} 对应"球从一侧到另一侧（y 跨 ~45m）重心只移 ${Q.fmt(en.mean * 45, 1)}m"，`);
  say(`与读代码得到的上限 \`SIDE_SHIFT_FACTOR*0.6*W = 0.06*0.6*68 = 2.45m\` 同量级——`);
  say(`真实是 ${Q.fmt(sc.mean * 45, 1)}–${Q.fmt(met.mean * 45, 1)}m。差距 ${Q.fmt(sc.mean / en.mean, 1)}×（SkillCorner）/ ${Q.fmt(met.mean / en.mean, 1)}×（Metrica）。`);
}
say('');

// ── Q1b. 相位对照（同一球位置下）────────────────────────────────────────
say('## Q1b. 控球 vs 失球：同一球位置下的横向重心差（个体层面之外的整体对照）\n');
say('按球 y 分 5 档（各 13.6m），统计两种相位下的 cy。**同一个球位档内**对比，');
say('故差不是"球位置不同"造成的。\n');
{
  const EDGES = [0, 1 / 5, 2 / 5, 3 / 5, 4 / 5, 1];
  const acc = EDGES.slice(0, -1).map(() => ({ own: [], opp: [] }));
  const accM = EDGES.slice(0, -1).map(() => ({ own: [], opp: [] }));
  for (const { m, rec } of perMatch) {
    if (m.dataset === 'engine') continue;
    const isSC = m.dataset === 'skillcorner';
    const tgt = isSC ? acc : accM;
    // 重扫一遍帧以拿到 by → 档（rec 里没有 by 分档索引；直接复用 rec 的两个池）
    for (const team of ['home', 'away']) {
      for (const [pool, key] of [[rec[team].own, 'own'], [rec[team].opp, 'opp']]) {
        for (const [cy, by] of pool) {
          const bi = Q.corpus.bucketIndex(by / P, EDGES);
          if (bi < 0) continue;
          tgt[bi][key].push(cy);
        }
      }
    }
  }
  for (const [ds, acc2] of [['SkillCorner（源真值相位）', acc], ['Metrica（最近球员代理）', accM]]) {
    say(`${ds}：`);
    const rows = acc2.map((a, i) => [`[${(EDGES[i] * 68).toFixed(0)}–${(EDGES[i + 1] * 68).toFixed(0)})m`,
      a.own.length, Q.fmt(Q.mean(a.own), 2), a.opp.length, Q.fmt(Q.mean(a.opp), 2),
      Q.fmt(Q.mean(a.own) - Q.mean(a.opp), 2)]);
    say(Q.table(['球 y 档', 'n(控球)', 'cy 控球', 'n(失球)', 'cy 失球', 'Δ(控−失)'], rows, [14, 9, 9, 9, 9, 10]));
    const dAll = acc2.filter((a) => a.own.length > 100 && a.opp.length > 100);
    const wOwn = Q.mean(dAll.map((a) => Q.mean(a.own)));
    const wOpp = Q.mean(dAll.map((a) => Q.mean(a.opp)));
    say(`  逐档均值 cy：控球 ${Q.fmt(wOwn, 2)}　失球 ${Q.fmt(wOpp, 2)}　**Δ = ${Q.fmt(wOwn - wOpp, 2)}m**`);
    const d0 = Q.mean(acc2[0].own) - Q.mean(acc2[0].opp);
    const d4 = Q.mean(acc2[4].own) - Q.mean(acc2[4].opp);
    say(`  但**逐档符号是翻转的**：球在 y 最小档 Δ=${Q.fmt(d0, 2)}（控球重心更远离中轴）`
      + `，球在 y 最大档 Δ=${Q.fmt(d4, 2)}（控球重心更靠中轴）。`);
    say('  两档的符号相反、量级都 <1.1m → **不存在"控球时整体推向球侧"的一致效应**；');
    say('  这更像"控球时两端各自向外张"的对称效应：分布变宽（Q4a 已证 +2.9~5.2m）而中心基本不动。');
    say('');
  }
}
say('');

// ── Q1c. 逐人分解：全队平移 vs 个体额外跟随 ─────────────────────────────
//
// **注意**（踩过的坑）：不能把「每人 y − 本帧重心 cy」在球位档内**混池求均值**——
// 那是恒等于 0 的（cy 就是同一批人的均值）。必须在**固定个体**上做：
// 逐槽位把该人的 y 对球 y 回归，得到该人的跟随斜率，再与全队斜率比。
// 个体斜率 − 全队斜率 = 该人相对队友的**额外**横移（正 = 比队友更跟球）。
say('## Q1c. 逐人分解：谁在跟随？跟随多少？\n');
say('对每个**固定槽位**（一场内不变的身份）单独做 `y_player ~ by` 回归。');
say('斜率 > 全队斜率 = 这个人比队友更跟球（相对的横向职责）；< = 更不跟（守区域/拖后）。');
say('SkillCorner 另有真实位置标签，故同时给出按**位置线**的汇总。\n');
{
  // perMatch → per match/team/slot 的回归样本
  const slotRows = []; // {ds, match, team, id, line, n, slope, r2, dev}
  const byLine = new Map(); // ds|line -> {teamSlope:[], devs:[]}
  for (const { m } of perMatch) {
    const ds = m.dataset;
    for (const team of ['home', 'away']) {
      // 全队斜率（当帧 cy ~ by 的最小二乘斜率，等价于逐人斜率按人取均值的前提）
      const teamPool = [];
      const slotPool = new Map();
      for (let i = 0; i < m.frames.length; i += 1) {
        const f = m.frames[i];
        if (!f.ball) continue;
        if (m.phase && m.phase.ballDet[i] !== 1) continue;
        const by = Q.ballYCanon(m, f, team, i);
        const ps = Q.framePlayers(m, f, team, { idx: i, includeExtrapolated: true });
        if (ps.length < 7) continue;
        teamPool.push([Q.mean(ps.map((p) => p.y)), by]);
        for (const p of ps) {
          if (!slotPool.has(p.id)) slotPool.set(p.id, { y: [], by: [], line: p.line });
          const s = slotPool.get(p.id); s.y.push(p.y); s.by.push(by);
          if (s.line == null) s.line = p.line;
        }
      }
      if (teamPool.length < 300) continue;
      const tr = Q.uni(teamPool.map((v) => v[0]), teamPool.map((v) => v[1]));
      for (const [id, s] of slotPool) {
        if (s.y.length < 300) continue;
        const r = Q.uni(s.y, s.by);
        if (!r) continue;
        slotRows.push({ ds, match: m.id, team, id, line: s.line, n: s.y.length,
          slope: r.slope, r2: r.r2, dev: r.slope - tr.slope });
      }
    }
  }
  // 汇总：逐数据集
  const rows = [];
  for (const ds of ['metrica', 'skillcorner', 'engine']) {
    const sub = slotRows.filter((r) => r.ds === ds);
    if (!sub.length) continue;
    const sl = sub.map((r) => r.slope);
    const dv = sub.map((r) => r.dev);
    const rms = Math.sqrt(Q.mean(dv.map((v) => v ** 2)));
    rows.push([ds, sub.length, Q.fmt(Q.mean(sl), 3), Q.fmt(Math.min(...sl), 3), Q.fmt(Math.max(...sl), 3),
      Q.fmt(Math.sqrt(Q.variance(sl)), 3), Q.fmt(rms, 3), Q.fmt(Q.mean(sub.map((r) => r.r2)), 3)]);
  }
  say(Q.table(['数据集', '人·场 n', '斜率均值', 'min', 'max', '斜率 sd', '相对全队 RMS', 'R²均值'],
    rows, [12, 9, 9, 8, 8, 8, 12, 8]));
  say('');
  // 按位置线（SkillCorner）
  const sc = slotRows.filter((r) => r.ds === 'skillcorner' && r.line);
  const lineRows = [];
  for (const ln of ['defence', 'midfield', 'attack']) {
    const sub = sc.filter((r) => r.line === ln);
    if (!sub.length) continue;
    const sl = sub.map((r) => r.slope);
    lineRows.push([ln, sub.length, Q.fmt(Q.mean(sl), 3), Q.fmt(Math.min(...sl), 3), Q.fmt(Math.max(...sl), 3),
      Q.fmt(Math.sqrt(Q.variance(sl)), 3)]);
  }
  say('SkillCorner 按真实位置标签：');
  say(Q.table(['线', '人·场 n', '斜率均值', 'min', 'max', 'sd'], lineRows, [10, 9, 9, 8, 8, 8]));
  say('');
  say('**引擎侧对照**：引擎 22 个槽位的斜率几乎相同（sd 见上表最后一列），因为 `ty` 只依赖 `base.y`');
  say('（每人不同、一场内固定）+ 同一个球位项 → **个体间差异只来自初始站位**，没有"谁更跟球"。');
  say('');
  // 引擎逐槽位明示
  const engRows = [];
  for (const ds of ['skillcorner', 'engine']) {
    const byId = new Map();
    for (const r of slotRows.filter((x) => x.ds === ds)) {
      if (!byId.has(r.id)) byId.set(r.id, []);
      byId.get(r.id).push(r.slope);
    }
    engRows.push([ds, ...[...byId.entries()].sort((a, b) => a[0] - b[0])
      .map(([id, v]) => `#${id}:${Q.fmt(Q.mean(v), 2)}`)]);
  }
  say('逐槽位斜率（同槽位跨场平均）：');
  for (const [ds, ...cells] of engRows) say(`  ${ds.padEnd(12)} ${cells.join(' ')}`);
  say('');
  say('（SkillCorner 槽位 = 按整场平均深度排的身份，**不是**位置标签；位置标签见上一表。）');
}
say('');

// ── Q1d. 极端情形：球贴边 vs 球在中轴 ────────────────────────────────────
say('## Q1d. 球贴边（y<8m 或 y>60m）vs 球在中轴（26<y<42）\n');
{
  const rows = [];
  for (const ds of ['metrica', 'skillcorner', 'engine']) {
    const edge = []; const mid = []; const widthsE = []; const widthsM = [];
    for (const { m, rec } of perMatch) {
      if (m.dataset !== ds) continue;
      for (const team of ['home', 'away']) {
        for (const [cy, by] of rec[team].all) {
          if (by < 8 || by > P - 8) edge.push([cy, by]);
          else if (by > 26 && by < 42) mid.push([cy, by]);
        }
      }
    }
    const dev = (a) => Math.sqrt(Q.variance(a.map((x) => x[0])));
    rows.push([ds, edge.length, Q.fmt(Q.mean(edge.map((x) => Math.abs(x[0] - P / 2))), 2),
      mid.length, Q.fmt(Q.mean(mid.map((x) => Math.abs(x[0] - P / 2))), 2),
      Q.fmt(dev(edge), 2), Q.fmt(dev(mid), 2)]);
  }
  say(Q.table(['数据集', 'n(贴边)', '|重心−中轴|贴边', 'n(中轴)', '|重心−中轴|中轴', '重心sd 贴边', '重心sd 中轴'],
    rows, [12, 9, 15, 9, 15, 11, 11]));
  say('');
  say('注意"重心 sd"是**跨时刻的**（含比赛整体漂移），不是逐球位档内的离散——');
  say('逐档内的横向离散见 Q3（个体层面）。');
}
say('');

// ── Q1e. ⚠ 上游约束：引擎的**球**本身就不去边路 ─────────────────────────
//
// **这是本探针最重要的发现之一**："球队不跟球"与"球本来就没往边路去"是两个独立的缺陷，
// 而后者在上游。若球从不进入边路通道，那么任何"让球队跟球"的机制都**没有输入可跟**。
say('## Q1e. ⚠ 上游约束：引擎的球本身有横向覆盖吗？（机制的前提）\n');
say('统计球 y 的分布：sd、q10–q90 跨度、以及 5 条 13.6m 通道的停留占比。');
say('若引擎的球几乎只在中间三条通道活动，那么"横向跟随"的**输入信号**本身就不存在。\n');
{
  const rows = [];
  for (const { m } of perMatch) {
    const ys = [];
    for (let i = 0; i < m.frames.length; i += 1) {
      const f = m.frames[i];
      if (!f.ball) continue;
      if (m.phase && m.phase.ballDet[i] !== 1) continue;
      ys.push(f.ball[1] * P);
    }
    if (ys.length < 300) continue;
    const s = [...ys].sort((a, b) => a - b);
    const occ = [0, 0, 0, 0, 0];
    for (const y of ys) occ[Q.channelOf(y)] += 1;
    rows.push([`${m.dataset === 'engine' ? 'eng' : m.dataset.slice(0, 3)} ${m.id}`, ys.length,
      Q.fmt(Math.sqrt(Q.variance(ys)), 1), Q.fmt(Q.quantile(s, 0.9) - Q.quantile(s, 0.1), 1),
      ...occ.map((v) => `${Q.fmt(100 * v / ys.length, 1)}%`)]);
  }
  say(Q.table(['场次', 'n', '球 y sd(m)', '球 y q10–q90(m)', '左翼', '左半', '中路', '右半', '右翼'],
    rows, [16, 8, 10, 14, 7, 7, 7, 7, 7]));
  say('');
  say('**读法**：真实球 y 的 q10–q90 跨 **53–59m**，五通道占比接近均匀（各 ~20%）；');
  say('引擎只有 **21–22m**、两翼合计仅 **3–5%**（真实 30–45%）。');
  say('→ **引擎的球基本不去边路**。这是一个**独立的、上游的**缺陷，与队形机制分开：');
  say('  队形"不跟球"（Q1a）× 球"不去边路"（本节）两个因子相乘，才得到 0.53m 的横向移动。');
  say('  **修队形之前必须先问：球会不会去边路？** 否则新机制会在中路的窄带里空转。');
}

writeFileSync(join(Q.OUT_DIR, '01-team-follow.txt'), lines.join('\n'));
console.error('\n→ 已写入 out/01-team-follow.txt');
