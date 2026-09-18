// P36 比赛标尺：引擎侧采样（wasm 加载 → 事件流 → Game.seekTo 定间隔采样 → 切窗 → 指标）。
//
// 供 tools/benchmark-baseline.mjs（生成冻结基线）与 tools/benchmark-compare.mjs（对比报告）
// 共用——两侧（消费方）都只见到与真实侧相同形状的统一帧，指标实现只有 viewer/match-metrics.js
// 一份（口径分叉 = 数字不可比，见 P36 design D1）。
//
// 采样方案（design D5b，两轮审阅已实测验证）：
//   引擎跑 5400s（引擎默认时长；"5 分钟"是 viewer config 传参，标尺不用）、
//   按 0.2s 读取 { players, ball }、按与真实相同的规则切 300s 窗（步长 900s）
//   → 5 种子 × 6 窗 = 30 窗（相位与真实同构；5400s 无中场死时间、不换边）。
//
// 不读引擎内部状态——只消费 seekTo 后的公开观测面（spec「引擎侧位置经采样获得」）。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BENCHMARK_SEEDS, ENGINE_DURATION_SEC, SAMPLE_INTERVAL_SEC,
  sampleEngineFrames, cutWindows, windowMetrics, summarizeWindowMetrics, elasticity,
} from '../viewer/match-metrics.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WASM_PATH = join(ROOT, 'viewer', 'engine.wasm');

export const ENGINE_CONFIG = {
  demo_mode: false,
  off_ball_movement_demo: true,
  match_duration_seconds: ENGINE_DURATION_SEC,
};

export const MISSING_WASM_HINT = `缺少 engine.wasm —— 先构建：\n`
  + '  (cd engine && cargo build --target wasm32-unknown-unknown --release)\n'
  + '  cp engine/target/wasm32-unknown-unknown/release/fm_engine.wasm viewer/engine.wasm';

// 加载 wasm 模块；文件缺失时返回 { ok:false, message }（调用方决定跳过还是报错）
export async function loadEngineWasm(wasmPath = WASM_PATH) {
  let bytes;
  try {
    bytes = readFileSync(wasmPath);
  } catch {
    return { ok: false, message: MISSING_WASM_HINT };
  }
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return { ok: true, wasm: instance.exports };
}

// 跑一个种子 → 事件流对象（engine.simulate 的 JSON 输出）
export function simulateStream(wasm, seed, durationSec = ENGINE_DURATION_SEC) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const cfg = enc.encode(JSON.stringify({ ...ENGINE_CONFIG, match_duration_seconds: durationSec }));
  const SCRATCH = 1024;
  new Uint8Array(wasm.memory.buffer, SCRATCH, cfg.length).set(cfg);
  wasm.simulate(BigInt(seed), SCRATCH, cfg.length);
  const ptr = wasm.get_json_ptr();
  const len = wasm.get_json_length();
  const text = dec.decode(new Uint8Array(wasm.memory.buffer, ptr, len));
  wasm.free_json();
  return text;
}

// 一个种子 → 逐窗指标。帧序列在切窗后即弃（省内存），返回的只是窗口指标。
export async function sampleSeedWindows(wasm, seed, { createGame } = {}) {
  const makeGame = createGame || (await import('../viewer/game.js')).createGame;
  const game = makeGame(simulateStream(wasm, seed));
  const frames = sampleEngineFrames(game);
  const windows = cutWindows(frames);
  // 引擎帧无外推标记、球场恒 105×68，故 primary === allPoints；取 primary。
  const metrics = windows.map((w) => windowMetrics(w).primary);
  const elasticities = {
    half: windows.map((w) => elasticity(w, { divider: 'half' })).filter(Boolean),
    centroid: windows.map((w) => elasticity(w, { divider: 'centroid' })).filter(Boolean),
  };
  return { seed, windowCount: windows.length, metrics, elasticities };
}

// 冻结种子集 → 引擎侧完整统计（基线生成与对比共用同一路径，两侧数字必然同源）。
export async function sampleEngineStats({ wasm, seeds = BENCHMARK_SEEDS } = {}) {
  if (!wasm) return null;
  const perSeed = [];
  for (const seed of seeds) {
    perSeed.push(await sampleSeedWindows(wasm, seed));
  }
  const allMetrics = perSeed.flatMap((s) => s.metrics);
  const summary = summarizeWindowMetrics(allMetrics);

  // 弹性：逐窗 Δ 的摘要（两侧同名同义）。样本不足的窗口已被 elasticity 过滤。
  const elasticitySummary = (key) => {
    const deltas = perSeed.flatMap((s) => s.elasticities[key].map((e) => e.delta));
    if (deltas.length === 0) return null;
    const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    return { avgDelta: avg, min: Math.min(...deltas), max: Math.max(...deltas), n: deltas.length };
  };

  return {
    seeds: [...seeds],
    nWindows: allMetrics.length,
    perMetric: summary,
    elasticity: { half: elasticitySummary('half'), centroid: elasticitySummary('centroid') },
    // 逐种子均值：观察种子间波动（ratchet 聚合规则待样本扩大后定，D5b；此处仅记录）
    perSeed: perSeed.map((s) => {
      const sm = summarizeWindowMetrics(s.metrics);
      return {
        seed: s.seed,
        hd: sm.hd && sm.hd.avg,
        ad: sm.ad && sm.ad.avg,
        spread: sm.spread && sm.spread.avg,
        gap: sm.gap && sm.gap.avg,
        width: sm.width && sm.width.avg,
      };
    }),
  };
}

export { SAMPLE_INTERVAL_SEC, ENGINE_DURATION_SEC, BENCHMARK_SEEDS };
