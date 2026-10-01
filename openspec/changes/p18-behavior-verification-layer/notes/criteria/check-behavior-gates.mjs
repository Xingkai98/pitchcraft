#!/usr/bin/env node
// P18 **行为判据器**（报告期：**退出码恒 0，不阻塞 verify.sh**）。
//
// 读两个产物：
//   引擎侧  engine/target/p18-gates/canary.json   （由 `p18_behavior_gates.rs` 落盘）
//   真实侧  notes/criteria/real-behavior-reference.json（入库，见 real-behavior.mjs）
// 按 `gates-spec.json` 成组否决 → 打印倍数 / 分位 / 每条的状态。
//
// ⚠️ **为什么退出码恒 0**（design §3.4，用户裁定）：
//   引擎现状与真实参照差 2–10×，**本来就过不了**。立成硬门会一直红到 `#19` 做完。
//   本判据的价值在**守住已修好的状态**，不在逼现在变绿。
//   **升门的前置**：#19 交付合格机制后 → 用它标定工程带宽 → 把 exit 码接进 verify.sh。
//   （同 P38 `check-criteria.mjs` 的形态。）
//
// 唯一的**门槛**在 `gates.test.mjs`——它守的是「判据没被改坏」，不是「引擎达标」。
//
// 用法：
//   node check-behavior-gates.mjs                      # 用默认路径
//   node check-behavior-gates.mjs --engine <p> --real <p>

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../../../..');

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const ENGINE_PATH = argOf('--engine', join(ROOT, 'engine/target/p18-gates/canary.json'));
const REAL_PATH = argOf('--real', join(HERE, 'real-behavior-reference.json'));
const SPEC_PATH = argOf('--spec', join(HERE, 'gates-spec.json'));

export function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** 从产物里按 `a.b.c` 取数（支持 `reference.A_x` 这种嵌套键）。 */
export function pick(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

const fmt = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : String(x));

/** 判据求值：返回 {ok, detail}。**报告期**——ok 只用于打印，不用于退出码。 */
export function evaluate(c, engineRef, realRef) {
  const e = pick(engineRef, `reference.${c.engineKey}`)?.center;
  const r = pick(realRef, `reference.${c.realKey}`)?.center;
  if (!Number.isFinite(e) || !Number.isFinite(r)) {
    return { ok: false, detail: `缺值（引擎 ${e} / 真实 ${r}）`, e, r };
  }
  const ratio = r !== 0 ? e / r : Infinity;
  if (c.kind === 'guardrail') {
    // 护栏的锚 = **现状 × 因子**（用户 2026-09-30 裁定）。
    // ⚠️ 两个方向都实现：`min` ⇒ 下界（现状 × f，不得更低）；`max` ⇒ 上界（现状 ÷ f，不得更高）。
    // 此前只实现 `min` 且 `dir` 是死字段——`dir` 翻反不会被任何测试发现（第一轮审阅的变异缺口）。
    if (c.dir !== 'min' && c.dir !== 'max') {
      return { ok: false, detail: `护栏 dir 非法：${c.dir}（应为 min|max）`, e, r, ratio };
    }
    const bound = c.dir === 'min' ? e * c.floorFactor : e / c.floorFactor;
    return {
      ok: true,  // 护栏在报告期恒为「信息」——它的锚是现状，现状必然满足
      detail: `护栏：${c.dir === 'min' ? '下界 floor' : '上界 ceil'} = 现状 ${c.dir === 'min' ? '×' : '÷'} `
        + `${c.floorFactor} = ${fmt(bound)}（真实参照 ${fmt(r)}，倍数 ${fmt(ratio, 2)}×）`,
      e, r, ratio, bound, dir: c.dir,
    };
  }
  // `upperRatio`：引擎/真实 的倍数**不得超**此值（引擎偏高型，如 A1/A2）
  // `minRatio`  ：引擎/真实 的倍数**不得低于**此值（引擎偏低型，如 B4）
  const up = c.band?.upperRatio;
  const lo = c.band?.minRatio;
  let ok = true; const why = [];
  if (up != null) { const g = ratio <= up; ok &&= g; why.push(`倍数 ${fmt(ratio, 2)}× ${g ? '≤' : '>'} ${up}×`); }
  if (lo != null) { const g = ratio >= lo; ok &&= g; why.push(`倍数 ${fmt(ratio, 2)}× ${g ? '≥' : '<'} ${lo}×`); }
  return { ok, detail: why.join('；'), e, r, ratio };
}

function main() {
  const missing = [ENGINE_PATH, REAL_PATH, SPEC_PATH].filter((p) => !existsSync(p));
  if (missing.length) {
    console.log('===== P18 行为判据（报告期；**不阻塞**）=====');
    console.log('⚠️ 缺产物，跳过（不算失败）：');
    for (const p of missing) console.log(`   ${p}`);
    console.log('   引擎侧产物生成：P18_SOURCE_COMMIT=$(git rev-parse HEAD) \\');
    console.log('     cargo test --release --test p18_behavior_gates -- --ignored --nocapture p18_canary');
    console.log('   （该产物是 gitignored 的 build artifact；verify.sh 与 CI 不生成它，'
      + '故本步在干净 checkout 上走的就是这一支——**报告期仍然成立**。）');
    return 0;
  }
  const spec = loadJson(SPEC_PATH);
  const engine = loadJson(ENGINE_PATH);
  const real = loadJson(REAL_PATH);

  // ── provenance 检查（spec requirement「两侧产物都必须带 provenance」）──
  const provProblems = [];
  for (const p of spec.engineArtifact.requiredProvenance) {
    if (engine.provenance?.[p] == null) provProblems.push(`引擎侧缺 provenance.${p}`);
  }
  for (const p of spec.realArtifact.requiredProvenance) {
    if (p.startsWith('source.')) {
      if (pick(real, p) == null) provProblems.push(`真实侧缺 ${p}`);
    } else if (real[p] == null) provProblems.push(`真实侧缺 ${p}`);
  }

  console.log('===== P18 行为判据（报告期；**不阻塞**）=====');
  console.log(`引擎侧: ${ENGINE_PATH}`);
  console.log(`   mode=${engine.provenance?.mode} seeds=${engine.provenance?.seed_first}..${engine.provenance?.seed_last}`);
  console.log(`   caliber=${engine.provenance?.caliber_version} engine_fp=${engine.provenance?.engine_source_fingerprint}`);
  console.log(`   generated_by=${engine.provenance?.generated_by}`);
  console.log(`真实侧: ${REAL_PATH}`);
  console.log(`   caliber=${real.caliberVersion} games=${real.source?.nGames} competition=${(real.source?.competition ?? []).join('；')}`);
  if (provProblems.length) {
    console.log(`⚠️ provenance 问题：\n   ${provProblems.join('\n   ')}`);
  }

  let anyFail = false;
  console.log('\n── 判据（成组否决：任一不达标 ⇒ 整体不通过）──');
  for (const c of spec.criteria) {
    const v = evaluate(c, engine, real);
    if (!v.ok) anyFail = true;
    const tag = c.kind === 'guardrail' ? '护栏' : (v.ok ? '通过' : '不通过');
    console.log(`[${c.key}] ${c.name}`);
    console.log(`   引擎 ${fmt(v.e)}  真实 ${fmt(v.r)}  倍数 ${fmt(v.ratio, 2)}×   → ${tag}`);
    console.log(`   ${v.detail}`);
    // 护栏的**对照栏**（用户 2026-09-30 裁定：C1 必须并列报「每场次数」）
    const ck = c.band?.companionKey;
    if (ck) {
      const ce = pick(engine, `reference.${ck}`)?.center;
      console.log(`   对照栏 ${ck}: 引擎 ${fmt(ce)}  真实 ${fmt(c.band.companionReal)}`
        + `（${fmt(ce / c.band.companionReal, 2)}×）—— 占比栏分母不可比，**这一栏才可比**`);
    }
  }

  console.log(`\n── 整体：${anyFail ? '**不通过**（预期——引擎现状与真实差 2–10×）' : '通过'} ──`);
  console.log('⚠️ 本判据**报告期**：退出码恒 0，不阻塞 verify.sh（design §3.4）。');
  console.log('   升门前置：#19 交付合格机制 → 标定工程带宽 → 把 exit 码接进 verify.sh。');

  console.log('\n── 已排除的候选（不静默消失）──');
  for (const x of spec.excluded) console.log(`[${x.key}] ${x.name} —— ${x.status}：${x.reason.slice(0, 60)}…`);
  console.log('\n── 已声明的不可得 ──');
  for (const x of spec.unavailable) console.log(`[${x.key}] ${x.name} —— ${x.availableInstead ?? ''}`);

  return 0;  // **恒 0**
}

// 仅在被直接执行时跑 main（import 时不跑，便于 gates.test.mjs 复用）
if (process.argv[1] && process.argv[1].endsWith('check-behavior-gates.mjs')) {
  process.exit(main());
}
