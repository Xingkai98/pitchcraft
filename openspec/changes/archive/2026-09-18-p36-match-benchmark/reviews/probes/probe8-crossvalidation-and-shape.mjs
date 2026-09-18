// Probe 8:
// A. 全指标交叉验证（game1 建区间 → game2 是否落在内；反向）
// B. 12 vs 14 窗口的 p5/p95
// C. depth/width 比例（形状签名）
// D. 重心划分的弹性（raw-only 球帧）
import { readFileSync } from 'node:fs';
const L = 105, W = 68;
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); const i = p * (s.length - 1); const lo = Math.floor(i), hi = Math.ceil(i); return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); };
const isKeeper = id => id === 0 || id === 21;

const games = [1, 2].map(g => JSON.parse(readFileSync(`./data/real-game-${g}.json`, 'utf8')));
function fr(f) { return { players: f.players.map((p, i) => p ? { id: i, x: p[0], y: p[1] } : null), ball: f.ball, ballFill: f.ballFill }; }
function shape(f, team) {
  const ps = f.players.filter(p => p && !isKeeper(p.id) && (team === 'home' ? p.id <= 10 : p.id >= 11));
  if (ps.length < 7) return null;
  const xs = ps.map(p => p.x * L), ys = ps.map(p => p.y * W);
  const cx = avg(xs), cy = avg(ys);
  return { depth: Math.max(...xs) - Math.min(...xs), width: Math.max(...ys) - Math.min(...ys), spread: avg(xs.map((x, i) => Math.hypot(x - cx, ys[i] - cy))), cx, cy };
}
function windowMetrics(frames) {
  const S = frames.map(f => ({ s: shape(f, 'home'), a: shape(f, 'away') }));
  const cdist = S.filter(x => x.s && x.a).map(x => Math.hypot(x.s.cx - x.a.cx, x.s.cy - x.a.cy));
  const sd = S.map(x => x.s).filter(Boolean);
  return {
    depth: avg(sd.map(s => s.depth)), width: avg(sd.map(s => s.width)), spread: avg(sd.map(s => s.spread)),
    cdist: avg(cdist), ratio: avg(sd.map(s => s.depth / s.width)),
  };
}

// ---------- A/B: 分为 12 窗口与 14 窗口两套 ----------
const W12 = { 1: [], 2: [] }, W14 = { 1: [], 2: [] };
for (const [gi, d] of games.entries()) {
  const g = gi + 1;
  for (let s = 0; s < 5500; s += 900) {
    const w = d.frames.filter(f => f.t >= s && f.t < s + 300);
    if (w.length <= 100) continue;
    const m = windowMetrics(w.map(fr));
    W14[g].push(m);
    if (s < 5400) W12[g].push(m);
  }
}
console.log('=== A/B. 12 vs 14 窗口（纵深 p5/p50/p95） ===');
for (const [label, W] of [['12窗', W12], ['14窗', W14]]) {
  const all = [...W[1], ...W[2]].map(m => m.depth);
  console.log(`  ${label}: n=${all.length} 均值 ${avg(all).toFixed(1)} p5 ${pct(all, 0.05).toFixed(1)} p50 ${pct(all, 0.5).toFixed(1)} p95 ${pct(all, 0.95).toFixed(1)}`);
}

console.log('\n=== A. 交叉验证（每指标：用一场的 p5–p95 区间检查另一场的窗口） ===');
for (const key of ['depth', 'width', 'spread', 'cdist', 'ratio']) {
  const v1 = W14[1].map(m => m[key]), v2 = W14[2].map(m => m[key]);
  const inFrom1 = v2.filter(v => v >= pct(v1, 0.05) && v <= pct(v1, 0.95)).length;
  const inFrom2 = v1.filter(v => v >= pct(v2, 0.05) && v <= pct(v2, 0.95)).length;
  const pooled = [...v1, ...v2];
  console.log(`  ${key.padEnd(7)}: game1区间[${pct(v1, 0.05).toFixed(1)},${pct(v1, 0.95).toFixed(1)}] 容纳 game2 ${inFrom1}/7 | game2区间[${pct(v2, 0.05).toFixed(1)},${pct(v2, 0.95).toFixed(1)}] 容纳 game1 ${inFrom2}/7 | 合并 p5-p95 [${pct(pooled, 0.05).toFixed(1)},${pct(pooled, 0.95).toFixed(1)}]`);
}

// ---------- C: depth/width 比例 ----------
console.log('\n=== C. depth/width 比例（形状签名） ===');
{
  const r = W14[1].concat(W14[2]).map(m => m.ratio);
  console.log(`  真实 14 窗口 ratio: 均值 ${avg(r).toFixed(2)} (${Math.min(...r).toFixed(2)}–${Math.max(...r).toFixed(2)})`);
  // 引擎
  const bytes = readFileSync('./engine.wasm');
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const wasm = instance.exports; const enc = new TextEncoder(), dec = new TextDecoder();
  const { createGame } = await import('./game.js');
  function es(seed) { const b = enc.encode(JSON.stringify({ demo_mode: false, off_ball_movement_demo: true, match_duration_seconds: 300 })); new Uint8Array(wasm.memory.buffer, 1024, b.length).set(b); wasm.simulate(BigInt(seed), 1024, b.length); const p = wasm.get_json_ptr(), n = wasm.get_json_length(); const s = dec.decode(new Uint8Array(wasm.memory.buffer, p, n)); wasm.free_json(); return s; }
  const ratios = [];
  for (const seed of [42, 1, 7, 99, 123]) {
    const g = createGame(es(seed)); const frm = [];
    for (let t = 0; t <= g.matchEnd; t += 0.2) { g.seekTo(t); frm.push({ players: g.players.map(p => ({ id: p.id, x: p.x, y: p.y })), ball: [g.ball.x, g.ball.y] }); }
    ratios.push(avg(frm.map(f => { const s = shape(f, 'home'); return s ? s.depth / s.width : null; }).filter(v => v != null)));
  }
  console.log(`  引擎 5 种子 ratio: ${ratios.map(v => v.toFixed(2)).join(', ')} 均值 ${avg(ratios).toFixed(2)}`);
  const sep = Math.max(...r) < Math.min(...ratios);
  console.log(`  分离: ${sep ? '✓' : '✗'}`);
}

// ---------- D: 弹性——重心划分 + raw-only ----------
console.log('\n=== D. 弹性（重心划分 × raw-only 球帧） ===');
function elasticity(frames, rawOnly) {
  const own = [], opp = [];
  for (const f of frames) {
    if (rawOnly && f.ballFill !== undefined) continue;
    const s = shape(f, 'home'); if (!s || !f.ball) continue;
    (f.ball[0] * L < s.cx ? own : opp).push(s.depth);
  }
  return own.length > 30 && opp.length > 30 ? avg(opp) - avg(own) : null;
}
{
  const res = [];
  for (const [gi, d] of games.entries())
    for (let s = 0; s < 5500; s += 900) {
      const w = d.frames.filter(f => f.t >= s && f.t < s + 300).map(fr);
      if (w.length <= 100) continue;
      const e = elasticity(w, true); if (e != null) res.push(e);
    }
  console.log(`  真实（重心划分, raw-only）: Δ 均值 ${avg(res).toFixed(1)} (${Math.min(...res).toFixed(1)}~${Math.max(...res).toFixed(1)}) n=${res.length}`);
}
