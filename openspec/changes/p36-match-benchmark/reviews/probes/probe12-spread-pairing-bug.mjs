// 实现期复核 2/3：紧凑度（spread）的 x/y 配对错位量化——探针实现（排序 x × 未排序 y）vs 正确配对。
// 发现：generate-baseline-numbers.mjs 的 spread 配对错位，偏差 0.06–0.15m，分离结论不变。
// 跑法：拷到 viewer/ 下 node 运行。
// 对照 generate-baseline-numbers.mjs 的实现（xs 已排序、ys 未排序，逐下标配对）
// 与正确实现（同一球员的 dx/dy 配对）
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
const mk = d => d.frames.map(f => ({ t: f.t, players: f.players.map((p, i) => p ? { id: i, x: p[0], y: p[1] } : null), ball: f.ball }));

function spreadBoth(frame, team) {
  const ps = frame.players.filter(p => p && !isKeeper(p.id) && (team === 'home' ? p.id <= 10 : p.id >= 11));
  if (ps.length < 7) return null;
  const xs = ps.map(p => p.x * L);
  const ys = ps.map(p => p.y * W);
  const cx = avg(xs), cy = avg(ys);
  const sortedXs = [...xs].sort((a, b) => a - b);
  const scrambled = avg(sortedXs.map((x, i) => Math.hypot(x - cx, ys[i] - cy)));   // 探针实现
  const matched = avg(ps.map((p, i) => Math.hypot(xs[i] - cx, ys[i] - cy)));       // 正确实现
  return { scrambled, matched };
}

const realW = [];
for (const g of [1, 2]) for (const w of cut(mk(games[g - 1]))) realW.push(w);

const engW = [];
{
  const bytes = readFileSync('./engine.wasm');
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const wasm = instance.exports; const enc = new TextEncoder(), dec = new TextDecoder();
  for (const seed of [42, 1, 7, 99, 123]) {
    const b = enc.encode(JSON.stringify({ demo_mode: false, off_ball_movement_demo: true, match_duration_seconds: 5400 }));
    new Uint8Array(wasm.memory.buffer, 1024, b.length).set(b); wasm.simulate(BigInt(seed), 1024, b.length);
    const p = wasm.get_json_ptr(), n = wasm.get_json_length(); const s = dec.decode(new Uint8Array(wasm.memory.buffer, p, n)); wasm.free_json();
    const g = createGame(s); const fr = [];
    for (let t = 0; t <= g.matchEnd; t += 0.2) { g.seekTo(t); fr.push({ t, players: g.players.map(x => ({ id: x.id, x: x.x, y: x.y })), ball: [g.ball.x, g.ball.y] }); }
    for (const w of cut(fr)) engW.push(w);
  }
}

for (const [name, windows] of [['真实', realW], ['引擎', engW]]) {
  const sc = windows.map(w => { const v = w.map(f => spreadBoth(f, 'home')).filter(Boolean); return v.length ? avg(v.map(x => x.scrambled)) : null; }).filter(v => v != null);
  const ma = windows.map(w => { const v = w.map(f => spreadBoth(f, 'home')).filter(Boolean); return v.length ? avg(v.map(x => x.matched)) : null; }).filter(v => v != null);
  console.log(`${name}: 探针(错位) ${avg(sc).toFixed(3)} (${rng(sc)})  正确(配对) ${avg(ma).toFixed(3)} (${rng(ma)})`);
}
console.log('基线数字（baseline-numbers.json）: 真实 spread avg 15.2983 (10.7951–17.3686) / 引擎 19.8337 (17.7068–23.0496)');
