// P38 阶段 2：**射门 hazard 五因子的分解** —— 射门为什么崩，崩在哪一项？
//
// 动机：exp4b 把纵深修到 26（达标）却让射门从 7.2 掉到 0.56/场。此前只有
// 「最近防守者 <8m 占比从 50.6% 升到 92%」这一条**间接**证据，而本轮
// `probe-defense-layers.mjs` 实测：exp4b 在射门瞬间 d1=8.3m / d2=12.4m——
// **比真实还远**。所以"防守者太近"这个解释**站不住**，必须直接分解五因子。
//
// 做法：hazard 的因子是**纯函数**（`engine/src/lib.rs` 的 ShotOpportunityFeatures），
// 可以在 JS 里按同一公式重算——只消费采样帧的公开观测（不用读引擎内部状态）。
// ⚠️ 常数必须与 Rust 源码**逐字对齐**；漂移了本探针就在测别的东西。
//    （下面 CONST 块的每个值都标了 Rust 里的常量名，改引擎时要同步改这里。）
//
// 用法：node probe-shot-factors.mjs [变体名] [JSON 参数]
//   node probe-shot-factors.mjs                    # 干净 main
//   node probe-shot-factors.mjs exp4b              # exp4b 变体

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { findRepoRoot } from '../probes/repo-root.mjs';
import {
  KEEPER_IDS, PITCH_LENGTH_M, PITCH_WIDTH_M, ENGINE_DURATION_SEC,
} from '../../../../../viewer/match-metrics.js';
import { VARIANTS, applyVariant } from './layer-variants.mjs';

const ROOT = findRepoRoot(new URL('.', import.meta.url).pathname);
const variant = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : null;
const params = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const SEEDS = (process.env.SEEDS || '42,1,7,99,123,2,3,5,11,17').split(',').map(Number);

// ── 与 engine/src/lib.rs 逐字对齐的常数 ──────────────────────────────────
const CONST = {
  BASE_SHOT_TENDENCY: -4.0,
  SHOT_FACTOR_GAIN: 2.5,
  SHOT_PRESSURE_NEAR_M: 3.0,
  SHOT_PRESSURE_SECOND_M: 8.0,
  SHOT_SPACE_MIN_M: 1.5,
  SHOT_SPACE_MAX_M: 5.0,
  BOX_DIST_M: 16.5,
  ARC_DIST_M: 25.0,
};

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, t) => a + (b - a) * clamp01(t);
const shotSpaceScore = (d) => clamp01((d - CONST.SHOT_SPACE_MIN_M) / (CONST.SHOT_SPACE_MAX_M - CONST.SHOT_SPACE_MIN_M));

function distanceQuality(d) {
  if (d <= 6.0) return 1.0;
  if (d <= CONST.BOX_DIST_M) return lerp(1.0, 0.9, (d - 6.0) / (CONST.BOX_DIST_M - 6.0));
  if (d <= CONST.ARC_DIST_M) return lerp(0.9, 0.45, (d - CONST.BOX_DIST_M) / (CONST.ARC_DIST_M - CONST.BOX_DIST_M));
  if (d <= 35.0) return lerp(0.45, 0.05, (d - CONST.ARC_DIST_M) / (35.0 - CONST.ARC_DIST_M));
  return lerp(0.05, 0.0, (d - 35.0) / (PITCH_LENGTH_M - 35.0));
}

const qs = (s, p) => {
  if (!s.length) return NaN;
  const h = (s.length - 1) * p; const lo = Math.floor(h); const hi = Math.ceil(h);
  return s[lo] + (h - lo) * (s[hi] - s[lo]);
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

// 从一帧 + 一个"持球者"（用**控球代理**：离球最近者）算出五因子。
// ⚠️ 代理不是真持球权（不处理传球在途）——这是**报告项**，不作断言。
function factorsAt(frame, carrierId) {
  const c = frame.players.find((p) => p && p.id === carrierId);
  if (!c) return null;
  const home = carrierId <= 10;
  const px = c.x * PITCH_LENGTH_M; const py = c.y * PITCH_WIDTH_M;
  const gx = (home ? 1.0 : 0.0) * PITCH_LENGTH_M; const gy = 0.5 * PITCH_WIDTH_M;
  const distance_m = Math.hypot(gx - px, gy - py);
  const dx = (home ? 1.0 - c.x : c.x) * PITCH_LENGTH_M;
  const dy = (home ? 0.5 - c.y : c.y - 0.5) * PITCH_WIDTH_M;
  const len = Math.hypot(dx, dy);
  const angle_cos = len < 1e-9 ? 1.0 : Math.max(-1, Math.min(1, dx / len));
  // 对方非门将距离
  const ds = [];
  for (const p of frame.players) {
    if (!p || KEEPER_IDS.includes(p.id)) continue;
    if ((p.id <= 10) === home) continue;
    ds.push(Math.hypot((p.x - c.x) * PITCH_LENGTH_M, (p.y - c.y) * PITCH_WIDTH_M));
  }
  ds.sort((a, b) => a - b);
  const near = ds[0] ?? PITCH_LENGTH_M; const second = ds[1] ?? PITCH_LENGTH_M;
  return {
    distance_m, angle_cos, near, second,
    distance_quality: distanceQuality(distance_m),
    angle_quality: clamp01(Math.max(0, angle_cos)),
    space_available: 0.65 * shotSpaceScore(near) + 0.35 * shotSpaceScore(second),
    defensive_pressure: 0.65 * clamp01(1 - near / CONST.SHOT_PRESSURE_NEAR_M)
      + 0.35 * clamp01(1 - second / CONST.SHOT_PRESSURE_SECOND_M),
  };
}

function scoreOf(f) {
  const factors = f.distance_quality + f.angle_quality + f.space_available - f.defensive_pressure;
  return CONST.BASE_SHOT_TENDENCY + CONST.SHOT_FACTOR_GAIN * factors;
}

// ── 跑一场：采样帧 + 逐帧算因子（只保留"够得着射门"的帧）───────────────
async function collectFor(wasm) {
  const { createGame } = await import(`${ROOT}/viewer/game.js`);
  const { sampleEngineFrames } = await import(`${ROOT}/viewer/match-metrics.js`);
  const { simulateStream } = await import(`${ROOT}/tools/benchmark-engine.mjs`);
  const rows = [];
  let crashed = 0;
  for (const seed of SEEDS) {
    const stream = simulateStream(wasm, seed, ENGINE_DURATION_SEC);
    let game;
    try { game = createGame(stream); } catch { crashed += 1; continue; }
    const frames = sampleEngineFrames(game);
    for (const f of frames) {
      if (!f.ball) continue;
      const [bx, by] = [f.ball[0] * PITCH_LENGTH_M, f.ball[1] * PITCH_WIDTH_M];
      let best = null;
      for (const p of f.players) {
        if (!p8Safe(p)) continue;
        const d = Math.hypot(p.x * PITCH_LENGTH_M - bx, p.y * PITCH_WIDTH_M - by);
        if (!best || d < best.d) best = { d, id: p.id };
      }
      if (!best) continue;
      const f5 = factorsAt(f, best.id);
      if (!f5) continue;
      // 只保留**射门窗口可能开启**的帧：在射程内且大致面向球门。
      // 阈值与 hazard 的 distance_quality 分段一致（>25m 的 distance_quality < 0.45）。
      if (f5.distance_m > CONST.ARC_DIST_M) continue;
      if (f5.angle_cos <= 0) continue;
      f5.score = scoreOf(f5);
      f5.possession = best.id <= 10 ? 'home' : 'away';
      rows.push(f5);
    }
  }
  return { rows, crashed };
}
// 防御 undefined 球员（探针不能因为脏帧就崩）
function p8Safe(p) { return p && !KEEPER_IDS.includes(p.id); }

const LIBSRC = join(ROOT, 'engine/src/lib.rs');
const WASM = join(ROOT, 'viewer/engine.wasm');
const BUILT = join(ROOT, 'engine/target/wasm32-unknown-unknown/release/fm_engine.wasm');
const CARGO = `${process.env.HOME}/.cargo/bin/cargo`;
const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };
const original = readFileSync(LIBSRC, 'utf8');
const rebuild = () => {
  const r = spawnSync(CARGO, ['build', '--target', 'wasm32-unknown-unknown', '--release'],
    { cwd: join(ROOT, 'engine'), env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error((r.stderr || '').slice(-1500));
  spawnSync('cp', [BUILT, WASM]);
};

async function loadWasm() {
  const { loadEngineWasm } = await import(`${ROOT}/tools/benchmark-engine.mjs`);
  const l = await loadEngineWasm(WASM);
  if (!l.ok) throw new Error(l.message);
  return l.wasm;
}

let out = null;
try {
  if (variant) {
    writeFileSync(LIBSRC, applyVariant(original, VARIANTS[variant](params)));
    rebuild();
  }
  const wasm = await loadWasm();
  const { rows, crashed } = await collectFor(wasm);
  const col = (k) => rows.map((r) => r[k]).filter(Number.isFinite).sort((a, b) => a - b);
  out = {
    variant: variant || 'clean-main', n: rows.length, crashed,
    distance_m: +qs(col('distance_m'), 0.5).toFixed(1),
    near: +qs(col('near'), 0.5).toFixed(1),
    second: +qs(col('second'), 0.5).toFixed(1),
    f_distance: +mean(col('distance_quality')).toFixed(3),
    f_angle: +mean(col('angle_quality')).toFixed(3),
    f_space: +mean(col('space_available')).toFixed(3),
    f_pressure: +mean(col('defensive_pressure')).toFixed(3),
    score: +mean(col('score')).toFixed(3),
    // 高机会帧占比（score > -4.0 即 hazard > 1，一 tick 起脚概率 > 63%）
    hiShare: +(col('score').filter((v) => v > -4.0).length / rows.length).toFixed(3),
  };
} finally {
  writeFileSync(LIBSRC, original);
  rebuild();
}

console.log(JSON.stringify(out));
