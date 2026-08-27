// 事件流协议解析（v1 + v2 beat）
// 引擎产出 JSON 事件流 → 解析成 JS 事件对象。
// 协议字段与 id 方案遵循 openspec/specs/event-stream-protocol/spec.md + p4-parallel-beats delta。

// 事件类型枚举（11 类：v1 动作 + lineup + v2 beat；goal 由 shot.result=goal 表达，非独立类型）
export const EVENT_TYPES = [
  'lineup',
  'kickoff',
  'whistle',
  'pass',
  'dribble',
  'shot',
  'tackle',
  'interception',
  'substitution',
  'off_ball_run',
  'beat',
];

// 球员 id 方案：0-10 = 主队(home)，11-21 = 客队(away)
export function playerTeam(id) {
  if (typeof id !== 'number') {
    throw new Error(`invalid player id: ${id}`);
  }
  if (id >= 0 && id <= 10) return 'home';
  if (id >= 11 && id <= 21) return 'away';
  throw new Error(`player id out of range 0-21: ${id}`);
}

// 校验 beat 事件（v2 节拍）：无顶层 subject/x/y；movers/main/ball 结构与互斥
function validateBeat(e) {
  // movers：增量数组，id 唯一且在 0-21，坐标 [0,1]
  if (e.movers !== undefined) {
    if (!Array.isArray(e.movers)) throw new Error(`beat movers must be array: ${JSON.stringify(e.movers)}`);
    const seen = new Set();
    for (const m of e.movers) {
      if (typeof m.id !== 'number' || !Number.isInteger(m.id) || m.id < 0 || m.id > 21) {
        throw new Error(`beat mover id invalid: ${JSON.stringify(m.id)}`);
      }
      if (seen.has(m.id)) throw new Error(`beat mover id duplicate: ${m.id}`);
      seen.add(m.id);
      for (const c of ['from_x', 'from_y', 'to_x', 'to_y']) {
        if (typeof m[c] !== 'number' || !Number.isFinite(m[c]) || m[c] < 0 || m[c] > 1) {
          throw new Error(`beat mover coord ${c}=${m[c]} out of [0,1]`);
        }
      }
    }
  }
  // main 与 ball 互斥（唯一驱动者）；null/undefined 视为缺失
  if (e.main != null && e.ball != null) {
    throw new Error(`beat cannot have both main and ball: ${JSON.stringify(e)}`);
  }
  // main：carrier 带球/控球（main-only）
  if (e.main != null) {
    if (e.main.type !== 'dribble') throw new Error(`beat.main type must be dribble: ${e.main.type}`);
    if (typeof e.main.subject !== 'number' || e.main.subject < 0 || e.main.subject > 21) {
      throw new Error(`beat.main subject invalid: ${e.main.subject}`);
    }
    for (const c of ['x', 'y', 'x2', 'y2']) {
      if (typeof e.main[c] !== 'number' || !Number.isFinite(e.main[c]) || e.main[c] < 0 || e.main[c] > 1) {
        throw new Error(`beat.main coord ${c}=${e.main[c]} out of [0,1]`);
      }
    }
  }
  // ball：松散球（含滚动轨迹）
  if (e.ball != null) {
    if (e.ball.loose !== true) throw new Error(`beat.ball.loose must be true: ${JSON.stringify(e.ball)}`);
    for (const c of ['x', 'y', 'x2', 'y2']) {
      if (typeof e.ball[c] !== 'number' || !Number.isFinite(e.ball[c]) || e.ball[c] < 0 || e.ball[c] > 1) {
        throw new Error(`beat.ball coord ${c}=${e.ball[c]} out of [0,1]`);
      }
    }
  }
}

// 校验单条事件的基础字段（t/type 必填；非 beat 需 subject/x/y）+ 类型相关必填字段
function validateBaseEvent(e) {
  if (typeof e.t !== 'number') throw new Error(`event missing numeric t: ${JSON.stringify(e)}`);
  if (!EVENT_TYPES.includes(e.type)) throw new Error(`event has unknown type: ${e.type}`);
  // beat 特判：无顶层 subject/x/y（主体与位置嵌套在 movers/main/ball 内）
  if (e.type === 'beat') {
    validateBeat(e);
    return;
  }
  if (typeof e.subject !== 'number' && typeof e.subject !== 'string') {
    throw new Error(`event missing subject: ${JSON.stringify(e)}`);
  }
  if (typeof e.x !== 'number' || typeof e.y !== 'number') {
    throw new Error(`event missing x/y: ${JSON.stringify(e)}`);
  }
  // 归一化坐标必须在 [0,1]（含 Phase B 新增的 tackle 坐标字段）。
  // 用 typeof === 'number' 判断：null/字符串/null 不得绕过范围校验。
  for (const c of ['x', 'y', 'x2', 'y2', 'loose_x', 'loose_y', 'carrier_from_x', 'carrier_from_y', 'receiver_x', 'receiver_y', 'keeper_x', 'keeper_y']) {
    if (e[c] !== undefined && e[c] !== null) {
      if (typeof e[c] !== 'number' || !Number.isFinite(e[c])) {
        throw new Error(`event coordinate ${c} must be a finite number: ${String(e[c])}`);
      }
      if (e[c] < 0 || e[c] > 1) {
        throw new Error(`event coordinate ${c}=${e[c]} out of [0,1]`);
      }
    }
  }
  // h（球高度，P6 批次1）：可选，0-1 数字（pass/shot 高亮带弧线高度）
  if (e.h !== undefined && e.h !== null) {
    if (typeof e.h !== 'number' || !Number.isFinite(e.h) || e.h < 0 || e.h > 1) {
      throw new Error(`event h must be number 0-1: ${JSON.stringify(e.h)}`);
    }
  }
  // detail 枚举按事件类型限定（P6 批次1）：pass 校验出界/角球/解围，shot 校验头球；
  // 其他类型 detail（whistle 的 kickoff_again/half_time 等）不校验。
  if (e.detail !== undefined && e.detail !== null) {
    const passDetails = ['out_sideline', 'out_goal_line', 'corner', 'clearance', 'throw_in'];
    const shotDetails = ['header'];
    if (e.type === 'pass' && !passDetails.includes(e.detail)) {
      throw new Error(`pass detail must be one of ${passDetails.join('/')}: ${JSON.stringify(e.detail)}`);
    }
    if (e.type === 'shot' && !shotDetails.includes(e.detail)) {
      throw new Error(`shot detail must be one of ${shotDetails.join('/')}: ${JSON.stringify(e.detail)}`);
    }
  }
  // 类型相关必填：pass 必须有 from；to 可选（门球开大脚无接收者，落点是争抢点）。
  // to 在场时校验 0-21 整数（同 tackle 身份校验）。
  if (e.type === 'pass') {
    if (e.from === undefined) {
      throw new Error(`pass event requires from: ${JSON.stringify(e)}`);
    }
    if (e.to !== undefined && (typeof e.to !== 'number' || !Number.isInteger(e.to) || e.to < 0 || e.to > 21)) {
      throw new Error(`pass event to must be integer 0-21 when present: ${JSON.stringify(e.to)}`);
    }
  }
  // shot 必须有射门方向 x2/y2
  if (e.type === 'shot') {
    if (typeof e.x2 !== 'number' || typeof e.y2 !== 'number') {
      throw new Error(`shot event requires x2/y2: ${JSON.stringify(e)}`);
    }
  }
  // dribble 必须有终点 x2/y2
  if (e.type === 'dribble') {
    if (typeof e.x2 !== 'number' || typeof e.y2 !== 'number') {
      throw new Error(`dribble event requires x2/y2: ${JSON.stringify(e)}`);
    }
  }
  // tackle 定稿（票据02）：必须有接触点 x2/y2 与身份（v1 用 to / v2 用 carrier，0-21 数字）。
  // 仅 tackle 必填（有生产者）；interception 尚无生产者、语义不同（截传球无持球人），不强制。
  if (e.type === 'tackle') {
    const hasIdentity = (typeof e.to === 'number' && Number.isInteger(e.to) && e.to >= 0 && e.to <= 21)
      || (typeof e.carrier === 'number' && Number.isInteger(e.carrier) && e.carrier >= 0 && e.carrier <= 21);
    if (!hasIdentity) {
      throw new Error(`tackle event requires integer to or carrier (0-21): ${JSON.stringify(e.to)}`);
    }
    if (typeof e.x2 !== 'number' || typeof e.y2 !== 'number') {
      throw new Error(`tackle event requires x2/y2: ${JSON.stringify(e)}`);
    }
  }
}

// 解析单条事件（浅拷贝，补充 team 字段）
export function parseEvent(raw) {
  validateBaseEvent(raw);
  const e = { ...raw };
  // 给 subject 补上 team（画面层据此分主客队颜色）
  if (typeof e.subject === 'number') e.subjectTeam = playerTeam(e.subject);
  return e;
}

// 解析完整事件流（JSON 字符串或对象数组）
// 返回 { events, lineup }
//   events: 解析后的事件数组
//   lineup: 初始站位 { id, team, x, y }[]，来自开头的 lineup/kickoff 消息
export function parseEventStream(input) {
  const rawEvents = typeof input === 'string' ? JSON.parse(input) : input;
  if (!Array.isArray(rawEvents)) throw new Error('event stream must be an array');

  let lineup = null;
  const events = [];
  for (const raw of rawEvents) {
    const e = parseEvent(raw);
    // 初始站位：lineup 事件（或带 lineup 数据的 kickoff）携带 22 个 {id,team,x,y}
    if (e.type === 'lineup' || (e.type === 'kickoff' && Array.isArray(e.lineup))) {
      const players = e.lineup || e.players;
      if (!Array.isArray(players)) throw new Error('lineup event missing players array');
      lineup = players.map((p) => ({
        id: p.id,
        team: p.team || playerTeam(p.id),
        x: p.x,
        y: p.y,
      }));
    }
    events.push(e);
  }
  return { events, lineup };
}

// 便捷：是否射门得分
export function isGoal(e) {
  return e.type === 'shot' && e.result === 'goal';
}

// 便捷：主/客队颜色方案（供画面层引用，也可放 config）
export const TEAM_COLORS = {
  home: '#e74c3c', // 红
  away: '#3498db', // 蓝
};
