// P38 #89：真实「贴身射门 vs 贴身传球」的**可分性**分析。
//
// 输入：probe-real-shot-pass.mjs 产出的 out/real-shot-pass.jsonl（事件时刻的几何特征）。
//
// 要回答的问题（#89 的核心假设）：
//   引擎里 `nearest_defender_m <= 8.0` 这一个标量**同时**决定射门与犯规 → 两端互斥。
//   若真实球员在贴身下**既射门也传球**，且区分二者的量**不是距离**而是别的维度，
//   那么把单标量门换成多维判断就有理论依据。
//
// 三层输出：
//   1. **能否射门的前置区**：把「射门候选」限制在射程内（dGoal ≤ 30m），看射门/传球比例
//   2. **逐特征分离度**：AUC（秩统计量，对样本量与量纲都稳健），全样本 + 仅贴身（d1≤4m）
//   3. **引擎自己的射门打分**：把 `compute_shot_score` 的五因子按 Rust 源码逐字重算，
//      看 SHOT 事件的分数分布是否高于 PASS —— 这是**最可行动**的一问：
//      若真实里「分数高就射、与压力无关」，引擎的硬门就是错的表示方式。
//
// 用法：node analyze-shot-pass.mjs [jsonl 路径]

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PITCH_LENGTH_M } from '../../../../../viewer/match-metrics.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const path = process.argv[2] || join(HERE, 'out/real-shot-pass.jsonl');
if (!existsSync(path)) { console.error(`缺 ${path}，先跑 probe-real-shot-pass.mjs`); process.exit(1); }
const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const qs = (s, p) => { if (!s.length) return NaN; const h = (s.length - 1) * p; const lo = Math.floor(h); const hi = Math.ceil(h); return s[lo] + (h - lo) * (s[hi] - s[lo]); };

/** AUC = P(随机一个 shot 的特征值 > 随机一个 pass 的)。0.5 = 无区分力。 */
function auc(pos, neg) {
  if (!pos.length || !neg.length) return NaN;
  const all = [...pos.map((v) => [v, 1]), ...neg.map((v) => [v, 0])].sort((a, b) => a[0] - b[0]);
  // 秩和法（含并列取平均秩）
  const rank = new Array(all.length);
  let i = 0;
  while (i < all.length) {
    let j = i; while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j += 1;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) rank[k] = r;
    i = j + 1;
  }
  let sumPos = 0;
  for (let k = 0; k < all.length; k += 1) if (all[k][1] === 1) sumPos += rank[k];
  const n1 = pos.length; const n0 = neg.length;
  return (sumPos - n1 * (n1 + 1) / 2) / (n1 * n0);
}

// ── 引擎射门打分（与 engine/src/lib.rs 逐字对齐）────────────────────────
// ⚠️ 常数改动时这里必须同步；漂移了本脚本就在测别的东西。
// 审阅发现过一次漂移：`SHOT_SPACE_MIN/MAX_M` 曾写成 1.5/5.0，而源码是 **2.0/8.0**
// （lib.rs:540/542）——这是 2026-09-20 修掉的。**改常量后请回读本块**。
const BASE_SHOT_TENDENCY = -4.0;   // lib.rs:527
const SHOT_FACTOR_GAIN = 2.5;      // lib.rs:529
const SHOT_PRESSURE_NEAR_M = 8.0;  // lib.rs:533
const SHOT_PRESSURE_SECOND_M = 16.0; // lib.rs:535
const SHOT_SPACE_MIN_M = 2.0;      // lib.rs:540
const SHOT_SPACE_MAX_M = 8.0;      // lib.rs:542
const BOX_DIST_M = 16.5, ARC_DIST_M = 25.0;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, t) => a + (b - a) * clamp01(t);
const spaceScore = (d) => (Number.isFinite(d) ? clamp01((d - SHOT_SPACE_MIN_M) / (SHOT_SPACE_MAX_M - SHOT_SPACE_MIN_M)) : 1);

function distanceQuality(d) {
  if (d <= 6.0) return 1.0;
  if (d <= BOX_DIST_M) return lerp(1.0, 0.9, (d - 6.0) / (BOX_DIST_M - 6.0));
  if (d <= ARC_DIST_M) return lerp(0.9, 0.45, (d - BOX_DIST_M) / (ARC_DIST_M - BOX_DIST_M));
  if (d <= 35.0) return lerp(0.45, 0.05, (d - ARC_DIST_M) / (35.0 - ARC_DIST_M));
  return lerp(0.05, 0.0, (d - 35.0) / (PITCH_LENGTH_M - 35.0));
}
// `distKey`：用哪个球门距离口径。**引擎用 `dGoalX`**（= `dist_to_goal_m`，只按纵深）；
// `dGoal`（欧氏）并列报告，用来说明这个口径选择对结论有没有影响。
// ⚠️ `cooldown_penalty` 无法从 tracking 观测 → **省略**。故这不是 `compute_shot_score` 本身，
// 是它的**四因子近似**（pressure_state 同样缺失）。
const scoreOf = (r, distKey = 'dGoalX') => {
  const dq = distanceQuality(r[distKey]);
  const aq = clamp01(Math.max(0, r.angleCos));
  const space = 0.65 * spaceScore(r.d1) + 0.35 * spaceScore(r.d2);
  const pressure = 0.65 * clamp01(1 - r.d1 / SHOT_PRESSURE_NEAR_M) + 0.35 * clamp01(1 - r.d2 / SHOT_PRESSURE_SECOND_M);
  return BASE_SHOT_TENDENCY + SHOT_FACTOR_GAIN * (dq + aq + space - pressure);
};

const FEATURES = [
  ['dGoal', '到球门距离 m', '缺射程就免谈'],
  ['angleCos', '射门角度 cos', '面向球门'],
  ['d1', '第 1 近防守者 m', '引擎唯一的门'],
  ['d2', '第 2 近防守者 m', '待命层'],
  ['oppGoalSide', '球门侧 15m 内对手数', '身前有没有堵'],
  ['laneBlocked', '球门线被挡 0/1', '射线是否封堵'],
  ['d2GoalSide', '第 2 近在球门侧 0/1', '身前有无第二层'],
  ['mateDist', '最近队友 m', '有没有出球选择'],
  ['nMate10', '10m 内队友数', '支援密度'],
  ['nOpp8', '8m 内对手数', '包夹程度'],
  ['inBox', '禁区内 0/1', '位置语义'],
];
// AUC 的**方向**：先验上「大值更该射门」的特征期望 AUC > 0.5；空间类特征（d1/d2）也期望 >0.5
const report = (label, sub) => {
  const S = sub.filter((r) => r.action === 'shot');
  const P = sub.filter((r) => r.action === 'pass');
  console.log(`\n── ${label}：射门 ${S.length} / 传球 ${P.length}`);
  if (S.length < 5 || P.length < 5) { console.log('   （某一侧样本 <5，跳过）'); return null; }
  const out = {};
  console.log(`   ${'特征'.padEnd(22)} ${'射门中位'.padStart(9)} ${'传球中位'.padStart(9)} ${'AUC'.padStart(7)}  ${'独有？'.padStart(6)}`);
  for (const [k, name] of FEATURES) {
    const a = S.map((r) => r[k]).filter(Number.isFinite);
    const b = P.map((r) => r[k]).filter(Number.isFinite);
    const A = auc(a, b);
    const sa = [...a].sort((x, y) => x - y); const sb = [...b].sort((x, y) => x - y);
    out[k] = A;
    console.log(`   ${name.padEnd(22)} ${qs(sa, 0.5).toFixed(2).padStart(9)} ${qs(sb, 0.5).toFixed(2).padStart(9)} ${A.toFixed(3).padStart(7)}`);
  }
  // 引擎打分（复合量，四因子近似）。两个距离口径并列——口径选择的影响必须可见。
  for (const [key, name] of [['dGoalX', '★引擎打分(引擎口径)'], ['dGoal', '★引擎打分(欧氏口径)']]) {
    const sScore = S.map((r) => scoreOf(r, key)); const pScore = P.map((r) => scoreOf(r, key));
    const sa = [...sScore].sort((x, y) => x - y); const sb = [...pScore].sort((x, y) => x - y);
    const A = auc(sScore, pScore);
    console.log(`   ${name.padEnd(21)} ${qs(sa, 0.5).toFixed(2).padStart(9)} ${qs(sb, 0.5).toFixed(2).padStart(9)} ${A.toFixed(3).padStart(7)}`);
    if (key === 'dGoalX') out.engineScore = A;
    else out.engineScoreEuclid = A;
  }
  // 两个球门距离口径本身的可分性（差多少）
  {
    const a = S.map((r) => r.dGoalX).filter(Number.isFinite);
    const b = P.map((r) => r.dGoalX).filter(Number.isFinite);
    console.log(`   ${'到球门距离(仅纵深,引擎)'.padEnd(20)} ${qs([...a].sort((x, y) => x - y), 0.5).toFixed(2).padStart(9)} ${qs([...b].sort((x, y) => x - y), 0.5).toFixed(2).padStart(9)} ${auc(a, b).toFixed(3).padStart(7)}`);
  }
  // 逐球门距离分层：贴身条件下「射门概率」随距离怎么变
  return out;
};

console.log('=== 真实：射门 vs 传球 的可分性 ===');
console.log(`总样本 ${rows.length}（射门 ${rows.filter((r) => r.action === 'shot').length}）`);

// 射门概率随 dGoal 的分布——先看「射程」在哪
console.log('\n[射门/事件 比例 随到球门距离]');
{
  const bins = [[0, 10], [10, 16.5], [16.5, 25], [25, 30], [30, 40], [40, 60], [60, 200]];
  for (const [lo, hi] of bins) {
    const sub = rows.filter((r) => r.dGoal >= lo && r.dGoal < hi);
    const s = sub.filter((r) => r.action === 'shot').length;
    if (sub.length) console.log(`   ${String(lo).padStart(3)}–${String(hi).padEnd(4)}m  n=${String(sub.length).padStart(4)}  射门 ${String(s).padStart(2)}  比例 ${(100 * s / sub.length).toFixed(1)}%`);
  }
}

const inRange = rows.filter((r) => r.dGoal <= 30);
report('A. 全部（dGoal ≤ 30m）', inRange);
report('B. ★贴身（dGoal ≤ 30m 且 d1 ≤ 4m）', inRange.filter((r) => r.d1 <= 4));
report('C. 稍宽压力（dGoal ≤ 30m 且 d1 ≤ 8m，引擎门的口径）', inRange.filter((r) => r.d1 <= 8));
report('D. 无压（dGoal ≤ 30m 且 d1 > 8m）', inRange.filter((r) => r.d1 > 8));

console.log('\n读法：AUC ≈ 0.5 = 该维度**完全不区分**射门与传球。');
console.log('     若「贴身」子集里所有维度都 ≈0.5，则 #89 的假设（多维可分）被证伪。');
