// P38 判据组核对（**可移植版**）：对 out/*.json 里已经跑出来的结果逐条判达标。
//
// 为什么另写：`notes/criteria/check-criteria.mjs` 是"对**当前** wasm 求值"的实时脚本，
// 且路径硬编码到另一个 worktree。线 A/B 的产出是**一批已跑完的 JSON**（lag 扫描、
// 变体、参照点），需要的是**按表判**而不是"再跑一次"。
// 阈值直接读 `notes/criteria/criteria-spec.json`（唯一真源，不复制数字）。
//
// 用法：
//   node check-criteria-local.mjs                 # 读 out/lag-sweep.json + out/variants.jsonl + out/reference.json
//   node check-criteria-local.mjs <file.json>     # 判任意单文件（一行 JSON 或 JSON 数组）

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = join(HERE, '../criteria/criteria-spec.json');
const OUT = join(HERE, 'out');

const spec = JSON.parse(readFileSync(SPEC, 'utf8'));
const KEYS = spec.criteria.map((c) => c.key);

// 判一行：返回 { key, ok, v }
export function judge(row) {
  return spec.criteria.map((c) => {
    const v = row[c.key];
    const ok = v != null && Number.isFinite(v) && v >= c.lower && v <= c.upper;
    return { key: c.key, name: c.name, group: c.group, ok, v, lower: c.lower, upper: c.upper };
  });
}

export function report(rows, title) {
  console.log(`\n=== ${title} ===`);
  const names = spec.criteria.map((c) => c.name);
  console.log(`  ${'配置'.padEnd(20)} ${names.map((n) => n.padStart(9)).join(' ')}   通过`);
  for (const r of rows) {
    const j = judge(r);
    const cells = j.map((x) => {
      const s = x.v == null || !Number.isFinite(x.v) ? '—' : x.v.toFixed(2);
      return (x.ok ? ' ' : '') + s.padStart(x.ok ? 9 : 8) + (x.ok ? ' ' : '*');
    });
    const nPass = j.filter((x) => x.ok).length;
    const label = r.tag || `${r.variant}-${r.lag}`;
    console.log(`  ${label.padEnd(20)} ${cells.join(' ')}   ${nPass}/${j.length}${nPass === j.length ? ' ✅' : ''}`);
  }
  console.log('  （列尾 * = 该条不达标；阈值见 notes/criteria/criteria-spec.json）');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2];
  const rows = [];
  if (arg) {
    const d = JSON.parse(readFileSync(arg, 'utf8'));
    rows.push(...(Array.isArray(d) ? d : [d]));
  } else {
    for (const f of ['lag-sweep.json', 'variants.jsonl', 'reference.json']) {
      const p = join(OUT, f);
      if (!existsSync(p)) continue;
      const txt = readFileSync(p, 'utf8').trim();
      if (!txt) continue;
      if (f.endsWith('.jsonl')) rows.push(...txt.split('\n').filter(Boolean).map((l) => JSON.parse(l)));
      else { const d = JSON.parse(txt); rows.push(...(d.rows || (Array.isArray(d) ? d : [d]))); }
    }
    // 去重：同一配置可能因**口径修正**跑过两次（拼接 → 逐场，见 probe-latsd-caliber.mjs），
    // 老行仍留在 jsonl 里。键必须**只用配置字段**、不能回退到 `tag`
    // （老行的 tag 是 `lag0.1`，新行没有 tag —— 混用键会导致去重失效，踩过一次）。
    const key = (r) => (r.variant
      ? `${r.variant}|${r.lag}|${r.curveK ?? ''}`
      : r.mech ? `${r.mech}|${r.strength}|${r.radius ?? ''}|${r.combo ?? ''}` : `tag:${r.tag}`);
    const seen = new Map();
    for (const r of rows) seen.set(key(r), r);
    rows.length = 0; rows.push(...seen.values());
  }
  report(rows, 'P38 判据组（报告期，成组否决）');
}
