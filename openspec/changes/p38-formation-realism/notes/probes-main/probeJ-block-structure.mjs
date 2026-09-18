// 方案设计 agent（乙）探针 J：把「块模型 + 越位锚定」的反事实**过结构判据**
//
// 主 session 已证明：能调绿四个数字的改动，会让断层**搬家**。所以任何方案都必须
// 用结构判据验收（相邻次序间距序列、断层位置、平移/拉伸比）。
// 本探针把候选机制挂在**引擎自己的球与对方防线轨迹**上，算：
//   · 四项指标（纵深/紧凑度/重心距/宽度）
//   · 相邻次序间距序列（断层在哪）
//   · 弹性（块中心随球平移 vs 跨度变化）
// 与真实 Metrica 逐项对照 —— 实现前先看结构对不对。

import { readFileSync } from 'node:fs';
import {
  PITCH_LENGTH_M, BENCHMARK_SEEDS, ENGINE_DURATION_SEC, KEEPER_IDS,
  quantileSorted, sampleEngineFrames, cutWindows, teamShape,
} from '/home/happy/.claude/worktrees/wayfinder-realism/viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '/home/happy/.claude/worktrees/wayfinder-realism/tools/benchmark-engine.mjs';

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const q = quantileSorted;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };

const load = await loadEngineWasm(WASM_PATH);
const { createGame } = await import('/home/happy/.claude/worktrees/wayfinder-realism/viewer/game.js');
const engineFrames = [];
for (const seed of BENCHMARK_SEEDS.slice(0, 3)) {
  const game = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  for (const w of cutWindows(sampleEngineFrames(game))) engineFrames.push(...w);
}
const realFrames = [];
for (const fn of ['1', '2']) {
  const g = JSON.parse(readFileSync(`/home/happy/.claude/worktrees/wayfinder-realism/viewer/data/real-game-${fn}.json`, 'utf8'));
  const frames = g.frames.map((fr) => ({ t: fr.t, ball: fr.ball || null, players: fr.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)) }));
  for (const w of cutWindows(frames)) realFrames.push(...w);
}

// 每帧每队：{ u: 离本方门线排序, y, ballU, oppU: 对手离其门线排序 }
function unpack(frames) {
  const out = [];
  for (const f of frames) {
    if (!f.ball || !Number.isFinite(f.ball[0])) continue;
    const T = {};
    for (const team of ['home', 'away']) {
      const isHome = team === 'home';
      const ps = [];
      for (let id = 0; id < 22; id += 1) {
        if (KEEPER_IDS.includes(id)) continue;
        if ((id <= 10) !== isHome) continue;
        const p = f.players[id]; if (!p) continue;
        const x = Array.isArray(p) ? p[0] : p.x; const y = Array.isArray(p) ? p[1] : p.y;
        if (!Number.isFinite(x)) continue;
        ps.push({ u: (isHome ? x : 1 - x) * PITCH_LENGTH_M, y: y * 68 });
      }
      if (ps.length < 7) continue;
      ps.sort((a, b) => a.u - b.u);
      T[team] = { u: ps.map((p) => p.u), y: ps.map((p) => p.y), ballU: (isHome ? f.ball[0] : 1 - f.ball[0]) * PITCH_LENGTH_M };
    }
    if (T.home && T.away) out.push(T);
  }
  return out;
}
const E = unpack(engineFrames);
const R = unpack(realFrames);

// 结构摘要
function structure(name, ds) {
  // ds: 每项 { xs: 10 个 u 值, ballU, oppU }
  const gaps = Array.from({ length: 9 }, () => []);
  const depths = []; const spans = []; const cens = []; const balls = [];
  for (const d of ds) {
    const s = [...d.xs].sort((a, b) => a - b);
    for (let i = 1; i < 10; i += 1) gaps[i - 1].push(s[i] - s[i - 1]);
    depths.push(q(s, 0.9) - q(s, 0.1));
    spans.push(s[9] - s[0]); cens.push(mean(s)); balls.push(d.ballU);
  }
  const gm = gaps.map(mean);
  const broken = gm.indexOf(Math.max(...gm));
  // 平移/拉伸
  const mb = mean(balls), mc = mean(cens);
  let sxy = 0; let sxx = 0;
  for (let i = 0; i < balls.length; i += 1) { sxy += (balls[i] - mb) * (cens[i] - mc); sxx += (balls[i] - mb) ** 2; }
  const g = sxy / sxx;
  // 跨度随球
  let sv = 0; let syy = 0; let sxx2 = 0;
  for (let i = 0; i < balls.length; i += 1) { sxx2 += (balls[i] - mb) ** 2; sv += (balls[i] - mb) * (spans[i] - mean(spans)); }
  const spanSlope = sv / sxx2;
  console.log(`  ${name}`);
  console.log(`    纵深 ${mean(depths).toFixed(1)}m  块跨度(max-min) ${mean(spans).toFixed(1)}m  平移增益 g=${g.toFixed(3)}  跨度随球斜率 ${spanSlope.toFixed(3)}`);
  console.log(`    相邻次序间距 ${gm.map((v) => v.toFixed(1)).join(' / ')}   最大断层在 ${broken + 1}→${broken + 2} (${gm[broken].toFixed(1)}m)`);
}

console.log('=== J 结构对照 ===');
structure('真实 Metrica', R.map((T) => ({ xs: T.home.u, ballU: T.home.ballU })));
structure('引擎现状  ', E.map((T) => ({ xs: T.home.u, ballU: T.home.ballU })));

// ── 候选机制反事实 ────────────────────────────────────────────────
// 关键：用引擎自己的**对手防线**轨迹（E 里 away.u[1]）来锚定 home 的锋线。
console.log('\n=== J 候选机制（挂在引擎自己的球/对手轨迹上）===');
const TPL = [0.14, 0.18, 0.20, 0.18, 0.40, 0.42, 0.42, 0.40, 0.62, 0.62];
const DEF = [0, 1, 2, 3]; const MID = [4, 5, 6, 7]; const FWD = [8, 9];

for (const [label, fn] of [
  ['现状（模板+clamp+g_def=0.12）', (T, own) => {
    const bx = own.ballU / 105; const sh = (bx - 0.5) * 0.06; const press = 0.02;
    return TPL.map((b, i) => {
      if (i >= 4) return Math.min(0.9, Math.max(0.04, b + sh + press));
      return Math.min(0.9, Math.max(0.04, Math.min(Math.max(b + sh + press + Math.abs(bx) * 0.12, b), bx)));
    });
  }],
  ['M1 块平移 g=0.59 + 固定块深', (T, own) => {
    const bx = own.ballU / 105;
    const center = 0.115 + 0.59 * bx;
    return TPL.map((v) => center + (v - 0.38) * 0.55);
  }],
  ['M2 块平移 + 锋线锚定对手越位线', (T, own) => {
    const bx = own.ballU / 105;
    const center = 0.115 + 0.59 * bx;
    const raw = TPL.map((v) => center + (v - 0.38) * 0.55);
    // 对手越位线：对手 u[1]（离对手门线）→ 离我攻向球门 = 对手 u[1]，换算到我门线坐标 = 105 - oppU
    const oppLine = own.oppU[1]; // 离对手本方门线
    const oppLineFromMyGoalLine = 105 - oppLine;
    const cap = Math.max(0.04, (oppLineFromMyGoalLine - 1.0) / 105);
    // 锋线（最前 2）钳到越位线
    raw[8] = Math.min(raw[8], cap); raw[9] = Math.min(raw[9], cap);
    // 保持线序：中场不得超过锋线 − 2m
    raw[7] = Math.min(raw[7], raw[8] - 0.02);
    for (let i = 6; i >= 4; i -= 1) raw[i] = Math.min(raw[i], raw[i + 1]);
    for (let i = 3; i >= 0; i -= 1) raw[i] = Math.min(raw[i], raw[i + 1]);
    return raw.map((v) => Math.min(0.98, Math.max(0.04, v)));
  }],
]) {
  const ds = []; const cens = []; const balls = []; const spans = [];
  for (const T of E) {
    const own = { ballU: T.home.ballU, oppU: T.away.u };
    const xs = fn(T, own).map((v) => v * 105);
    ds.push(xs); cens.push(mean(xs)); balls.push(T.home.ballU); spans.push(Math.max(...xs) - Math.min(...xs));
  }
  const mb = mean(balls); const mc = mean(cens);
  let sxy = 0; let sxx = 0;
  for (let i = 0; i < balls.length; i += 1) { sxy += (balls[i] - mb) * (cens[i] - mc); sxx += (balls[i] - mb) ** 2; }
  structure(label, ds.map((xs, i) => ({ xs: xs.map((v) => v), ballU: balls[i] })));
  console.log(`    平移增益 g=${(sxy / sxx).toFixed(3)}`);
}
