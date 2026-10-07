// 视觉审阅：**real-anchored 损失表**——「这版引擎离真实足球多远」的单一标量。
//
// ── 为什么有它（飞轮的三次失败）─────────────────────────────────────────────
// P143r 三版（v1 / v2g-g3 / FB4）都是「指标变好、用户看不出」。事后实测定位到飞轮的结构缺陷：
//   1. **没有损失函数**：motion-metrics 并排报引擎数与真实数，但**没有"离真实多远"的标量**。
//      于是 loop 优化了「方向一致性 dir」——而 main 的 dir 本来就 0.63 ≈ 真实 0.70（**没信号**），
//      v2 分支把它抬到 0.80 是**分支自己的问题**，不是 main 的。三版都在优化一个 main 已过关的量。
//   2. **最大的缺口不在视野里**：`gap`（两队重心间距）=「机械分边」——引擎 ~23m vs 真实 ~5m
//      （**4.4×**，全场最大缺口之一；按 |ln| 数值 disp 更大，但 gap 是用户一号抱怨），
//      而 motion-metrics **根本不输出它**，L1 统计带也不覆盖它。⇒ 用户最不满的点无数字承载。
//   3. **阈值与眼睛脱钩**：motion-metrics 的「静止 = 窗内位移 <0.5m」= 真实位移（13.46m）的 **1/27**。
//      FB4 位移 ~3.6m（真实 13.46m 的 **27%**）在这阈值上算「0% 静止」——数字说在跑，眼睛说没动。
//
// ── 口径（本仓头号纪律：别缺口径 ⇒ 不可比）─────────────────────────────────
// **结构量**（hd/ad/spread/gap/width/ballDist）：
//   真实锚 = **committed 基线** `viewer/data/benchmark-baseline.json` 的 `datasets.<primary>`
//   （primary = skillcorner，20 场 139 窗——**入库、CI 可跑**，不是 gitignore 的帧）；
//   引擎 = 现算，**同一聚合**（`cutWindows(300s) → windowMetrics.primary → 跨窗均值`）——
//   与基线 `summarizeWindowMetrics` 同一方法，故两侧可比。
// **运动量**（disp 端点位移/窗）：基线不含 → 两侧都从帧算（引擎现算；真实用 Metrica 帧，
//   `viewer/data/real-game-*.json`，**本地 gitignore**）→ 无帧时该行标 n/a（不静默填 0）。
//
// **距离 = 幅度量的 mean |ln(引擎/真实)|**（对数比 → 对称、不奖励"往一个方向过冲"）。
// **有界量（dir/still）不做对数比**（比值无意义）→ 单列为性质旗标。
//
// 用法：node tools/visual-review/like-football.mjs [engine.wasm] [seeds] [winSec]
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
const { createGame } = await import(join(ROOT, 'viewer/game.js'));
const { windowStats } = await import(join(ROOT, 'tools/visual-review/motion-metrics.mjs'));

const IS_ENTRY = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
const mean = a => a.reduce((u, v) => u + v, 0) / a.length;
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

// 幅度量：{key, label, from}。from='shape' → windowMetrics 键；from='motion' → windowStats 的 disp。
export const LOSS_METRICS = [
  { key: 'hd', label: '纵深(主)', from: 'shape' },
  { key: 'ad', label: '纵深(客)', from: 'shape' },
  { key: 'spread', label: '紧凑度', from: 'shape' },
  { key: 'gap', label: '分边★', from: 'shape' },
  { key: 'width', label: '宽度', from: 'shape' },
  { key: 'ballDist', label: '球距', from: 'shape' },
  { key: 'disp', label: '位移/窗★', from: 'motion' },
  { key: 'lat', label: '横向占比★', from: 'motion' },   // 「铁轨」信号：main 0.147 vs 真实 0.44
  { key: 'mix', label: '混队度★', from: 'motion' },     // 「两队是否混」：main 0.64 vs 真实 0.73（FB4 没改善）
];
export const SHAPE_KEYS = LOSS_METRICS.filter(m => m.from === 'shape').map(m => m.key);

// ── 帧 → 结构量（与基线同口径：cutWindows 300s → windowMetrics.primary → 跨窗均值）──
export function shapeFromFrames(frames) {
  const wins = mm.cutWindows(frames);
  const acc = {};
  for (const w of wins) {
    const p = mm.windowMetrics(w).primary;
    if (!p) continue;
    for (const k of SHAPE_KEYS) if (p[k] != null) (acc[k] ||= []).push(p[k]);
  }
  const out = {};
  for (const k of SHAPE_KEYS) out[k] = acc[k] ? mean(acc[k]) : null;
  return out;
}

// ── 真实结构锚：**committed 基线**（primary 数据集）。返回 { primary:{...}, perDataset:{...} } ──
export function realShapeFromBaseline(path) {
  const b = JSON.parse(readFileSync(path, 'utf8'));
  const per = {};
  for (const [key, ds] of Object.entries(b.datasets || {})) {
    per[key] = {};
    for (const k of SHAPE_KEYS) per[key][k] = ds.perMetric?.[k]?.avg ?? null;
  }
  return { primary: b.primaryDataset, shape: per[b.primaryDataset] || null, perDataset: per };
}

// ── 引擎：一个 wasm → { shape, motion }（结构量同基线口径；运动量跨 12s 窗中位）──
// seeds 缺省 = 基线的 BENCHMARK_SEEDS（[42,1,7,99,123]），使引擎结构量与 committed
// `baseline.engine.perMetric` **逐位可比**（同口径 + 同种子集 → 数字应复现）。
export async function engineProfile(wasmPath, seeds, winSec) {
  const { wasm } = await loadEngineWasm(wasmPath);
  const shapeAcc = {}; const disp = [], dir = [], still = [], lat = [], mix = [];
  for (let s = 0; s < seeds; s++) {
    const frames = mm.sampleEngineFrames(createGame(simulateStream(wasm, mm.BENCHMARK_SEEDS[s % mm.BENCHMARK_SEEDS.length], mm.ENGINE_DURATION_SEC)));
    const sh = shapeFromFrames(frames);
    for (const k of SHAPE_KEYS) if (sh[k] != null) (shapeAcc[k] ||= []).push(sh[k]);
    const ws = windowStats(frames, winSec);
    disp.push(...ws.disp); dir.push(...ws.dir); still.push(...ws.still);
    lat.push(...ws.lat); mix.push(...ws.mix);
  }
  const shape = {}; for (const k of SHAPE_KEYS) shape[k] = shapeAcc[k] ? mean(shapeAcc[k]) : null;
  return { shape, motion: { disp: median(disp), dir: median(dir), still: median(still), lat: median(lat), mix: median(mix) } };
}

// ── 真实运动锚：帧（本地 gitignore）→ { disp, dir, still }；无帧返回 null（不静默填 0）──
export function realMotionFromFrames(paths, winSec) {
  const disp = [], dir = [], still = [], lat = [], mix = [];
  for (const p of paths) {
    let g; try { g = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
    const frames = g.frames.map(f => mm.fromTrackingFrame(f, { pitchMeters: g.meta && g.meta.pitchMeters ? [g.meta.pitchMeters.length, g.meta.pitchMeters.width] : null }));
    const ws = windowStats(frames, winSec);
    disp.push(...ws.disp); dir.push(...ws.dir); still.push(...ws.still);
    lat.push(...ws.lat); mix.push(...ws.mix);
  }
  if (!disp.length) return null;
  return { disp: median(disp), dir: median(dir), still: median(still), lat: median(lat), mix: median(mix) };
}

// 退化引擎（某量为 0/负）时的对数缺口上限：|ln(0)| 发散，但那**正是最大缺口**，
// 绝不能因「算不出对数」把该行**静默剔除**（那会给「完全静止的引擎」最低距离 = 奖励最坏情形）。
// CAP ≈ e^4 ≈ 55×，远大于任何实测缺口（最大约 4.8×），确保退化排在最前。
export const CAP_LN = 4.0;

// 损失表：引擎 vs 真实（锚）→ 每量比值 + |ln|，返回 {rows, loss, flags, worst, coverage}。
// **纯函数**（好测）。
//   - `coverage = {used, total}`：进了距离的**行数 / 总行数**。两侧都缺数据（如本地无运动帧）
//     的行才被剔除；**引擎值为 0 不算缺失**（按 CAP_LN 罚）。**距离必须与该覆盖数一起读**
//     （否则 7 行均值与 6 行均值会被盲比——旧实现正是如此，飞轮 review P2c）。
export function lossTable(eng, real) {
  const val = (p, m) => m.from === 'shape' ? p.shape[m.key] : p.motion[m.key];
  const rows = LOSS_METRICS.map(m => {
    const e = val(eng, m), r = val(real, m);
    const present = e != null && r != null && r > 0;              // 引擎值 0 仍算 present（退化要罚）
    const ratio = present && e > 0 ? e / r : null;
    const gap = present ? Math.min(Math.abs(e > 0 ? Math.log(ratio) : Infinity), CAP_LN) : null;
    return { ...m, engine: e, real: r, ratio, gap };
  });
  const withGap = rows.filter(r => r.gap != null);
  const loss = withGap.length ? withGap.reduce((a, r) => a + r.gap, 0) / withGap.length : null;
  const worst = withGap.slice().sort((a, b) => b.gap - a.gap)[0] || null;
  const flags = {
    dirEngine: eng.motion.dir, dirReal: real.motion.dir,
    stillEngine: eng.motion.still, stillReal: real.motion.still,
    // real-anchored 静止：位移相对真实的比（0.5m 魔法阈值已废）
    dispRatio: eng.motion.disp != null && real.motion.disp ? eng.motion.disp / real.motion.disp : null,
  };
  return { rows, loss, flags, worst, coverage: { used: withGap.length, total: LOSS_METRICS.length } };
}

const fmt = v => v == null ? '  n/a ' : (typeof v === 'number' ? v.toFixed(2) : String(v));
const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol;

export function formatLossTable(eng, real, { wasmPath, sha, seeds, winSec, realLabel, motionLabel } = {}) {
  const { rows, loss, flags, worst, coverage } = lossTable(eng, real);
  const L = [];
  L.push(`═══ 像不像足球 · 引擎 vs 真实（real-anchored 损失表）═══`);
  L.push(`wasm=${wasmPath} sha8=${sha}  seeds=${seeds}  win=${winSec}s`);
  L.push(`真实锚（结构）=${realLabel}   真实锚（运动）=${motionLabel}`);
  L.push('');
  L.push('类别      指标        引擎      真实      比值E/R   |ln(E/R)|   ── 缺口');
  for (const r of rows) {
    const cls = r.from === 'motion' ? '运动' : '结构';
    const rr = r.ratio != null ? r.ratio.toFixed(2) : '  n/a';
    const gg = r.gap != null ? r.gap.toFixed(2) : ' n/a';
    const bar = r.gap != null ? '█'.repeat(Math.min(20, Math.round(r.gap * 12))) : '';
    L.push(`${cls.padEnd(6)}  ${r.label.padEnd(9)} ${fmt(r.engine)} ${fmt(r.real)}  ${rr.padStart(6)}  ${gg.padStart(6)}    ${bar}`);
  }
  L.push('');
  L.push(`★ = 「机械分边」「动没动」「铁轨」「两队是否混」——过去飞轮没优化的量`);
  L.push(`  ⚠ 「横向占比 lat」单独能被"抖动"刷分（FB4 lat 0.35 逼近真实，但画面仍不对）——**必须与「混队度 mix」一起看**：`);
  L.push(`     FB4 实测 lat 0.35 / mix 0.625（mix 没改善）⇒ 眼睛说「两队仍分开」。单看 lat 会被骗。`);
  L.push('');
  L.push(`**距离（幅度量 mean|ln(E/R)|，越小越像真实） = ${loss != null ? loss.toFixed(3) : 'n/a'}**`
    + `  [覆盖 ${coverage.used}/${coverage.total} 行${coverage.used < coverage.total ? '——⚠ 未满覆盖，勿与满覆盖的距离盲比' : ''}]`);
  if (worst) L.push(`  最大缺口：${worst.label} —— 引擎 ${fmt(worst.engine)} vs 真实 ${fmt(worst.real)}（${worst.ratio != null ? worst.ratio.toFixed(2) + '×' : '退化(0)'}）`);
  L.push('');
  L.push(`性质旗标（不进距离，须在带内）：`);
  L.push(`  方向一致性 dir : 引擎 ${fmt(flags.dirEngine)} vs 真实 ${fmt(flags.dirReal)}  ${near(flags.dirEngine, flags.dirReal, 0.10) ? 'OK(≈真实)' : '⚠ 偏离'}`);
  L.push(`  位移/真实比    : ${flags.dispRatio != null ? flags.dispRatio.toFixed(2) : 'n/a'}  （1.0=与真实同速；过去被当成"在动"的 0.28 其实=几乎不动）`);
  L.push(`  静止占比<0.5m  : 引擎 ${fmt(flags.stillEngine)}% vs 真实 ${fmt(flags.stillReal)}%  （⚠ 0.5m 阈值=真实的 1/27，此数别单独信）`);
  return L.join('\n');
}

if (IS_ENTRY) {
  const wasmPath = process.argv[2] || join(ROOT, 'viewer/engine.wasm');
  const seeds = Number(process.argv[3] || 5);
  const winSec = Number(process.argv[4] || 12);
  const sha = createHash('sha256').update(readFileSync(wasmPath)).digest('hex').slice(0, 8);

  const basePath = join(ROOT, 'viewer/data/benchmark-baseline.json');
  const rb = realShapeFromBaseline(basePath);           // 结构锚：committed 基线（primary）
  const realMotion = realMotionFromFrames(               // 运动锚：本地 Metrica 帧（可有可无）
    ['real-game-1.json', 'real-game-2.json'].map(f => join(ROOT, 'viewer/data', f)), winSec);
  const real = { shape: rb.shape, motion: realMotion || { disp: null, dir: null, still: null } };

  const eng = await engineProfile(wasmPath, seeds, winSec);

  const realLabel = `基线 ${rb.primary}（${Object.keys(rb.perDataset).join('/')}）`;
  const motionLabel = realMotion ? 'Metrica real-game-1/2 帧' : '缺（本地无 real-game-*.json）';
  console.log(formatLossTable(eng, real, { wasmPath, sha, seeds, winSec, realLabel, motionLabel }));

  // 对照：另一数据集的结构锚（若存在），让跨数据集差异可读（P37 纪律：两套分别报告）。
  const others = Object.keys(rb.perDataset).filter(k => k !== rb.primary);
  if (others.length) {
    console.log('');
    console.log(`（对照：非主数据集结构锚 ${others.map(k => `${k} gap=${fmt(rb.perDataset[k].gap)} hd=${fmt(rb.perDataset[k].hd)}`).join(' | ')}）`);
  }
}
