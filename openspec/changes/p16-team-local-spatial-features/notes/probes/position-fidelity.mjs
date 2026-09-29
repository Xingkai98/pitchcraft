// P16 位置保真度探针（**可复现**：只用公开 API，零引擎插桩）。
//
// 它回答的问题：**只靠事件流（`lineup` + 逐拍 `movers`/`main`）重放出的 22 人位置，
// 与 viewer 实际渲染出来的位置差多少？**
//
// 为什么需要这个数：用户选择「引擎导出位置」（见 `POSITION-EXPORT-DESIGN.md`）的前提是
// 「`movers` 只是 `st.pos` 的**残缺**派生」。本探针量化「残缺」有多大——若它足够小，
// 那反对「从事件流重放」的理由就只剩**原则**（P15A 的「不读取事件文本、不做推断」），
// 而不是数值精度。
//
// 两侧都来自公开面：
//   A. **beat-only 重放**：解析事件流 JSON，从 `lineup` 起，逐拍把 `beat.main` /
//      `beat.movers` 的终点累加进 22 人位置表（carry-forward）。
//      —— 这正是「从事件文本事后推断」那种做法。
//   B. **viewer 渲染路径**：`createGame(stream)` + `sampleEngineFrames`（走
//      `interpretation.js` 的锚点时间线 + `game.js` 的插值）。
//
// ⚠️ **本探针的两个纪律**（都是本 change 踩过的坑，见 `POSITION-EXPORT-DESIGN.md` §1）：
//   1. **比较函数必须对「比较失败」有区分度**：`NaN` 必须显式判红。
//      早期版本对数组误用 `.x`/`.y` 得到 `NaN`，而 `NaN > max` 恒假
//      ⇒ 打印出「max = 0.000000」而计数照常增长——**假证据**。
//   2. **写清对照的两端**：`A vs B`（本探针，可复现）与 `A vs 真值 st.pos`（需插桩）
//      是两个不同的量，**不可混引**。本探针只给前者。
//
// 跑法（需先在**本 worktree** 构建 wasm，见 CLAUDE.md）：
//   cd engine && cargo build --target wasm32-unknown-unknown --release
//   cp target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/engine.wasm
//   node openspec/changes/p16-team-local-spatial-features/notes/probes/position-fidelity.mjs

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools', 'benchmark-engine.mjs'));
const { sampleEngineFrames } = await import(join(ROOT, 'viewer', 'match-metrics.js'));
const { createGame } = await import(join(ROOT, 'viewer', 'game.js'));

const SEED = Number(process.argv[2] ?? 1);
const LIMIT_T = Number(process.argv[3] ?? 900);

/** beat-only 重放：从 lineup 起，逐拍累加 main/movers 的终点（carry-forward）。 */
export function replayFromEventStream(events) {
  const pos = new Array(22).fill(null);
  const frames = [];
  for (const e of events) {
    if (e.type === 'lineup' && Array.isArray(e.players)) {
      // 事件协议里 `lineup.players` 是对象数组 {id, team, x, y}（不是元组）——
      // 早先按元组解构会抛 `.for is not iterable`。
      for (const p of e.players) if (p.id >= 0 && p.id < 22) pos[p.id] = [p.x, p.y];
    } else if (e.type === 'beat') {
      if (e.main && e.main.subject >= 0 && e.main.subject < 22) {
        pos[e.main.subject] = [e.main.x2, e.main.y2];
      }
      if (Array.isArray(e.movers)) {
        for (const m of e.movers) if (m.id >= 0 && m.id < 22) pos[m.id] = [m.to_x, m.to_y];
      }
      frames.push({ t: e.t, pos: pos.map((p) => (p ? [...p] : null)) });
    }
  }
  return frames;
}

/** 逐点比较；`NaN` 显式抛错（本 change 的探针纪律 1）。 */
export function compareFrames(replay, render, { limitT = Infinity } = {}) {
  const byT = new Map();
  for (const f of replay) byT.set(f.t, f.pos);
  let n = 0;
  let worst = 0;
  let sum = 0;
  let over1cm = 0;
  let worstAt = null;
  let frames = 0;
  let framesWithDiff = 0;
  // ⚠️ **跳过数必须报**（本 change 的探针纪律）：不报跳过，「N 点全通过」会把
  // 「大部分点根本没比」读成「大部分点通过了」。分三类计数并随结果返回。
  let skippedNonInteger = 0; // 非整秒帧（本探针只比整秒）
  let skippedOverLimit = 0;  // 超出 limitT
  let skippedNoReplay = 0;   // 重放侧没有该时刻
  let skippedPoint = 0;      // 某一侧缺该 id 的点
  for (const f of render) {
    if (!Number.isInteger(f.t)) { skippedNonInteger += 1; continue; }
    if (f.t > limitT) { skippedOverLimit += 1; continue; }
    const rp = byT.get(f.t);
    if (!rp) { skippedNoReplay += 1; continue; }
    frames += 1;
    let frameDiff = 0;
    for (let id = 0; id < 22; id += 1) {
      const a = f.players.find((p) => p.id === id);
      const b = rp[id];
      if (!a || !b) { skippedPoint += 1; continue; }
      const d = Math.hypot(a.x - b[0], a.y - b[1]);
      if (!Number.isFinite(d)) {
        throw new Error(`比较得到非有限值：t=${f.t} id=${id} render=${a.x},${a.y} replay=${b}`);
      }
      n += 1;
      sum += d;
      if (d > 0.01) over1cm += 1;
      if (d > worst) {
        worst = d;
        worstAt = { t: f.t, id };
      }
      frameDiff = Math.max(frameDiff, d);
    }
    if (frameDiff > 0.01) framesWithDiff += 1;
  }
  return {
    n, frames, framesWithDiff, worst, worstAt, mean: n ? sum / n : NaN, over1cm,
    skipped: { nonInteger: skippedNonInteger, overLimit: skippedOverLimit, noReplay: skippedNoReplay, point: skippedPoint },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { ok, wasm, message } = await loadEngineWasm();
  if (!ok) {
    console.log(`跳过：${message}`);
    process.exit(0);
  }
  const stream = simulateStream(wasm, SEED, 5400);
  const replay = replayFromEventStream(JSON.parse(stream));
  const game = createGame(stream);
  const render = sampleEngineFrames(game, { stepSec: 0.2 });
  const r = compareFrames(replay, render, { limitT: LIMIT_T });
  console.log(`seed=${SEED} 对照：beat-only 重放(A) vs viewer 渲染路径(B)，t ≤ ${LIMIT_T}`);
  console.log(`  比较 ${r.n} 点 / ${r.frames} 个整秒帧`);
  // ⚠️ 归一化距离**不能**乘单一标量换算成米（球场 105×68 各向异性）。
  // 这里**只打印归一化值**；要读米数须用 hypot(dx*105, dy*68)，且须逐点算、不能拿 hypot 后的模长再乘。
  console.log(`  最大偏差 = ${r.worst.toFixed(6)}（归一化，0–1；球场对角线的 ${(r.worst / Math.hypot(1, 1) * 100).toFixed(1)}%）  均值 = ${r.mean.toFixed(6)}`);
  console.log(`  偏差 > 1cm 的点：${r.over1cm} (${((r.over1cm / r.n) * 100).toFixed(2)}%)`);
  console.log(`  含偏差 > 1cm 的帧：${r.framesWithDiff} / ${r.frames}`);
  console.log(`  最大偏差处：t=${r.worstAt?.t} id=${r.worstAt?.id}`);
  // **跳过数与被比较数并列打印**——「N 点通过」必须带上「多少点没比」才有意义。
  console.log(
    `  跳过：非整秒帧 ${r.skipped.nonInteger} / 超 limitT ${r.skipped.overLimit} / `
    + `重放侧无该时刻 ${r.skipped.noReplay} / 单侧缺点 ${r.skipped.point}`,
  );
}
