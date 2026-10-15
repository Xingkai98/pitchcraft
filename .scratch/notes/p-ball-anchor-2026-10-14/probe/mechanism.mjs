// 机制三条（A1/A2/A3）+ 运动量（disp/lat/mix/dir）+ 按球位分箱。
// 引擎侧：一个 wasm（可选多 seed）；真实侧：Metrica 两场（同口径现算）。
// 按 p.id 取人（Game.players 会过滤已罚下者 ⇒ 下标 ≠ id）。
// 用法: node mechanism.mjs <wasm> [seeds] [dur] [stepSec]
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const { createGame } = await import(join(ROOT, 'viewer/game.js'));
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
const { windowStats } = await import(join(ROOT, 'tools/visual-review/motion-metrics.mjs'));

const KEEP = mm.KEEPER_IDS;
const L = 105, W = 68;
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// 逐帧核心量。frames = [{t, players:[{id,x,y}], ball:[x,y]}]
export function mechFromFrames(frames, { includeKeeper = false } = {}) {
  const A1 = [], A2 = [], slope = [], bins = new Map();
  const sx = [], sy = [];   // 队均 x/y 对 ball 的回归累积
  const acc = { n: 0, sbx: 0, stx: 0, sbxx: 0, sbxtx: 0, sby: 0, sty: 0, sbyy: 0, sbyty: 0 };
  let nf = 0;
  for (const f of frames) {
    if (!f.ball) continue;
    const ps = (f.players || []).filter((p) => p && (includeKeeper || !KEEP.includes(p.id)));
    if (ps.length < 14) continue;
    const bx = f.ball[0] * L, by = f.ball[1] * W;
    // A1: 球 12m 内球员数（默认外场；双方合计）
    let c12 = 0;
    for (const p of ps) if (Math.hypot(p.x * L - bx, p.y * W - by) <= 12) c12++;
    A1.push(c12);
    // A2: 5m 内有对手的球员占比
    let contact = 0;
    for (const p of ps) {
      let has = false;
      for (const q of ps) {
        if ((p.id <= 10) === (q.id <= 10)) continue;
        if (Math.hypot(p.x * L - q.x * L, p.y * W - q.y * W) <= 5) { has = true; break; }
      }
      if (has) contact++;
    }
    A2.push(contact / ps.length);
    // A3: 队均 x ~ ball.x（两队各算一次；客队不需要镜像，因为回归斜率与坐标系无关）
    for (const home of [true, false]) {
      const t = ps.filter((p) => (p.id <= 10) === home);
      if (t.length < 7) continue;
      // ⚠️ 必须**同单位**（米对米）：队均 x 用米、ball 也用米；用归一化 x 对米制 ball 会得到
      // 「每米多少归一化单位」（≈0.005）这种无量纲错值（本探针踩过）。
      const mx = mean(t.map((p) => p.x)) * L; const my = mean(t.map((p) => p.y)) * W;
      acc.n++; acc.sbx += bx; acc.stx += mx; acc.sbxx += bx * bx; acc.sbxtx += bx * mx;
      acc.sby += by; acc.sty += my; acc.sbyy += by * by; acc.sbyty += by * my;
    }
    nf++;
    const k = Math.min(4, Math.floor(f.ball[0] * 5));
    if (!bins.has(k)) bins.set(k, []);
    bins.get(k).push(mean(ps.filter((p) => p.id <= 10).map((p) => p.x * L)));
  }
  const beta = (n, sx1, sy1, sxx, sxy) => { const den = n * sxx - sx1 * sx1; return den > 1e-9 ? (n * sxy - sx1 * sy1) / den : null; };
  return {
    nFrames: nf,
    A1: mean(A1), A2: mean(A2),
    slopeX: beta(acc.n, acc.sbx, acc.stx, acc.sbxx, acc.sbxtx),
    slopeY: beta(acc.n, acc.sby, acc.sty, acc.sbyy, acc.sbyty),
    binnedMeanXByBallXQuintile: [...bins.keys()].sort((a, b) => a - b).map((k) => ({ ballXQuintile: k + 1, meanHomeX: mean([].concat(...bins.get(k))), n: bins.get(k).length })),
    nSlope: acc.n,
  };
}

// ── 引擎侧 ──
const wasmPath = process.argv[2];
const NSEED = Number(process.argv[3] || 5);
const DUR = Number(process.argv[4] || 5400);
const STEP = Number(process.argv[5] || 0.2);
const { wasm, ok } = await loadEngineWasm(wasmPath);
if (!ok) { console.error('wasm 加载失败'); process.exit(1); }

const engMech = [];
for (let i = 0; i < NSEED; i++) {
  const seed = mm.BENCHMARK_SEEDS[i % mm.BENCHMARK_SEEDS.length];
  const stream = simulateStream(wasm, seed, DUR);
  const frames = mm.sampleEngineFrames(createGame(stream), { stepSec: STEP });
  const m = mechFromFrames(frames);
  const ws = windowStats(frames, 12);
  engMech.push({ seed, ...m, disp: median(ws.disp), lat: median(ws.lat), mix: median(ws.mix), dir: median(ws.dir), still: median(ws.still) });
}

// ── 真实侧（Metrica 两场；同口径）──
const realMech = [];
for (const p of ['viewer/data/real-game-1.json', 'viewer/data/real-game-2.json']) {
  const g = JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
  const frames = g.frames.map((f) => mm.fromTrackingFrame(f));
  // 与引擎同采样步长（0.2s）以便可比
  const sub = [];
  const stepN = Math.round(STEP * (g.meta.hz || 25));
  for (let i = 0; i < frames.length; i += Math.max(1, stepN)) sub.push(frames[i]);
  const m = mechFromFrames(sub);
  const ws = windowStats(sub, 12);
  realMech.push({ game: p, ...m, disp: median(ws.disp), lat: median(ws.lat), mix: median(ws.mix), dir: median(ws.dir), still: median(ws.still) });
}

const agg = (arr, k) => mean(arr.map((r) => r[k]).filter((v) => v != null));
const out = {
  wasmPath,
  engine: {
    seeds: engMech.map((r) => r.seed),
    A1_ball12: { mean: agg(engMech, 'A1'), perSeed: engMech.map((r) => r.A1) },
    A2_contact5: { mean: agg(engMech, 'A2'), perSeed: engMech.map((r) => r.A2) },
    A3_slopeX: { mean: agg(engMech, 'slopeX'), perSeed: engMech.map((r) => r.slopeX) },
    A3_slopeY: { mean: agg(engMech, 'slopeY') },
    disp: { mean: agg(engMech, 'disp') }, lat: { mean: agg(engMech, 'lat') },
    mix: { mean: agg(engMech, 'mix') }, dir: { mean: agg(engMech, 'dir') }, still: { mean: agg(engMech, 'still') },
    binned: engMech[0] ? engMech[0].binnedMeanXByBallXQuintile : null,
    mechAll: engMech,
  },
  real: {
    A1_ball12: { mean: agg(realMech, 'A1'), perGame: realMech.map((r) => r.A1) },
    A2_contact5: { mean: agg(realMech, 'A2'), perGame: realMech.map((r) => r.A2) },
    A3_slopeX: { mean: agg(realMech, 'slopeX'), perGame: realMech.map((r) => r.slopeX) },
    A3_slopeY: { mean: agg(realMech, 'slopeY') },
    disp: { mean: agg(realMech, 'disp') }, lat: { mean: agg(realMech, 'lat') },
    mix: { mean: agg(realMech, 'mix') }, dir: { mean: agg(realMech, 'dir') }, still: { mean: agg(realMech, 'still') },
    binned: realMech[0] ? realMech[0].binnedMeanXByBallXQuintile : null,
    mechAll: realMech,
  },
};
console.log(JSON.stringify(out, null, 1));
