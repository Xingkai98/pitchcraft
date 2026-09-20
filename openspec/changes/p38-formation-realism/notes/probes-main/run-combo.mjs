// P38 阶段 2：**任意队形变体 × 任意射门链变体**的组合跑（2×2 对照的通用形）。
//
// 与 run-layer-variant / run-score-variant 的区别：那两个各固定一侧；本脚本两侧都可空，
// 用来跑「分层防守 + 修正射门门」这类**假设检验**组合——
//   用户的假设是"防守分层能让贴身下仍有空间"。但阶段 2 实测发现射手身边的防守者
//   **本来就不近**（exp4b d1=8.3m vs 真实 2.0–2.9m），所以分层假设需要**在射门链修好之后**
//   再测一次才算公平：若那时分层仍无增益，假设就是错的，而不是"被别的缺陷掩盖"。
//
// 用法：node run-combo.mjs <队形变体|-[:参数JSON]> <射门变体|-[:参数]> <标签>
//   node run-combo.mjs defendLayers:{"pressN":2} passGateMeters:3 layers+pg3
// 环境：SEEDS=

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { findRepoRoot } from '../probes/repo-root.mjs';
import { VARIANTS, SCORE_PATCHES, applyVariant } from './layer-variants.mjs';

const ROOT = findRepoRoot(new URL('.', import.meta.url).pathname);
// ⚠️ 只按**第一个**冒号切（`s.split(':')` 会把 JSON 里的每个冒号也切开——
// 那是本脚本第一次跑就崩的原因）。JSON 参数里必然有冒号。
const parse = (s) => {
  if (!s || s === '-') return null;
  const i = s.indexOf(':');
  if (i < 0) return { name: s, params: {} };
  return { name: s.slice(0, i), params: JSON.parse(s.slice(i + 1)) };
};
const form = parse(process.argv[2]);
const score = parse(process.argv[3]);
const label = process.argv[4] || `${process.argv[2]}_${process.argv[3]}`;
const SEEDS = process.env.SEEDS || '42,1,7,99,123,2,3,5,11,17';

const LIBSRC = join(ROOT, 'engine/src/lib.rs');
const WASM = join(ROOT, 'viewer/engine.wasm');
const BUILT = join(ROOT, 'engine/target/wasm32-unknown-unknown/release/fm_engine.wasm');
const CARGO = `${process.env.HOME}/.cargo/bin/cargo`;
const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };
const original = readFileSync(LIBSRC, 'utf8');
const CLEAN_SHA = process.env.CLEAN_SHA || '901da77b';

const rebuild = () => {
  const r = spawnSync(CARGO, ['build', '--target', 'wasm32-unknown-unknown', '--release'],
    { cwd: join(ROOT, 'engine'), env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`构建失败：\n${(r.stderr || '').slice(-2000)}`);
  spawnSync('cp', [BUILT, WASM]);
};

let result = null;
try {
  let src = original;
  if (form) {
    if (!VARIANTS[form.name]) throw new Error(`未知队形变体 ${form.name}`);
    src = applyVariant(src, VARIANTS[form.name](form.params));
  }
  if (score) {
    if (!SCORE_PATCHES[score.name]) throw new Error(`未知射门变体 ${score.name}`);
    src = SCORE_PATCHES[score.name](score.params.meters).patch(src);
  }
  if (src === original) throw new Error('组合后源码未变——锚点没命中');
  writeFileSync(LIBSRC, src);
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
    tag: label, form: process.argv[2] || 'clean', score: process.argv[3] || 'clean',
    wasmSha8: sha8, ...metrics,
    layers: layers?.engine ? {
      d1: +layers.engine.d1.toFixed(2), d2: +layers.engine.d2.toFixed(2),
      layerGap: +layers.engine.layerGap.toFixed(2),
    } : null,
  };
} finally {
  writeFileSync(LIBSRC, original);
  rebuild();
  const sha = createHash('sha256').update(readFileSync(WASM)).digest('hex').slice(0, 8);
  if (readFileSync(LIBSRC, 'utf8') !== original) console.error('⚠⚠ 源码还原失败！');
  if (sha !== CLEAN_SHA) console.error(`⚠⚠ wasm 还原后是 ${sha}，应为 ${CLEAN_SHA}`);
}

console.log(JSON.stringify(result));
const OUT = join(ROOT, 'openspec/changes/p38-formation-realism/notes/probes-main/out');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
appendFileSync(join(OUT, 'combos2.jsonl'), `${JSON.stringify(result)}\n`);
