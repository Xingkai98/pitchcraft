// adv8: 逐槽位 x/y sd —— 判定 design-a「修正②」的引擎列来自哪个 wasm。
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const M = await import(pathToFileURL('../../../../../viewer/match-metrics.js').href);
const { cutWindows, KEEPER_IDS, PITCH_LENGTH_M, PITCH_WIDTH_M, BENCHMARK_SEEDS, ENGINE_DURATION_SEC, sampleEngineFrames } = M;
const { loadEngineWasm, simulateStream } = await import(pathToFileURL('../../../../../tools/benchmark-engine.mjs').href);
const { createGame } = await import(pathToFileURL('../../../../../viewer/game.js').href);
const ROOT = '../../../../..';
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };

async function slots(path, label) {
  const load = await loadEngineWasm(path);
  const W = [];
  for (const seed of BENCHMARK_SEEDS.slice(0, 3)) { const g = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC)); W.push(...cutWindows(sampleEngineFrames(g))); }
  const agg = (mode) => {
    const bx = []; const by = [];
    if (mode === 'pooled') {
      const m = new Map();
      for (const w of W) for (const f of w) for (const p of (f.players || [])) {
        if (p.id > 10 || KEEPER_IDS.includes(p.id)) continue;
        if (!m.has(p.id)) m.set(p.id, { x: [], y: [] });
        m.get(p.id).x.push(p.x * PITCH_LENGTH_M); m.get(p.id).y.push(p.y * PITCH_WIDTH_M);
      }
      for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) { const a = m.get(i); bx.push(sd(a.x)); by.push(sd(a.y)); }
    } else {
      const pwx = []; const pwy = [];
      for (const w of W) {
        const m = new Map();
        for (const f of w) for (const p of (f.players || [])) {
          if (p.id > 10 || KEEPER_IDS.includes(p.id)) continue;
          if (!m.has(p.id)) m.set(p.id, { x: [], y: [] });
          m.get(p.id).x.push(p.x * PITCH_LENGTH_M); m.get(p.id).y.push(p.y * PITCH_WIDTH_M);
        }
        for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) { const a = m.get(i); if (!a || a.x.length < 30) { pwx[i] = pwx[i] || []; pwy[i] = pwy[i] || []; continue; } (pwx[i] = pwx[i] || []).push(sd(a.x)); (pwy[i] = pwy[i] || []).push(sd(a.y)); }
      }
      for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) { bx.push(mean(pwx[i])); by.push(mean(pwy[i])); }
    }
    return { bx, by };
  };
  for (const mode of ['pooled', 'windowed']) {
    const r = agg(mode);
    console.log(`${label} [${mode}]`);
    console.log(`  x sd  ${r.bx.map((v) => v.toFixed(1)).join('/')}   (后防均值 ${mean(r.bx.slice(0, 4)).toFixed(1)}, 中场 ${mean(r.bx.slice(4, 8)).toFixed(1)}, 比 ${(mean(r.bx.slice(4, 8)) / mean(r.bx.slice(0, 4))).toFixed(2)})`);
    console.log(`  y sd  ${r.by.map((v) => v.toFixed(1)).join('/')}   (后防均值 ${mean(r.by.slice(0, 4)).toFixed(1)}, 中场 ${mean(r.by.slice(4, 8)).toFixed(1)})`);
  }
}
await slots('/tmp/wf-probe/eng-PRISTINE.wasm', '引擎 PRISTINE-MAIN(901da77b)');
await slots('/tmp/wf-probe/engine-DEMO-branch.wasm', '引擎 DEMO-branch(91b5f8761)');

// 真实 Metrica 逐槽位（窗内）
{
  const W = [];
  for (const f of ['1', '2']) {
    const g = JSON.parse(readFileSync(`${ROOT}/viewer/data/real-game-${f}.json`, 'utf8'));
    const fr = g.frames.map((x) => ({ t: x.t, ball: x.ball || null, players: x.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)) }));
    W.push(...cutWindows(fr));
  }
  const pwx = []; const pwy = [];
  for (const w of W) {
    const m = new Map();
    for (const f of w) for (const p of (f.players || [])) { if (p.id > 10 || KEEPER_IDS.includes(p.id)) continue; if (!m.has(p.id)) m.set(p.id, { x: [], y: [] }); m.get(p.id).x.push(p.x * PITCH_LENGTH_M); m.get(p.id).y.push(p.y * PITCH_WIDTH_M); }
    for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) { const a = m.get(i); if (!a) continue; (pwx[i] = pwx[i] || []).push(sd(a.x)); (pwy[i] = pwy[i] || []).push(sd(a.y)); }
  }
  const bx = []; const by = [];
  for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) { bx.push(mean(pwx[i])); by.push(mean(pwy[i])); }
  console.log('真实 Metrica [windowed]');
  console.log(`  x sd  ${bx.map((v) => v.toFixed(1)).join('/')}   (后防 ${mean(bx.slice(0, 4)).toFixed(1)}, 中场 ${mean(bx.slice(4, 8)).toFixed(1)}, 比 ${(mean(bx.slice(4, 8)) / mean(bx.slice(0, 4))).toFixed(2)})`);
  console.log(`  y sd  ${by.map((v) => v.toFixed(1)).join('/')}   (后防均值 ${mean(by.slice(0, 4)).toFixed(1)}, 中场 ${mean(by.slice(4, 8)).toFixed(1)})`);
}
