// P38 #90 探针 3：**横向"通道"结构**（Q3）——球员有没有稳定的 y 职责区？
//
// 要回答的是**个体层面**（团队聚合的"中路 33.8%"已由 real-formation-laws §6.2 给出）：
//   3a 每人的 y 分布：单峰还是多峰？峰在哪？峰的宽度（sd）多大？
//   3b 通道"稳定性"：把每人整场的 y 分布与"随机重排"（无职责）对比——他的 y 有多"守规矩"？
//   3c 与角色的对应：SkillCorner 的真实 position_group 下，各组的 y 中心差多少？
//   3d 每人的 y 分布里，多少由"固定档位"解释（= 与 2a 的静息档位呼应）。
//
// 口径：全点（恒 10 人）；球帧不限（通道结构是**整场**性质，不是球位条件量）；
//       SkillCorner 用真实位置标签；Metrica/引擎用深度槽位。
//
// 运行：node openspec/changes/p38-formation-realism/notes/probes-main/q90-3-channels.mjs

import * as Q from './q90-common.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const P = Q.PITCH_WIDTH_M;
const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };

const ms = Q.loadReal();
const eng = await Q.loadEngineFrames({ seeds: [42] });
say('样本：Metrica 2 场 + SkillCorner 6 场；引擎 1 种子（对照）。全点口径（恒 10 人/帧）。\n');

// ── 收集：每人一场的 y 序列 ─────────────────────────────────────────────
function perPlayerY(m) {
  const per = new Map();
  for (let i = 0; i < m.frames.length; i += 1) {
    const f = m.frames[i];
    for (const team of ['home', 'away']) {
      for (const p of Q.framePlayers(m, f, team, { idx: i, includeExtrapolated: true })) {
        const k = `${team}|${p.id}`;
        if (!per.has(k)) per.set(k, { team, id: p.id, line: p.line, group: p.group, ys: [], xs: [] });
        const s = per.get(k); s.ys.push(p.y); s.xs.push(p.x);
      }
    }
  }
  for (const [k, s] of per) if (s.ys.length < 300) per.delete(k);
  return per;
}

const pooled = new Map(); // ds -> {ys:[], sd:[], kurt:[], peakiness:[]}
const perMatchStats = new Map(); // ds -> match -> {sd:[], peak:[], n}

for (const m of [...ms, ...eng]) {
  const ds = m.dataset;
  if (!pooled.has(ds)) pooled.set(ds, { sd: [], iqr: [], kurt: [], peak: [], range: [] });
  if (!perMatchStats.has(ds)) perMatchStats.set(ds, new Map());
  if (!perMatchStats.get(ds).has(m.id)) perMatchStats.get(ds).set(m.id, { sd: [], peak: [], n: 0 });
  const A = pooled.get(ds); const PM = perMatchStats.get(ds).get(m.id);
  const per = perPlayerY(m);
  for (const s of per.values()) {
    const ys = [...s.ys].sort((a, b) => a - b);
    const sd = Math.sqrt(Q.variance(ys));
    A.sd.push(sd); PM.sd.push(sd);
    A.iqr.push(Q.quantile(ys, 0.75) - Q.quantile(ys, 0.25));
    A.kurt.push(Q.skewKurt(ys).kurt);
    A.range.push(ys[ys.length - 1] - ys[0]);
    // "峰性"：把 y 分 2m 桶，最大桶占比 / 均匀占比（13.6m 通道宽下的集中度）
    const B = 34; const hist = new Array(B).fill(0);
    for (const y of ys) hist[Math.min(B - 1, Math.max(0, Math.floor((y / P) * B)))] += 1;
    const pk = Math.max(...hist) / ys.length;
    const unif = 1 / B;
    A.peak.push(pk / unif); PM.peak.push(pk / unif);
    PM.n += 1;
  }
}

// ── Q3a. 每人的 y 分布形状 ──────────────────────────────────────────────
say('## Q3a. 个体 y 分布的形状\n');
say('逐人（一场一个身份槽位，n≥300 帧）算：sd、IQR、全距；峰性 = 2m 桶最大占比 ÷ 均匀占比');
say('（=1 表示在 68m 宽上完全均匀，=34 表示全部挤在一个 2m 桶）。kurt 是峰度（正态 = 3）。\n');
{
  const rows = [];
  for (const [ds, A] of pooled) {
    rows.push([ds, A.sd.length, Q.fmt(Q.mean(A.sd), 2), Q.fmt(Q.mean(A.iqr), 2),
      Q.fmt(Q.mean(A.range), 2), Q.fmt(Q.mean(A.peak), 2), Q.fmt(Q.mean(A.kurt), 2)]);
  }
  say(Q.table(['数据集', '人·场 n', 'y sd(m)', 'y IQR(m)', 'y 全距(m)', '峰性', '峰度'],
    rows, [12, 9, 9, 9, 10, 8, 8]));
  say('');
  say('**读法**：真实球员的整场 y sd ≈ **12.5–12.9m**，与"68m 宽上均匀随机游走"的 sd≈19.6m 只差 1.5 倍；');
  say('引擎 **0.76m**。差距 **~17×**。峰性 2.4–2.7（远小于引擎的 26.5）= 真实 y 分布**几乎没有尖峰**，');
  say('峰度 2.6–3.0 接近正态。**"每个球员有自己固定的横向通道"在分布形状上不成立**——');
  say('若成立，每人的 y 分布应是一个窄峰（峰性会高一个数量级），实测不是。');
  say('');
  say('> 注：本表的 sd **已做半场朝向归一**（`yCanon`，见 `00-caliber.txt` §3b）。');
  say('> 未修正的原始 y sd 是 14.2 / 15.3m——那多出来的 1.7–2.4m 是"半场换边把球员搬到了另一侧"，');
  say('> 不是他的跑动。这是本票据修掉的口径 bug。');
  say('');
  say('### ⚠ 与 P38 既有数字的对账（口径不同，两个都对）\n');
  say('`findings-final.md` §4b 的"真实横向 sd **10.04m** vs 引擎 **0.53m**"是**窗内**口径');
  say('（120s 窗 t∈[1800,1920)，Metrica game1）。该窗完全落在上半场（边界 2850s）内，');
  say('故朝向归一不影响它——**10.04m 逐位复现**。本表 12.5–12.9m 是**整场**口径，');
  say('两者差在**慢漂移**（整场重心/比赛态势），不是矛盾。窗内复算：\n');
  {
    const rows2 = [];
    for (const m of [...ms, ...eng]) {
      const w = m.frames.filter((f) => f.t >= 1800 && f.t < 1920);
      if (w.length < 100) continue;
      const vals = [];
      const per = new Map();
      for (let i = 0; i < w.length; i += 1) {
        const f = w[i];
        for (const team of ['home', 'away']) {
          for (const p of Q.framePlayers(m, f, team, { idx: i, includeExtrapolated: true })) {
            const k = `${team}|${p.id}`; if (!per.has(k)) per.set(k, []); per.get(k).push(p.y);
          }
        }
      }
      for (const v of per.values()) if (v.length > 50) vals.push(Math.sqrt(Q.variance(v)));
      rows2.push([`${m.dataset} ${m.id}`, w.length, vals.length, Q.fmt(Q.mean(vals), 2)]);
    }
    say(Q.table(['数据集/场次', '窗内帧 n', '人数', '窗内 y sd 均值(m)'], rows2, [18, 9, 6, 18]));
    say('');
    say('引擎 0.45–0.70m、真实 7.1–10.1m（SkillCorner 因每帧人数少、窗内有效样本更少，');
    say('  见 00-caliber；其窗内 sd 系统性略低）。**窗内比值 ~13–22×**，与整场比值一致。');
  }
}
say('');

// ── Q3b. 通道占用分布（与 §6.2 对账 + 个体层面）─────────────────────────
say('## Q3b. 个体 y 的通道占用（5 条 13.6m 通道）\n');
say('先与 `real-formation-laws.md` §6.2 对账（全员占比），再给**逐人的主导通道**：');
say('每人最常出现的通道及其占比（"主导通道%"）——若 ≈100%，说明此人**几乎不换通道**。\n');
{
  const rows = [];
  for (const [ds, m] of [['skillcorner', null], ['metrica', null], ['engine', null]]) {
    const occ = [0, 0, 0, 0, 0]; let tot = 0;
    const dom = []; let domShare = [];
    for (const mm of [...ms, ...eng].filter((x) => x.dataset === ds)) {
      for (const s of perPlayerY(mm).values()) {
        const h = [0, 0, 0, 0, 0];
        for (const y of s.ys) { h[Q.channelOf(y)] += 1; tot += 1; }
        for (let i = 0; i < 5; i += 1) occ[i] += h[i];
        dom.push(h.indexOf(Math.max(...h)));
        domShare.push(Math.max(...h) / s.ys.length);
      }
    }
    void m;
    if (!tot) continue;
    rows.push([ds, tot, ...occ.map((v) => `${Q.fmt(100 * v / tot, 1)}%`),
      Q.fmt(100 * Q.mean(domShare), 1) + '%']);
  }
  say(Q.table(['数据集', '人次 n', '左翼', '左半', '中路', '右半', '右翼', '主导通道占比均值'],
    rows, [12, 10, 7, 7, 7, 7, 7, 18]));
  say('');
  say('（`real-formation-laws.md` §6.2 的 SkillCorner 全员占比：12.3% / 22.4% / 33.8% / 21.1% / 10.4%。');
  say('  本表用全点口径 + 逐人先算，故有细微差异；方向应一致。）');
}
say('');

// ── Q3c. 峰位稳定性：逐场 vs 逐人 ───────────────────────────────────────
say('## Q3c. "主导通道"是稳定的身份还是随机波动？\n');
say('把每人的**前半场 y 中位数**与**后半场 y 中位数**对比（同一人、同一场），并把');
say('这个差拆成**队伍分量**（该队前后半场整体重心的差）与**个体分量**（残差）。');
say('若侧向职责是硬约束 → 个体分量应远小于队伍分量；若"通道"只是跟着球走 → 两者同量级。');
say('另给**打散对照**（每人 y 序列随机重排后分两半）作"无结构"基线。\n');
{
  const rnd = Q.lcg(20260919);
  const rows = [];
  for (const ds of ['metrica', 'skillcorner', 'engine']) {
    const dev = []; const teamComp = []; const tot = []; const shuf = [];
    for (const mm of [...ms, ...eng].filter((x) => x.dataset === ds)) {
      for (const team of ['home', 'away']) {
        // 该队逐帧重心，用于算前后半场的队伍分量
        const cyByT = new Map();
        for (let i = 0; i < mm.frames.length; i += 1) {
          const f = mm.frames[i];
          const ps = Q.framePlayers(mm, f, team, { idx: i, includeExtrapolated: true });
          if (ps.length >= 7) cyByT.set(f.t, Q.mean(ps.map((p) => p.y)));
        }
        const ts = [...cyByT.keys()].sort((a, b) => a - b);
        if (!ts.length) continue;
        const mid = ts[Math.floor(ts.length / 2)];
        const half = (sel) => Q.quantile(ts.filter(sel).map((t) => cyByT.get(t)).sort((a, b) => a - b), 0.5);
        const teamDelta = half((t) => t < mid) - half((t) => t >= mid);
        for (const s of perPlayerY(mm).values()) {
          if (s.team !== team) continue;
          const n = s.ys.length; const h = Math.floor(n / 2);
          const md = (a) => Q.quantile([...a].sort((x, y) => x - y), 0.5);
          const d = md(s.ys.slice(0, h)) - md(s.ys.slice(h));
          tot.push(Math.abs(d)); teamComp.push(Math.abs(teamDelta)); dev.push(Math.abs(d - teamDelta));
          const sh = [...s.ys];
          for (let i = sh.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; }
          shuf.push(Math.abs(md(sh.slice(0, h)) - md(sh.slice(h))));
        }
      }
    }
    if (!tot.length) continue;
    rows.push([ds, tot.length, Q.fmt(Q.mean(tot), 2), Q.fmt(Q.mean(teamComp), 2),
      Q.fmt(Q.mean(dev), 2), Q.fmt(Q.mean(shuf), 2)]);
  }
  say(Q.table(['数据集', '人·场 n', '|前后半场 y 中位差|', '其中队伍分量', '个体分量', '打散对照'],
    rows, [12, 9, 18, 13, 10, 10]));
  say('');
  say('**读法**：个体分量 ≪ 打散对照 → 同一人在**同一场内**确实守着相对稳定的横向档位；');
  say('个体分量 ≈ 队伍分量 → "通道"主要是全队横移的投影，不是个体职责。');
  say('（注意：这里的"前后半场"是**整段 45 分钟**。若中位差很大，说明半场之内 y 就在漂移，');
  say('  而不是"球员守一个固定档位、只在其附近抖动"。）');
}
say('');

// ── Q3d. 与真实位置标签的对应 ───────────────────────────────────────────
say('## Q3d. y 中心 ↔ 真实位置（SkillCorner position_group）\n');
say('每组：人数、y 均值（距中轴）、y sd、跨人 sd（组内不同人的 y 中心有多分散）。\n');
{
  const acc = new Map();
  for (const m of ms.filter((x) => x.dataset === 'skillcorner')) {
    for (const s of perPlayerY(m).values()) {
      if (!s.group) continue;
      if (!acc.has(s.group)) acc.set(s.group, []);
      acc.get(s.group).push(s);
    }
  }
  const rows = [];
  for (const [g, ss] of [...acc.entries()].sort()) {
    const centers = ss.map((s) => Q.mean(s.ys));
    rows.push([g, ss.length, Q.fmt(Q.mean(centers), 2), Q.fmt(Q.mean(centers) - P / 2, 2),
      Q.fmt(Q.mean(ss.map((s) => Math.sqrt(Q.variance(s.ys)))), 2),
      Q.fmt(Math.sqrt(Q.variance(centers)), 2)]);
  }
  say(Q.table(['position_group', '人·场 n', 'y 均值(m)', '距中轴(m)', '人内 y sd(m)', '跨人 y 中心 sd(m)'],
    rows, [22, 9, 10, 11, 12, 16]));
  say('');
  say('**读法**：`跨人 y 中心 sd` 是本表的关键——它衡量"位置真的决定了横向档位吗"。');
  say('⚠ **不要把它读成"球员习惯差异"**：这里的"人·场"里，**同一个槽位在不同场次是不同的人**，');
  say('而且同组内**左/右两名球员被算作两条记录**。所以：');
  say('');
  say('- **Full Back 15.43m** 不是"边卫各有习惯"，而是**左后卫（y≈14）与右后卫（y≈54）的分离**——');
  say('  它是"边卫确实有左右分工"的**直接证据**，量级等于场地宽的一半。');
  say('- **Central Defender 6.78m** 同理（左中卫/右中卫的间距），但小得多；');
  say('  **Center Forward 3.75m / Midfield 3.93m** 最小 → 中锋与中场**没有左右分工**。');
  say('- 因此正确的结论是：**左右分工只存在于"边后卫 + 边锋"这类边路位置，且是"相对进攻方向"的**');
  say('  （本表已做朝向归一，否则左/右会被半场换边搅成一半一半）。');
  say('');
  say('「人内 y sd」一列则给出各自的活动半径：Full Back 11.9m 最小（沿边线上下，横向约束最强）、');
  say('Wide Attacker 14.7m 最大。全部 10.6–14.7m，与 Q3a 的 12.5–12.9m 一致。');
  say('');
  // 逐场版本：消除"跨场不同人"的干扰，只看**同一场同一位置组内**的横向分散
  say('### 逐场版本（同一场、同一位置组内的横向分散）\n');
  say('每组在每个**单场**里的成员 y 中心的全距（max − min）与 sd，跨场取均值。');
  say('这是"位置是否强制左右分工"的干净读数：≤3m = 该组的人都在一条横轴上；');
  say('≥10m = 组内至少有一对左右分居两翼。\n');
  const perM = new Map();
  for (const m of ms.filter((x) => x.dataset === 'skillcorner')) {
    const byGroup = new Map();
    for (const s of perPlayerY(m).values()) {
      if (!s.group) continue;
      const c = Q.mean(s.ys);
      if (!byGroup.has(s.group)) byGroup.set(s.group, []);
      byGroup.get(s.group).push(c);
    }
    for (const [g, arr] of byGroup) {
      if (arr.length < 2) continue;
      if (!perM.has(g)) perM.set(g, { range: [], sd: [], n: [] });
      const A = perM.get(g);
      A.range.push(Math.max(...arr) - Math.min(...arr));
      A.sd.push(Math.sqrt(Q.variance(arr)));
      A.n.push(arr.length);
    }
  }
  const rows3 = [...perM.entries()].sort().map(([g, A]) => [g, A.range.length,
    Q.fmt(Q.mean(A.n), 1), Q.fmt(Q.mean(A.range), 2), Q.fmt(Q.mean(A.sd), 2),
    Q.fmt(Q.quantile([...A.range].sort((a, b) => a - b), 0.5), 2)]);
  say(Q.table(['position_group', '场数', '组内人数', '组内 y 全距均值(m)', '组内 y sd 均值(m)', '全距中位(m)'],
    rows3, [22, 6, 9, 17, 16, 11]));
}
say('');

// ── Q3e. 双峰检验（球侧效应还是通道？）─────────────────────────────────
say('## Q3e. 个体 y 分布是"双峰"（两侧各一个通道）还是"单峰宽分布"？\n');
say('对每个「人·场」序列，看 y 直方图（1m 桶）有几个显著峰。也分左右两侧统计');
say('（左半边 / 右半边各自的占比）——若明显偏离 50/50 且呈双峰，则此人有**左右两个职责档位**。\n');
{
  const rows = [];
  for (const ds of ['metrica', 'skillcorner', 'engine']) {
    if (![...ms, ...eng].some((x) => x.dataset === ds)) continue;
    let bimodal = 0; let total = 0; const sideDev = [];
    for (const mm of [...ms, ...eng].filter((x) => x.dataset === ds)) {
      for (const s of perPlayerY(mm).values()) {
        const n = s.ys.length;
        const left = s.ys.filter((y) => y < P / 2).length;
        sideDev.push(Math.abs(left / n - 0.5));
        // 峰计数：1m 桶，平滑（±1 桶），峰 = 高于两侧且高度 ≥ 峰值 30%
        const B = 68; const hist = new Array(B).fill(0);
        for (const y of s.ys) hist[Math.min(B - 1, Math.max(0, Math.floor(y)))] += 1;
        const sm = hist.map((_, i) => (hist[i - 1] || 0) + hist[i] + (hist[i + 1] || 0));
        const mx = Math.max(...sm);
        let peaks = 0;
        for (let i = 2; i < B - 2; i += 1) {
          if (sm[i] > sm[i - 1] && sm[i] >= sm[i + 1] && sm[i] >= 0.3 * mx) peaks += 1;
        }
        if (peaks >= 2) bimodal += 1;
        total += 1;
      }
    }
    rows.push([ds, total, `${Q.fmt(100 * bimodal / total, 1)}%`, Q.fmt(Q.mean(sideDev), 3)]);
  }
  say(Q.table(['数据集', '人·场 n', '有 ≥2 个显著峰的比例', '左右占比偏离 0.5 的均值'],
    rows, [12, 9, 20, 24]));
  say('');
  say('**读法**：`左右占比偏离 0.5` 小 = 该球员在场上的左右两侧**时间大致对半** → 说明他是"跟着球换边"的；');
  say('大 = 他基本固定在某一侧（真的边路职责）。');
  say('');
  say('⚠ **"≥2 个显著峰"这一列会误导**（实测 95–98% 的真实球员都 ≥2 峰，引擎 0%）。');
  say('原因是 1m 桶 + ±1 平滑下，一个**宽而平**（sd 12m、接近正态）的分布本来就有一堆');
  say('统计噪声峰；它不是"左右两个职责档位"的证据。**看后一列**（左右占比偏离）与 Q3d 的');
  say('逐场分散才是判据。');
  say('');
  say('后一列的读法：真实 0.20 左右（不是 0、也不是 0.43）→ 球员**约 70:30 偏向某一侧**，');
  say('既不是"严格守一侧"（那会到 0.4+）也不是"完全随球换边"（那会到 0）。');
  say('引擎 0.43 = 极端的固定一侧（它的球员 y 几乎不动，随机哪边就一辈子哪边）。');
}

writeFileSync(join(Q.OUT_DIR, '03-channels.txt'), lines.join('\n'));
console.error('\n→ 已写入 out/03-channels.txt');
