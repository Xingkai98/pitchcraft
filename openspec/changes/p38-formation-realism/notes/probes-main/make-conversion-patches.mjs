// P38 #102：把 `conversion-variants.mjs` 的源码变体落成**可 `git apply` 的补丁**。
//
// 形态对齐 `make-exp89-patches.mjs`（P38 惯例）：用 `git diff` 从干净 main 生成，
// 并**自证**（正向应用 == 变体产物、反向回退 == 干净 main）——两条都验，缺一条就是假绿。
//
// ⚠️ 脚本**不硬编码 worktree 绝对路径**（P38 踩过四次）：从自身位置上溯找仓库根。
//
// 用法：node make-conversion-patches.mjs

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { findRepoRoot } from '../probes/repo-root.mjs';
import { CONVERSION_PATCHES, applyPatches } from './conversion-variants.mjs';

const ROOT = findRepoRoot(new URL('.', import.meta.url).pathname);
const OUT = join(ROOT, 'openspec/changes/p38-formation-realism/notes/patches');
const REL = 'engine/src/lib.rs';

const git = (args, opts = {}) => {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`git ${args.join(' ')} 失败：${r.stderr}`);
  return r;
};

// 干净 main 的 lib.rs（从 git 取，不看工作区——工作区可能被实验改脏）
const clean = git(['show', `HEAD:${REL}`]).stdout;
const dirty = readFileSync(join(ROOT, REL), 'utf8');
if (dirty !== clean) {
  console.error(`⚠️ 工作区的 ${REL} 与 HEAD 不一致——先 git checkout 还原再生成补丁`);
  process.exit(1);
}

const SPECS = [
  ['ca-engage-shift-3.4.patch',  '体积杠杆：OPEN_PLAY_SHOT_ENGAGE_SHIFT −4.3 → −3.4（#102 的靶子体积）',
    [{ k: 'engageShift', p: { shift: -3.4 } }]],
  ['ca-bucket-scale-k1.32.patch', '对照：三桶常数整体 ×1.32（形状不动，只抬进球预算）',
    [{ k: 'engageShift', p: { shift: -3.4 } }, { k: 'shotBucketScale', p: { k: 1.32 } }]],
  ['ca-bucket-goal-only-k1.6.patch', '对照：只把 goal% ×1.6（saved 不动）',
    [{ k: 'engageShift', p: { shift: -3.4 } }, { k: 'shotBucketGoalOnly', p: { k: 1.6 } }]],
  ['ca-bucket-quality-6p.patch', '对照：欧氏 + 角度 + 自定义曲线（6 参数，含被证伪的角度维度）',
    [{ k: 'engageShift', p: { shift: -3.4 } },
      { k: 'shotBucketQuality', p: { qNear: 8, qFar: 25, angleFloor: 0.7, gMin: 1, gMax: 40, sMin: 8, sMax: 36 } }]],
  ['ca-bucket-quality-min.patch', '★ #102 交付变体：两参数最小质量自适应（欧氏 + 引擎既有折线）',
    [{ k: 'engageShift', p: { shift: -3.4 } },
      { k: 'shotBucketQualityMin', p: { gMax: 18.7, sMax: 27.4 } }]],
  ['ca-bucket-rebucket-17-9-6.patch',
    '★ 更简单的竞争解：三桶常数各自重标（17/9/6）——证明「形状自适应是必要的」不成立',
    [{ k: 'engageShift', p: { shift: -3.4 } },
      { k: 'shotBucketRebucket', p: { box: 17, arc: 9, far: 6 } }]],
];

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

for (const [file, desc, list] of SPECS) {
  const patched = applyPatches(clean, list.map(({ k, p }) => CONVERSION_PATCHES[k](p)));
  // 用 git diff --no-index 生成 unified diff（对临时文件），再改写成仓库内路径
  const tmpA = join(ROOT, '.ca-tmp-a.rs');
  const tmpB = join(ROOT, '.ca-tmp-b.rs');
  writeFileSync(tmpA, clean);
  writeFileSync(tmpB, patched);
  const d = spawnSync('git', ['diff', '--no-index', '--unified=3', '.ca-tmp-a.rs', '.ca-tmp-b.rs'],
    { cwd: ROOT, encoding: 'utf8' });
  let diff = (d.stdout || '').replace(/^--- a\/\.ca-tmp-a\.rs$/m, `--- a/${REL}`)
    .replace(/^\+\+\+ b\/\.ca-tmp-b\.rs$/m, `+++ b/${REL}`)
    .replace(/^diff --git a\/\.ca-tmp-a\.rs b\/\.ca-tmp-b\.rs$/m, `diff --git a/${REL} b/${REL}`);
  const header = `# P38 #102：${desc}\n#\n# 由 probes-main/make-conversion-patches.mjs 生成（不手工编辑）。\n`
    + `# 应用： git apply <本文件>   （在干净 main worktree 里）\n`
    + '# ⚠️ 引擎行为改动**不是可合入方案**（未走 OpenSpec、L1 九门有红）——见 notes/conversion-adaptive.md\n';
  writeFileSync(join(OUT, file), header + diff);

  // ── 自证 ①：正向应用 == 变体产物 ──
  const applied = spawnSync('git', ['apply', '--check', join(OUT, file)], { cwd: ROOT, encoding: 'utf8' });
  const roundtrip = spawnSync('git', ['apply', join(OUT, file)], { cwd: ROOT, encoding: 'utf8' });
  const after = readFileSync(join(ROOT, REL), 'utf8');
  const fwdOK = after === patched;
  // ── 自证 ②：反向回退 == 干净 main ──
  spawnSync('git', ['apply', '-R', join(OUT, file)], { cwd: ROOT, encoding: 'utf8' });
  const back = readFileSync(join(ROOT, REL), 'utf8');
  const revOK = back === clean;
  spawnSync('rm', ['-f', tmpA, tmpB]);

  console.log(`${fwdOK && revOK ? '✅' : '❌'} ${file.padEnd(34)} 正向==变体 ${fwdOK} / 反向==main ${revOK}`
    + ` (${diff.split('\n').filter((l) => l.startsWith('+') || l.startsWith('-')).length} 行改动)`);
  if (!fwdOK || !revOK) process.exitCode = 1;
}
