// 把**已跑完的归档实验**（exp4b 族）提炼成判据组的**固定夹具** `exp4b-family.jsonl`。
//
// 为什么需要这一步（这是阶段 1 的关键论证，不是脚本洁癖）：
//   `drive-criteria.mjs` 只遍历 `notes/patches/*.patch`，而**exp4b 不在那里**——
//   它在 `candidates/03-decouple/` 与 `notes/probes-main/out/`（线 A/B 的扫描产物）。
//   结果是：新加的射门判据在变异自证里**一条变体都没挡住**，因为表里唯一的塌缩候选不在。
//   **判据的靶子缺席时，"变异自证通过"是空转**——与 P36 那次的教训同型
//   （断言输入对目标变异没有区分度 = 假绿）。
//
// 数据来源（全部是**已跑完的实测**，本脚本只做字段改名，不重新模拟）：
//   - `notes/probes-main/out/combos.jsonl`  → exp4b + local 组合（线 B）
//   - `notes/criteria/table.json` 里已有的行不重复（避免同一配置两条）
//
// 字段映射（唯一一处口径桥接）：归档里的 `shotsRegularPerMatch` ↔ 判据键 `shotsReg`，
// 两者同义（都是逐场按 5400s 归一后的普通射门均值；`combos.jsonl` 的
// `nSeeds`/`seeds` 字段记录了同一次扫描的种子集，阶段 1 已核对 = 本判据的 10 种子）。
//
// 用法：node build-fixtures.mjs
// 产物：exp4b-family.jsonl（每行一个配置，含 provenance）

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '../../probes-main/out');

// 归档行 → 判据行。缺 `shotsRegularPerMatch` 的（旧口径）跳过并说明——不猜。
function toRow(r, source) {
  if (r.shotsRegularPerMatch == null) return null;
  return {
    tag: `${r.tag}${r.radius ? `-R${r.radius}` : ''}`,
    hd: r.hd, spread: r.spread, gap: r.gap, width: r.width,
    latSd: r.latSd, lonSd: r.lonSd, swarm: r.swarm, straight: r.straight,
    fault: r.fault, midBack: r.midBack,
    shotsReg: r.shotsRegularPerMatch,   // ← 口径桥接：同义字段改名
    // 溯源：哪次扫描、多少种子、wasm 哈希——判据表里的每个数都要能追到一次实测
    source: `${source}（${r.mech ? `${r.mech} s=${r.strength} R=${r.radius}` : r.variant || '—'}；`
      + `${r.nSeeds || '?'} 种子；wasm ${r.wasmSha8 || '?'}）`,
  };
}

const rows = [];
const combos = join(OUT, 'combos.jsonl');
if (existsSync(combos)) {
  for (const line of readFileSync(combos, 'utf8').trim().split('\n')) {
    if (!line.trim()) continue;
    const r = toRow(JSON.parse(line), 'probes-main/out/combos.jsonl');
    if (r) rows.push(r);
  }
} else {
  console.error(`缺 ${combos}（线 B 的扫描产物，不在库里时需重跑 sweep-combo.mjs）`);
}

// exp4b **单独**跑（射门判据的原始动机靶子）。它需要前置守卫才能跑满 10 种子，
// 故不在 combos.jsonl 的自动扫描里 —— 单独归档在 exp4b-alone.json，这里读入。
const alone = join(HERE, 'exp4b-alone.json');
if (existsSync(alone)) {
  const doc = JSON.parse(readFileSync(alone, 'utf8'));
  rows.push({ ...doc.measured, tag: 'exp4b-alone+guard', source: `fixtures/exp4b-alone.json（wasm ${doc.measured.wasmSha8}）` });
} else {
  console.error('缺 fixtures/exp4b-alone.json');
}

// 去重：同一 (tag, 关键指标) 只留一条（combos.jsonl 可能有重跑追加）
const seen = new Set();
const uniq = rows.filter((r) => {
  const k = `${r.tag}|${r.hd}|${r.shotsReg}|${r.latSd}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

writeFileSync(join(HERE, 'exp4b-family.jsonl'), `${uniq.map((r) => JSON.stringify(r)).join('\n')}\n`);
console.log(`→ exp4b-family.jsonl（${uniq.length} 条）`);
for (const r of uniq) {
  console.log(`  ${r.tag.padEnd(22)} hd=${String(r.hd).padStart(6)} gap=${String(r.gap).padStart(5)} `
    + `latSd=${String(r.latSd).padStart(5)} swarm=${String(r.swarm).padStart(6)} shotsReg=${r.shotsReg}`);
}
