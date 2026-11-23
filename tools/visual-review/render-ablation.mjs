// 同流渲染消融（Change 0 / A 工作流）：同一份事件流 + 同一批窗口，用多条渲染路径出帧，
// 把「引擎 mover 锚点几何 / viewer 锚点合成 / 插值 / T1 纹理 / 指标定义」对运动学量的贡献分开。
//
// ── 为什么有它（2026-11-19，GitHub #190）────────────────────────────────────
// 判别普查（discriminator-census）测的是 **viewer 渲染帧**，且对零步也调用 atan2
// （`atan2(0,0)=0`）：「向左走 → 静止 → 继续向左」会被计成两次 >120° 折返。
// 于是「引擎折返 24×」既可能是引擎目标反转、也可能是 viewer 插值/纹理、还可能是指标
// 定义的零步伪角。本工具在**同一事件流**上逐层去掉 viewer 的加工，量出每一层的差值区间。
//
// ── 路径（design D2 的五条 + 一条诊断）────────────────────────────────────
//   movers   （诊断）只用引擎 beat 的 main/movers 端点（from→to，拍内线性、拍外保持）
//            → 「引擎 mover 意图」的代理；不采信 viewer 为 pass/shot/... 合成的锚点
//   direct   全部 viewer 锚点的零阶保持（不拍内插值）→ **采样伪影对照，不是意图**
//            （分段常值按 5Hz 采样会被 atan2(0,0)=0 放大成假折返）
//   linear   锚点线性插值（事件真间隙 hold，同 viewer；无 Catmull、无纹理）
//   catmull  线性 + 球员 Catmull–Rom（仅均匀拍链；与 viewer 同条件，无纹理）
//   t1       catmull + T1 弓形纹理（= viewer 默认球员路径；无高亮专属逻辑）
//   current  现行 viewer 全链：直接跑 `viewer/game.js` 的 `Game.seekTo`
//            （即 t1 + 一切现行特判；两者若逐位一致，说明 t1 复刻无误）
//
// ── 口径（写死，别图省事改）────────────────────────────────────────────────
//   * 窗：24s @ 5Hz = 121 帧，采样时刻 t0 + i*0.2（与 R7i 包 windows.json 同相位）。
//   * 逐窗算特征 → 对窗取分布；**不跨窗拼接**。
//   * 剔门将（id 0 / 21）；米制换算 x×105、y×68。
//   * 旧 turn120 与普查同定义（零步也计角，作历史对照）；条件 turn120 只统计相邻两步
//     步速均 ≥ 门限（主口径 0.5 m/s；另报 0.3 / 1.0）。
//   * 配对差 = 同一窗前后的差，报告 24 窗上的均值与 t 区间（n=24，t(0.975,23)=2.0687）。
//
// 用法：
//   node tools/visual-review/render-ablation.mjs freeze --wasm viewer/engine.wasm \
//        --windows <R7i windows.json> --out openspec/changes/p155-measurement-instrument/notes
//   node tools/visual-review/render-ablation.mjs run --wasm viewer/engine.wasm \
//        --stimulus openspec/changes/p155-measurement-instrument/notes/stimulus.json \
//        --out openspec/changes/p155-measurement-instrument/notes/ablation-out [--images all|none]
//
// ⚠️ 只读共享模块：`replay-blind-core.mjs` / `render.mjs` / `soft-canvas.js` / `viewer/game.js`。
// 本文件不改 `engine/` / `viewer/` 的任何行为。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseEventStream } from '../../viewer/protocol.js';
import { buildGameIndex, Game } from '../../viewer/game.js';
import { config as viewerConfig } from '../../viewer/config.js';
import { KEEPER_IDS, PITCH_METERS, buildContactImage, buildTrajectoryImage, canvasToPngBuffer } from './replay-blind-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');

// 'movers' 是第 6 条**诊断**路径（design 要求「至少」五条）：只用引擎 beat 的
// main/movers 端点（from→to）线性铺满一拍，其余事件（pass/shot/tackle/...）的
// viewer 合成锚点一律不用——用来把「viewer 锚点合成」从「viewer 插值/纹理」里分出来。
export const MODES = ['movers', 'direct', 'linear', 'catmull', 't1', 'current'];
export const DEFAULT_WINDOW = { sec: 24, hz: 5, samples: 121, stepSec: 0.2 };

export const sha256 = (x) => createHash('sha256').update(x).digest('hex');
const round3 = (x) => Math.round(x * 1e3) / 1e3;

// ── 1. 锚点插值（从 viewer/game.js 逐条复刻；只读复刻，不改原实现）────────────
// 复制自 `Game._interpolateAnchors` 的 continuous 分支 + `_smoothNeighborPositions`
// + `_textureOffset`。复刻的正确性由测试断言「t1 与 current 逐帧一致」守护。
function textureHash01(id, k, axis) {
  let h = (Math.imul(id | 0, 374761393) + Math.imul(k | 0, 668265263) + Math.imul(axis | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967296) * 2 - 1;
}

function textureOffset(id, u, prev, next, ampM, blockSec) {
  if (!(ampM > 0)) return null;
  const L = PITCH_METERS[0]; const W = PITCH_METERS[1];
  const vx = (next.x - prev.x) * L; const vy = (next.y - prev.y) * W;
  const len = Math.hypot(vx, vy);
  if (!(len > 1e-6)) return { dx: 0, dy: 0 };
  const block = Math.floor(prev.t / blockSec);
  const sign = textureHash01(id, block, 7);
  const env = Math.sin(Math.PI * u) ** 2;
  const offM = ampM * env * sign;
  return { dx: (offM * (-vy / len)) / L, dy: (offM * (vx / len)) / W };
}

function smoothNeighbors(arr, pos, prev, next) {
  const s1 = next.t - prev.t;
  if (!(s1 >= 0.5 && s1 <= 1.5)) return null;
  let lo = 0; let hi = arr.length - 1; let p0i = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t < prev.t - 1e-6) { p0i = mid; lo = mid + 1; } else hi = mid - 1;
  }
  lo = 0; hi = arr.length - 1; let p3i = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t > next.t + 1e-6) { p3i = mid; hi = mid - 1; } else lo = mid + 1;
  }
  if (p0i < 0 || p3i < 0) return null;
  const p0 = arr[p0i]; const p3 = arr[p3i];
  const s0 = prev.t - p0.t; const s3 = p3.t - next.t;
  if (!(s0 >= 0.5 && s0 <= 1.5 && s3 >= 0.5 && s3 <= 1.5)) return null;
  if (s0 > 2.2 * s1 || s3 > 2.2 * s1 || s1 > 2.2 * Math.min(s0, s3)) return null;
  return { p0, p3 };
}

const lastAtOrBefore = (arr, t) => {
  let lo = 0; let hi = arr.length - 1; let pos = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t <= t) { pos = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return pos;
};

// 单实体（球员或球）在时刻 t 的位置。
// mode: direct(零阶保持) | linear | catmull(球员) | t1(球员=catmull+纹理)
// 导出供测试直调（本文件内部 API，不是稳定接口）。
export function sampleEntity(mode, arr, bounds, t, id, { ampM = 0, blockSec = 3, isPlayer = false } = {}) {
  if (!arr || arr.length === 0) return null;
  const pos = lastAtOrBefore(arr, t);
  if (pos === -1) return null;
  const prev = arr[pos];
  if (mode === 'direct') return { x: prev.x, y: prev.y }; // 端点重采样：不拍内插值
  const next = pos + 1 < arr.length ? arr[pos + 1] : null;
  if (!next) return { x: prev.x, y: prev.y };
  // 事件间真间隙：hold 在 prev（与 Game 同规则；重叠段照常插值）。
  if (prev.evt !== undefined && next.evt !== undefined && prev.evt !== next.evt) {
    if (bounds && bounds.isLast[pos] && bounds.isFirst[pos + 1]) return { x: prev.x, y: prev.y };
  }
  const span = Math.max(next.t - prev.t, 1e-6);
  const u = Math.min(Math.max((t - prev.t) / span, 0), 1);
  let out;
  if (isPlayer && (mode === 'catmull' || mode === 't1')) {
    const smooth = smoothNeighbors(arr, pos, prev, next);
    if (smooth) {
      const { p0, p3 } = smooth;
      const u2 = u * u; const u3 = u2 * u;
      const cr = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * u
        + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
      out = {
        x: Math.min(Math.max(cr(p0.x, prev.x, next.x, p3.x), 0), 1),
        y: Math.min(Math.max(cr(p0.y, prev.y, next.y, p3.y), 0), 1),
      };
    }
  }
  if (!out) {
    out = { x: prev.x + (next.x - prev.x) * u, y: prev.y + (next.y - prev.y) * u };
  }
  if (isPlayer && mode === 't1') {
    const off = textureOffset(id, u, prev, next, ampM, blockSec);
    if (off) {
      out = {
        x: Math.min(Math.max(out.x + off.dx, 0), 1),
        y: Math.min(Math.max(out.y + off.dy, 0), 1),
      };
    }
  }
  return out;
}

// `movers` 诊断采样器：只用 beat 的 main/movers 端点。拍内线性、拍外保持；
// 未出现在某拍 movers 里的球员保持该拍起点位置（= 上一拍终点）。
// ⚠️ 球不在 mover 几何内：本模式球位沿用 viewer 的球锚点（linear），
// 故 mover 模式的 ball* 指标不是独立的引擎读数，报告里只作对照。
export function createMoverSampler(events, lineup, opts = {}) {
  const tick = opts.tickSec ?? viewerConfig.interpretation.tickSeconds;
  const index = opts.index ?? buildGameIndex(events, lineup, 'continuous');
  const beats = events.filter((e) => e.type === 'beat').map((e) => ({ t: e.t, main: e.main ?? null, movers: e.movers ?? [] }));
  const starts = new Map(); const targets = new Map();
  const state = new Map(lineup.map((p) => [p.id, { x: p.x, y: p.y }]));
  for (let k = 0; k < beats.length; k += 1) {
    starts.set(k, new Map([...state].map(([id, p]) => [id, { ...p }])));
    const tgt = new Map();
    const b = beats[k];
    if (b.main) tgt.set(b.main.subject, { x: b.main.x, y: b.main.y, x2: b.main.x2, y2: b.main.y2 });
    for (const mv of b.movers) tgt.set(mv.id, { x: mv.from_x, y: mv.from_y, x2: mv.to_x, y2: mv.to_y });
    targets.set(k, tgt);
    for (const [id, v] of tgt) state.set(id, { x: v.x2, y: v.y2 });
  }
  const sentOffAt = new Map();
  for (const e of events) {
    if (e && e.type === 'foul' && e.card === 'red' && typeof e.subject === 'number' && !sentOffAt.has(e.subject)) sentOffAt.set(e.subject, e.t);
  }
  const beatAt = (t) => {
    let lo = 0; let hi = beats.length - 1; let pos = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (beats[mid].t <= t) { pos = mid; lo = mid + 1; } else hi = mid - 1; }
    return pos;
  };
  return {
    mode: 'movers',
    matchEnd: index.matchEnd,
    sample(t) {
      const k = beatAt(t);
      const players = [];
      for (const p of lineup) {
        const offAt = sentOffAt.get(p.id);
        if (offAt !== undefined && t > offAt) continue;
        let pos = { x: p.x, y: p.y };
        if (k >= 0) {
          const b = beats[k];
          const tgt = targets.get(k).get(p.id);
          if (tgt && t <= b.t + tick) {
            const u = Math.min(Math.max((t - b.t) / tick, 0), 1);
            pos = { x: tgt.x + (tgt.x2 - tgt.x) * u, y: tgt.y + (tgt.y2 - tgt.y) * u };
          } else if (tgt) pos = { x: tgt.x2, y: tgt.y2 };
          else pos = starts.get(k).get(p.id) ?? pos;
        }
        players.push({ id: p.id, x: pos.x, y: pos.y });
      }
      const ball = sampleEntity('linear', index.ballAnchors, index.ballBounds, t, 0) ?? { x: 0.5, y: 0.5 };
      return { t, players, ball: [ball.x, ball.y] };
    },
  };
}

// ── 2. 帧采样器 ────────────────────────────────────────────────────────────
// 由 (events, lineup, mode) 建一个 `sample(t) → {t, players, ball}`；除 `movers` 外所有模式
// 共享同一份锚点时间线（`buildGameIndex`），确保只有「渲染路径」不同、输入完全相同。
export function createFrameSampler(events, lineup, mode, opts = {}) {
  if (!MODES.includes(mode)) throw new Error(`未知渲染模式：${mode}（可用：${MODES.join(' / ')}）`);
  const ampM = opts.textureAmpM ?? 0.12;
  const blockSec = opts.textureBlockSec ?? 3.0;
  if (mode === 'current') {
    // 现行 viewer 全链：t1 + 一切特判（跳过机制关闭——seekTo 不受播放状态影响）。
    const game = new Game(events, lineup, 'continuous', { skipThreshold: Infinity });
    return {
      mode,
      matchEnd: game.matchEnd,
      sample(t) {
        game.seekTo(t);
        return {
          t,
          players: game.players.map((p) => ({ id: p.id, x: p.x, y: p.y })),
          ball: [game.ball.x, game.ball.y],
        };
      },
    };
  }
  if (mode === 'movers') return createMoverSampler(events, lineup, opts);
  const index = opts.index ?? buildGameIndex(events, lineup, 'continuous');
  // 罚下过滤与 viewer 同口径（Game.players）：foul.card === 'red' 记罚下时刻。
  const sentOffAt = new Map();
  for (const e of events) {
    if (e && e.type === 'foul' && e.card === 'red' && typeof e.subject === 'number') {
      if (!sentOffAt.has(e.subject)) sentOffAt.set(e.subject, e.t);
    }
  }
  const ids = lineup.map((p) => p.id);
  const lineupPos = new Map(lineup.map((p) => [p.id, { x: p.x, y: p.y }]));
  return {
    mode,
    matchEnd: index.matchEnd,
    sample(t) {
      const players = [];
      for (const id of ids) {
        const offAt = sentOffAt.get(id);
        if (offAt !== undefined && t > offAt) continue;
        const pos = sampleEntity(mode, index.playerAnchors.get(id), index.playerBounds.get(id), t, id,
          { ampM, blockSec, isPlayer: true }) ?? lineupPos.get(id);
        players.push({ id, x: pos.x, y: pos.y });
      }
      // 球也走同一套「事件间真间隙 hold」规则（bounds 必传；漏传会让 t1≠current）。
      const ball = sampleEntity(mode, index.ballAnchors, index.ballBounds, t, 0, { ampM, blockSec }) ?? { x: 0.5, y: 0.5 };
      return { t, players, ball: [ball.x, ball.y] };
    },
  };
}

// ── 3. 采样与特征（纯函数；口径见文件头）────────────────────────────────────
export function sampleWindow(sampler, t0, window = DEFAULT_WINDOW) {
  const n = window.samples ?? Math.round(window.sec * window.hz) + 1;
  const step = window.stepSec ?? 1 / window.hz;
  const frames = [];
  for (let i = 0; i < n; i += 1) frames.push(sampler.sample(round3(t0 + i * step)));
  return frames;
}

const fmean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const fquant = (sorted, p) => {
  const n = sorted.length;
  if (!n) return null;
  const h = (n - 1) * p; const i = Math.floor(h);
  return i + 1 >= n ? sorted[n - 1] : sorted[i] + (h - i) * (sorted[i + 1] - sorted[i]);
};
const fmedian = (a) => { const s = [...a].sort((x, y) => x - y); return fquant(s, 0.5); };
const fsd = (a) => {
  if (a.length < 2) return 0;
  const m = fmean(a);
  return Math.sqrt(fmean(a.map((v) => (v - m) ** 2)));
};

// 单窗特征。对齐 `discriminator-census.mjs` 的旧口径（turn120PerWindow / staticFrac /
// speedP50 / speedP90 / rotationTurns / pathLen / disp24），并新增条件口径与加速度尾部。
export function windowFeatures(frames, opts = {}) {
  const keepers = new Set(opts.keepers ?? KEEPER_IDS);
  const L = PITCH_METERS[0]; const W = PITCH_METERS[1];
  const dt = opts.dt ?? (frames.length > 1 ? round3(frames[1].t - frames[0].t) : 0.2);
  const thresholds = opts.thresholds ?? [0.3, 0.5, 1.0];
  const windowSec = opts.windowSec ?? (frames.length > 1 ? frames[frames.length - 1].t - frames[0].t + dt : 0);

  const ids = frames.length ? frames[0].players.filter((p) => !keepers.has(p.id)).map((p) => p.id) : [];
  const series = new Map(ids.map((id) => [id, []]));
  for (const f of frames) {
    for (const p of f.players) if (series.has(p.id)) series.get(p.id).push([p.x * L, p.y * W, f.t]);
  }

  // 球员逐步量
  let steps = 0; let staticSteps = 0; let staticSteps02 = 0; let staticSteps10 = 0;
  const thKey = (th) => th.toFixed(1); // 固定字符串键：0.3 / 0.5 / 1.0（避免 1.0→"1"）
  let oldTurns = 0; let condTurns05 = 0; const condTurnsByThr = Object.fromEntries(thresholds.map((th) => [thKey(th), 0]));
  let effectiveSteps05 = 0; let eligiblePairs05 = 0;
  const speedsAll = []; const accelsAll = [];
  const pathLen = []; const disp = []; const straight = []; const rotTurns = [];
  const trans = { moveToStop: 0, stopToMove: 0, moveToMove: 0, stopToStop: 0 };
  for (const id of ids) {
    const s = series.get(id);
    let len = 0; let rot = 0; let turns = 0;
    const v = []; // 每步速度向量（m/s）
    for (let i = 1; i < s.length; i += 1) {
      const dx = s[i][0] - s[i - 1][0]; const dy = s[i][1] - s[i - 1][1];
      const m = Math.hypot(dx, dy); const sp = m / dt;
      len += m; steps += 1; speedsAll.push(sp);
      v.push([dx / dt, dy / dt]);
      if (sp < 0.5) staticSteps += 1;
      if (sp < 0.2) staticSteps02 += 1;
      if (sp < 1.0) staticSteps10 += 1;
      if (sp >= 0.5) effectiveSteps05 += 1;
      if (i >= 2) {
        const pdx = s[i - 1][0] - s[i - 2][0]; const pdy = s[i - 1][1] - s[i - 2][1];
        const a1 = Math.atan2(pdy, pdx); const a2 = Math.atan2(dy, dx); // 零步 → atan2(0,0)=0（旧口径）
        let da = a2 - a1; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
        rot += Math.abs(da);
        const ang = Math.abs(da) * 180 / Math.PI;
        if (ang > 120) { turns += 1; oldTurns += 1; }
        const psp = Math.hypot(pdx, pdy) / dt; // 上一进步速
        for (const th of thresholds) {
          if (psp >= th && sp >= th && ang > 120) condTurnsByThr[thKey(th)] += 1;
        }
        if (psp >= 0.5 && sp >= 0.5) eligiblePairs05 += 1;
        // 加速度尾部：|Δv| / Δt
        const pa = v[v.length - 2];
        if (pa) accelsAll.push(Math.hypot(v[v.length - 1][0] - pa[0], v[v.length - 1][1] - pa[1]) / dt);
        // 移动状态转移
        const pm = psp >= 0.5; const cm = sp >= 0.5;
        if (pm && cm) trans.moveToMove += 1;
        else if (pm && !cm) trans.moveToStop += 1;
        else if (!pm && cm) trans.stopToMove += 1;
        else trans.stopToStop += 1;
      }
    }
    rotTurns.push(rot / (2 * Math.PI));
    const e = s.length ? Math.hypot(s[s.length - 1][0] - s[0][0], s[s.length - 1][1] - s[0][1]) : 0;
    pathLen.push(len); disp.push(e); straight.push(len > 1e-9 ? e / len : 0);
  }
  const speeds = [...speedsAll].sort((a, b) => a - b);
  const accels = [...accelsAll].sort((a, b) => a - b);
  const turns = oldTurns;
  condTurns05 = condTurnsByThr[thKey(0.5)];

  // 球
  let ballPath = 0; const ballSpeeds = [];
  let prevBall = null;
  for (const f of frames) {
    if (!f.ball) { prevBall = null; continue; }
    if (prevBall) {
      const dx = (f.ball[0] - prevBall[0]) * L; const dy = (f.ball[1] - prevBall[1]) * W;
      const m = Math.hypot(dx, dy); ballPath += m; ballSpeeds.push(m / dt);
    }
    prevBall = f.ball;
  }
  const bs = [...ballSpeeds].sort((a, b) => a - b);
  const nP = ids.length || 1;
  const condRates = Object.fromEntries(thresholds.map((th) => [thKey(th), condTurnsByThr[thKey(th)]]));
  const condRatesPerPlayer = Object.fromEntries(thresholds.map((th) => [thKey(th), condTurnsByThr[thKey(th)] / nP]));

  const meanPath = fmean(pathLen);
  return {
    windowSec,
    nPlayers: ids.length,
    steps,
    effectiveSteps: effectiveSteps05,
    eligibleTurnPairs: eligiblePairs05,
    turn120OldTotal: turns,
    turn120CondTotal: condTurns05,
    turn120Old: turns / nP, // **每球员每窗**（对齐 discriminator-census 的 turn120PerWindow 口径）
    turn120Cond: condTurns05 / nP,
    turn120CondByThreshold: condRates, // 窗内总数（跨球员）
    turn120CondByThresholdPerPlayer: condRatesPerPlayer,
    turnsPerEffectiveStep: effectiveSteps05 ? condTurns05 / effectiveSteps05 : null,
    // ⚠️ 分子是**跨球员总数**、分母是**每球员均值**：必须先把分子除以 nP，
    // 否则会大 nP 倍（2026-11-19 审阅 P1；与 census 的 mean(turns)/mean(path) 对齐）。
    turnsPerMeter: meanPath > 1e-9 ? (turns / nP) / meanPath : null,
    condTurnsPerMeter: meanPath > 1e-9 ? (condTurns05 / nP) / meanPath : null,
    staticFrac: steps ? staticSteps / steps : null,
    staticFrac02: steps ? staticSteps02 / steps : null,
    staticFrac10: steps ? staticSteps10 / steps : null,
    pathLenPerPlayer: fmean(pathLen),
    dispPerWindow: fmean(disp),
    straight: fmean(straight),
    speedMean: fmean(speeds),
    speedP50: fquant(speeds, 0.5),
    speedP90: fquant(speeds, 0.9),
    speedP99: fquant(speeds, 0.99),
    accelP95: fquant(accels, 0.95),
    accelP99: fquant(accels, 0.99),
    rotationTurns: fmean(rotTurns),
    rotationPerMeter: meanPath > 1e-9 ? fmean(rotTurns) / meanPath : null,
    transitions: trans,
    ballStaticFrac: bs.length ? bs.filter((s) => s < 0.5).length / bs.length : null,
    ballStaticFrac02: bs.length ? bs.filter((s) => s < 0.2).length / bs.length : null,
    ballStaticFrac20: bs.length ? bs.filter((s) => s < 2.0).length / bs.length : null,
    ballTravel: ballPath,
    ballSpeedP50: fquant(bs, 0.5),
  };
}

// ── 4. 配对差与区间（逐窗配对，不跨窗拼接）──────────────────────────────────
const T975_23 = 2.0687; // t(0.975, df=23)
export function pairedDiff(a, b) {
  if (a.length !== b.length) throw new Error(`pairedDiff: 长度不一致 ${a.length} vs ${b.length}`);
  const d = a.map((x, i) => x - b[i]).filter((x) => Number.isFinite(x));
  if (!d.length) return { n: 0, mean: null, sd: null, lo: null, hi: null, min: null, max: null, median: null, nonZero: 0 };
  const mean = fmean(d); const sd = fsd(d); const half = T975_23 * (sd / Math.sqrt(d.length));
  return {
    n: d.length,
    mean,
    sd,
    lo: mean - half,
    hi: mean + half,
    min: Math.min(...d), max: Math.max(...d), median: fmedian(d),
    nonZero: d.filter((x) => Math.abs(x) > 1e-12).length,
  };
}

// 报告用的指标白名单（顺序即表格顺序）
export const REPORT_METRICS = [
  ['turn120Old', '旧 turn120 / 球员 / 窗'],
  ['turn120Cond', '条件 turn120 / 球员 / 窗（0.5 m/s）'],
  ['turnsPerEffectiveStep', '每有效步转向率'],
  ['staticFrac', 'staticFrac (<0.5 m/s)'],
  ['pathLenPerPlayer', '路径长 m / 球员'],
  ['speedP50', '速度 p50'],
  ['speedP90', '速度 p90'],
  ['speedP99', '速度 p99'],
  ['accelP95', '加速度 p95 (m/s²)'],
  ['accelP99', '加速度 p99 (m/s²)'],
  ['rotationTurns', '自转圈数 / 球员'],
  ['rotationPerMeter', '自转 / 米'],
  ['ballStaticFrac', 'ballStaticFrac (辅)'],
];

// ── 5. 出图（复用共享渲染器；只读）──────────────────────────────────────────
export function contactFramesOf(frames, t0, window = DEFAULT_WINDOW, n = 8) {
  const win = window.sec;
  const out = [];
  for (let c = 0; c < n; c += 1) {
    const target = round3(t0 + (c * win) / Math.max(1, n - 1));
    let best = frames[0]; let bd = Infinity;
    for (const f of frames) { const d = Math.abs(f.t - target); if (d < bd) { bd = d; best = f; } }
    out.push(best);
  }
  return out;
}

export function renderWindowImages(frames, t0, window = DEFAULT_WINDOW) {
  const contact = buildContactImage(contactFramesOf(frames, t0, window));
  const traj = buildTrajectoryImage(frames);
  return {
    contactPng: canvasToPngBuffer(contact.canvas),
    trajectoryPng: canvasToPngBuffer(traj.canvas),
  };
}

// ── 6. 冻结刺激集（A 交付物；B 复用）────────────────────────────────────────
// 引擎窗沿用 R7i 的 seed/t0（design D1）；真实数据只登记清单与哈希，缺失标 n/a。
export function windowsFromR7i(r7iJson) {
  const items = (r7iJson.items || []).filter((it) => it.source === 'engine');
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const id = `eng-${it.seed}-${Math.round(it.anchorFrac * 100)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, seed: it.seed, t0: it.t0, t1: it.t1, anchorFrac: it.anchorFrac });
  }
  out.sort((a, b) => (a.seed - b.seed) || (a.anchorFrac - b.anchorFrac));
  return out;
}

// 事件流确定性身份：整场流 + 每窗切片（切片 = t∈[t0,t1] 的事件，稳定顺序）。
export function eventSlices(events, windows) {
  const at = new Map();
  for (const w of windows) {
    const slice = events.filter((e) => e.t >= w.t0 && e.t <= w.t1);
    at.set(w.id, sha256(JSON.stringify(slice)));
  }
  return at;
}

export function sourceHashes(root = ROOT) {
  const files = [
    'engine/src/lib.rs',
    'engine/Cargo.toml',
    'viewer/config.js',
    'viewer/interpretation.js',
    'viewer/game.js',
    'viewer/match-metrics.js', // loadEngineFrames 的 sampleEngineFrames 在这里
    'viewer/protocol.js',
    'viewer/soft-canvas.js',
  ];
  const out = {};
  for (const f of files) out[f] = sha256(readFileSync(join(root, f)));
  return out;
}

// spec「源不一致时拒绝拼表」：只校验 wasm/事件流不够——viewer 源码变而 wasm 不变时，
// 消融/普查的读数也不可比。**硬错误**，不是警告（P1-7）。
export function assertStimulusSourcesMatch(stim, root = ROOT) {
  const recorded = stim && stim.viewer && stim.viewer.sourceHashes;
  if (!recorded || typeof recorded !== 'object' || Object.keys(recorded).length === 0) {
    throw new Error('stimulus.json 缺少 viewer.sourceHashes：没有源身份，拒绝拼表。');
  }
  const actual = sourceHashes(root);
  const problems = [];
  for (const [f, want] of Object.entries(recorded)) {
    if (!(f in actual)) { problems.push(`${f}: 不在本工具的源码跟踪清单里`); continue; }
    if (actual[f] !== want) problems.push(`${f}: 现 ${actual[f]} / 记录 ${want}`);
  }
  const unrecorded = Object.keys(actual).filter((f) => !(f in recorded));
  if (unrecorded.length) problems.push(`sourceHashes 缺少已跟踪文件: ${unrecorded.join(', ')}`);
  if (problems.length) {
    throw new Error('stimulus.json 的源码哈希与当前树不一致（源不同，拒绝拼表）：\n'
      + problems.map((p) => `  - ${p}`).join('\n'));
  }
  return { ok: true, checked: Object.keys(recorded).length };
}

// ── 7. 主流程（CLI 调用）──────────────────────────────────────────────────
function argOf(argv, name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
}

async function freezeAction(argv) {
  const { loadEngineWasm, simulateStream, ENGINE_DURATION_SEC } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
  const wasmPath = resolve(argOf(argv, 'wasm', join(ROOT, 'viewer/engine.wasm')));
  const r7iPath = argOf(argv, 'windows', null);
  const outDir = resolve(argOf(argv, 'out', join(ROOT, 'openspec/changes/p155-measurement-instrument/notes')));
  if (!r7iPath) throw new Error('freeze 需要 --windows <R7i windows.json>');
  const r7i = JSON.parse(readFileSync(resolve(r7iPath), 'utf8'));
  const windows = windowsFromR7i(r7i);
  const seeds = [...new Set(windows.map((w) => w.seed))].sort((a, b) => a - b);

  const wasmBytes = readFileSync(wasmPath);
  const { wasm, ok, message } = await loadEngineWasm(wasmPath);
  if (!ok) throw new Error(message || `加载 wasm 失败：${wasmPath}`);

  const perSeed = {};
  for (const seed of seeds) {
    const stream = simulateStream(wasm, seed, ENGINE_DURATION_SEC);
    const again = simulateStream(wasm, seed, ENGINE_DURATION_SEC);
    if (sha256(stream) !== sha256(again)) throw new Error(`seed ${seed}: 同输入两次事件流不一致（非确定性）`);
    const { events } = parseEventStream(stream);
    perSeed[seed] = {
      eventStreamSha256: sha256(stream),
      eventCount: events.length,
      durationSec: ENGINE_DURATION_SEC,
    };
    for (const w of windows.filter((x) => x.seed === seed)) {
      w.streamSha256 = perSeed[seed].eventStreamSha256;
      if (events[events.length - 1].t < w.t1) throw new Error(`seed ${seed}: 流长 ${events[events.length - 1].t} < 窗末 ${w.t1}`);
      w.eventCount = events.filter((e) => e.t >= w.t0 && e.t <= w.t1).length;
      w.sliceSha256 = eventSlices(events, [w]).get(w.id);
      w.phase = round3(w.t0 - Math.floor(w.t0 * 5) / 5);
    }
  }

  // 真实数据：清单 + 哈希；缺失标 n/a（不静默填 0）。
  const realDir = resolve(argOf(argv, 'real-dir', join(ROOT, 'viewer/data')));
  const real = {};
  for (const [key, file] of [['metrica-1', 'real-game-1.json'], ['metrica-2', 'real-game-2.json']]) {
    try {
      const b = readFileSync(join(realDir, file));
      real[key] = { path: join(realDir, file), bytes: b.length, sha256: sha256(b), license: 'Metrica sample-data: README 要求注明来源/负责任使用；未声明正式许可' };
    } catch {
      real[key] = { path: join(realDir, file), status: 'n/a', reason: '文件缺失（gitignored；不静默填 0）' };
    }
  }
  for (const key of ['skillcorner-10-even']) {
    real[key] = { status: 'n/a', reason: 'SkillCorner 20 场未下载（~1.8GB，本 change 不下载）；design D1 的 10 场偶数位留待有数据时补登记' };
  }

  const srcText = readFileSync(join(ROOT, 'engine/src/lib.rs'), 'utf8');
  const modelVersion = Number((srcText.match(/pub const MODEL_VERSION: u32 = (\d+);/) || [])[1]);
  const tickSeconds = Number((srcText.match(/pub const TICK_SECONDS: f64 = ([0-9.]+);/) || [])[1]);

  const stimulus = {
    version: 'p155-stimulus-v1',
    frozenAt: '2026-11-19',
    purpose: 'Change 0（GitHub #190）A 工作流：冻结刺激集；B 的 L1 审计/条件指标复用同一批输入。',
    engine: {
      // 仓内相对路径（不是绝对 worktree 路径）——否则换目录重建时 stimulus.json 不可比。
      wasmPath: relative(ROOT, wasmPath), wasmSha256: sha256(wasmBytes),
      buildCommand: '(cd engine && cargo build --target wasm32-unknown-unknown --release) && cp engine/target/wasm32-unknown-unknown/release/fm_engine.wasm viewer/engine.wasm',
      modelVersion, tickSeconds,
      durationSec: ENGINE_DURATION_SEC,
      config: { demo_mode: false, off_ball_movement_demo: true, match_duration_seconds: ENGINE_DURATION_SEC },
    },
    viewer: {
      configVersionComment: 'viewer/config.js 的 ?v= 版本在 index.html / import specifier 上；本表记录文件哈希',
      tickSeconds: viewerConfig.interpretation.tickSeconds,
      sourceHashes: sourceHashes(),
    },
    window: { ...DEFAULT_WINDOW },
    windows,
    perSeed,
    real,
    note: '事件流由本工具同一次运行内「模拟两次并比对哈希」自证确定性；wasm 哈希随注释行号变化，不是行为哨兵。',
  };

  mkdirSync(outDir, { recursive: true });
  const stimulusPath = join(outDir, 'stimulus.json');
  const stimulusText = `${JSON.stringify(stimulus, null, 2)}\n`;
  writeFileSync(stimulusPath, stimulusText);
  writeFileSync(join(outDir, 'stimulus.md'), stimulusMarkdown(stimulus));
  // 只列**环境无关**的身份：事件流切片。不含 stimulus.json 自身哈希（它含真实数据的绝对路径，
  // 换机器会变，不可比）。复现口径：同 wasm + 同 seed → 同 slice sha。
  const lines = [
    '# 逐窗事件切片 sha256（切片哈希环境无关，可由同 wasm + seed + 窗口重建）',
    '# ⚠️ 文件头的 engine.wasm.sha256 是**构建产物**哈希：随注释行号/工具链变化，不是行为哨兵；',
    '#    另一会话即使复现全部切片，也未必得到同一个 wasm 文件哈希（行为等价仍成立）。',
    '# 切片口径：该 seed 完整事件流中 t∈[t0,t1] 的事件，JSON.stringify 后取 sha256（稳定顺序）',
    `# engine.wasm.sha256 ${stimulus.engine.wasmSha256}`,
    `# window sec=${DEFAULT_WINDOW.sec} hz=${DEFAULT_WINDOW.hz} samples=${DEFAULT_WINDOW.samples} step=${DEFAULT_WINDOW.stepSec}`,
    ...windows.map((w) => `${w.sliceSha256}  ${w.id}  seed=${w.seed} t0=${w.t0} t1=${w.t1}`),
  ];
  writeFileSync(join(outDir, 'windows.sha256'), `${lines.join('\n')}\n`);
  console.log(`stimulus: ${stimulusPath}（${windows.length} 窗 / ${seeds.length} seeds）`);
}

function stimulusMarkdown(s) {
  const w = s.windows;
  return [
    '# 冻结刺激集（Change 0 / A）',
    '',
    `- 协议：\`${s.version}\`，冻结于 ${s.frozenAt}`,
    `- 引擎：wasm sha256 \`${s.engine.wasmSha256}\`；MODEL_VERSION=${s.engine.modelVersion}；TICK_SECONDS=${s.engine.tickSeconds}`,
    `- 构建：\`${s.engine.buildCommand}\`（从本 worktree 源码现构建；不拷旧实验产物）`,
    `- viewer：config.interpretation.tickSeconds=${s.viewer.tickSeconds}；源码哈希见 stimulus.json \`viewer.sourceHashes\``,
    '',
    '## 窗口',
    '',
    `- 窗长 ${s.window.sec}s、${s.window.hz}Hz、${s.window.samples} 帧（步长 ${s.window.stepSec}s，与 R7i windows.json 同相位：t0 + i×0.2）`,
    `- 引擎窗沿用 R7i 包（\`c1-trajectory-morphology-2026-10-30/acceptance-r7d48/windows.json\`）的 12 seed × 2 anchor 的 seed/t0；不重新选窗。`,
    '',
    '| # | id | seed | t0 | t1 | slice sha256 |',
    '|---:|---|---:|---:|---:|---|',
    ...w.map((x, i) => `| ${i + 1} | ${x.id} | ${x.seed} | ${x.t0} | ${x.t1} | \`${x.sliceSha256.slice(0, 16)}…\` |`),
    '',
    '## 真实侧（只登记，不作为 A 的消融输入）',
    '',
    ...Object.entries(s.real).map(([k, v]) => v.status === 'n/a'
      ? `- ${k}: **n/a** — ${v.reason}`
      : `- ${k}: \`${v.path}\`，${v.bytes} B，sha256 \`${v.sha256}\`；许可：${v.license}`),
    '',
    '## 复现',
    '',
    '```bash',
    'node tools/visual-review/render-ablation.mjs freeze --wasm viewer/engine.wasm \\',
    '  --windows <R7i windows.json> --out openspec/changes/p155-measurement-instrument/notes',
    '```',
    '',
    '同一环境同输入重跑：`stimulus.json` 与 `windows.sha256` 逐位一致（工具内已对每 seed 模拟两次比对流哈希）。',
    '',
    '⚠️ 可复现性边界：`windows.sha256` 的**切片哈希**环境无关；其文件头另列 wasm **构建产物**哈希',
    '（随注释行号/工具链变化，不是行为哨兵）。`stimulus.json` 里的 `real.*.path` 是本次机器上的',
    '真实数据绝对路径（数据本身 gitignored），换机器时该字段会不同，但 `real.*.sha256` 才是数据身份。',
    '',
  ].join('\n');
}

async function runAction(argv) {
  const { loadEngineWasm, simulateStream } = await import(join(ROOT, 'tools/benchmark-engine.mjs'));
  const wasmPath = resolve(argOf(argv, 'wasm', join(ROOT, 'viewer/engine.wasm')));
  const stimulusPath = resolve(argOf(argv, 'stimulus', join(ROOT, 'openspec/changes/p155-measurement-instrument/notes/stimulus.json')));
  const outDir = resolve(argOf(argv, 'out', join(ROOT, 'openspec/changes/p155-measurement-instrument/notes/ablation-out')));
  const imagesMode = argOf(argv, 'images', 'all');
  const stim = JSON.parse(readFileSync(stimulusPath, 'utf8'));
  assertStimulusSourcesMatch(stim); // 源码身份（engine/src/lib.rs + viewer/*.js）
  const wasmBytes = readFileSync(wasmPath);
  if (sha256(wasmBytes) !== stim.engine.wasmSha256) {
    throw new Error(`wasm 与 stimulus.json 不同源：现 ${sha256(wasmBytes)} / 记录 ${stim.engine.wasmSha256}。拒绝拼表。`);
  }
  const { wasm, ok, message } = await loadEngineWasm(wasmPath);
  if (!ok) throw new Error(message || `加载 wasm 失败：${wasmPath}`);

  mkdirSync(outDir, { recursive: true });
  const imageDir = join(outDir, 'images');
  if (imagesMode === 'all') mkdirSync(imageDir, { recursive: true });

  const bySeed = new Map();
  for (const w of stim.windows) {
    if (!bySeed.has(w.seed)) bySeed.set(w.seed, []);
    bySeed.get(w.seed).push(w);
  }

  const perWindow = [];
  const imageHashes = [];
  const t1Equivalence = {
    maxAbsDelta: 0, mismatchedFrames: 0, checkedFrames: 0,
    ballMismatchFrames: 0, coordMismatchFrames: 0, playerSetMismatchFrames: 0,
  };
  for (const [seed, wins] of [...bySeed.entries()].sort((a, b) => a[0] - b[0])) {
    const stream = simulateStream(wasm, seed, stim.engine.durationSec);
    if (sha256(stream) !== stim.perSeed[seed].eventStreamSha256) {
      throw new Error(`seed ${seed}: 事件流哈希与 stimulus.json 不符——源不同，拒绝继续`);
    }
    const { events, lineup } = parseEventStream(stream);
    const index = buildGameIndex(events, lineup, 'continuous');
    const samplers = Object.fromEntries(MODES.map((m) => [m,
      createFrameSampler(events, lineup, m, { index, tickSec: stim.engine.tickSeconds })]));
    for (const w of wins) {
      const framesByMode = {};
      const feats = {};
      for (const m of MODES) {
        const frames = sampleWindow(samplers[m], w.t0, { ...DEFAULT_WINDOW, ...stim.window });
        framesByMode[m] = frames;
        feats[m] = windowFeatures(frames, { windowSec: stim.window.sec });
        if (imagesMode === 'all') {
          const { contactPng, trajectoryPng } = renderWindowImages(frames, w.t0, stim.window);
          const cName = `${w.id}-${m}-contact.png`;
          const tName = `${w.id}-${m}-trajectory.png`;
          writeFileSync(join(imageDir, cName), contactPng);
          writeFileSync(join(imageDir, tName), trajectoryPng);
          imageHashes.push(`${sha256(contactPng)}  ${cName}`, `${sha256(trajectoryPng)}  ${tName}`);
        }
      }
      // 复刻自证：t1 应逐帧等于 current（t1 是「现行默认球员路径」的手写复刻）。
      // 若不等，说明复刻漏了 viewer 特判——报告必须写明，不能静默当等价。
      for (let i = 0; i < framesByMode.t1.length; i += 1) {
        const a = framesByMode.t1[i]; const b = framesByMode.current[i];
        t1Equivalence.checkedFrames += 1;
        let frameBad = false;
        if (a.ball.some((v, k) => Math.abs(v - b.ball[k]) > 1e-12)) {
          frameBad = true; t1Equivalence.ballMismatchFrames += 1;
        }
        const pb = new Map(b.players.map((p) => [p.id, p]));
        for (const p of a.players) {
          const q = pb.get(p.id);
          if (!q) { frameBad = true; t1Equivalence.playerSetMismatchFrames += 1; continue; }
          const d = Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y));
          if (d > t1Equivalence.maxAbsDelta) t1Equivalence.maxAbsDelta = d;
          if (d > 1e-12) { frameBad = true; t1Equivalence.coordMismatchFrames += 1; }
        }
        if (frameBad) t1Equivalence.mismatchedFrames += 1;
      }
      perWindow.push({ id: w.id, seed: w.seed, t0: w.t0, t1: w.t1, features: feats });
      const d = perWindow[perWindow.length - 1];
      d.lastSampleT = framesByMode.current[framesByMode.current.length - 1].t;
    }
  }

  // 配对差：逐层拆「viewer 锚点合成 / Catmull / T1 / 现行特判」，另留 direct 作采样伪影对照。
  const pairs = [
    ['linear', 'movers'], // viewer 把 pass/shot/tackle/... 演绎成锚点（beat 端点之外）
    ['catmull', 'linear'], ['t1', 'catmull'], ['current', 't1'],
    ['current', 'movers'], // viewer 全链（合成 + 插值 + 纹理）
    ['linear', 'direct'], // 采样方式伪影：零阶保持 vs 线性
    ['current', 'linear'],
  ];
  const diffs = {};
  for (const [a, b] of pairs) {
    diffs[`${a}-${b}`] = {};
    for (const [key] of REPORT_METRICS) {
      diffs[`${a}-${b}`][key] = pairedDiff(perWindow.map((x) => x.features[a][key]), perWindow.map((x) => x.features[b][key]));
    }
  }
  // t1 与 current 的逐帧一致性（复刻自证；也回答「现行链是否有 t1 之外的运动加工」）
  const result = {
    version: 'p155-ablation-v1',
    // 相对路径（换 checkout 不改变 JSON）——与 images.dir 同一理由。
    stimulus: { path: relative(ROOT, stimulusPath), wasmSha256: stim.engine.wasmSha256, window: stim.window },
    modes: MODES,
    metrics: REPORT_METRICS.map(([k, label]) => ({ key: k, label })),
    t1VsCurrent: t1Equivalence,
    perWindow,
    diffs,
    // 相对路径（不是绝对 out 目录）——否则同输入重跑时 ablation.json 会因输出目录不同而变。
    images: imagesMode === 'all' ? { dir: 'images', count: imageHashes.length / 2, manifest: 'images/images.sha256' } : { status: 'skipped' },
  };
  writeFileSync(join(outDir, 'ablation.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (imagesMode === 'all') writeFileSync(join(imageDir, 'images.sha256'), `${imageHashes.join('\n')}\n`);
  writeFileSync(join(outDir, 'ablation-report.md'), ablationMarkdown(result));
  console.log(`ablation: ${join(outDir, 'ablation.json')}（${perWindow.length} 窗 × ${MODES.length} 模式；`
    + `t1 vs current 最大差 ${t1Equivalence.maxAbsDelta.toExponential(2)}）`);
}

// 报告：逐窗配对差 + 区间。表格由数据生成；裁决段由人写（见 notes/ablation.md）。
export function ablationMarkdown(r) {
  const fmt = (v, d = 3) => (v == null || !Number.isFinite(v) ? 'n/a' : v.toFixed(d));
  const avg = (m, key, d = 3) => fmt(fmean(r.perWindow.map((x) => x.features[m][key]).filter(Number.isFinite)), d);
  const lines = [];
  lines.push('# 同流渲染消融：读数（自动生成）');
  lines.push('');
  lines.push(`- 协议：\`${r.version}\`；stimulus wasm \`${r.stimulus.wasmSha256.slice(0, 16)}…\``);
  lines.push(`- 窗：${r.perWindow.length} 个（12 seed × 2 anchor，24s @ 5Hz = 121 帧）`);
  lines.push('- 配对差 = 同窗前−后；区间为 24 窗均值的 t(0.975,23) 区间。逐窗配对，**不跨窗拼接**。');
  lines.push('- movers = 只用引擎 beat 的 main/movers 端点（拍内线性、拍外保持）；direct = 锚点零阶保持（采样伪影对照）；');
  lines.push('  linear→catmull→t1 逐层加 viewer 插值/纹理；current = 现行 viewer 全链。movers 模式的 ball* 仍用 viewer 球锚点，不是独立读数。');
  if (r.t1VsCurrent) {
    const e = r.t1VsCurrent;
    lines.push(`- 复刻自证：t1 与 current 逐帧比最大坐标差 ${e.maxAbsDelta.toExponential(2)}`
      + `（不一致帧 ${e.mismatchedFrames}/${e.checkedFrames}；球 ${e.ballMismatchFrames} / 坐标 ${e.coordMismatchFrames} / 人数 ${e.playerSetMismatchFrames}）`);
  }
  lines.push('');
  lines.push(`## 各模式均值（${r.perWindow.length} 窗）`);
  lines.push('');
  const metrics = r.metrics;
  lines.push(`| 指标 | ${r.modes.join(' | ')} |`);
  lines.push(`|---|${r.modes.map(() => '---:').join('|')}|`);
  for (const { key, label } of metrics) {
    lines.push(`| ${label} | ${r.modes.map((m) => avg(m, key)).join(' | ')} |`);
  }
  lines.push('');
  lines.push('## 逐窗配对差（均值 [t 区间]；非零窗数/窗数）');
  lines.push('');
  const pairs = Object.keys(r.diffs);
  lines.push(`| 指标 | ${pairs.join(' | ')} |`);
  lines.push(`|---|${pairs.map(() => '---:').join('|')}|`);
  for (const { key, label } of metrics) {
    const cells = pairs.map((p) => {
      const d = r.diffs[p][key];
      return `${fmt(d.mean)} [${fmt(d.lo)}, ${fmt(d.hi)}] (${d.nonZero}/${d.n})`;
    });
    lines.push(`| ${label} | ${cells.join(' | ')} |`);
  }
  lines.push('');
  lines.push('## 速度/加速度/静止分档（模式均值）');
  lines.push('');
  lines.push(`| 指标 | ${r.modes.join(' | ')} |`);
  lines.push(`|---|${r.modes.map(() => '---:').join('|')}|`);
  const extra = [
    ['staticFrac02', 'staticFrac (<0.2)'], ['staticFrac10', 'staticFrac (<1.0)'],
    ['speedMean', '速度均值'], ['accelP95', '加速度 p95'], ['accelP99', '加速度 p99'],
    ['turnsPerMeter', '旧 turn120 / 米'], ['condTurnsPerMeter', '条件 turn120 / 米'],
    ['ballTravel', '球程 m'], ['ballStaticFrac20', 'ballStaticFrac (<2.0)'],
    ['dispPerWindow', '端点位移 / 窗'],
  ];
  for (const [key, label] of extra) {
    lines.push(`| ${label} | ${r.modes.map((m) => avg(m, key)).join(' | ')} |`);
  }
  const th = Object.keys(r.perWindow[0].features.current.turn120CondByThresholdPerPlayer);
  lines.push('');
  lines.push('## 条件 turn120 门限敏感性（模式均值，每球员 / 窗）');
  lines.push('');
  lines.push(`| 门限 m/s | ${r.modes.join(' | ')} |`);
  lines.push(`|---|${r.modes.map(() => '---:').join('|')}|`);
  for (const t of th) {
    lines.push(`| ${t} | ${r.modes.map((m) => fmt(fmean(r.perWindow.map((x) => x.features[m].turn120CondByThresholdPerPlayer[t]).filter(Number.isFinite)))).join(' | ')} |`);
  }
  lines.push('');
  lines.push('## 逐窗明细（old/cond/static，均按每球员）');
  lines.push('');
  lines.push(`| 窗 | seed | t0 | ${r.modes.join(' | ')} |`);
  lines.push(`|---|---:|---:|${r.modes.map(() => '---:|').join('')}`);
  for (const x of r.perWindow) {
    const cells = r.modes.map((m) => {
      const f = x.features[m];
      return `${fmt(f.turn120Old, 2)}/${fmt(f.turn120Cond, 2)}/${fmt(f.staticFrac, 3)}`;
    });
    lines.push(`| ${x.id} | ${x.seed} | ${x.t0} | ${cells.join(' | ')} |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

// ── 8. CLI ────────────────────────────────────────────────────────────────
const IS_ENTRY = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (IS_ENTRY) {
  const action = process.argv[2];
  const argv = process.argv.slice(3);
  try {
    if (action === 'freeze') await freezeAction(argv);
    else if (action === 'run') await runAction(argv);
    else {
      console.error('用法：render-ablation.mjs freeze|run [options]（见文件头注释）');
      process.exit(2);
    }
  } catch (e) {
    console.error(`render-ablation: ${e.message}`);
    process.exit(1);
  }
}
