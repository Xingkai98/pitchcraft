// P38 #91：阈值标定 + 变异自证
//
// 输入：table.json（7 个变体 × 11 个量的实测值，由 drive-criteria.mjs 生成）
// 目标：找出「成组否决」判据的阈值，使
//   - 真实值 通过
//   - 已知 hack 变体 全部被挡（这是变异自证）
//
// 不是拍脑袋：阈值由**反推**得到，且每个阈值都标注它挡了谁、漏了谁。

import { readFileSync } from 'node:fs';

const rows = JSON.parse(readFileSync(new URL('./table.json', import.meta.url).pathname, 'utf8'));
const real = rows.find((r) => r.tag.startsWith('REAL'));
const variants = rows.filter((r) => !r.tag.startsWith('REAL'));

// ── 判据定义（每条：真实值 + 容差 + 方向）───────────────────────────────
// 方向 'band'：值须落在 real ± tol（双边）
// 方向 'min' ：值须 ≥ 阈值（下限，挡"不动"）
// 方向 'max' ：值须 ≤ 阈值（上限）
const CRITERIA = [
  { key: 'hd', name: '纵深', group: '纵向', dir: 'band', tol: 2.5 },
  { key: 'spread', name: '紧凑度', group: '纵向', dir: 'band', tol: 1.8 },
  { key: 'gap', name: '重心间距', group: '纵向', dir: 'band', tol: 1.8 },
  { key: 'latSd', name: '横向位移 sd', group: '横向', dir: 'band', tol: 3.5 },
  { key: 'swarm', name: 'y 两两相关', group: '整体性', dir: 'band', tol: 0.22 },
  { key: 'fault', name: '断层幅度', group: '结构', dir: 'band', tol: 2.5 },
  { key: 'midBack', name: '各线均衡', group: '结构', dir: 'band', tol: 0.22 },
];

const within = (v, target, tol) => v != null && Math.abs(v - target) <= tol;

console.log('=== 逐条判据：谁能挡住谁 ===\n');
for (const c of CRITERIA) {
  const t = real[c.key];
  const pass = variants.filter((v) => within(v[c.key], t, c.tol)).map((v) => v.tag);
  const fail = variants.filter((v) => !within(v[c.key], t, c.tol)).map((v) => v.tag);
  console.log(`【${c.group}】${c.name}（真实 ${t}，容差 ±${c.tol}）`);
  console.log(`   漏过（被判"达标"）：${pass.length ? pass.join(', ') : '（无）'}`);
  console.log(`   挡住：${fail.join(', ')}`);
  console.log();
}

// ── 成组否决：任一条不通过 → 整体不通过 ────────────────────────────────
console.log('=== 成组否决：全部 7 条同时达标才算通过 ===\n');
const verdict = (r) => {
  const bad = CRITERIA.filter((c) => !within(r[c.key], real[c.key], c.tol)).map((c) => c.name);
  return { pass: bad.length === 0, bad };
};
console.log(`真实值：${verdict(real).pass ? '✅ 通过' : `❌ 未通过（${verdict(real).bad.join(', ')}）`}`);
console.log();
let allBlocked = true;
for (const v of variants) {
  const r = verdict(v);
  if (r.pass) allBlocked = false;
  console.log(`  ${r.pass ? '⚠️ 漏过' : '✅ 挡住'}  ${v.tag.padEnd(24)} ${r.pass ? '' : `不达标：${r.bad.join(', ')}`}`);
}

console.log(`\n=== 变异自证 ===`);
console.log(allBlocked
  ? '✅ 全部 6 个变体被挡住 —— 判据组通过变异测试'
  : '⚠️ 有变体漏过 —— 阈值需收紧或增加判据');

// ── 输出标定结果 ────────────────────────────────────────────────────────
const spec = {
  note: 'P38 #91 判据组（成组否决：任一条不达标即不通过）',
  realReference: Object.fromEntries(CRITERIA.map((c) => [c.key, real[c.key]])),
  criteria: CRITERIA.map((c) => ({
    key: c.key, name: c.name, group: c.group,
    center: real[c.key], tol: c.tol,
    lower: +(real[c.key] - c.tol).toFixed(3),
    upper: +(real[c.key] + c.tol).toFixed(3),
  })),
  mutationSelfTest: {
    variantsBlocked: variants.every((v) => !verdict(v).pass) ? variants.length : 'NOT ALL',
    totalVariants: variants.length,
  },
};
console.log(`\n${JSON.stringify(spec, null, 2).slice(0, 400)}...`);
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./criteria-spec.json', import.meta.url).pathname, `${JSON.stringify(spec, null, 2)}\n`);
console.log('\n→ criteria-spec.json');
