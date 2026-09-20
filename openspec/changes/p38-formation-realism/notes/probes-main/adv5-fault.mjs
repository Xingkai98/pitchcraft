// adv5: 「断层搬家 = hack」这个判据本身可靠吗？
//  (A) 断层位置在**同代码、不同种子**间稳不稳？（若不稳，判据无区分度）
//  (B) 一个**正当的机制改动**（块锚定，即 design-a 甲2 / design-b C 的核心）会不会也搬家？
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const M = await import(pathToFileURL('../../../../../viewer/match-metrics.js').href);
const { cutWindows, KEEPER_IDS, PITCH_LENGTH_M, BENCHMARK_SEEDS, ENGINE_DURATION_SEC, sampleEngineFrames } = M;
const { loadEngineWasm, simulateStream } = await import(pathToFileURL('../../../../../tools/benchmark-engine.mjs').href);
const { createGame } = await import(pathToFileURL('../../../../../viewer/game.js').href);
const ROOT = '../../../../..';
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

const load = await loadEngineWasm(process.argv[2] || '/tmp/wf-probe/engine-PRISTINE-MAIN.wasm');

const pos = (sorted, p) => { const h = (sorted.length - 1) * p; const i = Math.floor(h); return i + 1 >= sorted.length ? sorted[sorted.length - 1] : sorted[i] + (h - i) * (sorted[i + 1] - sorted[i]); };
function gapOf(frames) {
  const acc = Array.from({ length: 10 }, () => []);
  for (const f of frames) {
    const s = (f.players || []).filter((p) => p && !KEEPER_IDS.includes(p.id) && p.id <= 10).map((p) => p.x * PITCH_LENGTH_M).sort((a, b) => a - b);
    if (s.length < 10) continue;
    for (let i = 0; i < 10; i += 1) acc[i].push(pos(s, i / 9));
  }
  const P = acc.map(mean); return P.slice(1).map((v, i) => v - P[i]);
}

console.log('=== (A) 断层位置在种子间的稳定性（同一二进制）===');
const perSeed = [];
for (const seed of [42, 1, 7, 99, 123]) {
  const g = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  const W = cutWindows(sampleEngineFrames(g));
  const gaps = gapOf(W.flat());
  const mx = Math.max(...gaps); const at = gaps.indexOf(mx) + 1;
  console.log(`  seed ${String(seed).padStart(3)}  断层 ${mx.toFixed(1)}m @ ${at}→${at + 1}   序列 ${gaps.map((v) => v.toFixed(1)).join('/')}`);
  perSeed.push({ seed, mx, at, gaps });
}
const locs = new Set(perSeed.map((p) => p.at));
console.log(`  → 断层落点集合 {${[...locs].join(',')}}  ${locs.size === 1 ? '稳定' : '不稳定（判据区分度受损）'}`);
console.log(`  → 断层幅度范围 ${Math.min(...perSeed.map((p) => p.mx)).toFixed(1)}–${Math.max(...perSeed.map((p) => p.mx)).toFixed(1)}m`);

// 抽掉单场（leave-one-seed-out）看落点
console.log('\n  LOO（去掉一个种子后合并 4 场）:');
for (let i = 0; i < perSeed.length; i += 1) {
  const sub = perSeed.filter((_, j) => j !== i);
  // 重算：用平均序列（近似）——直接对每 seed 的 gaps 取平均
  const avg = sub[0].gaps.map((_, k) => mean(sub.map((p) => p.gaps[k])));
  const mx = Math.max(...avg); console.log(`    去掉 seed${sub[0].seed === 42 ? '' : ''}${perSeed[i].seed}: 断层 ${mx.toFixed(1)} @ ${avg.indexOf(mx) + 1}→${avg.indexOf(mx) + 2}`);
}

console.log('\n=== (B) 正当机制改动会不会也让断层搬家？===');
// 用一个"块锚定"模拟：把每队 10 人目标 = 块中心 + 队内次序槽位（软曲线），块中心随球平移
// 这**不是**拟合常数，而是 design-a 甲2 / design-b C 的机制核心。在 JS 里对引擎的真实球轨迹后处理。
function synthetic(frames, { g = 0.59, span = 0.32, curve = 'soft' } = {}) {
  // 返回新帧：球员 x 被替换为「块模型」坐标（仅作结构演示，不是引擎实现）
  const out = [];
  for (const f of frames) {
    if (!f.players) { out.push(f); continue; }
    const np = f.players.map((p) => (p ? { ...p } : null));
    for (const team of ['home', 'away']) {
      const idx = team === 'home' ? np.map((p, i) => (p && i <= 10 && i !== 0 ? i : -1)) : np.map((p, i) => (p && i >= 11 && i !== 21 ? i : -1));
      const ids = idx.filter((i) => i >= 0); if (ids.length < 10) continue;
      const bx = f.ball ? (team === 'home' ? f.ball[0] : 1 - f.ball[0]) : 0.5;
      const centre = Math.min(0.95, Math.max(0.05, 0.05 + g * bx));
      const rear = Math.max(0.02, centre - span / 2);
      const sorted = ids.slice().sort((a, b) => np[a].x - np[b].x);
      sorted.forEach((id, k) => {
        const s = curve === 'soft' ? (k / 9) ** 1.15 : k / 9;
        np[id] = { ...np[id], x: Math.min(0.98, rear + span * s) };
      });
    }
    out.push({ ...f, players: np });
  }
  return out;
}
const g0 = createGame(simulateStream(load.wasm, 42, ENGINE_DURATION_SEC));
const W0 = cutWindows(sampleEngineFrames(g0));
const base = gapOf(W0.flat());
console.log(`  基线 seed42   断层 ${Math.max(...base).toFixed(1)} @ ${base.indexOf(Math.max(...base)) + 1}→${base.indexOf(Math.max(...base)) + 2} ${base.map((v) => v.toFixed(1)).join('/')}`);
for (const opt of [{ g: 0.59 }, { g: 0.59, span: 0.55 }, { g: 0.59, span: 0.28, curve: 'lin' }, { g: 0.3 }, { g: 0.8 }]) {
  const g2 = gapOf(synthetic(W0.flat(), opt));
  const mx = Math.max(...g2);
  console.log(`  块锚定 ${JSON.stringify(opt).padEnd(34)} 断层 ${mx.toFixed(1)} @ ${g2.indexOf(mx) + 1}→${g2.indexOf(mx) + 2}  ${g2.map((v) => v.toFixed(1)).join('/')}`);
}
