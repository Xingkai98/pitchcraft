// tools/service.mjs HTTP 单测（无真实 API / Claude / WASM）。
// 用 fake runDiagnosis 注入（参照 runner.test.mjs 的 fake 风格）；另有一例用真实
// runDiagnosis + env:{} 走 provider_unavailable（不 spawn，无 API 调用）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService, main, parseArgs } from './service.mjs';
import { verifyProblem, REPO_ROOT } from './actions.mjs';

const FAKE_KEY = 'sk-ant-fake-secret-value-0001';
const LOCAL_ORIGIN = 'http://localhost:8000';
const EVIL_ORIGIN = 'http://evil.example';

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

// A fake runDiagnosis that immediately persists a diagnosed task + audit report,
// so GET /tasks/:id can read them back. Captures the args the service passed.
function fakeRunPersisting() {
  const calls = [];
  const fake = async (args) => {
    calls.push(args);
    const task = {
      run_id: args.runId,
      status: 'diagnosed',
      report: validReport(),
      errors: [],
      input_summary: { audit_path: args.auditPath, finding_count: 1 },
      status_history: [
        { status: 'auditing', at: 't0' },
        { status: 'diagnosed', at: 't1' },
      ],
    };
    writeFileSync(join(args.tasksDir, `${args.runId}.task.json`), JSON.stringify(task));
    writeFileSync(
      args.auditPath,
      JSON.stringify({
        findings: [
          { detector_id: 'unforced_out', event_index: 3, match_time: 12.5, severity: 'realism_warning' },
        ],
      })
    );
    return task;
  };
  return { fake, calls };
}

async function startService(opts) {
  const server = createService(opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

const closeServer = (server) => new Promise((r) => server.close(r));

test('POST /observations returns 202 { task_id } and hands the bundle to runDiagnosis', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { fake, calls } = fakeRunPersisting();
  const { server, base } = await startService({ tasksDir: dir, runDiagnosisFn: fake });
  try {
    const res = await fetch(`${base}/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify(validBundle()),
    });
    assert.equal(res.status, 202);
    assert.equal(res.headers.get('access-control-allow-origin'), LOCAL_ORIGIN);
    const data = await res.json();
    assert.ok(data.task_id, '202 must carry a task_id');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].runId, data.task_id);
    assert.equal(calls[0].tasksDir, dir);
    assert.equal(calls[0].bundlePath, join(dir, `${data.task_id}.bundle.json`));
    assert.equal(calls[0].auditPath, join(dir, `${data.task_id}.audit.json`));
    // The submitted bundle is persisted for replay.
    const saved = JSON.parse(readFileSync(calls[0].bundlePath, 'utf8'));
    assert.equal(saved.observation_id, 'obs-1');
  } finally {
    await closeServer(server);
  }
});

test('POST rejects an invalid bundle with 400 without calling runDiagnosis', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { fake, calls } = fakeRunPersisting();
  const { server, base } = await startService({ tasksDir: dir, runDiagnosisFn: fake });
  try {
    const bad = validBundle();
    delete bad.audit_input;
    const res = await fetch(`${base}/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify(bad),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, 'invalid observation bundle');
    assert.ok(data.errors.some((e) => /missing required field: audit_input/.test(e)));
    assert.equal(calls.length, 0);
  } finally {
    await closeServer(server);
  }
});

test('POST rejects a bundle carrying a credential with 400 and never leaks the value', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { fake, calls } = fakeRunPersisting();
  const { server, base } = await startService({ tasksDir: dir, runDiagnosisFn: fake });
  try {
    const leaking = validBundle();
    leaking.api_key = FAKE_KEY;
    const res = await fetch(`${base}/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify(leaking),
    });
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.match(text, /credential/);
    assert.doesNotMatch(text, new RegExp(FAKE_KEY));
    assert.doesNotMatch(text, /sk-ant-/);
    assert.equal(calls.length, 0);
  } finally {
    await closeServer(server);
  }
});

test('POST rejects non-JSON and non-object bodies with 400', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { fake, calls } = fakeRunPersisting();
  const { server, base } = await startService({ tasksDir: dir, runDiagnosisFn: fake });
  try {
    for (const body of ['not json {{{', JSON.stringify([1, 2])]) {
      const res = await fetch(`${base}/observations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
        body,
      });
      assert.equal(res.status, 400, `body ${body.slice(0, 20)} should 400`);
    }
    assert.equal(calls.length, 0);
  } finally {
    await closeServer(server);
  }
});

test('POST enforces the request body size limit with 413', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { fake, calls } = fakeRunPersisting();
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: fake,
    maxBodyBytes: 100,
  });
  try {
    const big = validBundle();
    big.statement = 'x'.repeat(500);
    const res = await fetch(`${base}/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify(big),
    });
    assert.equal(res.status, 413);
    assert.equal(calls.length, 0);
  } finally {
    await closeServer(server);
  }
});

test('POST from a non-localhost Origin is rejected with 403 and no CORS headers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { fake, calls } = fakeRunPersisting();
  const { server, base } = await startService({ tasksDir: dir, runDiagnosisFn: fake });
  try {
    const res = await fetch(`${base}/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: EVIL_ORIGIN },
      body: JSON.stringify(validBundle()),
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(calls.length, 0);
  } finally {
    await closeServer(server);
  }
});

test('POST without an Origin (curl-style local client) is allowed but gets no CORS headers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { fake, calls } = fakeRunPersisting();
  const { server, base } = await startService({ tasksDir: dir, runDiagnosisFn: fake });
  try {
    const res = await fetch(`${base}/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBundle()),
    });
    assert.equal(res.status, 202);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(calls.length, 1);
  } finally {
    await closeServer(server);
  }
});

test('GET /tasks/:id returns the persisted redacted task with findings for polling', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { fake } = fakeRunPersisting();
  const { server, base } = await startService({ tasksDir: dir, runDiagnosisFn: fake });
  try {
    const post = await fetch(`${base}/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify(validBundle()),
    });
    const { task_id } = await post.json();
    const res = await fetch(`${base}/tasks/${task_id}`, { headers: { Origin: LOCAL_ORIGIN } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), LOCAL_ORIGIN);
    const data = await res.json();
    assert.equal(data.task_id, task_id);
    assert.equal(data.status, 'diagnosed');
    assert.equal(data.report.root_cause, 'engine/src/lib.rs: unforced out pressure gate misconfigured');
    assert.equal(data.findings.length, 1);
    assert.equal(data.findings[0].detector_id, 'unforced_out');
    // The polling response is whitelisted: internal paths / runner config never
    // leak through the service.
    assert.equal(data.input_summary, undefined);
    assert.equal(data.provider, undefined);
    assert.equal(data.started_at, undefined);
    assert.equal(data.ended_at, undefined);
    assert.equal(data.raw_output_ref, undefined);
    assert.equal(data.command_exit_status, undefined);
    assert.equal(data.retries, undefined);
  } finally {
    await closeServer(server);
  }
});

// --- P18：GET /tasks/:id 暴露 bundle 的 statement（页面刷新回填的权威源）---
test('GET /tasks/:id returns the bundle statement so the page can refill it (P18)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { fake } = fakeRunPersisting();
  const { server, base } = await startService({ tasksDir: dir, runDiagnosisFn: fake });
  try {
    const post = await fetch(`${base}/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ ...validBundle(), statement: '球员射门偏出太多了' }),
    });
    const { task_id } = await post.json();
    const res = await fetch(`${base}/tasks/${task_id}`, { headers: { Origin: LOCAL_ORIGIN } });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.statement, '球员射门偏出太多了');
  } finally {
    await closeServer(server);
  }
});

test('GET /tasks/:id distinguishes an empty bundle statement from a missing one (P18)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { fake } = fakeRunPersisting();
  const { server, base } = await startService({ tasksDir: dir, runDiagnosisFn: fake });
  try {
    const post = await fetch(`${base}/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ ...validBundle(), statement: '' }),
    });
    const { task_id } = await post.json();
    const res = await fetch(`${base}/tasks/${task_id}`, { headers: { Origin: LOCAL_ORIGIN } });
    const data = await res.json();
    // 空串（用户清空描述）不同于 null（无 bundle）——页面据此决定是否覆盖本地值。
    assert.equal(data.statement, '');
  } finally {
    await closeServer(server);
  }
});

test('P14 queue-only captured task still exposes its bundle statement (P18)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { server, base } = await startService({ tasksDir: dir, runDiagnosisFn: async () => {}, queueOnly: true });
  try {
    // queue-only 任务停在 captured（同一次请求里就落盘），此时页面已在轮询——
    // statement 必须随第一个响应就能回填，不能等到有人取走任务。
    const post = await fetch(`${base}/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ ...validBundle(), statement: '右路内切太少' }),
    });
    const { task_id } = await post.json();
    const res = await fetch(`${base}/tasks/${task_id}`, { headers: { Origin: LOCAL_ORIGIN } });
    const data = await res.json();
    assert.equal(data.status, 'captured');
    assert.equal(data.statement, '右路内切太少');
  } finally {
    await closeServer(server);
  }
});

test('GET /tasks/:id returns a null statement when the bundle is missing (P18)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { server, base } = await startService({ tasksDir: dir, runDiagnosisFn: async () => {} });
  try {
    // 只落 task 文件、不落 bundle（例如 bundle 被清理）：任务仍可轮询，但描述无从得知。
    writeFileSync(
      join(dir, 't-no-bundle.task.json'),
      JSON.stringify({ run_id: 't-no-bundle', status: 'captured', errors: [], status_history: [] })
    );
    const res = await fetch(`${base}/tasks/t-no-bundle`, { headers: { Origin: LOCAL_ORIGIN } });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.statement, null);
  } finally {
    await closeServer(server);
  }
});

test('GET /tasks/:id redacts credential-shaped text in the bundle statement (P18)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  // POST 的 bundle 校验会拒收含凭证的 statement，所以这里直接落盘模拟「绕过提交路径
  // 写入的 bundle」（历史/导入文件）。读取时统一过 redactKey 是这层兜底的意义所在。
  writeFileSync(
    join(dir, 't-stale.task.json'),
    JSON.stringify({ run_id: 't-stale', status: 'captured', errors: [], status_history: [] })
  );
  writeFileSync(join(dir, 't-stale.bundle.json'), JSON.stringify({ statement: `key 是 ${FAKE_KEY}` }));
  const { server, base } = await startService({ tasksDir: dir, runDiagnosisFn: async () => {}, env: { ANTHROPIC_API_KEY: FAKE_KEY } });
  try {
    const res = await fetch(`${base}/tasks/t-stale`, { headers: { Origin: LOCAL_ORIGIN } });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(!data.statement.includes(FAKE_KEY), 'statement 不得含存活凭证');
    assert.match(data.statement, /\[REDACTED\]/);
  } finally {
    await closeServer(server);
  }
});

test('GET /tasks/:id returns a synthetic auditing status before the task file exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  // A fake that never persists anything — the bundle file exists but the task
  // file is absent, so the service answers 'auditing' instead of 404.
  const fake = async () => ({ run_id: 'ignored', status: 'auditing' });
  const { server, base } = await startService({ tasksDir: dir, runDiagnosisFn: fake });
  try {
    const post = await fetch(`${base}/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ ...validBundle(), statement: '合成状态下的描述' }),
    });
    const { task_id } = await post.json();
    const res = await fetch(`${base}/tasks/${task_id}`, { headers: { Origin: LOCAL_ORIGIN } });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'auditing');
    assert.deepEqual(data.findings, []);
    // P18：合成响应这条路径同样要带 statement——页面在任务刚提交、task 文件还没落盘的
    // 窗口里就在轮询，这时描述必须已经可回填，不能等任务真正开始跑。
    assert.equal(data.statement, '合成状态下的描述');
  } finally {
    await closeServer(server);
  }
});

test('GET /tasks/:id returns 404 for an unknown task and rejects path-traversal ids', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { server, base } = await startService({ tasksDir: dir, runDiagnosisFn: async () => {} });
  try {
    const notFound = await fetch(`${base}/tasks/does-not-exist`, { headers: { Origin: LOCAL_ORIGIN } });
    assert.equal(notFound.status, 404);
    for (const id of ['../..', '..%2F..', 'a/b']) {
      const r = await fetch(`${base}/tasks/${encodeURIComponent(id)}`, { headers: { Origin: LOCAL_ORIGIN } });
      assert.equal(r.status, 404, `id ${id} must not resolve outside tasksDir`);
    }
  } finally {
    await closeServer(server);
  }
});

test('OPTIONS preflight echoes a localhost Origin with 204', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { server, base } = await startService({ tasksDir: dir, runDiagnosisFn: async () => {} });
  try {
    const res = await fetch(`${base}/observations`, { method: 'OPTIONS', headers: { Origin: LOCAL_ORIGIN } });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), LOCAL_ORIGIN);
    assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, PATCH, DELETE, OPTIONS');
    assert.equal(res.headers.get('access-control-allow-headers'), 'Content-Type');
  } finally {
    await closeServer(server);
  }
});

test('OPTIONS preflight from a non-localhost Origin is rejected without CORS headers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { server, base } = await startService({ tasksDir: dir, runDiagnosisFn: async () => {} });
  try {
    const res = await fetch(`${base}/observations`, { method: 'OPTIONS', headers: { Origin: EVIL_ORIGIN } });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  } finally {
    await closeServer(server);
  }
});

test('parseArgs collects repeatable --allow-origin and --host', () => {
  const opts = parseArgs([
    '--tasks-dir', '/tmp/x',
    '--host', '0.0.0.0',
    '--allow-origin', 'http://100.114.76.34:8000',
    '--allow-origin', 'http://100.114.76.35:8000',
  ]);
  assert.equal(opts.host, '0.0.0.0');
  assert.deepEqual(opts.allowOrigin, ['http://100.114.76.34:8000', 'http://100.114.76.35:8000']);
  assert.equal(opts.tasksDir, '/tmp/x');
});

test('POST from an allow-listed Origin echoes CORS and starts the task', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { fake, calls } = fakeRunPersisting();
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: fake,
    allowedOrigins: ['http://100.114.76.34:8000'],
  });
  try {
    const res = await fetch(`${base}/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://100.114.76.34:8000' },
      body: JSON.stringify(validBundle()),
    });
    assert.equal(res.status, 202);
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://100.114.76.34:8000');
    assert.equal(calls.length, 1);
  } finally {
    await closeServer(server);
  }
});

test('an Origin outside the allowlist is still rejected without CORS headers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { fake, calls } = fakeRunPersisting();
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: fake,
    allowedOrigins: ['http://100.114.76.34:8000'],
  });
  try {
    const res = await fetch(`${base}/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
      body: JSON.stringify(validBundle()),
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(calls.length, 0);
  } finally {
    await closeServer(server);
  }
});

test('main passes --host to listen (Tailscale 0.0.0.0 scenario)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const captured = {};
  await main(
    ['--tasks-dir', dir, '--host', '0.0.0.0', '--allow-origin', 'http://100.114.76.34:8000'],
    {
      log: () => {},
      listen: (server, port, host, cb) => {
        captured.port = port;
        captured.host = host;
        cb();
      },
    }
  );
  assert.equal(captured.host, '0.0.0.0');
  assert.equal(captured.port, 8787); // --port not given -> default
});

test('unknown paths return 404', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { server, base } = await startService({ tasksDir: dir, runDiagnosisFn: async () => {} });
  try {
    const res = await fetch(`${base}/nope`, { headers: { Origin: LOCAL_ORIGIN } });
    assert.equal(res.status, 404);
  } finally {
    await closeServer(server);
  }
});

test('service + real runDiagnosis reaches provider_unavailable with no API key (no spawn)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { server, base } = await startService({ tasksDir: dir, env: {} });
  try {
    const post = await fetch(`${base}/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify(validBundle()),
    });
    assert.equal(post.status, 202);
    const { task_id } = await post.json();
    let status = null;
    for (let i = 0; i < 20; i++) {
      const r = await fetch(`${base}/tasks/${task_id}`);
      const data = await r.json();
      status = data.status;
      if (['diagnosed', 'insufficient_evidence', 'provider_unavailable', 'failed'].includes(status)) break;
      await new Promise((r2) => setTimeout(r2, 50));
    }
    assert.equal(status, 'provider_unavailable');
    // The deterministic audit still produced a report the page can review.
    assert.equal(existsSync(join(dir, `${task_id}.audit.json`)), true);
  } finally {
    await closeServer(server);
  }
});

test('service survives a malformed request URL with 400 and keeps serving', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { server, base } = await startService({ tasksDir: dir, runDiagnosisFn: async () => {} });
  try {
    const port = new URL(base).port;
    // absolute-form request-target with an invalid port -> `new URL` throws;
    // the handler must answer 400 instead of crashing the process.
    const status = await new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: 'http://localhost:badport/x',
          method: 'GET',
          headers: { Origin: LOCAL_ORIGIN },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        }
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 400);
    // The process survived: a normal request still works afterwards.
    const ok = await fetch(`${base}/nope`);
    assert.equal(ok.status, 404);
  } finally {
    await closeServer(server);
  }
});

test('POST rejects a streamed chunked oversized body with 413 (no content-length)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { fake, calls } = fakeRunPersisting();
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: fake,
    maxBodyBytes: 100,
  });
  try {
    const port = new URL(base).port;
    const status = await new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/observations',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        }
      );
      req.on('error', reject);
      // No Content-Length -> Node sends chunked; write in separate chunks that
      // cross the limit only after streaming starts.
      const body = JSON.stringify(validBundle());
      req.write(body.slice(0, 20));
      setImmediate(() => {
        req.write('x'.repeat(200));
        req.end();
      });
    });
    assert.equal(status, 413);
    assert.equal(calls.length, 0);
  } finally {
    await closeServer(server);
  }
});

// --- P11 problem lifecycle endpoints (tasks 2.1/2.2/3.2) ----------------------

// 确定性 problem id 工厂：每次调用返回递增 id。
function problemIdFactory() {
  let seq = 0;
  return () => `prob-svc-${++seq}`;
}

// fake gh issue creator：直接返回给定结果（或按 (problem, opts) 计算）。
function fakeGithubIssue(result) {
  return async (problem, opts) => {
    if (typeof result === 'function') return result(problem, opts);
    return result;
  };
}

test('problems CRUD: manual create/list/detail/patch and wontfix requires reason', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
  });
  try {
    // manual create → discuss/open, source null
    const post = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ title: 'long passes are too accurate', description: 'seen in seed 42' }),
    });
    assert.equal(post.status, 201);
    assert.equal(post.headers.get('access-control-allow-origin'), LOCAL_ORIGIN);
    const created = await post.json();
    assert.equal(created.triage, 'discuss');
    assert.equal(created.status, 'open');
    assert.equal(created.source, null);
    assert.equal(created.github, null);
    assert.equal(created.decisions.length, 1);

    // list
    const list = await fetch(`${base}/problems`, { headers: { Origin: LOCAL_ORIGIN } });
    assert.equal(list.status, 200);
    const { problems } = await list.json();
    assert.equal(problems.length, 1);
    assert.equal(problems[0].id, created.id);

    // detail
    const detail = await fetch(`${base}/problems/${created.id}`, { headers: { Origin: LOCAL_ORIGIN } });
    assert.equal(detail.status, 200);
    const got = await detail.json();
    assert.equal(got.title, 'long passes are too accurate');
    assert.equal(got.status, 'open');

    // patch title + status → decisions trail grows
    const patch = await fetch(`${base}/problems/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ title: 'renamed', status: 'in_progress' }),
    });
    assert.equal(patch.status, 200);
    const updated = await patch.json();
    assert.equal(updated.title, 'renamed');
    assert.equal(updated.status, 'in_progress');
    assert.equal(updated.decisions.length, 2);
    assert.equal(updated.decisions.at(-1).action, 'status:in_progress');

    // wontfix without reason → 400; with reason → 200 closed
    const noReason = await fetch(`${base}/problems/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ triage: 'wontfix' }),
    });
    assert.equal(noReason.status, 400);
    const withReason = await fetch(`${base}/problems/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ triage: 'wontfix', reason: 'accepted behavior' }),
    });
    assert.equal(withReason.status, 200);
    const wf = await withReason.json();
    assert.equal(wf.triage, 'wontfix');
    assert.equal(wf.status, 'closed');
    assert.equal(wf.decisions.at(-1).action, 'wontfix');

    // invalid triage → 400
    const badTriage = await fetch(`${base}/problems/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ triage: 'nope' }),
    });
    assert.equal(badTriage.status, 400);
  } finally {
    await closeServer(server);
  }
});

test('POST /problems creates from a diagnosed task report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const fake = async (args) => {
    const task = {
      run_id: args.runId,
      status: 'diagnosed',
      report: validReport({
        phenomenon_summary: 'wingers never cut inside',
        triage: { category: 'design', rationale: 'missing cut-inside mechanism', confidence: 0.8 },
      }),
      errors: [],
      input_summary: { audit_path: args.auditPath },
      status_history: [
        { status: 'auditing', at: 't0' },
        { status: 'diagnosed', at: 't1' },
      ],
    };
    writeFileSync(join(args.tasksDir, `${args.runId}.task.json`), JSON.stringify(task));
    return task;
  };
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: fake,
    newProblemId: problemIdFactory(),
  });
  try {
    const obs = await fetch(`${base}/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({
        ...validBundle(),
        statement: 'wingers never cut inside on the right flank',
      }),
    });
    const { task_id } = await obs.json();
    const res = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ task_id }),
    });
    assert.equal(res.status, 201);
    const problem = await res.json();
    assert.equal(problem.title, 'wingers never cut inside');
    assert.equal(problem.triage, 'design');
    assert.equal(problem.status, 'open');
    assert.equal(problem.source.task_id, task_id);
    assert.equal(problem.source.observation_id, 'obs-1');
    assert.equal(problem.source.report.root_cause, 'engine/src/lib.rs: unforced out pressure gate misconfigured');
    // 描述 = 用户描述 + 现象 + 证据摘要（spec scenario）。
    assert.match(problem.description, /用户描述: wingers never cut inside on the right flank/);
    assert.match(problem.description, /现象: wingers never cut inside/);
    assert.match(problem.description, /根因:/);
    // 列表里能看到。
    const list = await fetch(`${base}/problems`, { headers: { Origin: LOCAL_ORIGIN } });
    const { problems } = await list.json();
    assert.equal(problems.length, 1);

    // 未知 / 未 diagnosed 的 task_id → 400
    const missing = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ task_id: 'does-not-exist' }),
    });
    assert.equal(missing.status, 400);
  } finally {
    await closeServer(server);
  }
});

test('POST /problems rejects empty bodies and non-object payloads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
  });
  try {
    for (const body of ['', '[]', '{"foo":1}']) {
      const res = await fetch(`${base}/problems`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
        body,
      });
      assert.equal(res.status, 400, `body ${JSON.stringify(body)} should 400`);
    }
  } finally {
    await closeServer(server);
  }
});

test('problems discussion redacts credential-shaped text before storing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
  });
  try {
    const post = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ title: 'discuss this' }),
    });
    const problem = await post.json();
    const res = await fetch(`${base}/problems/${problem.id}/discussion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ author: 'user', text: `please see sk-ant-fake-secret-value-0001 attached` }),
    });
    assert.equal(res.status, 200);
    const updated = await res.json();
    assert.equal(updated.discussion.length, 1);
    assert.match(updated.discussion[0].text, /\[REDACTED\]/);
    assert.doesNotMatch(updated.discussion[0].text, /sk-ant-fake-secret-value-0001/);
    // 落盘后读回仍是净化文本。
    const detail = await fetch(`${base}/problems/${problem.id}`, { headers: { Origin: LOCAL_ORIGIN } });
    const got = await detail.json();
    assert.match(got.discussion[0].text, /\[REDACTED\]/);
    // 缺 author/text → 400
    const bad = await fetch(`${base}/problems/${problem.id}/discussion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ author: '', text: '' }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await closeServer(server);
  }
});

test('problems persist sanitizes generic credential shapes (client_secret) in description and discussion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
  });
  try {
    // 人工创建 description 含 JSON 风格 client_secret → 落盘净化（读回已抹值）。
    const post = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ title: 'x', description: 'leak "client_secret":"s3cret-value"' }),
    });
    assert.equal(post.status, 201);
    const created = await post.json();
    const detail = await fetch(`${base}/problems/${created.id}`, { headers: { Origin: LOCAL_ORIGIN } });
    const got = await detail.json();
    assert.doesNotMatch(got.description, /s3cret-value/);
    assert.match(got.description, /\[REDACTED\]/);

    // 讨论 text 含 client_secret → 落盘净化。
    const disc = await fetch(`${base}/problems/${created.id}/discussion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ author: 'user', text: '{"client_secret":"topsecret"}' }),
    });
    assert.equal(disc.status, 200);
    const detail2 = await fetch(`${base}/problems/${created.id}`, { headers: { Origin: LOCAL_ORIGIN } });
    const got2 = await detail2.json();
    assert.doesNotMatch(got2.discussion[0].text, /topsecret/);
    assert.match(got2.discussion[0].text, /\[REDACTED\]/);
  } finally {
    await closeServer(server);
  }
});

test('problems endpoints: 404 for unknown ids, 403 for non-localhost origins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
  });
  try {
    assert.equal((await fetch(`${base}/problems/nope`, { headers: { Origin: LOCAL_ORIGIN } })).status, 404);
    assert.equal(
      (
        await fetch(`${base}/problems/nope`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
          body: JSON.stringify({ status: 'fixed' }),
        })
      ).status,
      404
    );
    assert.equal(
      (
        await fetch(`${base}/problems/nope/discussion`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
          body: JSON.stringify({ author: 'a', text: 't' }),
        })
      ).status,
      404
    );
    // 非法 triage/status 筛选 → 400。
    const badFilter = await fetch(`${base}/problems?triage=nope`, { headers: { Origin: LOCAL_ORIGIN } });
    assert.equal(badFilter.status, 400);
    // 非本机 origin 一律 403，无 CORS 头。
    const evil = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: EVIL_ORIGIN },
      body: JSON.stringify({ title: 'x' }),
    });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
  } finally {
    await closeServer(server);
  }
});

test('POST /problems/:id/github writes the github ref on success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  let received = null;
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
    createGithubIssueFn: fakeGithubIssue(async (problem, { repo, dryRun }) => {
      received = { problem, repo, dryRun };
      return { ok: true, issue_number: 42, url: 'https://github.com/owner/repo/issues/42' };
    }),
  });
  try {
    const post = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ title: 'bug one', triage: 'bug' }),
    });
    const problem = await post.json();
    const res = await fetch(`${base}/problems/${problem.id}/github`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ repo: 'owner/repo' }),
    });
    assert.equal(res.status, 200);
    const updated = await res.json();
    assert.equal(updated.github.issue_number, 42);
    assert.equal(updated.github.url, 'https://github.com/owner/repo/issues/42');
    assert.ok(updated.github.synced_at);
    // fake 收到了 problem 与 repo/dryRun 参数。
    assert.equal(received.problem.id, problem.id);
    assert.equal(received.repo, 'owner/repo');
    assert.equal(received.dryRun, false);
    // 持久化读回一致。
    const detail = await fetch(`${base}/problems/${problem.id}`, { headers: { Origin: LOCAL_ORIGIN } });
    assert.equal((await detail.json()).github.issue_number, 42);
  } finally {
    await closeServer(server);
  }
});

test('POST /problems/:id/github failure returns an error and keeps the problem unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
    createGithubIssueFn: fakeGithubIssue({ ok: false, error: 'gh 未登录：请先运行 gh auth login' }),
  });
  try {
    const post = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ title: 'bug one', triage: 'bug' }),
    });
    const problem = await post.json();
    const res = await fetch(`${base}/problems/${problem.id}/github`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: '{}',
    });
    assert.equal(res.status, 502);
    const data = await res.json();
    assert.match(data.error, /gh 未登录/);
    // Problem 保持原状。
    const detail = await fetch(`${base}/problems/${problem.id}`, { headers: { Origin: LOCAL_ORIGIN } });
    assert.equal((await detail.json()).github, null);
  } finally {
    await closeServer(server);
  }
});

test('POST /problems/:id/github dryRun returns ok without writing the ref', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  let receivedDryRun = null;
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
    createGithubIssueFn: fakeGithubIssue(async (problem, { dryRun }) => {
      receivedDryRun = dryRun;
      return { ok: true, dryRun: true, repo: 'owner/repo', args: ['issue', 'create'] };
    }),
  });
  try {
    const post = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ title: 'bug one', triage: 'bug' }),
    });
    const problem = await post.json();
    const res = await fetch(`${base}/problems/${problem.id}/github`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ dryRun: true }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.dryRun, true);
    assert.equal(receivedDryRun, true);
    // 未回写 github 引用。
    const detail = await fetch(`${base}/problems/${problem.id}`, { headers: { Origin: LOCAL_ORIGIN } });
    assert.equal((await detail.json()).github, null);
  } finally {
    await closeServer(server);
  }
});

// --- P12 problem ops endpoints（rerun / delete / import）-----------------------

// 直接写一个终态 diagnosed 任务（bundle + task 文件），供 import / rerun 复用。
function writeDiagnosedTask(dir, taskId, report) {
  writeFileSync(join(dir, `${taskId}.bundle.json`), JSON.stringify(validBundle()));
  writeFileSync(join(dir, `${taskId}.task.json`), JSON.stringify({
    run_id: taskId,
    status: 'diagnosed',
    report,
    errors: [],
    status_history: [
      { status: 'auditing', at: 't0' },
      { status: 'diagnosed', at: 't1' },
    ],
  }));
}

// fake runDiagnosis：落一个新 task 文件并返回带新 report 的任务（服务端据此写回
// problem.source.report）。记录收到的 args。
function fakeRerunDiagnosing(newReport) {
  const calls = [];
  const fake = async (args) => {
    calls.push(args);
    const task = {
      run_id: args.runId,
      status: 'diagnosed',
      report: newReport,
      errors: [],
      status_history: [
        { status: 'auditing', at: 't0' },
        { status: 'diagnosed', at: 't1' },
      ],
    };
    writeFileSync(join(args.tasksDir, `${args.runId}.task.json`), JSON.stringify(task));
    writeFileSync(args.auditPath, JSON.stringify({ findings: [] }));
    return task;
  };
  return { fake, calls };
}

test('DELETE /problems/:id removes the problem (200) and 404s when missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
  });
  try {
    const post = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ title: 'to delete' }),
    });
    const problem = await post.json();
    const del = await fetch(`${base}/problems/${problem.id}`, {
      method: 'DELETE',
      headers: { Origin: LOCAL_ORIGIN },
    });
    assert.equal(del.status, 200);
    assert.equal(del.headers.get('access-control-allow-origin'), LOCAL_ORIGIN);
    assert.deepEqual(await del.json(), { ok: true });
    // 列表不再包含；详情 404。
    const list = await fetch(`${base}/problems`, { headers: { Origin: LOCAL_ORIGIN } });
    assert.equal((await list.json()).problems.length, 0);
    assert.equal(
      (await fetch(`${base}/problems/${problem.id}`, { headers: { Origin: LOCAL_ORIGIN } })).status,
      404
    );
    // 幂等：再次删除 → 404。
    const del2 = await fetch(`${base}/problems/${problem.id}`, {
      method: 'DELETE',
      headers: { Origin: LOCAL_ORIGIN },
    });
    assert.equal(del2.status, 404);
    // 未知 / 非法 id → 404。
    assert.equal(
      (await fetch(`${base}/problems/nope`, { method: 'DELETE', headers: { Origin: LOCAL_ORIGIN } })).status,
      404
    );
    assert.equal(
      (await fetch(`${base}/problems/..%2Fx`, { method: 'DELETE', headers: { Origin: LOCAL_ORIGIN } })).status,
      404
    );
  } finally {
    await closeServer(server);
  }
});

test('POST /problems/:id/rerun returns 202, repoints the problem, and writes the new report back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const oldReport = validReport({ phenomenon_summary: 'old phenomenon' });
  const newReport = validReport({ phenomenon_summary: 'new phenomenon' });
  writeDiagnosedTask(dir, 'task-a', oldReport);
  const { fake, calls } = fakeRerunDiagnosing(newReport);
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: fake,
    newProblemId: problemIdFactory(),
  });
  try {
    const create = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ task_id: 'task-a' }),
    });
    assert.equal(create.status, 201);
    const problem = await create.json();
    assert.equal(problem.source.task_id, 'task-a');
    assert.equal(problem.source.report.phenomenon_summary, 'old phenomenon');

    const rerun = await fetch(`${base}/problems/${problem.id}/rerun`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ reason: 'engine changed' }),
    });
    assert.equal(rerun.status, 202);
    assert.equal(rerun.headers.get('access-control-allow-origin'), LOCAL_ORIGIN);
    const { task_id } = await rerun.json();
    assert.ok(task_id);
    assert.notEqual(task_id, 'task-a');

    // 关联立即更新为新任务 + decisions 追加 rerun（含 reason）。
    const detail = await fetch(`${base}/problems/${problem.id}`, { headers: { Origin: LOCAL_ORIGIN } });
    const updated = await detail.json();
    assert.equal(updated.source.task_id, task_id);
    assert.equal(updated.decisions.at(-1).action, 'rerun');
    assert.equal(updated.decisions.at(-1).reason, 'engine changed');

    // 后台 fake 收到新 runId，bundle 内容来自旧任务。
    assert.equal(calls.length, 1);
    assert.equal(calls[0].runId, task_id);
    assert.equal(calls[0].bundlePath, join(dir, `${task_id}.bundle.json`));
    const saved = JSON.parse(readFileSync(calls[0].bundlePath, 'utf8'));
    assert.equal(saved.observation_id, 'obs-1');

    // 终态后新报告写回 problem（轮询直到写回完成）。
    let latest = null;
    for (let i = 0; i < 20; i++) {
      const r = await fetch(`${base}/problems/${problem.id}`, { headers: { Origin: LOCAL_ORIGIN } });
      latest = await r.json();
      if (latest.source?.report?.phenomenon_summary === 'new phenomenon') break;
      await new Promise((r2) => setTimeout(r2, 25));
    }
    assert.equal(latest.source.report.phenomenon_summary, 'new phenomenon');
    assert.equal(latest.source.task_id, task_id);
  } finally {
    await closeServer(server);
  }
});

test('POST /problems/:id/rerun returns 400 when the source task has no bundle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
  });
  try {
    // 人工创建 → 无 source.task_id → 400。
    const manual = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ title: 'manual' }),
    });
    const manualProblem = await manual.json();
    const res1 = await fetch(`${base}/problems/${manualProblem.id}/rerun`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: '{}',
    });
    assert.equal(res1.status, 400);
    assert.match((await res1.json()).error, /no bundle for rerun/);
    // 问题不变。
    const unchanged = await fetch(`${base}/problems/${manualProblem.id}`, { headers: { Origin: LOCAL_ORIGIN } });
    assert.equal((await unchanged.json()).source, null);

    // 从诊断任务创建后删除 bundle → 400。
    writeDiagnosedTask(dir, 'task-b', validReport());
    const created = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ task_id: 'task-b' }),
    });
    const p = await created.json();
    unlinkSync(join(dir, 'task-b.bundle.json'));
    const res2 = await fetch(`${base}/problems/${p.id}/rerun`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: '{}',
    });
    assert.equal(res2.status, 400);
    assert.match((await res2.json()).error, /no bundle for rerun/);
  } finally {
    await closeServer(server);
  }
});

test('POST /problems/:id/rerun returns 404 for an unknown problem', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { server, base } = await startService({ tasksDir: dir, runDiagnosisFn: async () => {} });
  try {
    const res = await fetch(`${base}/problems/nope/rerun`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: '{}',
    });
    assert.equal(res.status, 404);
  } finally {
    await closeServer(server);
  }
});

test('POST /problems/:id/rerun rejects a path-traversal source task id with 400', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { server, base } = await startService({ tasksDir: dir, runDiagnosisFn: async () => {} });
  try {
    mkdirSync(join(dir, 'problems'), { recursive: true });
    writeFileSync(
      join(dir, 'problems', 'prob-x.json'),
      JSON.stringify({
        id: 'prob-x',
        title: 'x',
        source: { task_id: '../evil' },
        triage: 'bug',
        status: 'open',
        decisions: [],
        discussion: [],
        github: null,
        change_ref: null,
        created_at: 't',
        updated_at: 't',
      })
    );
    const res = await fetch(`${base}/problems/prob-x/rerun`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: '{}',
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /no bundle for rerun/);
  } finally {
    await closeServer(server);
  }
});

test('POST /problems/import scans diagnosed tasks, skips linked, and creates the rest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  writeDiagnosedTask(dir, 't-1', validReport({ phenomenon_summary: 'pheno one' }));
  writeDiagnosedTask(dir, 't-2', validReport({ phenomenon_summary: 'pheno two' }));
  writeDiagnosedTask(dir, 't-3', validReport({ phenomenon_summary: 'pheno three' }));
  // t-failed 不是候选（不导入也不报失败）。
  writeFileSync(
    join(dir, 't-failed.task.json'),
    JSON.stringify({ run_id: 't-failed', status: 'failed', report: null, errors: ['x'], status_history: [] })
  );
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
  });
  try {
    // 先手工把 t-1 关联到问题。
    const create = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ task_id: 't-1' }),
    });
    assert.equal(create.status, 201);

    const res = await fetch(`${base}/problems/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: '{}',
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), LOCAL_ORIGIN);
    const data = await res.json();
    assert.equal(data.created.length, 2);
    assert.deepEqual(data.skipped, ['t-1']);
    assert.deepEqual(data.failed, []);

    const list = await fetch(`${base}/problems`, { headers: { Origin: LOCAL_ORIGIN } });
    const { problems } = await list.json();
    assert.equal(problems.length, 3);
  } finally {
    await closeServer(server);
  }
});

test('POST /problems/import with explicit task_ids reports failed for missing/undiagnosed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  writeDiagnosedTask(dir, 't-1', validReport());
  writeFileSync(
    join(dir, 't-failed.task.json'),
    JSON.stringify({ run_id: 't-failed', status: 'failed', report: null, errors: [], status_history: [] })
  );
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
  });
  try {
    const res = await fetch(`${base}/problems/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ task_ids: ['t-1', 't-failed', 't-missing'] }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.created.length, 1);
    assert.deepEqual(data.skipped, []);
    assert.deepEqual(data.failed, [
      { task_id: 't-failed', error: 'task not diagnosed or missing' },
      { task_id: 't-missing', error: 'task not diagnosed or missing' },
    ]);
  } finally {
    await closeServer(server);
  }
});

test('POST /problems/import validates task_ids and rejects bad shapes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
  });
  try {
    // 非法 task_id 格式 → 400。
    const badId = await fetch(`${base}/problems/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ task_ids: ['../x'] }),
    });
    assert.equal(badId.status, 400);
    // task_ids 不是数组 → 400。
    const notArray = await fetch(`${base}/problems/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ task_ids: 't-1' }),
    });
    assert.equal(notArray.status, 400);
    // 空 body → 缺省扫描（无任务 → created 空）。
    const empty = await fetch(`${base}/problems/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: '{}',
    });
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { created: [], skipped: [], failed: [] });
  } finally {
    await closeServer(server);
  }
});

test('POST /problems/import skips tasks linked by a previous import (no duplicates)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  writeDiagnosedTask(dir, 't-1', validReport());
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
  });
  try {
    const first = await fetch(`${base}/problems/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: '{}',
    });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).created.length, 1);

    const second = await fetch(`${base}/problems/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: '{}',
    });
    assert.deepEqual(await second.json(), { created: [], skipped: ['t-1'], failed: [] });
  } finally {
    await closeServer(server);
  }
});

// --- P13 problem action endpoints（verify / fix / merge-fix）-------------------

// 真实 verifyProblem + fake exec（不 spawn 子进程）：verify 端点全链路可测。
const verifyWithExec = (exec) => async (problem, opts) =>
  verifyProblem(problem, { ...opts, exec });

const verifyExecOk = (stdout = 'ok') => async () => ({ stdout, stderr: '', code: 0, error: null, timedOut: false, signal: null });
const verifyExecFail = (code = 1, stderr = 'boom') => async () => ({ stdout: '', stderr, code, error: `exited with code ${code}`, timedOut: false, signal: null });

// 带白名单验证命令的诊断任务：verification 首行为可执行命令。
const whitelistedReport = (over = {}) =>
  validReport({ verification: 'cargo test\nrun the engine tests to prove the fix', ...over });

const fakeRunFix = (result) => {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    return typeof result === 'function' ? result(opts) : result;
  };
  fn.calls = calls;
  return fn;
};

const fakeGitExec = (handler) => {
  const calls = [];
  const fn = async (args, opts) => {
    calls.push({ args, opts });
    return handler ? handler(calls.length - 1, { args, opts }) : { ok: true, stdout: '', stderr: '', code: 0 };
  };
  fn.calls = calls;
  return fn;
};

const fixSuccessResult = (over = {}) => ({
  ok: true,
  outcome: 'fixed',
  worktree: '/tmp/p13-fix/fix-prob-svc-1-t',
  branch: 'fix/prob-svc-1/20260827T1530000',
  summary: 'lowered the threshold',
  changed_files: ['engine/src/lib.rs'],
  verification_results: [{ command: 'cargo test', exit_code: 0, summary: 'all pass' }],
  ...over,
});

test('POST /problems/:id/verify runs the report default command and marks fixed on exit 0 + mark_fixed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  writeDiagnosedTask(dir, 'task-v', whitelistedReport());
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
    verifyProblemFn: verifyWithExec(verifyExecOk()),
  });
  try {
    const create = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ task_id: 'task-v' }),
    });
    const problem = await create.json();

    const res = await fetch(`${base}/problems/${problem.id}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ mark_fixed: true }),
    });
    assert.equal(res.status, 200);
    const updated = await res.json();
    assert.equal(updated.status, 'fixed');
    const decision = updated.decisions.at(-1);
    assert.equal(decision.action, 'verify');
    assert.equal(decision.command, 'cargo test');
    assert.equal(decision.exit_code, 0);
    assert.equal(decision.summary, 'ok');
    // status:fixed 决策在 verify 之前。
    assert.equal(updated.decisions.at(-2).action, 'status:fixed');
  } finally {
    await closeServer(server);
  }
});

test('POST /problems/:id/verify rejects a whitelist-violating command with 400 and no decision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  writeDiagnosedTask(dir, 'task-v', whitelistedReport());
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
    verifyProblemFn: verifyWithExec(verifyExecOk()),
  });
  try {
    const create = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ task_id: 'task-v' }),
    });
    const problem = await create.json();
    const res = await fetch(`${base}/problems/${problem.id}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ command: 'rm -rf /' }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /command not allowed/);
    const detail = await (await fetch(`${base}/problems/${problem.id}`, { headers: { Origin: LOCAL_ORIGIN } })).json();
    assert.ok(!detail.decisions.some((d) => d.action === 'verify'));
  } finally {
    await closeServer(server);
  }
});

test('POST /problems/:id/verify returns 400 when no whitelisted command is available', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  writeDiagnosedTask(dir, 'task-v', validReport()); // verification 不是白名单命令
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
    verifyProblemFn: verifyWithExec(verifyExecOk()),
  });
  try {
    const create = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ task_id: 'task-v' }),
    });
    const problem = await create.json();
    const res = await fetch(`${base}/problems/${problem.id}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: '{}',
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /no verification command/);
  } finally {
    await closeServer(server);
  }
});

test('POST /problems/:id/verify does not mark fixed on a non-zero exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  writeDiagnosedTask(dir, 'task-v', whitelistedReport());
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
    verifyProblemFn: verifyWithExec(verifyExecFail(1)),
  });
  try {
    const create = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ task_id: 'task-v' }),
    });
    const problem = await create.json();
    const res = await fetch(`${base}/problems/${problem.id}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ mark_fixed: true }),
    });
    const updated = await res.json();
    assert.equal(updated.status, 'open');
    assert.equal(updated.decisions.at(-1).exit_code, 1);
  } finally {
    await closeServer(server);
  }
});

test('POST /problems/:id/verify redacts credentials from the persisted decision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  writeDiagnosedTask(dir, 'task-v', whitelistedReport());
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
    env: { ANTHROPIC_API_KEY: FAKE_KEY },
    verifyProblemFn: verifyWithExec(verifyExecOk(`please see ${FAKE_KEY} attached`)),
  });
  try {
    const create = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ task_id: 'task-v' }),
    });
    const problem = await create.json();
    const res = await fetch(`${base}/problems/${problem.id}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: '{}',
    });
    const updated = await res.json();
    assert.match(updated.decisions.at(-1).summary, /\[REDACTED\]/);
    assert.doesNotMatch(updated.decisions.at(-1).summary, new RegExp(FAKE_KEY));
  } finally {
    await closeServer(server);
  }
});

test('POST /problems/:id/verify returns 404 for an unknown problem', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    verifyProblemFn: verifyWithExec(verifyExecOk()),
  });
  try {
    const res = await fetch(`${base}/problems/nope/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: '{}',
    });
    assert.equal(res.status, 404);
  } finally {
    await closeServer(server);
  }
});

test('POST /problems/:id/fix dispatches the fix agent and writes fix_ref pending_confirm', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  writeDiagnosedTask(dir, 'task-f', validReport());
  const fix = fakeRunFix(fixSuccessResult());
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
    env: { ANTHROPIC_API_KEY: FAKE_KEY },
    runFixFn: fix,
  });
  try {
    const create = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ task_id: 'task-f' }),
    });
    const problem = await create.json();

    const res = await fetch(`${base}/problems/${problem.id}/fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ extra_instructions: 'also bump the version' }),
    });
    assert.equal(res.status, 200);
    const updated = await res.json();
    assert.equal(updated.status, 'in_progress');
    assert.deepEqual(updated.fix_ref, { worktree: fixSuccessResult().worktree, branch: fixSuccessResult().branch, status: 'pending_confirm' });
    const decision = updated.decisions.at(-1);
    assert.equal(decision.action, 'fix');
    assert.equal(decision.outcome, 'succeeded');
    assert.deepEqual(decision.changed_files, ['engine/src/lib.rs']);
    assert.equal(decision.verification_results[0].command, 'cargo test');
    // runFix 收到 problem 与净化后的 extra_instructions。
    assert.equal(fix.calls.length, 1);
    assert.equal(fix.calls[0].problem.id, problem.id);
    assert.equal(fix.calls[0].extraInstructions, 'also bump the version');
    assert.equal(fix.calls[0].env.ANTHROPIC_API_KEY, FAKE_KEY);
  } finally {
    await closeServer(server);
  }
});

test('POST /problems/:id/fix failure records the decision without changing status or creating fix_ref', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  writeDiagnosedTask(dir, 'task-f', validReport());
  const fix = fakeRunFix({ ok: false, outcome: 'provider_unavailable', error: 'ANTHROPIC_API_KEY is not set' });
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
    env: { ANTHROPIC_API_KEY: FAKE_KEY },
    runFixFn: fix,
  });
  try {
    const create = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ task_id: 'task-f' }),
    });
    const problem = await create.json();

    const res = await fetch(`${base}/problems/${problem.id}/fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: '{}',
    });
    assert.equal(res.status, 200);
    const updated = await res.json();
    assert.equal(updated.status, 'open'); // 状态不变
    assert.equal(updated.fix_ref, undefined); // fix_ref 不建
    const decision = updated.decisions.at(-1);
    assert.equal(decision.action, 'fix');
    assert.equal(decision.outcome, 'failed');
    assert.equal(decision.error, 'ANTHROPIC_API_KEY is not set');
  } finally {
    await closeServer(server);
  }
});

test('POST /problems/:id/fix rejects closed-triage problems and pending fixes with 400', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
    runFixFn: fakeRunFix(fixSuccessResult()),
  });
  try {
    const closed = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ title: 'later', triage: 'defer', reason: 'later' }),
    });
    const closedProblem = await closed.json();
    const res1 = await fetch(`${base}/problems/${closedProblem.id}/fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: '{}',
    });
    assert.equal(res1.status, 400);
    assert.match((await res1.json()).error, /closed/);

    // 已有 pending fix → 拒绝新 fix。
    const open = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ title: 'open one' }),
    });
    const openProblem = await open.json();
    await fetch(`${base}/problems/${openProblem.id}/fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: '{}',
    });
    const res2 = await fetch(`${base}/problems/${openProblem.id}/fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: '{}',
    });
    assert.equal(res2.status, 400);
    assert.match((await res2.json()).error, /pending/);
  } finally {
    await closeServer(server);
  }
});

test('POST /problems/:id/fix redacts extra_instructions before they reach the fix runner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  writeDiagnosedTask(dir, 'task-f', validReport());
  const fix = fakeRunFix(fixSuccessResult());
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
    env: { ANTHROPIC_API_KEY: FAKE_KEY },
    runFixFn: fix,
  });
  try {
    const create = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ task_id: 'task-f' }),
    });
    const problem = await create.json();
    await fetch(`${base}/problems/${problem.id}/fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ extra_instructions: `please see ${FAKE_KEY}` }),
    });
    assert.doesNotMatch(fix.calls[0].extraInstructions, new RegExp(FAKE_KEY));
    assert.match(fix.calls[0].extraInstructions, /\[REDACTED\]/);
  } finally {
    await closeServer(server);
  }
});

test('POST /problems/:id/merge-fix merges the branch, closes the problem, and cleans the worktree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  writeDiagnosedTask(dir, 'task-f', validReport());
  const git = fakeGitExec();
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
    env: { ANTHROPIC_API_KEY: FAKE_KEY },
    runFixFn: fakeRunFix(fixSuccessResult()),
    gitExec: git,
  });
  try {
    const create = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ task_id: 'task-f' }),
    });
    const problem = await create.json();
    // 先 fix（写入 fix_ref pending_confirm）。
    await fetch(`${base}/problems/${problem.id}/fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: '{}',
    });

    const res = await fetch(`${base}/problems/${problem.id}/merge-fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ change_ref: 'fix/custom' }),
    });
    assert.equal(res.status, 200);
    const updated = await res.json();
    assert.equal(updated.status, 'closed');
    assert.equal(updated.change_ref, 'fix/custom');
    assert.equal(updated.fix_ref.status, 'merged');
    assert.equal(updated.decisions.at(-1).action, 'merge-fix');

    // git 操作顺序：rev-parse → merge --no-ff → worktree remove。
    assert.deepEqual(git.calls[0].args, ['rev-parse', '--verify', 'fix/prob-svc-1/20260827T1530000^{commit}']);
    assert.deepEqual(git.calls[1].args[0], 'merge');
    assert.equal(git.calls[1].args[1], '--no-ff');
    assert.equal(git.calls[1].args[2], 'fix/prob-svc-1/20260827T1530000');
    assert.deepEqual(git.calls[2].args, ['worktree', 'remove', '--force', '/tmp/p13-fix/fix-prob-svc-1-t']);
    assert.equal(git.calls[1].opts.cwd, REPO_ROOT); // 主 checkout（repoRoot）
  } finally {
    await closeServer(server);
  }
});

test('POST /problems/:id/merge-fix reject keeps the worktree and marks fix_ref rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  writeDiagnosedTask(dir, 'task-f', validReport());
  const git = fakeGitExec();
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
    env: { ANTHROPIC_API_KEY: FAKE_KEY },
    runFixFn: fakeRunFix(fixSuccessResult()),
    gitExec: git,
  });
  try {
    const create = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ task_id: 'task-f' }),
    });
    const problem = await create.json();
    await fetch(`${base}/problems/${problem.id}/fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: '{}',
    });

    const res = await fetch(`${base}/problems/${problem.id}/merge-fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ reject: true, reason: 'wrong approach' }),
    });
    assert.equal(res.status, 200);
    const updated = await res.json();
    assert.equal(updated.status, 'in_progress'); // 不闭环
    assert.equal(updated.fix_ref.status, 'rejected');
    assert.equal(updated.decisions.at(-1).action, 'reject-fix');
    assert.equal(updated.decisions.at(-1).reason, 'wrong approach');
    // 不执行 merge / worktree remove。
    assert.deepEqual(git.calls, []);
  } finally {
    await closeServer(server);
  }
});

test('POST /problems/:id/merge-fix guards: no pending fix / no commits / failed verification', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  writeDiagnosedTask(dir, 'task-f', validReport());
  const gitNoCommit = fakeGitExec((i) => (i === 0 ? { ok: false, stdout: '', stderr: 'unknown revision', code: 128 } : { ok: true, stdout: '', stderr: '', code: 0 }));
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
    env: { ANTHROPIC_API_KEY: FAKE_KEY },
    runFixFn: fakeRunFix(fixSuccessResult()),
    gitExec: gitNoCommit,
  });
  try {
    const create = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ task_id: 'task-f' }),
    });
    const problem = await create.json();

    // 无 pending fix → 400。
    const res0 = await fetch(`${base}/problems/${problem.id}/merge-fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: '{}',
    });
    assert.equal(res0.status, 400);
    assert.match((await res0.json()).error, /no pending fix/);

    // 先 fix，但分支无提交 → 400。
    await fetch(`${base}/problems/${problem.id}/fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: '{}',
    });
    const res1 = await fetch(`${base}/problems/${problem.id}/merge-fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: '{}',
    });
    assert.equal(res1.status, 400);
    assert.match((await res1.json()).error, /no commits/);

    // 验证记录未全过 → 400；force → 通过（独立 tasksDir + git 全成功）。
    const dir2 = mkdtempSync(join(tmpdir(), 'service-test-'));
    const gitFailV = fakeGitExec();
    const badVr = fakeRunFix({ ...fixSuccessResult(), verification_results: [{ command: 'cargo test', exit_code: 1, summary: 'fail' }] });
    const { server: s2, base: b2 } = await startService({
      tasksDir: dir2,
      runDiagnosisFn: async () => {},
      newProblemId: problemIdFactory(),
      env: { ANTHROPIC_API_KEY: FAKE_KEY },
      runFixFn: badVr,
      gitExec: gitFailV,
    });
    try {
      const create2 = await fetch(`${b2}/problems`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
        body: JSON.stringify({ title: 'second' }),
      });
      const problem2 = await create2.json();
      await fetch(`${b2}/problems/${problem2.id}/fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
        body: '{}',
      });
      const res2 = await fetch(`${b2}/problems/${problem2.id}/merge-fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
        body: '{}',
      });
      assert.equal(res2.status, 400);
      assert.match((await res2.json()).error, /did not all pass/);
      // force:true → 合入成功。
      const res3 = await fetch(`${b2}/problems/${problem2.id}/merge-fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
        body: JSON.stringify({ force: true }),
      });
      assert.equal(res3.status, 200);
      assert.equal((await res3.json()).status, 'closed');
    } finally {
      await closeServer(s2);
    }
  } finally {
    await closeServer(server);
  }
});

test('POST /problems/:id/merge-fix reports a git merge failure without closing the problem', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  writeDiagnosedTask(dir, 'task-f', validReport());
  const git = fakeGitExec((i) => {
    if (i === 0) return { ok: true, stdout: '', stderr: '', code: 0 }; // rev-parse ok
    return { ok: false, stdout: '', stderr: 'conflict in engine/src/lib.rs', code: 1 }; // merge fail
  });
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
    env: { ANTHROPIC_API_KEY: FAKE_KEY },
    runFixFn: fakeRunFix(fixSuccessResult()),
    gitExec: git,
  });
  try {
    const create = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ task_id: 'task-f' }),
    });
    const problem = await create.json();
    await fetch(`${base}/problems/${problem.id}/fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: '{}',
    });
    const res = await fetch(`${base}/problems/${problem.id}/merge-fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: '{}',
    });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /merge failed/);
    // problem 不闭环：status 保持 in_progress，fix_ref 保持 pending_confirm。
    const detail = await (await fetch(`${base}/problems/${problem.id}`, { headers: { Origin: LOCAL_ORIGIN } })).json();
    assert.equal(detail.status, 'in_progress');
    assert.equal(detail.fix_ref.status, 'pending_confirm');
  } finally {
    await closeServer(server);
  }
});

test('POST /problems/:id/merge-fix returns 404 for an unknown problem', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    gitExec: fakeGitExec(),
  });
  try {
    const res = await fetch(`${base}/problems/nope/merge-fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: '{}',
    });
    assert.equal(res.status, 404);
  } finally {
    await closeServer(server);
  }
});

test('POST /problems/:id/verify rejects mark_fixed early for closed-triage problems without running the command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  let called = false;
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
    verifyProblemFn: async () => {
      called = true;
      return { ok: true, command: 'cargo test', exit_code: 0, summary: 'ok' };
    },
  });
  try {
    const created = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ title: 'later', triage: 'defer', reason: 'later' }),
    });
    const problem = await created.json();
    const res = await fetch(`${base}/problems/${problem.id}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ mark_fixed: true }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /status=closed/);
    assert.equal(called, false); // 命令未执行
  } finally {
    await closeServer(server);
  }
});

test('POST /problems/:id/merge-fix rejects when the fix has no verification records (force required)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  const git = fakeGitExec();
  const noVr = fakeRunFix({ ...fixSuccessResult(), verification_results: [] });
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
    env: { ANTHROPIC_API_KEY: FAKE_KEY },
    runFixFn: noVr,
    gitExec: git,
  });
  try {
    const created = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ title: 'no vr' }),
    });
    const problem = await created.json();
    await fetch(`${base}/problems/${problem.id}/fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: '{}',
    });
    // 无验证记录 → 400（必须 force）。
    const res = await fetch(`${base}/problems/${problem.id}/merge-fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: '{}',
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /did not all pass/);
    // force → 合入。
    const res2 = await fetch(`${base}/problems/${problem.id}/merge-fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ force: true }),
    });
    assert.equal(res2.status, 200);
    assert.equal((await res2.json()).status, 'closed');
  } finally {
    await closeServer(server);
  }
});

test('POST /problems/:id/fix rejects a concurrent dispatch while one fix is in flight', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-test-'));
  let releaseRun;
  const gate = new Promise((r) => { releaseRun = r; });
  const fix = fakeRunFix(async () => {
    await gate;
    return fixSuccessResult();
  });
  const { server, base } = await startService({
    tasksDir: dir,
    runDiagnosisFn: async () => {},
    newProblemId: problemIdFactory(),
    env: { ANTHROPIC_API_KEY: FAKE_KEY },
    runFixFn: fix,
  });
  try {
    const created = await fetch(`${base}/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify({ title: 'race' }),
    });
    const problem = await created.json();
    // 第一个 fix 挂起（agent 运行中）。
    const p1 = fetch(`${base}/problems/${problem.id}/fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: '{}',
    });
    // 等 p1 进入互斥区后，第二次下发 → 400 in progress。
    await new Promise((r) => setTimeout(r, 30));
    const res2 = await fetch(`${base}/problems/${problem.id}/fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: '{}',
    });
    assert.equal(res2.status, 400);
    assert.match((await res2.json()).error, /in progress/);
    // 放行第一个 → 正常成功。
    releaseRun();
    const res1 = await p1;
    assert.equal(res1.status, 200);
    assert.equal((await res1.json()).fix_ref.status, 'pending_confirm');
    // 互斥释放后，pending_confirm 守卫接管：再次下发 → 400 pending。
    const res3 = await fetch(`${base}/problems/${problem.id}/fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: '{}',
    });
    assert.equal(res3.status, 400);
    assert.match((await res3.json()).error, /pending/);
  } finally {
    await closeServer(server);
  }
});

// === P14 queue-only：入队不自动跑，任务 captured，可手动续跑 ===

test('P14 queue-only: POST /observations persists bundle + captured task without running diagnosis', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-qonly-'));
  let diagnosisCalled = false;
  const fake = async () => { diagnosisCalled = true; };
  const { server, base } = await startService({ tasksDir: dir, runDiagnosisFn: fake, queueOnly: true });
  try {
    const res = await fetch(`${base}/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify(validBundle()),
    });
    assert.equal(res.status, 202);
    const data = await res.json();
    assert.ok(data.task_id);
    assert.equal(data.queued, true);
    // 诊断未被调用
    assert.equal(diagnosisCalled, false);
    // bundle 与 task 均落盘，task 为 captured
    const task = JSON.parse(readFileSync(join(dir, `${data.task_id}.task.json`), 'utf8'));
    assert.equal(task.status, 'captured');
    assert.equal(task.status_history[0].status, 'captured');
    assert.ok(existsSync(join(dir, `${data.task_id}.bundle.json`)));
    assert.equal(task.provider, null);
  } finally {
    await closeServer(server);
  }
});

test('P14 queue-only: GET /tasks/:id returns captured state (no error)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-qonly-'));
  const { server, base } = await startService({ tasksDir: dir, runDiagnosisFn: async () => {}, queueOnly: true });
  try {
    const post = await fetch(`${base}/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify(validBundle()),
    });
    const { task_id } = await post.json();
    const res = await fetch(`${base}/tasks/${task_id}`, { headers: { Origin: LOCAL_ORIGIN } });
    assert.equal(res.status, 200);
    const task = await res.json();
    assert.equal(task.status, 'captured');
    assert.equal(task.report, null);
  } finally {
    await closeServer(server);
  }
});

test('P14 non-queue-only keeps auto-diagnosis behavior', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-auto-'));
  const { fake, calls } = fakeRunPersisting();
  const { server, base } = await startService({ tasksDir: dir, runDiagnosisFn: fake });
  try {
    const res = await fetch(`${base}/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
      body: JSON.stringify(validBundle()),
    });
    assert.equal(res.status, 202);
    const data = await res.json();
    // 等后台 microtask 跑完
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 1);
    const task = JSON.parse(readFileSync(join(dir, `${data.task_id}.task.json`), 'utf8'));
    assert.equal(task.status, 'diagnosed');
  } finally {
    await closeServer(server);
  }
});

test('P14 parseArgs parses --queue-only', () => {
  const opts = parseArgs(['--tasks-dir', '/tmp/x', '--queue-only']);
  assert.equal(opts.queueOnly, true);
  const opts2 = parseArgs(['--tasks-dir', '/tmp/x']);
  assert.equal(opts2.queueOnly, undefined);
});
