// P104：在粗扫找到的两条**活杠杆**上细扫——`DEF_CONTACT_SCALE_M`（抢断的"脚下"尺度）
// 与 `BASE_DEF_TACKLE`（抢断打分基线）。粗扫结论：抢断/犯规/封堵/跟防是**打分选一**的
// 同一块饼，抬抢断必切犯规；cooldown 族（cd/paircd/cdpen/thresh）**完全不动**（100 场逐位相同）。
//
// 目的：找「抢断≈真实 30/场 且 犯规仍 ∈ [16,30]」的工作点，并看它离悬崖多远。
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from './l1-metrics.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = findRepoRoot(HERE);
const SEEDS = Number(process.argv[2] || 100);
const FROM = Number(process.argv[3] || 401);
const SHIFT = -3.4;
const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };
const OUT = join(HERE, 'out');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

// 一维细扫（contact 尺度） + 一维细扫（base 基线） + 二者组合的少量点
const GRID = [];
// contact 尺度：3.5 已达标（tackle 18.8 / foul 17.9），要找它的犯规悬崖在哪
for (const m of [3.75, 4.0, 4.25]) GRID.push([`c${m}`, `tackleContactScale:{"m":${m}}`]);
// base 基线：−0.7 给出最好的点（tackle 25.8 / foul 17.0），但它离 −0.3 的悬崖很近
for (const v of [-0.85, -0.8, -0.75, -0.65, -0.6, -0.55]) GRID.push([`b${v}`, `baseDefTackle:{"v":${v}}`]);
// 两杠杆组合：contact 只抬总量、base 只移配比 → 组合应能同时抬抢断与保住犯规
GRID.push(['c4+b-0.85', 'tackleContactScale:{"m":4.0}']);
GRID.push(['c4+b-0.85', 'baseDefTackle:{"v":-0.85}']);

function extractRecord(out) {
  const line = out.split('\n').find((l) => l.startsWith('__RECORD__ '));
  if (!line) throw new Error(`无 __RECORD__：${out.slice(-500)}`);
  return JSON.parse(line.slice('__RECORD__ '.length));
}

// 把同一 label 的多个 --patch 合起来跑（组合点用）
const groups = new Map();
for (const [label, spec] of GRID) {
  if (!groups.has(label)) groups.set(label, []);
  groups.get(label).push(spec);
}

for (const [label, specs] of groups) {
  const rec = { label, specs, seedsFrom: FROM, seedsRequested: SEEDS };
  try {
    const argv = [join(HERE, 'run-variant.mjs'), label, '--shift', String(SHIFT),
      '--seeds', String(SEEDS), '--from', String(FROM), '--ha-seeds', '0'];
    for (const s of specs) argv.push('--patch', s);
    const r = spawnSync('node', argv, { cwd: ROOT, encoding: 'utf8', env, maxBuffer: 64e6 });
    if (r.status !== 0) throw new Error((r.stderr || r.stdout || '').slice(-1200));
    const rec2 = extractRecord(r.stdout);
    rec.metrics = { ...rec2.metrics, _wasm: rec2.wasmSha8 };
    const m = rec.metrics;
    console.log(`${label.padEnd(12)} tackle=${String(m.tacklesPerMatch).padStart(7)} foul=${String(m.foulsPerMatch).padStart(6)} ratio=${String(m.shotTackleRatio).padStart(7)} shots=${String(m.shotsPerMatch).padStart(6)} sot=${m.sot} conv=${m.conv} inside=${m.inside} crash=${m.crashedSeeds}`);
  } catch (e) {
    rec.error = String(e.message).slice(0, 400);
    console.log(`${label.padEnd(12)} ❌ ${rec.error.split('\n')[0]}`);
  }
  appendFileSync(join(OUT, 'sweep-fine.jsonl'), `${JSON.stringify(rec)}\n`);
}
