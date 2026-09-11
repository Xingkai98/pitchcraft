// 观察列表状态模型（P10 Slice 3 viewer 切片）。
// 纯函数：条目创建、列表增改、状态判定、match_time 格式化、localStorage 序列化。
// 不含 DOM、不做网络请求、不含凭证。浏览器与 Node 双端可测。
//
// 列表条目持久化的是「元数据 + task_id」：诊断反馈（findings/report）是轮询
// 派生的渲染状态，只留在内存（findingsDetail），刷新后从服务端重新拉取。

export const LIST_STORAGE_KEY = 'p10.observation.list.v1';

// 状态词表（对应 match-observation spec / runner TASK_STATUSES）。P20 加入事件锚定
// 确认步的两态（awaiting_confirmation / confirmed，见 runner.mjs 注释）。
export const OBSERVATION_STATUSES = [
  'captured', 'awaiting_confirmation', 'confirmed', 'auditing', 'audit_ready', 'diagnosing',
  'diagnosed', 'insufficient_evidence', 'provider_unavailable', 'failed',
];

export const OBSERVATION_TERMINAL_STATUSES = new Set([
  'diagnosed', 'insufficient_evidence', 'provider_unavailable', 'failed',
]);

export function isTerminalStatus(status) {
  return OBSERVATION_TERMINAL_STATUSES.has(status);
}

export function isKnownStatus(status) {
  return OBSERVATION_STATUSES.includes(status);
}

const DEFAULT_CLOCK = () => (typeof Date === 'function' ? new Date().toISOString() : '');

// 创建一条列表条目。id 必填；created_at 可注入（测试用确定性值）。
export function createListEntry({
  id,
  statement = '',
  match_time = null,
  event_index = null,
  status = 'captured',
  task_id = null,
  created_at = null,
  sync_error = false,
  detail_error = null,
} = {}) {
  return {
    id,
    statement,
    match_time,
    event_index,
    status,
    task_id,
    created_at: created_at ?? DEFAULT_CLOCK(),
    sync_error,
    detail_error,
  };
}

export function addListEntry(list, entry) {
  return [...list, entry];
}

export function updateListEntry(list, id, patch) {
  return list.map((e) => (e.id === id ? { ...e, ...patch } : e));
}

export function upsertListEntry(list, entry) {
  return list.some((e) => e.id === entry.id)
    ? updateListEntry(list, entry.id, entry)
    : addListEntry(list, entry);
}

// 用服务端 bundle 的 statement 覆盖本地条目（已提交条目的描述以服务端为权威）。
// 仅当服务端给出的**是字符串**时覆盖：空串是有效值（用户把描述清空了），必须覆盖掉
// 本地旧值；null/undefined（bundle 缺失或旧服务不返回该字段）时保持本地值不动。
export function applyServerStatement(entry, statement) {
  if (typeof statement !== 'string') return entry;
  return { ...entry, statement };
}

// 秒 → MM:SS（比赛时刻显示，如 2234 → 37:14）。负数/NaN 兜底为 0:00。
export function formatMatchTime(seconds) {
  const s = Number(seconds);
  const clamped = Number.isFinite(s) && s >= 0 ? Math.floor(s) : 0;
  const mm = Math.floor(clamped / 60);
  const ss = clamped % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

// 描述摘要：单行截断 + 空值兜底。
export function summarizeStatement(statement, maxLen = 48) {
  const s = String(statement ?? '').trim();
  if (!s) return '(无描述)';
  return s.length <= maxLen ? s : `${s.slice(0, maxLen)}…`;
}

// 校验/规范化单条条目（从 localStorage 读回时丢弃非法条目，派生渲染状态不持久化）。
export function sanitizeEntry(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id === '') return null;
  const status = isKnownStatus(raw.status) ? raw.status : 'failed';
  return {
    id: raw.id,
    statement: typeof raw.statement === 'string' ? raw.statement : '',
    match_time: typeof raw.match_time === 'number' && Number.isFinite(raw.match_time) ? raw.match_time : null,
    event_index: typeof raw.event_index === 'number' ? raw.event_index : null,
    status,
    task_id: typeof raw.task_id === 'string' && raw.task_id.length > 0 ? raw.task_id : null,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : '',
    sync_error: raw.sync_error === true,
    detail_error: typeof raw.detail_error === 'string' ? raw.detail_error : null,
  };
}

// 解析 localStorage JSON → 规范化条目数组（非法条目丢弃，绝不抛异常）。
export function parseObservationList(text) {
  if (typeof text !== 'string' || text === '') return [];
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data.map(sanitizeEntry).filter(Boolean);
}

export function serializeObservationList(list) {
  return JSON.stringify(list);
}

// --- P20 事件锚定确认：条目上的确认渲染状态（纯函数，可测） ------------------
//
// 确认 UI 的数据来自 GET /tasks/:id（proposal + confirmation + 窗口 events/lineup）。
// 这些是**轮询派生的渲染状态**，与 findingsDetail 一样只留在内存、不进 localStorage
// （刷新后从服务端重新拉）。选择/展开状态也挂在条目上，避免 re-render 丢失。

// 从服务端任务响应提取确认步渲染数据。events 与 proposal 都缺时返回 null
// （旧任务/captured → 页面走原有路径，确认步是可选增强）。
export function confirmationDetailFromTask(data) {
  if (data === null || typeof data !== 'object') return null;
  const events = Array.isArray(data.events) ? data.events : [];
  const proposal = data.proposal && typeof data.proposal === 'object' ? data.proposal : null;
  const confirmation = data.confirmation && typeof data.confirmation === 'object' ? data.confirmation : null;
  if (events.length === 0 && proposal === null) return null;
  return {
    proposal,
    confirmation,
    events,
    lineup: Array.isArray(data.lineup) ? data.lineup : [],
  };
}

// 提案的候选 index 集合（带去重 + 非整数过滤）。无提案时返回空。
export function proposalIndexes(detail) {
  const raw = detail?.proposal?.event_indexes;
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  for (const i of raw) {
    if (Number.isInteger(i) && i >= 0) seen.add(i);
  }
  return [...seen];
}

// 默认勾选：模型提案的候选（用户在此基础上可增可减）。无提案（fallback-empty）→ 空。
export function defaultConfirmationSelection(detail) {
  return proposalIndexes(detail);
}

// 勾选集合增/删（返回新数组，去重，保持稳定顺序）。
export function toggleEventIndex(selection, index) {
  const set = new Set(Array.isArray(selection) ? selection : []);
  if (set.has(index)) set.delete(index);
  else set.add(index);
  return [...set];
}

// 确认 UI 要展示的事件列表：
//   - 默认（expanded=false）：只列模型候选对应的事件（A 面）；
//   - expanded=true：列全部事件（B 面），showAll=false 时只列高亮事件、折叠 beat。
// isCandidate 由调用方（页面）注入 event-labels 的 isCandidateEvent，避免本模块依赖它。
export function confirmationEventsToShow(detail, { expanded = false, showAll = false, isCandidate = () => true } = {}) {
  const events = Array.isArray(detail?.events) ? detail.events : [];
  if (!expanded) {
    const wanted = new Set(proposalIndexes(detail));
    return events.filter((e) => wanted.has(e.index));
  }
  return showAll ? events : events.filter((e) => isCandidate(e));
}

// localStorage 存取（浏览器注入真实 localStorage；Node 测试传内存 store）。
// 读写失败都是非致命的（配额/隐私模式等），绝不抛异常。
export function loadList(storage) {
  try {
    return parseObservationList(storage?.getItem?.(LIST_STORAGE_KEY) ?? '');
  } catch {
    return [];
  }
}

export function saveList(storage, list) {
  try {
    storage?.setItem?.(LIST_STORAGE_KEY, serializeObservationList(list));
  } catch {
    /* quota / security errors are non-fatal for the list */
  }
}
