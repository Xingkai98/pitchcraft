// tools/service.mjs HTTP 单测（无真实 API / Claude / WASM）。
// 用 fake runDiagnosis 注入（参照 runner.test.mjs 的 fake 风格）；另有一例用真实
// runDiagnosis + env:{} 走 provider_unavailable（不 spawn，无 API 调用）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService, main, parseArgs } from './service.mjs';

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
      body: JSON.stringify(validBundle()),
    });
    const { task_id } = await post.json();
    const res = await fetch(`${base}/tasks/${task_id}`, { headers: { Origin: LOCAL_ORIGIN } });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'auditing');
    assert.deepEqual(data.findings, []);
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
    assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
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
