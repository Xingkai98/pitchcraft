// Wayfinder 探索探针 3：验证「防线 clamp 到球」假说
//
// 假说（读 formation_target 得到）：
//   max-min 的后防 clamp 是 `tx_full.min(ball.0).max(base.0)`——**只作用于防线球员**。
//   当球深入本方后场（ball.x < 防线基准 x），整条后防被拽到 ball.x，
//   而前锋/中场不受影响 → 纵深爆炸。
//
// 本探针直接看「引擎帧里，防线高度 / 锋线高度 随球 x 的变化」，与真实侧对照。
// 若假说成立：引擎防线在球 x 小时骤降到 ball.x，锋线纹丝不动。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PITCH_LENGTH_M, BENCHMARK_SEEDS, ENGINE_DURATION_SEC,
  sampleEngineFrames, cutWindows, KEEPER_IDS,
} from '../../../../../viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '../../../../../tools/benchmark-engine.mjs';

const HERE = fileURLToPath(new URL('../../../../..', import.meta.url));

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

function outfieldXs(frame, team) {
  const isHome = team === 'home';
  const out = (frame.players || [])
    .filter((p) => p && !KEEPER_IDS.includes(p.id) && (isHome ? p.id <= 10 : p.id >= 11))
    .map((p) => p.x * PITCH_LENGTH_M);
  return out.length >= 7 ? out.sort((a, b) => a - b) : null;
}

// 后卫线（引擎：id 1-4）与前锋线（id 9-10）的平均 x——用**固定 id 分组**，
// 因为要看的是"引擎那四个人"随球怎么动；真实侧用次序分组（1-4 / 9-10）替代。
function linesByName(frame, team, mode) {
  const isHome = team === 'home';
  const ps = (frame.players || []).filter((p) => p && !KEEPER_IDS.includes(p.id) && (isHome ? p.id <= 10 : p.id >= 11));
  if (ps.length < 7) return null;
  let back; let front;
  if (mode === 'id') {
    const b = ps.filter((p) => (isHome ? p.id >= 1 && p.id <= 4 : p.id >= 17 && p.id <= 20));
    const f = ps.filter((p) => (isHome ? p.id >= 9 : p.id >= 11 && p.id <= 12));
    if (!b.length || !f.length) return null;
    back = mean(b.map((p) => p.x * PITCH_LENGTH_M));
    front = mean(f.map((p) => p.x * PITCH_LENGTH_M));
  } else {
    const xs = ps.map((p) => p.x * PITCH_LENGTH_M).sort((a, b2) => a - b2);
    back = mean(xs.slice(0, 4));
    front = mean(xs.slice(8, 10));
  }
  if (!isHome) { back = PITCH_LENGTH_M - back; front = PITCH_LENGTH_M - front; }
  return { back, front, spread: front - back };
}

const load = await loadEngineWasm(WASM_PATH);
const { createGame } = await import('../../../../../viewer/game.js');
const engineFrames = [];
for (const seed of BENCHMARK_SEEDS.slice(0, 3)) {
  const game = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  for (const w of cutWindows(sampleEngineFrames(game))) engineFrames.push(...w);
}
const realFrames = [];
for (const f of ['1', '2']) {
  const g = JSON.parse(readFileSync(`${HERE}/viewer/data/real-game-${f}.json`, 'utf8'));
  const frames = g.frames.map((fr) => ({
    t: fr.t, ball: fr.ball || null,
    players: fr.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)),
  }));
  for (const w of cutWindows(frames)) realFrames.push(...w);
}

const edges = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

function table(frames, label, mode) {
  const acc = edges.slice(0, -1).map(() => ({ back: [], front: [], ball: [] }));
  for (const f of frames) {
    if (!f.ball || !Number.isFinite(f.ball[0])) continue;
    const bi = Math.max(0, Math.min(acc.length - 1, Math.floor(f.ball[0] * 10)));
    const L = linesByName(f, 'home', mode);
    if (!L) continue;
    acc[bi].back.push(L.back); acc[bi].front.push(L.front); acc[bi].ball.push(f.ball[0] * PITCH_LENGTH_M);
  }
  console.log(`\n=== ${label}：主队「后卫线 / 前锋线 / 纵深跨度」随球 x（米）===`);
  console.log('球 x 区间        球位   后卫线   前锋线   跨度(前-后)  n');
  acc.forEach((a, i) => {
    const lo = (edges[i] * 105).toFixed(0);
    const hi = (edges[i + 1] * 105).toFixed(0);
    const range = '  [' + lo + '–' + hi + ')';
    if (a.ball.length < 30) { console.log(range.padEnd(16) + '  样本不足'); return; }
    const b = mean(a.back); const fr = mean(a.front); const bx = mean(a.ball);
    console.log(range.padEnd(16)
      + `${bx.toFixed(1).padStart(7)}${b.toFixed(1).padStart(9)}${fr.toFixed(1).padStart(9)}${(fr - b).toFixed(1).padStart(12)}${String(a.ball.length).padStart(6)}`);
  });
}

table(engineFrames, '引擎（防线 = id 1-4，锋线 = id 9-10）', 'id');
table(realFrames, '真实 Metrica（防线 = 最深的 4 人，锋线 = 最前的 2 人）', 'order');
