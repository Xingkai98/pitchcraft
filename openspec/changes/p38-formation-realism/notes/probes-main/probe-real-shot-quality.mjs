// P38 #102：**真实比赛**里「射门质量 → 结果」的经验曲线。
//
// 问题：`shot_bucket` 声明的三桶转化率（禁区内 15% / 禁区弧 7% / 远射 4%）是
// **按 x 纵深**分桶的**常数**。真实足球里转化率随射门质量怎么变？
//
// 数据与口径：
//   - **主样本 = Metrica Sample_Game_{1,2}**（= 判据组 `shotsReg` 的同一口径，18+17 普通射门）。
//     事件坐标是**原始 Metrica 坐标**（每半场换边），必须用帧 JSON 的
//     `orientationDetected.flipX` + y 翻转做同套变换，否则全错。
//     ⚠️ **自检是门槛**：事件 `StartX/Y` 应落在同帧该球员位置上（中位误差 ~0.004），
//     不过就 `exit(1)`（复用 `probe-real-shot-pass.mjs` 的对齐代码与判据）。
//   - **补充样本 = Sample_Game_3**（`Sample_Game_3_events.json`，本 worktree 已备）。
//     它**没有帧**，故无法做对齐自检；但它的 `start.x/y` 已经是**归一化朝向**的
//     （每队固定攻一侧）。攻击方向由全体事件的净推进方向**从数据里推**，并用射门终点 x 复核。
//     ⚠️ 它**不进判据组口径**（判据组只用 game 1/2），只用来把样本量从 31 提到 ~50。
//     入库时逐条标 provenance，读者可自行决定信谁。
//
// ⚠️ **样本量必须如实报出**：31（+19）脚射门上估转化率曲线，**分箱后每格只有个位数**。
// 本探针的全部结论都带 Wilson 95% CI；报告里凡引用它必须同时引用 CI 与 n。
//
// 用法：node probe-real-shot-quality.mjs

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { findRepoRoot } from '../probes/repo-root.mjs';

const ROOT = findRepoRoot(new URL('.', import.meta.url).pathname);
const PITCH_LENGTH_M = 105.0;
const PITCH_WIDTH_M = 68.0;
const DATA = join(ROOT, '.scratch/tracking-data/sample-data/data');

function wilson(k, n) {
  if (!n) return [NaN, NaN];
  const z = 1.96; const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - s) / d, (c + s) / d];
}

const parseCsv = (text) => {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const head = lines[0].split(',').map((h) => h.replace(/"/g, '').trim());
  const C = (n) => head.indexOf(n);
  const out = [];
  for (let i = 1; i < lines.length; i += 1) {
    const c = lines[i].split(',');
    if (!c[C('Team')]) continue;
    out.push({
      team: c[C('Team')].replace(/"/g, ''),
      type: c[C('Type')].replace(/"/g, ''),
      subtype: c[C('Subtype')].replace(/"/g, ''),
      period: Number(c[C('Period')]),
      t: Number(c[C('Start Time [s]')]),
      from: c[C('From')].replace(/[^0-9]/g, ''),
      x: Number(c[C('Start X')]), y: Number(c[C('Start Y')]),
      ex: Number(c[C('End X')]), ey: Number(c[C('End Y')]),
    });
  }
  return out;
};

/** 射门结果归档（与引擎三个 result 对齐）。
 *  `blocked` 是**第四态**：封堵后仍可能有二次进攻，引擎没有这条链。
 *  ⚠️ 封堵的终点在场内，无法用终点判定「有没有射正」——真实口径里它既非 on-target 也非 off，
 *  单列一档，**不混进任何比率的分母**（除非明说）。 */
function resultOf(subtype) {
  const s = subtype.toUpperCase();
  if (s.includes('GOAL')) return 'goal';
  if (s === 'BLOCKED') return 'blocked';
  if (s.includes('SAVED') || s.includes('WOODWORK')) return 'on_target_nongoal';
  return 'off';
}

const rows = [];
const provenance = [];

// ── 主样本：games 1,2（CSV + 帧，带对齐自检）─────────────────────────────
for (const g of [1, 2]) {
  const csvPath = join(DATA, `Sample_Game_${g}`, `Sample_Game_${g}_RawEventsData.csv`);
  const framePath = join(ROOT, `viewer/data/real-game-${g}.json`);
  if (!existsSync(csvPath)) { console.error(`缺 ${csvPath}（gitignored）`); process.exit(1); }
  if (!existsSync(framePath)) { console.error(`缺 ${framePath}`); process.exit(1); }
  const gd = JSON.parse(readFileSync(framePath, 'utf8'));
  const { flipX } = gd.meta.orientationDetected;
  const { idMap } = gd.meta;
  const { frames } = gd;
  const nearestFrame = (t) => {
    let lo = 0; let hi = frames.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (frames[m].t < t) lo = m; else hi = m; }
    return Math.abs(frames[lo].t - t) <= Math.abs(frames[hi].t - t) ? frames[lo] : frames[hi];
  };
  const raw = readFileSync(csvPath);
  const evs = parseCsv(raw.toString('utf8'));
  const shots = evs.filter((e) => e.type === 'SHOT');
  const norm = (e, x = e.x, y = e.y) => {
    const flip = e.period <= 1 ? flipX[0] : flipX[1];
    return [flip ? 1 - x : x, 1 - y];
  };
  // ── 对齐自检（门槛）──
  const errs = [];
  for (const e of shots) {
    const isHome = e.team === 'Home';
    const eid = (isHome ? idMap.home : idMap.away)[e.from];
    if (eid === undefined) continue;
    const f = nearestFrame(e.t);
    const p = f.players[eid];
    if (!p || !Number.isFinite(e.x)) continue;
    const [nx, ny] = norm(e);
    errs.push(Math.hypot(nx - p[0], ny - p[1]));
  }
  errs.sort((a, b) => a - b);
  const medErr = errs.length ? errs[errs.length >> 1] : NaN;
  if (!(medErr < 0.02)) {
    console.error(`game${g}: 坐标自检失败（中位误差 ${medErr}，期望 <0.02）——退出`);
    process.exit(1);
  }
  let unresolved = 0;
  for (const e of shots) {
    const isHome = e.team === 'Home';
    const eid = (isHome ? idMap.home : idMap.away)[e.from];
    // 归属不到的射手（未进 tracking 的替补）无法定位 → 如实报出，不修正
    if (eid === undefined) { unresolved += 1; continue; }
    const f = nearestFrame(e.t);
    const p = f.players[eid];
    if (!p) { unresolved += 1; continue; }
    const [nx, ny] = norm(e);
    const sub = e.subtype.toUpperCase();
    rows.push({
      src: `game${g}`, game: g, t: e.t, team: isHome ? 'home' : 'away', actor: eid,
      header: sub.includes('HEAD'), subtype: e.subtype,
      x: nx, y: ny, depth_m: (isHome ? 1 - nx : nx) * PITCH_LENGTH_M,
      euclid_m: Math.hypot((isHome ? 1 - nx : nx) * PITCH_LENGTH_M, (0.5 - ny) * PITCH_WIDTH_M),
      angle_cos: (() => {
        const dx = (isHome ? 1 - nx : nx) * PITCH_LENGTH_M;
        const dy = (0.5 - ny) * PITCH_WIDTH_M; // 归一化后球门中心恒在 y=0.5
        const L = Math.hypot(dx, dy);
        return L < 1e-9 ? 1 : Math.min(1, Math.max(-1, dx / L));
      })(),
      result: resultOf(e.subtype),
      // 帧复核：归一化坐标确实落在该球员身上
      frameErr: Math.hypot(nx - p[0], ny - p[1]),
    });
  }
  provenance.push({
    src: `game${g}`, caliber: 'CSV + frames（判据组口径）',
    source: `Sample_Game_${g}_RawEventsData.csv`,
    sourceSha256: createHash('sha256').update(raw).digest('hex').slice(0, 16),
    alignmentMedianErr: +medErr.toFixed(4), shotsTotal: shots.length, unresolved,
  });
  console.log(`game${g}: SHOT ${shots.length}，对齐中位误差 ${medErr.toFixed(4)}，归属不到 ${unresolved}`);
}

// ── 补充样本：game 3（events.json，无帧）────────────────────────────────
{
  const p = join(DATA, 'Sample_Game_3', 'Sample_Game_3_events.json');
  if (existsSync(p)) {
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    const evs = doc.data;
    const name = (x) => (x && x.name ? x.name : '');
    const subsOf = (s) => { let a = s.subtypes; a = Array.isArray(a) ? a : (a ? [a] : []); return a.map(name).join(' '); };
    // ⚠️ game3 的 `events.json` 是**原始 Metrica 朝向**（每半场换边），不是归一化后的。
    //    实测证据：half1 Team A 射门终点 x≈0.01、Team B 的 x≈1.01；half2 正好相反。
    //    故攻击方向必须**按 (队, 半场)** 推，不能按队推一次。
    //    推法：该 (队,半场) 全部事件沿 x 的净推进符号（射门太少，pass/carry 多得多）；
    //    再用射门终点 x 复核（应落在进攻侧球门线外）。一致率不达标就**丢弃整个 game3**。
    const prog = {};
    for (const e of evs) {
      const tn = e.team && e.team.name; if (!tn) continue;
      if (!e.start || !e.end || !Number.isFinite(e.start.x) || !Number.isFinite(e.end.x)) continue;
      const k = `${tn}|${e.period}`;
      prog[k] = prog[k] || { sum: 0, n: 0 };
      prog[k].sum += e.end.x - e.start.x; prog[k].n += 1;
    }
    const dirAt = (tn, period) => ((prog[`${tn}|${period}`] || {}).sum > 0 ? +1 : -1);
    const shots = evs.filter((e) => name(e.type) === 'SHOT' && e.start && Number.isFinite(e.start.x));
    let agree = 0; let checked = 0;
    const dirSummary = {};
    for (const s of shots) {
      const atk = dirAt(s.team.name, s.period);
      dirSummary[`${s.team.name}|P${s.period}`] = atk;
      if (!s.end || !Number.isFinite(s.end.x)) continue;
      if (Math.abs(s.end.x - (atk > 0 ? 1.0 : 0.0)) < 0.35) agree += 1;
      checked += 1;
    }
    console.log(`game3: 推出 (队,半场) 进攻方向 ${JSON.stringify(dirSummary)}；射门终点与之一致 ${agree}/${checked}`);
    if (agree / Math.max(1, checked) < 0.75) {
      console.error(`game3: 朝向推断与射门终点一致率 ${agree}/${checked} < 0.75 —— 整个 game3 丢弃（宁可少一个样本，不可多一个错的）`);
    } else {
      provenance.push({
        src: 'game3', caliber: 'events.json（样本量补充，**不进判据组口径**；无帧 → 无对齐自检，朝向由 (队,半场) 净推进推断并用射门终点复核）',
        source: 'Sample_Game_3_events.json',
        sourceSha256: createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16),
        inferredAttackDir: dirSummary, endAgree: `${agree}/${checked}`,
        shotsTotal: shots.length,
      });
      for (const s of shots) {
        const tn = s.team.name; const atk = dirAt(tn, s.period);
        const nx = atk > 0 ? s.start.x : 1 - s.start.x;   // 归一化：恒攻击 x=1
        const ny = s.start.y;
        const dx = (1 - nx) * PITCH_LENGTH_M;
        const dy = (ny - 0.5) * PITCH_WIDTH_M;            // 归一化后球门中心恒在 y=0.5
        const L = Math.hypot(dx, dy);
        rows.push({
          src: 'game3', game: 3, t: s.start.time, team: atk > 0 ? 'home' : 'away',
          actor: s.from ? s.from.name : null,
          header: /HEAD/.test(subsOf(s)), subtype: subsOf(s),
          x: nx, y: ny, depth_m: dx, euclid_m: L,
          angle_cos: L < 1e-9 ? 1 : Math.min(1, Math.max(-1, dx / L)),
          result: resultOf(subsOf(s)), frameErr: null,
        });
      }
    }
  } else {
    console.warn('（无 Sample_Game_3_events.json —— 只用 2 场主样本）');
  }
}

// 修正 game3 的 angle_cos（上面那行为了不去猜符号写得绕，这里统一重算）
for (const r of rows) {
  if (r.src !== 'game3') continue;
  const gx = r.team === 'home' ? 1.0 : 0.0;
  const dx = Math.abs(r.x - gx) * PITCH_LENGTH_M;
  const dy = (r.y - 0.5) * PITCH_WIDTH_M;
  const L = Math.hypot(dx, dy);
  r.angle_cos = L < 1e-9 ? 1 : Math.min(1, Math.max(-1, dx / L));
}

const regular = rows.filter((r) => !r.header);
const header = rows.filter((r) => r.header);
console.log(`\n合计：射门 ${rows.length}（普通 ${regular.length} + 头球 ${header.length}）`);

const BANDS = [[0, 6], [6, 11], [11, 16.5], [16.5, 25], [25, 99]];
const bandLabel = ([lo, hi]) => (hi === 99 ? `${lo}+` : `${lo}-${hi}`);

/** 分箱统计（带 Wilson CI）。`distKey` = 'euclid_m' | 'depth_m'。 */
function curve(sel, distKey, bands = BANDS) {
  return bands.map(([lo, hi]) => {
    const s = sel.filter((r) => r[distKey] >= lo && r[distKey] < hi);
    const g = s.filter((r) => r.result === 'goal').length;
    const ot = s.filter((r) => r.result === 'goal' || r.result === 'on_target_nongoal').length;
    const bl = s.filter((r) => r.result === 'blocked').length;
    const denom = s.length - bl; // 封堵不进 on-target 比率分母（无终点的第三态）
    return {
      band: bandLabel([lo, hi]), n: s.length, blocked: bl, goals: g,
      conv: s.length ? +(g / s.length).toFixed(4) : NaN,
      convCI: s.length ? wilson(g, s.length).map((v) => +v.toFixed(3)) : [NaN, NaN],
      onTarget: denom > 0 ? +((ot) / denom).toFixed(4) : NaN,
      onTargetCI: denom > 0 ? wilson(ot, denom).map((v) => +v.toFixed(3)) : [NaN, NaN],
    };
  });
}

const primary = regular.filter((r) => r.src !== 'game3');
const all = regular;

const out = {
  note: '真实射门质量→结果经验曲线。主样本 = Metrica game1/2（判据组口径）；补充 = game3（无帧）。'
    + '分箱后每格 n 很小——引用必须同时给 CI。',
  provenance,
  totals: {
    primary: { n: primary.length, goals: primary.filter((r) => r.result === 'goal').length,
      onTargetRate: +(primary.filter((r) => r.result === 'goal' || r.result === 'on_target_nongoal').length
        / (primary.length - primary.filter((r) => r.result === 'blocked').length)).toFixed(4) },
    withGame3: { n: all.length, goals: all.filter((r) => r.result === 'goal').length },
  },
  byEuclid: { primary: curve(primary, 'euclid_m'), all3: curve(all, 'euclid_m') },
  byDepth: { primary: curve(primary, 'depth_m'), all3: curve(all, 'depth_m') },
  // 引擎桶边界（16.5 / 25）的对照——即「声明 15/7/4」那三档
  byEngineBandsEuclid: {
    primary: curve(primary, 'euclid_m', [[0, 16.5], [16.5, 25], [25, 99]]),
    all3: curve(all, 'euclid_m', [[0, 16.5], [16.5, 25], [25, 99]]),
  },
  byEngineBandsDepth: {
    primary: curve(primary, 'depth_m', [[0, 16.5], [16.5, 25], [25, 99]]),
    all3: curve(all, 'depth_m', [[0, 16.5], [16.5, 25], [25, 99]]),
  },
  angleBands: [[0.5, 0.8], [0.8, 1.01]].map(([lo, hi]) => {
    const s = primary.filter((r) => r.angle_cos >= lo && r.angle_cos < hi);
    const g = s.filter((r) => r.result === 'goal').length;
    return { band: `cos ${lo}-${hi}`, n: s.length, goals: g, conv: s.length ? +(g / s.length).toFixed(4) : NaN };
  }),
  rows: all,
};

console.log('\n=== 按**欧氏**距离分箱（主样本 game1/2）===');
for (const b of out.byEuclid.primary) {
  console.log(` ${b.band.padEnd(8)} n=${String(b.n).padStart(2)} 封堵=${b.blocked} 进球=${b.goals} 转化=${b.conv} CI=[${b.convCI[0]},${b.convCI[1]}] 射正=${b.onTarget}`);
}
console.log('\n=== 按**纵深**（引擎口径）分箱（主样本）===');
for (const b of out.byDepth.primary) {
  console.log(` ${b.band.padEnd(8)} n=${String(b.n).padStart(2)} 封堵=${b.blocked} 进球=${b.goals} 转化=${b.conv} CI=[${b.convCI[0]},${b.convCI[1]}] 射正=${b.onTarget}`);
}
console.log('\n=== 引擎桶边界（欧氏 / 纵深）===');
console.log(' euclid', JSON.stringify(out.byEngineBandsEuclid.all3.map((b) => `${b.band}: n=${b.n} g=${b.goals} conv=${b.conv}`)));
console.log(' depth ', JSON.stringify(out.byEngineBandsDepth.all3.map((b) => `${b.band}: n=${b.n} g=${b.goals} conv=${b.conv}`)));

const OUT = join(ROOT, 'openspec/changes/p38-formation-realism/notes/probes-main/out');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'real-shot-quality.json'), `${JSON.stringify(out, null, 2)}\n`);
writeFileSync(join(OUT, 'real-shot-quality.jsonl'), `${all.map((r) => JSON.stringify(r)).join('\n')}\n`);
console.log(`\n→ out/real-shot-quality.json（+ .jsonl ${all.length} 行）`);
