// probe 5：引擎侧「最深的 4 人到底是谁」+ 相位口径收紧 + 引擎队形目标的静态预测
// 目标：区分「防线被 clamp 拽深」vs「carrier/close_down 等非队形目标把 4 深拉深」。

import {
  PITCH_LENGTH_M, BENCHMARK_SEEDS, ENGINE_DURATION_SEC,
  sampleEngineFrames, cutWindows, KEEPER_IDS, possessionProxy, isRawBallFrame,
} from '../../../../../viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '../../../../../tools/benchmark-engine.mjs';

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

const load = await loadEngineWasm(WASM_PATH);
const { createGame } = await import('../../../../../viewer/game.js');
const engineFrames = [];
for (const seed of BENCHMARK_SEEDS.slice(0, 3)) {
  const game = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  for (const w of cutWindows(sampleEngineFrames(game))) engineFrames.push(...w);
}

const DEF = [1, 2, 3, 4], MID = [5, 6, 7, 8], FWD = [9, 10];

// ── A：球深时，主队最深的 4 人是谁 ────────────────────────────────────────
console.log('=== A. 球 x<11m（主队后场）时，主队最深 4 人的 id 构成 ===');
{
  const idCount = new Map();
  let n = 0;
  const posById = new Map();
  for (const f of engineFrames) {
    if (!f.ball || !Number.isFinite(f.ball[0]) || f.ball[0] >= 0.105) continue;
    const ps = f.players.filter((p) => p && p.id >= 1 && p.id <= 10);
    if (ps.length < 7) continue;
    const sorted = [...ps].sort((a, b) => a.x - b.x);
    n += 1;
    for (const p of sorted.slice(0, 4)) idCount.set(p.id, (idCount.get(p.id) || 0) + 1);
    for (const p of ps) { if (!posById.has(p.id)) posById.set(p.id, []); posById.get(p.id).push(p.x * 105); }
  }
  console.log(` 样本 ${n} 帧`);
  console.log('  最深4人 id 频次：' + [...idCount.entries()].sort((a, b) => b[1] - a[1]).map(([id, c]) => `${id}:${(c / n * 100).toFixed(0)}%`).join(' '));
  console.log('  各 id 平均 x（米）当球深：' + DEF.concat(MID, FWD).map((id) => `${id}:${mean(posById.get(id) || []).toFixed(1)}`).join(' '));
}

// ── B：全帧各 id 的 x 分布（静态模板 vs 实际游走范围）────────────────────
console.log('\n=== B. 全帧各 id 平均 x 与 sd（米）===');
{
  const acc = new Map();
  for (const f of engineFrames) {
    for (const p of f.players) { if (!p || KEEPER_IDS.includes(p.id) || p.id > 10) continue; if (!acc.has(p.id)) acc.set(p.id, []); acc.get(p.id).push(p.x * 105); }
  }
  for (const id of DEF.concat(MID, FWD)) {
    const a = acc.get(id) || [];
    const m = mean(a); const sd = Math.sqrt(mean(a.map((v) => (v - m) ** 2)));
    const s = [...a].sort((x, y) => x - y);
    console.log(`  id ${String(id).padStart(2)}  mean ${m.toFixed(1)}  sd ${sd.toFixed(1)}  p05 ${s[(a.length * 0.05) | 0].toFixed(1)}  p95 ${s[(a.length * 0.95) | 0].toFixed(1)}`);
  }
}

// ── C：相位口径收紧（原始球帧 + possessionProxy）────────────────────────
console.log('\n=== C. 相位分析（只用原始球帧；possessionProxy 判定控球）===');
{
  const acc = { home: { in: [], out: [] }, away: { in: [], out: [] } };
  for (const f of engineFrames) {
    if (!isRawBallFrame(f)) continue;
    const pos = possessionProxy(f);
    if (!pos) continue;
    for (const team of ['home', 'away']) {
      const ps = f.players.filter((p) => p && !KEEPER_IDS.includes(p.id) && (team === 'home' ? p.id <= 10 : p.id >= 11));
      if (ps.length < 7) continue;
      const xs = ps.map((p) => (team === 'home' ? p.x : 1 - p.x) * 105).sort((a, b) => a - b);
      const b4 = mean(xs.slice(0, 4)); const f2 = mean(xs.slice(8, 10));
      acc[team][pos === team ? 'in' : 'out'].push({ b4, f2 });
    }
  }
  for (const team of ['home', 'away']) {
    for (const k of ['in', 'out']) {
      const a = acc[team][k];
      if (!a.length) continue;
      console.log(`  ${team} ${k === 'in' ? '控球' : '丢球'}  后4 ${mean(a.map((r) => r.b4)).toFixed(1)}  前2 ${mean(a.map((r) => r.f2)).toFixed(1)}  前-后 ${mean(a.map((r) => r.f2 - r.b4)).toFixed(1)}  n=${a.length}`);
    }
  }
}

// ── D：引擎防线（id 1-4）实际 x 随球 x 的散点（中位数 + p10/p90）──────────
console.log('\n=== D. 引擎后卫 id1-4 平均 x 随球 x（中位与带宽）===');
{
  const edges = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 105];
  const acc = edges.slice(0, -1).map(() => []);
  for (const f of engineFrames) {
    if (!f.ball || !Number.isFinite(f.ball[0])) continue;
    const bx = f.ball[0] * 105;
    const bi = Math.min(9, Math.max(0, Math.floor(bx / 10)));
    const ds = f.players.filter((p) => p && DEF.includes(p.id));
    if (ds.length < 4) continue;
    acc[bi].push(mean(ds.map((p) => p.x * 105)));
  }
  acc.forEach((a, i) => {
    if (a.length < 100) return;
    const s = [...a].sort((x, y) => x - y);
    console.log(`  球[${edges[i]}–${edges[i + 1]})  后卫均值 ${mean(a).toFixed(1)}  p10 ${s[(a.length * 0.1) | 0].toFixed(1)}  p90 ${s[(a.length * 0.9) | 0].toFixed(1)}  n=${a.length}`);
  });
}

// ── E：真实侧同样口径（最深的 4 人是谁不可知，只能给次序块）────────────
console.log('\n=== E. 真实侧参照：后卫块随球 x（已在 probe4 给出）===');
console.log('  (跳过)');
