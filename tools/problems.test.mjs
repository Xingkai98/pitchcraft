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

const sampleReport = () => ({
  status: 'diagnosed',
  phenomenon_summary: 'pass out of play with no defender pressure',
  layer: 'engine',
  hypotheses: ['defender pressure distance threshold too high'],
  root_cause: 'engine/src/lib.rs: unforced out pressure gate misconfigured',
  proposed_fix: 'lower unforced_out.pressure_distance in the audit profile',
  verification: 'node tools/runner-cli.mjs --bundle obs.json --audit audit.json --replay r',
  confidence: 0.8,
  triage: { category: 'bug', rationale: 'clear root cause', confidence: 0.9 },
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
