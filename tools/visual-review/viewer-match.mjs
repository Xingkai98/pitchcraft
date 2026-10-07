// 「**用户实际看到的那场比赛**」——viewer 的固定配置，一等公民。
//
// ── 为什么有它（2026-10-07，用户点破的头号问题）─────────────────────────────
// 用户：「**我发现现在每次你看的结果和我看的不一样**」——查下来是真事：
//   - **viewer 播的是 `FIXED_SEED=42`、`matchDuration=5` 分钟（300s）、`demo_mode:false`**；
//   - 而主 session 的探针一直跑 **5400s（90 分钟）× 多个 seed**、并报**聚合/均值**。
// ⇒ 两个「真实」：用户看的是 5 分钟的一场；我报的是 90 分钟的统计。**在 5 分钟里，
//   引擎每场只有 ~1.6 抢断 / ~0.7 射门** —— 用户说「根本没有防守」**完全正确**，而我的
//   「抢断 30/场 ∈ L1 带 [24,50]」把这个体验**藏掉了**（30/场 ÷ 18 = 1.7/5min）。
//   **P143r-v3/def/events 的所有「改善」都是在 90 分钟聚合上量的——在 5 分钟窗口里全部消失。**
//
// ── 纪律（本仓新增）───────────────────────────────────────────────────────
// **先量用户实际看的（本模块）；要报 90 分钟聚合做「统计带是否破」的判据时，必须两个尺度并列，
// 且领先写「你看到的（5min）」。** 只报 90 分钟聚合 = 又一次「你看的和我看的不一样」。
//
// ⚠️ 常量**从 viewer 源码读**（`viewer/config.js` 的 `matchDuration`、`viewer/app.js` 的
// `FIXED_SEED`）——**不硬编码**，且 `viewer-match.test.mjs` 会在 viewer 改了配置而本文件未跟随时**变红**
// （防「工具与 viewer 静默漂移」，正是本问题的根）。
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// 从 viewer 源码解析（不硬编码）——见文件头。
export function viewerConfig(root = ROOT) {
  const cfg = readFileSync(join(root, 'viewer/config.js'), 'utf8');
  const app = readFileSync(join(root, 'viewer/app.js'), 'utf8');
  const mDur = /matchDuration:\s*([0-9.]+)/.exec(cfg);
  const mSeed = /FIXED_SEED\s*=\s*([0-9]+)/.exec(app);
  if (!mDur || !mSeed) throw new Error('无法从 viewer/config.js 或 app.js 解析 matchDuration / FIXED_SEED');
  return { seed: Number(mSeed[1]), durationSec: Math.round(Number(mDur[1]) * 60), matchMinutes: Number(mDur[1]) };
}
export const VIEWER = viewerConfig();

// viewer 那场的引擎帧序列（seed 42 / 300s，与 app.js 的 simulate 调用同参）。
export async function viewerMatchFrames(wasmPath) {
  const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
  const mm = await import(join(ROOT, 'viewer/match-metrics.js'));
  const { createGame } = await import(join(ROOT, 'viewer/game.js'));
  const { wasm } = await loadEngineWasm(wasmPath);
  return mm.sampleEngineFrames(createGame(simulateStream(wasm, VIEWER.seed, VIEWER.durationSec)));
}

// viewer 那场的原始事件计数（不采帧，直接读事件流）——「每 5 分钟发生了什么」。
export async function viewerMatchEvents(wasmPath) {
  const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
  const { wasm } = await loadEngineWasm(wasmPath);
  const s = JSON.parse(simulateStream(wasm, VIEWER.seed, VIEWER.durationSec));
  const ev = Object.values(s).filter(e => e && e.type);
  const c = { pass: 0, tackle: 0, foul: 0, shot: 0 };
  for (const e of ev) if (e.type in c) c[e.type] += 1;
  return { ...c, total: ev.length, minutes: VIEWER.matchMinutes };
}

const IS_ENTRY = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (IS_ENTRY) {
  const wasmPath = process.argv[2];
  if (!wasmPath) { console.error('用法: node viewer-match.mjs <engine.wasm>'); process.exit(2); }
  const c = await viewerMatchEvents(wasmPath);
  console.log(`【用户实际看到的：seed=${VIEWER.seed}, ${VIEWER.matchMinutes} 分钟】${wasmPath}`);
  console.log(`  每 ${VIEWER.matchMinutes} 分钟原始事件：传球 ${c.pass} | 抢断 ${c.tackle} | 犯规 ${c.foul} | 射门 ${c.shot}`);
}
