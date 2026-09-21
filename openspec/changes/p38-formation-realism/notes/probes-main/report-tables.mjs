// #102 报告表格生成器：**表从产物 JSONL 生成，不手工誊写**。
//
// 动机（审阅发现）：`notes/conversion-adaptive.md` §1.3 手工誊写的表里，
// 「−3.0」行把 seeds 401..600 的射门/进球与 seeds 1..200 的转化率/射正率**混在了一起**；
// 「干净 main」行的射正率串到了 `adapt-3.4` 那一行。
// 根因是 `engine-shot-quality.jsonl` 当时**不记种子区间**——同 wasm、同 label 前缀的
// 两次跑无法区分。探针已补 `seedsFrom`/`seedsTo`；本脚本把"誊写"这一步也去掉。
//
// 用法：
//   node report-tables.mjs                 # 打印 §1.3 表（L1 口径）
//   node report-tables.mjs --section 4.1   # 打印 §4.1 对照表
//   node report-tables.mjs --all

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '../probes/repo-root.mjs';

const ROOT = findRepoRoot(new URL('.', import.meta.url).pathname);
const OUT = join(ROOT, 'openspec/changes/p38-formation-realism/notes/probes-main/out');

const read = (f) => (existsSync(join(OUT, f))
  ? readFileSync(join(OUT, f), 'utf8').trim().split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  : []);

const quality = read('engine-shot-quality.jsonl');
const runs = read('conversion-runs.jsonl');

/** 按 label 找**最后一条**质量记录（同一 label 可被重跑覆盖，取最新才是当前事实）。
 *  ⚠️ 同时校验种子区间（防止把 1..200 的记录当成 401..600——本脚本存在的理由之一）。 */
function q(label, { from = null } = {}) {
  const hits = quality.filter((r) => r.label === label);
  const hit = hits[hits.length - 1];
  if (!hit) return null;
  if (from !== null && hit.seedsFrom !== from) {
    console.error(`⚠️ ${label} 的 seedsFrom=${hit.seedsFrom}，期望 ${from}——拒绝使用（防串行）`);
    return null;
  }
  return hit;
}

/** 同 `q`，但查转换配置记录（含 l1）。取**最后一条**——重跑会追加。 */
function runOf(label) {
  const hits = runs.filter((r) => r.label === label);
  return hits[hits.length - 1] || null;
}

const f = (v, n = 3) => (Number.isFinite(v) ? v.toFixed(n) : '—');
const B = ['禁区内', '禁区弧', '远射'];

// L1 门的三条比例带（`engine/tests/realism.rs:659-671`）
const GATE = [
  { g: [0.10, 0.20], s: [0.24, 0.36], o: [0.48, 0.60] },
  { g: [0.03, 0.12], s: [0.14, 0.30], o: [0.61, 0.75] },
  { g: [0.00, 0.08], s: [0.04, 0.18], o: [0.78, 0.92] },
];
const mark = (v, r) => (v >= r[0] && v <= r[1] ? '' : '❌');

function table13() {
  const labels = [
    ['干净 main', 'clean-main-401', '901da77b'],
    ['−4.0', 'vol-4.0-401', '513731b4'],
    ['−3.7', 'vol-3.7-401', '118683ad'],
    ['−3.4', 'vol-3.4-401', '75871fd9'],
    ['−3.0', 'vol-3.0-401', '8ffcb7b8'],
  ];
  console.log('| 配置 | wasm | 种子 | 射门/场 | 进球/场 | **转化率** | Wilson 95% CI | 射正率 | 桶转化(禁区内/弧/远) |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const [name, label, sha] of labels) {
    const r = q(label, { from: 401 });
    if (!r) { console.log(`| ${name} | — | — | ⚠️ 缺记录或种子区间不符 | | | | | |`); continue; }
    const b = r.depthBuckets.map((x) => f(x.conv, 4)).join(' / ');
    console.log(`| ${name} | \`${r.wasmSha8}\` | ${r.seedsFrom}..${r.seedsTo} | ${f(r.shotsPerMatch, 3)} | ${f(r.goalsPerMatch, 3)} | **${f(r.conversionPooled, 4)}** | [${f(r.conversionPooledCI[0], 3)}, ${f(r.conversionPooledCI[1], 3)}] | ${f(r.onTargetRatePooled, 3)} | ${b} |`);
  }
}

function table41() {
  const rowsList = [
    ['干净 main（对照）', 'clean-main-401', '901da77b'],
    ['`−3.4` 单独（**常数桶**）', 'vol-3.4-401', '75871fd9'],
    ['`−3.4` + `GoalOnly k=1.6`', 'goalonly-k1.6-3.4', null],
    ['`−3.4` + `Scale k=1.32`', 'flat-k1.32-3.4', null],
    ['`−3.4` + `Quality`（6 参数，含角度）', 'adapt-3.4', 'e0ed0329'],
    ['`−3.4` + `QualityMin`（2 参数，g18/s31）★', 'qmin-g18', 'ff87b7cf'],
    ['**`−3.4` + 三整数重标 17/9/6**', 'rebucket-17-9-6', 'deed8d69'],
    ['`−3.4` + `QualityMin`（**交付** g18.7/s27.4）', 'fit2-g18.7', 'd4f8c2da'],
    ['★ **留出集** 601..800（交付配置）', 'fit2-g18.7-holdout', 'd4f8c2da'],
  ];
  console.log('| 配置 | wasm | 射门/场 | 进球/场 | 转化率 | **射正率** | 禁区内 goal | L1 九门 |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const [name, label, sha] of rowsList) {
    // 质量记录既可能在 engine-shot-quality.jsonl，也可能只在 conversion-runs.jsonl 的 .quality
    const r = q(label) || (runOf(label) || {}).quality;
    if (!r) { console.log(`| ${name} | — | ⚠️ 缺记录 | | | | | |`); continue; }
    // ⚠️ L1 记录另存一条（label 带 `-l1` 后缀或同名）——**必须显式查**，
    //    否则这一列永远是 `—`（审阅指出：那会让表看起来"生成"实则手写）。
    const l1 = ((runOf(`${label}-l1`) || runOf(label)) || {}).l1;
    const l1txt = l1 ? `${l1.passed} 绿 ${l1.failed} 红` : '—（未跑）';
    console.log(`| ${name} | \`${r.wasmSha8}\` | ${f(r.shotsPerMatch, 3)} | **${f(r.goalsPerMatch, 3)}** | ${f(r.conversionPooled, 4)} | **${f(r.onTargetRatePooled, 3)}** | ${f(r.depthBuckets[0].goalRate, 3)} | ${l1txt} |`);
  }
}

function bucketGate(label) {
  const r = q(label) || (runOf(label) || {}).quality;
  if (!r) { console.log(`缺 ${label}`); return; }
  console.log(`\n=== ${label}（wasm ${r.wasmSha8}）逐桶 vs L1 三条带 ===`);
  for (let i = 0; i < 3; i++) {
    const b = r.depthBuckets[i];
    const t = b.goals + b.saved + b.off;
    const g = b.goals / t; const s = b.saved / t; const o = b.off / t;
    console.log(` ${B[i].padEnd(4)} n=${String(b.n).padStart(4)} share=${f(b.share, 3)} `
      + `goal=${f(g, 4)}${mark(g, GATE[i].g)} `
      + `saved=${f(s, 4)}${mark(s, GATE[i].s)} `
      + `off=${f(o, 4)}${mark(o, GATE[i].o)}`);
  }
  console.log(` 验收：射门/场 ${f(r.shotsPerMatch, 2)}（目标 ~16.5）  进球/场 ${f(r.goalsPerMatch, 3)}（目标 2.5–3.0）`
    + `  L3conv=${f(r.goalsPerMatch / (r.shotsPerMatch + (r.headerPerMatch || 0)), 4)}（门 ≤0.14）`);
}

const mode = process.argv.includes('--all') ? 'all'
  : process.argv.includes('--section') ? process.argv[process.argv.indexOf('--section') + 1] : '1.3';
if (mode === 'all' || mode === '1.3') { console.log('### §1.3（由 JSONL 生成）\n'); table13(); console.log(); }
if (mode === 'all' || mode === '4.1') { console.log('### §4.1（由 JSONL 生成）\n'); table41(); }
for (const l of process.argv.filter((a) => a.startsWith('--bucket=')).map((a) => a.slice(9))) bucketGate(l);
