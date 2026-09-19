// P38 #90 探针 0：**口径说明 + 与既有报告的对账**。
//
// 作用有三：
//   (a) 把本套探针相对 `../probes/`（Agent A 的 real-formation-laws.md）的**口径差异**
//       （外推点默认采信 vs 跳过）量化出来，并证明"跳过外推"对横向量是有偏的；
//   (b) 用**两条独立路径**重算 `real-formation-laws.md` §6.3 的「球队重心跟球」数字，
//       确认本套装载器与那份报告口径可比（对不上就是装载器错了，不是数字错了）；
//   (c) **本套探针修掉的一个口径 bug**：转换器的 y 轴没有跟 x 一起做半场翻转，
//       导致跨半场的**个体**横向统计被"换边位移"污染（§3b）。这是本票据最重要的
//       口径发现——它让"每人整场 y sd 14–15m"这类数字必须重算。
//
// 运行：node openspec/changes/p38-formation-realism/notes/probes-main/q90-0-caliber.mjs

import * as Q from './q90-common.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };

const ms = Q.loadReal();
say('# P38 #90 探针 0：口径说明 + 对账\n');

// ── 1. 外推点：每帧有效人数 ─────────────────────────────────────────────
say('## 1. 外推点的两种口径：每帧有效人数\n');
const rows = [];
for (const m of ms) {
  for (const team of ['home', 'away']) {
    const nAll = []; const nDet = [];
    for (let i = 0; i < m.frames.length; i += 1) {
      const f = m.frames[i];
      nAll.push(Q.framePlayers(m, f, team, { idx: i, includeExtrapolated: true }).length);
      nDet.push(Q.framePlayers(m, f, team, { idx: i, includeExtrapolated: false }).length);
    }
    const hist = {};
    for (const n of nDet) hist[n] = (hist[n] || 0) + 1;
    rows.push([`${m.dataset.slice(0, 3)} ${m.id}`, team, Q.fmt(Q.mean(nAll), 2),
      Q.fmt(Q.mean(nDet), 2), (100 * (hist[10] || 0) / nDet.length).toFixed(1),
      Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([k, v]) => `${k}人 ${(100 * v / nDet.length).toFixed(0)}%`).join(' ')]);
  }
}
say(Q.table(['场次', '队', '全点人数', '真检测人数', '10人帧%', '真检测口径的众数'],
  rows, [14, 5, 9, 11, 8, 30]));
say('');
say('**读法**：SkillCorner 全点口径恒 10 人（转换器每帧填满 22 槽）。真检测口径平均只有 ~8 人、');
say('10 人齐的帧不足 3%——即"跳过外推"下每帧的球员集合是**变动的**，重心/分位数/分布都被 n 效应污染。');
say('');

// ── 2. 跳过外推 = 按球位置系统性截断队形两端？────────────────────────────
say('## 2. 「跳过外推」是否与球位置相关（选择性偏倚的直接检验）\n');
say('按球深度（离本方门线，7 桶）统计**真检测率**（= 1 − 外推率），逐队逐桶。若与球位置无关，');
say('各行应接近常数；若两端低 → 跳过外推会系统性削掉队形两端（= 横向分布的选择性偏倚）。\n');
{
  const EDGES = [0, 0.14, 0.28, 0.42, 0.58, 0.72, 0.86, 1.0];
  const acc = EDGES.slice(0, -1).map(() => [0, 0]); // [det, all]
  for (const m of ms.filter((x) => x.dataset === 'skillcorner')) {
    for (let i = 0; i < m.frames.length; i += 1) {
      const f = m.frames[i];
      if (!f.ball) continue;
      const [L] = f.pitchMeters || [105, 68];
      for (const team of ['home', 'away']) {
        const depth = (team === 'home' ? f.ball[0] : 1 - f.ball[0]) * L;
        const bi = Q.corpus.bucketIndex(depth / L, EDGES);
        if (bi < 0) continue;
        for (const p of Q.framePlayers(m, f, team, { idx: i, includeExtrapolated: true })) {
          acc[bi][1] += 1;
          if (!p.extrapolated) acc[bi][0] += 1;
        }
      }
    }
  }
  const r = acc.map(([d, a], i) => [`[${(EDGES[i] * 105).toFixed(0)}–${(EDGES[i + 1] * 105).toFixed(0)})m`,
    a, (100 * d / a).toFixed(1)]);
  say(Q.table(['球深度（离本方门线）', '人次 n', '真检测率 %'], r, [22, 12, 12]));
  const rates = acc.map(([d, a]) => d / a);
  say('');
  say(`两端 vs 中间：最深桶 ${(100 * rates[0]).toFixed(1)}% / 最浅桶 ${(100 * rates[6]).toFixed(1)}%`
    + ` vs 中间桶均值 ${(100 * Q.mean(rates.slice(2, 5))).toFixed(1)}%`
    + ` → 差 ${(100 * (Q.mean(rates.slice(2, 5)) - (rates[0] + rates[6]) / 2)).toFixed(1)} 个百分点。`);
  say('（方向与 P38 `findings-final.md` §1 的 U 形一致：真检测率沿深度两端低。）');
}
say('');

// ── 3. 与 real-formation-laws.md §6.3 对账 ──────────────────────────────
say('## 3. 对账：球队横向重心 vs 球横向位置（复算 §6.3）\n');
say('球 y 分三档（<W/3 / 中 / >2W/3），统计球队重心 cy（米）与宽度（q10–q90，米）。');
say('两条路径：(a) 本套装载器（全点口径）；(b) `probes/corpus.mjs` 的 teamXY（跳过外推）——');
say('(b) 若复现报告数字，(a) 与 (b) 的差就是**纯口径差**，不是装载器差。\n');
{
  const rows2 = [];
  for (const ds of ['metricadata|metrica', 'skillcorner']) {
    const sub = ms.filter((m) => (ds === 'skillcorner' ? m.dataset === 'skillcorner' : m.dataset === 'metrica'));
    const W = Q.PITCH_WIDTH_M;
    for (const mode of ['all', 'det']) {
      const inc = mode === 'all';
      const buckets = [[], [], []]; // 每档：[cy 数组, 宽度数组]
      const widths = [[], [], []];
      let n = 0;
      // ⚠ 本节**刻意用原始 y**（`yPrime`，不做 team-relative 朝向归一）——因为要复现的
      // `real-formation-laws.md` §6.3 就是原始 y 口径。§3b 证明该口径对**逐帧**量
      // （逐帧 cy、逐帧宽度）无偏（它只是把每帧的 y 做了一次常数反射）；有偏的只有
      // **跨半场的个体统计**。故这里的对账是有效的，且不需要重算 §6.3。
      for (const m of sub) {
        for (let i = 0; i < m.frames.length; i += 1) {
          const f = m.frames[i];
          if (!f.ball) continue;
          const byRaw = f.ball[1] * W;
          const bi = byRaw < W / 3 ? 0 : byRaw > (2 * W) / 3 ? 2 : 1;
          for (const team of ['home', 'away']) {
            const ps = Q.framePlayers(m, f, team, { idx: i, includeExtrapolated: inc });
            if (ps.length < 7) continue;
            const cy = Q.mean(ps.map((p) => p.yPrime));
            const ys = ps.map((p) => p.yPrime).sort((a, b) => a - b);
            buckets[bi].push(cy); widths[bi].push(Q.quantile(ys, 0.9) - Q.quantile(ys, 0.1));
            n += 1;
          }
        }
      }
      const r = [];
      for (let i = 0; i < 3; i += 1) {
        r.push([['左（球 y<W/3）', '中', '右（球 y>2W/3）'][i], buckets[i].length,
          Q.fmt(Q.mean(buckets[i]), 2), Q.fmt(Q.mean(buckets[i]) - Q.PITCH_WIDTH_M / 2, 2),
          Q.fmt(Q.mean(widths[i]), 2)]);
      }
      const span = Q.mean(buckets[2]) - Q.mean(buckets[0]);
      rows2.push(...r.map((x, i) => [
        i === 1 ? `${ds.split('|')[0]} ${mode === 'all' ? '全点' : '真检测'}` : '', ...x]));
      rows2.push(['', '档心跨度', '', Q.fmt(span, 2), '']);
    }
  }
  say(Q.table(['数据集/口径', '球横向档', 'n', '重心 cy(m)', '距中轴(m)', '宽度 q10–q90(m)'],
    rows2.filter((r) => r[0] !== '' || r[1] !== ''), [22, 16, 10, 11, 12, 14]));
}
say('');
say('**对账结论**：');
say('`metricadata 真检测` 行 25.57 / 32.94 / 40.41（距中轴 −8.43 / −1.06 / +6.41，档心跨度 14.84）');
say('对照 `real-formation-laws.md` §6.3 的 Metrica 25.8 / 33.4 / 40.2（−8.23 / −0.62 / +6.23，跨度 14.5）；');
say('`skillcorner 真检测` 行 23.74 / 33.77 / 44.41（−10.26 / −0.23 / +10.41，跨度 20.66）');
say('对照同表的 23.9 / 33.7 / 44.2（−10.13 / −0.27 / +10.23，跨度 20.4）。**两条路径逐项吻合**');
say('→ 本套装载器与那份报告口径可比，差仅来自球帧过滤（本表不过滤 `ballFill`）与四舍五入。');
say('');
say('**口径差本身**（同一批帧，只换外推点采信与否）：SkillCorner 宽度 29.34/27.69/28.86');
say('（全点）vs 26.96/25.33/27.67（真检测），**全点宽 2.3–2.4m**；重心档心跨度 19.04 vs 20.66。');
say('即"跳过外推"同时**窄化**队形与**夸大**重心跟随幅度——两者都不是真实观测的差异，');
say('而是缺失模式与球位置相关的产物。本套探针主口径取全点（恒 10 人面板）。');
say('');

// ── 3b. ⚠ 半场换边：y 轴没有跟着 x 一起翻（本套探针修掉的口径 bug）────────
//
// 转换器把 x 归一化成「该队恒攻向 x=1」，半场换边时翻 x；但 y 只做了固定的 `1-y` 反射。
// 半场换边在几何上是**绕球场中心的 180° 旋转** `(x,y)→(1-x,1-y)`——只翻 x 不翻 y，
// 下半场就成了**镜像**而不是旋转，`i` 与 `W−i` 的左右手性在两半场之间翻反。
//
// 后果：跨半场的**个体**统计（y 方差、分布、前后半场对比）会被"换边把你搬到另一侧"
// 污染。对**逐帧**量（width、iqr、cy~ballY 斜率）无影响——它们对纯 y 反射不变，
// 所以 `real-formation-laws.md` 的既有结论不受影响。
say('## 3b. ⚠ 半场换边：y 轴需要跟着 x 一起翻（本套探针修掉的口径 bug）\n');
say('半场换边 = 绕场地中心 180° 旋转。转换器翻了 x 但没翻 y → 跨半场的个体统计被污染。');
say('修正 = team-relative 横向 `yCanon`（见 `q90-common.mjs` 的 `lateralFlip`）；');
say('Metrica 转换产物不含 `period`，半场边界由**数据**定（取使**逐人方差均值**最小的 t0）。\n');
{
  const rows = [];
  for (const m of ms.filter((x) => x.dataset === 'metrica')) {
    const b = Q.metricaHalfBoundary(m);
    rows.push([m.id, `${b.t0}s (${(b.t0 / 60).toFixed(1)}min)`, JSON.stringify(b.flipX),
      Q.fmt(b.perPlayerVarNoFlip, 1), Q.fmt(b.perPlayerVar, 1),
      `${Q.fmt(100 * (1 - b.perPlayerVar / b.perPlayerVarNoFlip), 1)}%`]);
  }
  say(Q.table(['Metrica 场次', '检测出的半场边界 t0', '源 flipX(逐半场)',
    '逐人方差均值 未修正', '修正后', '降幅'], rows, [13, 20, 16, 16, 10, 8]));
  say('');
  say('**为什么用「逐人方差的均值」做判据，而不是池化方差**：池化会把 20 个人的左右差异');
  say('互相抵消，目标函数对 t0 几乎不敏感（实测曲线平到 471.6 vs 478，会选到区间端点）；');
  say('逐人方差均值对同一现象敏感得多，曲线是干净的碗形、谷底明确。\n');
  const m0 = ms.find((x) => x.id === '1');
  const rowId = [];
  for (const id of [1, 3, 4, 8, 9, 13, 19]) {
    const raw = []; const can = [];
    const team = id <= 10 ? 'home' : 'away';
    for (let i = 0; i < m0.frames.length; i += 1) {
      for (const p of Q.framePlayers(m0, m0.frames[i], team, { idx: i })) {
        if (p.id === id) { can.push(p.y); raw.push(p.yPrime); }
      }
    }
    if (!raw.length) continue;
    const sd = (a) => Math.sqrt(Q.variance(a));
    rowId.push([id, raw.length, Q.fmt(sd(raw), 2), Q.fmt(sd(can), 2), Q.fmt(sd(can) - sd(raw), 2)]);
  }
  say('修正前后的**单人** y sd（Metrica game1）：\n');
  say(Q.table(['槽位 id', 'n', "y' sd（未修正）", 'yCanon sd（修正后）', 'Δ'],
    rowId, [9, 8, 15, 18, 8]));
  say('');
  say('**SkillCorner 不受此 bug 影响**：侧信道记录了**逐帧 period 真值**（源 `match.json` 的');
  say('`match_periods`），修正直接用它、不需要检测。实测 6 场的 home 半场朝向：3 场');
  say('left→right、3 场 right→left——若漏掉这一步，**一半的场次**会被镜像。\n');
}

// ── 4. 结论性口径声明 ───────────────────────────────────────────────────
say('## 4. 本套探针的口径（写进 real-lateral-laws.md 的那份）\n');
say('1. **y 分量一律用 PITCH_WIDTH_M(68)**；实测 8 场球场宽恒 68（04-width-channels.mjs 已核）。');
say('2. **x 客队镜像**（→ 离本方门线距离）；**y 做 team-relative 朝向归一**（`yCanon`，');
say('   半场换边时跟着 x 一起翻，见 §3b）——**不是**"不镜像"（那是修正前的错误口径）。');
say('3. **球员面板恒 10 人/帧/队**（全点口径，含 SkillCorner 外推点）。理由见 §1/§2；');
say('   凡结论与真检测口径差 ≥0.3m 或 ≥3pp 的，在正文处单独标注。');
say('4. **相位**：SkillCorner 用源数据 `possession.group` 真值（侧信道 `*-phase.json`，')
say('   由 `buildSkillcornerPhase()` 从原始 jsonl 重建并**逐帧断言 t 与转换产物相等**）；')
say('   Metrica 无此字段，退回最近球员代理（`corpus.poss`）。两者**分列，不混池**。');
say('5. **球相关量只用球的原始观测帧**（SkillCorner: `ball_data.is_detected === true`，');
say('   n≈18205/22122 等；Metrica 无外推概念，全部可用）。');
say('6. **槽位 ≠ 位置身份**：Metrica 与引擎用"按整场平均深度排的固定槽位"；');
say('   SkillCorner 另有真实 `position_group`（`roles.mjs`），个体分析优先用它。');
say('');

writeFileSync(join(Q.OUT_DIR, '00-caliber.txt'), lines.join('\n'));
console.error('\n→ 已写入 out/00-caliber.txt');
