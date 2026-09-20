// P38 #89：给一个门变体渲染轨迹图（必须看图——本 campaign 三次"数字达标但画面更差"都是看图发现的）。
//
// 与 run-exp89 同一套还原纪律：无论成败，finally 里还原 lib.rs + 重建 wasm，并核对 sha256。
//
// 用法：node render-exp89.mjs <队形变体|-> <门变体|-> <out.png> <标签> [窗口秒]

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { findRepoRoot } from '../probes/repo-root.mjs';
import { VARIANTS, applyVariant } from './layer-variants.mjs';
import { EXP89_PATCHES } from './exp89-variants.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = findRepoRoot(HERE);
const parse = (s) => {
  if (!s || s === '-') return null;
  const i = s.indexOf(':');
  return i < 0 ? { name: s, params: {} } : { name: s.slice(0, i), params: JSON.parse(s.slice(i + 1)) };
};
const form = parse(process.argv[2]);
const gate = parse(process.argv[3]);
const outPath = process.argv[4] || '/tmp/exp89.png';
const label = process.argv[5] || 'exp89';
const win = process.argv[6] || '120';

const LIBSRC = join(ROOT, 'engine/src/lib.rs');
const WASM = join(ROOT, 'viewer/engine.wasm');
const BUILT = join(ROOT, 'engine/target/wasm32-unknown-unknown/release/fm_engine.wasm');
const CARGO = `${process.env.HOME}/.cargo/bin/cargo`;
const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };
const original = readFileSync(LIBSRC, 'utf8');
const CLEAN_SHA = process.env.CLEAN_SHA || '901da77b';
const sha8 = () => createHash('sha256').update(readFileSync(WASM)).digest('hex').slice(0, 8);
const rebuild = () => {
  const r = spawnSync(CARGO, ['build', '--target', 'wasm32-unknown-unknown', '--release'],
    { cwd: join(ROOT, 'engine'), env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`构建失败：\n${(r.stderr || '').slice(-2000)}`);
  spawnSync('cp', [BUILT, WASM]);
};

try {
  let src = original;
  if (form) src = applyVariant(src, VARIANTS[form.name](form.params));
  if (gate) src = EXP89_PATCHES[gate.name](gate.params).patch(src);
  if (src === original && (form || gate)) throw new Error('源码未变——锚点没命中');
  writeFileSync(LIBSRC, src);
  rebuild();
  console.log(`wasm ${sha8()}`);
  const r = spawnSync('node', [join(HERE, 'render-trajectories.mjs'), 'engine', outPath, label, win],
    { env, encoding: 'utf8' });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
} finally {
  writeFileSync(LIBSRC, original);
  rebuild();
  const sha = sha8();
  if (sha !== CLEAN_SHA) console.error(`⚠⚠ wasm 还原后是 ${sha}，应为 ${CLEAN_SHA}`);
  console.log(`[还原] lib.rs pristine，wasm ${sha}`);
}
