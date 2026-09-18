// Probe 10 (round 2):
// A. 对称注入（正确 span 定义）：min 侧 vs max 侧
// B. 引擎 5400s：中场休息/换边/死时间/窗口计数
import { readFileSync } from 'node:fs';
import { createGame } from './game.js';
const L = 105, W = 68;
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const pctL = (a, p) => { const s = [...a].sort((x, y) => x - y); const i = p * (s.length - 1); const lo = Math.floor(i), hi = Math.ceil(i); return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); };
const isKeeper = id => id === 0 || id === 21;
const games = [1, 2].map(g => JSON.parse(readFileSync(`data/real-game-${g}.json`, 'utf8')));

const SPAN = {
  'max-min   ': xs => Math.max(...xs) - Math.min(...xs),
  'p1090-lin ': xs => pctL(xs, 0.9) - pctL(xs, 0.1),
  'p1090-flr ': xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(0.9 * (s.length - 1))] - s[Math.floor(0.1 * (s.length - 1))]; },
  'trim1     ': xs => { const s = [...xs].sort((a, b) => a - b); return s[s.length - 2] - s[1]; },
};

console.log('=== A. 对称注入（窗口 G1 900-1200，每帧注入，正确 span 定义）===');
{
  const win = games[0].frames.filter(f => f.t >= 900 && f.t < 1200);
  const xsOf = f => { const xs = []; for (let i = 1; i <= 10; i++) if (f.players[i]) xs.push(f.players[i][0] * L); return xs; };
  const inj = (f, which) => {
    let idx = -1, best = which === 'max' ? -Infinity : Infinity;
    for (let i = 1; i <= 10; i++) { const p = f.players[i]; if (!p) continue; const v = p[0] * L; if ((which === 'max' && v > best) || (which === 'min' && v < best)) { best = v; idx = i; } }
    return f.players.map((p, i) => i === idx && p ? [which === 'max' ? 1.4 : -1.4, 0.5] : p);
  };
  for (const which of ['max', 'min']) {
    const parts = [];
    for (const [cn, fn] of Object.entries(SPAN)) {
      let d = 0, n = 0;
      for (const f of win) { const a = xsOf(f), b = xsOf({ players: inj(f, which) }); if (a.length < 7 || b.length < 7) continue; d += fn(b) - fn(a); n++; }
      parts.push(`${cn.trim()}: +${(d / n).toFixed(1)}m`);
    }
    console.log(`  ${which === 'max' ? '最前球员→x=+1.4' : '最后球员→x=-1.4'}: ${parts.join(' | ')}`);
  }
  console.log('  （设计只报了 max 侧的 p10–p90=1.4m；min 侧未测）');
}

// ---------- B. 引擎 5400s ----------
console.log('\n=== B. 引擎 5400s（seed42）中场行为 ===');
const bytes = readFileSync('./engine.wasm');
const { instance } = await WebAssembly.instantiate(bytes, {});
const wasm = instance.exports; const enc = new TextEncoder(), dec = new TextDecoder();
function es(seed, dur) { const b = enc.encode(JSON.stringify({ demo_mode: false, off_ball_movement_demo: true, match_duration_seconds: dur })); new Uint8Array(wasm.memory.buffer, 1024, b.length).set(b); wasm.simulate(BigInt(seed), 1024, b.length); const p = wasm.get_json_ptr(), n = wasm.get_json_length(); const s = dec.decode(new Uint8Array(wasm.memory.buffer, p, n)); wasm.free_json(); return s; }

const long = es(42, 5400);
{
  const evs = JSON.parse(long);
  const wh = evs.filter(e => e.type === 'whistle');
  console.log(`  事件总数 ${evs.length}；whistle 事件: ${wh.map(e => `t=${e.t}(${e.detail || '-'})`).join(' ')}`);
  const ko = evs.filter(e => e.type === 'kickoff' || e.type === 'lineup');
  console.log(`  lineup/kickoff: ${ko.map(e => `t=${e.t}(${e.type})`).join(' ')}`);
  // 事件最大间隔
  let mg = 0, at = 0;
  for (let i = 1; i < evs.length; i++) if (evs[i].t - evs[i - 1].t > mg) { mg = evs[i].t - evs[i - 1].t; at = evs[i - 1].t; }
  console.log(`  最大事件间隔 ${mg.toFixed(2)}s @t=${at}`);
  // 所有事件里 halftime 附近的动静
  const near = evs.filter(e => e.t >= 2690 && e.t <= 2760);
  console.log(`  t∈[2690,2760] 事件: ${near.map(e => `${e.t}:${e.type}`).join(' ')}`);
}
{
  const g = createGame(long);
  const sample = [];
  for (let t = 0; t <= 5400; t += 0.2) { g.seekTo(t); sample.push({ t: +t.toFixed(2), players: g.players.map(p => ({ id: p.id, x: p.x, y: p.y })), ball: [g.ball.x, g.ball.y] }); }
  // 主场门将 x 随时间（换边检查）
  const kx = s => { const seg = sample.filter(f => f.t >= s && f.t < s + 300); const v = seg.map(f => f.players.find(p => p.id === 0)).filter(Boolean).map(p => p.x * L); return avg(v).toFixed(1); };
  console.log(`  主队门将(id0) 平均 x: [0,300]=${kx(0)}m [900,1200]=${kx(900)}m [1800,2100]=${kx(1800)}m [2700,3000]=${kx(2700)}m [3600,3900]=${kx(3600)}m [4500,4800]=${kx(4500)}m （恒~2m = 不换边）`);
  // 主队重心 x
  const cx = s => { const seg = sample.filter(f => f.t >= s && f.t < s + 300); const v = seg.map(f => { const xs = []; for (const p of f.players) if (!isKeeper(p.id) && p.id <= 10) xs.push(p.x * L); return xs.length >= 7 ? avg(xs) : null; }).filter(v => v != null); return avg(v).toFixed(1); };
  console.log(`  主队重心 x: [0,300]=${cx(0)} [2700,3000]=${cx(2700)} [4500,4800]=${cx(4500)} （~52=中性）`);
  // 死时间：相邻 0.2s 全队平均位移
  const move = s => { const seg = sample.filter(f => f.t >= s && f.t < s + 60); let d = 0, n = 0; for (let i = 1; i < seg.length; i++) { for (const p of seg[i].players) { const q = seg[i - 1].players.find(x => x.id === p.id); if (q) { d += Math.hypot((p.x - q.x) * L, (p.y - q.y) * W); n++; } } } return (d / n).toFixed(3); };
  console.log(`  全队平均单帧位移(0.2s): [2650,2710]=${move(2650)} [2690,2750]=${move(2690)} [2730,2790]=${move(2730)} [300,360]=${move(300)} （突变=有暂停/重置）`);
  // 球位置在 2700 附近
  const ballx = s => { const seg = sample.filter(f => f.t >= s && f.t < s + 30); return avg(seg.map(f => f.ball[0] * L)).toFixed(1); };
  console.log(`  球平均 x: [2640,2670]=${ballx(2640)} [2680,2710]=${ballx(2680)} [2720,2750]=${ballx(2720)}`);
  // 窗口计数
  let cnt = 0;
  for (let s = 0; s < 5400; s += 900) { const w = sample.filter(f => f.t >= s && f.t < s + 300); if (w.length > 100) cnt++; }
  console.log(`  5400s 按 s=0,900,... 步长 900 切的窗口数: ${cnt}（D5b 声称 6 窗/种子 × 5 种子 = 30）`);
  // 窗口 [0,300] 与独立 300s 跑的对照（floor 口径）
  const flr = fr => { let d = 0, n = 0; for (const f of fr) { const xs = []; for (const p of f.players) if (!isKeeper(p.id) && p.id <= 10) xs.push(p.x * L); if (xs.length < 7) continue; xs.sort((a, b) => a - b); d += xs[Math.floor(0.9 * (xs.length - 1))] - xs[Math.floor(0.1 * (xs.length - 1))]; n++; } return d / n; };
  const win0 = sample.filter(f => f.t < 300);
  const solo = [];
  { const g2 = createGame(es(42, 300)); for (let t = 0; t <= 300; t += 0.2) { g2.seekTo(t); solo.push({ players: g2.players.map(p => ({ id: p.id, x: p.x, y: p.y })) }); } }
  console.log(`  窗口[0,300] floor 纵深: 5400s 跑 ${flr(win0).toFixed(2)} vs 300s 独立跑 ${flr(solo).toFixed(2)}`);
  // 各窗口 floor 纵深一览（6 窗）
  const wins = [];
  for (let s = 0; s < 5400; s += 900) wins.push(flr(sample.filter(f => f.t >= s && f.t < s + 300)).toFixed(1));
  console.log(`  6 窗口 floor 纵深: [${wins.join(', ')}]`);
}

// ---------- C. 真实数据：中场是否在 t 里（对照） ----------
console.log('\n=== C. 真实数据 halftime 结构 ===');
{
  const d = games[0];
  const move = s => { const seg = d.frames.filter(f => f.t >= s && f.t < s + 60); let dd = 0, n = 0; for (let i = 1; i < seg.length; i++) for (let k = 1; k <= 10; k++) { const a = seg[i - 1].players[k], b = seg[i].players[k]; if (a && b) { dd += Math.hypot((a[0] - b[0]) * L, (a[1] - b[1]) * W); n++; } } return (dd / n).toFixed(3); };
  console.log(`  game1 全队平均单帧位移: [2650,2710]=${move(2650)} [2690,2750]=${move(2690)} [2730,2790]=${move(2730)} [2730+3600? 无] [5400,5460]=${move(5400)}`);
  const bx = s => { const seg = d.frames.filter(f => f.t >= s && f.t < s + 30); return avg(seg.filter(f => f.ball).map(f => f.ball[0] * L)).toFixed(1); };
  console.log(`  game1 球平均 x: [2640,2670]=${bx(2640)} [2680,2710]=${bx(2680)} [2720,2750]=${bx(2720)}`);
}
