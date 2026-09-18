// probe 8：用 match-metrics.js 的正式口径复算五条头条指标（不照抄任务书的数字）
import { readFileSync } from 'node:fs';
import {
  BENCHMARK_SEEDS, ENGINE_DURATION_SEC, sampleEngineFrames, cutWindows,
  windowMetrics, summarizeWindowMetrics, elasticity, teamShape, frameMetrics, KEEPER_IDS,
} from '/home/happy/.claude/worktrees/wayfinder-realism/viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '/home/happy/.claude/worktrees/wayfinder-realism/tools/benchmark-engine.mjs';

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
  const frames = g.frames.map((fr) => ({ t: fr.t, ball: fr.ball || null, players: fr.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)) }));
  for (const w of cutWindows(frames)) realFrames.push(...w);
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

function report(label, frames) {
  const m = windowMetrics(frames).primary;
  // 紧凑度：非门将到重心的平均距离（两队合并），逐帧再均值——与 teamShape.spread 同源
  const sp = [];
  for (const f of frames) for (const t of ['home', 'away']) { const s = teamShape(f, t); if (s) sp.push(s.spread); }
  const el = elasticity(frames);
  console.log(`  ${label}`);
  console.log(`    纵深(主) ${m.hd.toFixed(1)}m   纵深(客) ${m.ad.toFixed(1)}m   紧凑度 ${mean(sp).toFixed(1)}m   重心间距 ${m.gap.toFixed(1)}m   宽度(主) ${m.width.toFixed(1)}m`);
  console.log(`    弹性(half) Δ=${el ? el.delta.toFixed(1) : 'n/a'}m  [own ${el ? el.own.toFixed(1) : '—'} → opp ${el ? el.opp.toFixed(1) : '—'}]  球到重心 ${m.ballDist != null ? m.ballDist.toFixed(1) : '—'}m  控球率(代理) ${m.possessionHome != null ? (m.possessionHome * 100).toFixed(0) : '—'}%`);
  return { m, sp: mean(sp), el };
}
const R = report('真实 Metrica（2 场）', realFrames);
const E = report('引擎（3 种子 × 6 窗）', engineFrames);
console.log(`\n  差距：纵深 ${(E.m.hd - R.m.hd).toFixed(1)}m  紧凑度 ${(E.sp - R.sp).toFixed(1)}m  重心间距 ${(E.m.gap - R.m.gap).toFixed(1)}m  宽度 ${(E.m.width - R.m.width).toFixed(1)}m`);

// 方差分解：把「主队纵深」按球位分桶（主口径：只用原始球帧）
console.log('\n  纵深随球位的方差（主队，10 桶）——两侧对照');
for (const [lab, FR] of [['真实', realFrames], ['引擎', engineFrames]]) {
  const E2 = [0, 10.5, 21, 31.5, 42, 52.5, 63, 73.5, 84, 94.5, 105];
  const acc = E2.slice(0, -1).map(() => []);
  for (const f of FR) {
    if (!f.ball) continue;
    const bi = Math.max(0, Math.min(9, Math.floor(f.ball[0] * 105 / 10.5)));
    const s = teamShape(f, 'home'); if (!s) continue;
    acc[bi].push(s.depth);
  }
  console.log(`    ${lab}  ` + acc.map((a, i) => `${((E2[i] + E2[i + 1]) / 2).toFixed(0)}m:${mean(a).toFixed(1)}`).join('  '));
}
