// 实现期复核 1/3：重心到球距离的候选口径试算（对齐设计期 18.7 / 20.3 的溯源）。
// 跑法：拷到 viewer/ 下 node 运行（相对路径 ./game.js ./data ./engine.wasm）。
// 在 worktree 的 viewer/ 下运行（相对路径 game.js / data / engine.wasm）
import { readFileSync } from 'node:fs';
import { createGame } from './game.js';
const L = 105, W = 68;
const isKeeper = id => id === 0 || id === 21;
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const rng = a => `${Math.min(...a).toFixed(1)}–${Math.max(...a).toFixed(1)}`;

const games = [1, 2].map(g => JSON.parse(readFileSync(`./data/real-game-${g}.json`, 'utf8')));
const cut = (frames, size = 300, step = 900) => {
  const o = []; const T = frames[frames.length - 1].t;
  for (let s = 0; s + size <= T + 1; s += step) o.push(frames.filter(f => f.t >= s && f.t < s + size));
  return o.filter(w => w.length > 100);
};
const mk = d => d.frames.map(f => ({ t: f.t, players: f.players.map((p, i) => p ? { id: i, x: p[0], y: p[1] } : null), ball: f.ball, fill: f.ballFill !== undefined && f.ballFill !== null }));

function teamCentroid(frame, team) {
  const ps = frame.players.filter(p => p && !isKeeper(p.id) && (team === 'home' ? p.id <= 10 : p.id >= 11));
  if (ps.length < 7) return null;
  return { cx: avg(ps.map(p => p.x * L)), cy: avg(ps.map(p => p.y * W)) };
}

// 候选：(a) 主队重心到球；(b) 两队平均
function ballDist(frames, variant, rawOnly) {
  const vals = [];
  for (const f of frames) {
    if (!f.ball) continue;
    if (rawOnly && f.fill) continue;
    const H = teamCentroid(f, 'home'), A = teamCentroid(f, 'away');
    const [bx, by] = [f.ball[0] * L, f.ball[1] * W];
    if (variant === 'a') { if (H) vals.push(Math.hypot(H.cx - bx, H.cy - by)); }
    else { const ds = []; if (H) ds.push(Math.hypot(H.cx - bx, H.cy - by)); if (A) ds.push(Math.hypot(A.cx - bx, A.cy - by)); if (ds.length) vals.push(avg(ds)); }
  }
  return vals.length ? avg(vals) : null;
}

const realW = [];
for (const g of [1, 2]) for (const w of cut(mk(games[g - 1]))) realW.push({ g, frames: w });
console.log(`真实窗口数 ${realW.length}`);

for (const variant of ['a', 'both']) {
  for (const rawOnly of [false, true]) {
    const vals = realW.map(w => ballDist(w.frames, variant, rawOnly)).filter(v => v != null);
    console.log(`真实 variant=${variant} rawOnly=${rawOnly}: ${avg(vals).toFixed(1)} (${rng(vals)})`);
  }
}

const bytes = readFileSync('./engine.wasm');
const { instance } = await WebAssembly.instantiate(bytes, {});
const wasm = instance.exports; const enc = new TextEncoder(), dec = new TextDecoder();
const engW = [];
for (const seed of [42, 1, 7, 99, 123]) {
  const b = enc.encode(JSON.stringify({ demo_mode: false, off_ball_movement_demo: true, match_duration_seconds: 5400 }));
  new Uint8Array(wasm.memory.buffer, 1024, b.length).set(b); wasm.simulate(BigInt(seed), 1024, b.length);
  const p = wasm.get_json_ptr(), n = wasm.get_json_length(); const s = dec.decode(new Uint8Array(wasm.memory.buffer, p, n)); wasm.free_json();
  const g = createGame(s); const fr = [];
  for (let t = 0; t <= g.matchEnd; t += 0.2) { g.seekTo(t); fr.push({ t, players: g.players.map(x => ({ id: x.id, x: x.x, y: x.y })), ball: [g.ball.x, g.ball.y], fill: false }); }
  for (const w of cut(fr)) engW.push({ seed, frames: w });
}
for (const variant of ['a', 'both']) {
  const vals = engW.map(w => ballDist(w.frames, variant, false)).filter(v => v != null);
  console.log(`引擎 variant=${variant}: ${avg(vals).toFixed(1)} (${rng(vals)})`);
}

// 宽度对照（应为 39.2 真实）
const widthOf = frames => {
  const vals = [];
  for (const f of frames) {
    const ps = f.players.filter(p => p && !isKeeper(p.id) && p.id <= 10);
    if (ps.length < 7) continue;
    const ys = ps.map(p => p.y * W);
    vals.push(Math.max(...ys) - Math.min(...ys));
  }
  return vals.length ? avg(vals) : null;
};
const wReal = realW.map(w => widthOf(w.frames)).filter(v => v != null);
console.log(`真实宽度(主队, max-min): ${avg(wReal).toFixed(1)} (${rng(wReal)})  [设计 39.2 (28.2–46.8)]`);
const wEng = engW.map(w => widthOf(w.frames)).filter(v => v != null);
console.log(`引擎宽度: ${avg(wEng).toFixed(1)} (${rng(wEng)})  [设计 32.4 (30.4–34.2)]`);
