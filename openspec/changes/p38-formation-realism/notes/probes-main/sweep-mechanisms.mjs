// P38 线 B：「队形的表示方式」——把横向位置从**单一球侧系数**改成**职责/相互作用**驱动。
//
// ── 为什么这么设计（读 sweep 结果先看这段）────────────────────────────────
//
// `probe-lateral-drivers.mjs` 的实测：真实球员 y 的可解释性
//     球 y         R² = 0.17
//     球队重心 y   R² = 0.26
//     最近对手 y   R² = 0.85  ← 但见下
//     最近队友 y   R² = 0.73
// `probe-marking-confound.mjs` 反证：**0.85 不是"盯人"**——
//   最近**队友**也 0.73（"两人靠近"本身就让 y 像）；盯人对象逐帧只有 30% 稳定；
//   交叉相关峰值在 Δ=0 且左右对称（真跟随应有滞后）。
//   → 真实结构是**局部邻域在 y 上同进退**（两个队都是），不是一对一的盯人。
//
// ── 由此得到的关键约束（决定了该试什么）──────────────────────────────
//
// **swarm 判据测的是两两相关。** 若每人 `y_i = base_i + g_i · s(t)`（s = 同一路公共信号），
// 那么即便 g_i 各不相同，corr(y_i, y_j) 仍然 → 1：**公共信号 + 个体增益 = 假的个体性**
// （exp5 就是这么拿到 0.95 的）。要压低 swarm，球员必须读**各不相同的信号源**——
// 而引擎里唯一天然"每人不同"的信号，就是**他自己邻居的位置**（不同的人邻居不同）。
//
// 所以本脚本试三类机制，判据都看同一组：latSd（横向 sd，真实 14.0–14.5）、
// swarm（y 两两相关，真实 0.61–0.74）、hd（纵深 25.9）、L1 门。
//
//   duty   基准：**职责 y + 公共球侧系数**（= 把当前 `ty` 的系数从 0.036 放大，
//          并按边中角色分化）。**预期：latSd 上得去、swarm 也上得去**——这是对照。
//   local  每个球员的 ty 向**附近队友的 y 均值**混合（局部块同进退）。
//          "附近"用半径 R 内的队友，各人邻居集合不同 → 信号天然个体化。
//   mark   每个球员的 ty 向**最近对手的 y** 混合。数据上对手 R²(0.85) > 队友(0.73)，
//          且盯人是防守的正当职责——若 confound 分析错了，这条会赢过 local。
//   both   local + mark 叠加。
//
// 用法：node sweep-mechanisms.mjs <机制> <强度> [半径m] [种子列表]
//   node sweep-mechanisms.mjs duty  0.30
//   node sweep-mechanisms.mjs local 0.50 15
// 输出：一行 JSON + 追加 out/mechanisms.jsonl

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

const mech = process.argv[2] || 'duty';
const strength = Number(process.argv[3] ?? 0.3);
const radius = Number(process.argv[4] ?? 15);
const seeds = (process.argv[5] || '42,1,7,99,123,2,3,5,11,17').split(',').map(Number);

const LIBSRC = join(ROOT, 'engine/src/lib.rs');
const WASM_DST = join(ROOT, 'viewer/engine.wasm');
const WASM_BUILT = join(ROOT, 'engine/target/wasm32-unknown-unknown/release/fm_engine.wasm');

const original = readFileSync(LIBSRC, 'utf8');
const ANCHOR = '    let ty = base.1 + (ball.1 - 0.5) * SIDE_SHIFT_FACTOR * 0.6;';
if (!original.includes(ANCHOR)) {
  console.error('未找到 `let ty = ...` 锚点——lib.rs 不是干净的 main？');
  process.exit(1);
}

// **前置：tackle 重复 mover 守卫**（`patches/fix-tackle-duplicate-mover.patch`）。
//
// 必须带它，否则横向机制**测不了**：横向机制让队友靠得更近（正是我们要的"紧凑"），
// 于是 `emit_tackle_highlight_impl` 的"推开队友"分支频繁触发 → 同 id 两条 mover →
// `createGame` 抛 `beat mover id duplicate`。实测 local s=0.96 时 **10 个种子崩 5 个**，
// s=1.0 崩 3 个——不修的话每个强度点都在"少一半种子"上算均值，**跨行不可比**。
//
// ⚠️ 这个守卫**不是本实验的变量**：它对所有机制一视同仁，且单独跑在干净 main 上
// 不改变任何 10 种子的行为（已验证）。它只是**解锁**横向这一类实验。
const GUARD_OLD = `        if (oid <= 10) != (victim <= 10) { continue; } // 同队
        let op = st.pos[oid as usize];`;
const GUARD_NEW = `        if (oid <= 10) != (victim <= 10) { continue; } // 同队
        if (movers.iter().any(|m| m.id == oid)) { continue; }
        let op = st.pos[oid as usize];`;
if (!original.includes(GUARD_OLD)) {
  console.error('未找到 tackle 守卫插入锚点');
  process.exit(1);
}
const base = original.replace(GUARD_OLD, GUARD_NEW);

const f = (v) => (Number.isInteger(v) ? `${v}.0` : String(v));

// 每个机制产出替换 `let ty = ...` 的代码块 + 一组常量
const MECH = {
  // 对照：职责 y + **公共**球侧信号（按边中角色给不同增益）
  duty: {
    consts: `pub const LAT_GAIN_BASE: f64 = ${f(strength)};\npub const LAT_GAIN_WIDE: f64 = ${f(strength)};`,
    body: `
    // 线B `+'`duty`'+`：职责 y + 球侧倾斜。增益按**角色**（边/中）分化，但信号是公共的球 y。
    // 预期：latSd 上升、swarm 也上升（公共信号 → 两两相关高）。
    let wide = (base.1 - 0.5).abs() * 2.0;              // 0=中路 1=边路
    let gain = LAT_GAIN_BASE + LAT_GAIN_WIDE * wide;
    let ty = base.1 + (ball.1 - 0.5) * gain;`,
  },
  // 局部块：向"附近队友 y 均值"混合（各人邻居不同 → 信号个体化）
  local: {
    consts: `pub const LAT_BLEND: f64 = ${f(strength)};\npub const LAT_RADIUS_M: f64 = ${f(radius)};`,
    body: `
    // 线B `+'`local`'+`：每人的 ty 向**半径 R 内队友的 y 均值**混合。
    // 邻居集合逐人不同 → 信号个体化（是压低 swarm 的关键）。
    let mut sum = 0.0; let mut n = 0.0;
    for oid in 0..22i32 {
        if oid == id || st.sent_off[oid as usize] { continue; }
        if (oid <= 10) != home { continue; }
        if oid == 0 || oid == 21 { continue; }
        let op = st.pos[oid as usize];
        if same_team_dist_m(op, st.pos[id as usize]) <= LAT_RADIUS_M { sum += op.1; n += 1.0; }
    }
    let local_y = if n > 0.0 { sum / n } else { base.1 };
    let ty = base.1 * (1.0 - LAT_BLEND) + local_y * LAT_BLEND + (ball.1 - 0.5) * SIDE_SHIFT_FACTOR * 0.6;`,
  },
  // 盯人：向最近对手的 y 混合
  mark: {
    consts: `pub const LAT_BLEND: f64 = ${f(strength)};`,
    body: `
    // 线B `+'`mark`'+`：每人的 ty 向**最近对手的 y**混合（对手因人而异 → 信号个体化）。
    // 数据上对手 R²(0.85) > 队友(0.73)，但 confound 反证说那不是真盯人——本机制直接实测。
    let opp_team: u32 = if home { 1 } else { 0 };
    let oi = nearest_in_team(st, st.pos[id as usize], opp_team);
    let opp_y = if oi >= 0 { st.pos[oi as usize].1 } else { base.1 };
    let ty = base.1 * (1.0 - LAT_BLEND) + opp_y * LAT_BLEND + (ball.1 - 0.5) * SIDE_SHIFT_FACTOR * 0.6;`,
  },
  // **门控球侧**：对球 y 的响应强度取决于"球在 x 上离我多近"。
  //
  // 动机（来自 duty/local 的结构分析）：`duty` 的 latSd 高但 swarm 也高，因为**所有人同时**
  // 响应同一个球 y（同相位）。足球里的真实做法是**球到我这一侧我才大幅横移**——
  // 每个人的响应**相位**不同（球先到左边卫、再到中场…），于是公共信号被拆成
  // 每人不同的**时移**版本 → swarm 被打破，而方差仍由球 y 的幅度提供。
  //
  // `LAT_RADIUS_M` 复用为 x 向的"响应半径"（米）：球在我 x 方向 ±R 内时吃满增益，
  // 越远越低（线性衰减到 LAT_FAR_GAIN）。
  gated: {
    consts: `pub const LAT_GAIN: f64 = ${f(strength)};\npub const LAT_FAR_GAIN: f64 = 0.10;\npub const LAT_RADIUS_M: f64 = ${f(radius)};`,
    body: `
    // 线B `+'`gated`'+`：增益随"球在 x 上离我多远"衰减 → 各人响应相位不同。
    let dx_m = (ball.0 - st.pos[id as usize].0).abs() * PITCH_LENGTH_M;
    let near = (1.0 - dx_m / LAT_RADIUS_M).clamp(0.0, 1.0);
    let gain = LAT_FAR_GAIN + (LAT_GAIN - LAT_FAR_GAIN) * near;
    let ty = base.1 + (ball.1 - 0.5) * gain * 2.0;`,
  },
  // **混合**：公共分量（球侧）+ 个体分量（局部邻域）。
  // 动机：实测真实 swarm = 0.671，**夹在** duty（公共信号，0.88）与 local（纯个体，0.39）**之间**。
  // 真实球队既有"整队随球倾斜"（公共）又有"各人自己的局部协调"（个体）。
  // `LAT_BLEND` 给个体分量权重，(1-LAT_BLEND) 给公共分量。
  blend: {
    consts: `pub const LAT_BLEND: f64 = ${f(strength)};\npub const LAT_RADIUS_M: f64 = ${f(radius)};\npub const LAT_COMMON_GAIN: f64 = 0.30;`,
    body: `
    // 线B `+'`blend`'+`：(1-b)·公共球侧 + b·局部邻域均值。b=0 → duty，b=1 → local。
    let mut sum = 0.0; let mut n = 0.0;
    for oid in 0..22i32 {
        if oid == id || st.sent_off[oid as usize] { continue; }
        if (oid <= 10) != home { continue; }
        if oid == 0 || oid == 21 { continue; }
        let op = st.pos[oid as usize];
        if same_team_dist_m(op, st.pos[id as usize]) <= LAT_RADIUS_M { sum += op.1; n += 1.0; }
    }
    let local_y = if n > 0.0 { sum / n } else { base.1 };
    let public_y = base.1 + (ball.1 - 0.5) * LAT_COMMON_GAIN;
    let ref_y = public_y * (1.0 - LAT_BLEND) + local_y * LAT_BLEND;
    let ty = ref_y + (ball.1 - 0.5) * SIDE_SHIFT_FACTOR * 0.6;`,
  },
  both: {
    consts: `pub const LAT_BLEND: f64 = ${f(strength)};\npub const LAT_RADIUS_M: f64 = ${f(radius)};`,
    body: `
    // 线B `+'`both`'+`：local 与 mark 各半。
    let mut sum = 0.0; let mut n = 0.0;
    for oid in 0..22i32 {
        if oid == id || st.sent_off[oid as usize] { continue; }
        if (oid <= 10) != home { continue; }
        if oid == 0 || oid == 21 { continue; }
        let op = st.pos[oid as usize];
        if same_team_dist_m(op, st.pos[id as usize]) <= LAT_RADIUS_M { sum += op.1; n += 1.0; }
    }
    let local_y = if n > 0.0 { sum / n } else { base.1 };
    let opp_team: u32 = if home { 1 } else { 0 };
    let oi = nearest_in_team(st, st.pos[id as usize], opp_team);
    let opp_y = if oi >= 0 { st.pos[oi as usize].1 } else { base.1 };
    let ref_y = local_y * 0.5 + opp_y * 0.5;
    let ty = base.1 * (1.0 - LAT_BLEND) + ref_y * LAT_BLEND + (ball.1 - 0.5) * SIDE_SHIFT_FACTOR * 0.6;`,
  },
};
if (!MECH[mech]) { console.error(`未知机制 ${mech}（可选 ${Object.keys(MECH)}）`); process.exit(1); }

// 常量插在 SIDE_SHIFT_FACTOR 之后
let src = base.replace(
  /(pub const SIDE_SHIFT_FACTOR: f64 = 0\.06;)/,
  `$1\n${MECH[mech].consts}`,
);
if (src === base) { console.error('常量锚点未命中'); process.exit(1); }
src = src.replace(ANCHOR, MECH[mech].body.trimEnd());
if (src.includes(ANCHOR)) { console.error('ty 锚点替换失败'); process.exit(1); }

writeFileSync(LIBSRC, src);
try {
  const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };
  const build = spawnSync('cargo', ['build', '--target', 'wasm32-unknown-unknown', '--release'],
    { cwd: join(ROOT, 'engine'), encoding: 'utf8', env });
  if (build.status !== 0) throw new Error(`build 失败：\n${(build.stderr || build.stdout || '').slice(-2500)}`);
  cpSync(WASM_BUILT, WASM_DST, { force: true });
  const sha8 = createHash('sha256').update(readFileSync(WASM_DST)).digest('hex').slice(0, 8);

  const run = spawnSync('node', [join(HERE, 'p38-eval.mjs'), `${mech}-${strength}`, seeds.join(',')],
    { cwd: ROOT, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr?.slice(-2000));
  const r = JSON.parse(run.stdout.trim().split('\n').pop());
  Object.assign(r, { mech, strength, radius, wasmSha8: sha8 });
  appendFileSync(join(OUT, 'mechanisms.jsonl'), `${JSON.stringify(r)}\n`);
  console.log(`[${mech} s=${strength} R=${radius}] hd=${r.hd} gap=${r.gap} latSd=${r.latSd} lonSd=${r.lonSd}`
    + ` swarm=${r.swarm} straight=${r.straight} shotsReg=${r.shotsRegularPerMatch} fault=${r.fault}`
    + ` nSeeds=${r.nSeeds} sha=${sha8}`);
} finally {
  // 硬约束 2：改动只以 .patch 存盘。默认还原。
  // `P38_KEEP=1` 保留改动源码——只给**需要接着跑 L1 门 / 渲图**的场合用
  // （那两步要读源码重编译）。用完必须自己 `git checkout engine/src/lib.rs`。
  if (process.env.P38_KEEP !== '1') writeFileSync(LIBSRC, original);
  else console.error('⚠️ P38_KEEP=1：lib.rs 未还原，用完请 git checkout');
}
