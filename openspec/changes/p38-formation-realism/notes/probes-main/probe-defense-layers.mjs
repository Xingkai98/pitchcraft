// P38 阶段 2：射门瞬间的**防守者分层**剖面 —— 真实 vs 引擎 vs 候选。
//
// 重跑 `probe-shot-space.mjs` 的**可移植版**（原版硬编码到 `/home/happy/.claude/worktrees/`
// 的旧 worktree，是 P38 踩过的"脚本指向旧 worktree"那个坑的现存实例）。
//
// 为什么要看「第 1 近 / 第 2 近 / 第 3 近」三档，而不只是最近一个：
//   主 session 实测（Metrica 48 脚射门）：
//     真实：最近防守者中位 2.0–2.9m，**第二近中位 5.0–5.8m（79% <8m）**
//     引擎：最近 8.3m（45% <8m），第二近 9.8m（**只有 15% <8m**）
//   → 真实是「**一人贴身 + 一人 5m 待命**」的两层结构；引擎是**一层且都很远**。
//
//   引擎的射门 hazard **已经**对第二防守者加权（`space_available = 0.65·nearest + 0.35·second`）；
//   问题不在模型，在**防守方没实现这个结构**。本探针量的是"结构有没有出现"。
//
// 口径：射门事件时刻 → 最近帧 → 球位到对方**非门将**球员的距离（米）。
// 真实与引擎走**同一段代码**（P36 教训：口径分叉 = 数字不可比）。
//
// 用法：node probe-defense-layers.mjs [标签]
// 环境：SEEDS=42,1,7,99,123,2,3,5,11,17（缺省本判据的 10 种子）

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '../probes/repo-root.mjs';
import { KEEPER_IDS, PITCH_LENGTH_M, PITCH_WIDTH_M, ENGINE_DURATION_SEC }
  from '../../../../../viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '../../../../../tools/benchmark-engine.mjs';

const HERE = findRepoRoot(new URL('.', import.meta.url).pathname);
const label = process.argv[2] || 'current';
const seeds = (process.env.SEEDS || '42,1,7,99,123,2,3,5,11,17').split(',').map(Number);

const qs = (s, p) => {
  if (!s.length) return NaN;
  const h = (s.length - 1) * p; const lo = Math.floor(h); const hi = Math.ceil(h);
  return s[lo] + (h - lo) * (s[hi] - s[lo]);
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

// 到球位的距离排序后的**对方非门将**距离序列（升序），取前 k 档。
// 门将排除——门将永远在球门附近，算进来会把"第二近"变成门将，掩盖分层。
function defenderDistances(frame, ballX, ballY, shooterIsHome, k = 3) {
  const ds = [];
  for (const p of frame.players) {
    if (!p) continue;
    if (KEEPER_IDS.includes(p.id)) continue;
    if ((p.id <= 10) === shooterIsHome) continue;      // 只看对方
    ds.push(Math.hypot((p.x - ballX) * PITCH_LENGTH_M, (p.y - ballY) * PITCH_WIDTH_M));
  }
  ds.sort((a, b) => a - b);
  return ds.slice(0, k);
}

function summarize(rows, title) {
  if (!rows.length) { console.log(`  ${title}: 无样本`); return null; }
  console.log(`\n  ${title}（n=${rows.length} 脚）`);
  console.log(`    ${'档'.padEnd(6)} ${'中位'.padStart(6)} ${'p25'.padStart(6)} ${'p75'.padStart(6)} ${'<4m'.padStart(7)} ${'<8m'.padStart(7)}`);
  const out = {};
  for (let k = 0; k < 3; k += 1) {
    const col = rows.map((r) => r[k]).filter(Number.isFinite);
    const s = [...col].sort((a, b) => a - b);
    out[`d${k + 1}`] = qs(s, 0.5);
    console.log(`    ${`第${k + 1}近`.padEnd(6)} ${qs(s, 0.5).toFixed(1).padStart(6)} `
      + `${qs(s, 0.25).toFixed(1).padStart(6)} ${qs(s, 0.75).toFixed(1).padStart(6)} `
      + `${`${(100 * col.filter((d) => d < 4).length / col.length).toFixed(0)}%`.padStart(7)} `
      + `${`${(100 * col.filter((d) => d < 8).length / col.length).toFixed(0)}%`.padStart(7)}`);
  }
  // 分层信号：第二近 − 最近（越大越"两层"，≈0 越"一层平推"）
  const gap = rows.map((r) => r[1] - r[0]).filter(Number.isFinite);
  out.layerGap = mean(gap);
  console.log(`    第二近 − 最近（分层间距）均值 ${mean(gap).toFixed(2)}m`);
  return out;
}

const result = { label, seeds, real: null, engine: null };

// ── 真实：Metrica 事件 CSV 的 SHOT + tracking 帧 ──────────────────────────
console.log('=== 射门瞬间「对方非门将距离」剖面 ===\n');
for (const game of ['1', '2']) {
  const csvPath = join(HERE, `.scratch/tracking-data/sample-data/data/Sample_Game_${game}`,
    `Sample_Game_${game}_RawEventsData.csv`);
  if (!existsSync(csvPath)) {
    console.log(`游戏 ${game}：缺事件表（见 real-shots.mjs 的说明），跳过`);
    continue;
  }
  const lines = readFileSync(csvPath, 'utf8').split('\n').slice(1).filter(Boolean);
  const shots = [];
  for (const l of lines) {
    const c = l.split(',');
    if (c[1] !== 'SHOT') continue;
    shots.push({ t: Number(c[5]), team: c[0].replace(/"/g, '') });
  }
  const g = JSON.parse(readFileSync(join(HERE, `viewer/data/real-game-${game}.json`), 'utf8'));
  const frames = g.frames;
  const rows = [];
  let matched = 0;
  for (const s of shots) {
    // 事件 t 与帧 t 同一时基；线性扫描够用（每场 ~30k 帧 × ~24 脚）
    let best = null;
    for (const f of frames) {
      const d = Math.abs(f.t - s.t);
      if (!best || d < best.d) best = { d, f };
    }
    if (!best || best.d > 1.0 || !best.f.ball) continue;
    const f = best.f;
    const shooterIsHome = s.team === 'Home';
    const ds = defenderDistances(
      { players: f.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)) },
      f.ball[0], f.ball[1], shooterIsHome);
    if (ds.length >= 2) { rows.push(ds); matched += 1; }
  }
  console.log(`Metrica game${game}：事件表 ${shots.length} 脚，匹配上 ${matched}`);
  result.real = summarize(rows, `真实 game${game}`);
}

// ── 引擎 ────────────────────────────────────────────────────────────────
const load = await loadEngineWasm(WASM_PATH);
if (!load.ok) { console.error(load.message); process.exit(1); }
const { createGame } = await import(`${HERE}/viewer/game.js`);
const rows = [];
let crashed = 0;
for (const seed of seeds) {
  const stream = simulateStream(load.wasm, seed, ENGINE_DURATION_SEC);
  let game;
  try { game = createGame(stream); } catch { crashed += 1; continue; }
  const events = JSON.parse(stream);
  // 采样帧（与标尺同口径）用于最近邻查找
  const { sampleEngineFrames } = await import(`${HERE}/viewer/match-metrics.js`);
  const frames = sampleEngineFrames(game);
  for (const e of events) {
    if (e.type !== 'shot' || e.detail === 'header' || e.x == null) continue;
    let best = null;
    for (const f of frames) {
      const d = Math.abs(f.t - e.t);
      if (!best || d < best.d) best = { d, f };
    }
    if (!best || best.d > 1.0) continue;
    const ds = defenderDistances(best.f, e.x, e.y, e.subject <= 10);
    if (ds.length >= 2) rows.push(ds);
  }
}
if (crashed) console.log(`\n⚠ ${crashed}/${seeds.length} 个种子崩溃（重复 mover）`);
result.engine = summarize(rows, `引擎 ${label}（${seeds.length} 种子）`);

console.log('\n读法：真实的「第二近 <8m 占比」很高（~79%）而引擎很低（~15%）');
console.log('      → 真实的防守是「一人贴身 + 一人 5m 待命」两层；引擎是一层且都很远。');
console.log('      若候选把第二近拉近而第一近不变，就是"分层"出现了。');
console.log(`\nJSON ${JSON.stringify(result)}`);
