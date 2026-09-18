// 方案设计 agent（乙）探针 B1：队形差的**来源分解**
//
// 问题：引擎纵深 41.2m vs 真实 26.4m。这 15m 从哪来？
//   候选来源
//   (a) mover 事件**目标**本身就更散（formation_target 的形状问题）
//   (b) 球员**没跟上目标**（速度/节拍/死区造成的滞后）——目标其实是对的
//
// 做法：直接解析事件流里的 `beat.movers`（每个 mover 有 from/to），
//   把「每拍每球员的 to」收集成「目标位置云」，把 from 收集成「实际位置云」，
//   分别算纵深，与真实帧对照。两侧口径一致（都是非门将 10 人 q10－q90）。
//
// 若目标纵深 ≈ 实际纵深 ≈ 41m  → (a)，是形状问题
// 若目标纵深 ≈ 26m 而实际 ≈ 41m  → (b)，是跟随问题
// 若两者都不对 → 需要看别的

import { readFileSync } from 'node:fs';
import {
  PITCH_LENGTH_M, BENCHMARK_SEEDS, ENGINE_DURATION_SEC, KEEPER_IDS,
  quantileSorted,
} from '/home/happy/.claude/worktrees/wayfinder-realism/viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '/home/happy/.claude/worktrees/wayfinder-realism/tools/benchmark-engine.mjs';

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const span = (xs) => {
  if (xs.length < 3) return null;
  const s = [...xs].sort((a, b) => a - b);
  return quantileSorted(s, 0.9) - quantileSorted(s, 0.1);
};

function outfieldXsMeters(players, team) {
  // players: [{id,x,y}] 或 [[x,y]|null]（下标=id）
  const out = [];
  for (let id = 0; id < 22; id += 1) {
    if (KEEPER_IDS.includes(id)) continue;
    const isHome = id <= 10;
    if ((team === 'home') !== isHome) continue;
    const p = players[id];
    if (!p) continue;
    const x = Array.isArray(p) ? p[0] : p.x;
    if (!Number.isFinite(x)) continue;
    out.push(x * PITCH_LENGTH_M);
  }
  return out.length >= 7 ? out : null;
}

const load = await loadEngineWasm(WASM_PATH);
if (!load.ok) { console.error(load.message); process.exit(1); }
const { createGame } = await import('/home/happy/.claude/worktrees/wayfinder-realism/viewer/game.js');

const SEEDS = BENCHMARK_SEEDS.slice(0, 3);
const PER_SEED = [];
for (const seed of SEEDS) {
  const text = simulateStream(load.wasm, seed, ENGINE_DURATION_SEC);
  const stream = JSON.parse(text);
  const events = stream.events || stream;
  PER_SEED.push({ seed, events });
}

// ── 1. 直接从事件流里拆 mover 的 from/to ─────────────────────────────
console.log('=== 事件流 mover 分解（全部 beat 事件，主客合并）===');
for (const { seed, events } of PER_SEED) {
  const goalXs = []; const realXs = [];
  const byAction = new Map();
  // 只取开放比赛段：跳过死球/重开/门球？此处先全取，再看细分
  for (const ev of events) {
    if (!ev || ev.type !== 'beat' || !Array.isArray(ev.movers)) continue;
    for (const m of ev.movers) {
      const isHome = m.id <= 10;
      // 归一到「离本方门线」
      const fx = isHome ? m.from_x : 1 - m.from_x;
      const tx = isHome ? m.to_x : 1 - m.to_x;
      realXs.push({ t: ev.t, team: isHome ? 'home' : 'away', x: fx * PITCH_LENGTH_M });
      goalXs.push({ t: ev.t, team: isHome ? 'home' : 'away', x: tx * PITCH_LENGTH_M });
      const k = m.action;
      if (!byAction.has(k)) byAction.set(k, { from: [], to: [] });
      byAction.get(k).from.push(fx * PITCH_LENGTH_M);
      byAction.get(k).to.push(tx * PITCH_LENGTH_M);
    }
  }
  // 按 (t, team) 分组成帧，算纵深
  const group = (rows) => {
    const m = new Map();
    for (const r of rows) {
      const k = `${r.t}|${r.team}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r.x);
    }
    const out = [];
    for (const v of m.values()) {
      const s = span(v);
      if (s != null) out.push(s);
    }
    return out;
  };
  const dFrom = group(realXs); const dTo = group(goalXs);
  console.log(`seed ${seed}: 拍数=${dTo.length}  mover 目标纵深=${mean(dTo).toFixed(2)}m  mover 起点(实际)纵深=${mean(dFrom).toFixed(2)}m  (目标−实际)=${(mean(dTo) - mean(dFrom)).toFixed(2)}m`);
  const acts = [...byAction.entries()].sort((a, b) => b[1].to.length - a[1].to.length);
  for (const [k, v] of acts.slice(0, 8)) {
    console.log(`    action=${k.padEnd(14)} n=${String(v.to.length).padStart(6)}  目标纵深=${span(v.to).toFixed(1)}  起点纵深=${span(v.from).toFixed(1)}  Δx均值=${mean(v.to.map((x, i) => x - v.from[i])).toFixed(2)}m`);
  }
}

// ── 2. 实际位置 vs 真实：纵深差在哪个相位 ──────────────────────────
console.log('\n=== 相位分解：控球代理分相位的纵深（主队）===');
const REAL_TEAMS = ['home', 'away'];
for (const seed of SEEDS.slice(0, 3)) {
  const { events } = PER_SEED.find((p) => p.seed === seed);
  const game = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  const byPhase = { attack: [], defend: [], neutral: [] };
  const step = 0.2;
  for (let t = 0; t <= game.matchEnd; t += step) {
    game.seekTo(t);
    const xs = outfieldXsMeters(game.players, 'home');
    if (!xs) continue;
    const s = span(xs);
    if (s == null) continue;
    // 控球代理：离球最近者
    let bi = -1; let bd = Infinity;
    for (const p of game.players) {
      const dx = (p.x - game.ball.x) * PITCH_LENGTH_M;
      const dy = (p.y - game.ball.y) * 68;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; bi = p.id; }
    }
    const homeHas = bi <= 10;
    byPhase[homeHas ? 'attack' : 'defend'].push(s);
  }
  console.log(`seed ${seed}: 主队控球时纵深=${mean(byPhase.attack).toFixed(1)}m (n=${byPhase.attack.length})  对方控球时=${mean(byPhase.defend).toFixed(1)}m (n=${byPhase.defend.length})`);
}
