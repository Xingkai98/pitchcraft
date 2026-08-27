import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDiagnosisPrompt,
  validateDiagnosisReport,
  redactTaskText,
  runDiagnosis,
  REPORT_FIELDS,
  TASK_STATUSES,
  DEFAULT_RUNNER_CONFIG,
} from './runner.mjs';
import { ClaudeCodeAdapter, redactKey, sanitizeChildEnv } from './provider.mjs';

const FAKE_KEY = 'sk-ant-fake-secret-value-0001';

const validBundle = () => ({
  schema_version: '1',
  observation_id: 'obs-1',
  seed: 'seed-42',
  config: { home: 'A', away: 'B' },
  match_time: 100,
  window: { before: 5, after: 5 },
  events: [{ index: 0, type: 'kickoff' }],
  engine_snapshot: {
    kind: 'event-stream',
    match_time: 100,
    current_event_index: 0,
    event_count: 1,
    window: { before: 5, after: 5 },
    lineup: [],
  },
  viewer_snapshot: {
    match_time: 100,
    current_event_index: 0,
    event_count: 1,
    play_time: 100,
    players: [],
    ball: { x: 0.5, y: 0.5 },
  },
  audit_input: { events: [], players: {} },
  source_revision: 'abc123',
});

const validReport = (over = {}) => ({
  status: 'diagnosed',
  phenomenon_summary: 'pass out of play with no defender pressure',
  layer: 'engine',
  hypotheses: ['defender pressure distance threshold too high'],
  root_cause: 'engine/src/lib.rs: unforced out pressure gate misconfigured',
  proposed_fix: 'lower unforced_out.pressure_distance in the audit profile',
  verification: 'node tools/runner-cli.mjs --bundle obs.json --audit audit.json --replay r --revision HEAD',
  confidence: 0.8,
  ...over,
});

const mkBundleFile = (dir, bundle = validBundle()) => {
  const p = join(dir, 'bundle.json');
  writeFileSync(p, JSON.stringify(bundle));
  return p;
};

// A minimal fake child process for the ClaudeCodeAdapter. Captures stdin writes
// and exposes kill(). stdout/stderr are EventEmitters; 'close'/'error' are
// emitted by the test to drive the adapter to completion.
const fakeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdin = new EventEmitter();
  stdin.writes = [];
  stdin.ended = false;
  stdin.write = (chunk) => {
    stdin.writes.push(String(chunk));
  };
  stdin.end = () => {
    stdin.ended = true;
  };
  child.stdin = stdin;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
};

// --- prompt construction ----------------------------------------------------

test('buildDiagnosisPrompt references all evidence + requires insufficient_evidence', () => {
  const prompt = buildDiagnosisPrompt({
    bundlePath: '/bundle.json',
    auditPath: '/audit.json',
    replayInstructions: 'node tools/runner-cli.mjs --seed 42',
    sourceRevision: 'abc123',
    statement: 'defender does not press',
  });
  assert.match(prompt, /bundle: \/bundle\.json/);
  assert.match(prompt, /audit report: \/audit\.json/);
  assert.match(prompt, /node tools\/runner-cli\.mjs --seed 42/);
  assert.match(prompt, /abc123/);
  assert.match(prompt, /insufficient_evidence/);
  assert.match(prompt, /DO NOT fabricate a root cause/);
  for (const field of REPORT_FIELDS) assert.match(prompt, new RegExp(field));
});

test('buildDiagnosisPrompt never contains a credential even when present in env', () => {
  const prompt = buildDiagnosisPrompt({
    bundlePath: '/b.json',
    auditPath: '/a.json',
    replayInstructions: 'x',
    sourceRevision: 'r',
  });
  assert.doesNotMatch(prompt, new RegExp(FAKE_KEY));
  assert.doesNotMatch(prompt, /sk-ant-/);
});

test('buildDiagnosisPrompt default (bypass) tells the agent to execute verification and record modifications', () => {
  const prompt = buildDiagnosisPrompt({
    bundlePath: '/b.json',
    auditPath: '/a.json',
    replayInstructions: 'node tools/runner-cli.mjs --seed 42',
    sourceRevision: 'r',
  });
  // Default permission is bypass: the agent actually executes the verification
  // commands and may modify files (recording what it did).
  assert.match(prompt, /bypass: full tool access/);
  assert.match(prompt, /EXECUTE the/);
  assert.match(prompt, /same-seed replay, run the relevant tests/);
  assert.match(prompt, /MAY modify source,/);
  assert.match(prompt, /record every modification you make in the report/);
  // The verification field still carries the commands for human re-check.
  assert.match(prompt, /verification" field of your report so a human can/);
  // The read-only mandate must be absent.
  assert.doesNotMatch(prompt, /MUST NOT modify any source/);
});

test('buildDiagnosisPrompt read-only keeps the strict no-edit contract and defers execution', () => {
  const prompt = buildDiagnosisPrompt({
    bundlePath: '/b.json',
    auditPath: '/a.json',
    replayInstructions: 'node tools/runner-cli.mjs --seed 42',
    sourceRevision: 'r',
    permission: 'read-only',
  });
  assert.match(prompt, /mode \(read-only\)/);
  assert.match(prompt, /MUST NOT modify any source/);
  assert.match(prompt, /PROPOSE the/);
  assert.match(prompt, /so the runner\/user can execute them/);
  assert.match(prompt, /do not run the full pipeline yourself/);
  assert.doesNotMatch(prompt, /EXECUTE the/);
});

// --- structured report validation -------------------------------------------

test('validateDiagnosisReport accepts a valid report', () => {
  const { valid, report, errors } = validateDiagnosisReport(validReport());
  assert.equal(valid, true);
  assert.equal(report.status, 'diagnosed');
  assert.deepEqual(errors, []);
});

test('validateDiagnosisReport accepts a valid insufficient_evidence report', () => {
  const rep = validReport({ status: 'insufficient_evidence', root_cause: '', confidence: 0.1 });
  const { valid } = validateDiagnosisReport(rep);
  assert.equal(valid, true);
});

test('validateDiagnosisReport rejects a report missing a required field', () => {
  const rep = validReport();
  delete rep.verification;
  const { valid, errors } = validateDiagnosisReport(rep);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /missing required field: verification/.test(e)));
});

test('validateDiagnosisReport rejects an invalid status and does not diagnose', () => {
  const { valid, errors } = validateDiagnosisReport(validReport({ status: 'guessed' }));
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /status must be one of/.test(e)));
});

test('validateDiagnosisReport rejects non-JSON string output', () => {
  const { valid, errors } = validateDiagnosisReport('this is not json');
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /parseable JSON report/.test(e)));
});

test('validateDiagnosisReport rejects a report carrying a credential key without leaking value', () => {
  const rep = validReport({ api_key: FAKE_KEY });
  const { valid, errors } = validateDiagnosisReport(rep);
  assert.equal(valid, false);
  assert.ok(errors.length >= 1);
  assert.doesNotMatch(errors.join(' '), new RegExp(FAKE_KEY));
});

// --- triage classification ---------------------------------------------------

test('validateDiagnosisReport accepts a valid triage and preserves it', () => {
  const rep = validReport({
    triage: { category: 'bug', rationale: 'clear root cause at lib.rs:42', confidence: 0.9 },
  });
  const { valid, report, errors } = validateDiagnosisReport(rep);
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
  assert.deepEqual(report.triage, {
    category: 'bug',
    rationale: 'clear root cause at lib.rs:42',
    confidence: 0.9,
  });
});

test('validateDiagnosisReport falls back to discuss when triage is missing (report still valid)', () => {
  const rep = validReport(); // no triage field
  const { valid, report } = validateDiagnosisReport(rep);
  assert.equal(valid, true, 'missing triage must not reject the report');
  assert.deepEqual(report.triage, {
    category: 'discuss',
    rationale: 'agent 未提供分类',
    confidence: 0,
  });
});

test('validateDiagnosisReport falls back to discuss on an invalid triage category', () => {
  const rep = validReport({ triage: { category: 'urgent', rationale: 'x', confidence: 0.5 } });
  const { valid, report } = validateDiagnosisReport(rep);
  assert.equal(valid, true);
  assert.equal(report.triage.category, 'discuss');
  assert.match(report.triage.rationale, /非法分类已兜底/);
});

test('validateDiagnosisReport falls back on empty rationale or out-of-range confidence', () => {
  for (const triage of [
    { category: 'bug', rationale: '', confidence: 0.5 },
    { category: 'bug', rationale: '   ', confidence: 0.5 },
    { category: 'bug', rationale: 'ok', confidence: 1.5 },
    { category: 'bug', rationale: 'ok', confidence: 'high' },
    { category: 'bug', rationale: 'ok' }, // missing confidence
    'not-an-object',
  ]) {
    const rep = validReport({ triage });
    const { valid, report } = validateDiagnosisReport(rep);
    assert.equal(valid, true, `triage ${JSON.stringify(triage)} must not reject the report`);
    assert.equal(report.triage.category, 'discuss');
    assert.equal(report.triage.confidence, 0);
  }
});

test('validateDiagnosisReport rejects a credential-shaped value in triage.rationale', () => {
  const rep = validReport({
    triage: { category: 'bug', rationale: `auth leak ${FAKE_KEY}`, confidence: 0.5 },
  });
  const { valid, errors } = validateDiagnosisReport(rep);
  assert.equal(valid, false);
  assert.doesNotMatch(errors.join(' '), new RegExp(FAKE_KEY));
});

test('buildDiagnosisPrompt includes the triage classification guide', () => {
  const prompt = buildDiagnosisPrompt({
    bundlePath: '/b.json',
    auditPath: '/a.json',
    replayInstructions: 'x',
    sourceRevision: 'r',
  });
  assert.match(prompt, /NATURE of the root\s+cause, NOT by fix effort/);
  assert.match(prompt, /- bug: existing implementation behaves differently/);
  assert.match(prompt, /- design: the code works as designed/);
  assert.match(prompt, /- discuss: root cause unclear/);
  assert.match(prompt, /low \(<0\.7\)/);
  assert.match(prompt, /MUST carry a "triage" field/);
  assert.match(prompt, /triage: \{ category: one of bug \| design \| discuss/);
  for (const c of ['bug', 'design', 'discuss']) assert.match(prompt, new RegExp(c));
});

// --- redaction --------------------------------------------------------------

test('redactKey scrubs the live key value and generic sk-ant secrets', () => {
  const text = `token=${FAKE_KEY} plus another sk-ant-abc123`;
  const out = redactKey(text, FAKE_KEY);
  assert.doesNotMatch(out, new RegExp(FAKE_KEY));
  assert.doesNotMatch(out, /sk-ant-/);
  assert.match(out, /\[REDACTED\]/);
});

test('redactTaskText deep-scrubs a persisted task object', () => {
  const task = { report: { proposed_fix: FAKE_KEY }, raw: `x${FAKE_KEY}y` };
  const out = redactTaskText(task, FAKE_KEY);
  assert.doesNotMatch(out, new RegExp(FAKE_KEY));
  assert.doesNotMatch(out, /sk-ant-/);
});

// --- provider adapter (timeout, no real process) ----------------------------

test('ClaudeCodeAdapter returns provider_unavailable without spawning when key missing', async () => {
  let spawned = false;
  const adapter = new ClaudeCodeAdapter({}, {
    spawn: () => {
      spawned = true;
      return fakeChild();
    },
    readEnv: () => ({}),
  });
  const result = await adapter.run('prompt', { env: {} });
  assert.equal(result.status, 'provider_unavailable');
  assert.equal(spawned, false);
});

// --- child process environment sanitization -----------------------------------

test('sanitizeChildEnv strips Claude Code session/auth vars and keeps base + key + proxies', () => {
  const out = sanitizeChildEnv({
    ANTHROPIC_API_KEY: FAKE_KEY,
    PATH: '/usr/bin',
    HOME: '/home/user',
    TERM: 'xterm',
    LANG: 'C.UTF-8',
    SHELL: '/bin/bash',
    HTTPS_PROXY: 'http://proxy:8080',
    HTTP_PROXY: 'http://proxy:8080',
    NO_PROXY: 'localhost',
    no_proxy: '127.0.0.1',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SESSION_ID: 'sess-1',
    CLAUDE_CODE_EXECPATH: '/usr/local/bin/claude',
    CLAUDE_CODE_ENTRYPOINT: '/usr/local/bin/claude',
    CLAUDE_PID: '12345',
    ANTHROPIC_AUTH_TOKEN: 'tok-abc',
    ANTHROPIC_BASE_URL: 'http://proxy.internal',
    ANTHROPIC_MODEL: 'claude-sonnet-4-5',
    ANTHROPIC_DEFAULT_MODEL: 'claude-sonnet-4-5',
    ANTHROPIC_DEFAULT_SMALL_FAST_MODEL: 'claude-haiku',
    AI_AGENT: 'claude',
    CLAUDECODE: '1',
  });
  assert.equal(out.ANTHROPIC_API_KEY, FAKE_KEY, 'API key must survive sanitization');
  for (const k of ['PATH', 'HOME', 'TERM', 'LANG', 'SHELL']) {
    assert.ok(out[k], `${k} must be kept`);
  }
  for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'no_proxy']) {
    assert.ok(out[k], `proxy var ${k} must be kept`);
  }
  for (const k of [
    'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PID', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL', 'ANTHROPIC_DEFAULT_SMALL_FAST_MODEL',
    'AI_AGENT', 'CLAUDECODE',
  ]) {
    assert.equal(out[k], undefined, `${k} must be stripped`);
  }
});

test('ClaudeCodeAdapter spawns the child with a sanitized env (session vars stripped, base kept)', async () => {
  let spawnedEnv = null;
  const child = fakeChild();
  const adapter = new ClaudeCodeAdapter({}, {
    spawn: (_cmd, _args, opts) => {
      spawnedEnv = opts.env;
      return child;
    },
    readEnv: () => ({}),
  });
  const sourceEnv = {
    ANTHROPIC_API_KEY: FAKE_KEY,
    PATH: '/usr/bin',
    HOME: '/home/user',
    HTTPS_PROXY: 'http://proxy:8080',
    NO_PROXY: 'localhost',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SESSION_ID: 'sess-1',
    CLAUDE_PID: '12345',
    ANTHROPIC_AUTH_TOKEN: 'tok-abc',
    ANTHROPIC_BASE_URL: 'http://proxy.internal',
    ANTHROPIC_MODEL: 'claude-sonnet-4-5',
    ANTHROPIC_DEFAULT_MODEL: 'claude-sonnet-4-5',
    AI_AGENT: 'claude',
    CLAUDECODE: '1',
  };
  const pending = adapter.run('prompt', { env: sourceEnv });
  assert.ok(spawnedEnv, 'spawn must receive the sanitized env');
  for (const blocked of [
    'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID',
    'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_MODEL', 'AI_AGENT', 'CLAUDECODE',
  ]) {
    assert.equal(spawnedEnv[blocked], undefined, `${blocked} must be stripped from child env`);
  }
  assert.equal(spawnedEnv.ANTHROPIC_API_KEY, FAKE_KEY);
  assert.equal(spawnedEnv.PATH, '/usr/bin');
  assert.equal(spawnedEnv.HTTPS_PROXY, 'http://proxy:8080');
  assert.equal(spawnedEnv.NO_PROXY, 'localhost');
  child.emit('close', 0);
  const result = await pending;
  assert.equal(result.status, 'success');
});

test('ClaudeCodeAdapter passes cwd through to spawn when provided (P13 fix worktree)', async () => {
  let spawnedCwd = null;
  const child = fakeChild();
  const adapter = new ClaudeCodeAdapter({}, {
    spawn: (_cmd, _args, opts) => {
      spawnedCwd = opts.cwd;
      return child;
    },
    readEnv: () => ({}),
  });
  const pending = adapter.run('prompt', {
    env: { ANTHROPIC_API_KEY: FAKE_KEY },
    cwd: '/tmp/p13-fix/fix-prob-1-t',
  });
  assert.equal(spawnedCwd, '/tmp/p13-fix/fix-prob-1-t');
  child.emit('close', 0);
  const result = await pending;
  assert.equal(result.status, 'success');
  // 不传 cwd 时不带该选项（向后兼容）。
  let spawnedWithoutCwd = 'sentinel';
  const child2 = fakeChild();
  const adapter2 = new ClaudeCodeAdapter({}, {
    spawn: (_cmd, _args, opts) => {
      spawnedWithoutCwd = opts.cwd;
      return child2;
    },
    readEnv: () => ({}),
  });
  const pending2 = adapter2.run('prompt', { env: { ANTHROPIC_API_KEY: FAKE_KEY } });
  child2.emit('close', 0);
  await pending2;
  assert.equal(spawnedWithoutCwd, undefined);
});

test('ClaudeCodeAdapter still refuses to spawn when the env has session vars but no API key', async () => {
  let spawned = false;
  const adapter = new ClaudeCodeAdapter({}, {
    spawn: () => {
      spawned = true;
      return fakeChild();
    },
    readEnv: () => ({}),
  });
  const result = await adapter.run('prompt', {
    env: { CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_PID: '123', CLAUDECODE: '1' },
  });
  assert.equal(result.status, 'provider_unavailable');
  assert.equal(spawned, false);
});

test('ClaudeCodeAdapter times out and kills the child', async () => {
  let killed = false;
  const child = fakeChild();
  child.kill = () => {
    killed = true;
  };
  const adapter = new ClaudeCodeAdapter({ timeout_seconds: 1 }, {
    spawn: () => child,
    readEnv: () => ({ ANTHROPIC_API_KEY: FAKE_KEY }),
  });
  // A tiny timeout via the run option forces the timeout path without a real child.
  const result = await adapter.run('prompt', { env: { ANTHROPIC_API_KEY: FAKE_KEY }, timeoutMs: 40 });
  assert.equal(result.status, 'timeout');
  assert.equal(result.timedOut, true);
  assert.equal(killed, true);
});

test('ClaudeCodeAdapter sends the exact prompt via stdin and ends it', async () => {
  const child = fakeChild();
  const adapter = new ClaudeCodeAdapter({}, {
    spawn: () => child,
    readEnv: () => ({ ANTHROPIC_API_KEY: FAKE_KEY }),
  });
  const prompt = 'diagnose observation bundle /bundle.json';
  const pending = adapter.run(prompt, { env: { ANTHROPIC_API_KEY: FAKE_KEY } });
  // The prompt is written synchronously before the promise resolves.
  assert.equal(child.stdin.writes.join(''), prompt);
  assert.equal(child.stdin.ended, true);
  child.emit('close', 0);
  const result = await pending;
  assert.equal(result.status, 'success');
  assert.equal(result.ok, true);
});

test('ClaudeCodeAdapter bare/pipe flags + fails closed to plan when permission is unspecified', () => {
  const adapter = new ClaudeCodeAdapter({}, { readEnv: () => ({ ANTHROPIC_API_KEY: FAKE_KEY }) });
  const args = adapter.buildArgs({ ANTHROPIC_API_KEY: FAKE_KEY });
  // --bare disables claude keychain/OAuth so ANTHROPIC_API_KEY is the auth source.
  assert.ok(args.includes('--bare'));
  assert.ok(args.includes('--output-format'));
  assert.equal(args[args.indexOf('--output-format') + 1], 'text');
  // A bare adapter with an empty config fails closed to plan + disallowed edit
  // tools (unknown permission => read-only). The runner default (bypass) is
  // tested separately against DEFAULT_RUNNER_CONFIG below.
  assert.ok(args.includes('--permission-mode'));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
  assert.ok(args.includes('--disallowedTools'));
  assert.ok(args.includes('Edit'));
  assert.ok(args.includes('Write'));
  // No credential material in the argument vector; no model unless configured.
  assert.ok(!args.some((a) => a.includes(FAKE_KEY)));
  assert.ok(!args.some((a) => /sk-ant-/.test(a)));
  assert.ok(!args.includes('--model'));
});

test('ClaudeCodeAdapter with the default runner config (bypass) uses bypassPermissions and no --disallowedTools', () => {
  const adapter = new ClaudeCodeAdapter(DEFAULT_RUNNER_CONFIG, {
    readEnv: () => ({ ANTHROPIC_API_KEY: FAKE_KEY }),
  });
  const args = adapter.buildArgs({ ANTHROPIC_API_KEY: FAKE_KEY });
  assert.equal(DEFAULT_RUNNER_CONFIG.permission, 'bypass');
  assert.equal(DEFAULT_RUNNER_CONFIG.read_only, false);
  assert.ok(args.includes('--permission-mode'));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'bypassPermissions');
  // bypass default: edit tools are NOT disallowed.
  assert.ok(!args.includes('--disallowedTools'));
  assert.ok(!args.includes('Edit'));
  // Still no credential material in the argument vector.
  assert.ok(!args.some((a) => a.includes(FAKE_KEY)));
});

test('ClaudeCodeAdapter with --permission read-only still disables editing', () => {
  const adapter = new ClaudeCodeAdapter(
    { permission: 'read-only' },
    { readEnv: () => ({ ANTHROPIC_API_KEY: FAKE_KEY }) }
  );
  const args = adapter.buildArgs({ ANTHROPIC_API_KEY: FAKE_KEY });
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
  assert.ok(args.includes('--disallowedTools'));
  assert.ok(args.includes('Edit'));
  assert.ok(args.includes('Write'));
});

test('ClaudeCodeAdapter uses documented pipe form: -p + stdin, no standalone - positional', async () => {
  const child = fakeChild();
  const adapter = new ClaudeCodeAdapter({}, {
    spawn: () => child,
    readEnv: () => ({ ANTHROPIC_API_KEY: FAKE_KEY }),
  });
  const args = adapter.buildArgs({ ANTHROPIC_API_KEY: FAKE_KEY });
  // `claude --help` documents `-p, --print` as the non-interactive pipe mode and
  // has NO `-` stdin sentinel positional; a standalone `-` would be read as the
  // literal prompt and stdin ignored.
  assert.ok(args.includes('-p'));
  assert.ok(!args.includes('-'), `standalone '-' positional must not be present: ${JSON.stringify(args)}`);
  // The prompt still goes to stdin (documented pipe form), not as an argument.
  const prompt = 'diagnose bundle /b.json';
  const pending = adapter.run(prompt, { env: { ANTHROPIC_API_KEY: FAKE_KEY } });
  assert.equal(child.stdin.writes.join(''), prompt);
  assert.equal(child.stdin.ended, true);
  child.emit('close', 0);
  const result = await pending;
  assert.equal(result.status, 'success');
});

test('ClaudeCodeAdapter survives an async stdin EPIPE and still resolves from close', async () => {
  const child = fakeChild();
  const adapter = new ClaudeCodeAdapter({}, {
    spawn: () => child,
    readEnv: () => ({ ANTHROPIC_API_KEY: FAKE_KEY }),
  });
  const pending = adapter.run('prompt', { env: { ANTHROPIC_API_KEY: FAKE_KEY } });
  // Provider exits early -> async EPIPE on our write stream. Must not crash.
  child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  child.emit('close', 0);
  const result = await pending;
  assert.equal(result.status, 'success');
  assert.equal(result.ok, true);
});

test('ClaudeCodeAdapter does not crash on a non-benign stdin error and resolves via close/error', async () => {
  const child = fakeChild();
  const adapter = new ClaudeCodeAdapter({}, {
    spawn: () => child,
    readEnv: () => ({ ANTHROPIC_API_KEY: FAKE_KEY }),
  });
  const pending = adapter.run('prompt', { env: { ANTHROPIC_API_KEY: FAKE_KEY } });
  // A non-EPIPE stdin error is surfaced by the child error/close path.
  child.stdin.emit('error', Object.assign(new Error('bad fd'), { code: 'EBADF' }));
  child.emit('error', Object.assign(new Error('child crashed'), { code: 'EBADF' }));
  const result = await pending;
  assert.equal(result.status, 'error');
  assert.equal(result.ok, false);
});

test('ClaudeCodeAdapter emits --disallowedTools as a space-separated variadic list (CLI <tools...> contract)', () => {
  const adapter = new ClaudeCodeAdapter({}, { readEnv: () => ({ ANTHROPIC_API_KEY: FAKE_KEY }) });
  const args = adapter.buildArgs({ ANTHROPIC_API_KEY: FAKE_KEY });
  const i = args.indexOf('--disallowedTools');
  assert.ok(i >= 0, 'must include --disallowedTools');
  const tools = args.slice(i + 1, i + 1 + 4);
  assert.deepEqual(tools, ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
  // Space-separated individual args, NOT a single comma-joined string.
  assert.ok(!tools.some((t) => t.includes(',')));
});

test('ClaudeCodeAdapter disallows edit tools for any mode while read_only', () => {
  const adapter = new ClaudeCodeAdapter(
    { permission: 'manual' },
    { readEnv: () => ({ ANTHROPIC_API_KEY: FAKE_KEY }) }
  );
  const args = adapter.buildArgs({ ANTHROPIC_API_KEY: FAKE_KEY });
  assert.ok(args.includes('--disallowedTools'));
  assert.ok(args.includes('Edit'));
  assert.ok(args.includes('Write'));
});

test('ClaudeCodeAdapter omits disallowedTools when read_only is false and edits are accepted', () => {
  const adapter = new ClaudeCodeAdapter(
    { permission: 'accept-edits', read_only: false },
    { readEnv: () => ({ ANTHROPIC_API_KEY: FAKE_KEY }) }
  );
  const args = adapter.buildArgs({ ANTHROPIC_API_KEY: FAKE_KEY });
  assert.ok(!args.includes('--disallowedTools'));
});

test('ClaudeCodeAdapter maps a configured model into args while keeping it key-free', () => {
  const adapter = new ClaudeCodeAdapter(
    { model: 'claude-fable-5' },
    { readEnv: () => ({ ANTHROPIC_API_KEY: FAKE_KEY }) }
  );
  const args = adapter.buildArgs({ ANTHROPIC_API_KEY: FAKE_KEY });
  assert.ok(args.includes('--model'));
  assert.equal(args[args.indexOf('--model') + 1], 'claude-fable-5');
  assert.ok(!args.some((a) => a.includes(FAKE_KEY)));
});

test('ClaudeCodeAdapter maps config.budget to the stable --max-budget-usd flag', () => {
  const adapter = new ClaudeCodeAdapter(
    { budget: 2.5 },
    { readEnv: () => ({ ANTHROPIC_API_KEY: FAKE_KEY }) }
  );
  const args = adapter.buildArgs({ ANTHROPIC_API_KEY: FAKE_KEY });
  assert.ok(args.includes('--max-budget-usd'));
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '2.5');
});

test('ClaudeCodeAdapter omits --max-budget-usd when budget is unset or non-positive', () => {
  for (const budget of [undefined, null, 0, -1, NaN]) {
    const adapter = new ClaudeCodeAdapter(
      { budget },
      { readEnv: () => ({ ANTHROPIC_API_KEY: FAKE_KEY }) }
    );
    const args = adapter.buildArgs({ ANTHROPIC_API_KEY: FAKE_KEY });
    assert.ok(!args.includes('--max-budget-usd'), `budget=${budget} must not set the flag`);
  }
});

test('ClaudeCodeAdapter treats a non-zero exit as an error, not success', async () => {
  const child = fakeChild();
  const adapter = new ClaudeCodeAdapter({}, {
    spawn: () => child,
    readEnv: () => ({ ANTHROPIC_API_KEY: FAKE_KEY }),
  });
  const pending = adapter.run('prompt', { env: { ANTHROPIC_API_KEY: FAKE_KEY } });
  child.stderr.emit('data', 'authentication failed');
  child.emit('close', 1);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.status, 'error');
  assert.equal(result.exitCode, 1);
  assert.match(result.error, /exited with code 1/);
  assert.match(result.error, /authentication failed/);
});

test('validateDiagnosisReport extracts a report from fenced text output', () => {
  const { valid, report, errors } = validateDiagnosisReport(
    '```json\n' + JSON.stringify(validReport()) + '\n```'
  );
  assert.equal(valid, true);
  assert.equal(report.status, 'diagnosed');
  assert.deepEqual(errors, []);
});

test('validateDiagnosisReport rejects a null root_cause (use "" for insufficient_evidence)', () => {
  const rep = validReport({ status: 'insufficient_evidence', root_cause: null });
  const { valid, errors } = validateDiagnosisReport(rep);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /root_cause must be a string/.test(e)));
});

test('validateDiagnosisReport rejects a non-array hypotheses', () => {
  const { valid, errors } = validateDiagnosisReport(validReport({ hypotheses: 'not-an-array' }));
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /hypotheses must be an array/.test(e)));
});

test('validateDiagnosisReport rejects hypotheses containing non-strings', () => {
  const { valid, errors } = validateDiagnosisReport(validReport({ hypotheses: ['ok', 42] }));
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /only strings/.test(e)));
});

test('validateDiagnosisReport rejects confidence out of [0,1] and non-numeric', () => {
  for (const confidence of [-0.1, 1.5, 'high', NaN]) {
    const { valid, errors } = validateDiagnosisReport(validReport({ confidence }));
    assert.equal(valid, false, `confidence ${confidence} should be rejected`);
    assert.ok(errors.some((e) => /confidence must be a number between 0 and 1/.test(e)));
  }
});

// --- full pipeline via injected fake adapter --------------------------------

test('runDiagnosis returns provider_unavailable when ANTHROPIC_API_KEY is unset', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-test-'));
  const bundlePath = mkBundleFile(dir);
  const auditPath = join(dir, 'audit.json');
  const tasksDir = join(dir, 'tasks');

  let adapterCalled = false;
  const adapter = {
    run: async () => {
      adapterCalled = true;
      throw new Error('should not be called');
    },
  };
  const task = await runDiagnosis({
    bundlePath,
    auditPath,
    replayInstructions: 'x',
    sourceRevision: 'r',
    tasksDir,
    adapter,
    env: {},
  });
  assert.equal(task.status, 'provider_unavailable');
  assert.equal(adapterCalled, false);
  // The audit report was still produced for independent review.
  assert.equal(existsSync(auditPath), true);
});

test('runDiagnosis marks invalid agent output as failed/invalid_agent_output, not diagnosed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-test-'));
  const bundlePath = mkBundleFile(dir);
  const auditPath = join(dir, 'audit.json');
  const tasksDir = join(dir, 'tasks');

  const adapter = {
    run: async () => ({ ok: true, status: 'success', stdout: 'not json at all', exitCode: 0 }),
  };
  const task = await runDiagnosis({
    bundlePath,
    auditPath,
    replayInstructions: 'x',
    sourceRevision: 'r',
    tasksDir,
    adapter,
    env: { ANTHROPIC_API_KEY: FAKE_KEY },
  });
  assert.equal(task.status, 'failed');
  assert.equal(task.failure_kind, 'invalid_agent_output');
  assert.equal(task.report, null);
  assert.ok(task.retries.attempts >= 1);
  assert.ok(task.raw_output_ref.endsWith('.raw.txt'));
});

test('runDiagnosis does not diagnose valid-looking output on a non-zero provider exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-test-'));
  const bundlePath = mkBundleFile(dir);
  const auditPath = join(dir, 'audit.json');
  const tasksDir = join(dir, 'tasks');

  const adapter = {
    run: async () => ({
      ok: true,
      status: 'success',
      stdout: JSON.stringify(validReport()),
      exitCode: 1,
    }),
  };
  const task = await runDiagnosis({
    bundlePath,
    auditPath,
    replayInstructions: 'x',
    sourceRevision: 'r',
    tasksDir,
    adapter,
    env: { ANTHROPIC_API_KEY: FAKE_KEY },
  });
  assert.equal(task.status, 'failed');
  assert.equal(task.failure_kind, 'provider_error');
  assert.equal(task.report, null);
  assert.ok(task.errors.some((e) => /non-zero exit code 1|exited with code 1/.test(e)));
});

test('runDiagnosis does not diagnose when the provider reports an error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-test-'));
  const bundlePath = mkBundleFile(dir);
  const auditPath = join(dir, 'audit.json');
  const tasksDir = join(dir, 'tasks');

  const adapter = {
    run: async () => ({
      ok: false,
      status: 'error',
      stdout: '',
      stderr: 'boom',
      exitCode: 1,
      error: 'provider exited with code 1: boom',
    }),
  };
  const task = await runDiagnosis({
    bundlePath,
    auditPath,
    replayInstructions: 'x',
    sourceRevision: 'r',
    tasksDir,
    adapter,
    env: { ANTHROPIC_API_KEY: FAKE_KEY },
  });
  assert.equal(task.status, 'failed');
  assert.equal(task.failure_kind, 'provider_error');
  assert.equal(task.report, null);
  assert.ok(task.errors.some((e) => /boom/.test(e)));
});

test('runDiagnosis persists a valid structured report and marks diagnosed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-test-'));
  const bundlePath = mkBundleFile(dir);
  const auditPath = join(dir, 'audit.json');
  const tasksDir = join(dir, 'tasks');

  const adapter = {
    run: async () => ({
      ok: true,
      status: 'success',
      stdout: JSON.stringify(validReport()),
      exitCode: 0,
    }),
  };
  const task = await runDiagnosis({
    bundlePath,
    auditPath,
    replayInstructions: 'x',
    sourceRevision: 'abc123',
    tasksDir,
    adapter,
    env: { ANTHROPIC_API_KEY: FAKE_KEY },
  });
  assert.equal(task.status, 'diagnosed');
  assert.equal(task.report.status, 'diagnosed');
  assert.equal(task.command_exit_status, 0);
  assert.equal(task.input_summary.observation_id, 'obs-1');
  assert.equal(task.input_summary.finding_count, 0);
  assert.ok(task.started_at);
  assert.ok(task.ended_at);
  // Default permission is bypass (full tool access, edit tools not disallowed).
  assert.equal(task.provider.permission, 'bypass');
  assert.equal(task.provider.read_only, false);
  // The persisted report carries a normalized triage (fallback discuss here,
  // since the fake report has none).
  assert.equal(task.report.triage.category, 'discuss');
  assert.equal(task.report.triage.confidence, 0);

  // Audit report written for the agent to read.
  const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
  assert.equal(audit.observation_id, 'obs-1');
  assert.equal(audit.source_revision, 'abc123');
  // Per-detector stats are included so multi-seed aggregation can read report files.
  assert.ok(Array.isArray(audit.stats));
  assert.ok(audit.stats.some((s) => s.detector_id === 'unforced_out' && typeof s.samples === 'number'));
});

test('runDiagnosis marks bundle source_revision as provenance and keeps runner revision separate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-test-'));
  const bundle = validBundle();
  bundle.source_revision = 'bundle-rev';
  const bundlePath = mkBundleFile(dir, bundle);
  const auditPath = join(dir, 'audit.json');
  const tasksDir = join(dir, 'tasks');
  let capturedPrompt = '';
  const adapter = {
    run: async (prompt) => {
      capturedPrompt = prompt;
      return { ok: true, status: 'success', stdout: JSON.stringify(validReport()), exitCode: 0 };
    },
  };
  const task = await runDiagnosis({
    bundlePath,
    auditPath,
    replayInstructions: 'x',
    sourceRevision: 'runner-rev',
    tasksDir,
    adapter,
    env: { ANTHROPIC_API_KEY: FAKE_KEY },
  });
  assert.equal(task.status, 'diagnosed');
  // Audit report provenance comes from the BUNDLE, not the CLI/checkout revision.
  const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
  assert.equal(audit.source_revision, 'bundle-rev');
  assert.equal(audit.runner_source_revision, 'runner-rev');
  assert.equal(task.input_summary.source_revision, 'bundle-rev');
  assert.equal(task.input_summary.runner_source_revision, 'runner-rev');
  // The prompt surfaces both: bundle provenance + the runner/current checkout.
  assert.match(capturedPrompt, /bundle-rev/);
  assert.match(capturedPrompt, /runner-rev/);
  assert.match(capturedPrompt, /observation bundle source revision: bundle-rev/);
  assert.match(capturedPrompt, /current source revision \(runner\/checkout\): runner-rev/);
});

test('runDiagnosis surfaces insufficient_evidence report status', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-test-'));
  const bundlePath = mkBundleFile(dir);
  const auditPath = join(dir, 'audit.json');
  const tasksDir = join(dir, 'tasks');

  const adapter = {
    run: async () => ({
      ok: true,
      status: 'success',
      stdout: JSON.stringify(
        validReport({ status: 'insufficient_evidence', root_cause: '', confidence: 0.1 })
      ),
      exitCode: 0,
    }),
  };
  const task = await runDiagnosis({
    bundlePath,
    auditPath,
    replayInstructions: 'x',
    sourceRevision: 'r',
    tasksDir,
    adapter,
    env: { ANTHROPIC_API_KEY: FAKE_KEY },
  });
  assert.equal(task.status, 'insufficient_evidence');
  assert.equal(task.report.status, 'insufficient_evidence');
});

test('runDiagnosis audits bundle.audit_input (meter), not raw normalized viewer events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-test-'));
  // viewer bundle: raw events are normalized [0,1] with NO meter feature evidence.
  const meterBundle = {
    schema_version: '1',
    observation_id: 'obs-meter',
    seed: 'seed-42',
    config: { home: 'A', away: 'B' },
    match_time: 100,
    window: { before: 5, after: 5 },
    events: [
      { index: 0, type: 'pass', result: 'out', x: 0.5, y: 0.5, x2: 0.9, y2: 0.5 },
    ],
    engine_snapshot: {
      kind: 'event-stream',
      match_time: 100,
      current_event_index: 0,
      event_count: 1,
      window: { before: 5, after: 5 },
      lineup: [],
    },
    viewer_snapshot: {
      match_time: 100,
      current_event_index: 0,
      event_count: 1,
      play_time: 100,
      players: [],
      ball: { x: 0.5, y: 0.5 },
    },
    source_revision: 'abc123',
    audit_input: {
      events: [
        {
          index: 0, type: 'pass', result: 'out',
          x: 52.5, y: 34, x2: 94.5, y2: 34,
          nearest_defender_distance: 12, pass_distance: 40, target_distance: 50,
        },
      ],
      players: {},
    },
  };
  const bundlePath = mkBundleFile(dir, meterBundle);
  const auditPath = join(dir, 'audit.json');
  const tasksDir = join(dir, 'tasks');
  const adapter = {
    run: async () => ({
      ok: true,
      status: 'success',
      stdout: JSON.stringify(validReport()),
      exitCode: 0,
    }),
  };
  const task = await runDiagnosis({
    bundlePath,
    auditPath,
    replayInstructions: 'x',
    sourceRevision: 'r',
    tasksDir,
    adapter,
    env: { ANTHROPIC_API_KEY: FAKE_KEY },
  });
  assert.equal(task.status, 'diagnosed');
  const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
  const out = audit.findings.find(
    (f) => f.detector_id === 'unforced_out' && f.severity === 'realism_warning'
  );
  // If the runner had audited the normalized events instead, this finding would be
  // `unknown` (nearest_defender_distance missing). Its meter features prove
  // audit_input was consumed.
  assert.ok(out, 'expected a realism_warning unforced_out finding from meter audit_input');
  assert.equal(out.features.pass_distance, 40);
  assert.equal(out.features.defender_distance, 12);
});

test('TASK_STATUSES uses the match-observation spec vocabulary only', () => {
  assert.deepEqual(TASK_STATUSES, [
    'captured',
    'auditing',
    'audit_ready',
    'diagnosing',
    'diagnosed',
    'insufficient_evidence',
    'provider_unavailable',
    'failed',
  ]);
});

test('runDiagnosis records spec status_history transitions for a diagnosed task', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-test-'));
  const bundlePath = mkBundleFile(dir);
  const auditPath = join(dir, 'audit.json');
  const tasksDir = join(dir, 'tasks');
  const adapter = {
    run: async () => ({
      ok: true,
      status: 'success',
      stdout: JSON.stringify(validReport()),
      exitCode: 0,
    }),
  };
  const task = await runDiagnosis({
    bundlePath,
    auditPath,
    replayInstructions: 'x',
    sourceRevision: 'r',
    tasksDir,
    adapter,
    env: { ANTHROPIC_API_KEY: FAKE_KEY },
  });
  const seq = task.status_history.map((s) => s.status);
  assert.deepEqual(seq, ['auditing', 'audit_ready', 'diagnosing', 'diagnosed']);
  assert.ok(task.status_history.every((s) => typeof s.at === 'string' && s.at.length > 0));
});

test('runDiagnosis rejects a bundle missing audit_input (no silent fallback to raw events)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-test-'));
  // All required fields except audit_input; even though events exist, the bundle
  // must fail validation rather than audit raw normalized coordinates as meters.
  const noAuditInput = validBundle();
  delete noAuditInput.audit_input;
  const bundlePath = mkBundleFile(dir, noAuditInput);
  const auditPath = join(dir, 'audit.json');
  const tasksDir = join(dir, 'tasks');
  const adapter = {
    run: async () => {
      throw new Error('should not be called');
    },
  };
  const task = await runDiagnosis({
    bundlePath,
    auditPath,
    replayInstructions: 'x',
    sourceRevision: 'r',
    tasksDir,
    adapter,
    env: { ANTHROPIC_API_KEY: FAKE_KEY },
  });
  assert.equal(task.status, 'failed');
  assert.equal(task.failure_kind, 'invalid_bundle');
  assert.ok(task.errors.some((e) => /missing required field: audit_input/.test(e)));
});

test('runDiagnosis rejects an invalid bundle as failed/invalid_bundle with a status_history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-test-'));
  const bundlePath = mkBundleFile(dir, { schema_version: '1', observation_id: 'x' });
  const auditPath = join(dir, 'audit.json');
  const tasksDir = join(dir, 'tasks');
  const adapter = {
    run: async () => {
      throw new Error('should not be called');
    },
  };
  const task = await runDiagnosis({
    bundlePath,
    auditPath,
    replayInstructions: 'x',
    sourceRevision: 'r',
    tasksDir,
    adapter,
    env: { ANTHROPIC_API_KEY: FAKE_KEY },
  });
  assert.equal(task.status, 'failed');
  assert.equal(task.failure_kind, 'invalid_bundle');
  assert.ok(task.errors.some((e) => /missing required field/.test(e)));
  assert.ok(task.status_history.some((s) => s.status === 'auditing'));
});

test('runDiagnosis scrubs sk-ant in sourceRevision from prompt, audit report, and persisted task', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-test-'));
  const bundlePath = mkBundleFile(dir);
  const auditPath = join(dir, 'audit.json');
  const tasksDir = join(dir, 'tasks');
  let capturedPrompt = '';
  const adapter = {
    run: async (prompt) => {
      capturedPrompt = prompt;
      return { ok: true, status: 'success', stdout: JSON.stringify(validReport()), exitCode: 0 };
    },
  };
  const secretRevision = 'rev-abc-sk-ant-xyz789';
  const task = await runDiagnosis({
    bundlePath,
    auditPath,
    replayInstructions: 'x',
    sourceRevision: secretRevision,
    tasksDir,
    adapter,
    env: { ANTHROPIC_API_KEY: FAKE_KEY },
  });
  assert.equal(task.status, 'diagnosed');
  // Never in the prompt.
  assert.doesNotMatch(capturedPrompt, /sk-ant-xyz789/);
  assert.doesNotMatch(capturedPrompt, /sk-ant-/);
  // Never in the returned task input_summary.
  assert.doesNotMatch(task.input_summary.source_revision, /sk-ant-/);
  assert.doesNotMatch(task.input_summary.source_revision, new RegExp(secretRevision));
  // Never in the audit report the agent reads.
  const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
  assert.doesNotMatch(audit.source_revision, /sk-ant-/);
  // Never in the persisted task JSON.
  const persisted = readFileSync(join(tasksDir, `${task.run_id}.task.json`), 'utf8');
  assert.doesNotMatch(persisted, /sk-ant-/);
  assert.doesNotMatch(persisted, new RegExp(secretRevision));
});

test('runDiagnosis scrubs the live env key from replayInstructions in the prompt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-test-'));
  const bundlePath = mkBundleFile(dir);
  const auditPath = join(dir, 'audit.json');
  const tasksDir = join(dir, 'tasks');
  // A live key value that does NOT match the sk-ant pattern, so only value-based
  // scrubbing (not the generic regex) can remove it.
  const liveKey = 'live-secret-value-42';
  let capturedPrompt = '';
  const adapter = {
    run: async (prompt) => {
      capturedPrompt = prompt;
      return { ok: true, status: 'success', stdout: JSON.stringify(validReport()), exitCode: 0 };
    },
  };
  const task = await runDiagnosis({
    bundlePath,
    auditPath,
    replayInstructions: `replay with auth ${liveKey}`,
    sourceRevision: 'r',
    tasksDir,
    adapter,
    env: { ANTHROPIC_API_KEY: liveKey },
  });
  assert.equal(task.status, 'diagnosed');
  assert.doesNotMatch(capturedPrompt, new RegExp(liveKey));
  // The persisted task must not carry the live key value anywhere.
  const persisted = readFileSync(join(tasksDir, `${task.run_id}.task.json`), 'utf8');
  assert.doesNotMatch(persisted, new RegExp(liveKey));
});

test('runDiagnosis scrubs a credential-shaped statement before it reaches the agent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-test-'));
  const bundlePath = mkBundleFile(dir);
  const auditPath = join(dir, 'audit.json');
  const tasksDir = join(dir, 'tasks');
  let capturedPrompt = '';
  const adapter = {
    run: async (prompt) => {
      capturedPrompt = prompt;
      return {
        ok: true,
        status: 'success',
        stdout: JSON.stringify(validReport()),
        exitCode: 0,
      };
    },
  };
  const task = await runDiagnosis({
    bundlePath,
    auditPath,
    replayInstructions: 'x',
    sourceRevision: 'r',
    statement: `suspicious pass near sk-ant-abc123xyz`,
    tasksDir,
    adapter,
    env: { ANTHROPIC_API_KEY: FAKE_KEY },
  });
  assert.equal(task.status, 'diagnosed');
  assert.doesNotMatch(capturedPrompt, /sk-ant-abc123xyz/);
  assert.doesNotMatch(capturedPrompt, /sk-ant-/);
});

test('runDiagnosis scrubs a ghp_ token in the statement from prompt and persisted task', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-test-'));
  const bundlePath = mkBundleFile(dir);
  const auditPath = join(dir, 'audit.json');
  const tasksDir = join(dir, 'tasks');
  const ghp = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
  let capturedPrompt = '';
  const adapter = {
    run: async (prompt) => {
      capturedPrompt = prompt;
      return {
        ok: true,
        status: 'success',
        stdout: JSON.stringify(validReport()),
        exitCode: 0,
      };
    },
  };
  const task = await runDiagnosis({
    bundlePath,
    auditPath,
    replayInstructions: 'x',
    sourceRevision: 'r',
    statement: `see token: ${ghp}`,
    tasksDir,
    adapter,
    env: { ANTHROPIC_API_KEY: FAKE_KEY },
  });
  assert.equal(task.status, 'diagnosed');
  assert.doesNotMatch(capturedPrompt, new RegExp(ghp));
  assert.doesNotMatch(capturedPrompt, /ghp_/);
  const persisted = readFileSync(join(tasksDir, `${task.run_id}.task.json`), 'utf8');
  assert.doesNotMatch(persisted, new RegExp(ghp));
  assert.doesNotMatch(persisted, /ghp_/);
});

test('validateDiagnosisReport rejects a report carrying a ghp_ token without leaking it', () => {
  const rep = validReport({ proposed_fix: 'use ghp_abcdefghijklmnopqrstuvwxyz123456 to auth' });
  const { valid, errors } = validateDiagnosisReport(rep);
  assert.equal(valid, false);
  assert.ok(errors.length >= 1);
  assert.doesNotMatch(errors.join(' '), /ghp_abcdefghijklmnopqrstuvwxyz123456/);
});

test('runDiagnosis honors an injected runId (used by the local service for 202 task_id)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-test-'));
  const bundlePath = mkBundleFile(dir);
  const auditPath = join(dir, 'audit.json');
  const tasksDir = join(dir, 'tasks');
  const adapter = {
    run: async () => ({
      ok: true,
      status: 'success',
      stdout: JSON.stringify(validReport()),
      exitCode: 0,
    }),
  };
  const task = await runDiagnosis({
    bundlePath,
    auditPath,
    replayInstructions: 'x',
    sourceRevision: 'r',
    tasksDir,
    adapter,
    env: { ANTHROPIC_API_KEY: FAKE_KEY },
    runId: 'svc-task-123',
  });
  assert.equal(task.run_id, 'svc-task-123');
  // The persisted task file uses the injected id so GET /tasks/:id can find it.
  assert.equal(existsSync(join(tasksDir, 'svc-task-123.task.json')), true);
});

test('runDiagnosis rejects a credential-shaped leak in agent output and keeps raw/task JSON clean', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-test-'));
  const bundlePath = mkBundleFile(dir);
  const auditPath = join(dir, 'audit.json');
  const tasksDir = join(dir, 'tasks');

  const leaking = {
    ...validReport(),
    proposed_fix: `use ${FAKE_KEY} to auth`,
  };
  const adapter = {
    run: async () => ({
      ok: true,
      status: 'success',
      stdout: JSON.stringify(leaking),
      exitCode: 0,
    }),
  };
  const task = await runDiagnosis({
    bundlePath,
    auditPath,
    replayInstructions: 'x',
    sourceRevision: 'r',
    tasksDir,
    adapter,
    env: { ANTHROPIC_API_KEY: FAKE_KEY },
  });
  // A credential-shaped value makes the report untrustworthy: it is rejected,
  // never persisted as a diagnosis.
  assert.equal(task.status, 'failed');
  assert.equal(task.failure_kind, 'invalid_agent_output');
  assert.equal(task.report, null);
  // Raw output is kept in a separate file, redacted.
  const raw = readFileSync(join(tasksDir, task.raw_output_ref), 'utf8');
  assert.doesNotMatch(raw, new RegExp(FAKE_KEY));
  assert.doesNotMatch(raw, /sk-ant-/);
  // Persisted task JSON never carries the key.
  const persisted = readFileSync(join(tasksDir, `${task.run_id}.task.json`), 'utf8');
  assert.doesNotMatch(persisted, new RegExp(FAKE_KEY));
  assert.doesNotMatch(persisted, /sk-ant-/);
});
