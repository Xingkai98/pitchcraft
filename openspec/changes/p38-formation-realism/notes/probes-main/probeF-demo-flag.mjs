// 方案设计 agent（乙）探针 F：**决定性实验** —— benchmark 测的到底是哪个引擎？
//
// 发现：`tools/benchmark-engine.mjs` 的 ENGINE_CONFIG 里 `off_ball_movement_demo: true`，
// 而该标志在 main 仓库的 `demo/off-ball-movement` 分支上会**覆盖** formation_target
// （`demo_off_ball_target`）。worktree 的 lib.rs 里没有这个标志（是旧代码）。
//
// wasm 暴露了这个开关 → 可以**运行时切换**，不需要重新编译、不需要 cargo。
// 同一个 seed、同一份 wasm，只改一个布尔值，比较纵深。这是干净的 A/B。

import { readFileSync } from 'node:fs';
import {
  PITCH_LENGTH_M, BENCHMARK_SEEDS, ENGINE_DURATION_SEC, KEEPER_IDS,
  quantileSorted, sampleEngineFrames, cutWindows, teamShape,
} from '/home/happy/.claude/worktrees/wayfinder-realism/viewer/match-metrics.js';
import { loadEngineWasm, WASM_PATH } from '/home/happy/.claude/worktrees/wayfinder-realism/tools/benchmark-engine.mjs';

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

// 自建 simulate（带 off_ball 开关），其余与 benchmark-engine.mjs 一致
function simulateWith(wasm, seed, durationSec, offBall) {
  const enc = new TextEncoder(); const dec = new TextDecoder();
  const cfg = enc.encode(JSON.stringify({ demo_mode: false, off_ball_movement_demo: offBall, match_duration_seconds: durationSec }));
  const SCRATCH = 1024;
  new Uint8Array(wasm.memory.buffer, SCRATCH, cfg.length).set(cfg);
  wasm.simulate(BigInt(seed), SCRATCH, cfg.length);
  const ptr = wasm.get_json_ptr(); const len = wasm.get_json_length();
  const text = dec.decode(new Uint8Array(wasm.memory.buffer, ptr, len));
  wasm.free_json();
  return text;
}

const load = await loadEngineWasm(WASM_PATH);
if (!load.ok) { console.error(load.message); process.exit(1); }
const { createGame } = await import('/home/happy/.claude/worktrees/wayfinder-realism/viewer/game.js');

function shapeStats(wasm, offBall) {
  const acc = { depth: [], spread: [], gap: [], width: [], elastic: [] };
  const byBall = new Map();
  for (const seed of BENCHMARK_SEEDS.slice(0, 3)) {
    const game = createGame(simulateWith(wasm, seed, ENGINE_DURATION_SEC, offBall));
    for (const w of cutWindows(sampleEngineFrames(game))) {
      for (const f of w) {
        if (!f.ball || !Number.isFinite(f.ball[0])) continue;
        const h = teamShape(f, 'home'); const a = teamShape(f, 'away');
        if (!h || !a) continue;
        acc.depth.push(h.depth); acc.spread.push(h.spread);
        acc.gap.push(Math.abs(h.cx - a.cx)); acc.width.push(h.width);
        const k = Math.min(4, Math.floor(f.ball[0] * 5));
        if (!byBall.has(k)) byBall.set(k, []);
        byBall.get(k).push(h.depth);
      }
    }
  }
  const b = [...byBall.entries()].sort((x, y) => x[0] - y[0]).map(([, v]) => mean(v));
  acc.elastic = Math.max(...b) - Math.min(...b);
  return {
    depth: mean(acc.depth), spread: mean(acc.spread), gap: mean(acc.gap),
    width: mean(acc.width), elastic: acc.elastic, n: acc.depth.length,
  };
}

const off = shapeStats(load.wasm, false);
const on = shapeStats(load.wasm, true);
const real = { depth: 26.37, spread: 15.2, gap: 7.4, width: 39.6, elastic: 10.3 }; // 探针实测

console.log('=== F 同一 wasm，只切 off_ball_movement_demo ===');
console.log(' 指标                     demo=OFF      demo=ON       真实(Metrica)   基线(入库)');
console.log(` 纵深 q10-q90 (m)      ${off.depth.toFixed(1).padStart(9)} ${on.depth.toFixed(1).padStart(12)} ${real.depth.toFixed(1).padStart(13)} ${'40.5'.padStart(12)}`);
console.log(` 紧凑度 spread (m)     ${off.spread.toFixed(1).padStart(9)} ${on.spread.toFixed(1).padStart(12)} ${real.spread.toFixed(1).padStart(13)} ${'20.0'.padStart(12)}`);
console.log(` 重心间距 gap (m)      ${off.gap.toFixed(1).padStart(9)} ${on.gap.toFixed(1).padStart(12)} ${real.gap.toFixed(1).padStart(13)} ${'15.1'.padStart(12)}`);
console.log(` 宽度 width (m)        ${off.width.toFixed(1).padStart(9)} ${on.width.toFixed(1).padStart(12)} ${real.width.toFixed(1).padStart(13)} ${'32.5'.padStart(12)}`);
console.log(` 弹性 (m)              ${off.elastic.toFixed(1).padStart(9)} ${on.elastic.toFixed(1).padStart(12)} ${real.elastic.toFixed(1).padStart(13)} ${'31.6'.padStart(12)}`);
console.log(` n=${off.n}`);
console.log('\n判读：若 demo=OFF 的列 ≈ 入库基线（40.5/20.0/15.1/32.5），');
console.log('则基线**未被 demo 污染**，我此前测到的 press/cover/screen 层只作用在别处（或仅个别 action 名）。');
console.log('若 demo=ON 才是 40.5，则**入库基线是在 demo 层上量的**——那整个 P36/P37 标尺的引擎侧口径需要重新审视。');
