// P38 线 A 变体：解耦的**作用范围**与**形状**（不只是幅度）。
//
// 动机：lag 扫描（sweep-lag.mjs）显示**单调**——滞后越大射门越多、重心间距越差。
// 说明"幅度"这一个自由度已经用尽；要同时满足「射门 ↑」与「重心间距 ↓」，必须改
// 滞后**作用在谁身上**（范围）或**怎么随球位变化**（形状）。
//
// 本脚本把三种形态都装在同一个 `formation_target` 覆盖块里，用环境变量式常量切换——
// 避免每次改代码结构导致 diff 不可比。三个旋钮：
//
//   VARIANT=scope  解耦只作用于**防线**（is_defender），中场保持与球对位。
//                  依据：真实射门瞬间是「一人贴（2.5m）、一人待命（5.4m）」两层——
//                  贴身那层来自**防线**，待命那层来自中场。全队一起滞后会把中场也推远。
//   VARIANT=curve  滞后**非线性**：球越靠前滞后越大（`lag * ball_own^k`）。
//                  依据：真实防守方在本方禁区前沿才整体回收；中场区域仍保持对位。
//   VARIANT=both   两者叠加。
//
// 用法：node sweep-variants.mjs <variant> <lag> [曲线指数] [种子列表]
// 输出：一行 JSON + 写 out/variants.jsonl（追加，供汇总）

import { readFileSync, writeFileSync, cpSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { findRepoRoot } from '../probes/repo-root.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = findRepoRoot(HERE);
const OUT = join(HERE, 'out');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const variant = process.argv[2] || 'scope';
const lag = Number(process.argv[3] || 0.10);
const curveK = Number(process.argv[4] || 2.0);
const seeds = (process.argv[5] || '42,1,7,99,123,2,3,5,11,17').split(',').map(Number);

const LIBSRC = join(ROOT, 'engine/src/lib.rs');
const WASM_DST = join(ROOT, 'viewer/engine.wasm');
const WASM_BUILT = join(ROOT, 'engine/target/wasm32-unknown-unknown/release/fm_engine.wasm');

// 候选03 已经 `git apply` 过（含 DECOUPLE_LAG 常量）。这里只替换**覆盖块**里的
// `let lag = ...` 那一行 + 常量值，保证三个变体之间只有这一个表达式不同。
const original = readFileSync(LIBSRC, 'utf8');
if (!original.includes('let lag = if my_team_is_attacking { 0.0 } else { DECOUPLE_LAG };')) {
  console.error('未找到候选03 的解耦块——先 git apply candidates/03-decouple/combined-with-equal-spacing.patch');
  process.exit(1);
}

// 三种变体的 `lag` 表达式（球位项一律用 `ball_own`，即"球离本方球门多远"）
const LAG_EXPR = {
  // 幅度扫描的基准形态（全队统一）
  base: 'let lag = if my_team_is_attacking { 0.0 } else { DECOUPLE_LAG };',
  // 只防线滞后
  scope: 'let lag = if my_team_is_attacking || !is_defender(st, id) { 0.0 } else { DECOUPLE_LAG };',
  // 非线性：球越靠前（ball_own 越大）滞后越大
  curve: 'let lag = if my_team_is_attacking { 0.0 } else { DECOUPLE_LAG * ball_own.powf(CURVE_K) };',
  // 两者叠加
  both: 'let lag = if my_team_is_attacking || !is_defender(st, id) { 0.0 } else { DECOUPLE_LAG * ball_own.powf(CURVE_K) };',
};
if (!LAG_EXPR[variant]) { console.error(`未知 variant=${variant}（可选 ${Object.keys(LAG_EXPR)}）`); process.exit(1); }

// Rust f64 字面量必须带小数点：`Number("2.0")` → 2 → 模板插值出 "2" → E0308
// （expected f64, found integer）。踩过一次，别再直接插数值。
const f = (v) => (Number.isInteger(v) ? `${v}.0` : String(v));

let src = original
  .replace('let lag = if my_team_is_attacking { 0.0 } else { DECOUPLE_LAG };', LAG_EXPR[variant])
  .replace(/pub const DECOUPLE_LAG: f64 = [\d.]+;/, `pub const DECOUPLE_LAG: f64 = ${f(lag)};`);
if (variant === 'curve' || variant === 'both') {
  // 曲线指数：插在常量旁边（同一次编辑，避免二次匹配失败）
  src = src.replace(
    /pub const DECOUPLE_LAG: f64 = [\d.]+;/,
    `pub const DECOUPLE_LAG: f64 = ${f(lag)};\n#[allow(dead_code)]\npub const CURVE_K: f64 = ${f(curveK)};`,
  );
}
// `finally` 必须真的跑到——`process.exit()` **不会**执行 finally，会留下改过的 lib.rs
// （踩过一次：build 失败 → exit → 文件停在改过的状态 → 后续 run 全部 "未找到锚点"，
// 看起来像"补丁没打上"，实际是上一轮的残留）。一律用 throw，让 finally 收尾。
writeFileSync(LIBSRC, src);
try {
  const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };
  const build = spawnSync('cargo', ['build', '--target', 'wasm32-unknown-unknown', '--release'],
    { cwd: join(ROOT, 'engine'), encoding: 'utf8', env });
  if (build.status !== 0) {
    throw new Error(`build 失败：\n${(build.stderr || build.stdout || '').slice(-3000)}`);
  }
  cpSync(WASM_BUILT, WASM_DST, { force: true });
  const sha8 = createHash('sha256').update(readFileSync(WASM_DST)).digest('hex').slice(0, 8);

  const run = spawnSync('node', [join(HERE, 'p38-eval.mjs'), `${variant}-${lag}`, seeds.join(',')],
    { cwd: ROOT, encoding: 'utf8' });
  if (run.status !== 0) { throw new Error(run.stderr?.slice(-2000)); }
  const r = JSON.parse(run.stdout.trim().split('\n').pop());
  Object.assign(r, { variant, lag, curveK, wasmSha8: sha8 });
  appendFileSync(join(OUT, 'variants.jsonl'), `${JSON.stringify(r)}\n`);
  console.log(`[${variant} lag=${lag} k=${curveK}] hd=${r.hd} gap=${r.gap} latSd=${r.latSd} swarm=${r.swarm}`
    + ` shotsReg=${r.shotsRegularPerMatch} shotsHdr=${r.shotsHeaderPerMatch} fault=${r.fault} midBack=${r.midBack} nSeeds=${r.nSeeds} sha=${sha8}`);
} finally {
  writeFileSync(LIBSRC, original); // 硬约束 2
}
