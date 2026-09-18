// Probe 9 (round 2): 分位口径扫描
// 设计修订声称：纵深 p10–p90 真实 28.0 (19.3–31.9) vs 引擎 45.0 (38.5–51.2)；
// 注入实验 max-min +87.7 vs p10-p90 +1.4（60 倍）。
// 本脚本用 5 种常见约定扫描，找出这些数字出自哪种约定；并复现注入实验。
import { readFileSync } from 'node:fs';
import { createGame } from './game.js';
const L = 105, W = 68;
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const pctL = (a, p) => { const s = [...a].sort((x, y) => x - y); const i = p * (s.length - 1); const lo = Math.floor(i), hi = Math.ceil(i); return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); };
const isKeeper = id => id === 0 || id === 21;

const CONV = {
  'max-min   ': xs => Math.max(...xs) - Math.min(...xs),
  'p1090-lin ': xs => pctL(xs, 0.9) - pctL(xs, 0.1),          // 线性插值（numpy/Excel INC 默认）
  'p1090-flr ': xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(0.9 * (s.length - 1))] - s[Math.floor(0.1 * (s.length - 1))]; }, // 最近秩（floor、无插值）
  'trim1     ': xs => { const s = [...xs].sort((a, b) => a - b); return s[s.length - 2] - s[1]; },  // 掐头去尾各 1
  'gap3      ': xs => { const s = [...xs].sort((a, b) => a - b); return avg(s.slice(-3)) - avg(s.slice(0, 3)); }, // 前3-后3 均值差
};
const CN = Object.keys(CONV);

const games = [1, 2].map(g => JSON.parse(readFileSync(`data/real-game-${g}.json`, 'utf8')));
function xsOf(f, team = 'home') { const xs = []; for (let i = 0; i < 22; i++) { const p = f.players[i]; if (p && !isKeeper(i) && (team === 'home' ? i <= 10 : i >= 11)) xs.push(p[0] * L); } return xs; }

const realWin = [];
for (const [gi, d] of games.entries()) for (let s = 0; s < 5500; s += 900) { const w = d.frames.filter(f => f.t >= s && f.t < s + 300); if (w.length > 100) realWin.push({ g: gi + 1, s, frames: w }); }

console.log('=== A. 真实 14 窗口：各约定纵深均值(范围) — 目标 28.0 (19.3–31.9) ===');
const realByConv = {};
for (const cn of CN) {
  const vals = realWin.map(w => avg(w.frames.map(f => { const xs = xsOf(f); return xs.length >= 7 ? CONV[cn](xs) : null; }).filter(v => v != null)));
  realByConv[cn] = vals;
  console.log(`  ${cn} 真实 ${avg(vals).toFixed(1)} (${Math.min(...vals).toFixed(1)}–${Math.max(...vals).toFixed(1)})`);
}
console.log('  [客队对照 — 设计表里客队行仍是 32.4/49.9 旧数字]');
for (const cn of CN) {
  const vals = realWin.map(w => avg(w.frames.map(f => { const xs = xsOf(f, 'away'); return xs.length >= 7 ? CONV[cn](xs) : null; }).filter(v => v != null)));
  console.log(`  ${cn} away ${avg(vals).toFixed(1)} (${Math.min(...vals).toFixed(1)}–${Math.max(...vals).toFixed(1)})`);
}

// ---------- 引擎 ----------
const bytes = readFileSync('./engine.wasm');
const { instance } = await WebAssembly.instantiate(bytes, {});
const wasm = instance.exports; const enc = new TextEncoder(), dec = new TextDecoder();
function es(seed, dur = 300) { const b = enc.encode(JSON.stringify({ demo_mode: false, off_ball_movement_demo: true, match_duration_seconds: dur })); new Uint8Array(wasm.memory.buffer, 1024, b.length).set(b); wasm.simulate(BigInt(seed), 1024, b.length); const p = wasm.get_json_ptr(), n = wasm.get_json_length(); const s = dec.decode(new Uint8Array(wasm.memory.buffer, p, n)); wasm.free_json(); return s; }
const SEEDS = [42, 1, 7, 99, 123];
function sampleFrames(jsonStr) { const g = createGame(jsonStr); const out = []; for (let t = 0; t <= g.matchEnd; t += 0.2) { g.seekTo(t); out.push({ t: +t.toFixed(2), players: g.players.map(p => ({ id: p.id, x: p.x, y: p.y })) }); } return out; }

console.log('\n=== B. 引擎 300s：各约定 — 目标 45.0 (38.5–51.2) ===');
const eng300 = SEEDS.map(s => sampleFrames(es(s, 300)));
for (const cn of CN) {
  const vals = eng300.map(fr => avg(fr.map(f => { const xs = []; for (const p of f.players) if (!isKeeper(p.id) && p.id <= 10) xs.push(p.x * L); return xs.length >= 7 ? CONV[cn](xs) : null; }).filter(v => v != null)));
  console.log(`  ${cn} 引擎300s ${avg(vals).toFixed(1)} (${Math.min(...vals).toFixed(1)}–${Math.max(...vals).toFixed(1)})`);
}

console.log('\n=== C. 引擎 5400s（D5b 新方案）：各约定 — 30 窗口 ===');
const eng5400 = SEEDS.map(s => sampleFrames(es(s, 5400)));
for (const cn of CN) {
  const allVals = [];
  for (const fr of eng5400) for (let s = 0; s < 5400 - 300; s += 900) {
    const w = fr.filter(f => f.t >= s && f.t < s + 300);
    if (w.length < 100) continue;
    allVals.push(avg(w.map(f => { const xs = []; for (const p of f.players) if (!isKeeper(p.id) && p.id <= 10) xs.push(p.x * L); return xs.length >= 7 ? CONV[cn](xs) : null; }).filter(v => v != null)));
  }
  console.log(`  ${cn} 引擎5400s ${avg(allVals).toFixed(1)} (${Math.min(...allVals).toFixed(1)}–${Math.max(...allVals).toFixed(1)}) n=${allVals.length}`);
}

// ---------- D. 注入实验复现 ----------
console.log('\n=== D. 注入实验：把球员挪到 x=1.4，各约定受影响程度 ===');
const win = realWin.find(w => w.g === 1 && w.s === 900);
function inject(f, who) { // who: 'max' = 当前 x 最大者 | 'mid5' = 固定 id 5
  const xs = xsOf(f);
  let idx = -1;
  if (who === 'max') { let best = -1; for (let i = 1; i <= 10; i++) { const p = f.players[i]; if (p && p[0] * L > best) { best = p[0] * L; idx = i; } } }
  else idx = 5;
  return f.players.map((p, i) => (i === idx && p) ? [1.4, 0.5] : p);
}
for (const who of ['max', 'mid5']) {
  const cells = [];
  for (const cn of CN) {
    let dAll = 0, dOne = 0, nAll = 0, nOne = 0;
    // (a) 每帧都注入
    for (const f of win.frames) {
      const xs0 = xsOf(f); if (xs0.length < 7) continue;
      const xs1 = xsOf({ players: inject(f, who) }); if (xs1.length < 7) continue;
      dAll += CONV[cn](xs1) - CONV[cn](xs0); nAll++;
    }
    // (b) 只注入 1 帧（窗口内第 150 帧），看窗口均值变化
    for (let k = 0; k < win.frames.length; k++) {
      const f = win.frames[k]; const xs0 = xsOf(f); if (xs0.length < 7) continue;
      const xs1 = (k === 150) ? xsOf({ players: inject(f, who) }) : xs0;
      if (xs1.length < 7) continue;
      dOne += CONV[cn](xs1) - CONV[cn](xs0); nOne++;
    }
    cells.push(`${cn.trim()}: 每帧+${(dAll / nAll).toFixed(1)}m / 1帧(窗均)+${(dOne / nOne).toFixed(2)}m`);
  }
  console.log(`  注入目标=${who}:`);
  for (const c of cells) console.log(`    ${c}`);
}
console.log('  设计声称: max-min 抬高 87.7m, p10-p90 只抬 1.4m');

// ---------- E. 交叉验证：各约定下 game1 区间 vs game2 ----------
console.log('\n=== E. 交叉验证（game1 7 窗口 p5–p95 → game2 7 窗口落入数；设计称 2/6）===');
for (const cn of CN) {
  const v1 = realByConv[cn].filter((_, i) => realWin[i].g === 1);
  const v2 = realByConv[cn].filter((_, i) => realWin[i].g === 2);
  const lo = pctL(v1, 0.05), hi = pctL(v1, 0.95);
  const inC = v2.filter(v => v >= lo && v <= hi).length;
  console.log(`  ${cn} game1 [${lo.toFixed(1)}, ${hi.toFixed(1)}] 容纳 game2 ${inC}/${v2.length} | game2 [${pctL(v2, 0.05).toFixed(1)}, ${pctL(v2, 0.95).toFixed(1)}] 容纳 game1 ${v1.filter(v => v >= pctL(v2, 0.05) && v <= pctL(v2, 0.95)).length}/${v1.length}`);
}

// ---------- F. bootstrap（p1090-lin 口径）----------
console.log('\n=== F. bootstrap p5/p95 的 90% CI（p1090-lin 口径，14 窗口）===');
{
  const vals = realByConv['p1090-lin '];
  const bs = [];
  for (let b = 0; b < 2000; b++) {
    const res = []; for (let i = 0; i < vals.length; i++) res.push(vals[Math.floor(Math.random() * vals.length)]);
    bs.push({ p5: pctL(res, 0.05), p95: pctL(res, 0.95) });
  }
  const p5s = bs.map(x => x.p5).sort((a, b) => a - b), p95s = bs.map(x => x.p95).sort((a, b) => a - b);
  console.log(`  区间自身宽 ${(pctL(vals, 0.95) - pctL(vals, 0.05)).toFixed(1)}m；p5 的 CI [${pctL(p5s, 0.05).toFixed(1)}, ${pctL(p5s, 0.95).toFixed(1)}]，p95 的 CI [${pctL(p95s, 0.05).toFixed(1)}, ${pctL(p95s, 0.95).toFixed(1)}]`);
}
