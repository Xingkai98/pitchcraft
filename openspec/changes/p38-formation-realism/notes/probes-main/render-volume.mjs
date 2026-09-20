// P38 体积补偿（第二步）：**看图**——体积修好后，画面变了吗？
//
// 硬约束第 5 条：必须看图。三次「数字达标但画面更差」都是看图发现的。
// 本脚本按变体构建 wasm → 渲染 120s 轨迹图 → **还原** wasm（finally）。
//
// 用法：node render-volume.mjs <out.png> <标签> [--volume <变体>] [--form <变体>] [--form2 <变体>] [--win 120]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { findRepoRoot } from '../probes/repo-root.mjs';
import { VARIANTS, applyVariant } from './layer-variants.mjs';
import { VOLUME_PATCHES, applyPatches } from './volume-variants.mjs';
import { FORM_PATCHES, applyFormPatches } from './volume-form-variants.mjs';

const ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const outPath = argv[0];
const label = argv[1] || 'volume';
const WIN = Number(argOf('--win', '120'));

const LIBSRC = join(ROOT, 'engine/src/lib.rs');
const WASM = join(ROOT, 'viewer/engine.wasm');
const BUILT = join(ROOT, 'engine/target/wasm32-unknown-unknown/release/fm_engine.wasm');
const CARGO = `${process.env.HOME}/.cargo/bin/cargo`;
const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };
const original = readFileSync(LIBSRC, 'utf8');

const rebuild = () => {
  const r = spawnSync(CARGO, ['build', '--target', 'wasm32-unknown-unknown', '--release'],
    { cwd: join(ROOT, 'engine'), env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`构建失败：\n${(r.stderr || '').slice(-3000)}`);
  const cp = spawnSync('cp', [BUILT, WASM]);
  if (cp.status !== 0) throw new Error('wasm 搬运失败');
  if (!readFileSync(BUILT).equals(readFileSync(WASM))) throw new Error('wasm 不一致');
};

const parseSpec = (s) => {
  if (!s || s === '-') return null;
  const i = s.indexOf(':');
  if (i < 0) return { name: s, params: {} };
  return { name: s.slice(0, i), params: JSON.parse(s.slice(i + 1)) };
};

try {
  let src = original;
  const formSpec = argOf('--form', '-');
  if (formSpec !== '-') {
    const f = parseSpec(formSpec);
    if (!VARIANTS[f.name]) throw new Error(`未知队形变体 ${f.name}`);
    src = applyVariant(src, VARIANTS[f.name](f.params));
  }
  const volumeSpec = argOf('--volume', '-');
  if (volumeSpec !== '-') {
    const list = volumeSpec.split(',').map((s) => {
      const v = parseSpec(s.trim());
      if (!VOLUME_PATCHES[v.name]) throw new Error(`未知体积变体 ${v.name}`);
      return VOLUME_PATCHES[v.name](v.params);
    });
    src = applyPatches(src, list);
  }
  const form2Spec = argOf('--form2', '-');
  if (form2Spec !== '-') {
    const list = form2Spec.split(',').map((s) => {
      const v = parseSpec(s.trim());
      if (!FORM_PATCHES[v.name]) throw new Error(`未知队形变体(form2) ${v.name}`);
      return FORM_PATCHES[v.name](v.params);
    });
    src = applyFormPatches(src, list);
  }
  writeFileSync(LIBSRC, src);
  rebuild();
  console.log(`[${label}] wasm ${createHash('sha256').update(readFileSync(WASM)).digest('hex').slice(0, 8)}`);

  // 复用 render-trajectories.mjs 的渲染通路（P38_ROOT 覆盖为当前仓库）
  const r = spawnSync('node', [
    join(ROOT, 'openspec/changes/p38-formation-realism/notes/probes-main/render-trajectories.mjs'),
    'engine', outPath, label, String(WIN),
  ], { env: { ...env, P38_ROOT: ROOT }, encoding: 'utf8' });
  process.stdout.write(r.stdout || '');
  if (r.status !== 0) throw new Error(`渲染失败：\n${r.stderr}`);
} finally {
  writeFileSync(LIBSRC, original);
  rebuild();
  const sha = createHash('sha256').update(readFileSync(WASM)).digest('hex').slice(0, 8);
  if (readFileSync(LIBSRC, 'utf8') !== original) console.error('⚠⚠ 源码还原失败！');
  console.log(`[还原] lib.rs pristine，wasm ${sha}`);
}

const VIS = join(ROOT, 'openspec/changes/p38-formation-realism/notes/visual');
if (!existsSync(VIS)) mkdirSync(VIS, { recursive: true });
