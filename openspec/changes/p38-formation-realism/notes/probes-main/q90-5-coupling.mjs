// P38 #90 探针 5：**横向与纵向的耦合**（Q5）——球员纵向移动时横向怎么变？
// 边路球员是"沿边直上"还是"内切"？
//
// 为什么这是关键（对机制的含义）：
//   若"纵向越前 → 横向越靠中"（内切收缩），则纵向位置 x 本身就携带了一部分横向信息，
//   机制可以用 f(x) 近似；若"沿边直上"（x 变化时 y 不变），则横向必须**独立**建模。
//
// 五节：
//   5a 全队：把球员按 x 分档，看 y 的**相对重心偏移**（去均值）如何随 x 变化；
//   5b 逐人：每人对 (x, y) 做回归——斜率 = "前进 1m 时横向动多少 m"，并给 R²；
//   5c 按位置线的同一条曲线（SkillCorner 真实标签）；
//   5d 边路 vs 中路的**轨迹形状**：把边路球员按"从后到前的整段位移"分解成纵向/横向分量；
//   5e 球在边路 vs 中路时，"内切"是否更强（= 横向是否由球侧驱动而非固定内切）。
//
// 运行：node openspec/changes/p38-formation-realism/notes/probes-main/q90-5-coupling.mjs

import * as Q from './q90-common.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const P = Q.PITCH_WIDTH_M;
const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };

const ms = Q.loadReal();
const eng = await Q.loadEngineFrames({ seeds: [42] });
say('样本：Metrica 2 场 + SkillCorner 6 场；引擎 1 种子对照。全点口径。\n');

// ── 收集逐人面板 ────────────────────────────────────────────────────────
function collect(m) {
  const per = new Map();
  for (let i = 0; i < m.frames.length; i += 1) {
    const f = m.frames[i];
    if (!f.ball) continue;
    if (m.phase && m.phase.ballDet[i] !== 1) continue;
    for (const team of ['home', 'away']) {
      const ps = Q.framePlayers(m, f, team, { idx: i, includeExtrapolated: true });
      if (ps.length < 7) continue;
      const cy = Q.mean(ps.map((p) => p.y));
      const by = Q.ballYCanon(m, f, team, i);
      for (const p of ps) {
        const k = `${team}|${p.id}`;
        if (!per.has(k)) per.set(k, { team, id: p.id, line: p.line, group: p.group, x: [], y: [], cy: [], by: [], t: [], phase: [] });
        const s = per.get(k);
        s.x.push(p.x); s.y.push(p.y); s.cy.push(cy); s.by.push(by); s.t.push(f.t);
        s.phase.push(Q.phaseOf(m, f, team, i));
        if (s.line == null) s.line = p.line;
      }
    }
  }
  return per;
}
const all = new Map();
for (const m of [...ms, ...eng]) all.set(`${m.dataset}|${m.id}`, { m, per: collect(m) });

function residualize(v, ctrl) {
  const r = Q.uni(v, ctrl);
  if (!r) return v;
  return v.map((x, i) => x - (r.intercept + r.slope * ctrl[i]));
}

const EDGES_X = [0, 0.15, 0.3, 0.45, 0.6, 0.75, 1.0]; // 纵向 6 档（离本方门线）

// ── Q5a. 全队：y 相对重心的偏移随纵向位置变化 ───────────────────────────
say('## Q5a. 横向（相对重心）随纵向位置的变化——"越往前越靠中"？\n');
say('把球员按 x（离本方门线）分 6 档，统计其 `y − 当帧本队重心 cy` 的均值与 sd。');
say('注意：**必须取相对重心的偏移**——绝对 y 被"球队整体横移"主导（见 Q1）。\n');
{
  for (const ds of ['metrica', 'skillcorner', 'engine']) {
    const acc = EDGES_X.slice(0, -1).map(() => []);
    const accLine = { defence: EDGES_X.slice(0, -1).map(() => []), midfield: EDGES_X.slice(0, -1).map(() => []), attack: EDGES_X.slice(0, -1).map(() => []) };
    for (const [key, { per }] of all) {
      if (!key.startsWith(`${ds}|`)) continue;
      for (const s of per.values()) {
        for (let i = 0; i < s.x.length; i += 1) {
          const bi = Q.corpus.bucketIndex(s.x[i] / Q.PITCH_LENGTH_M, EDGES_X);
          if (bi < 0) continue;
          acc[bi].push(s.y[i] - s.cy[i]);
          if (s.line && accLine[s.line]) accLine[s.line][bi].push(s.y[i] - s.cy[i]);
        }
      }
    }
    say(`${ds}：`);
    const rows = acc.map((a, i) => [`[${(EDGES_X[i] * 105).toFixed(0)}–${(EDGES_X[i + 1] * 105).toFixed(0)})m`,
      a.length, Q.fmt(Q.mean(a), 2), Q.fmt(Math.sqrt(Q.variance(a)), 2),
      Q.fmt(Q.mean(accLine.defence[i]), 2), Q.fmt(Q.mean(accLine.midfield[i]), 2),
      Q.fmt(Q.mean(accLine.attack[i]), 2)]);
    say(Q.table(['x 档', 'n 人次', 'y−cy 均值', 'y−cy sd', '后防', '中场', '锋线'],
      rows, [13, 9, 10, 9, 8, 8, 8]));
    const m0 = acc.filter((a) => a.length > 100).map((a) => Q.mean(a));
    say(`  最深档 → 最浅档的偏移变化：${Q.fmt(m0[0], 2)} → ${Q.fmt(m0[m0.length - 1], 2)}`
      + `（Δ ${Q.fmt(m0[m0.length - 1] - m0[0], 2)}m）\n`);
  }
}

// ── Q5b. 逐人：dy/dx 的斜率 ─────────────────────────────────────────────
say('## Q5b. 逐人回归 `y ~ x`：前进 1m 时横向动多少？\n');
say('逐「人·场」做单变量回归（x 已镜像成"离本方门线距离"，y 已做朝向归一）。');
say('斜率 0 = **沿边线/沿直线直上**（纵向走、横向不动）；');
say('斜率显著非 0 = 纵向移动伴随横向漂移（内切/外扩）。\n');
{
  const rows = [];
  for (const ds of ['metrica', 'skillcorner', 'engine']) {
    const slopes = []; const r2s = []; const byLine = { defence: [], midfield: [], attack: [] };
    for (const [key, { per }] of all) {
      if (!key.startsWith(`${ds}|`)) continue;
      for (const s of per.values()) {
        if (s.x.length < 300) continue;
        const r = Q.uni(s.y, s.x);
        if (!r) continue;
        slopes.push(r.slope); r2s.push(r.r2);
        if (s.line && byLine[s.line]) byLine[s.line].push(r.slope);
      }
    }
    if (!slopes.length) continue;
    const sd = (a) => Math.sqrt(Q.variance(a));
    const q = (a, p) => Q.quantile([...a].sort((x, y) => x - y), p);
    rows.push([ds, slopes.length, Q.fmt(Q.mean(slopes), 3), Q.fmt(sd(slopes), 3),
      Q.fmt(q(slopes, 0.1), 3), Q.fmt(q(slopes, 0.5), 3), Q.fmt(q(slopes, 0.9), 3),
      Q.fmt(Q.mean(r2s), 3)]);
  }
  say(Q.table(['数据集', '人·场 n', '斜率均值', '斜率 sd', 'q10', '中位', 'q90', 'R²均值'],
    rows, [12, 9, 9, 8, 8, 8, 8, 8]));
  say('');
  say('SkillCorner 按位置线：');
  const lr = [];
  const byLineSC = { defence: [], midfield: [], attack: [] };
  for (const [key, { per }] of all) {
    if (!key.startsWith('skillcorner|')) continue;
    for (const s of per.values()) {
      if (s.x.length < 300 || !s.line || !byLineSC[s.line]) continue;
      const r = Q.uni(s.y, s.x);
      if (r) byLineSC[s.line].push(r.slope);
    }
  }
  for (const [ln, v] of Object.entries(byLineSC)) {
    if (!v.length) continue;
    lr.push([ln, v.length, Q.fmt(Q.mean(v), 3), Q.fmt(Math.min(...v), 3), Q.fmt(Math.max(...v), 3)]);
  }
  say(Q.table(['线', 'n', '斜率均值', 'min', 'max'], lr, [10, 6, 9, 8, 8]));
  say('');
  say('**读法**：斜率均值接近 0（即使 sd 不为 0）→ **"沿边直上"是主流**，横向不由纵向位置决定。');
  say('若中场的斜率系统性为负（y 大的一侧越往前越靠中）→ 中场有内切趋势。');
}
say('');

// ── Q5c. 球在边路 vs 中路：内切强度是否随球侧变化 ───────────────────────
say('## Q5c. 横向位置与球侧的耦合：球员偏离重心的方向是否指向球？\n');
say('对每个「人·场」，算 `corr(y − cy, ballY − cy)`（他偏离重心的方向 vs 球偏离重心的方向）。');
say('+1 = 永远站在球的同侧（"球侧倾斜"）；0 = 与球侧无关（固定职责）；');
say('−1 = 永远站反侧。逐人算后再跨人平均。\n');
{
  const rows = [];
  for (const ds of ['metrica', 'skillcorner', 'engine']) {
    const cs = []; const byLine = { defence: [], midfield: [], attack: [] };
    const csByBallSide = { near: [], far: [] };
    for (const [key, { per }] of all) {
      if (!key.startsWith(`${ds}|`)) continue;
      for (const s of per.values()) {
        if (s.x.length < 300) continue;
        const devY = s.y.map((v, i) => v - s.cy[i]);
        const devB = s.by.map((v, i) => v - s.cy[i]);
        const c = Q.corr(devY, devB);
        if (!Number.isFinite(c)) continue;
        cs.push(c);
        if (s.line && byLine[s.line]) byLine[s.line].push(c);
      }
    }
    if (!cs.length) continue;
    const sd = (a) => Math.sqrt(Q.variance(a));
    rows.push([ds, cs.length, Q.fmt(Q.mean(cs), 3), Q.fmt(sd(cs), 3),
      Q.fmt(Q.quantile([...cs].sort((a, b) => a - b), 0.1), 3),
      Q.fmt(Q.quantile([...cs].sort((a, b) => a - b), 0.9), 3)]);
  }
  say(Q.table(['数据集', '人·场 n', 'corr(y−cy, ballY−cy) 均值', 'sd', 'q10', 'q90'],
    rows, [12, 9, 24, 8, 8, 8]));
  say('');
  say('⚠ **这个简单相关被共享项污染了**：`y−cy` 与 `ballY−cy` 都含 `−cy`，');
  say('而 `Var(cy)` 很大（Q1），这一项给相关系数加了**正的**贡献。故简单相关 ≈0 意味着');
  say('**去掉共享项后真实关系是负的或更接近 0**。表格下方给**偏相关**（把 cy 从两边都回归掉）。\n');
  say('**读法**：偏相关就是"这个人的横向站位有多少由球侧决定"的量化（扣掉全队平移）。');
  say('≈0.5 → "一半跟球、一半守区"（球侧倾斜 + 职责区混合）；接近 1 → 纯球侧倾斜（无职责）；');
  say('接近 0 → 纯职责（不跟球）。\n');
  // 按位置线
  const lr = [];
  const byLine = { defence: [], midfield: [], attack: [] };
  for (const [key, { per }] of all) {
    if (!key.startsWith('skillcorner|')) continue;
    for (const s of per.values()) {
      if (s.x.length < 300 || !s.line || !byLine[s.line]) continue;
      const c = Q.corr(s.y.map((v, i) => v - s.cy[i]), s.by.map((v, i) => v - s.cy[i]));
      if (Number.isFinite(c)) byLine[s.line].push(c);
    }
  }
  for (const [ln, v] of Object.entries(byLine)) {
    if (!v.length) continue;
    lr.push([ln, v.length, Q.fmt(Q.mean(v), 3), Q.fmt(Math.min(...v), 3), Q.fmt(Math.max(...v), 3)]);
  }
  say('SkillCorner 按位置线：');
  say(Q.table(['线', 'n', 'corr 均值', 'min', 'max'], lr, [10, 6, 9, 8, 8]));
  say('');
  // 偏相关：把 cy 从 y_i 与 ballY 两边都回归掉，再取相关（去掉共享的 -cy 项）
  const partial = (s) => {
    const rY = residualize(s.y, s.cy);
    const rB = residualize(s.by, s.cy);
    const c = Q.corr(rY, rB);
    return Number.isFinite(c) ? c : null;
  };
  const rows2 = [];
  for (const ds of ['metrica', 'skillcorner', 'engine']) {
    const cs = []; const lines2 = { defence: [], midfield: [], attack: [] };
    for (const [key, { per }] of all) {
      if (!key.startsWith(ds + '|')) continue;
      for (const s of per.values()) {
        if (s.x.length < 300) continue;
        const c = partial(s);
        if (c == null) continue;
        cs.push(c);
        if (s.line && lines2[s.line]) lines2[s.line].push(c);
      }
    }
    if (!cs.length) continue;
    rows2.push([ds, cs.length, Q.fmt(Q.mean(cs), 3), Q.fmt(Math.sqrt(Q.variance(cs)), 3),
      Q.fmt(Q.mean(lines2.defence), 3), Q.fmt(Q.mean(lines2.midfield), 3), Q.fmt(Q.mean(lines2.attack), 3)]);
  }
  say('**偏相关** （扣掉全队平移）：\n');
  say(Q.table(['数据集', '人·场 n', '偏相关均值', 'sd', '后防', '中场', '锋线'], rows2, [12, 9, 11, 8, 8, 8, 8]));
}

// ── Q5d. 纵向推进事件：横向同步变化量 ───────────────────────────────────
// **必须做 Δt 归一**（这里踩过一个坑）：SkillCorner 的帧经过 `ballDet` 过滤后会**成片缺失**，
// 于是"相邻两条记录"的实际时间间隔并不恒等于采样间隔。用 `|Δy| 米/记录` 直接比较，
// 数字会随过滤策略（是否保留相位为 null 的帧）变化 45%（实测 0.157 vs 0.228 m）。
// 改成 **m/s**（除以真实 Δt）并把 Δt 上限卡在 0.4s（≈2 个源采样间隔），才是可比的物理量。
say('## Q5d. 纵向推进时横向实际动多少（用 **速度** 而非位移增量）\n');
say('取每个「人·场」序列的**相邻两条记录**，算横向速度 `|Δy| / Δt`（m/s）。');
say('只保留 `Δt ≤ 0.4s` 的对（SkillCorner 的 `ballDet` 过滤会造成成片缺帧，');
say('长间隔的对会把"慢漂移"与"抖动"混在一起——不做 Δt 归一的话数字会随过滤策略变 45%）。');
say('按纵向速度分桶：前跑 `Δx/Δt > 1.25 m/s`、静止 `|Δx|/Δt < 0.25 m/s`、后退 `Δx/Δt < −1.25`。');
say('同时剔除球位剧变对（`|Δ球y|/Δt > 2.5 m/s`），避免把"球转移导致全队横移"算进来。\n');
{
  const rows = [];
  for (const ds of ['metrica', 'skillcorner', 'engine']) {
    const fwd = []; const still = []; const back = []; const dts = [];
    for (const [key, { per }] of all) {
      if (!key.startsWith(`${ds}|`)) continue;
      for (const s of per.values()) {
        for (let i = 1; i < s.x.length; i += 1) {
          const dt = s.t[i] - s.t[i - 1];
          if (!(dt > 0) || dt > 0.4) continue;
          dts.push(dt);
          const vx = (s.x[i] - s.x[i - 1]) / dt;
          const vy = Math.abs(s.y[i] - s.y[i - 1]) / dt;
          const vby = Math.abs(s.by[i] - s.by[i - 1]) / dt;
          if (vby > 2.5) continue;
          if (vx > 1.25) fwd.push(vy);
          else if (Math.abs(vx) < 0.25) still.push(vy);
          else if (vx < -1.25) back.push(vy);
        }
      }
    }
    if (!fwd.length) continue;
    const q = (a, p) => Q.quantile([...a].sort((x, y) => x - y), p);
    rows.push([ds, Q.fmt(q(dts, 0.5), 2), fwd.length, Q.fmt(Q.mean(fwd), 3),
      still.length, Q.fmt(Q.mean(still), 3), Q.fmt(Q.mean(back), 3),
      Q.fmt(Q.mean(fwd) / (Q.mean(still) || 1), 2)]);
  }
  say(Q.table(['数据集', 'Δt 中位(s)', 'n(前跑)', '|vy| 前跑', 'n(静止)', '|vy| 静止', '|vy| 后退', '前跑/静止'],
    rows, [12, 10, 9, 9, 9, 9, 9, 9]));
  say('（单位 m/s。所有量都按真实 Δt 归一。）');
  say('');
  say('**读法**：`|vy| 前跑` vs `|vy| 静止` 的比值 → **纵向跑动时横向并不「额外」动**（比值 ≈1）');
  say('还是"跑起来才横move"（比值 >1）。**绝对值才是关键**：');
  say('真实即使"纵向不动"的帧，横向也在以 0.5–0.9 m/s 移动；引擎 0.00–0.01 m/s。');
}
say('');

writeFileSync(join(Q.OUT_DIR, '05-coupling.txt'), lines.join('\n'));
console.error('\n→ 已写入 out/05-coupling.txt');
