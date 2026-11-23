// Phase 0 性能 smoke（P1 / tasks 2.8 & 2.13 第一刀）。
//
// 只测 **v11 同配置**（引擎 = main，wasm 现构建）的**分母**：C1 的「活体 5×+规划」尚未实现，
// 这里不冒充它的读数。测量口径与 viewer 实际链路一致：
//   simulateStream（wasm 产事件流 JSON）→ JSON.parse → createGame（建索引）→ seekTo + 读状态。
//
// 用法：node openspec/changes/p1-motion-integration/notes/probes/perf-smoke.mjs <engine.wasm> [--out file.json]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const wasmPath = process.argv[2];
if (!wasmPath || wasmPath.startsWith('--')) {
  console.error('用法: node perf-smoke.mjs <engine.wasm> [--out file.json]');
  process.exit(2);
}
const outArgIdx = process.argv.indexOf('--out');
const outPath = outArgIdx >= 0 ? resolve(process.argv[outArgIdx + 1]) : null;

const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
const { createGame } = await import(join(ROOT, 'viewer/game.js'));

const ms = (t0) => (performance.now() - t0);
// Node 的 memoryUsage 单位是字节；/1024/1024 = MiB（与 1e6 字节的 MB 区分，别混写）。
const rssMiB = () => process.memoryUsage().rss / 1024 / 1024;
const heapMiB = () => process.memoryUsage().heapUsed / 1024 / 1024;

// wasm 实例化耗时（与 loadEngineWasm 内部同一条路径；单次受 JIT/页缓存影响大，取 5 次中位）。
const instRuns = [];
for (let i = 0; i < 5; i += 1) {
  const ti = performance.now();
  await WebAssembly.instantiate(readFileSync(wasmPath), {});
  instRuns.push(ms(ti));
}
instRuns.sort((a, b) => a - b);
const wasmInstantiateMs = { n: instRuns.length, median: instRuns[Math.floor(instRuns.length / 2)], min: instRuns[0], max: instRuns[instRuns.length - 1], runs: instRuns };

const { wasm, ok, message } = await loadEngineWasm(wasmPath);
if (!ok) throw new Error(message || `无法加载 wasm：${wasmPath}`);

const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  wasmPath,
  wasmInstantiateMs,
  wasmSha256: (await import('node:crypto')).createHash('sha256').update(readFileSync(wasmPath)).digest('hex'),
  note: 'v11（main）同配置分母；不是 C1 的「5×+规划」读数。RSS 为 Node 进程自报；峰值另读 /proc/self/status 的 VmHWM。',
  samples: {},
};

for (const [label, durationSec, seekN] of [['5min', 300, 300], ['90min', 5400, 1000]]) {
  const r = { durationSec };
  // 冷启动：每次重新加载 wasm 不现实；这里同进程顺序跑，前面的模拟会预热 wasm 实例。
  // 为了让 5min 是「冷」口径，5min 先跑。90min 标注 warm。
  let t = performance.now();
  const json = simulateStream(wasm, 42, durationSec);
  r.simulateMs = ms(t);
  r.jsonBytes = Buffer.byteLength(json, 'utf8');
  t = performance.now();
  const events = JSON.parse(json);
  r.parseMs = ms(t);
  r.eventCount = Object.keys(events).length;
  t = performance.now();
  const game = createGame(json);
  r.createGameMs = ms(t);
  r.matchEnd = game.matchEnd;
  // seek + 读状态：确定性等距采样（不依赖 RNG）。
  const seekMs = [];
  for (let i = 0; i < seekN; i += 1) {
    const tt = (i + 0.5) / seekN * durationSec;
    const a = performance.now();
    game.seekTo(tt);
    // 「帧」= 一次 seekTo 后读取画面需要的公开观测面（与 sampleEngineFrames 同量）。
    const frame = { players: game.players.length, ball: [game.ball.x, game.ball.y] };
    const b = performance.now();
    seekMs.push(b - a);
    if (frame.players === 0) throw new Error('seek 后 players 为空');
  }
  seekMs.sort((a, b) => a - b);
  const mean = seekMs.reduce((s, x) => s + x, 0) / seekMs.length;
  const p = (q) => seekMs[Math.min(seekMs.length - 1, Math.floor(q * (seekMs.length - 1)))];
  r.seekAndReadFrame = { n: seekMs.length, meanMs: mean, p50Ms: p(0.5), p95Ms: p(0.95), maxMs: seekMs[seekMs.length - 1] };
  r.rssMiB = rssMiB();
  r.heapUsedMiB = heapMiB();
  report.samples[label] = r;
  // 释放以便下一档（提醒：JS GC 不保证立刻归还 RSS，故 90min 的 RSS 是峰值上界）。
  global.gc?.();
}

// 逐档内存：90min 档后 RSS + 脚本末尾从 /proc/self/status 读 VmHWM（峰值常驻）。
report.rssAfterAllMiB = rssMiB();
// Linux 峰值 RSS（VmHWM），替代缺失的 /usr/bin/time -v。
try {
  const status = readFileSync('/proc/self/status', 'utf8');
  const hwm = /VmHWM:\s+(\d+) kB/.exec(status);
  // 只取 VmHWM（峰值常驻内存）；VmPeak 是虚拟地址空间（含 wasm 预留），不是内存占用，不报。
  report.peakRssMiB = hwm ? Number(hwm[1]) / 1024 : null;
} catch { /* 非 Linux：忽略 */ }
console.log(JSON.stringify(report, null, 2));
if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`\nJSON → ${outPath}`);
}
