// Probe 7: 瞬移帧对基线的污染 + 引擎主客对称性(全种子) + 重心绝对位置 + 球权代理对重心间距的影响
import { readFileSync } from 'node:fs';
import { createGame } from './game.js';
const L = 105, W = 68;
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); const i = p * (s.length - 1); const lo = Math.floor(i), hi = Math.ceil(i); return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); };
const isKeeper = id => id === 0 || id === 21;

const games = [1, 2].map(g => JSON.parse(readFileSync(`./data/real-game-${g}.json`, 'utf8')));

// ---------- 1. 瞬移帧剔除前后 ----------
console.log('=== 1. 瞬移帧（任一球员单帧跳 >10m）剔除前后：真实基线 ===');
function windowVals(clean) {
  const vals = [];
  for (const [gi, d] of games.entries()) {
    // 标记恶劣帧
    const bad = new Set();
    if (clean) {
      let prev = null;
      for (let k = 0; k < d.frames.length; k++) {
        const f = d.frames[k];
        if (prev) {
          for (let i = 0; i < 22; i++) {
            const a = prev.players[i], b = f.players[i];
            if (a && b && Math.hypot((a[0] - b[0]) * L, (a[1] - b[1]) * W) > 10) bad.add(k);
          }
        }
        prev = f;
      }
    }
    for (let s = 0; s < 5500; s += 900) {
      const w = d.frames.filter((f, k) => f.t >= s && f.t < s + 300 && !bad.has(k));
      if (w.length > 100) {
        const deps = w.map(f => { const xs = []; for (let i = 1; i <= 10; i++) if (f.players[i]) xs.push(f.players[i][0] * L); return xs.length >= 7 ? Math.max(...xs) - Math.min(...xs) : null; }).filter(v => v != null);
        vals.push(avg(deps));
      }
    }
  }
  return vals;
}
const raw = windowVals(false), cleaned = windowVals(true);
console.log(`  原始: 均值 ${avg(raw).toFixed(1)} 范围 ${Math.min(...raw).toFixed(1)}–${Math.max(...raw).toFixed(1)} p5=${pct(raw, 0.05).toFixed(1)} p95=${pct(raw, 0.95).toFixed(1)}`);
console.log(`  剔瞬移: 均值 ${avg(cleaned).toFixed(1)} 范围 ${Math.min(...cleaned).toFixed(1)}–${Math.max(...cleaned).toFixed(1)} p5=${pct(cleaned, 0.05).toFixed(1)} p95=${pct(cleaned, 0.95).toFixed(1)}`);
// 每场单独看
for (const [gi, d] of games.entries()) {
  for (const clean of [false, true]) {
    const bad = new Set();
    if (clean) { let prev = null; for (let k = 0; k < d.frames.length; k++) { const f = d.frames[k]; if (prev) { for (let i = 0; i < 22; i++) { const a = prev.players[i], b = f.players[i]; if (a && b && Math.hypot((a[0] - b[0]) * L, (a[1] - b[1]) * W) > 10) bad.add(k); } } prev = f; } }
    const vals = [];
    for (let s = 0; s < 5500; s += 900) {
      const w = d.frames.filter((f, k) => f.t >= s && f.t < s + 300 && !bad.has(k));
      if (w.length > 100) { const deps = w.map(f => { const xs = []; for (let i = 1; i <= 10; i++) if (f.players[i]) xs.push(f.players[i][0] * L); return xs.length >= 7 ? Math.max(...xs) - Math.min(...xs) : null; }).filter(v => v != null); vals.push(avg(deps)); }
    }
    console.log(`  game${gi + 1} ${clean ? '剔瞬移' : '原始  '}: [${vals.map(v => v.toFixed(1)).join(', ')}]`);
  }
}

// ---------- 2. 引擎主客对称性（全 5 种子） ----------
console.log('\n=== 2. 引擎主客纵深对称性（5 种子） ===');
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
function tm(f, team) {
  const ps = f.players.filter(p => p && !isKeeper(p.id) && (team === 'home' ? p.id <= 10 : p.id >= 11));
  if (ps.length < 7) return null;
  const xs = ps.map(p => p.x * L), ys = ps.map(p => p.y * W);
  return { depth: Math.max(...xs) - Math.min(...xs), cx: avg(xs), cy: avg(ys), spread: avg(xs.map((x, i) => Math.hypot(x - avg(xs), ys[i] - avg(ys)))) };
}
const SEEDS = [42, 1, 7, 99, 123];
const engHome = [], engAway = [];
for (const seed of SEEDS) {
  const g = createGame(engineStream(seed)); const fr = [];
  for (let t = 0; t <= g.matchEnd; t += 0.2) { g.seekTo(t); fr.push({ players: g.players.map(p => ({ id: p.id, x: p.x, y: p.y })), ball: [g.ball.x, g.ball.y] }); }
  const h = fr.map(f => tm(f, 'home')).filter(Boolean), a = fr.map(f => tm(f, 'away')).filter(Boolean);
  engHome.push({ d: avg(h.map(m => m.depth)), cx: avg(h.map(m => m.cx)), cy: avg(h.map(m => m.cy)) });
  engAway.push({ d: avg(a.map(m => m.depth)), cx: avg(a.map(m => m.cx)), cy: avg(a.map(m => m.cy)) });
  console.log(`  seed ${String(seed).padStart(3)}: home 纵深 ${avg(h.map(m => m.depth)).toFixed(1)} 重心(${avg(h.map(m => m.cx)).toFixed(1)}, ${avg(h.map(m => m.cy)).toFixed(1)}) | away 纵深 ${avg(a.map(m => m.depth)).toFixed(1)} 重心(${avg(a.map(m => m.cx)).toFixed(1)}, ${avg(a.map(m => m.cy)).toFixed(1)})`);
}
console.log(`  home 纵深均值 ${avg(engHome.map(x => x.d)).toFixed(2)} | away 纵深均值 ${avg(engAway.map(x => x.d)).toFixed(2)}  → 主客差 ${(avg(engHome.map(x => x.d)) - avg(engAway.map(x => x.d))).toFixed(2)}m`);
console.log(`  home 重心x 均值 ${avg(engHome.map(x => x.cx)).toFixed(1)} (球场中点 52.5) | away 重心x 均值 ${avg(engAway.map(x => x.cx)).toFixed(1)}`);

// ---------- 3. 真实主客重心（含纵深对照） ----------
console.log('\n=== 3. 真实主客纵深与重心绝对位置 ===');
{
  const recs = [];
  for (const [gi, d] of games.entries()) {
    const fr = d.frames.map(f => ({ players: f.players.map((p, i) => p ? { id: i, x: p[0], y: p[1] } : null) }));
    const h = fr.map(f => tm(f, 'home')).filter(Boolean), a = fr.map(f => tm(f, 'away')).filter(Boolean);
    console.log(`  game${gi + 1} 全场: home 纵深 ${avg(h.map(m => m.depth)).toFixed(1)} 重心(${avg(h.map(m => m.cx)).toFixed(1)}, ${avg(h.map(m => m.cy)).toFixed(1)}) | away 纵深 ${avg(a.map(m => m.depth)).toFixed(1)} 重心(${avg(a.map(m => m.cx)).toFixed(1)}, ${avg(a.map(m => m.cy)).toFixed(1)})`);
    for (let s = 0; s < 5500; s += 900) {
      const w = d.frames.filter(f => f.t >= s && f.t < s + 300).map(f => ({ players: f.players.map((p, i) => p ? { id: i, x: p[0], y: p[1] } : null) }));
      if (w.length <= 100) continue;
      const H = w.map(f => tm(f, 'home')).filter(Boolean), A = w.map(f => tm(f, 'away')).filter(Boolean);
      recs.push({ hd: avg(H.map(m => m.depth)), ad: avg(A.map(m => m.depth)), hcx: avg(H.map(m => m.cx)), acx: avg(A.map(m => m.cx)) });
    }
  }
  console.log(`  14 窗口: home 纵深 ${avg(recs.map(r => r.hd)).toFixed(1)} | away 纵深 ${avg(recs.map(r => r.ad)).toFixed(1)} → 主客差 ${(avg(recs.map(r => r.hd)) - avg(recs.map(r => r.ad))).toFixed(2)}m`);
  console.log(`  窗口 home 重心x: ${Math.min(...recs.map(r => r.hcx)).toFixed(1)}–${Math.max(...recs.map(r => r.hcx)).toFixed(1)} | away 重心x: ${Math.min(...recs.map(r => r.acx)).toFixed(1)}–${Math.max(...recs.map(r => r.acx)).toFixed(1)}`);
}

// ---------- 4. ballFill 对重心间距的影响 ----------
console.log('\n=== 4. ballFill（球到最近球员）对指标本身的影响？ ===');
console.log('  说明：ballFill 只影响 ball 位置相关指标（重心到球距离、控球代理），不影响纵深/宽度/紧凑度。');
console.log('  验证：含 ballFill 帧 × 不含 ballFill 帧，队列指标是否相同');
{
  const d = games[0];
  const val = (f, fn) => { const xs = []; for (let i = 1; i <= 10; i++) if (f.players[i]) xs.push(f.players[i][0] * L); return xs.length >= 7 ? fn(xs) : null; };
  const fillFrames = d.frames.filter(f => f.ballFill !== undefined && f.ballFill !== null);
  const rawFrames = d.frames.filter(f => !(f.ballFill !== undefined && f.ballFill !== null));
  console.log(`  ballFill 帧纵深均值 ${avg(fillFrames.map(f => val(f, xs => Math.max(...xs) - Math.min(...xs))).filter(v => v != null)).toFixed(1)} vs 原始帧 ${avg(rawFrames.map(f => val(f, xs => Math.max(...xs) - Math.min(...xs))).filter(v => v != null)).toFixed(1)}（差异应为伪影差异而非填充差异）`);
}

// ---------- 5. 弹性口径对「球半场」的敏感性：改用「球到本队重心的距离」而非半场划分 ----------
console.log('\n=== 5. 弹性改用「球相对本队重心 x 的前后」划分（对比半场划分） ===');
function elasticityBy(frames, divider) {
  const near = [], far = [];
  for (const f of frames) {
    const d = tm(f, 'home'); if (!d || !f.ball) continue;
    const ballInOwn = f.ball[0] < 0.5;
    const ballBehindCentroid = f.ball[0] * L < d.cx;
    const grp = divider === 'half' ? ballInOwn : ballBehindCentroid;
    (grp ? near : far).push(d.depth);
  }
  return near.length > 30 && far.length > 30 ? { near: avg(near), far: avg(far), delta: avg(far) - avg(near), nNear: near.length, nFar: far.length } : null;
}
{
  const res = [];
  for (const [gi, d] of games.entries()) {
    for (let s = 0; s < 5500; s += 900) {
      const w = d.frames.filter(f => f.t >= s && f.t < s + 300).map(f => ({ players: f.players.map((p, i) => p ? { id: i, x: p[0], y: p[1] } : null), ball: f.ball }));
      if (w.length <= 100) continue;
      const e = elasticityBy(w, 'half'); if (e) res.push(e);
    }
  }
  console.log(`  真实（半场划分）: Δ 均值 ${avg(res.map(r => r.delta)).toFixed(1)} (${Math.min(...res.map(r => r.delta)).toFixed(1)}~${Math.max(...res.map(r => r.delta)).toFixed(1)})`);
}
{
  const res = [];
  for (const seed of SEEDS) {
    const g = createGame(engineStream(seed)); const fr = [];
    for (let t = 0; t <= g.matchEnd; t += 0.2) { g.seekTo(t); fr.push({ players: g.players.map(p => ({ id: p.id, x: p.x, y: p.y })), ball: [g.ball.x, g.ball.y] }); }
    const e = elasticityBy(fr, 'half'); if (e) res.push(e);
  }
  console.log(`  引擎（半场划分）: Δ 均值 ${avg(res.map(r => r.delta)).toFixed(1)} (${Math.min(...res.map(r => r.delta)).toFixed(1)}~${Math.max(...res.map(r => r.delta)).toFixed(1)})`);
}
{
  const res = [];
  for (const [gi, d] of games.entries()) {
    for (let s = 0; s < 5500; s += 900) {
      const w = d.frames.filter(f => f.t >= s && f.t < s + 300).map(f => ({ players: f.players.map((p, i) => p ? { id: i, x: p[0], y: p[1] } : null), ball: f.ball }));
      if (w.length <= 100) continue;
      const e = elasticityBy(w, 'centroid'); if (e) res.push(e);
    }
  }
  console.log(`  真实（重心划分）: Δ 均值 ${avg(res.map(r => r.delta)).toFixed(1)} (${Math.min(...res.map(r => r.delta)).toFixed(1)}~${Math.max(...res.map(r => r.delta)).toFixed(1)})`);
}
{
  const res = [];
  for (const seed of SEEDS) {
    const g = createGame(engineStream(seed)); const fr = [];
    for (let t = 0; t <= g.matchEnd; t += 0.2) { g.seekTo(t); fr.push({ players: g.players.map(p => ({ id: p.id, x: p.x, y: p.y })), ball: [g.ball.x, g.ball.y] }); }
    const e = elasticityBy(fr, 'centroid'); if (e) res.push(e);
  }
  console.log(`  引擎（重心划分）: Δ 均值 ${avg(res.map(r => r.delta)).toFixed(1)} (${Math.min(...res.map(r => r.delta)).toFixed(1)}~${Math.max(...res.map(r => r.delta)).toFixed(1)})`);
}
