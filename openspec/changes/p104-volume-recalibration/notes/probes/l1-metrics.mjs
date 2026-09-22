// P104：从**当前 `viewer/engine.wasm`** 直接算 L1 门关心的全部量（200/600 场口径）。
//
// 为什么要有它：`cargo test --test realism -- --ignored` 是**权威**（门就在那里），
// 但一个配置 ~75s，扫参太慢。本探针把同一份口径在 JS 里重算一遍——
//   ① 快（4 worker 并行，200 场 ~7s）；② 输出**全部**量而不是只有断言里那几个。
// **口径必须逐字对齐 `engine/tests/realism.rs::aggregate`**（桶边界 16.5/25、头球按
// `detail=="header"`、close/far 按 `TACKLE_DISTANCE_THRESHOLD_METERS`、主客按 `subject<=10`）。
// 任何不一致都会让"探针说绿、cargo 说红"——那种分叉是 P37 定义的"数字不可比"。
//
// 用法：
//   node l1-metrics.mjs --seeds 200 --from 401 [--ha-seeds 600] [--label X] [--out file.jsonl]
//   node l1-metrics.mjs --seeds 200 --from 601 --win 601            # 留出窗口
//
// ⚠️ **不硬编码 worktree 绝对路径**：仓库根由「向上找 package.json + viewer/match-metrics.js」定位。

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));

export function findRepoRoot(start) {
  let dir = resolve(start);
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'viewer', 'match-metrics.js'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error('未找到仓库根');
}

// ── 口径常量（逐字对齐 realism.rs） ─────────────────────────────────────
const PITCH_LENGTH_M = 105.0;
const PITCH_WIDTH_M = 68.0;
const BOX_DIST_M = 16.5;
const ARC_DIST_M = 25.0;
const TACKLE_THRESHOLD_M = 12.0;
const ENGINE_DURATION_SEC = 5400.0;

const num = (e, k) => (typeof e[k] === 'number' ? e[k] : NaN);

/** 单场事件流 → MatchStats（只保留 L1 门用到的字段）。 */
export function statsOfEvents(ev) {
  const s = {
    nShotGoal: 0, nShotSaved: 0, nShotOff: 0,
    nHeader: 0, nHeaderGoal: 0, nHeaderSaved: 0, nHeaderOff: 0,
    nShotFar45: 0,
    nBox: 0, nBoxGoal: 0, nBoxSaved: 0, nBoxOff: 0,
    nArc: 0, nArcGoal: 0, nArcSaved: 0, nArcOff: 0,
    nFar: 0, nFarGoal: 0, nFarSaved: 0, nFarOff: 0,
    nGoalHome: 0, nGoalAway: 0,
    nTackle: 0, nTackleSuccess: 0, nTackleClose: 0, nTackleCloseSuccess: 0, nTackleFar: 0,
    nCornerKick: 0, nOutSideline: 0, nFreeKick: 0,
    nFoul: 0, nFoulYellow: 0, nFoulRed: 0,
    nPass: 0, nPassSuccess: 0, nPassIntercepted: 0, nPassLost: 0, nGkPass: 0,
  };
  for (const e of ev) {
    if (e.type === 'shot') {
      const header = e.detail === 'header';
      const res = e.result;
      const subj = num(e, 'subject');
      const sx = num(e, 'x');
      const distM = subj <= 10 ? (1 - sx) * PITCH_LENGTH_M : sx * PITCH_LENGTH_M;
      if (distM > 45) s.nShotFar45 += 1;
      if (header) {
        s.nHeader += 1;
        if (res === 'goal') s.nHeaderGoal += 1;
        else if (res === 'saved') s.nHeaderSaved += 1;
        else if (res === 'off_target') s.nHeaderOff += 1;
      } else {
        const b = distM <= BOX_DIST_M ? 'Box' : distM <= ARC_DIST_M ? 'Arc' : 'Far';
        s[`n${b}`] += 1;
        if (res === 'goal') { s[`n${b}Goal`] += 1; s.nShotGoal += 1; }
        else if (res === 'saved') { s[`n${b}Saved`] += 1; s.nShotSaved += 1; }
        else if (res === 'off_target') { s[`n${b}Off`] += 1; s.nShotOff += 1; }
      }
      if (res === 'goal') { if (subj <= 10) s.nGoalHome += 1; else s.nGoalAway += 1; }
    } else if (e.type === 'tackle') {
      s.nTackle += 1;
      const ok = e.result === 'success';
      if (ok) s.nTackleSuccess += 1;
      const dx = (num(e, 'x') - num(e, 'x2')) * PITCH_LENGTH_M;
      const dy = (num(e, 'y') - num(e, 'y2')) * PITCH_WIDTH_M;
      if (Math.hypot(dx, dy) <= TACKLE_THRESHOLD_M) {
        s.nTackleClose += 1;
        if (ok) s.nTackleCloseSuccess += 1;
      } else s.nTackleFar += 1;
    } else if (e.type === 'foul') {
      s.nFoul += 1;
      if (e.card === 'yellow') s.nFoulYellow += 1;
      else if (e.card === 'red') s.nFoulRed += 1;
    } else if (e.type === 'pass') {
      s.nPass += 1;
      const hasTo = typeof e.to === 'number';
      if (hasTo) {
        if (e.result === 'success') s.nPassSuccess += 1;
        else if (e.result === 'intercepted') s.nPassIntercepted += 1;
        else if (e.result === 'lost') s.nPassLost += 1;
      } else if (e.subject === 0 || e.subject === 21) s.nGkPass += 1;
      if (e.detail === 'corner') s.nCornerKick += 1;
      else if (e.detail === 'out_sideline') s.nOutSideline += 1;
      else if (e.detail === 'free_kick') s.nFreeKick += 1;
    }
  }
  return s;
}

/** 把 [MatchStats] 聚合成 L1 门的读数。**逐场算再平均**（计数类可加总，比率类必须逐场）。 */
export function aggregate(statsList) {
  const sum = (k) => statsList.reduce((a, s) => a + s[k], 0);
  const n = statsList.length;
  const per = (k) => sum(k) / n;
  const regular = sum('nBox') + sum('nArc') + sum('nFar');
  const header = sum('nHeaderGoal') + sum('nHeaderSaved') + sum('nHeaderOff');
  const shots = regular + header;
  const goals = sum('nShotGoal') + sum('nHeaderGoal');
  const saved = sum('nShotSaved') + sum('nHeaderSaved');
  const boxGoals = sum('nBoxGoal') + sum('nHeaderGoal');
  const tackles = sum('nTackle');
  const goalsAll = goals;
  return {
    matches: n,
    // —— 门 ①：l1_shot_result_distributions
    shotsPerMatch: +(regular / n).toFixed(3),
    boxRate: [sum('nBoxGoal') / sum('nBox'), sum('nBoxSaved') / sum('nBox'), sum('nBoxOff') / sum('nBox')].map((v) => +v.toFixed(4)),
    arcRate: [sum('nArcGoal') / sum('nArc'), sum('nArcSaved') / sum('nArc'), sum('nArcOff') / sum('nArc')].map((v) => +v.toFixed(4)),
    farRate: [sum('nFarGoal') / sum('nFar'), sum('nFarSaved') / sum('nFar'), sum('nFarOff') / sum('nFar')].map((v) => +v.toFixed(4)),
    boxShare: +(sum('nBox') / regular).toFixed(4),
    nShotFar45: sum('nShotFar45'),
    headerN: header,
    headerRate: header ? [sum('nHeaderGoal') / header, sum('nHeaderSaved') / header, sum('nHeaderOff') / header].map((v) => +v.toFixed(4)) : null,
    // —— 门 ②：l1_tackle_dilution_and_slot_mix
    tacklesPerMatch: +(tackles / n).toFixed(3),
    tackleSuccessRate: +(sum('nTackleSuccess') / tackles).toFixed(4),
    tackleCloseRate: +(sum('nTackleCloseSuccess') / sum('nTackleClose')).toFixed(4),
    tackleFar: sum('nTackleFar'),
    shotTackleRatio: +(regular / tackles).toFixed(4),
    cornersPerMatch: +(sum('nCornerKick') / n).toFixed(3),
    throwInsPerMatch: +(sum('nOutSideline') / n).toFixed(3),
    // —— 门 ③：l1_home_away_goal_asymmetry（调用方传 600 场窗口）
    homeGoalsPerMatch: +(sum('nGoalHome') / n).toFixed(4),
    awayGoalsPerMatch: +(sum('nGoalAway') / n).toFixed(4),
    // —— l3_shot_ratios
    shotsTotal: shots,
    regularShots: regular,
    headerShots: header,
    goalsAll: goalsAll,
    goalsPerMatchAll: +(goalsAll / n).toFixed(4),
    sot: +((goals + saved) / shots).toFixed(4),
    conv: +(goals / shots).toFixed(4),
    inside: +(boxGoals / Math.max(goals, 1)).toFixed(4),
    // —— 不动门（副作用哨兵）
    foulsPerMatch: +(sum('nFoul') / n).toFixed(3),
    yellowsPerMatch: +(sum('nFoulYellow') / n).toFixed(3),
    redsPerMatch: +(sum('nFoulRed') / n).toFixed(3),
    passCompletion: +(sum('nPassSuccess') / sum('nPass')).toFixed(4),
    interceptShare: +(sum('nPassIntercepted') / Math.max(sum('nPassIntercepted') + sum('nPassLost'), 1)).toFixed(4),
    passPerMatch: +(sum('nPass') / n).toFixed(2),
    headerPerMatch: +(header / n).toFixed(3),
  };
}

// ── 入口判定 ─────────────────────────────────────────────────────────
// ⚠️ **本模块被 `run-variant.mjs` import**（取 `findRepoRoot`/`aggregate`）。ESM 的顶层代码
// 在 import 时就会执行——若不守卫，import 会**顺带把整个探针跑一遍**（读的是 clean main 的
// wasm、打印一份 JSON、还往 `l1-metrics.jsonl` 写一条假记录）。实测后果：调用方在自己的
// stdout 里先看到这份"干净 main"的 JSON，解析时就拿到了**错的数**（`run-variant` 里
// `record.metrics` 是对的，但到处都在读 stdout）。
const IS_ENTRY = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

// ── worker 侧 ────────────────────────────────────────────────────────
if (!isMainThread) {
  const { seeds, wasmPath } = workerData;
  const bytes = readFileSync(wasmPath);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const wasm = instance.exports;
  const { simulateStream } = await import(join(findRepoRoot(workerData.root), 'tools/benchmark-engine.mjs'));
  const out = [];
  const crashed = [];
  for (const seed of seeds) {
    try {
      out.push(statsOfEvents(JSON.parse(simulateStream(wasm, seed, ENGINE_DURATION_SEC))));
    } catch (e) {
      crashed.push({ seed, error: String(e.message).slice(0, 80) });
    }
  }
  parentPort.postMessage({ stats: out, crashed });
} else if (IS_ENTRY) {
  const argv = process.argv.slice(2);
  const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
  const ROOT = findRepoRoot(HERE);
  const WASM = argOf('--wasm', join(ROOT, 'viewer/engine.wasm'));
  const label = argOf('--label', 'current');
  const N = Number(argOf('--seeds', '200'));
  const FROM = Number(argOf('--from', '401'));
  const HA_N = Number(argOf('--ha-seeds', '0'));
  const HA_FROM = Number(argOf('--ha-from', '401'));
  const WORKERS = Number(argOf('--workers', String(Math.max(1, Math.min(4, os.cpus().length)))));

  const sha8 = existsSync(WASM) ? createHash('sha256').update(readFileSync(WASM)).digest('hex').slice(0, 8) : null;

  const runRange = async (from, n) => {
    const all = Array.from({ length: n }, (_, i) => from + i);
    const chunks = Array.from({ length: WORKERS }, () => []);
    all.forEach((s, i) => chunks[i % WORKERS].push(s));
    const res = await Promise.all(chunks.filter((c) => c.length).map((seeds) => new Promise((res2, rej) => {
      const w = new Worker(new URL(import.meta.url), { workerData: { seeds, wasmPath: WASM, root: ROOT } });
      w.on('message', (m) => { res2(m); w.terminate(); });
      w.on('error', rej);
    })));
    const stats = res.flatMap((r) => r.stats);
    const crashed = res.flatMap((r) => r.crashed);
    return { stats, crashed };
  };

  const t0 = Date.now();
  const l1 = await runRange(FROM, N);
  const out = { label, wasmSha8: sha8, seedsFrom: FROM, seedsTo: FROM + N - 1, seedsRequested: N, crashedSeeds: l1.crashed.length, ...aggregate(l1.stats) };
  if (l1.crashed.length) out.crashSample = l1.crashed.slice(0, 2);
  if (HA_N > 0) {
    const ha = await runRange(HA_FROM, HA_N);
    const a = aggregate(ha.stats);
    out.haMatches = a.matches;
    out.homeGoalsPerMatch = a.homeGoalsPerMatch;
    out.awayGoalsPerMatch = a.awayGoalsPerMatch;
    out.haCrashedSeeds = ha.crashed.length;
  }
  out.elapsedSec = +((Date.now() - t0) / 1000).toFixed(1);
  console.log(JSON.stringify(out, null, 2));
  const OUTDIR = join(ROOT, 'openspec/changes/p104-volume-recalibration/notes/probes/out');
  if (!existsSync(OUTDIR)) mkdirSync(OUTDIR, { recursive: true });
  const file = join(OUTDIR, 'l1-metrics.jsonl');
  const prev = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = prev.split('\n').filter((l) => l.trim() && !l.includes(`"label":"${label}"`));
  lines.push(JSON.stringify(out));
  appendFileSync(file, ''); // 保持文件存在（幂等）
  const { writeFileSync } = await import('node:fs');
  writeFileSync(file, `${lines.join('\n')}\n`);
}
