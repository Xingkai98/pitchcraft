// P38 体积补偿（第二步）：扫 `OPEN_PLAY_SHOT_ENGAGE_SHIFT` 找**体积靶子**。
//
// 只跑快车道（10 种子事件流计数），不跑判据组、不跑 L1——扫参用。
// 判定仍回 run-volume.mjs（判据组）与 L1 门。
//
// 用法：node sweep-volume.mjs "[-4.0,-3.8,-3.6]"
// 环境：SEEDS=（缺省 10 个判据种子）

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { findRepoRoot } from '../probes/repo-root.mjs';
import { VOLUME_PATCHES, applyPatches } from './volume-variants.mjs';

const ROOT = findRepoRoot(new URL('.', import.meta.url).pathname);
const shifts = JSON.parse(process.argv[2] || '[-4.3,-4.0,-3.8,-3.6,-3.4,-3.2,-3.0]');
const SEEDS = process.env.SEEDS || '42,1,7,99,123,2,3,5,11,17';

const LIBSRC = join(ROOT, 'engine/src/lib.rs');
const WASM = join(ROOT, 'viewer/engine.wasm');
const BUILT = join(ROOT, 'engine/target/wasm32-unknown-unknown/release/fm_engine.wasm');
const CARGO = `${process.env.HOME}/.cargo/bin/cargo`;
const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };
const original = readFileSync(LIBSRC, 'utf8');

const rebuild = () => {
  const r = spawnSync(CARGO, ['build', '--target', 'wasm32-unknown-unknown', '--release'],
    { cwd: join(ROOT, 'engine'), env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`构建失败：\n${(r.stderr || '').slice(-2000)}`);
  const cp = spawnSync('cp', [BUILT, WASM]);
  if (cp.status !== 0) throw new Error(`wasm 搬运失败`);
  if (!readFileSync(BUILT).equals(readFileSync(WASM))) throw new Error('wasm 不一致');
};

const rows = [];
async function measure(shift) {
  writeFileSync(LIBSRC, applyPatches(original, [VOLUME_PATCHES.engageShift({ shift })]));
  rebuild();
  const sha = createHash('sha256').update(readFileSync(WASM)).digest('hex').slice(0, 8);
  const { loadEngineWasm, simulateStream, WASM_PATH } = await import(`${ROOT}/tools/benchmark-engine.mjs`);
  const { ENGINE_DURATION_SEC } = await import(`${ROOT}/viewer/match-metrics.js`);
  const L = await loadEngineWasm(WASM_PATH);
  if (!L.ok) throw new Error(L.message);
  const acc = { shot: 0, goal: 0, saved: 0, header: 0, headerGoal: 0, foul: 0, tackle: 0, pass: 0, succ: 0, int: 0, lost: 0, out: 0, box: 0 };
  let n = 0;
  for (const seed of SEEDS.split(',').map(Number)) {
    const ev = JSON.parse(simulateStream(L.wasm, seed, ENGINE_DURATION_SEC));
    const shots = ev.filter((e) => e.type === 'shot');
    const reg = shots.filter((e) => e.detail !== 'header');
    const passes = ev.filter((e) => e.type === 'pass');
    acc.shot += reg.length;
    acc.goal += reg.filter((e) => e.result === 'goal').length;
    acc.saved += reg.filter((e) => e.result === 'saved').length;
    acc.header += shots.length - reg.length;
    acc.headerGoal += shots.filter((e) => e.detail === 'header' && e.result === 'goal').length;
    acc.foul += ev.filter((e) => e.type === 'foul').length;
    acc.tackle += ev.filter((e) => e.type === 'tackle').length;
    acc.pass += passes.length;
    acc.succ += passes.filter((e) => e.to !== undefined && e.result === 'success').length;
    acc.int += passes.filter((e) => e.result === 'intercepted').length;
    acc.lost += passes.filter((e) => e.result === 'lost').length;
    acc.out += passes.filter((e) => e.result === 'out').length;
    acc.box += reg.filter((e) => (e.subject <= 10 ? 1 - e.x : e.x) * 105 <= 16.5).length;
    n += 1;
  }
  const p = (v) => +(v / n).toFixed(2);
  const r = {
    shift, wasmSha8: sha, shots: p(acc.shot), goals: p(acc.goal + acc.headerGoal),
    goalsRegular: p(acc.goal), saved: p(acc.saved), header: p(acc.header),
    onTargetRate: acc.shot ? +((acc.goal + acc.saved) / acc.shot).toFixed(3) : NaN,
    conv: acc.shot ? +(acc.goal / acc.shot).toFixed(3) : NaN,
    boxShare: acc.shot ? +(acc.box / acc.shot).toFixed(3) : NaN,
    fouls: p(acc.foul), tackles: p(acc.tackle), pass: p(acc.pass),
    passSuccessL1: acc.pass ? +(acc.succ / acc.pass).toFixed(3) : NaN,
    failedPasses: p(acc.int + acc.lost + acc.out),
  };
  console.log(`shift ${shift}: 射门 ${r.shots} 进球 ${r.goals} 射正率 ${r.onTargetRate} 转化 ${r.conv} 禁区占比 ${r.boxShare} 犯规 ${r.fouls} 传球 ${r.pass} 成功率 ${r.passSuccessL1} 失败传球 ${r.failedPasses} (wasm ${sha})`);
  rows.push(r);
}

try {
  for (const s of shifts) await measure(s);
} finally {
  writeFileSync(LIBSRC, original);
  rebuild();
  console.log(`[还原] lib.rs pristine，wasm ${createHash('sha256').update(readFileSync(WASM)).digest('hex').slice(0, 8)}`);
}
const OUT = join(ROOT, 'openspec/changes/p38-formation-realism/notes/probes-main/out');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'volume-sweep.json'), `${JSON.stringify(rows, null, 2)}\n`);
