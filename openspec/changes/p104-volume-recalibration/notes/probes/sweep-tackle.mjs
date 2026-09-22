// P104：抢断体积杠杆的**粗扫**——每个候选单常量动一档，看抢断/犯规/射门-抢断比往哪走。
//
// 目的不是找"达标点"，是**描出可动轴**：抢断是一块固定大小的饼（打分选一，机会点总数与
// 打分无关），抬抢断只能从 contain/jockey（不产事件）与 foul 里切。这个扫描回答：
//   ① 哪个常量真的能把抢断抬起来（弹性多大）？
//   ② 抬抢断的代价落在犯规上多少？（犯规有 L1 门 [16,30]，不能被切穿）
//   ③ 有没有哪个杠杆能**只抬抢断不抬犯规**？
//
// 跑法：node sweep-tackle.mjs            # 全部档位，每档 100 场（快车道）
// 结果落 out/sweep-tackle.jsonl。

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from './l1-metrics.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = findRepoRoot(HERE);
const SEEDS = Number(process.argv[2] || 100);
const FROM = Number(process.argv[3] || 401);
const SHIFT = -3.4; // 全部档位都跑在「射门已抬到真实量级」的背景上

// 每项：标签 + 变体规格。刻意**一次只动一个常量**（P38 教训：多参数一起动无法归因）。
const SWEEP = [
  ['baseline-vol', null],
  ['contact-3.5', 'tackleContactScale:{"m":3.5}'],
  ['contact-5', 'tackleContactScale:{"m":5}'],
  ['contact-8', 'tackleContactScale:{"m":8}'],
  ['base--0.7', 'baseDefTackle:{"v":-0.7}'],
  ['base--0.3', 'baseDefTackle:{"v":-0.3}'],
  ['base-0.1', 'baseDefTackle:{"v":0.1}'],
  ['eager-1.0', 'tackleEagerness:{"v":1.0}'],
  ['eager-1.5', 'tackleEagerness:{"v":1.5}'],
  ['closegain-2.4', 'tackleClosenessGain:{"v":2.4}'],
  ['closegain-3.2', 'tackleClosenessGain:{"v":3.2}'],
  ['thresh-16', 'tackleThreshold:{"m":16}'],
  ['thresh-22', 'tackleThreshold:{"m":22}'],
  ['cd-2', 'tackleCooldown:{"v":2}'],
  ['cd-0', 'tackleCooldown:{"v":0}'],
  ['paircd-2', 'pairCooldown:{"v":2}'],
  ['paircd-0', 'pairCooldown:{"v":0}'],
  ['cdpen-0.2', 'tackleCdPenalty:{"v":0.2}'],
  ['cdpen-0.0', 'tackleCdPenalty:{"v":0.0}'],
  ['badangle-0.2', 'tackleBadAngle:{"v":0.2}'],
  ['badangle-0.0', 'tackleBadAngle:{"v":0.0}'],
];

const LIBSRC = join(ROOT, 'engine/src/lib.rs');
const WASM = join(ROOT, 'viewer/engine.wasm');
const BUILT = join(ROOT, 'engine/target/wasm32-unknown-unknown/release/fm_engine.wasm');
const CARGO = `${process.env.HOME}/.cargo/bin/cargo`;
const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };
const original = readFileSync(LIBSRC, 'utf8');
const OUT = join(HERE, 'out');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });


// run-variant.mjs 用**单独一行** `__RECORD__ {json}` 交付结果（不去猜 stdout 里的 JSON 块：
// 那样会把探针 import 副作用的"干净 main"JSON 当成结果读——实测踩过，整张扫描表是错的）。
function extractRecord(out) {
  const line = out.split('\n').find((l) => l.startsWith('__RECORD__ '));
  if (!line) throw new Error(`stdout 里找不到 __RECORD__ 行：${out.slice(-600)}`);
  return JSON.parse(line.slice('__RECORD__ '.length));
}

function rebuild() {
  const r = spawnSync(CARGO, ['build', '--target', 'wasm32-unknown-unknown', '--release'],
    { cwd: join(ROOT, 'engine'), env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`构建失败：\n${(r.stderr || '').slice(-2500)}`);
  spawnSync('cp', [BUILT, WASM]);
}

try {
  for (const [label, spec] of SWEEP) {
    // ⚠️ 走 `run-variant.mjs` 而不是自己 rebuild：它负责「还原 + 重编 + 核对」的收尾契约，
    // 而且在 `--shift` 之外还接受 `--patch`。这里是**唯一**的变体应用路径。
    const rec = { label, spec, seedsFrom: FROM, seedsRequested: SEEDS };
    try {
      const argv = [join(HERE, 'run-variant.mjs'), label, '--shift', String(SHIFT),
        '--seeds', String(SEEDS), '--from', String(FROM), '--ha-seeds', '0'];
      if (spec) argv.push('--patch', spec);
      const r = spawnSync('node', argv, { cwd: ROOT, encoding: 'utf8', env, maxBuffer: 64e6 });
      if (r.status !== 0) throw new Error((r.stderr || r.stdout || '').slice(-1500));
      const rec2 = extractRecord(r.stdout);
      const m = { ...rec2.metrics, _wasm: rec2.wasmSha8 };
      rec.metrics = m;
      console.log(`${label.padEnd(16)} shots=${m.shotsPerMatch} tackle=${m.tacklesPerMatch} ratio=${m.shotTackleRatio} foul=${m.foulsPerMatch} pass=${m.passPerMatch} crash=${m.crashedSeeds} (${m.elapsedSec}s)`);
    } catch (e) {
      rec.error = String(e.message).slice(0, 300);
      console.log(`${label.padEnd(16)} ❌ ${rec.error.split('\n')[0]}`);
    }
    appendFileSync(join(OUT, 'sweep-tackle.jsonl'), `${JSON.stringify(rec)}\n`);
  }
} finally {
  writeFileSync(LIBSRC, original);
  rebuild();
  const { createHash } = await import('node:crypto');
  const back = createHash('sha256').update(readFileSync(WASM)).digest('hex').slice(0, 8);
  console.log(`[还原] wasm ${back}${back === '901da77b' ? ' ✅' : ' ⚠️'}`);
}
