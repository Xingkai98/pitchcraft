// 运动普查（P155 Change 0 / B）：**条件 turn120 + 静止来源分解**。
//
// ── 为什么新建文件，而不是扩 motion-metrics.mjs ─────────────────────────────
// `motion-metrics.mjs` 的 `windowStats` 已被 `discriminator-census.mjs` / `like-football.mjs`
// 当作稳定 API 消费；在那里改口径会静默改写历史读数。本文件只新增纯函数，旧文件一行不动。
//
// ── 口径（逐条写死；报告必须带 n / seed / 窗长 / 采样率）───────────────────
// 输入统一帧：`{ t: 秒, players: [{id,x,y}], ball: [x,y]|null, pitchMeters?: [L,W] }`，
// x/y 归一化 [0,1]；id 语义 0=主队门将、21=客队门将、1-10 主队、11-20 客队。
//
// 1. **剔门将**（id 0/21）——与 match-metrics 同口径。
// 2. **逐窗算 → 对窗取分布**；本文件不跨窗拼接，也不把不同 seed 的步数池化。
// 3. **步（step）** = 相邻两帧同一球员的位移；步速 = |位移| / Δt（米/秒）。
// 4. **旧 turn120（兼容列）**：相邻两步方向差 > 120° 即计一次，**零步也调用 atan2**
//    （JS `atan2(0,0)=0`）。这是历史口径，保留作对照，不修正——修正会切断与旧普查
//    （`discriminator-census.mjs` 的 turn120PerWindow=5.885）的可比性。
// 5. **条件 turn120**：只有**相邻两步的步速都 ≥ 门限**时才计；主口径 0.5 m/s，
//    另报 0.3 / 1.0 两档。零步（左→停→左）因此不被计成大角转向。
// 6. **分母必须并列**：
//      - `effectivePairs[g]`   = 相邻两步都 ≥ g 的**步对**数（条件 turn120 的直接分母）
//      - `effectiveSteps[g]`   = 步速 ≥ g 的步数
//      - `effectivePathM[g]`   = 步速 ≥ g 的步的米制路径和
//      - `turnsPerEffectivePair` = Σturns / ΣeffectivePairs（窗内按球员求和，再逐窗平均）
//      - `turnsPerEffectiveStep` = Σturns / ΣeffectiveSteps
//      - `turnsPerMeter`         = Σturns / ΣeffectivePathM
//    三个分母都打印，禁止只给一个无分母比值。
// 7. **静止**：`staticFrac[g]` = 步速 < g 的步占比；档位 0.2/0.5/1.0。
//    `ballStaticFrac[g]` = 球相邻原始帧速度 < g 的步占比；档位 0.2/0.5/2.0（球 2.0）。
// 8. **转移**：按 0.5 m/s 把步分成 move / stop，对相邻步对计
//    move→stop / stop→move / move→move / stop→stop（含 stop→stop 供分母自证）。
// 9. **速度分位**：p50/p90/p99（R type-7，与 match-metrics.quantileSorted 同口径）；
//    **加速度尾部**：相邻两步的速度矢量差 / 平均 Δt（秒），报 p95/p99（m/s²）。
// 10. **方向对称性**：底/顶边各 8m 带的使用率与左/右半场使用率（有符号差）。
// 11. **采样缺口**：Δt ≤ 0 或 > `MAX_STEP_SEC`（默认 1.0s）视为不连续——该步不计，
//     且不与前后步组成步对（不跨缺口求方向差）。
// 11b. **外推点**：真实转换器把 SkillCorner 的补全球员点标为 `extrapolated`（p[2]===1）。
//     主口径**跳过**这些点（按缺帧处理：断开步/步对、不进对称性样本），与 design D3
//     「外推点按既有规则（真实侧默认跳过）」一致。`includeExtrapolated: true` 可复算旧口径。
// 12. **球静止来源分解**（`decomposeBallStatic`）：按**引擎事件流**给每个采样区间一个来源：
//      `carrier_hold` / `carrier_dribble` / `highlight_flight` / `loose` / `restart_dead`。
//      来源只由事件语义决定；**静止率仍按渲染帧的球速测**（与旧 ballStaticFrac 同帧口径）。
//      - `carrier_hold`：beat.main 的米制位移 < `HOLD_MAX_M`（1.0m）。依据：引擎 hold 分支
//        抖幅 = `TICK_SECONDS`（0.5）× 归一化 ±0.011 ⇒ x ≤0.58m、y ≤0.37m、合成 ≤0.69m；
//        普通带球每拍被 `CARRIER_SPEED_MS × TICK_SECONDS`(=2.5m) 截流 ⇒ d≥2.5m。
//        1.0m 在两簇之间，不靠“感觉”分界。
//      - `carrier_dribble`：beat.main 位移 ≥ `HOLD_MAX_M`。
//      - `highlight_flight`：pass / shot / tackle / kickoff 的飞行与高亮段。
//      - `loose`：beat.ball（松散球）段。
//      - `restart_dead`：出界/犯规/进球后的死球与重开准备段。
//      ⚠️ 本分解**不是**「球停在谁脚下」的物理归因，而是「事件状态 × 球速」的联合表；
//      carrier_hold 里仍有 >0.5 m/s 的抖动步（不当静止），报告同时给条件静止率而不是只给份额。
//
// ── 用法 ─────────────────────────────────────────────────────────────────
//   node tools/visual-review/motion-census.mjs <engine.wasm> [--seeds 42,1,7] [--window-sec 24]
//        [--active-only] [--out file.json]
//   node tools/visual-review/motion-census.mjs <engine.wasm> --stimulus <stimulus.json> [--out ...]
//        只跑 A 的冻结刺激集（逐 seed 校验事件流 SHA；不一致抛错）
//   node tools/visual-review/motion-census.mjs <engine.wasm> --windows <windows.json> [--out ...]
//        同一批 anchor 的 engine vs real（R7i windows.json；real 只算帧口径）
//   宽扫模式自动读 viewer/data/real-game-*.json（缺文件时真实列 n/a，退出码 0）。
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const PITCH_LENGTH_M = 105;
export const PITCH_WIDTH_M = 68;
export const KEEPER_IDS = [0, 21];
export const TURN_DEG = 120;
export const SPEED_GATES = [0.3, 0.5, 1.0];
export const CONDITION_GATE = 0.5;
export const STATIC_GATES = [0.2, 0.5, 1.0];
export const BALL_STATIC_GATES = [0.2, 0.5, 2.0];
export const MAX_STEP_SEC = 1.0;
export const EDGE_BAND_M = 8;
export const HOLD_MAX_M = 1.0;
export const BALL_SOURCES = ['carrier_hold', 'carrier_dribble', 'highlight_flight', 'loose', 'restart_dead'];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sum = (a) => a.reduce((x, y) => x + y, 0);

// R type-7 线性插值分位（与 viewer/match-metrics.js 的 quantileSorted 同口径）。
export function quantile(sorted, p) {
  const n = sorted.length;
  if (!n) return null;
  if (n === 1) return sorted[0];
  const h = (n - 1) * p;
  const i = Math.floor(h);
  if (i + 1 >= n) return sorted[n - 1];
  return sorted[i] + (h - i) * (sorted[i + 1] - sorted[i]);
}

const pitchOf = (frame, fallback = [PITCH_LENGTH_M, PITCH_WIDTH_M]) => {
  const pm = (frame && frame.pitchMeters) || fallback;
  return Array.isArray(pm) ? pm : [pm.length, pm.width];
};

// 归一化角差 → (−π, π]；atan2(0,0)=0 的零步语义由调用方保留（不在这里特判）。
export function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

// 单窗运动普查。返回窗口级标量（逐球员先算再对球员取均值；比率用窗内求和）。
export function censusOfWindow(frames, opts = {}) {
  const maxStepSec = opts.maxStepSec ?? MAX_STEP_SEC;
  const holdMaxM = opts.holdMaxM ?? HOLD_MAX_M;
  // 球相关量的主口径只用**原始球帧**（`ballFill == null`）；SkillCorner 的补全球位是启发式推断，
  // 与 match-metrics / ball-travel 同口径。引擎与 Metrica 无 fill，行为不变。
  const rawBallOnly = opts.rawBallOnly !== false;
  // 真实侧外推点默认跳过（design D3）；引擎帧没有该标记，行为不变。
  const includeExtrapolated = opts.includeExtrapolated === true;
  const isUsablePlayer = (p) => !!p && isNum(p.x) && isNum(p.y)
    && (includeExtrapolated || !p.extrapolated);
  const out = {
    nFrames: frames ? frames.length : 0,
    nPlayers: 0,
    nSteps: 0,
    turn120Old: null,
    conditional: {},
    staticFrac: {},
    transitions: null,
    speed: { p50: null, p90: null, p99: null, mean: null },
    accel: { p95: null, p99: null },
    symmetry: null,
    ball: { p50: null, p90: null, p99: null, meanSpeed: null, pathM: 0, nSteps: 0 },
  };
  if (!Array.isArray(frames) || frames.length < 2) return out;

  const pitch = pitchOf(frames[0], opts.pitchMeters);
  const [L, W] = pitch;
  const idSet = new Set();
  let skippedExtrapolatedPoints = 0;
  for (const f of frames) {
    for (const p of f.players || []) {
      if (!p || KEEPER_IDS.includes(p.id)) continue;
      if (!includeExtrapolated && p.extrapolated) { skippedExtrapolatedPoints += 1; continue; }
      if (!isNum(p.x) || !isNum(p.y)) continue;
      idSet.add(p.id);
    }
  }
  out.skippedExtrapolatedPoints = skippedExtrapolatedPoints;

  // 逐球员建连续步序列（跨缺口断开）。
  const speeds = [];
  const accels = [];
  const perPlayer = [];
  const symCount = { n: 0, bottom: 0, top: 0, left: 0, right: 0 };
  let allSteps = 0;

  for (const id of idSet) {
    const steps = [];
    let prev = null;
    for (const f of frames) {
      const p = (f.players || []).find((q) => q && q.id === id);
      if (!isUsablePlayer(p)) { prev = null; steps.push(null); continue; }
      const cur = { t: f.t, x: p.x * L, y: p.y * W };
      if (!prev) { steps.push(null); prev = cur; continue; }
      const dt = cur.t - prev.t;
      if (!(dt > 0) || dt > maxStepSec) { steps.push(null); prev = cur; continue; }
      const vx = (cur.x - prev.x) / dt;
      const vy = (cur.y - prev.y) / dt;
      const len = Math.hypot(cur.x - prev.x, cur.y - prev.y);
      steps.push({ dt, vx, vy, speed: Math.hypot(vx, vy), len, angle: Math.atan2(vy, vx) });
      prev = cur;
    }
    // 旧/条件转向、加速度：只对连续的两步（steps[k-1]、steps[k] 都非 null）计。
    let oldTurns = 0;
    const cond = Object.fromEntries(SPEED_GATES.map((g) => [g, { turns: 0, pairs: 0, steps: 0, pathM: 0 }]));
    let moveStop = 0; let stopMove = 0; let moveMove = 0; let stopStop = 0; let pairN = 0;
    for (let k = 1; k < steps.length; k += 1) {
      const b = steps[k];
      if (!b) continue;
      for (const g of SPEED_GATES) if (b.speed >= g) { cond[g].steps += 1; cond[g].pathM += b.len; }
      speeds.push(b.speed);
      allSteps += 1;
      const a = steps[k - 1];
      if (!a) continue;
      const dAng = Math.abs(wrapAngle(b.angle - a.angle)) * 180 / Math.PI;
      if (dAng > TURN_DEG) oldTurns += 1;
      for (const g of SPEED_GATES) {
        if (a.speed >= g && b.speed >= g) {
          cond[g].pairs += 1;
          if (dAng > TURN_DEG) cond[g].turns += 1;
        }
      }
      // 加速度尾部：速度矢量差 / 平均 Δt（秒；同口径两侧共用），单位 m/s²。
      const dtAvg = (a.dt + b.dt) / 2;
      if (dtAvg > 0) accels.push(Math.hypot(b.vx - a.vx, b.vy - a.vy) / dtAvg);
      // move/stop 转移（0.5 m/s）。
      const am = a.speed >= CONDITION_GATE; const bm = b.speed >= CONDITION_GATE;
      pairN += 1;
      if (am && !bm) moveStop += 1; else if (!am && bm) stopMove += 1;
      else if (am && bm) moveMove += 1; else stopStop += 1;
    }
    // 只计「至少有一个连续步」的球员：缺帧窗口里只出现一次的球员不应以 0 稀释每球员均值。
    if (steps.some((s) => s)) perPlayer.push({ id, oldTurns, cond, moveStop, stopMove, moveMove, stopStop, pairN });
  }

  out.nPlayers = perPlayer.length;
  out.nSteps = allSteps;
  out.turn120Old = perPlayer.length ? mean(perPlayer.map((p) => p.oldTurns)) : null;

  for (const g of SPEED_GATES) {
    const turns = sum(perPlayer.map((p) => p.cond[g].turns));
    const pairs = sum(perPlayer.map((p) => p.cond[g].pairs));
    const effSteps = sum(perPlayer.map((p) => p.cond[g].steps));
    const effPath = sum(perPlayer.map((p) => p.cond[g].pathM));
    out.conditional[g] = {
      turnsPerPlayer: perPlayer.length ? turns / perPlayer.length : null,
      effectivePairs: pairs,
      effectiveSteps: effSteps,
      effectivePathM: effPath,
      turnsPerEffectivePair: pairs ? turns / pairs : null,
      turnsPerEffectiveStep: effSteps ? turns / effSteps : null,
      turnsPerMeter: effPath > 0 ? turns / effPath : null,
    };
  }
  const sortedSpeeds = [...speeds].sort((a, b) => a - b);
  for (const g of STATIC_GATES) {
    out.staticFrac[g] = allSteps ? speeds.filter((v) => v < g).length / allSteps : null;
  }
  const tr = perPlayer.reduce((acc, p) => {
    acc.moveStop += p.moveStop; acc.stopMove += p.stopMove;
    acc.moveMove += p.moveMove; acc.stopStop += p.stopStop; acc.n += p.pairN;
    return acc;
  }, { moveStop: 0, stopMove: 0, moveMove: 0, stopStop: 0, n: 0 });
  out.transitions = {
    moveStop: tr.moveStop, stopMove: tr.stopMove, moveMove: tr.moveMove, stopStop: tr.stopStop,
    n: tr.n,
    moveStopShare: tr.n ? tr.moveStop / tr.n : null,
    stopMoveShare: tr.n ? tr.stopMove / tr.n : null,
    moveMoveShare: tr.n ? tr.moveMove / tr.n : null,
    stopStopShare: tr.n ? tr.stopStop / tr.n : null,
  };
  out.speed = {
    p50: quantile(sortedSpeeds, 0.5), p90: quantile(sortedSpeeds, 0.9), p99: quantile(sortedSpeeds, 0.99),
    mean: mean(speeds),
  };
  const sortedAcc = [...accels].sort((a, b) => a - b);
  out.accel = { p95: quantile(sortedAcc, 0.95), p99: quantile(sortedAcc, 0.99) };

  // 方向对称性：按球员-帧样本计（非门将）。
  for (const f of frames) {
    for (const p of f.players || []) {
      if (!p || KEEPER_IDS.includes(p.id) || !isUsablePlayer(p)) continue;
      const xm = p.x * L; const ym = p.y * W;
      symCount.n += 1;
      if (ym < EDGE_BAND_M) symCount.bottom += 1;
      if (ym > W - EDGE_BAND_M) symCount.top += 1;
      if (xm < L / 2) symCount.left += 1; else symCount.right += 1;
    }
  }
  out.symmetry = symCount.n ? {
    bottomShare: symCount.bottom / symCount.n,
    topShare: symCount.top / symCount.n,
    bottomMinusTop: (symCount.bottom - symCount.top) / symCount.n,
    leftShare: symCount.left / symCount.n,
    rightShare: symCount.right / symCount.n,
    leftMinusRight: (symCount.left - symCount.right) / symCount.n,
    n: symCount.n,
  } : null;

  // 球：只用相邻的两帧都有球位的连续区间；缺口断开。
  const ballSpeeds = []; let ballPath = 0; let ballSteps = 0;
  let bp = null;
  for (const f of frames) {
    const b = f && f.ball;
    if (!b || !isNum(b[0]) || !isNum(b[1]) || (rawBallOnly && f.ballFill != null)) { bp = null; continue; }
    const cur = { t: f.t, x: b[0] * L, y: b[1] * W };
    if (bp) {
      const dt = cur.t - bp.t;
      if (dt > 0 && dt <= maxStepSec) {
        const d = Math.hypot(cur.x - bp.x, cur.y - bp.y);
        ballPath += d; ballSteps += 1; ballSpeeds.push(d / dt);
      }
    }
    bp = cur;
  }
  const sortedBall = [...ballSpeeds].sort((a, b) => a - b);
  out.ball = {
    p50: quantile(sortedBall, 0.5), p90: quantile(sortedBall, 0.9), p99: quantile(sortedBall, 0.99),
    meanSpeed: mean(ballSpeeds), pathM: ballPath, nSteps: ballSteps,
  };
  for (const g of BALL_STATIC_GATES) {
    out.ballStaticFrac = out.ballStaticFrac || {};
    out.ballStaticFrac[g] = ballSteps ? ballSpeeds.filter((v) => v < g).length / ballSteps : null;
  }
  return out;
}

// 时间窗切分：**只取完整窗**（t0 + win ≤ 末帧 + 容差），步长默认 = 窗长。
// ⚠️ 121 帧含两端点 ⇒ 相邻窗**共享边界帧**（该帧在左窗是终点、在前一窗是起点）；
// **步不重复计**，但按帧计数的量（方向对称性）会多约 1/121≈0.8%。
export function cutTimeWindows(frames, { windowSec = 24, stepSec = null } = {}) {
  if (!Array.isArray(frames) || frames.length < 2) return [];
  const step = stepSec ?? windowSec;
  const t0 = frames[0].t; const tEnd = frames[frames.length - 1].t;
  const out = [];
  for (let t = t0; t + windowSec <= tEnd + 1e-9; t += step) {
    const w = frames.filter((f) => f.t >= t - 1e-9 && f.t <= t + windowSec + 1e-9);
    if (w.length >= 2) out.push({ t0: t, t1: t + windowSec, frames: w });
  }
  return out;
}

// 逐窗普查 → 窗级数组。**不跨窗拼接**：每个窗单独 census，返回数组由调用方汇总。
export function censusWindows(frames, { windowSec = 24, stepSec = null } = {}) {
  return cutTimeWindows(frames, { windowSec, stepSec }).map((w) => ({ t0: w.t0, t1: w.t1, ...censusOfWindow(w.frames) }));
}

// 对窗级标量取分布：均值/中位/p10/p90/n。嵌套对象递归；数组不汇总（本工具不产数组）。
// ⚠️ 这是「逐窗算 → 对窗取分布」，不是把步池化后重算。
export function summarizeCensus(rows) {
  const vals = (list) => list.filter((v) => v != null && Number.isFinite(v));
  const summarize = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return {
      n: s.length, mean: mean(s), median: quantile(s, 0.5), p10: quantile(s, 0.1), p90: quantile(s, 0.9),
    };
  };
  const walk = (objs) => {
    if (!objs.length) return null;
    const first = objs[0];
    if (typeof first === 'number' || first === null) {
      const v = vals(objs);
      return v.length ? summarize(v) : null;
    }
    if (Array.isArray(first)) return null;
    if (first && typeof first === 'object') {
      const out = {};
      for (const k of Object.keys(first)) out[k] = walk(objs.map((o) => (o ? o[k] : null)));
      return out;
    }
    return null;
  };
  return walk(rows);
}

// ── 球静止来源分解 ───────────────────────────────────────────────────────

// 事件飞行时长（秒）：距离/速度；字段缺失时退回 0.5s（= 一拍）——只用于把出界/进球的
// 「飞行」与「死球」分开，字段完整时不会走 fallback。
const flightSeconds = (e) => {
  const x = isNum(e.x) ? e.x : null; const y = isNum(e.y) ? e.y : null;
  const x2 = isNum(e.x2) ? e.x2 : null; const y2 = isNum(e.y2) ? e.y2 : null;
  const speed = isNum(e.speed) && e.speed > 0 ? e.speed : null;
  if (x == null || y == null || x2 == null || y2 == null || !speed) return 0.5;
  const d = Math.hypot((x2 - x) * PITCH_LENGTH_M, (y2 - y) * PITCH_WIDTH_M);
  return d / speed;
};

// 事件 → 相位时间线。返回按时间排序的 `{ t, phase, why }`；同 t 时**动作事件覆盖 beat**
// （排序上 beat 先、动作后；这样飞行不会被同拍的 beat 误判为持球）。
export function phaseTimeline(events, { holdMaxM = HOLD_MAX_M } = {}) {
  // 同 t 排序：**动作事件（prio=1）覆盖 beat（prio=0）**，因为动作描述该时刻开始的高亮；
  // 而 beat（carrier/loose）只在没有动作的拍上成立。动作之后**预约**的 restart（如出界飞行结束）
  // 用 prio=0：同 t 若真有 beat.main（接球者上线）则让 beat 覆盖，避免把已恢复的比赛误判为死球。
  const prio = { lineup: 0, whistle: 0, kickoff: 1, pass: 1, shot: 1, tackle: 1, foul: 1, beat: 0 };
  const entries = [];
  events.forEach((e, i) => {
    const t = e.t;
    if (!isNum(t)) return;
    const type = e.type;
    if (type === 'pass') {
      const out = e.result === 'out' || (typeof e.detail === 'string' && e.detail.startsWith('out_'));
      entries.push({ t, phase: 'highlight_flight', why: `pass${out ? ':out' : ''}`, prio: prio.pass, i });
      if (out) entries.push({ t: t + flightSeconds(e), phase: 'restart_dead', why: 'pass:out+flight', prio: 0, i });
    } else if (type === 'shot') {
      entries.push({ t, phase: 'highlight_flight', why: 'shot', prio: prio.shot, i });
      if (e.result === 'goal') entries.push({ t: t + flightSeconds(e), phase: 'restart_dead', why: 'goal+flight', prio: 0, i });
    } else if (type === 'tackle') {
      entries.push({ t, phase: 'highlight_flight', why: 'tackle', prio: prio.tackle, i });
    } else if (type === 'kickoff') {
      entries.push({ t, phase: 'highlight_flight', why: 'kickoff', prio: prio.kickoff, i });
    } else if (type === 'foul') {
      entries.push({ t, phase: 'restart_dead', why: 'foul', prio: prio.foul, i });
    } else if (type === 'whistle' || type === 'lineup') {
      entries.push({ t, phase: 'restart_dead', why: type, prio: prio[type], i });
    } else if (type === 'beat') {
      if (e.main && isNum(e.main.x) && isNum(e.main.y) && isNum(e.main.x2) && isNum(e.main.y2)) {
        const d = Math.hypot((e.main.x2 - e.main.x) * PITCH_LENGTH_M, (e.main.y2 - e.main.y) * PITCH_WIDTH_M);
        entries.push({
          t, phase: d < holdMaxM ? 'carrier_hold' : 'carrier_dribble',
          why: `main:${d.toFixed(2)}m`, prio: prio.beat, i,
        });
      } else if (e.ball) {
        entries.push({ t, phase: 'loose', why: 'beat.ball', prio: prio.beat, i });
      }
      // 高亮中的 beat（无 main/ball）不重置相位：飞行/死球继续。
    }
  });
  entries.sort((a, b) => (a.t - b.t) || (a.prio - b.prio) || (a.i - b.i));
  return entries.map(({ t, phase, why }) => ({ t, phase, why }));
}

// 相位查询：最后一个 t ≤ time 的 entry；早于首 entry → restart_dead。
export function phaseAt(timeline, time) {
  let lo = 0; let hi = timeline.length - 1; let ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (timeline[m].t <= time + 1e-9) { ans = m; lo = m + 1; } else hi = m - 1;
  }
  return ans < 0 ? 'restart_dead' : timeline[ans].phase;
}

// 球速区间（渲染帧口径）：相邻原始球帧的连续段 `{ t0, t1, speed }`；缺口处断开。
export function ballSpeedIntervals(frames, { maxStepSec = MAX_STEP_SEC } = {}) {
  const out = [];
  let prev = null;
  for (const f of frames || []) {
    const b = f && f.ball;
    // 分解只服务引擎事件流（引擎无 ballFill）；仍按原始球帧断开，避免将来接 SkillCorner 时混口径。
    if (!b || !isNum(b[0]) || !isNum(b[1]) || f.ballFill != null) { prev = null; continue; }
    const pitch = pitchOf(f); const cur = { t: f.t, x: b[0] * pitch[0], y: b[1] * pitch[1] };
    if (prev) {
      const dt = cur.t - prev.t;
      if (dt > 0 && dt <= maxStepSec) {
        const speed = Math.hypot(cur.x - prev.x, cur.y - prev.y) / dt;
        out.push({ t0: prev.t, t1: cur.t, speed });
      }
    }
    prev = cur;
  }
  return out;
}

// 把区间按相位时间线切开：返回 `{ t0, t1, dt, phase, speed, static }`（static 按 staticMs）。
export function classifyBallIntervals(frames, events, { staticMs = CONDITION_GATE, holdMaxM = HOLD_MAX_M, maxStepSec = MAX_STEP_SEC } = {}) {
  const timeline = phaseTimeline(events, { holdMaxM });
  const intervals = ballSpeedIntervals(frames, { maxStepSec });
  const out = [];
  for (const iv of intervals) {
    const cuts = [iv.t0];
    for (const e of timeline) if (e.t > iv.t0 + 1e-9 && e.t < iv.t1 - 1e-9) cuts.push(e.t);
    cuts.push(iv.t1);
    for (let k = 1; k < cuts.length; k += 1) {
      const a = cuts[k - 1]; const b = cuts[k];
      if (!(b > a)) continue;
      out.push({ t0: a, t1: b, dt: b - a, phase: phaseAt(timeline, a + 1e-9), speed: iv.speed, static: iv.speed < staticMs });
    }
  }
  return out;
}

// 对一段区间（可裁剪到窗）按来源汇总时间权重 / 条件静止率 / 对总静止的贡献。
export function aggregateDecomposition(intervals, { t0 = -Infinity, t1 = Infinity } = {}) {
  const sources = Object.fromEntries(BALL_SOURCES.map((k) => [k, { timeSec: 0, staticSec: 0, n: 0 }]));
  let totalTime = 0; let totalStatic = 0;
  for (const iv of intervals) {
    const a = Math.max(iv.t0, t0); const b = Math.min(iv.t1, t1);
    const dt = b - a;
    if (!(dt > 0)) continue;
    const s = sources[iv.phase] || (sources[iv.phase] = { timeSec: 0, staticSec: 0, n: 0 });
    s.timeSec += dt; s.n += 1;
    totalTime += dt;
    if (iv.static) { s.staticSec += dt; totalStatic += dt; }
  }
  const out = {};
  for (const k of Object.keys(sources)) {
    const s = sources[k];
    out[k] = {
      timeSec: s.timeSec,
      timeShare: totalTime > 0 ? s.timeSec / totalTime : null,
      staticRate: s.timeSec > 0 ? s.staticSec / s.timeSec : null,
      staticSec: s.staticSec,
      staticContribution: totalStatic > 0 ? s.staticSec / totalStatic : null,
      nIntervals: s.n,
    };
  }
  return {
    totalTimeSec: totalTime,
    totalStaticSec: totalStatic,
    ballStaticFrac: totalTime > 0 ? totalStatic / totalTime : null,
    sources: out,
  };
}

export function decomposeBallStatic(frames, events, opts = {}) {
  const intervals = classifyBallIntervals(frames, events, opts);
  return { ...aggregateDecomposition(intervals), nIntervals: intervals.length };
}

// 逐窗分解：每个窗单独裁剪汇总（不跨窗拼接），返回窗级数组。
export function decomposeWindows(frames, events, { windowSec = 24, stepSec = null, ...opts } = {}) {
  const intervals = classifyBallIntervals(frames, events, opts);
  return cutTimeWindows(frames, { windowSec, stepSec }).map((w) => ({
    t0: w.t0, t1: w.t1, ...aggregateDecomposition(intervals, { t0: w.t0, t1: w.t1 }),
  }));
}

// ── CLI 驱动 ─────────────────────────────────────────────────────────────
const IS_ENTRY = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

function argOf(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
}

function fmt(v, d = 3) { return v == null || !Number.isFinite(v) ? 'n/a' : v.toFixed(d); }
const pct = (v) => (v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`);

// 逐场先汇总（每场等权），再跨场取均值——避免「窗多的场」压过「窗少的场」。
function perMatchMean(rowsByMatch) {
  const keys = {};
  const collect = (obj, path, bag) => {
    for (const [k, v] of Object.entries(obj)) {
      const p = path ? `${path}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) collect(v, p, bag);
      else if (typeof v === 'number' && Number.isFinite(v)) (bag[p] = bag[p] || []).push(v);
    }
  };
  const bags = {};
  for (const rows of rowsByMatch) {
    const bag = {};
    for (const r of rows) collect(r, '', bag);
    for (const [p, vals] of Object.entries(bag)) (bags[p] = bags[p] || []).push(mean(vals));
  }
  for (const [p, vals] of Object.entries(bags)) keys[p] = mean(vals);
  return keys;
}

// A 工作流的冻结刺激集（`notes/stimulus.json`）：逐窗测量，事件流 SHA 必须与 A 记录一致。
// 这是 B 与 A 的唯一共同输入；不一致就抛错（spec「源不一致时拒绝拼表」）。
async function runStimulus(wasmPath, stimulusPath, outPath) {
  const { loadEngineFrames } = await import(join(ROOT, 'tools/visual-review/replay-blind-core.mjs'));
  const sha256 = (x) => createHash('sha256').update(x).digest('hex');
  const stim = JSON.parse(readFileSync(stimulusPath, 'utf8'));
  // 源码身份硬校验（engine/src/lib.rs + viewer/*.js）：viewer 改而 wasm 不变时读数不可比。
  // 与 render-ablation 共用同一实现，避免两份清单漂移。
  const { assertStimulusSourcesMatch } = await import(join(ROOT, 'tools/visual-review/render-ablation.mjs'));
  assertStimulusSourcesMatch(stim);
  const wasmSha = sha256(readFileSync(wasmPath));
  const wasmMatches = !stim.engine?.wasmSha256 || wasmSha === stim.engine.wasmSha256;
  // 逐 seed 加载 → 算完该 seed 的窗 → 释放（12 场 × 27k 帧同时驻留会 OOM）。
  const windowsBySeed = new Map();
  for (const w of stim.windows || []) {
    const seedKey = Number(w.seed); // 兼容 stimulus 把 seed 写成字符串
    if (!windowsBySeed.has(seedKey)) windowsBySeed.set(seedKey, []);
    windowsBySeed.get(seedKey).push(w);
  }
  const rows = []; const decRows = []; const frameCounts = []; const eventShaBySeed = {};
  for (const [seedStr, meta] of Object.entries(stim.perSeed || {})) {
    const seed = Number(seedStr);
    const wins = windowsBySeed.get(seed) || [];
    if (!wins.length) continue;
    const src = await loadEngineFrames(wasmPath, seed, stim.engine?.durationSec ?? 5400, { sampleStepSec: stim.window?.stepSec ?? 0.2 });
    const got = sha256(src.eventJson);
    if (meta.eventStreamSha256 && got !== meta.eventStreamSha256) {
      throw new Error(`事件流 SHA 与 A 的 stimulus.json 不一致（seed=${seed}）：got ${got} want ${meta.eventStreamSha256}。拒绝拼表。`);
    }
    eventShaBySeed[seed] = got;
    const events = JSON.parse(src.eventJson);
    for (const w of wins) {
      const frames = src.frames.filter((f) => f.t >= w.t0 - 1e-9 && f.t <= w.t1 + 1e-9);
      frameCounts.push({ id: w.id, frames: frames.length });
      rows.push({ id: w.id, seed: w.seed, t0: w.t0, ...censusOfWindow(frames) });
      decRows.push({ id: w.id, seed: w.seed, t0: w.t0, ...decomposeBallStatic(frames, events, { staticMs: CONDITION_GATE }) });
    }
  }
  if (!rows.length) throw new Error(`stimulus 的 ${stim.windows?.length ?? 0} 个窗没有匹配到任何 perSeed（检查 seed 类型/键名）`);
  const expectedFrames = Math.round((stim.window?.sec ?? 24) / (stim.window?.stepSec ?? 0.2)) + 1;
  const badFrames = frameCounts.filter((x) => x.frames !== expectedFrames);
  if (badFrames.length) console.warn(`⚠ ${badFrames.length}/${frameCounts.length} 个窗帧数 != ${expectedFrames}：`, badFrames.slice(0, 5));
  rows.sort((a, b) => a.id.localeCompare(b.id));
  decRows.sort((a, b) => a.id.localeCompare(b.id));
  frameCounts.sort((a, b) => a.id.localeCompare(b.id));
  const c = summarizeCensus(rows);
  const d = summarizeCensus(decRows);
  const fmt = (v, n = 3) => (v == null || !Number.isFinite(v) ? 'n/a' : v.toFixed(n));
  const pct = (v) => (v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
  console.log('═══ 运动普查（A 冻结刺激集）═══');
  console.log(`stimulus=${stimulusPath}  wasm=${wasmPath}`);
  console.log(`wasm SHA ${wasmSha}${wasmMatches ? ' == stimulus (match)' : ' != stimulus (WARN: 事件流才是行为哨兵)'}`);
  console.log(`seeds=${Object.keys(stim.perSeed || {}).join(',')}  窗=${rows.length}（${stim.window?.sec ?? 24}s @ ${stim.window?.hz ?? 5}Hz）`);
  console.log(`帧数检查：${[...new Set(frameCounts.map((x) => x.frames))].join(',')} 帧/窗（应 121）`);
  console.log('');
  console.log(`[转向] 旧 turn120 ${fmt(c.turn120Old?.mean)}/球员/窗  条件 @0.5 ${fmt(c.conditional?.['0.5']?.turnsPerPlayer?.mean)}` +
    `  有效步对 ${fmt(c.conditional?.['0.5']?.effectivePairs?.mean, 1)}  每有效步对 ${fmt(c.conditional?.['0.5']?.turnsPerEffectivePair?.mean, 4)}` +
    `  每米 ${fmt(c.conditional?.['0.5']?.turnsPerMeter?.mean, 4)}`);
  for (const g of SPEED_GATES) console.log(`  @${g}: 条件 ${fmt(c.conditional?.[g]?.turnsPerPlayer?.mean)}  每有效步对 ${fmt(c.conditional?.[g]?.turnsPerEffectivePair?.mean, 4)}`);
  console.log(`[静止] staticFrac <0.5 ${pct(c.staticFrac?.['0.5']?.mean)}  ballStaticFrac <0.5 ${pct(c.ballStaticFrac?.['0.5']?.mean)}`);
  console.log(`[速度] p50 ${fmt(c.speed?.p50?.mean, 2)}  p90 ${fmt(c.speed?.p90?.mean, 2)}  加速度 p95 ${fmt(c.accel?.p95?.mean, 2)}`);
  console.log('[球静止来源]');
  for (const k of BALL_SOURCES) {
    const s = d.sources?.[k];
    console.log(`  ${k.padEnd(17)} 时间 ${pct(s?.timeShare?.mean)}  静止率 ${pct(s?.staticRate?.mean)}  贡献 ${pct(s?.staticContribution?.mean)}`);
  }
  console.log(`  合计 ballStaticFrac ${pct(d.ballStaticFrac?.mean)}`);
  const payload = {
    generatedAt: new Date().toISOString(),
    stimulusPath, wasmPath, wasmSha256: wasmSha, wasmShaMatches: wasmMatches,
    caliber: { windowSec: stim.window?.sec, sampleHz: stim.window?.hz, activeOnly: false, includeExtrapolated: false, speedGates: SPEED_GATES, staticGates: STATIC_GATES, ballStaticGates: BALL_STATIC_GATES, holdMaxM: HOLD_MAX_M, maxStepSec: MAX_STEP_SEC },
    eventShaBySeed,
    frameCounts,
    windows: rows.map((r) => ({ ...r, decomposition: decRows.find((d2) => d2.id === r.id) })),
    summary: { census: c, decomposition: d },
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`\nJSON → ${outPath}`);
}

// R7i 式「同一批锚点」：windows.json 同时含 engine 与 real 窗（同一 t0/窗长），
// 用 canonicalWindow 取同一批帧；真实侧只算帧口径（无事件分解）。这是 A 的 stimulus 之外、
// 但**同一批 anchor** 的对照，用于给出 A 留作「待 B」的真实条件 turn120。
async function runWindows(wasmPath, windowsPath, outPath) {
  const { loadEngineFrames, loadRealFrames, canonicalWindow } = await import(join(ROOT, 'tools/visual-review/replay-blind-core.mjs'));
  const W = JSON.parse(readFileSync(windowsPath, 'utf8'));
  const winSec = W.window?.sec ?? 24;
  const step = W.window?.canonical_step_sec ?? 0.2;
  const cut = (src, t0) => canonicalWindow(src.frames, t0, { windowSec: winSec, canonicalStepSec: step })
    .map((s) => s.frame).filter(Boolean);
  const rowsE = []; const rowsR = []; const decE = []; const eventShaBySeed = {};
  const sha256 = (x) => createHash('sha256').update(x).digest('hex');
  const wasmSha256 = sha256(readFileSync(wasmPath));
  // 逐 seed / 逐真实文件加载 → 算完即释放（12 场 × 27k 帧同时驻留会 OOM）。
  const engItems = (W.items || []).filter((x) => x.source === 'engine');
  const bySeed = new Map();
  for (const it of engItems) {
    if (!bySeed.has(it.seed)) bySeed.set(it.seed, []);
    bySeed.get(it.seed).push(it);
  }
  for (const [seed, items] of bySeed) {
    const src = await loadEngineFrames(wasmPath, seed, 5400, { sampleStepSec: step });
    eventShaBySeed[seed] = sha256(src.eventJson);
    const events = JSON.parse(src.eventJson);
    for (const it of items) {
      const frames = cut(src, it.t0);
      rowsE.push({ id: it.id, seed, t0: it.t0, ...censusOfWindow(frames) });
      decE.push({ id: it.id, seed, t0: it.t0, ...decomposeBallStatic(frames, events, { staticMs: CONDITION_GATE }) });
    }
  }
  const realItems = (W.items || []).filter((x) => x.source === 'real');
  const byKey = new Map();
  for (const it of realItems) {
    if (!byKey.has(it.framesKey)) byKey.set(it.framesKey, []);
    byKey.get(it.framesKey).push(it);
  }
  for (const [, items] of byKey) {
    const src = loadRealFrames(items[0].path, { pitchMeters: items[0].pitchMeters });
    for (const it of items) {
      const frames = cut(src, it.t0);
      rowsR.push({ id: it.id, framesKey: it.framesKey, t0: it.t0, ...censusOfWindow(frames) });
    }
  }
  rowsE.sort((a, b) => a.id.localeCompare(b.id));
  rowsR.sort((a, b) => a.id.localeCompare(b.id));
  decE.sort((a, b) => a.id.localeCompare(b.id));
  const expectedFrames = Math.round(winSec / step) + 1;
  const badFrames = [...rowsE, ...rowsR].filter((r) => r.nFrames !== expectedFrames);
  if (badFrames.length) console.warn(`⚠ ${badFrames.length}/${rowsE.length + rowsR.length} 个窗帧数 != ${expectedFrames}：`, badFrames.slice(0, 5).map((r) => ({ id: r.id, nFrames: r.nFrames })));
  const cE = summarizeCensus(rowsE); const cR = summarizeCensus(rowsR); const dE = summarizeCensus(decE);
  const fmt = (v, n = 3) => (v == null || !Number.isFinite(v) ? 'n/a' : v.toFixed(n));
  const pct = (v) => (v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
  console.log('═══ 运动普查（同一批锚点：engine vs real）═══');
  console.log(`windows=${windowsPath}  wasm=${wasmPath}`);
  console.log(`engine 窗 ${rowsE.length}  real 窗 ${rowsR.length}  ${winSec}s@${(1 / step).toFixed(0)}Hz (${Math.round(winSec / step) + 1} 帧)`);
  console.log('外推点：真实侧跳过（SkillCorner `extrapolated`；design D3 主口径）');
  console.log('');
  const getPath = (o, path) => path.split('/').reduce((v, k) => (v == null ? null : v[k]), o);
  const r = (label, key, n = 3, suffix = '') => {
    const e = getPath(cE, key)?.mean; const rr = getPath(cR, key)?.mean;
    const ratio = rr ? `${(e / rr).toFixed(1)}×` : '—';
    console.log(`  ${label.padEnd(20)} 引擎 ${fmt(e, n).padStart(8)}${suffix}  真实 ${fmt(rr, n).padStart(8)}${suffix}  E/R ${ratio}`);
  };
  console.log('[转向]');
  r('旧 turn120', 'turn120Old');
  for (const g of SPEED_GATES) r(`条件 @${g}`, `conditional/${g}/turnsPerPlayer`);
  console.log(`  有效步对 引擎 ${fmt(getPath(cE, 'conditional/0.5/effectivePairs')?.mean, 1)}  真实 ${fmt(getPath(cR, 'conditional/0.5/effectivePairs')?.mean, 1)}`);
  console.log(`  每有效步对 引擎 ${fmt(getPath(cE, 'conditional/0.5/turnsPerEffectivePair')?.mean, 4)}  真实 ${fmt(getPath(cR, 'conditional/0.5/turnsPerEffectivePair')?.mean, 4)}`);
  console.log(`  每米       引擎 ${fmt(getPath(cE, 'conditional/0.5/turnsPerMeter')?.mean, 4)}  真实 ${fmt(getPath(cR, 'conditional/0.5/turnsPerMeter')?.mean, 4)}`);
  console.log('[静止]');
  for (const g of STATIC_GATES) r(`staticFrac <${g}`, `staticFrac/${g}`, 4);
  for (const g of BALL_STATIC_GATES) r(`ballStaticFrac <${g}`, `ballStaticFrac/${g}`, 4);
  console.log('[速度]');
  r('速度 p50', 'speed/p50', 2); r('速度 p90', 'speed/p90', 2);
  r('加速度 p95', 'accel/p95', 2);
  console.log('[球静止来源] 引擎');
  for (const k of BALL_SOURCES) {
    console.log(`  ${k.padEnd(17)} 时间 ${pct(dE.sources?.[k]?.timeShare?.mean)}  静止率 ${pct(dE.sources?.[k]?.staticRate?.mean)}  贡献 ${pct(dE.sources?.[k]?.staticContribution?.mean)}`);
  }
  const payload = {
    generatedAt: new Date().toISOString(), windowsPath, wasmPath,
    wasmSha256, eventShaBySeed,
    caliber: { windowSec: winSec, sampleStepSec: step, includeExtrapolated: false, speedGates: SPEED_GATES, staticGates: STATIC_GATES, ballStaticGates: BALL_STATIC_GATES, holdMaxM: HOLD_MAX_M, maxStepSec: MAX_STEP_SEC },
    engineWindows: rowsE, realWindows: rowsR,
    engineDecomposition: decE,
    summary: { engine: cE, real: cR, engineDecomposition: dE },
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`\nJSON → ${outPath}`);
}

async function main() {
  const wasmPath = process.argv[2];
  if (!wasmPath || wasmPath.startsWith('--')) { console.error('用法: node motion-census.mjs <engine.wasm> [--seeds 42,1,7] [--window-sec 24] [--active-only] [--stimulus <stimulus.json>] [--windows <windows.json>] [--out file.json]'); process.exit(2); }
  const windowsPath = argOf('--windows', null);
  if (windowsPath) {
    const outPath = argOf('--out', join(ROOT, '.scratch/motion-census-windows.json'));
    await runWindows(wasmPath, resolve(windowsPath), outPath);
    return;
  }
  const stimulusPath = argOf('--stimulus', null);
  if (stimulusPath) {
    const outPath = argOf('--out', join(ROOT, '.scratch/motion-census-stimulus.json'));
    await runStimulus(wasmPath, resolve(stimulusPath), outPath);
    return;
  }
  const seeds = String(argOf('--seeds', '42,1,7')).split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
  const windowSec = Number(argOf('--window-sec', 24));
  const activeOnly = process.argv.includes('--active-only');
  const outPath = argOf('--out', join(ROOT, '.scratch/motion-census-out.json'));
  const { loadEngineFrames, loadRealFrames, evaluateWindow } = await import(join(ROOT, 'tools/visual-review/replay-blind-core.mjs'));
  const sha256 = (x) => createHash('sha256').update(x).digest('hex');
  // 选窗：全窗（默认）或 R7i 式「活跃窗」预筛（同一批预注册阈值，但穷举扫描而非 anchor 搜索）。
  // ⚠️ 两种口径的数字不可混表；报告必须带 `activeOnly`。
  const keepWin = (frames, t0) => !activeOnly || evaluateWindow(frames, t0, { windowSec }).pass;

  const engineMatches = [];
  for (const seed of seeds) {
    const src = await loadEngineFrames(wasmPath, seed, 5400, { sampleStepSec: 0.2 });
    const events = JSON.parse(src.eventJson);
    const allRows = censusWindows(src.frames, { windowSec });
    const rows = allRows.filter((r) => keepWin(src.frames, r.t0));
    const allDecRows = decomposeWindows(src.frames, events, { windowSec });
    const decRows = allDecRows.filter((r) => keepWin(src.frames, r.t0));
    engineMatches.push({
      seed,
      eventSha256: sha256(src.eventJson),
      frames: src.frames.length,
      windows: rows.length,
      windowsScanned: allRows.length,
      census: summarizeCensus(rows),
      decomposition: summarizeCensus(decRows.map((r) => ({ ...r, sources: r.sources }))),
      raw: { census: rows, decomposition: decRows },
    });
  }

  // 真实侧：Metrica 2 场（gitignored；缺则 n/a）。只算帧口径，不做事件分解（真实无事件流）。
  const realMatches = [];
  const dataDir = join(ROOT, 'viewer/data');
  const realFiles = existsSync(dataDir) ? readdirSync(dataDir).filter((n) => /^real-game-\d+\.json$/.test(n)).sort() : [];
  for (const fn of realFiles) {
    const src = loadRealFrames(join(dataDir, fn));
    const allRows = censusWindows(src.frames, { windowSec });
    const rows = allRows.filter((r) => keepWin(src.frames, r.t0));
    realMatches.push({
      file: fn, frames: src.frames.length, windows: rows.length, windowsScanned: allRows.length,
      census: summarizeCensus(rows), raw: { census: rows },
    });
  }

  const eCensus = perMatchMean(engineMatches.map((m) => m.raw.census));
  const rCensus = realMatches.length ? perMatchMean(realMatches.map((m) => m.raw.census)) : null;
  const eDec = perMatchMean(engineMatches.map((m) => m.raw.decomposition));

  const eWin = engineMatches.reduce((s, m) => s + m.windows, 0);
  const eScanned = engineMatches.reduce((s, m) => s + m.windowsScanned, 0);
  const rWin = realMatches.reduce((s, m) => s + m.windows, 0);
  const rScanned = realMatches.reduce((s, m) => s + m.windowsScanned, 0);
  console.log(`═══ 运动普查（条件 turn120 + 静止来源分解）═══`);
  console.log(`wasm=${wasmPath}  seeds=${seeds.join(',')}  窗=${windowSec}s@5Hz（121 帧）  逐窗算→逐场等权均值`);
  console.log(`选窗口径=${activeOnly ? 'active-only（R7i 式预注册阈值；与全窗不可混表）' : 'all-windows（不筛选）'}`);
  console.log(`引擎场数=${engineMatches.length}（窗 ${eWin}/${eScanned}）  真实 Metrica 场数=${realMatches.length}（窗 ${rWin}/${rScanned}）${realMatches.length ? '' : '（缺真实帧：真实列 n/a）'}`);
  console.log('');
  console.log(`[转向] 旧 turn120（零步也计角） 引擎 ${fmt(eCensus['turn120Old'], 3)}/球员/窗` + (rCensus ? `  真实 ${fmt(rCensus['turn120Old'], 3)}` : ''));
  for (const g of SPEED_GATES) {
    const k = `conditional.${g}`;
    console.log(`  条件 turn120 @${g} m/s 引擎 ${fmt(eCensus[`${k}.turnsPerPlayer`], 3)}  ` +
      `有效步对 ${fmt(eCensus[`${k}.effectivePairs`], 1)}  每有效步对 ${fmt(eCensus[`${k}.turnsPerEffectivePair`], 4)}  ` +
      `每有效步 ${fmt(eCensus[`${k}.turnsPerEffectiveStep`], 4)}  每米 ${fmt(eCensus[`${k}.turnsPerMeter`], 4)}` +
      (rCensus ? `  | 真实 ${fmt(rCensus[`${k}.turnsPerPlayer`], 3)} / 每对 ${fmt(rCensus[`${k}.turnsPerEffectivePair`], 4)}` : ''));
  }
  console.log('');
  console.log('[静止] 球员 staticFrac' + STATIC_GATES.map((g) => ` <${g}: ${pct(eCensus[`staticFrac.${g}`])}`).join('') +
    (rCensus ? '  | 真实' + STATIC_GATES.map((g) => ` <${g}: ${pct(rCensus[`staticFrac.${g}`])}`).join('') : ''));
  console.log('[静止] 球 ballStaticFrac' + BALL_STATIC_GATES.map((g) => ` <${g}: ${pct(eCensus[`ballStaticFrac.${g}`])}`).join('') +
    (rCensus ? '  | 真实' + BALL_STATIC_GATES.map((g) => ` <${g}: ${pct(rCensus[`ballStaticFrac.${g}`])}`).join('') : ''));
  console.log(`[转移] move→stop ${fmt(eCensus['transitions.moveStopShare'], 3)}  stop→move ${fmt(eCensus['transitions.stopMoveShare'], 3)}  ` +
    `move→move ${fmt(eCensus['transitions.moveMoveShare'], 3)}  stop→stop ${fmt(eCensus['transitions.stopStopShare'], 3)}（窗内步对占比）`);
  console.log(`[速度] p50 ${fmt(eCensus['speed.p50'], 2)}  p90 ${fmt(eCensus['speed.p90'], 2)}  p99 ${fmt(eCensus['speed.p99'], 2)} m/s` +
    `  加速度 p95 ${fmt(eCensus['accel.p95'], 2)}  p99 ${fmt(eCensus['accel.p99'], 2)} m/s²`);
  console.log(`[对称] 底-顶 ${fmt(eCensus['symmetry.bottomMinusTop'], 3)}  左-右 ${fmt(eCensus['symmetry.leftMinusRight'], 3)}` +
    (rCensus ? `  | 真实 底-顶 ${fmt(rCensus['symmetry.bottomMinusTop'], 3)} 左-右 ${fmt(rCensus['symmetry.leftMinusRight'], 3)}` : ''));
  console.log('');
  console.log(`[球静止来源] 引擎（窗内时间权重；条件静止率 = 该类球速<0.5 的时间占比）`);
  for (const k of BALL_SOURCES) {
    const s = eDec[`sources.${k}`];
    console.log(`  ${k.padEnd(17)} 时间权重 ${pct(eDec[`sources.${k}.timeShare`])}  条件静止率 ${pct(eDec[`sources.${k}.staticRate`])}  ` +
      `对总静止贡献 ${pct(eDec[`sources.${k}.staticContribution`])}`);
  }
  console.log(`  合计 ballStaticFrac ${pct(eDec['ballStaticFrac'])}（窗内静止时间 / 有时间权重的时间）`);
  console.log('');
  console.log(`⚠ 口径：旧 turn120 对零步调用 atan2(0,0)=0（历史口径，保留对照）；条件列只在相邻两步都 ≥ 门限时计。`);
  console.log(`⚠ 外推点：真实侧跳过 SkillCorner 的 \`extrapolated\` 球员点（design D3 主口径；引擎帧无此标记）。`);
  console.log(`⚠ 本工具测的是**渲染帧**；mover 锚点 vs 渲染帧的差由 A 的同流消融回答，别把两者混成一张表。`);

  const payload = {
    generatedAt: new Date().toISOString(),
    caliber: { windowSec, sampleHz: 5, framesPerWindow: Math.round(windowSec * 5) + 1, activeOnly, includeExtrapolated: false, speedGates: SPEED_GATES, staticGates: STATIC_GATES, ballStaticGates: BALL_STATIC_GATES, holdMaxM: HOLD_MAX_M, maxStepSec: MAX_STEP_SEC },
    wasmPath,
    seeds,
    engineMatches,
    realMatches,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`\nJSON → ${outPath}`);
}

if (IS_ENTRY) await main();
