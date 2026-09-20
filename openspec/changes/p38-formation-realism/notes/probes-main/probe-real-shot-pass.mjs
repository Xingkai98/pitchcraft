// P38 #89：**真实球员在贴身时凭什么射门、凭什么传球？** —— 事件时刻的几何特征提取。
//
// 这是 #89「把单标量阈值换成多维几何判断」这条假设的**前提测试**：
// 若真实数据里「贴身射门」与「贴身传球」在特征空间里**不可分**，假设就错了。
//
// 做法：取 Metrica 两场的所有 SHOT（非头球）与 PASS 事件，在事件发生帧上算一组几何特征，
// 写成 JSONL 供 `analyze-shot-pass.mjs` 做分离度分析。
//
// ⚠️ 坐标：事件 CSV 是**原始 Metrica 坐标**（原点左上、y 向下、每半场换边），
// 帧 JSON 是**归一化后**的（y 翻转 + 按 period 的 x 翻转，见 convert-tracking-to-frames.mjs）。
// 二者必须走同一套变换，否则特征全错。本探针用 `orientationDetected.flipX` + y 翻转做变换，
// 并用「事件 StartX/Y vs 帧内球员位置」的中位误差（应 ≈0.004 归一化 = 0.4m）自检——
// 这个自检是**门槛**：对不齐就退出，不产出错误的特征。
//
// 用法：node probe-real-shot-pass.mjs [--out <path>] [--events-dir <dir>]
// 环境：METRICA_EVENTS_DIR（同 real-shots.mjs 的约定）

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findRepoRoot } from '../probes/repo-root.mjs';
import { KEEPER_IDS, PITCH_LENGTH_M, PITCH_WIDTH_M } from '../../../../../viewer/match-metrics.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = findRepoRoot(HERE);

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const eventsDir = argOf('--events-dir', process.env.METRICA_EVENTS_DIR
  || join(ROOT, '.scratch/tracking-data/sample-data/data'));
const outPath = argOf('--out', join(HERE, 'out/real-shot-pass.jsonl'));

// ── 事件 CSV ────────────────────────────────────────────────────────────
const parseEvents = (text) => {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const head = lines[0].split(',').map((h) => h.replace(/"/g, '').trim());
  const col = (n) => head.indexOf(n);
  const iTeam = col('Team'); const iType = col('Type'); const iSub = col('Subtype');
  const iPeriod = col('Period'); const iT = col('Start Time [s]'); const iFrom = col('From');
  const iX = col('Start X'); const iY = col('Start Y');
  const out = [];
  for (let i = 1; i < lines.length; i += 1) {
    const c = lines[i].split(',');
    if (!c[iTeam]) continue;
    out.push({
      team: c[iTeam].replace(/"/g, ''),
      type: c[iType].replace(/"/g, ''),
      subtype: c[iSub].replace(/"/g, ''),
      period: Number(c[iPeriod]),
      t: Number(c[iT]),
      from: c[iFrom].replace(/[^0-9]/g, ''),
      x: Number(c[iX]),
      y: Number(c[iY]),
    });
  }
  return out;
};

// ── 特征 ────────────────────────────────────────────────────────────────
// 全部用**米**，与引擎同口径（PITCH_LENGTH_M × PITCH_WIDTH_M）。
// `attacking` = 该球员所属队是否在本场向前进攻 x=1（帧 JSON 已归一化为「主队始终攻 x=1」）。
const dist = (ax, ay, bx, by) => Math.hypot((ax - bx) * PITCH_LENGTH_M, (ay - by) * PITCH_WIDTH_M);

/** 点到线段的横向距离（米）。用于「球门方向上有没有人封堵」。 */
function lateralToSegment(px, py, ax, ay, bx, by) {
  const X = (v, o) => (v - o) * PITCH_LENGTH_M;
  const Y = (v, o) => (v - o) * PITCH_WIDTH_M;
  const vx = X(bx, ax); const vy = Y(by, ay);
  const wx = X(px, ax); const wy = Y(py, ay);
  const L2 = vx * vx + vy * vy;
  if (L2 < 1e-9) return Math.hypot(wx, wy);
  const tt = Math.max(0, Math.min(1, (wx * vx + wy * vy) / L2));
  return Math.hypot(wx - tt * vx, wy - tt * vy);
}

function features(frame, carrierId, isHome) {
  const c = frame.players[carrierId];
  if (!c) return null;
  const cx = c[0]; const cy = c[1];
  const goalX = isHome ? 1.0 : 0.0;
  const goalY = 0.5;
  // ⚠️ **两个球门距离口径，都要留**（审阅发现）：
  //   `dGoal`   = 到球门中心的欧氏距离（自然的足球量）
  //   `dGoalX`  = **只按纵深**（= Rust `dist_to_goal_m`，lib.rs:4762），
  //              是引擎真正喂进 `distance_quality` 的那个数——复算引擎打分必须用这个。
  // 二者中位差 4.31m，混用会让"引擎自己的打分"这一行不成立。
  const dGoal = dist(cx, cy, goalX, goalY);
  const dGoalX = (isHome ? 1.0 - cx : cx) * PITCH_LENGTH_M;
  // 引擎口径：持球者→球门中心 与 进攻方向 的夹角余弦（与 `shot_angle_cos` 逐字对齐）
  const dx = (isHome ? 1.0 - cx : cx) * PITCH_LENGTH_M;
  const dy = (isHome ? 0.5 - cy : cy - 0.5) * PITCH_WIDTH_M;
  const angleCos = (dx === 0 && dy === 0) ? 1.0 : dx / Math.hypot(dx, dy);

  const opp = []; const mate = [];
  for (let id = 0; id < frame.players.length; id += 1) {
    const p = frame.players[id];
    if (!p) continue;
    // ⚠️ **必须排除持球者自己**（审阅发现）：不排除时 `dist(c,c)=0` 会被当作"最近队友"，
    // 使 `mateDist ≡ 0`、`nMate10` 变成"队友数 + 1"。真实侧与引擎侧同错，特征退化但不偏。
    if (id === carrierId) continue;
    if (KEEPER_IDS.includes(id)) continue;
    const d = dist(cx, cy, p[0], p[1]);
    // 「goal-side 纵深」：沿进攻轴，>0 = 该球员在持球者与所攻球门之间
    const depth = (isHome ? p[0] - cx : cx - p[0]) * PITCH_LENGTH_M;
    (id <= 10 === isHome ? mate : opp).push({ id, x: p[0], y: p[1], d, depth });
  }
  opp.sort((a, b) => a.d - b.d);
  mate.sort((a, b) => a.d - b.d);

  const d1 = opp.length > 0 ? opp[0].d : NaN;
  const d2 = opp.length > 1 ? opp[1].d : NaN;
  const nOpp8 = opp.filter((o) => o.d <= 8).length;
  const nOpp16 = opp.filter((o) => o.d <= 16).length;
  // 球门侧（挡在身前）的防守者：距球门更近且横向 15m 内
  const oppGoalSide = opp.filter((o) => o.depth > 0 && o.depth <= 15).length;
  // 球门方向封堵：有人贴在该点到球门的线段上（横向 <1.5m）且比持球者更近门
  const laneBlocked = opp.some((o) => o.depth > 0 && lateralToSegment(o.x, o.y, cx, cy, goalX, goalY) < 1.5);
  // 第二防守者是否在球门侧（「身后有没有保护」的进攻视角 = 身前有没有第二层）
  const d2GoalSide = opp.length > 1 ? (opp[1].depth > 0 ? 1 : 0) : 0;

  const mateDist = mate.length > 0 ? mate[0].d : NaN;
  const nMate10 = mate.filter((m) => m.d <= 10).length;
  const inBox = (Math.abs(cx - goalX) * PITCH_LENGTH_M <= 16.5)
    && (Math.abs(cy - 0.5) * PITCH_WIDTH_M <= 20.16);

  return {
    dGoal, dGoalX, angleCos, d1, d2, nOpp8, nOpp16, oppGoalSide, laneBlocked, d2GoalSide,
    mateDist, nMate10, inBox: inBox ? 1 : 0,
  };
}

// ── 主流程 ──────────────────────────────────────────────────────────────
const rows = [];
for (const g of [1, 2]) {
  const csvPath = join(eventsDir, `Sample_Game_${g}`, `Sample_Game_${g}_RawEventsData.csv`);
  const framePath = join(ROOT, `viewer/data/real-game-${g}.json`);
  if (!existsSync(csvPath)) { console.error(`缺 ${csvPath}（gitignored；用 --events-dir 指定）`); process.exit(1); }
  if (!existsSync(framePath)) { console.error(`缺 ${framePath}（转换产物，gitignored）`); process.exit(1); }

  const gd = JSON.parse(readFileSync(framePath, 'utf8'));
  const flipX = gd.meta.orientationDetected.flipX;
  const idMap = gd.meta.idMap;
  const frames = gd.frames;

  // 帧按 t 升序 → 二分找最近帧（29002 帧 × 1700 事件，线性扫描是 O(n·m)）
  const nearestFrame = (t) => {
    let lo = 0; let hi = frames.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (frames[mid].t < t) lo = mid; else hi = mid; }
    return Math.abs(frames[lo].t - t) <= Math.abs(frames[hi].t - t) ? frames[lo] : frames[hi];
  };

  const evs = parseEvents(readFileSync(csvPath, 'utf8'));
  const usable = evs.filter((e) => {
    if (e.type === 'SHOT') return !e.subtype.toUpperCase().includes('HEAD');
    if (e.type === 'PASS') return e.subtype === '' ;   // 只取开放比赛普通传球（排除 CROSS/GOAL KICK/HEAD/CLEARANCE/DEEP BALL）
    return false;
  });
  // 归一化事件坐标（与帧同一变换）
  const norm = (e) => {
    const flip = e.period <= 1 ? flipX[0] : flipX[1];
    return [flip ? 1 - e.x : e.x, 1 - e.y];
  };

  // 方向自检：事件 StartX/Y 应落在同帧该球员位置上（中位误差 ≈0.004）
  const errs = [];
  let n = 0;
  for (const e of usable) {
    const isHome = e.team === 'Home';
    const eid = (isHome ? idMap.home : idMap.away)[e.from];
    if (eid === undefined) continue;
    const f = nearestFrame(e.t);
    const p = f.players[eid];
    if (!p || !Number.isFinite(e.x)) continue;
    const [nx, ny] = norm(e);
    errs.push(Math.hypot(nx - p[0], ny - p[1]));
  }
  errs.sort((a, b) => a - b);
  const medErr = errs.length ? errs[errs.length >> 1] : NaN;
  if (!(medErr < 0.02)) {
    console.error(`game${g}: 坐标自检失败（中位误差 ${medErr}，期望 <0.02）——事件表与帧不同源，退出`);
    process.exit(1);
  }

  const before = rows.length;
  for (const e of usable) {
    const isHome = e.team === 'Home';
    const eid = (isHome ? idMap.home : idMap.away)[e.from];
    if (eid === undefined) continue;
    const f = nearestFrame(e.t);
    const ft = features(f, eid, isHome);
    if (!ft || !Number.isFinite(ft.d1)) continue;
    rows.push({
      game: g, t: e.t, team: isHome ? 'home' : 'away', actor: eid,
      action: e.type === 'SHOT' ? 'shot' : 'pass', ...ft,
    });
  }
  const s = rows.slice(before).filter((r) => r.action === 'shot').length;
  console.log(`game${g}: 可用事件 ${usable.length}（射门 ${s}），坐标自检中位误差 ${medErr.toFixed(4)}`);
  n += 1;
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);

const shots = rows.filter((r) => r.action === 'shot').length;
console.log(`\n→ ${outPath.replace(`${ROOT}/`, '<ROOT>/')}（${rows.length} 行 = 射门 ${shots} + 传球 ${rows.length - shots}）`);
console.log(`  贴身（d1 ≤ 4m）事件：射门 ${rows.filter((r) => r.action === 'shot' && r.d1 <= 4).length} / 传球 ${rows.filter((r) => r.action === 'pass' && r.d1 <= 4).length}`);
