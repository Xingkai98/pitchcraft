// P38 体积补偿假说（第二步）runner：**改体积 → 量队形判据 + 引擎 L1 门**。
//
// 与 `run-exp89.mjs` 的分工：那个是 #89 的（门 + 组合），这个是体积的（engageShift + shotBucket
// + 任意队形变体叠加）。共用同一套快车道 / L1 解析 / 构建校验 / finally 还原。
//
// 用法：
//   node run-volume.mjs <标签> [--volume <变体>] [--form <变体>] [--extra <k=v,...>] [--no-l1] [--only <测试名>]
//
//   --volume  体积变体，逗号分隔，如 `engageShift:{"shift":-3.5}` 或
//             `engageShift:{"shift":-3.5},shotBucket:{"k":0.8}`
//   --form    队形变体（`layer-variants.mjs` 的 VARIANTS），如 `exp4b`、`-` 表示无
//   --extra   额外 key=value 落进结果 JSON（方便标注老方案）
//
// 硬约束（照搬 run-exp89.mjs，本 campaign 明文要求）：
//   - wasm 从**本 worktree 的 main 源码**重建，实验前后各记一次 sha256
//   - 无论成功失败，finally 里 `git checkout engine/src/lib.rs` 还原 + 重建
//   - 不提交引擎源码改动（改动只以 .patch 落 notes/patches/）

import { readFileSync, appendFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { findRepoRoot } from '../probes/repo-root.mjs';
import { VARIANTS, applyVariant } from './layer-variants.mjs';
import { VOLUME_PATCHES, applyPatches } from './volume-variants.mjs';
import { FORM_PATCHES, applyFormPatches } from './volume-form-variants.mjs';

const ROOT = findRepoRoot(new URL('.', import.meta.url).pathname);
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

const label = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'volume-current';
const volumeSpec = argOf('--volume', '-');
const formSpec = argOf('--form', '-');
const form2Spec = argOf('--form2', '-');
const extraSpec = argOf('--extra', null);
const skipL1 = argv.includes('--no-l1');
const SEEDS = process.env.SEEDS || '42,1,7,99,123,2,3,5,11,17';

const LIBSRC = join(ROOT, 'engine/src/lib.rs');
const WASM = join(ROOT, 'viewer/engine.wasm');
const BUILT = join(ROOT, 'engine/target/wasm32-unknown-unknown/release/fm_engine.wasm');
const CARGO = `${process.env.HOME}/.cargo/bin/cargo`;
const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };
const original = readFileSync(LIBSRC, 'utf8');
const CLEAN_SHA = process.env.CLEAN_SHA || '901da77b';
const sha8 = () => createHash('sha256').update(readFileSync(WASM)).digest('hex').slice(0, 8);

// 构建 + **搬运的成败都检**（审阅发现，见 run-exp89.mjs 的同名注释）
const rebuild = () => {
  const r = spawnSync(CARGO, ['build', '--target', 'wasm32-unknown-unknown', '--release'],
    { cwd: join(ROOT, 'engine'), env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`构建失败：\n${(r.stderr || '').slice(-3000)}`);
  const cp = spawnSync('cp', [BUILT, WASM]);
  if (cp.status !== 0) throw new Error(`wasm 搬运失败（cp 退出 ${cp.status}）`);
  const a = readFileSync(BUILT); const b = readFileSync(WASM);
  if (!a.equals(b)) throw new Error('viewer/engine.wasm 与构建产物不一致');
};

// 只按**第一个**冒号切（JSON 参数里必然有冒号）
const parseSpec = (s) => {
  if (!s || s === '-') return null;
  const i = s.indexOf(':');
  if (i < 0) return { name: s, params: {} };
  return { name: s.slice(0, i), params: JSON.parse(s.slice(i + 1)) };
};

async function quickLane() {
  const { loadEngineWasm, simulateStream, WASM_PATH } = await import(`${ROOT}/tools/benchmark-engine.mjs`);
  const { ENGINE_DURATION_SEC } = await import(`${ROOT}/viewer/match-metrics.js`);
  const L = await loadEngineWasm(WASM_PATH);
  if (!L.ok) throw new Error(L.message);
  const acc = { foul: 0, shot: 0, tackle: 0, header: 0, goal: 0, saved: 0, pass: 0, passSucc: 0, passDir: 0, passInt: 0, passLost: 0, passOut: 0, shotP90: 0, goalP90: 0 };
  let n = 0;
  for (const seed of SEEDS.split(',').map(Number)) {
    const ev = JSON.parse(simulateStream(L.wasm, seed, ENGINE_DURATION_SEC));
    const shots = ev.filter((e) => e.type === 'shot');
    const reg = shots.filter((e) => e.detail !== 'header');
    const passes = ev.filter((e) => e.type === 'pass');
    const directed = passes.filter((e) => e.to !== undefined);
    acc.foul += ev.filter((e) => e.type === 'foul').length;
    acc.shot += reg.length;
    acc.header += shots.length - reg.length;
    acc.goal += reg.filter((e) => e.result === 'goal').length;
    acc.saved += reg.filter((e) => e.result === 'saved').length;
    acc.tackle += ev.filter((e) => e.type === 'tackle').length;
    acc.pass += passes.length;
    acc.passDir += directed.length;
    acc.passSucc += directed.filter((e) => e.result === 'success').length;
    acc.passInt += directed.filter((e) => e.result === 'intercepted').length;
    acc.passLost += directed.filter((e) => e.result === 'lost').length;
    acc.passOut += passes.filter((e) => e.result === 'out').length;
    n += 1;
  }
  const per = (v) => +(v / n).toFixed(2);
  return {
    qFouls: per(acc.foul), qShots: per(acc.shot), qHeaders: per(acc.header),
    qGoals: per(acc.goal), qSaved: per(acc.saved), qTackles: per(acc.tackle),
    qPass: per(acc.pass),
    // 快车道口径的比率（判方向用；判定仍回 L1）
    qShotOnTargetRate: acc.shot ? +(acc.saved / acc.shot + acc.goal / acc.shot).toFixed(3) : NaN,
    qGoalConv: acc.shot ? +(acc.goal / acc.shot).toFixed(3) : NaN,
    qPassSuccessL1: acc.pass ? +(acc.passSucc / acc.pass).toFixed(3) : NaN,
    qPassSuccessDirected: acc.passDir ? +(acc.passSucc / acc.passDir).toFixed(3) : NaN,
    qFailedPasses: per(acc.passInt + acc.passLost + acc.passOut),
    qSeedCount: n,
  };
}

function runL1() {
  const t0 = Date.now();
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;
  const args = ['test', '--release', '--test', 'realism', '--', '--ignored', '--nocapture'];
  if (only) args.push(only);
  const r = spawnSync(CARGO, args,
    { cwd: join(ROOT, 'engine'), env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 900000 });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const m = (re) => { const x = out.match(re); return x ? Number(x[1]) : NaN; };
  // ⚠️ 不按行解析 `test NAME ... ok/FAILED`（--nocapture 下 stdout 会插在中间）。见 run-exp89.mjs。
  const sum = out.match(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed;/);
  const nPassed = sum ? Number(sum[1]) : NaN;
  const nFailed = sum ? Number(sum[2]) : NaN;
  const TEST_NAME = /^(?:l1_|l3_|p\d+_)\w+$/;
  const panicNames = [...out.matchAll(/thread '([a-z0-9_]+)' \(\d+\) panicked at/g)].map((x) => x[1]);
  const fails = [...new Set(panicNames.filter((n) => TEST_NAME.test(n)))];
  const passLineNames = [...out.matchAll(/^test ((?:l1_|l3_|p\d+_)\w+) \.\.\. /gm)].map((x) => x[1]);
  const passes = [...new Set(passLineNames)].filter((n) => !fails.includes(n));
  const res = {
    l1Sec: +((Date.now() - t0) / 1000).toFixed(1),
    foulsPerMatch: m(/\[fouls\] 每场: foul=([\d.]+)/) || m(/每场犯规 ([\d.]+) ∉/),
    yellowsPerMatch: m(/\[fouls\] 每场: foul=[\d.]+ yellow=([\d.]+)/),
    redsPerMatch: m(/\[fouls\] 每场: foul=[\d.]+ yellow=[\d.]+ red=([\d.]+)/),
    shotsPerMatch: m(/singles? shot=([\d.]+)/) || m(/shot=([\d.]+)\(/),
    headersPerMatch: m(/\(\+header ([\d.]+)\)/),
    goalsHome: m(/进球 主([\d.]+)\/客/),
    goalsAway: m(/进球 主[\d.]+\/客([\d.]+)/),
    l1Passed: Number.isFinite(nPassed) ? nPassed : passes.length,
    l1Failed: Number.isFinite(nFailed) ? nFailed : fails.length,
    l1FailedNames: fails,
    l1TestTotal: sum ? nPassed + nFailed : passes.length + fails.length,
    l1PassedNames: passes,
    l1SummaryLine: sum ? sum[0] : null,
  };
  // 从 L3 那行拿射正率 / 转化率 / 禁区占比（`[L3] shots=… sot=… conv=…`）
  res.l3SotRate = m(/sot=([\d.]+)/);
  res.l3ConvRate = m(/conv=([\d.]+)/);
  res.l3BoxGoalShare = m(/禁区占比=([\d.]+)/);
  if (Number.isFinite(nFailed) && nFailed !== fails.length) {
    console.error(`⚠ L1 解析自相矛盾：收尾行说失败 ${nFailed} 个，panic 名单只捞到 ${fails.length} 个（${fails.join(',')}）`);
  }
  return { res, out };
}

let result = null;
try {
  let src = original;
  if (formSpec && formSpec !== '-') {
    const f = parseSpec(formSpec);
    if (!VARIANTS[f.name]) throw new Error(`未知队形变体 ${f.name}`);
    src = applyVariant(src, VARIANTS[f.name](f.params));
  }
  const volList = [];
  if (volumeSpec && volumeSpec !== '-') {
    for (const part of volumeSpec.split(',')) {
      const v = parseSpec(part.trim());
      if (!VOLUME_PATCHES[v.name]) throw new Error(`未知体积变体 ${v.name}`);
      volList.push(VOLUME_PATCHES[v.name](v.params));
    }
  }
  if (volList.length) src = applyPatches(src, volList);
  if (form2Spec && form2Spec !== '-') {
    const fp2 = [];
    for (const part of form2Spec.split(',')) {
      const f2 = parseSpec(part.trim());
      if (!FORM_PATCHES[f2.name]) throw new Error(`未知队形变体(form2) ${f2.name}`);
      fp2.push(FORM_PATCHES[f2.name](f2.params));
    }
    src = applyFormPatches(src, fp2);
  }
  if (src === original && (formSpec !== '-' || volumeSpec !== '-' || form2Spec !== '-')) {
    throw new Error('组合后源码未变——锚点没命中');
  }
  writeFileSync(LIBSRC, src);
  rebuild();
  const sha = sha8();

  console.log(`[${label}] wasm ${sha}，判据组评测中…`);
  const ev = spawnSync('node', [
    join(ROOT, 'openspec/changes/p38-formation-realism/notes/criteria/eval-criteria.mjs'), label,
  ], { env: { ...env, CRITERIA_SEEDS: SEEDS }, encoding: 'utf8' });
  if (ev.status !== 0) throw new Error(`评测失败：${ev.stdout}\n${ev.stderr}`);
  const metrics = JSON.parse(ev.stdout.trim().split('\n').pop());

  const quick = await quickLane();
  console.log(`[${label}] 快车道（${quick.qSeedCount} 种子）：犯规 ${quick.qFouls} 射门 ${quick.qShots} 进球 ${quick.qGoals} 转化 ${quick.qGoalConv} 抢断 ${quick.qTackles}`);

  let l1 = null;
  if (!skipL1) {
    console.log(`[${label}] L1 门（200 场 release）…`);
    l1 = runL1();
    console.log(`[${label}] L1 射门 ${l1.res.shotsPerMatch} 进球 ${l1.res.goalsHome}+${l1.res.goalsAway} 犯规 ${l1.res.foulsPerMatch} → `
      + `${l1.res.l1Passed}绿 ${l1.res.l1Failed}红 [${l1.res.l1FailedNames.join(',')}]`);
    if (l1.res.l1FailedNames.length) {
      const lines = l1.out.split('\n');
      const detail = [];
      for (let i = 0; i < lines.length && detail.length < 12; i += 1) {
        if (/panicked at tests\//.test(lines[i])) detail.push(...lines.slice(i, i + 2).filter((l) => l.trim()));
      }
      result = { ...result, l1FailureDetail: detail };
    }
  }
  const extra = extraSpec ? Object.fromEntries(extraSpec.split(',').map((kv) => kv.split('='))) : {};
  result = { ...(result || {}), tag: label, form: formSpec, form2: form2Spec, volume: volumeSpec, wasmSha8: sha, ...metrics, ...quick, ...(l1 ? l1.res : {}), ...extra };
} finally {
  writeFileSync(LIBSRC, original);
  rebuild();
  const sha = sha8();
  if (readFileSync(LIBSRC, 'utf8') !== original) console.error('⚠⚠ 源码还原失败！');
  if (sha !== CLEAN_SHA) console.error(`⚠⚠ wasm 还原后是 ${sha}，应为 ${CLEAN_SHA}`);
  console.log(`[还原] lib.rs pristine，wasm ${sha}`);
}

console.log(JSON.stringify(result));
const OUT = join(ROOT, 'openspec/changes/p38-formation-realism/notes/probes-main/out');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
appendFileSync(join(OUT, 'volume.jsonl'), `${JSON.stringify(result)}\n`);
