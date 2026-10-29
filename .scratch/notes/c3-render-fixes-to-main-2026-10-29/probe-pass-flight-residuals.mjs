// C3 残余分类探针（2026-10-29 审阅 P1.1 的证据脚本）：
// 统计「上报飞行时长 distance/speed < 0.95s − 5e-3」的 pass 还有多少条、按 detail 分类。
// 口径：只看 type==="pass"（kickoff 是 type==="kickoff"，不在 pass 统计里）；距离用序列化
// 后的 x/y/x2/y2（4 位小数）与 105×68 米制；speed 是 {:.1} 序列化值。
// 明确无法判定的边界：距离 < 0.52m 的 pass 不进填拍域（0.5m 守卫 + 坐标量化），单独计数。
//
// 用法：node probe-pass-flight-residuals.mjs <wasm> [nSeeds=300]
import { readFileSync } from 'node:fs';

const [wasmPath, nArg] = process.argv.slice(2);
const N = Number(nArg || 300);
const DURATION = 5400;
const FILL = 0.95;
const EPS = 5e-3;

const bytes = readFileSync(wasmPath);
const { instance } = await WebAssembly.instantiate(bytes, {});
const wasm = instance.exports;
const enc = new TextEncoder();
const dec = new TextDecoder();

function simulate(seed) {
  const cfg = enc.encode(JSON.stringify({ match_duration_seconds: DURATION }));
  const SCRATCH = 1024;
  new Uint8Array(wasm.memory.buffer, SCRATCH, cfg.length).set(cfg);
  wasm.simulate(BigInt(seed), SCRATCH, cfg.length);
  const ptr = wasm.get_json_ptr();
  const len = wasm.get_json_length();
  const text = dec.decode(new Uint8Array(wasm.memory.buffer, ptr, len));
  wasm.free_json();
  return text;
}

const byDetail = new Map();
const violByDetail = new Map();
let nPass = 0;
let nResidual = 0;      // 原始口径：序列化 flight < 0.95 − 5e-3（含 speed {:.1} 量化噪声）
let nViolation = 0;     // 真违例：0.95·speed − 距离 > 0.06m 且距离 ≥ 0.52m（见 realism.rs PASS_FLIGHT_QUANT_EPS_M）
let nShortUnfillable = 0; // 距离 < 0.52m：填拍域外（0.5m 守卫 + 量化）
let worst = { abs: -1 };
let worstGap = { gap: -1 };
const distances = [];

for (let seed = 1; seed <= N; seed++) {
  const events = JSON.parse(simulate(seed));
  for (const e of events) {
    if (e.type !== 'pass') continue;
    if (typeof e.x2 !== 'number' || typeof e.y2 !== 'number' || !(e.speed > 0)) continue;
    nPass++;
    const dx = (e.x2 - e.x) * 105;
    const dy = (e.y2 - e.y) * 68;
    const dist = Math.hypot(dx, dy);
    const flight = dist / e.speed;
    const key = e.detail || '(none)';
    if (flight < FILL - EPS) {
      nResidual++;
      distances.push(dist);
      byDetail.set(key, (byDetail.get(key) || 0) + 1);
      const abs = Math.abs(flight - FILL);
      if (abs > worst.abs) worst = { abs: +abs.toFixed(4), seed, detail: key, speed: e.speed, dist: +dist.toFixed(3), flight: +flight.toFixed(4) };
    }
    if (dist >= 0.52) {
      const gap = FILL * e.speed - dist; // >0 表示球「太早到」，0.06 内算量化噪声
      if (gap > 0.06) {
        nViolation++;
        violByDetail.set(key, (violByDetail.get(key) || 0) + 1);
        if (gap > worstGap.gap) worstGap = { gap: +gap.toFixed(3), seed, detail: key, speed: e.speed, dist: +dist.toFixed(3), flight: +flight.toFixed(4) };
      }
    } else {
      nShortUnfillable++;
    }
  }
}

distances.sort((a, b) => a - b);
const q = (p) => (distances.length ? distances[Math.min(distances.length - 1, Math.floor(p * (distances.length - 1)))] : NaN);
console.log(JSON.stringify({
  wasm: wasmPath,
  seeds: N,
  duration: DURATION,
  nPass,
  nResidual,
  nViolation,
  nShortUnfillable,
  residualByDetail: Object.fromEntries([...byDetail.entries()].sort((a, b) => b[1] - a[1])),
  violationByDetail: Object.fromEntries([...violByDetail.entries()].sort((a, b) => b[1] - a[1])),
  residualDistanceM: distances.length ? { min: +distances[0].toFixed(3), q01: +q(0.01).toFixed(3), q50: +q(0.5).toFixed(3), max: +distances.at(-1).toFixed(3) } : null,
  worst,
  worstGap,
}, null, 2));
