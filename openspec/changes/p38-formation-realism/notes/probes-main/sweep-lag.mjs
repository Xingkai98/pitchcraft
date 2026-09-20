// P38 线 A：`DECOUPLE_LAG` 通道扫描（候选03 / 票据 #89 的核心参数）。
//
// 前置：`candidates/03-decouple/combined-with-equal-spacing.patch` 已 `git apply`
//       （即 engine/src/lib.rs 里已有 `pub const DECOUPLE_LAG: f64 = 0.10;`）。
//
// 本脚本**逐值改写那一行常量 → 重建 wasm → 跑 p38-eval → 收集一行 JSON**，
// 结束后**不改回**（调用方负责 `git checkout engine/src/lib.rs` 还原）。
//
// 用法：
//   node sweep-lag.mjs 0.03,0.05,0.08,0.10,0.14,0.20,0.28 [seed列表] [时长秒]
//
// 输出：JSON 数组落到 stdout；同时写 `out/lag-sweep.json`（供画曲线与复现）。
//
// 复现性：wasm 从**本 worktree** 的 lib.rs 重建（不是共享 worktree 的旧产物）。
//   每次重建后记录 sha256 前 8 位，写进结果——跨会话引用时能核对。

import { readFileSync, writeFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { findRepoRoot } from '../probes/repo-root.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = findRepoRoot(HERE);
const OUT = join(HERE, 'out');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const LIBSRC = join(ROOT, 'engine/src/lib.rs');
const WASM_DST = join(ROOT, 'viewer/engine.wasm');
const WASM_BUILT = join(ROOT, 'engine/target/wasm32-unknown-unknown/release/fm_engine.wasm');

const lags = (process.argv[2] || '0.03,0.05,0.08,0.10,0.14,0.20,0.28').split(',').map(Number);
// 10 个种子：BENCHMARK_SEEDS 的 5 个 + 5 个补充——射门数是噪声最大的量
// （基线 5 种子上 5–9/场），单点 sem≈0.7 会盖住 1.5 球的差；扩容到 10 降到 ≈0.5。
const seeds = (process.argv[3] || '42,1,7,99,123,2,3,5,11,17').split(',').map(Number);
const durationSec = Number(process.argv[4] || 5400);

const sha8 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 8);

// 保留原文件，任何异常都要能还原（调用方还会再 git checkout 一次兜底）
const original = readFileSync(LIBSRC, 'utf8');
if (!/pub const DECOUPLE_LAG: f64 = [\d.]+;/.test(original)) {
  console.error('lib.rs 里没有 `pub const DECOUPLE_LAG: f64 = ...;`——先 git apply 候选03 的补丁');
  process.exit(1);
}
// 备份留在 /tmp（不入库）：`out/` 是**结论数据**目录，塞一个 537KB 的源码副本会
// 让人以为它是产物。真正需要回溯时 `candidates/03-decouple/*.patch` 就是源。
const BACKUP = join(tmpdir(), `p38-lib.rs.before-sweep-${process.pid}`);
cpSync(LIBSRC, BACKUP, { force: true });

const rows = [];
try {
  for (const lag of lags) {
    const patched = original.replace(
      /pub const DECOUPLE_LAG: f64 = [\d.]+;/,
      `pub const DECOUPLE_LAG: f64 = ${lag};`,
    );
    writeFileSync(LIBSRC, patched);

    // PATH 里默认没有 cargo（见 CLAUDE.md 记录）
    const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };
    const build = spawnSync('cargo', ['build', '--target', 'wasm32-unknown-unknown', '--release'],
      { cwd: join(ROOT, 'engine'), encoding: 'utf8', env });
    if (build.status !== 0) {
      console.error(`build 失败 @ lag=${lag}\n${build.stderr?.slice(-2000)}`);
      process.exit(1);
    }
    cpSync(WASM_BUILT, WASM_DST, { force: true });

    const run = spawnSync('node', [join(HERE, 'p38-eval.mjs'), `lag${lag}`, seeds.join(','), String(durationSec)],
      { cwd: ROOT, encoding: 'utf8' });
    if (run.status !== 0) {
      console.error(`eval 失败 @ lag=${lag}\n${run.stderr?.slice(-2000)}`);
      process.exit(1);
    }
    const r = JSON.parse(run.stdout.trim().split('\n').pop());
    r.lag = lag;
    r.wasmSha8 = sha8(WASM_DST);
    rows.push(r);
    console.log(`lag=${lag}  hd=${r.hd}  gap=${r.gap}  latSd=${r.latSd}  swarm=${r.swarm}`
      + `  shots=${r.shotsPerMatch}  goals=${r.goalsPerMatch}  [${r.wasmSha8}]`);
  }
} finally {
  // 还原（即便中途抛错）——硬约束 2：改动只以 .patch 存盘
  writeFileSync(LIBSRC, original);
}

// **合并写回**（不是覆盖）：脚本支持只跑几个 lag 补点（如 `sweep-lag.mjs 0.10`），
// 覆盖会把之前跑的其他 lag 全丢掉——踩过一次（补跑单点把 15 行扫成 1 行，
// 且已经过了 §2 的表，只能重跑）。按 lag 去重合并，新结果覆盖同 lag 的旧结果。
const dst = join(OUT, 'lag-sweep.json');
const prev = existsSync(dst) ? JSON.parse(readFileSync(dst, 'utf8')).rows || [] : [];
const byLag = new Map(prev.map((r) => [r.lag, r]));
for (const r of rows) byLag.set(r.lag, r);
const merged = [...byLag.values()].sort((a, b) => a.lag - b.lag);
writeFileSync(dst, `${JSON.stringify({ seeds, durationSec, rows: merged }, null, 2)}\n`);
console.log(`\n→ ${dst}  （本次 ${rows.length} 行 + 既有 ${prev.length} 行 → 合并 ${merged.length} 行）`);
