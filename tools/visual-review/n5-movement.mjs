// N5（2026-10-21）运动层只读诊断：轨迹几何 + 目标生成 + 层级消融。
//
// 定位：**只读分析工具**。输入是
//   1) `engine/examples/n5_dump.rs` 产出的 N5 tick JSON（sidecar，事件流不变）；
//   2) viewer 的真实 tracking 帧（Metrica / SkillCorner，逐场换算，不拼场）。
// 输出：逐窗指标 → 逐臂/逐真实数据集中位数 + IQR；目标来源/更新率/随球响应/18s 周期。
//
// 口径（2026-10-22 按独立审阅修正）：
//   - 引擎目标/消融 = native 1 Hz N5 sidecar；引擎轨迹 = wasm `sampleEngineFrames` 1 Hz/5 Hz。
//   - 真实 = **primary**（剔除 `p[2]===1` 外推点；队形帧要求两队各 ≥7 人）/ **allPoints** ×
//     1 Hz/5 Hz；逐场算窗，不拼场。
//   - 球指标只用原始球帧（`ballFill` 缺省）；补全/外推球置 null。
//   - 缺口 `dt>1.5 s` 分段；`gapStepFrac`/`ballGapFrac` 报告。
//   - 时间量（turn/actualDyFlip/ballDyFlip/straight/alignment）**只做同采样率比较**。
//   - 目标统计只取 phase0；wiggle 份额分 level / total-step / wiggle-only R² 三层。
//
// 用法：
//   node tools/visual-review/n5-movement.mjs --dumps <dir> --real <dir,file> \
//     [--wasm viewer/engine.wasm --engine-seeds 42,401,... --duration 300] --out <prefix>

import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

export const KEEPER_IDS = [0, 21];
export const OUTFIELD = [...Array(10).keys()].map((i) => i + 1).concat([...Array(10).keys()].map((i) => i + 11));
export const SAMPLE_DT = 1.0;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
export function quantile(sorted, p) {
  if (!sorted.length) return null;
  const h = (sorted.length - 1) * p;
  const i = Math.floor(h);
  if (i + 1 >= sorted.length) return sorted[sorted.length - 1];
  return sorted[i] + (h - i) * (sorted[i + 1] - sorted[i]);
}
export const median = (a) => quantile([...a].sort((x, y) => x - y), 0.5);
export const iqr = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return [quantile(s, 0.25), quantile(s, 0.75)];
};
const corr = (x, y) => {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  const mx = mean(x.slice(0, n)); const my = mean(y.slice(0, n));
  let sx = 0; let sy = 0; let sxy = 0;
  for (let i = 0; i < n; i += 1) { const a = x[i] - mx; const b = y[i] - my; sx += a * a; sy += b * b; sxy += a * b; }
  if (sx < 1e-12 || sy < 1e-12) return 0;
  return sxy / Math.sqrt(sx * sy);
};
const ols = (x, y) => {
  const n = Math.min(x.length, y.length);
  if (n < 3) return { slope: null, r2: null, n };
  const mx = mean(x.slice(0, n)); const my = mean(y.slice(0, n));
  let sxx = 0; let sxy = 0; let syy = 0;
  for (let i = 0; i < n; i += 1) { const a = x[i] - mx; const b = y[i] - my; sxx += a * a; sxy += a * b; syy += b * b; }
  if (sxx < 1e-12) return { slope: null, r2: null, n };
  const slope = sxy / sxx;
  return { slope, r2: syy < 1e-12 ? 0 : (sxy * sxy) / (sxx * syy), n };
};

// ── 单频最小二乘幅值：y = a·sin(2πt/T) + b·cos(2πt/T) + c ───────────────
export function sineAmp(ts, ys, period) {
  const n = Math.min(ts.length, ys.length);
  if (n < 20) return null;
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const w = (2 * Math.PI * ts[i]) / period;
    rows.push([Math.sin(w), Math.cos(w), 1]);
  }
  // 正规方程 3×3
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; const B = [0, 0, 0];
  for (let i = 0; i < n; i += 1) {
    for (let r = 0; r < 3; r += 1) {
      B[r] += rows[i][r] * ys[i];
      for (let c = 0; c < 3; c += 1) A[r][c] += rows[i][r] * rows[i][c];
    }
  }
  const det3 = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det3(A);
  if (Math.abs(D) < 1e-12) return null;
  const solve = (col) => {
    const M = A.map((row) => [...row]); for (let r = 0; r < 3; r += 1) M[r][col] = B[r];
    return det3(M) / D;
  };
  const a = solve(0); const b = solve(1);
  return Math.hypot(a, b);
}

// ── 引擎 N5 dump ─────────────────────────────────────────────────────────
// 输出统一帧：{ t, players: [{id,x,y}], ball:[x,y] }，供轨迹几何复用。
export function engineFramesFromDump(d) {
  return d.ticks.map((t) => ({
    t: t.t,
    players: OUTFIELD.map((id) => ({ id, x: t.p[id][0], y: t.p[id][1] })),
    ball: [t.bx, t.by],
    tick: t,
  }));
}

// ── 真实帧 ──────────────────────────────────────────────────────────────
// 真实帧 → 统一帧。
//   includeExtrapolated=false（primary）：剔除坐标第三位 === 1 的外推点；某队本帧
//     非门将不足 7 人时，trajectoryWindow 的队形指标按 `match-metrics.js` 同口径丢帧。
//   includeExtrapolated=true（allPoints）：采信外推点，作对照。
// ballRaw = 该帧球位是原始观测（`ballFill` 缺省）；球相关指标只在 ballRaw 且相邻帧
// 都是原始球位时计算（与 `isRawBallFrame` 同口径）。
export function realFramesFromJson(g, { downsampleHz = 1, includeExtrapolated = false } = {}) {
  const pm = g.meta && g.meta.pitchMeters;
  const pitch = Array.isArray(pm) ? pm : (pm && pm.length && pm.width ? [pm.length, pm.width] : [105, 68]);
  const isExtrap = (p) => Array.isArray(p) && p.length > 2 && p[2] === 1;
  const isRawBall = (f) => f.ballFill === undefined || f.ballFill === null;
  let frames = g.frames.map((f) => ({
    t: f.t,
    players: f.players.map((p, id) => (p && (includeExtrapolated || !isExtrap(p))
      ? { id, x: p[0], y: p[1], extrapolated: isExtrap(p) } : null)).filter(Boolean),
    ball: f.ball || null,
    ballRaw: isRawBall(f),
    ballFill: f.ballFill,
    pitchMeters: pitch,
  }));
  if (downsampleHz) {
    const step = 1 / downsampleHz;
    const t0 = Math.ceil(frames[0].t / step) * step;
    const out = [];
    let j = 0;
    for (let t = t0; t <= frames[frames.length - 1].t + 1e-9; t += step) {
      while (j + 1 < frames.length && frames[j + 1].t < t - 1e-9) j += 1;
      const a = frames[j]; const b = frames[Math.min(j + 1, frames.length - 1)];
      if (!a || Math.abs(a.t - t) > 0.35) continue;
      const pos = [];
      const mapB = new Map(b.players.map((p) => [p.id, p]));
      for (const p of a.players) {
        const q = mapB.get(p.id);
        if (!q) continue;
        const u = Math.abs(b.t - a.t) < 1e-9 ? 0 : (t - a.t) / (b.t - a.t);
        pos.push({ id: p.id, x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u, extrapolated: p.extrapolated || q.extrapolated });
      }
      // 球：只有两端都是原始观测才插值/采信；否则置 null（球指标跳过，不拿补全值对比）
      const raw = a.ballRaw && b.ballRaw && a.ball && b.ball;
      const uu = Math.abs(b.t - a.t) < 1e-9 ? 0 : (t - a.t) / (b.t - a.t);
      const bb = raw ? [a.ball[0] + (b.ball[0] - a.ball[0]) * uu, a.ball[1] + (b.ball[1] - a.ball[1]) * uu] : null;
      out.push({ t: Math.round(t * 1e6) / 1e6, players: pos, ball: bb, ballRaw: !!(raw), ballFill: a.ballFill, pitchMeters: pitch });
    }
    frames = out;
  }
  return { frames, pitchMeters: pitch, meta: g.meta || {} };
}

export function windowize(frames, winSec = 60) {
  if (!frames.length) return [];
  const wins = [];
  const t0 = Math.ceil(frames[0].t);
  const tEnd = frames[frames.length - 1].t;
  for (let s = t0; s + winSec <= tEnd + 2; s += winSec) {
    const w = frames.filter((f) => f.t >= s - 1e-6 && f.t <= s + winSec + 1e-6);
    if (w.length >= winSec * 0.8) wins.push({ t0: s, frames: w });
  }
  return wins;
}

// ── 轨迹几何（逐窗） ────────────────────────────────────────────────────
const DIR_BINS = 12;
function dirBin(dx, dy) {
  let a = Math.atan2(dy, dx); // -π..π
  if (a < 0) a += 2 * Math.PI;
  return Math.min(DIR_BINS - 1, Math.floor((a / (2 * Math.PI)) * DIR_BINS));
}
function entropy(counts) {
  const n = counts.reduce((a, b) => a + b, 0);
  if (!n) return null;
  let h = 0;
  for (const c of counts) if (c > 0) { const p = c / n; h -= p * Math.log(p); }
  return h / Math.log(DIR_BINS);
}

export function trajectoryWindow(frames) {
  const t0 = frames[0].t; const t1 = frames[frames.length - 1].t;
  const dt = (t1 - t0) / Math.max(1, frames.length - 1);
  const byId = new Map();
  for (const f of frames) for (const p of f.players) {
    if (KEEPER_IDS.includes(p.id)) continue;
    if (!byId.has(p.id)) byId.set(p.id, []);
    byId.get(p.id).push({ t: f.t, x: p.x, y: p.y });
  }
  const pm = frames[0].pitchMeters;
  const pitch = Array.isArray(pm) ? pm : (pm && pm.length && pm.width ? [pm.length, pm.width] : [105, 68]);
  const [L, W] = pitch;
  let sumDx = 0; let sumDy = 0; let path = 0;
  let gapSteps = 0; let validSteps = 0; let ballSteps = 0; let ballGapSteps = 0;
  // pooled 对照（旧预注册口径：所有球员的所有有效步一起算；不按球员先取中位）
  let poolSumDx = 0; let poolSumDy = 0; let poolSteps = 0; let poolStill = 0;
  let poolDyFlip = 0; let poolDyFlipN = 0;
  const GAP_SEC = 1.5;
  const straight = []; const turnAbs = []; const dirCounts = new Array(DIR_BINS).fill(0);
  const speedById = new Map();
  const ballDirCosW = []; const ballFollowByPlayer = []; const dyFlip = []; const ballDyFlipW = [];
  const yLag10 = []; const yCrossRate = []; const yRange = [];
  // 逐球员指标（先逐球员算，再取中位）——避免外推点稀疏的球员按步数加权主导 primary 口径。
  const pLat = []; const pStill05 = []; const pStill10 = []; const pTurn = []; const pTurn30s = [];
  let turnSumAll = 0; let turnNAll = 0; let turn30All = 0; let validPathAll = 0; let validPlayers = 0;
  const pTurnAnglesAll = [];
  const pPath = []; const pDisp = []; const pDirHist = []; const pDyFlips = []; const pSpeedBins = [[], [], [], [], []];
  const pBallDir = []; const pBallFollow = []; const pAutocorr = [];
  const MIN_STEPS = Math.max(10, Math.round(60 / Math.max(0.2, dt) * 0.50));
  const bmap = new Map(frames.filter((f) => f.ball && f.ballRaw !== false).map((f) => [f.t, f.ball]));
  for (const [id, arr] of byId) {
    let pSumDx = 0; let pSumDy = 0; let pPathLen = 0; let pTurnSum = 0; let pTurn30Cnt = 0;
    let pStepN = 0; let pDyFlipCnt = 0; let pDyFlipN = 0; let pTurnN = 0;
    const pSpeeds = []; const pDir = new Array(DIR_BINS).fill(0);
    const pBallDirId = []; const pBallSpeed = []; const pBallSpeedBall = [];
    let prevStep = null; let prevDy = 0;
    for (let i = 1; i < arr.length; i += 1) {
      const a = arr[i - 1]; const b = arr[i];
      const ddt = b.t - a.t;
      if (ddt <= 0) continue;
      if (ddt > GAP_SEC) { gapSteps += 1; prevStep = null; prevDy = 0; continue; }
      validSteps += 1;
      const dx = (b.x - a.x) * L; const dy = (b.y - a.y) * W;
      const d = Math.hypot(dx, dy); const v = d / ddt;
      pSumDx += Math.abs(dx); pSumDy += Math.abs(dy); pPathLen += d; pStepN += 1;
      poolSumDx += Math.abs(dx); poolSumDy += Math.abs(dy); poolSteps += 1;
      if (v < 0.5) poolStill += 1;
      pSpeeds.push(v);
      if (v > 0.5) {
        pDir[dirBin(dx, dy)] += 1;
        if (prevStep) {
          const c = (dx * prevStep.dx + dy * prevStep.dy) / (d * Math.hypot(prevStep.dx, prevStep.dy));
          const ang = Math.acos(Math.max(-1, Math.min(1, c)));
          pTurnSum += ang; pTurnN += 1; pTurnAnglesAll.push(ang); if (ang > Math.PI / 6) pTurn30Cnt += 1;
        }
        prevStep = { dx, dy };
      } else {
        prevStep = null;
      }
      // 实际 y 锯齿（缺口安全）
      if (Math.abs(dy) > 1e-9 && Math.abs(prevDy) > 1e-9) { pDyFlipN += 1; poolDyFlipN += 1; if (prevDy * dy < 0) { pDyFlipCnt += 1; poolDyFlip += 1; } }
      if (Math.abs(dy) > 1e-9) prevDy = dy;
      // 朝球方向/球速（只用原始球帧；按 m/s 阈值，不按每步米数——采样率无关）
      const bd = bmap.get(a.t);
      if (bd) {
        if (v > 0.5) {
          const tx = (bd[0] - a.x) * L; const ty = (bd[1] - a.y) * W;
          const td = Math.hypot(tx, ty);
          if (td > 0.5) pBallDirId.push((dx * tx + dy * ty) / (d * td));
        }
        const bd2 = bmap.get(b.t);
        if (bd2) { pBallSpeed.push(v); pBallSpeedBall.push(Math.hypot((bd2[0] - bd[0]) * L, (bd2[1] - bd[1]) * W) / ddt); }
      }
    }
    if (pStepN >= MIN_STEPS) {
      pLat.push(pSumDy / (pSumDx + pSumDy + 1e-9));
      pStill05.push(pSpeeds.filter((v) => v < 0.5).length / pStepN);
      pStill10.push(pSpeeds.filter((v) => v < 1.0).length / pStepN);
      pTurn.push(pPathLen > 1 ? (pTurnSum * 180 / Math.PI) * 100 / pPathLen : null);
      pTurn30s.push(pPathLen > 1 ? pTurn30Cnt * 100 / pPathLen : null);
      turnSumAll += pTurnSum; turnNAll += pTurnN; turn30All += pTurn30Cnt;
      validPathAll += pPathLen; validPlayers += 1;
      if (pPathLen > 1) {
        const a0 = arr[0]; const b0 = arr[arr.length - 1];
        straight.push(Math.hypot((b0.x - a0.x) * L, (b0.y - a0.y) * W) / pPathLen);
      }
      pPath.push(pPathLen);
      pDisp.push(Math.hypot((arr[arr.length - 1].x - arr[0].x) * L, (arr[arr.length - 1].y - arr[0].y) * W));
      const totDir = pDir.reduce((a, b) => a + b, 0);
      if (totDir) pDirHist.push(pDir.map((v) => v / totDir));
      if (pDyFlipN) pDyFlips.push(pDyFlipCnt / pDyFlipN);
      for (let bi = 0; bi < 5; bi += 1) {
        const lo = [0, 0.5, 2, 4, 6][bi]; const hi = bi < 4 ? [0.5, 2, 4, 6][bi + 1] : Infinity;
        pSpeedBins[bi].push(pSpeeds.filter((v) => v >= lo && v < hi).length / pStepN);
      }
      if (pBallDirId.length) pBallDir.push(median(pBallDirId));
      if (pBallSpeed.length >= 10) { const c = corr(pBallSpeed, pBallSpeedBall); if (c != null) pBallFollow.push(c); }
      if (pSpeeds.length >= 10) { const c = corr(pSpeeds.slice(0, -1), pSpeeds.slice(1)); if (c != null) pAutocorr.push(c); }
    }
    // 车道持续性/幅度（按时间找点，缺口安全）
    const yv = arr.map((z) => z.y);
    if (yv.length > 15) {
      const a10 = []; const b10 = [];
      const yAt = new Map(arr.map((z) => [Math.round(z.t * 10) / 10, z.y]));
      for (const z of arr) {
        const w = yAt.get(Math.round((z.t + 10) * 10) / 10);
        if (w != null) { a10.push(z.y); b10.push(w); }
      }
      const cc = corr(a10, b10); if (cc != null) yLag10.push(cc);
      yRange.push((quantile([...yv].sort((x, y) => x - y), 0.9) - quantile([...yv].sort((x, y) => x - y), 0.1)) * W);
    }
    if (pStepN >= MIN_STEPS) speedById.set(id, pSpeeds);
  }
  // 汇总逐球员指标（中位）
  const lat = median(pLat);
  const still05 = median(pStill05);
  const still10 = median(pStill10);
  const bins = pSpeedBins.map((xs) => median(xs));
  const ac = pAutocorr;
  const dirHist = pDirHist.length ? pDirHist[0].map((_, i) => mean(pDirHist.map((h) => h[i]))) : new Array(DIR_BINS).fill(0);
  const dirEntropy = entropy(dirHist);
  const pathPerPlayer = median(pPath);
  const dispPerPlayer = median(pDisp);
  // 转角沿用原 pooled 口径（sum/路径），只累计有效球员；与 review 5 Hz 读数同口径。
  const pathPerValidPlayer = validPlayers ? validPathAll / validPlayers : null;
  const turnDegPer100mVal = (turnNAll && pathPerValidPlayer) ? (turnSumAll / turnNAll) * 180 / Math.PI * 100 / pathPerValidPlayer : null;
  const turns30Per100mVal = pathPerValidPlayer ? turn30All * 100 / pathPerValidPlayer : null;
  const turnMedianDeg = turnNAll ? median(pTurnAnglesAll) * 180 / Math.PI : null;
  const actualDyFlipVal = median(pDyFlips);
  const ballDirCosVal = median(pBallDir);
  const ballFollowCorrVal = median(pBallFollow);
  // 球 y 锯齿（逐窗；只用原始球帧，缺口安全）
  // 球 y 锯齿（逐窗；只用原始球帧，缺口安全）
  let prevB = null;
  for (const f of frames) {
    if (!f.ball || f.ballRaw === false) { prevB = null; continue; }
    if (prevB) {
      if (f.t - prevB[3] > GAP_SEC) { prevB = null; }
      else {
        ballSteps += 1;
        const dy = f.ball[1] - prevB[1];
        if (Math.abs(dy) > 1e-9 && Math.abs(prevB[2]) > 1e-9) ballDyFlipW.push(prevB[2] * dy < 0 ? 1 : 0);
        if (Math.abs(dy) > 1e-9) prevB = [f.ball[0], f.ball[1], dy, f.t];
      }
    }
    if (!prevB) prevB = [f.ball[0], f.ball[1], 0, f.t];
  }
  // 统计球帧缺口：原始球帧相邻间隔 >1.5s
  {
    let last = null;
    for (const f of frames) {
      if (!f.ball || f.ballRaw === false) continue;
      if (last != null && f.t - last > GAP_SEC) ballGapSteps += 1;
      last = f.t;
    }
  }
  // 队形/对齐/车道（逐帧先算）
  const widths = []; const depths = []; const hds = []; const ads = []; const spacings = []; const align = []; const blockT = [];
  const alignNet = []; const alignFast = [];
  const yCorr = []; const laneSd = []; const latSd = []; const mixing = [];
  const teamY = new Map(); // team -> Map(id -> [{t,y}])
  const centroid = new Map(); // t -> {0:{x,y},1:{x,y}}
  const framesNext = frames.map((f, i) => ({ ...f, _next: frames[i + 1] || null }));
  for (const f of framesNext) {
    const ps = f.players.filter((p) => !KEEPER_IDS.includes(p.id));
    // 与 match-metrics 同口径：两队都需 ≥7 名有效外场，否则整帧不参与队形指标。
    const homePs = ps.filter((p) => p.id <= 10); const awayPs = ps.filter((p) => p.id >= 11);
    if (homePs.length < 7 || awayPs.length < 7) { /* skip frame shape */ } else
    for (const team of [0, 1]) {
      const tp = team === 0 ? homePs : awayPs;
      const ys = tp.map((p) => p.y * W); const xs = tp.map((p) => p.x * L);
      if (!centroid.has(f.t)) centroid.set(f.t, {});
      centroid.get(f.t)[team] = { x: mean(xs), y: mean(ys) };
      widths.push(Math.max(...ys) - Math.min(...ys));
      const sx = [...xs].sort((a, b) => a - b);
      const dep = quantile(sx, 0.9) - quantile(sx, 0.1);
      depths.push(dep); (team === 0 ? hds : ads).push(dep);
      let nn = 0;
      for (const p of tp) {
        let best = Infinity;
        for (const q of tp) if (q.id !== p.id) {
          const d = Math.hypot((p.x - q.x) * L, (p.y - q.y) * W);
          if (d < best) best = d;
        }
        if (Number.isFinite(best)) nn += best;
      }
      spacings.push(nn / tp.length);
      const my = mean(ys); latSd.push(Math.sqrt(mean(ys.map((y) => (y - my) ** 2))));
      if (!teamY.has(team)) teamY.set(team, new Map());
      for (const p of tp) {
        if (!teamY.get(team).has(p.id)) teamY.get(team).set(p.id, []);
        teamY.get(team).get(p.id).push({ t: f.t, y: p.y * W });
      }
    }
    // 速度对齐：用相邻帧位移（以本帧为起点，若存在）
    if (f._next) {
      const v = new Map(); const vFast = new Map();
      const ddt = f._next.t - f.t;
      if (ddt > GAP_SEC) { /* 缺口：不跨帧对齐 */ } else
      for (const p of f.players) {
        if (KEEPER_IDS.includes(p.id)) continue;
        const q = f._next.players.find((z) => z.id === p.id);
        if (!q) continue;
        const d = Math.hypot((q.x - p.x) * L, (q.y - p.y) * W);
        // 阈值按 m/s（采样率无关），不是每步米数
        if (d / ddt > 0.5) v.set(p.id, [(q.x - p.x) * L, (q.y - p.y) * W, d]);
        if (d > 0.5) vFast.set(p.id, [(q.x - p.x) * L, (q.y - p.y) * W, d]);
      }
      for (const team of [0, 1]) {
        const vs = [...v.entries()].filter(([id]) => (team === 0 ? id <= 10 : id >= 11));
        if (vs.length < 3) continue;
        let s = 0; let n = 0;
        for (let i = 0; i < vs.length; i += 1) for (let j = i + 1; j < vs.length; j += 1) {
          const a = vs[i][1]; const b = vs[j][1];
          s += (a[0] * b[0] + a[1] * b[1]) / (a[2] * b[2]); n += 1;
        }
        if (n) align.push(s / n);
        const mvx = mean(vs.map((z) => z[1][0])); const mvy = mean(vs.map((z) => z[1][1]));
        blockT.push(Math.hypot(mvx, mvy) / (mean(vs.map((z) => z[1][2])) + 1e-9));
        // 旧口径（每步 >0.5 m；采样率相关，只用于与 review 5 Hz 读数对照）
        const vf = [...vFast.entries()].filter(([id]) => (team === 0 ? id <= 10 : id >= 11));
        if (vf.length >= 3) {
          let s2 = 0; let n2 = 0;
          for (let ii = 0; ii < vf.length; ii += 1) for (let jj = ii + 1; jj < vf.length; jj += 1) {
            const a = vf[ii][1]; const b = vf[jj][1];
            s2 += (a[0] * b[0] + a[1] * b[1]) / (a[2] * b[2]); n2 += 1;
          }
          if (n2) alignFast.push(s2 / n2);
        }
      }
    }
    // 混队度
    let opp = 0; let tot = 0;
    for (const p of ps) {
      let best = Infinity; let bid = -1;
      for (const q of ps) if (q.id !== p.id) {
        const d = Math.hypot((p.x - q.x) * L, (p.y - q.y) * W);
        if (d < best) { best = d; bid = q.id; }
      }
      if (bid >= 0) { if ((p.id <= 10) !== (bid <= 10)) opp += 1; tot += 1; }
    }
    if (tot) mixing.push(opp / tot);
  }
  // 窗口净位移方向对齐（pairwise cosine；与 motion-metrics 的 dir 同口径）
  for (const team of [0, 1]) {
    const vs = [];
    for (const [id, arr] of byId) {
      if (team === 0 ? id > 10 : id < 11) continue;
      if (arr.length < 2) continue;
      const dx = (arr[arr.length - 1].x - arr[0].x) * L;
      const dy = (arr[arr.length - 1].y - arr[0].y) * W;
      const d = Math.hypot(dx, dy);
      if (d > 0.5) vs.push([dx / d, dy / d]);
    }
    if (vs.length >= 3) {
      let sum = 0; let n = 0;
      for (let i = 0; i < vs.length; i += 1) for (let j = i + 1; j < vs.length; j += 1) {
        sum += vs[i][0] * vs[j][0] + vs[i][1] * vs[j][1]; n += 1;
      }
      if (n) alignNet.push(sum / n);
    }
  }
  const centroidGap = []; const centroidXGap = [];
  for (const c of centroid.values()) {
    if (c[0] && c[1]) {
      centroidGap.push(Math.hypot(c[0].x - c[1].x, c[0].y - c[1].y));
      centroidXGap.push(Math.abs(c[0].x - c[1].x));
    }
  }
  // 车道固定度 + y 同步相关（逐队）
  for (const team of [0, 1]) {
    const m = teamY.get(team);
    if (!m) continue;
    const ids = [...m.keys()];
    const pairs = [];
    for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) {
      const a = new Map(m.get(ids[i]).map((z) => [z.t, z.y]));
      const b = new Map(m.get(ids[j]).map((z) => [z.t, z.y]));
      const d = [];
      for (const [t, y] of a) if (b.has(t)) d.push(y - b.get(t));
      if (d.length > 10) pairs.push(Math.sqrt(mean(d.map((x) => (x - mean(d)) ** 2))));
    }
    if (pairs.length) laneSd.push(median(pairs));
    // 两两 y 相关（时间序列）
    const cs = [];
    for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) {
      const a = new Map(m.get(ids[i]).map((z) => [z.t, z.y]));
      const b = new Map(m.get(ids[j]).map((z) => [z.t, z.y]));
      const xs = []; const ys = [];
      for (const [t, y] of a) if (b.has(t)) { xs.push(y); ys.push(b.get(t)); }
      const c = corr(xs, ys); if (c != null) cs.push(c);
    }
    if (cs.length) yCorr.push(mean(cs));
    // 相对队均 y 的穿越率（每球员每窗）
    const times = new Set();
    const yMaps = new Map(ids.map((id) => [id, new Map(m.get(id).map((z) => [z.t, z.y]))]));
    for (const id of ids) for (const z of m.get(id)) times.add(z.t);
    const meanAt = new Map();
    for (const t of times) {
      const vals = [];
      for (const id of ids) { const y = yMaps.get(id).get(t); if (y != null) vals.push(y); }
      if (vals.length) meanAt.set(t, mean(vals));
    }
    for (const id of ids) {
      const seq = m.get(id);
      let prev = 0; let cross = 0; let n = 0;
      for (const z of seq) {
        const mu = meanAt.get(z.t); if (mu == null) continue;
        const d = z.y - mu;
        if (Math.abs(d) > 1e-9 && Math.abs(prev) > 1e-9) { if (prev * d < 0) cross += 1; n += 1; }
        if (Math.abs(d) > 1e-9) prev = d;
      }
      if (n) yCrossRate.push(cross / n);
    }
  }
  return {
    dt,
    gapStepFrac: validSteps + gapSteps > 0 ? gapSteps / (validSteps + gapSteps) : null,
    ballGapFrac: ballSteps + ballGapSteps > 0 ? ballGapSteps / (ballSteps + ballGapSteps) : null,
    lat,
    latPooled: poolSumDx + poolSumDy > 0 ? poolSumDy / (poolSumDx + poolSumDy) : null,
    still05Pooled: poolSteps ? poolStill / poolSteps : null,
    actualDyFlipPooled: poolDyFlipN ? poolDyFlip / poolDyFlipN : null,
    straight: median(straight),
    pathPerPlayer,
    dispPerPlayer,
    turnDegPer100m: turnDegPer100mVal,
    turns30Per100m: turns30Per100mVal,
    turnMedianDeg,
    dirEntropy,
    dirCounts,
    still05,
    still10,
    speedBins: bins,
    speedAutocorr: median(ac),
    width: median(widths),
    depth: median(depths),
    hd: median(hds),
    ad: median(ads),
    spacing: median(spacings),
    alignment: median(alignNet),
    alignmentFrame: median(align),
    alignmentStep: median(alignFast),
    blockTranslation: median(blockT),
    lateralSd: median(latSd),
    laneSd: median(laneSd),
    yCorr: median(yCorr),
    mixing: median(mixing),
    centroidGap: median(centroidGap),
    centroidXGap: median(centroidXGap),
    ballDirCos: ballDirCosVal,
    ballFollowCorr: ballFollowCorrVal,
    actualDyFlip: actualDyFlipVal,
    ballDyFlip: mean(ballDyFlipW),
    yLag10: median(yLag10),
    yCrossRate: median(yCrossRate),
    yRange: median(yRange),
    nPlayers: byId.size,
  };
}

// ── 目标生成（引擎 dump） ───────────────────────────────────────────────
const ACTION = ['run', 'mark', 'close_down', 'chase', 'keeper', 'other'];
function roleLine(id) {
  const rel = id <= 10 ? id : id - 10; // 1..10
  if (rel <= 4) return 'back';
  if (rel <= 8) return 'mid';
  return 'fwd';
}

export function targetMetrics(d) {
  const ticks = d.ticks;
  const [L, W] = [105, 68];
  const act = new Array(6).fill(0);
  const actByLine = { back: new Array(6).fill(0), mid: new Array(6).fill(0), fwd: new Array(6).fill(0) };
  const upd05 = []; const upd10 = []; const tgtStep = []; const tgtDyShare = [];
  const srcStep = []; const srcUpd = []; const srcDyShare = [];
  const tgtJump = []; const tgtDyFlip = []; const actDyFlip = []; const ballDyFlip = [];
  const syncJumpShare = []; const syncJumpReset = []; const syncJumpNonReset = [];
  const resetTyJump = []; const nonResetTyJump = []; const resetAyJump = []; const nonResetAyJump = [];
  let phaseResetTicks = 0; let phaseTickN = 0;
  const alignCos = []; const staticByDist = { '<0.5': [0, 0], '0.5-1': [0, 0], '1-2': [0, 0], '>2': [0, 0] };
  const slopeX = []; const slopeY = []; const r2X = []; const r2Y = [];
  const slopeYAll = []; const r2YAll = [];
  const lagY = { 0: [], 1: [], 2: [] };
  const amp18Target = []; const amp18Actual = []; const amp90Target = [];
  const commonY = []; const commonX = [];
  const ballDirCos = []; const ballFollowCorr = [];
  const velVsDispCorr = []; const velStaleFrac = [];
  const wiggleShare = []; const wiggleCorr = []; const wiggleVar = []; const targetYVar = [];
  const runWigBeta = []; const runWigR2 = []; const runWigOnlyR2 = []; const runWigVarShare = []; const runBallVarShare = [];
  const runStepY = []; const runStepWig = []; const runUpdate05 = []; const runDyShare = [];
  const runActualWigBeta = []; const runActualWigR2 = [];
  const runStepPairs = []; const runWigStepShare = [];
  // 逐球员序列
  const series = new Map(); // id -> [{t,tx,ty,x,y,bx,by}]
  for (const t of ticks) {
    // 目标统计只取 phase0（开放局）且本拍目标新鲜——预注册口径；死球/重开/高亮/
    // 射门推进的 targets 可能是上一拍残留。
    if (!t.fresh || t.phase !== 0) continue;
    for (const id of OUTFIELD) {
      if (id === t.carrier) continue;
      const p = t.p[id];
      if (!p[8]) continue;
      const a = p[6];
      act[a] += 1; actByLine[roleLine(id)][a] += 1;
      if (!series.has(id)) series.set(id, []);
      series.get(id).push({ t: t.t, tx: p[4], ty: p[5], x: p[0], y: p[1], vx: p[2], vy: p[3], bx: t.bx, by: t.by, a, phase: t.phase, phase_s: t.phase_s });
    }
  }
  for (const [id, arr] of series) {
    for (let i = 1; i < arr.length; i += 1) {
      const a = arr[i - 1]; const b = arr[i];
      const dt = b.t - a.t; if (dt <= 0 || dt > 1.5) continue;
      const dx = (b.tx - a.tx) * L; const dy = (b.ty - a.ty) * W;
      const step = Math.hypot(dx, dy);
      tgtStep.push(step);
      upd05.push(step > 0.5 ? 1 : 0); upd10.push(step > 1.0 ? 1 : 0);
      tgtDyShare.push(step > 1e-6 ? Math.abs(dy) / (Math.abs(dx) + Math.abs(dy)) : null);
      tgtJump.push(step);
      // 实际下一步位移 vs 目标方向
      const adx = (b.x - a.x) * L; const ady = (b.y - a.y) * W;
      const asp = Math.hypot(adx, ady) / dt;
      if (asp > 0.5) {
        const tdx = (a.tx - a.x) * L; const tdy = (a.ty - a.y) * W;
        const td = Math.hypot(tdx, tdy);
        if (td > 0.1) alignCos.push((adx * tdx + ady * tdy) / (Math.hypot(adx, ady) * td));
      }
      // 静止条件：用 a 时刻到目标距离分箱，看下一 step 是否静止
      const tdist = Math.hypot((a.tx - a.x) * L, (a.ty - a.y) * W);
      const key = tdist < 0.5 ? '<0.5' : tdist < 1 ? '0.5-1' : tdist < 2 ? '1-2' : '>2';
      staticByDist[key][1] += 1; if (asp < 0.5) staticByDist[key][0] += 1;
      // 随球响应
      const bdx = (b.bx - a.bx) * L; const bdy = (b.by - a.by) * W;
    }
    // OLS 斜率（逐球员；预注册口径：只用球移动 >0.5 m 的相邻 tick）
    const bxF = []; const byF = []; const txF = []; const tyF = [];
    const bxA = []; const byA = []; const txA = []; const tyA = [];
    for (let i = 1; i < arr.length; i += 1) {
      if (arr[i].t - arr[i - 1].t > 1.5) continue;
      const bdx = (arr[i].bx - arr[i - 1].bx) * L;
      const bdy = (arr[i].by - arr[i - 1].by) * W;
      const tdx = (arr[i].tx - arr[i - 1].tx) * L;
      const tdy = (arr[i].ty - arr[i - 1].ty) * W;
      bxA.push(bdx); byA.push(bdy); txA.push(tdx); tyA.push(tdy);
      if (Math.hypot(bdx, bdy) > 0.5) { bxF.push(bdx); byF.push(bdy); txF.push(tdx); tyF.push(tdy); }
    }
    if (txF.length >= 20) { const o = ols(bxF, txF); if (o.slope != null) { slopeX.push(o.slope); r2X.push(o.r2); } }
    if (tyF.length >= 20) { const o = ols(byF, tyF); if (o.slope != null) { slopeY.push(o.slope); r2Y.push(o.r2); } }
    if (tyA.length >= 20) { const o = ols(byA, tyA); if (o.slope != null) { slopeYAll.push(o.slope); r2YAll.push(o.r2); } }
    // 目标源更新（去掉球跟随分量）：逐球员对 target x/y 关于球 x/y 做 OLS，
    // 取残差的步长/更新。旧路径的目标是球位的确定性函数 ⇒ 残差接近 0；
    // C2 的 keyframe+wiggle 是独立于球的目标源 ⇒ 残差保留 2 m/tick 量级。
    if (arr.length >= 20) {
      const bxv = arr.map((z) => z.bx * L); const byv = arr.map((z) => z.by * W);
      const txv = arr.map((z) => z.tx * L); const tyv = arr.map((z) => z.ty * W);
      const oy = ols(byv, tyv); const ox = ols(bxv, txv);
      if (oy.slope != null && ox.slope != null) {
        const ry = tyv.map((v, i) => v - (oy.slope * byv[i] + (mean(tyv) - oy.slope * mean(byv))));
        const rx = txv.map((v, i) => v - (ox.slope * bxv[i] + (mean(txv) - ox.slope * mean(bxv))));
        for (let i = 1; i < arr.length; i += 1) {
          if (arr[i].t - arr[i - 1].t > 1.5) continue;
          const ddx = rx[i] - rx[i - 1]; const ddy = ry[i] - ry[i - 1];
          const ds = Math.hypot(ddx, ddy);
          srcStep.push(ds); srcUpd.push(ds > 0.5 ? 1 : 0);
          srcDyShare.push(Math.abs(ddy) / (Math.abs(ddx) + Math.abs(ddy) + 1e-9));
        }
      }
    }
    // 滞后相关（Δtarget.y vs Δball.y）
    for (const lag of [0, 1, 2]) {
      const xs = []; const ys = [];
      for (let i = lag; i < arr.length; i += 1) {
        const j = i - lag; if (j < 1) continue;
        xs.push((arr[j].by - arr[j - 1].by) * W);
        ys.push((arr[i].ty - arr[i - 1].ty) * W);
      }
      const c = corr(xs, ys); if (c != null) lagY[lag].push(c);
    }
    // 18s / 90s 周期
    const ts = arr.map((z) => z.t); const tys = arr.map((z) => z.ty * W); const ays = arr.map((z) => z.y * W);
    const a18 = sineAmp(ts, tys, 18); if (a18 != null) amp18Target.push(a18);
    const b18 = sineAmp(ts, ays, 18); if (b18 != null) amp18Actual.push(b18);
    const a90 = sineAmp(ts, tys, 90); if (a90 != null) amp90Target.push(a90);
    // C2 确定性 wiggle：wiggle = 0.11·sin(2π·phase_s/18 + id·1.7)，米制 = ×68
    const wig = arr.map((z) => 0.11 * Math.sin((2 * Math.PI * z.phase_s) / 18 + id * 1.7) * W);
    const mv = mean(tys); const mw = mean(wig);
    const vTy = mean(tys.map((v) => (v - mv) ** 2));
    const vW = mean(wig.map((v) => (v - mw) ** 2));
    if (vTy > 1e-9) { wiggleShare.push(vW / vTy); wiggleVar.push(vW); targetYVar.push(vTy); }
    const cw = corr(tys, wig); if (cw != null) wiggleCorr.push(cw);
    // 球向运动：实际速度与「指向球」的夹角
    for (let i = 1; i < arr.length; i += 1) {
      const a = arr[i - 1]; const b = arr[i];
      const adx = (b.x - a.x) * L; const ady = (b.y - a.y) * W;
      const asp = Math.hypot(adx, ady); if (asp < 0.5) continue;
      const tdx = (a.bx - a.x) * L; const tdy = (a.by - a.y) * W;
      const td = Math.hypot(tdx, tdy); if (td < 0.5) continue;
      ballDirCos.push((adx * tdx + ady * tdy) / (asp * td));
    }
    // 球员速度 vs 球速相关
    if (arr.length > 10) {
      const ps = []; const bs = [];
      for (let i = 1; i < arr.length; i += 1) {
        ps.push(Math.hypot((arr[i].x - arr[i - 1].x) * L, (arr[i].y - arr[i - 1].y) * W));
        bs.push(Math.hypot((arr[i].bx - arr[i - 1].bx) * L, (arr[i].by - arr[i - 1].by) * W));
      }
      const c = corr(ps, bs); if (c != null) ballFollowCorr.push(c);
    }
    // C1 速度状态是否与真实位移一致（诊断「刷新只在非 main 路径」）
    const rv = []; const dv = [];
    let stale = 0; let staleN = 0;
    for (let i = 1; i < arr.length; i += 1) {
      if (arr[i].phase !== 0 || arr[i - 1].phase !== 0) continue;
      const disp = Math.hypot((arr[i].x - arr[i - 1].x) * L, (arr[i].y - arr[i - 1].y) * W);
      // n5 探针记录的是本拍终态的 st.vel；与 arr[i]-arr[i-1] 位移同拍比较时用 arr[i].vx
      const v = Math.hypot(arr[i].vx, arr[i].vy);
      const vPrev = Math.hypot(arr[i - 1].vx, arr[i - 1].vy);
      rv.push(v); dv.push(disp);
      staleN += 1;
      if (Math.abs(v - vPrev) < 1e-6 && disp > 0.5) stale += 1;
    }
    if (rv.length >= 10) { const c = corr(rv, dv); if (c != null) velVsDispCorr.push(c); }
    if (staleN) velStaleFrac.push(stale / staleN);
  }
  // 目标 y 锯齿 / 同步跳变 / 实际与球的锯齿
  for (const [id, arr] of series) {
    for (let i = 2; i < arr.length; i += 1) {
      if (arr[i].t - arr[i - 1].t > 1.5) continue;
      const dy1 = arr[i - 1].ty - arr[i - 2].ty;
      const dy2 = arr[i].ty - arr[i - 1].ty;
      if (Math.abs(dy1) > 1e-6 && Math.abs(dy2) > 1e-6) tgtDyFlip.push(dy1 * dy2 < 0 ? 1 : 0);
      const ay1 = arr[i - 1].y - arr[i - 2].y;
      const ay2 = arr[i].y - arr[i - 1].y;
      if (Math.abs(ay1) > 1e-6 && Math.abs(ay2) > 1e-6) actDyFlip.push(ay1 * ay2 < 0 ? 1 : 0);
      const by1 = arr[i - 1].by - arr[i - 2].by;
      const by2 = arr[i].by - arr[i - 1].by;
      if (Math.abs(by1) > 1e-6 && Math.abs(by2) > 1e-6) ballDyFlip.push(by1 * by2 < 0 ? 1 : 0);
    }
  }
  // 同步跳变：同一 tick 上多名球员目标 y 大幅变化（相位重置的签名）
  for (let i = 1; i < ticks.length; i += 1) {
    const a = ticks[i - 1]; const b = ticks[i];
    if (!a.fresh || !b.fresh || b.t - a.t > 1.5) continue;
    let nJ = 0; let n = 0;
    for (const id of OUTFIELD) {
      if (id === a.carrier || id === b.carrier) continue;
      if (!a.p[id][8] || !b.p[id][8]) continue;
      n += 1;
      if (Math.abs(b.p[id][5] - a.p[id][5]) * W > 2.0) nJ += 1;
    }
    if (n >= 10) syncJumpShare.push(nJ / n);
  }
  const q = (a, p) => quantile([...a].sort((x, y) => x - y), p);
  // run-only：C2 wiggle 对目标 y（及其步长）的解释力。只取 action=0、非重置的相邻拍。
  for (const [id, arr] of series) {
    const run = arr.filter((z) => z.a === 0);
    const sign = id <= 10 ? 1 : -1;
    const wigOf = (ps) => sign * 0.11 * Math.sin((2 * Math.PI * ps) / 18 + id * 1.7);
    const dty = []; const dwig = []; const dby = [];
    for (let i = 1; i < run.length; i += 1) {
      if (run[i].t - run[i - 1].t > 1.5) continue;
      if (run[i].phase_s < run[i - 1].phase_s - 1e-9) continue;
      const dy = (run[i].ty - run[i - 1].ty) * W;
      const dw = (wigOf(run[i].phase_s) - wigOf(run[i - 1].phase_s)) * W;
      const db = (run[i].by - run[i - 1].by) * W;
      dty.push(dy); dwig.push(dw); dby.push(db);
      runStepY.push(Math.abs(dy)); runStepWig.push(Math.abs(dw));
      runUpdate05.push(Math.abs(dy) > 0.5 ? 1 : 0);
      runDyShare.push(Math.abs(dy) / (Math.abs(dy) + Math.abs((run[i].tx - run[i - 1].tx) * L) + 1e-9));
      runStepPairs.push([dw, dy]);
    }
    if (dty.length >= 20) {
      const X = dty.map((_, i) => [dwig[i], dby[i], 1]);
      // OLS 三元
      const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; const B = [0, 0, 0];
      for (let i = 0; i < X.length; i += 1) for (let r = 0; r < 3; r += 1) {
        B[r] += X[i][r] * dty[i];
        for (let c = 0; c < 3; c += 1) A[r][c] += X[i][r] * X[i][c];
      }
      const det3 = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
      const D = det3(A);
      if (Math.abs(D) > 1e-12) {
        const sol = (col) => { const M = A.map((row) => [...row]); for (let r = 0; r < 3; r += 1) M[r][col] = B[r]; return det3(M) / D; };
        const bw = sol(0); const bb = sol(1); const c0 = sol(2);
        { const o = ols(dwig, dty); if (o.r2 != null) runWigOnlyR2.push(o.r2); }
        // 实际 y 步长对同一组回归量的拟合（看球员跟不跟 wiggle）
        const ay = []; const aw = []; const ab = [];
        for (let i = 1; i < run.length; i += 1) {
          if (run[i].t - run[i - 1].t > 1.5) continue;
          if (run[i].phase_s < run[i - 1].phase_s - 1e-9) continue;
          ay.push((run[i].y - run[i - 1].y) * W);
          aw.push((wigOf(run[i].phase_s) - wigOf(run[i - 1].phase_s)) * W);
          ab.push((run[i].by - run[i - 1].by) * W);
        }
        if (ay.length >= 20) {
          const X2 = ay.map((_, i) => [aw[i], ab[i], 1]);
          const A2 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; const B2 = [0, 0, 0];
          for (let i = 0; i < X2.length; i += 1) for (let r = 0; r < 3; r += 1) {
            B2[r] += X2[i][r] * ay[i];
            for (let c = 0; c < 3; c += 1) A2[r][c] += X2[i][r] * X2[i][c];
          }
          const D2 = det3(A2);
          if (Math.abs(D2) > 1e-12) {
            const s2 = (col) => { const M = A2.map((row) => [...row]); for (let r = 0; r < 3; r += 1) M[r][col] = B2[r]; return det3(M) / D2; };
            const b2 = s2(0); const b3 = s2(1); const c2 = s2(2);
            const pred2 = ay.map((_, i) => b2 * aw[i] + b3 * ab[i] + c2);
            const my2 = mean(ay);
            const r22 = 1 - ay.reduce((s, v, i) => s + (v - pred2[i]) ** 2, 0) / ay.reduce((s, v) => s + (v - my2) ** 2, 0);
            runActualWigBeta.push(b2); runActualWigR2.push(r22);
          }
        }
        const pred = dty.map((_, i) => bw * dwig[i] + bb * dby[i] + c0);
        const my = mean(dty);
        const r2 = 1 - dty.reduce((s, v, i) => s + (v - pred[i]) ** 2, 0) / dty.reduce((s, v) => s + (v - my) ** 2, 0);
        runWigBeta.push(bw); runWigR2.push(r2);
        const vw = mean(dwig.map((v) => (bw * v) ** 2));
        const vb = mean(dby.map((v) => (bb * v) ** 2));
        if (vw + vb > 1e-9) { runWigVarShare.push(vw / (vw + vb)); runBallVarShare.push(vb / (vw + vb)); }
      }
    }
  }
  // run wiggle 的**总步长方差占比**：var(Δwiggle) / var(Δtarget.y)（逐球员，phase0/run/non-reset）
  {
    // 按球员分组（runStepPairs 是全局池，这里重算逐球员）
    for (const [id, arr] of series) {
      const run = arr.filter((z) => z.a === 0);
      const sign = id <= 10 ? 1 : -1;
      const wigOf = (ps) => sign * 0.11 * Math.sin((2 * Math.PI * ps) / 18 + id * 1.7);
      const dw = []; const dt = [];
      for (let i = 1; i < run.length; i += 1) {
        if (run[i].t - run[i - 1].t > 1.5) continue;
        if (run[i].phase_s < run[i - 1].phase_s - 1e-9) continue;
        dw.push((wigOf(run[i].phase_s) - wigOf(run[i - 1].phase_s)) * W);
        dt.push((run[i].ty - run[i - 1].ty) * W);
      }
      if (dw.length >= 20 && mean(dt.map((v) => (v - mean(dt)) ** 2)) > 1e-9) {
        runWigStepShare.push(mean(dw.map((v) => (v - mean(dw)) ** 2)) / mean(dt.map((v) => (v - mean(dt)) ** 2)));
      }
    }
  }
  // 相位重置（meaningful action）与目标/实际 y 跳变
  for (let i = 1; i < ticks.length; i += 1) {
    const a = ticks[i - 1]; const b = ticks[i];
    if (b.t - a.t > 1.5) continue;
    // 只统计**连续两个 phase0 拍**之间的重置（审阅要求）。
    if (!a.fresh || !b.fresh || a.phase !== 0 || b.phase !== 0) continue;
    phaseTickN += 1;
    const reset = b.phase_s < a.phase_s - 1e-9;
    if (reset) phaseResetTicks += 1;
    let nJ = 0; let n = 0;
    for (const id of OUTFIELD) {
      if (id === a.carrier || id === b.carrier) continue;
      if (!a.p[id][8] || !b.p[id][8]) continue;
      n += 1;
      const dty = Math.abs(b.p[id][5] - a.p[id][5]) * W;
      const day = Math.abs(b.p[id][1] - a.p[id][1]) * W;
      (reset ? resetTyJump : nonResetTyJump).push(dty);
      (reset ? resetAyJump : nonResetAyJump).push(day);
      if (dty > 2.0) nJ += 1;
    }
    if (n >= 10) (reset ? syncJumpReset : syncJumpNonReset).push(nJ / n);
  }
  // 共同信号：逐 tick/队 的目标 y/x 方差分解（phase0）
  for (const t of ticks) {
    if (!t.fresh || t.phase !== 0) continue;
    for (const team of [0, 1]) {
      const arr = OUTFIELD.filter((id) => (team === 0 ? id <= 10 : id >= 11) && id !== t.carrier && t.p[id][8]);
      if (arr.length < 3) continue;
      for (const ax of [4, 5]) {
        const vals = arr.map((id) => t.p[id][ax] * (ax === 4 ? L : W));
        const m = mean(vals);
        const resid = mean(vals.map((v) => (v - m) ** 2));
        (ax === 4 ? commonX : commonY).push({ m, resid });
      }
    }
  }
  // 共同信号占比 = var(逐 tick 的队均目标) / (var(队均) + mean(逐 tick 的个体残差方差))
  const cmShare = (rows) => {
    const ms = rows.map((r) => r.m);
    const mm = mean(ms);
    const commonVar = mean(ms.map((v) => (v - mm) ** 2));
    const residVar = mean(rows.map((r) => r.resid));
    return { commonVar, residVar, commonShare: commonVar + residVar > 1e-12 ? commonVar / (commonVar + residVar) : null };
  };
  // 汇总
  const safeMedian = (a) => (a.length ? median(a) : null);
  const rate = (a) => (a.length ? mean(a) : null);
  const staticTable = {};
  for (const [k, v] of Object.entries(staticByDist)) staticTable[k] = { staticRate: v[1] ? v[0] / v[1] : null, n: v[1] };
  return {
    actionDistribution: Object.fromEntries(act.map((n, i) => [ACTION[i], n])),
    actionByLine: Object.fromEntries(Object.entries(actByLine).map(([k, v]) => [k, Object.fromEntries(v.map((n, i) => [ACTION[i], n]))])),
    targetUpdateRate05: rate(upd05),
    targetSourceStepM: safeMedian(srcStep),
    targetSourceUpdateRate: rate(srcUpd),
    targetSourceDyShare: safeMedian(srcDyShare),
    targetJumpP95M: q(tgtJump, 0.95),
    targetJumpMaxM: tgtJump.length ? Math.max(...tgtJump) : null,
    targetJumpGt5Rate: tgtJump.length ? tgtJump.filter((v) => v > 5).length / tgtJump.length : null,
    targetJumpGt10Rate: tgtJump.length ? tgtJump.filter((v) => v > 10).length / tgtJump.length : null,
    targetDyFlipRate: rate(tgtDyFlip),
    actualDyFlipRate: rate(actDyFlip),
    ballDyFlipRate: rate(ballDyFlip),
    syncJumpShare: rate(syncJumpShare),
    phaseResetRate: phaseTickN ? phaseResetTicks / phaseTickN : null,
    syncJumpReset: rate(syncJumpReset),
    syncJumpNonReset: rate(syncJumpNonReset),
    targetYJumpResetM: median(resetTyJump),
    targetYJumpNonResetM: median(nonResetTyJump),
    actualYJumpResetM: median(resetAyJump),
    actualYJumpNonResetM: median(nonResetAyJump),
    wiggleVarShare: median(wiggleShare),
    wiggleCorr: median(wiggleCorr),
    wiggleVarMedianM2: median(wiggleVar),
    targetYVarMedianM2: median(targetYVar),
    runWiggleBeta: median(runWigBeta),
    runWiggleR2: median(runWigR2),
    runWiggleFullR2: median(runWigR2),
    runWiggleOnlyR2: median(runWigOnlyR2),
    runWiggleVarShare: median(runWigVarShare),
    runBallVarShare: median(runBallVarShare),
    runTargetYStepM: median(runStepY),
    runWiggleYStepM: median(runStepWig),
    runTargetUpdate05: mean(runUpdate05),
    runTargetDyShare: mean(runDyShare),
    runActualWiggleBeta: median(runActualWigBeta),
    runActualWiggleR2: median(runActualWigR2),
    runWiggleStepVarShare: median(runWigStepShare),
    targetUpdateRate10: rate(upd10),
    targetStepMedianM: safeMedian(tgtStep),
    targetDyShare: safeMedian(tgtDyShare.filter((v) => v != null)),
    targetDirAlignCos: safeMedian(alignCos),
    staticByTargetDist: staticTable,
    ballSlopeX: safeMedian(slopeX),
    ballSlopeY: safeMedian(slopeY),
    ballR2X: safeMedian(r2X),
    ballR2Y: safeMedian(r2Y),
    ballSlopeYAll: safeMedian(slopeYAll),
    ballR2YAll: safeMedian(r2YAll),
    ballLagY: Object.fromEntries(Object.entries(lagY).map(([k, v]) => [k, safeMedian(v)])),
    ballLagY0: safeMedian(lagY[0]),
    ballLagY1: safeMedian(lagY[1]),
    ballLagY2: safeMedian(lagY[2]),
    amp18TargetM: safeMedian(amp18Target),
    amp18ActualM: safeMedian(amp18Actual),
    amp90TargetM: safeMedian(amp90Target),
    ballDirCos: safeMedian(ballDirCos),
    ballFollowCorr: safeMedian(ballFollowCorr),
    velVsDispCorr: safeMedian(velVsDispCorr),
    velStaleFrac: safeMedian(velStaleFrac),
    commonMode: { x: cmShare(commonX), y: cmShare(commonY) },
    nPlayerSeries: series.size,
  };
}

// ── 聚合 ────────────────────────────────────────────────────────────────
const TRAJ_KEYS = ['lat', 'latPooled', 'still05Pooled', 'actualDyFlipPooled', 'straight', 'pathPerPlayer', 'dispPerPlayer', 'turnDegPer100m', 'turns30Per100m',
  'turnMedianDeg', 'dirEntropy', 'still05', 'still10', 'speedAutocorr', 'width', 'depth', 'hd', 'ad', 'spacing',
  'alignment', 'alignmentFrame', 'alignmentStep', 'blockTranslation', 'lateralSd', 'laneSd', 'yCorr', 'mixing', 'centroidGap', 'centroidXGap',
  'ballDirCos', 'ballFollowCorr', 'actualDyFlip', 'ballDyFlip', 'yLag10', 'yCrossRate', 'yRange',
  'gapStepFrac', 'ballGapFrac'];
export function summarizeWindows(windows) {
  const out = {};
  for (const k of TRAJ_KEYS) {
    const vals = windows.map((w) => w[k]).filter((v) => isNum(v));
    out[k] = { median: median(vals), mean: mean(vals), iqr: iqr(vals), n: vals.length };
  }
  for (const k of ['speedBins']) {
    const cols = [0, 1, 2, 3, 4].map((i) => windows.map((w) => w[k][i]).filter(isNum));
    out[k] = cols.map((v) => ({ median: median(v), iqr: iqr(v), n: v.length }));
  }
  return out;
}

// ── CLI ─────────────────────────────────────────────────────────────────
const IS_ENTRY = process.argv[1] && process.argv[1].endsWith('n5-movement.mjs');
if (IS_ENTRY) {
  const argv = process.argv.slice(2);
  const get = (flag, def = null) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : def; };
  const dumpsDir = get('--dumps');
  const realArgs = (get('--real') || '').split(',').filter(Boolean);
  const outPrefix = get('--out', 'n5-metrics');
  const winSec = Number(get('--win', 60));
  if (!dumpsDir) { console.error('用法: node n5-movement.mjs --dumps <dir> --real <dir,file> --out <prefix>'); process.exit(2); }

  const arms = readdirSync(dumpsDir).filter((d) => statSync(join(dumpsDir, d)).isDirectory()).sort();
  const result = { generatedBy: 'tools/visual-review/n5-movement.mjs', winSec, calibers: {
    engineTargets: '1 Hz native N5 sidecar; phase0 only; 300 s matches',
    engineTrajectory: 'viewer frames sampled from wasm at 1 Hz and 5 Hz (0.2 s); reported separately',
    real: 'primary = exclude p[2]===1 extrapolated points; allPoints = include; 1 Hz and 5 Hz separately; per-game windows, not pooled; ball metrics raw-ball only',
    gaps: '1 Hz steps with dt>1.5 s skipped (segmented); gapStepFrac/ballGapFrac reported',
  }, arms: {}, real: {}, engine1: {}, engine5: {}, engine1Summary: null, engine5Summary: null };
  for (const arm of arms) {
    // 聚合只取 seeds 401–420；seed 42 只用于 engine5/图，不混入 A 臂统计。
    const files = readdirSync(join(dumpsDir, arm)).filter((f) => {
      if (!f.endsWith('.json')) return false;
      const n = Number(f.slice(0, -5));
      return Number.isInteger(n) && n >= 401 && n <= 420;
    }).sort();
    const wins = []; const targets = [];
    for (const f of files) {
      const d = JSON.parse(readFileSync(join(dumpsDir, arm, f), 'utf8'));
      const frames = engineFramesFromDump(d);
      for (const w of windowize(frames, winSec)) wins.push(trajectoryWindow(w.frames));
      targets.push(targetMetrics(d));
    }
    // 目标指标聚合（逐场中位数的中位数）
    const tkeys = ['targetUpdateRate05', 'targetUpdateRate10', 'targetStepMedianM', 'targetDyShare',
      'targetDirAlignCos', 'ballSlopeX', 'ballSlopeY', 'ballR2X', 'ballR2Y', 'ballSlopeYAll', 'ballR2YAll',
      'ballLagY0', 'ballLagY1', 'ballLagY2', 'amp18TargetM',
      'amp18ActualM', 'amp90TargetM', 'ballDirCos', 'ballFollowCorr', 'velVsDispCorr', 'velStaleFrac',
      'targetJumpP95M', 'targetJumpMaxM', 'targetJumpGt5Rate', 'targetJumpGt10Rate',
      'targetDyFlipRate', 'actualDyFlipRate', 'ballDyFlipRate', 'syncJumpShare',
      'phaseResetRate', 'syncJumpReset', 'syncJumpNonReset', 'targetYJumpResetM', 'targetYJumpNonResetM',
      'actualYJumpResetM', 'actualYJumpNonResetM', 'wiggleVarShare', 'wiggleCorr', 'wiggleVarMedianM2', 'targetYVarMedianM2',
      'runWiggleBeta', 'runWiggleR2', 'runWiggleFullR2', 'runWiggleOnlyR2', 'runWiggleVarShare', 'runBallVarShare', 'runTargetYStepM', 'runWiggleYStepM', 'runTargetUpdate05', 'runTargetDyShare',
      'runActualWiggleBeta', 'runActualWiggleR2', 'runWiggleStepVarShare',
      'targetSourceStepM', 'targetSourceUpdateRate', 'targetSourceDyShare'];
    const tsum = {};
    for (const k of tkeys) {
      const v = targets.map((t) => t[k]).filter(isNum);
      tsum[k] = { median: median(v), iqr: iqr(v), n: v.length };
    }
    const staticAgg = {};
    for (const bin of ['<0.5', '0.5-1', '1-2', '>2']) {
      const v = targets.map((t) => t.staticByTargetDist[bin]);
      const n = v.reduce((a, b) => a + b.n, 0);
      staticAgg[bin] = { staticRate: n ? v.reduce((a, b) => a + (b.staticRate || 0) * b.n, 0) / n : null, n };
    }
    const actSum = {};
    for (const a of ACTION) actSum[a] = targets.reduce((s, t) => s + (t.actionDistribution[a] || 0), 0);
    const cmY = targets.map((t) => t.commonMode?.y?.commonShare).filter(isNum);
    const cmX = targets.map((t) => t.commonMode?.x?.commonShare).filter(isNum);
    result.arms[arm] = {
      nSeeds: files.length,
      nWindows: wins.length,
      traj: summarizeWindows(wins),
      target: { ...tsum, staticByTargetDist: staticAgg, actionDistribution: actSum,
        commonMode: { x: { median: median(cmX), iqr: iqr(cmX), n: cmX.length }, y: { median: median(cmY), iqr: iqr(cmY), n: cmY.length } } },
    };
  }
  // 真实数据：每个文件单独算（不拼场）
  for (const rp of realArgs) {
    let files = [];
    try {
      if (statSync(rp).isDirectory()) files = readdirSync(rp).filter((f) => f.endsWith('.json')).map((f) => join(rp, f)).filter((f) => statSync(f).isFile());
      else files.push(rp);
    } catch { continue; }
    for (const file of files) {
      const g = JSON.parse(readFileSync(file, 'utf8'));
      if (!Array.isArray(g.frames)) continue;
      const measure = (includeExtrapolated, hz) => {
        const { frames } = realFramesFromJson(g, { downsampleHz: hz, includeExtrapolated });
        const wins = windowize(frames, winSec).map((w) => trajectoryWindow(w.frames));
        return { frames, wins, summary: summarizeWindows(wins) };
      };
      const p1 = measure(false, 1); const a1 = measure(true, 1);
      const p5 = measure(false, 5); const a5 = measure(true, 5);
      // 外推比例：逐场（球员点 / 球点）
      let pN = 0; let pE = 0; let bN = 0; let bE = 0;
      for (const f of g.frames) {
        for (const p of f.players || []) if (p) { pN += 1; if (p.length > 2 && p[2] === 1) pE += 1; }
        if (f.ball) { bN += 1; if (f.ballFill === 'extrapolated') bE += 1; }
      }
      // 缺口：1 Hz primary 窗内 dt>1.5s 的步占比（0 = 无缺口）
      const gapVals = p1.wins.map((w) => w.gapStepFrac).filter(isNum);
      const winWithGap = p1.wins.filter((w) => (w.gapStepFrac || 0) > 0).length;
      result.real[basename(file)] = {
        nWindows: p1.wins.length,
        trajPrimary: p1.summary,
        trajAllPoints: a1.summary,
        trajPrimary5Hz: p5.summary,
        trajAllPoints5Hz: a5.summary,
        coverage: {
          playerExtrapolatedPct: pN ? 100 * pE / pN : null,
          ballExtrapolatedPct: bN ? 100 * bE / bN : null,
        },
        gaps: {
          medianGapStepFrac: median(gapVals),
          windowsWithGapPct: p1.wins.length ? 100 * winWithGap / p1.wins.length : null,
        },
        meta: { pitchMeters: p1.frames[0]?.pitchMeters || g.meta?.pitchMeters || [105, 68], frames: g.frames?.length },
      };
    }
  }
  // 引擎 viewer 帧：wasm 采样 1 Hz / 5 Hz（用户实际看到的是 5 Hz）。
  const wasmPath = get('--wasm');
  if (wasmPath) {
    const { loadEngineWasm, simulateStream } = await import('../benchmark-engine.mjs');
    const { createGame } = await import('../../viewer/game.js');
    const mm = await import('../../viewer/match-metrics.js');
    const { wasm, ok } = await loadEngineWasm(wasmPath);
    if (!ok) { console.error(`加载 wasm 失败：${wasmPath}`); process.exit(1); }
    const realism = get('--engine-realism', 'motion+formation+marking+press+shot_bridge');
    const duration = Number(get('--duration', 300));
    const seeds = (get('--engine-seeds', '42,401,402,403')).split(',').map(Number);
    const mkFrames = (stepSec) => {
      const out = [];
      for (const seed of seeds) {
        const stream = simulateStream(wasm, seed, duration, realism);
        const game = createGame(stream);
        const fr = mm.sampleEngineFrames(game, { stepSec }).map((f) => ({
          t: f.t, players: f.players, ball: f.ball, ballRaw: true, pitchMeters: [105, 68],
        }));
        out.push({ seed, frames: fr });
      }
      return out;
    };
    const e1 = mkFrames(1.0); const e5 = mkFrames(0.2);
    for (const { seed, frames } of e1) {
      const wins = windowize(frames, winSec).map((w) => trajectoryWindow(w.frames));
      result.engine1[seed] = { nWindows: wins.length, traj: summarizeWindows(wins) };
    }
    for (const { seed, frames } of e5) {
      const wins = windowize(frames, winSec).map((w) => trajectoryWindow(w.frames));
      result.engine5[seed] = { nWindows: wins.length, traj: summarizeWindows(wins) };
    }
    // 汇总：跨 seed 的窗池（描述性；同 seed 窗不独立）
    const allWins = (framesBySeed) => framesBySeed.flatMap(({ frames }) => windowize(frames, winSec).map((w) => trajectoryWindow(w.frames)));
    result.engine1Summary = summarizeWindows(allWins(e1));
    result.engine5Summary = summarizeWindows(allWins(e5));
  }
  writeFileSync(`${outPrefix}.json`, `${JSON.stringify(result, null, 2)}\n`);
  // 可读表
  const fmt = (v, d = 2) => (v == null ? 'n/a' : Number(v).toFixed(d));
  const lines = [];
  lines.push(`# N5 指标（${winSec}s 窗；实时=逐场 1 Hz 插值）`);
  lines.push('| 臂 | run目标y步(m) | wiggle y步(m) | run更新>0.5 | run目标y占比 | run wiggle beta | run R² | wiggle方差占比 | ball方差占比 | 实际y wiggle beta | 实际y R² |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const arm of arms) {
    const t = result.arms[arm].target;
    lines.push(`| ${arm} | ${fmt(t.runTargetYStepM?.median, 2)} | ${fmt(t.runWiggleYStepM?.median, 2)} | ${fmt(t.runTargetUpdate05?.median, 3)} | ${fmt(t.runTargetDyShare?.median, 3)} | ${fmt(t.runWiggleBeta?.median, 3)} | ${fmt(t.runWiggleR2?.median, 3)} | ${fmt(t.runWiggleVarShare?.median, 3)} | ${fmt(t.runBallVarShare?.median, 3)} | ${fmt(t.runActualWiggleBeta?.median, 3)} | ${fmt(t.runActualWiggleR2?.median, 3)} |`);
  }
  lines.push('');
  lines.push('| 臂 | 相位重置率 | 重置拍目标y跳(m) | 非重置拍目标y跳(m) | 重置拍同步跳变 | 非重置拍同步跳变 | wiggle方差占比 | wiggle-目标y相关 | wiggle幅值sd(m) | 目标y sd(m) |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const arm of arms) {
    const t = result.arms[arm].target;
    lines.push(`| ${arm} | ${fmt(t.phaseResetRate?.median, 3)} | ${fmt(t.targetYJumpResetM?.median, 2)} | ${fmt(t.targetYJumpNonResetM?.median, 2)} | ${fmt(t.syncJumpReset?.median, 3)} | ${fmt(t.syncJumpNonReset?.median, 3)} | ${fmt(t.wiggleVarShare?.median, 3)} | ${fmt(t.wiggleCorr?.median, 3)} | ${fmt(t.wiggleVarMedianM2?.median != null ? Math.sqrt(t.wiggleVarMedianM2.median) : null, 2)} | ${fmt(t.targetYVarMedianM2?.median != null ? Math.sqrt(t.targetYVarMedianM2.median) : null, 2)} |`);
  }
  lines.push('');
  const rows = [
    ...arms.map((a) => [a, result.arms[a].traj]),
    ...Object.entries(result.real).flatMap(([k, v]) => [
      [`${k} primary1`, v.trajPrimary], [`${k} all1`, v.trajAllPoints],
      [`${k} primary5`, v.trajPrimary5Hz], [`${k} all5`, v.trajAllPoints5Hz],
    ]),
    ...Object.entries(result.engine5).map(([seed, v]) => [`engine5 seed${seed}`, v.traj]),
    ...(result.engine5Summary ? [[`engine5 pool`, result.engine5Summary]] : []),
    ...(result.engine1Summary ? [[`engine1 pool`, result.engine1Summary]] : []),
  ];
  lines.push('| 数据 | lat | 直线度 | 转角°/100m | >30°转/100m | 方向熵 | 静止<0.5 | 静止<1.0 | 对齐度 | 块平移 | 车道sd(m) | y相关 | 混队 |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const [name, t] of rows) {
    lines.push(`| ${name} | ${fmt(t.lat.median, 3)} | ${fmt(t.straight.median)} | ${fmt(t.turnDegPer100m.median, 1)} | ${fmt(t.turns30Per100m.median, 1)} | ${fmt(t.dirEntropy.median, 3)} | ${fmt(t.still05.median, 3)} | ${fmt(t.still10.median, 3)} | ${fmt(t.alignment.median, 3)} | ${fmt(t.blockTranslation.median, 3)} | ${fmt(t.laneSd.median, 2)} | ${fmt(t.yCorr.median, 3)} | ${fmt(t.mixing.median, 3)} |`);
  }
  lines.push('');
  lines.push('## 目标生成（引擎臂）');
  lines.push('| 臂 | 共同信号y占比 | 速度态/位移相关 | 速度态停滞占比 | 目标锯齿率 | 实际锯齿率 | 同步跳变占比 | 目标跳变p95(m) | >5m跳变率 |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const arm of arms) {
    const a = result.arms[arm];
    lines.push(`| ${arm} | ${fmt(a.target.commonMode?.y?.median, 3)} | ${fmt(a.target.velVsDispCorr?.median, 3)} | ${fmt(a.target.velStaleFrac?.median, 3)} | ${fmt(a.target.targetDyFlipRate?.median, 3)} | ${fmt(a.target.actualDyFlipRate?.median, 3)} | ${fmt(a.target.syncJumpShare?.median, 3)} | ${fmt(a.target.targetJumpP95M?.median, 2)} | ${fmt(a.target.targetJumpGt5Rate?.median, 3)} |`);
  }
  lines.push('');
  lines.push('| 臂 | run% | mark% | close% | 更新>0.5m | 更新>1m | 目标步(m) | 目标y占比 | 对齐cos | 球y斜率 | 球y R² | 18s目标幅(m) | 18s实际幅(m) | 球向cos | 静止@>2m |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const arm of arms) {
    const t = result.arms[arm].target;
    const tot = Object.values(t.actionDistribution).reduce((a, b) => a + b, 0) || 1;
    lines.push(`| ${arm} | ${fmt(100 * t.actionDistribution.run / tot, 1)} | ${fmt(100 * t.actionDistribution.mark / tot, 1)} | ${fmt(100 * (t.actionDistribution.close_down + t.actionDistribution.chase) / tot, 1)} | ${fmt(t.targetUpdateRate05.median, 3)} | ${fmt(t.targetUpdateRate10.median, 3)} | ${fmt(t.targetStepMedianM.median)} | ${fmt(t.targetDyShare.median, 3)} | ${fmt(t.targetDirAlignCos.median, 3)} | ${fmt(t.ballSlopeY.median, 3)} | ${fmt(t.ballR2Y.median, 3)} | ${fmt(t.amp18TargetM.median, 2)} | ${fmt(t.amp18ActualM.median, 2)} | ${fmt(t.ballDirCos.median, 3)} | ${fmt(t.staticByTargetDist['>2'].staticRate, 3)} |`);
  }
  writeFileSync(`${outPrefix}.md`, `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
}
