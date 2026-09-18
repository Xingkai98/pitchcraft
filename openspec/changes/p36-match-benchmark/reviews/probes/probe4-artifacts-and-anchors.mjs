// Probe 4: 重复坐标伪影影响 + 引擎锚点密度与 hold 段 + game2 低值窗口解剖 + 引擎弹性修正
import { readFileSync } from 'node:fs';
import { createGame } from './game.js';
const L = 105, W = 68;
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const isKeeper = id => id === 0 || id === 21;

const games = [1, 2].map(g => JSON.parse(readFileSync(`./data/real-game-${g}.json`, 'utf8')));

// ---------- 1. 重复坐标伪影：发生在哪些帧？对纵深的影响？ ----------
console.log('=== 1. 重复坐标伪影（同帧两人坐标完全相同） ===');
for (const [gi, d] of games.entries()) {
  let dupFrames = [];  // 帧号
  const dupPairs = [];  // 涉及球员 id
  for (let k = 0; k < d.frames.length; k++) {
    const f = d.frames[k];
    const seen = new Map();
    let hasDup = false;
    for (let i = 0; i < 22; i++) {
      const p = f.players[i]; if (!p) continue;
      const key = `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
      if (seen.has(key)) { hasDup = true; dupPairs.push([seen.get(key), i, f.t]); }
      else seen.set(key, i);
    }
    if (hasDup) dupFrames.push(k);
  }
  const pctDup = 100 * dupFrames.length / d.frames.length;
  console.log(`  比赛${gi + 1}: 含重复坐标帧 ${dupFrames.length} (${pctDup.toFixed(2)}%)，重复对 ${dupPairs.length}`);
  // 重复对类型：同队 vs 跨队
  const sameTeam = dupPairs.filter(([a, b]) => (a <= 10) === (b <= 10)).length;
  console.log(`    同队重复 ${sameTeam} / 跨队重复 ${dupPairs.length - sameTeam}`);
  // 涉及门将？
  const withKeeper = dupPairs.filter(([a, b]) => isKeeper(a) || isKeeper(b)).length;
  console.log(`    涉及门将 ${withKeeper}`);
  // 该帧深度 vs 全体深度
  const depth = f => {
    const ps = [];
    for (let i = 0; i < 22; i++) { const p = f.players[i]; if (p && !isKeeper(i)) ps.push(p[0] * L); }
    return ps.length >= 7 ? Math.max(...ps) - Math.min(...ps) : null;
  };
  const dupSet = new Set(dupFrames);
  const dv = d.frames.map((f, k) => dupSet.has(k) ? depth(f) : null).filter(v => v != null);
  const nv = d.frames.map((f, k) => dupSet.has(k) ? null : depth(f)).filter(v => v != null);
  console.log(`    重复帧纵深: 均值 ${avg(dv).toFixed(1)} (max ${Math.max(...dv).toFixed(1)}) vs 正常帧: 均值 ${avg(nv).toFixed(1)} (max ${Math.max(...nv).toFixed(1)})`);
  // 极端值来自哪类帧？
  const sorted = d.frames.map((f, k) => ({ k, dep: depth(f) })).filter(x => x.dep != null).sort((a, b) => b.dep - a.dep);
  const top20 = sorted.slice(0, 20);
  const top20dup = top20.filter(x => dupSet.has(x.k)).length;
  console.log(`    纵深最大的 20 帧中，含重复坐标的: ${top20dup}/20；这20帧的 t: ${top20.slice(0, 5).map(x => d.frames[x.k].t).join(',')}...`);
}

// ---------- 2. 引擎锚点密度 / hold 段 ----------
console.log('\n=== 2. 引擎事件流锚点密度（Player anchor 间隔） ===');
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
const stream = engineStream(42);
const evs = JSON.parse(stream);
console.log(`  事件流顶层 keys: ${Object.keys(evs)}`);
const events = evs.events || evs;
if (Array.isArray(events)) {
  console.log(`  事件数: ${events.length}`);
  // 找球员锚点：看第一个事件的结构
  console.log(`  事件类型分布:`);
  const types = {};
  for (const e of events) types[e.type] = (types[e.type] || 0) + 1;
  console.log('   ', JSON.stringify(types));
  console.log(`  首事件: ${JSON.stringify(events[0]).slice(0, 300)}`);
  // 时间间隔
  const ts = events.map(e => e.t).filter(t => typeof t === 'number');
  const gaps = [];
  for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
  gaps.sort((a, b) => a - b);
  console.log(`  事件时间间隔: min ${gaps[0]?.toFixed(2)} p50 ${gaps[Math.floor(gaps.length / 2)]?.toFixed(2)} p95 ${gaps[Math.floor(gaps.length * 0.95)]?.toFixed(2)} max ${gaps[gaps.length - 1]?.toFixed(2)}`);
  // 最大间隔段
  let maxGap = 0, maxAt = 0;
  for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] > maxGap) { maxGap = ts[i] - ts[i - 1]; maxAt = ts[i - 1]; }
  console.log(`  最大间隔 ${maxGap.toFixed(2)}s 出现在 t=${maxAt.toFixed(1)}s`);
}

// 用 Game 逐 0.2s 采样，检测 hold 段（连续两帧位置完全一样）
{
  const g = createGame(stream);
  let same = 0, total = 0, prev = null;
  const holds = [];
  let holdStart = null;
  for (let t = 0; t <= g.matchEnd; t += 0.2) {
    g.seekTo(t);
    const sig = g.players.map(p => `${p.id}:${p.x.toFixed(4)},${p.y.toFixed(4)}`).join('|');
    if (prev !== null) { total++; if (sig === prev) { same++; if (holdStart === null) holdStart = t - 0.2; } else if (holdStart !== null) { holds.push([holdStart, t - 0.2]); holdStart = null; } }
    prev = sig;
  }
  if (holdStart !== null) holds.push([holdStart, g.matchEnd]);
  console.log(`  0.2s 采样下「全队位置完全不变」的帧对: ${same}/${total} (${(100 * same / total).toFixed(1)}%)`);
  console.log(`  hold 段: ${holds.length} 段，最长 ${holds.length ? Math.max(...holds.map(h => h[1] - h[0])).toFixed(1) : 0}s`);
  console.log(`  前 5 段: ${holds.slice(0, 5).map(h => `[${h[0].toFixed(1)}-${h[1].toFixed(1)}]`).join(' ')}`);
}

// ---------- 3. 引擎弹性（修正版：直接用统一帧） ----------
console.log('\n=== 3. 引擎弹性 Δ（修正探针 bug 后） ===');
function teamDepth(f, team) {
  const ps = f.players.filter(p => p && !isKeeper(p.id) && (team === 'home' ? p.id <= 10 : p.id >= 11));
  if (ps.length < 7) return null;
  const xs = ps.map(p => p.x * L);
  return Math.max(...xs) - Math.min(...xs);
}
function elasticityUnified(frames) {
  const own = [], opp = [];
  for (const f of frames) {
    if (!f.ball) continue;
    const d = teamDepth(f, 'home');
    if (d == null) continue;
    (f.ball[0] < 0.5 ? own : opp).push(d);
  }
  return own.length > 30 && opp.length > 30 ? { own: avg(own), opp: avg(opp), delta: avg(opp) - avg(own), nOwn: own.length, nOpp: opp.length } : null;
}
const g42 = createGame(stream);
const engFrames = [];
for (let t = 0; t <= g42.matchEnd; t += 0.2) { g42.seekTo(t); engFrames.push({ t: +t.toFixed(2), players: g42.players.map(p => ({ id: p.id, x: p.x, y: p.y })), ball: [g42.ball.x, g42.ball.y] }); }
const e42 = elasticityUnified(engFrames);
console.log(`  seed42: 防守时 ${e42.own.toFixed(1)}m → 进攻时 ${e42.opp.toFixed(1)}m Δ=${e42.delta.toFixed(1)}m (own ${e42.nOwn} 帧 / opp ${e42.nOpp} 帧)`);
console.log(`  设计称引擎 Δ=11.3 (5.5~20.2)`);

// ---------- 4. game2 低值窗口解剖（W5 t=4500-4800, depth 22.2） ----------
console.log('\n=== 4. game2 W5 (4500-4800s, 纵深 22.2m) 解剖 ===');
{
  const d = games[1];
  const w = d.frames.filter(f => f.t >= 4500 && f.t < 4800);
  console.log(`  帧数: ${w.length}（正常窗口应为 1500）`);
  // 每帧人数
  const counts = w.map(f => f.players.filter(Boolean).length);
  console.log(`  人数: min ${Math.min(...counts)} max ${Math.max(...counts)} 均值 ${avg(counts).toFixed(1)}`);
  const homeCounts = w.map(f => f.players.slice(0, 11).filter(Boolean).length);
  const awayCounts = w.map(f => f.players.slice(11).filter(Boolean).length);
  console.log(`  主队人数: ${Math.min(...homeCounts)}–${Math.max(...homeCounts)} | 客队: ${Math.min(...awayCounts)}–${Math.max(...awayCounts)}`);
  // 非门将主队 x 范围演变（每 30s 一个块）
  for (let s = 4500; s < 4800; s += 60) {
    const seg = d.frames.filter(f => f.t >= s && f.t < s + 60);
    const xs = seg.flatMap(f => { const ps = []; for (let i = 1; i <= 10; i++) if (f.players[i]) ps.push(f.players[i][0] * L); return ps; });
    if (xs.length) console.log(`    [${s}-${s + 60}] 主队非门将 x: min ${Math.min(...xs).toFixed(1)} max ${Math.max(...xs).toFixed(1)} span ${(Math.max(...xs) - Math.min(...xs)).toFixed(1)}m`);
  }
  // 该窗口球在哪
  const bx = w.filter(f => f.ball).map(f => f.ball[0] * L);
  console.log(`  球 x: ${Math.min(...bx).toFixed(1)}–${Math.max(...bx).toFixed(1)}m，均值 ${avg(bx).toFixed(1)}m`);
}

// ---------- 5. 引擎全队 hold 段对指标影响：与真实对比「位置更新时间戳覆盖率」 ----------
console.log('\n=== 5. 引擎采样点 vs 事件锚点覆盖 ===');
{
  // 引擎逐 0.2s 采样中，有多少采样点落在两个锚点的 hold 区间（跨事件）
  // 近似：统计 0.2s 采样位置上，与前一采样点的距离分布
  let dists = [], zeroRun = 0, prev = null;
  for (const f of engFrames) {
    if (prev) {
      const h0 = f.players.find(p => p.id === 0), p0 = prev.players.find(p => p.id === 0);
      if (h0 && p0) dists.push(Math.hypot((h0.x - p0.x) * L, (h0.y - p0.y) * W));
    }
    prev = f;
  }
  dists.sort((a, b) => a - b);
  console.log(`  球员0 相邻采样点移动距离: p10 ${dists[Math.floor(dists.length * 0.1)].toFixed(3)}m p50 ${dists[Math.floor(dists.length * 0.5)].toFixed(3)}m p90 ${dists[Math.floor(dists.length * 0.9)].toFixed(3)}m max ${dists[dists.length - 1].toFixed(3)}m`);
  console.log(`  （两采样点间隔 0.2s；若球员全速 ~8m/s，理论位移约 1.6m）`);
}
