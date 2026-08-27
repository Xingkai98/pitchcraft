// Problem entity + persistence for the P11 problem lifecycle.
//
// Pure Node logic (no API calls): create/update/list/get problems persisted as
// one JSON file per problem under `<tasks-dir>/problems/`. Writes are atomic
// (tmp + rename); corrupt files are skipped on read, never fatal. The service is
// the only writer; this module enforces the domain rules (triage/status enums,
// defer/wontfix require reason, decisions audit trail) and the atomic persistence
// contract. All user-controlled text is scrubbed at persist time as a final
// safety net (redactKey), mirroring the runner's persistTask.

import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { redactKey, redactCredentialText, hasCredentialTerm } from './provider.mjs';

// triage 分类：agent 建议 bug/design/discuss；人工可改 defer（先不搞）/wontfix（废弃）。
export const TRIAGE_VALUES = ['bug', 'design', 'discuss', 'defer', 'wontfix'];
// status 生命周期：open → in_progress → fixed → closed；defer/wontfix 落在 closed。
export const STATUS_VALUES = ['open', 'in_progress', 'fixed', 'closed'];

// Problem id 只允许安全路径段字符，id 永远不能逃逸 problems 目录。
export const PROBLEM_ID_RE = /^[A-Za-z0-9_-]+$/;

const CLOSED_TRIAGE = ['defer', 'wontfix'];

// P13：closed-triage（defer/wontfix）问题不允许状态流转到非 closed，端点据此拒绝
// 下发 fix / mark_fixed。导出供服务层复用（不重定义枚举）。
export { CLOSED_TRIAGE };

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

// --- P12 problem ops（delete / rerun / import）--------------------------------

// 删除 Problem（幂等 404 语义）：文件删除；id 缺失/非法返回 null（服务层映射 404）。
// 返回 true 表示已删除。文件系统删除无回收站——调用方负责确认。
export function deleteProblem(id, { tasksDir } = {}) {
  if (!tasksDir || !PROBLEM_ID_RE.test(id)) return null;
  if (!getProblem(id, { tasksDir })) return null;
  try {
    unlinkSync(problemPath(tasksDir, id));
  } catch {
    return null;
  }
  return true;
}

// 重跑：把 problem.source.task_id 指向新 runId 并追加 decisions 审计记录
// `{ action: 'rerun', by, at, reason, prev_task_id }`（reason 可空；prev_task_id =
// 被替换的旧 task_id，供 import 去重——脱链的旧任务不会被二次导入重建）。旧报告
// 保留到新诊断写回（setProblemReport）。返回更新后的 Problem；id 缺失返回 null。
// 重跑编排（读 bundle / runDiagnosis / 终态写回）在服务层。
export function rerunProblem(id, { task_id, reason = null } = {}, { tasksDir, now = defaultNow, by = 'user', envKey } = {}) {
  if (!tasksDir || !PROBLEM_ID_RE.test(id)) return null;
  const problem = getProblem(id, { tasksDir });
  if (!problem) return null;
  if (typeof task_id !== 'string' || !task_id) {
    throw new ProblemError('BAD_REQUEST', 'task_id is required for rerun');
  }
  const at = now();
  const prevTaskId = problem.source?.task_id ?? null;
  const decision = { action: 'rerun', by, at, reason: reason ?? null };
  if (prevTaskId) decision.prev_task_id = prevTaskId;
  problem.source = { ...(problem.source ?? {}), task_id };
  problem.decisions.push(decision);
  problem.updated_at = at;
  persistProblem(problem, tasksDir, envKey);
  return problem;
}

// 终态诊断报告写回 problem.source.report（重跑完成后旧报告被覆盖）；保留 source
// 链上其它字段（task_id/observation_id）。`runId` 传当前任务的 run_id：若与
// problem.source.task_id 不一致（并发 rerun 已把问题指向更新的任务），丢弃本次
// 写回（no-op，返回未改动的 problem），避免旧诊断覆盖新结果。返回更新后的
// Problem；id 缺失返回 null。
export function setProblemReport(id, report, { tasksDir, now = defaultNow, envKey, runId = null } = {}) {
  if (!tasksDir || !PROBLEM_ID_RE.test(id)) return null;
  const problem = getProblem(id, { tasksDir });
  if (!problem) return null;
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new ProblemError('BAD_REQUEST', 'report must be an object');
  }
  if (runId != null && problem.source?.task_id !== runId) {
    return problem; // 并发保护：run_id 不匹配当前 source → no-op
  }
  const at = now();
  problem.source = { ...(problem.source ?? {}), report };
  problem.updated_at = at;
  persistProblem(problem, tasksDir, envKey);
  return problem;
}

// 从诊断任务构造 createProblem 输入（POST /problems 与 POST /problems/import 共用
// 的 create-from-report 路径，从服务层抽出的公共纯函数）。task 须已归一化
// （status=diagnosed 且带 report）；bundle 为原观察 bundle（可空，读失败传 null）。
// overrides 覆盖 title/description/triage/status/reason。bundle.statement 先
// redactKey 再进描述。
export function problemInputFromDiagnosis({ task_id, task, bundle = null, envKey, overrides = {} } = {}) {
  const report = task?.report;
  const phenomenon =
    typeof report?.phenomenon_summary === 'string' && report.phenomenon_summary.trim()
      ? report.phenomenon_summary.trim()
      : '未命名问题';
  let userStatement = '';
  if (bundle && typeof bundle.statement === 'string' && bundle.statement.trim()) {
    userStatement = redactKey(bundle.statement.trim(), envKey);
  }
  const descLines = [`现象: ${phenomenon}`];
  if (userStatement) descLines.push(`用户描述: ${userStatement}`);
  if (report?.root_cause) descLines.push(`根因: ${report.root_cause}`);
  if (report?.proposed_fix) descLines.push(`建议修复: ${report.proposed_fix}`);
  if (report?.verification) descLines.push(`验证: ${report.verification}`);
  const source = { task_id, report };
  if (bundle && typeof bundle.observation_id === 'string' && bundle.observation_id) {
    source.observation_id = bundle.observation_id;
  }
  return {
    title: overrides.title ?? phenomenon,
    description: overrides.description ?? descLines.join('\n'),
    source,
    triage: overrides.triage ?? report?.triage?.category ?? 'discuss',
    status: overrides.status ?? 'open',
    reason: overrides.reason,
  };
}

// 批量导入历史诊断任务为 Problem。`task_ids` 显式给定（调用方已做 TASK_ID_RE 校验）；
// 缺省 = 扫描 listTaskIds() 中 status=diagnosed 且带 report 的全部任务（未诊断任务
// 不是候选，不计入 failed）。已有关联 Problem 的任务跳过：existing 集合 = 所有
// problem 的 source.task_id ∪ 所有 decisions 里的 task_id/prev_task_id（重跑脱链的旧
// 任务也被跳过，避免二次导入重建重复 Problem）。readTask/readBundle/listTaskIds 由
// 调用方注入（服务层接 runner 持久化文件），本模块保持纯逻辑可测。返回
// `{ created: [ids], skipped: [task_ids], failed: [{task_id, error}] }`。
export function importProblems(
  { tasksDir, task_ids = null, readTask = null, listTaskIds = null, readBundle = null },
  { now = defaultNow, newId = defaultProblemId, by = 'user', envKey, createFn = createProblem } = {}
) {
  if (!tasksDir) throw new ProblemError('BAD_REQUEST', 'tasksDir is required');
  // existing：source.task_id + decisions 里的 task_id/prev_task_id（递归扫 decisions）。
  const existing = new Set();
  for (const p of listProblems({ tasksDir })) {
    if (p?.source?.task_id) existing.add(p.source.task_id);
    for (const d of Array.isArray(p?.decisions) ? p.decisions : []) {
      if (!d || typeof d !== 'object') continue;
      if (typeof d.task_id === 'string' && d.task_id) existing.add(d.task_id);
      if (typeof d.prev_task_id === 'string' && d.prev_task_id) existing.add(d.prev_task_id);
    }
  }
  const created = [];
  const skipped = [];
  const failed = [];
  const seen = new Set();
  const process = (id, task) => {
    if (seen.has(id)) {
      skipped.push(id); // 同一批内重复的 task_ids 计入 skipped，不静默消失
      return;
    }
    seen.add(id);
    if (existing.has(id)) {
      skipped.push(id);
      return;
    }
    if (!task || task.status !== 'diagnosed' || !task.report) {
      failed.push({ task_id: id, error: 'task not diagnosed or missing' });
      return;
    }
    let bundle = null;
    try {
      bundle = readBundle ? readBundle(id) : null;
    } catch {
      bundle = null;
    }
    try {
      const input = problemInputFromDiagnosis({ task_id: id, task, bundle, envKey });
      const problem = createFn(input, { tasksDir, now, newId, by, envKey });
      created.push(problem.id);
      existing.add(id); // 同一批内后续重复（task_ids 重复）不再创建
    } catch (e) {
      failed.push({ task_id: id, error: e?.message ?? String(e) });
    }
  };
  if (Array.isArray(task_ids)) {
    for (const id of task_ids) {
      if (typeof id !== 'string' || !id) {
        failed.push({ task_id: String(id), error: 'invalid task_id' });
        continue;
      }
      let task = null;
      try {
        task = readTask ? readTask(id) : null;
      } catch (e) {
        failed.push({ task_id: id, error: e?.message ?? String(e) });
        continue;
      }
      process(id, task);
    }
  } else {
    const all = listTaskIds ? listTaskIds() : [];
    for (const id of all) {
      let task = null;
      try {
        task = readTask ? readTask(id) : null;
      } catch {
        continue; // 扫描路径下不可读任务直接跳过（不是显式候选）
      }
      if (task && task.status === 'diagnosed' && task.report) process(id, task);
    }
  }
  return { created, skipped, failed };
}

// --- P13 problem actions（verify / fix / merge-close）-------------------------

// 记录一次 verify 动作：decisions 追加 `{ action:'verify', by, at, command,
// exit_code, summary }`；exit 0 且 markFixed 时置 status fixed（追加 status:fixed
// 决策）。closed-triage（defer/wontfix）问题拒绝 markFixed（400，verify 记录不写入
// ——保持原子）。返回更新后的 Problem；id 缺失返回 null。
export function recordVerify(
  id,
  { command, exit_code, summary, markFixed = false } = {},
  { tasksDir, now = defaultNow, by = 'user', envKey } = {}
) {
  if (!tasksDir || !PROBLEM_ID_RE.test(id)) return null;
  const problem = getProblem(id, { tasksDir });
  if (!problem) return null;
  const at = now();
  if (markFixed === true && exit_code === 0) {
    if (CLOSED_TRIAGE.includes(problem.triage)) {
      throw new ProblemError('BAD_REQUEST', `${problem.triage} problems are status=closed (cannot mark fixed)`);
    }
    if (problem.status !== 'fixed') {
      problem.decisions.push({ action: 'status:fixed', from: problem.status, by, at, reason: 'verification passed' });
      problem.status = 'fixed';
    }
  }
  problem.decisions.push({ action: 'verify', by, at, command, exit_code, summary });
  problem.updated_at = at;
  persistProblem(problem, tasksDir, envKey);
  return problem;
}

// 记录一次 fix 成功结果：decisions 追加 fix 记录（含 outcome/worktree/branch/
// summary/changed_files/verification_results）；status → in_progress；fix_ref =
// { worktree, branch, status:'pending_confirm' }（人工确认合入前不动主 checkout）。
// 返回更新后的 Problem；id 缺失返回 null。
export function recordFix(id, fixInfo = {}, { tasksDir, now = defaultNow, by = 'user', envKey } = {}) {
  if (!tasksDir || !PROBLEM_ID_RE.test(id)) return null;
  const problem = getProblem(id, { tasksDir });
  if (!problem) return null;
  if (
    !fixInfo ||
    typeof fixInfo !== 'object' ||
    Array.isArray(fixInfo) ||
    typeof fixInfo.worktree !== 'string' ||
    typeof fixInfo.branch !== 'string'
  ) {
    throw new ProblemError('BAD_REQUEST', 'fix result requires worktree and branch');
  }
  const at = now();
  const decision = {
    action: 'fix',
    by,
    at,
    outcome: 'succeeded',
    worktree: fixInfo.worktree,
    branch: fixInfo.branch,
    summary: typeof fixInfo.summary === 'string' ? fixInfo.summary : '',
    changed_files: Array.isArray(fixInfo.changed_files) ? fixInfo.changed_files : [],
    verification_results: Array.isArray(fixInfo.verification_results) ? fixInfo.verification_results : [],
  };
  if (!CLOSED_TRIAGE.includes(problem.triage) && problem.status !== 'in_progress') {
    problem.decisions.push({ action: 'status:in_progress', from: problem.status, by, at, reason: 'fix dispatched' });
    problem.status = 'in_progress';
  }
  problem.decisions.push(decision);
  problem.fix_ref = { worktree: fixInfo.worktree, branch: fixInfo.branch, status: 'pending_confirm' };
  problem.updated_at = at;
  persistProblem(problem, tasksDir, envKey);
  return problem;
}

// 记录 fix 失败（provider 失败/超时/无效输出/agent 自报 failed）：只追加 decisions
// 失败记录（action:'fix' + outcome:'failed'），problem 状态与字段不变，fix_ref 不建。
// 返回更新后的 Problem；id 缺失返回 null。
export function recordFixFailure(
  id,
  { error, worktree = null, branch = null, summary = null } = {},
  { tasksDir, now = defaultNow, by = 'user', envKey } = {}
) {
  if (!tasksDir || !PROBLEM_ID_RE.test(id)) return null;
  const problem = getProblem(id, { tasksDir });
  if (!problem) return null;
  const at = now();
  const decision = { action: 'fix', by, at, outcome: 'failed', error: String(error ?? '') };
  if (worktree) decision.worktree = worktree;
  if (branch) decision.branch = branch;
  if (summary != null) decision.summary = summary;
  problem.decisions.push(decision);
  problem.updated_at = at;
  persistProblem(problem, tasksDir, envKey);
  return problem;
}

// 记录确认合入：status → closed（closed-triage 已是 closed 不再动）、change_ref 填
// changeRef、fix_ref.status → 'merged'（merged_at 时间戳）、decisions 追加 merge-fix。
// 返回更新后的 Problem；id 缺失返回 null。
export function recordMergeFix(
  id,
  { changeRef, worktree, branch } = {},
  { tasksDir, now = defaultNow, by = 'user', envKey } = {}
) {
  if (!tasksDir || !PROBLEM_ID_RE.test(id)) return null;
  const problem = getProblem(id, { tasksDir });
  if (!problem) return null;
  const at = now();
  const from = problem.status;
  if (!CLOSED_TRIAGE.includes(problem.triage) && problem.status !== 'closed') {
    problem.status = 'closed';
    problem.decisions.push({ action: 'status:closed', from, by, at, reason: 'fix merged' });
  }
  problem.change_ref = typeof changeRef === 'string' && changeRef.trim() ? changeRef.trim() : `fix/${id}`;
  problem.fix_ref = { ...(problem.fix_ref ?? {}), status: 'merged', merged_at: at };
  problem.decisions.push({ action: 'merge-fix', by, at, branch, worktree, change_ref: problem.change_ref });
  problem.updated_at = at;
  persistProblem(problem, tasksDir, envKey);
  return problem;
}

// 记录拒绝修复：fix_ref.status → 'rejected'（rejected_at 时间戳；worktree 保留供
// 检查），decisions 追加 reject-fix（reason 可空）。problem 不闭环。返回更新后的
// Problem；id 缺失返回 null。
export function recordRejectFix(
  id,
  { reason = null, worktree = null, branch = null } = {},
  { tasksDir, now = defaultNow, by = 'user', envKey } = {}
) {
  if (!tasksDir || !PROBLEM_ID_RE.test(id)) return null;
  const problem = getProblem(id, { tasksDir });
  if (!problem) return null;
  const at = now();
  problem.fix_ref = { ...(problem.fix_ref ?? {}), status: 'rejected', rejected_at: at };
  const decision = { action: 'reject-fix', by, at, reason };
  if (worktree) decision.worktree = worktree;
  if (branch) decision.branch = branch;
  problem.decisions.push(decision);
  problem.updated_at = at;
  persistProblem(problem, tasksDir, envKey);
  return problem;
}
