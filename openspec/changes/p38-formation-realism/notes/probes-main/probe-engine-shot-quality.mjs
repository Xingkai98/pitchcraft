// P38 #102：**引擎侧**射门质量 vs 结果的完整交叉表（200+ 种子，L1 量级）。
//
// 为什么需要它：`sweep-volume.mjs` / `probe-conversion-adaptive.mjs` 走的是 10 种子快车道，
// 而**转化率是比率统计量**——10 种子上「禁区内转化率」能 0.128→0.270 地跳（本文件实测），
// 那是采样噪声不是机制。判「转化率是不是常数」必须用 L1 量级的样本（≥200 种子）。
//
// 输出（每档）：
//   - 总转化率 + 二项 95% CI（逐场算再平均 *与* pool 两口径都报）
//   - 按**纵深桶**（= 引擎 `shot_bucket` 口径，x-only）的 n / goal / conv
//   - 按**欧氏桶**（depth + y 角向；真实侧的自然口径）的 n / goal / conv
//   - **交叉表** depth × euclid —— 引擎在「纵深在禁区内但欧氏在禁区弧」那一格上有多少射门？
//     这一格就是「只按纵深分桶」与「真实距离」的全部差额。
//   - 角度（`angle_cos`）、最近防守者距离 的分箱转化率
//   - 头球射门（另一条通道）单独报
//
// 用法：node probe-engine-shot-quality.mjs [标签] [种子数]
//   node probe-engine-shot-quality.mjs clean-main 200
// 环境：SEEDS_FROM（起始种子，缺省 1）、SEEDS_STEP

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { findRepoRoot } from '../probes/repo-root.mjs';

const ROOT = findRepoRoot(new URL('.', import.meta.url).pathname);
// 取位置参数时要**跳过带值的旗标**（`--dump <path>` 的 path 会被当成位置参数——
// 曾因此让 `N = Number('--dump') = NaN`，循环 0 次、静默产出空表）。
const POS = (() => {
  const a = process.argv.slice(2); const out = [];
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].startsWith('--')) { if (a[i] === '--dump') i += 1; continue; }
    out.push(a[i]);
  }
  return out;
})();
const label = POS[0] || 'current';
const N = Number(POS[1] || 200);
if (!Number.isFinite(N) || N <= 0) throw new Error(`种子数解析失败：${JSON.stringify(POS)}`);
const FROM = Number(process.env.SEEDS_FROM || 1);

const PITCH_LENGTH_M = 105.0;
const PITCH_WIDTH_M = 68.0;
const ENGINE_DURATION_SEC = 5400;
const BOX_DIST_M = 16.5;
const ARC_DIST_M = 25.0;
const BUCKETS = ['box', 'arc', 'far'];

const WASM = join(ROOT, 'viewer/engine.wasm');
const sha8 = createHash('sha256').update(readFileSync(WASM)).digest('hex').slice(0, 8);

const { loadEngineWasm, simulateStream } = await import(`${ROOT}/tools/benchmark-engine.mjs`);
const L = await loadEngineWasm(WASM);
if (!L.ok) throw new Error(L.message);

/** Wilson 95% 置信区间（比率统计量必须带区间——本区间的宽度就是「10 种子为什么不能判」的答案）。 */
function wilson(k, n) {
  if (!n) return [NaN, NaN];
  const z = 1.96; const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - s) / d, (c + s) / d];
}

const bucketOf = (d) => (d <= BOX_DIST_M ? 0 : d <= ARC_DIST_M ? 1 : 2);
const acc = (n, g) => ({ n, goal: g, conv: n ? g / n : NaN, ci: wilson(g, n) });

// `--dump <path>`：把**逐条**射门（纵深/欧氏/角度/结果）落盘。
// 用途：在 JS 里对候选转化率曲线做**解析**扫描（秒级），再决定编哪几个 Rust 变体——
// 避免"N 个参数 × 30 秒编译 × 200 场"的暴力搜索。
const DUMP = (() => { const i = process.argv.indexOf('--dump'); return i >= 0 ? process.argv[i + 1] : null; })();
const dumpRows = [];

const stats = {
  matches: 0,
  shots: 0, goals: 0, saved: 0, off: 0,
  header: 0, headerGoal: 0, headerSaved: 0,
  depth: [0, 1, 2].map(() => ({ n: 0, goal: 0, saved: 0, off: 0 })),
  euclid: [0, 1, 2].map(() => ({ n: 0, goal: 0, saved: 0, off: 0 })),
  cross: Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => ({ n: 0, goal: 0 }))),
  // 质量维度的分箱（引擎起脚瞬间的几何；口径与 `shot_opportunity_features` 一致）
  angle: [[0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1.01]].map(([lo, hi]) => ({ lo, hi, n: 0, goal: 0 })),
  convTally: { perMatch: [], pooled: [0, 0] },
};
const perMatchConv = [];

for (let i = 0; i < N; i += 1) {
  const seed = FROM + i;
  let ev;
  try { ev = JSON.parse(simulateStream(L.wasm, seed, ENGINE_DURATION_SEC)); } catch { continue; }
  stats.matches += 1;
  const shots = ev.filter((e) => e.type === 'shot');
  const reg = shots.filter((e) => e.detail !== 'header');
  const hdr = shots.filter((e) => e.detail === 'header');
  stats.header += hdr.length;
  stats.headerGoal += hdr.filter((e) => e.result === 'goal').length;
  stats.headerSaved += hdr.filter((e) => e.result === 'saved').length;
  let mg = 0;
  for (const e of reg) {
    const home = e.subject <= 10;
    const dx = (home ? 1.0 - e.x : e.x) * PITCH_LENGTH_M;
    const dy = (home ? 0.5 - e.y : e.y - 0.5) * PITCH_WIDTH_M;
    const de = Math.hypot(dx, dy);
    const bd = bucketOf(dx); const be = bucketOf(de);
    stats.shots += 1;
    stats.depth[bd].n += 1; stats.euclid[be].n += 1;
    stats.cross[bd][be].n += 1;
    if (e.result === 'goal') {
      stats.goals += 1; mg += 1;
      stats.depth[bd].goal += 1; stats.euclid[be].goal += 1; stats.cross[bd][be].goal += 1;
    }
    if (e.result === 'saved') { stats.saved += 1; stats.depth[bd].saved += 1; stats.euclid[be].saved += 1; }
    if (e.result === 'off_target') { stats.off += 1; stats.depth[bd].off += 1; stats.euclid[be].off += 1; }
    // 头球不进 `reg`（走 emit_header_shot 另一条通道），只在这里计数供对照。
    const ang = de > 1e-9 ? dx / de : 1.0;
    for (const b of stats.angle) if (ang >= b.lo && ang < b.hi) { b.n += 1; if (e.result === 'goal') b.goal += 1; }
    if (DUMP) dumpRows.push({ seed, depth: +dx.toFixed(3), eu: +de.toFixed(3), ang: +ang.toFixed(4), goal: e.result === 'goal' ? 1 : 0 });
  }
  perMatchConv.push(reg.length ? mg / reg.length : NaN);
  stats.convTally.pooled[0] += stats.goals; // 占位（下面重算）
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const nz = perMatchConv.filter(Number.isFinite);

const out = {
  label,
  // ⚠️ **必须记种子区间**（#102 审阅发现）：`seedsFrom`/`seedsTo` 缺失时，
  // 同 wasm 哈希、同 label 前缀的两次跑（如 seeds 1..200 与 401..600）写进
  // 同一个 `engine-shot-quality.jsonl` 后**无法区分**——报告里手工誊写就会串行。
  // 这个字段是"表能从 JSONL 生成"的前提。
  seedsFrom: FROM, seedsTo: FROM + N - 1, seedsRequested: N,
  wasmSha8: sha8, matches: stats.matches,
  shotsPerMatch: +(stats.shots / stats.matches).toFixed(3),
  goalsPerMatch: +((stats.goals + stats.headerGoal) / stats.matches).toFixed(3),
  regularGoalsPerMatch: +(stats.goals / stats.matches).toFixed(3),
  headerPerMatch: +(stats.header / stats.matches).toFixed(3),
  headerGoalsPerMatch: +(stats.headerGoal / stats.matches).toFixed(3),
  headerConv: stats.header ? +(stats.headerGoal / stats.header).toFixed(4) : NaN,
  conversionPooled: +(stats.goals / stats.shots).toFixed(4),
  conversionPooledCI: wilson(stats.goals, stats.shots).map((v) => +v.toFixed(4)),
  conversionPerMatch: +mean(nz).toFixed(4),
  conversionPerMatchSem: +(sd(nz) / Math.sqrt(nz.length)).toFixed(4),
  onTargetRatePooled: +((stats.goals + stats.saved) / stats.shots).toFixed(4),
  // ⚠️ 桶必须给**三个结果的原始计数**（goal/saved/off），不能只给 goal。
  //    `engine/tests/realism.rs::l1_shot_result_distributions` 断言的正是逐桶的
  //    goal/saved/off **比例**——只报 goal 比例无法判断那条门会不会红。
  depthBuckets: BUCKETS.map((b, i) => ({
    bucket: b, n: stats.depth[i].n, share: +(stats.depth[i].n / stats.shots).toFixed(4),
    goals: stats.depth[i].goal, saved: stats.depth[i].saved, off: stats.depth[i].off,
    ...acc(stats.depth[i].n, stats.depth[i].goal),
    goalRate: stats.depth[i].n ? +(stats.depth[i].goal / stats.depth[i].n).toFixed(4) : NaN,
    savedRate: stats.depth[i].n ? +(stats.depth[i].saved / stats.depth[i].n).toFixed(4) : NaN,
    offRate: stats.depth[i].n ? +(stats.depth[i].off / stats.depth[i].n).toFixed(4) : NaN,
    convCI: stats.depth[i].n ? wilson(stats.depth[i].goal, stats.depth[i].n).map((v) => +v.toFixed(3)) : [NaN, NaN],
  })),
  euclidBuckets: BUCKETS.map((b, i) => ({
    bucket: b, n: stats.euclid[i].n, share: +(stats.euclid[i].n / stats.shots).toFixed(4),
    goals: stats.euclid[i].goal, saved: stats.euclid[i].saved, off: stats.euclid[i].off,
    ...acc(stats.euclid[i].n, stats.euclid[i].goal),
    goalRate: stats.euclid[i].n ? +(stats.euclid[i].goal / stats.euclid[i].n).toFixed(4) : NaN,
    savedRate: stats.euclid[i].n ? +(stats.euclid[i].saved / stats.euclid[i].n).toFixed(4) : NaN,
    offRate: stats.euclid[i].n ? +(stats.euclid[i].off / stats.euclid[i].n).toFixed(4) : NaN,
    convCI: stats.euclid[i].n ? wilson(stats.euclid[i].goal, stats.euclid[i].n).map((v) => +v.toFixed(3)) : [NaN, NaN],
  })),
  crossDepthEuclid: [0, 1, 2].map((i) => BUCKETS.map((b, j) => ({
    depth: BUCKETS[i], euclid: b, n: stats.cross[i][j].n, goal: stats.cross[i][j].goal,
    conv: stats.cross[i][j].n ? +(stats.cross[i][j].goal / stats.cross[i][j].n).toFixed(4) : NaN,
  }))),
  angleBins: stats.angle.map((b) => ({
    range: `${b.lo}-${b.hi}`, n: b.n, goal: b.goal,
    conv: b.n ? +(b.goal / b.n).toFixed(4) : NaN,
    ci: b.n ? wilson(b.goal, b.n).map((v) => +v.toFixed(3)) : [NaN, NaN],
  })),
};

console.log(JSON.stringify(out, null, 2));
const OUT = join(ROOT, 'openspec/changes/p38-formation-realism/notes/probes-main/out');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
if (DUMP) {
  // 绝对路径直接用；相对路径锚到仓库根（不依赖 cwd——P38 踩过"看似有效实则串味"）
  const dumpPath = DUMP.startsWith('/') ? DUMP : join(ROOT, DUMP);
  writeFileSync(dumpPath, `${JSON.stringify({ label, wasmSha8: sha8, matches: stats.matches, shots: dumpRows })}\n`);
  console.log(`[dump] ${DUMP}（${dumpRows.length} 条射门）`);
}
const file = join(OUT, 'engine-shot-quality.jsonl');
const prev = existsSync(file) ? readFileSync(file, 'utf8') : '';
const lines = prev.split('\n').filter((l) => l.trim() !== '' && !l.includes(`"label":"${label}"`));
lines.push(JSON.stringify(out));
writeFileSync(file, `${lines.join('\n')}\n`);
