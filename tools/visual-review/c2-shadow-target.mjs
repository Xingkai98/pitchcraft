// C2 局部无球目标影子原型（2026-10-22，只读分析工具）。
//
// 定位：**只记录、不移动**。输入是 `engine/examples/n5_dump.rs` 的 A6 tick dump
// （`simulate_with_n5_probe` sidecar；事件流不变）。每 tick 用**本 tick 起始状态**
// （= 上一 tick 终态）对每名非 carrier 外场球员计算一个替代目标点，只写分析产物；
// `st.pos` / movers / 事件流不动。
//
// 变体（公式见 `.scratch/notes/c2-shadow-target-2026-10-22.md` §2，先注册后跑）：
//   C2        当前 `p[4],p[5]`（post-repulsion，非影子）
//   V1        最近对手 + 角色/线路 + 同队目标分离
//   V1-no-opp 去掉最近对手项
//   V1-no-sep 去掉同队目标分离
//   V2        球相对（位置/速度）+ 个体局部车道 + 对手局部项（无分离）
//   V2-no-opp 去掉对手局部项
//   V3        对手线匹配 + 最近队友决定侧向（无固定槽位/无 wiggle）
//   V3-no-line 对手改为全体最近者（不按线匹配）
//
// 口径：
//   - 只分析 `fresh && phase==0` tick；dt≤1.5 s 才配对；门将不参与；carrier 不参与。
//   - 目标点指标是**目标代理**，不是球员实际位置；actual 单独一行、所有变体共享。
//   - 结构量复用 `n5-movement.mjs::trajectoryWindow`（60 s 非重叠子窗，与 N5 同口径）。
//   - 真实锚只读 `metrics-all-v4.json`，逐场取中位再跨场取中位；只作参照、不拟合。
//
// 用法：
//   node tools/visual-review/c2-shadow-target.mjs --dumps <dir> --out <dir> [--real <json>]

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OUTFIELD, KEEPER_IDS, quantile, median, iqr, mean, sineAmp,
} from './n5-movement.mjs';

export const PITCH_LENGTH_M = 105;
export const PITCH_WIDTH_M = 68;
export const TICK_SECONDS = 1.0;
export const RUN_SPEED_MS_MOTION = 6.5; // engine/src/lib.rs:3257
export const SAME_TEAM_MIN_DIST_M = 2.2; // engine/src/lib.rs:3464

// §2.5 机制参数（不是拟合值）
export const MECH = {
  OPP_STANDOFF_M: 5.0,
  LANE_GAP_M: 7.0,
  V2_LANE_GAIN: 1.2,
  V2_OPP_GAIN: 0.4,
  V2_SIDE_M: 5.0,
  V2_BALL_LEAD_S: 0.5,
  V3_LANE_M: 5.0,
  V3_BALL_WEIGHT: 0.25,
};

const ROLE_DX_ATT = { back: -18, mid: -4, fwd: 12 };
const ROLE_DX_DEF = { back: -12, mid: 1, fwd: 10 };
const X_OPP_OFF = { back: -6, mid: 0, fwd: 4 };
const X_GAP_V3 = { back: -5, mid: -1, fwd: 3 };

export const VARIANTS = [
  'C2', 'V1', 'V1-no-opp', 'V1-no-sep', 'V2', 'V2-no-opp', 'V3', 'V3-no-line',
  // 可部署 hybrid：run 用影子律，mark/close 等保留 C2 目标。
  'hybrid-V1', 'hybrid-V1-no-opp',
];
export const DEPLOYABLE = ['hybrid-V1', 'hybrid-V1-no-opp'];
export const SHADOW_VARIANTS = ['V1', 'V1-no-opp', 'V1-no-sep', 'V2', 'V2-no-opp', 'V3', 'V3-no-line'];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const teamOf = (id) => (id <= 10 ? 0 : 1);
const roleLine = (id) => {
  const rel = id <= 10 ? id : id - 10;
  if (rel <= 4) return 'back';
  if (rel <= 8) return 'mid';
  return 'fwd';
};
const attackDir = (team) => (team === 0 ? 1 : -1);
const distM = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const corr = (x, y) => {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let sx = 0; let sy = 0; let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    const a = x[i] - mx; const b = y[i] - my;
    sx += a * a; sy += b * b; sxy += a * b;
  }
  if (sx < 1e-12 || sy < 1e-12) return 0;
  return sxy / Math.sqrt(sx * sy);
};

// 本 tick 起始状态（= 上一 tick dump 终态）。位置/球转米制。
export function buildStartState(tick) {
  const players = tick.p.map((p, id) => ({ id, x: p[0] * PITCH_LENGTH_M, y: p[1] * PITCH_WIDTH_M }));
  return {
    t: tick.t,
    players,
    ball: { x: tick.bx * PITCH_LENGTH_M, y: tick.by * PITCH_WIDTH_M },
    possession: tick.poss,
    carrier: tick.carrier,
  };
}

function outfieldIds(start, team) {
  return OUTFIELD.filter((id) => teamOf(id) === team && id !== start.carrier);
}
function allOutfield(start, team) {
  return OUTFIELD.filter((id) => teamOf(id) === team);
}
function nearestOf(players, from) {
  let best = null;
  for (const p of players) {
    const d = distM(p, from);
    if (!best || d < best.d) best = { p, d };
  }
  return best;
}
function oppGoal(team) {
  return { x: team === 0 ? PITCH_LENGTH_M : 0, y: PITCH_WIDTH_M / 2 };
}
function ownGoal(team) {
  return { x: team === 0 ? 0 : PITCH_LENGTH_M, y: PITCH_WIDTH_M / 2 };
}
// 点到线段的距离（米）。用于球→球门连线。
function pointSegDist(p, a, b) {
  const vx = b.x - a.x; const vy = b.y - a.y;
  const wx = p.x - a.x; const wy = p.y - a.y;
  const vv = vx * vx + vy * vy;
  const t = vv < 1e-12 ? 0 : clamp((wx * vx + wy * vy) / vv, 0, 1);
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}
function sideOf(player, opp, teamMeanY) {
  let d = player.y - opp.y;
  if (Math.abs(d) < 0.5) d = player.y - teamMeanY;
  if (Math.abs(d) < 0.5) d = player.id % 2 === 0 ? 1 : -1;
  return d >= 0 ? 1 : -1;
}
function norm(p) {
  return { x: p.x / PITCH_LENGTH_M, y: p.y / PITCH_WIDTH_M };
}
function inPitch(p) {
  return { x: clamp(p.x, 3, PITCH_LENGTH_M - 3), y: clamp(p.y, 3, PITCH_WIDTH_M - 3) };
}

// 同队目标分离：3 轮 pair，目标间距 minM。只作用于目标点。
function separateTargets(targets, team, minM = MECH.LANE_GAP_M) {
  const ids = [...targets.keys()].filter((id) => teamOf(id) === team).sort((a, b) => a - b);
  for (let iter = 0; iter < 3; iter += 1) {
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = ids[i]; const b = ids[j];
        const ta = targets.get(a); const tb = targets.get(b);
        const d = distM(ta, tb);
        if (d >= minM) continue;
        let ux; let uy;
        if (d < 1e-9) {
          // 确定性退化方向（不耗 RNG）：按 id 奇偶给一个固定轴。
          ux = (a + b) % 2 === 0 ? 1 : 0;
          uy = ux === 1 ? 0 : 1;
        } else {
          ux = (tb.x - ta.x) / d; uy = (tb.y - ta.y) / d;
        }
        const push = (minM - d) / 2;
        targets.set(a, inPitch({ x: ta.x - ux * push, y: ta.y - uy * push }));
        targets.set(b, inPitch({ x: tb.x + ux * push, y: tb.y + uy * push }));
      }
    }
  }
}

// §2 影子目标律。返回 `{ targets, meta }`：targets 是 Map<id,{x,y}>（米制），
// meta 是律内对手（oppId/oppX/oppY/side）；**不是**目标点最近对手。只读 start 状态。
export function computeShadowTargetsEx(start, variant, ballV = { x: 0, y: 0 }) {
  const targets = new Map();
  const meta = new Map();
  const teamMeanY = [0, 1].map((team) => {
    const ids = outfieldIds(start, team);
    return ids.length ? mean(ids.map((id) => start.players[id].y)) : PITCH_WIDTH_M / 2;
  });
  const myAttack = [0, 1].map((team) => (team === 0 ? start.possession === 0 : start.possession === 1));

  for (const id of OUTFIELD) {
    if (id === start.carrier) continue;
    const player = start.players[id];
    const team = teamOf(id);
    const oppIds = allOutfield(start, 1 - team);
    const oppPool = oppIds.map((oid) => start.players[oid]);
    const oppNearest = nearestOf(oppPool, player);
    const line = roleLine(id);
    const dir = attackDir(team);
    const roleDx = myAttack[team] ? ROLE_DX_ATT : ROLE_DX_DEF;
    const xRole = start.ball.x + dir * roleDx[line];
    let x;
    let y;
    let lawOpp = null;
    let lawSide = null;

    if (variant === 'V2' || variant === 'V2-no-opp') {
      const localLane = player.y - teamMeanY[team];
      const oppTerm = variant === 'V2-no-opp' ? 0 : MECH.V2_OPP_GAIN * (oppNearest.p.y - start.ball.y);
      const sideTerm = variant === 'V2-no-opp' ? 0 : MECH.V2_SIDE_M * sideOf(player, oppNearest.p, teamMeanY[team]);
      const lead = {
        x: clamp(ballV.x * MECH.V2_BALL_LEAD_S, -4, 4),
        y: clamp(ballV.y * MECH.V2_BALL_LEAD_S, -4, 4),
      };
      x = xRole + lead.x;
      y = start.ball.y + MECH.V2_LANE_GAIN * localLane + oppTerm + sideTerm + lead.y;
      if (variant === 'V2') {
        lawOpp = oppNearest.p;
        lawSide = sideOf(player, oppNearest.p, teamMeanY[team]);
      }
    } else if (variant === 'V3' || variant === 'V3-no-line') {
      let pool = oppPool;
      if (variant === 'V3') {
        // 角色对位：后卫↔对方前锋、前卫↔对方前卫、前锋↔对方后卫（预注册 §2.3）。
        const oppLine = line === 'back' ? 'fwd' : (line === 'fwd' ? 'back' : 'mid');
        const matched = oppPool.filter((p) => roleLine(p.id) === oppLine);
        if (matched.length) pool = matched;
      }
      const opp = nearestOf(pool, player).p;
      const xLine = opp.x + dir * X_GAP_V3[line];
      x = (1 - MECH.V3_BALL_WEIGHT) * xLine + MECH.V3_BALL_WEIGHT * xRole;
      // 同线最近队友（按到 opp 的 y 距离）；朝队友反侧站位，避免同线撞点。
      const mates = OUTFIELD.filter((mid) => mid !== id && mid !== start.carrier
        && teamOf(mid) === team && roleLine(mid) === line);
      let side = sideOf(player, opp, teamMeanY[team]);
      if (mates.length) {
        let bestMate = null;
        for (const mid of mates) {
          const d = Math.abs(start.players[mid].y - opp.y);
          if (!bestMate || d < bestMate.d) bestMate = { id: mid, d, y: start.players[mid].y };
        }
        if (Math.abs(opp.y - bestMate.y) >= 1.0) side = opp.y >= bestMate.y ? 1 : -1;
      }
      y = opp.y + side * MECH.V3_LANE_M;
      if (variant === 'V3') { lawOpp = opp; lawSide = side; }
    } else {
      // V1 family
      if (variant === 'V1-no-opp') {
        x = xRole;
        y = player.y;
      } else {
        const opp = oppNearest.p;
        const side = sideOf(player, opp, teamMeanY[team]);
        const laneOff = clamp(
          MECH.OPP_STANDOFF_M + 0.5 * Math.abs(player.y - opp.y),
          MECH.OPP_STANDOFF_M, 9.0,
        );
        const xOpp = opp.x + dir * X_OPP_OFF[line];
        x = 0.5 * xRole + 0.5 * xOpp;
        y = opp.y + side * laneOff;
        lawOpp = opp;
        lawSide = side;
      }
    }
    targets.set(id, inPitch({ x, y }));
    meta.set(id, {
      oppId: lawOpp ? lawOpp.id : null,
      oppX: lawOpp ? lawOpp.x : null,
      oppY: lawOpp ? lawOpp.y : null,
      side: lawSide,
    });
  }
  if (variant === 'V1' || variant === 'V1-no-opp') {
    separateTargets(targets, 0);
    separateTargets(targets, 1);
  }
  return { targets, meta };
}

// 兼容旧调用：只返回目标点。
export function computeShadowTargets(start, variant, ballV = { x: 0, y: 0 }) {
  return computeShadowTargetsEx(start, variant, ballV).targets;
}

// 逐 seed 提取：C2 目标 + 所有影子变体 + hybrid + actual。
//
// phaseMode：
//   'start'（主口径）——本 tick 的目标由 ticks[i-1] 起始态计算，因此用**起始 phase** 过滤；
//   'end'（并列对照）——旧口径，用 tick 末 cur.phase 过滤。
// hybrid：`run`（action 0）用影子律，mark/close/chase/keeper 保留 C2 目标。
export function extractSeed(dump, { phaseMode = 'start' } = {}) {
  const ticks = dump.ticks;
  const byVariant = Object.fromEntries(VARIANTS.map((v) => [v, new Map()]));
  const periodSeries = Object.fromEntries(VARIANTS.map((v) => [v, new Map()]));
  const frames = Object.fromEntries(VARIANTS.map((v) => [v, []]));
  const actualAllFrames = [];
  const actualPeriodSeries = new Map(); // 全 tick（actual 连续序列，用于周期基线）
  const lastC2 = new Map();
  const actionCounts = new Array(6).fill(0);
  let actionN = 0;
  const ballV = { x: 0, y: 0 };

  for (let i = 1; i < ticks.length; i += 1) {
    const cur = ticks[i];
    const startTick = ticks[i - 1];
    if (cur.t - startTick.t <= 0 || cur.t - startTick.t > 1.5) continue;
    const start = buildStartState(startTick);
    // actual 连续序列（全 tick；非 carrier 外场），只用于周期基线。
    for (const id of OUTFIELD) {
      if (id === start.carrier) continue;
      if (!actualPeriodSeries.has(id)) actualPeriodSeries.set(id, []);
      actualPeriodSeries.get(id).push({ t: cur.t, y: cur.p[id][1] * PITCH_WIDTH_M });
    }
    const phaseOk = phaseMode === 'start' ? startTick.phase === 0 : cur.phase === 0;
    if (!phaseOk) continue;
    // 球速：上一 tick 到本 tick 起始状态。
    if (i >= 2) {
      const prev2 = ticks[i - 2];
      const dt = startTick.t - prev2.t;
      if (dt > 0 && dt <= 1.5) {
        ballV.x = (start.ball.x - prev2.bx * PITCH_LENGTH_M) / dt;
        ballV.y = (start.ball.y - prev2.by * PITCH_WIDTH_M) / dt;
      } else {
        ballV.x = 0; ballV.y = 0;
      }
    } else {
      ballV.x = 0; ballV.y = 0;
    }
    const carrier = start.carrier;
    const made = {};
    const meta = {};
    // C2（非 fresh 拍 held，供周期序列；churn/shape 只用 fresh）。
    {
      const m = new Map();
      for (const id of OUTFIELD) {
        if (id === carrier) continue;
        const p = cur.p[id];
        if (cur.fresh && p[8]) {
          const tgt = { x: p[4] * PITCH_LENGTH_M, y: p[5] * PITCH_WIDTH_M };
          m.set(id, tgt);
          lastC2.set(id, tgt);
        } else if (lastC2.has(id)) {
          m.set(id, lastC2.get(id));
        }
      }
      made.C2 = m;
      meta.C2 = new Map();
    }
    // 影子律（每 phaseOk tick 重算；无状态）。
    for (const variant of SHADOW_VARIANTS) {
      const r = computeShadowTargetsEx(start, variant, ballV);
      made[variant] = r.targets;
      meta[variant] = r.meta;
    }
    // 可部署 hybrid：run 用影子律，其余保留 C2 目标。
    for (const h of DEPLOYABLE) {
      const base = h === 'hybrid-V1' ? 'V1' : 'V1-no-opp';
      const hm = new Map();
      const hmeta = new Map();
      for (const id of OUTFIELD) {
        if (id === carrier) continue;
        const action = cur.p[id][6];
        if (action === 0 && made[base].has(id)) {
          hm.set(id, made[base].get(id));
          hmeta.set(id, meta[base].get(id));
        } else if (made.C2.has(id)) {
          hm.set(id, made.C2.get(id));
          hmeta.set(id, { oppId: null, oppX: null, oppY: null, side: null });
        }
      }
      made[h] = hm;
      meta[h] = hmeta;
    }
    // 周期性序列：phaseOk 样本（C2 held；影子律每 tick 重算，无状态）。
    for (const variant of VARIANTS) {
      for (const [id, tgt] of made[variant]) {
        if (!periodSeries[variant].has(id)) periodSeries[variant].set(id, []);
        periodSeries[variant].get(id).push({ t: cur.t, y: tgt.y });
      }
    }
    // churn/shape 只用 fresh 拍；非 fresh 的 held 目标只进周期序列。
    if (!cur.fresh) continue;
    // 动作分布（与目标同球员集；用于校验 A6 run/mark/close 比例）。
    for (const id of OUTFIELD) {
      if (id === carrier) continue;
      const a = cur.p[id][6];
      if (a >= 0 && a < 6) { actionCounts[a] += 1; actionN += 1; }
    }
    for (const variant of VARIANTS) {
      const m = made[variant];
      const tframe = { t: cur.t, players: [], ball: [start.ball.x / PITCH_LENGTH_M, start.ball.y / PITCH_WIDTH_M], pitchMeters: [PITCH_LENGTH_M, PITCH_WIDTH_M] };
      for (const [id, tgt] of m) {
        const p = start.players[id];
        // 律内对手优先；无对手项（C2 / no-opp / hybrid 的非 run）用起始位置最近对手作代理，
        // 并显式记录 oppSource，避免把代理冒充律内对象。
        let oppInfo = meta[variant]?.get(id) || null;
        let oppSource = oppInfo && oppInfo.oppId != null ? 'law' : null;
        if (!oppInfo || oppInfo.oppId == null) {
          const team = teamOf(id);
          const pool = allOutfield(start, 1 - team).map((oid) => start.players[oid]);
          const opp = nearestOf(pool, p).p;
          oppInfo = { oppId: opp.id, oppX: opp.x, oppY: opp.y, side: null };
          oppSource = 'proxy';
        }
        const item = {
          t: cur.t, i, id, team: teamOf(id), line: roleLine(id),
          action: cur.p[id][6],
          x: tgt.x, y: tgt.y,
          startX: p.x, startY: p.y,
          actualX: cur.p[id][0] * PITCH_LENGTH_M,
          actualY: cur.p[id][1] * PITCH_WIDTH_M,
          vx: cur.p[id][2], vy: cur.p[id][3],
          ballX: start.ball.x, ballY: start.ball.y,
          poss: start.possession, carrier,
          oppX: oppInfo.oppX, oppY: oppInfo.oppY, oppId: oppInfo.oppId, oppSource,
        };
        if (!byVariant[variant].has(id)) byVariant[variant].set(id, []);
        byVariant[variant].get(id).push(item);
        tframe.players.push({ id, x: tgt.x / PITCH_LENGTH_M, y: tgt.y / PITCH_WIDTH_M });
      }
      frames[variant].push(tframe);
    }
    // actual：全外场（与真实锚同口径；目标行只排除 carrier，须显式区分）。
    const afAll = { t: cur.t, players: OUTFIELD.map((id) => ({ id, x: cur.p[id][0], y: cur.p[id][1] })), ball: [start.ball.x / PITCH_LENGTH_M, start.ball.y / PITCH_WIDTH_M], pitchMeters: [PITCH_LENGTH_M, PITCH_WIDTH_M] };
    actualAllFrames.push(afAll);
    // actual 逐球员序列（非 carrier；含 ballY，供 Δy~ΔballY 与速度基线）。
    if (!byVariant.actual) byVariant.actual = new Map();
    for (const id of OUTFIELD) {
      if (id === carrier) continue;
      if (!byVariant.actual.has(id)) byVariant.actual.set(id, []);
      const p = cur.p[id];
      byVariant.actual.get(id).push({
        t: cur.t, i, id, team: teamOf(id), line: roleLine(id),
        actualX: p[0] * PITCH_LENGTH_M, actualY: p[1] * PITCH_WIDTH_M,
        vx: p[2], vy: p[3], startX: start.players[id].x, startY: start.players[id].y,
        ballY: start.ball.y,
      });
    }
  }
  return {
    byVariant, frames, periodSeries, actualAllFrames, actualPeriodSeries,
    actionCounts, actionN, phaseMode,
  };
}

// 连续段（dt=1 s）切分。
function segments(series) {
  const out = [];
  let cur = [];
  for (const z of series) {
    if (cur.length && z.t - cur[cur.length - 1].t > 1.5) {
      if (cur.length) out.push(cur);
      cur = [];
    }
    cur.push(z);
  }
  if (cur.length) out.push(cur);
  return out;
}

// 单球员目标 y 的周期性（全 phase0 样本；非均匀采样）。
//
// ⚠️ 口径订正（跑后、见 note 实测 §8.0）：预注册要求「连续 fresh phase0 段 ≥60 tick」，
// 但实测 phase0 连续段最长 5 s（与 N5 §8.4 一致）——该口径**没有可用样本**。
// 改用对非均匀样本合法的固定频率正弦拟合（sineAmp）+ 精确 lag 配对的 ACF；
// H4 阈值不变。主导周期用 3–60 s、0.5 s 步长的正弦拟合幅值取最大（不是均匀 DFT）。
export function periodicMetrics(series) {
  const ts = series.map((z) => z.t);
  const ys = series.map((z) => z.y);
  const n = ys.length;
  if (n < 60) return null;
  const mt = mean(ts); const my = mean(ys);
  let sxx = 0; let sxy = 0;
  for (let i = 0; i < n; i += 1) { sxx += (ts[i] - mt) ** 2; sxy += (ts[i] - mt) * (ys[i] - my); }
  const slope = sxx > 1e-12 ? sxy / sxx : 0;
  const resid = ys.map((y, i) => y - (my + slope * (ts[i] - mt)));
  let domAmp = 0; let domPeriod = null;
  for (let period = 3; period <= 60 + 1e-9; period += 0.5) {
    const amp = sineAmp(ts, ys, period);
    if (amp != null && amp > domAmp) { domAmp = amp; domPeriod = period; }
  }
  // ACF（去趋势后），精确 t+lag 配对；缺口安全。
  const at = new Map(ts.map((t, i) => [Math.round(t * 1e6), resid[i]]));
  const acfAt = (lag) => {
    const xs = []; const ys2 = [];
    for (let i = 0; i < n; i += 1) {
      const v = at.get(Math.round((ts[i] + lag) * 1e6));
      if (v != null) { xs.push(resid[i]); ys2.push(v); }
    }
    return xs.length >= 10 ? corr(xs, ys2) : null;
  };
  const acfLag1 = acfAt(1);
  let acfMax = -Infinity; let acfMaxLag = null;
  for (let lag = 3; lag <= 30; lag += 1) {
    const c = acfAt(lag);
    if (c != null && c > acfMax) { acfMax = c; acfMaxLag = lag; }
  }
  return {
    n,
    dominantAmpM: domAmp,
    dominantPeriodS: domPeriod,
    acfLag1,
    acfMax: Number.isFinite(acfMax) ? acfMax : null,
    acfMaxLag,
    amp4p3TargetM: sineAmp(ts, ys, 4.3),
    amp18TargetM: sineAmp(ts, ys, 18),
    amp90TargetM: sineAmp(ts, ys, 90),
  };
}

// 逐帧共同信号（actual 位置用；target 侧在 variantSeedMetrics 里用同一定义）。
export function commonModeFromFrames(frames) {
  const rowsX = []; const rowsY = [];
  for (const f of frames) {
    const ps = f.players.filter((p) => !KEEPER_IDS.includes(p.id));
    for (const team of [0, 1]) {
      const tp = ps.filter((p) => (team === 0 ? p.id <= 10 : p.id >= 11));
      if (tp.length < 7) continue;
      for (const [ax, rows] of [['x', rowsX], ['y', rowsY]]) {
        const vals = tp.map((p) => p[ax]);
        const m = mean(vals);
        const resid = mean(vals.map((v) => (v - m) ** 2));
        rows.push({ m, resid });
      }
    }
  }
  const share = (rows) => {
    if (!rows.length) return null;
    const ms = rows.map((r) => r.m);
    const mm = mean(ms);
    const cv = mean(ms.map((v) => (v - mm) ** 2));
    const rv = mean(rows.map((r) => r.resid));
    return cv + rv > 1e-12 ? cv / (cv + rv) : null;
  };
  return { x: share(rowsX), y: share(rowsY) };
}

// 队内 y 同步量。**拆分**：
//   teamYStepCorr        = 两两 Δy 的时间相关（整队同步）
//   collectiveYStepShare = |队均 Δy| / mean|个体 Δy|（0=各自动，1=整队平移）
//   personalJumpRate     = 个人 |Δy|>2m 的比例（个人 churn，不是整队同步）
//   syncJumpShare        = 同 tick 内同队多人 |Δy|>2m 的共现率（并列，不作为 H4 整队同步）
export function teamStepMetrics(series, getY) {
  const tickList = [...new Set([...series.values()].flatMap((arr) => arr.map((z) => z.i)))].sort((a, b) => a - b);
  const byTick = new Map();
  for (const [, arr] of series) for (const z of arr) {
    if (!byTick.has(z.i)) byTick.set(z.i, []);
    byTick.get(z.i).push(z);
  }
  const teamYStepCorr = [];
  const collective = [];
  let personalJumpN = 0; let personalJumpD = 0;
  for (const team of [0, 1]) {
    const ids = [...series.keys()].filter((id) => teamOf(id) === team).sort((a, b) => a - b);
    const yMaps = new Map(ids.map((id) => [id, new Map(series.get(id).map((z) => [z.i, getY(z)]))]));
    for (let a = 0; a < ids.length; a += 1) {
      for (let b = a + 1; b < ids.length; b += 1) {
        const ma = yMaps.get(ids[a]); const mb = yMaps.get(ids[b]);
        const times = [...ma.keys()].filter((i) => mb.has(i)).sort((x, y) => x - y);
        const dyA = []; const dyB = [];
        for (let k = 1; k < times.length; k += 1) {
          if (times[k] - times[k - 1] !== 1) continue;
          dyA.push(ma.get(times[k]) - ma.get(times[k - 1]));
          dyB.push(mb.get(times[k]) - mb.get(times[k - 1]));
          personalJumpD += 1;
          if (Math.abs(ma.get(times[k]) - ma.get(times[k - 1])) > 2.0) personalJumpN += 1;
        }
        const c = dyA.length >= 20 ? corr(dyA, dyB) : null;
        if (c != null) teamYStepCorr.push(c);
      }
    }
  }
  for (let k = 1; k < tickList.length; k += 1) {
    const i0 = tickList[k - 1]; const i1 = tickList[k];
    if (i1 - i0 !== 1) continue;
    const m0 = new Map((byTick.get(i0) || []).map((z) => [z.id, z]));
    const m1 = new Map((byTick.get(i1) || []).map((z) => [z.id, z]));
    for (const team of [0, 1]) {
      const ids = [...m1.keys()].filter((id) => teamOf(id) === team && m0.has(id));
      if (ids.length < 3) continue;
      const dys = ids.map((id) => getY(m1.get(id)) - getY(m0.get(id)));
      const absMean = mean(dys.map((v) => Math.abs(v)));
      if (absMean > 1e-9) collective.push(Math.abs(mean(dys)) / absMean);
    }
  }
  // 个人大跳共现（旧 syncJumpShare；保留为并列，不是整队同步判据）
  const syncJumps = [];
  for (let k = 1; k < tickList.length; k += 1) {
    const i0 = tickList[k - 1]; const i1 = tickList[k];
    if (i1 - i0 !== 1) continue;
    const m0 = new Map((byTick.get(i0) || []).map((z) => [z.id, z]));
    const m1 = new Map((byTick.get(i1) || []).map((z) => [z.id, z]));
    for (const team of [0, 1]) {
      const ids = [...m1.keys()].filter((id) => teamOf(id) === team && m0.has(id));
      if (ids.length < 5) continue;
      let nJ = 0;
      for (const id of ids) if (Math.abs(getY(m1.get(id)) - getY(m0.get(id))) > 2.0) nJ += 1;
      syncJumps.push(nJ / ids.length);
    }
  }
  const s = (a) => (a.length ? median(a) : null);
  return {
    teamYStepCorr: s(teamYStepCorr),
    collectiveYStepShare: s(collective),
    personalJumpRate: personalJumpD ? personalJumpN / personalJumpD : null,
    syncJumpShare: s(syncJumps),
  };
}

export function ballYCorrOf(series, getY) {
  const out = [];
  for (const [, arr] of series) {
    const pairs = [];
    for (let k = 1; k < arr.length; k += 1) {
      const a = arr[k - 1]; const b = arr[k];
      if (b.t - a.t > 1.5) continue;
      if (a.ballY == null || b.ballY == null) continue;
      pairs.push([b.ballY - a.ballY, getY(b) - getY(a)]);
    }
    const c = pairs.length >= 20 ? corr(pairs.map((v) => v[0]), pairs.map((v) => v[1])) : null;
    if (c != null) out.push(c);
  }
  return out.length ? median(out) : null;
}

// actual 位置层指标（F1 上下文；不是目标代理）。
export function actualPositionMetrics(series, frames) {
  const cm = commonModeFromFrames(frames);
  const ts = teamStepMetrics(series, (z) => z.actualY);
  return {
    actualCommonX: cm.x,
    actualCommonY: cm.y,
    actualTeamYStepCorr: ts.teamYStepCorr,
    actualCollectiveYStepShare: ts.collectiveYStepShare,
    actualPersonalJumpRate: ts.personalJumpRate,
    actualSyncJumpShare: ts.syncJumpShare,
    actualBallYCorr: ballYCorrOf(series, (z) => z.actualY),
  };
}

// 逐 seed 指标（单一变体）。
export function variantSeedMetrics(series, frames, periodSeries = series) {
  const steps = [];
  const stepByPlayer = new Map();
  const update05 = []; const update10 = []; const dyShares = [];
  const jumps = [];
  let stepExceed = 0; let stepN = 0;
  const targetDist = [];
  const followAlign = [];
  const commonY = []; const commonX = [];
  const residualSteps = [];
  const actionCounts = new Array(6).fill(0);
  let actionN = 0;
  const oppositionCorr = []; const ballCorr = [];
  const nearestOpp = []; const ballGoalPerp = []; const nearOpp12 = [];
  const oppSwitch = []; const jumpAfterSwitch = []; const jumpNoSwitch = [];
  const period = [];
  const updateIndicators = new Map(); // id -> [0/1]
  let nPlayers = 0; let nTicks = 0;

  // 逐球员步长/周期性/局部相关
  for (const [id, arr] of series) {
    if (!arr.length) continue;
    nPlayers += 1;
    const team = teamOf(id);
    const dir = attackDir(team);
    const goal = team === (arr[0].poss ?? 0) ? oppGoal(team) : ownGoal(team);
    const ownSteps = [];
    const oppYs = []; const ballYs = []; const tys = [];
    const upd = [];
    for (let k = 0; k < arr.length; k += 1) {
      const z = arr[k];
      if (Number.isInteger(z.action) && z.action >= 0 && z.action < 6) { actionCounts[z.action] += 1; actionN += 1; }
      const tgt = { x: z.x, y: z.y };
      nearestOpp.push(distM(tgt, { x: z.oppX, y: z.oppY }));
      if (distM(tgt, { x: z.oppX, y: z.oppY }) <= 12) nearOpp12.push(1); else nearOpp12.push(0);
      ballGoalPerp.push(pointSegDist(tgt, { x: z.ballX, y: z.ballY }, goal));
      targetDist.push(Math.hypot(z.x - z.startX, z.y - z.startY));
      if (k > 0 && z.t - arr[k - 1].t <= 1.5) {
        const a = arr[k - 1];
        const dx = z.x - a.x; const dy = z.y - a.y;
        const step = Math.hypot(dx, dy);
        steps.push(step); ownSteps.push(step); jumps.push(step);
        stepN += 1; if (step > RUN_SPEED_MS_MOTION * TICK_SECONDS) stepExceed += 1;
        update05.push(step > 0.5 ? 1 : 0); update10.push(step > 1 ? 1 : 0);
        dyShares.push(step > 1e-6 ? Math.abs(dy) / (Math.abs(dx) + Math.abs(dy)) : null);
        upd.push(step > 0.5 ? 1 : 0);
        // 执行器代理：实际本 tick 位移方向 vs 目标方向。
        const adx = z.actualX - z.startX; const ady = z.actualY - z.startY;
        const asp = Math.hypot(adx, ady);
        const tdx = z.x - z.startX; const tdy = z.y - z.startY;
        const td = Math.hypot(tdx, tdy);
        if (asp > 0.5 && td > 0.5) followAlign.push((adx * tdx + ady * tdy) / (asp * td));
        // 律内对手身份切换 vs 大跳变。只比较**同来源**的对手（law 对 law / proxy 对 proxy）；
        // no-opp 与 hybrid 的混合来源不计，避免把代理冒充律内对象。
        const switchEligible = z.oppSource && a.oppSource === z.oppSource
          && z.oppId != null && a.oppId != null;
        if (switchEligible) {
          const switched = z.oppId !== a.oppId;
          oppSwitch.push(switched ? 1 : 0);
          (switched ? jumpAfterSwitch : jumpNoSwitch).push(Math.abs(dy) > 2.0 ? 1 : 0);
        }
        // 局部相关：目标 y 变化 vs 律内/代理对手 y 变化 / 球 y 变化。
        if (z.oppId != null && z.oppId === a.oppId && z.oppSource === a.oppSource) {
          oppYs.push([z.oppY - a.oppY, dy]);
        }
        if (z.ballY !== a.ballY) ballYs.push([z.ballY - a.ballY, dy]);
        tys.push(dy);
      }
    }
    if (ownSteps.length) stepByPlayer.set(id, median(ownSteps));
    if (upd.length) updateIndicators.set(id, upd);
    const oc = oppYs.length >= 20 ? corr(oppYs.map((v) => v[0]), oppYs.map((v) => v[1])) : null;
    if (oc != null) oppositionCorr.push(oc);
    const bc = ballYs.length >= 20 ? corr(ballYs.map((v) => v[0]), ballYs.map((v) => v[1])) : null;
    if (bc != null) ballCorr.push(bc);
    const p = periodicMetrics(periodSeries.get(id) || []);
    if (p) period.push(p);
  }
  // 共同信号：逐 tick/队（只取该 tick 有目标的球员）
  const byTick = new Map();
  for (const [, arr] of series) for (const z of arr) {
    if (!byTick.has(z.i)) byTick.set(z.i, []);
    byTick.get(z.i).push(z);
  }
  for (const rows of byTick.values()) {
    nTicks += 1;
    for (const team of [0, 1]) {
      const vals = rows.filter((z) => z.team === team);
      if (vals.length < 3) continue;
      for (const key of ['x', 'y']) {
        const vs = vals.map((z) => z[key]);
        const m = mean(vs);
        const resid = mean(vs.map((v) => (v - m) ** 2));
        (key === 'x' ? commonX : commonY).push({ m, resid });
      }
    }
  }
  // 个体残差步长：去掉同队该 tick 均值位移
  const tickList = [...byTick.keys()].sort((a, b) => a - b);
  const pos = new Map(); // i -> Map<id, z>
  for (const [, arr] of series) for (const z of arr) {
    if (!pos.has(z.i)) pos.set(z.i, new Map());
    pos.get(z.i).set(z.id, z);
  }
  for (let k = 1; k < tickList.length; k += 1) {
    const i0 = tickList[k - 1]; const i1 = tickList[k];
    if (i1 - i0 !== 1) continue;
    const m0 = pos.get(i0); const m1 = pos.get(i1);
    for (const team of [0, 1]) {
      const ids = [...m1.keys()].filter((id) => teamOf(id) === team && m0.has(id));
      if (ids.length < 3) continue;
      const dxs = ids.map((id) => m1.get(id).x - m0.get(id).x);
      const dys = ids.map((id) => m1.get(id).y - m0.get(id).y);
      const mx = mean(dxs); const my = mean(dys);
      for (const d of dxs.map((v, j) => Math.hypot(v - mx, dys[j] - my))) residualSteps.push(d);
    }
  }
  // 整队 y 同步 / 个人 churn（拆开；更新指示相关保留）
  const syn = teamStepMetrics(series, (z) => z.y);
  const updatePairCorr = [];
  for (const team of [0, 1]) {
    const ids = [...series.keys()].filter((id) => teamOf(id) === team).sort((a, b) => a - b);
    const inds = ids.map((id) => updateIndicators.get(id)).filter(Boolean);
    for (let a = 0; a < inds.length; a += 1) {
      for (let b = a + 1; b < inds.length; b += 1) {
        const n = Math.min(inds[a].length, inds[b].length);
        if (n < 20) continue;
        const c = corr(inds[a].slice(0, n), inds[b].slice(0, n));
        if (c != null) updatePairCorr.push(c);
      }
    }
  }
  // 结构量：逐帧瞬时（目标帧稀疏，不用 60 s 窗门槛），全部 valid fresh 拍。
  const shape = shapeMetrics(frames);
  const turns = turnMetrics(series);
  const cmShare = (rows) => {
    if (!rows.length) return null;
    const ms = rows.map((r) => r.m);
    const mm = mean(ms);
    const commonVar = mean(ms.map((v) => (v - mm) ** 2));
    const residVar = mean(rows.map((r) => r.resid));
    return commonVar + residVar > 1e-12 ? commonVar / (commonVar + residVar) : null;
  };
  const safeMedian = (a) => (a.length ? median(a) : null);
  return {
    nPlayers, nTicks, nSteps: stepN, nShapeFrames: shape.validFrames,
    shapeWidth: shape.width ?? null,
    shapeSpacing: shape.spacing ?? null,
    shapeMixing: shape.mixing ?? null,
    shapeCentroidGap: shape.centroidGap ?? null,
    shapeYRange: shape.yRange ?? null,
    shapeYCorr: shape.yCorr ?? null,
    shapeLaneSd: shape.laneSd ?? null,
    shapeDepth: shape.depth ?? null,
    shapeTurnDegPer100m: turns.turnDegPer100m ?? null,
    shapeTurns30Per100m: turns.turns30Per100m ?? null,
    shapeLat: null,
    targetStepM: safeMedian([...stepByPlayer.values()]),
    targetStepMeanM: steps.length ? mean(steps) : null,
    targetUpdateRate05: update05.length ? mean(update05) : null,
    targetUpdateRate10: update10.length ? mean(update10) : null,
    targetDyShare: safeMedian(dyShares.filter(isNum)),
    targetJumpP95M: steps.length ? quantile([...steps].sort((a, b) => a - b), 0.95) : null,
    targetJumpGt5Rate: steps.length ? steps.filter((v) => v > 5).length / steps.length : null,
    targetJumpGt10Rate: steps.length ? steps.filter((v) => v > 10).length / steps.length : null,
    commonShareY: cmShare(commonY),
    commonShareX: cmShare(commonX),
    individualResidualStepM: safeMedian(residualSteps),
    teamYStepCorr: syn.teamYStepCorr,
    collectiveYStepShare: syn.collectiveYStepShare,
    personalJumpRate: syn.personalJumpRate,
    updatePairCorr: safeMedian(updatePairCorr),
    syncJumpShare: syn.syncJumpShare,
    actionRunShare: actionN ? actionCounts[0] / actionN : null,
    actionMarkShare: actionN ? actionCounts[1] / actionN : null,
    actionCloseShare: actionN ? actionCounts[2] / actionN : null,
    actionChaseShare: actionN ? actionCounts[3] / actionN : null,
    nearestOppM: safeMedian(nearestOpp),
    nearOpp12Frac: nearOpp12.length ? mean(nearOpp12) : null,
    ballGoalPerpM: safeMedian(ballGoalPerp),
    dfTargetYOppY: safeMedian(oppositionCorr),
    dfTargetYBallY: safeMedian(ballCorr),
    oppSwitchRate: oppSwitch.length ? mean(oppSwitch) : null,
    jumpRateAfterSwitch: jumpAfterSwitch.length ? mean(jumpAfterSwitch) : null,
    jumpRateNoSwitch: jumpNoSwitch.length ? mean(jumpNoSwitch) : null,
    amp4p3TargetM: safeMedian(period.map((p) => p.amp4p3TargetM).filter(isNum)),
    amp18TargetM: safeMedian(period.map((p) => p.amp18TargetM).filter(isNum)),
    amp90TargetM: safeMedian(period.map((p) => p.amp90TargetM).filter(isNum)),
    dominantPeriodS: safeMedian(period.map((p) => p.dominantPeriodS).filter(isNum)),
    dominantAmpM: safeMedian(period.map((p) => p.dominantAmpM).filter(isNum)),
    acfLag1: safeMedian(period.map((p) => p.acfLag1).filter(isNum)),
    acfMax: safeMedian(period.map((p) => p.acfMax).filter(isNum)),
    dominantAmpFrac: period.length
      ? period.filter((p) => p.dominantAmpM >= 2 && p.dominantPeriodS >= 4 && p.dominantPeriodS <= 30).length / period.length
      : null,
    stepExceedFrac: stepN ? stepExceed / stepN : null,
    distTargetToPlayerM: safeMedian(targetDist),
    distTargetToPlayerP90: targetDist.length ? quantile([...targetDist].sort((a, b) => a - b), 0.9) : null,
    followAlignCos: safeMedian(followAlign),
  };
}

// actual 基线：速度态 vs 位移，证明 F1-off。
// 两种口径并列（F1 note §9.2 的教训）：
//   literal      = N5 字面口径（不跳缺口；off ≈0.696 / 0.288）
//   sameInterval = dt≤1.5 s（off ≈0.95 / ~0.15；不能用 literal 的 0.696 混比）
export function actualVelocityMetrics(series) {
  const rows = { literal: [], same: [] };
  for (const [, arr] of series) {
    for (const mode of ['literal', 'same']) {
      let staleN = 0; let total = 0;
      const vv = []; const dd = [];
      for (let k = 1; k < arr.length; k += 1) {
        if (mode === 'same' && arr[k].t - arr[k - 1].t > 1.5) continue;
        const disp = Math.hypot(arr[k].actualX - arr[k - 1].actualX, arr[k].actualY - arr[k - 1].actualY);
        const v = Math.hypot(arr[k].vx, arr[k].vy);
        const vPrev = Math.hypot(arr[k - 1].vx, arr[k - 1].vy);
        vv.push(v); dd.push(disp); total += 1;
        if (Math.abs(v - vPrev) < 1e-6 && disp > 0.5) staleN += 1;
      }
      if (total) rows[mode].push({ stale: staleN / total, corr: vv.length >= 10 ? corr(vv, dd) : null });
    }
  }
  const agg = (mode) => {
    const rs = rows[mode];
    return {
      velStaleFrac: rs.length ? mean(rs.map((r) => r.stale)) : null,
      velVsDispCorr: rs.map((r) => r.corr).filter(isNum).length
        ? median(rs.map((r) => r.corr).filter(isNum)) : null,
    };
  };
  return { literal: agg('literal'), sameInterval: agg('same') };
}

// 逐帧瞬时结构量（与 viewer/match-metrics.js 同口径：先每帧算，再对帧取均值/中位）。
// 目标帧是稀疏的 fresh phase0 样本，**不能**用 n5-movement 的 60 s 窗 80% 帧数门槛
// （实测 20 seed 只剩 4 seed 有窗）。这里对全部 valid 帧直接算。
function qSpan(sorted, lo = 0.1, hi = 0.9) {
  if (sorted.length < 2) return null;
  return quantile(sorted, hi) - quantile(sorted, lo);
}

export function shapeMetrics(frames) {
  const widths = []; const depths = []; const spacings = []; const mixings = []; const gaps = [];
  const teamY = new Map([[0, new Map()], [1, new Map()]]);
  const playerY = new Map();
  let validFrames = 0;
  for (const f of frames) {
    const ps = f.players.map((p) => ({ id: p.id, x: p.x * PITCH_LENGTH_M, y: p.y * PITCH_WIDTH_M }));
    const home = ps.filter((p) => p.id <= 10);
    const away = ps.filter((p) => p.id >= 11);
    // 与 match-metrics 同口径：两队各 ≥7 名有效外场才计该帧。
    if (home.length < 7 || away.length < 7) continue;
    validFrames += 1;
    const cents = {};
    for (const [team, tp] of [[0, home], [1, away]]) {
      const ys = tp.map((p) => p.y); const xs = tp.map((p) => p.x);
      widths.push(Math.max(...ys) - Math.min(...ys));
      const dep = qSpan([...xs].sort((a, b) => a - b));
      if (dep != null) depths.push(dep);
      let nn = 0;
      for (const p of tp) {
        let best = Infinity;
        for (const q of tp) if (q.id !== p.id) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
        if (Number.isFinite(best)) nn += best;
      }
      if (tp.length) spacings.push(nn / tp.length);
      cents[team] = { x: mean(xs), y: mean(ys) };
      for (const p of tp) {
        if (!teamY.get(team).has(p.id)) teamY.get(team).set(p.id, new Map());
        teamY.get(team).get(p.id).set(f.t, p.y);
        if (!playerY.has(p.id)) playerY.set(p.id, []);
        playerY.get(p.id).push(p.y);
      }
    }
    gaps.push(Math.hypot(cents[0].x - cents[1].x, cents[0].y - cents[1].y));
    // 混队度：全体外场里，最近邻是对方的比例。
    let opp = 0; let tot = 0;
    for (const p of ps) {
      let best = Infinity; let bid = -1;
      for (const q of ps) if (q.id !== p.id) {
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (d < best) { best = d; bid = q.id; }
      }
      if (bid >= 0) { if ((p.id <= 10) !== (bid <= 10)) opp += 1; tot += 1; }
    }
    if (tot) mixings.push(opp / tot);
  }
  const laneSd = []; const yCorrVals = [];
  for (const team of [0, 1]) {
    const m = teamY.get(team);
    const ids = [...m.keys()];
    const pairSd = []; const pairCorr = [];
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = m.get(ids[i]); const b = m.get(ids[j]);
        const common = [...a.keys()].filter((t) => b.has(t));
        if (common.length < 15) continue;
        const d = common.map((t) => a.get(t) - b.get(t));
        const md = mean(d);
        pairSd.push(Math.sqrt(mean(d.map((v) => (v - md) ** 2))));
        const c = corr(common.map((t) => a.get(t)), common.map((t) => b.get(t)));
        if (c != null) pairCorr.push(c);
      }
    }
    if (pairSd.length) laneSd.push(median(pairSd));
    if (pairCorr.length) yCorrVals.push(mean(pairCorr));
  }
  const yRanges = [];
  for (const [, ys] of playerY) {
    const r = qSpan([...ys].sort((a, b) => a - b));
    if (r != null) yRanges.push(r);
  }
  const med = (a) => (a.length ? median(a) : null);
  return {
    validFrames,
    width: med(widths), depth: med(depths), spacing: med(spacings),
    mixing: med(mixings), centroidGap: med(gaps), laneSd: med(laneSd),
    yCorr: med(yCorrVals), yRange: med(yRanges),
  };
}

// 目标轨迹（点代理）的方向变化；只作 churn/折返代理。
function turnMetrics(series) {
  const perPlayer = [];
  for (const [, arr] of series) {
    let path = 0; let turnSum = 0; let turn30 = 0; let nTurn = 0;
    let prev = null;
    const px = (z) => (z.x != null ? z.x : z.actualX);
    const py = (z) => (z.y != null ? z.y : z.actualY);
    for (let k = 1; k < arr.length; k += 1) {
      if (arr[k].t - arr[k - 1].t > 1.5) { prev = null; continue; }
      const dx = px(arr[k]) - px(arr[k - 1]); const dy = py(arr[k]) - py(arr[k - 1]);
      const d = Math.hypot(dx, dy);
      if (d < 1e-9) continue;
      path += d;
      if (d > 0.5 && prev) {
        const c = (dx * prev.dx + dy * prev.dy) / (d * Math.hypot(prev.dx, prev.dy));
        const ang = Math.acos(Math.max(-1, Math.min(1, c)));
        turnSum += ang; nTurn += 1; if (ang > Math.PI / 6) turn30 += 1;
      }
      prev = d > 0.5 ? { dx, dy } : null;
    }
    if (path > 1) perPlayer.push({ path, turn: (turnSum * 180 / Math.PI) * 100 / path, turn30: turn30 * 100 / path });
  }
  if (!perPlayer.length) return { turnDegPer100m: null, turns30Per100m: null };
  return {
    turnDegPer100m: median(perPlayer.map((p) => p.turn)),
    turns30Per100m: median(perPlayer.map((p) => p.turn30)),
  };
}

const METRIC_KEYS = [
  'shapeWidth', 'shapeSpacing', 'shapeMixing', 'shapeCentroidGap', 'shapeYRange', 'shapeYCorr',
  'shapeLaneSd', 'shapeDepth', 'shapeTurnDegPer100m', 'shapeTurns30Per100m', 'shapeLat',
  'targetStepM', 'targetStepMeanM', 'targetUpdateRate05', 'targetUpdateRate10', 'targetDyShare',
  'targetJumpP95M', 'targetJumpGt5Rate', 'targetJumpGt10Rate', 'commonShareY', 'commonShareX',
  'individualResidualStepM', 'teamYStepCorr', 'collectiveYStepShare', 'personalJumpRate',
  'updatePairCorr', 'syncJumpShare', 'actionRunShare', 'actionMarkShare', 'actionCloseShare',
  'actionChaseShare',
  'nearestOppM', 'nearOpp12Frac', 'ballGoalPerpM', 'dfTargetYOppY', 'dfTargetYBallY',
  'oppSwitchRate', 'jumpRateAfterSwitch', 'jumpRateNoSwitch',
  'amp4p3TargetM', 'amp18TargetM', 'amp90TargetM', 'dominantPeriodS', 'dominantAmpM',
  'acfLag1', 'acfMax', 'dominantAmpFrac', 'stepExceedFrac', 'distTargetToPlayerM',
  'distTargetToPlayerP90', 'followAlignCos',
];

function aggregateSeedMetrics(seedMetrics) {
  const out = { nSeeds: seedMetrics.length };
  for (const key of METRIC_KEYS) {
    const vals = seedMetrics.map((m) => m[key]).filter(isNum);
    out[key] = vals.length ? {
      median: median(vals), mean: mean(vals), iqr: iqr(vals), n: vals.length,
    } : null;
  }
  return out;
}

// 真实锚（逐场中位 → 跨场中位）。只作参照。
export function loadRealAnchors(path) {
  if (!existsSync(path)) return null;
  const j = JSON.parse(readFileSync(path, 'utf8'));
  const games = Object.keys(j.real || {});
  const sc = games.filter((k) => k.startsWith('skillcorner'));
  const met = games.filter((k) => k.startsWith('real-game'));
  const calibers = {
    sc_primary_1hz: 'trajPrimary', sc_all_1hz: 'trajAllPoints',
    sc_primary_5hz: 'trajPrimary5Hz', sc_all_5hz: 'trajAllPoints5Hz',
    metrica_1hz: 'trajPrimary', metrica_5hz: 'trajPrimary5Hz',
  };
  const keys = ['width', 'spacing', 'mixing', 'centroidGap', 'yRange', 'yCorr', 'laneSd', 'depth'];
  const summarize = (list, prop) => {
    const out = { nGames: list.length };
    for (const key of keys) {
      const vals = list.map((g) => j.real[g]?.[prop]?.[key]?.median).filter(isNum);
      out[key] = vals.length ? median(vals) : null;
    }
    return out;
  };
  const out = { source: path };
  for (const [name, prop] of Object.entries(calibers)) {
    out[name] = summarize(name.startsWith('metrica') ? met : sc, prop);
  }
  return out;
}

function fmt(v, d = 2) {
  return v == null || !Number.isFinite(Number(v)) ? 'n/a' : Number(v).toFixed(d);
}
function fmtPct(v, d = 1) {
  return v == null || !Number.isFinite(Number(v)) ? 'n/a' : `${(100 * v).toFixed(d)}%`;
}

export const H4_METRICS = ['amp4p3TargetM', 'amp18TargetM', 'dominantAmpFrac'];
export const H4_REPORT_METRICS = [...H4_METRICS, 'teamYStepCorr', 'collectiveYStepShare', 'syncJumpShare', 'commonShareY', 'personalJumpRate', 'targetStepM'];

// C2 固定种子零分布：每个 H4 量的 C2 per-seed 分布的 95 分位。H4 用它判“是否新于 C2”，
// 不再用事后 C2+0.10 的绝对阈值。
export function c2NullDistribution(seedMetrics) {
  const out = { nSeeds: seedMetrics.length, metrics: {} };
  for (const key of H4_REPORT_METRICS) {
    const vals = seedMetrics.map((m) => m[key]).filter(isNum).sort((a, b) => a - b);
    out.metrics[key] = vals.length ? {
      p95: quantile(vals, 0.95),
      median: median(vals),
      min: vals[0],
      max: vals[vals.length - 1],
      n: vals.length,
    } : null;
  }
  return out;
}

function evaluate(summary, c2Null, seedMetrics, realAnchors, realCommon) {
  const c2 = summary.C2;
  const get = (v, k) => summary[v]?.[k]?.median ?? null;
  const del = (v, k) => {
    const a = get(v, k); const b = get('C2', k);
    return a == null || b == null ? null : a - b;
  };
  const evals = [...SHADOW_VARIANTS, ...DEPLOYABLE];
  const realDepth = realAnchors?.sc_all_5hz?.depth ?? null;
  const realLaneSd = realAnchors?.sc_all_5hz?.laneSd ?? null;
  const rcAll = realCommon?.sc20?.['5hz']?.all || null;
  const realSyncCeil = {
    teamYStepCorr: rcAll?.teamYStepCorr?.max ?? null,
    collectiveYStepShare: rcAll?.collectiveYStepShare?.max ?? null,
    ballYCorr: rcAll?.ballYCorr?.max ?? null,
  };
  const h4For = (v) => {
    // 周期：C2 固定种子 per-seed p95（review 要求）。y 同步：不能用 C2 p95 判“新”，
    // 因为真实 y 同步高于 C2（H1 订正）；改用 real 上界 + 0.05 的过冲判据。
    const periodExceed = H4_METRICS.filter((k) => {
      const a = get(v, k); const th = c2Null?.metrics?.[k]?.p95;
      return a != null && th != null && a > th;
    });
    const syncOvershoot = [];
    if (realSyncCeil.teamYStepCorr != null && get(v, 'teamYStepCorr') > realSyncCeil.teamYStepCorr + 0.05) syncOvershoot.push('teamYStepCorr>realMax');
    if (realSyncCeil.collectiveYStepShare != null && get(v, 'collectiveYStepShare') > realSyncCeil.collectiveYStepShare + 0.05) syncOvershoot.push('collectiveYStepShare>realMax');
    if (realSyncCeil.ballYCorr != null && get(v, 'dfTargetYBallY') > realSyncCeil.ballYCorr + 0.05) syncOvershoot.push('dfTargetYBallY>realMax');
    const exceedP95Frac = {};
    for (const k of H4_METRICS) {
      const th = c2Null?.metrics?.[k]?.p95;
      const vals = (seedMetrics[v] || []).map((m) => m[k]).filter(isNum);
      exceedP95Frac[k] = th == null || !vals.length ? null : vals.filter((x) => x > th).length / vals.length;
    }
    return {
      nullTriggered: periodExceed.length > 0 || syncOvershoot.length > 0,
      periodExceed,
      syncOvershoot,
      exceedingMetrics: [...periodExceed, ...syncOvershoot],
      c2P95: Object.fromEntries(H4_METRICS.map((k) => [k, c2Null?.metrics?.[k]?.p95 ?? null])),
      realSyncCeil,
      exceedP95Frac,
      amp4p3TargetM: get(v, 'amp4p3TargetM'),
      amp18TargetM: get(v, 'amp18TargetM'),
      dominantPeriodS: get(v, 'dominantPeriodS'),
      dominantAmpM: get(v, 'dominantAmpM'),
      dominantAmpFrac: get(v, 'dominantAmpFrac'),
      teamYStepCorr: get(v, 'teamYStepCorr'),
      collectiveYStepShare: get(v, 'collectiveYStepShare'),
      commonShareY: get(v, 'commonShareY'),
      personalJumpRate: get(v, 'personalJumpRate'),
      syncJumpShare: get(v, 'syncJumpShare'),
    };
  };
  const h1 = {};
  const h2 = {};
  const h4 = {};
  for (const v of evals) {
    h4[v] = h4For(v);
    // H1（审阅订正）：不再要求 commonY 下降。real 的 commonY 高于 engine；真正的缺口是
    // y 的集体移动/同步。H1b 要求 commonY 与 teamYStepCorr 都朝 real 方向上升 ≥0.10，
    // 且不能靠球共模（Δty~ΔballY ≤0.60）。commonX 只报告是否落在 real 范围。
    const c2CommonY = get('C2', 'commonShareY');
    const c2TeamY = get('C2', 'teamYStepCorr');
    const commonY = get(v, 'commonShareY');
    const teamY = get(v, 'teamYStepCorr');
    const ballY = get(v, 'dfTargetYBallY');
    const realCommonY = realCommon?.sc20?.['5hz']?.all?.commonY?.median ?? null;
    const realTeamY = realCommon?.sc20?.['5hz']?.all?.teamYStepCorr?.median ?? null;
    h1[v] = {
      commonX: get(v, 'commonShareX'),
      commonXVsC2: del(v, 'commonShareX'),
      realCommonX: realCommon?.sc20?.['5hz']?.all?.commonX?.median ?? null,
      commonY,
      commonYVsC2: commonY == null || c2CommonY == null ? null : commonY - c2CommonY,
      realCommonY,
      teamYStepCorr: teamY,
      teamYStepCorrVsC2: teamY == null || c2TeamY == null ? null : teamY - c2TeamY,
      realTeamYStepCorr: realTeamY,
      dfTargetYBallY: ballY,
      // 审阅订正后的 H1 方向：y 集体量朝 real 上升、不靠球共模、且 H4 无新同步/周期。
      revisedYNumeric: commonY != null && c2CommonY != null && realCommonY != null
        && commonY >= c2CommonY + 0.10 && commonY <= realCommonY + 0.10
        && teamY != null && c2TeamY != null && realTeamY != null && teamY >= c2TeamY + 0.10
        && ballY != null && ballY <= 0.60,
      revisedYPass: commonY != null && c2CommonY != null && realCommonY != null
        && commonY >= c2CommonY + 0.10 && commonY <= realCommonY + 0.10
        && teamY != null && c2TeamY != null && realTeamY != null && teamY >= c2TeamY + 0.10
        && ballY != null && ballY <= 0.60
        && !h4[v].nullTriggered,
      notLowerY: commonY != null && c2CommonY != null && commonY >= c2CommonY,
    };
    const dw = del(v, 'shapeWidth');
    const ds = del(v, 'shapeSpacing');
    const dmix = del(v, 'shapeMixing');
    const dyc = del(v, 'shapeYCorr');
    const dgap = del(v, 'shapeCentroidGap');
    const moved5 = [
      dw != null && dw >= 3, ds != null && ds >= 1.5, dmix != null && dmix >= 0.10,
      dyc != null && dyc >= 0.10, dgap != null && dgap <= -1.0,
    ].filter(Boolean).length;
    // depth/laneSd 只作补充：depth 的真实锚方向在 primary/all 间反转（18.18 vs 25.66），
    // 因此只判“更接近 all 5Hz 参照”，不计入预注册 moved5。
    const vDepth = get(v, 'shapeDepth');
    const vLane = get(v, 'shapeLaneSd');
    const c2Depth = get('C2', 'shapeDepth');
    const c2Lane = get('C2', 'shapeLaneSd');
    const depthCloser = vDepth != null && c2Depth != null && realDepth != null
      ? Math.abs(vDepth - realDepth) < Math.abs(c2Depth - realDepth) : null;
    const laneCloser = vLane != null && c2Lane != null && realLaneSd != null
      ? Math.abs(vLane - realLaneSd) < Math.abs(c2Lane - realLaneSd) : null;
    const moved7 = moved5 + (depthCloser ? 1 : 0) + (laneCloser ? 1 : 0);
    h2[v] = {
      dw, ds, dmix, dyc, dgap, moved5, moved7,
      ddepth: vDepth == null || c2Depth == null ? null : vDepth - c2Depth,
      dlaneSd: vLane == null || c2Lane == null ? null : vLane - c2Lane,
      depthCloser, laneCloser, depthAmbiguous: true,
      passTarget: moved5 >= 2,
      passTarget7: moved7 >= 3,
    };
  }
  // H3 消融一律相对**母变体**（不是 C2）。
  const relTo = (v, parent, key) => {
    const a = get(v, key); const b = get(parent, key);
    return a == null || b == null ? null : a - b;
  };
  const ablation = {
    'V1-no-opp': {
      mixDrop: -(relTo('V1-no-opp', 'V1', 'shapeMixing') ?? NaN),
      widthDrop: -(relTo('V1-no-opp', 'V1', 'shapeWidth') ?? NaN),
      pass: (-(relTo('V1-no-opp', 'V1', 'shapeMixing') ?? -Infinity) >= 0.10)
        || (-(relTo('V1-no-opp', 'V1', 'shapeWidth') ?? -Infinity) >= 3),
    },
    'V1-no-sep': {
      spacingDrop: -(relTo('V1-no-sep', 'V1', 'shapeSpacing') ?? NaN),
      widthDrop: -(relTo('V1-no-sep', 'V1', 'shapeWidth') ?? NaN),
      pass: (-(relTo('V1-no-sep', 'V1', 'shapeSpacing') ?? -Infinity) >= 1.5)
        || (-(relTo('V1-no-sep', 'V1', 'shapeWidth') ?? -Infinity) >= 3),
    },
    'V2-no-opp': {
      mixDrop: -(relTo('V2-no-opp', 'V2', 'shapeMixing') ?? NaN),
      commonRise: relTo('V2-no-opp', 'V2', 'commonShareY') ?? NaN,
      pass: (-(relTo('V2-no-opp', 'V2', 'shapeMixing') ?? -Infinity) >= 0.10)
        || ((relTo('V2-no-opp', 'V2', 'commonShareY') ?? -Infinity) >= 0.10),
    },
    'V3-no-line': {
      mixDrop: -(relTo('V3-no-line', 'V3', 'shapeMixing') ?? NaN),
      yCorrDrop: -(relTo('V3-no-line', 'V3', 'shapeYCorr') ?? NaN),
      pass: (-(relTo('V3-no-line', 'V3', 'shapeMixing') ?? -Infinity) >= 0.10)
        || (-(relTo('V3-no-line', 'V3', 'shapeYCorr') ?? -Infinity) >= 0.10),
    },
  };
  return {
    h1, h2, h3: ablation, h4, c2Null, realCommon,
    deployable: DEPLOYABLE,
    c2CommonShareY: c2?.commonShareY?.median ?? null,
    c2CommonShareX: c2?.commonShareX?.median ?? null,
  };
}

function makeTables(result) {
  const lines = [];
  const real = result.realAnchors?.sc_all_5hz || null;
  const rcAllRaw = result.realCommon?.sc20?.['5hz']?.all || null;
  const rcPrimaryRaw = result.realCommon?.sc20?.['5hz']?.primary || null;
  const rv = (o, k) => o?.[k]?.median ?? null;
  const rcAll = rcAllRaw ? {
    commonX: rv(rcAllRaw, 'commonX'), commonY: rv(rcAllRaw, 'commonY'),
    teamYStepCorr: rv(rcAllRaw, 'teamYStepCorr'),
    collectiveYStepShare: rv(rcAllRaw, 'collectiveYStepShare'),
    ballYCorr: rv(rcAllRaw, 'ballYCorr'),
  } : null;
  const rcPrimary = rcPrimaryRaw ? {
    commonX: rv(rcPrimaryRaw, 'commonX'), commonY: rv(rcPrimaryRaw, 'commonY'),
    teamYStepCorr: rv(rcPrimaryRaw, 'teamYStepCorr'),
    collectiveYStepShare: rv(rcPrimaryRaw, 'collectiveYStepShare'),
    ballYCorr: rv(rcPrimaryRaw, 'ballYCorr'),
  } : null;
  lines.push('# C2 影子目标指标（目标点代理 vs 实际位置；起始 phase 主口径）');
  lines.push('');
  lines.push(`样本：${result.meta.nSeeds} seeds × ${result.meta.duration}s，A6；` +
    `目标统计 = fresh + **起始 phase 0**（ticks[i-1]）；summaryEndPhase 为旧口径（tick 末 phase）。`);
  lines.push('结构量 = `shapeMetrics` 逐帧瞬时（valid fresh 帧），不是 60 s 窗；目标帧排除 carrier，' +
    'actual_all 行 = 全外场实际位置（所有变体共享）。');
  const ad = result.meta.actionDistribution;
  if (ad) lines.push(`A6 动作占比（fresh 起始 phase 0）：run **${fmtPct(ad.run)}**、mark **${fmtPct(ad.mark)}**、close_down **${fmtPct(ad.closeDown)}**（n=${ad.n}）。`);
  lines.push('');
  lines.push('## 结构量（**V1–V3 / hybrid 是目标点代理**；actual_all 是实际位置；real 是真实实际位置，仅参照）');
  lines.push('| 行 | width | spacing | mixing | centroidGap | yRange | yCorr | laneSd | depth | 目标轨迹 turn/100m | >30°/100m |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of [...VARIANTS, 'actual_all']) {
    const m = result.summary[r];
    if (!m) continue;
    lines.push(`| ${r} | ${fmt(m.shapeWidth?.median)} | ${fmt(m.shapeSpacing?.median)} | ${fmt(m.shapeMixing?.median, 3)} | ${fmt(m.shapeCentroidGap?.median)} | ${fmt(m.shapeYRange?.median)} | ${fmt(m.shapeYCorr?.median, 3)} | ${fmt(m.shapeLaneSd?.median)} | ${fmt(m.shapeDepth?.median)} | ${fmt(m.shapeTurnDegPer100m?.median, 1)} | ${fmt(m.shapeTurns30Per100m?.median, 1)} |`);
  }
  if (real) {
    lines.push(`| real SC20 all 5Hz（参照，实际位置） | ${fmt(real.width)} | ${fmt(real.spacing)} | ${fmt(real.mixing, 3)} | ${fmt(real.centroidGap)} | ${fmt(real.yRange)} | ${fmt(real.yCorr, 3)} | ${fmt(real.laneSd)} | ${fmt(real.depth)} | n/a | n/a |`);
  }
  lines.push('');
  lines.push('## 目标 churn / 共同信号 / 执行器代理');
  lines.push('| 变体 | step(m/tick) | 更新>0.5 | 个人大跳 | 个人大跳共现 | commonY | commonX | 个体残差step | 同队Δy相关 | 整队y平移占比 | step>6.5m | 目标距球员p90(m) | 跟随cos |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const v of VARIANTS) {
    const m = result.summary[v];
    if (!m) continue;
    lines.push(`| ${v} | ${fmt(m.targetStepM?.median)} | ${fmtPct(m.targetUpdateRate05?.median)} | ${fmtPct(m.personalJumpRate?.median)} | ${fmtPct(m.syncJumpShare?.median)} | ${fmt(m.commonShareY?.median, 3)} | ${fmt(m.commonShareX?.median, 3)} | ${fmt(m.individualResidualStepM?.median)} | ${fmt(m.teamYStepCorr?.median, 3)} | ${fmt(m.collectiveYStepShare?.median, 3)} | ${fmtPct(m.stepExceedFrac?.median)} | ${fmt(m.distTargetToPlayerP90?.median)} | ${fmt(m.followAlignCos?.median, 3)} |`);
  }
  lines.push('');
  lines.push('## 周期性 / 局部性（对手切换只用**律内 oppId**；C2 用起始位置最近对手作 proxy，显式分开）');
  lines.push('| 变体 | amp4.3s(m) | amp18s(m) | amp90s(m) | 主导周期(s) | 主导幅值(m) | 主导≥2m占比 | acf lag1 | 目标-最近对手(m) | ≤12m 占比 | 球-门线距离(m) | Δty~ΔoppY | Δty~ΔballY | 对手切换率 | 切换后大跳 | 非切换大跳 |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const v of VARIANTS) {
    const m = result.summary[v];
    if (!m) continue;
    lines.push(`| ${v} | ${fmt(m.amp4p3TargetM?.median)} | ${fmt(m.amp18TargetM?.median)} | ${fmt(m.amp90TargetM?.median)} | ${fmt(m.dominantPeriodS?.median, 1)} | ${fmt(m.dominantAmpM?.median)} | ${fmtPct(m.dominantAmpFrac?.median)} | ${fmt(m.acfLag1?.median, 3)} | ${fmt(m.nearestOppM?.median)} | ${fmtPct(m.nearOpp12Frac?.median)} | ${fmt(m.ballGoalPerpM?.median)} | ${fmt(m.dfTargetYOppY?.median, 3)} | ${fmt(m.dfTargetYBallY?.median, 3)} | ${fmtPct(m.oppSwitchRate?.median)} | ${fmtPct(m.jumpRateAfterSwitch?.median)} | ${fmtPct(m.jumpRateNoSwitch?.median)} |`);
  }
  lines.push('');
  lines.push('## 可部署 hybrid（run 用影子律；mark/close 保留 C2）：H2 + 执行器门');
  lines.push('| hybrid | width | spacing | mixing | yCorr | centroidGap | depth | laneSd | Δwidth | Δspacing | Δmix | ΔyCorr | Δgap | moved5 | moved7 | step | step>6.5 | personalJump | H4 null | moved5(末phase) | step(末) | >6.5(末) |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  const c2End = result.summaryEndPhase?.C2;
  const h2End = (v) => {
    const s = result.summaryEndPhase?.[v];
    if (!s || !c2End) return null;
    const d = (k) => (c2End[k]?.median == null || s[k]?.median == null ? null : s[k].median - c2End[k].median);
    const dw = d('shapeWidth'); const ds = d('shapeSpacing'); const dm = d('shapeMixing'); const dy = d('shapeYCorr'); const dg = d('shapeCentroidGap');
    return [dw, ds, dm, dy, dg].filter((x, i) => x != null && [x >= 3, x >= 1.5, x >= 0.10, x >= 0.10, x <= -1][i]).length;
  };
  for (const v of DEPLOYABLE) {
    const m = result.summary[v];
    const me = result.summaryEndPhase?.[v];
    const h2 = result.verdicts.h2[v];
    const h4 = result.verdicts.h4[v];
    if (!m) continue;
    lines.push(`| ${v} | ${fmt(m.shapeWidth?.median)} | ${fmt(m.shapeSpacing?.median)} | ${fmt(m.shapeMixing?.median, 3)} | ${fmt(m.shapeYCorr?.median, 3)} | ${fmt(m.shapeCentroidGap?.median)} | ${fmt(m.shapeDepth?.median)} | ${fmt(m.shapeLaneSd?.median)} | ${fmt(h2.dw)} | ${fmt(h2.ds)} | ${fmt(h2.dmix, 3)} | ${fmt(h2.dyc, 3)} | ${fmt(h2.dgap)} | ${h2.moved5}/5 | ${h2.moved7}/7 | ${fmt(m.targetStepM?.median)} | ${fmtPct(m.stepExceedFrac?.median)} | ${fmtPct(m.personalJumpRate?.median)} | ${h4.nullTriggered ? 'TRIGGER' : 'ok'} | ${h2End(v)}/5 | ${fmt(me?.targetStepM?.median)} | ${fmtPct(me?.stepExceedFrac?.median)} |`);
  }
  lines.push('');
  lines.push('## H4：周期用 C2 固定种子 p95；y 同步用过冲 real 上界（real 高于 C2，不能把“变同步”当新周期）');
  lines.push('| 变体 | 周期触发量 | amp4.3 p95 | amp18 p95 | domFrac p95 | 同步过冲 | real teamYΔ max | real 整队y平移 max | real ballYCorr max |');
  lines.push('|---|---:|---:|---:|---:|---|---:|---:|---:|');
  const p95 = (k) => result.c2Null?.metrics?.[k]?.p95;
  const ceil = result.verdicts.h4[Object.keys(result.verdicts.h4)[0]]?.realSyncCeil || {};
  for (const v of [...SHADOW_VARIANTS, ...DEPLOYABLE]) {
    const h4 = result.verdicts.h4[v];
    lines.push(`| ${v} | ${h4.periodExceed?.join(',') || '—'} | ${fmt(p95('amp4p3TargetM'))} | ${fmt(p95('amp18TargetM'))} | ${fmtPct(p95('dominantAmpFrac'))} | ${h4.syncOvershoot?.join(',') || '—'} | ${fmt(ceil.teamYStepCorr, 3)} | ${fmt(ceil.collectiveYStepShare, 3)} | ${fmt(ceil.ballYCorr, 3)} |`);
  }
  lines.push('');
  lines.push('（period exceed≥50% seeds：见 `verdicts.h4.*.exceedP95Frac`；C2 p95 是固定 20 seed 的零分布，不是正式门。）');
  lines.push('');
  lines.push('## 起始 phase vs 末 phase（旧口径；H4/step 会翻转）');
  lines.push('| 变体 | step 起始 | step 末 | >6.5 起始 | >6.5 末 | 个人大跳共现 起始 | 个人大跳共现 末 | teamYΔ相关 起始 | teamYΔ相关 末 | commonY 起始 | commonY 末 | amp4.3 起始 | amp4.3 末 | amp18 起始 | amp18 末 |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const v of ['C2', ...DEPLOYABLE, 'V1', 'V3']) {
    const a = result.summary[v]; const b = result.summaryEndPhase?.[v];
    if (!a || !b) continue;
    lines.push(`| ${v} | ${fmt(a.targetStepM?.median)} | ${fmt(b.targetStepM?.median)} | ${fmtPct(a.stepExceedFrac?.median)} | ${fmtPct(b.stepExceedFrac?.median)} | ${fmtPct(a.syncJumpShare?.median)} | ${fmtPct(b.syncJumpShare?.median)} | ${fmt(a.teamYStepCorr?.median, 3)} | ${fmt(b.teamYStepCorr?.median, 3)} | ${fmt(a.commonShareY?.median, 3)} | ${fmt(b.commonShareY?.median, 3)} | ${fmt(a.amp4p3TargetM?.median)} | ${fmt(b.amp4p3TargetM?.median)} | ${fmt(a.amp18TargetM?.median)} | ${fmt(b.amp18TargetM?.median)} |`);
  }
  lines.push('');
  lines.push('## actual 位置层：common-mode 与同步（F1-off 上下文；不是目标代理）');
  const ap = result.actualPosition || {};
  lines.push('| 口径 | commonX | commonY | 同队Δy相关 | 整队y平移占比 | 个人大跳 | Δty~ΔballY |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  lines.push(`| engine A6 actual（${result.meta.nSeeds} seeds） | ${fmt(ap.actualCommonX?.median, 3)} | ${fmt(ap.actualCommonY?.median, 3)} | ${fmt(ap.actualTeamYStepCorr?.median, 3)} | ${fmt(ap.actualCollectiveYStepShare?.median, 3)} | ${fmtPct(ap.actualPersonalJumpRate?.median)} | ${fmt(ap.actualBallYCorr?.median, 3)} |`);
  if (rcAll) lines.push(`| real SC20 all 5Hz（参照，actual） | ${fmt(rcAll.commonX, 3)} | ${fmt(rcAll.commonY, 3)} | ${fmt(rcAll.teamYStepCorr, 3)} | ${fmt(rcAll.collectiveYStepShare, 3)} | n/a | ${fmt(rcAll.ballYCorr, 3)} |`);
  if (rcPrimary) lines.push(`| real SC20 primary 5Hz（参照，actual） | ${fmt(rcPrimary.commonX, 3)} | ${fmt(rcPrimary.commonY, 3)} | ${fmt(rcPrimary.teamYStepCorr, 3)} | ${fmt(rcPrimary.collectiveYStepShare, 3)} | n/a | ${fmt(rcPrimary.ballYCorr, 3)} |`);
  if (result.realCommon?.reviewerCrossCheck) lines.push(`| 审阅独立测量（SC20 all，参考） | ${fmt(result.realCommon.reviewerCrossCheck.commonX, 3)} | ${fmt(result.realCommon.reviewerCrossCheck.commonY, 3)} | ${fmt(result.realCommon.reviewerCrossCheck.teamYStepCorr, 3)} | n/a | n/a | ${fmt(result.realCommon.reviewerCrossCheck.ballYCorr, 3)} |`);
  const av = result.actualMetrics;
  if (av) {
    lines.push('');
    lines.push('### F1-off 速度基线（所有变体共享；主行用末 phase 以对齐 N5 旧口径）');
    lines.push(`- literal（N5 字面，不跳缺口）：velStaleFrac **${fmt(av.velStaleFrac?.median, 3)}**、velVsDispCorr **${fmt(av.velVsDispCorr?.median, 3)}**；N5 A6 off ≈0.696 / 0.288。`);
    lines.push(`- sameInterval（dt≤1.5 s）：velStaleFrac **${fmt(av.velStaleFracSameInterval?.median, 3)}**、velVsDispCorr **${fmt(av.velVsDispCorrSameInterval?.median, 3)}**；两口径不可混比。`);
    const avs = result.actualMetricsStart;
    if (avs) lines.push(`- 起始 phase 口径（并列）：literal velStale ${fmt(avs.velStaleFrac?.median, 3)}、velCorr ${fmt(avs.velVsDispCorr?.median, 3)}；sameInterval ${fmt(avs.velStaleFracSameInterval?.median, 3)} / ${fmt(avs.velVsDispCorrSameInterval?.median, 3)}。`);
    const app = result.actualPeriodicity;
    if (app) lines.push(`- actual 周期基线（全 tick）：amp18 **${fmt(app.amp18TargetM?.median)} m**、amp4.3 **${fmt(app.amp4p3TargetM?.median)} m**、主导周期 **${fmt(app.dominantPeriodS?.median, 1)} s**。`);
  }
  lines.push('');
  lines.push('## 判据（审阅订正后；H4 用 C2 p95 零分布）');
  for (const v of [...SHADOW_VARIANTS, ...DEPLOYABLE]) {
    const h1 = result.verdicts.h1[v]; const h2 = result.verdicts.h2[v]; const h4 = result.verdicts.h4[v];
    lines.push(`- **${v}**：H1 revised ${h1.revisedYPass ? 'PASS' : 'fail'}（数值方向 ${h1.revisedYNumeric ? 'ok' : 'fail'}；commonY ${fmt(h1.commonY, 3)} vs C2 ${fmt(result.summary.C2.commonShareY?.median, 3)}、real ${fmt(h1.realCommonY, 3)}；teamYΔ ${fmt(h1.teamYStepCorr, 3)} vs C2 ${fmt(result.summary.C2.teamYStepCorr?.median, 3)}、real ${fmt(h1.realTeamYStepCorr, 3)}；Δty~ΔballY ${fmt(h1.dfTargetYBallY, 3)}）；` +
      `H2 ${h2.passTarget ? 'PASS' : 'fail'}（moved5 ${h2.moved5}/5、moved7 ${h2.moved7}/7；Δwidth ${fmt(h2.dw)}、Δspacing ${fmt(h2.ds)}、Δmix ${fmt(h2.dmix, 3)}、ΔyCorr ${fmt(h2.dyc, 3)}、Δgap ${fmt(h2.dgap)}、Δdepth ${fmt(h2.ddepth)}、ΔlaneSd ${fmt(h2.dlaneSd)}）；` +
      `H4 ${h4.nullTriggered ? 'TRIGGER' : 'ok'}（${h4.exceedingMetrics?.join(',') || '—'}）；step ${fmt(result.summary[v].targetStepM?.median)}、>6.5 ${fmtPct(result.summary[v].stepExceedFrac?.median)}。`);
  }
  lines.push('');
  lines.push('## 消融（H3）');
  for (const [v, h] of Object.entries(result.verdicts.h3)) {
    lines.push(`- **${v}**：${h.pass ? '机制必要' : '未达阈值（不必要/被掩盖）'} — ` +
      `${Object.entries(h).filter(([k]) => k !== 'pass').map(([k, val]) => `${k} ${fmt(val, 3)}`).join('；')}`);
  }
  return `${lines.join('\n')}\n`;
}

function makeSummarySvg(result, outDir) {
  // 三个面板：结构量 / 共同信号 / churn-同步。目标行明确标 target proxy。
  const rows = ['C2', 'V1', 'V1-no-opp', 'V2', 'V3', 'hybrid-V1', 'hybrid-V1-no-opp', 'actual_all'];
  const labels = { C2: 'C2目标', V1: 'V1目标', 'V1-no-opp': 'V1-no-opp', V2: 'V2目标', V3: 'V3目标', 'hybrid-V1': 'hybrid-V1', 'hybrid-V1-no-opp': 'hybrid-V1-no-opp', actual_all: 'actual实际' };
  const real = result.realAnchors?.sc_all_5hz || {};
  const panels = [
    { title: '结构量（width/spacing/mixing，目标=代理）', keys: ['shapeWidth', 'shapeSpacing', 'shapeMixing'], realKeys: ['width', 'spacing', 'mixing'] },
    { title: '共同信号（commonShare x/y）', keys: ['commonShareX', 'commonShareY'], realKeys: [] },
    { title: 'churn / 同步（step/6.5m/sync）', keys: ['targetStepM', 'stepExceedFrac', 'syncJumpShare'], realKeys: [] },
  ];
  const W = 1200; const H = 640; const panelW = W - 40; const panelH = 180;
  const lines = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    '<rect width="100%" height="100%" fill="white"/>',
    '<text x="20" y="24" font-size="15" font-family="sans-serif">C2 shadow targets (target proxy vs actual; real = actual positions, reference only)</text>'];
  panels.forEach((panel, pi) => {
    const y0 = 44 + pi * panelH;
    lines.push(`<text x="20" y="${y0 + 16}" font-size="13" font-family="sans-serif">${panel.title}</text>`);
    const barH = 13; const gap = 3; const left = 120; const right = 1150;
    const groupW = (right - left) / rows.length;
    panel.keys.forEach((key, ki) => {
      const vals = rows.map((r) => result.summary[r]?.[key]?.median ?? 0);
      const rv = panel.realKeys[ki] != null ? real[panel.realKeys[ki]] : null;
      const max = Math.max(...vals, rv ?? 0, 1e-9);
      rows.forEach((r, ri) => {
        const v = vals[ri];
        const bw = ((v / max) * (groupW - 12));
        const x = left + ri * groupW + 6;
        const y = y0 + 28 + ki * (barH + gap);
        lines.push(`<rect x="${x.toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="${barH}" fill="${['#4a7fb5', '#e08b3c', '#6aa84f'][ki]}"/>`);
        lines.push(`<text x="${(x + bw + 3).toFixed(1)}" y="${y + 10}" font-size="9" font-family="monospace">${v.toFixed(2)}</text>`);
      });
      if (rv != null) {
        const x = left + (right - left) - 8;
        const y = y0 + 28 + ki * (barH + gap);
        lines.push(`<line x1="${x - 4}" y1="${y}" x2="${x - 4}" y2="${y + barH}" stroke="#c00" stroke-width="2"/>`);
        lines.push(`<text x="${x - 40}" y="${y + 10}" font-size="9" font-family="monospace" fill="#c00">real ${Number(rv).toFixed(2)}</text>`);
      }
    });
    rows.forEach((r, ri) => {
      lines.push(`<text x="${(left + ri * groupW + 6).toFixed(1)}" y="${y0 + 28 + panel.keys.length * (barH + gap) + 10}" font-size="9" font-family="sans-serif">${labels[r]}</text>`);
    });
  });
  lines.push('</svg>');
  writeFileSync(join(outDir, 'fig', 'summary.svg'), `${lines.join('\n')}\n`);
}

function makeSvg(result, outDir) {
  // 简单目标 y 分布图（按变体分箱）+ width 条形图；不引入依赖。
  const variants = VARIANTS;
  const W = 1100; const H = 40 + variants.length * 42;
  const bins = 34; // y ∈ [0,68]
  const maxCount = Math.max(...variants.map((v) => {
    const h = result.yHist[v] || new Array(bins).fill(0);
    return Math.max(...h);
  }), 1);
  const lines = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="100%" height="100%" fill="white"/>`,
    `<text x="10" y="20" font-size="14" font-family="sans-serif">C2 shadow target: y distribution (goal-line horizontal); target proxy, 300s x seeds</text>`];
  variants.forEach((v, row) => {
    const h = result.yHist[v] || new Array(bins).fill(0);
    const y0 = 32 + row * 42;
    lines.push(`<text x="10" y="${y0 + 22}" font-size="12" font-family="monospace">${v}</text>`);
    for (let b = 0; b < bins; b += 1) {
      const bh = (h[b] / maxCount) * 32;
      const x = 120 + (b * (W - 150)) / bins;
      lines.push(`<rect x="${x.toFixed(1)}" y="${(y0 + 32 - bh).toFixed(1)}" width="${((W - 150) / bins - 1).toFixed(1)}" height="${bh.toFixed(1)}" fill="#4a7fb5"/>`);
    }
  });
  lines.push('</svg>');
  writeFileSync(join(outDir, 'fig', 'target-y-hist.svg'), `${lines.join('\n')}\n`);
}

export function run({ dumpsDir, outDir, realPath, realCommonPath }) {
  const files = readdirSync(dumpsDir).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) throw new Error(`no dumps in ${dumpsDir}`);
  const seedMetrics = Object.fromEntries(VARIANTS.map((v) => [v, []]));
  const seedMetricsEnd = Object.fromEntries(VARIANTS.map((v) => [v, []]));
  const actualShapeMetrics = [];
  const actualVel = [];
  const actualVelStart = [];
  const actualPeriod = [];
  const actualPos = [];
  const actionAgg = new Array(6).fill(0); let actionN = 0;
  const yHist = Object.fromEntries(VARIANTS.map((v) => [v, new Array(34).fill(0)]));
  const perSeed = {};
  let duration = null;
  for (const f of files) {
    const dump = JSON.parse(readFileSync(join(dumpsDir, f), 'utf8'));
    if (duration == null) duration = dump.duration;
    const start = extractSeed(dump, { phaseMode: 'start' });
    const { byVariant, frames, periodSeries, actualAllFrames, actualPeriodSeries, actionCounts, actionN: aN } = start;
    for (let k = 0; k < 6; k += 1) actionAgg[k] += actionCounts[k];
    actionN += aN;
    perSeed[f] = {};
    for (const v of VARIANTS) {
      const m = variantSeedMetrics(byVariant[v], frames[v], periodSeries[v]);
      seedMetrics[v].push(m);
      perSeed[f][v] = m;
      // y 直方图（目标点代理）
      for (const [, arr] of byVariant[v]) for (const z of arr) {
        const b = Math.min(33, Math.max(0, Math.floor((z.y / PITCH_WIDTH_M) * 34)));
        yHist[v][b] += 1;
      }
    }
    const shapeOf = (fr) => variantSeedMetrics(new Map(), fr); // 只用结构量；步长空
    const at = turnMetrics(byVariant.actual);
    actualShapeMetrics.push({ ...shapeOf(actualAllFrames), shapeTurnDegPer100m: at.turnDegPer100m, shapeTurns30Per100m: at.turns30Per100m });
    actualVelStart.push(actualVelocityMetrics(byVariant.actual));
    actualPos.push(actualPositionMetrics(byVariant.actual, actualAllFrames));
    // actual 周期基线（全 tick、连续）
    const aps = [];
    for (const [, arr] of actualPeriodSeries) {
      const p = periodicMetrics(arr);
      if (p) aps.push(p);
    }
    actualPeriod.push(aps);
    // 并列：旧口径（tick 末 phase）只重算目标变体，用于看 H4/step 的方向变化。
    const end = extractSeed(dump, { phaseMode: 'end' });
    actualVel.push(actualVelocityMetrics(end.byVariant.actual)); // N5 旧口径（末 phase）可比
    for (const v of VARIANTS) {
      seedMetricsEnd[v].push(variantSeedMetrics(end.byVariant[v], end.frames[v], end.periodSeries[v]));
    }
  }
  const summary = {};
  for (const v of VARIANTS) summary[v] = aggregateSeedMetrics(seedMetrics[v]);
  summary.actual_all = aggregateSeedMetrics(actualShapeMetrics);
  const summaryEndPhase = {};
  for (const v of VARIANTS) summaryEndPhase[v] = aggregateSeedMetrics(seedMetricsEnd[v]);
  const c2Null = c2NullDistribution(seedMetrics.C2);
  const medAgg = (vals) => {
    const v = vals.filter(isNum);
    return v.length ? { median: median(v), iqr: iqr(v), n: v.length } : null;
  };
  const actualMetrics = {
    velStaleFrac: medAgg(actualVel.map((m) => m.literal.velStaleFrac)),
    velVsDispCorr: medAgg(actualVel.map((m) => m.literal.velVsDispCorr)),
    velStaleFracSameInterval: medAgg(actualVel.map((m) => m.sameInterval.velStaleFrac)),
    velVsDispCorrSameInterval: medAgg(actualVel.map((m) => m.sameInterval.velVsDispCorr)),
  };
  const actualMetricsStart = {
    velStaleFrac: medAgg(actualVelStart.map((m) => m.literal.velStaleFrac)),
    velVsDispCorr: medAgg(actualVelStart.map((m) => m.literal.velVsDispCorr)),
    velStaleFracSameInterval: medAgg(actualVelStart.map((m) => m.sameInterval.velStaleFrac)),
    velVsDispCorrSameInterval: medAgg(actualVelStart.map((m) => m.sameInterval.velVsDispCorr)),
  };
  const actualPosition = {};
  for (const key of ['actualCommonX', 'actualCommonY', 'actualTeamYStepCorr', 'actualCollectiveYStepShare', 'actualPersonalJumpRate', 'actualSyncJumpShare', 'actualBallYCorr']) {
    actualPosition[key] = medAgg(actualPos.map((m) => m[key]));
  }
  const actionDistribution = actionN ? {
    run: actionAgg[0] / actionN,
    mark: actionAgg[1] / actionN,
    closeDown: actionAgg[2] / actionN,
    chase: actionAgg[3] / actionN,
    keeper: actionAgg[4] / actionN,
    other: actionAgg[5] / actionN,
    n: actionN,
  } : null;
  const flatPeriod = actualPeriod.flat();
  const actualPeriodicity = {
    nSeeds: files.length,
    nPlayers: flatPeriod.length,
    amp4p3TargetM: medAgg(flatPeriod.map((p) => p.amp4p3TargetM)),
    amp18TargetM: medAgg(flatPeriod.map((p) => p.amp18TargetM)),
    amp90TargetM: medAgg(flatPeriod.map((p) => p.amp90TargetM)),
    dominantPeriodS: medAgg(flatPeriod.map((p) => p.dominantPeriodS)),
    dominantAmpM: medAgg(flatPeriod.map((p) => p.dominantAmpM)),
    acfLag1: medAgg(flatPeriod.map((p) => p.acfLag1)),
    acfMax: medAgg(flatPeriod.map((p) => p.acfMax)),
  };
  const meta = {
    nSeeds: files.length,
    seeds: files.map((f) => JSON.parse(readFileSync(join(dumpsDir, f), 'utf8')).seed),
    duration,
    config: 'motion+formation+marking+press+shot_bridge',
    generatedBy: 'tools/visual-review/c2-shadow-target.mjs',
    caliber: {
      target: '目标点代理（每 tick 起始状态计算；只记录，不移动；目标帧排除 carrier）',
      actual: 'actual_all 行 = 全外场实际位置（与真实锚同口径；所有变体共享同一 dump）',
      shape: 'shapeMetrics 逐帧瞬时（valid fresh phase-start 帧；不是 60 s 窗）',
      phase: '主口径按起始 phase（ticks[i-1]）；summaryEndPhase 并列旧口径（tick 末 phase）',
      real: '真实实际位置，仅参照；不是目标点',
      hybrid: 'hybrid-V1 / hybrid-V1-no-opp：run 用影子律，mark/close/chase 等保留 C2 目标（可部署规则）',
    },
    actionDistribution,
    parameters: MECH,
  };
  const realAnchors = realPath ? loadRealAnchors(realPath) : null;
  const realCommon = realCommonPath && existsSync(realCommonPath)
    ? JSON.parse(readFileSync(realCommonPath, 'utf8')) : null;
  const result = {
    meta, parameters: MECH, realAnchors, realCommon, summary, summaryEndPhase, c2Null,
    actualMetrics, actualMetricsStart, actualPosition, actualPeriodicity, perSeed, yHist,
  };
  result.verdicts = evaluate(summary, c2Null, seedMetrics, realAnchors, realCommon);
  mkdirSync(join(outDir, 'fig'), { recursive: true });
  writeFileSync(join(outDir, 'metrics.json'), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(outDir, 'tables.md'), makeTables(result));
  makeSvg(result, outDir);
  makeSummarySvg(result, outDir);
  return result;
}

// ── CLI ─────────────────────────────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const IS_ENTRY = process.argv[1] && process.argv[1].endsWith('c2-shadow-target.mjs');
if (IS_ENTRY) {
  const args = process.argv.slice(2);
  const opt = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
  };
  const dumpsDir = opt('--dumps', join(HERE, '../../.scratch/notes/c2-shadow-target-2026-10-22/dumps/A6'));
  const outDir = opt('--out', join(HERE, '../../.scratch/notes/c2-shadow-target-2026-10-22'));
  const realPath = opt('--real', join(HERE, '../../.scratch/notes/n5-movement-layer-2026-10-21/metrics-all-v4.json'));
  const realCommonPath = opt('--real-common', join(HERE, '../../.scratch/notes/c2-shadow-target-2026-10-22/real-commonmode-anchors.json'));
  const result = run({ dumpsDir, outDir, realPath, realCommonPath });
  console.log(`wrote ${join(outDir, 'metrics.json')} / tables.md / fig/target-y-hist.svg / fig/summary.svg`);
  console.log(`seeds=${result.meta.nSeeds} duration=${result.meta.duration}`);
}
