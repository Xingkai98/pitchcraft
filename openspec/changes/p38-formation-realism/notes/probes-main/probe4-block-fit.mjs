// Wayfinder 探索探针 4：把 probe3 的发现做成定量「块模型」拟合
//
// probe3 显示：
//   真实——后卫线与锋线**一起平移**（斜率 0.476 / 0.556），块的整体跨度约恒定 24–32m
//   引擎——后卫线几乎不动（斜率 0.25），锋线大幅前插（斜率 0.456），跨度 38→58m 膨胀
//
// 本探针把「球队块」的参数拟合出来：块中心 = f(球位)，块跨度 = g(球位)。
// 这是后续机制设计的定量依据。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PITCH_LENGTH_M, BENCHMARK_SEEDS, ENGINE_DURATION_SEC,
  sampleEngineFrames, cutWindows, KEEPER_IDS,
} from '../../../../../viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '../../../../../tools/benchmark-engine.mjs';

const HERE = fileURLToPath(new URL('../../../../..', import.meta.url));

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

function teamXs(frame, team) {
  const isHome = team === 'home';
  const out = (frame.players || [])
    .filter((p) => p && !KEEPER_IDS.includes(p.id) && (isHome ? p.id <= 10 : p.id >= 11))
    .map((p) => p.x * PITCH_LENGTH_M);
  if (out.length < 7) return null;
  const xs = out.sort((a, b) => a - b);
  return team === 'home' ? xs : xs.map((v) => PITCH_LENGTH_M - v).reverse();
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

// 逐帧：块中心 = 10 人 x 的中点（平均），块跨度 = 最深-最前
function blockStats(frames) {
  const rows = [];
  for (const f of frames) {
    if (!f.ball || !Number.isFinite(f.ball[0])) continue;
    for (const team of ['home', 'away']) {
      const xs = teamXs(f, team);
      if (!xs) continue;
      // ⚠️ 球位必须与队形同一坐标系：away 的「离本方门线距离」要把 x 镜像，
      // 否则两队的 ball-x 关系方向相反，回归斜率互相抵消（本探针初版就是这个 bug）。
      const bx = (team === 'home' ? f.ball[0] : 1 - f.ball[0]) * PITCH_LENGTH_M;
      rows.push({ ball: bx, center: mean(xs), span: xs[9] - xs[0], back: xs[0], front: xs[9] });
    }
  }
  return rows;
}

// 最小二乘 y = a*x + b
function fit(rows, key) {
  const n = rows.length;
  const sx = rows.reduce((s, r) => s + r.ball, 0);
  const sy = rows.reduce((s, r) => s + r[key], 0);
  const sxy = rows.reduce((s, r) => s + r.ball * r[key], 0);
  const sxx = rows.reduce((s, r) => s + r.ball * r.ball, 0);
  const a = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const b = (sy - a * sx) / n;
  return { a, b };
}

function report(rows, label) {
  const n = rows.length;
  console.log(`\n=== ${label}（n=${n} 帧·队）===${''}`);
  for (const [key, name] of [['center', '块中心'], ['back', '最后一人'], ['front', '最前一人'], ['span', '块跨度']]) {
    const { a, b } = fit(rows, key);
    console.log(`  ${name}: ${key}(ball) = ${a.toFixed(4)} * ball + ${b.toFixed(4)}   （ball 每移 10m，${name}移 ${(a * 10).toFixed(2)}m）`);
  }
  // 跨度是否随球位单增
  const edges = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
  const acc = edges.slice(0, -1).map(() => ({ span: [], center: [] }));
  for (const r of rows) {
    const bi = Math.max(0, Math.min(acc.length - 1, Math.floor((r.ball / PITCH_LENGTH_M) * 5)));
    acc[bi].span.push(r.span); acc[bi].center.push(r.center);
  }
  console.log('  球位区间      块跨度   块中心');
  acc.forEach((a, i) => {
    if (a.span.length < 30) return;
    console.log(`    [${(edges[i] * 105).toFixed(0)}–${(edges[i + 1] * 105).toFixed(0)})   ${mean(a.span).toFixed(1).padStart(6)}   ${mean(a.center).toFixed(1).padStart(6)}`);
  });
}

const R = blockStats(realFrames);
const E = blockStats(engineFrames);
report(R, '真实 Metrica');
report(E, '引擎');

console.log('\n=== 归一化到 [0,1] 的斜率对比（ball 每移 1.0，各量移多少）===');
for (const [key, name] of [['center', '块中心'], ['back', '最后一人'], ['front', '最前一人'], ['span', '块跨度']]) {
  const r = fit(R, key); const e = fit(E, key);
  console.log(`  ${name}  真实 ${r.a.toFixed(3)}  引擎 ${e.a.toFixed(3)}  差 ${(e.a - r.a).toFixed(3)}`);
}

// 关键：块跨度是否与「防守/进攻」相关
console.log('\n=== 块跨度分布（紧凑度）===');
const rs = R.map((r) => r.span).sort((a, b) => a - b);
const es = E.map((r) => r.span).sort((a, b) => a - b);
const qq = (s, p) => s[Math.floor((s.length - 1) * p)];
console.log(`  真实  中位 ${qq(rs, 0.5).toFixed(1)}  p10 ${qq(rs, 0.1).toFixed(1)}  p90 ${qq(rs, 0.9).toFixed(1)}`);
console.log(`  引擎  中位 ${qq(es, 0.5).toFixed(1)}  p10 ${qq(es, 0.1).toFixed(1)}  p90 ${qq(es, 0.9).toFixed(1)}`);
