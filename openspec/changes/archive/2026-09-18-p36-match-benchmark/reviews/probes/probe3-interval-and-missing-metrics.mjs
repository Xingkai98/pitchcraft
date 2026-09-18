// Probe 3: 区间稳定性(bootstrap/分场) + 弹性口径敏感性 + 遗漏指标体检
import { readFileSync } from 'node:fs';
import { createGame } from './game.js';
const L = 105, W = 68;
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); const i = p * (s.length - 1); const lo = Math.floor(i), hi = Math.ceil(i); return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); };
const isKeeper = id => id === 0 || id === 21;

const games = [1, 2].map(g => JSON.parse(readFileSync(`./data/real-game-${g}.json`, 'utf8')));
const windows = [];
for (const [gi, d] of games.entries())
  for (let s = 0; s < 5500; s += 900) {
    const w = d.frames.filter(f => f.t >= s && f.t < s + 300);
    if (w.length > 100) windows.push({ game: gi + 1, s, frames: w, obj: d });
  }

// 统一帧构造
function shapeFromRaw(f) {
  const ps = f.players.map((p, i) => p ? { id: i, x: p[0], y: p[1] } : null);
  return { players: ps, ball: f.ball };
}
function teamShape(f, team) {
  const ps = f.players.filter(p => p && !isKeeper(p.id) && (team === 'home' ? p.id <= 10 : p.id >= 11));
  if (ps.length < 7) return null;
  const xs = ps.map(p => p.x * L), ys = ps.map(p => p.y * W);
  return { depth: Math.max(...xs) - Math.min(...xs), width: Math.max(...ys) - Math.min(...ys) };
}

// ---------- 1. 弹性：全帧 vs 仅原始球帧（真实侧） ----------
console.log('=== 1. 弹性（纵深 vs 球半场）口径敏感性 ===');
function elasticity(frames, rawOnly) {
  const own = [], opp = [];
  for (const f of frames) {
    if (rawOnly && f.ballFill !== undefined && f.ballFill !== null) continue;
    if (!f.ball) continue;
    const s = teamShape(shapeFromRaw(f), 'home');
    if (!s) continue;
    (f.ball[0] < 0.5 ? own : opp).push(s.depth);
  }
  return own.length > 30 && opp.length > 30 ? { own: avg(own), opp: avg(opp), delta: avg(opp) - avg(own), nOwn: own.length, nOpp: opp.length } : null;
}
const realEAll = windows.map(w => elasticity(w.frames, false));
const realERaw = windows.map(w => elasticity(w.frames, true));
const validAll = realEAll.filter(Boolean), validRaw = realERaw.filter(Boolean);
console.log(`  全帧: ${validAll.length}/${windows.length} 窗口可用, Δ 均值 ${avg(validAll.map(e => e.delta)).toFixed(1)} (范围 ${Math.min(...validAll.map(e => e.delta)).toFixed(1)}~${Math.max(...validAll.map(e => e.delta)).toFixed(1)})`);
console.log(`  仅原始球帧: ${validRaw.length}/${windows.length} 窗口可用, Δ 均值 ${avg(validRaw.map(e => e.delta)).toFixed(1)} (范围 ${Math.min(...validRaw.map(e => e.delta)).toFixed(1)}~${Math.max(...validRaw.map(e => e.delta)).toFixed(1)})`);
console.log(`  → 设计称 12 窗口、Δ=4.4、范围 -1.9~16.4`);
// 球在半场的时长占比
for (const [gi, d] of games.entries()) {
  const ownT = d.frames.filter(f => f.ball && f.ball[0] < 0.5).length, tot = d.frames.filter(f => f.ball).length;
  console.log(`  比赛${gi + 1} 球在本方(home)半场时长占比: ${(100 * ownT / tot).toFixed(1)}%`);
}

// ---------- 2. 引擎侧弹性复现 ----------
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
{
  const engE = engRuns.map(fr => elasticity(fr, false)).filter(Boolean);
  console.log(`\n  引擎: ${engE.length}/5 可用, Δ 均值 ${avg(engE.map(e => e.delta)).toFixed(1)} (范围 ${Math.min(...engE.map(e => e.delta)).toFixed(1)}~${Math.max(...engE.map(e => e.delta)).toFixed(1)})  [设计称 11.3, 5.5~20.2]`);
  console.log(`  → 弹性倍数 ${(avg(engE.map(e => e.delta)) / avg(validAll.map(e => e.delta))).toFixed(1)}x`);
}

// ---------- 3. 区间门：bootstrap p5/p95 稳定性 ----------
console.log('\n=== 3. 区间门 bootstrap（14 窗口重采样 2000 次） ===');
const depthByWin = windows.map(w => avg(w.frames.map(f => teamShape(shapeFromRaw(f), 'home')?.depth).filter(v => v != null)));
const game1 = depthByWin.filter((_, i) => windows[i].game === 1);
const game2 = depthByWin.filter((_, i) => windows[i].game === 2);
console.log(`  game1 窗口均值: ${game1.map(v => v.toFixed(1)).join(', ')}`);
console.log(`  game2 窗口均值: ${game2.map(v => v.toFixed(1)).join(', ')}`);
console.log(`  合并 p5=${pct(depthByWin, 0.05).toFixed(1)} p50=${pct(depthByWin, 0.5).toFixed(1)} p95=${pct(depthByWin, 0.95).toFixed(1)}`);
console.log(`  game1 p5=${pct(game1, 0.05).toFixed(1)} p95=${pct(game1, 0.95).toFixed(1)} | game2 p5=${pct(game2, 0.05).toFixed(1)} p95=${pct(game2, 0.95).toFixed(1)}`);
// bootstrap
let bs = [];
for (let b = 0; b < 2000; b++) {
  const res = []; for (let i = 0; i < depthByWin.length; i++) res.push(depthByWin[Math.floor(Math.random() * depthByWin.length)]);
  bs.push({ p5: pct(res, 0.05), p95: pct(res, 0.95) });
}
const p5s = bs.map(b => b.p5).sort((a, b) => a - b), p95s = bs.map(b => b.p95).sort((a, b) => a - b);
console.log(`  bootstrap p5 的 90% CI: [${pct(p5s, 0.05).toFixed(1)}, ${pct(p5s, 0.95).toFixed(1)}]`);
console.log(`  bootstrap p95 的 90% CI: [${pct(p95s, 0.05).toFixed(1)}, ${pct(p95s, 0.95).toFixed(1)}]`);
// 2 场各留一交叉验证：用 game1 建区间，game2 窗口是否落在内
{
  const in1 = game2.filter(v => v >= pct(game1, 0.05) && v <= pct(game1, 0.95)).length;
  const in2 = game1.filter(v => v >= pct(game2, 0.05) && v <= pct(game2, 0.95)).length;
  console.log(`  交叉验证: game2 的 ${in1}/7 落在 game1 区间内；game1 的 ${in2}/7 落在 game2 区间内`);
}

// ---------- 4. 分位数 vs max-min 在引擎侧的对照 ----------
console.log('\n=== 4. 改用 p10-p90 后，分离是否保持？ ===');
function shapeP(f, team) {
  const ps = f.players.filter(p => p && !isKeeper(p.id) && (team === 'home' ? p.id <= 10 : p.id >= 11));
  if (ps.length < 7) return null;
  const xs = ps.map(p => p.x * L);
  return { d1090: pct(xs, 0.9) - pct(xs, 0.1), d595: pct(xs, 0.95) - pct(xs, 0.05) };
}
const realP = windows.map(w => ({ m: avg(w.frames.map(f => shapeP(shapeFromRaw(f), 'home')?.d1090).filter(v => v != null)), m595: avg(w.frames.map(f => shapeP(shapeFromRaw(f), 'home')?.d595).filter(v => v != null)) }));
const engP = engRuns.map(r => ({ m: avg(r.map(f => shapeP(f, 'home')?.d1090).filter(v => v != null)), m595: avg(r.map(f => shapeP(f, 'home')?.d595).filter(v => v != null)) }));
console.log(`  p10-p90: 真实 ${avg(realP.map(r => r.m)).toFixed(1)} (${Math.min(...realP.map(r => r.m)).toFixed(1)}–${Math.max(...realP.map(r => r.m)).toFixed(1)}) vs 引擎 ${avg(engP.map(r => r.m)).toFixed(1)} (${Math.min(...engP.map(r => r.m)).toFixed(1)}–${Math.max(...engP.map(r => r.m)).toFixed(1)})`);
console.log(`  p5-p95 : 真实 ${avg(realP.map(r => r.m595)).toFixed(1)} (${Math.min(...realP.map(r => r.m595)).toFixed(1)}–${Math.max(...realP.map(r => r.m595)).toFixed(1)}) vs 引擎 ${avg(engP.map(r => r.m595)).toFixed(1)} (${Math.min(...engP.map(r => r.m595)).toFixed(1)}–${Math.max(...engP.map(r => r.m595)).toFixed(1)})`);

// ---------- 5. 遗漏指标体检 ----------
console.log('\n=== 5. 候选遗漏指标：真实 vs 引擎 ===');
// 5a. 最近队友距离（局部紧凑度）
function nnDist(f, team) {
  const ps = f.players.filter(p => p && !isKeeper(p.id) && (team === 'home' ? p.id <= 10 : p.id >= 11));
  if (ps.length < 7) return null;
  let sum = 0;
  for (let i = 0; i < ps.length; i++) {
    let best = Infinity;
    for (let j = 0; j < ps.length; j++) if (i !== j) {
      const d = Math.hypot((ps[i].x - ps[j].x) * L, (ps[i].y - ps[j].y) * W);
      best = Math.min(best, d);
    }
    sum += best;
  }
  return sum / ps.length;
}
// 5b. 球到非持球方最近球员（压迫距离）—— 用控球代理的对方
function pressDist(f) {
  if (!f.ball) return null;
  const ps = f.players.filter(p => p && !isKeeper(p.id));
  if (ps.length < 14) return null;
  const [bx, by] = f.ball;
  let nearest = null;
  for (const p of ps) { const d = Math.hypot((p.x - bx) * L, (p.y - by) * W); if (!nearest || d < nearest.d) nearest = { d, id: p.id }; }
  if (!nearest) return null;
  const oppTeam = nearest.id <= 10 ? 'away' : 'home';
  let best = Infinity;
  for (const p of ps) {
    const isOpp = oppTeam === 'home' ? p.id <= 10 : p.id >= 11;
    if (!isOpp) continue;
    const d = Math.hypot((p.x - bx) * L, (p.y - by) * W);
    best = Math.min(best, d);
  }
  return best;
}
// 5c. 后防线深度（非门将最深 3 人的平均 x）+ 防线-锋线间隙
function linesGap(f, team) {
  const ps = f.players.filter(p => p && !isKeeper(p.id) && (team === 'home' ? p.id <= 10 : p.id >= 11));
  if (ps.length < 7) return null;
  const xs = ps.map(p => team === 'home' ? p.x * L : (1 - p.x) * L).sort((a, b) => a - b);
  const back3 = xs.slice(0, 3), front3 = xs.slice(-3);
  return { backLine: avg(back3), frontLine: avg(front3), gap: avg(front3) - avg(back3) };
}
// 5d. 凸包面积（队形覆盖面积）
function hullArea(f, team) {
  const ps = f.players.filter(p => p && !isKeeper(p.id) && (team === 'home' ? p.id <= 10 : p.id >= 11));
  if (ps.length < 7) return null;
  const pts = ps.map(p => [p.x * L, p.y * W]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of [...pts].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  const hull = lower.concat(upper.slice(1, -1));
  let a = 0;
  for (let i = 0; i < hull.length; i++) { const j = (i + 1) % hull.length; a += hull[i][0] * hull[j][1] - hull[j][0] * hull[i][1]; }
  return Math.abs(a) / 2;
}
const CAND = {
  '最近队友距离': f => nnDist(f, 'home'),
  '球到对方最近者(压迫)': f => pressDist(f),
  '防线-锋线间隙': f => linesGap(f, 'home')?.gap,
  '凸包面积': f => hullArea(f, 'home'),
};
for (const [name, fn] of Object.entries(CAND)) {
  const rv = windows.map(w => avg(w.frames.map(f => fn(shapeFromRaw(f))).filter(v => v != null)));
  const ev = engRuns.map(r => avg(r.map(f => fn(f)).filter(v => v != null)));
  const sep = Math.max(...rv) < Math.min(...ev) || Math.max(...ev) < Math.min(...rv);
  console.log(`  ${name.padEnd(20)} 真实 ${avg(rv).toFixed(1)} (${Math.min(...rv).toFixed(1)}–${Math.max(...rv).toFixed(1)}) | 引擎 ${avg(ev).toFixed(1)} (${Math.min(...ev).toFixed(1)}–${Math.max(...ev).toFixed(1)}) | ${sep ? '✓分离' : '✗重叠'}`);
}

// ---------- 6. 真实数据时间稳定性：窗口间是否有漂移 ----------
console.log('\n=== 6. 真实窗口的时序（game1） ===');
console.log('  ' + game1.map((v, i) => `W${i}(${windows[i].s}s): ${v.toFixed(1)}`).join('  '));
