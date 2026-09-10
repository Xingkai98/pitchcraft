// 观察列表状态模型（P10 Slice 3 viewer 切片）。
// 纯函数：条目创建、列表增改、状态判定、match_time 格式化、localStorage 序列化。
// 不含 DOM、不做网络请求、不含凭证。浏览器与 Node 双端可测。
//
// 列表条目持久化的是「元数据 + task_id」：诊断反馈（findings/report）是轮询
// 派生的渲染状态，只留在内存（findingsDetail），刷新后从服务端重新拉取。

export const LIST_STORAGE_KEY = 'p10.observation.list.v1';

// 8 状态词表（对应 match-observation spec / runner TASK_STATUSES）。
export const OBSERVATION_STATUSES = [
  'captured', 'auditing', 'audit_ready', 'diagnosing', 'diagnosed',
  'insufficient_evidence', 'provider_unavailable', 'failed',
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
