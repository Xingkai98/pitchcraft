// [y 轴探索探针] y 向形态：球员到最近边线的距离分布 —— 引擎各点 vs 真实帧，**同一段代码**。
//
// 用法：
//   node zz_y_probe.mjs <engine.wasm> <seed> <t0csv>
//   node zz_y_probe.mjs --real <real-game-N.json> <t0csv>
//
// 口径（与 match-metrics.js 对齐）：
//   - **按 p.id 取人**，不按下标（Game.players 过滤已罚下者 ⇒ 下标 ≠ id）。
//   - 剔除门将（KEEPER_IDS = 0/21）。
//   - 到最近边线距离 d_edge = min(y, 1−y) × 68（米）。
//   - 窗内每帧每人一个样本，pooled → 分位。
// 只读不写，用完即删。
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const { createGame } = await import(join(ROOT, 'viewer/game.js'));

const KEEPERS = new Set(mm.KEEPER_IDS);
const W = mm.PITCH_WIDTH_M;

function q(sorted, p) {
  const h = (sorted.length - 1) * p, i = Math.floor(h);
  if (i + 1 >= sorted.length) return sorted[sorted.length - 1];
  return sorted[i] + (h - i) * (sorted[i + 1] - sorted[i]);
}

// ★ 引擎与真实**共用**的这一段
export function edgeStats(frames, { t0, win }) {
  const edges = [];          // d_edge 逐帧逐人
  const lane = new Map();    // id → d_edge 样本
  const spans = [];          // 每帧 home 外场 y 跨度（米）
  let nFrames = 0;
  for (const f of frames) {
    if (f.t < t0 || f.t > t0 + win) continue;
    const outf = f.players.filter((p) => p && !KEEPERS.has(p.id));
    if (outf.length < 14) continue;
    nFrames++;
    for (const p of outf) {
      const d = Math.min(p.y, 1 - p.y) * W;
      edges.push(d);
      if (!lane.has(p.id)) lane.set(p.id, []);
      lane.get(p.id).push(d);
    }
    // home 外场（id 1..10）跨距 + 端点身份
    const hs = f.players.filter((p) => p && p.id >= 1 && p.id <= 10);
    if (hs.length === 10) {
      let lo = hs[0], hi = hs[0];
      for (const p of hs) { if (p.y < lo.y) lo = p; if (p.y > hi.y) hi = p; }
      spans.push({ t: f.t, span: (hi.y - lo.y) * W, loId: lo.id, hiId: hi.id, loY: lo.y * W, hiY: hi.y * W });
    }
  }
  const s = [...edges].sort((a, b) => a - b);
  const mean = edges.reduce((a, b) => a + b, 0) / edges.length;
  // 端点身份直方图（谁把跨度撑到最外）
  const idHist = new Map();
  for (const x of spans) for (const id of [x.loId, x.hiId]) idHist.set(id, (idHist.get(id) || 0) + 1);
  const top = [...idHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  return {
    nFrames, n: edges.length, mean,
    q: [0.05, 0.25, 0.5, 0.75, 0.95].map((p) => q(s, p)),
    frac_lt8: edges.filter((d) => d < 8).length / edges.length,
    frac_lt12: edges.filter((d) => d < 12).length / edges.length,
    spanMean: spans.reduce((a, x) => a + x.span, 0) / Math.max(1, spans.length),
    spanMax: Math.max(...spans.map((x) => x.span)),
    endpointHist: top,
    // 逐人均值 → 看「谁被推得最外 / 最里」
    perId: [...lane.entries()].map(([id, v]) => [id, v.reduce((a, b) => a + b, 0) / v.length]).sort((a, b) => a[1] - b[1]),
  };
}

function fmt(tag, r) {
  const f = (x) => x.toFixed(2).padStart(6);
  console.log(`[YPROBE] ${tag}  帧=${r.nFrames} 样本=${r.n}`);
  console.log(`[YPROBE] ${tag}  d_edge mean=${r.mean.toFixed(2)}m  p05/p25/p50/p75/p95 = ${r.q.map(f).join(' / ')}`);
  console.log(`[YPROBE] ${tag}  <8m ${(r.frac_lt8 * 100).toFixed(1)}%   <12m ${(r.frac_lt12 * 100).toFixed(1)}%`);
  console.log(`[YPROBE] ${tag}  home 外场 y 跨度 均值=${r.spanMean.toFixed(2)}m 最大=${r.spanMax.toFixed(2)}m`);
  console.log(`[YPROBE] ${tag}  端点 id 直方图(前6) = ${r.endpointHist.map(([id, c]) => `${id}:${c}`).join(' ')}`);
  console.log(`[YPROBE] ${tag}  逐人 d_edge 均值(升序) = ${r.perId.map(([id, v]) => `${id}=${v.toFixed(1)}`).join(' ')}`);
}

const argv = process.argv.slice(2);
if (argv[0] === '--real') {
  const g = JSON.parse(readFileSync(argv[1], 'utf8'));
  const frames = g.frames.map((f) => mm.fromTrackingFrame(f));
  for (const t0 of argv[2].split(',').map(Number)) fmt(`REAL t0=${t0}`, edgeStats(frames, { t0, win: 90 }));
} else {
  const wasmPath = argv[0];
  const SEED = Number(argv[1] || 42);
  const t0s = (argv[2] || '600,1800,3600').split(',').map(Number);
  const { wasm, ok } = await loadEngineWasm(wasmPath);
  if (!ok) { console.error('wasm 加载失败'); process.exit(1); }
  const frames = mm.sampleEngineFrames(createGame(simulateStream(wasm, SEED, mm.ENGINE_DURATION_SEC)));
  for (const t0 of t0s) fmt(`ENGINE seed=${SEED} t0=${t0}`, edgeStats(frames, { t0, win: 90 }));
}
