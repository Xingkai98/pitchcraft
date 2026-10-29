// 盲测回放基线：**纯函数核心**（窗口选择 / 同渲染器出图 / 盲法排布 / 像素自证 / 评分统计）。
//
// ── 为什么有它（2026-10-23）────────────────────────────────────────────────
// 本仓已有 `trajectory.mjs` / `like-football.mjs` / `contact-sheet.mjs`，但它们
// **把引擎与真实并排画在一张图上**——裁判看到「左引擎右真实」，测的是「哪边更像」，
// 而不是「能不能只看一张图就分出真假」。本工具把两侧**混成一个无标签刺激集**：
// 同一渲染器、同一窗口长度、同一采样率、同一点位/球/比例；裁判只看到单张图。
//
// 纪律（沿袭 visual-review skill，逐条都有前车之鉴）：
//   1. **一张图只放一个来源**（并排/成对 = 泄题）；
//   2. **同一渲染器**（contact 逐面板复用 `render.mjs` 的 `drawPanel`）；
//   3. **真实侧瑕疵逐面板断言清零**（22 人 / 球 / 坐标范围 / 原始球帧）；
//   4. **死球窗按写死规则过滤**，且规则在渲图前冻结（pre-registration）；
//   5. **呈现顺序与来源统计独立**（随机洗牌 + 检验）；
//   6. **中性命名**、图内无 seed/match/时间/来源；
//   7. **图本身要自证**（球、22 人、坐标映射、调色板、PNG 元数据）。
//
// 本文件不读 wasm / 真实数据（除 `loadRealFrames` / `loadEngineFrames` 两个加载器）；
// 其余函数吃帧序列，CI 可用合成帧直测。
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SoftCanvas, canvasToPng } from '../../viewer/soft-canvas.js';
import { drawPanel, ballXY } from './render.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const KEEPER_IDS = [0, 21];
export const PITCH_METERS = [105, 68];

// ── 预注册默认值（与 .scratch/notes/.../preregistration.json 一致；测试用合成配置）──
export const DEFAULT_PREREG = {
  windowSec: 24,
  canonicalHz: 5,
  canonicalStepSec: 0.2,
  contactFrames: 8,
  usableMarginSec: 60,
  searchStepSec: 2,
  maxSearchOffsetSec: 360,
  thresholds: {
    coverage: 0.98,
    allPlayersFrac: 0.98,
    rawBallFrac: 0.90,
    maxBallFillSec: 1.0,
    ballInFieldFrac: 0.98,
    minBallPathM: 30,
    minOutfieldMedianPathM: 1.0,
    maxDuplicateCoordFrac: 0.10,
    contactSamplesOk: true,
    contactRawBall: true,
    contactBallInField: true,
  },
};

// ── 小工具 ──────────────────────────────────────────────────────────────
export const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
export const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const quantile = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const h = (s.length - 1) * p;
  const i = Math.floor(h);
  return i + 1 >= s.length ? s[s.length - 1] : s[i] + (h - i) * (s[i + 1] - s[i]);
};
export const sha256 = (x) => createHash('sha256').update(x).digest('hex');
const round3 = (v) => Math.round(v * 1000) / 1000;

// ── 数据加载 ────────────────────────────────────────────────────────────
// 统一帧：{ t, players:[{id,x,y,extrapolated?}], ball:[x,y]|null, ballFill:null|number }
// `ballFill` 非 null = 转换器补全的球位（不是原始观测）。
export function loadRealFrames(path, { pitchMeters } = {}) {
  const g = JSON.parse(readFileSync(path, 'utf8'));
  const pm = pitchMeters || (g.meta && g.meta.pitchMeters);
  const pitch = Array.isArray(pm) ? pm
    : (pm && pm.length && pm.width ? [pm.length, pm.width] : PITCH_METERS);
  const frames = g.frames.map((f) => {
    const players = [];
    for (let id = 0; id < f.players.length; id += 1) {
      const p = f.players[id];
      if (!p) continue;
      const out = { id, x: p[0], y: p[1] };
      if (p.length > 2 && p[2] === 1) out.extrapolated = true;
      players.push(out);
    }
    return {
      t: f.t,
      players,
      ball: Array.isArray(f.ball) && f.ball.length >= 2 ? [f.ball[0], f.ball[1]] : null,
      ballFill: f.ballFill === undefined ? null : f.ballFill,
    };
  });
  return { frames, pitchMeters: pitch, meta: g.meta, path };
}

export async function loadEngineFrames(wasmPath, seed, durationSec, { sampleStepSec = 0.2 } = {}) {
  const { loadEngineWasm, simulateStream } = await import('../benchmark-engine.mjs');
  const mm = await import('../../viewer/match-metrics.js');
  const { createGame } = await import('../../viewer/game.js');
  const { wasm, ok, message } = await loadEngineWasm(wasmPath);
  if (!ok) throw new Error(message || `无法加载 wasm：${wasmPath}`);
  const eventJson = simulateStream(wasm, seed, durationSec);
  const game = createGame(eventJson, { smoothSamples: 5 });
  const frames = mm.sampleEngineFrames(game, { stepSec: sampleStepSec });
  const normalized = frames.map((f) => ({
    t: f.t,
    players: f.players.map((p) => ({ id: p.id, x: p.x, y: p.y })),
    ball: f.ball ? [f.ball[0], f.ball[1]] : null,
    ballFill: null,
  }));
  return {
    frames: normalized,
    pitchMeters: PITCH_METERS,
    eventJson,
    eventHash: sha256(eventJson),
    eventLength: eventJson.length,
    seed,
  };
}

// ── 取帧 / 窗口质量 ──────────────────────────────────────────────────────
// 最近源帧；距 t 超过 tolSec 返回 null（禁止跨 gap 插值——SkillCorner 有 62 段 gap）。
export function nearestFrame(frames, t, tolSec = 0.3) {
  if (!frames.length) return null;
  let lo = 0; let hi = frames.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (frames[m].t < t) lo = m + 1; else hi = m - 1;
  }
  let best = null; let bd = Infinity;
  for (const i of [hi, lo, hi - 1, lo + 1]) {
    const f = frames[i];
    if (!f) continue;
    const d = Math.abs(f.t - t);
    if (d < bd) { bd = d; best = f; }
  }
  return bd <= tolSec + 1e-9 ? { frame: best, dt: bd } : null;
}

export function canonicalWindow(frames, t0, opts = {}) {
  const step = opts.canonicalStepSec ?? DEFAULT_PREREG.canonicalStepSec;
  const win = opts.windowSec ?? DEFAULT_PREREG.windowSec;
  const tol = opts.tolSec ?? 0.3;
  const n = Math.round(win / step) + 1;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const t = round3(t0 + i * step);
    const hit = nearestFrame(frames, t, tol);
    out.push(hit ? { t, frame: hit.frame, dt: hit.dt } : { t, frame: null, dt: null });
  }
  return out;
}

const inField = (b) => b && b[0] >= 0.01 && b[0] <= 0.99 && b[1] >= 0.01 && b[1] <= 0.99;
const isRawBall = (f) => f && f.ball && f.ballFill == null;
const dupFrame = (f) => {
  const seen = new Set();
  for (const p of f.players) {
    const k = `${p.x.toFixed(6)},${p.y.toFixed(6)}`;
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
};

// 评估一个窗口。**纯函数**：帧序列 + t0 → 统计量。所有阈值与 quality 公式来自预注册。
export function evaluateWindow(frames, t0, opts = {}) {
  const pre = { ...DEFAULT_PREREG, ...opts, thresholds: { ...DEFAULT_PREREG.thresholds, ...(opts.thresholds || {}) } };
  const win = pre.windowSec;
  const step = pre.canonicalStepSec;
  const samples = canonicalWindow(frames, t0, { windowSec: win, canonicalStepSec: step, tolSec: opts.tolSec ?? 0.3 });
  const present = samples.filter((s) => s.frame);
  const n = samples.length;
  const nonNull = present.length;
  const coverage = nonNull / n;
  const all22 = nonNull ? present.filter((s) => s.frame.players.length === 22).length / nonNull : 0;
  const rawBall = nonNull ? present.filter((s) => isRawBall(s.frame)).length / nonNull : 0;
  const ballInField = nonNull ? present.filter((s) => inField(s.frame.ball)).length / nonNull : 0;

  let maxFillFrames = 0; let run = 0;
  for (const s of samples) {
    if (s.frame && s.frame.ball && s.frame.ballFill != null) {
      run += 1; if (run > maxFillFrames) maxFillFrames = run;
    } else run = 0;
  }
  const maxFillSec = maxFillFrames * step;

  let ballPathM = 0; let prev = null;
  for (const s of samples) {
    const f = s.frame;
    if (isRawBall(f)) {
      if (prev && f.t - prev.t <= step + 0.05) {
        ballPathM += Math.hypot((f.ball[0] - prev.ball[0]) * PITCH_METERS[0],
          (f.ball[1] - prev.ball[1]) * PITCH_METERS[1]);
      }
      prev = f;
    } else prev = null;
  }

  const byId = new Map();
  for (const s of samples) {
    const f = s.frame;
    if (!f) continue;
    for (const p of f.players) {
      if (KEEPER_IDS.includes(p.id)) continue;
      if (!byId.has(p.id)) byId.set(p.id, []);
      byId.get(p.id).push({ t: f.t, x: p.x, y: p.y });
    }
  }
  const paths = [];
  for (const pts of byId.values()) {
    let d = 0;
    for (let i = 1; i < pts.length; i += 1) {
      if (pts[i].t - pts[i - 1].t <= step + 0.05) {
        d += Math.hypot((pts[i].x - pts[i - 1].x) * PITCH_METERS[0], (pts[i].y - pts[i - 1].y) * PITCH_METERS[1]);
      }
    }
    paths.push(d);
  }
  const outfieldMedianPathM = median(paths) ?? 0;
  const dupFrac = nonNull ? present.filter((s) => dupFrame(s.frame)).length / nonNull : 1;

  const contactTimes = [];
  for (let c = 0; c < pre.contactFrames; c += 1) {
    contactTimes.push(round3(t0 + (c * win) / Math.max(1, pre.contactFrames - 1)));
  }
  const contactFrames = contactTimes.map((t) => nearestFrame(frames, t, opts.tolSec ?? 0.3));
  // 2026-10-28：接触帧「同队可见色块」预筛。渲染用 10px 直径点（≈1.7m），同队两人 <1.7m
  // 会并成一个色块；verifyContactImage 要求每色 ≥5 组件。这里在**选窗阶段**用同一几何近似
  // 预筛（≥6 留余量），把「庆祝/开球挤成一团」这类真实侧渲染瑕疵挡在冻结之前。
  // 渲染半径 5px / 面板 300px×105m ⇒ 1px≈0.35m，两点相切=10px≈3.5m（2026-10-28 实测校正，初版 1.7 低估一半）。
  const CONTACT_MERGE_M = 3.6;
  const teamBlobs = (frame) => {
    const counts = { home: 0, away: 0 };
    for (const team of ['home', 'away']) {
      const ids = frame.players.filter((p) => (team === 'home' ? p.id <= 10 : p.id >= 11));
      for (const p of ids) {
        let nearest = Infinity;
        for (const q of ids) {
          if (q === p) continue;
          const d = Math.hypot((p.x - q.x) * PITCH_METERS[0], (p.y - q.y) * PITCH_METERS[1]);
          if (d < nearest) nearest = d;
        }
        if (nearest > CONTACT_MERGE_M) counts[team] += 1;
      }
    }
    return Math.min(counts.home, counts.away);
  };
  const contactMinTeamBlobs = contactFrames.length
    ? Math.min(...contactFrames.map((h) => (h && h.frame.players.length === 22 ? teamBlobs(h.frame) : 0)))
    : 0;
  const contactSamplesOk = contactFrames.every((h) => h && h.frame.players.length === 22 && h.frame.ball);
  const contactRawBall = contactFrames.every((h) => h && isRawBall(h.frame));
  const contactBallInField = contactFrames.every((h) => h && inField(h.frame.ball));

  const t = pre.thresholds;
  const pass = coverage >= t.coverage
    && all22 >= t.allPlayersFrac
    && rawBall >= t.rawBallFrac
    && maxFillSec <= t.maxBallFillSec
    && ballInField >= t.ballInFieldFrac
    && ballPathM >= t.minBallPathM
    && outfieldMedianPathM >= t.minOutfieldMedianPathM
    && dupFrac <= t.maxDuplicateCoordFrac
    && (!t.contactSamplesOk || contactSamplesOk)
    && (t.contactMinTeamBlobs == null || contactMinTeamBlobs >= t.contactMinTeamBlobs)
    && (!t.contactRawBall || contactRawBall)
    && (!t.contactBallInField || contactBallInField);

  // 预注册公式：2*cov+2*all22+3*raw+2*ballIn+min(path/100,1)-maxFill/10-dup。
  const quality = 2 * coverage + 2 * all22 + 3 * rawBall + 2 * ballInField
    + Math.min(ballPathM / 100, 1) - maxFillSec / 10 - dupFrac;

  return {
    t0: round3(t0),
    t1: round3(t0 + win),
    pass,
    quality,
    stats: {
      coverage, all22, rawBallFrac: rawBall, maxFillSec, ballInFieldFrac: ballInField,
      ballPathM, outfieldMedianPathM, duplicateCoordFrac: dupFrac, contactMinTeamBlobs,
    },
    contactTimes,
    contactFrames: contactFrames.map((h) => h && h.frame),
    contactSamplesOk,
    contactRawBall,
    contactBallInField,
    samples,
  };
}

// 从 anchor 起向前搜索第一个通过窗口；无则取 quality 最大者（fallback=true，同分取小 t）。
export function selectWindow(frames, anchorT, opts = {}) {
  const pre = { ...DEFAULT_PREREG, ...opts, thresholds: { ...DEFAULT_PREREG.thresholds, ...(opts.thresholds || {}) } };
  if (!frames.length) throw new Error('selectWindow: 空帧序列');
  const T = frames[frames.length - 1].t;
  const maxStart = T - pre.usableMarginSec - pre.windowSec;
  const minStart = pre.usableMarginSec;
  const start = Math.max(minStart, Math.min(anchorT, maxStart));
  let best = null;
  let searched = 0;
  for (let off = 0; off <= pre.maxSearchOffsetSec + 1e-9; off += pre.searchStepSec) {
    const t0 = round3(start + off);
    if (t0 > maxStart + 1e-9) break;
    searched += 1;
    const ev = evaluateWindow(frames, t0, opts);
    if (ev.pass) return { ...ev, offsetSec: off, fallback: false, searched };
    if (!best || ev.quality > best.quality) best = { ...ev, offsetSec: off };
  }
  if (!best) throw new Error('selectWindow: 搜索范围内没有可用起点');
  return { ...best, fallback: true, searched };
}

// 真实 anchor：可用时长上的比例。
export function anchorTime(frames, frac, opts = {}) {
  const margin = opts.usableMarginSec ?? DEFAULT_PREREG.usableMarginSec;
  const win = opts.windowSec ?? DEFAULT_PREREG.windowSec;
  const T = frames[frames.length - 1].t;
  const a = margin; const b = T - margin - win;
  return round3(a + (b - a) * frac);
}

// ── 盲法：随机 id / 呈现顺序 ─────────────────────────────────────────────
export function itemId(salt, descriptor) {
  return `rb-${sha256(`${salt}|${descriptor}`).slice(0, 10)}`;
}

const hashOrder = (salt, id) => sha256(`${salt}|${id}`);

export function mainOrderCheck(order) {
  const half = Math.floor(order.length / 2);
  const realInFirstHalf = order.slice(0, half).filter((x) => x.source === 'real').length;
  let maxRun = 1; let run = 1;
  for (let i = 1; i < order.length; i += 1) {
    if (order[i].source === order[i - 1].source) { run += 1; maxRun = Math.max(maxRun, run); } else run = 1;
  }
  // 2026-10-28：边界从写死 [6,12] 泛化为「前一半的 1/3..2/3」——36 项（18/18）时仍是 [6,12]，
  // 24 项（12/12）收紧为 [4,8]（SKILL.md 的配方值）。写死 [6,12] 在 24 项下允许前半全真 = 呈现顺序泄题口。
  const lo = Math.ceil(half / 3);
  const hi = Math.floor((half * 2) / 3);
  const ok = realInFirstHalf >= lo && realInFirstHalf <= hi && maxRun <= 4;
  return { ok, realInFirstHalf, maxRun, n: order.length };
}

// 从 k=0 递增取第一个满足检查的 salt（预注册；记录 k）。
export function orderWithCheck(items, saltBase, check, maxK = 1000) {
  for (let k = 0; k < maxK; k += 1) {
    const salt = `${saltBase}:${k}`;
    const sorted = [...items].sort((a, b) => hashOrder(salt, a.id).localeCompare(hashOrder(salt, b.id)));
    const res = check(sorted);
    if (res.ok) return { items: sorted, salt, k, check: res };
  }
  throw new Error(`orderWithCheck: ${maxK} 个 salt 都不满足检查`);
}

// 负控：随机 pair 顺序 + 随机 A/B 朝向；要求 A 侧为 real 的数目 ∈ [3,6]。
export function controlOrderCheck(pairs) {
  const aReal = pairs.filter((p) => p.A.source === 'real').length;
  // 同上泛化：n=9 时 [3,6]（与 2026-10-23 预注册一致），n=3 时 [1,2]。
  const lo = Math.ceil(pairs.length / 3);
  const hi = Math.floor((pairs.length * 2) / 3);
  return { ok: aReal >= lo && aReal <= hi, aReal, n: pairs.length };
}
export function orderControls(pairs, saltBase, maxK = 1000) {
  for (let k = 0; k < maxK; k += 1) {
    const salt = `${saltBase}:${k}`;
    const oriented = pairs.map((p) => {
      const flip = parseInt(hashOrder(`${salt}|ab`, p.id).slice(0, 2), 16) % 2 === 1;
      return flip ? { ...p, A: p.bItem, B: p.aItem } : { ...p, A: p.aItem, B: p.bItem };
    }).sort((a, b) => hashOrder(salt, a.id).localeCompare(hashOrder(salt, b.id)));
    const res = controlOrderCheck(oriented);
    if (res.ok) return { pairs: oriented, salt, k, check: res };
  }
  throw new Error(`orderControls: ${maxK} 个 salt 都不满足检查`);
}

// ── 同渲染器出图 ────────────────────────────────────────────────────────
// 关键：contact 的每个面板直接调用 `render.mjs` 的 `drawPanel`——与现有视觉工具同一个函数。
// 传空 label，图内没有任何文字。
export const CONTACT_LAYOUT = { PW: 300, PH: 194, GAP: 8, MARGIN: 8, BG: '#111' };
export const TRAJ_LAYOUT = { PW: 600, PH: 389, MARGIN: 12, BG: '#111', LINE: 1.3, DOT: 3, BALL_LINE: 1.5, BALL_R: 5, BALL_OUTLINE: 7.5 };

export const RENDER_PARAMS = {
  contact: { ...CONTACT_LAYOUT, colors: { red: '#e84040', blue: '#4090e8', ball: '#ffe400' }, labels: false },
  trajectory: { ...TRAJ_LAYOUT, colors: { red: '#e84040', blue: '#4090e8', ball: '#ffe400' }, labels: false },
};
export const RENDER_PARAMS_HASH = sha256(JSON.stringify(RENDER_PARAMS));

export function buildContactImage(contactFrames, opts = {}) {
  const { PW, PH, GAP, MARGIN, BG } = { ...CONTACT_LAYOUT, ...(opts.layout || {}) };
  if (!Array.isArray(contactFrames) || contactFrames.length === 0) throw new Error('buildContactImage: 没有帧');
  for (const [i, f] of contactFrames.entries()) {
    if (!f) throw new Error(`buildContactImage: 第 ${i} 帧为空（禁止静默丢面板）`);
    if (f.players.length !== 22) throw new Error(`buildContactImage: 第 ${i} 帧 ${f.players.length} 人（应 22）`);
    if (!ballXY(f.ball)) throw new Error(`buildContactImage: 第 ${i} 帧没球`);
  }
  const W = MARGIN * 2 + contactFrames.length * PW + (contactFrames.length - 1) * GAP;
  const H = MARGIN * 2 + PH;
  const cv = new SoftCanvas(W, H); const ctx = cv.getContext();
  ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
  const panels = [];
  contactFrames.forEach((f, i) => {
    const x = MARGIN + i * (PW + GAP); const y = MARGIN;
    drawPanel(ctx, x, y, PW, PH, f.players, f.ball, '');
    panels.push({ x, y, w: PW, h: PH, playersDrawn: f.players.length, ballDrawn: !!ballXY(f.ball) });
  });
  return { canvas: cv, W, H, panels, params: { ...RENDER_PARAMS.contact, layout: { PW, PH, GAP, MARGIN, BG } } };
}

function strokePath(ctx, pts, color, width) {
  if (pts.length < 2) {
    if (pts.length === 1) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], width, 0, Math.PI * 2); ctx.fill(); }
    return;
  }
  ctx.strokeStyle = color; ctx.lineWidth = width;
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
  for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
  ctx.stroke();
}

// 轨迹图：**一张图只放一个来源**。字段用 drawPanel（空人/空球）画，保证与 contact 同底；
// 轨迹线/端点/球路径叠加。无标题、无 id 文字、无来源文字。
export function buildTrajectoryImage(canonicalSamples, opts = {}) {
  const L = { ...TRAJ_LAYOUT, ...(opts.layout || {}) };
  const { PW, PH, MARGIN, BG } = L;
  const frames = canonicalSamples.map((s) => (s && s.frame) || s).filter(Boolean);
  if (!frames.length) throw new Error('buildTrajectoryImage: 没有帧');
  const W = PW + MARGIN * 2; const H = PH + MARGIN * 2;
  const cv = new SoftCanvas(W, H); const ctx = cv.getContext();
  ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
  drawPanel(ctx, MARGIN, MARGIN, PW, PH, [], null, '');
  const toPx = (x, y) => [MARGIN + x * PW, MARGIN + (1 - y) * PH];
  const byId = new Map();
  for (const f of frames) {
    for (const p of f.players) {
      if (!byId.has(p.id)) byId.set(p.id, []);
      const [px, py] = toPx(p.x, p.y);
      byId.get(p.id).push({ t: f.t, px, py });
    }
  }
  let playersDrawn = 0;
  for (const [id, pts] of [...byId.entries()].sort((a, b) => a[0] - b[0])) {
    const color = id <= 10 ? RENDER_PARAMS.trajectory.colors.red : RENDER_PARAMS.trajectory.colors.blue;
    strokePath(ctx, pts.map((p) => [p.px, p.py]), color, L.LINE);
    const last = pts[pts.length - 1];
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(last.px, last.py, L.DOT, 0, Math.PI * 2); ctx.fill();
    playersDrawn += 1;
  }
  // 球路径：只在**原始球帧**之间连线（补全球位不画，避免把启发式补全画成真实跑动）。
  let prev = null; let ballPathPoints = 0; let lastRaw = null;
  for (const f of frames) {
    if (isRawBall(f)) {
      const [bx, by] = toPx(f.ball[0], f.ball[1]);
      if (prev && f.t - prev.t <= 0.25) {
        strokePath(ctx, [[prev.px, prev.py], [bx, by]], RENDER_PARAMS.trajectory.colors.ball, L.BALL_LINE);
      }
      prev = { t: f.t, px: bx, py: by };
      lastRaw = [bx, by];
      ballPathPoints += 1;
    } else prev = null;
  }
  if (lastRaw) {
    ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(lastRaw[0], lastRaw[1], L.BALL_OUTLINE, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = RENDER_PARAMS.trajectory.colors.ball; ctx.beginPath(); ctx.arc(lastRaw[0], lastRaw[1], L.BALL_R, 0, Math.PI * 2); ctx.fill();
  }
  return { canvas: cv, W, H, params: { ...RENDER_PARAMS.trajectory, layout: L }, playersDrawn, ballPathPoints };
}

export function canvasToPngBuffer(canvas) { return canvasToPng(canvas); }

// 标定图：22 名球员（11 红 11 蓝）排成互不重叠的网格，球在空位；用于自证
// 「球画了 / 22 人画了 / 归一化→像素映射正确」。
export function buildCalibrationCanvas(opts = {}) {
  const { PW, PH } = { ...CONTACT_LAYOUT, ...(opts.layout || {}) };
  const positions = [];
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 6; col += 1) {
      positions.push({ x: 0.08 + col * 0.145, y: 0.08 + row * 0.2 });
    }
  }
  // 避开中心球位 (0.5,0.5)：挑距中心 >0.12 的前 22 个位置。
  const chosen = positions.filter((p) => Math.hypot(p.x - 0.5, p.y - 0.5) > 0.12).slice(0, 22);
  const players = chosen.map((p, i) => ({ id: i, x: p.x, y: p.y }));
  const ball = [0.5, 0.5];
  const cv = new SoftCanvas(PW, PH); const ctx = cv.getContext();
  drawPanel(ctx, 0, 0, PW, PH, players, ball, '');
  const toPx = (x, y) => [x * PW, (1 - y) * PH];
  return {
    canvas: cv, W: PW, H: PH, players, ball, toPx,
    expected: players.map((p) => ({ id: p.id, x: p.x, y: p.y, px: toPx(p.x, p.y), color: p.id <= 10 ? 'red' : 'blue' })),
  };
}

// ── 像素分析（自证用）──────────────────────────────────────────────────
export function isRed(r, g, b) { return r === 232 && g === 64 && b === 64; }
export function isBlue(r, g, b) { return r === 64 && g === 144 && b === 232; }
export function isYellow(r, g, b) { return r === 255 && g === 228 && b === 0; }
export function isWhite(r, g, b) { return r > 240 && g > 240 && b > 240; }

export function countPixels(img, pred, rect) {
  const { data, width } = img;
  const x0 = Math.max(0, rect ? rect.x0 : 0); const y0 = Math.max(0, rect ? rect.y0 : 0);
  const x1 = Math.min(width, rect ? rect.x1 : width); const y1 = Math.min(img.height, rect ? rect.y1 : img.height);
  let n = 0;
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
    const o = (y * width + x) * 4; if (pred(data[o], data[o + 1], data[o + 2])) n += 1;
  }
  return n;
}

// 4 邻域连通块；返回面积与像素质心。用于「数球 / 数人」。
export function connectedComponents(img, pred, rect) {
  const { data, width, height } = img;
  const x0 = Math.max(0, rect ? rect.x0 : 0); const y0 = Math.max(0, rect ? rect.y0 : 0);
  const x1 = Math.min(width, rect ? rect.x1 : width); const y1 = Math.min(height, rect ? rect.y1 : height);
  const seen = new Uint8Array(width * height);
  const comps = [];
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const idx = y * width + x;
      if (seen[idx]) continue;
      const o = idx * 4;
      if (!pred(data[o], data[o + 1], data[o + 2])) { seen[idx] = 1; continue; }
      const stack = [[x, y]]; seen[idx] = 1;
      let area = 0; let sx = 0; let sy = 0; let minX = x; let maxX = x; let minY = y; let maxY = y;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        area += 1; sx += cx; sy += cy;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx; const ny = cy + dy;
          if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) continue;
          const ni = ny * width + nx;
          if (seen[ni]) continue;
          seen[ni] = 1;
          const no = ni * 4;
          if (pred(data[no], data[no + 1], data[no + 2])) stack.push([nx, ny]);
        }
      }
      if (area >= 2) comps.push({ area, cx: sx / area, cy: sy / area, bbox: [minX, minY, maxX, maxY] });
    }
  }
  return comps;
}

// ── PNG 块 / 等长化 ─────────────────────────────────────────────────────
const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export function pngChunks(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('不是 PNG');
  const out = []; let off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    out.push({ type, off, len, dataStart: off + 8, dataEnd: off + 8 + len });
    off += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
// 在 IEND 前插入私有 ancillary chunk（全零），把文件精确补到 targetSize。
// 目的：消除「文件大小」这条与来源相关的侧信道；所有图都有同样的 padding 块结构。
export function padPngToSize(buf, targetSize, chunkType = 'prVt') {
  if (buf.length === targetSize) return buf;
  if (buf.length > targetSize) throw new Error(`padPngToSize: 原图 ${buf.length} > target ${targetSize}`);
  const chunks = pngChunks(buf);
  const iend = chunks.find((c) => c.type === 'IEND');
  if (!iend) throw new Error('padPngToSize: 缺 IEND');
  const padLen = targetSize - buf.length - 12;
  if (padLen < 0) throw new Error('padPngToSize: target 太小');
  const type = Buffer.from(chunkType, 'ascii');
  const data = Buffer.alloc(padLen);
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(padLen);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  const chunk = Buffer.concat([lenBuf, type, data, crc]);
  return Buffer.concat([buf.subarray(0, iend.off), chunk, buf.subarray(iend.off)]);
}
export function forbiddenPngChunks(buf) {
  const bad = new Set(['tEXt', 'zTXt', 'iTXt', 'tIME', 'eXIf']);
  return pngChunks(buf).filter((c) => bad.has(c.type)).map((c) => c.type);
}

// 调色板自证：除 field/border/red/blue/yellow/outline/background 外的颜色数应为 0。
export const PALETTE = new Set(['13,43,15', '58,138,58', '232,64,64', '64,144,232', '255,228,0', '17,17,17']);
export function paletteViolations(img) {
  const { data } = img;
  const bad = new Map();
  for (let o = 0; o < data.length; o += 4) {
    const k = `${data[o]},${data[o + 1]},${data[o + 2]}`;
    if (!PALETTE.has(k)) bad.set(k, (bad.get(k) || 0) + 1);
  }
  return [...bad.entries()].map(([color, n]) => ({ color, n })).sort((a, b) => b.n - a.n);
}

// ── 自证 ────────────────────────────────────────────────────────────────
// 1) 标定图：11 红 + 11 蓝连通块、1 个黄球；每个质心与预期像素坐标误差 <=1.5px。
export function verifyCalibration() {
  const cal = buildCalibrationCanvas();
  const img = cal.canvas.getContext().getImageData(0, 0, cal.W, cal.H);
  const reds = connectedComponents(img, isRed);
  const blues = connectedComponents(img, isBlue);
  const yellows = connectedComponents(img, isYellow);
  const centroidErr = [];
  for (const e of cal.expected) {
    const pool = e.color === 'red' ? reds : blues;
    const c = pool.find((q) => q.bbox[0] <= e.px[0] && e.px[0] <= q.bbox[2] && q.bbox[1] <= e.px[1] && e.px[1] <= q.bbox[3])
      || pool.reduce((best, q) => (!best || Math.hypot(q.cx - e.px[0], q.cy - e.px[1]) < Math.hypot(best.cx - e.px[0], best.cy - e.px[1]) ? q : best), null);
    if (c) centroidErr.push(Math.hypot(c.cx - e.px[0], c.cy - e.px[1]));
  }
  const ball = yellows.length === 1 ? yellows[0] : null;
  const ballExpected = cal.toPx(0.5, 0.5);
  const ballErr = ball ? Math.hypot(ball.cx - ballExpected[0], ball.cy - ballExpected[1]) : null;
  return {
    redComponents: reds.length,
    blueComponents: blues.length,
    yellowComponents: yellows.length,
    playersDrawn: cal.players.length,
    centroidErrMax: centroidErr.length ? Math.max(...centroidErr) : null,
    centroidErrMean: centroidErr.length ? mean(centroidErr) : null,
    ballErr,
    pass: reds.length === 11 && blues.length === 11 && yellows.length === 1
      && cal.players.length === 22 && centroidErr.length === 22
      && Math.max(...centroidErr) <= 1.5 && ballErr != null && ballErr <= 1.5,
  };
}

// 2) 实际 contact 图：每个面板恰 1 个黄球；红/蓝像素充足；无白字；调色板无越界。
export function verifyContactImage(canvas, meta) {
  const img = canvas.getContext().getImageData(0, 0, meta.W, meta.H);
  const yellows = connectedComponents(img, isYellow);
  const reds = connectedComponents(img, isRed);
  const blues = connectedComponents(img, isBlue);
  const panels = meta.panels.map((p) => {
    const rect = { x0: p.x, y0: p.y, x1: p.x + p.w, y1: p.y + p.h };
    const y = yellows.filter((c) => c.cx >= rect.x0 && c.cx < rect.x1 && c.cy >= rect.y0 && c.cy < rect.y1);
    const rN = reds.filter((c) => c.cx >= rect.x0 && c.cx < rect.x1 && c.cy >= rect.y0 && c.cy < rect.y1).length;
    const bN = blues.filter((c) => c.cx >= rect.x0 && c.cx < rect.x1 && c.cy >= rect.y0 && c.cy < rect.y1).length;
    return {
      ...p,
      yellowComponents: y.length,
      redPixels: countPixels(img, isRed, rect),
      bluePixels: countPixels(img, isBlue, rect),
      redComponents: rN,
      blueComponents: bN,
    };
  });
  const whitePixels = countPixels(img, isWhite);
  const violations = paletteViolations(img);
  return {
    W: meta.W, H: meta.H, panels,
    yellowComponentsTotal: yellows.length,
    whitePixels,
    paletteViolations: violations.slice(0, 5),
    pass: panels.every((p) => p.yellowComponents === 1 && p.redPixels >= 250 && p.bluePixels >= 250
      && p.redComponents >= 5 && p.blueComponents >= 5)
      && whitePixels === 0 && violations.length === 0,
  };
}

// 3) 实际轨迹图：黄球路径、红蓝轨迹都有；无白字；调色板无越界。
export function verifyTrajectoryImage(canvas, meta) {
  const img = canvas.getContext().getImageData(0, 0, meta.W, meta.H);
  const yellowPixels = countPixels(img, isYellow);
  const redPixels = countPixels(img, isRed);
  const bluePixels = countPixels(img, isBlue);
  const whitePixels = countPixels(img, isWhite);
  const violations = paletteViolations(img);
  return {
    W: meta.W, H: meta.H, playersDrawn: meta.playersDrawn, ballPathPoints: meta.ballPathPoints,
    yellowPixels, redPixels, bluePixels, whitePixels,
    paletteViolations: violations.slice(0, 5),
    pass: meta.playersDrawn === 22 && meta.ballPathPoints >= 20
      && yellowPixels >= 100 && redPixels >= 200 && bluePixels >= 200
      && whitePixels === 0 && violations.length === 0,
  };
}

// ── 评分统计（分析器用；故意不含任何“判分”以外的启发式）──────────────────
export function wilsonInterval(p, n, z = 1.96) {
  if (!n) return null;
  const denom = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

export function auc(positive, negative) {
  if (!positive.length || !negative.length) return null;
  let wins = 0;
  for (const a of positive) for (const b of negative) {
    if (a > b) wins += 1; else if (a === b) wins += 0.5;
  }
  return wins / (positive.length * negative.length);
}

const cueSplit = (s) => String(s || '').split(/[,，;；/、\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);

export function analyzeJudgments(key, judge) {
  const keyItems = new Map(key.items.map((it) => [it.id, it]));
  const judged = new Map((judge.items || []).map((it) => [it.id, it]));
  const rows = [];
  for (const it of key.items) {
    const j = judged.get(it.id);
    if (!j) continue;
    const guess = j.A_guess === 'real' ? 'real' : j.A_guess === 'engine' ? 'engine' : null;
    if (!guess) continue;
    rows.push({
      id: it.id, source: it.source, guess, correct: guess === it.source,
      confidence: Number(j.A_confidence) || null, b: Number(j.B_score) || null, cues: j.cues || '',
    });
  }
  const n = rows.length;
  const correct = rows.filter((r) => r.correct).length;
  const acc = n ? correct / n : null;
  const realB = rows.filter((r) => r.source === 'real' && r.b != null).map((r) => r.b);
  const engB = rows.filter((r) => r.source === 'engine' && r.b != null).map((r) => r.b);
  const cues = new Map();
  for (const r of rows) for (const c of cueSplit(r.cues)) cues.set(c, (cues.get(c) || 0) + 1);

  const ctlKey = new Map((key.controls || []).map((c) => [c.id, c]));
  const ctlRows = [];
  for (const j of judge.controls || []) {
    const k = ctlKey.get(j.id);
    if (!k) continue;
    const truth = k.type === 'real-engine' ? 'different' : 'same';
    const guess = j.same_source === 'same' ? 'same' : j.same_source === 'different' ? 'different' : null;
    if (!guess) continue;
    const moreRealCorrect = k.type === 'real-engine' && j.more_real
      ? (k.A.source === 'real' ? j.more_real === 'A' : j.more_real === 'B') : null;
    ctlRows.push({ id: j.id, type: k.type, truth, guess, correct: guess === truth, confidence: Number(j.confidence) || null, moreRealCorrect });
  }
  const ctlByType = {};
  for (const t of ['real-real', 'engine-engine', 'real-engine']) {
    const rs = ctlRows.filter((r) => r.type === t);
    ctlByType[t] = { n: rs.length, correct: rs.filter((r) => r.correct).length };
  }
  const tpr = ctlByType['real-real'].n ? ctlByType['real-real'].correct / ctlByType['real-real'].n : null;
  const tnr = ctlByType['real-engine'].n ? ctlByType['real-engine'].correct / ctlByType['real-engine'].n : null;
  const mixedDir = ctlRows.filter((r) => r.moreRealCorrect != null);
  return {
    judge_id: judge.judge_id || null,
    main: {
      n, correct, accuracy: acc,
      accuracyCI95: acc == null ? null : wilsonInterval(acc, n),
      confusion: {
        real_as_real: rows.filter((r) => r.source === 'real' && r.guess === 'real').length,
        real_as_engine: rows.filter((r) => r.source === 'real' && r.guess === 'engine').length,
        engine_as_real: rows.filter((r) => r.source === 'engine' && r.guess === 'real').length,
        engine_as_engine: rows.filter((r) => r.source === 'engine' && r.guess === 'engine').length,
      },
      bScore: {
        real: { n: realB.length, mean: mean(realB), median: median(realB) },
        engine: { n: engB.length, mean: mean(engB), median: median(engB) },
        aucRealHigher: auc(realB, engB),
      },
      confidenceBuckets: {
        high: (() => { const r = rows.filter((x) => x.confidence >= 4); return { n: r.length, accuracy: r.length ? r.filter((x) => x.correct).length / r.length : null }; })(),
        low: (() => { const r = rows.filter((x) => x.confidence <= 2); return { n: r.length, accuracy: r.length ? r.filter((x) => x.correct).length / r.length : null }; })(),
      },
    },
    controls: {
      n: ctlRows.length,
      byType: ctlByType,
      balancedAccuracy: tpr != null && tnr != null ? (tpr + tnr) / 2 : null,
      mixedMoreRealAccuracy: mixedDir.length ? mixedDir.filter((r) => r.moreRealCorrect).length / mixedDir.length : null,
      rows: ctlRows,
    },
    cues: [...cues.entries()].sort((a, b) => b[1] - a[1]).map(([cue, count]) => ({ cue, count })),
  };
}
