// tools/problems.mjs 单测（P11 problem lifecycle, task 1）。
// Problem 实体：createProblem/updateProblem/listProblems/getProblem + decisions 审计
// 轨迹 + defer/wontfix 强制 reason + 原子写 + 损坏文件容错。纯逻辑，无 API 调用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createProblem,
  updateProblem,
  getProblem,
  listProblems,
  addDiscussion,
  setGithubRef,
  deleteProblem,
  rerunProblem,
  setProblemReport,
  problemInputFromDiagnosis,
  importProblems,
  recordVerify,
  recordFix,
  recordFixFailure,
  recordMergeFix,
  recordRejectFix,
  ProblemError,
  PROBLEM_ID_RE,
  TRIAGE_VALUES,
  STATUS_VALUES,
} from './problems.mjs';

const FIXED_AT = '2026-08-27T12:00:00.000Z';
const NOW = () => FIXED_AT;
const laterNow = (offsetMs) => () =>
  new Date(new Date(FIXED_AT).getTime() + offsetMs).toISOString();

const mkTasksDir = () => mkdtempSync(join(tmpdir(), 'problems-test-'));

const problemsDirOf = (dir) => join(dir, 'problems');

// 每次调用返回递增 id（collision guard 测试除外）。
let seq = 0;
const freshId = () => `prob-test-${++seq}`;

const sampleReport = (over = {}) => ({
  status: 'diagnosed',
  phenomenon_summary: 'pass out of play with no defender pressure',
  layer: 'engine',
  hypotheses: ['defender pressure distance threshold too high'],
  root_cause: 'engine/src/lib.rs: unforced out pressure gate misconfigured',
  proposed_fix: 'lower unforced_out.pressure_distance in the audit profile',
  verification: 'node tools/runner-cli.mjs --bundle obs.json --audit audit.json --replay r',
  confidence: 0.8,
  triage: { category: 'bug', rationale: 'clear root cause', confidence: 0.9 },
  ...over,
});

const envKey = 'sk-ant-fake-live-secret-0000';

test('TRIAGE_VALUES/STATUS_VALUES enumerate the documented enums', () => {
  assert.deepEqual(TRIAGE_VALUES, ['bug', 'design', 'discuss', 'defer', 'wontfix']);
  assert.deepEqual(STATUS_VALUES, ['open', 'in_progress', 'fixed', 'closed']);
  assert.match('prob-1720000000000-1', PROBLEM_ID_RE);
  assert.doesNotMatch('../evil', PROBLEM_ID_RE);
});

test('createProblem from a diagnosis report persists an open bug Problem', () => {
  const dir = mkTasksDir();
  const report = sampleReport();
  const problem = createProblem(
    {
      title: report.phenomenon_summary,
      description: `现象：${report.phenomenon_summary}\n根因：${report.root_cause}`,
      source: { observation_id: 'obs-1', task_id: 'task-1', report },
      triage: 'bug',
    },
    { tasksDir: dir, newId: freshId, now: NOW, envKey }
  );
  assert.match(problem.id, /^prob-/);
  assert.equal(problem.title, report.phenomenon_summary);
  assert.equal(problem.triage, 'bug');
  assert.equal(problem.status, 'open');
  assert.equal(problem.source.task_id, 'task-1');
  assert.equal(problem.source.observation_id, 'obs-1');
  assert.equal(problem.source.report.root_cause, report.root_cause);
  assert.equal(problem.change_ref, null);
  assert.equal(problem.github, null);
  assert.equal(problem.discussion.length, 0);
  assert.equal(problem.created_at, FIXED_AT);
  assert.equal(problem.updated_at, FIXED_AT);
  assert.deepEqual(problem.decisions, [
    { action: 'create', by: 'user', at: FIXED_AT, reason: 'from diagnosis report' },
  ]);
  // 落盘：一问题一文件，原子写不留 .tmp。
  const file = join(problemsDirOf(dir), `${problem.id}.json`);
  assert.equal(existsSync(file), true);
  assert.equal(existsSync(`${file}.tmp`), false);
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(stored.id, problem.id);
  assert.equal(stored.status, 'open');
  // getProblem 读回一致。
  assert.deepEqual(getProblem(problem.id, { tasksDir: dir }), problem);
});

test('createProblem manual (title only) defaults to discuss/open with null source', () => {
  const dir = mkTasksDir();
  const problem = createProblem(
    { title: '  long passes are too accurate  ' },
    { tasksDir: dir, newId: freshId, now: NOW }
  );
  assert.equal(problem.title, 'long passes are too accurate');
  assert.equal(problem.triage, 'discuss');
  assert.equal(problem.status, 'open');
  assert.equal(problem.source, null);
  assert.equal(problem.decisions[0].reason, 'manual creation');
  assert.equal(problem.description, '');
});

test('createProblem rejects missing/invalid title, invalid triage/status', () => {
  const dir = mkTasksDir();
  assert.throws(() => createProblem({ title: '  ' }, { tasksDir: dir }), (e) => {
    assert.ok(e instanceof ProblemError);
    assert.equal(e.code, 'BAD_REQUEST');
    assert.match(e.message, /title/);
    return true;
  });
  assert.throws(
    () => createProblem({ title: 'x', triage: 'nope' }, { tasksDir: dir }),
    (e) => e.code === 'BAD_REQUEST' && /triage/.test(e.message)
  );
  assert.throws(
    () => createProblem({ title: 'x', status: 'nope' }, { tasksDir: dir }),
    (e) => e.code === 'BAD_REQUEST' && /status/.test(e.message)
  );
  // 失败时不应落任何文件（目录可能尚未创建，视为空）。
  const entries = existsSync(problemsDirOf(dir)) ? readdirSync(problemsDirOf(dir)) : [];
  assert.equal(entries.length, 0);
});

test('createProblem with defer/wontfix requires a reason and forces status closed', () => {
  const dir = mkTasksDir();
  assert.throws(
    () => createProblem({ title: 'x', triage: 'defer' }, { tasksDir: dir }),
    (e) => e.code === 'MISSING_REASON' && /defer/.test(e.message)
  );
  assert.throws(
    () => createProblem({ title: 'x', triage: 'wontfix' }, { tasksDir: dir }),
    (e) => e.code === 'MISSING_REASON' && /wontfix/.test(e.message)
  );
  const problem = createProblem(
    { title: 'x', triage: 'defer', reason: 'not this sprint' },
    { tasksDir: dir, newId: freshId, now: NOW }
  );
  assert.equal(problem.triage, 'defer');
  assert.equal(problem.status, 'closed');
  assert.equal(problem.decisions.length, 2);
  assert.equal(problem.decisions[1].action, 'defer');
  assert.equal(problem.decisions[1].reason, 'not this sprint');
});

test('getProblem returns null for missing/corrupt files and rejects traversal ids', () => {
  const dir = mkTasksDir();
  assert.equal(getProblem('does-not-exist', { tasksDir: dir }), null);
  assert.equal(getProblem('../evil', { tasksDir: dir }), null);
  assert.equal(getProblem('a/b', { tasksDir: dir }), null);
  // 损坏文件：读返回 null，不抛。
  mkdirSync(problemsDirOf(dir), { recursive: true });
  const id = 'prob-corrupt-1';
  writeFileSync(join(problemsDirOf(dir), `${id}.json`), 'not json {{{');
  assert.equal(getProblem(id, { tasksDir: dir }), null);
  // id 字段与文件名不一致也视为损坏。
  writeFileSync(join(problemsDirOf(dir), 'prob-mismatch-1.json'), JSON.stringify({ id: 'other' }));
  assert.equal(getProblem('prob-mismatch-1', { tasksDir: dir }), null);
});

test('listProblems skips corrupt files and filters by triage/status', () => {
  const dir = mkTasksDir();
  const bug = createProblem(
    { title: 'bug one', source: { report: sampleReport() }, triage: 'bug' },
    { tasksDir: dir, newId: freshId, now: NOW }
  );
  const deferred = createProblem(
    { title: 'deferred one', triage: 'defer', reason: 'later' },
    { tasksDir: dir, newId: freshId, now: laterNow(1000) }
  );
  writeFileSync(join(problemsDirOf(dir), 'prob-garbage.json'), 'garbage');
  assert.equal(listProblems({ tasksDir: dir }).length, 2);
  assert.deepEqual(listProblems({ tasksDir: dir, triage: 'bug' }).map((p) => p.id), [bug.id]);
  assert.deepEqual(listProblems({ tasksDir: dir, status: 'closed' }).map((p) => p.id), [deferred.id]);
  // 新在前。
  assert.deepEqual(listProblems({ tasksDir: dir }).map((p) => p.id), [deferred.id, bug.id]);
  // 非法筛选值——模块容错，返回空（服务层负责 400）。
  assert.deepEqual(listProblems({ tasksDir: dir, triage: 'nope' }), []);
});

test('updateProblem triage → defer requires reason and records the decision', () => {
  const dir = mkTasksDir();
  const problem = createProblem(
    { title: 'x', triage: 'bug' },
    { tasksDir: dir, newId: freshId, now: NOW }
  );
  assert.throws(
    () => updateProblem(problem.id, { triage: 'defer' }, { tasksDir: dir }),
    (e) => e.code === 'MISSING_REASON'
  );
  // 拒绝后原样保留。
  assert.equal(getProblem(problem.id, { tasksDir: dir }).status, 'open');
  const updated = updateProblem(
    problem.id,
    { triage: 'defer', reason: 'parking until next milestone' },
    { tasksDir: dir, now: laterNow(1000) }
  );
  assert.equal(updated.triage, 'defer');
  assert.equal(updated.status, 'closed');
  assert.equal(updated.decisions.length, 2);
  assert.deepEqual(updated.decisions[1], {
    action: 'defer',
    from: 'bug',
    by: 'user',
    at: laterNow(1000)(),
    reason: 'parking until next milestone',
  });
  assert.equal(updated.updated_at, laterNow(1000)());
  // 持久化读回一致。
  assert.equal(getProblem(problem.id, { tasksDir: dir }).triage, 'defer');
});

test('updateProblem wontfix without reason is rejected; with reason records wontfix', () => {
  const dir = mkTasksDir();
  const problem = createProblem(
    { title: 'x', triage: 'design' },
    { tasksDir: dir, newId: freshId, now: NOW }
  );
  assert.throws(
    () => updateProblem(problem.id, { triage: 'wontfix' }, { tasksDir: dir }),
    (e) => e.code === 'MISSING_REASON' && /wontfix/.test(e.message)
  );
  const updated = updateProblem(
    problem.id,
    { triage: 'wontfix', reason: 'accepted behavior' },
    { tasksDir: dir, now: laterNow(1000) }
  );
  assert.equal(updated.triage, 'wontfix');
  assert.equal(updated.status, 'closed');
  assert.equal(updated.decisions[1].action, 'wontfix');
});

test('updateProblem rejects conflicting status with defer/wontfix', () => {
  const dir = mkTasksDir();
  const problem = createProblem(
    { title: 'x', triage: 'bug' },
    { tasksDir: dir, newId: freshId, now: NOW }
  );
  assert.throws(
    () =>
      updateProblem(
        problem.id,
        { triage: 'defer', status: 'in_progress', reason: 'r' },
        { tasksDir: dir }
      ),
    (e) => e.code === 'BAD_REQUEST' && /status=closed/.test(e.message)
  );
  // 已是 defer 的问题不能再改成非 closed status。
  const deferred = updateProblem(
    problem.id,
    { triage: 'defer', reason: 'r' },
    { tasksDir: dir }
  );
  assert.throws(
    () => updateProblem(deferred.id, { status: 'in_progress' }, { tasksDir: dir }),
    (e) => e.code === 'BAD_REQUEST' && /closed/.test(e.message)
  );
});

test('updateProblem reopens a defer problem (status → open, decision reopen)', () => {
  const dir = mkTasksDir();
  const problem = createProblem(
    { title: 'x', triage: 'bug' },
    { tasksDir: dir, newId: freshId, now: NOW }
  );
  updateProblem(problem.id, { triage: 'defer', reason: 'later' }, { tasksDir: dir, now: laterNow(1000) });
  const reopened = updateProblem(
    problem.id,
    { triage: 'discuss', reason: 'revisit after feature ships' },
    { tasksDir: dir, now: laterNow(2000) }
  );
  assert.equal(reopened.triage, 'discuss');
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.decisions.at(-1).action, 'reopen');
  assert.equal(reopened.decisions.at(-1).reason, 'revisit after feature ships');
});

test('updateProblem reopens a wontfix problem with explicit status', () => {
  const dir = mkTasksDir();
  const problem = createProblem(
    { title: 'x', triage: 'bug' },
    { tasksDir: dir, newId: freshId, now: NOW }
  );
  updateProblem(problem.id, { triage: 'wontfix', reason: 'w' }, { tasksDir: dir });
  const reopened = updateProblem(
    problem.id,
    { triage: 'bug', status: 'in_progress', reason: 'came back' },
    { tasksDir: dir }
  );
  assert.equal(reopened.triage, 'bug');
  assert.equal(reopened.status, 'in_progress');
  assert.equal(reopened.decisions.at(-1).action, 'reopen');
});

test('updateProblem plain triage change and status transitions append decisions', () => {
  const dir = mkTasksDir();
  const problem = createProblem(
    { title: 'x', triage: 'bug' },
    { tasksDir: dir, newId: freshId, now: NOW }
  );
  const triaged = updateProblem(
    problem.id,
    { triage: 'discuss', reason: 'low confidence' },
    { tasksDir: dir, now: laterNow(1000) }
  );
  assert.equal(triaged.triage, 'discuss');
  assert.equal(triaged.decisions.at(-1).action, 'triage');
  assert.equal(triaged.decisions.at(-1).reason, 'low confidence');
  // status: open → in_progress → fixed → closed
  let p = triaged;
  let prevStatus = 'open';
  for (const [status, offset] of [['in_progress', 2000], ['fixed', 3000], ['closed', 4000]]) {
    p = updateProblem(problem.id, { status }, { tasksDir: dir, now: laterNow(offset) });
    assert.equal(p.status, status);
    assert.equal(p.decisions.at(-1).action, `status:${status}`);
    assert.equal(p.decisions.at(-1).from, prevStatus);
    prevStatus = status;
  }
  assert.equal(p.decisions.length, 5); // create + triage + 3 status
});

test('updateProblem combined patch applies triage AND status with two decisions', () => {
  const dir = mkTasksDir();
  const problem = createProblem(
    { title: 'x', triage: 'bug' },
    { tasksDir: dir, newId: freshId, now: NOW }
  );
  const combined = updateProblem(
    problem.id,
    { triage: 'discuss', status: 'in_progress', reason: 'multi-factor' },
    { tasksDir: dir, now: laterNow(1000) }
  );
  assert.equal(combined.triage, 'discuss');
  assert.equal(combined.status, 'in_progress');
  assert.equal(combined.decisions.length, 3); // create + triage + status
  const lastTwo = combined.decisions.slice(-2);
  assert.equal(lastTwo[0].action, 'triage');
  assert.equal(lastTwo[1].action, 'status:in_progress');
  assert.equal(lastTwo[1].from, 'open');
  // 只改 triage → status 不变、只追加一条 decisions。
  const triageOnly = updateProblem(
    problem.id,
    { triage: 'design' },
    { tasksDir: dir, now: laterNow(2000) }
  );
  assert.equal(triageOnly.triage, 'design');
  assert.equal(triageOnly.status, 'in_progress');
  assert.equal(triageOnly.decisions.at(-1).action, 'triage');
  assert.equal(triageOnly.decisions.length, 4);
});

test('updateProblem combined patch rejects an invalid status', () => {
  const dir = mkTasksDir();
  const problem = createProblem(
    { title: 'x', triage: 'bug' },
    { tasksDir: dir, newId: freshId, now: NOW }
  );
  assert.throws(
    () => updateProblem(problem.id, { triage: 'discuss', status: 'nope' }, { tasksDir: dir }),
    (e) => e.code === 'BAD_REQUEST' && /status/.test(e.message)
  );
  // 拒绝后原样保留（无部分应用）。
  const unchanged = getProblem(problem.id, { tasksDir: dir });
  assert.equal(unchanged.triage, 'bug');
  assert.equal(unchanged.status, 'open');
  assert.equal(unchanged.decisions.length, 1);
});

test('persistProblem sanitizes generic credential key-value shapes in description', () => {
  const dir = mkTasksDir();
  const problem = createProblem(
    { title: 'x', description: 'leak "client_secret":"s3cret-value" and api_key: other-leak' },
    { tasksDir: dir, newId: freshId, now: NOW }
  );
  const stored = getProblem(problem.id, { tasksDir: dir });
  // 值已抹除；键名保留（与 viewer redactText 行为一致）。
  assert.doesNotMatch(stored.description, /s3cret-value/);
  assert.doesNotMatch(stored.description, /other-leak/);
  assert.match(stored.description, /\[REDACTED\]/);
});

test('persistProblem sanitizes generic credential shapes in discussion text', () => {
  const dir = mkTasksDir();
  const problem = createProblem(
    { title: 'x' },
    { tasksDir: dir, newId: freshId, now: NOW }
  );
  addDiscussion(
    problem.id,
    { author: 'user', text: '{"authorization":"Bearer tok"}' },
    { tasksDir: dir, now: laterNow(1000) }
  );
  const stored = getProblem(problem.id, { tasksDir: dir });
  assert.doesNotMatch(stored.discussion[0].text, /Bearer tok/);
  assert.match(stored.discussion[0].text, /\[REDACTED\]/);
});

test('persistProblem sanitizes unquoted KEY: value credential shapes in reason', () => {
  const dir = mkTasksDir();
  const problem = createProblem(
    { title: 'x', triage: 'bug' },
    { tasksDir: dir, newId: freshId, now: NOW }
  );
  updateProblem(problem.id, { triage: 'defer', reason: 'secret: abcdefgh long value' }, { tasksDir: dir });
  const stored = getProblem(problem.id, { tasksDir: dir });
  const lastReason = stored.decisions.at(-1).reason;
  assert.doesNotMatch(lastReason, /abcdefgh/);
  assert.match(lastReason, /\[REDACTED\]/);
});

test('persistProblem keeps legitimate non-credential text intact', () => {
  const dir = mkTasksDir();
  const problem = createProblem(
    {
      title: 'token: of the month discussion',
      description: 'layer: engine\n验证: node tools/runner-cli.mjs --bundle obs.json\nlib.rs: unforced gate',
    },
    { tasksDir: dir, newId: freshId, now: NOW }
  );
  const stored = getProblem(problem.id, { tasksDir: dir });
  // "token: of the month" 值不像秘密（含空格）不误伤；CJK key 与普通 key 不误伤。
  assert.equal(stored.title, 'token: of the month discussion');
  assert.match(stored.description, /layer: engine/);
  assert.match(stored.description, /验证: node tools\/runner-cli\.mjs/);
  assert.match(stored.description, /lib\.rs: unforced gate/);
});

test('persistProblem sanitizes credential-shaped values (sk-proj/github_pat_) anywhere', () => {
  const dir = mkTasksDir();
  const problem = createProblem(
    {
      title: 'x',
      description: 'see sk-proj-fake-secret-123456 and github_pat_fake_token_12345678901234567890 attached',
    },
    { tasksDir: dir, newId: freshId, now: NOW }
  );
  const stored = getProblem(problem.id, { tasksDir: dir });
  assert.doesNotMatch(stored.description, /sk-proj-fake-secret-123456/);
  assert.doesNotMatch(stored.description, /github_pat_fake_token_12345678901234567890/);
  assert.match(stored.description, /\[REDACTED\]/);
});

test('persistProblem sanitizes credential-keyed values (nested object keys)', () => {
  const dir = mkTasksDir();
  const problem = createProblem(
    {
      title: 'x',
      source: {
        task_id: 't1',
        report: { client_secret: 'longsecretvalue123', root_cause: 'engine lib.rs: gate', layer: 'engine' },
      },
    },
    { tasksDir: dir, newId: freshId, now: NOW }
  );
  const stored = getProblem(problem.id, { tasksDir: dir });
  // 键名含凭证词（client_secret）→ 值整体替换为 [REDACTED]（与响应路径一致）。
  assert.equal(stored.source.report.client_secret, '[REDACTED]');
  // 合法键名的值原样保留。
  assert.equal(stored.source.report.root_cause, 'engine lib.rs: gate');
  assert.equal(stored.source.report.layer, 'engine');
});

test('persistProblem keeps legitimate object keys intact', () => {
  const dir = mkTasksDir();
  const problem = createProblem(
    {
      title: 'x',
      source: { task_id: 't1', observation_id: 'o1', report: { layer: 'engine', root_cause: 'r' } },
      change_ref: 'p11-fix',
    },
    { tasksDir: dir, newId: freshId, now: NOW }
  );
  setGithubRef(
    problem.id,
    { issue_number: 1, url: 'https://github.com/owner/repo/issues/1' },
    { tasksDir: dir }
  );
  const stored = getProblem(problem.id, { tasksDir: dir });
  assert.equal(stored.source.task_id, 't1');
  assert.equal(stored.source.report.layer, 'engine');
  assert.equal(stored.change_ref, 'p11-fix');
  // github 键不误伤：issue_number/url 原样保留。
  assert.equal(stored.github.issue_number, 1);
  assert.equal(stored.github.url, 'https://github.com/owner/repo/issues/1');
});

test('updateProblem rejects invalid triage/status and unknown ids', () => {
  const dir = mkTasksDir();
  const problem = createProblem(
    { title: 'x' },
    { tasksDir: dir, newId: freshId, now: NOW }
  );
  assert.throws(
    () => updateProblem(problem.id, { triage: 'nope' }, { tasksDir: dir }),
    (e) => e.code === 'BAD_REQUEST'
  );
  assert.throws(
    () => updateProblem(problem.id, { status: 'nope' }, { tasksDir: dir }),
    (e) => e.code === 'BAD_REQUEST'
  );
  assert.equal(updateProblem('does-not-exist', { status: 'fixed' }, { tasksDir: dir }), null);
  // 非法 id（路径穿越）拒绝。
  assert.equal(updateProblem('../x', { status: 'fixed' }, { tasksDir: dir }), null);
});

test('updateProblem edits title/description/change_ref without a decision but bumps updated_at', () => {
  const dir = mkTasksDir();
  const problem = createProblem(
    { title: 'old', description: 'd', change_ref: 'p1-old' },
    { tasksDir: dir, newId: freshId, now: NOW }
  );
  const updated = updateProblem(
    problem.id,
    { title: 'new title', description: 'new description', change_ref: 'p11-fix' },
    { tasksDir: dir, now: laterNow(5000) }
  );
  assert.equal(updated.title, 'new title');
  assert.equal(updated.description, 'new description');
  assert.equal(updated.change_ref, 'p11-fix');
  assert.equal(updated.decisions.length, 1); // 仅 create
  assert.equal(updated.updated_at, laterNow(5000)());
  // change_ref 可清空（空串 → null）。
  const cleared = updateProblem(problem.id, { change_ref: '' }, { tasksDir: dir });
  assert.equal(cleared.change_ref, null);
});

test('addDiscussion appends a message and persists; persist-time scrub hides credentials', () => {
  const dir = mkTasksDir();
  const problem = createProblem(
    { title: 'x' },
    { tasksDir: dir, newId: freshId, now: NOW }
  );
  const updated = addDiscussion(
    problem.id,
    { author: 'user', text: 'reproducible, see sk-ant-fake-secret-value-0001 attached' },
    { tasksDir: dir, now: laterNow(1000), envKey }
  );
  assert.equal(updated.discussion.length, 1);
  assert.equal(updated.discussion[0].author, 'user');
  assert.equal(updated.discussion[0].at, laterNow(1000)());
  assert.equal(updated.updated_at, laterNow(1000)());
  // 落盘前 final safety net：凭证形值已抹除。
  const stored = getProblem(problem.id, { tasksDir: dir, envKey });
  assert.match(stored.discussion[0].text, /\[REDACTED\]/);
  assert.doesNotMatch(stored.discussion[0].text, /sk-ant-fake-secret-value-0001/);
  // 缺 author/text 拒绝。
  assert.throws(
    () => addDiscussion(problem.id, { author: '', text: 'x' }, { tasksDir: dir }),
    (e) => e.code === 'BAD_REQUEST'
  );
  assert.equal(addDiscussion('missing', { author: 'a', text: 't' }, { tasksDir: dir }), null);
});

test('setGithubRef writes the github reference with synced_at', () => {
  const dir = mkTasksDir();
  const problem = createProblem(
    { title: 'x', triage: 'bug' },
    { tasksDir: dir, newId: freshId, now: NOW }
  );
  const updated = setGithubRef(
    problem.id,
    { issue_number: 42, url: 'https://github.com/owner/repo/issues/42' },
    { tasksDir: dir, now: laterNow(1000) }
  );
  assert.deepEqual(updated.github, {
    issue_number: 42,
    url: 'https://github.com/owner/repo/issues/42',
    synced_at: laterNow(1000)(),
  });
  assert.equal(updated.updated_at, laterNow(1000)());
  assert.equal(getProblem(problem.id, { tasksDir: dir }).github.issue_number, 42);
  // 缺 id → null。
  assert.equal(setGithubRef('missing', { issue_number: 1, url: 'u' }, { tasksDir: dir }), null);
});

test('createProblem avoids id collisions by re-asking newId', () => {
  const dir = mkTasksDir();
  // newId 前两次返回已占用的 id，第三次给新 id。
  mkdirSync(problemsDirOf(dir), { recursive: true });
  const taken = join(problemsDirOf(dir), 'prob-collide-1.json');
  writeFileSync(taken, JSON.stringify({ id: 'prob-collide-1' }));
  let calls = 0;
  const collidingId = () => {
    calls += 1;
    return calls <= 2 ? 'prob-collide-1' : `prob-collide-${calls}`;
  };
  const problem = createProblem({ title: 'x' }, { tasksDir: dir, newId: collidingId, now: NOW });
  assert.equal(problem.id, 'prob-collide-3');
  assert.equal(calls, 3);
});

// --- P12 problem ops（delete / rerun / import）---

test('deleteProblem removes the file and returns true; missing id returns null', () => {
  const dir = mkTasksDir();
  const problem = createProblem({ title: 'x' }, { tasksDir: dir, newId: freshId, now: NOW });
  const file = join(problemsDirOf(dir), `${problem.id}.json`);
  assert.equal(existsSync(file), true);
  assert.equal(deleteProblem(problem.id, { tasksDir: dir }), true);
  assert.equal(existsSync(file), false);
  assert.equal(getProblem(problem.id, { tasksDir: dir }), null);
  assert.equal(listProblems({ tasksDir: dir }).length, 0);
  // 幂等 404 语义：再次删除返回 null，不影响其它问题。
  assert.equal(deleteProblem(problem.id, { tasksDir: dir }), null);
  assert.equal(deleteProblem('does-not-exist', { tasksDir: dir }), null);
  // 非法 / 穿越 id 拒绝。
  assert.equal(deleteProblem('../evil', { tasksDir: dir }), null);
  assert.equal(deleteProblem('a/b', { tasksDir: dir }), null);
  // 未删除的其它问题原样保留。
  const keep = createProblem({ title: 'keep' }, { tasksDir: dir, newId: freshId, now: NOW });
  assert.equal(listProblems({ tasksDir: dir }).length, 1);
  assert.equal(getProblem(keep.id, { tasksDir: dir }).title, 'keep');
});

test('rerunProblem points source.task_id at the new run and records the rerun decision', () => {
  const dir = mkTasksDir();
  const report = sampleReport();
  const problem = createProblem(
    { title: 'x', source: { task_id: 'task-1', observation_id: 'obs-1', report } },
    { tasksDir: dir, newId: freshId, now: NOW }
  );
  const updated = rerunProblem(problem.id, { task_id: 'run-2' }, { tasksDir: dir, now: laterNow(1000) });
  assert.equal(updated.source.task_id, 'run-2');
  // 其它 source 字段（observation_id / 旧 report）保留到新报告写回。
  assert.equal(updated.source.observation_id, 'obs-1');
  assert.deepEqual(updated.source.report, report);
  assert.equal(updated.updated_at, laterNow(1000)());
  assert.equal(updated.decisions.length, 2);
  // rerun 决策带 prev_task_id（旧 task_id，供 import 去重）。
  assert.deepEqual(updated.decisions[1], {
    action: 'rerun',
    by: 'user',
    at: laterNow(1000)(),
    reason: null,
    prev_task_id: 'task-1',
  });
  // 持久化读回一致。
  const stored = getProblem(problem.id, { tasksDir: dir });
  assert.equal(stored.source.task_id, 'run-2');
  assert.equal(stored.decisions[1].action, 'rerun');
  // reason 可空 / 可填。
  const again = rerunProblem(
    problem.id,
    { task_id: 'run-3', reason: 'engine changed' },
    { tasksDir: dir, now: laterNow(2000) }
  );
  assert.equal(again.source.task_id, 'run-3');
  assert.equal(again.decisions[2].reason, 'engine changed');
  // 缺 id → null；非法 id → null；缺 task_id → BAD_REQUEST。
  assert.equal(rerunProblem('missing', { task_id: 'r' }, { tasksDir: dir }), null);
  assert.equal(rerunProblem('../x', { task_id: 'r' }, { tasksDir: dir }), null);
  assert.throws(() => rerunProblem(problem.id, {}, { tasksDir: dir }), (e) => e.code === 'BAD_REQUEST');
});

test('setProblemReport writes the new diagnosis report back, preserving the source chain', () => {
  const dir = mkTasksDir();
  const oldReport = sampleReport();
  const problem = createProblem(
    { title: 'x', source: { task_id: 'task-1', observation_id: 'obs-1', report: oldReport } },
    { tasksDir: dir, newId: freshId, now: NOW }
  );
  const newReport = sampleReport({ phenomenon_summary: 'after rerun' });
  const updated = setProblemReport(problem.id, newReport, { tasksDir: dir, now: laterNow(1000) });
  assert.equal(updated.source.report.phenomenon_summary, 'after rerun');
  assert.equal(updated.source.task_id, 'task-1');
  assert.equal(updated.source.observation_id, 'obs-1');
  assert.equal(updated.updated_at, laterNow(1000)());
  assert.equal(getProblem(problem.id, { tasksDir: dir }).source.report.phenomenon_summary, 'after rerun');
  // 缺 id → null；非法 report → 拒绝。
  assert.equal(setProblemReport('missing', newReport, { tasksDir: dir }), null);
  assert.throws(() => setProblemReport(problem.id, 'not-an-object', { tasksDir: dir }), (e) => e.code === 'BAD_REQUEST');
});

test('problemInputFromDiagnosis builds createProblem input from a diagnosed task', () => {
  const report = sampleReport({
    phenomenon_summary: 'wingers never cut inside',
    triage: { category: 'design', rationale: 'missing cut-inside mechanism', confidence: 0.8 },
  });
  const bundle = { observation_id: 'obs-9', statement: 'wingers never cut inside on the right flank' };
  const input = problemInputFromDiagnosis({
    task_id: 'task-9',
    task: { status: 'diagnosed', report },
    bundle,
    envKey,
  });
  assert.equal(input.title, 'wingers never cut inside');
  assert.match(input.description, /现象: wingers never cut inside/);
  assert.match(input.description, /用户描述: wingers never cut inside on the right flank/);
  assert.match(input.description, /根因:/);
  assert.match(input.description, /建议修复:/);
  assert.match(input.description, /验证:/);
  assert.equal(input.triage, 'design');
  assert.equal(input.status, 'open');
  assert.equal(input.source.task_id, 'task-9');
  assert.equal(input.source.observation_id, 'obs-9');
  assert.equal(input.source.report, report);
});

test('problemInputFromDiagnosis applies overrides and redacts the bundle statement', () => {
  const report = sampleReport();
  const bundle = { observation_id: 'obs-1', statement: `see ${envKey} attached` };
  const input = problemInputFromDiagnosis({
    task_id: 't1',
    task: { status: 'diagnosed', report },
    bundle,
    envKey,
    overrides: { title: 'custom title', triage: 'discuss', status: 'in_progress', description: 'custom desc' },
  });
  assert.equal(input.title, 'custom title');
  assert.equal(input.description, 'custom desc');
  assert.equal(input.triage, 'discuss');
  assert.equal(input.status, 'in_progress');
  // overrides 只覆盖顶层，source 链仍是 task_id/report。
  assert.equal(input.source.task_id, 't1');
  assert.equal(input.source.report, report);
  // bundle.statement 已抹除凭证形值。
  assert.doesNotMatch(input.description, new RegExp(envKey));
});

test('problemInputFromDiagnosis falls back for missing fields and no bundle', () => {
  const report = { status: 'diagnosed' };
  const input = problemInputFromDiagnosis({
    task_id: 't1',
    task: { status: 'diagnosed', report },
    bundle: null,
    envKey,
  });
  assert.equal(input.title, '未命名问题');
  assert.equal(input.description, '现象: 未命名问题');
  assert.equal(input.triage, 'discuss');
  assert.equal(input.status, 'open');
  assert.equal(input.source.observation_id, undefined);
  assert.equal(input.source.report, report);
});

test('importProblems scans diagnosed tasks, skips linked tasks, and creates the rest', () => {
  const dir = mkTasksDir();
  // 已有一个 Problem 指向 t-diagnosed-1。
  createProblem(
    { title: 'existing', source: { task_id: 't-diagnosed-1', report: sampleReport() } },
    { tasksDir: dir, newId: freshId, now: NOW }
  );
  const tasks = {
    't-diagnosed-1': { status: 'diagnosed', report: sampleReport() },
    't-diagnosed-2': { status: 'diagnosed', report: sampleReport({ phenomenon_summary: 'second' }) },
    't-failed': { status: 'failed', errors: ['x'] },
    't-auditing': { status: 'auditing' },
  };
  const listTaskIds = () => Object.keys(tasks);
  const readTask = (id) => tasks[id] ?? null;
  const readBundle = (id) => ({ observation_id: `obs-${id}` });
  const result = importProblems(
    { tasksDir: dir, readTask, listTaskIds, readBundle },
    { newId: freshId, now: NOW }
  );
  // 只有 t-diagnosed-2 被创建（t-diagnosed-1 已关联，failed/auditing 不是候选）。
  assert.equal(result.created.length, 1);
  assert.deepEqual(result.skipped, ['t-diagnosed-1']);
  assert.deepEqual(result.failed, []);
  const created = getProblem(result.created[0], { tasksDir: dir });
  assert.equal(created.source.task_id, 't-diagnosed-2');
  assert.equal(created.source.observation_id, 'obs-t-diagnosed-2');
});

test('importProblems with explicit task_ids fails missing/undiagnosed tasks', () => {
  const dir = mkTasksDir();
  const tasks = {
    't-good': { status: 'diagnosed', report: sampleReport() },
    't-failed': { status: 'failed' },
  };
  const readTask = (id) => tasks[id] ?? null;
  const readBundle = () => null;
  const result = importProblems(
    { tasksDir: dir, task_ids: ['t-good', 't-failed', 't-missing'], readTask, readBundle },
    { newId: freshId, now: NOW }
  );
  assert.equal(result.created.length, 1);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.failed, [
    { task_id: 't-failed', error: 'task not diagnosed or missing' },
    { task_id: 't-missing', error: 'task not diagnosed or missing' },
  ]);
});

test('importProblems creates each task once and reports read/create failures', () => {
  const dir = mkTasksDir();
  const tasks = {
    t1: { status: 'diagnosed', report: sampleReport() },
    boom: { status: 'diagnosed', report: sampleReport({ phenomenon_summary: 'boom' }) },
  };
  const readTask = (id) => {
    if (id === 't-broken') throw new Error('read error');
    return tasks[id] ?? null;
  };
  const readBundle = () => null;
  const createFn = (input, opts) => {
    if (input.title === 'boom') throw new Error('create error');
    return createProblem(input, { ...opts, newId: freshId, now: NOW });
  };
  const result = importProblems(
    { tasksDir: dir, task_ids: ['t1', 't1', 't-broken', 'boom'], readTask, readBundle },
    { newId: freshId, now: NOW, createFn }
  );
  // t1 只创建一次；同批重复的第二个 t1 计入 skipped（不静默消失）；t-broken/boom 各自失败。
  assert.equal(result.created.length, 1);
  assert.deepEqual(result.skipped, ['t1']);
  assert.equal(result.failed.length, 2);
  assert.ok(result.failed.some((f) => f.task_id === 't-broken' && /read error/.test(f.error)));
  assert.ok(result.failed.some((f) => f.task_id === 'boom' && /create error/.test(f.error)));
});

test('importProblems skips old task ids superseded by a rerun (decisions prev_task_id)', () => {
  const dir = mkTasksDir();
  const tasks = {
    't-orig': { status: 'diagnosed', report: sampleReport() },
    't-new': { status: 'diagnosed', report: sampleReport() },
  };
  // 问题从 t-orig 创建后重跑 → source.task_id 指向 t-new，decision 带 prev_task_id t-orig。
  const problem = createProblem(
    { title: 'x', source: { task_id: 't-orig', report: sampleReport() } },
    { tasksDir: dir, newId: freshId, now: NOW }
  );
  rerunProblem(problem.id, { task_id: 't-new' }, { tasksDir: dir, now: laterNow(1000) });
  const readTask = (id) => tasks[id] ?? null;
  const readBundle = () => null;
  const result = importProblems(
    { tasksDir: dir, readTask, listTaskIds: () => ['t-orig', 't-new'], readBundle },
    { newId: freshId, now: NOW }
  );
  // t-new 是当前 source.task_id；t-orig 已脱链但 decisions 里 prev_task_id 仍标记 → 都跳过。
  assert.equal(result.created.length, 0);
  assert.deepEqual(result.skipped.sort(), ['t-new', 't-orig']);
  assert.deepEqual(result.failed, []);
});

test('setProblemReport discards write-back when run_id no longer matches the current source', () => {
  const dir = mkTasksDir();
  const oldReport = sampleReport();
  const problem = createProblem(
    { title: 'x', source: { task_id: 'run-1', report: oldReport } },
    { tasksDir: dir, newId: freshId, now: NOW }
  );
  const staleReport = sampleReport({ phenomenon_summary: 'stale result' });
  // run_id 不匹配当前 source.task_id（并发 rerun 已指向更新的任务）→ no-op，报告不覆盖。
  const unchanged = setProblemReport(problem.id, staleReport, { tasksDir: dir, runId: 'run-2' });
  assert.equal(unchanged.source.report.phenomenon_summary, 'pass out of play with no defender pressure');
  assert.equal(
    getProblem(problem.id, { tasksDir: dir }).source.report.phenomenon_summary,
    'pass out of play with no defender pressure'
  );
  // run_id 匹配 → 正常写回。
  const updated = setProblemReport(problem.id, staleReport, { tasksDir: dir, runId: 'run-1' });
  assert.equal(updated.source.report.phenomenon_summary, 'stale result');
  assert.equal(getProblem(problem.id, { tasksDir: dir }).source.report.phenomenon_summary, 'stale result');
});

// --- P13 problem actions（recordVerify / recordFix / recordFixFailure / recordMergeFix / recordRejectFix）---

test('recordVerify appends a verify decision and marks fixed when exit 0 + markFixed', () => {
  const dir = mkTasksDir();
  const problem = createProblem({ title: 'x' }, { tasksDir: dir, newId: freshId, now: NOW });
  const updated = recordVerify(
    problem.id,
    { command: 'cargo test', exit_code: 0, summary: 'all pass', markFixed: true },
    { tasksDir: dir, now: laterNow(1000), by: 'user' }
  );
  assert.equal(updated.status, 'fixed');
  const decision = updated.decisions.at(-1);
  assert.equal(decision.action, 'verify');
  assert.equal(decision.command, 'cargo test');
  assert.equal(decision.exit_code, 0);
  assert.equal(decision.summary, 'all pass');
  assert.equal(decision.at, laterNow(1000)());
  // status:fixed 决策追加在 verify 之前。
  assert.equal(updated.decisions.at(-2).action, 'status:fixed');
  assert.equal(getProblem(problem.id, { tasksDir: dir }).status, 'fixed');
});

test('recordVerify does not change status when exit is non-zero even with markFixed', () => {
  const dir = mkTasksDir();
  const problem = createProblem({ title: 'x' }, { tasksDir: dir, newId: freshId, now: NOW });
  const updated = recordVerify(
    problem.id,
    { command: 'cargo test', exit_code: 1, summary: 'fail', markFixed: true },
    { tasksDir: dir, now: NOW }
  );
  assert.equal(updated.status, 'open');
  assert.equal(updated.decisions.at(-1).exit_code, 1);
  assert.ok(!updated.decisions.some((d) => d.action === 'status:fixed'));
});

test('recordVerify without markFixed leaves status untouched', () => {
  const dir = mkTasksDir();
  const problem = createProblem({ title: 'x' }, { tasksDir: dir, newId: freshId, now: NOW });
  const updated = recordVerify(problem.id, { command: 'cargo test', exit_code: 0, summary: 'ok' }, { tasksDir: dir, now: NOW });
  assert.equal(updated.status, 'open');
  assert.equal(updated.decisions.at(-1).action, 'verify');
});

test('recordVerify rejects markFixed on closed-triage problems atomically', () => {
  const dir = mkTasksDir();
  const problem = createProblem(
    { title: 'x', triage: 'defer', reason: 'later' },
    { tasksDir: dir, newId: freshId, now: NOW }
  );
  assert.throws(
    () => recordVerify(problem.id, { command: 'cargo test', exit_code: 0, summary: 'ok', markFixed: true }, { tasksDir: dir, now: NOW }),
    (e) => e instanceof ProblemError && /status=closed/.test(e.message)
  );
  // 记录不写入：问题不变。
  const after = getProblem(problem.id, { tasksDir: dir });
  assert.ok(!after.decisions.some((d) => d.action === 'verify'));
  assert.equal(after.status, 'closed');
});

test('recordFix writes fix_ref pending_confirm, sets status in_progress, and appends the fix decision', () => {
  const dir = mkTasksDir();
  const problem = createProblem({ title: 'x' }, { tasksDir: dir, newId: freshId, now: NOW });
  const updated = recordFix(
    problem.id,
    {
      worktree: '/tmp/p13-fix/fix-prob-1-t',
      branch: 'fix/prob-1/20260827T1530000',
      summary: 'lowered threshold',
      changed_files: ['engine/src/lib.rs'],
      verification_results: [{ command: 'cargo test', exit_code: 0, summary: 'pass' }],
    },
    { tasksDir: dir, now: NOW }
  );
  assert.equal(updated.status, 'in_progress');
  assert.deepEqual(updated.fix_ref, { worktree: '/tmp/p13-fix/fix-prob-1-t', branch: 'fix/prob-1/20260827T1530000', status: 'pending_confirm' });
  const decision = updated.decisions.at(-1);
  assert.equal(decision.action, 'fix');
  assert.equal(decision.outcome, 'succeeded');
  assert.deepEqual(decision.changed_files, ['engine/src/lib.rs']);
  assert.equal(decision.verification_results[0].exit_code, 0);
  // status:in_progress 决策在 fix 之前。
  assert.equal(updated.decisions.at(-2).action, 'status:in_progress');
  // 持久化。
  assert.deepEqual(getProblem(problem.id, { tasksDir: dir }).fix_ref.status, 'pending_confirm');
});

test('recordFix requires worktree and branch', () => {
  const dir = mkTasksDir();
  const problem = createProblem({ title: 'x' }, { tasksDir: dir, newId: freshId, now: NOW });
  assert.throws(
    () => recordFix(problem.id, { worktree: '/w', summary: 's' }, { tasksDir: dir, now: NOW }),
    (e) => e instanceof ProblemError && /worktree and branch/.test(e.message)
  );
});

test('recordFixFailure appends a failure decision without touching status or fix_ref', () => {
  const dir = mkTasksDir();
  const problem = createProblem({ title: 'x', status: 'open' }, { tasksDir: dir, newId: freshId, now: NOW });
  const updated = recordFixFailure(
    problem.id,
    { error: 'provider timed out', worktree: '/tmp/x/fix-prob-1-t', branch: 'fix/prob-1/t' },
    { tasksDir: dir, now: NOW }
  );
  assert.equal(updated.status, 'open');
  assert.equal(updated.fix_ref, undefined);
  const decision = updated.decisions.at(-1);
  assert.equal(decision.action, 'fix');
  assert.equal(decision.outcome, 'failed');
  assert.equal(decision.error, 'provider timed out');
  assert.equal(decision.worktree, '/tmp/x/fix-prob-1-t');
});

test('recordMergeFix closes the problem, fills change_ref, and marks fix_ref merged', () => {
  const dir = mkTasksDir();
  const problem = createProblem({ title: 'x' }, { tasksDir: dir, newId: freshId, now: NOW });
  recordFix(
    problem.id,
    { worktree: '/w', branch: 'fix/prob-1/t', summary: 's', changed_files: [], verification_results: [] },
    { tasksDir: dir, now: NOW }
  );
  const updated = recordMergeFix(problem.id, { changeRef: 'fix/prob-1', worktree: '/w', branch: 'fix/prob-1/t' }, { tasksDir: dir, now: NOW });
  assert.equal(updated.status, 'closed');
  assert.equal(updated.change_ref, 'fix/prob-1');
  assert.equal(updated.fix_ref.status, 'merged');
  assert.ok(updated.fix_ref.merged_at);
  const decision = updated.decisions.at(-1);
  assert.equal(decision.action, 'merge-fix');
  assert.equal(decision.change_ref, 'fix/prob-1');
});

test('recordMergeFix defaults change_ref to fix/<id> and keeps closed-triage status', () => {
  const dir = mkTasksDir();
  const problem = createProblem(
    { title: 'x', triage: 'defer', reason: 'later' },
    { tasksDir: dir, newId: freshId, now: NOW }
  );
  // closed-triage 问题本来 status=closed：合入不追加 status:closed 决策。
  const updated = recordMergeFix(problem.id, { worktree: '/w', branch: 'fix/p/t' }, { tasksDir: dir, now: NOW });
  assert.equal(updated.status, 'closed');
  assert.equal(updated.change_ref, `fix/${problem.id}`);
  assert.ok(!updated.decisions.some((d) => d.action === 'status:closed'));
});

test('recordRejectFix marks fix_ref rejected and keeps the worktree; problem not closed', () => {
  const dir = mkTasksDir();
  const problem = createProblem({ title: 'x' }, { tasksDir: dir, newId: freshId, now: NOW });
  recordFix(
    problem.id,
    { worktree: '/w', branch: 'fix/prob-1/t', summary: 's', changed_files: [], verification_results: [] },
    { tasksDir: dir, now: NOW }
  );
  const updated = recordRejectFix(problem.id, { reason: 'wrong approach', worktree: '/w', branch: 'fix/prob-1/t' }, { tasksDir: dir, now: NOW });
  assert.equal(updated.status, 'in_progress');
  assert.equal(updated.fix_ref.status, 'rejected');
  assert.ok(updated.fix_ref.rejected_at);
  const decision = updated.decisions.at(-1);
  assert.equal(decision.action, 'reject-fix');
  assert.equal(decision.reason, 'wrong approach');
  assert.equal(decision.worktree, '/w');
});
