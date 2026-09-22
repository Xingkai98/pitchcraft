// P104：大样本副作用扫描——角球单场 max / 远距抢断（`far==0` 结构断言）/ 门球。
//
// 为什么要 3000 场：角球单场最大值是**极值统计量**，200 场的 max 系统性低于 3000 场
// （grill 已证：干净 main 200 场 max=9，3000 场 max=12）。用 200 场去给上界定值会低估。
//
// 口径逐字对齐 `engine/tests/realism.rs`：
//   - 角球 = `pass` 且 `detail=="corner"`
//   - `far` 抢断 = 事件内 (x,y)↔(x2,y2) 米制距离 > `TACKLE_DISTANCE_THRESHOLD_METERS`(12m)
//   - 门球 = `pass` 无 `to` 且无 `lead` 且 subject ∈ {0,21}（`start_goal_kick` 的唯一形态）
//
// 用法：node big-sample.mjs [--seeds 3000] [--from 401] [--workers 4]

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
export function findRepoRoot(start) {
  let d = resolve(start);
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(d, 'package.json')) && existsSync(join(d, 'viewer/match-metrics.js'))) return d;
    const u = dirname(d); if (u === d) break; d = u;
  }
  throw new Error('未找到仓库根');
}
const PL = 105.0, PW = 68.0, TACKLE_THRESHOLD_M = 12.0, DUR = 5400.0;

export function scanEvents(ev) {
  let corner = 0, far = 0, gk = 0, tackle = 0;
  for (const e of ev) {
    if (e.type === 'pass') {
      if (e.detail === 'corner') corner += 1;
      if (typeof e.to !== 'number' && typeof e.lead !== 'number' && (e.subject === 0 || e.subject === 21)) gk += 1;
    } else if (e.type === 'tackle') {
      tackle += 1;
      const d = Math.hypot((e.x - e.x2) * PL, (e.y - e.y2) * PW);
      if (d > TACKLE_THRESHOLD_M) far += 1;
    }
  }
  return { corner, far, gk, tackle };
}

const IS_ENTRY = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (!isMainThread) {
  const { seeds, wasmPath, root } = workerData;
  const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {});
  const { simulateStream } = await import(join(root, 'tools/benchmark-engine.mjs'));
  const rows = [];
  for (const s of seeds) {
    try { rows.push(scanEvents(JSON.parse(simulateStream(instance.exports, s, DUR)))); } catch { /* 崩溃种子跳过 */ }
  }
  parentPort.postMessage(rows);
} else if (IS_ENTRY) {
  const argv = process.argv.slice(2);
  const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const N = Number(argOf('--seeds', '3000'));
  const FROM = Number(argOf('--from', '401'));
  const WORKERS = Number(argOf('--workers', String(Math.max(1, Math.min(4, os.cpus().length)))));
  const ROOT = findRepoRoot(HERE);
  const WASM = join(ROOT, 'viewer/engine.wasm');
  const all = Array.from({ length: N }, (_, i) => FROM + i);
  const chunks = Array.from({ length: WORKERS }, () => []);
  all.forEach((s, i) => chunks[i % WORKERS].push(s));
  const res = await Promise.all(chunks.filter((c) => c.length).map((seeds) => new Promise((ok, no) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { seeds, wasmPath: WASM, root: ROOT } });
    w.on('message', (r) => { ok(r); w.terminate(); });
    w.on('error', no);
  })));
  const rows = res.flat();
  const corners = rows.map((r) => r.corner).sort((a, b) => a - b);
  const n = rows.length;
  const out = {
    matches: n, seedsFrom: FROM,
    cornerMean: +(corners.reduce((a, b) => a + b, 0) / n).toFixed(3),
    cornerMedian: corners[Math.floor((n - 1) * 0.5)],
    cornerP90: corners[Math.floor((n - 1) * 0.9)],
    cornerP99: corners[Math.floor((n - 1) * 0.99)],
    cornerMax: corners[n - 1],
    cornerOver12: +(corners.filter((x) => x > 12).length / n * 100).toFixed(3),
    cornerOver14: +(corners.filter((x) => x > 14).length / n * 100).toFixed(3),
    cornerOver15: +(corners.filter((x) => x > 15).length / n * 100).toFixed(3),
    farTackles: rows.reduce((a, r) => a + r.far, 0),
    tackles: rows.reduce((a, r) => a + r.tackle, 0),
    goalKicksPerMatch: +(rows.reduce((a, r) => a + r.gk, 0) / n).toFixed(3),
  };
  console.log(JSON.stringify(out));
}
