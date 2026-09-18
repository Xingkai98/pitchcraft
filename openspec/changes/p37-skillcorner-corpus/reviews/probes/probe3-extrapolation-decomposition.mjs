#!/usr/bin/env node
// P0.5 前置测量（审阅把原 P1.5 提到拍板之前）：
//   1) D2 的 n 效应分解——口径差里有多少是「trim1 依赖参与人数 n」的机械伪影、
//      有多少是「检测的选择性」（P0.5.1）
//   2) 外推过滤的代价——逐场逐窗有效帧、丢帧率、每队检测数分布（P0.5.2）
//
// **复用已交付的转换器代码路径**（parseTrackingJsonl / stitchTimeline / 归一化 / 身份映射），
// 保证这里的数字与最终基线出自同一套实现，不是另写一份"看起来一样"的探针
// （P36 踩过：两边各写一份实现、差异只在细节里）。
//
// 按 design D6 分开报告 SkillCorner；口径按 design D2 的三条并列。
//
// 用法：node openspec/changes/p37-skillcorner-corpus/reviews/probes/probe3-extrapolation-decomposition.mjs
//       [--dir <tracking-data/skillcorner>] [--json <输出.json>]

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseTrackingJsonl, stitchTimeline, makeNormalizer, isGoalkeeper,
} from '../../../../../tools/convert-skillcorner-to-frames.mjs';
import {
  PITCH_LENGTH_M, PITCH_WIDTH_M, quantileSpan,
} from '../../../../../viewer/match-metrics.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..', '..', '..');
const DEFAULT_DIR = join(ROOT, '.scratch', 'tracking-data', 'skillcorner');

const MIN_OUTFIELD_PLAYERS = 7;
const SAMPLE_STRIDE = 2; // 10fps → 5Hz（与指标层采样间隔一致）
const RANDOM_K_TRIALS = 20; // 随机 k 子集重复次数（消除抽样噪声）
const WINDOW_SIZE_SEC = 300;
const WINDOW_STEP_SEC = 900;

// 确定性 RNG（不用 Math.random——结果须可复现；对齐项目「种子冻结」原则）。
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// trim1：P36 旧口径（排序后掐头去尾各 1 人）。保留——用于展示「换 β 之前」的分解。
function trim1(xs) {
  if (xs.length < MIN_OUTFIELD_PLAYERS) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length - 2] - s[1];
}

// β 口径：q10–q90 线性插值分位跨度——**直接复用已交付的 viewer/match-metrics.js**，
// 不另写一份（P36 教训：两边各写一份"看起来一样"的实现，差异只在细节里）。
function betaSpan(xs) {
  if (xs.length < MIN_OUTFIELD_PLAYERS) return null;
  return quantileSpan([...xs].sort((a, b) => a - b));
}

// 一场：把 tracking 帧转成「每帧每队一组米制 x 坐标 + 检测标记」。
function loadGame(scDir, matchPath) {
  const match = JSON.parse(readFileSync(matchPath, 'utf8'));
  const id = String(match.id);
  const trackingPath = join(scDir, 'tracking', `${id}_tracking_extrapolated.jsonl`);
  if (!existsSync(trackingPath)) return { id, skipped: 'tracking 实体缺失' };
  const { frames, shift } = stitchTimeline(parseTrackingJsonl(readFileSync(trackingPath, 'utf8')));
  const L = match.pitch_length;
  const W = match.pitch_width;
  const normalize = makeNormalizer(L, W, match.home_team_side);
  const homeId = match.home_team.id;
  const awayId = match.away_team.id;
  const byId = new Map(match.players.map((p) => [p.id, p]));
  const teamOf = (pid) => {
    const p = byId.get(pid);
    return p ? (p.team_id === homeId ? 'home' : p.team_id === awayId ? 'away' : null) : null;
  };

  const out = [];
  for (let i = 0; i < frames.length; i += SAMPLE_STRIDE) {
    const f = frames[i];
    if (f.period !== 1 && f.period !== 2) continue; // 跳过 period ∈ {null,...}
    const pts = { home: { all: [], det: [] }, away: { all: [], det: [] } };
    for (const p of f.players) {
      const pid = p.player_id;
      const byPlayer = byId.get(pid);
      if (!byPlayer || isGoalkeeper(byPlayer)) continue;
      const t = teamOf(pid);
      if (!t || p.x == null || p.y == null) continue;
      // 只取 x（纵深只用 x）。**按该场自己的尺寸换算**（P37 D4，与已交付实现一致）。
      const [x01] = normalize(p.x, p.y, f.period);
      const xm = x01 * L;
      pts[t].all.push(xm);
      if (p.is_detected === true) pts[t].det.push(xm);
    }
    out.push({ t: f.t, pts });
  }
  return { id, L, W, shift, frames: out, status: match.status };
}

// 单场：逐帧算「全点 / 随机同规模 k / 仅真检测」三口径，**对两个估计量各算一遍**
// （trim1 = P36 旧口径；q10–q90 = P37 β 口径）。两者**分别标注**，不混在同一行。
function decompose(game, rng) {
  const est = {
    trim1: { A: [], B: [], Cm: [] },
    beta: { A: [], B: [], Cm: [] },
  };
  const nDist = { home: new Map(), away: new Map() };
  let framesBothOkAll = 0;
  let framesBothOkDet = 0;
  let frameCount = 0;
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

  for (const fr of game.frames) {
    frameCount += 1;
    const { home, away } = fr.pts;
    bump(nDist.home, home.det.length);
    bump(nDist.away, away.det.length);
    if (home.all.length >= MIN_OUTFIELD_PLAYERS && away.all.length >= MIN_OUTFIELD_PLAYERS) framesBothOkAll += 1;
    if (home.det.length >= MIN_OUTFIELD_PLAYERS && away.det.length >= MIN_OUTFIELD_PLAYERS) framesBothOkDet += 1;

    // ⚠️ **三个量必须在同一批帧上算**（否则比较被"取帧"污染——实测踩过）：
    // 全点 A 若覆盖所有帧、而随机 k / 仅真检测只覆盖 det≥7 的子集，两者比的是
    // 不同的帧集合，算出的「n 效应」会虚高（实测同一场虚高到 3.67m vs 真实的 1.30m）。
    // 只保留「全点 10 人 **且** 真检测 ≥7」的帧——三口径同帧可比。
    if (home.all.length !== 10 || home.det.length < MIN_OUTFIELD_PLAYERS) continue;
    const k = home.det.length;
    // 随机同规模子样本（20 次平均），**两个估计量共用同一批子样本**（控制变量）
    const subSamples = [];
    for (let rep = 0; rep < RANDOM_K_TRIALS; rep += 1) {
      const pool = [...home.all];
      for (let i = 0; i < k; i += 1) {
        const j = i + Math.floor(rng() * (pool.length - i));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      subSamples.push(pool.slice(0, k));
    }
    for (const [name, fn] of [['trim1', trim1], ['beta', betaSpan]]) {
      const a = fn(home.all);
      if (a != null) est[name].A.push(a);
      const b = fn(home.det);
      if (b != null) est[name].B.push(b);
      const vals = subSamples.map(fn).filter((v) => v != null);
      if (vals.length) est[name].Cm.push(mean(vals));
    }
  }
  const pack = (e) => ({
    all: mean(e.A), randK: mean(e.Cm), det: mean(e.B),
    nEffect: mean(e.A) != null && mean(e.Cm) != null ? mean(e.A) - mean(e.Cm) : null,
    detEffect: mean(e.Cm) != null && mean(e.B) != null ? mean(e.Cm) - mean(e.B) : null,
    n: { all: e.A.length, randK: e.Cm.length, det: e.B.length },
  });
  return {
    frameCount,
    framesBothOkAll,
    framesBothOkDet,
    trim1: pack(est.trim1),
    beta: pack(est.beta),
    nDistHome: [...nDist.home.entries()].sort((x, y) => x[0] - y[0]),
    nDistAway: [...nDist.away.entries()].sort((x, y) => x[0] - y[0]),
  };
}

// 逐窗：有效帧数（三口径）与丢帧率。
function windows(game) {
  if (!game.frames.length) return [];
  const T = game.frames[game.frames.length - 1].t;
  const out = [];
  for (let s = 0; s + WINDOW_SIZE_SEC <= T + 1; s += WINDOW_STEP_SEC) {
    const w = game.frames.filter((f) => f.t >= s && f.t < s + WINDOW_SIZE_SEC);
    let okAll = 0;
    let okDet = 0;
    for (const fr of w) {
      const { home, away } = fr.pts;
      if (home.all.length >= MIN_OUTFIELD_PLAYERS && away.all.length >= MIN_OUTFIELD_PLAYERS) okAll += 1;
      if (home.det.length >= MIN_OUTFIELD_PLAYERS && away.det.length >= MIN_OUTFIELD_PLAYERS) okDet += 1;
    }
    out.push({ startSec: Math.round(s), frames: w.length, okAll, okDet });
  }
  return out;
}

function main() {
  const dirIdx = process.argv.indexOf('--dir');
  const scDir = dirIdx > -1 ? resolve(process.argv[dirIdx + 1]) : DEFAULT_DIR;
  const jsonIdx = process.argv.indexOf('--json');
  const srcDir = join(scDir, 'opendata-master', 'data', 'matches');
  if (!existsSync(srcDir)) throw new Error(`找不到骨架：${srcDir}（先跑 node tools/fetch-tracking-data.mjs --dataset skillcorner-opendata）`);

  const ids = readdirSync(srcDir).sort();
  const rng = mulberry32(20260918); // 种子冻结
  const perGame = [];
  for (const id of ids) {
    const g = loadGame(scDir, join(srcDir, id, `${id}_match.json`));
    if (g.skipped) { console.log(`- ${id}: 跳过（${g.skipped}）`); continue; }
    const d = decompose(g, rng);
    const w = windows(g);
    perGame.push({ id: g.id, status: g.status, pitch: [g.L, g.W], shiftSec: Number(g.shift.toFixed(2)), ...d, windows: w });
    console.log(`- ${g.id} [${g.L}m]: 帧 ${d.frameCount}`
      + ` | 全点可用 ${(100 * d.framesBothOkAll / d.frameCount).toFixed(1)}%`
      + ` | 仅真检测可用 ${(100 * d.framesBothOkDet / d.frameCount).toFixed(1)}%`
      + ` | trim1 n效应 ${fmt(d.trim1.nEffect)} | beta n效应 ${fmt(d.beta.nEffect)}`);
  }

  const withData = perGame.filter((g) => g.beta && g.beta.all != null);
  const agg = (name, field) => mean(withData.map((g) => g[name][field]).filter((v) => v != null));
  const sumEff = (name) => {
    const nE = withData.reduce((a, g) => a + (g[name].nEffect || 0), 0);
    const dE = withData.reduce((a, g) => a + (g[name].detEffect || 0), 0);
    return { nE, dE, nPct: (100 * nE / (nE + dE)) };
  };

  console.log('\n=== 汇总（按场均值再平均）===');
  console.log(`场数（有数据）: ${withData.length}`);
  console.log('');
  console.log('估计量 A：trim1（P36 旧口径——**已废弃**，此处仅供对照）');
  console.log(`  全点10点    : ${fmt(agg('trim1', 'all'))} m`);
  console.log(`  随机同规模 k: ${fmt(agg('trim1', 'randK'))} m`);
  console.log(`  仅真检测    : ${fmt(agg('trim1', 'det'))} m`);
  { const e = sumEff('trim1');
    console.log(`  机械 n 效应 : ${fmt(e.nE / withData.length)} m (${e.nPct.toFixed(0)}%)`);
    console.log(`  检测选择效应: ${fmt(e.dE / withData.length)} m (${(100 - e.nPct).toFixed(0)}%)`); }
  console.log('');
  console.log('估计量 B：q10–q90（P37 β 口径——**已交付的默认口径**，见 viewer/match-metrics.js）');
  console.log(`  全点10点    : ${fmt(agg('beta', 'all'))} m`);
  console.log(`  随机同规模 k: ${fmt(agg('beta', 'randK'))} m`);
  console.log(`  仅真检测    : ${fmt(agg('beta', 'det'))} m`);
  { const e = sumEff('beta');
    console.log(`  机械 n 效应 : ${fmt(e.nE / withData.length)} m (${e.nPct.toFixed(0)}%)`);
    console.log(`  检测选择效应: ${fmt(e.dE / withData.length)} m (${(100 - e.nPct).toFixed(0)}%)`); }
  console.log('');
  console.log('→ 换 β 的收益：n 效应被压小（这正是用户拍板 β 的依据）；上面的两个块**口径分开标注**。');

  const sum = (fn) => withData.reduce((a, g) => a + (fn(g) || 0), 0);
  const okAll = sum((g) => g.framesBothOkAll) / sum((g) => g.frameCount);
  const okDet = sum((g) => g.framesBothOkDet) / sum((g) => g.frameCount);
  console.log(`\n全点可用帧占比   : ${(100 * okAll).toFixed(1)}%`);
  console.log(`仅真检测可用帧占比: ${(100 * okDet).toFixed(1)}%（丢帧 ${(100 * (1 - okDet)).toFixed(1)}%）`);
  const allW = perGame.flatMap((g) => g.windows);
  const okDetPerWin = allW.map((w) => w.okDet);
  console.log(`窗数 ${allW.length} | 每窗仅真检测可用帧：中位 ${median(okDetPerWin)}，全距 ${Math.min(...okDetPerWin)}–${Math.max(...okDetPerWin)}`);
  const below = okDetPerWin.filter((v) => v < 100).length;
  console.log(`落入 minFrames=100 之下的窗: ${below}（${below === 0 ? '即 minFrames 从未触发' : '需注意'}）`);

  if (jsonIdx > -1) {
    const out = process.argv[jsonIdx + 1];
    writeFileSync(out, `${JSON.stringify({ seed: 20260918, perGame, summary: {
      games: withData.length,
      trim1: { nEffect: sumEff('trim1').nE / withData.length, detEffect: sumEff('trim1').dE / withData.length },
      beta: { nEffect: sumEff('beta').nE / withData.length, detEffect: sumEff('beta').dE / withData.length },
      okAllPct: 100 * okAll, okDetPct: 100 * okDet, windows: allW.length,
      okDetPerWindow: { median: median(okDetPerWin), min: Math.min(...okDetPerWin), max: Math.max(...okDetPerWin) },
    } }, null, 1)}\n`);
    console.log(`\n→ ${out}`);
  }
}

function fmt(v) { return v == null ? '—' : v.toFixed(2); }

main();
