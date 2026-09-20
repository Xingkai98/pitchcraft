// P38 体积补偿：把 `out/volume.jsonl` 的逐条结果按判据组的带**判绿/红**，出对比表。
//
// 判据组定义直接读 `notes/criteria/criteria-spec.json`（单一真相源，不在这里抄一遍——
// 抄一遍就会漂）。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from '../probes/repo-root.mjs';

const ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const spec = JSON.parse(readFileSync(join(ROOT, 'openspec/changes/p38-formation-realism/notes/criteria/criteria-spec.json'), 'utf8'));
const rows = readFileSync(join(ROOT, 'openspec/changes/p38-formation-realism/notes/probes-main/out/volume.jsonl'), 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l));

const verdict = (c, v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (c.dir === 'min') return v >= c.floor;
  return v >= c.lower && v <= c.upper;
};

const byTag = new Map();
for (const r of rows) byTag.set(r.tag, r);

const ORDER = process.argv.slice(2);
const tags = ORDER.length ? ORDER : [...byTag.keys()];
const keys = spec.criteria.map((c) => c.key);

console.log('判据组（成组否决；✅通过 / ❌不通过 / — 无数据）\n');
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
console.log(pad('配置', 22), keys.map((k) => padL(k, 9)).join(''), padL('绿/8', 7), padL('L1绿红', 9), '  射门(快)  进球(快)');
for (const t of tags) {
  const r = byTag.get(t);
  if (!r) continue;
  const cells = keys.map((k) => {
    const c = spec.criteria.find((x) => x.key === k);
    const vd = verdict(c, r[k]);
    return padL(vd == null ? '—' : (vd ? '✅' : '❌'), 9);
  });
  const nGreen = keys.map((k, i) => verdict(spec.criteria[i], r[k])).filter((v) => v === true).length;
  const l1 = r.l1TestTotal ? `${r.l1Passed}/${r.l1Failed}` : '—';
  console.log(pad(t, 22), cells.join(''), padL(`${nGreen}/8`, 7), padL(l1, 9),
    padL(r.qShots ?? '—', 9), padL(r.qGoals ?? '—', 10));
}

console.log('\n判据带（来自 criteria-spec.json）：');
for (const c of spec.criteria) {
  console.log(`  ${pad(c.key, 9)} ${c.dir === 'min' ? `≥ ${c.floor}` : `[${c.lower}, ${c.upper}]`}  （真实 ${c.center ?? c.realReference}）`);
}
console.log('\nL1 门（9 个 --ignored 测试；干净 main = 9 绿 0 红）：');
for (const t of tags) {
  const r = byTag.get(t);
  if (!r || !r.l1TestTotal) continue;
  console.log(`  ${pad(t, 22)} ${r.l1Passed}绿 ${r.l1Failed}红  ${(r.l1FailedNames || []).join(', ')}`);
}
