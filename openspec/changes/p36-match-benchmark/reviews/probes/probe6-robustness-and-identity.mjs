// Probe 6: 极值稳健性对照、追踪瞬移、Metrica 比赛身份、引擎种子稳定性、含门将对照
import { readFileSync, readdirSync } from 'node:fs';
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

// ---------- 1. Metrica 原始数据身份 ----------
console.log('=== 1. Metrica 原始数据身份检查 ===');
try {
  const dir = '/home/shared/deep-research-playground/projects/football-manager-clone/.scratch/tracking-data/sample-data';
  const files = readdirSync(dir);
  console.log('  文件:', files.filter(f => f.includes('Sample') && f.endsWith('.csv')).join('\n         '));
  // 读 meta xml / readme
  for (const f of files) {
    if (/readme|meta|\.xml|\.txt/i.test(f)) {
      const c = readFileSync(`${dir}/${f}`, 'utf8');
      console.log(`  --- ${f} (前 1200 字) ---`);
      console.log('  ' + c.slice(0, 1200).replace(/\n/g, '\n  '));
    }
  }
} catch (e) { console.log('  读取失败:', e.message); }

// ---------- 2. 追踪瞬移（单帧大跳）频率与影响 ----------
console.log('\n=== 2. 真实数据单帧瞬移（>5m/0.2s）频率 ===');
for (const [gi, d] of games.entries()) {
  let jumps = 0, big = 0, total = 0;
  const jumpTs = [];
  let prev = null;
  for (const f of d.frames) {
    if (prev) {
      for (let i = 1; i <= 10; i++) {
        const a = prev.players[i], b = f.players[i];
        if (a && b) {
          const dd = Math.hypot((a[0] - b[0]) * L, (a[1] - b[1]) * W);
          if (dd > 5) { jumps++; if (dd > 20) big++; if (jumpTs.length < 8) jumpTs.push(`id${i}@${f.t.toFixed(0)}s ${dd.toFixed(0)}m`); }
          total++;
        }
      }
    }
    prev = f;
  }
  console.log(`  比赛${gi + 1}: >5m 跳 ${jumps}/${total} (${(100 * jumps / total).toFixed(3)}%)，其中 >20m 跳 ${big}`);
  console.log(`    样例: ${jumpTs.join(' | ')}`);
}
// 纵深最大的 5 帧是否伴随瞬移
console.log('  纵深最大 5 帧所在时刻的瞬移检查（game1）:');
{
  const d = games[0];
  const depth = f => { const ps = []; for (let i = 1; i <= 10; i++) if (f.players[i]) ps.push(f.players[i][0] * L); return Math.max(...ps) - Math.min(...ps); };
  const idx = d.frames.map((f, k) => ({ k, dep: depth(f) })).sort((a, b) => b.dep - a.dep).slice(0, 5);
  for (const { k, dep } of idx) {
    const f = d.frames[k], p = d.frames[k - 1];
    let maxJump = 0, who = -1;
    if (p) for (let i = 1; i <= 10; i++) { const a = p.players[i], b = f.players[i]; if (a && b) { const dd = Math.hypot((a[0] - b[0]) * L, (a[1] - b[1]) * W); if (dd > maxJump) { maxJump = dd; who = i; } } }
    console.log(`    t=${f.t.toFixed(1)}s 纵深 ${dep.toFixed(1)}m，帧内最大跳变 id${who} ${maxJump.toFixed(1)}m`);
  }
}

// ---------- 3. 单帧离群注入：max-min vs 稳健全距 ----------
console.log('\n=== 3. 单帧 1 名球员瞬移(→x=1.4) 对窗口均值的影响 ===');
function metricsOf(f) {
  const xs = []; for (let i = 1; i <= 10; i++) if (f.players[i]) xs.push(f.players[i][0] * L);
  if (xs.length < 7) return null;
  const s = [...xs].sort((a, b) => a - b);
  return {
    mm: Math.max(...xs) - Math.min(...xs),
    p1090: pct(xs, 0.9) - pct(xs, 0.1),
    gap: avg(s.slice(-3)) - avg(s.slice(0, 3)),
  };
}
for (const [gi, d] of games.entries()) {
  const base = { mm: [], p1090: [], gap: [] }, inj = { mm: [], p1090: [], gap: [] };
  for (const f of d.frames) {
    const m0 = metricsOf(f); if (!m0) continue;
    base.mm.push(m0.mm); base.p1090.push(m0.p1090); base.gap.push(m0.gap);
    // 注入：把球员 5 挪到 x=1.4（单帧）
    const players = f.players.map((p, i) => i === 5 && p ? [1.4, 0.5] : p);
    const m1 = metricsOf({ players }); if (!m1) continue;
    inj.mm.push(m1.mm); inj.p1090.push(m1.p1090); inj.gap.push(m1.gap);
  }
  console.log(`  比赛${gi + 1}（每帧都注入，即 100% 帧含 1 个离群点）:`);
  console.log(`    max-min  : ${avg(base.mm).toFixed(1)} → ${avg(inj.mm).toFixed(1)} (+${(avg(inj.mm) - avg(base.mm)).toFixed(1)}m)`);
  console.log(`    p10-p90  : ${avg(base.p1090).toFixed(1)} → ${avg(inj.p1090).toFixed(1)} (+${(avg(inj.p1090) - avg(base.p1090)).toFixed(1)}m)`);
  console.log(`    后3-前3   : ${avg(base.gap).toFixed(1)} → ${avg(inj.gap).toFixed(1)} (+${(avg(inj.gap) - avg(base.gap)).toFixed(1)}m)`);
}
// 真实数据中 1% 帧含离群时的影响（更现实）
console.log('  （现实情形：1% 帧含 1 个离群点）');
for (const [gi, d] of games.entries()) {
  const n = d.frames.length;
  const sample = d.frames.filter((_, k) => k % 100 === 0); // 1%
  const base = [], injM = [], injP = [], injG = [];
  for (const f of sample) {
    const m0 = metricsOf(f); if (!m0) continue;
    const players = f.players.map((p, i) => i === 5 && p ? [1.4, 0.5] : p);
    const m1 = metricsOf({ players }); if (!m1) continue;
    base.push(m0); injM.push(m1.mm); injP.push(m1.p1090); injG.push(m1.gap);
  }
  const dMM = avg(injM) - avg(base.map(b => b.mm));
  const dP = avg(injP) - avg(base.map(b => b.p1090));
  const dG = avg(injG) - avg(base.map(b => b.gap));
  console.log(`    比赛${gi + 1}: max-min 窗口均值变化 ≈ ${(dMM * 0.01).toFixed(2)}m | p10-p90 ≈ ${(dP * 0.01).toFixed(3)}m | gap ≈ ${(dG * 0.01).toFixed(3)}m`);
}

// ---------- 4. 引擎 5 种子：逐种子均值 & 均值-of-5 ----------
console.log('\n=== 4. 引擎逐种子指标（复算） ===');
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
function teamMetrics(f, team, withKeeper = false) {
  const ps = f.players.filter(p => p && (withKeeper || !isKeeper(p.id)) && (team === 'home' ? p.id <= 10 : p.id >= 11));
  if (ps.length < 7) return null;
  const xs = ps.map(p => p.x * L), ys = ps.map(p => p.y * W);
  const cx = avg(xs), cy = avg(ys);
  return { depth: Math.max(...xs) - Math.min(...xs), width: Math.max(...ys) - Math.min(...ys), spread: avg(xs.map((x, i) => Math.hypot(x - cx, ys[i] - cy))), cx, cy };
}
const perSeed = [];
for (const seed of SEEDS) {
  const g = createGame(engineStream(seed)); const fr = [];
  for (let t = 0; t <= g.matchEnd; t += 0.2) { g.seekTo(t); fr.push({ players: g.players.map(p => ({ id: p.id, x: p.x, y: p.y })), ball: [g.ball.x, g.ball.y] }); }
  const h = fr.map(f => teamMetrics(f, 'home')).filter(Boolean);
  const a = fr.map(f => teamMetrics(f, 'away')).filter(Boolean);
  const cdist = fr.map(f => { const H = teamMetrics(f, 'home'), A = teamMetrics(f, 'away'); return H && A ? Math.hypot(H.cx - A.cx, H.cy - A.cy) : null; }).filter(v => v != null);
  const withK = fr.map(f => teamMetrics(f, 'home', true)).filter(Boolean);
  perSeed.push({ seed, depth: avg(h.map(m => m.depth)), width: avg(h.map(m => m.width)), spread: avg(h.map(m => m.spread)), cdist: avg(cdist), depthWk: avg(withK.map(m => m.depth)) });
}
for (const p of perSeed) console.log(`  seed ${String(p.seed).padStart(3)}: 纵深 ${p.depth.toFixed(1)} 宽度 ${p.width.toFixed(1)} 紧凑 ${p.spread.toFixed(1)} 重心距 ${p.cdist.toFixed(1)} [含门将纵深 ${p.depthWk.toFixed(1)}]`);
const mean5 = k => avg(perSeed.map(p => p[k]));
console.log(`  均值(5): 纵深 ${mean5('depth').toFixed(1)} 宽度 ${mean5('width').toFixed(1)} 紧凑 ${mean5('spread').toFixed(1)} 重心距 ${mean5('cdist').toFixed(1)} 含门将纵深 ${mean5('depthWk').toFixed(1)}`);
console.log(`  种子间范围: 纵深 ${Math.min(...perSeed.map(p => p.depth)).toFixed(1)}–${Math.max(...perSeed.map(p => p.depth)).toFixed(1)} 紧凑 ${Math.min(...perSeed.map(p => p.spread)).toFixed(1)}–${Math.max(...perSeed.map(p => p.spread)).toFixed(1)}`);

// ---------- 5. 真实含门将对照 + 全部指标复算（对照设计表） ----------
console.log('\n=== 5. 真实侧全指标（含门将对照） ===');
const realAgg = { depth: [], width: [], spread: [], cdist: [], depthWk: [] };
for (const w of windows) {
  const fr = w.frames.map(f => ({ players: f.players.map((p, i) => p ? { id: i, x: p[0], y: p[1] } : null), ball: f.ball }));
  const h = fr.map(f => teamMetrics(f, 'home')).filter(Boolean);
  const a = fr.map(f => teamMetrics(f, 'away')).filter(Boolean);
  const cdist = fr.map(f => { const H = teamMetrics(f, 'home'), A = teamMetrics(f, 'away'); return H && A ? Math.hypot(H.cx - A.cx, H.cy - A.cy) : null; }).filter(v => v != null);
  const withK = fr.map(f => teamMetrics(f, 'home', true)).filter(Boolean);
  realAgg.depth.push(avg(h.map(m => m.depth)));
  realAgg.width.push(avg(h.map(m => m.width)));
  realAgg.spread.push(avg(h.map(m => m.spread)));
  realAgg.cdist.push(avg(cdist));
  realAgg.depthWk.push(avg(withK.map(m => m.depth)));
}
const rr = k => `${avg(realAgg[k]).toFixed(1)} (${Math.min(...realAgg[k]).toFixed(1)}–${Math.max(...realAgg[k]).toFixed(1)})`;
console.log(`  纵深 ${rr('depth')} [设计 32.2 (22.2–36.2)] 含门将 ${rr('depthWk')} [设计 33→64 之说]`);
console.log(`  宽度 ${rr('width')} [设计 39.2 (28.2–46.8)]`);
console.log(`  紧凑 ${rr('spread')} [设计 15.1 (10.7–17.2)]`);
console.log(`  重心距 ${rr('cdist')} [设计 8.3 (6.8–10.5)]`);

// ---------- 6. 采样密度敏感性（引擎 0.2s vs 1s） ----------
console.log('\n=== 6. 引擎采样密度敏感性 ===');
{
  const g = createGame(engineStream(42));
  for (const step of [0.2, 1.0]) {
    const fr = [];
    for (let t = 0; t <= g.matchEnd; t += step) { g.seekTo(t); fr.push({ players: g.players.map(p => ({ id: p.id, x: p.x, y: p.y })), ball: [g.ball.x, g.ball.y] }); }
    const h = fr.map(f => teamMetrics(f, 'home')).filter(Boolean);
    console.log(`  step=${step}s: 纵深 ${avg(h.map(m => m.depth)).toFixed(2)} 紧凑 ${avg(h.map(m => m.spread)).toFixed(2)}`);
  }
  // 真实：5Hz 是数据原生，抽稀到 1Hz 对照
  const w = windows[2];
  const fr = w.frames.map(f => ({ players: f.players.map((p, i) => p ? { id: i, x: p[0], y: p[1] } : null), ball: f.ball }));
  for (const step of [0.2, 1.0]) {
    const samp = fr.filter((_, k) => k % Math.round(step / 0.2) === 0);
    const h = samp.map(f => teamMetrics(f, 'home')).filter(Boolean);
    console.log(`  真实 W2 step=${step}s: 纵深 ${avg(h.map(m => m.depth)).toFixed(2)} 紧凑 ${avg(h.map(m => m.spread)).toFixed(2)}`);
  }
}
