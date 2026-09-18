// Probe 1: 指标方法论
// - 复现设计基线数字（可复现性）
// - 稀疏采样(5Hz keyframe) vs 全量 25Hz 的极值伪影
// - max-min vs 分位数(p5-p95 / p10-p90)
// - 10 人剔除门将的统计性质
import { readFileSync } from 'node:fs';
const L = 105, W = 68;
const isKeeper = id => id === 0 || id === 21;
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); const i = p * (s.length - 1); const lo = Math.floor(i), hi = Math.ceil(i); return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); };
const rng = a => `${Math.min(...a).toFixed(1)}–${Math.max(...a).toFixed(1)}`;

function teamShape(f, team) {
  const ps = f.players.filter(p => p && !isKeeper(p.id) && (team === 'home' ? p.id <= 10 : p.id >= 11));
  if (ps.length < 7) return null;
  const xs = ps.map(p => p.x * L), ys = ps.map(p => p.y * W);
  const cx = avg(xs), cy = avg(ys);
  return {
    depth: Math.max(...xs) - Math.min(...xs),
    depthP: pct(xs, 0.9) - pct(xs, 0.1),          // p10-p90 跨度
    depthP5: pct(xs, 0.95) - pct(xs, 0.05),        // p5-p95 跨度
    width: Math.max(...ys) - Math.min(...ys),
    widthP: pct(ys, 0.9) - pct(ys, 0.1),
    cx, cy,
    spread: avg(xs.map((x, i) => Math.hypot(x - cx, ys[i] - cy))),
    n: ps.length,
  };
}

// ---------- 真实侧 ----------
const games = [1, 2].map(g => JSON.parse(readFileSync(`./data/real-game-${g}.json`, 'utf8')));

// 窗口：与 probe-tmp.mjs 一致 0..5500 step 900, 窗口 300s
const windows = [];
for (const [gi, d] of games.entries()) {
  for (let s = 0; s < 5500; s += 900) {
    const w = d.frames.filter(f => f.t >= s && f.t < s + 300);
    if (w.length > 100) windows.push({ game: gi + 1, s, frames: w });
  }
}

// ---------- 复现设计基线 ----------
console.log('=== 1a. 复现设计基线（应与 design.md D3 数字一致） ===');
function shapeFromRaw(f) {
  const ps = f.players.map((p, i) => p ? { id: i, x: p[0], y: p[1] } : null);
  return { players: ps, ball: f.ball };
}
const realDepthW = windows.map(w => { let s = 0, n = 0; for (const f of w.frames) { const sh = teamShape(shapeFromRaw(f), 'home'); if (sh) { s += sh.depth; n++; } } return n ? s / n : NaN; });
console.log(`真实 纵深 max-min: 均值 ${avg(realDepthW).toFixed(1)} (窗口范围 ${rng(realDepthW)})  [设计称 32.2, 22.2–36.2, 12 窗口]`);
console.log(`真实 窗口数: ${windows.length}（设计称 12）`);

// ---------- 稀疏采样伪影 ----------
console.log('\n=== 1b. 5Hz keyframe 稀疏采样 vs 25Hz 全量：极值伪影有多大？ ===');
// 全量帧（25Hz 已入库，共 25Hz 数据；keyframe 5Hz 是每 5 帧取 1）
for (const [gi, d] of games.entries()) {
  const full = d.frames;               // 25 Hz
  const keyf = d.frames.filter((_, i) => i % 5 === 0); // 模拟 5Hz keyframe
  console.log(`  比赛 ${gi + 1}: 全量 ${full.length} 帧 vs 5Hz ${keyf.length} 帧`);
  // 单帧级别的差：同一时刻窗口内，两套采样下深度的差异
  const winFull = full.filter(f => f.t >= 900 && f.t < 1200);
  const winKey = keyf.filter(f => f.t >= 900 && f.t < 1200);
  const dF = avg(winFull.map(f => teamShape(shapeFromRaw(f), 'home')?.depth).filter(v => v != null));
  const dK = avg(winKey.map(f => teamShape(shapeFromRaw(f), 'home')?.depth).filter(v => v != null));
  const maxFull = Math.max(...winFull.map(f => teamShape(shapeFromRaw(f), 'home')?.depth).filter(v => v != null));
  const maxKey = Math.max(...winKey.map(f => teamShape(shapeFromRaw(f), 'home')?.depth).filter(v => v != null));
  console.log(`    [900-1200s] home 纵深: 25Hz 均值 ${dF.toFixed(2)} max ${maxFull.toFixed(2)} | 5Hz 均值 ${dK.toFixed(2)} max ${maxKey.toFixed(2)}`);
}

// ---------- max-min vs 分位数 ----------
console.log('\n=== 1c. max-min vs p10-p90 vs p5-p95（每窗口均值） ===');
const stats = windows.map(w => {
  const arr = w.frames.map(f => teamShape(shapeFromRaw(f), 'home')).filter(Boolean);
  return {
    mm: avg(arr.map(s => s.depth)),
    p1090: avg(arr.map(s => s.depthP)),
    p595: avg(arr.map(s => s.depthP5)),
  };
});
console.log(`max-min    : ${avg(stats.map(s => s.mm)).toFixed(1)} (窗口 ${rng(stats.map(s => s.mm))})`);
console.log(`p10-p90    : ${avg(stats.map(s => s.p1090)).toFixed(1)} (窗口 ${rng(stats.map(s => s.p1090))})`);
console.log(`p5-p95     : ${avg(stats.map(s => s.p595)).toFixed(1)} (窗口 ${rng(stats.map(s => s.p595))})`);

// ---------- 每窗口至少 1 帧的极端点：极值对单帧噪声的敏感性 ----------
console.log('\n=== 1d. 极值敏感性：单帧最坏情况 vs 窗口均值 ===');
const worst = windows.map(w => Math.max(...w.frames.map(f => teamShape(shapeFromRaw(f), 'home')?.depth).filter(v => v != null)));
console.log(`各窗口 max-min 的**单帧最大**值: ${rng(worst)}  (窗口均值的范围是 ${rng(stats.map(s => s.mm))})`);
console.log(`→ 单帧最大值比窗口均值上界高出 ${(avg(worst) - avg(stats.map(s => s.mm))).toFixed(1)}m`);

// ---------- 10 人 vs 11 人 ----------
console.log('\n=== 1e. 剔除门将（10 人）对 max-min 的影响：伪影一帧能撑多大？ ===');
// 构造实验：把 10 个非门将中随机 1 人挪到极端位置，看 max-min 的变化
function injectNoise(frames, frac) {
  let out = 0, n = 0;
  for (const f of frames) {
    const base = teamShape(shapeFromRaw(f), 'home');
    if (!base) continue;
    // 找一个中间球员，挪到 x=1.45（越过对方门线，模拟追踪异常）
    const ps = f.players.map((p, i) => p ? { id: i, x: p[0], y: p[1] } : null);
    const cands = ps.map((p, i) => ({ p, i })).filter(({ p }) => p && p.id >= 1 && p.id <= 10);
    if (!cands.length) continue;
    const victim = cands[Math.floor(cands.length / 2)];
    victim.p.x = 1.4; victim.p.y = 0.5;
    const noisy = teamShape({ players: ps, ball: f.ball }, 'home');
    if (noisy) { out += noisy.depth - base.depth; n++; }
  }
  return n ? out / n : NaN;
}
console.log(`单帧 1 个球员放到 x=1.4 时，窗口平均纵深增加: ${injectNoise(windows[0].frames).toFixed(1)}m（仅 1/300 帧受影响）`);
console.log(`如果这类伪影出现率 5%（已知重复坐标率 4.86%），纵深会被撑大约 ${(injectNoise(windows[0].frames) * 0.05 * (windows[0].frames.length / 300)).toFixed(1)}m`);

// ---------- 引擎侧 ----------
console.log('\n=== 1f. 引擎侧采样（复现 + 采样间隔敏感性） ===');
const bytes = readFileSync('./engine.wasm');
const { instance } = await WebAssembly.instantiate(bytes, {});
const wasm = instance.exports; const enc = new TextEncoder(), dec = new TextDecoder();
function engineRaw(seed) {
  const b = enc.encode(JSON.stringify({ demo_mode: false, off_ball_movement_demo: true, match_duration_seconds: 300 }));
  new Uint8Array(wasm.memory.buffer, 1024, b.length).set(b);
  wasm.simulate(BigInt(seed), 1024, b.length);
  const p = wasm.get_json_ptr(), n = wasm.get_json_length();
  const s = dec.decode(new Uint8Array(wasm.memory.buffer, p, n)); wasm.free_json();
  return s;
}
const raw = engineRaw(42);
console.log(`引擎事件流长度: ${raw.length} bytes`);
// 用 Game 采样
const { createGame } = await import('./game.js');
function sampleGame(jsonStr, step) {
  const g = createGame(jsonStr); const out = [];
  for (let t = 0; t <= g.matchEnd; t += step) { g.seekTo(t); out.push({ t: +t.toFixed(2), players: g.players.map(p => ({ id: p.id, x: p.x, y: p.y })), ball: [g.ball.x, g.ball.y] }); }
  return out;
}
for (const step of [0.2, 0.1]) {
  const fr = sampleGame(raw, step);
  const d = avg(fr.map(f => teamShape(f, 'home')?.depth).filter(v => v != null));
  const w = avg(fr.map(f => teamShape(f, 'home')?.width).filter(v => v != null));
  console.log(`引擎 seed=42 step=${step}s: 帧数 ${fr.length} 纵深 ${d.toFixed(1)} 宽度 ${w.toFixed(1)} matchEnd=${createGame(raw).matchEnd}`);
}
