// R3 T1 标定扫描：纹理幅度（米）→ 转角/hp 指标，对照真实 22 场目标。
// 开发 seed 42（train），标定后 held-out 验收用 201+。
import { join } from 'node:path';
const ROOT = process.cwd();
const { matchTracks, toMeters } = await import(join(ROOT, '.scratch/notes/goal-loop-r3/diag-turns.mjs'));
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const { Game, ARC_STEER } = await import(join(ROOT, 'viewer/game.js'));
const { parseEventStream } = await import(join(ROOT, 'viewer/protocol.js'));
const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
const { wasm } = await loadEngineWasm(join(ROOT, 'viewer/engine.wasm'));
const evJson = simulateStream(wasm, 42, mm.ENGINE_DURATION_SEC);
const { events, lineup } = parseEventStream(evJson);
const TARGET = { p50: 3.024, p90: 10.877, p99: 27.625, fracGt20: 0.026, top10mass: 0.378, hp3: 0.027, hp5: 0.066, hp7: 0.118, hp11: 0.259 };
const fmt = (o) => Object.entries(o).map(([k, v]) => `${k}=${v.toFixed(3)}`).join(' ');
console.log('TARGET(real22):', fmt(TARGET));
const pairs = (process.argv[2] || '0:1.0:noise')
  .split(',').map((s) => { const [a, l, m, b, c, arc, r] = s.split(':'); return { amp: Number(a), lattice: Number(l), mode: m || 'noise', block: b ? Number(b) : undefined, tau: c ? Number(c) : undefined, arc: arc === undefined ? undefined : arc === 'arc', radius: r ? Number(r) : undefined }; });
for (const p of pairs) {
  if (p.radius) ARC_STEER.radiusM = p.radius;
  const g = new Game(events, lineup, 'continuous', { textureAmpM: p.amp, textureLatticeSec: p.lattice, textureMode: p.mode, textureBlockSec: p.block, crTension: p.tau, arcSteer: p.arc });
  const frames = toMeters(mm.sampleEngineFrames(g), 105, 68);
  const m = matchTracks(frames);
  console.log(`amp=${p.amp.toFixed(2)} lattice=${p.lattice.toFixed(1)} mode=${p.mode}${p.block ? ' block=' + p.block : ''}${p.tau ? ' tau=' + p.tau : ''}${p.arc !== undefined ? ' arc=' + p.arc : ''}${p.radius ? ' R=' + p.radius : ''}:`, fmt(m));
}
