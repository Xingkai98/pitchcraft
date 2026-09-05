// 事件演绎层（票据 09）：把事件"演"成动画锚点序列
// 原则：引擎给参数、画面给戏；人球解耦（带球=踢-追周期、传球=传跑配合、射门=门将先动）。
// 本模块为纯函数（不碰 DOM/Canvas），便于单测（tasks 5.4/6.1）。

import { config } from './config.js';

// 动画锚点：一个可渲染的关键帧（球员位置/球位置随时间变化）
// { t, kind: 'player'|'ball'|'pitch', id?, x, y }
//
// 演绎策略：
//   每条事件被展开成多个锚点，画面层在锚点间插值补帧。
//   锚点带绝对时间 t（比赛秒），画面层按播放速度映射到真实时间。

// 归一化距离 → 真实米（考虑球场长宽比）
function distanceMeters(x1, y1, x2, y2) {
  const p = config.pitch;
  return Math.hypot((x2 - x1) * p.lengthMeters, (y2 - y1) * p.widthMeters);
}

// 速度 + 距离 → 动画时长（秒）。speed 为 m/s。
// 下限 0.05s 防止零距离/极高速度的瞬间移动。
function durationFromSpeed(meters, speed) {
  const s = speed > 0 ? speed : config.defaults.passSpeed;
  return Math.max(meters / s, 0.05);
}

// ---- 带球：连续推进（人球解耦）----
// 输入 dribble 事件，输出锚点：球在人身前连续滚动，人同步前进。
// 不再拆"踢-追"周期（那会导致球瞬移、看起来像两个动作）。
// 整段时长 = 带球距离 ÷ 带球速度。
function interpretDribble(e, out) {
  const d = config.interpretation.dribble;
  const t0 = e.t;
  const meters = distanceMeters(e.x, e.y, e.x2, e.y2);
  const speed = e.speed ?? config.defaults.dribbleSpeed;
  const totalDur = durationFromSpeed(meters, speed);

  // 人球分离量（归一化，沿运动方向）：球始终领先人 sep
  const dist = Math.hypot(e.x2 - e.x, e.y2 - e.y);
  const sep = d.separation; // 归一化
  const dirX = dist === 0 ? 0 : (e.x2 - e.x) / dist;
  const dirY = dist === 0 ? 0 : (e.y2 - e.y) / dist;

  // 起始：球和人都在起点（球略领先）
  out.push({ t: t0, kind: 'player', id: e.subject, x: e.x, y: e.y });
  out.push({ t: t0, kind: 'ball', x: e.x + dirX * sep, y: e.y + dirY * sep });
  // 终点：球和人到终点（球仍领先）
  out.push({ t: t0 + totalDur, kind: 'player', id: e.subject, x: e.x2, y: e.y2 });
  out.push({ t: t0 + totalDur, kind: 'ball', x: e.x2 + dirX * sep, y: e.y2 + dirY * sep });
}

// ---- 传球：传跑配合 ----
// 输入 pass 事件，输出锚点：接球者从当前位置(receiver_x/y)跑向落点，球飞向落点，落点汇合。
// 球飞行时长 = 传球距离 ÷ 球速。
// P13 fix：拦截（result=intercepted）语义——球被防守方断下，飞到拦截者处（x2/y2=拦截者位置），
// 原目标接球者不跑向落点（球到不了）；拦截者引擎已站在断球点（x2/y2），无需额外锚点（球到脚下）。
// 传失（result=lost）——球飞向落点但没人接住，后续 beat.ball（松散球）表现"传过/无人控制"。
function interpretPass(e, out) {
  const p = config.interpretation.pass;
  const t0 = e.t;
  const meters = distanceMeters(e.x, e.y, e.x2, e.y2);
  const speed = e.speed ?? config.defaults.passSpeed;
  const ballDur = durationFromSpeed(meters, speed);

  // 球：起点 → 弧线顶点 → 终点。h 语义（P6 批次1）：事件带 h 用事件值（协议 0-1，球大小表示高度）；
  // h 缺失 → 按飞行时长/距离默认插值（向后兼容，P6 首批现有行为）；h=0 → 基础半径（无高度）
  const h = e.h !== undefined ? e.h : Math.min(0.08 + ballDur * 0.03, 0.2);
  const midX = (e.x + e.x2) / 2;
  const midY = (e.y + e.y2) / 2;
  out.push({ t: t0, kind: 'ball', x: e.x, y: e.y, h: 0 });
  out.push({ t: t0 + ballDur / 2, kind: 'ball', x: midX, y: midY, h });
  out.push({ t: t0 + ballDur, kind: 'ball', x: e.x2, y: e.y2, h: 0 });
  // P13 fix：成功传球才让接球者（to）跑向落点（receiver_x/y → x2/y2，终点 = 引擎高亮结束位置，beat-main
  // 连续无 freeze/teleport）。拦截/传失时球到不了接球者 → 不产接球者跑位锚点（接球者由 beat movers 跑位，
  // 参与者集合已对齐引擎：拦截含拦截者、传失仅传球者）。
  const noReceiverRun = (e.result === 'intercepted' && e.interceptor !== undefined) || e.result === 'lost';
  if (e.to !== undefined && !noReceiverRun) {
    const startX = e.receiver_x !== undefined ? e.receiver_x : e.x2;
    const startY = e.receiver_y !== undefined ? e.receiver_y : e.y2;
    out.push({ t: t0, kind: 'player', id: e.to, x: startX, y: startY });
    out.push({ t: t0 + ballDur, kind: 'player', id: e.to, x: e.x2, y: e.y2 });
  }
  // 传球者（from）：原地不动（简化）
  if (e.from !== undefined) {
    out.push({ t: t0, kind: 'player', id: e.from, x: e.x, y: e.y });
    out.push({ t: t0 + ballDur, kind: 'player', id: e.from, x: e.x, y: e.y });
  }
}

// ---- 射门：球加速飞向球门 + 门将先动 ----
// 球飞行时长 = 射门距离 ÷ 球速。
// goal 与 saved 视觉区分：
//   - goal：球越过门线飞进网（终点 x 略超门线），门将扑向射门侧但没够到（门将 y 偏移小）
//   - saved：球停在门线，门将扑到球路线上挡住球（门将与球终点一致）
function interpretShot(e, out) {
  const s = config.interpretation.shot;
  const t0 = e.t;
  const meters = distanceMeters(e.x, e.y, e.x2, e.y2);
  const speed = e.speed ?? config.defaults.shotSpeed;
  const flightDur = durationFromSpeed(meters, speed);
  const isGoal = e.result === 'goal';
  const isOff = e.result === 'off_target';
  // 球终点（P6 区分）：
  //   goal → 球停在门里：球心刚过门线（x=1.005），球体完全越线但停在网内（不飞过球门）
  //   off_target → 飞过球门出界（x=1.02，y 偏离球门由引擎给）
  //   saved → 停门线（x2）
  const ballEndX = isGoal ? (e.x2 >= 0.5 ? 1.005 : -0.005) : (isOff ? (e.x2 >= 0.5 ? 1.02 : -0.02) : e.x2);
  const ballEndY = e.y2 ?? 0.5;
  // 弧线（h=高度）：事件带 h 用事件值（头球射门 h=0 低空）；缺失 → 飞行短而快，高度略低（0.05-0.12）
  const h = e.h !== undefined ? e.h : Math.min(0.05 + flightDur * 0.04, 0.12);
  const midX = (e.x + ballEndX) / 2;
  const midY = (e.y + ballEndY) / 2;
  out.push({ t: t0, kind: 'ball', x: e.x, y: e.y, h: 0 });
  out.push({ t: t0 + flightDur / 2, kind: 'ball', x: midX, y: midY, h });
  out.push({ t: t0 + flightDur, kind: 'ball', x: ballEndX, y: ballEndY, h: 0 });
  // 射手（subject）：原地（摆腿）
  out.push({ t: t0, kind: 'player', id: e.subject, x: e.x, y: e.y });
  // 门将：从当前实际位置（引擎给 keeper_x/y，可能因带球离门）向射门方向扑；缺失时 fallback 门线中点。
  // 连续播放里门将 x/y 可能在别处，从实位扑救避免瞬移（审阅 major）。
  const keeperId = e.subjectTeam === 'home' ? 21 : 0; // 对侧门将
  const keeperStartX = (Number.isFinite(e.keeper_x)) ? e.keeper_x : (keeperId === 21 ? 0.98 : 0.02);
  const keeperStartY = (Number.isFinite(e.keeper_y)) ? e.keeper_y : 0.5;
  const keeperTargetY = e.y2 !== undefined ? e.y2 : 0.5;
  // 门将扑救终点 = 引擎高亮结束位置（shot.x2/y2，球到达门线处）——保证高亮结束回归 movers 不 snap。
  // 门将从实位（keeper_x/y）扑向球门（x2/y2）；saved 挡在球路线上，goal 未够到（球越过门线）。
  out.push({ t: t0, kind: 'player', id: keeperId, x: keeperStartX, y: keeperStartY });
  out.push({ t: t0 + s.keeperReactDelay, kind: 'player', id: keeperId, x: keeperStartX, y: keeperStartY });
  out.push({ t: t0 + flightDur, kind: 'player', id: keeperId, x: e.x2, y: keeperTargetY });
}

// ---- 抢断/拦截：带球中被抢 → 逼近 → 碰撞捅开 → 弹开 + 捡球 ----
// 被铲者从 carrier_from_x/y（引擎给带球起点）带球到接触点（x2/y2），防守者同时逼近；
// 碰撞后球弹开（优先引擎 loose_x/y，缺失则自算垂线弹开点）；按 result 决定谁捡球。
// result=success（或缺省）→ 防守者拿球；result=fail → 原持球人拿回。
// dropCarryBeat（连续模式）：若被铲者上一事件刚带球到接触点，丢弃 carry-beat 起点（从接触点开始），
// 避免连续播放里"重放刚播过的带球段"（design D4，grill Q6）。
// v2（carrier 存在）：高亮时长固定 1 tick（引擎 t_end=t+1）；approach 压缩到 1s 内，
//   球员终态 = 接触点（引擎 participants 结束位置），球终态 = loose（与下一 beat.ball 起点连续）；
//   collect（捡球）不在此演绎——由后续 beat.ball + chase movers 表达。
function interpretTackle(e, out, dropCarryBeat = false) {
  const t0 = e.t;
  const tackler = e.subject;
  const sx = e.x;
  const sy = e.y;
  const victim = e.carrier ?? e.to; // v2 用 carrier（被铲者 id），v1 用 to
  // 防守者/被铲者任一方位置缺失或非法（undefined/null/NaN）时无法定位双方：退化为最小演绎，
  // 不伪造球/人位置。补一个 0.3s 静止锚点，让退化片段也有可播放时长。
  if (!Number.isFinite(e.x) || !Number.isFinite(e.y) || !Number.isFinite(e.x2) || !Number.isFinite(e.y2) || victim === undefined || victim === null) {
    if (Number.isFinite(e.x) && Number.isFinite(e.y)) {
      out.push({ t: t0, kind: 'player', id: tackler, x: e.x, y: e.y });
      out.push({ t: t0 + 0.3, kind: 'player', id: tackler, x: e.x, y: e.y });
    }
    return;
  }
  const vx = e.x2;
  const vy = e.y2;
  const deflect = config.interpretation.tackle;
  const isV2 = e.carrier !== undefined;
  // 带球起点：引擎给 carrier_from 时被铲者从那里带球到接触点；缺失则原地持球（fallback）
  const hasCarrierFrom = Number.isFinite(e.carrier_from_x) && Number.isFinite(e.carrier_from_y);
  const cfx = dropCarryBeat ? vx : (hasCarrierFrom ? e.carrier_from_x : vx);
  const cfy = dropCarryBeat ? vy : (hasCarrierFrom ? e.carrier_from_y : vy);

  // 1) 带球逼近：被铲者从 carrier_from 带球到接触点（球在他脚下），防守者从起点逼近
  const carrierMoveDur = dropCarryBeat ? 0 : durationFromSpeed(distanceMeters(cfx, cfy, vx, vy), config.defaults.dribbleSpeed);
  let approachDur = durationFromSpeed(distanceMeters(sx, sy, vx, vy), config.defaults.runSpeed);
  if (isV2) {
    approachDur = Math.min(approachDur, 0.6); // v2 高亮 1 tick：逼近压缩到 0.6s（避免 >1s 破坏时序）
  }
  // 带球段与逼近段同时发生，接触时刻取两者较长者（双方都在动）
  const tContact = t0 + Math.max(carrierMoveDur, approachDur);
  out.push({ t: t0, kind: 'player', id: victim, x: cfx, y: cfy });
  out.push({ t: tContact, kind: 'player', id: victim, x: vx, y: vy });
  out.push({ t: t0, kind: 'player', id: tackler, x: sx, y: sy });
  out.push({ t: tContact, kind: 'player', id: tackler, x: vx, y: vy });
  // 球随被铲者移动（人球同步，简化）；接触时球在接触点
  out.push({ t: t0, kind: 'ball', x: cfx, y: cfy });
  out.push({ t: tContact, kind: 'ball', x: vx, y: vy });

  // 2) 碰撞捅开：球弹开。优先引擎 loose_x/y（语义结果），缺失则自算垂线弹开点
  const loose = (Number.isFinite(e.loose_x) && Number.isFinite(e.loose_y))
    ? { x: e.loose_x, y: e.loose_y }
    : deflectPoint(sx, sy, vx, vy, deflect.deflectDistance, tackler, victim);
  const deflectDur = durationFromSpeed(distanceMeters(vx, vy, loose.x, loose.y), deflect.deflectSpeed);

  if (isV2) {
    // v2：高亮覆盖 [t0, t0+1]。球员终态 = 接触点（引擎对账），球终态按 result：
    //   success → 弹到 loose（进入松散球，与 beat.ball 起点连续）
    //   fail    → 停在接触点（被铲者保持，main 从接触点恢复，无松散球）
    // collect 交给后续 beat.ball + chase，不在此演绎。
    const end = t0 + 1;
    if (e.result === 'fail') {
      out.push({ t: end, kind: 'ball', x: vx, y: vy });
      out.push({ t: end, kind: 'player', id: victim, x: vx, y: vy });
      out.push({ t: end, kind: 'player', id: tackler, x: vx, y: vy });
      return;
    }
    const tLoose = Math.min(tContact + deflectDur, end - 0.05);
    out.push({ t: tLoose, kind: 'ball', x: loose.x, y: loose.y });
    if (tLoose < end - 0.01) {
      out.push({ t: end, kind: 'ball', x: loose.x, y: loose.y }); // 球停在 loose 到高亮结束
    }
    out.push({ t: end, kind: 'player', id: victim, x: vx, y: vy });
    out.push({ t: end, kind: 'player', id: tackler, x: vx, y: vy });
    return;
  }

  // 3) v1 捡球：球先到位，捡球人反应一拍（collectDelay），再以跑速追到弹开点，人球汇合 = 拾取。
  //    success → 防守者拿球；fail → 原持球人拿回（被铲者在接触点等到球被捅开再动）。
  const tLoose = tContact + deflectDur;
  out.push({ t: tLoose, kind: 'ball', x: loose.x, y: loose.y });
  const collectPause = tLoose + deflect.collectDelay;
  const chaseDur = durationFromSpeed(distanceMeters(vx, vy, loose.x, loose.y), config.defaults.runSpeed);
  const tPickup = collectPause + chaseDur;
  if (e.result !== 'fail') {
    out.push({ t: collectPause, kind: 'player', id: tackler, x: vx, y: vy });
    out.push({ t: tPickup, kind: 'player', id: tackler, x: loose.x, y: loose.y });
    out.push({ t: tPickup, kind: 'player', id: victim, x: vx, y: vy });
  } else {
    out.push({ t: collectPause, kind: 'player', id: victim, x: vx, y: vy });
    out.push({ t: tPickup, kind: 'player', id: victim, x: loose.x, y: loose.y });
  }
}

// 弹开点：被铲者位置 + 逼近方向垂线 × 距离。确定性选边（避开 RNG），优先弹向场内，越界钳制。
function deflectPoint(sx, sy, vx, vy, dist, tackler, victim) {
  const dx = vx - sx;
  const dy = vy - sy;
  const len = Math.hypot(dx, dy);
  // 零距离（防守者已在被铲者脚下）时退化：视作从左侧逼近 → 弹开沿垂直方向，保证有方向
  const ux = len === 0 ? 1 : dx / len;
  const uy = len === 0 ? 0 : dy / len;
  // 逼近方向的两个垂线候选
  const cand1 = { x: vx - uy * dist, y: vy + ux * dist };
  const cand2 = { x: vx + uy * dist, y: vy - ux * dist };
  const in1 = cand1.x >= 0 && cand1.x <= 1 && cand1.y >= 0 && cand1.y <= 1;
  const in2 = cand2.x >= 0 && cand2.x <= 1 && cand2.y >= 0 && cand2.y <= 1;
  let loose;
  if (in1 && !in2) {
    loose = cand1;
  } else if (in2 && !in1) {
    loose = cand2;
  } else if (in1 && in2) {
    // 都在场内：按球员 id 确定性选边
    const victimId = victim !== undefined ? victim : 0;
    loose = ((tackler * 7 + victimId * 3) % 2) === 1 ? cand2 : cand1;
  } else {
    // 都在场外（贴角球）：钳制第一个候选
    loose = cand1;
  }
  return {
    x: Math.min(Math.max(loose.x, 0), 1),
    y: Math.min(Math.max(loose.y, 0), 1),
  };
}

// ---- 无球跑位：短距离碎步移动（人移动，球不动）----
// off_ball_run 事件带 subject/x/y/x2/y2/speed。时长 = 距离 ÷ 跑速。
function interpretOffBallRun(e, out) {
  // 缺终点（x2/y2 非有限）时不产出锚点，避免 NaN 污染时间线
  if (!Number.isFinite(e.x2) || !Number.isFinite(e.y2)) return;
  const t0 = e.t;
  const meters = distanceMeters(e.x, e.y, e.x2, e.y2);
  const speed = e.speed ?? config.defaults.runSpeed;
  const dur = durationFromSpeed(meters, speed);
  out.push({ t: t0, kind: 'player', id: e.subject, x: e.x, y: e.y });
  out.push({ t: t0 + dur, kind: 'player', id: e.subject, x: e.x2, y: e.y2 });
}

// ---- v2：beat 节拍演绎（并行节拍）----
// beat = 固定 1s tick 的并行动作：main（carrier 带球）+ movers（并行跑位）+ ball（松散球）。
// 所有动画铺满整拍 [t, t+1]（缓动到位，非"距离÷速度"——保证 22 人并行同时动）。
// 高亮参与者由 buildTimeline 在 beat 展开前排除（两层合成，spec 要求 viewer 侧防御）。
function interpretBeat(e, out, excluded = null) {
  const t0 = e.t;
  const t1 = t0 + 1; // 铺满整拍
  // main：carrier 带球。球位置 = carrier（拍边界连续；不做 sep 领先偏移——方向变化会导致拍边界球跳，审阅 minor）
  if (e.main) {
    const m = e.main;
    out.push({ t: t0, kind: 'player', id: m.subject, x: m.x, y: m.y });
    out.push({ t: t0, kind: 'ball', x: m.x, y: m.y });
    out.push({ t: t1, kind: 'player', id: m.subject, x: m.x2, y: m.y2 });
    out.push({ t: t1, kind: 'ball', x: m.x2, y: m.y2 });
  }
  // movers：并行跑位（增量，静止球员不发），排除高亮参与者（两层合成）
  if (Array.isArray(e.movers)) {
    for (const mv of e.movers) {
      if (excluded && excluded.has(mv.id)) continue;
      out.push({ t: t0, kind: 'player', id: mv.id, x: mv.from_x, y: mv.from_y });
      out.push({ t: t1, kind: 'player', id: mv.id, x: mv.to_x, y: mv.to_y });
    }
  }
  // ball：松散球滚动轨迹
  if (e.ball) {
    const b = e.ball;
    out.push({ t: t0, kind: 'ball', x: b.x, y: b.y });
    out.push({ t: t1, kind: 'ball', x: b.x2, y: b.y2 });
  }
}

// 高亮事件的参与者集合（两层合成排除用）
function highlightParticipants(e) {
  const clean = (ids) => new Set(ids.filter((x) => x !== undefined && x !== null));
  // P13 fix：参与者 = 引擎高亮冻结的球员（对齐 finalize 对账集合）——
  // 拦截 = 传球者 + 拦截者（接球者照常跑位）；传失 = 只有传球者（球飞向落点变松散球，
  // 接收者不冻结，双方争抢由 chase movers 表现）；成功 = 传球者 + 接球者；门球开大脚无 to → 传球者。
  if (e.type === 'pass') {
    if (e.result === 'intercepted' && e.interceptor !== undefined) return clean([e.from, e.interceptor]);
    if (e.result === 'lost') return clean([e.from]);
    return clean([e.from, e.to]);
  }
  if (e.type === 'shot') {
    const keeperId = (typeof e.subject === 'number' && e.subject <= 10) ? 21 : 0;
    return clean([e.subject, keeperId]);
  }
  if (e.type === 'tackle') return clean([e.subject, e.carrier ?? e.to]);
  return new Set();
}

// 高亮事件的自然飞行终点（pass/shot 按距离÷球速；tackle 固定 1 tick）
function highlightEndTime(e) {
  if (e.type === 'tackle') return e.t + 1;
  const meters = distanceMeters(e.x, e.y, e.x2, e.y2);
  const speed = e.speed ?? (e.type === 'pass' ? config.defaults.passSpeed : config.defaults.shotSpeed);
  return e.t + durationFromSpeed(meters, speed);
}

function isHighlightType(e) {
  return e.type === 'pass' || e.type === 'shot' || e.type === 'tackle';
}

// ---- 主入口：把一条事件演绎成锚点序列 ----
// 返回 [{t, kind, id?, x, y}]，锚点已按 t 排序
// dropCarryBeat：仅连续模式 tackle 丢弃 carry-beat 起点用（见 buildTimeline）
export function interpretEvent(e, dropCarryBeat = false) {
  const out = [];
  switch (e.type) {
    case 'lineup':
      // 初始站位：产 22 个球员锚点（t=事件 t），保证时间线在开场有所有球员的初始位置。
      // 否则 replay/seek 到 t=0 时插值器找不到锚点，球员停在末态位置（审阅/用户报告：重播不回初始）。
      if (Array.isArray(e.players)) {
        for (const p of e.players) {
          out.push({ t: e.t, kind: 'player', id: p.id, x: p.x, y: p.y });
        }
      }
      break;
    case 'kickoff':
      // 中圈开球：开球球员在中点，随后一拨（有 from/to/x2/y2 时按短传演绎）
      out.push({ t: e.t, kind: 'player', id: e.subject, x: 0.5, y: 0.5 });
      if (e.from !== undefined && e.x2 !== undefined) {
        // 开球一拨：球从中圈拨向队友，用事件 speed 算时长（interpretPass 处理球锚点）
        interpretPass(e, out);
      } else {
        // 无拨球信息时球停在中圈
        out.push({ t: e.t, kind: 'ball', x: 0.5, y: 0.5 });
      }
      break;
    case 'whistle':
      // 哨声：无动作（画面层显示比分/时间文字）
      break;
    case 'pass':
      interpretPass(e, out);
      break;
    case 'dribble':
      interpretDribble(e, out);
      break;
    case 'shot':
      interpretShot(e, out);
      break;
    case 'tackle':
    case 'interception':
      interpretTackle(e, out, dropCarryBeat);
      break;
    case 'off_ball_run':
      interpretOffBallRun(e, out);
      break;
    case 'beat':
      interpretBeat(e, out);
      break;
    case 'substitution':
      // 换人：简单占位，P0 不做动画
      break;
    default:
      // 未知类型忽略
      break;
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// 便捷：把整场事件流展开成锚点时间线（供画面层一次性取用）
// 每个锚点打上来源事件索引 evt，供插值器判断"是否跨事件边界"（事件间隙应保持原位，不滑动）
// mode='continuous'：连续模式启用 tackle carry-beat 丢弃——若当前 tackle 前（跳过 off_ball_run
// 填满的事件）是同一被铲者的 dribble（且落点即接触点），则不重现带球段（避免连续播放里重放刚播过的带球）。
export function buildTimeline(events, mode = 'clip') {
  const anchors = [];
  // 飞行中高亮注册表（两层合成）：高亮覆盖区间内，其参与者从重叠 beat movers 排除
  const activeHighlights = []; // {tStart, tEnd, participants:Set}
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    // 清理已结束高亮（覆盖区间 [tStart, tEnd)，tEnd 起不再影响 beat）
    for (let j = activeHighlights.length - 1; j >= 0; j--) {
      if (activeHighlights[j].tEnd <= e.t) activeHighlights.splice(j, 1);
    }
    if (isHighlightType(e)) {
      activeHighlights.push({ tStart: e.t, tEnd: highlightEndTime(e), participants: highlightParticipants(e) });
    }
    let dropCarryBeat = false;
    if (mode === 'continuous' && e.type === 'tackle') {
      // 向前跳过 off_ball_run（引擎在每个有球事件后都插了无球跑位填满），
      // 找到最后一个非 off_ball_run 的"动作"事件；若是同一被铲者的 dribble 且落点即接触点，丢弃 carry-beat。
      let j = i - 1;
      while (j >= 0 && events[j].type === 'off_ball_run') j--;
      const prev = j >= 0 ? events[j] : null;
      if (
        prev &&
        prev.type === 'dribble' &&
        prev.subject === e.to &&
        prev.x2 !== undefined &&
        Math.abs(prev.x2 - e.x2) < 1e-6 &&
        Math.abs(prev.y2 - e.y2) < 1e-6
      ) {
        dropCarryBeat = true;
      }
    }
    // 连续模式：进球后球直接回中圈（用户确认：不做"从门内滚回中圈"过渡）。
    // 进球确认（whistle，进球庆祝后）时刻球直接出现在中圈；庆祝/准备期间球在中圈，kickoff 从中圈开球。
    if (mode === 'continuous' && e.type === 'whistle') {
      // 向前找最近的 shot goal（跳过 off_ball_run/beat）
      let j = i - 1;
      while (j >= 0 && (events[j].type === 'off_ball_run' || events[j].type === 'beat')) j--;
      const prevShot = j >= 0 ? events[j] : null;
      // 守卫：仅当 whistle 在射门飞行结束后（真实引擎流）才加中圈锚点；
      // mock 流 shot 与 whistle 同 t 时跳过，避免破坏进球飞行（审阅 minor）
      if (prevShot && prevShot.type === 'shot' && prevShot.result === 'goal'
        && e.t >= highlightEndTime(prevShot) - 0.01) {
        // 进球确认：球直接跳到中圈（瞬移；死球→kickoff 例外）
        anchors.push({ t: e.t, kind: 'ball', x: 0.5, y: 0.5, evt: i });
      }
    }
    if (e.type === 'beat') {
      // 两层合成：排除覆盖区间内的高亮参与者（引擎已排除，viewer 防御性排除 + 可单测）
      const excluded = new Set();
      for (const h of activeHighlights) {
        if (e.t >= h.tStart && e.t < h.tEnd) {
          for (const p of h.participants) excluded.add(p);
        }
      }
      const beatAnchors = [];
      interpretBeat(e, beatAnchors, excluded);
      for (const a of beatAnchors) {
        anchors.push({ ...a, evt: i });
      }
    } else {
      for (const a of interpretEvent(e, dropCarryBeat)) {
        anchors.push({ ...a, evt: i });
      }
    }
  }
  anchors.sort((a, b) => a.t - b.t);
  return anchors;
}
