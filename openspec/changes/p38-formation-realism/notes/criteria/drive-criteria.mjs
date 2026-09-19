// 判据评测驱动器：依次应用每个实验补丁 → 重建 wasm → 求值 → 汇总成表。
//
// 用法：node drive-criteria.mjs
//
// ⚠️ 会反复改 engine/src/lib.rs 与 viewer/engine.wasm，跑完自动还原到干净 main。
// ⚠️ 需要 cargo 在 PATH（脚本内显式加 ~/.cargo/bin）。

import { execFileSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';

const HERE = '/home/happy/.claude/worktrees/wayfinder-realism';
const PATCH_DIR = `${HERE}/openspec/changes/p38-formation-realism/notes/patches`;
const CARGO = `${process.env.HOME}/.cargo/bin/cargo`;
const PATH = `${process.env.HOME}/.cargo/bin:${process.env.PATH}`;

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: HERE, env: { ...process.env, PATH }, encoding: 'utf8', ...opts });

function rebuild() {
  run(CARGO, ['build', '--target', 'wasm32-unknown-unknown', '--release'], { cwd: `${HERE}/engine` });
  run('cp', [`${HERE}/engine/target/wasm32-unknown-unknown/release/fm_engine.wasm`, `${HERE}/viewer/engine.wasm`]);
}

function evaluate(label) {
  const out = run('node', [`${HERE}/openspec/changes/p38-formation-realism/notes/criteria/eval-criteria.mjs`, label]);
  return JSON.parse(out.trim().split('\n').pop());
}

function restore() {
  run('git', ['checkout', 'engine/src/lib.rs']);
  rebuild();
}

const rows = [];

console.log('=== 真实侧 ===');
const realOut = run('node', [`${HERE}/openspec/changes/p38-formation-realism/notes/criteria/eval-criteria.mjs`, '--real']);
const real = realOut.trim().split('\n').map((l) => JSON.parse(l));
const realAvg = {};
for (const k of Object.keys(real[0])) {
  if (k === 'tag') continue;
  realAvg[k] = +(real.reduce((s, r) => s + r[k], 0) / real.length).toFixed(3);
}
realAvg.tag = 'REAL(Metrica×2)';
console.log(JSON.stringify(realAvg));
rows.push(realAvg);

console.log('\n=== 引擎 ===');
restore();
rows.push(evaluate('baseline(clean-main)'));

const patches = readdirSync(PATCH_DIR).filter((f) => f.endsWith('.patch')).sort();
for (const p of patches) {
  restore();
  try {
    run('git', ['apply', `${PATCH_DIR}/${p}`]);
    rebuild();
    const r = evaluate(p.replace('.patch', ''));
    console.log(JSON.stringify(r));
    rows.push(r);
  } catch (e) {
    console.log(`  ⚠ ${p} 应用/构建失败：${String(e.message).slice(0, 120)}`);
  }
}
restore();

// 汇总表
const cols = ['tag', 'hd', 'spread', 'gap', 'width', 'latSd', 'lonSd', 'swarm', 'straight', 'fault', 'midBack'];
const w = (s, n) => String(s).padEnd(n);
console.log(`\n\n===== 候选判据 × 变体 =====\n`);
console.log(cols.map((c) => w(c, c === 'tag' ? 22 : 9)).join(''));
console.log('-'.repeat(22 + 9 * (cols.length - 1)));
for (const r of rows) console.log(cols.map((c) => w(c === 'tag' ? r[c] : (r[c] ?? '—'), c === 'tag' ? 22 : 9)).join(''));

console.log(`\n真实靶子（Metrica）: hd=${realAvg.hd} spread=${realAvg.spread} gap=${realAvg.gap} width=${realAvg.width}`);
console.log(`                     latSd=${realAvg.latSd} lonSd=${realAvg.lonSd} swarm=${realAvg.swarm} straight=${realAvg.straight}`);
console.log(`                     fault=${realAvg.fault} midBack=${realAvg.midBack}`);

writeFileSync(`${HERE}/openspec/changes/p38-formation-realism/notes/criteria/table.json`, `${JSON.stringify(rows, null, 2)}\n`);
console.log('\n→ table.json');
