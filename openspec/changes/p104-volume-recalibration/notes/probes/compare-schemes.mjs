// P104：两方案（③ 3 常量 vs deadline 2 常量）的**全套门对照**——用户第 2 轮拍板要求的表。
//
// 每个方案：改 lib.rs → 重建 wasm → 跑（a）L1 量（b）角球/远距抢断的**大样本**扫描
// （c）判据组 8 条 → 无条件还原 + 重编 + 核对 sha。
//
// ⚠️ 互斥：本脚本改共享的 lib.rs/wasm，**不要并发跑**。
// 用法：node compare-schemes.mjs <label> <specsJson>
//   node compare-schemes.mjs scheme3 '["engageShift:{\"shift\":-3.4}", ...]'

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = (() => { let d = resolve(HERE); for (let i = 0; i < 12; i += 1) { if (existsSync(join(d, 'package.json')) && existsSync(join(d, 'viewer/match-metrics.js'))) return d; const u = dirname(d); if (u === d) break; d = u; } throw new Error('no repo root'); })();

const label = process.argv[2] || 'unnamed';
const specs = JSON.parse(process.argv[3] || '[]');

const LIBSRC = join(ROOT, 'engine/src/lib.rs');
const WASM = join(ROOT, 'viewer/engine.wasm');
const BUILT = join(ROOT, 'engine/target/wasm32-unknown-unknown/release/fm_engine.wasm');
const CARGO = `${process.env.HOME}/.cargo/bin/cargo`;
const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };
const sha8 = () => createHash('sha256').update(readFileSync(WASM)).digest('hex').slice(0, 8);
const original = readFileSync(LIBSRC, 'utf8');
const { applyPatches, patchFromSpec } = await import('./variants.mjs');

function rebuild() {
  const r = spawnSync(CARGO, ['build', '--target', 'wasm32-unknown-unknown', '--release'], { cwd: join(ROOT, 'engine'), env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`构建失败：\n${(r.stderr || '').slice(-2500)}`);
  spawnSync('cp', [BUILT, WASM]);
}
const run = (cmd, argv, opts = {}) => {
  const r = spawnSync(cmd, argv, { cwd: ROOT, encoding: 'utf8', env, maxBuffer: 256e6, ...opts });
  return { status: r.status, out: `${r.stdout || ''}\n${r.stderr || ''}` };
};
const rec = { label, specs };

try {
  writeFileSync(LIBSRC, applyPatches(original, specs.map(patchFromSpec)));
  rebuild();
  rec.wasmSha8 = sha8();
  console.log(`[方案] ${label} wasm=${rec.wasmSha8}`);

  // ── (a) L1 量（200 场 + 600 场 HA 窗口）──
  const a = run('node', [join(HERE, 'l1-metrics.mjs'), '--label', `${label}-l1`, '--seeds', '200', '--from', '401', '--ha-seeds', '600']);
  rec.l1 = JSON.parse(a.out.trim().split('\n').filter((l) => l.startsWith('{') || l.startsWith(' ') || l.startsWith('}')).join('\n'));
  const m = rec.l1;
  console.log(`  射门=${m.shotsPerMatch} 抢断=${m.tacklesPerMatch} shot/tackle=${m.shotTackleRatio} 犯规=${m.foulsPerMatch} 传球=${m.passPerMatch}`);
  console.log(`  主=${m.homeGoalsPerMatch} 客=${m.awayGoalsPerMatch} sot=${m.sot} conv=${m.conv} inside=${m.inside} 角球均=${m.cornersPerMatch} 界外=${m.throwInsPerMatch}`);

  // ── (b) 大样本：角球单场 max + 远距抢断（结构断言）+ 门球 ──
  const b = run('node', [join(HERE, 'big-sample.mjs'), '--seeds', '3000', '--from', '401', '--workers', String(Math.max(1, Math.min(4, os.cpus().length)))]);
  rec.big = JSON.parse(b.out.trim());
  console.log(`  3000 场: 角球 max=${rec.big.cornerMax} P(>12)=${rec.big.cornerOver12}% P(>15)=${rec.big.cornerOver15}%  远距抢断(>12m)=${rec.big.farTackles}  门球/场=${rec.big.goalKicksPerMatch}`);

  // ── (c) 判据组 8 条（P38 #91，报告期）──
  const c = run('node', [join(ROOT, 'openspec/changes/p38-formation-realism/notes/criteria/check-criteria.mjs')]);
  rec.criteriaRaw = c.out.slice(-2500);
  const jl = c.out.split('\n').filter((l) => l.trim().startsWith('{')).pop();
  rec.criteria = jl ? JSON.parse(jl) : null;
  if (rec.criteria) {
    const cr = rec.criteria;
    console.log(`  判据组: hd=${cr.hd} spread=${cr.spread} gap=${cr.gap} latSd=${cr.latSd} swarm=${cr.swarm} fault=${cr.fault} midBack=${cr.midBack} shotsReg=${cr.shotsReg}`);
  } else {
    console.log(`  判据组原始输出尾部:\n${rec.criteriaRaw.slice(-800)}`);
  }
} finally {
  writeFileSync(LIBSRC, original);
  rebuild();
  rec.restored = sha8();
  console.log(`[还原] wasm ${rec.restored}${rec.restored === '901da77b' ? ' ✅' : ' ⚠️'}`);
}
const OUT = join(HERE, 'out');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
appendFileSync(join(OUT, 'compare-schemes.jsonl'), `${JSON.stringify(rec)}\n`);
process.stdout.write(`__RECORD__ ${JSON.stringify(rec)}\n`);
