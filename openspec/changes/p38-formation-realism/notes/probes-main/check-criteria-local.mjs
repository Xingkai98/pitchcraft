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

// 口径桥接：线 A/B 的归档（sweep-*.mjs / p38-eval.mjs）里射门字段叫
// `shotsRegularPerMatch`，判据键叫 `shotsReg`——**同义**（都是逐场按 5400s 归一后的
// 普通射门均值）。不桥接的话归档表会把每一行都显示成"—*"（未测），
// 让人误以为"这批数据没有射门数字"，而其实有。
// ⚠️ 只桥接这一个字段：别的字段两边同名，改名会掩盖真正的缺字段。
function normalize(row) {
  if (row.shotsReg == null && row.shotsRegularPerMatch != null) {
    return { ...row, shotsReg: row.shotsRegularPerMatch };
  }
  return row;
}

// 判一行：返回 { key, ok, v }
// ⚠️ 判据有两种形态（`criteria-spec.json` 的 `dir`）：
//   'band'：双边 [lower, upper]；'min'：单边 ≥ floor（射门那一条，阶段 1 新增）。
// 加一条判据就把这里炸了——**读 spec 的脚本都得跟着 spec 的形状走**。
export function judge(row) {
  return spec.criteria.map((c) => {
    const v = row[c.key];
    const ok = v != null && Number.isFinite(v)
      && (c.dir === 'min' ? v >= c.floor : (v >= c.lower && v <= c.upper));
    return {
      key: c.key, name: c.name, group: c.group, ok, v,
      dir: c.dir, lower: c.lower, upper: c.upper, floor: c.floor,
    };
  });
}

export function report(rows, title) {
  console.log(`\n=== ${title} ===`);
  const names = spec.criteria.map((c) => c.name);
  console.log(`  ${'配置'.padEnd(20)} ${names.map((n) => n.padStart(9)).join(' ')}   通过`);
  for (const raw of rows) {
    const r = normalize(raw);
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
