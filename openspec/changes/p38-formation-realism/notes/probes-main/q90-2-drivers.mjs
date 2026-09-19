// P38 #90 探针 2：**个体横向移动由什么驱动**（Q2）。
//
// ── 为什么先做方差分解（Q2a）再做回归排序（Q2b）────────────────────────
//
// "个体 y 由什么驱动"最容易踩的坑是**循环定义**：若用"本队重心"当自变量或基准，
// 而重心又是由这批人的 y 算出来的，模型就能精确重构出因变量（首版实测全模型 R²=100%、
// 其余因子 unique R² 全 0——纯泄漏）。
//
// 本探针的做法：
//   1. 所有"队友侧"的量一律**留一法**（不含本人）：`mateY = 其余 9 人 y 均值`。
//   2. 方差分解把个体 y 的总方差拆成三层，**层与层之间无泄漏**：
//        Var(y_i) = Var(cy)  +  Var(y_i − cy)            （cy = 含本人的 10 人均值，
//                                                          这两项恰好正交，见文末代数证明）
//     再把 Var(y_i − cy) 拆成：
//        「静息档位」（该球员整场平均 y − 全队平均 cy：**位置/职责的固定偏移**）
//        「时刻波动」（逐帧 dev 减去自己的均值：**个体在职责附近的游走**）
//     这直接回答："个体的横向移动里，多少只是全队平移、多少是他自己的位置职责、
//     多少是他真正在跑"。
//   3. 回归排序时，因变量与自变量**不共用**任何构造项：
//        DV_team  = 本队 cy（10 人均值）    ← 队伍层
//        DV_dev   = y_i − mateY（留一）     ← 个体层；自变量里**不含**任何队友项
//
// 运行：node openspec/changes/p38-formation-realism/notes/probes-main/q90-2-drivers.mjs

import * as Q from './q90-common.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const P = Q.PITCH_WIDTH_M;
const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };

const ms = Q.loadReal();
const eng = await Q.loadEngineFrames({ seeds: [42, 1] });
say(`样本：Metrica 2 场 + SkillCorner 6 场；引擎 2 种子（5400s，5Hz）作对照\n`);

// ── 逐场逐队逐人：收集纵向面板 ──────────────────────────────────────────
//
// 每人一条记录数组：[y_i, cy(含本人10人均值), mateY(留一), ballY, oppY, nearOppY, ownX, phase]
function collect(m) {
  const per = new Map(); // key `${team}|${id}` -> { team, id, line, rows: [] }
  for (let i = 0; i < m.frames.length; i += 1) {
    const f = m.frames[i];
    if (!f.ball) continue;
    if (m.phase && m.phase.ballDet[i] !== 1) continue;
    for (const team of ['home', 'away']) {
      const by = Q.ballYCanon(m, f, team, i);
      const mine = Q.framePlayers(m, f, team, { idx: i, includeExtrapolated: true });
      if (mine.length < 7) continue;
      const theirs = Q.frameOpponents(m, f, team, { idx: i, includeExtrapolated: true });
      const cy = Q.mean(mine.map((p) => p.y));
      const oppY = theirs.length ? Q.mean(theirs.map((p) => p.y)) : null;
      // ⚠ 相位为 null 的帧**保留**（SkillCorner 有 ~11% 的帧源里没有 possession.group）。
      // Q2a 的方差分解是纯运动学量、不需要相位；把'相位未知'当'帧无效'会静默丢 11% 样本。
      const ph = Q.phaseOf(m, f, team, i);
      for (const p of mine) {
        const mates = mine.filter((q) => q.id !== p.id);
        const mateY = Q.mean(mates.map((q) => q.y));
        let near = null;
        for (const q of theirs) {
          const d = Math.hypot(q.x - p.x, q.y - p.y);
          if (!near || d < near.d) near = { d, y: q.y };
        }
        const key = `${team}|${p.id}`;
        if (!per.has(key)) per.set(key, { team, id: p.id, line: p.line, rows: [] });
        per.get(key).rows.push({
          y: p.y, cy, mateY, ballY: by,
          oppY: oppY ?? by, nearOppY: near ? near.y : (oppY ?? by),
          ownX: p.x, phase: ph,
        });
      }
    }
  }
  return per;
}

const all = new Map(); // matchKey -> Map
for (const m of [...ms, ...eng]) all.set(`${m.dataset}|${m.id}`, { m, per: collect(m) });

// ── Q2a. 方差分解（池化到「队·场」，玩家×时刻）──────────────────────────
//
// **为什么必须池化到队·场而不是"逐人算再取平均"**（踩过的坑）：逐人算时
// `Var(y_i) = Var(cy) + Var(y_i − cy)` **不成立**（cy 含本人，两项不正交，
// 实测引擎出现 24239% 这种荒谬值）。正确做法是在**同一队·场**内对
// **全体非门将 × 全部时刻**池化：
//
//   Var_pooled(y) = IT + DEV
//   IT  = E_t[(cy_t − ȳ)²]              ← 队伍层：全队整体横移（无泄漏，逐帧共享量）
//   DEV = E_{i,t}[(y_it − cy_t)²]       ← 个体层总量
//   交叉项 = 0（因为每帧 Σ_i (y_it − cy_t) = 0，代数上恒成立）
//
// 再把 DEV 拆成两项（也是精确正交，因每人的 E_t[y_it − cy_t] 的残差均值为 0）：
//   静息档位 = E_i[(ȳ_i − ȳ)²]                        ← 位置/职责的固定横向偏移
//   个体游走 = E_{i,t}[((y_it − cy_t) − (ȳ_i − ȳ))²]  ← 职责附近的实际跑动
say('## Q2a. 个体 y 的方差分解：全队平移 / 位置职责 / 个体游走\n');
say('在**每个「队·场」**内对「全体非门将 × 全部时刻」池化（不是逐人算再平均——逐人算时');
say('两项不正交，会出荒谬值）：\n');
say('```');
say('Var_pooled(y)  =  队伍层 IT  +  个体层 DEV');
say('  IT  = E_t[(cy_t − ȳ)²]              ← 全队随球的整体横移（逐帧共享量）');
say('  DEV = E_{i,t}[(y_it − cy_t)²]       ← 此刻相对全队重心在哪');
say('DEV            =  静息档位  +  个体游走');
say('  静息档位 = E_i[(ȳ_i − ȳ)²]          ← 位置/职责的固定横向偏移（整场不变）');
say('  个体游走 = 其余                      ← 职责附近的实际跑动');
say('```\n');
say('代数上交叉项恒为 0（每帧 Σ_i (y_it − cy_t) = 0）。三列 = 各层占 Var_pooled(y) 的百分比。\n');
{
  const acc = new Map(); // ds -> {team:[], rest:[], wander:[], tot:[]}
  for (const [key, { m, per }] of all) {
    const ds = m.dataset;
    if (!acc.has(ds)) acc.set(ds, { team: [], rest: [], wander: [], tot: [], npl: [] });
    const A = acc.get(ds);
    // 按队·场池化：[{y_it}] 与逐帧 cy_t
    for (const team of ['home', 'away']) {
      const series = new Map(); // id -> [y]
      const cyT = [];
      // 用第一个人的行数当帧数基准（同一队所有人行数一致）
      const ids = [...per.entries()].filter(([k, v]) => v.team === team && v.rows.length >= 300)
        .map(([k, v]) => v);
      if (ids.length < 7) continue;
      const n = Math.min(...ids.map((v) => v.rows.length));
      for (const v of ids) {
        series.set(v.id, v.rows.slice(0, n).map((r) => r.y));
        if (!cyT.length) for (let t = 0; t < n; t += 1) cyT.push(v.rows[t].cy);
      }
      const allY = []; const ybarBy = [];
      for (const ys of series.values()) { allY.push(...ys); ybarBy.push(Q.mean(ys)); }
      const ybar = Q.mean(allY);
      const tot = Q.variance(allY);
      if (!(tot > 1e-9)) continue;
      const IT = Q.mean(cyT.map((c) => (c - ybar) ** 2));
      const DEV = Q.mean(allY.map((v) => v ** 2)) * 0 + (() => {
        let s = 0; let k = 0;
        for (const ys of series.values()) for (let t = 0; t < n; t += 1) { s += (ys[t] - cyT[t]) ** 2; k += 1; }
        return s / k;
      })();
      const rest = Q.mean(ybarBy.map((b) => (b - ybar) ** 2));
      const wander = Math.max(0, DEV - rest);
      A.team.push(IT / tot); A.rest.push(rest / tot); A.wander.push(wander / tot);
      A.tot.push(tot); A.npl.push(series.size);
      // 自检：IT + DEV 应与 tot 相等（相对误差 < 1e-6）
      const rel = Math.abs((IT + DEV) - tot) / tot;
      if (rel > 1e-6) console.error(`⚠ 分解恒等式失配 ${key} ${team} rel=${rel}`);
    }
  }
  const table = [];
  for (const [ds, A] of acc) {
    if (!A.team.length) continue;
    table.push([ds, A.team.length,
      `${Q.fmt(100 * Q.mean(A.team), 1)}%`,
      `${Q.fmt(100 * Q.mean(A.rest), 1)}%`,
      `${Q.fmt(100 * Q.mean(A.wander), 1)}%`,
      Q.fmt(Q.mean(A.tot), 1)]);
  }
  say(Q.table(['数据集', '人·场 n', '队伍层(全队平移)', '静息档位(职责偏移)', '个体游走',
    'Var(y) m²'], table, [12, 9, 16, 17, 10, 9]));
  say('');
  say('**读法**：真实球员的横向方差在三个来源上**大体均分**——');
  say('队伍整体平移 **28–37%**、位置/职责的固定档位 **29–34%**、个体在职责附近的游走 **29–43%**。');
  say('即：横向移动**既**是全队平移、**也**是位置分工、**也**是逐帧的跑动，三者都不可省。');
  say('');
  say('⚠ **本表在修正半场朝向前是错的**：未修正时"个体游走"被虚高到 52–65%、"静息档位"被压到 4%。');
  say('原因是半场换边把每名球员的 y 搬到球场另一侧，那部分位移被记成了他的"跑动"。');
  say('修正（`yCanon`，见 `00-caliber.txt` §3b）后才三足鼎立。**这是本票据对既有结论的实质修正。**');
  say('');
  say('引擎侧仍是另一个极端：**静息档位 99.4%**、队伍层 0.2%、个体游走 0.5%——');
  say('引擎球员的 y 几乎是一整场不变的常数（只有模板 base.y 的固定档位）。');
  say('**这不等于"引擎没有位置分工"**：99.4% 说明它的分工是**绝对静态**的；');
  say('真实的分工只占约 1/3，另 2/3 是动态的。差别在"动态"而非"有没有分区"。');
}
say('');

// ── Q2b. 因子解释力排序 ─────────────────────────────────────────────────
const PRED = ['ballY', 'mateY', 'oppY', 'nearOppY', 'ownX', 'phase'];
// 个体层模型的自变量（**不含任何队友项**——DV 已用 mateY 做基准，再放队友项会引入共享项）。
const PRED_DEV = ['ballY', 'oppY', 'nearOppY', 'ownX', 'phase'];

// 一次性预算好自变量矩阵常量（避免重复分配）。
// ⚠ 相位为 null 的行在这里剔除（回归需要数值相位）。Q2a 的方差分解**不**走这条路，
// 故它保留全部帧；两者样本量不同是**有意为之**，不是口径分叉。
function fitOne(rsIn, dvFn, preds) {
  const rs = rsIn.filter((r) => r.phase != null);
  const y = rs.map(dvFn);
  const X = preds.map((p) => rs.map((r) => r[p]));
  const full = Q.ols(y, X);
  if (!full) return null;
  const sdY = Math.sqrt(Q.variance(y));
  const alone = {}; const unique = {}; const beta = {};
  for (let k = 0; k < preds.length; k += 1) {
    const r1 = Q.ols(y, [X[k]]);
    alone[preds[k]] = r1 ? r1.r2 : null;
    const rw = Q.ols(y, preds.map((_, j) => j).filter((j) => j !== k).map((j) => X[j]));
    unique[preds[k]] = rw ? Math.max(0, full.r2 - rw.r2) : null;
    const sdX = Math.sqrt(Q.variance(X[k]));
    beta[preds[k]] = sdY > 0 ? full.b[k + 1] * sdX / sdY : null;
  }
  // 自变量两两相关（暴露"代理"关系：如近端对手与球位高度共线）
  const cm = [];
  for (let a = 0; a < preds.length; a += 1) {
    for (let b = a + 1; b < preds.length; b += 1) cm.push([`${preds[a]}~${preds[b]}`, Q.corr(X[a], X[b])]);
  }
  return { n: rs.length, r2: full.r2, alone, unique, beta, cm, sdY };
}

say('## Q2b. 因子解释力排序（逐「人·场」回归，跨人取均值）\n');
say('**两层各用一套不泄漏的构造**（这是本探针最容易出错的地方）：\n');
say('- 队伍层（DV = 队重心 cy）：观测单位是**帧**（每队·场一批 (cy, ballY, oppY, phase, meanX)），');
say('  自变量**不含任何队友均值**——`mateY` 与 cy 在代数上几乎重合（cy = (9·mateY+y_i)/10），');
say('  放进去会得到 R²≈99% 的退化模型（首版实测）。');
say('- 个体层（DV = y_i − mateY，mateY 留一）：观测单位是**人·帧**，自变量不含队友项。\n');

// 队伍层：帧级观测
function runTeamModels(dsFilter) {
  const out = [];
  for (const [key, { m, per }] of all) {
    if (!key.startsWith(dsFilter)) continue;
    for (const team of ['home', 'away']) {
      const rows = [];
      const ids = [...per.values()].filter((v) => v.team === team && v.rows.length >= 300);
      if (ids.length < 7) continue;
      const n = Math.min(...ids.map((v) => v.rows.length));
      for (let t = 0; t < n; t += 1) {
        const src = ids[0].rows[t];
        rows.push({
          cy: src.cy, ballY: src.ballY, oppY: src.oppY, phase: src.phase,
          ownX: src.ownX, // 该帧该球员的 x；下面换成本队平均 x
        });
      }
      // 本队平均 x（球侧/前后位置）
      for (let t = 0; t < n; t += 1) {
        let s = 0;
        for (const v of ids) s += v.rows[t].ownX;
        rows[t].xTeam = s / ids.length;
      }
      const rec = fitOne(rows, (r) => r.cy, ['ballY', 'oppY', 'phase', 'xTeam']);
      if (rec) out.push({ ds: m.dataset, match: m.id, team, ...rec });
    }
  }
  return out;
}

function runModels(dsFilter) {
  const out = [];
  for (const [key, { m, per }] of all) {
    if (!key.startsWith(dsFilter)) continue;
    for (const { rows: rs } of per.values()) {
      if (rs.length < 300) continue;
      const rec = fitOne(rs, (r) => r.y - r.mateY, PRED_DEV);
      if (rec) out.push({ ds: m.dataset, match: m.id, ...rec });
    }
  }
  return out;
}

function showRank(recs, label, preds) {
  const rows = preds.map((p) => {
    const g = (k) => recs.map((r) => r[k][p]).filter((v) => v != null);
    const al = g('alone'); const un = g('unique'); const be = g('beta');
    return [p, al.length, Q.fmt(100 * Q.mean(al), 1), Q.fmt(100 * Q.mean(un), 1),
      Q.fmt(Q.mean(be), 3), Q.fmt(Math.min(...be), 2), Q.fmt(Math.max(...be), 2)];
  });
  const r2 = Q.mean(recs.map((r) => r.r2));
  say(`**${label}**（n=${recs.length} 人·场，全模型 R² 均值 ${Q.fmt(100 * r2, 1)}%）`);
  say(Q.table(['因子', 'n', 'alone R²%', 'unique R²%', 'β 均值', 'β min', 'β max'],
    rows, [11, 5, 10, 11, 8, 7, 7]));
  const order = [...rows].sort((a, b) => Number(b[3]) - Number(a[3]));
  say(`  排序（unique R² 降序）：${order.map((r) => `${r[0]} ${r[3]}%`).join(' > ')}`);
  say('');
}

const teamPreds = ['ballY', 'oppY', 'phase', 'xTeam'];
const devPreds = PRED_DEV;
say('### 队伍层：DV = 本队重心 cy（米）\n');
say('⚠ **先说清这张表能读什么**：`ballY` 与 `oppY` 高度共线（r = 0.83），');
say('而"两队横向重心近乎锁定"是**数据结构本身**——实测两队的 cy 在**绝对**坐标下');
say('相关系数 **−0.87 ~ −0.98**（一队向左、另一队必向右），转到同朝向后接近 +1。');
say('故 `oppY` 在排序里领先，主要说明"两队在横向上一体移动"，');
say('**不代表它是一条独立的因果通道**（共线下"谁排第一"由最后加入的顺序决定）。');
say('可读的是"全模型 R² 有多高"（真实 81–94%）与"ballY 单独有多少"（alone R² 见下）。\n');
showRank(runTeamModels('skillcorner|'), 'SkillCorner', teamPreds);
showRank(runTeamModels('metrica|'), 'Metrica', teamPreds);
showRank(runTeamModels('engine|'), '引擎', teamPreds);
// 被解释的方差有多大？同一个 R² 在 0.5m 与 10m 的方差上含义完全不同。
{
  const rows = [];
  for (const ds of ['metrica', 'skillcorner', 'engine']) {
    const cys = [];
    for (const [key, { per }] of all) {
      if (!key.startsWith(`${ds}|`)) continue;
      for (const v of per.values()) for (const r of v.rows) cys.push(r.cy);
    }
    if (!cys.length) continue;
    const s = [...cys].sort((a, b) => a - b);
    rows.push([ds, cys.length, Q.fmt(Q.mean(cys), 1), Q.fmt(Math.sqrt(Q.variance(cys)), 2),
      Q.fmt(Q.quantile(s, 0.9) - Q.quantile(s, 0.1), 2)]);
  }
  say('被解释的方差有多大（同一个 R² 在 0.5m 与 10m 的方差上含义完全不同）：\n');
  say(Q.table(['数据集', 'n 队·帧', 'cy 均值(m)', 'cy sd(m)', 'cy q10–q90(m)'], rows, [12, 10, 10, 9, 12]));
  say('');
}

say('### 个体层：DV = y_i − 其余 9 人重心（米）——"他相对队友在哪"\n');
showRank(runModels('skillcorner|'), 'SkillCorner', devPreds);
showRank(runModels('metrica|'), 'Metrica', devPreds);
showRank(runModels('engine|'), '引擎', devPreds);

// ── Q2c. 自变量相关矩阵（暴露代理关系）─────────────────────────────────
say('## Q2c. 自变量之间的相关（SkillCorner，全员逐帧池化）\n');
say('**为什么必须看**：nearOppY（最近对手的 y）与球位高度共线——');
say('"最近对手"通常就是贴着球的那个防守人。若不看相关矩阵，会把"球位"的效应误记到"对手"头上。\n');
{
  const pools = [];
  for (const [key, { per }] of all) {
    if (!key.startsWith('skillcorner|')) continue;
    for (const { rows: rs } of per.values()) pools.push(...rs);
  }
  const names = ['ballY', 'mateY', 'oppY', 'nearOppY', 'ownX', 'phase'];
  const hdr = ['', ...names];
  const rows = names.map((a) => [a, ...names.map((b) => (a === b ? '1.00' : Q.fmt(Q.corr(pools.map((r) => r[a]), pools.map((r) => r[b])), 2)))]);
  say(Q.table(hdr, rows, [10, 7, 7, 7, 9, 7, 7]));
  say('');
  // 条件检验：把 nearOppY 换成"球位残差化的 nearOppY"后，它的 unique R² 还剩多少
  const y = pools.map((r) => r.y);
  const ballOnly = Q.ols(y, [pools.map((r) => r.ballY)]);
  const resid = y.map((v, i) => v - (ballOnly.b[0] + ballOnly.b[1] * pools[i].ballY));
  const nearResid = (() => {
    const rb = Q.uni(pools.map((r) => r.nearOppY), pools.map((r) => r.ballY));
    return pools.map((r) => r.nearOppY - (rb.intercept + rb.slope * r.ballY));
  })();
  const rNearOnBall = Q.uni(pools.map((r) => r.nearOppY), pools.map((r) => r.ballY));
  say(`池化（n=${pools.length} 人次）：\n`);
  say(`  \`nearOppY ~ ballY\`：斜率 ${Q.fmt(rNearOnBall.slope, 3)}，R² ${Q.fmt(rNearOnBall.r2, 3)}`
    + ` → 最近对手的横向位置有 ${Q.fmt(100 * rNearOnBall.r2, 1)}% 由球位解释。`);
  const rDevOnNear = Q.uni(resid, nearResid);
  say(`  把球位从两边都剥掉后，\`y 残差 ~ nearOppY 残差\`：斜率 ${Q.fmt(rDevOnNear.slope, 3)}，`
    + `R² ${Q.fmt(rDevOnNear.r2, 3)} → **"最近对手"在剥掉球位后仍解释 ${Q.fmt(100 * rDevOnNear.r2, 1)}% 的方差**。`);
  say('');
  // ── 安慰剂对照：把"最近对手"换成"随机对手"，看相关是否下降 ──────────────
  //
  // **为什么必须做**：`nearOppY` 有 31% 由球位解释，而"离得最近"本身意味着
  // "他在我旁边"——若不设对照，无法区分"盯人"与"两队都在球附近所以 y 自然接近"。
  // 做法：同一批帧里，把 nearOppY 换成**该球员第 k 近**的对手（k=1 vs k=3 vs k=5 vs 随机）。
  // 若相关性随 k 单调下降 → 空间邻近（距离衰减）是主要机制，不一定是"盯人职责"。
  say('### 安慰剂对照：把"最近对手"换成"第 k 近对手"\n');
  say('若相关随 k（第几近）**单调下降**，则"相关性"至少部分来自**空间邻近的距离衰减**，');
  say('而不是"每人盯一个固定对手"的职责。\n');
  {
    const acc = new Map(); // k -> {dev:[], oppY:[]}
    for (const [key, { m }] of all) {
      if (!key.startsWith('skillcorner|')) continue;
      for (let i = 0; i < m.frames.length; i += 1) {
        const f = m.frames[i];
        if (!f.ball) continue;
        if (m.phase && m.phase.ballDet[i] !== 1) continue;
        for (const team of ['home', 'away']) {
          const mine = Q.framePlayers(m, f, team, { idx: i, includeExtrapolated: true });
          if (mine.length < 7) continue;
          // 对手必须转到**本队**的横向朝向下（两队手性相反），否则 y 不可比
          const theirs = Q.frameOpponents(m, f, team, { idx: i, includeExtrapolated: true });
          for (const p of mine) {
            const mates = mine.filter((q) => q.id !== p.id);
            const mateY = Q.mean(mates.map((q) => q.y));
            const sorted = [...theirs].sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
            if (sorted.length < 6) continue;
            for (const [k, idx] of [['1 近', 0], ['3 近', 2], ['5 近', 4], ['10 近(最远)', sorted.length - 1]]) {
              if (!acc.has(k)) acc.set(k, { dev: [], opp: [], u: [] });
              const A = acc.get(k);
              A.dev.push(p.y - mateY);
              A.opp.push(sorted[idx].y);
              A.u.push(p.id);
            }
          }
        }
      }
    }
    const rows = [...acc.entries()].map(([k, A]) => {
      const r = Q.uni(A.dev, A.opp);
      const rb = Q.uni(A.opp, A.dev);
      return [k, A.dev.length, Q.fmt(r.slope, 3), Q.fmt(r.r2, 3), Q.fmt(rb.r2, 3)];
    });
    say(Q.table(['第几近的对手', 'n 人次', '斜率', 'R²(对手→我)', 'R²(我→对手)'],
      rows, [14, 10, 8, 13, 13]));
    say('');
    say('**读法**：k=1/3/5 的斜率与 R² **单调下降**（0.535/0.277 → 0.227/0.062 → 0.084/0.009）。');
    say('→ 相关性随距离衰减，与"**空间邻近（贴身）**"一致，**不足以**单独证明"每人盯一个固定对手"。');
    say('');
    say('`10 近(最远)` 一行斜率 **−0.427**、R² 反而高（0.347）：这不是"更强的盯人"，');
    say('而是**镜像**——最远的对手必然在你反侧，于是在球位控制下两者近似线性镜像。');
    say('它的 R² 高只说明"最远的人与我最反相关"，是几何必然，不是战术信息。');
    say('');
    say('**结论（与 Q3e 合并读）**：个体横向位置的最大单一解释项是"最近对手的 y"（unique 28–35%），');
    say('但安慰剂显示它主要由距离衰减驱动。结合 Q3e（真实球员左右占比约 70:30）、Q5b（纵向几乎不耦合），');
    say('**最简约的机制解释是"球侧倾斜 + 弱职责档位"，而不是"人盯人"或"固定通道"**。');
  }
}

writeFileSync(join(Q.OUT_DIR, '02-drivers.txt'), lines.join('\n'));
console.error('\n→ 已写入 out/02-drivers.txt');
