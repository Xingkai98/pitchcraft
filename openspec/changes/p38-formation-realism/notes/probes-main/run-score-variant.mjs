// P38 阶段 2：跑「队形变体 × 射门链变体」的组合。
//
// 为什么需要组合：阶段 2 的因果问题是「**射门崩到底是队形造成的，还是射门链自己的门造成的**」。
// 单跑一个回答不了——必须 2×2 对照：
//   ① 干净 main（基线）
//   ② 只改队形（exp4b）
//   ③ 只改射门门（passGate）
//   ④ 两者都改
// 若 ③ 就把射门救回来而 ② 崩，说明**主因在射门链**，队形是放大器；
// 若只有 ④ 能同时满足纵深+射门，说明两者都要动。
//
// ⚠️ 与 run-layer-variant.mjs 同一条硬约束：**异常也要还原**（finally）。
//
// 用法：node run-score-variant.mjs <射门变体名> <射门参数> [队形变体名|-] [标签]
//   node run-score-variant.mjs passGateMeters 5 - pg5
//   node run-score-variant.mjs passGateMeters 5 exp4b exp4b+pg5

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { findRepoRoot } from '../probes/repo-root.mjs';
import { VARIANTS, SCORE_PATCHES, applyVariant } from './layer-variants.mjs';

const ROOT = findRepoRoot(new URL('.', import.meta.url).pathname);
const scoreName = process.argv[2];
const scoreArg = process.argv[3];
const formName = process.argv[4] && process.argv[4] !== '-' ? process.argv[4] : null;
const label = process.argv[5] || `${formName || 'clean'}+${scoreName}${scoreArg}`;
const SEEDS = process.env.SEEDS || '42,1,7,99,123,2,3,5,11,17';

const scoreV = SCORE_PATCHES[scoreName];
if (!scoreV) { console.error(`未知射门变体：${scoreName}`); process.exit(1); }
const scorePatch = scoreV(Number(scoreArg));

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
  // 先叠队形，再叠射门链（两个变体改的是不同代码区，顺序无关但固定下来可复现）
  let src = original;
  if (formName) src = applyVariant(src, VARIANTS[formName]({}));
  src = scorePatch.patch(src);
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
    tag: label, form: formName || 'clean', score: scorePatch.name, scoreArg: Number(scoreArg),
    wasmSha8: sha8, ...metrics,
    layers: layers?.engine ? {
      d1: +layers.engine.d1.toFixed(2), d2: +layers.engine.d2.toFixed(2),
      layerGap: +layers.engine.layerGap.toFixed(2),
    } : null,
  };
} finally {
  writeFileSync(LIBSRC, original);
  rebuild();
  const after = readFileSync(LIBSRC, 'utf8');
  const sha = createHash('sha256').update(readFileSync(WASM)).digest('hex').slice(0, 8);
  if (after !== original) console.error('⚠⚠ 源码还原失败！');
  if (sha !== CLEAN_SHA) console.error(`⚠⚠ wasm 还原后是 ${sha}，应为 ${CLEAN_SHA}`);
}

console.log(JSON.stringify(result));
const OUT = join(ROOT, 'openspec/changes/p38-formation-realism/notes/probes-main/out');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
appendFileSync(join(OUT, 'score-gates.jsonl'), `${JSON.stringify(result)}\n`);
