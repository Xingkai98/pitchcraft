// P38 探索：射门瞬间的「防守者距离」——真实 vs 引擎
//
// 动机：exp4b 把队形压到真实量级（gap 7.93 ≈ 真实 8.34）却让射门崩了 93%，
// 机制是「进攻三区最近防守者 <8m 占比 50.6% → 92%」。但**真实比赛里防守者到底多近？**
// 如果真实球员本来就在贴身下射门，那限制在**射门模型**，不在队形。
//
// 口径：射门事件时刻 → 取该时刻的帧 → 球所在位置到最近**对方**球员的距离（米）。
// 真实与引擎用**同一段代码**计算（P36 的教训：口径分叉 = 数字不可比）。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BENCHMARK_SEEDS, ENGINE_DURATION_SEC, sampleEngineFrames, KEEPER_IDS,
  PITCH_LENGTH_M, PITCH_WIDTH_M,
} from '../../../../../viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '../../../../../tools/benchmark-engine.mjs';

const HERE = fileURLToPath(new URL('../../../../..', import.meta.url));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const qs = (s, p) => { const h = (s.length - 1) * p; const lo = Math.floor(h); const hi = Math.ceil(h); return s[lo] + (h - lo) * (s[hi] - s[lo]); };

// 给定帧 + 球位 + 射门方 → 最近对方球员距离（米）；排除门将（门将永远在附近但不算压迫）
function nearestOpponent(frame, ballX, ballY, shooterIsHome) {
  let best = Infinity;
  for (const p of frame.players) {
    if (!p) continue;
    if (KEEPER_IDS.includes(p.id)) continue;
    const isHome = p.id <= 10;
    if (isHome === shooterIsHome) continue;          // 只看对方
    const d = Math.hypot((p.x - ballX) * PITCH_LENGTH_M, (p.y - ballY) * PITCH_WIDTH_M);
    if (d < best) best = d;
  }
  return best;
}

function summarize(dists, label) {
  if (!dists.length) { console.log(`  ${label}: 无样本`); return; }
  const s = [...dists].sort((a, b) => a - b);
  const under4 = dists.filter((d) => d < 4).length / dists.length;
  const under8 = dists.filter((d) => d < 8).length / dists.length;
  console.log(`  ${label}  n=${dists.length}  中位 ${qs(s, 0.5).toFixed(1)}m`
    + `  p25 ${qs(s, 0.25).toFixed(1)}  p75 ${qs(s, 0.75).toFixed(1)}`
    + `  | <4m ${(100 * under4).toFixed(0)}%  <8m ${(100 * under8).toFixed(0)}%`);
}

console.log('=== 射门瞬间「最近对方非门将球员」距离 ===\n');

// ── 真实：Metrica 事件 CSV 的 SHOT + tracking 帧 ──────────────────────────
for (const game of ['1', '2']) {
  const csv = readFileSync(`${HERE}/.scratch/tracking-data/sample-data/data/Sample_Game_${game}/Sample_Game_${game}_RawEventsData.csv`, 'utf8');
  const lines = csv.split('\n').slice(1).filter(Boolean);
  const shots = [];
  for (const l of lines) {
    const c = l.split(',');
    if (c[1] !== 'SHOT') continue;
    const period = Number(c[3]);
    const t = Number(c[5]);
    shots.push({ period, t, team: c[0] });
  }
  const g = JSON.parse(readFileSync(`${HERE}/viewer/data/real-game-${game}.json`, 'utf8'));
  const frames = g.frames;
  // 帧 t 是否分半场重置？先看范围
  const tMin = frames[0].t; const tMax = frames[frames.length - 1].t;
  const dists = [];
  let matched = 0;
  for (const s of shots) {
    // 事件 CSV 的 t 与帧的 t 同一时基（都来自 RawTrackingData 的 Time [s]）
    let best = null;
    for (const f of frames) {
      const d = Math.abs(f.t - s.t);
      if (!best || d < best.d) best = { d, f };
    }
    if (!best || best.d > 1.0) continue;   // 1 秒内无帧则跳过
    const f = best.f;
    if (!f.ball) continue;
    // 射门方 = 主队？事件 CSV Team 为 Home/Away
    const shooterIsHome = s.team === 'Home';
    const nd = nearestOpponent(
      { players: f.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)) },
      f.ball[0], f.ball[1], shooterIsHome,
    );
    if (Number.isFinite(nd)) { dists.push(nd); matched += 1; }
  }
  console.log(`Metrica game${game}（事件表 ${shots.length} 脚射门，匹配上 ${matched}；帧 t∈[${tMin.toFixed(0)},${tMax.toFixed(0)}]）`);
  summarize(dists, '真实');
}

// ── 引擎 ────────────────────────────────────────────────────────────────
const load = await loadEngineWasm(WASM_PATH);
const { createGame } = await import(`${HERE}/viewer/game.js`);
const dists = [];
for (const seed of BENCHMARK_SEEDS.slice(0, 3)) {
  const game = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  const stream = JSON.parse(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  const frames = sampleEngineFrames(game);
  for (const e of stream) {
    if (e.type !== 'shot' || e.x == null) continue;
    let best = null;
    for (const f of frames) {
      const d = Math.abs(f.t - e.t);
      if (!best || d < best.d) best = { d, f };
    }
    if (!best || best.d > 1.0) continue;
    const shooterIsHome = e.subject <= 10;
    const nd = nearestOpponent(best.f, e.x, e.y, shooterIsHome);
    if (Number.isFinite(nd)) dists.push(nd);
  }
}
console.log(`\n引擎（3 seed × 5400s）`);
summarize(dists, '引擎');

console.log('\n读法：若真实的 <8m 占比也很高，说明"防守者近"不是射门少的解释——');
console.log('      限制在射门模型而非队形（引擎的 SHOT_WINDOW_FREE_M=8 判据可能过严）。');
