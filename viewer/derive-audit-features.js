// 从 viewer 可见证据推导审计特征（P10）。
//
// 纯函数：输入归一化事件 + 锚点时间线 + lineup，输出米制 audit_input（事件 + 逐球员快照），
// 并对可观测几何/事件流事实推导 detector 特征。只推导 viewer 真的能看到的事实：
//   - 最近防守者距离（传球起点 ↔ 对方球员插值位置）
//   - 传球走廊距离 / 拦截机会（防守者到传球线段的垂直距离 + 到达时间）
//   - 责任状态 / 静止时长（球进责任区 = 球在球员附近且移动中；球权转换 = 事件流里可见）
// 引擎内部决策事实（formation_hold、engine responsibility 等）无从观测 → 不推导，保持 unknown。
// 所有推导值都标 responsibility_source / pass_speed_source，绝不伪装成引擎事实。
//
// 无 DOM、无 WASM、无网络。确定性：同一输入产生同一输出。

// audit_input 的形状版本（P21 D6）。detector 读的字段契约会在版本里演进；消费方
// （tools/detectors.mjs 的 runAudit）入口校验它，缺失或未知即报错，避免「字段悄悄换了
// 写法、detector 静默读空」这类断裂再次潜伏。定义在生产方，tools 侧再导出。
export const AUDIT_INPUT_SCHEMA_VERSION = 'audit-input/1';

const round3 = (n) => Math.round(n * 1000) / 1000;

// 推导参数（viewer 侧可观测事实的阈值；audit profile 的阈值仍由 detectors 裁决）。
const VIEWER_DERIVATION = {
  sample_step: 0.5, // 球员快照采样间隔（秒）
  zone_radius: 12.0, // 球进入球员半径（米）且球在移动 → ball_entered_zone
  transition_window: 2.0, // 球权转换后多少秒内视为责任窗口
  ball_static_epsilon: 0.02, // 球移动低于此（米）视为静止
  moved_epsilon: 0.5, // 位移/距离减少超过此（米）才算“移动/趋近”
};

// 球员 id 方案：0-10 home，11-21 away（protocol.js）。lineup 里如有 team 字段优先。
function teamOf(id, lineupMap) {
  if (typeof id !== 'number') return null;
  const fromLineup = lineupMap && lineupMap.get(id);
  if (fromLineup) return fromLineup;
  if (id >= 0 && id <= 10) return 'home';
  if (id >= 11 && id <= 21) return 'away';
  return null;
}

// 锚点时间线 → 按实体分组的插值列表（球一组、每球员一组）。锚点已按 t 排序。
function anchorLists(timeline) {
  const ball = [];
  const players = new Map();
  for (const a of timeline ?? []) {
    if (a && typeof a.t === 'number') {
      if (a.kind === 'ball') ball.push(a);
      else if (a.kind === 'player' && a.id !== undefined) {
        if (!players.has(a.id)) players.set(a.id, []);
        players.get(a.id).push(a);
      }
    }
  }
  return { ball, players };
}

// 在锚点列表上插值 t 时刻的位置。与 Game._interpolateAnchors 同语义：跨事件间隙 hold，
// 末尾 hold，无锚点返回 null。位置是归一化 [0,1]。
function interpolateAnchors(arr, t) {
  if (!arr || arr.length === 0) return null;
  let lo = 0;
  let hi = arr.length - 1;
  let pos = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t <= t) {
      pos = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (pos === -1) return { x: arr[0].x, y: arr[0].y };
  const prev = arr[pos];
  const next = pos + 1 < arr.length ? arr[pos + 1] : null;
  if (!next) return { x: prev.x, y: prev.y };
  if (prev.evt !== undefined && next.evt !== undefined && prev.evt !== next.evt) {
    return { x: prev.x, y: prev.y };
  }
  const span = Math.max(next.t - prev.t, 1e-6);
  const u = Math.min(Math.max((t - prev.t) / span, 0), 1);
  return { x: prev.x + (next.x - prev.x) * u, y: prev.y + (next.y - prev.y) * u };
}

// 点到线段最近距离（归一化坐标输入，clamp 到线段上）。
function pointToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return { dist: Math.hypot(px - ax, py - ay), u: 0 };
  let u = ((px - ax) * abx + (py - ay) * aby) / len2;
  u = Math.min(Math.max(u, 0), 1);
  const cx = ax + u * abx;
  const cy = ay + u * aby;
  return { dist: Math.hypot(px - cx, py - cy), u };
}

// 有球动作区间 + 参与者。用于排除当前动作参与者（传球者/接球者等正在做动作的球员
// 不可能是“责任状态下站桩”的候选人）。duration 与演绎层同口径（距离÷速度，下限 0.05s）。
function onBallActors(events, pitch, defaults) {
  const acts = [];
  for (const e of events ?? []) {
    if (e.type === 'beat') {
      if (e.main) acts.push({ t0: e.t, t1: e.t + 1, participants: [e.main.subject] });
      else if (e.ball) acts.push({ t0: e.t, t1: e.t + 1, participants: [] });
      continue;
    }
    if (e.type === 'tackle') {
      const victim = e.carrier ?? e.to;
      acts.push({
        t0: e.t,
        t1: e.t + 1,
        participants: [e.subject, victim].filter((x) => typeof x === 'number'),
      });
      continue;
    }
    if (e.type === 'pass' || e.type === 'dribble' || e.type === 'shot') {
      if (typeof e.x !== 'number' || typeof e.y !== 'number' || typeof e.x2 !== 'number' || typeof e.y2 !== 'number') {
        continue;
      }
      const meters = Math.hypot((e.x2 - e.x) * pitch.length, (e.y2 - e.y) * pitch.width);
      const speed = typeof e.speed === 'number' && e.speed > 0
        ? e.speed
        : defaults[e.type === 'pass' ? 'passSpeed' : e.type === 'dribble' ? 'dribbleSpeed' : 'shotSpeed'];
      const dur = speed > 0 ? Math.max(meters / speed, 0.05) : 0.05;
      const participants =
        e.type === 'pass'
          ? [e.from, e.to]
          : e.type === 'shot'
            ? [e.subject, (typeof e.subject === 'number' && e.subject <= 10) ? 21 : 0]
            : [e.subject];
      acts.push({
        t0: e.t,
        t1: e.t + dur,
        participants: participants.filter((x) => typeof x === 'number'),
      });
    }
  }
  return acts;
}

// t 时刻正在做有球动作的球员集合（排除站桩候选）。
function activeActorsAt(acts, t) {
  const set = new Set();
  for (const act of acts) {
    if (t >= act.t0 - 1e-9 && t <= act.t1 + 1e-9) {
      for (const id of act.participants) set.add(id);
    }
  }
  return set;
}

// 球权转换时间点：连续有球动作的 team 变化处。
function possessionTransitionTimes(events, lineupMap) {
  const times = [];
  let prevTeam = null;
  for (const e of events ?? []) {
    let team = null;
    if (e.type === 'pass') team = teamOf(e.from, lineupMap);
    else if (e.type === 'dribble' || e.type === 'tackle' || e.type === 'shot') team = teamOf(e.subject, lineupMap);
    else if (e.type === 'beat' && e.main) team = teamOf(e.main.subject, lineupMap);
    if (team && prevTeam && team !== prevTeam) times.push(e.t);
    if (team) prevTeam = team;
  }
  return times;
}

// 可观测死球标记：whistle、goal、out、无开球动作的 kickoff。
// 注：`pass && result === 'out'` 与 `kickoff && x2 === undefined` 两支在真实数据上不可达——
// 调用方取的是「最近一个事件」（latestEventAt），而每条出界 pass 后紧跟同 t 的 beat（P27 实测
// 113/113），kickoff 也带 x2。分支保留为语义表达；死球标记实际靠 whistle + 球静止。
function isDeadBallEvent(e) {
  if (!e) return false;
  if (e.type === 'whistle') return true;
  if (e.type === 'shot' && e.result === 'goal') return true;
  if (e.type === 'pass' && e.result === 'out') return true;
  if (e.type === 'kickoff' && e.x2 === undefined) return true;
  return false;
}

function latestEventAt(events, t) {
  let latest = null;
  for (const e of events ?? []) {
    if (e.t <= t + 1e-9) latest = e;
  }
  return latest;
}

// 球是否在 t 时刻移动（t 与 t+0.25s 的插值位置差 > epsilon）。
function makeBallMovingAt(ballAnchors, pitch) {
  return (t) => {
    const a = interpolateAnchors(ballAnchors, t);
    const b = interpolateAnchors(ballAnchors, t + 0.25);
    if (!a || !b) return false;
    const dx = (b.x - a.x) * pitch.length;
    const dy = (b.y - a.y) * pitch.width;
    return Math.hypot(dx, dy) > VIEWER_DERIVATION.ball_static_epsilon;
  };
}

// 传球事件推导：最近防守者距离 + 传球走廊/拦截机会特征。
function derivePassEvent(e, i, { pitch, lineupMap, anchors, passDefaultSpeed }) {
  const out = { ...e, index: e.index ?? i };
  if (
    typeof e.x !== 'number' || typeof e.y !== 'number' ||
    typeof e.x2 !== 'number' || typeof e.y2 !== 'number'
  ) {
    return out;
  }
  const ox = e.x * pitch.length;
  const oy = e.y * pitch.width;
  const lx = e.x2 * pitch.length;
  const ly = e.y2 * pitch.width;
  const segLen = Math.hypot(lx - ox, ly - oy);
  out.x = round3(ox);
  out.y = round3(oy);
  out.x2 = round3(lx);
  out.y2 = round3(ly);
  out.pass_distance = round3(segLen);
  // P27 出界真实坐标 out_pos 同步米制化（同 x2/y2 口径）——审计层坐标单位必须一致，
  // 否则同一事件里 out_pos（归一化、可越界）与 x2/y2（米制）混用两套单位。它保留越界符号。
  if (Array.isArray(e.out_pos) && e.out_pos.length === 2
      && typeof e.out_pos[0] === 'number' && typeof e.out_pos[1] === 'number') {
    out.out_pos = [round3(e.out_pos[0] * pitch.length), round3(e.out_pos[1] * pitch.width)];
  }

  // 传球速度（m/s）：事件 speed 优先，否则用 viewer 默认，并标注来源。
  if (typeof e.speed === 'number' && e.speed > 0) {
    out.pass_speed = round3(e.speed);
    out.pass_speed_source = 'event.speed';
  } else {
    out.pass_speed = round3(passDefaultSpeed);
    out.pass_speed_source = 'config.defaults.passSpeed';
  }

  const passerTeam = teamOf(e.from ?? e.subject, lineupMap);
  const defenderTeam = passerTeam === 'home' ? 'away' : passerTeam === 'away' ? 'home' : null;
  if (!defenderTeam) return out;

  // 候选防守者：时间线里位置可观测的对方球员（插值需要锚点）。
  const defenderIds = [];
  for (const id of anchors.players.keys()) {
    if (teamOf(id, lineupMap) === defenderTeam) defenderIds.push(id);
  }

  // 最近防守者（到传球起点）。
  let nearest = null;
  for (const id of defenderIds) {
    const pos = interpolateAnchors(anchors.players.get(id), e.t);
    if (!pos) continue;
    const px = pos.x * pitch.length;
    const py = pos.y * pitch.width;
    const dist = Math.hypot(px - ox, py - oy);
    if (!nearest || dist < nearest.dist) nearest = { id, dist };
  }
  if (nearest) {
    out.nearest_defender_id = nearest.id;
    out.nearest_defender_distance = round3(nearest.dist);
  }

  // 传球走廊：最近防守者到传球线段的垂直距离。
  let best = null;
  for (const id of defenderIds) {
    const pos = interpolateAnchors(anchors.players.get(id), e.t);
    if (!pos) continue;
    const px = pos.x * pitch.length;
    const py = pos.y * pitch.width;
    const seg = pointToSegment(px, py, ox, oy, lx, ly);
    if (!best || seg.dist < best.dist) best = { id, dist: seg.dist, px, py };
  }
  if (best && segLen > 0) {
    out.corridor_distance = round3(best.dist);
    out.defender_id = best.id;
    // 防守者是否朝走廊移动：传球窗口结束时刻到走廊的距离是否明显减小。
    const endT = e.t + segLen / out.pass_speed;
    const endPos = interpolateAnchors(anchors.players.get(best.id), endT);
    if (endPos) {
      const endSeg = pointToSegment(
        endPos.x * pitch.length, endPos.y * pitch.width, ox, oy, lx, ly
      );
      if (endSeg.dist < best.dist - VIEWER_DERIVATION.moved_epsilon) {
        out.defender_moved_toward_corridor = true;
      } else if (Math.abs(endSeg.dist - best.dist) <= VIEWER_DERIVATION.moved_epsilon) {
        // 起点与终点位置都可观测且无趋近 → 明确没有朝走廊移动。
        out.defender_moved_toward_corridor = false;
      }
      // 终点不可插值（无锚点）时保持缺失：检测器按“无观测到移动”处理。
    }
  }
  return out;
}

// 在窗口内按固定步长采样每个球员，并推导可观测的责任/静止/死球标记。
function derivePlayerSnapshots({
  events,
  lineupMap,
  anchors,
  pitch,
  window: win,
  matchTime,
  transitionTimes,
  ballMovingAt,
  acts,
}) {
  const players = {};
  const lo = matchTime - win.before;
  const hi = matchTime + win.after;
  const step = VIEWER_DERIVATION.sample_step;

  // 采样范围球员：lineup + 时间线里出现过的 id。
  const playerIds = new Set([...lineupMap.keys()]);
  for (const id of anchors.players.keys()) playerIds.add(id);

  const goalX = (team) => (team === 'home' ? pitch.length : 0);

  for (const id of playerIds) {
    if (typeof id !== 'number') continue;
    const snaps = [];
    for (let t = lo; t <= hi + 1e-9; t = round3(t + step)) {
      const pos = interpolateAnchors(anchors.players.get(id), t);
      if (!pos) continue;
      const ball = interpolateAnchors(anchors.ball, t);
      const team = teamOf(id, lineupMap);
      const snap = {
        t: round3(t),
        x: round3(pos.x * pitch.length),
        y: round3(pos.y * pitch.width),
      };
      if (id === 0 || id === 21) snap.is_gk = true; // viewer 门将 id：home 0 / away 21

      const ballMoving = ballMovingAt(t);
      const latest = latestEventAt(events, t);
      // 死球：球静止 + 最近事件是可观测死球标记。
      if (!ballMoving && isDeadBallEvent(latest)) snap.dead_ball = true;

      // 当前动作参与者不可能是站桩候选（传球者/接球者/持球者正在做动作）。
      const activeNow = activeActorsAt(acts, t);

      // 责任状态（viewer 可观测代理，标注来源；无证据 → 不设置 → 检测器 unknown）。
      const ballNear =
        ball &&
        Math.hypot(ball.x * pitch.length - snap.x, ball.y * pitch.width - snap.y) <=
          VIEWER_DERIVATION.zone_radius;
      const transition = transitionTimes.some(
        (tt) => t >= tt - 1e-9 && t - tt <= VIEWER_DERIVATION.transition_window
      );
      let responsibility = null;
      if (transition && !activeNow.has(id)) {
        responsibility = 'possession_transition';
      } else if (!activeNow.has(id) && ballMoving && ballNear) {
        responsibility = 'ball_entered_zone';
      }
      if (responsibility) {
        snap.responsibility = responsibility;
        snap.responsibility_source = 'viewer-derived';
      }

      // 向球/目标移动：仅当球员自身位置改变且到球/对方球门距离明显减小。
      const nextPos = interpolateAnchors(anchors.players.get(id), round3(t + step));
      if (nextPos && (nextPos.x !== pos.x || nextPos.y !== pos.y)) {
        const nextBall = interpolateAnchors(anchors.ball, round3(t + step));
        if (ball) {
          const d0 = Math.hypot(ball.x * pitch.length - snap.x, ball.y * pitch.width - snap.y);
          const nx = (nextBall ? nextBall.x * pitch.length : ball.x * pitch.length);
          const ny = (nextBall ? nextBall.y * pitch.width : ball.y * pitch.width);
          const d1 = Math.hypot(nx - nextPos.x * pitch.length, ny - nextPos.y * pitch.width);
          if (d1 < d0 - VIEWER_DERIVATION.moved_epsilon) snap.moved_toward_ball = true;
        }
        if (team) {
          const gx = goalX(team);
          const d0 = Math.abs(pos.x * pitch.length - gx);
          const d1 = Math.abs(nextPos.x * pitch.length - gx);
          if (d1 < d0 - VIEWER_DERIVATION.moved_epsilon) snap.moved_toward_goal = true;
        }
      }
      snaps.push(snap);
    }
    if (snaps.length > 0) players[id] = snaps;
  }
  return players;
}

// 主入口：归一化事件 + 锚点时间线 + lineup → 米制 audit_input（事件 + 球员快照）。
export function deriveAuditInput({
  events = [],
  timeline = [],
  lineup = [],
  pitch = { length: 105, width: 68 },
  defaults = { passSpeed: 10, dribbleSpeed: 3, shotSpeed: 20 },
  window: win = { before: 5, after: 5 },
  matchTime = 0,
} = {}) {
  const anchors = anchorLists(timeline);
  const lineupMap = new Map();
  for (const p of lineup ?? []) {
    if (p && typeof p.id === 'number') lineupMap.set(p.id, p.team || teamOf(p.id));
  }

  const ballMovingAt = makeBallMovingAt(anchors.ball, pitch);
  const transitionTimes = possessionTransitionTimes(events, lineupMap);
  const acts = onBallActors(events, pitch, defaults);

  const meterEvents = (events ?? []).map((e, i) => {
    if (!e || typeof e !== 'object') return { t: i, type: 'unknown', index: i };
    const base = { ...e, index: e.index ?? i };
    if (e.type === 'pass') {
      return derivePassEvent(e, i, {
        pitch,
        lineupMap,
        anchors,
        passDefaultSpeed: defaults.passSpeed ?? 10,
      });
    }
    // 非 pass 事件：仅转米。
    for (const c of ['x', 'y', 'x2', 'y2']) {
      if (typeof base[c] === 'number') {
        base[c] = c === 'y' || c === 'y2'
          ? round3(base[c] * pitch.width)
          : round3(base[c] * pitch.length);
      }
    }
    return base;
  });

  const players = derivePlayerSnapshots({
    events: meterEvents,
    lineupMap,
    anchors,
    pitch,
    window: win,
    matchTime,
    transitionTimes,
    ballMovingAt,
    acts,
  });

  return {
    schema_version: AUDIT_INPUT_SCHEMA_VERSION,
    events: meterEvents,
    players,
    features_derived: {
      source: 'viewer-geometry',
      responsibility: 'viewer-derived',
      note: 'only facts observable from the event stream / anchor positions are derived; engine-internal decisions are left unknown',
    },
  };
}
