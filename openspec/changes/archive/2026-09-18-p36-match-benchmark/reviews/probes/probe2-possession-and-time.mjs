// Probe 2: 控球代理偏向性 + 引擎时间稳定性 + 窗口数核对
import { readFileSync } from 'node:fs';
import { createGame } from './game.js';
const L = 105, W = 68;
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const isKeeper = id => id === 0 || id === 21;

const games = [1, 2].map(g => JSON.parse(readFileSync(`./data/real-game-${g}.json`, 'utf8')));

// ---------- 0. 窗口数核对 ----------
console.log('=== 0. 窗口数核对（设计称 12）===');
for (const [gi, d] of games.entries()) {
  let cnt = 0, det = [];
  for (let s = 0; s < 5500; s += 900) {
    const w = d.frames.filter(f => f.t >= s && f.t < s + 300);
    if (w.length > 100) { cnt++; det.push(`[${s}-${s + 300}] ${w.length}帧`); }
  }
  console.log(`  比赛${gi + 1}: ${cnt} 个窗口 (时长 ${d.meta.endTime}s): ${det.join(' | ')}`);
}

// ---------- 1. 控球代理 ----------
console.log('\n=== 1. 控球代理（离球最近者所属队）在真实数据上的分布 ===');
function possession(f, teams) {
  if (!f.ball) return null;
  const [bx, by] = f.ball; let best = null;
  for (let i = 0; i < 22; i++) {
    const p = f.players[i]; if (!p) continue;
    const d = Math.hypot((p[0] - bx) * L, (p[1] - by) * W);
    if (!best || d < best.d) best = { d, id: i };
  }
  return best ? (best.id <= 10 ? 'home' : 'away') : null;
}
for (const [gi, d] of games.entries()) {
  let home = 0, away = 0, none = 0;
  let fillHome = 0, fillAway = 0, fillN = 0, rawHome = 0, rawAway = 0, rawN = 0;
  let fillSelfDist = 0, fillSelfN = 0;
  for (const f of d.frames) {
    const pos = possession(f);
    if (pos === 'home') home++; else if (pos === 'away') away++; else none++;
    if (f.ballFill !== undefined && f.ballFill !== null) {
      fillN++;
      if (pos === 'home') fillHome++; else if (pos === 'away') fillAway++;
      // 补全帧上，球到最近球员的距离（应为 0，除非重复坐标）
      const [bx, by] = f.ball; let best = Infinity;
      for (let i = 0; i < 22; i++) { const p = f.players[i]; if (!p) continue; const dd = Math.hypot((p[0] - bx) * L, (p[1] - by) * W); best = Math.min(best, dd); }
      fillSelfDist += best; fillSelfN++;
    } else {
      rawN++;
      if (pos === 'home') rawHome++; else if (pos === 'away') rawAway++;
    }
  }
  const pctf = (x, n) => n ? (100 * x / n).toFixed(1) + '%' : '-';
  console.log(`  比赛${gi + 1}: 总帧 ${d.frames.length}`);
  console.log(`    控球代理总体: home ${pctf(home, home + away)} / away ${pctf(away, home + away)} (null ${none})`);
  console.log(`    补全帧(${fillN}, ${pctf(fillN, d.frames.length)}): home ${pctf(fillHome, fillN)} / away ${pctf(fillAway, fillN)}；球到最近球员平均距离 ${(fillSelfDist / fillSelfN).toFixed(3)}m`);
  console.log(`    原始帧(${rawN}, ${pctf(rawN, d.frames.length)}): home ${pctf(rawHome, rawN)} / away ${pctf(rawAway, rawN)}`);
}

// ---------- 2. 补全链：ballFill 持续多久、是否会在两队间跳变 ----------
console.log('\n=== 2. 补全链分析（比赛1）===');
{
  const d = games[0];
  let chain = [], cur = null;
  for (const f of d.frames) {
    const isFill = f.ballFill !== undefined && f.ballFill !== null;
    if (isFill) { if (!cur) cur = { start: f.t, teams: new Set(), n: 0 }; cur.n++; cur.teams.add(f.ballFill <= 10 ? 'home' : 'away'); }
    else if (cur) { chain.push(cur); cur = null; }
  }
  if (cur) chain.push(cur);
  chain.sort((a, b) => b.n - a.n);
  console.log(`  补全链数量: ${chain.length}，最长 5 条:`);
  for (const c of chain.slice(0, 5)) console.log(`    t=${c.start.toFixed(0)}s 持续 ${c.n} 帧(${(c.n / 5).toFixed(0)}s) 涉及队伍: ${[...c.teams].join('+')}`);
  const multi = chain.filter(c => c.teams.size > 1).length;
  console.log(`  跨两队跳变的链: ${multi}/${chain.length}`);
}

// ---------- 3. 引擎时间稳定性：前 60s vs 后 60s；分桶演变 ----------
console.log('\n=== 3. 引擎 300s 内指标时间稳定性 ===');
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
function teamShape(f, team) {
  const ps = f.players.filter(p => p && !isKeeper(p.id) && (team === 'home' ? p.id <= 10 : p.id >= 11));
  if (ps.length < 7) return null;
  const xs = ps.map(p => p.x * L), ys = ps.map(p => p.y * W);
  const cx = avg(xs), cy = avg(ys);
  return { depth: Math.max(...xs) - Math.min(...xs), width: Math.max(...ys) - Math.min(...ys), cx, cy, spread: avg(xs.map((x, i) => Math.hypot(x - cx, ys[i] - cy))), n: ps.length };
}
const SEEDS = [42, 1, 7, 99, 123];
const engRuns = SEEDS.map(s => {
  const g = createGame(engineStream(s)); const out = [];
  for (let t = 0; t <= g.matchEnd; t += 0.2) { g.seekTo(t); out.push({ t: +t.toFixed(2), players: g.players.map(p => ({ id: p.id, x: p.x, y: p.y })), ball: [g.ball.x, g.ball.y] }); }
  return out;
});
for (const [si, run] of engRuns.entries()) {
  const seg = (a, b) => run.filter(f => f.t >= a && f.t < b);
  const m = fr => avg(fr.map(f => teamShape(f, 'home')?.depth).filter(v => v != null));
  const first = m(seg(0, 60)), mid = m(seg(60, 240)), last = m(seg(240, 300));
  const first10 = m(seg(0, 10)), first30 = m(seg(10, 60));
  console.log(`  seed ${SEEDS[si]}: 0-60s ${first.toFixed(1)} | 60-240s ${mid.toFixed(1)} | 240-300s ${last.toFixed(1)} || 前10s ${first10.toFixed(1)} vs 10-60s ${first30.toFixed(1)}`);
}
// 全局：去 kickoff 后均值变化？
{
  const m = (run, a, b) => avg(run.filter(f => f.t >= a && f.t < b).map(f => teamShape(f, 'home')?.depth).filter(v => v != null));
  const full = avg(engRuns.map(r => m(r, 0, 300)));
  const noKick = avg(engRuns.map(r => m(r, 60, 300)));
  console.log(`  全 300s 均值 ${full.toFixed(2)} vs 去掉前 60s 均值 ${noKick.toFixed(2)}  → 差 ${(full - noKick).toFixed(2)}m`);
}

// 引擎比赛节奏：事件数/球的位置覆盖
{
  const run = engRuns[0];
  const ballx = run.map(f => f.ball[0]);
  console.log(`  引擎 seed42 球 x 范围: ${Math.min(...ballx).toFixed(2)}–${Math.max(...ballx).toFixed(2)} (归一化)`);
  const d = games[0];
  const rbx = d.frames.map(f => f.ball[0]);
  console.log(`  真实 game1 球 x 范围: ${Math.min(...rbx).toFixed(2)}–${Math.max(...rbx).toFixed(2)}`);
}
