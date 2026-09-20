// 跑一个防守分层变体：改源码 → 重建 wasm → 判据组 + 射门 + 防守分层剖面 → **还原**。
//
// ⚠️ **异常也要还原**（try/finally）：本脚本在本轮开发中真的崩过一次，
// 崩后 `engine/src/lib.rs` 留在改动状态、wasm 也是脏的——正是 P38 明令禁止的
// "实验完不还原"。还原放进 `finally`，任何路径（含抛异常、被 kill 前的正常退出）都执行。
//
// 用法：node run-layer-variant.mjs <变体名> [JSON 参数] [标签]
//   node run-layer-variant.mjs defendLayers '{"pressN":2,"holdM":6}' my-label
// 环境：SEEDS=42,1,7,...（缺省判据组的 10 种子）

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { findRepoRoot } from '../probes/repo-root.mjs';
import { VARIANTS, applyVariant } from './layer-variants.mjs';

const ROOT = findRepoRoot(new URL('.', import.meta.url).pathname);
const variant = process.argv[2];
const params = process.argv[3] && process.argv[3] !== '-' ? JSON.parse(process.argv[3]) : {};
const label = process.argv[4] || `${variant}`;
const SEEDS = process.env.SEEDS || '42,1,7,99,123,2,3,5,11,17';

if (!VARIANTS[variant]) { console.error(`未知变体：${variant}（有 ${Object.keys(VARIANTS).join(', ')}）`); process.exit(1); }

const LIBSRC = join(ROOT, 'engine/src/lib.rs');
const WASM = join(ROOT, 'viewer/engine.wasm');
const BUILT = join(ROOT, 'engine/target/wasm32-unknown-unknown/release/fm_engine.wasm');
const CARGO = `${process.env.HOME}/.cargo/bin/cargo`;
const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };
const original = readFileSync(LIBSRC, 'utf8');
// 干净 main 的指纹（阶段 1 记录：901da77b）——还原后比对，确认真的回干净了
const CLEAN_SHA = process.env.CLEAN_SHA || '901da77b';

const rebuild = () => {
  const r = spawnSync(CARGO, ['build', '--target', 'wasm32-unknown-unknown', '--release'],
    { cwd: join(ROOT, 'engine'), env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`构建失败：\n${(r.stderr || '').slice(-2000)}`);
  spawnSync('cp', [BUILT, WASM]);
};

const srcBefore = readFileSync(LIBSRC, 'utf8');
let result = null;
try {
  const patched = applyVariant(original, VARIANTS[variant](params));
  if (patched === original) throw new Error('变体未改变源码——锚点没命中，静默不生效');
  writeFileSync(LIBSRC, patched);
  rebuild();
  const sha8 = createHash('sha256').update(readFileSync(WASM)).digest('hex').slice(0, 8);

  const ev = spawnSync('node', [
    join(ROOT, 'openspec/changes/p38-formation-realism/notes/criteria/eval-criteria.mjs'), label,
  ], { env: { ...env, CRITERIA_SEEDS: SEEDS }, encoding: 'utf8' });
  if (ev.status !== 0) throw new Error(`评测失败：${ev.stdout}\n${ev.stderr}`);
  const metrics = JSON.parse(ev.stdout.trim().split('\n').pop());

  const ly = spawnSync('node', [
    join(ROOT, 'openspec/changes/p38-formation-realism/notes/probes-main/probe-defense-layers.mjs'), label,
  ], { env: { ...env, SEEDS }, encoding: 'utf8' });
  const line = ly.stdout.trim().split('\n').find((l) => l.startsWith('JSON '));
  const layers = line ? JSON.parse(line.slice(5)) : null;

  result = {
    tag: label, variant, params, wasmSha8: sha8,
    ...metrics,
    layers: layers?.engine ? {
      d1: +layers.engine.d1.toFixed(2), d2: +layers.engine.d2.toFixed(2),
      d3: +layers.engine.d3.toFixed(2), layerGap: +layers.engine.layerGap.toFixed(2),
    } : null,
    // 真实参照（probe-defense-layers 每次都会重算，此处只记游戏 1 便于对照）
    realRef: layers?.real ? { d1: layers.real.d1, d2: layers.real.d2, layerGap: layers.real.layerGap } : null,
  };
} finally {
  // 无条件还原：源码 + 干净 wasm
  writeFileSync(LIBSRC, original);
  rebuild();
  const after = readFileSync(LIBSRC, 'utf8');
  const sha = createHash('sha256').update(readFileSync(WASM)).digest('hex').slice(0, 8);
  // 还原失败要**大声**——静默地把脏源码留在树上是 P38 栽过两次的坑
  if (after !== srcBefore) console.error('⚠⚠ 源码还原后与运行前不一致！');
  if (sha !== CLEAN_SHA) console.error(`⚠⚠ wasm 还原后是 ${sha}，应为 ${CLEAN_SHA}`);
}

console.log(JSON.stringify(result));
appendFileSync(join(ROOT, 'openspec/changes/p38-formation-realism/notes/probes-main/out/layers.jsonl'),
  `${JSON.stringify(result)}\n`);
