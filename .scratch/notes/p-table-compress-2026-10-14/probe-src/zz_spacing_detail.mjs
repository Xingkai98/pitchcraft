// [table-compress 探索探针 · 用完即删] spacing finding 的**细节**（pair id / t / min_distance）
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { loadEngineWasm } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const { simulateEvents } = await import(join(ROOT, 'tools/spacing-sweep-core.mjs'));
const { Game, buildGameIndex } = await import(join(ROOT, 'viewer/game.js'));
const { captureObservation } = await import(join(ROOT, 'viewer/observation.js'));
const { DEFAULT_AUDIT_PROFILE, detectPlayerOverlap } = await import(join(ROOT, 'tools/detectors.mjs'));
const wasmPath = process.argv[2], seed = Number(process.argv[3] || 42);
const { wasm } = await loadEngineWasm(wasmPath);
const { events, lineup } = simulateEvents({ wasm, seed, dur: 5400 });
const index = buildGameIndex(events, lineup, 'continuous');
const out = [];
for (let t = 5; t <= 5395; t += 2.5) {
  const game = new Game(events, lineup, 'continuous', { index });
  game.seekTo(t);
  const b = captureObservation({ game, statement: '', selectedEntities: [], window: { before: 5, after: 5 }, seed,
    config: { match_duration_seconds: 5400 }, sourceRevision: '<probe>', opts: { idFactory: () => 'sweep', now: 1 } });
  for (const f of detectPlayerOverlap(b.audit_input.players, DEFAULT_AUDIT_PROFILE)) out.push({ t, ...f.features, det: f.detector_id });
}
out.sort((a, b) => a.min_distance - b.min_distance);
console.log(`seed ${seed}: ${out.length} findings；最差 12 条：`);
for (const o of out.slice(0, 12)) console.log('  t=' + o.t + 's pair=[' + (o.players || o.pair || JSON.stringify(Object.keys(o))) + '] min=' + o.min_distance.toFixed(3) + 'm  ' + JSON.stringify({ ...o, t: undefined }));
