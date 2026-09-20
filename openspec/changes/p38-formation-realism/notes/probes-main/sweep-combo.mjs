// P38 线 B：**横向机制 × exp4b（纵向等间距块）** 的组合。
//
// 为什么必须试这个组合（线 A 的直接推论）：
//   线 A 证明「纵深 ↔ 射门」是**一维兑换**，且 decouple 只动 x → 横向一行没碰。
//   线 B 的 `local` 机制只动 y（`ty`）→ **纵深一行没碰**（hd 恒 40.4）。
//   两个机制**动的轴不同**，应当能叠加：exp4b 压纵深、local 给横向。
//
// 但**不能假设它们独立**：exp4b 把全队压到 32 米长的块里，队友间距普遍缩小
// （这正是 tackle 重复-mover 崩溃的触发条件），`local` 的"半径 R 内队友"集合会随之变大
// → 两个机制通过**队友密度**耦合。必须实测，不能外推。
//
// 用法：node sweep-combo.mjs <机制> <强度> [半径m] [种子列表]
//   node sweep-combo.mjs local 0.96 15
// 输出：追加 out/combos.jsonl

import { readFileSync, writeFileSync, cpSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { findRepoRoot } from '../probes/repo-root.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = findRepoRoot(HERE);
const OUT = join(HERE, 'out');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const mech = process.argv[2] || 'local';
const strength = Number(process.argv[3] ?? 0.96);
const radius = Number(process.argv[4] ?? 15);
const seeds = (process.argv[5] || '42,1,7,99,123,2,3,5,11,17').split(',').map(Number);

const LIBSRC = join(ROOT, 'engine/src/lib.rs');
const WASM_DST = join(ROOT, 'viewer/engine.wasm');
const WASM_BUILT = join(ROOT, 'engine/target/wasm32-unknown-unknown/release/fm_engine.wasm');

const original = readFileSync(LIBSRC, 'utf8');
let src = original;
const f = (v) => (Number.isInteger(v) ? `${v}.0` : String(v));

// ── 1) tackle 守卫（见 sweep-mechanisms.mjs 的说明：解锁横向实验，行为中性）──
const GUARD_OLD = `        if (oid <= 10) != (victim <= 10) { continue; } // 同队
        let op = st.pos[oid as usize];`;
if (!src.includes(GUARD_OLD)) { console.error('缺 tackle 守卫锚点'); process.exit(1); }
src = src.replace(GUARD_OLD, `        if (oid <= 10) != (victim <= 10) { continue; } // 同队
        if (movers.iter().any(|m| m.id == oid)) { continue; }
        let op = st.pos[oid as usize];`);

// ── 2) exp4b：等间距块 + 球锚定（纵向；取自 notes/patches/exp4b-equal-spacing.patch）──
const FT_ANCHOR = 'fn formation_target(st: &MatchState, id: i32) -> (f64, f64) {';
if (!src.includes(FT_ANCHOR)) { console.error('缺 formation_target 锚点'); process.exit(1); }
const EXP4B = `
    // === exp4b：等间距次序目标 + 球锚定（纵向压缩；来自 notes/patches/exp4b-equal-spacing.patch）===
    if id != 0 && id != 21 {
        let home = id <= 10;
        let ids: Vec<i32> = if home { (1..=10).collect() } else { (11..=20).collect() };
        let mut sorted = ids.clone();
        sorted.sort_by(|&a, &b| st.lineup[a as usize].0.partial_cmp(&st.lineup[b as usize].0).unwrap());
        let r = sorted.iter().position(|&v| v == id).unwrap() as f64 / 9.0;
        let ball_own = if home { st.ball_pos.0 } else { 1.0 - st.ball_pos.0 };
        let centre = (0.165 + 0.59 * ball_own).clamp(0.12, 0.82);
        let rear = (centre - 0.32 * 0.5).clamp(0.04, 0.86);
        let tx_local = rear + 0.32 * r;
        let tx = if home { tx_local } else { 1.0 - tx_local };
        // 横向：线 B 机制接管 y（exp4b 原本把 y 交给静态模板）
        let base_y = st.lineup[id as usize].1;
${mech === 'local' ? `        let mut sum = 0.0; let mut n = 0.0;
        for oid in 0..22i32 {
            if oid == id || st.sent_off[oid as usize] { continue; }
            if (oid <= 10) != home { continue; }
            if oid == 0 || oid == 21 { continue; }
            let op = st.pos[oid as usize];
            if same_team_dist_m(op, st.pos[id as usize]) <= LAT_RADIUS_M { sum += op.1; n += 1.0; }
        }
        let local_y = if n > 0.0 { sum / n } else { base_y };
        let ty = base_y * (1.0 - LAT_BLEND) + local_y * LAT_BLEND + (st.ball_pos.1 - 0.5) * SIDE_SHIFT_FACTOR * 0.6;`
  : `        let ty = base_y;`}
        return (clamp01(tx).clamp(0.04, 0.9), clamp01(ty));
    }
`;
src = src.replace(FT_ANCHOR, `${FT_ANCHOR}${EXP4B}`);

// ── 3) 常量 ──
if (mech === 'local') {
  src = src.replace(/(pub const SIDE_SHIFT_FACTOR: f64 = 0\.06;)/,
    `$1\npub const LAT_BLEND: f64 = ${f(strength)};\npub const LAT_RADIUS_M: f64 = ${f(radius)};`);
}

const tag = `combo-${mech}-${strength}`;
writeFileSync(LIBSRC, src);
try {
  const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };
  const build = spawnSync('cargo', ['build', '--target', 'wasm32-unknown-unknown', '--release'],
    { cwd: join(ROOT, 'engine'), encoding: 'utf8', env });
  if (build.status !== 0) throw new Error(`build 失败：\n${(build.stderr || build.stdout || '').slice(-2500)}`);
  cpSync(WASM_BUILT, WASM_DST, { force: true });
  const sha8 = createHash('sha256').update(readFileSync(WASM_DST)).digest('hex').slice(0, 8);

  const run = spawnSync('node', [join(HERE, 'p38-eval.mjs'), tag, seeds.join(',')], { cwd: ROOT, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr?.slice(-2000));
  const r = JSON.parse(run.stdout.trim().split('\n').pop());
  Object.assign(r, { mech, strength, radius, wasmSha8: sha8, combo: 'exp4b' });
  appendFileSync(join(OUT, 'combos.jsonl'), `${JSON.stringify(r)}\n`);
  console.log(`[${tag} R=${radius}] hd=${r.hd} spread=${r.spread} gap=${r.gap} latSd=${r.latSd}`
    + ` swarm=${r.swarm} fault=${r.fault} midBack=${r.midBack} shotsReg=${r.shotsRegularPerMatch}`
    + ` shotsHdr=${r.shotsHeaderPerMatch} nSeeds=${r.nSeeds} crash=${(r.crashedSeeds || []).length} sha=${sha8}`);
} finally {
  // 硬约束 2：改动只以 .patch 存盘。用 throw（不是 process.exit）保证这里一定跑到。
  writeFileSync(LIBSRC, original);
}
