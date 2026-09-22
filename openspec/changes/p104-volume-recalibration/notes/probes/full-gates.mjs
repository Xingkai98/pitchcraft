// P104：一个方案跑**全套现有门**，输出逐条红门清单（用户第 2 轮拍板要求的对照依据）。
//
// 跑的门：
//   ① `cargo test`（默认套件：lib 单测 + L2 + golden）—— verify.sh 第 1 步
//   ② `cargo test --test realism`（非 ignored：golden/L2）—— 同第 1 步
//   ③ `cargo test --test realism --release -- --ignored --nocapture`（L1 九门）—— verify.sh 第 7 步
//   ④ `node --test tools/benchmark-baseline.test.mjs`（引擎指纹哨兵）—— verify.sh 第 3 步的一部分
//   ⑤ 判据组 8 条（报告期）—— verify.sh 第 9 步
//   ⑥ 角球单场 max + 远距抢断（3000 场）—— L1 的 `far==0` 与角球上界
//
// ⚠️ 改共享 lib.rs/wasm，**不要并发跑**；`finally` 无条件还原 + 重编 + 核对 sha。
// 用法：node full-gates.mjs <label> <specsJson>

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = (() => { let d = resolve(HERE); for (let i = 0; i < 12; i += 1) { if (existsSync(join(d, 'package.json')) && existsSync(join(d, 'viewer/match-metrics.js'))) return d; const u = dirname(d); if (u === d) break; d = u; } throw new Error('no root'); })();

const label = process.argv[2] || 'unnamed';
const specs = JSON.parse(process.argv[3] || '[]');
const LIBSRC = join(ROOT, 'engine/src/lib.rs');
const WASM = join(ROOT, 'viewer/engine.wasm');
const BUILT = join(ROOT, 'engine/target/wasm32-unknown-unknown/release/fm_engine.wasm');
const CARGO = `${process.env.HOME}/.cargo/bin/cargo`;
const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };
const original = readFileSync(LIBSRC, 'utf8');
const { applyPatches, patchFromSpec } = await import('./variants.mjs');

const rebuild = () => {
  const r = spawnSync(CARGO, ['build', '--target', 'wasm32-unknown-unknown', '--release'], { cwd: join(ROOT, 'engine'), env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`构建失败：${(r.stderr || '').slice(-2000)}`);
  spawnSync('cp', [BUILT, WASM]);
};
const run = (cmd, argv, opts = {}) => {
  const r = spawnSync(cmd, argv, { cwd: ROOT, encoding: 'utf8', env, maxBuffer: 256e6, ...opts });
  return `${r.stdout || ''}\n${r.stderr || ''}`;
};
/** libtest 输出 → {passed, failed, names}。名字取自 `failures:` 段（`---- <name> stdout ----` 会漏，故两路都取）。 */
function parseLibtest(out) {
  const res = [...out.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed/g)];
  const passed = res.reduce((s, x) => s + Number(x[1]), 0);
  const failed = res.reduce((s, x) => s + Number(x[2]), 0);
  const fromDash = [...out.matchAll(/^---- (\S+) stdout ----/gm)].map((x) => x[1]);
  const blk = out.split('\n    ').slice(1).map((s) => s.split('\n')[0].trim()).filter((s) => /^[A-Za-z_][\w:]*$/.test(s));
  const names = [...new Set([...fromDash, ...blk])];
  const panics = [...out.matchAll(/panicked at [^\n]*\n([^\n]*)/g)].map((x) => x[1].trim());
  return { passed, failed, names, panics };
}

const rec = { label, specs };
try {
  writeFileSync(LIBSRC, applyPatches(original, specs.map(patchFromSpec)));
  rebuild();
  rec.wasmSha8 = createHash('sha256').update(readFileSync(WASM)).digest('hex').slice(0, 8);
  console.log(`[方案] ${label} wasm=${rec.wasmSha8}`);

  const g = {};
  let o = run(CARGO, ['test'], { cwd: join(ROOT, 'engine') });
  g.default = parseLibtest(o);
  console.log(`  ① cargo test(默认): ${g.default.passed}p/${g.default.failed}f  ${JSON.stringify(g.default.names)}`);

  o = run(CARGO, ['test', '--test', 'realism'], { cwd: join(ROOT, 'engine') });
  g.realismNonIgnored = parseLibtest(o);
  console.log(`  ② realism(非 ignored): ${g.realismNonIgnored.passed}p/${g.realismNonIgnored.failed}f  ${JSON.stringify(g.realismNonIgnored.names)}`);

  o = run(CARGO, ['test', '--test', 'realism', '--release', '--', '--ignored', '--nocapture'], { cwd: join(ROOT, 'engine') });
  g.l1 = parseLibtest(o);
  g.l1.report = [...o.matchAll(/^\[(fouls|home-adv|L3|P13[^\]]*|P31[^\]]*|home-adv calibration)\].*$/gm)].map((x) => x[0]);
  console.log(`  ③ L1 九门: ${g.l1.passed}p/${g.l1.failed}f  ${JSON.stringify(g.l1.names)}`);
  g.l1.panics.forEach((p) => console.log(`       panic: ${p}`));
  g.l1.report.forEach((l) => console.log(`       ${l}`));

  o = run('node', ['--test', 'tools/benchmark-baseline.test.mjs']);
  const bbFail = /# fail (\d+)/.exec(o);
  g.benchmarkBaseline = { fail: bbFail ? Number(bbFail[1]) : null, tail: o.slice(-1400) };
  console.log(`  ④ benchmark-baseline 哨兵: fail=${g.benchmarkBaseline.fail}`);

  o = run('node', [join(ROOT, 'openspec/changes/p38-formation-realism/notes/criteria/check-criteria.mjs')]);
  const m = o.match(/纵深\s+当前\s+([\d.]+)[\s\S]*?y 两两相关\s+当前\s+([\d.]+)[\s\S]*?普通射门\/场\s+当前\s+([\d.]+)/);
  g.criteria = m ? { hd: +m[1], swarm: +m[2], shotsReg: +m[3], raw: o.slice(-1600) } : { raw: o.slice(-1600) };
  console.log(`  ⑤ 判据组: hd=${g.criteria.hd} swarm=${g.criteria.swarm} shotsReg=${g.criteria.shotsReg}`);

  o = run('node', [join(HERE, 'big-sample.mjs'), '--seeds', '3000', '--from', '401', '--workers', String(Math.max(1, Math.min(4, os.cpus().length)))]);
  g.big = JSON.parse(o.trim());
  console.log(`  ⑥ 3000 场: 角球 max=${g.big.cornerMax} far=${g.big.farTackles} 门球/场=${g.big.goalKicksPerMatch}`);

  rec.gates = g;
} finally {
  writeFileSync(LIBSRC, original);
  rebuild();
  rec.restored = createHash('sha256').update(readFileSync(WASM)).digest('hex').slice(0, 8);
  console.log(`[还原] wasm ${rec.restored}${rec.restored === '901da77b' ? ' ✅' : ' ⚠️'}`);
}
const OUT = join(HERE, 'out');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
appendFileSync(join(OUT, 'full-gates.jsonl'), `${JSON.stringify(rec)}\n`);
