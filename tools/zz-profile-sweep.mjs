// 一次性 profile 探针（#154 先量再改）。跑完读数固化进 design.md 后**删除**。
//
// 目的：确认 #152 的 §D1 读数（每窗 `new Game` = 91.6%）在 main=9cadab5 上仍然成立，
// 并把构造函数拆开（buildTimeline / _buildAnchorIndex / _computeEventEnds /
// _buildHighlightIndex / _initToEvent），看缓存静态索引能拿回多少。
//
// 用法：node tools/zz-profile-sweep.mjs [seed] [profileSeconds]

import { performance } from 'node:perf_hooks';

import { config } from '../viewer/config.js';
import { parseEventStream } from '../viewer/protocol.js';
import { Game } from '../viewer/game.js';
import { buildTimeline } from '../viewer/interpretation.js';
import { captureObservation } from '../viewer/observation.js';
import { DEFAULT_AUDIT_PROFILE, detectPlayerOverlap } from './detectors.mjs';
import { DEFAULT_DUR, DEFAULT_STEP, instantiateWasm } from './spacing-sweep-core.mjs';

config.debug.enabled = false;
config.playback.skipThresholdSeconds = Infinity;

const seed = Number(process.argv[2] ?? 42);
const profileSeconds = Number(process.argv[3] ?? 600);

const wasm = await instantiateWasm();
const enc = new TextEncoder();
const dec = new TextDecoder();
const cfgBytes = enc.encode(JSON.stringify({ match_duration_seconds: DEFAULT_DUR }));
new Uint8Array(wasm.memory.buffer, 1024, cfgBytes.length).set(cfgBytes);
const tSim = performance.now();
wasm.simulate(BigInt(seed), 1024, cfgBytes.length);
const rawJson = dec.decode(new Uint8Array(wasm.memory.buffer, wasm.get_json_ptr(), wasm.get_json_length()));
const tSimMs = performance.now() - tSim;
wasm.free_json();
const tParse = performance.now();
const raw = JSON.parse(rawJson);
const { events, lineup } = parseEventStream(raw);
const tParseMs = performance.now() - tParse;
console.log(`seed=${seed} events=${events.length} lineup=${lineup.length} jsonBytes=${rawJson.length}`);
console.log(`simulate=${tSimMs.toFixed(1)}ms  JSON.parse+parseEventStream=${tParseMs.toFixed(1)}ms`);

// 构造函数内部拆解：包装 prototype 上的私有阶段（互不嵌套），累加各自耗时。
const acc = { _buildAnchorIndex: 0, _computeEventEnds: 0, _buildHighlightIndex: 0, _initToEvent: 0 };
const calls = { _buildAnchorIndex: 0, _computeEventEnds: 0, _buildHighlightIndex: 0, _initToEvent: 0 };
for (const name of Object.keys(acc)) {
  const orig = Game.prototype[name];
  Game.prototype[name] = function (...args) {
    const t0 = performance.now();
    try {
      return orig.apply(this, args);
    } finally {
      acc[name] += performance.now() - t0;
      calls[name] += 1;
    }
  };
}

// buildTimeline 是自由函数（模块绑定不可改写），单独测 N 次取其自身成本。
const N_TL = 20;
let tTl = 0;
for (let i = 0; i < N_TL; i++) {
  const t0 = performance.now();
  buildTimeline(events, 'continuous');
  tTl += performance.now() - t0;
}
const tlMs = tTl / N_TL;

let windows = 0;
let tGame = 0;
let tSeek = 0;
let tObs = 0;
let tDetect = 0;
let findings = 0;
let worst = Infinity;

for (let t = 5; t <= DEFAULT_DUR - 5; t += DEFAULT_STEP) {
  if (t > 5 + profileSeconds) break;
  const g0 = performance.now();
  const game = new Game(events, lineup, 'continuous');
  tGame += performance.now() - g0;
  const s0 = performance.now();
  game.seekTo(t);
  tSeek += performance.now() - s0;
  const o0 = performance.now();
  const bundle = captureObservation({
    game,
    statement: '',
    selectedEntities: [],
    window: { before: 5, after: 5 },
    seed,
    config: { match_duration_seconds: DEFAULT_DUR },
    sourceRevision: '<spacing-sweep>',
    opts: { idFactory: () => 'sweep', now: 1 },
  });
  tObs += performance.now() - o0;
  const d0 = performance.now();
  const f = detectPlayerOverlap(bundle.audit_input.players, DEFAULT_AUDIT_PROFILE);
  tDetect += performance.now() - d0;
  windows += 1;
  for (const x of f) {
    findings += 1;
    if (x.features.min_distance < worst) worst = x.features.min_distance;
  }
}

const mins = (ms) => (ms / 1000 / 60).toFixed(2);
const total = tGame + tSeek + tObs + tDetect;
console.log(`\n窗口数=${windows}（t ∈ [5, ${5 + profileSeconds}] step ${DEFAULT_STEP}）`);
console.log(`new Game(...)          ${tGame.toFixed(0)} ms  ${(tGame / windows).toFixed(2)} ms/窗  ${((tGame / total) * 100).toFixed(1)}%`);
console.log(`  buildTimeline        ${(tlMs * windows).toFixed(0)} ms  ${tlMs.toFixed(2)} ms/窗  ${((tlMs * windows / total) * 100).toFixed(1)}%`);
for (const name of Object.keys(acc)) {
  console.log(
    `  ${name.padEnd(20)} ${acc[name].toFixed(0)} ms  ${(acc[name] / windows).toFixed(2)} ms/窗  ${((acc[name] / total) * 100).toFixed(1)}%  (${calls[name]} 次)`
  );
}
console.log(`seekTo                 ${tSeek.toFixed(0)} ms  ${(tSeek / windows).toFixed(2)} ms/窗  ${((tSeek / total) * 100).toFixed(1)}%`);
console.log(`captureObservation     ${tObs.toFixed(0)} ms  ${(tObs / windows).toFixed(2)} ms/窗  ${((tObs / total) * 100).toFixed(1)}%`);
console.log(`detectPlayerOverlap    ${tDetect.toFixed(0)} ms  ${(tDetect / windows).toFixed(2)} ms/窗  ${((tDetect / total) * 100).toFixed(1)}%`);
console.log(`逐窗合计               ${total.toFixed(0)} ms  折算全 2157 窗 = ${mins((total / windows) * 2157)} min/seed（本机）`);
console.log(`findings=${findings} worst=${Number.isFinite(worst) ? worst.toFixed(3) : 'null'}`);
