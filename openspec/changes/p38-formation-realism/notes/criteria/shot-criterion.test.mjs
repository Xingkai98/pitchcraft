// P38 #91 阶段 1：**射门判据的守护测试**。
//
// 为什么要有它（而不是只靠 calibrate.mjs 打印）：
//   `calibrate.mjs` 是**报告**——它打印"挡了谁/漏了谁"。报告不会在判据退化时变红：
//   若有人把 shotsReg 的判定改成恒真、或把 floor 调到 0，`calibrate.mjs` 照样打印
//   "✅ 全部变体被挡住"以外的漂亮输出，没人会回头看。P36 的教训正是这个
//   （"口径守护要防空转断言"）——**断言必须对目标变异有区分度，且变异后必须变红**。
//
//   本测试用**变异自证**的反面：不是"证明判据对"，而是**证明判据会红**。
//   做法：故意构造会失败的输入，断言判据确实拒绝它。若哪天判据被改成空转（恒真），
//   这些"必须被判红"的断言就会失败 → 测试变红。这是**反证条**。
//
// 运行：node --test openspec/changes/p38-formation-realism/notes/criteria/shot-criterion.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(join(HERE, 'criteria-spec.json'), 'utf8'));
const shot = spec.criteria.find((c) => c.key === 'shotsReg');

// 判据的判定逻辑（与 check-criteria.mjs / calibrate.mjs 同一形状；
// 三处各自实现是因为它们跑在不同上下文——**改判定形状时三处都要改**，
// 本测试的存在就是为了保证"改坏了会红"）。
function passes(c, v) {
  if (v == null || !Number.isFinite(v)) return false;
  if (c.dir === 'min') return v >= c.floor;
  return v >= c.lower && v <= c.upper;
}

test('判据形态：shotsReg 是单边下界（不是双边带）', () => {
  assert.equal(shot.dir, 'min', 'shotsReg 必须是 min 单边；双边会拒绝引擎全部合法配置');
  assert.equal(typeof shot.floor, 'number');
  assert.ok(shot.floor > 0, 'floor 必须为正——0 会让判据恒真（空转）');
  assert.ok(!('upper' in shot), '单边判据不应有 upper——有 upper 说明被改回了双边带');
  // 真实值只作参照、不参与判定：这是 README「为什么不能用真实值标定」的机器化表达
  assert.equal(shot.centerSource, 'engine-l1-gate-lower-edge');
  assert.ok(shot.realReference > shot.floor,
    '真实参照应高于下界——若倒挂，说明口径搞反了（真实是更宽的含补射口径）');
});

test('反证条：塌缩配置必须被判红', () => {
  // exp4b 族：纵深已达标、几何全绿，只有射门塌。判据**必须**拒绝它们。
  const fixtures = readFileSync(join(HERE, 'fixtures/exp4b-family.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(fixtures.length >= 5, `夹具应有 ≥5 条，实得 ${fixtures.length}`);
  const collapsed = fixtures.filter((f) => f.shotsReg < shot.floor);
  assert.ok(collapsed.length >= 5,
    `应有多条塌缩配置被判红，实得 ${collapsed.length}/${fixtures.length}`);
  // 逐条断言（不是"至少一条"）——每一条都是一次起脚体量不足，没有例外
  for (const f of collapsed) {
    assert.equal(passes(shot, f.shotsReg), false,
      `${f.tag} 的射门 ${f.shotsReg} 低于下界 ${shot.floor}，必须被判红`);
  }
});

test('反证条：exp4b 单独是"几何全绿但射门塌"的那个配置', () => {
  // 这是本判据存在的**唯一理由**的机器化：它在几何判据全绿时仍然拦下。
  const alone = JSON.parse(readFileSync(join(HERE, 'fixtures/exp4b-alone.json'), 'utf8')).measured;
  const geom = spec.criteria.filter((c) => c.group !== '行为');
  for (const c of geom.filter((c) => ['hd', 'gap', 'spread', 'fault', 'midBack'].includes(c.key))) {
    assert.equal(passes(c, alone[c.key]), true,
      `${c.name} 在 exp4b 单独特上应为达标（该配置几何确实修好了）；若不达标，说明本测试的前提变了`);
  }
  assert.equal(passes(shot, alone.shotsReg), false,
    'exp4b 单独射门 0.5/场 —— 射门判据必须拦下它（这正是加这条判据的原因）');
});

test('反证条：合法簇必须通过（判据不能过严）', () => {
  // 引擎干净基线 + 引擎 L1 门带内的配置必须通过。否则判据永远为红、失去区分力。
  const table = JSON.parse(readFileSync(join(HERE, 'table.json'), 'utf8'));
  for (const tag of ['baseline(clean-main)']) {
    const r = table.find((x) => x.tag === tag);
    assert.ok(r, `表里应有 ${tag}`);
    assert.equal(passes(shot, r.shotsReg), true,
      `${tag} 射门 ${r.shotsReg} 在 L1 门带内，必须通过`);
  }
  // 引擎 L1 门预注册带 [6, 11] 内的值一律通过（这是 floor 的锚点来源）
  for (const v of [6.0, 7.2, 9.9, 11.0]) {
    assert.equal(passes(shot, v), true, `${v} 落在引擎 L1 门带内，必须通过`);
  }
});

test('反证条：缺失/非有限值必须判红（不能静默放过）', () => {
  // 崩溃的配置会把 shotsReg 置 NaN。NaN 若被当作"无约束"放过，
  // 等于"崩了 = 通过"——最危险的假绿。必须判红。
  for (const v of [null, undefined, NaN, Infinity]) {
    assert.equal(passes(shot, v), false, `${String(v)} 必须判红，不得静默放过`);
  }
});

test('标定表自洽：变异自证的全部变体确实被挡', () => {
  assert.equal(spec.mutationSelfTest.variantsBlocked, spec.mutationSelfTest.totalVariants,
    '变异自证未全数通过——判据组有漏网');
  assert.ok(spec.mutationSelfTest.totalVariants >= 15,
    `变体数 ${spec.mutationSelfTest.totalVariants} 偏少——夹具可能没挂上（靶子缺席 = 空转）`);
  assert.ok(spec.mutationSelfTest.fixtures.length >= 5,
    'spec 里应记录夹具溯源；夹具缺席时变异自证是空转');
});
