// 横向行为分解：真实 Metrica vs 当前引擎
// 目的：把「人均 y-sd」拆成 (a) 球 y 跟随分量（OLS 斜率 × 球 y 波动）, (b) 残差分量（独立运动）
// 输出：逐球员表 + 汇总。只读，不改引擎。
//
// 用法：node research/2026-10-25-team-shape-law/lateral-decomposition.mjs [seed...]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const mod = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const { loadEngineWasm, simulateStream } = await mod('tools/benchmark-engine.mjs');
const { sampleEngineFrames, PITCH_LENGTH_M, PITCH_WIDTH_M } = await mod('viewer/match-metrics.js');
const { createGame } = await mod('viewer/game.js');

const WINDOW = [1800, 1920];

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const corr = (a, b) => {
  const ma = mean(a); const mb = mean(b);
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < a.length; i += 1) { const x = a[i] - ma; const y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
};
const ols = (xs, ys) => {
  const mx = mean(xs); const my = mean(ys);
  let num = 0; let den = 0;
  for (let i = 0; i < xs.length; i += 1) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const b = den > 0 ? num / den : 0;
  const a = my - b * mx;
  let ssr = 0; let sst = 0;
  for (let i = 0; i < xs.length; i += 1) { const e = ys[i] - (a + b * xs[i]); ssr += e * e; sst += (ys[i] - my) ** 2; }
  return { slope: b, intercept: a, r2: sst > 0 ? 1 - ssr / sst : 0 };
};

// frames: [{t, players:[{id,x,y}], ball:[x,y]}]
function analyze(frames, label) {
  const p = frames[0].players.length;
  const ids = Array.from({ length: p }, (_, i) => i).filter((id) => id !== 0 && id !== 21); // 非门将
  // 逐帧球队平均 y（同一队 10 人）——用于把「整队平移」从个体运动中拆出来
  const teamIds = [ids.filter((id) => id <= 10), ids.filter((id) => id >= 11)];
  const teamMeanY = frames.map((f) => teamIds.map((t) => {
    const vals = t.map((id) => f.players[id]?.y).filter((v) => v != null);
    return vals.length ? mean(vals) * PITCH_WIDTH_M : null;
  }));
  // 全段逐球员
  const rows = [];
  for (const id of ids) {
    const pts = frames.map((f) => f.players[id]).filter(Boolean);
    if (pts.length < frames.length * 0.5) continue;
    const y = pts.map((q) => q.y * PITCH_WIDTH_M);
    const x = pts.map((q) => q.x * PITCH_LENGTH_M);
    const ballY = frames.filter((f) => f.ball).map((f) => f.ball[1] * PITCH_WIDTH_M);
    const ballX = frames.filter((f) => f.ball).map((f) => f.ball[0] * PITCH_LENGTH_M);
    // 球序列与球员序列对齐（都过滤过缺失，长度可能不同——按帧号对齐）
    const idx = [];
    frames.forEach((f, i) => { if (f.players[id] && f.ball) idx.push(i); });
    const yy = idx.map((i) => frames[i].players[id].y * PITCH_WIDTH_M);
    const xx = idx.map((i) => frames[i].players[id].x * PITCH_LENGTH_M);
    const by = idx.map((i) => frames[i].ball[1] * PITCH_WIDTH_M);
    const bx = idx.map((i) => frames[i].ball[0] * PITCH_LENGTH_M);
    const teamIdx = id <= 10 ? 0 : 1;
    const tm = idx.map((i) => teamMeanY[i][teamIdx]);
    const fitY = ols(by, yy);
    const fitTeam = ols(tm, yy);
    // 二元回归 y ~ teamMeanY + ballY（残差 = 个体独立运动）
    const resid1 = idx.map((i, k) => yy[k] - (fitTeam.intercept + fitTeam.slope * tm[k]));
    const fitResidOnBall = ols(by, resid1);
    rows.push({
      id, n: idx.length,
      meanX: +mean(xx).toFixed(1), meanY: +mean(yy).toFixed(1),
      xSd: +sd(xx).toFixed(2), ySd: +sd(yy).toFixed(2),
      slopeBallY: +fitY.slope.toFixed(3), r2BallY: +fitY.r2.toFixed(3),
      slopeTeamY: +fitTeam.slope.toFixed(3), r2TeamY: +fitTeam.r2.toFixed(3),
      residYsd: +sd(idx.map((i, k) => yy[k] - (fitY.intercept + fitY.slope * by[k]))).toFixed(2),
      // 去掉整队平移后，仍能被球 y 解释的部分
      r2Independent: +Math.max(0, 1 - fitTeam.r2).toFixed(3),
      slopeBallX: +ols(bx, yy).slope.toFixed(3),
      // 窗口内（P38 latSd 口径）
      winYsd: (() => { const w = frames.filter((f) => f.t >= WINDOW[0] && f.t <= WINDOW[1] && f.players[id]).map((f) => f.players[id].y * PITCH_WIDTH_M); return w.length > 50 ? +sd(w).toFixed(2) : null; })(),
      // 横向路径与折返：全段 |Δy| 总里程、方向反转次数、最大偏离
      yPath: +(() => { let s = 0; for (let i = 1; i < y.length; i += 1) s += Math.abs(y[i] - y[i - 1]); return s; })().toFixed(0),
      yReversals: (() => { let n = 0; let prev = 0; for (let i = 1; i < y.length; i += 1) { const d = y[i] - y[i - 1]; if (Math.abs(d) < 0.05) continue; const sgn = Math.sign(d); if (prev !== 0 && sgn !== prev) n += 1; prev = sgn; } return n; })(),
      yMaxDev: +Math.max(...y.map((v) => Math.abs(v - mean(y)))).toFixed(1),
    });
  }
  // 窗口 swarm / 窗内球 y sd / 球队平均 y 对球 y 斜率
  const win = frames.filter((f) => f.t >= WINDOW[0] && f.t <= WINDOW[1]);
  const yseq = {};
  for (const id of ids) yseq[id] = win.map((f) => f.players[id]?.y * PITCH_WIDTH_M).filter((v) => v != null);
  const cors = [];
  for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) {
    if (yseq[ids[i]].length > 50 && yseq[ids[j]].length > 50) cors.push(corr(yseq[ids[i]], yseq[ids[j]]));
  }
  const ballY = win.filter((f) => f.ball).map((f) => f.ball[1] * PITCH_WIDTH_M);
  const ballX = win.filter((f) => f.ball).map((f) => f.ball[0] * PITCH_LENGTH_M);
  const winIdx = []; win.forEach((f, i) => { if (f.ball) winIdx.push(i); });
  const teamYwin = winIdx.map((i) => teamMeanY[frames.indexOf(win[i])]?.[0]).filter((v) => v != null);
  const ballYwin = winIdx.map((i) => win[i].ball[1] * PITCH_WIDTH_M);
  const summary = {
    label,
    nPlayers: rows.length,
    meanYsd: +mean(rows.map((r) => r.ySd)).toFixed(2),
    meanWinYsd: +mean(rows.map((r) => r.winYsd).filter((v) => v != null)).toFixed(2),
    meanSlopeBallY: +mean(rows.map((r) => r.slopeBallY)).toFixed(3),
    sdSlopeBallY: +sd(rows.map((r) => r.slopeBallY)).toFixed(3),
    meanR2BallY: +mean(rows.map((r) => r.r2BallY)).toFixed(3),
    meanSlopeTeamY: +mean(rows.map((r) => r.slopeTeamY)).toFixed(3),
    meanR2TeamY: +mean(rows.map((r) => r.r2TeamY)).toFixed(3),
    meanResidYsd: +mean(rows.map((r) => r.residYsd)).toFixed(2),
    meanYPath: +mean(rows.map((r) => r.yPath)).toFixed(0),
    meanYReversals: +mean(rows.map((r) => r.yReversals)).toFixed(0),
    meanYMaxDev: +mean(rows.map((r) => r.yMaxDev)).toFixed(1),
    swarm: +mean(cors).toFixed(3),
    ballYsdWin: +sd(ballY).toFixed(2),
    ballXsdWin: +sd(ballX).toFixed(2),
    teamMeanYslopeOnBallY: +ols(ballYwin, teamYwin).slope.toFixed(3),
  };
  return { summary, rows };
}

function loadReal(g) {
  const d = JSON.parse(readFileSync(join(ROOT, `viewer/data/real-game-${g}.json`), 'utf8'));
  const frames = d.frames.map((f, fi) => ({
    t: f.t,
    players: f.players.map((q, id) => (q == null ? null : { id, x: q[0], y: q[1] })),
    ball: f.ball || null,
  }));
  return frames;
}

const out = [];
for (const g of [1, 2]) {
  const a = analyze(loadReal(g), `real-game-${g}`);
  out.push(a);
}

const wasmArg = process.argv.find((a) => a.startsWith('--wasm='));
const wasmRes = await loadEngineWasm(wasmArg ? wasmArg.slice('--wasm='.length) : join(ROOT, 'viewer/engine.wasm'));
if (!wasmRes.ok) { console.error(wasmRes.message); process.exit(2); }
const seeds = process.argv.slice(2).filter((a) => !a.startsWith('--wasm=')).map(Number);
const seedList = seeds.length ? seeds : [42];
for (const seed of seedList) {
  const game = createGame(simulateStream(wasmRes.wasm, seed, 5400));
  const frames = sampleEngineFrames(game);
  const a = analyze(frames, `engine-seed${seed}`);
  out.push(a);
}

for (const a of out) {
  console.log(`\n## ${a.summary.label}`);
  console.log(JSON.stringify(a.summary));
  console.log('id  meanX meanY  xSd   ySd  winYsd slopeBallY r2Ball slopeTeamY r2Team  residYsd  yPath revs maxDev');
  for (const r of a.rows.sort((u, v) => u.meanX - v.meanX)) {
    console.log([String(r.id).padStart(2), String(r.meanX).padStart(5), String(r.meanY).padStart(5), String(r.xSd).padStart(5), String(r.ySd).padStart(5), String(r.winYsd).padStart(6), String(r.slopeBallY).padStart(9), String(r.r2BallY).padStart(6), String(r.slopeTeamY).padStart(10), String(r.r2TeamY).padStart(6), String(r.residYsd).padStart(8), String(r.yPath).padStart(6), String(r.yReversals).padStart(4), String(r.yMaxDev).padStart(6)].join(' '));
  }
}
