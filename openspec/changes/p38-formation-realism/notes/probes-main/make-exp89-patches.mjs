// P38 #89：把源码变体落成 `notes/patches/*.patch`（硬约束 2：改动只以 .patch 存盘，不提交源码）。
//
// 用法：node make-exp89-patches.mjs
// 产出：notes/patches/exp89-*.patch（对干净 main 的 unified diff）

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findRepoRoot } from '../probes/repo-root.mjs';
import { EXP89_PATCHES } from './exp89-variants.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = findRepoRoot(HERE);
const SRC = join(ROOT, 'engine/src/lib.rs');
const OUT = join(ROOT, 'openspec/changes/p38-formation-realism/notes/patches');
const base = readFileSync(SRC, 'utf8');

if (base.includes('#89')) {
  console.error('⚠ engine/src/lib.rs 不是干净 main（含 #89 标记）——先 git checkout');
  process.exit(1);
}

const CASES = [
  ['exp89-position-gate.patch', 'positionGate', { radius: 25, meters: 0.5, guardMeters: 1.5 },
    '位置门：射程内把出球门收到 0.5m（贴身照射），射程外保持 8.0；d1≤1.5m 时仍出球'],
  ['exp89-position-gate-noguard.patch', 'positionGateNoGuard', { radius: 25, meters: 0.5 },
    '同上但**无** d1≤1.5m 保护条（隔离保护条的贡献：实测无差别）'],
  ['exp89-engage-shift-3.5.patch', 'engageShift', { shift: -3.5 },
    '★ 射门倾向 -4.3→-3.5：射门 7.2→17.6/场（≈真实 16.51），犯规 23.46 ∈ L1[16,30]'],
  ['exp89-engage-shift-3.0.patch', 'engageShift', { shift: -3.0 },
    '★ 射门倾向 -4.3→-3.0：射门 7.2→26.8/场（超真实），犯规 23.56 ∈ L1[16,30]；但进球 0.95→3.18 破 4 条 L1'],
  ['exp89-flat-gate-3.0.patch', 'flatGate', { meters: 3.0 },
    '对照：全局收门到 3.0m（= 已测过的 exp10 形态），隔离"位置条件"的作用'],
  ['exp89-combo-gate-shift.patch', 'comboGateShift', { radius: 25, meters: 0.5, guardMeters: 1.5, shift: -3.5 },
    '可加性对照：位置门 + 倾向抬升（实测 19.9 vs 可加预测 21.2）'],
];

for (const [file, name, params, desc] of CASES) {
  const variant = EXP89_PATCHES[name](params);
  const patched = variant.patch(base);
  // 逐字节验证：patch 产物必须**真的**只改动了预期的那几行
  const td = mkdtempSync(join(tmpdir(), 'exp89-'));
  const a = join(td, 'a'); const b = join(td, 'b');
  spawnSync('mkdir', ['-p', `${a}/engine/src`, `${b}/engine/src`]);
  writeFileSync(`${a}/engine/src/lib.rs`, base);
  writeFileSync(`${b}/engine/src/lib.rs`, patched);
  const d = spawnSync('diff', ['-u', `${a}/engine/src/lib.rs`, `${b}/engine/src/lib.rs`], { encoding: 'utf8' });
  const diff = (d.stdout || '').replace(`${a}/engine/src/lib.rs`, 'a/engine/src/lib.rs')
    .replace(`${b}/engine/src/lib.rs`, 'b/engine/src/lib.rs');
  if (!diff.trim()) { console.error(`⚠ ${file}: 无 diff（锚点没命中？）`); process.exit(1); }
  writeFileSync(join(OUT, file), `# P38 #89：${desc}\n# 变体名 ${variant.name}（probes-main/exp89-variants.mjs）\n# 干净 main = 901da77b\n${diff}`);
  const lines = diff.split('\n').filter((l) => /^[+-][^+-]/.test(l)).length;
  console.log(`→ ${file}  （${lines} 行改动）`);
  // 双向可应用性（在**干净树的临时副本**上验，不碰工作树）：
  //   ① `patch -p1` 正向应用必须成功 → 产物与变体逐字节相同
  //   ② 应用后再 `patch -R` 必须干净回退 → 恢复成干净 main
  // 直接在本仓跑 `patch -R` 是错的：本仓是**干净**的，反向本来就不该应用得上。
  const tree = mkdtempSync(join(tmpdir(), 'exp89-chk-'));
  spawnSync('mkdir', ['-p', `${tree}/engine/src`]);
  writeFileSync(`${tree}/engine/src/lib.rs`, base);
  const fwd = spawnSync('patch', ['-p1', '-s', '-i', join(OUT, file)], { cwd: tree, encoding: 'utf8' });
  if (fwd.status !== 0) { console.error(`⚠ ${file} 正向应用失败：${fwd.stdout}${fwd.stderr}`); process.exit(1); }
  if (readFileSync(`${tree}/engine/src/lib.rs`, 'utf8') !== patched) {
    console.error(`⚠ ${file} 应用产物与变体不一致`); process.exit(1);
  }
  const rev = spawnSync('patch', ['-p1', '-R', '-s', '-i', join(OUT, file)], { cwd: tree, encoding: 'utf8' });
  if (rev.status !== 0) { console.error(`⚠ ${file} 反向回退失败：${rev.stdout}${rev.stderr}`); process.exit(1); }
  if (readFileSync(`${tree}/engine/src/lib.rs`, 'utf8') !== base) {
    console.error(`⚠ ${file} 回退后与干净 main 不一致`); process.exit(1);
  }
}
console.log('\n全部 patch：正向应用 == 变体产物，反向回退 == 干净 main（在临时副本上验，未碰工作树）。');
