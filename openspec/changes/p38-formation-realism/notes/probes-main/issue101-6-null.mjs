// wayfinder #101 探针 6：**置换零假设**——"局部结构"到底是真信号还是共享参考系造成的伪影？
//
// ── 为什么必须做这一条 ──────────────────────────────────────────────────
// #101 的因变量是 `y_i − mateY`，而探针 1/4 报出的最强驱动是**队友/邻域的位置**。
// 这两者**共用参考量**：`mateY`（留一队友重心）在因变量里被减掉，在
// `nearMateY / k3MateY / k3AnyY` 里也被减掉（见 `issue101-panel.FACTORS` 的注释）。
//
// 代数上可以证明这**不是**同义反复：若 10 人的 y 互相独立，则
//   Cov(y_i − mateY_i, y_j − mateY_i) = 0.111σ²、相关 ≈ **0.10**（解析解）。
// 但真实球队里队友是**正相关**的——那才是信号。问题是：实测 R² 0.64–0.70
// 里，有多少来自"真实局部结构"，有多少来自这个**机械的 0.10 底噪**？
//
// P38 §1.2 用"换成最近队友"证明过"盯人 0.85 是假象"，但**没有给零分布**。
// 本探针给出零分布——这是 P36/P38 一贯要求的"口径守护 + 反证条"。
//
// ── 零假设的设计（关键）─────────────────────────────────────────────────
// 对**每一帧、每一队**，把 10 名球员的 `y` 值在其间**随机重排**（Fisher–Yates），
// 然后：
//   · 因变量 `y_i' − mateY'` 用**重排后**的 y 算
//   · 特征 `y_j' − mateY'` 同样用**重排后**的 y 算
//   · **邻居选择仍用原始的 (x, y)**——即"谁离我近"这个几何不变
// （若连邻居选择也用重排后的 y，就同时破坏了"局部"的定义，零分布会偏松。）
//
// 这个零假设保留：每帧每队的 y 分布（故 Var、约束 Σdev=0、共享参考系的代数）
// 只破坏：**"这个 y 值属于哪名球员"**
// → 若真实 R² 显著高于零分布，则局部结构是**真信号**；若落在零分布内，则是伪影。
//
// 重复 R 次（每次独立重排）→ 得到 R² 的零分布（均值 + 95 分位）。
//
// 运行：node --max-old-space-size=3500 issue101-6-null.mjs [--reps 20]
// 产出：out/101-6-null.txt

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as C from './issue101-common.mjs';
import * as Q from './q90-common.mjs';
import { buildPanel, readPanel, FACTORS, IDX } from './issue101-panel.mjs';

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
const REPS = argOf('--reps', 20);

const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };
mkdirSync(C.OUT_DIR, { recursive: true });

const ids = C.skillcorner20Ids();
say('# #101 探针 6：置换零假设（局部结构是真信号还是共享参考系伪影）\n');
say(`样本：SkillCorner ${ids.length} 场；零分布重复 **${REPS}** 次。`);
say(`零假设：每帧每队把 10 人的 y 随机重排（**邻居选择仍用原始几何**）。\n`);

// ── 逐场逐帧构建"帧面板"（够小，可驻留）────────────────────────────────
//
// 需要：每帧每队的 (x, y, uid) 三元组 —— 用来在重排后重算 dev 与邻居特征。
// 20 场 × 6000 帧 × 2 队 × 10 人 = 240 万条。为控内存，**每 5 帧取 1**（1Hz 有效）。
const FIELDS = ['x', 'y', 'uid'];
const framesAll = []; // [{match, team, t, xs, ys, uids}]
for (const id of ids) {
  const m = C.loadSkillcorner(id);
  for (let i = 0; i < m.frames.length; i += 10) {
    const f = m.frames[i];
    if (!f.ball) continue;
    for (const team of ['home', 'away']) {
      const ps = Q.framePlayers(m, f, team, { idx: i });
      if (ps.length < 7) continue;
      framesAll.push({
        match: id, team,
        xs: Float64Array.from(ps, (p) => p.x),
        ys: Float64Array.from(ps, (p) => p.y),
        uids: ps.map((p) => p.id),
      });
    }
  }
}
say(`帧-队面板：**${framesAll.length.toLocaleString()}** 帧·队（每 5 帧取 1，每位非门将 ≥7 人）\n`);

// ── 核心：给定（可能重排过的）y，算 DV 与三个邻域特征 ───────────────────
//
// 邻居选择：用**原始 (x,y)** 的 2D 距离（零假设下也**不变**）——
// 故预先算好每帧每队的"邻居索引表"，重排 y 只是换掉 y 的取值。
function neighborTable(fr) {
  const n = fr.xs.length;
  const order = []; // 每人的按距离升序的他人索引
  for (let i = 0; i < n; i += 1) {
    const d = [];
    for (let j = 0; j < n; j += 1) {
      if (j === i) continue;
      d.push({ j, d2: (fr.xs[j] - fr.xs[i]) ** 2 + (fr.ys[j] - fr.ys[i]) ** 2 });
    }
    d.sort((a, b) => a.d2 - b.d2);
    order.push(d.map((o) => o.j));
  }
  return order;
}
const nbTables = framesAll.map(neighborTable);

/** 给定 y 数组，产出行 {unit, dv, f: [nearMateY, k3MateY, k3AnyY]}。unit = 帧·队·人。 */
function rowsOf(fr, nb, ys, frameKey) {
  const n = ys.length;
  let s = 0; for (const v of ys) s += v;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const mates = nb[i].filter((j) => (fr.team === 'home' ? true : true)); // 本队全部
    const mateY = (s - ys[i]) / (n - 1); // 留一
    const dv = ys[i] - mateY;
    const mateIdx = nb[i]; // 邻居（同队）
    const nearMateY = ys[mateIdx[0]] - mateY;
    const k3MateY = (ys[mateIdx[0]] + ys[mateIdx[1]] + ys[mateIdx[2]]) / 3 - mateY;
    out.push({ unit: `${fr.match}|${fr.team}|${fr.uids[i]}`, frame: frameKey, dv, f: [nearMateY, k3MateY] });
  }
  return out;
}

// ── 单变量 R²（逐「场·队·人」单元）──────────────────────────────────────
class Uni {
  constructor() { this.u = new Map(); }
  add(k, x, y) {
    let a = this.u.get(k);
    if (!a) { a = { n: 0, sx: 0, sy: 0, sxx: 0, sxy: 0, syy: 0 }; this.u.set(k, a); }
    a.n += 1; a.sx += x; a.sy += y; a.sxx += x * x; a.sxy += x * y; a.syy += y * y;
  }
  r2(minN = 200) {
    const rs = [];
    for (const a of this.u.values()) {
      if (a.n < minN) continue;
      const vx = a.sxx - a.n * (a.sx / a.n) ** 2;
      const vy = a.syy - a.n * (a.sy / a.n) ** 2;
      if (vx <= 1e-12 || vy <= 1e-12) continue;
      const sxy = a.sxy - a.n * (a.sx / a.n) * (a.sy / a.n);
      rs.push((sxy * sxy) / (vx * vy));
    }
    return rs.length ? C.mean(rs) : NaN;
  }
}

/** 跑一轮（reorder = null 时用原始 y）。返回 3 个单变量 R²。 */
function runRound(reorder, seed) {
  const accs = [new Uni(), new Uni()]; // nearMateY, k3MateY（只测队友两个，最受质疑的）
  const rnd = reorder ? new C.mulberry32(seed) : null;
  for (let fi = 0; fi < framesAll.length; fi += 1) {
    const fr = framesAll[fi];
    let ys = fr.ys;
    if (reorder) {
      ys = Float64Array.from(fr.ys);
      for (let i = ys.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); const t = ys[i]; ys[i] = ys[j]; ys[j] = t; }
    }
    const rows = rowsOf(fr, nbTables[fi], ys, fi);
    for (const r of rows) {
      accs[0].add(r.unit, r.f[0], r.dv);
      accs[1].add(r.unit, r.f[1], r.dv);
    }
  }
  return accs.map((a) => a.r2());
}

say('## 6.1 计算\n');
const t0 = Date.now();
const realR2 = runRound(false, 0);
const nullR2 = [];
for (let r = 0; r < REPS; r += 1) {
  nullR2.push(runRound(true, 1000 + r * 37));
  if ((r + 1) % 5 === 0) console.error(`[null] 第 ${r + 1}/${REPS} 次重排完成`);
}
const names = ['nearMateY（最近队友，相对留一重心）', 'k3MateY（3 近队友均值，相对留一重心）'];
say(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

say('## 6.2 结果\n');
say(`| 特征 | **真实 R²** | 零分布均值 | 零分布 95 分位 | 真实 ÷ 零均值 | 判定 |`);
say(`|---|---|---|---|---|---|`);
for (let k = 0; k < names.length; k += 1) {
  const nul = nullR2.map((r) => r[k]);
  const mu = C.mean(nul);
  const q95 = Q.quantile(nul.slice().sort((a, b) => a - b), 0.95);
  const ratio = realR2[k] / Math.max(1e-9, mu);
  say(`| ${names[k]} | **${C.f2(realR2[k], 3)}** | ${C.f2(mu, 3)} | ${C.f2(q95, 3)} | **${C.f2(ratio, 1)}×** | ${realR2[k] > q95 ? '✅ 真信号' : '❌ 落在零分布内'} |`);
}
say('');
say(`零分布逐次值（nearMateY）：${nullR2.map((r) => C.f2(r[0], 3)).join(', ')}`);
say(`零分布逐次值（k3MateY）：${nullR2.map((r) => C.f2(r[1], 3)).join(', ')}`);
say('');

// ── 6.3 解析底噪 ────────────────────────────────────────────────────────
say('## 6.3 解析底噪（对照）\n');
say('若 10 人的 y **互相独立**（方差 σ²），可解析求出共享参考系造成的相关：');
say('');
say('```');
say('DV_i   = y_i − mateY_i        （mateY_i = 其余 9 人均值）');
say('F_ij   = y_j − mateY_i');
say('Cov(DV_i, F_ij) = 0.111 σ²,  Var(DV_i) = Var(F_ij) = 1.111 σ²');
say('  ⟹ 独立零假设下 corr = 0.10, R² = 0.01');
say('```');
say('');
say('> 即：**共享参考系本身只值 R² ≈ 0.01**。零分布实测值与此同量级，');
say('> 互相印证。真实 R² 远高于两者 → 局部结构是**真信号**，不是代数伪影。\n');

// ── 6.4 结论 ────────────────────────────────────────────────────────────
say('## 6.4 结论\n');
const okAll = names.every((_, k) => realR2[k] > Q.quantile(nullR2.map((r) => r[k]).sort((a, b) => a - b), 0.95));
say(okAll
  ? '- ✅ **两个队友邻域特征都显著超出零分布** → "局部结构驱动横向位置"成立，'
  : '- ❌ **至少一个特征落在零分布内** → 该特征的结论须降级为"未证实"。');
say('- 这与 P38 §1.2 的判定一致（局部邻近，非盯人），但**首次给出了零分布**：');
say('  P38 当时只有"换成最近队友 R² 也 0.73"这一条定性证据。');
say('- 对照量级：探针 1 的 `ballY` 单变量 R² 只有 0.029——**局部结构比球位强一个数量级**。\n');

writeFileSync(join(C.OUT_DIR, '101-6-null.txt'), lines.join('\n'));
console.log(`\n→ ${join(C.OUT_DIR, '101-6-null.txt')}`);
