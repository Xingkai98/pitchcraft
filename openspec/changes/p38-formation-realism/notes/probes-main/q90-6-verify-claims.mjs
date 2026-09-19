// P38 #90 探针 6：**独立复核**——用**另一套聚合**重算 `real-lateral-laws.md` 的每条头号数字。
//
// **为什么必须另写一套**：若复核只是重跑同一个函数、复用同一份中间量，
// 它只能抓"报告抄错"，抓不到"探针本身算错"。本文件**不复用** `q90-*.mjs` 的任何聚合代码，
// 只复用 `q90-common.mjs` 的**装载**（口径层：镜像 / 朝向归一 / 相位 / 帧过滤）——
// 那是"两侧必须一致"的部分；**聚合全部重写**。
//
// 不一致即退出码 1。核对项与报告节号的对应关系写在每条的 label 里。
//
// 运行：node openspec/changes/p38-formation-realism/notes/probes-main/q90-6-verify-claims.mjs

import * as Q from './q90-common.mjs';

const P = Q.PITCH_WIDTH_M;
const ms = Q.loadReal();
const eng = await Q.loadEngineFrames({ seeds: [42, 1, 7] });

const fails = [];
const checks = [];
function claim(label, got, lo, hi, unit = '') {
  const ok = got >= lo && got <= hi;
  checks.push({ label, got, lo, hi, unit, ok });
  if (!ok) fails.push(`${label}: 实测 ${got.toFixed(3)}${unit}，报告区间 [${lo}, ${hi}]${unit}`);
}

// ── 独立实现：一次遍历建全部原始数组 ────────────────────────────────────
//
// **相位为 null 的帧要保留**（`phase: null`），只在**相位条件**的分析里过滤。
// 这是本项目探针的一个易错点：SkillCorner 有 ~11% 的帧 `possession.group` 为 null
// （实测 1874553：ballDet 18205 帧里只有 16166 帧有相位）。把"相位未知"当成
// "帧无效"会**静默丢掉 11% 的样本**，而且只影响那些碰巧不用相位的分析
// （如 §5.4 的纯运动学量），让两个本应一致的实现给出不同数字
// （实测 0.78 vs 1.14 m/s）。**运动学量不需要相位。**
function scan(m) {
  const perTeamFrame = []; // {team, phase|null, cy, by, t, ys, xs, ids}
  for (let i = 0; i < m.frames.length; i += 1) {
    const f = m.frames[i];
    if (!f.ball) continue;
    if (m.phase && m.phase.ballDet[i] !== 1) continue; // 球须真观测
    for (const team of ['home', 'away']) {
      const all = Q.framePlayers(m, f, team, { idx: i, includeExtrapolated: true });
      if (all.length < 7) continue;
      const ys = all.map((p) => p.y);
      perTeamFrame.push({
        team, phase: Q.phaseOf(m, f, team, i), ys, xs: all.map((p) => p.x), ids: all.map((p) => p.id),
        cy: ys.reduce((a, b) => a + b, 0) / ys.length,
        by: Q.ballYCanon(m, f, team, i),
        t: f.t,
        ballRawY: f.ball[1] * P,
      });
    }
  }
  return perTeamFrame;
}
const scanned = new Map();
for (const m of [...ms, ...eng]) scanned.set(`${m.dataset}|${m.id}`, { m, tf: scan(m) });

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const mu = mean(a); return Math.sqrt(mean(a.map((v) => (v - mu) ** 2))); };
const slope = (y, x) => {
  const mx = mean(x); const my = mean(y);
  let sxy = 0; let sxx = 0;
  for (let i = 0; i < x.length; i += 1) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; }
  return sxy / sxx;
};

// ── §1.1 球队重心 ~ 球 y 的斜率 ─────────────────────────────────────────
{
  const byDs = { metrica: [], skillcorner: [], engine: [] };
  for (const { m, tf } of scanned.values()) {
    for (const team of ['home', 'away']) {
      const r = tf.filter((v) => v.team === team);
      if (r.length < 300) continue;
      byDs[m.dataset].push(slope(r.map((v) => v.cy), r.map((v) => v.by)));
    }
  }
  claim('§1.1 Metrica 重心跟球斜率', mean(byDs.metrica), 0.30, 0.35);
  claim('§1.1 SkillCorner 重心跟球斜率', mean(byDs.skillcorner), 0.36, 0.41);
  claim('§1.1 引擎 重心跟球斜率', mean(byDs.engine), 0.025, 0.040);
}

// ── §1.5 球 y 的 q10–q90 跨度 ───────────────────────────────────────────
{
  for (const ds of ['metrica', 'skillcorner', 'engine']) {
    const spans = [];
    for (const { m, tf } of scanned.values()) {
      if (m.dataset !== ds) continue;
      const s = [...new Set(tf.map((v) => v.ballRawY))].sort((a, b) => a - b);
      if (s.length < 100) continue;
      spans.push(Q.quantile(s, 0.9) - Q.quantile(s, 0.1));
    }
    if (!spans.length) continue;
    const mu = mean(spans);
    if (ds === 'engine') claim('§1.5 引擎 球 y q10–q90', mu, 18, 24, 'm');
    else claim(`§1.5 ${ds} 球 y q10–q90`, mu, 50, 62, 'm');
  }
}

// ── §2.1 方差分解（独立重算，池化到队·场）──────────────────────────────
{
  const acc = { metrica: [], skillcorner: [], engine: [] };
  for (const { m, tf } of scanned.values()) {
    for (const team of ['home', 'away']) {
      // §2.1 是纯运动学量：**不按相位过滤**（与 q90-2 的 Q2a 一致）
      const fr = tf.filter((v) => v.team === team);
      if (fr.length < 300) continue;
      const flat = []; let it = 0; const dev = []; const devBy = new Map();
      for (const v of fr) { for (const y of v.ys) { flat.push(y); dev.push(y - v.cy); } }
      const mAll = mean(flat);
      const tot = mean(flat.map((v) => (v - mAll) ** 2));
      const IT = mean(fr.map((v) => (v.cy - mAll) ** 2));
      const DEV = mean(dev.map((v) => v ** 2));
      if (!(tot > 1e-9)) continue;
      // 静息档位：逐人在该队·场的 E[y − cy]
      for (const v of fr) v.ys.forEach((y, k) => {
        const id = v.ids[k];
        if (!devBy.has(id)) devBy.set(id, []);
        devBy.get(id).push(y - v.cy);
      });
      const rests = [...devBy.values()].map((a) => mean(a));
      const rest = mean(rests.map((r) => r ** 2));
      acc[m.dataset].push({ it: IT / tot, rest: rest / tot, wander: (DEV - rest) / tot });
      void it;
    }
  }
  for (const ds of Object.keys(acc)) {
    if (!acc[ds].length) continue;
    const mu = (k) => mean(acc[ds].map((v) => v[k])) * 100;
    claim(`§2.1 ${ds} 队伍层占比`, mu('it'), ds === 'engine' ? 0 : 25, ds === 'engine' ? 1 : 45, '%');
    claim(`§2.1 ${ds} 个体游走占比`, mu('wander'), ds === 'engine' ? 0 : 25, ds === 'engine' ? 1 : 50, '%');
  }
}

// ── §3.1 个体 y sd ──────────────────────────────────────────────────────
{
  const out = {};
  for (const { m, tf } of scanned.values()) {
    const per = new Map();
    for (const v of tf) v.ys.forEach((y, k) => {
      const key = `${v.team}|${v.ids[k]}`;
      if (!per.has(key)) per.set(key, []);
      per.get(key).push(y);
    });
    for (const arr of per.values()) {
      if (arr.length < 300) continue;
      (out[m.dataset] = out[m.dataset] || []).push(sd(arr));
    }
  }
  for (const ds of Object.keys(out)) {
    const mu = mean(out[ds]);
    // 引擎：本探针用 3 种子（60 人·场），报告 §3.1 的表用 1 种子（20 人·场）。
    // 逐种子 sd 差异大（0.43 / 0.45 / 0.70 / 0.76 / 1.14 …），故区间放到覆盖 3 种子。
    if (ds === 'engine') claim('§3.1 引擎 个体 y sd（3 种子）', mu, 0.5, 1.6, 'm');
    else claim(`§3.1 ${ds} 个体 y sd`, mu, 11.5, 13.5, 'm');
  }
}

// ── §4.1 相位宽度差（分球位档后平均）────────────────────────────────────
{
  const EDGES = [0, 1 / 5, 2 / 5, 3 / 5, 4 / 5, 1];
  for (const ds of ['metrica', 'skillcorner']) {
    const acc = EDGES.slice(0, -1).map(() => ({ o: [], p: [] }));
    for (const { m, tf } of scanned.values()) {
      if (m.dataset !== ds) continue;
      for (const v of tf) {
        if (v.phase == null) continue;
        const bi = Q.corpus.bucketIndex(v.by / P, EDGES);
        if (bi < 0) continue;
        const s = [...v.ys].sort((a, b) => a - b);
        (v.phase === 1 ? acc[bi].o : acc[bi].p).push(Q.quantile(s, 0.9) - Q.quantile(s, 0.1));
      }
    }
    const ds2 = acc.filter((a) => a.o.length > 200 && a.p.length > 200);
    const d = mean(ds2.map((a) => mean(a.o) - mean(a.p)));
    claim(`§4.1 ${ds} 控球−失球宽度`, d, 2, 6, 'm');
  }
}

// ── §5.2 逐人 y~x 斜率 ──────────────────────────────────────────────────
{
  const out = {};
  for (const { m, tf } of scanned.values()) {
    const per = new Map();
    for (const v of tf) {
      const key = `${v.team}|${v.ids.join(',')}`;
      if (!per.has(key)) per.set(key, { x: [], y: [] });
      const s = per.get(key);
      v.xs.forEach((x, k) => { s.x.push(x); s.y.push(v.ys[k]); });
    }
    for (const s of per.values()) {
      if (s.x.length < 300) continue;
      (out[m.dataset] = out[m.dataset] || []).push(slope(s.y, s.x));
    }
  }
  for (const ds of Object.keys(out)) {
    claim(`§5.2 ${ds} y~x 斜率均值`, Math.abs(mean(out[ds])), 0, 0.03);
  }
}

// ── §5.4 静止帧的横向速度 |vy|（m/s，Δt 归一）──────────────────────────
//
// **必须 Δt 归一**：SkillCorner 的 `ballDet` 过滤造成成片缺帧，"相邻两条记录"的
// 时间间隔不恒定。用「米/记录」比较会让数字随过滤策略变 45%（实测 0.157 vs 0.228 m）。
{
  const out = {};
  for (const { m, tf } of scanned.values()) {
    const per = new Map();
    for (const v of tf) v.ys.forEach((y, k) => {
      const key = `${v.team}|${v.ids[k]}`;
      if (!per.has(key)) per.set(key, { x: [], y: [], by: [], t: [] });
      const s = per.get(key);
      s.x.push(v.xs[k]); s.y.push(y); s.by.push(v.by); s.t.push(v.t);
    });
    for (const s of per.values()) {
      for (let i = 1; i < s.x.length; i += 1) {
        const dt = s.t[i] - s.t[i - 1];
        if (!(dt > 0) || dt > 0.4) continue;
        if (Math.abs(s.by[i] - s.by[i - 1]) / dt > 2.5) continue; // 球位剧变
        if (Math.abs(s.x[i] - s.x[i - 1]) / dt < 0.25) {
          (out[m.dataset] = out[m.dataset] || []).push(Math.abs(s.y[i] - s.y[i - 1]) / dt);
        }
      }
    }
  }
  for (const ds of Object.keys(out)) {
    const mu = mean(out[ds]);
    if (ds === 'engine') claim('§5.4 引擎 静止帧 横向速率', mu, 0, 0.05, 'm/s');
    else claim(`§5.4 ${ds} 静止帧 横向速率`, mu, 0.3, 1.3, 'm/s');
  }
}

// ── 输出 ────────────────────────────────────────────────────────────────
const width = Math.max(...checks.map((c) => c.label.length));
console.log('独立复核（另一套聚合实现，只共用装载口径）\n');
for (const c of checks) {
  console.log(`${c.ok ? '✅' : '❌'} ${c.label.padEnd(width)}  实测 ${c.got.toFixed(3)}${c.unit}`
    + `  报告区间 [${c.lo}, ${c.hi}]${c.unit}`);
}
console.log(`\n${checks.length - fails.length}/${checks.length} 通过`);
if (fails.length) {
  console.log('\n不符项：');
  for (const f of fails) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log('全部通过：报告的头号数字与独立聚合一致。');
}

