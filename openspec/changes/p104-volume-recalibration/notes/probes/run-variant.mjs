// P104：跑一个「体积配置」——改 lib.rs → 重建 wasm → 算 L1 量 →（可选）跑真 cargo L1 门 → 无条件还原。
//
// 用法：
//   node run-variant.mjs <标签> --shift -3.4 --tackle 'baseDefTackle:{"v":-0.4}'
//   node run-variant.mjs <标签> --patch 'tackleContactScale:{"m":4}' --seeds 200 --ha-seeds 600
//   node run-variant.mjs <标签> --shift -3.4 --gates          # 额外跑 cargo L1 九门（权威）
//
// ⚠️ **每次实验前/后核对 wasm 与 lib.rs**：`finally` 里无条件还原并重编，退出后再核一次
//    sha256 前缀（干净 main = `901da77b`）。P38 在这上面栽过三次。

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { findRepoRoot, aggregate } from './l1-metrics.mjs';
import { applyPatches, patchFromSpec } from './variants.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = findRepoRoot(HERE);

// ⚠️ **互斥锁**：本脚本直接改 `engine/src/lib.rs` + `viewer/engine.wasm`（**共享可变状态**）。
// 两个实例并发跑会让彼此的锚点检查错乱（实测：并发时 `variants.mjs` 报"缺锚点"，
// 而锚点明明在——因为另一个进程刚把它改掉了），且 wasm 会串味。
// 锁文件里记 PID；陈旧锁（进程已死）自动接管。
const LOCK = join(HERE, 'out', '.run-variant.lock');
(() => {
  mkdirSync(join(HERE, 'out'), { recursive: true });
  if (existsSync(LOCK)) {
    const pid = Number(readFileSync(LOCK, 'utf8').trim());
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    if (alive) {
      console.error(`✋ 另一个 run-variant 正在跑（pid ${pid}）——拒绝并发（会串味 lib.rs/wasm）。`);
      process.exit(2);
    }
    console.error(`[锁] 接管陈旧锁（pid ${pid} 已不在）`);
  }
  writeFileSync(LOCK, String(process.pid));
})();
process.on('exit', () => { try { if (readFileSync(LOCK, 'utf8').trim() === String(process.pid)) rmSync(LOCK); } catch {} });

const argv = process.argv.slice(2);
const label = argv[0] || 'unnamed';
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const allOf = (n) => { const out = []; argv.forEach((a, i) => { if (a === n) out.push(argv[i + 1]); }); return out; };

const LIBSRC = join(ROOT, 'engine/src/lib.rs');
const WASM = join(ROOT, 'viewer/engine.wasm');
const BUILT = join(ROOT, 'engine/target/wasm32-unknown-unknown/release/fm_engine.wasm');
const CARGO = `${process.env.HOME}/.cargo/bin/cargo`;
const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };
const CLEAN_SHA8 = '901da77b';

const sha8 = () => createHash('sha256').update(readFileSync(WASM)).digest('hex').slice(0, 8);
const libSha = () => createHash('sha256').update(readFileSync(LIBSRC)).digest('hex').slice(0, 12);

function rebuild() {
  const r = spawnSync(CARGO, ['build', '--target', 'wasm32-unknown-unknown', '--release'],
    { cwd: join(ROOT, 'engine'), env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`构建失败：\n${(r.stderr || '').slice(-3000)}`);
  spawnSync('cp', [BUILT, WASM]);
  if (!readFileSync(BUILT).equals(readFileSync(WASM))) throw new Error('wasm 搬运不一致');
}

// 变体规格：--shift 是 engageShift 的糖；--patch 可重复
const specs = allOf('--patch');
const shift = argOf('--shift', null);
if (shift !== null) specs.unshift(`engageShift:{"shift":${Number(shift)}}`);
const patches = specs.map(patchFromSpec);

const wantGates = argv.includes('--gates');
const seeds = Number(argOf('--seeds', '200'));
const from = Number(argOf('--from', '401'));
const haSeeds = Number(argOf('--ha-seeds', '600'));
const haFrom = Number(argOf('--ha-from', '401'));

const original = readFileSync(LIBSRC, 'utf8');
const record = { label, specs, seedsFrom: from, seedsRequested: seeds, at: null };

function runProbe() {
  const r = spawnSync('node', [join(HERE, 'l1-metrics.mjs'), '--label', label, '--seeds', String(seeds),
    '--from', String(from), '--ha-seeds', String(haSeeds), '--ha-from', String(haFrom)],
    { cwd: ROOT, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`l1-metrics 失败：\n${(r.stderr || '').slice(-3000)}`);
  return JSON.parse(r.stdout.trim());
}

/** 权威读数：真 cargo L1 九门（~75s）。解析 libtest 收尾行 + panic 线程名。 */
function runL1Gates() {
  const r = spawnSync(CARGO, ['test', '--test', 'realism', '--release', '--', '--ignored', '--nocapture'],
    { cwd: join(ROOT, 'engine'), env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const m = [...out.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/g)];
  const passed = m.reduce((s, x) => s + Number(x[1]), 0);
  const failed = m.reduce((s, x) => s + Number(x[2]), 0);
  const names = [...new Set([...out.matchAll(/^---- (\S+) stdout ----/gm)].map((x) => x[1]))];
  const panics = [...out.matchAll(/thread '[^']+' panicked at [^\n]*\n([^\n]*)/g)].map((x) => x[1].trim());
  const l1 = { passed, failed, failedNames: names, panics };
  l1.report = [...out.matchAll(/^\[(fouls|home-adv|L3|P13[^\]]*|P31[^\]]*|home-adv calibration)\].*$/gm)].map((x) => x[0]);
  console.log(`[L1] ${passed} 绿 ${failed} 红；红名单 ${JSON.stringify(names)}`);
  l1.report.forEach((l) => console.log('   ' + l));
  return l1;
}

try {
  writeFileSync(LIBSRC, applyPatches(original, patches));
  const libModified = libSha();
  rebuild();
  record.wasmSha8 = sha8();
  record.libSha12 = libModified;
  console.log(`[变体] ${label} wasm=${record.wasmSha8} specs=${JSON.stringify(specs)}`);
  record.metrics = runProbe();
  if (wantGates) record.l1 = runL1Gates();
} finally {
  writeFileSync(LIBSRC, original);
  rebuild();
  const back = sha8();
  record.restored = back;
  record.libRestored = libSha();
  console.log(`[还原] lib.rs pristine，wasm ${back}${back === CLEAN_SHA8 ? ' ✅' : ' ⚠️ 不是干净 main！'}`);
}

const OUT = join(HERE, 'out');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
appendFileSync(join(OUT, 'variants.jsonl'), `${JSON.stringify(record)}\n`);
// 机器可读的**唯一**输出行：调用方（sweep）只认这一行，不去猜 stdout 里的 JSON 块
// （曾因此把探针 import 副作用的"干净 main"JSON 当成结果读，整张扫描表是错的）。
process.stdout.write(`__RECORD__ ${JSON.stringify(record)}\n`);
