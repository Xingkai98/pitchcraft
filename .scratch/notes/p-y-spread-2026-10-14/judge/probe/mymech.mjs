// 判据镜独立机制探针（只读）。用法:
//   node mymech.mjs engine <wasm> [seed]
//   node mymech.mjs real   <real-game-N.json> [<...>]
// 口径自报：W=68m；剔除门将（id 0/21）；d_edge = min(y,1-y)*68。
// **两种取人规则都报**：A) 要求该队 10 名外场全在（探针口径）B) match-metrics 的 >=7 且剔外推点（基线口径）。
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..', '..');
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const { createGame } = await import(join(ROOT, 'viewer/game.js'));
const W = mm.PITCH_WIDTH_M, L = mm.PITCH_LENGTH_M;
const KEEP = new Set(mm.KEEPER_IDS);
const qs = (a, p) => { const s = [...a].sort((x, y) => x - y); const h = (s.length - 1) * p, i = Math.floor(h); return i + 1 >= s.length ? s[s.length - 1] : s[i] + (h - i) * (s[i + 1] - s[i]); };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;

function scan(frames, fromEvents) {
  const out = { win: [], all: null };
  const accEdge = [], accBall = [], accMover = [], accNear = [], accWmm = [], accW10 = [];
  const spanId = new Map();
  let nf = 0, nf10 = 0;
  const T0S = []; for (let t = 0; t <= 5100; t += 300) T0S.push(t);
  const buckets = new Map(T0S.map(t => [t, { edge: [], ball: [], mover: [], near: [], wmm: [], w10: [], spans: [], nf: 0 }]));
  const isExtrap = p => p && p.extrapolated === true;
  for (const f of frames) {
    const _t = T0S.find(t => f.t >= t && f.t < t + 90);
    const bk = _t === undefined ? null : buckets.get(_t);
    const of = f.players.filter(p => p && !KEEP.has(p.id) && !isExtrap(p));
    const home10 = f.players.filter(p => p && p.id >= 1 && p.id <= 10 && !isExtrap(p));
    const away10 = f.players.filter(p => p && p.id >= 11 && p.id <= 20 && !isExtrap(p));
    // 基线口径宽度（match-metrics）
    const sh = mm.teamShape(f, 'home');
    // 探针口径宽度（要求 10 人全在，含外推与否都算"在"）
    const homeAll = f.players.filter(p => p && p.id >= 1 && p.id <= 10);
    let w10 = null, ids = null;
    if (homeAll.length === 10) {
      let lo = homeAll[0], hi = homeAll[0];
      for (const p of homeAll) { if (p.y < lo.y) lo = p; if (p.y > hi.y) hi = p; }
      w10 = (hi.y - lo.y) * W; ids = [lo.id, hi.id];
      spanId.set(ids[0], (spanId.get(ids[0]) || 0) + 1); spanId.set(ids[1], (spanId.get(ids[1]) || 0) + 1);
    }
    if (of.length >= 14) nf++;
    if (home10.length === 10 && away10.length === 10) nf10++;
    let near = null;
    if (f.ball && of.length >= 14) {
      const bx = f.ball[0] * L, by = f.ball[1] * W;
      near = of.filter(p => Math.hypot(p.x * L - bx, p.y * W - by) <= 12).length;
    }
    for (const p of of) accEdge.push(Math.min(p.y, 1 - p.y) * W);
    if (f.ball) accBall.push(Math.abs(f.ball[1] - 0.5) * W);
    if (sh) accWmm.push(sh.width);
    if (w10 != null) accW10.push(w10);
    if (near != null) accNear.push(near);
    if (!bk) continue;
    bk.nf++;
    for (const p of of) bk.edge.push(Math.min(p.y, 1 - p.y) * W);
    if (sh) bk.wmm.push(sh.width);
    if (w10 != null) { bk.w10.push(w10); bk.spans.push(w10); }
    if (near != null) bk.near.push(near);
    if (f.ball) bk.ball.push(Math.abs(f.ball[1] - 0.5) * W);
  }
  for (const e of fromEvents) if (e.movers) for (const m of e.movers) {
    const v = Math.abs(m.to_y - 0.5) * W;
    accMover.push(v);
    const _t = T0S.find(t => e.t >= t && e.t < t + 90); if (_t !== undefined) buckets.get(_t).mover.push(v);
  }
  const sum = (tag, agg) => ({
    tag, n: agg.edge.length,
    edgeMean: mean(agg.edge), e05: qs(agg.edge, .05), e50: qs(agg.edge, .5), e95: qs(agg.edge, .95),
    lt8: agg.edge.filter(d => d < 8).length / agg.edge.length,
    lt12: agg.edge.filter(d => d < 12).length / agg.edge.length,
    wmm: mean(agg.wmm), w10: mean(agg.w10), ball: mean(agg.ball), mover: mean(agg.mover), near: mean(agg.near),
  });
  const A = { edge: accEdge, wmm: accWmm, w10: accW10, ball: accBall, mover: accMover, near: accNear };
  out.all = sum('ALL', A);
  out.nf = nf; out.nf10 = nf10; out.spanId = [...spanId.entries()].sort((a, b) => b[1] - a[1]);
  for (const t of T0S) { const b = buckets.get(t); out.win.push(sum(`t0=${t}`, b)); }
  return out;
}

const mode = process.argv[2];
const fmt = (r) => `${r.tag} n=${r.n} d_edge ${r.edgeMean.toFixed(2)} [p05 ${r.e05.toFixed(1)} p50 ${r.e50.toFixed(1)} p95 ${r.e95.toFixed(1)}] <8m ${(r.lt8 * 100).toFixed(1)}% <12m ${(r.lt12 * 100).toFixed(1)}% | width(mm) ${r.wmm == null || isNaN(r.wmm) ? 'n/a' : r.wmm.toFixed(2)} width(10人) ${isNaN(r.w10) ? 'n/a' : r.w10.toFixed(2)} | 球位 ${r.ball.toFixed(2)} mover目标 ${r.mover.toFixed(2)} 12m内 ${r.near.toFixed(3)}`;

if (mode === 'engine') {
  const { wasm, ok } = await loadEngineWasm(process.argv[3]);
  if (!ok) { console.error('wasm 失败'); process.exit(1); }
  const seed = Number(process.argv[4] || 42);
  const raw = simulateStream(wasm, seed, mm.ENGINE_DURATION_SEC);
  const evs = JSON.parse(raw);
  const frames = mm.sampleEngineFrames(createGame(raw));
  const r = scan(frames, evs);
  console.log(`### ENGINE seed=${seed} frames=${r.nf} fullFrames=${r.nf10}`);
  console.log(fmt(r.all));
  for (const w of r.win) console.log(fmt(w));
  console.log('端点 id 直方图 =', r.spanId.map(([i, c]) => `${i}:${c}`).join(' '));
} else {
  for (const p of process.argv.slice(3)) {
    const g = JSON.parse(readFileSync(p, 'utf8'));
    const frames = g.frames.map(f => mm.fromTrackingFrame(f));
    const r = scan(frames, []);
    console.log(`### REAL ${p} frames=${r.nf} fullFrames=${r.nf10}`);
    console.log(fmt(r.all));
    for (const w of r.win) console.log(fmt(w));
    console.log('端点 id 直方图 =', r.spanId.map(([i, c]) => `${i}:${c}`).join(' '));
  }
}
