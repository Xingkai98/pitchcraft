// 方案设计 agent（乙）探针 C：真实球队的「块」规律 + 越位线是否在真实数据里**起作用**
//
// 三个问题：
//   C1 真实球队的**线高度**如何随球位变化？拟合出「追踪增益」g（线随球的位移 / 球位移）。
//      引擎的 DEFENSE_PUSH_FACTOR=0.12 等价于 g=0.12。真实 g 是多少？
//   C2 真实的**队内形状**是不是近似刚体块（平移为主、拉伸为辅）？
//   C3 **越位线**是不是活的约束？即：真实进攻方的锋线是否被对方后防线**压住**？
//      检验：(a) 锋线 − 对方最后一名防守者 的分布是否紧贴 0（越位线在起作用）
//            (b) 我方锋线 与 对方防线高度 的相关性
//      若 (a) 显示锋线普遍**远低于**对方防线（差几十米），那越位在真实数据里**不是**
//      紧约束，我的方案就不该假装它是。
//
// 同时对照引擎，量化「谁被谁约束」。

import { readFileSync } from 'node:fs';
import {
  PITCH_LENGTH_M, BENCHMARK_SEEDS, ENGINE_DURATION_SEC, KEEPER_IDS,
  quantileSorted, sampleEngineFrames, cutWindows, teamShape,
} from '/home/happy/.claude/worktrees/wayfinder-realism/viewer/match-metrics.js';
import { loadEngineWasm, simulateStream, WASM_PATH } from '/home/happy/.claude/worktrees/wayfinder-realism/tools/benchmark-engine.mjs';

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const q = quantileSorted;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
function linreg(xs, ys) {
  const mx = mean(xs); const my = mean(ys);
  let sxy = 0; let sxx = 0;
  for (let i = 0; i < xs.length; i += 1) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const b = sxy / sxx;
  return { slope: b, intercept: my - b * mx, r: sxy / Math.sqrt(sxx * ys.reduce((s, v) => s + (v - my) ** 2, 0)) };
}

// 统一：把一个队的 10 名非门将按「离本方门线距离」升序排出 10 个 x（米）
function teamXsFrame(frame, team) {
  const isHome = team === 'home';
  const out = [];
  for (let id = 0; id < 22; id += 1) {
    if (KEEPER_IDS.includes(id)) continue;
    if ((id <= 10) !== isHome) continue;
    const p = frame.players[id];
    if (!p) continue;
    const x = Array.isArray(p) ? p[0] : p.x;
    if (!Number.isFinite(x)) continue;
    out.push(x * PITCH_LENGTH_M);
  }
  if (out.length < 7) return null;
  out.sort((a, b) => a - b);
  return isHome ? out : out.map((v) => PITCH_LENGTH_M - v).reverse(); // 客队镜像到「离本方门线」
}

// ── C1：线高度 vs 球位（两侧同口径）──────────────────────────────────
function lineGains(frames, label) {
  const ballU = []; const backU = []; const midU = []; const frontU = [];
  const ballUa = []; const backUa = []; const frontUa = [];
  for (const f of frames) {
    if (!f.ball || !Number.isFinite(f.ball[0])) continue;
    const h = teamXsFrame(f, 'home'); const a = teamXsFrame(f, 'away');
    if (h) {
      const bu = f.ball[0] * PITCH_LENGTH_M;
      ballU.push(bu); backU.push(mean(h.slice(0, 4))); midU.push(mean(h.slice(4, 8))); frontU.push(mean(h.slice(8, 10)));
    }
    if (a) {
      // 客队「离本方门线」的球位 = 1 - ball.x
      const bu = (1 - f.ball[0]) * PITCH_LENGTH_M;
      ballUa.push(bu); backUa.push(mean(a.slice(0, 4))); frontUa.push(mean(a.slice(8, 10)));
    }
  }
  const allBall = [...ballU, ...ballUa];
  const allBack = [...backU, ...backUa];
  const allFront = [...frontU, ...frontUa];
  const rb = linreg(allBall, allBack); const rf = linreg(allBall, allFront);
  console.log(`  ${label}`);
  console.log(`    防线高度 = ${rb.intercept.toFixed(1)} + ${rb.slope.toFixed(3)} × 球距本方门线   (r=${rb.r.toFixed(3)}, n=${allBall.length})`);
  console.log(`    锋线高度 = ${rf.intercept.toFixed(1)} + ${rf.slope.toFixed(3)} × 球距本方门线   (r=${rf.r.toFixed(3)})`);
  const rmh = linreg(ballU, midU);
  console.log(`    中场线高度 = ${rmh.intercept.toFixed(1)} + ${rmh.slope.toFixed(3)} × 球位 (r=${rmh.r.toFixed(3)}, 仅主队)`);
  return { back: rb, front: rf };
}

const load = await loadEngineWasm(WASM_PATH);
if (!load.ok) { console.error(load.message); process.exit(1); }
const { createGame } = await import('/home/happy/.claude/worktrees/wayfinder-realism/viewer/game.js');
const engineFrames = [];
for (const seed of BENCHMARK_SEEDS.slice(0, 3)) {
  const game = createGame(simulateStream(load.wasm, seed, ENGINE_DURATION_SEC));
  for (const w of cutWindows(sampleEngineFrames(game))) engineFrames.push(...w);
}
const realFrames = [];
for (const fn of ['1', '2']) {
  const g = JSON.parse(readFileSync(`/home/happy/.claude/worktrees/wayfinder-realism/viewer/data/real-game-${fn}.json`, 'utf8'));
  const frames = g.frames.map((fr) => ({ t: fr.t, ball: fr.ball || null, players: fr.players.map((p, id) => (p ? { id, x: p[0], y: p[1] } : null)) }));
  for (const w of cutWindows(frames)) realFrames.push(...w);
}

console.log('=== C1 线高度对球位的追踪增益（线性回归，斜率 = 追踪增益 g）===');
lineGains(realFrames, '真实 Metrica');
lineGains(engineFrames, '引擎');

// ── C2：平移 vs 拉伸 分解 ─────────────────────────────────────────
console.log('\n=== C2 队内形状：平移（块位移）vs 拉伸（块内跨度变化）===');
function translationStretch(frames, label) {
  const ball = []; const cen = []; const span = [];
  for (const f of frames) {
    if (!f.ball) continue;
    const h = teamXsFrame(f, 'home'); const a = teamXsFrame(f, 'away');
    for (const [xs, bu] of [[h, f.ball[0] * 105], [a, (1 - f.ball[0]) * 105]]) {
      if (!xs) continue;
      ball.push(bu); cen.push(mean(xs)); span.push(xs[9] - xs[0]);
    }
  }
  const rc = linreg(ball, cen);
  console.log(`  ${label}`);
  console.log(`    块中心 = ${rc.intercept.toFixed(1)} + ${rc.slope.toFixed(3)} × 球位  (r=${rc.r.toFixed(3)})  ⇒ 全队以 g=${rc.slope.toFixed(3)} 随球平移`);
  console.log(`    块内跨度（最深→最前，max-min）均值 ${mean(span).toFixed(1)}m  标准差 ${sd(span).toFixed(1)}m  [p10 ${q([...span].sort((a, b) => a - b), 0.1).toFixed(1)} – p90 ${q([...span].sort((a, b) => a - b), 0.9).toFixed(1)}]`);
  // 平移能解释多少跨度的方差？残差跨度 = span - 由块中心预测的 span
  const rs = linreg(cen, span);
  console.log(`    跨度 vs 块中心: 斜率 ${rs.slope.toFixed(3)} (r=${rs.r.toFixed(3)}) —— 越接近 0 越像刚体`);
}
translationStretch(realFrames, '真实 Metrica');
translationStretch(engineFrames, '引擎');

// ── C3：越位线是不是活的约束 ────────────────────────────────────────
console.log('\n=== C3 越位线：进攻方最前球员 vs 防守方最后一名非门将 ===');
function offsideTest(frames, label) {
  // 对每个「攻方」：攻方最深(最靠前)的球员离对方门线的距离 vs 守方最靠本方门线的球员
  // 统一到「离对方门线」的坐标 d ∈ [0,105]，d 越小越靠近对方球门。
  // 越位线 = 守方第 2 深的球员（离守方本方门线第 2 近）→ 转化为「离攻方所攻球门」的距离。
  const margins = []; const attFront = []; const defLine = [];
  for (const f of frames) {
    if (!f.ball) continue;
    const h = teamXsFrame(f, 'home'); const a = teamXsFrame(f, 'away');
    if (!h || !a) continue;
    // home 攻 → 攻方 home 的「离对方门线」= 105 - x；守方 away 的越位线 = away 第 2 深 = a[1]
    // away 坐标已镜像为「离 away 本方门线」，所以 away 第 2 深离 away 门线 = a[1]，
    // 换算成「离 home 所攻球门（x=105）」= 105 - a[1]
    const homeAtt = 105 - h[9]; const awayOffLine = 105 - a[1];
    margins.push(homeAtt - awayOffLine); attFront.push(homeAtt); defLine.push(awayOffLine);
    const awayAtt = 105 - a[9]; const homeOffLine = 105 - h[1];
    margins.push(awayAtt - homeOffLine);
  }
  const s = [...margins].sort((x, y) => x - y);
  console.log(`  ${label}`);
  console.log(`    最前球员「越线量」= 攻方最前 − 守方越位线（正 = 越位）。n=${margins.length}`);
  console.log(`    p5=${q(s, 0.05).toFixed(1)}  中位=${q(s, 0.5).toFixed(1)}  p95=${q(s, 0.95).toFixed(1)}  >0 占比=${(margins.filter((v) => v > 0).length / margins.length * 100).toFixed(1)}%`);
  console.log(`    锋线离对方门线 ${mean(attFront).toFixed(1)}m  守方越位线离该门线 ${mean(defLine).toFixed(1)}m  ⇒ 平均余量 ${mean(margins).toFixed(1)}m`);
  const rr = linreg(defLine, attFront);
  console.log(`    攻方锋线 vs 守方越位线 相关: 斜率 ${rr.slope.toFixed(3)} r=${rr.r.toFixed(3)}`);
}
offsideTest(realFrames, '真实 Metrica');
offsideTest(engineFrames, '引擎');

// ── C4：横向（宽度/重心间距）──────────────────────────────────────
console.log('\n=== C4 两队重心间距 与 宽度 ===');
function gapWidth(frames, label) {
  const gaps = []; const w = [];
  for (const f of frames) {
    const hs = teamShape(f, 'home'); const as = teamShape(f, 'away');
    if (!hs || !as) continue;
    gaps.push(Math.abs(hs.cx - as.cx));
    w.push(hs.width);
  }
  const s = [...gaps].sort((a, b) => a - b);
  console.log(`  ${label}: 重心 x 间距 均值 ${mean(gaps).toFixed(1)}m 中位 ${q(s, 0.5).toFixed(1)}  主队宽度 均值 ${mean(w).toFixed(1)}m`);
}
gapWidth(realFrames, '真实 Metrica');
gapWidth(engineFrames, '引擎');
