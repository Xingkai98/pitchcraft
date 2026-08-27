// Problem entity + persistence for the P11 problem lifecycle.
//
// Pure Node logic (no API calls): create/update/list/get problems persisted as
// one JSON file per problem under `<tasks-dir>/problems/`. Writes are atomic
// (tmp + rename); corrupt files are skipped on read, never fatal. The service is
// the only writer; this module enforces the domain rules (triage/status enums,
// defer/wontfix require reason, decisions audit trail) and the atomic persistence
// contract. All user-controlled text is scrubbed at persist time as a final
// safety net (redactKey), mirroring the runner's persistTask.

import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { redactKey, redactCredentialText, hasCredentialTerm } from './provider.mjs';

// triage 分类：agent 建议 bug/design/discuss；人工可改 defer（先不搞）/wontfix（废弃）。
export const TRIAGE_VALUES = ['bug', 'design', 'discuss', 'defer', 'wontfix'];
// status 生命周期：open → in_progress → fixed → closed；defer/wontfix 落在 closed。
export const STATUS_VALUES = ['open', 'in_progress', 'fixed', 'closed'];

// Problem id 只允许安全路径段字符，id 永远不能逃逸 problems 目录。
export const PROBLEM_ID_RE = /^[A-Za-z0-9_-]+$/;

const CLOSED_TRIAGE = ['defer', 'wontfix'];

// 带稳定 code 的领域错误；服务层映射到 HTTP 状态（BAD_REQUEST/MISSING_REASON → 400）。
export class ProblemError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'ProblemError';
  }
}

const problemsDirOf = (tasksDir) => join(tasksDir, 'problems');
const problemPath = (tasksDir, id) => join(problemsDirOf(tasksDir), `${id}.json`);

const defaultNow = () => new Date().toISOString();
const isNonEmptyReason = (reason) => typeof reason === 'string' && reason.trim().length > 0;

// 默认 id：prob-<ts>-<n>（进程内自增计数；create 内还有碰撞重试守卫）。
let problemIdSeq = 0;
export function defaultProblemId() {
  problemIdSeq += 1;
  return `prob-${Date.now()}-${problemIdSeq}`;
}

// --- persistence -------------------------------------------------------------

// 深度净化：每个 string 值先 redactKey（存活 key + 凭证形值模式）再
// redactCredentialText（通用 `KEY=value`/`KEY: value`/`"KEY":"value"` 键值对）；
// 对象键名含凭证词（token/secret/apikey/authorization 等）时其值整体替换为
// [REDACTED]（含嵌套对象/数组，与响应路径 redactProblemJSON 行为一致）。
// 覆盖用户可控文本/结构在落盘前可能携带的所有凭证形状。内存中的 problem 不变；
// 只是磁盘副本被净化。
function deepRedactText(value, envKey) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') return redactCredentialText(redactKey(value, envKey));
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => deepRedactText(v, envKey));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (hasCredentialTerm(k)) out[k] = '[REDACTED]';
    else out[k] = deepRedactText(v, envKey);
  }
  return out;
}

function persistProblem(problem, tasksDir, envKey) {
  mkdirSync(problemsDirOf(tasksDir), { recursive: true });
  const safe = deepRedactText(problem, envKey);
  const finalPath = problemPath(tasksDir, safe.id);
  const tmpPath = `${finalPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(safe, null, 2));
  renameSync(tmpPath, finalPath);
}

function allocateId(newId, tasksDir) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = newId();
    if (typeof id !== 'string' || !PROBLEM_ID_RE.test(id)) continue;
    if (!existsSync(problemPath(tasksDir, id))) return id;
  }
  throw new ProblemError('BAD_REQUEST', 'could not allocate a unique problem id');
}

// --- entity construction -----------------------------------------------------

function normalizeSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const out = {};
  if (source.observation_id != null) out.observation_id = String(source.observation_id);
  if (source.task_id != null) out.task_id = String(source.task_id);
  if (source.report != null && typeof source.report === 'object' && !Array.isArray(source.report)) {
    out.report = source.report;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function normalizeDiscussionEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const author = typeof entry.author === 'string' ? entry.author.trim() : '';
  const text = typeof entry.text === 'string' ? entry.text : '';
  if (!author || !text) return null;
  return { author, text, at: typeof entry.at === 'string' ? entry.at : null };
}

// 创建 Problem。`input.source` 携带证据链（observation_id/task_id/report），缺省 =
// 人工创建。defer/wontfix 必须在 input.reason 提供理由，否则拒绝（缺省 status 被
// 强制为 closed）。`now`/`newId` 可注入（测试用确定性时钟/id）。
export function createProblem(input, { tasksDir, now = defaultNow, newId = defaultProblemId, by = 'user', envKey } = {}) {
  if (!tasksDir) throw new ProblemError('BAD_REQUEST', 'tasksDir is required');
  const at = now();
  const source = normalizeSource(input?.source);
  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  if (!title) throw new ProblemError('BAD_REQUEST', 'title is required');
  const triage = input?.triage ?? 'discuss';
  const status = input?.status ?? 'open';
  if (!TRIAGE_VALUES.includes(triage)) {
    throw new ProblemError('BAD_REQUEST', `triage must be one of: ${TRIAGE_VALUES.join(', ')}`);
  }
  if (!STATUS_VALUES.includes(status)) {
    throw new ProblemError('BAD_REQUEST', `status must be one of: ${STATUS_VALUES.join(', ')}`);
  }
  const decisions = [
    { action: 'create', by, at, reason: source ? 'from diagnosis report' : 'manual creation' },
  ];
  if (CLOSED_TRIAGE.includes(triage)) {
    if (!isNonEmptyReason(input?.reason)) {
      throw new ProblemError('MISSING_REASON', `${triage} requires a reason`);
    }
    // 显式传了非 closed status 与 defer/wontfix 冲突 → 拒绝；缺省 status 强制 closed。
    if (input?.status !== undefined && input.status !== 'closed') {
      throw new ProblemError('BAD_REQUEST', `${triage} problems are status=closed`);
    }
    decisions.push({ action: triage, by, at, reason: input.reason });
  }
  const problem = {
    id: allocateId(newId, tasksDir),
    title,
    description: typeof input?.description === 'string' ? input.description : '',
    source,
    triage,
    status: CLOSED_TRIAGE.includes(triage) ? 'closed' : status,
    decisions,
    discussion: Array.isArray(input?.discussion)
      ? input.discussion.map(normalizeDiscussionEntry).filter(Boolean)
      : [],
    github: null,
    change_ref:
      typeof input?.change_ref === 'string' && input.change_ref.trim() ? input.change_ref.trim() : null,
    created_at: at,
    updated_at: at,
  };
  persistProblem(problem, tasksDir, envKey);
  return problem;
}

// --- read --------------------------------------------------------------------

// 读单个 Problem；缺失/损坏/非法 id 一律返回 null（服务层映射 404），不抛异常。
export function getProblem(id, { tasksDir } = {}) {
  if (!tasksDir || !PROBLEM_ID_RE.test(id)) return null;
  try {
    const problem = JSON.parse(readFileSync(problemPath(tasksDir, id), 'utf8'));
    if (
      problem === null ||
      typeof problem !== 'object' ||
      Array.isArray(problem) ||
      problem.id !== id
    ) {
      return null;
    }
    return problem;
  } catch {
    return null;
  }
}

// 列出全部 Problem（跳过损坏文件），可按 triage/status 筛选，最新在前。
export function listProblems({ tasksDir, triage, status } = {}) {
  if (!tasksDir) return [];
  let files;
  try {
    files = readdirSync(problemsDirOf(tasksDir));
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const id = file.slice(0, -'.json'.length);
    if (!PROBLEM_ID_RE.test(id)) continue;
    const problem = getProblem(id, { tasksDir });
    if (!problem) continue;
    if (triage && problem.triage !== triage) continue;
    if (status && problem.status !== status) continue;
    out.push(problem);
  }
  out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return out;
}

// --- mutations ---------------------------------------------------------------

// 应用一次更新（title/description/triage/status/change_ref）。triage/status 变化
// 追加 decisions 审计记录（action/by/at/reason）；defer/wontfix 强制 reason，缺则
// 抛 ProblemError('MISSING_REASON')。defer/wontfix 的问题 status 强制 closed，重开
// （triage 改回 bug/design/discuss）默认 status→open（可被 patch.status 覆盖）。
// 返回更新后的 Problem；id 缺失返回 null。
export function updateProblem(id, patch, { tasksDir, now = defaultNow, by = 'user', envKey } = {}) {
  if (!tasksDir || !PROBLEM_ID_RE.test(id)) return null;
  const problem = getProblem(id, { tasksDir });
  if (!problem) return null;
  patch = patch ?? {};
  const at = now();
  const next = { ...problem, decisions: [...problem.decisions], discussion: [...problem.discussion] };
  let changed = false;

  if (patch.title !== undefined) {
    const title = typeof patch.title === 'string' ? patch.title.trim() : '';
    if (!title) throw new ProblemError('BAD_REQUEST', 'title must be a non-empty string');
    if (title !== next.title) {
      next.title = title;
      changed = true;
    }
  }
  if (patch.description !== undefined) {
    if (typeof patch.description !== 'string') {
      throw new ProblemError('BAD_REQUEST', 'description must be a string');
    }
    if (patch.description !== next.description) {
      next.description = patch.description;
      changed = true;
    }
  }
  if (patch.change_ref !== undefined) {
    const ref =
      typeof patch.change_ref === 'string' && patch.change_ref.trim() ? patch.change_ref.trim() : null;
    if (ref !== next.change_ref) {
      next.change_ref = ref;
      changed = true;
    }
  }

  const reason = patch.reason ?? null;
  if (patch.triage !== undefined && patch.triage !== next.triage) {
    const from = next.triage;
    const to = patch.triage;
    if (!TRIAGE_VALUES.includes(to)) {
      throw new ProblemError('BAD_REQUEST', `triage must be one of: ${TRIAGE_VALUES.join(', ')}`);
    }
    if (CLOSED_TRIAGE.includes(to)) {
      // → defer/wontfix：必须带理由；status 强制 closed。
      if (!isNonEmptyReason(reason)) {
        throw new ProblemError('MISSING_REASON', `${to} requires a reason`);
      }
      if (patch.status !== undefined && patch.status !== 'closed') {
        throw new ProblemError('BAD_REQUEST', `${to} problems are status=closed`);
      }
      next.triage = to;
      next.status = 'closed';
      next.decisions.push({ action: to, from, by, at, reason });
      changed = true;
    } else if (CLOSED_TRIAGE.includes(from)) {
      // 重开：defer/wontfix → bug/design/discuss，status 回到 open（可覆盖）。
      const newStatus = patch.status ?? 'open';
      if (!STATUS_VALUES.includes(newStatus)) {
        throw new ProblemError('BAD_REQUEST', `status must be one of: ${STATUS_VALUES.join(', ')}`);
      }
      next.triage = to;
      next.status = newStatus;
      next.decisions.push({ action: 'reopen', from, by, at, reason: reason ?? 'reopened' });
      changed = true;
    } else {
      // 普通分类流转（bug/design/discuss 之间）：patch 可同时携带 status 变化，
      // 两者都生效并各自追加 decisions 记录（组合 patch 不再静默丢弃 status）。
      if (patch.status !== undefined && !STATUS_VALUES.includes(patch.status)) {
        throw new ProblemError('BAD_REQUEST', `status must be one of: ${STATUS_VALUES.join(', ')}`);
      }
      next.triage = to;
      next.decisions.push({ action: 'triage', from, by, at, reason });
      if (patch.status !== undefined && patch.status !== problem.status) {
        next.status = patch.status;
        next.decisions.push({ action: `status:${patch.status}`, from: problem.status, by, at, reason });
      }
      changed = true;
    }
  } else if (patch.status !== undefined && patch.status !== next.status) {
    if (!STATUS_VALUES.includes(patch.status)) {
      throw new ProblemError('BAD_REQUEST', `status must be one of: ${STATUS_VALUES.join(', ')}`);
    }
    if (CLOSED_TRIAGE.includes(next.triage)) {
      throw new ProblemError('BAD_REQUEST', `${next.triage} problems are status=closed (reopen instead)`);
    }
    next.status = patch.status;
    next.decisions.push({ action: `status:${patch.status}`, from: problem.status, by, at, reason });
    changed = true;
  }

  if (changed) {
    next.updated_at = at;
    persistProblem(next, tasksDir, envKey);
  }
  return next;
}

// 讨论区留言：追加 { author, text, at }。author/text 必填；凭证净化由服务层在
// 写入前执行，持久化时再有 final safety net。返回更新后的 Problem；id 缺失返回 null。
export function addDiscussion(id, { author, text } = {}, { tasksDir, now = defaultNow, envKey } = {}) {
  if (!tasksDir || !PROBLEM_ID_RE.test(id)) return null;
  const problem = getProblem(id, { tasksDir });
  if (!problem) return null;
  const a = typeof author === 'string' ? author.trim() : '';
  const t = typeof text === 'string' ? text : '';
  if (!a || !t) throw new ProblemError('BAD_REQUEST', 'author and text are required for a discussion message');
  const at = now();
  problem.discussion.push({ author: a, text: t, at });
  problem.updated_at = at;
  persistProblem(problem, tasksDir, envKey);
  return problem;
}

// 回写 GitHub issue 引用（issue_number/url/synced_at）。返回更新后的 Problem；
// id 缺失返回 null。
export function setGithubRef(id, github, { tasksDir, now = defaultNow, envKey } = {}) {
  if (!tasksDir || !PROBLEM_ID_RE.test(id)) return null;
  const problem = getProblem(id, { tasksDir });
  if (!problem) return null;
  if (!github || typeof github !== 'object' || Array.isArray(github)) {
    throw new ProblemError('BAD_REQUEST', 'github ref must be an object');
  }
  const at = now();
  problem.github = {
    issue_number: github.issue_number,
    url: github.url,
    synced_at: github.synced_at ?? at,
  };
  problem.updated_at = at;
  persistProblem(problem, tasksDir, envKey);
  return problem;
}
