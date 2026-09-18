#!/usr/bin/env node
// P37 交叉验证：真实侧**内部**的自洽性检验（half-split + leave-one-game-out）。
//
// ⚠️ **本阶段是报告项、不是门**（用户拍板 + design D7 + spec「先落报告项」requirement）。
// 理由（审阅 P1-3，已实测）：min/max 包含门的通过率 = `n(n−1)/((n+m)(n+m−1))`，
// 与样本量**无关**（N=20 时约 0.25）——它在数据完全正常时也会频繁"红"。
// 一个正常数据下通过率 25% 的判据不是门，是掷硬币。
// 升格为硬门须先满足三个前置条件（design D7）：零分布刻画 / 容差预注册 / 失败语义定义。
//
// 本工具因此**只输出数字**（落空数、最易落空的指标、分半种子），不产生绿/红。
//
// 两个检验：
//   - **half-split**（issue #78 的验收条件形态）：20 场随机分半（种子固定），
//     用一半导出的范围检查另一半的窗口有多少落不进去。
//   - **leave-one-game-out**（诊断）：用 19 场导出的范围检查剩下 1 场，逐场落空情况。
//
// 用法：
//   node tools/benchmark-crossvalidation.mjs [--baseline viewer/data/benchmark-baseline.json]
//   数据缺失（基线缺失/无逐窗数据）→ 跳过并退出 0（沿用 P36 惯例，见 verify.sh）

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_BASELINE_PATH = join(ROOT, 'viewer', 'data', 'benchmark-baseline.json');

// 分半种子：**冻结常数，记录在案**（对齐项目 L1 门「种子集冻结」；禁止按结果重挑分法）。
export const SPLIT_SEED = 20260918;

// 采用指标（与 benchmark-compare 的 ADOPTED_METRICS 一致）。
export const CV_METRICS = [['hd', '主队纵深'], ['spread', '紧凑度'], ['gap', '两队重心间距']];

// 确定性 RNG（禁止用 Math.random——分半须可复现）。
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher-Yates 洗牌（确定性）。
export function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 从逐窗记录导出一组「指标值」（每窗一个值）。
//   windows: [{startSec, frameCount, okPrimary, ...}]（基线的逐窗记录）
//   metricValues: [{<metric>: value, ...}]（每窗的指标值，与 windows 同序）
// 这里不重新算指标——直接消费基线已存的逐窗指标（避免口径分叉）。
// ⚠️ 基线目前**不存逐窗指标值**，只存摘要。故本工具从游戏级摘要无法做窗口级交叉验证——
// 需要逐窗值。为此基线须存逐窗指标（见下方 windowsFromGames 的说明）。
export function rangeOf(values) {
  if (!values.length) return null;
  return { min: Math.min(...values), max: Math.max(...values), n: values.length };
}

// half-split：分半后，用 A 的范围查 B 的窗口有多少落进去（以及反向）。
// values 是 {game, metric, value} 的列表；按**场次**分半（同一场的所有窗跟该场走——
// 窗口不独立，独立样本是场次，见 design D5）。
export function halfSplit(records, { seed = SPLIT_SEED, metrics = CV_METRICS.map(([k]) => k) } = {}) {
  const games = [...new Set(records.map((r) => r.game))].sort();
  const rng = mulberry32(seed);
  const shuffled = shuffle(games, rng);
  const halfA = new Set(shuffled.slice(0, Math.floor(games.length / 2)));
  const out = {};
  for (const metric of metrics) {
    const a = records.filter((r) => halfA.has(r.game) && r.metric === metric).map((r) => r.value);
    const b = records.filter((r) => !halfA.has(r.game) && r.metric === metric).map((r) => r.value);
    const ra = rangeOf(a);
    const rb = rangeOf(b);
    if (!ra || !rb) { out[metric] = null; continue; }
    const bOutsideA = b.filter((v) => v < ra.min || v > ra.max).length;
    const aOutsideB = a.filter((v) => v < rb.min || v > rb.max).length;
    out[metric] = {
      aRange: [ra.min, ra.max], bRange: [rb.min, rb.max],
      nA: ra.n, nB: rb.n,
      bOutsideA, aOutsideB,
      bOutsideAPct: 100 * bOutsideA / rb.n, aOutsideBPct: 100 * aOutsideB / ra.n,
      // 「A 容纳 B 的全部窗口」= 落空 0（issue #78 的原始形态）
      aContainsB: bOutsideA === 0,
      bContainsA: aOutsideB === 0,
    };
  }
  return { seed, halfA: [...halfA].sort(), halfB: games.filter((g) => !halfA.has(g)), perMetric: out };
}

// leave-one-game-out：每次留一场，用其余场的范围查这一场有多少窗落空。
export function leaveOneGameOut(records, { metrics = CV_METRICS.map(([k]) => k) } = {}) {
  const games = [...new Set(records.map((r) => r.game))].sort();
  const perGame = [];
  for (const g of games) {
    const entry = { game: g, perMetric: {} };
    for (const metric of metrics) {
      const rest = records.filter((r) => r.game !== g && r.metric === metric).map((r) => r.value);
      const mine = records.filter((r) => r.game === g && r.metric === metric).map((r) => r.value);
      const rr = rangeOf(rest);
      if (!rr || !mine.length) { entry.perMetric[metric] = null; continue; }
      const outside = mine.filter((v) => v < rr.min || v > rr.max).length;
      entry.perMetric[metric] = {
        restRange: [rr.min, rr.max], nRest: rr.n, nMine: mine.length,
        outside, outsidePct: 100 * outside / mine.length, contained: outside === 0,
      };
    }
    perGame.push(entry);
  }
  // 逐指标汇总：多少场未能被其余场容纳（最易落空的指标在这里显形）
  const perMetricSummary = {};
  for (const metric of metrics) {
    const entries = perGame.map((g) => g.perMetric[metric]).filter(Boolean);
    const failing = entries.filter((e) => !e.contained);
    perMetricSummary[metric] = {
      gamesFailing: failing.length,
      gamesTotal: entries.length,
      totalWindowsOutside: entries.reduce((a, e) => a + e.outside, 0),
      totalWindows: entries.reduce((a, e) => a + e.nMine, 0),
      worst: failing.sort((x, y) => y.outsidePct - x.outsidePct).slice(0, 3)
        .map((e) => ({ outsidePct: Number(e.outsidePct.toFixed(1)) })),
    };
  }
  return { perGame, perMetricSummary };
}

// 从基线取「逐场逐窗的指标值」。**基线须存逐窗指标**——P37 起 datasets[].games[].windows
// 只存了 frameCount/okPrimary，未存逐窗指标值。故本工具需要一个带 `windowMetrics` 的
// 基线（或直接传入 records）。若基线无该字段 → 返回 null，调用方跳过（不失败，P36 惯例）。
export function recordsFromBaseline(baseline, datasetKey) {
  const ds = baseline.datasets && baseline.datasets[datasetKey];
  if (!ds || !Array.isArray(ds.games)) return null;
  const recs = [];
  for (const g of ds.games) {
    if (!Array.isArray(g.windows)) return null;
    // 逐窗指标在 g.windows[i].windowMetrics（P37 起写入）
    if (!g.windows.every((w) => 'windowMetrics' in w)) return null; // 缺逐窗指标 → 无法做窗口级 CV
    g.windows.forEach((w, i) => {
      const wm = w.windowMetrics;
      if (!wm) return; // 该窗主口径无有效帧
      for (const [k] of CV_METRICS) if (wm[k] != null) recs.push({ game: g.game, window: i, metric: k, value: wm[k] });
    });
  }
  return recs;
}

export function render(cv) {
  const L = [];
  L.push('=== P37 交叉验证（真实侧内部自洽性检验）===');
  L.push('');
  L.push('⚠️ **报告项，不是门**（design D7 / 用户拍板）：min/max 包含门的通过率与样本量无关');
  L.push('   （N=20 约 0.25），正常数据下也会频繁"红"——本报告只给数字，不产生绿/红。');
  L.push('');
  L.push(`【half-split】种子 ${cv.halfSplit.seed}（冻结）｜A 半 ${cv.halfSplit.halfA.length} 场，B 半 ${cv.halfSplit.halfB.length} 场`);
  L.push(`  A 半：${cv.halfSplit.halfA.join(', ')}`);
  L.push(`  B 半：${cv.halfSplit.halfB.join(', ')}`);
  for (const [k, name] of CV_METRICS) {
    const v = cv.halfSplit.perMetric[k];
    if (!v) { L.push(`  ${name}：缺数据`); continue; }
    L.push(`  ${name.padEnd(12)} A [${v.aRange[0].toFixed(2)}–${v.aRange[1].toFixed(2)}]`
      + `  B [${v.bRange[0].toFixed(2)}–${v.bRange[1].toFixed(2)}]`
      + `　B 落空 A ${v.bOutsideA}/${v.nB}（${v.bOutsideAPct.toFixed(1)}%）`
      + `　A 落空 B ${v.aOutsideB}/${v.nA}（${v.aOutsideBPct.toFixed(1)}%）`);
  }
  L.push('');
  L.push('【leave-one-game-out】诊断：逐场排除，看哪场不被其余场容纳、哪个指标最易落空');
  for (const [k, name] of CV_METRICS) {
    const s = cv.loo.perMetricSummary[k];
    L.push(`  ${name.padEnd(12)} ${s.gamesFailing}/${s.gamesTotal} 场未被容纳`
      + `　落空窗口 ${s.totalWindowsOutside}/${s.totalWindows}（${(100 * s.totalWindowsOutside / Math.max(1, s.totalWindows)).toFixed(1)}%）`);
  }
  L.push('');
  L.push('读法：本报告回答"真实侧内部是否自洽"，**不回答"引擎是否像真实"**（那需要校准目标）。');
  return L.join('\n');
}

function main() {
  const idx = process.argv.indexOf('--baseline');
  const path = idx > -1 && process.argv[idx + 1] ? process.argv[idx + 1] : DEFAULT_BASELINE_PATH;
  if (!existsSync(path)) {
    console.log(`P37 交叉验证：跳过（基线缺失：${path}）\n  生成：node tools/benchmark-baseline.mjs`);
    return 0;
  }
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.log(`P37 交叉验证：跳过（基线损坏）\n  ${err.message}`);
    return 0;
  }
  const key = baseline.primaryDataset || Object.keys(baseline.datasets || {})[0];
  const records = recordsFromBaseline(baseline, key);
  if (!records) {
    console.log(`P37 交叉验证：跳过（基线 ${key} 无逐窗指标 windowMetrics —— 无法做窗口级交叉验证）`);
    return 0;
  }
  const cv = { halfSplit: halfSplit(records), loo: leaveOneGameOut(records) };
  console.log(render(cv));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
