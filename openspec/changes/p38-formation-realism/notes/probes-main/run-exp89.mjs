// P38 #89：**组合与门 + L1 门**的一体化 runner。
//
// `run-combo.mjs` 只跑判据组（8 条），而本轮的核心问题是**犯规**——
// 上一轮实测「门一收紧，犯规就从 ~20 涨到 50.4/场」（`notes/defense-layers.md` §5a）。
// 判据组**没有**犯规判据，L1 门才有（`engine/tests/realism.rs::l1_fouls_and_cards`，
// 犯规 ∈ [16,30]）。两条门必须一起看，否则会出现"判据组绿而引擎门红"的假达标。
//
// 本脚本一次跑两个：判据组（10 种子，几秒）+ 一个共享的 process 跑**一次** L1 聚合
// （200 场 release，~16s），从输出里同时解析犯规/射门/射正——只付一次 200 场的代价。
//
// 用法：node run-exp89.mjs <队形变体|-[:JSON]> <#89 门变体|-[:JSON]> <标签> [--no-l1] [--only <测试名>]
//   node run-exp89.mjs exp4b positionGate:{"radius":25,"meters":0.5,"guardMeters":1.5} exp89-a
// 环境：SEEDS=（判据组种子，缺省 10 个）
//
// 硬约束（本 campaign 的明文要求）：
//   - wasm 从**本 worktree 的 main 源码**重建，实验前后各记一次 sha256
//   - 无论成功失败，finally 里 `git checkout engine/src/lib.rs` 还原 + 重建
//   - 不提交引擎源码改动（改动只以 .patch 落 notes/patches/）

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { findRepoRoot } from '../probes/repo-root.mjs';
import { VARIANTS, applyVariant } from './layer-variants.mjs';
import { EXP89_PATCHES } from './exp89-variants.mjs';

const ROOT = findRepoRoot(new URL('.', import.meta.url).pathname);
// ⚠️ 只按**第一个**冒号切（JSON 参数里必然有冒号）
const parse = (s) => {
  if (!s || s === '-') return null;
  const i = s.indexOf(':');
  if (i < 0) return { name: s, params: {} };
  return { name: s.slice(0, i), params: JSON.parse(s.slice(i + 1)) };
};
const form = parse(process.argv[2]);
const gate = parse(process.argv[3]);
const label = process.argv[4] || `${process.argv[2]}_${process.argv[3]}`;
const skipL1 = process.argv.includes('--no-l1');
const SEEDS = process.env.SEEDS || '42,1,7,99,123,2,3,5,11,17';

const LIBSRC = join(ROOT, 'engine/src/lib.rs');
const WASM = join(ROOT, 'viewer/engine.wasm');
const BUILT = join(ROOT, 'engine/target/wasm32-unknown-unknown/release/fm_engine.wasm');
const CARGO = `${process.env.HOME}/.cargo/bin/cargo`;
const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };
const original = readFileSync(LIBSRC, 'utf8');
const CLEAN_SHA = process.env.CLEAN_SHA || '901da77b';
const sha8 = () => createHash('sha256').update(readFileSync(WASM)).digest('hex').slice(0, 8);

// ⚠️ 构建 + **搬运的成败都要检**（审阅发现）：早先 `cp` 的返回码被丢掉，
// 一旦它失败（或 build 产物是陈的），实验就会跑在**上一版 wasm** 上，
// 却记下一个看着合理的 sha——正是本 campaign 反复出的那类假绿。
const rebuild = () => {
  const r = spawnSync(CARGO, ['build', '--target', 'wasm32-unknown-unknown', '--release'],
    { cwd: join(ROOT, 'engine'), env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`构建失败：\n${(r.stderr || '').slice(-3000)}`);
  const cp = spawnSync('cp', [BUILT, WASM]);
  if (cp.status !== 0) throw new Error(`wasm 搬运失败（cp 退出 ${cp.status}）`);
  if (!existsSync(WASM)) throw new Error(`搬运后 ${WASM} 不存在`);
  // 产物必须与刚构建的 wasm 逐字节相同
  const a = readFileSync(BUILT); const b = readFileSync(WASM);
  if (!a.equals(b)) throw new Error('viewer/engine.wasm 与构建产物不一致（搬运后校验失败）');
};

// ── 快车道：JS 侧数犯规/射门/抢断（同一组判据种子，几秒）──────────────────
// 为什么另开一条：L1 门是 200 场 release（~20–115s），用来**扫参**太贵。
// 10 种子口径下基线犯规 20.20/场（L1 的 200 场是 20.09）——**同一口径的抽样**，
// 用来排方向足够；但**判定**必须回 L1（`notes/criteria/README.md` 的种子集教训：
// 射门是计数统计量，10 种子 sem≈0.5，L1 才是门）。
async function quickLane() {
  const { loadEngineWasm, simulateStream, WASM_PATH } = await import(`${ROOT}/tools/benchmark-engine.mjs`);
  const { ENGINE_DURATION_SEC } = await import(`${ROOT}/viewer/match-metrics.js`);
  const L = await loadEngineWasm(WASM_PATH);
  if (!L.ok) throw new Error(L.message);
  const acc = { foul: 0, shot: 0, tackle: 0, header: 0 };
  let n = 0;
  for (const seed of SEEDS.split(',').map(Number)) {
    const ev = JSON.parse(simulateStream(L.wasm, seed, ENGINE_DURATION_SEC));
    acc.foul += ev.filter((e) => e.type === 'foul').length;
    acc.shot += ev.filter((e) => e.type === 'shot' && e.detail !== 'header').length;
    acc.header += ev.filter((e) => e.type === 'shot' && e.detail === 'header').length;
    acc.tackle += ev.filter((e) => e.type === 'tackle').length;
    n += 1;
  }
  return {
    qFouls: +(acc.foul / n).toFixed(2), qShots: +(acc.shot / n).toFixed(2),
    qTackles: +(acc.tackle / n).toFixed(2), qHeaders: +(acc.header / n).toFixed(2),
    qSeedCount: n,
  };
}

// ── L1 门：**一次 process** 跑全部 200 场，从 `--nocapture` 的 stdout 解析多行 ──
// 为什么不用 `cargo test l1_fouls_and_cards`：它一次只跑一个测试，无法从断言消息里
// 拿到"通过时"的实际值（断言不打印就不知道数值）。用 `--nocapture` 跑全部 L1 测试，
// 它打印 `[fouls] 每场: foul=… yellow=… red=…` 与 `[P13+pilot3 副作用] … shot=…`。
function runL1() {
  const t0 = Date.now();
  // `--only <名>`：只跑一个 L1 测试。⚠️ 每个 `#[ignore]` 测试各自调 `l1_stats()`，
  // 而它是 `OnceLock`——**同一进程内只算一次 200 场**。跑全部 L1 测试时那 200 场只付一次，
  // 所以"只跑 l1_fouls"并不省时间（实测 21s，与全跑同量级）。真正省时间的是**少跑 60 场**：
  // `--only l1_fouls` 实测 21s vs 全跑 115s，因为面板测试（主客优势）自己又跑 60 场。
  const onlyIdx = process.argv.indexOf('--only');
  const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;
  const args = ['test', '--release', '--test', 'realism', '--', '--ignored', '--nocapture'];
  if (only) args.push(only);
  const r = spawnSync(CARGO, args,
    { cwd: join(ROOT, 'engine'), env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600000 });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const m = (re) => { const x = out.match(re); return x ? Number(x[1]) : NaN; };
  // ⚠️ 匹配**全部** `#[ignore]` 测试，不能只匹配 `l1_`（审阅发现）：
  // `l3_shot_ratios` 与 `l3_home_away_goal_calibration` 同样是硬门/报告项，
  // 早先只数 `l1_*` 会让 "5 绿 0 红" 变成 "5 个被解析的测试全绿"，而引擎实际是 9 个。
  // 本 campaign 的教训：**读数范围必须与门的范围一致**，否则是口径分叉。
  const fails = [...out.matchAll(/^test ((?:l1_|l3_|p\d+_)\w+) \.\.\. FAILED$/gm)].map((x) => x[1]);
  const passes = [...out.matchAll(/^test ((?:l1_|l3_|p\d+_)\w+) \.\.\. ok$/gm)].map((x) => x[1]);
  const total = fails.length + passes.length;
  const res = {
    l1Sec: +((Date.now() - t0) / 1000).toFixed(1),
    // ⚠️ `[fouls]` 那行 println 在 assert **之后**——断言失败时它不打印，
    // 只剩 panic 消息。只抓 println 会得到 NaN（正是"L1 红 = 没有数"的假绿反向版）。
    foulsPerMatch: m(/\[fouls\] 每场: foul=([\d.]+)/) || m(/每场犯规 ([\d.]+) ∉/),
    yellowsPerMatch: m(/\[fouls\] 每场: foul=[\d.]+ yellow=([\d.]+)/),
    redsPerMatch: m(/\[fouls\] 每场: foul=[\d.]+ yellow=[\d.]+ red=([\d.]+)/),
    shotsPerMatch: m(/singles? shot=([\d.]+)/) || m(/shot=([\d.]+)\(/),
    headersPerMatch: m(/\(\+header ([\d.]+)\)/),
    goalsHome: m(/进球 主([\d.]+)\/客/),
    goalsAway: m(/进球 主[\d.]+\/客([\d.]+)/),
    l1Passed: passes.length,
    l1Failed: fails.length,
    l1FailedNames: fails,
    l1TestTotal: total,
    // 红/绿的**明细**也落盘——只留计数的话，"哪条红"要靠翻 stdout，等于丢证据。
    l1FailedNamesAll: fails,
    l1PassedNames: passes,
  };
  return { res, out };
}

let result = null;
try {
  let src = original;
  if (form) {
    if (!VARIANTS[form.name]) throw new Error(`未知队形变体 ${form.name}`);
    src = applyVariant(src, VARIANTS[form.name](form.params));
  }
  if (gate) {
    if (!EXP89_PATCHES[gate.name]) throw new Error(`未知 #89 门变体 ${gate.name}`);
    src = EXP89_PATCHES[gate.name](gate.params).patch(src);
  }
  // 纯基线（form 与 gate 都为空）**允许**源码不变——它是每张表的对照列。
  // 有变体时源码不变才是错误（锚点没命中 = 静默不生效）。
  if (src === original && (form || gate)) throw new Error('组合后源码未变——锚点没命中');
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
  console.log(`[${label}] 快车道（${quick.qSeedCount} 种子）：犯规 ${quick.qFouls}/场 射门 ${quick.qShots}/场 抢断 ${quick.qTackles}`);

  let l1 = null;
  if (!skipL1) {
    console.log(`[${label}] L1 门（200 场 release）…`);
    l1 = runL1();
    console.log(`[${label}] 犯规 ${l1.res.foulsPerMatch} / 射门 ${l1.res.shotsPerMatch} / `
      + `L1 ${l1.res.l1Passed}绿 ${l1.res.l1Failed}红 ${l1.res.l1FailedNames.join(',')}`);
    if (l1.res.l1Failed && l1.res.l1FailedNames.length) {
      // 失败明细在 stdout 的 assertion 消息里，抓出来供诊断
      result = { ...result, l1FailureDetail: (l1.out.match(/^.*assertion.*$/gm) || []).slice(0, 6) };
    }
  }
  result = { ...(result || {}), tag: label, form: process.argv[2] || 'clean', gate: process.argv[3] || 'clean', wasmSha8: sha, ...metrics, ...quick, ...(l1 ? l1.res : {}) };
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
appendFileSync(join(OUT, 'exp89.jsonl'), `${JSON.stringify(result)}\n`);
