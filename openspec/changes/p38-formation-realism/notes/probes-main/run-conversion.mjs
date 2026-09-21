// P38 #102：跑一个（体积 × 转化率）组合配置 —— 重建 wasm → 质量交叉表 → （可选）L1 九门。
//
// 用法：
//   node run-conversion.mjs <标签> --shift -3.4
//   node run-conversion.mjs <标签> --shift -3.4 --bucket 'shotBucketQuality:{"gMax":40}'
//   node run-conversion.mjs <标签> --shift -3.4 --bucket 'shotBucketScale:{"k":1.2}' --l1
//
// ⚠️ 每次实验都从**本 worktree 的 main 源码**重编 wasm，并记 sha256 前缀；
//    `finally` 里无条件还原 `lib.rs` 并重编，退出后再核对一次（P38 栽过三次）。

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { findRepoRoot } from '../probes/repo-root.mjs';
import { CONVERSION_PATCHES, applyPatches } from './conversion-variants.mjs';

const ROOT = findRepoRoot(new URL('.', import.meta.url).pathname);
const args = process.argv.slice(2);
const label = args[0] || 'unnamed';
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const runL1 = args.includes('--l1');
const shift = argOf('--shift', null);
const bucketSpec = argOf('--bucket', null);
const seeds = argOf('--seeds', '200');
const from = argOf('--from', '1');

const LIBSRC = join(ROOT, 'engine/src/lib.rs');
const WASM = join(ROOT, 'viewer/engine.wasm');
const BUILT = join(ROOT, 'engine/target/wasm32-unknown-unknown/release/fm_engine.wasm');
const CARGO = `${process.env.HOME}/.cargo/bin/cargo`;
const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };
const original = readFileSync(LIBSRC, 'utf8');

const sha8 = () => createHash('sha256').update(readFileSync(WASM)).digest('hex').slice(0, 8);

const rebuild = () => {
  const r = spawnSync(CARGO, ['build', '--target', 'wasm32-unknown-unknown', '--release'],
    { cwd: join(ROOT, 'engine'), env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`构建失败：\n${(r.stderr || '').slice(-4000)}`);
  const cp = spawnSync('cp', [BUILT, WASM]);
  if (cp.status !== 0) throw new Error('wasm 搬运失败');
  if (!readFileSync(BUILT).equals(readFileSync(WASM))) throw new Error('wasm 不一致');
};

const patches = [];
if (shift !== null) patches.push(CONVERSION_PATCHES.engageShift({ shift: Number(shift) }));
if (bucketSpec) {
  const i = bucketSpec.indexOf(':');
  const name = i < 0 ? bucketSpec : bucketSpec.slice(0, i);
  const params = i < 0 ? {} : JSON.parse(bucketSpec.slice(i + 1));
  if (!CONVERSION_PATCHES[name]) throw new Error(`未知变体 ${name}`);
  patches.push(CONVERSION_PATCHES[name](params));
}

const record = { label, shift: shift === null ? null : Number(shift), bucket: bucketSpec, at: null };
try {
  writeFileSync(LIBSRC, applyPatches(original, patches));
  rebuild();
  record.wasmSha8 = sha8();
  record.quality = run('probe-engine-shot-quality.mjs', [label, seeds]);
  if (runL1) record.l1 = runL1Gates();
} finally {
  writeFileSync(LIBSRC, original);
  rebuild();
  const back = sha8();
  record.restored = back;
  console.log(`[还原] lib.rs pristine，wasm ${back}${back === '901da77b' ? ' ✅' : ' ⚠️ 不是干净 main！'}`);
}

function run(script, argv) {
  const r = spawnSync('node', [join(ROOT, 'openspec/changes/p38-formation-realism/notes/probes-main', script), ...argv],
    { cwd: ROOT, encoding: 'utf8', env: { ...env, SEEDS_FROM: from } });
  if (r.status !== 0) throw new Error(`${script} 失败：\n${(r.stderr || '').slice(-3000)}`);
  // 探针把整个 JSON 对象 pretty-print 到 stdout（没有别的东西）→ 整体解析。
  return JSON.parse(r.stdout.trim());
}

/** L1 九门。解析 libtest 收尾行取计数 + panic 线程名取名单（P38 的读数坑：`--nocapture` 下
 *  测试自己的 stdout 会插在名字与 ok/FAILED 之间，行锚定正则**静默漏测试**）。 */
function runL1Gates() {
  const r = spawnSync(CARGO, ['test', '--test', 'realism', '--release', '--', '--ignored', '--nocapture'],
    { cwd: join(ROOT, 'engine'), env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const m = [...out.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/g)];
  const passed = m.reduce((s, x) => s + Number(x[1]), 0);
  const failed = m.reduce((s, x) => s + Number(x[2]), 0);
  // libtest 默认按线程名报 panic：`---- <test name> stdout ----`
  const names = [...new Set([...out.matchAll(/^---- (\S+) stdout ----/gm)].map((x) => x[1]))];
  const ran = [...new Set([...out.matchAll(/^test (\S+) \.\.\./gm)].map((x) => x[1]))].filter((n) => !/^result:/.test(n));
  const contradiction = (passed + failed) !== ran.length
    ? `⚠️ 自相矛盾：计数 ${passed}+${failed} ≠ 名字数 ${ran.length}` : null;
  const l1 = { passed, failed, failedNames: names, ranCount: ran.length, contradiction };
  console.log(`[L1] ${passed} 绿 ${failed} 红；红名单 ${JSON.stringify(names)}${contradiction ? ` ${contradiction}` : ''}`);
  // 关键数字（[fouls]/[home-adv]/[L3] 的 println 在 --nocapture 下可见）
  l1.report = [...out.matchAll(/^\[(fouls|home-adv|L3|home-adv calibration)\].*$/gm)].map((x) => x[0]);
  for (const l of l1.report) console.log('   ' + l);
  return l1;
}

const OUT = join(ROOT, 'openspec/changes/p38-formation-realism/notes/probes-main/out');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
record.at = null;
appendFileSync(join(OUT, 'conversion-runs.jsonl'), `${JSON.stringify(record)}\n`);
console.log(`→ out/conversion-runs.jsonl（${label}）`);
