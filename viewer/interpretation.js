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
function interpretPass(e, out) {
  const p = config.interpretation.pass;
  const t0 = e.t;
  const meters = distanceMeters(e.x, e.y, e.x2, e.y2);
  const speed = e.speed ?? config.defaults.passSpeed;
  const ballDur = durationFromSpeed(meters, speed);

  // 球：起点 → 终点（直线）
  out.push({ t: t0, kind: 'ball', x: e.x, y: e.y });
  out.push({ t: t0 + ballDur, kind: 'ball', x: e.x2, y: e.y2 });
  // 接球者（to）：从当前位置(receiver_x/y)跑向落点（不瞬移，比球稍晚到位）
  if (e.to !== undefined) {
    const startX = e.receiver_x !== undefined ? e.receiver_x : e.x2;
    const startY = e.receiver_y !== undefined ? e.receiver_y : e.y2;
    out.push({ t: t0, kind: 'player', id: e.to, x: startX, y: startY });
    out.push({ t: t0 + ballDur + p.receiverBrakeDuration, kind: 'player', id: e.to, x: e.x2, y: e.y2 });
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
  // 球终点：goal 时略过门线（进网），saved 时停在门线
  const ballEndX = isGoal ? (e.x2 >= 0.5 ? 1.02 : -0.02) : e.x2; // 越过门线一点表示进网
  const ballEndY = e.y2 ?? 0.5;
  out.push({ t: t0, kind: 'ball', x: e.x, y: e.y });
  out.push({ t: t0 + flightDur, kind: 'ball', x: ballEndX, y: ballEndY });
  // 射手（subject）：原地（摆腿）
  out.push({ t: t0, kind: 'player', id: e.subject, x: e.x, y: e.y });
  // 门将：从己方门线中点向射门方向扑
  const keeperId = e.subjectTeam === 'home' ? 21 : 0; // 对侧门将
  const keeperStartX = keeperId === 21 ? 0.98 : 0.02;
  const keeperStartY = 0.5;
  const keeperTargetY = e.y2 !== undefined ? e.y2 : 0.5;
  // 门将扑救终点：
  //   - saved：扑到球路线上（= 球终点），挡住球
  //   - goal：门将扑向射门侧，但球已越过（门将 y 比球略偏，表示没够到）
  const keeperEndY = isGoal ? (keeperTargetY + (keeperTargetY >= 0.5 ? 0.02 : -0.02)) : keeperTargetY;
  out.push({ t: t0, kind: 'player', id: keeperId, x: keeperStartX, y: keeperStartY });
  out.push({ t: t0 + s.keeperReactDelay, kind: 'player', id: keeperId, x: keeperStartX, y: keeperStartY });
  out.push({ t: t0 + flightDur, kind: 'player', id: keeperId, x: keeperStartX, y: keeperEndY });
}

// ---- 抢断/拦截：带球中被抢 → 逼近 → 碰撞捅开 → 弹开 + 捡球 ----
// 被铲者从 carrier_from_x/y（引擎给带球起点）带球到接触点（x2/y2），防守者同时逼近；
// 碰撞后球弹开（优先引擎 loose_x/y，缺失则自算垂线弹开点）；按 result 决定谁捡球。
// result=success（或缺省）→ 防守者拿球；result=fail → 原持球人拿回。
function interpretTackle(e, out) {
  const t0 = e.t;
  const tackler = e.subject;
  const sx = e.x;
  const sy = e.y;
  const victim = e.to;
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
  // 带球起点：引擎给 carrier_from 时被铲者从那里带球到接触点；缺失则原地持球（fallback）
  const hasCarrierFrom = Number.isFinite(e.carrier_from_x) && Number.isFinite(e.carrier_from_y);
  const cfx = hasCarrierFrom ? e.carrier_from_x : vx;
  const cfy = hasCarrierFrom ? e.carrier_from_y : vy;

  // 1) 带球逼近：被铲者从 carrier_from 带球到接触点（球在他脚下），防守者从起点逼近
  const carrierMoveDur = durationFromSpeed(distanceMeters(cfx, cfy, vx, vy), config.defaults.dribbleSpeed);
  const approachDur = durationFromSpeed(distanceMeters(sx, sy, vx, vy), config.defaults.runSpeed);
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
  const tLoose = tContact + deflectDur;
  out.push({ t: tLoose, kind: 'ball', x: loose.x, y: loose.y });

  // 3) 捡球：球先到位，捡球人反应一拍（collectDelay），再以跑速追到弹开点，人球汇合 = 拾取。
  //    success → 防守者拿球；fail → 原持球人拿回（被铲者在接触点等到球被捅开再动）。
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

// ---- 主入口：把一条事件演绎成锚点序列 ----
// 返回 [{t, kind, id?, x, y}]，锚点已按 t 排序
export function interpretEvent(e) {
  const out = [];
  switch (e.type) {
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
      interpretTackle(e, out);
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
export function buildTimeline(events) {
  const anchors = [];
  for (let i = 0; i < events.length; i++) {
    for (const a of interpretEvent(events[i])) {
      anchors.push({ ...a, evt: i });
    }
  }
  anchors.sort((a, b) => a.t - b.t);
  return anchors;
}
