// P38 #102 第一步：**裁决「转化率是绝对常数」这条前提**。
//
// 背景与冲突（本探针存在的理由）：
//   `tradeoff-breaking.md` §3.1：`engageShift` 7.75→24.82（3.2×）时进球 0.89→3.18（3.6×）
//     → 读作「射门涨 3.2 倍就涨进球 3.6 倍 = 转化率是绝对常数」。
//   `volume-compensation.md` §2.1：`−3.4` 射门 16.6、进球 2.5（L1 200 场 17.65 / 2.25）
//     → 读作「转化率本来就是对的，抬体积后进球自动落到真实量级，不需要回调」。
//   两份文档的差异可能是**倍率**（−3.0 看着像常数、−3.4 不像），也可能来自**桶混合**漂移。
//
// 本探针做的事：**逐档同时记录** 射门/进球/**逐桶**（禁区内/禁区弧/远射）的射门数、
// 进球数、射正数 + 射正率 + 转化率，然后：
//   (a) 算 转化率 vs 射门数 的经验曲线（常数 = 水平线）；
//   (b) 看桶混合随体积怎么漂（桶内转化率固定时，混合漂移本身就能造出"非恒定"的总转化率）；
//   (c) 给出每档的 射门倍率 vs 进球倍率。
//
// 口径（与 `criteria/README.md` 一致，缺一条就错）：
//   - **只数普通射门**：`type==='shot' && detail!=='header'`（头球走 `emit_header_shot`，
//     与开放比赛射门节奏无关）。
//   - **逐场算再平均**（绝不跨场拼接）。
//   - 桶按 `dist_to_goal_m` 口径（**只按 x 纵深**，与引擎 `shot_bucket` 同口径）：
//     home 攻右 → `(1-x)*105`；away 攻左 → `x*105`（镜像）。
//   - 同时报**欧氏距离桶**作为对照——引擎的距离口径是 x-only，
//     而 `tradeoff-breaking.md` §1.2 实测欧氏口径判别力强得多（AUC 0.192 vs 0.329）。
//
// 用法：node probe-conversion-adaptive.mjs "[-4.3,-4.0,-3.7,-3.4,-3.0]" [--no-rebuild]
// 环境：SEEDS=（缺省 10 个判据种子）

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { findRepoRoot } from '../probes/repo-root.mjs';
import { VOLUME_PATCHES, applyPatches } from './volume-variants.mjs';

const ROOT = findRepoRoot(new URL('.', import.meta.url).pathname);
const shifts = JSON.parse(process.argv[2] || '[-4.3,-4.0,-3.7,-3.4,-3.0]');
const SEEDS = (process.env.SEEDS || '42,1,7,99,123,2,3,5,11,17').split(',').map(Number);

const PITCH_LENGTH_M = 105.0;
const PITCH_WIDTH_M = 68.0;
const ENGINE_DURATION_SEC = 5400;
const BOX_DIST_M = 16.5;
const ARC_DIST_M = 25.0;
const BUCKET_NAMES = ['box', 'arc', 'far'];

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

/** 起脚点到所攻球门的距离（米）。两种口径同报。 */
function distances(ev) {
  const home = ev.subject <= 10;
  const x = ev.x, y = ev.y;
  const dx = (home ? 1.0 - x : x) * PITCH_LENGTH_M;
  const dy = (home ? 0.5 - y : y - 0.5) * PITCH_WIDTH_M;
  return { depth_m: dx, euclid_m: Math.hypot(dx, dy) };
}

const bucketOf = (d) => (d <= BOX_DIST_M ? 0 : d <= ARC_DIST_M ? 1 : 2);

/** 逐场算再平均：每场先算比率，再对场取均值（不是总计数相除）。 */
const meanOver = (rows, f) => (rows.length ? rows.reduce((s, r) => s + f(r), 0) / rows.length : NaN);

const out = [];
try {
  const { loadEngineWasm, simulateStream } = await import(`${ROOT}/tools/benchmark-engine.mjs`);

  for (const shift of shifts) {
    if (process.argv.includes('--no-rebuild')) {
      // 复用当前 wasm（调试用；正式跑不要用）
    } else {
      writeFileSync(LIBSRC, applyPatches(original, [VOLUME_PATCHES.engageShift({ shift })]));
      rebuild();
    }
    const sha = createHash('sha256').update(readFileSync(WASM)).digest('hex').slice(0, 8);
    const L = await loadEngineWasm(WASM);
    if (!L.ok) throw new Error(L.message);

    const perMatch = [];
    let crashed = 0;
    for (const seed of SEEDS) {
      let ev;
      try { ev = JSON.parse(simulateStream(L.wasm, seed, ENGINE_DURATION_SEC)); }
      catch { crashed += 1; continue; }
      const  reg  = ev.filter((e) => e.type === 'shot' && e.detail !== 'header');
      const  head = ev.filter((e) => e.type === 'shot' && e.detail === 'header');
      const passes = ev.filter((e) => e.type === 'pass');
      const buckets = [0, 1, 2].map(() => ({ n: 0, goal: 0, saved: 0, off: 0 }));
      const ebuckets = [0, 1, 2].map(() => ({ n: 0, goal: 0 }));
      let euclidSum = 0;
      for (const e of reg) {
        const { depth_m, euclid_m } = distances(e);
        const b = buckets[bucketOf(depth_m)];
        b.n += 1; b[e.result] += 1;
        const eb = ebuckets[bucketOf(euclid_m)];
        eb.n += 1; if (e.result === 'goal') eb.goal += 1;
        euclidSum += euclid_m;
      }
      perMatch.push({
        seed,
        shots: reg.length,
        goals: reg.filter((e) => e.result === 'goal').length,
        saved: reg.filter((e) => e.result === 'saved').length,
        off: reg.filter((e) => e.result === 'off_target').length,
        header: head.length,
        headerGoal: head.filter((e) => e.result === 'goal').length,
        fouls: ev.filter((e) => e.type === 'foul').length,
        tackles: ev.filter((e) => e.type === 'tackle').length,
        passes: passes.length,
        passSuccess: passes.filter((e) => e.to !== undefined && e.result === 'success').length,
        buckets, ebuckets,
        euclidMean: reg.length ? euclidSum / reg.length : NaN,
      });
    }

    const n = perMatch.length;
    const S = (f) => perMatch.reduce((s, r) => s + f(r), 0);
    const shots = S((r) => r.shots);
    const goals = S((r) => r.goals);
    const saved = S((r) => r.saved);
    const per = (v) => +(v / n).toFixed(3);

    // 逐场算再平均的比率（每场先算再对场平均），同时报 pool 口径作对照
    const convPerMatch = meanOver(perMatch, (r) => (r.shots ? r.goals / r.shots : NaN));
    const otPerMatch   = meanOver(perMatch, (r) => (r.shots ? (r.goals + r.saved) / r.shots : NaN));

    const bucketRows = BUCKET_NAMES.map((name, i) => {
      const bs = perMatch.map((r) => r.buckets[i]);
      const bn = bs.reduce((s, b) => s + b.n, 0);
      const bg = bs.reduce((s, b) => s + b.goal, 0);
      const bsv = bs.reduce((s, b) => s + b.saved, 0);
      const boff = bs.reduce((s, b) => s + b.off, 0);
      // 逐场桶内转化率（该场该桶无射门 → 计入 NaN，被 meanOver 过滤）
      const convPM = meanOver(
        perMatch.map((r) => r.buckets[i]).filter((b) => b.n > 0),
        (b) => b.goal / b.n);
      return {
        bucket: name, n: bn, perMatch: per(bn), goals: bg, goalsPerMatch: per(bg),
        saved: bsv, off: boff,
        share: shots ? +(bn / shots).toFixed(4) : NaN,
        conv: bn ? +(bg / bn).toFixed(4) : NaN,
        convPerMatch: Number.isFinite(convPM) ? +convPM.toFixed(4) : NaN,
        onTarget: bn ? +((bg + bsv) / bn).toFixed(4) : NaN,
      };
    });

    // 欧氏桶（对照）
    const ebSummary = BUCKET_NAMES.map((name, i) => {
      const bn = S((r) => r.ebuckets[i].n);
      const bg = S((r) => r.ebuckets[i].goal);
      return { bucket: name, n: bn, share: shots ? +(bn / shots).toFixed(4) : NaN, conv: bn ? +(bg / bn).toFixed(4) : NaN };
    });

    const row = {
      shift, wasmSha8: sha, seeds: n, crashedSeeds: crashed,
      shotsPerMatch: per(shots),
      goalsPerMatch: per(goals + S((r) => r.headerGoal)),   // 含头球 = L1 口径
      regularGoalsPerMatch: per(goals),
      headerPerMatch: per(S((r) => r.header)),
      savedPerMatch: per(saved),
      offPerMatch: per(S((r) => r.off)),
      onTargetRatePooled: shots ? +((goals + saved) / shots).toFixed(4) : NaN,
      onTargetRatePerMatch: Number.isFinite(otPerMatch) ? +otPerMatch.toFixed(4) : NaN,
      conversionPooled: shots ? +(goals / shots).toFixed(4) : NaN,
      conversionPerMatch: Number.isFinite(convPerMatch) ? +convPerMatch.toFixed(4) : NaN,
      goalsPerShot: shots ? +(goals / shots).toFixed(4) : NaN,
      foulsPerMatch: per(S((r) => r.fouls)),
      tacklesPerMatch: per(S((r) => r.tackles)),
      shotOverTackle: S((r) => r.tackles) ? undefined : undefined,
      passesPerMatch: per(S((r) => r.passes)),
      passSuccessPooled: S((r) => r.passes) ? +(S((r) => r.passSuccess) / S((r) => r.passes)).toFixed(4) : NaN,
      euclidMean_m: Number.isFinite(meanOver(perMatch, (r) => r.euclidMean)) ? +meanOver(perMatch, (r) => r.euclidMean).toFixed(2) : NaN,
      buckets: bucketRows, euclidBuckets: ebSummary,
    };
    row.shotOverTackle = +(row.shotsPerMatch / row.tacklesPerMatch).toFixed(3);
    console.log(
      `shift ${String(shift).padStart(5)}: 射门 ${row.shotsPerMatch.toFixed(2)} 进球 ${row.goalsPerMatch.toFixed(2)} `
      + `(普通 ${row.regularGoalsPerMatch.toFixed(2)}) 转化 ${row.conversionPooled.toFixed(3)} `
      + `射正 ${row.onTargetRatePooled.toFixed(3)} | 桶 % ${bucketRows.map((b) => b.share.toFixed(2)).join('/')} `
      + `桶转化 ${bucketRows.map((b) => b.conv.toFixed(3)).join('/')} | 犯规 ${row.foulsPerMatch.toFixed(1)} `
      + `抢断 ${row.tacklesPerMatch.toFixed(2)} s/t ${row.shotOverTackle} 崩 ${crashed} (${sha})`);
    out.push(row);
  }
} finally {
  writeFileSync(LIBSRC, original);
  rebuild();
  const sha = createHash('sha256').update(readFileSync(WASM)).digest('hex').slice(0, 8);
  console.log(`[还原] lib.rs pristine，wasm ${sha}${sha === '901da77b' ? ' ✅' : ' ⚠️ 不是干净 main！'}`);
}

const OUT = join(ROOT, 'openspec/changes/p38-formation-realism/notes/probes-main/out');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'conversion-arbitration.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(`→ ${join(OUT, 'conversion-arbitration.json')}`);
