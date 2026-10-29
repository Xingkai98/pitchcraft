// C3 行为等价证明（main vs feat/render-fixes-to-main）：
// 同一 seed 集、同一 config 模拟两次，掩掉所有 "speed":<num> 字段后逐字节比较事件流。
// 判据：掩 speed 后两条流逐字节相同 ⇒ 位置/决策/时间戳/计数全部逐位不变；speed 是唯一差异面。
import { readFileSync } from 'node:fs';

const [mainWasmPath, branchWasmPath] = process.argv.slice(2);
const SEEDS = [...Array.from({ length: 40 }, (_, i) => i + 1), 42, 99, 123, 317, 1000];
const DURATION = 5400;

async function load(p) {
  const bytes = readFileSync(p);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function simulate(wasm, seed) {
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

const SPEED_RE = /"speed":-?\d+(?:\.\d+)?/g;
const mask = (s) => s.replace(SPEED_RE, '"speed":0'); // 与 realism.rs::mask_speed_fields 逐字一致（2026-10-29 审阅修复后）

function fnv1a(str) {
  let h = 0xcbf29ce484222325n;
  const buf = Buffer.from(str, 'utf8');
  for (const b of buf) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

// 附加统计：pass 事件的「上报飞行时长 = 距离/speed」分布（证明 speed 改写落在哪）
function passFlightStats(json) {
  const events = JSON.parse(json);
  const flights = [];
  for (const e of events) {
    if (e.type !== 'pass') continue;
    if (typeof e.x2 !== 'number' || typeof e.speed !== 'number' || !(e.speed > 0)) continue;
    const dx = (e.x2 - e.x) * 105;
    const dy = (e.y2 - e.y) * 68;
    flights.push(Math.hypot(dx, dy) / e.speed);
  }
  flights.sort((a, b) => a - b);
  const q = (p) => (flights.length ? flights[Math.min(flights.length - 1, Math.floor(p * (flights.length - 1)))] : NaN);
  return {
    n: flights.length,
    p10: q(0.1), p50: q(0.5), p90: q(0.9), max: flights[flights.length - 1],
    nAt095: flights.filter((f) => Math.abs(f - 0.95) < 5e-3).length,
    nBelow095: flights.filter((f) => f < 0.95 - 5e-3).length,
  };
}

const mainWasm = await load(mainWasmPath);
const branchWasm = await load(branchWasmPath);

const rows = [];
let allMaskedEqual = true;
let allRawDiffer = true;
let totalSpeedFields = 0;
const agg = { main: [], branch: [] };

for (const seed of SEEDS) {
  const rawMain = simulate(mainWasm, seed);
  const rawBranch = simulate(branchWasm, seed);
  const maskedMain = mask(rawMain);
  const maskedBranch = mask(rawBranch);
  const maskedEqual = maskedMain === maskedBranch;
  const rawEqual = rawMain === rawBranch;
  const nSpeed = (rawBranch.match(SPEED_RE) || []).length;
  totalSpeedFields += nSpeed;
  if (!maskedEqual) allMaskedEqual = false;
  if (rawEqual) allRawDiffer = false;
  const stM = passFlightStats(rawMain);
  const stB = passFlightStats(rawBranch);
  agg.main.push(stM);
  agg.branch.push(stB);
  rows.push({
    seed,
    rawEqual,
    maskedEqual,
    hashRawMain: fnv1a(rawMain),
    hashRawBranch: fnv1a(rawBranch),
    hashMasked: fnv1a(maskedBranch),
    nSpeedFields: nSpeed,
    passFlightsMain: { p50: +stM.p50.toFixed(4), nBelow095: stM.nBelow095 },
    passFlightsBranch: { p50: +stB.p50.toFixed(4), nAt095: stB.nAt095, nBelow095: stB.nBelow095 },
  });
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const summary = {
  seeds: SEEDS,
  duration: DURATION,
  totalSpeedFields,
  allRawDiffer,
  allMaskedEqual,
  mainFlightP50Mean: +mean(agg.main.map((s) => s.p50)).toFixed(4),
  branchFlightP50Mean: +mean(agg.branch.map((s) => s.p50)).toFixed(4),
  mainBelow095Total: agg.main.reduce((a, s) => a + s.nBelow095, 0),
  branchBelow095Total: agg.branch.reduce((a, s) => a + s.nBelow095, 0),
  branchAt095Total: agg.branch.reduce((a, s) => a + s.nAt095, 0),
};
console.log(JSON.stringify({ summary, rows }, null, 2));
