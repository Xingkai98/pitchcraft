// [table-compress 探索探针 · 用完即删]
// 机制判据：**分边小有两条互不相干的机制** —— (a) 球相对紧凑（真实）/ (b) 静态中线停车（退化）。
// 本探针量化 (a)：逐帧「队均 x 对 ball.x 的斜率 / 相关系数 / 按 ball.x 分箱」。
// **引擎各 c 与真实帧走同一段代码**（同一函数、同一采样口径），故两者的斜率可直接对比。
//
// 用法：node viewer/zz_table_probe.mjs <wasm> [seeds...]      （默认 seed 42）
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
const { createGame } = await import(join(ROOT, 'viewer/game.js'));

const KEEPERS = new Set([0, 21]);

// 逐帧 (队均 x, ball.x)。**同一段代码**用于引擎帧与真实帧。
export function framePairs(frames) {
  const out = [];
  for (const f of frames) {
    if (!f.ball || !f.players) continue;
    for (const team of ['home', 'away']) {
      const xs = [];
      for (const p of f.players) {
        if (!p || KEEPERS.has(p.id)) continue;
        if (team === 'home' ? p.id > 10 : p.id < 11) continue;
        xs.push(p.x);
      }
      if (xs.length < 7) continue;
      out.push({ t: f.t, team, mx: xs.reduce((a, b) => a + b, 0) / xs.length, bx: f.ball[0] });
    }
  }
  return out;
}

// 斜率 / 相关系数 / 分箱（纯函数）
export function slopeAndBins(pairs, nBins = 5) {
  const res = {};
  for (const team of ['home', 'away']) {
    const P = pairs.filter(p => p.team === team);
    const n = P.length;
    if (n < 10) { res[team] = null; continue; }
    const mbx = P.reduce((a, p) => a + p.bx, 0) / n, mmx = P.reduce((a, p) => a + p.mx, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (const p of P) { const dx = p.bx - mbx, dy = p.mx - mmx; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    const bins = [];
    for (let i = 0; i < nBins; i++) {
      const lo = i / nBins, hi = (i + 1) / nBins;
      const Q = P.filter(p => p.bx >= lo && (i === nBins - 1 ? p.bx <= hi : p.bx < hi));
      bins.push({ lo, hi, n: Q.length, mx: Q.length ? Q.reduce((a, p) => a + p.mx, 0) / Q.length : null });
    }
    res[team] = { n, slope: sxy / sxx, r: sxy / Math.sqrt(sxx * syy), meanX: mmx, meanBallX: mbx, bins };
  }
  return res;
}

const fmt = v => (v == null ? ' n/a ' : v.toFixed(3));

// 分边：逐帧两队非门将重心 x 之差（米@105）与 corr(gap, ball.x)
export function gapStats(pairs) {
  const by = new Map();
  for (const p of pairs) { (by.get(p.t) ?? by.set(p.t, {}).get(p.t))[p.team] = p.mx; }
  const G = [], B = [];
  for (const [, v] of by) { if (v.home == null || v.away == null) continue; G.push(Math.abs(v.home - v.away) * 105); B.push(null); }
  return { mean: G.reduce((a, b) => a + b, 0) / G.length, n: G.length };
}

function report(label, pairs) {
  const R = slopeAndBins(pairs);
  const line = t => `  ${t.padEnd(4)} n=${String(R[t].n).padStart(6)} slope=${fmt(R[t].slope).padStart(7)} r=${fmt(R[t].r).padStart(7)} 队均x=${(R[t].meanX * 105).toFixed(1)}m 球均x=${(R[t].meanBallX * 105).toFixed(1)}m`;
  console.log(`【${label}】`);
  console.log(line('home')); console.log(line('away'));
  console.log(`   分边(队均x 差) = ${gapStats(pairs).mean.toFixed(2)} m`);
  console.log(`   按 ball.x 分箱（队均 x，米@105）：`);
  const hdr = R.home.bins.map(b => `${(b.lo * 105).toFixed(0)}-${(b.hi * 105).toFixed(0)}m`).join(' | ');
  console.log(`     ${' '.padEnd(5)}${hdr}`);
  for (const t of ['home', 'away']) {
    console.log(`   ${t.padEnd(4)} ` + R[t].bins.map(b => (b.mx == null ? '  n/a  ' : (b.mx * 105).toFixed(1).padStart(5) + `(n${b.n})`)).join('  '));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const wasmPath = process.argv[2] || join(ROOT, 'viewer/engine.wasm');
  const seeds = process.argv.slice(3).map(Number);
  const seedList = seeds.length ? seeds : [42];
  const { wasm } = await loadEngineWasm(wasmPath);
  const pooled = [];
  for (const seed of seedList) {
    const frames = mm.sampleEngineFrames(createGame(simulateStream(wasm, seed, mm.ENGINE_DURATION_SEC)));
    const P = framePairs(frames);
    pooled.push(...P);
    if (seedList.length === 1) report(`引擎 seed ${seed}（全 90min 采样）`, P);
  }
  if (seedList.length > 1) report(`引擎 **合并 ${seedList.length} seed**（${seedList.join(',')}）`, pooled);
  // 真实帧（Metrica）—— 同一段代码
  for (const f of ['real-game-1.json', 'real-game-2.json']) {
    let g; try { g = JSON.parse(readFileSync(join(ROOT, 'viewer/data', f), 'utf8')); } catch { console.log(`【${f}】缺`); continue; }
    const frames = g.frames.map(x => mm.fromTrackingFrame(x, { pitchMeters: g.meta && g.meta.pitchMeters ? [g.meta.pitchMeters.length, g.meta.pitchMeters.width] : null }))
      .filter(x => mm.isRawBallFrame(x));
    report(`真实 ${f}（原始球帧 ${frames.length}）`, framePairs(frames));
  }
}
