// 问题管理视图（P11 problem lifecycle, task 4.1 viewer 切片）。
//
// 纯函数 + 可注入 fetch 的 API 客户端；DOM 由 app.js 接线。不含 DOM、不做真实网络
// 请求（测试注入 fake fetch）、不含凭证。所有外部文本渲染前经 redactText 抹除，
// defer/wontfix 前端必填 reason 校验（服务端仍权威）。问题实体形状与 tools/problems.mjs
// 对齐（id/title/description/source/triage/status/decisions/discussion/github/change_ref）。

import { redactText, formatReportSummary } from './audit-report.js';
import { isTerminalStatus, isKnownStatus } from './observation-list.js';

export const PROBLEM_TRIAGE_VALUES = ['bug', 'design', 'discuss', 'defer', 'wontfix'];
export const PROBLEM_STATUS_VALUES = ['open', 'in_progress', 'fixed', 'closed'];

// triage 徽章配色：bug 红 / design 蓝 / discuss 黄 / defer 灰 / wontfix 黑灰。
const TRIAGE_BADGE_CLASS = {
  bug: 'problem-triage-bug',
  design: 'problem-triage-design',
  discuss: 'problem-triage-discuss',
  defer: 'problem-triage-defer',
  wontfix: 'problem-triage-wontfix',
};

export function triageBadgeClass(triage) {
  return TRIAGE_BADGE_CLASS[triage] ?? TRIAGE_BADGE_CLASS.discuss;
}

// 来源标签：带 task_id → 'task'；仅 observation_id → 'observation'；无 source → '人工'。
export function problemSourceLabel(problem) {
  const s = problem?.source;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return '人工';
  if (s.task_id != null) return 'task';
  if (s.observation_id != null) return 'observation';
  return '人工';
}

// ISO 时间 → 本地展示（UTC 固定格式，测试确定性）；缺失/非法 → '—'。
export function formatProblemTime(iso) {
  if (typeof iso !== 'string' || !iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// 标题摘要：单行截断 + 空值兜底。
export function summarizeProblemTitle(title, maxLen = 60) {
  const s = String(title ?? '').trim();
  if (!s) return '(无标题)';
  return s.length <= maxLen ? s : `${s.slice(0, maxLen)}…`;
}

// 列表筛选：triage/status 可选过滤（undefined = 不过滤）。
export function filterProblems(problems, { triage, status } = {}) {
  return (problems ?? []).filter((p) => {
    if (triage && p?.triage !== triage) return false;
    if (status && p?.status !== status) return false;
    return true;
  });
}

// 归一化单条 API problem（字段缺失/类型非法兜底，供渲染）。非对象 → null。
export function normalizeProblem(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    title: typeof raw.title === 'string' ? raw.title : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    source: raw.source && typeof raw.source === 'object' && !Array.isArray(raw.source) ? raw.source : null,
    triage: PROBLEM_TRIAGE_VALUES.includes(raw.triage) ? raw.triage : 'discuss',
    status: PROBLEM_STATUS_VALUES.includes(raw.status) ? raw.status : 'open',
    decisions: Array.isArray(raw.decisions) ? raw.decisions : [],
    discussion: Array.isArray(raw.discussion) ? raw.discussion : [],
    github: raw.github && typeof raw.github === 'object' && !Array.isArray(raw.github) ? raw.github : null,
    change_ref: typeof raw.change_ref === 'string' && raw.change_ref ? raw.change_ref : null,
    fix_ref: raw.fix_ref && typeof raw.fix_ref === 'object' && !Array.isArray(raw.fix_ref) ? raw.fix_ref : null,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : '',
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : '',
  };
}

// 列表归一化：映射 + 丢弃非法条目。
export function normalizeProblems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeProblem).filter(Boolean);
}

// 动作 → PATCH body 构造。空 reason 不携带（服务端不要求普通流转的 reason）。
export function buildProblemPatch({ title, description, triage, status, reason, change_ref } = {}) {
  const body = {};
  if (title !== undefined) body.title = title;
  if (description !== undefined) body.description = description;
  if (triage !== undefined) body.triage = triage;
  if (status !== undefined) body.status = status;
  if (change_ref !== undefined) body.change_ref = change_ref;
  if (reason !== undefined && typeof reason === 'string' && reason.trim() !== '') body.reason = reason.trim();
  return body;
}

// defer/wontfix 前端必填 reason 校验（服务端仍权威）。
export function validateProblemAction({ triage, reason } = {}) {
  if ((triage === 'defer' || triage === 'wontfix') && (!reason || !String(reason).trim())) {
    return { ok: false, error: `${triage} 必须填写理由` };
  }
  return { ok: true };
}

// 讨论留言 → 渲染数据（author/text 抹除凭证形文本，at 格式化）。
export function discussionToRender(discussion) {
  return (discussion ?? []).map((d) => ({
    author: typeof d?.author === 'string' && d.author.trim() ? redactText(d.author) : '匿名',
    text: redactText(d?.text ?? ''),
    at: formatProblemTime(d?.at),
  }));
}

// 单条决策 → 展示行（多行文本）。verify/fix/merge-fix 决策携带的结构化字段
// （command/exit_code/summary/changed_files/verification_results/outcome/worktree/
// branch/change_ref）全部渲染前 redactText；summary 展示时截断到 displayMax。
export function formatDecisionText(d, displayMax = 400) {
  const at = d?.at ?? '';
  const action = d?.action ?? '';
  const by = d?.by ?? '';
  const reason = d?.reason ?? '';
  const parts = [`${at}  ${action}${reason ? ` — ${reason}` : ''} (${by})`];
  const clip = (t) => {
    const s = String(t ?? '');
    return s.length <= displayMax ? s : `${s.slice(0, displayMax)}…`;
  };
  if (action === 'verify') {
    if (d.command) parts.push(`  命令: ${d.command}`);
    parts.push(`  退出码: ${d.exit_code ?? '—'}`);
    if (d.summary) parts.push(`  输出摘要: ${clip(d.summary)}`);
  }
  if (action === 'fix') {
    parts.push(`  结果: ${d.outcome ?? 'succeeded'}`);
    if (d.branch) parts.push(`  分支: ${d.branch}`);
    if (d.worktree) parts.push(`  worktree: ${d.worktree}`);
    if (d.summary) parts.push(`  摘要: ${clip(d.summary)}`);
    if (d.changed_files && d.changed_files.length > 0) {
      parts.push(`  改动文件: ${d.changed_files.join(', ')}`);
    }
    if (d.verification_results && d.verification_results.length > 0) {
      parts.push('  验证结果:');
      for (const v of d.verification_results) {
        const vs = v?.summary ? `：${clip(v.summary)}` : '';
        parts.push(`    ${v?.command ?? ''} → exit ${v?.exit_code ?? '—'}${vs}`);
      }
    }
    if (d.error) parts.push(`  失败: ${redactText(d.error)}`);
  }
  if (action === 'merge-fix' && d.change_ref) parts.push(`  change_ref: ${d.change_ref}`);
  if (action === 'reject-fix' && d.worktree) parts.push(`  worktree: ${d.worktree}（保留）`);
  return parts.join('\n');
}

// fix_ref → 渲染数据（worktree/branch/status + 合入/拒绝时间），文本 redactText。
export function fixRefToRender(fixRef) {
  if (!fixRef || typeof fixRef !== 'object' || Array.isArray(fixRef)) return null;
  return {
    worktree: redactText(fixRef.worktree ?? ''),
    branch: redactText(fixRef.branch ?? ''),
    status: typeof fixRef.status === 'string' ? fixRef.status : '',
    merged_at: formatProblemTime(fixRef.merged_at),
    rejected_at: formatProblemTime(fixRef.rejected_at),
  };
}

// 详情 → 渲染数据：完整报告文本（复用 formatReportSummary）+ 决策轨迹 + 讨论区 +
// fix_ref，全部文本渲染前 redactText。
export function problemDetailToRender(problem) {
  const p = problem ?? {};
  const report = p.source?.report ?? null;
  return {
    id: p.id ?? '',
    title: redactText(p.title ?? ''),
    description: redactText(p.description ?? ''),
    triage: p.triage ?? 'discuss',
    status: p.status ?? 'open',
    source: problemSourceLabel(p),
    reportText: report && typeof report === 'object' ? formatReportSummary(report) : '',
    github: p.github ?? null,
    change_ref: typeof p.change_ref === 'string' && p.change_ref ? redactText(p.change_ref) : null,
    fix_ref: fixRefToRender(p.fix_ref),
    decisions: (p.decisions ?? []).map((d) => ({
      action: redactText(d?.action ?? ''),
      by: redactText(d?.by ?? ''),
      at: formatProblemTime(d?.at),
      reason: redactText(d?.reason ?? ''),
      command: typeof d?.command === 'string' ? redactText(d.command) : null,
      exit_code: typeof d?.exit_code === 'number' ? d.exit_code : null,
      summary: typeof d?.summary === 'string' ? redactText(d.summary) : '',
      outcome: typeof d?.outcome === 'string' ? d.outcome : null,
      worktree: typeof d?.worktree === 'string' ? redactText(d.worktree) : null,
      branch: typeof d?.branch === 'string' ? redactText(d.branch) : null,
      error: typeof d?.error === 'string' ? redactText(d.error) : '',
      change_ref: typeof d?.change_ref === 'string' ? redactText(d.change_ref) : null,
      changed_files: Array.isArray(d?.changed_files)
        ? d.changed_files.map((f) => redactText(String(f)))
        : [],
      verification_results: Array.isArray(d?.verification_results)
        ? d.verification_results.map((v) => ({
            command: redactText(v?.command ?? ''),
            exit_code: typeof v?.exit_code === 'number' ? v.exit_code : null,
            summary: redactText(v?.summary ?? ''),
          }))
        : [],
    })),
    discussion: discussionToRender(p.discussion),
  };
}

// --- 服务端 API 客户端（可注入 fetch，测试用 fake） -----------------------------
//
// 所有端点走本地诊断服务的 /problems 路径；响应统一归一为 { ok, status, data }，
// 网络异常直接向上抛（由调用方显示「服务不可达」）。browser 永不接触凭证。

export function createProblemApi({ endpoint, fetchImpl = fetch } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  async function request(method, path, body) {
    const res = await fetchImpl(`${endpoint}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  }
  return {
    list: (filters = {}) => {
      const qs = new URLSearchParams();
      if (filters.triage) qs.set('triage', filters.triage);
      if (filters.status) qs.set('status', filters.status);
      const q = qs.toString();
      return request('GET', `/problems${q ? `?${q}` : ''}`);
    },
    create: (body) => request('POST', '/problems', body),
    get: (id) => request('GET', `/problems/${encodeURIComponent(id)}`),
    patch: (id, body) => request('PATCH', `/problems/${encodeURIComponent(id)}`, body),
    discuss: (id, body) => request('POST', `/problems/${encodeURIComponent(id)}/discussion`, body),
    github: (id, body = {}) => request('POST', `/problems/${encodeURIComponent(id)}/github`, body),
    rerun: (id, body = {}) => request('POST', `/problems/${encodeURIComponent(id)}/rerun`, body),
    remove: (id) => request('DELETE', `/problems/${encodeURIComponent(id)}`),
    importProblems: (body = {}) => request('POST', '/problems/import', body),
    verify: (id, body = {}) => request('POST', `/problems/${encodeURIComponent(id)}/verify`, body),
    fix: (id, body = {}) => request('POST', `/problems/${encodeURIComponent(id)}/fix`, body),
    mergeFix: (id, body = {}) => request('POST', `/problems/${encodeURIComponent(id)}/merge-fix`, body),
  };
}

// 导入结果 → 一条人类可读摘要（created/skipped/failed 计数 + 失败明细）。
// failed 的 error/task_id 渲染前 redactText 抹除凭证形片段。
export function summarizeImportResult(result = {}) {
  const created = Array.isArray(result?.created) ? result.created : [];
  const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
  const failed = Array.isArray(result?.failed) ? result.failed : [];
  const parts = [`导入完成：新建 ${created.length}，跳过 ${skipped.length}`];
  if (failed.length > 0) {
    const msgs = failed
      .map((f) => `${redactText(f?.task_id ?? '')}: ${redactText(f?.error ?? '')}`)
      .join('；');
    parts.push(`失败 ${failed.length}（${msgs}）`);
  }
  return parts.join('，');
}

// 重跑轮询终态判定（纯函数，可测）：diagnosed → 成功；其它终态（failed /
// insufficient_evidence / provider_unavailable）→ 失败消息，含 status/failure_kind 与
// 错误摘要（全部 redactText 抹除凭证形片段）。data 为 GET /tasks/:id 的白名单响应。
export function rerunTerminalState(status, data = {}) {
  if (status === 'diagnosed') return { ok: true, status };
  const errors = Array.isArray(data?.errors) && data.errors.length > 0
    ? data.errors.map((e) => redactText(String(e))).join('；')
    : '';
  const kind =
    typeof data?.failure_kind === 'string' && data.failure_kind ? data.failure_kind : status;
  const detail = errors ? `（${errors}）` : '';
  return { ok: false, status, error: `重跑结束：${redactText(kind)}${detail}` };
}

// 轮询 GET /tasks/:id 直到终态。diagnosed → {ok:true}；其它终态 → {ok:false,error}
// （rerunTerminalState，页面提示失败、不刷新详情为成功）。网络/超时/非 JSON → 失败。
// opts 可注入 endpoint/间隔/上限/状态判定/fetch（测试用 fake，参照 problemApi 模式）。
export async function pollRerunTask(taskId, opts = {}) {
  const {
    endpoint = '',
    fetchImpl = fetch,
    pollMs = 2000,
    maxMs = 15 * 60 * 1000,
    isTerminal = isTerminalStatus,
    isKnown = isKnownStatus,
  } = opts;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    let res;
    try {
      res = await fetchImpl(`${endpoint}/tasks/${encodeURIComponent(taskId)}`);
    } catch (err) {
      return { ok: false, error: `轮询服务不可达（${redactText(String(err.message))}）` };
    }
    if (!res.ok) {
      return { ok: false, error: `轮询任务 HTTP ${res.status}` };
    }
    let data;
    try {
      data = await res.json();
    } catch {
      return { ok: false, error: '轮询响应不是 JSON' };
    }
    const state = isKnown(data?.status) ? data.status : 'failed';
    if (isTerminal(state)) return rerunTerminalState(state, data);
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { ok: false, error: '重跑等待超时' };
}
