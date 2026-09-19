// P38 #91：对**当前**引擎求值判据组，与 criteria-spec.json 比对，打印逐条结论。
//
// ⚠️ 形态说明（重要，别急着改成硬门）：
//   本脚本当前是**报告期**——只打印，不产生 pass/fail、不阻塞 verify.sh。
//   理由：引擎现状（纵深 40.5 vs 靶子 25.9）**本来就达标不了**——它是"确实还没修"，
//   不是"判据错了"。立成硬门会立即变红并一直红到 #89（队形机制）做完为止，
//   这与 P37 把 half-split 降级为报告项是同一个道理（docs: design D7）。
//
//   **升格为门的前提**：#89 交付一个通过判据的机制方案。届时本脚本改 `exit 1`
//   即成为防回归的 ratchet 门——它的价值在**守住已修好的状态**，不在逼着现在变绿。
//
// 与 drive-criteria.mjs 的分工：
//   - 本脚本：轻量，只测**当前** wasm（CI 友好，几秒）
//   - drive-criteria.mjs：重量，逐个应用 6 个补丁重建 wasm 做**变异自证**（开发期用）

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../../../..');
const SPEC = join(HERE, 'criteria-spec.json');

if (!existsSync(SPEC)) {
  console.log('跳过：缺 criteria-spec.json（先跑 drive-criteria.mjs + calibrate.mjs）');
  process.exit(0);
}
// 真实数据缺失时跳过（P36 惯例：缺基线跳过而非失败）
if (!existsSync(join(ROOT, 'viewer/data/real-game-1.json'))) {
  console.log('跳过：缺真实侧数据（viewer/data/real-game-*.json）');
  process.exit(0);
}

const spec = JSON.parse(readFileSync(SPEC, 'utf8'));
const out = spawnSync('node', [join(HERE, 'eval-criteria.mjs'), 'current'], { encoding: 'utf8', cwd: ROOT });
if (out.status !== 0) {
  console.log('跳过：评测器未能运行（可能缺 engine.wasm）');
  process.exit(0);
}
const cur = JSON.parse(out.stdout.trim().split('\n').pop());

console.log('=== P38 队形判据（报告期：只打印，不判定）===');
console.log('（判据组定义见 notes/criteria/README.md；成组否决，任一条不达标即不通过）\n');
let bad = 0;
for (const c of spec.criteria) {
  const v = cur[c.key];
  const ok = v != null && v >= c.lower && v <= c.upper;
  if (!ok) bad += 1;
  const shown = v == null ? '—' : (typeof v === 'number' ? v.toFixed(3) : v);
  console.log(`  ${ok ? '✅' : '❌'} [${c.group}] ${c.name.padEnd(12)} 当前 ${String(shown).padStart(8)}   目标 [${c.lower}, ${c.upper}]`);
}
console.log(`\n  ${bad === 0 ? '全部达标' : `${bad}/${spec.criteria.length} 条不达标`}`);
console.log('\n注：本步不阻塞（报告期）。引擎现况达标不了是**确实还没修**，不是判据错——');
console.log('    等 #89（队形机制）交付后再升格为防回归的 ratchet 门。');
