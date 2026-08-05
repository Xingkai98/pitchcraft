// 事件流协议解析（v1，草案落地）
// 引擎产出 JSON 事件流 → 解析成 JS 事件对象。
// 协议字段与 id 方案遵循 openspec/changes/p0-event-to-pitch/specs/event-stream-protocol/spec.md。

// 事件类型枚举（9 类：8 类动作 + lineup 初始站位；goal 由 shot.result=goal 表达，非独立类型）
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

// 校验单条事件的基础字段（t/type/subject/x/y 必填）+ 类型相关必填字段
function validateBaseEvent(e) {
  if (typeof e.t !== 'number') throw new Error(`event missing numeric t: ${JSON.stringify(e)}`);
  if (!EVENT_TYPES.includes(e.type)) throw new Error(`event has unknown type: ${e.type}`);
  if (typeof e.subject !== 'number' && typeof e.subject !== 'string') {
    throw new Error(`event missing subject: ${JSON.stringify(e)}`);
  }
  if (typeof e.x !== 'number' || typeof e.y !== 'number') {
    throw new Error(`event missing x/y: ${JSON.stringify(e)}`);
  }
  // 归一化坐标必须在 [0,1]
  for (const c of ['x', 'y', 'x2', 'y2']) {
    if (e[c] !== undefined && (e[c] < 0 || e[c] > 1)) {
      throw new Error(`event coordinate ${c}=${e[c]} out of [0,1]`);
    }
  }
  // 类型相关必填：pass 必须有 from/to（传球语义核心）
  if (e.type === 'pass') {
    if (e.from === undefined || e.to === undefined) {
      throw new Error(`pass event requires from/to: ${JSON.stringify(e)}`);
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
