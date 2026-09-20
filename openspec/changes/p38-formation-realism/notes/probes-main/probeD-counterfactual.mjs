// 方案设计 agent（乙）探针 D：修正的越位统计 + **反事实目标形状**
//
// D1 越位线（修正镜像口径）。
// D2 反事实：把几套候选目标公式挂在**引擎自己的球轨迹**上，算目标集合的纵深，
//    与真实观测纵深对照 —— 在写实现之前先看哪套公式能把数字带到哪。
//    （这是「目标集合形状」的预测，不含运动学；B3 已证 observed ≈ target。）
//
// 坐标约定（**务必统一**）：
//   · home 队：x ∈ [0,1]，攻向 x=1。其「离本方门线距离」= x*105。
//   · away 队：x ∈ [0,1]，攻向 x=0。其「离本方门线距离」= (1-x)*105。
//   · 越位线：home 进攻时，away 的越位线 = away 第 2 深的球员（离 away 本方门线第 2 近）
//     → 换算到「离 home 所攻球门(x=1)」= away 该球员离 away 门线的距离。
//     因为 away 离本方门线距离 d 意味着 x = 1 - d/105，则离 x=1 的距离 = d。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PITCH_LENGTH_M, BENCHMARK_SEEDS, ENGINE_DURATION_SEC, KEEPER_IDS,
  quantileSorted, sampleEngineFrames, cutWindows,
} from '../../../../../viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '../../../../../tools/benchmark-engine.mjs';

const HERE = fileURLToPath(new URL('../../../../..', import.meta.url));

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const q = quantileSorted;
const depth = (xs) => { const s = [...xs].sort((a, b) => a - b); return q(s, 0.9) - q(s, 0.1); };
const blk = (p, a, b) => mean(p.slice(a, b));

const load = await loadEngineWasm(WASM_PATH);
if (!load.ok) { console.error(load.message); process.exit(1); }
const { createGame } = await import('../../../../../viewer/game.js');
const engineFrames = [];
for (const seed of BENCHMARK_SEEDS.slice(0, 3)) {
  const game = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  for (const w of cutWindows(sampleEngineFrames(game))) engineFrames.push(...w);
}
const realFrames = [];
for (const fn of ['1', '2']) {
  const g = JSON.parse(readFileSync(`${HERE}/viewer/data/real-game-${fn}.json`, 'utf8'));
  const frames = g.frames.map((fr) => ({ t: fr.t, ball: fr.ball || null, players: fr.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)) }));
  for (const w of cutWindows(frames)) realFrames.push(...w);
}

// ── 统一取数：每帧每队 → { xs: 离本方门线距离升序, ys, ballU, possHome } ──
function unpack(frames) {
  const out = [];
  for (const f of frames) {
    if (!f.ball || !Number.isFinite(f.ball[0])) continue;
    const rows = [];
    for (const team of ['home', 'away']) {
      const isHome = team === 'home';
      const ps = [];
      for (let id = 0; id < 22; id += 1) {
        if (KEEPER_IDS.includes(id)) continue;
        if ((id <= 10) !== isHome) continue;
        const p = f.players[id];
        if (!p) continue;
        const x = Array.isArray(p) ? p[0] : p.x;
        const y = Array.isArray(p) ? p[1] : p.y;
        if (!Number.isFinite(x)) continue;
        ps.push({ id, u: (isHome ? x : 1 - x) * PITCH_LENGTH_M, y: y * 68, absX: x * PITCH_LENGTH_M });
      }
      if (ps.length < 7) continue;
      ps.sort((a, b) => a.u - b.u);
      rows.push({ team, xs: ps.map((p) => p.u), ys: ps.map((p) => p.y), ballU: (isHome ? f.ball[0] : 1 - f.ball[0]) * PITCH_LENGTH_M, absBall: f.ball[0] });
    }
    if (rows.length === 2) out.push({ t: f.t, rows, ball: f.ball });
  }
  return out;
}
const E = unpack(engineFrames);
const R = unpack(realFrames);

// ── D1 越位线（修正）────────────────────────────────────────────────
console.log('=== D1 越位线（修正镜像）===');
function offside(D, label) {
  const margins = []; let over = 0;
  for (const { rows } of D) {
    const home = rows.find((r) => r.team === 'home');
    const away = rows.find((r) => r.team === 'away');
    // home 进攻：home 最前 = xs[9]（离 home 门线最远）。换算成「离 home 所攻球门(x=1)」= 105 - xs[9]
    const homeFront = 105 - home.xs[9];
    // away 越位线：away 第 2 深 = xs[1]（离 away 门线）。离 x=1 的距离 = xs[1]
    const awayLine = away.xs[1];
    margins.push(homeFront - awayLine);
    if (homeFront - awayLine > 0) over += 1;
    // away 进攻对称
    const awayFront = 105 - away.xs[9];
    const homeLine = home.xs[1];
    margins.push(awayFront - homeLine);
    if (awayFront - homeLine > 0) over += 1;
  }
  const s = [...margins].sort((a, b) => a - b);
  console.log(`  ${label}: 越线量 p5=${q(s, 0.05).toFixed(1)} 中位=${q(s, 0.5).toFixed(1)} p95=${q(s, 0.95).toFixed(1)}  >0(越位) 占比 ${(over / margins.length * 100).toFixed(1)}%`);
  console.log(`    余量分布：p25=${q(s, 0.25).toFixed(1)} p75=${q(s, 0.75).toFixed(1)}  （0 = 贴线）`);
}
offside(R, '真实 Metrica');
offside(E, '引擎');

// ── D2 反事实目标形状 ────────────────────────────────────────────────
// 引擎沿用的静态模板（离本方门线的比例 × 105）
const TPL = { def: [0.14, 0.18, 0.20, 0.18], mid: [0.40, 0.42, 0.42, 0.40], fwd: [0.62, 0.62] };
const TPL_ALL = [...TPL.def, ...TPL.mid, ...TPL.fwd];

// 观测纵深（两侧）
console.log('\n=== D2 反事实：目标集合纵深 vs 观测纵深 ===');
const obsE = []; const obsR = [];
for (const { rows } of E) for (const r of rows) obsE.push(depth(r.xs));
for (const { rows } of R) for (const r of rows) obsR.push(depth(r.xs));
console.log(`  观测：引擎 ${mean(obsE).toFixed(2)}m   真实 ${mean(obsR).toFixed(2)}m`);

// 各候选公式：输入 = 球离本方门线距离 b（米）、己方是否控球、transition
function propose(name, fn) {
  const ds = []; const spans = []; const els = [];
  const byBall = new Map();
  for (const { rows } of E) {
    for (const r of rows) {
      const b = r.ballU;
      const myAttack = r.team === 'home' ? (r.ballAbs * 105 < 52.5) : (r.ballAbs * 105 > 52.5); // 粗糙相位代理
      const xs = fn(b, myAttack).map((v) => v * 105);
      const d = depth(xs);
      ds.push(d); spans.push(Math.max(...xs) - Math.min(...xs));
      const k = Math.min(4, Math.floor(b / 21));
      if (!byBall.has(k)) byBall.set(k, []);
      byBall.get(k).push(d);
    }
  }
  const buckets = [...byBall.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => mean(v));
  const el = Math.max(...buckets) - Math.min(...buckets);
  console.log(`  ${name.padEnd(34)} 纵深 ${mean(ds).toFixed(1)}m  跨度(max-min) ${mean(spans).toFixed(1)}m  弹性 ${el.toFixed(1)}m  n=${ds.length}`);
}
console.log(`  （真实：纵深 ${mean(obsR).toFixed(1)}m，弹性 10.3m；引擎现状：弹性 31.6m）`);

// 现状：模板 + 防线 clamp（复刻 formation_target 主队）
propose('现状（模板 + clamp + 0.12 push）', (b, atk) => {
  const out = TPL_ALL.map((base, i) => {
    const isDef = i < 4;
    const shift = 0; // 球侧平移只动 y 侧，x 方向 (ball.0-0.5)*0.06 保留
    const bx = b / 105;
    const sh = (bx - 0.5) * 0.06;
    const press = atk ? 0.02 : -0.02;
    if (!isDef) return Math.min(0.9, Math.max(0.04, base + sh + press));
    const push = Math.abs(bx) * 0.12;
    return Math.min(0.9, Math.max(0.04, Math.min(Math.max(base + sh + press + push, base), bx)));
  });
  return out;
});
// 候选 A：块模型 —— 块中心随球平移(g) + 固定块内相对位置
for (const g of [0.55, 0.6, 0.7]) {
  propose(`A 块模型（块中心 g=${g}，块深固定）`, (b, atk) => {
    const bx = b / 105;
    const center = 0.10 + g * bx; // 块中心（归一化）
    const rel = TPL_ALL.map((v) => v - 0.38); // 相对模板中心的偏移，归一化后缩放到目标块深
    const K = 0.55; // 压缩系数：块内跨度 × 0.55
    return rel.map((r, i) => Math.min(0.98, Math.max(0.04, center + r * K + (atk ? 0.02 : -0.02))));
  });
}
// 候选 B：模板 + 「不越过对方越位线」约束（需要对手状态，这里用引擎实际对手越位线）
{
  const ds = []; const spans = [];
  const byBall = new Map();
  for (const { rows } of E) {
    const h = rows.find((r) => r.team === 'home'); const a = rows.find((r) => r.team === 'away');
    for (const [me, opp] of [[h, a], [a, h]]) {
      const bx = me.ballU / 105;
      const oppLine = opp.xs[1]; // 对手第 2 深（离对手本方门线）→ 离我攻向球门 = oppLine
      const oppLineAbs = 105 - oppLine; // 换算回我自己的「离本方门线」坐标
      const sh = (bx - 0.5) * 0.06;
      const xs = TPL_ALL.map((base, i) => {
        const isDef = i < 4;
        const press = 0.02;
        let tx = base + sh + press;
        if (isDef) tx = Math.min(Math.max(Math.min(tx + Math.abs(bx) * 0.12, base), bx), 0.98);
        // 越位约束：最前的两人不得越过对手越位线（留 0.5m 余量）
        return Math.min(0.98, Math.max(0.04, tx));
      });
      // 攻方锋线锚定对手越位线
      const cap = Math.min(0.98, Math.max(0.04, (oppLineAbs - 0.5) / 105));
      xs[8] = Math.min(xs[8], cap); xs[9] = Math.min(xs[9], cap);
      // 越位锚定后，锋线若被压到中场之后则一并压低中场（保持线序）
      ds.push(depth(xs.map((v) => v * 105)));
      spans.push(Math.max(...xs) - Math.min(...xs) * 105 / 105 === 0 ? 0 : Math.max(...xs.map((v) => v * 105)) - Math.min(...xs.map((v) => v * 105)));
      const k = Math.min(4, Math.floor(bx * 5 / 1));
      if (!byBall.has(k)) byBall.set(k, []);
      byBall.get(k).push(ds[ds.length - 1]);
    }
  }
  const buckets = [...byBall.entries()].sort((x, y) => x[0] - y[0]).map(([, v]) => mean(v));
  console.log(`  ${'B 越位锚定锋线（用真实对手线）'.padEnd(34)} 纵深 ${mean(ds).toFixed(1)}m  跨度 ${mean(spans).toFixed(1)}m  弹性 ${(Math.max(...buckets) - Math.min(...buckets)).toFixed(1)}m  n=${ds.length}`);
}

// 候选 C：局部规则 —— 每个球员的目标向「本线中点」和「全队重心」收缩
for (const k of [0.35, 0.5, 0.65]) {
  propose(`C 局部收缩（相邻次序间距 ×${k}）`, (b, atk) => {
    const bx = b / 105;
    const sh = (bx - 0.5) * 0.06;
    const press = atk ? 0.02 : -0.02;
    const raw = TPL_ALL.map((base, i) => {
      const isDef = i < 4;
      if (!isDef) return base + sh + press;
      return Math.min(Math.max(Math.min(base + sh + press + Math.abs(bx) * 0.12, base), bx), 0.98);
    });
    // 以 raw 的中位为中心，向中心收缩
    const c = [...raw].sort((x, y) => x - y)[5];
    return raw.map((v) => Math.min(0.98, Math.max(0.04, c + (v - c) * k)));
  });
}
