// 事件人话标签（P20 事件锚定确认步）。
//
// 事件是技术字段 {t,type,subject,result,detail,...}，用户在确认锚点时必须能看到
// 「这条到底是传球还是射门」——猜错锚点则后续诊断全废。本模块把一条事件渲染成
//   #55 · t=51s · 传球出边线 · 主队 #7
// 这类单行标签。
//
// 双端共享（design D4）：页面（viewer/app.js，浏览器 ESM import）与 CLI
// （tools/queue-cli.mjs / tools/runner.mjs，Node ESM import）用**同一份函数**。
// 落点必须在 viewer/ 而不能在 tools/：index.html 由 viewer/serve.py 在 viewer 目录起
// 静态服务，浏览器里 app.js 只能 import viewer/ 内的模块（`../tools/x.mjs` 会 404）。
// 反向引用 tools→viewer 有先例（tools/github.mjs import ../viewer/audit-report.js）。
//
// 纯函数、无 DOM、无网络、无凭证。

// 事件类型 → 基础标签。未列出的类型原样显示 type（引擎新增类型时不至于渲染成空白）。
const TYPE_LABELS = {
  pass: '传球',
  shot: '射门',
  tackle: '抢断',
  foul: '犯规',
  dribble: '带球',
  interception: '拦截',
  off_ball_run: '无球跑动',
  kickoff: '开球',
  whistle: '哨声',
  lineup: '首发站位',
  substitution: '换人',
};

// detail 分两类（design D4 要求「区分 detail」，且角球/界外球须是**独立类型**而非
// 「传球角球」这类叠词）：
//   REPLACE —— detail 本身就是完整事件名，直接顶替 type（角球其实是 pass，但用户必须
//              一眼看出是角球而不是普通传球）；
//   SUFFIX  —— detail 是 type 的限定，拼在 type 后面（传球出边线 / 射门头球）。
const DETAIL_REPLACE = {
  corner: '角球',
  throw_in: '界外球',
  free_kick: '任意球',
};
const DETAIL_SUFFIX = {
  out_sideline: '出边线',
  out_goal_line: '出底线',
  header: '头球',
  foul_trip: '绊人',
};

// whistle 的 detail 是比赛阶段，不是动作细节，单独一张表。
const WHISTLE_DETAIL_LABELS = {
  half_time: '半场',
  kickoff_again: '重新开球',
  full_time: '终场',
};

// 结果限定词：仅在**没有 detail** 时追加到标签（有 detail 时 detail 已说明发生了什么，
// 再叠结果会变长且互相打架）。
const PASS_RESULT_LABELS = {
  intercepted: '被断',
  lost: '传丢',
  contested: '争抢',
  success: '成功',
};
const SHOT_RESULT_LABELS = {
  goal: '得分',
  saved: '被扑',
  off_target: '偏出',
};

// 这些类型的 subject 是真实球员；whistle/lineup 的 subject 是占位 0，不能渲染成「主队 #0」。
const PLAYERLESS_TYPES = new Set(['whistle', 'lineup']);

// 列表默认只列「高亮事件」（design：shot/pass/corner/tackle/foul/throw_in）。corner/throw_in
// 都是 pass 带 detail，故只需按 type 判。beat 是每 tick 的过渡拍，默认折叠。
const CANDIDATE_TYPES = new Set(['pass', 'shot', 'tackle', 'foul']);

/**
 * 该事件是否进「默认候选」列表（页面 B 面 / CLI events 的省略视图）。
 * beat / off_ball_run / dribble 等过渡事件默认不列，用户可开「显示全部」展开。
 */
export function isCandidateEvent(e) {
  return CANDIDATE_TYPES.has(e?.type);
}

// 由球员 id 推队别（0-10 主队 / 11-21 客队）。lineup 缺失或 id 越界时返回 null。
function teamFromId(id) {
  if (typeof id !== 'number' || !Number.isInteger(id)) return null;
  if (id >= 0 && id <= 10) return 'home';
  if (id >= 11 && id <= 21) return 'away';
  return null;
}

const TEAM_LABELS = { home: '主队', away: '客队' };

// lineup（bundle.lineup / engine 事件里的 players）→ id→队别映射。
// 条目形如 {id, team, x, y}；team 可能是 'home'/'away' 也可能是 0/1，两者都收。
function teamMapFromLineup(lineup) {
  const map = new Map();
  if (!Array.isArray(lineup)) return map;
  for (const p of lineup) {
    if (p == null || typeof p.id !== 'number') continue;
    const t = p.team;
    if (t === 'home' || t === 0) map.set(p.id, 'home');
    else if (t === 'away' || t === 1) map.set(p.id, 'away');
  }
  return map;
}

// 球员标识：优先用 lineup 给的队别，缺失时按 id 区间推。id 非法则返回 null。
function playerLabel(id, teamMap) {
  if (typeof id !== 'number' || !Number.isInteger(id)) return null;
  const team = teamMap.get(id) ?? teamFromId(id);
  if (!team) return null;
  return `${TEAM_LABELS[team]} #${id}`;
}

// 事件里「谁」：beat 的主体嵌在 main，其余用 subject（pass 缺 subject 时回退 from）。
function subjectOf(e) {
  if (e?.type === 'beat') return e.main?.subject;
  return e?.subject ?? e?.from;
}

// 动作描述（不含球员）。beat 折叠规则：有 main → 带球（main.type 恒为 dribble）；
// 纯 beat（只有 movers/ball）→ 无球跑动。
function actionLabel(e) {
  const type = e?.type;
  if (type === 'beat') {
    return e.main ? (TYPE_LABELS[e.main.type] ?? TYPE_LABELS.dribble) : TYPE_LABELS.off_ball_run;
  }
  if (type === 'whistle') {
    const detail = WHISTLE_DETAIL_LABELS[e.detail];
    return detail ? `哨声（${detail}）` : TYPE_LABELS.whistle;
  }
  if (type === 'lineup') return TYPE_LABELS.lineup;

  const base = TYPE_LABELS[type] ?? (typeof type === 'string' ? type : '未知事件');
  // detail 比 result 更能说明问题（出边线的传球 vs 一次成功的传球），有则优先。
  if (DETAIL_REPLACE[e?.detail]) return DETAIL_REPLACE[e.detail];
  if (DETAIL_SUFFIX[e?.detail]) return `${base}${DETAIL_SUFFIX[e.detail]}`;

  if (type === 'pass' && PASS_RESULT_LABELS[e?.result]) return `${base}${PASS_RESULT_LABELS[e.result]}`;
  if (type === 'shot' && SHOT_RESULT_LABELS[e?.result]) return `${base}${SHOT_RESULT_LABELS[e.result]}`;
  return base;
}

// t → 「t=51s」。非有限值给占位，绝不抛异常（旧任务/半截事件也要能显示）。
function timeLabel(t) {
  const n = Number(t);
  if (!Number.isFinite(n)) return 't=?s';
  return `t=${Math.round(n)}s`;
}

// index → 「#55」。缺失给 `#?`（页面全量列表里不应出现，兜底而已）。
function indexLabel(index) {
  return typeof index === 'number' && Number.isFinite(index) ? `#${index}` : '#?';
}

/**
 * 把一条窗口事件渲染成人话标签：`#55 · t=51s · 传球出边线 · 主队 #7`。
 *
 * @param {object} e 窗口事件（bundle.events 的一条，须带 index）
 * @param {Array<{id:number,team?:string|number}>} [lineup] 球员 id→队别映射；缺失时按 id 区间推
 * @returns {string} 单行标签；输入为 null/非对象时返回 '（无效事件）'
 */
export function describeEvent(e, lineup = null) {
  if (e === null || typeof e !== 'object' || Array.isArray(e)) return '（无效事件）';
  const parts = [indexLabel(e.index), timeLabel(e.t), actionLabel(e)];
  if (!PLAYERLESS_TYPES.has(e.type)) {
    const who = playerLabel(subjectOf(e), teamMapFromLineup(lineup));
    if (who) parts.push(who);
  }
  return parts.join(' · ');
}
