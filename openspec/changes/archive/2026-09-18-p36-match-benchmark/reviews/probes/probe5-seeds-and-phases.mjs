// Probe 5: 引擎 5 种子全量 + 引擎内部分段方差 vs 真实窗口方差 + 窗口长度敏感性 + 采样位移复查
import { readFileSync } from 'node:fs';
import { createGame } from './game.js';
const L = 105, W = 68;
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); const i = p * (s.length - 1); const lo = Math.floor(i), hi = Math.ceil(i); return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); };
const isKeeper = id => id === 0 || id === 21;

const games = [1, 2].map(g => JSON.parse(readFileSync(`./data/real-game-${g}.json`, 'utf8')));
function shapeFromRaw(f) { return { players: f.players.map((p, i) => p ? { id: i, x: p[0], y: p[1] } : null), ball: f.ball }; }
function teamMetric(f, team, fn) {
  const ps = f.players.filter(p => p && !isKeeper(p.id) && (team === 'home' ? p.id <= 10 : p.id >= 11));
  if (ps.length < 7) return null;
  const xs = ps.map(p => p.x * L), ys = ps.map(p => p.y * W);
  const cx = avg(xs), cy = avg(ys);
  if (fn === 'depth') return Math.max(...xs) - Math.min(...xs);
  if (fn === 'width') return Math.max(...ys) - Math.min(...ys);
  if (fn === 'spread') return avg(xs.map((x, i) => Math.hypot(x - cx, ys[i] - cy)));
  if (fn === 'cx') return cx;
  if (fn === 'cy') return cy;
}

const bytes = readFileSync('./engine.wasm');
const { instance } = await WebAssembly.instantiate(bytes, {});
const wasm = instance.exports; const enc = new TextEncoder(), dec = new TextDecoder();
function engineStream(seed) {
  const b = enc.encode(JSON.stringify({ demo_mode: false, off_ball_movement_demo: true, match_duration_seconds: 300 }));
  new Uint8Array(wasm.memory.buffer, 1024, b.length).set(b);
  wasm.simulate(BigInt(seed), 1024, b.length);
  const p = wasm.get_json_ptr(), n = wasm.get_json_length();
  const s = dec.decode(new Uint8Array(wasm.memory.buffer, p, n)); wasm.free_json();
  return s;
}
const SEEDS = [42, 1, 7, 99, 123];
const engRuns = SEEDS.map(s => {
  const g = createGame(engineStream(s)); const out = [];
  for (let t = 0; t <= g.matchEnd; t += 0.2) { g.seekTo(t); out.push({ t: +t.toFixed(2), players: g.players.map(p => ({ id: p.id, x: p.x, y: p.y })), ball: [g.ball.x, g.ball.y] }); }
  return out;
});

// ---------- 1. 引擎弹性 5 种子复现 ----------
console.log('=== 1. 引擎弹性 5 种子（修正后探针） ===');
const eDeltas = engRuns.map(run => {
  const own = [], opp = [];
  for (const f of run) { const d = teamMetric(f, 'home', 'depth'); if (d == null) continue; (f.ball[0] < 0.5 ? own : opp).push(d); }
  return { own: avg(own), opp: avg(opp), delta: avg(opp) - avg(own) };
});
console.log('  seed: Δ 值: ' + eDeltas.map((e, i) => `${SEEDS[i]}:${e.delta.toFixed(1)}`).join('  '));
console.log(`  均值 Δ = ${avg(eDeltas.map(e => e.delta)).toFixed(1)}  (设计称 11.3, 5.5~20.2)`);
console.log(`  own→opp: ${eDeltas.map(e => `${e.own.toFixed(1)}→${e.opp.toFixed(1)}`).join(' | ')}`);

// ---------- 2. 引擎内部分段方差 vs 真实窗口间方差 ----------
console.log('\n=== 2. 方差分解：引擎段间 vs 真实窗口间（纵深）===');
// 引擎：每个种子分成 6 段 × 50s（或 5 段 × 60s），看段均值
function segMeans(frames, len) {
  const out = [];
  const total = frames[frames.length - 1].t;
  for (let s = 0; s + len <= total + 1e-9; s += len) {
    const v = avg(frames.filter(f => f.t >= s && f.t < s + len).map(f => teamMetric(f, 'home', 'depth')).filter(v => v != null));
    out.push(v);
  }
  return out;
}
const engSeg = engRuns.map(r => segMeans(r, 50));   // 6 段/种子
const engSegAll = engSeg.flat();
console.log(`  引擎 50s 段 (30 段): 均值 ${avg(engSegAll).toFixed(1)} 段间 SD ${Math.sqrt(avg(engSegAll.map(v => (v - avg(engSegAll)) ** 2))).toFixed(1)} 范围 ${Math.min(...engSegAll).toFixed(1)}–${Math.max(...engSegAll).toFixed(1)}`);
const realWins = [];
for (const [gi, d] of games.entries())
  for (let s = 0; s < 5500; s += 900) {
    const w = d.frames.filter(f => f.t >= s && f.t < s + 300);
    if (w.length > 100) realWins.push({ g: gi + 1, s, v: avg(w.map(f => teamMetric(shapeFromRaw(f), 'home', 'depth')).filter(v => v != null)) });
  }
const realVals = realWins.map(w => w.v);
console.log(`  真实 300s 窗口 (${realVals.length} 个): 均值 ${avg(realVals).toFixed(1)} 窗口间 SD ${Math.sqrt(avg(realVals.map(v => (v - avg(realVals)) ** 2))).toFixed(1)} 范围 ${Math.min(...realVals).toFixed(1)}–${Math.max(...realVals).toFixed(1)}`);
// 真实：窗口内逐帧 SD（采样噪声）
const realWithin = [];
for (const [gi, d] of games.entries())
  for (let s = 0; s < 5500; s += 900) {
    const w = d.frames.filter(f => f.t >= s && f.t < s + 300);
    if (w.length > 100) { const vs = w.map(f => teamMetric(shapeFromRaw(f), 'home', 'depth')).filter(v => v != null); realWithin.push(Math.sqrt(avg(vs.map(v => (v - avg(vs)) ** 2)))); }
  }
console.log(`  真实窗口内逐帧 SD: 均值 ${avg(realWithin).toFixed(1)}`);
const engWithin = engRuns.map(r => { const vs = r.map(f => teamMetric(f, 'home', 'depth')).filter(v => v != null); return Math.sqrt(avg(vs.map(v => (v - avg(vs)) ** 2))); });
console.log(`  引擎 300s 内逐帧 SD: 均值 ${avg(engWithin).toFixed(1)}`);
console.log(`  → 引擎场内波动是真实的 ${(avg(engWithin) / avg(realWithin)).toFixed(1)} 倍`);

// ---------- 3. 窗口长度敏感性（真实侧） ----------
console.log('\n=== 3. 真实侧窗口长度敏感性 ===');
for (const len of [60, 120, 300, 600, 900]) {
  const vals = [];
  for (const [gi, d] of games.entries())
    for (let s = 0; s + len <= d.meta.endTime; s += 300) {
      const w = d.frames.filter(f => f.t >= s && f.t < s + len);
      if (w.length > len * 0.5) vals.push(avg(w.map(f => teamMetric(shapeFromRaw(f), 'home', 'depth')).filter(v => v != null)));
    }
  console.log(`  ${String(len).padStart(3)}s 窗口 (n=${vals.length}): 均值 ${avg(vals).toFixed(1)} SD ${Math.sqrt(avg(vals.map(v => (v - avg(vals)) ** 2))).toFixed(1)} 范围 ${Math.min(...vals).toFixed(1)}–${Math.max(...vals).toFixed(1)}`);
}

// ---------- 4. 采样位移复查：非门将球员 ----------
console.log('\n=== 4. 引擎 0.2s 采样位移（非门将，检查插值是否连续） ===');
{
  const run = engRuns[0];
  let dists = []; let prev = null;
  for (const f of run) {
    if (prev) {
      for (const p of f.players) {
        if (isKeeper(p.id)) continue;
        const q = prev.players.find(x => x.id === p.id);
        if (q) dists.push(Math.hypot((p.x - q.x) * L, (p.y - q.y) * W));
      }
    }
    prev = f;
  }
  dists.sort((a, b) => a - b);
  console.log(`  非门将相邻采样位移: p10 ${dists[Math.floor(dists.length * 0.1)].toFixed(3)} p50 ${dists[Math.floor(dists.length * 0.5)].toFixed(3)} p90 ${dists[Math.floor(dists.length * 0.9)].toFixed(3)} p99 ${dists[Math.floor(dists.length * 0.99)].toFixed(3)} max ${dists[dists.length - 1].toFixed(3)}`);
  console.log(`  移动 <1cm 的比例: ${(100 * dists.filter(d => d < 0.01).length / dists.length).toFixed(1)}%`);
}
// 真实侧同项对照
{
  const d = games[0];
  let dists = []; let prev = null;
  for (const f of d.frames) {
    const cur = shapeFromRaw(f);
    if (prev) {
      for (const p of cur.players) {
        if (!p || isKeeper(p.id)) continue;
        const q = prev.players[p.id];
        if (q) dists.push(Math.hypot((p.x - q.x) * L, (p.y - q.y) * W));
      }
    }
    prev = cur;
  }
  dists.sort((a, b) => a - b);
  console.log(`  真实非门将相邻采样位移(0.2s): p10 ${dists[Math.floor(dists.length * 0.1)].toFixed(3)} p50 ${dists[Math.floor(dists.length * 0.5)].toFixed(3)} p90 ${dists[Math.floor(dists.length * 0.9)].toFixed(3)} p99 ${dists[Math.floor(dists.length * 0.99)].toFixed(3)} max ${dists[dists.length - 1].toFixed(3)}`);
}

// ---------- 5. 引擎的「比赛状态」覆盖：事件类型分布 vs 真实窗口覆盖面 ----------
console.log('\n=== 5. 引擎 300s 是完整比赛（含开球/终场）===');
const stream = engineStream(42);
const evs = Object.values(JSON.parse(stream)).filter(e => e && typeof e === 'object' && e.type);
console.log(`  引擎(seed42) 事件: ${evs.filter(e => e.type !== 'beat').map(e => `${e.type}@${e.t}`).join(' ')}`);
for (const [gi, d] of games.entries()) {
  const bt = d.meta.endTime;
  console.log(`  真实 game${gi + 1}: ${bt.toFixed(0)}s，取 7 个 5 分钟窗口覆盖 [0,300],[900,1200],...,[5400,5700]`);
}
