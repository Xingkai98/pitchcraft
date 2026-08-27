// viewer/problem-view.js 纯函数 + API 客户端单测（P11 problem lifecycle, task 4.1/4.3）。
// 无 DOM、无网络（fake fetch）；所有渲染文本先 redact；不含凭证。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROBLEM_TRIAGE_VALUES,
  PROBLEM_STATUS_VALUES,
  triageBadgeClass,
  problemSourceLabel,
  formatProblemTime,
  summarizeProblemTitle,
  filterProblems,
  normalizeProblem,
  normalizeProblems,
  buildProblemPatch,
  validateProblemAction,
  discussionToRender,
  problemDetailToRender,
  createProblemApi,
  summarizeImportResult,
  rerunTerminalState,
  pollRerunTask,
} from './problem-view.js';

const FAKE_KEY = 'sk-ant-fake-secret-value-0001';

const sampleProblem = (over = {}) => ({
  id: 'prob-1',
  title: 'pass out of play with no defender pressure',
  description: 'User saw defenders never press the ball carrier.',
  source: {
    task_id: 'task-1',
    observation_id: 'obs-1',
    report: {
      status: 'diagnosed',
      phenomenon_summary: 'pass out of play with no defender pressure',
      layer: 'engine',
      hypotheses: ['pressure distance threshold too high'],
      root_cause: 'engine/src/lib.rs: unforced out pressure gate misconfigured',
      proposed_fix: 'lower unforced_out.pressure_distance',
      verification: 'node tools/runner-cli.mjs --bundle obs.json',
      confidence: 0.8,
      triage: { category: 'bug', rationale: 'clear root cause', confidence: 0.9 },
    },
  },
  triage: 'bug',
  status: 'open',
  decisions: [{ action: 'create', by: 'user', at: '2026-08-27T12:00:00.000Z', reason: 'from diagnosis report' }],
  discussion: [{ author: 'user', text: 'reproducible every time', at: '2026-08-27T12:05:00.000Z' }],
  github: { issue_number: 42, url: 'https://github.com/owner/repo/issues/42', synced_at: '2026-08-27T13:00:00.000Z' },
  change_ref: 'p11-fix',
  created_at: '2026-08-27T12:00:00.000Z',
  updated_at: '2026-08-27T13:00:00.000Z',
  ...over,
});

// fake fetch：记录 (url, opts)，由 handler 决定响应。
const jsonResponse = (status, data) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(data),
  json: async () => data,
});

const fakeFetch = (handler) => {
  const fn = async (url, opts) => handler(url, opts);
  fn.calls = [];
  const wrapped = (url, opts) => {
    fn.calls.push({ url, opts });
    return fn(url, opts);
  };
  wrapped.calls = fn.calls;
  return wrapped;
};

// --- 枚举 / 徽章 / 来源 / 时间 ---

test('PROBLEM_TRIAGE_VALUES / PROBLEM_STATUS_VALUES match the spec enums', () => {
  assert.deepEqual(PROBLEM_TRIAGE_VALUES, ['bug', 'design', 'discuss', 'defer', 'wontfix']);
  assert.deepEqual(PROBLEM_STATUS_VALUES, ['open', 'in_progress', 'fixed', 'closed']);
});

test('triageBadgeClass maps each triage to its badge style, fallback discuss', () => {
  assert.equal(triageBadgeClass('bug'), 'problem-triage-bug');
  assert.equal(triageBadgeClass('design'), 'problem-triage-design');
  assert.equal(triageBadgeClass('discuss'), 'problem-triage-discuss');
  assert.equal(triageBadgeClass('defer'), 'problem-triage-defer');
  assert.equal(triageBadgeClass('wontfix'), 'problem-triage-wontfix');
  assert.equal(triageBadgeClass('nope'), 'problem-triage-discuss');
});

test('problemSourceLabel: task / observation / manual', () => {
  assert.equal(problemSourceLabel({ source: { task_id: 't1', observation_id: 'o1' } }), 'task');
  assert.equal(problemSourceLabel({ source: { observation_id: 'o1' } }), 'observation');
  assert.equal(problemSourceLabel({ source: null }), '人工');
  assert.equal(problemSourceLabel({}), '人工');
  assert.equal(problemSourceLabel(null), '人工');
});

test('formatProblemTime renders deterministic UTC and falls back for bad input', () => {
  assert.equal(formatProblemTime('2026-08-27T12:34:56.000Z'), '2026-08-27 12:34');
  assert.equal(formatProblemTime(''), '—');
  assert.equal(formatProblemTime(null), '—');
  assert.equal(formatProblemTime('not-a-date'), '—');
});

test('summarizeProblemTitle truncates and falls back for empty input', () => {
  assert.equal(summarizeProblemTitle(''), '(无标题)');
  assert.equal(summarizeProblemTitle(null), '(无标题)');
  const long = 'x'.repeat(80);
  const s = summarizeProblemTitle(long, 60);
  assert.equal(s.length, 61); // 60 + ellipsis
  assert.ok(s.endsWith('…'));
  assert.equal(summarizeProblemTitle('short title', 60), 'short title');
});

// --- 筛选 / 归一化 ---

test('filterProblems filters by triage and status independently and combined', () => {
  const problems = [
    sampleProblem({ id: 'p1', triage: 'bug', status: 'open' }),
    sampleProblem({ id: 'p2', triage: 'design', status: 'open' }),
    sampleProblem({ id: 'p3', triage: 'discuss', status: 'closed' }),
  ];
  assert.equal(filterProblems(problems, { triage: 'bug' }).length, 1);
  assert.equal(filterProblems(problems, { status: 'open' }).length, 2);
  assert.equal(filterProblems(problems, { triage: 'discuss', status: 'closed' }).length, 1);
  assert.equal(filterProblems(problems, {}).length, 3);
  assert.equal(filterProblems(problems, { triage: 'wontfix' }).length, 0);
  assert.deepEqual(filterProblems(null, {}), []);
});

test('normalizeProblem fills defaults and tolerates malformed input', () => {
  const p = normalizeProblem(sampleProblem());
  assert.equal(p.triage, 'bug');
  assert.equal(p.status, 'open');
  assert.equal(p.source.task_id, 'task-1');
  assert.equal(p.github.issue_number, 42);
  assert.equal(p.change_ref, 'p11-fix');
  // 非法 triage/status 兜底，缺失字段给安全默认。
  const bad = normalizeProblem({ id: 'x', triage: 'nope', status: 'nope' });
  assert.equal(bad.triage, 'discuss');
  assert.equal(bad.status, 'open');
  assert.equal(bad.title, '');
  assert.equal(bad.discussion.length, 0);
  assert.equal(bad.decisions.length, 0);
  assert.equal(bad.github, null);
  assert.equal(bad.change_ref, null);
  // 非对象 / 数组 → null。
  assert.equal(normalizeProblem(null), null);
  assert.equal(normalizeProblem([1]), null);
});

test('normalizeProblems maps an array and drops invalid entries', () => {
  const raw = [sampleProblem({ id: 'p1' }), null, 'x', { id: 'p2', triage: 'design' }];
  const list = normalizeProblems(raw);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'p1');
  assert.equal(list[1].triage, 'design');
  assert.deepEqual(normalizeProblems('nope'), []);
});

// --- 动作构造 / 校验 ---

test('buildProblemPatch includes only provided fields and non-empty reason', () => {
  assert.deepEqual(buildProblemPatch({ title: 'new' }), { title: 'new' });
  assert.deepEqual(buildProblemPatch({ triage: 'defer', reason: 'later' }), { triage: 'defer', reason: 'later' });
  assert.deepEqual(buildProblemPatch({ status: 'fixed' }), { status: 'fixed' });
  assert.deepEqual(buildProblemPatch({ change_ref: 'p12-x' }), { change_ref: 'p12-x' });
  // 空 reason 不携带（服务端不要求普通流转的 reason）。
  assert.deepEqual(buildProblemPatch({ triage: 'discuss', reason: '  ' }), { triage: 'discuss' });
  assert.deepEqual(buildProblemPatch({}), {});
});

test('validateProblemAction requires a reason for defer/wontfix only', () => {
  assert.deepEqual(validateProblemAction({ triage: 'defer', reason: '' }), {
    ok: false,
    error: 'defer 必须填写理由',
  });
  assert.deepEqual(validateProblemAction({ triage: 'wontfix', reason: '  ' }), {
    ok: false,
    error: 'wontfix 必须填写理由',
  });
  assert.deepEqual(validateProblemAction({ triage: 'defer', reason: 'later' }), { ok: true });
  assert.deepEqual(validateProblemAction({ triage: 'bug' }), { ok: true });
  assert.deepEqual(validateProblemAction({ status: 'fixed' }), { ok: true });
});

// --- 渲染数据（redaction）---

test('discussionToRender redacts author/text and formats time', () => {
  const list = discussionToRender([
    { author: 'user', text: `please see ${FAKE_KEY} attached`, at: '2026-08-27T12:05:00.000Z' },
    { author: '', text: 'x', at: 'bad' },
  ]);
  assert.equal(list.length, 2);
  assert.match(list[0].text, /\[REDACTED\]/);
  assert.doesNotMatch(list[0].text, new RegExp(FAKE_KEY));
  assert.equal(list[0].at, '2026-08-27 12:05');
  assert.equal(list[1].author, '匿名');
  assert.equal(list[1].at, '—');
  assert.deepEqual(discussionToRender(null), []);
});

test('problemDetailToRender builds redacted report/decision/discussion render data', () => {
  const p = sampleProblem();
  const r = problemDetailToRender(p);
  assert.equal(r.id, 'prob-1');
  assert.equal(r.triage, 'bug');
  assert.equal(r.status, 'open');
  assert.equal(r.source, 'task');
  assert.equal(r.change_ref, 'p11-fix');
  assert.equal(r.github.issue_number, 42);
  assert.match(r.reportText, /根因:/);
  assert.match(r.reportText, /分类: bug/);
  assert.equal(r.decisions.length, 1);
  assert.equal(r.decisions[0].action, 'create');
  assert.equal(r.decisions[0].at, '2026-08-27 12:00');
  assert.equal(r.discussion.length, 1);
  // 凭证形文本在渲染数据中被抹除。
  const leaky = problemDetailToRender(
    sampleProblem({ title: `key ${FAKE_KEY}`, description: 'd', discussion: [{ author: 'a', text: FAKE_KEY, at: 't' }] })
  );
  assert.doesNotMatch(leaky.title, new RegExp(FAKE_KEY));
  assert.match(leaky.title, /\[REDACTED\]/);
  assert.match(leaky.discussion[0].text, /\[REDACTED\]/);
});

// --- API 客户端（fake fetch）---

test('problemApi.list issues GET /problems with filter query and parses data', async () => {
  const fetchImpl = fakeFetch(async (url, opts) => {
    assert.equal(opts.method, 'GET');
    assert.equal(url, 'http://svc:8787/problems?triage=bug&status=open');
    return jsonResponse(200, { problems: [sampleProblem()] });
  });
  const api = createProblemApi({ endpoint: 'http://svc:8787', fetchImpl });
  const res = await api.list({ triage: 'bug', status: 'open' });
  assert.equal(res.ok, true);
  assert.equal(res.data.problems.length, 1);
  // 无筛选时不带 query。
  const fetch2 = fakeFetch(async (url) => {
    assert.equal(url, 'http://svc:8787/problems');
    return jsonResponse(200, { problems: [] });
  });
  await createProblemApi({ endpoint: 'http://svc:8787', fetchImpl: fetch2 }).list();
});

test('problemApi.create POSTs /problems with the JSON body', async () => {
  const fetchImpl = fakeFetch(async (url, opts) => {
    assert.equal(url, 'http://svc:8787/problems');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(opts.body), { task_id: 'task-1' });
    return jsonResponse(201, sampleProblem());
  });
  const api = createProblemApi({ endpoint: 'http://svc:8787', fetchImpl });
  const res = await api.create({ task_id: 'task-1' });
  assert.equal(res.status, 201);
  assert.equal(res.data.id, 'prob-1');
});

test('problemApi.patch/discuss/github hit the per-problem endpoints', async () => {
  const calls = [];
  const fetchImpl = fakeFetch(async (url, opts) => {
    calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
    return jsonResponse(200, sampleProblem());
  });
  const api = createProblemApi({ endpoint: 'http://svc:8787', fetchImpl });
  await api.patch('prob-1', { status: 'fixed' });
  await api.discuss('prob-1', { author: 'user', text: 'hi' });
  await api.github('prob-1', { dryRun: true });
  await api.get('prob-1');
  assert.deepEqual(calls, [
    { url: 'http://svc:8787/problems/prob-1', method: 'PATCH', body: { status: 'fixed' } },
    { url: 'http://svc:8787/problems/prob-1/discussion', method: 'POST', body: { author: 'user', text: 'hi' } },
    { url: 'http://svc:8787/problems/prob-1/github', method: 'POST', body: { dryRun: true } },
    { url: 'http://svc:8787/problems/prob-1', method: 'GET', body: null },
  ]);
});

test('problemApi surfaces non-ok responses as { ok:false, status, data }', async () => {
  const fetchImpl = fakeFetch(async () => jsonResponse(400, { error: 'wontfix requires a reason' }));
  const api = createProblemApi({ endpoint: 'http://svc:8787', fetchImpl });
  const res = await api.patch('prob-1', { triage: 'wontfix' });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.equal(res.data.error, 'wontfix requires a reason');
});

test('problemApi propagates fetch rejections (service unreachable)', async () => {
  const fetchImpl = fakeFetch(async () => {
    throw new Error('network down');
  });
  const api = createProblemApi({ endpoint: 'http://svc:8787', fetchImpl });
  await assert.rejects(() => api.list(), /network down/);
});

// --- P12 problem ops（rerun / delete / import）---

test('problemApi.rerun/remove/importProblems hit the P12 endpoints', async () => {
  const calls = [];
  const fetchImpl = fakeFetch(async (url, opts) => {
    calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
    return jsonResponse(202, { task_id: 'run-2' });
  });
  const api = createProblemApi({ endpoint: 'http://svc:8787', fetchImpl });
  await api.rerun('prob-1', { reason: 'engine changed' });
  await api.remove('prob-1');
  await api.importProblems({ task_ids: ['t-1'] });
  assert.deepEqual(calls, [
    { url: 'http://svc:8787/problems/prob-1/rerun', method: 'POST', body: { reason: 'engine changed' } },
    { url: 'http://svc:8787/problems/prob-1', method: 'DELETE', body: null },
    { url: 'http://svc:8787/problems/import', method: 'POST', body: { task_ids: ['t-1'] } },
  ]);
});

test('problemApi.rerun without a reason body sends an empty object', async () => {
  const fetchImpl = fakeFetch(async (url, opts) => {
    assert.equal(url, 'http://svc:8787/problems/prob-1/rerun');
    assert.deepEqual(JSON.parse(opts.body), {});
    return jsonResponse(202, { task_id: 'run-2' });
  });
  const api = createProblemApi({ endpoint: 'http://svc:8787', fetchImpl });
  const res = await api.rerun('prob-1');
  assert.equal(res.status, 202);
  assert.equal(res.data.task_id, 'run-2');
});

test('summarizeImportResult builds a redacted summary from created/skipped/failed', () => {
  const s = summarizeImportResult({
    created: ['prob-1', 'prob-2'],
    skipped: ['t-1'],
    failed: [{ task_id: 't-x', error: `see ${FAKE_KEY} attached` }],
  });
  assert.match(s, /新建 2/);
  assert.match(s, /跳过 1/);
  assert.match(s, /失败 1/);
  assert.doesNotMatch(s, new RegExp(FAKE_KEY));
  assert.match(s, /\[REDACTED\]/);
  // 空/非法输入安全兜底（失败 0 时不带「失败」后缀）。
  assert.match(summarizeImportResult(null), /新建 0/);
  assert.match(summarizeImportResult({}), /新建 0/);
  assert.equal(summarizeImportResult({ failed: 'not-an-array' }), '导入完成：新建 0，跳过 0');
});

// --- 重跑轮询终态判定 / 轮询（P12 review 修复）---

test('rerunTerminalState: diagnosed is success; other terminals are failures', () => {
  assert.deepEqual(rerunTerminalState('diagnosed', { errors: [] }), { ok: true, status: 'diagnosed' });
  const failed = rerunTerminalState('failed', {
    failure_kind: 'provider_error',
    errors: [`see ${FAKE_KEY} attached`],
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /重跑结束/);
  assert.match(failed.error, /provider_error/);
  assert.match(failed.error, /\[REDACTED\]/);
  assert.doesNotMatch(failed.error, new RegExp(FAKE_KEY));
  // 无 failure_kind → 用 status；无 errors → 无详情括号。
  const ie = rerunTerminalState('insufficient_evidence', {});
  assert.equal(ie.ok, false);
  assert.match(ie.error, /insufficient_evidence/);
  assert.doesNotMatch(ie.error, /（/);
  const pa = rerunTerminalState('provider_unavailable', { failure_kind: null, errors: [] });
  assert.equal(pa.ok, false);
  assert.match(pa.error, /provider_unavailable/);
});

test('pollRerunTask returns ok for a diagnosed terminal and failure for other terminals', async () => {
  // fake fetch 依次返回 auditing → failed（带错误摘要）。
  const states = [
    { status: 'auditing', errors: [] },
    { status: 'failed', failure_kind: 'provider_error', errors: [`see ${FAKE_KEY}`] },
  ];
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    assert.equal(url, 'http://svc:8787/tasks/run-2');
    return jsonResponse(200, states[Math.min(calls - 1, states.length - 1)]);
  };
  const failed = await pollRerunTask('run-2', {
    endpoint: 'http://svc:8787',
    fetchImpl,
    pollMs: 1,
    maxMs: 1000,
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /重跑结束/);
  assert.doesNotMatch(failed.error, new RegExp(FAKE_KEY));
  assert.match(failed.error, /\[REDACTED\]/);

  // diagnosed 终态 → ok。
  const fetchOk = fakeFetch(async () => jsonResponse(200, { status: 'diagnosed', errors: [] }));
  const ok = await pollRerunTask('run-3', { endpoint: 'http://svc:8787', fetchImpl: fetchOk, pollMs: 1, maxMs: 1000 });
  assert.deepEqual(ok, { ok: true, status: 'diagnosed' });
});

test('pollRerunTask surfaces network / HTTP / bad-JSON failures', async () => {
  const network = await pollRerunTask('run-2', {
    endpoint: 'http://svc:8787',
    fetchImpl: async () => {
      throw new Error('network down');
    },
    pollMs: 1,
    maxMs: 1000,
  });
  assert.equal(network.ok, false);
  assert.match(network.error, /网络|不可达|network down/);

  const http = await pollRerunTask('run-2', {
    endpoint: 'http://svc:8787',
    fetchImpl: async () => jsonResponse(500, { error: 'x' }),
    pollMs: 1,
    maxMs: 1000,
  });
  assert.equal(http.ok, false);
  assert.match(http.error, /HTTP 500/);
});
