// wayfinder #101 探针 0：**口径声明 + 与 P38 #90 对账**。
//
// 为什么要先跑这个：#101 的每一条结论都要与 P38 #90（`real-lateral-laws.md`，6 场）
// 可比。若 20 场的口径与 6 场不同（外推采信、朝向归一、相位来源、样本过滤），
// 数字差异就分不清是"样本变大"还是"口径变了"。本探针把关键量**在 6 场子样本上**
// 复算一遍，与 P38 报告的区间对账；再给 20 场的值。
//
// 运行：node openspec/changes/p38-formation-realism/notes/probes-main/issue101-0-caliber.mjs
//
// 产出：out/101-0-caliber.txt

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as C from './issue101-common.mjs';
import * as Q from './q90-common.mjs';

const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };
mkdirSync(C.OUT_DIR, { recursive: true });

const P38_SUBSET = ['1874553', '1886347', '1899585', '1959846', '2007448', '2013725'];
const allIds = C.skillcorner20Ids();

say('# #101 探针 0：口径声明与对账\n');
say(`SkillCorner 转换成功场次：${allIds.length} 场（P38 #90 用了 6 场）`);
say(`P38 子样本在本次全量中：${P38_SUBSET.filter((i) => allIds.includes(i)).length}/6\n`);

// ── 口径声明（逐条打印，进报告直接引用）────────────────────────────────
say('## 口径声明\n');
say('| 项 | 取值 | 依据 |');
say('|---|---|---|');
say('| 外推点（is_detected=false） | **采信（全点口径）** | P38 #90 §0.2-1：跳过会按球位置系统性削掉队形两端 |');
say('| 横向朝向 | `yCanon`（半场换边 = 绕中心 180° 旋转） | P38 #90 §0.2-3 修掉的口径 bug |');
say('| y 轴 | `PITCH_WIDTH_M`（逐场，104/105/106×68 不折算） | P36 口径 |');
say('| 门将 | 剔除（`KEEPER_IDS`） | P36 口径 |');
say('| 每队非门将 < 7 人的帧 | 丢弃 | `MIN_OUTFIELD_PLAYERS`（match-metrics） |');
say('| 球 | 相位分析只用原始观测球帧（`ballDet===1`）；运动学量不过滤 | P38 #90 §0.2-5 |');
say('| 相位 | SkillCorner `possession.group` 源真值；**相位未知的帧（~11%）在运动学分析中保留** | P38 #90 §0.2-2/5 |');
say('| 聚合 | **逐场（逐「场·队·人」单元）算再平均**，绝不跨场拼接 | P38 #90 §4：拼接把 latSd 灌水 6.5× 且奖励 hack |');
say('| 采样 | 转换产物 5Hz（0.2s） | P36/P37 |');
say('');

// ── 对账 1：个体 y sd（全点、逐场逐人再平均）────────────────────────────
say('## 对账 1：个体横向位移 sd（整场口径）\n');
say('P38 #90 §3.1 报告：SkillCorner 6 场 **12.87m**（人·场 n=120）；Metrica 2 场 12.46m。\n');

function individualYSd(m) {
  // 逐「人·场」算 sd，再跨人平均（与 #90 同口径）。要求每人不低于 100 帧。
  const per = new Map();
  for (let i = 0; i < m.frames.length; i += 1) {
    const f = m.frames[i];
    for (const team of ['home', 'away']) {
      const ps = Q.framePlayers(m, f, team, { idx: i });
      for (const p of ps) {
        const key = `${team}|${p.id}`;
        if (!per.has(key)) per.set(key, []);
        per.get(key).push(p.y);
      }
    }
  }
  const sds = [];
  for (const arr of per.values()) if (arr.length >= 100) sds.push(C.std(arr));
  return { sd: C.mean(sds), n: sds.length };
}

const six = P38_SUBSET.filter((i) => allIds.includes(i)).map(C.loadSkillcorner);
const sixSd = six.map(individualYSd);
const all20 = allIds.map(C.loadSkillcorner);
const allSd = all20.map(individualYSd);

say(`| 样本 | 人·场 n | 个体 y sd 均值 |`);
say(`|---|---|---|`);
say(`| SkillCorner 6 场（P38 子样本） | ${sixSd.reduce((s, r) => s + r.n, 0)} | **${C.f2(C.mean(sixSd.map((r) => r.sd)))}m** |`);
say(`| SkillCorner 20 场 | ${allSd.reduce((s, r) => s + r.n, 0)} | **${C.f2(C.mean(allSd.map((r) => r.sd)))}m** |`);
const met = C.loadMetrica().map(individualYSd);
say(`| Metrica 2 场 | ${met.reduce((s, r) => s + r.n, 0)} | ${C.f2(C.mean(met.map((r) => r.sd)))}m |`);
say('');

// 逐场值（供报告核验离散度）
say('逐场个体 y sd（20 场）：');
say(all20.map((m, i) => `  ${m.id}: ${C.f2(allSd[i].sd)}m (n=${allSd[i].n})`).join('\n'));
say('');

// ── 对账 2：球队重心跟球斜率（逐场逐队再平均）────────────────────────────
say('## 对账 2：球队横向重心 cy ~ 球 y 的斜率\n');
say('P38 #90 §1.1 报告：SkillCorner 6 场斜率均值 **0.383**、R² 0.692；Metrica **0.326** / 0.589。\n');

function teamFollow(m) {
  const pairs = [];
  for (let i = 0; i < m.frames.length; i += 1) {
    const f = m.frames[i];
    if (!f.ball) continue;
    if (m.phase && m.phase.ballDet[i] !== 1) continue;
    for (const team of ['home', 'away']) {
      const ps = Q.framePlayers(m, f, team, { idx: i });
      if (ps.length < 7) continue;
      const by = Q.ballYCanon(m, f, team, i);
      if (by == null) continue;
      pairs.push({ key: `${m.id}|${team}`, x: by, y: C.mean(ps.map((p) => p.y)) });
    }
  }
  return pairs;
}

const pairs6 = six.flatMap(teamFollow);
const pairs20 = all20.flatMap(teamFollow);
const r6 = C.univariateByUnit(pairs6, 500);
const r20 = C.univariateByUnit(pairs20, 500);
const rMet = C.univariateByUnit(C.loadMetrica().flatMap(teamFollow), 500);

say('| 数据集 | 队·场 n | 斜率均值 | R² 均值 |');
say('|---|---|---|---|');
say(`| SkillCorner 6 场 | ${r6.units} | **${C.f2(r6.slope, 3)}** | ${C.f2(r6.r2, 3)} |`);
say(`| SkillCorner 20 场 | ${r20.units} | **${C.f2(r20.slope, 3)}** | ${C.f2(r20.r2, 3)} |`);
say(`| Metrica 2 场 | ${rMet.units} | ${C.f2(rMet.slope, 3)} | ${C.f2(rMet.r2, 3)} |`);
say('');

// ── 对账 3：球 y 的横向覆盖（q10-q90）───────────────────────────────────
say('## 对账 3：球 y 的 q10–q90 跨度\n');
say('P38 #90 §1.5 报告：SkillCorner 6 场均值 **57.6m**；Metrica 53.9/53.1m。\n');

function ballSpread(m) {
  const ys = [];
  for (let i = 0; i < m.frames.length; i += 1) {
    const f = m.frames[i];
    if (!f.ball) continue;
    if (m.phase && m.phase.ballDet[i] !== 1) continue;
    ys.push(Q.ballYCanon(m, f, 'home', i));
  }
  ys.sort((a, b) => a - b);
  return Q.quantile(ys, 0.9) - Q.quantile(ys, 0.1);
}
const spread6 = C.mean(six.map(ballSpread));
const spread20 = C.mean(all20.map(ballSpread));
say(`| 样本 | 球 y q10–q90 均值 |`);
say(`|---|---|`);
say(`| SkillCorner 6 场 | ${C.f2(spread6)}m |`);
say(`| SkillCorner 20 场 | **${C.f2(spread20)}m** |`);
say(`| Metrica 2 场 | ${C.f2(C.mean(C.loadMetrica().map(ballSpread)))}m |`);
say('');

// ── 对账 4：方差分解（队伍层 / 静息档位 / 个体游走）──────────────────────
say('## 对账 4：个体 y 的方差分解\n');
say('P38 #90 §2.1 报告 SkillCorner 6 场：队伍层 37.1% / 静息档位 34.0% / 个体游走 28.9%。\n');

function varianceDecomp(m) {
  const out = [];
  for (const team of ['home', 'away']) {
    // 逐帧 cy
    const devs = new Map(); // uid -> [y - cy]
    const cys = [];
    for (let i = 0; i < m.frames.length; i += 1) {
      const ps = Q.framePlayers(m, m.frames[i], team, { idx: i });
      if (ps.length < 7) continue;
      const cy = C.mean(ps.map((p) => p.y));
      cys.push(cy);
      for (const p of ps) {
        if (!devs.has(p.id)) devs.set(p.id, []);
        devs.get(p.id).push([p.y, cy]);
      }
    }
    if (cys.length < 200) continue;
    const grand = C.mean(cys);
    // 池化：Var = IT + DEV（交叉项恒 0）
    const it = C.mean(cys.map((c) => (c - grand) ** 2));
    const allDev = [];
    const perPlayerMeanDev = [];
    for (const arr of devs.values()) {
      let s = 0;
      for (const [y, cy] of arr) { s += y - cy; allDev.push(y - cy); }
      perPlayerMeanDev.push(s / arr.length);
    }
    const dev = C.mean(allDev.map((d) => d ** 2));
    const rest = C.mean(perPlayerMeanDev.map((d) => d ** 2));
    const walk = dev - rest;
    const tot = it + dev;
    out.push({ it: it / tot, rest: rest / tot, walk: walk / tot, var: tot });
  }
  return out;
}
const vd6 = six.flatMap(varianceDecomp);
const vd20 = all20.flatMap(varianceDecomp);
say(`| 样本 | 队·场 n | 队伍层（全队平移） | 静息档位（职责偏移） | 个体游走 | Var(y) m² |`);
say(`|---|---|---|---|---|---|`);
say(`| SkillCorner 6 场 | ${vd6.length} | ${C.f2(100 * C.mean(vd6.map((v) => v.it)), 1)}% | `
  + `${C.f2(100 * C.mean(vd6.map((v) => v.rest)), 1)}% | ${C.f2(100 * C.mean(vd6.map((v) => v.walk)), 1)}% | ${C.f2(C.mean(vd6.map((v) => v.var)))} |`);
say(`| SkillCorner 20 场 | ${vd20.length} | **${C.f2(100 * C.mean(vd20.map((v) => v.it)), 1)}%** | `
  + `**${C.f2(100 * C.mean(vd20.map((v) => v.rest)), 1)}%** | **${C.f2(100 * C.mean(vd20.map((v) => v.walk)), 1)}%** | ${C.f2(C.mean(vd20.map((v) => v.var)))} |`);
say('');

// ── 对账 5：静止帧横向速率（帧间量）─────────────────────────────────────
say('## 对账 5：静止帧的横向速率 |vy|（纵向速度 < 0.25 m/s 的帧对）\n');
say('P38 #90 §5.4 报告：SkillCorner **0.780 m/s**（Δt 中位 0.20s）。\n');

function stillLateral(m) {
  const out = [];
  for (const team of ['home', 'away']) {
    const per = new Map();
    for (let i = 0; i < m.frames.length; i += 1) {
      const f = m.frames[i];
      for (const p of Q.framePlayers(m, f, team, { idx: i })) {
        if (!per.has(p.id)) per.set(p.id, []);
        per.get(p.id).push([f.t, p.x, p.y]);
      }
    }
    for (const arr of per.values()) {
      for (let j = 1; j < arr.length; j += 1) {
        const [t0, x0, y0] = arr[j - 1]; const [t1, x1, y1] = arr[j];
        const dt = t1 - t0;
        if (dt <= 0 || dt > 0.5) continue; // 断帧
        const vx = (x1 - x0) / dt; const vy = (y1 - y0) / dt;
        if (Math.abs(vx) < 0.25) out.push(Math.abs(vy));
      }
    }
  }
  return out;
}
const st6 = six.flatMap(stillLateral);
const st20 = all20.flatMap(stillLateral);
say(`| 样本 | n 帧对 | 静止帧 \|vy\| 均值 |`);
say(`|---|---|---|`);
say(`| SkillCorner 6 场 | ${st6.length} | **${C.f2(C.mean(st6), 3)} m/s** |`);
say(`| SkillCorner 20 场 | ${st20.length} | **${C.f2(C.mean(st20), 3)} m/s** |`);
say(`| Metrica 2 场 | ${C.loadMetrica().flatMap(stillLateral).length} | ${C.f2(C.mean(C.loadMetrica().flatMap(stillLateral)), 3)} m/s |`);
say('');

// ── 对账汇总表 ─────────────────────────────────────────────────────────
say('## 对账汇总：20 场 vs P38 #90（6 场）\n');
say('| 量 | P38 #90（6 场） | 本次 6 场复算 | 本次 20 场 | 判定 |');
say('|---|---|---|---|---|');
const rows = [
  ['个体 y sd', '12.87m', `${C.f2(C.mean(sixSd.map((r) => r.sd)))}m`, `${C.f2(C.mean(allSd.map((r) => r.sd)))}m`],
  ['重心跟球斜率', '0.383', C.f2(r6.slope, 3), C.f2(r20.slope, 3)],
  ['重心跟球 R²', '0.692', C.f2(r6.r2, 3), C.f2(r20.r2, 3)],
  ['球 y q10-q90', '57.6m', `${C.f2(spread6)}m`, `${C.f2(spread20)}m`],
  ['队伍层占比', '37.1%', `${C.f2(100 * C.mean(vd6.map((v) => v.it)), 1)}%`, `${C.f2(100 * C.mean(vd20.map((v) => v.it)), 1)}%`],
  ['静息档位占比', '34.0%', `${C.f2(100 * C.mean(vd6.map((v) => v.rest)), 1)}%`, `${C.f2(100 * C.mean(vd20.map((v) => v.rest)), 1)}%`],
  ['个体游走占比', '28.9%', `${C.f2(100 * C.mean(vd6.map((v) => v.walk)), 1)}%`, `${C.f2(100 * C.mean(vd20.map((v) => v.walk)), 1)}%`],
  ['静止帧 |vy|', '0.780', `${C.f2(C.mean(st6), 3)}`, `${C.f2(C.mean(st20), 3)}`],
];
for (const [k, a, b, c] of rows) {
  const d = Math.abs(Number(String(b).replace('%', '').replace('m', '')) - Number(String(a).replace('%', '').replace('m', '')));
  const rel = d / Math.max(1e-9, Math.abs(Number(String(a).replace('%', '').replace('m', ''))));
  say(`| ${k} | ${a} | ${b} | **${c}** | ${rel < 0.15 ? '✅ 复现（<15%）' : rel < 0.3 ? '⚠ 有偏差' : '❌ 不复现'} |`);
}
say('');
say('> **对账判据**：本次 6 场复算与 P38 #90 报告值的相对偏差 <15% 视为口径一致。');
say('> 若某量不复现，则该量在 20 场上的数字不能与 #90 直接比较，须在报告中标注。');

writeFileSync(join(C.OUT_DIR, '101-0-caliber.txt'), lines.join('\n'));
console.log(`\n→ ${join(C.OUT_DIR, '101-0-caliber.txt')}`);
