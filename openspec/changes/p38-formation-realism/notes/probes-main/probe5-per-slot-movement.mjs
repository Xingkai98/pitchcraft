// Wayfinder 探索探针 5：逐槽位移动量（验证 agent 甲 的「修正 ②」）
//
// 甲的主张：引擎纵深不是「后防太深」，是「中场到处跑」——
//   引擎后防 4 人 x 方向 sd ≈10m（真实 ≈18m），中场 4 人 sd ≈24m。
// 若成立：修 formation_target 的防线 clamp 比改模板更对症。
//
// 口径：窗内逐 id 的 x/y 标准差，再对窗取均值。两侧都用**固定 id**：
//   引擎 id 1-4 = 后卫、5-8 = 中场、9-10 = 前锋（default_lineup 固定）
//   真实 Metrica 转换器的 assignIds 按「出场数 + 整场深度排序」填槽位，未必对应位置，
//   故真实侧**同时**给出「按整场深度排序的槽位」与「逐帧次序分组」两种，便于交叉判断。

import { readFileSync } from 'node:fs';
import {
  PITCH_LENGTH_M, PITCH_WIDTH_M, BENCHMARK_SEEDS, ENGINE_DURATION_SEC,
  sampleEngineFrames, cutWindows, KEEPER_IDS,
} from '/home/happy/.claude/worktrees/wayfinder-realism/viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '/home/happy/.claude/worktrees/wayfinder-realism/tools/benchmark-engine.mjs';

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((v) => (v - m) ** 2)));
};

function outfield(frame, team) {
  const isHome = team === 'home';
  return (frame.players || []).filter((p) => p && !KEEPER_IDS.includes(p.id) && (isHome ? p.id <= 10 : p.id >= 11));
}

// 按 id 固定分组（引擎语义；真实侧 = 转换器槽位）
function perIdStd(frames) {
  const acc = new Map(); // `${team}-${id}` -> {x:[], y:[]}
  for (const f of frames) {
    for (const team of ['home', 'away']) {
      for (const p of outfield(f, team)) {
        const key = `${team}-${p.id}`;
        if (!acc.has(key)) acc.set(key, { x: [], y: [] });
        const a = acc.get(key);
        a.x.push(p.x * PITCH_LENGTH_M);
        a.y.push(p.y * PITCH_WIDTH_M);
      }
    }
  }
  const out = [];
  for (const [key, a] of acc) {
    const [team, id] = key.split('-');
    // 队形统一到「离本方门线的距离」：away 的 x 镜像
    const xs = team === 'home' ? a.x : a.x.map((v) => PITCH_LENGTH_M - v);
    if (xs.length < 200) continue;
    out.push({ team, id: Number(id), n: xs.length, sdX: sd(xs), sdY: sd(a.y) });
  }
  return out.sort((p, q) => p.id - q.id);
}

const load = await loadEngineWasm(WASM_PATH);
const { createGame } = await import('/home/happy/.claude/worktrees/wayfinder-realism/viewer/game.js');
const engineFrames = [];
for (const seed of BENCHMARK_SEEDS.slice(0, 3)) {
  const game = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  for (const w of cutWindows(sampleEngineFrames(game))) engineFrames.push(...w);
}
const realFrames = [];
for (const f of ['1', '2']) {
  const g = JSON.parse(readFileSync(`/home/happy/.claude/worktrees/wayfinder-realism/viewer/data/real-game-${f}.json`, 'utf8'));
  const frames = g.frames.map((fr) => ({
    t: fr.t, ball: fr.ball || null,
    players: fr.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)),
  }));
  for (const w of cutWindows(frames)) realFrames.push(...w);
}

function report(frames, label, teamFilter) {
  const rows = perIdStd(frames).filter((r) => r.team === teamFilter);
  console.log(`\n=== ${label}（${teamFilter === 'home' ? '主队' : '客队'}）===`);
  console.log('槽位id   n      x向sd    y向sd');
  for (const r of rows) {
    console.log(`  ${String(r.id).padStart(2)}   ${String(r.n).padStart(6)}  ${r.sdX.toFixed(1).padStart(7)}  ${r.sdY.toFixed(1).padStart(7)}`);
  }
  const grp = (a, b) => {
    const sel = rows.filter((r) => r.id >= a && r.id <= b);
    return sel.length ? { x: mean(sel.map((r) => r.sdX)), y: mean(sel.map((r) => r.sdY)) } : null;
  };
  const back = grp(1, 4); const mid = grp(5, 8); const front = grp(9, 10);
  if (back && mid && front) {
    console.log(`  分组均值：后防 x ${back.x.toFixed(1)} / y ${back.y.toFixed(1)}　`
      + `中场 x ${mid.x.toFixed(1)} / y ${mid.y.toFixed(1)}　`
      + `锋线 x ${front.x.toFixed(1)} / y ${front.y.toFixed(1)}`);
    console.log(`  中场/后防 x 比 = ${(mid.x / back.x).toFixed(2)}`);
  }
}

report(realFrames, '真实 Metrica（槽位 = 转换器按整场深度分配）', 'home');
report(engineFrames, '引擎（槽位 = default_lineup 固定）', 'home');
