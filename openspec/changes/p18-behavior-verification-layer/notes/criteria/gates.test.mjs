#!/usr/bin/env node
// P18 **反证条**（本 change **唯一的门槛**——进 verify.sh，判据退化时会红）。
//
// ## 它守的是什么（务必读清楚，别高估）
//
// 它守的是「**判据没被改坏**」，**不是**「判据组能分辨真改善」。
// 后者需要「合法配置簇」，而那只在 `#19` 交付机制之后才存在（design §4 / §3.4）。
// ⚠️ **不得**把本文件读成后者。
//
// ## 它怎么守
//
// 1. **逐条反证**：对每条判据构造「恰好越该条限、不越其余条限」的输入 ⇒ 只有该条红。
// 2. **区分度**：反证输入必须在目标判据上越限、在其余判据上不越限（P36 的教训）。
// 3. **成组否决**：任一不达标 ⇒ 整体不通过。
// 4. **合成变体**：改一个量不影响别的量的判定（防判据互相买账）。
// 5. **真实历史变体**：`#17A` 实测的 `BASE_ACTION_DEADLINE_TICKS` 7→3（间隔 12.64 → 8.54 s）
//    ——**仍然全红**。⚠️ 如实标注：它证明的是**谓词接线**（见下）。
// 6. **产物同源**：真实侧参照 JSON 与源 CSV 的 sha256 一致（原始数据存在时）。
// 7. **口径回归**：`gates-spec.json` 的每条判据都带 `sameThing` 与 `denominatorComparable`。
//
// 跑法：node --test gates.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { evaluate, loadJson, pick } from './check-behavior-gates.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../../../..');
const SPEC_PATH = join(HERE, 'gates-spec.json');
const REAL_PATH = join(HERE, 'real-behavior-reference.json');

/** 造一个「引擎侧产物」的替身（只含判据需要的 reference 结构）。 */
const fakeEngine = (over = {}) => ({
  schema: 'p18-engine-behavior-gates/1',
  provenance: {
    mode: 'synthetic', seed_first: 1, seed_last: 30,
    engine_source_fingerprint: 'fnv1a64:synthetic',
    caliber_version: 'test', generated_by: 'gates.test.mjs',
  },
  reference: {
    A_chainDurPos: { center: 49.6507 }, A_gapSS: { center: 12.6355 },
    B_coverShare: { center: 0.0581 },
    A_actsAll: { center: 3.9016 }, C_shotLastShare: { center: 0.1767 },
    C_shotLastChains: { center: 18.0333 },
    ...over,
  },
});

const SPEC = loadJson(SPEC_PATH);
const REAL = loadJson(REAL_PATH);
const specOf = (key) => SPEC.criteria.find((c) => c.key === key);

/** 「全部达标」的基线——区分度与成组否决的测试必须从这里出发
 *  （从**引擎现状**出发的话每条都已经是红的，测不出"只有该条红"）。 */
const PASSING = {
  A_chainDurPos: { center: REAL.reference.A_chainDurPos.center },
  A_gapSS: { center: REAL.reference.A_gapSS.center },
  B_coverShare: { center: REAL.reference.B_coverShare.center },
  A_actsAll: { center: REAL.reference.A_actsAll.center },
  C_shotLastShare: { center: REAL.reference.C_shotLast.center },
  C_shotLastChains: { center: REAL.reference.C_shotEndChains.center },
};
const passingEngine = (over = {}) => fakeEngine({ ...PASSING, ...over });

// ── 1. 每条判据：反证输入 ⇒ 该条红 ──

test('反证条 A1：链时长塌到真实水平 ⇒ A1 通过（判据不是恒红）', () => {
  const c = specOf('A1');
  const v = evaluate(c, fakeEngine({ A_chainDurPos: { center: 10.18 } }), REAL);
  assert.equal(v.ok, true, `塌到真实值应通过，实际：${v.detail}`);
});

test('反证条 A1：链时长超真实 1.5× ⇒ A1 红', () => {
  const c = specOf('A1');
  const v = evaluate(c, fakeEngine({ A_chainDurPos: { center: 10.18 * 1.6 } }), REAL);
  assert.equal(v.ok, false, '超 1.5× 应判红');
});

test('反证条 A2：间隔超真实 1.5× ⇒ A2 红；等于真实 ⇒ 通过', () => {
  const c = specOf('A2');
  assert.equal(evaluate(c, fakeEngine({ A_gapSS: { center: 3.2 } }), REAL).ok, true);
  assert.equal(evaluate(c, fakeEngine({ A_gapSS: { center: 3.2 * 1.6 } }), REAL).ok, false);
});

test('反证条 B4：覆盖占比低于真实一半 ⇒ B4 红；达到真实一半 ⇒ 通过', () => {
  const c = specOf('B4');
  assert.equal(evaluate(c, fakeEngine({ B_coverShare: { center: 0.25 * 0.5609 } }), REAL).ok, false,
    '低于真实一半应红');
  assert.equal(evaluate(c, fakeEngine({ B_coverShare: { center: 0.51 * REAL.reference.B_coverShare.center } }), REAL).ok, true,
    '略高于真实一半应通过（下界闭）');
});

// ── 2. 区分度：反证输入不越其他判据的限 ──

test('基线自检：PASSING 基线必须**全绿**（否则后面的区分度测试是空转）', () => {
  const bad = SPEC.criteria.filter((c) => !evaluate(c, passingEngine(), REAL).ok);
  assert.equal(bad.length, 0, `PASSING 基线应全绿，但 ${bad.map((c) => c.key).join(',')} 为红`);
});

test('区分度：把 A1 越限的输入不越 A2/B4 的限', () => {
  const over = passingEngine({ A_chainDurPos: { center: REAL.reference.A_chainDurPos.center * 1.6 } });
  assert.equal(evaluate(specOf('A1'), over, REAL).ok, false, 'A1 应红');
  assert.equal(evaluate(specOf('A2'), over, REAL).ok, true, 'A2 不应受影响');
  assert.equal(evaluate(specOf('B4'), over, REAL).ok, true, 'B4 不应受影响');
});

test('区分度：把 B4 越限的输入不越 A1/A2 的限', () => {
  const over = passingEngine({ B_coverShare: { center: REAL.reference.B_coverShare.center * 0.1 } });
  assert.equal(evaluate(specOf('B4'), over, REAL).ok, false, 'B4 应红');
  assert.equal(evaluate(specOf('A1'), over, REAL).ok, true);
  assert.equal(evaluate(specOf('A2'), over, REAL).ok, true);
});

// ── 3. 成组否决 ──

test('成组否决：任一不达标 ⇒ 整体不通过', () => {
  const allOk = SPEC.criteria.every((c) => evaluate(c, passingEngine(), REAL).ok);
  assert.equal(allOk, true, '全部达标的输入应整体通过（否则判据组恒红）');

  const oneBad = passingEngine({ A_gapSS: { center: REAL.reference.A_gapSS.center * 2 } });
  const anyBad = SPEC.criteria.some((c) => !evaluate(c, oneBad, REAL).ok);
  assert.equal(anyBad, true, '一条超标应使整体不通过');
});

// ── 4. 合成变体：改一个量不影响别的量的判定 ──

test('合成变体：单量变化只影响该量所在的判据', () => {
  const base = passingEngine();
  const before = SPEC.criteria.map((c) => evaluate(c, base, REAL).ok);
  const after = SPEC.criteria.map((c) => evaluate(c, passingEngine({ A_gapSS: { center: 999 } }), REAL).ok);
  const changed = before.map((b, i) => b !== after[i]);
  assert.equal(changed.filter(Boolean).length, 1, `应恰好 1 条改变，实际 ${changed.filter(Boolean).length}`);
  assert.equal(SPEC.criteria[changed.indexOf(true)].key, 'A2');
});

// ── 5. 真实历史变体（#17A 实测）──

test('真实历史变体：BASE_ACTION_DEADLINE_TICKS 7→3（间隔 12.64→8.54 s）仍然全红', () => {
  // ⚠️ 如实标注：8.54 s 距真实 3.20 s 还有 2.67× ⇒ 全红是**必然的**。
  // 本条证明的是**谓词接线正确**，**不是**「判据能分辨真改善」（design §4）。
  const variant = fakeEngine({ A_gapSS: { center: 8.54 } });
  const v = evaluate(specOf('A2'), variant, REAL);
  assert.equal(v.ok, false, '8.54 s 应仍判红');
  assert.ok(v.ratio > 2.6, `倍数应约 2.67×，实际 ${v.ratio}`);
});

// ── 6. 产物同源（原始数据存在时）──

test('真实侧参照 JSON 与源 CSV 的 sha256 一致（缺原始数据则跳过）', () => {
  const dir = join(ROOT, '.scratch/tracking-data/skillcorner/opendata-master/data/matches');
  const ids = Object.keys(REAL.source.csvSha256);
  assert.ok(ids.length > 0, '参照 JSON 应记有 CSV 哈希（否则同源校验空转）');
  if (!existsSync(dir)) {
    console.log('   （原始数据不存在，跳过 sha256 校验——按 P38 先例）');
    return;
  }
  let checked = 0;
  for (const id of ids) {
    const p = join(dir, id, `${id}_dynamic_events.csv`);
    if (!existsSync(p)) continue;
    const h = createHash('sha256').update(readFileSync(p)).digest('hex');
    assert.equal(h, REAL.source.csvSha256[id], `${id} 的 CSV 与参照 JSON 记录不一致（陈旧）`);
    checked += 1;
  }
  assert.ok(checked > 0, '一台 CSv 都没校验到——检查路径');
});

// ── 7. 口径回归守卫 ──

test('每条判据都必须带 sameThing 与 denominatorComparable（口径可审计）', () => {
  for (const c of SPEC.criteria) {
    assert.ok(typeof c.sameThing === 'string' && c.sameThing.length > 20,
      `[${c.key}] 缺 sameThing（本 change 的头号教训：必须声明两侧测的是不是同一件事）`);
    assert.ok(typeof c.denominatorComparable === 'string' && c.denominatorComparable.length >= 4,
      `[${c.key}] 缺 denominatorComparable（分母可比性——第二轮 grill 的教训）`);
  }
});

test('已排除的候选必须留档（不静默消失）', () => {
  assert.ok(Array.isArray(SPEC.excluded) && SPEC.excluded.length >= 4,
    '应至少留档 4 条被排除的候选');
  for (const x of SPEC.excluded) {
    assert.ok(x.reason && x.reason.length > 10, `[${x.key}] 排除理由过短`);
    assert.ok(x.status, `[${x.key}] 缺 status`);
  }
});

test('不可得的类必须显式声明（含「缺什么才能得到它」）', () => {
  const d = SPEC.unavailable.find((x) => x.key === 'D-restart');
  assert.ok(d, 'restart 的不可得声明必须存在');
  assert.ok(d.toMakeItAvailable && d.toMakeItAvailable.length > 10,
    '必须写明缺什么才能得到它（spec requirement）');
});

test('护栏条必须锚「现状 × 因子」并并列报真实参照', () => {
  for (const key of ['A3', 'C1']) {
    const c = specOf(key);
    assert.equal(c.kind, 'guardrail', `[${key}] 应是护栏`);
    assert.ok(Number.isFinite(c.floorFactor), `[${key}] 缺 floorFactor`);
    assert.ok(Number.isFinite(c.realCenter), `[${key}] 必须并列报真实参照`);
    assert.ok(c.anchorNote.includes('用户'), `[${key}] 应记明锚是用户裁定`);
  }
  assert.ok(typeof specOf('C1').band.companionKey === 'string' && specOf('C1').band.companionKey.length > 0,
    'C1 应有「每场次数」伙伴栏 key（用户裁定的对照栏）');
  assert.ok(Number.isFinite(specOf('C1').band.companionReal), 'C1 的伙伴栏应带真实参照值');
});

test('护栏条的 realKey 必须能在真实产物里命中，且 center 与 spec 的 realCenter 相符（防串线）', () => {
  // ⚠️ 变异缺口（第一轮审阅）：护栏的 evaluate 恒 ok:true ⇒ realKey 串线不会被发现。
  // 本守卫把它钉住。
  for (const c of SPEC.criteria) {
    const v = pick(REAL, `reference.${c.realKey}`)?.center;
    assert.ok(Number.isFinite(v), `[${c.key}] realKey=${c.realKey} 在真实产物里取不到 center（串线？）`);
    if (Number.isFinite(c.realCenter)) {
      assert.ok(Math.abs(v - c.realCenter) < Math.max(1e-3, Math.abs(c.realCenter) * 0.01),
        `[${c.key}] realKey=${c.realKey} 的 center ${v} 与 spec.realCenter ${c.realCenter} 不符`);
    }
    // `dir` 必须与 `band` 的实际形态一致（criterion 的 dir 此前是死字段）
    if (c.kind === 'criterion') {
      const expect = c.band?.upperRatio != null ? 'upper' : (c.band?.minRatio != null ? 'lower' : 'band');
      // 注：B4 的 dir 标成 'band'，但其 band 只有 minRatio（单边）——两者都接受
      assert.ok([expect, 'band'].includes(c.dir), `[${c.key}] dir=${c.dir} 与 band 形态（${expect}）不一致`);
    } else {
      assert.ok(['min', 'max'].includes(c.dir), `[${c.key}] 护栏 dir=${c.dir} 不在枚举内`);
    }
  }
});

test('护栏的 dir 必须与「目标方向」一致（变异缺口：dir 曾是死字段）', () => {
  // 第一轮审阅证明：把 C1 的 dir 从 min 改成 max，旧版 `evaluate` 无任何反应。
  // **真正该守的不是"dir 被消费"，而是"dir 的方向对"**：
  //   护栏防的是**过度漂移**——真实值低于现状 ⇒ 目标方向是下降 ⇒ 护栏应是**下界**（min），
  //   即"不得降到 floor 以下"；反之若是 max（不得高于 ceil），就防错了方向。
  for (const key of ['A3', 'C1']) {
    const c = specOf(key);
    const expect = c.realCenter < c.engineCenter ? 'min' : 'max';
    assert.equal(c.dir, expect,
      `[${key}] 真实 ${c.realCenter} vs 现状 ${c.engineCenter} ⇒ 目标方向是`
      + `${c.realCenter < c.engineCenter ? '下降' : '上升'}，护栏应为 ${expect}`);
    const v = evaluate(c, fakeEngine(), REAL);
    assert.ok(Number.isFinite(v.bound), `[${key}] 护栏必须给出有限 bound`);
    assert.equal(v.dir, c.dir, `[${key}] evaluate 必须把 dir 带进结果（否则是死字段）`);
  }
  // 非法 dir 必须判错，不得静默当 min
  const bad = evaluate({ ...specOf('C1'), dir: 'sideways' }, fakeEngine(), REAL);
  assert.equal(bad.ok, false, '非法 dir 应判错（不得静默当 min）');
});

test('每条判据的 engineKey 必须能在引擎产物里命中（防静默 undefined）', () => {
  const engine = existsSync(join(ROOT, 'engine/target/p18-gates/canary.json'))
    ? loadJson(join(ROOT, 'engine/target/p18-gates/canary.json')) : null;
  if (!engine) { console.log('   （引擎产物不存在，跳过——按缺产物纪律）'); return; }
  for (const c of SPEC.criteria) {
    assert.ok(Number.isFinite(pick(engine, `reference.${c.engineKey}`)?.center),
      `[${c.key}] engineKey=${c.engineKey} 在引擎产物里取不到 center`);
  }
});

test('结构：判据组整体含至少一条结构性条（spec requirement）', () => {
  const structural = SPEC.criteria.filter((c) => c.kindClass === 'structural');
  assert.ok(structural.length >= 1,
    '判据组**整体**必须至少一条结构性条（B4）——spec「组内不得只有均值条」');
  assert.equal(structural[0].key, 'B4');
});

// ── 8. 判据器本身：不缺产物时退出码恒 0（报告期）──

test('判据器退出码恒 0（报告期，不阻塞）', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, [join(HERE, 'check-behavior-gates.mjs')], { encoding: 'utf8' });
  assert.ok(out.includes('报告期'), '输出应标明报告期');
  // execFileSync 不抛 = 退出码 0
});

test('判据器**输出**里必须真的出现 C1 的对照栏（每场次数）——不是只检查字段存在', async () => {
  const { execFileSync } = await import('node:child_process');
  const enginePath = join(ROOT, 'engine/target/p18-gates/canary.json');
  if (!existsSync(enginePath)) { console.log('   （引擎产物不存在，跳过）'); return; }
  const out = execFileSync(process.execPath, [join(HERE, 'check-behavior-gates.mjs')], { encoding: 'utf8' });
  const companion = specOf('C1').band.companionKey;
  assert.ok(out.includes(companion), `输出应含 C1 的对照栏 ${companion}（用户裁定的「每场次数」）`);
  assert.ok(/22\.75|22\.8/.test(out), '输出应含真实侧的每场次数（22.75）');
  assert.ok(out.includes('对照栏'), '输出应把对照栏与主栏区分开');
});

test('判据器不得读 gitignored 的原始数据（spec requirement）', () => {
  const src = readFileSync(join(HERE, 'check-behavior-gates.mjs'), 'utf8');
  // 剥注释再扫（防自指：说明文字里也提到 tracking-data）
  const stripped = src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(!/tracking-data/.test(stripped),
    '判据器不得在代码里依赖 .scratch/tracking-data（只读入库的小 JSON）');
});

// ── 9. provenance / 陈旧哨兵（第一轮审阅抓到的缺口）──

test('缺 provenance 的判据被拒：判据器必须**报出**问题（不只是打印算过）', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync: wf } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const enginePath = join(ROOT, 'engine/target/p18-gates/canary.json');
  if (!existsSync(enginePath)) { console.log('   （引擎产物不存在，跳过）'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'p18prov-'));
  const brokenReal = JSON.parse(JSON.stringify(REAL));
  delete brokenReal.caliberVersion; delete brokenReal.source.csvSha256;
  const rp = join(dir, 'real.json');
  wf(rp, JSON.stringify(brokenReal));
  const out = execFileSync(process.execPath,
    [join(HERE, 'check-behavior-gates.mjs'), '--real', rp], { encoding: 'utf8' });
  assert.ok(out.includes('provenance 问题'), '缺 provenance 时判据器必须报出问题');
  assert.ok(out.includes('caliberVersion'), '应指明缺哪个字段');
  assert.ok(out.includes('csvSha256'), '应指明缺哪个字段');
});

test('陈旧哨兵：产物的引擎源码指纹必须与当前源码一致（否则是旧 commit 的读数）', () => {
  const enginePath = join(ROOT, 'engine/target/p18-gates/canary.json');
  if (!existsSync(enginePath)) { console.log('   （引擎产物不存在，跳过——CI 走这一支）'); return; }
  const engine = loadJson(enginePath);
  // 当前源码指纹：与 p18_behavior_gates.rs 的 ENGINE_SOURCES/TEST_SOURCES 同构造
  const fnv = (t) => { let h = 0xcbf29ce484222325n;
    for (const b of Buffer.from(t, 'utf8')) { h ^= BigInt(b); h = BigInt.asUintN(64, h * 0x100000001b3n); }
    return 'fnv1a64:' + h.toString(16).padStart(16, '0'); };
  const fp = (srcs) => fnv(srcs.map(([n, t]) => `${n}\n${t}\n`).join(''));
  const engSrc = [['lib.rs', readFileSync(join(ROOT, 'engine/src/lib.rs'), 'utf8')],
    ['observation.rs', readFileSync(join(ROOT, 'engine/src/observation.rs'), 'utf8')],
    ['rng.rs', readFileSync(join(ROOT, 'engine/src/rng.rs'), 'utf8')]];
  assert.equal(engine.provenance.engine_source_fingerprint, fp(engSrc),
    '产物的引擎源码指纹与当前源码不符 ⇒ 该产物是旧 commit 的读数（重生成：见 p18_behavior_gates.rs 头注释）');
  const testSrc = [['p18_behavior_gates.rs', readFileSync(join(ROOT, 'engine/tests/p18_behavior_gates.rs'), 'utf8')],
    ['p18/gates.rs', readFileSync(join(ROOT, 'engine/tests/p18/gates.rs'), 'utf8')]];
  assert.equal(engine.provenance.test_source_fingerprint, fp(testSrc),
    '产物的测试源码指纹与当前不符 ⇒ 口径改过但产物没重生成');
});
