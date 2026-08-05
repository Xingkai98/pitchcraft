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

// ---- 抢断/拦截：防守者逼近持球者 + 球权切换 ----
// 逼近时长 = 防守者到持球者的距离 ÷ 跑速。
function interpretTackle(e, out) {
  const t0 = e.t;
  const victim = e.to;
  const victimX = e.x2 !== undefined ? e.x2 : e.x; // 被铲者位置（引擎给 x2/y2）
  const victimY = e.y2 !== undefined ? e.y2 : e.y;
  const meters = distanceMeters(e.x, e.y, victimX, victimY);
  const approachDur = durationFromSpeed(meters, config.defaults.runSpeed);
  out.push({ t: t0, kind: 'player', id: e.subject, x: e.x, y: e.y });
  // 防守者向持球者位置移动（逼近）
  out.push({
    t: t0 + approachDur,
    kind: 'player', id: e.subject,
    x: victimX, y: victimY,
  });
  // 被铲者（to）在 x2/y2 位置（原地，若事件带 to）
  if (victim !== undefined) {
    out.push({ t: t0, kind: 'player', id: victim, x: victimX, y: victimY });
  }
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
