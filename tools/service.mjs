#!/usr/bin/env node
// Local observation diagnosis HTTP service.
//
// Slice 3: a dependency-free Node `http` server that wires the viewer's
// observation submission to the existing runner. It does NOT re-implement any
// audit/diagnosis logic — it validates the incoming bundle, schedules
// runDiagnosis in the background, and exposes redacted task polling over the
// runner's persisted task files.
//
// Endpoints (CORS headers are echoed ONLY for localhost/127.0.0.1 origins):
//   POST /observations   body = observation bundle JSON -> 202 { task_id }
//   GET  /tasks/:id      redacted task status + findings (page polling)
//   OPTIONS              CORS preflight 204
//   other                404
//
// Security: binds 127.0.0.1 only; request body capped (default 5 MB); a
// non-localhost Origin is rejected without CORS headers; the API key never
// enters responses or logs (composed responses are re-scrubbed defensively).

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateObservationBundle } from './bundle.mjs';
import { runDiagnosis } from './runner.mjs';
import { redactKey, redactCredentialText } from './provider.mjs';
import { loadDotEnv } from './dotenv.mjs';
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
  defaultProblemId,
} from './problems.mjs';
import { createGithubIssue } from './github.mjs';

export const DEFAULT_PORT = 8787;
export const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;
export const DEFAULT_HOST = '127.0.0.1';

// Task ids are service-generated (UUIDs) or test ids; only safe path-segment
// characters are accepted so a task id can never escape the tasks dir.
const TASK_ID_RE = /^[A-Za-z0-9_-]+$/;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Best-effort checkout revision for the diagnosis prompt (the CLI passes one
// via --revision; the service reads git once at startup). Returns null when
// git is unavailable so the caller can fall back to the bundle revision.
export function readRepoRevision() {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const rev = out.trim();
    return rev.length > 0 ? rev : null;
  } catch {
    return null;
  }
}

// Origin check: only localhost / 127.0.0.1 origins are trusted. No-Origin
// requests (curl-style local clients) are allowed but never get CORS headers.
export function isLocalhostOrigin(origin) {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

// Build the replay / verification instructions the diagnosis prompt carries.
// The audit already ran over bundle.audit_input; this tells the agent how a
// human re-runs/views the same window. Values are scrubbed by the runner before
// they reach a prompt, and this text never carries credentials.
export function buildReplayInstructions(bundle) {
  const seed = bundle?.seed;
  const lines = [
    'Replay the saved observation window deterministically (the audit already ran over bundle.audit_input).',
    'To re-audit via CLI, run from the repo root:',
    '  node tools/runner-cli.mjs --bundle <bundle.json> --audit <audit.json> --replay "..." --revision <rev> --tasks-dir <dir>',
    seed != null ? `To view: reload the match with the same seed (${seed}) and seek to match_time ${bundle?.match_time ?? '?'}s.` : null,
    'Reproduce findings from the saved evidence; do not fabricate engine internals not visible in the bundle.',
  ].filter(Boolean);
  return lines.join('\n');
}

function sendJSON(res, status, body, corsOrigin, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (corsOrigin) headers['Access-Control-Allow-Origin'] = corsOrigin;
  if (opts.connectionClose) headers.Connection = 'close';
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function sendPreflight(res, origin) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  });
  res.end();
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(
        Object.assign(new Error(`request body exceeds ${maxBytes} bytes`), { code: 'BODY_TOO_LARGE' })
      );
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        // Stop reading the oversized body instead of destroying the socket, so
        // the 413 response is flushed reliably; the handler closes the connection.
        req.pause();
        reject(
          Object.assign(new Error(`request body exceeds ${maxBytes} bytes`), {
            code: 'BODY_TOO_LARGE',
          })
        );
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Parse a JSON request body for the problem endpoints. Empty body → {}. Errors
// map to 400 (or 413 with tooLarge) via the returned flags.
async function parseJsonBody(req, maxBytes) {
  try {
    const buf = await readBody(req, maxBytes);
    if (buf.length === 0) return { ok: true, body: {} };
    const parsed = JSON.parse(buf.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'request body must be a JSON object' };
    }
    return { ok: true, body: parsed };
  } catch (e) {
    if (e.code === 'BODY_TOO_LARGE') return { ok: false, tooLarge: true, error: e.message };
    return { ok: false, error: 'cannot read request body' };
  }
}

// Create the http.Server. `runDiagnosisFn` and `validateBundle` are injectable
// for tests; `env` is passed through to runDiagnosis so the key gate and
// redaction behave exactly as in the CLI. `createGithubIssueFn`/`newProblemId`
// are injectable for the problem lifecycle endpoints (tests use fakes).
export function createService({
  tasksDir,
  runDiagnosisFn = runDiagnosis,
  validateBundle = validateObservationBundle,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  env = process.env,
  newId = () => randomUUID(),
  sourceRevision = null,
  replayInstructionsFn = buildReplayInstructions,
  allowedOrigins = [],
  createGithubIssueFn = createGithubIssue,
  newProblemId = defaultProblemId,
  log = () => {},
} = {}) {
  if (!tasksDir) throw new Error('createService: tasksDir is required');
  mkdirSync(tasksDir, { recursive: true });
  const envKey = env.ANTHROPIC_API_KEY;
  const checkoutRevision = sourceRevision ?? readRepoRevision() ?? null;

  // 用户可控文本的组合净化：redactKey（存活 key + 凭证形值）+ redactCredentialText
  // （通用 `KEY=value`/`KEY: value`/`"KEY":"value"` 键值对）。problem 响应组合用
  // redactProblemJSON（防御性兜底，与 problems.mjs 落盘净化同规则）。
  const redactProblemText = (text) => redactCredentialText(redactKey(text, envKey));
  const redactProblemJSON = (obj) => JSON.parse(redactProblemText(JSON.stringify(obj)));

  // Compose a redacted task state for GET /tasks/:id. Reads the runner-persisted
  // task file and the audit report it wrote; before the task file exists the
  // bundle file is already present, so answer 'auditing' (smooth polling).
  const readTaskState = (id) => {
    const taskPath = join(tasksDir, `${id}.task.json`);
    let task = null;
    try {
      task = JSON.parse(readFileSync(taskPath, 'utf8'));
    } catch {
      task = null;
    }
    if (!task) {
      try {
        readFileSync(join(tasksDir, `${id}.bundle.json`));
        task = {
          task_id: id,
          status: 'auditing',
          errors: [],
          report: null,
          findings: [],
          status_history: [{ status: 'auditing', at: new Date().toISOString() }],
        };
      } catch {
        return null;
      }
    }
    let findings = [];
    if (task.input_summary?.audit_path) {
      try {
        const audit = JSON.parse(readFileSync(task.input_summary.audit_path, 'utf8'));
        if (Array.isArray(audit.findings)) findings = audit.findings;
      } catch {
        /* audit not written yet */
      }
    }
    // Whitelist the polling fields the page actually consumes. The persisted task
    // carries internal paths (input_summary.bundle_path / audit_path) and runner
    // config that must not be exposed through the service.
    const response = {
      task_id: id,
      status: typeof task.status === 'string' ? task.status : 'failed',
      errors: Array.isArray(task.errors) ? task.errors : [],
      report: task.report ?? null,
      status_history: Array.isArray(task.status_history) ? task.status_history : [],
      failure_kind: task.failure_kind ?? null,
      findings,
    };
    // Defense-in-depth: the persisted task is already redacted; re-scrub the
    // composed response so a live env key value never leaves the service.
    return JSON.parse(redactKey(JSON.stringify(response), envKey));
  };

  const server = createServer((req, res) => {
    // A malformed request must never crash the service: an unhandled rejection
    // in an async request listener terminates Node and loses every in-flight
    // diagnosis. dispatch() handles expected errors inline; this is the
    // last-resort guard for anything unexpected.
    dispatch(req, res).catch((err) => {
      try {
        if (!res.headersSent) sendJSON(res, 400, { error: 'invalid request' }, null);
        else res.end();
      } catch {
        /* ignore */
      }
    });
  });

  async function dispatch(req, res) {
    const origin = req.headers.origin ?? null;
    // Allowed when the origin is localhost/127.0.0.1 (default), OR it is listed
    // exactly in --allow-origin (e.g. a Tailscale in-network page address).
    // No-Origin requests (curl-style local clients) are allowed but never get
    // CORS headers.
    const originAllowed = origin
      ? isLocalhostOrigin(origin) || allowedOrigins.includes(origin)
      : true;
    if (origin && !originAllowed) {
      // Reject without CORS headers; no task is started for arbitrary origins.
      sendJSON(res, 403, { error: 'origin not allowed' }, null);
      return;
    }
    const corsOrigin = origin && originAllowed ? origin : null;

    if (req.method === 'OPTIONS') {
      if (corsOrigin) sendPreflight(res, corsOrigin);
      else res.writeHead(204).end();
      return;
    }

    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      // Absolute-form request targets with an invalid port (or otherwise
      // unparseable URLs) reject cleanly instead of crashing the handler.
      sendJSON(res, 400, { error: 'invalid request url' }, corsOrigin);
      return;
    }

    if (req.method === 'POST' && pathname === '/observations') {
      let body;
      try {
        body = await readBody(req, maxBodyBytes);
      } catch (e) {
        if (e.code === 'BODY_TOO_LARGE') {
          sendJSON(res, 413, { error: e.message }, corsOrigin, { connectionClose: true });
        } else {
          sendJSON(res, 400, { error: 'cannot read request body' }, corsOrigin);
        }
        return;
      }
      let bundle;
      try {
        bundle = JSON.parse(body.toString('utf8'));
      } catch {
        sendJSON(res, 400, { error: 'request body must be a JSON object' }, corsOrigin);
        return;
      }
      const check = validateBundle(bundle);
      if (!check.valid) {
        // Errors are field names / JSON paths only — never secret values.
        sendJSON(res, 400, { error: 'invalid observation bundle', errors: check.errors }, corsOrigin);
        return;
      }

      const runId = newId();
      const bundlePath = join(tasksDir, `${runId}.bundle.json`);
      const auditPath = join(tasksDir, `${runId}.audit.json`);
      try {
        writeFileSync(bundlePath, JSON.stringify(bundle));
      } catch (e) {
        sendJSON(res, 500, { error: `cannot persist bundle: ${e.code ?? e.message}` }, corsOrigin);
        return;
      }

      const serviceRevision = checkoutRevision ?? bundle.source_revision ?? '<unknown>';
      const replay = replayInstructionsFn(bundle);

      // Background diagnosis: runDiagnosis validates again, audits, then
      // diagnoses. Deferred to a microtask so the 202 is sent before the audit
      // runs; guarded so an unexpected rejection cannot crash the server.
      Promise.resolve()
        .then(() =>
          runDiagnosisFn({
            bundlePath,
            auditPath,
            replayInstructions: replay,
            sourceRevision: serviceRevision,
            tasksDir,
            runId,
            env,
          })
        )
        .catch((err) => {
          log(`task ${runId} background run failed: ${redactKey(err?.message ?? String(err), envKey)}`);
        });

      sendJSON(res, 202, { task_id: runId }, corsOrigin);
      return;
    }

    const match = /^\/tasks\/([^/]+)$/.exec(pathname);
    if (req.method === 'GET' && match) {
      const id = match[1];
      if (!TASK_ID_RE.test(id)) {
        sendJSON(res, 404, { error: 'not found' }, corsOrigin);
        return;
      }
      const task = readTaskState(id);
      if (!task) {
        sendJSON(res, 404, { error: 'not found' }, corsOrigin);
        return;
      }
      sendJSON(res, 200, task, corsOrigin);
      return;
    }

    // --- P11 problem lifecycle endpoints -----------------------------------
    const problemList = pathname === '/problems';
    const problemDetail = /^\/problems\/([^/]+)$/.exec(pathname);
    const problemDiscussion = /^\/problems\/([^/]+)\/discussion$/.exec(pathname);
    const problemGithub = /^\/problems\/([^/]+)\/github$/.exec(pathname);
    // 领域错误映射：MISSING_REASON/BAD_REQUEST → 400，NOT_FOUND → 404，其他 500。
    // 500 分支的 message 一律净化，绝不外泄凭证。
    const problemError = (e) => {
      if (e instanceof ProblemError) {
        sendJSON(res, e.code === 'NOT_FOUND' ? 404 : 400, { error: e.message }, corsOrigin);
      } else {
        sendJSON(res, 500, { error: `problem operation failed: ${redactKey(e.message, envKey)}` }, corsOrigin);
      }
    };

    if (req.method === 'GET' && problemList) {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const triage = url.searchParams.get('triage') ?? undefined;
      const status = url.searchParams.get('status') ?? undefined;
      if (
        (triage && !TRIAGE_VALUES.includes(triage)) ||
        (status && !STATUS_VALUES.includes(status))
      ) {
        sendJSON(res, 400, { error: 'invalid filter' }, corsOrigin);
        return;
      }
      const problems = listProblems({ tasksDir, triage, status });
      sendJSON(res, 200, redactProblemJSON({ problems }), corsOrigin);
      return;
    }

    if (req.method === 'POST' && problemList) {
      const parsed = await parseJsonBody(req, maxBodyBytes);
      if (!parsed.ok) {
        sendJSON(res, parsed.tooLarge ? 413 : 400, { error: parsed.error }, corsOrigin, parsed.tooLarge ? { connectionClose: true } : undefined);
        return;
      }
      const { task_id, title, description, triage, status, reason } = parsed.body;
      let input;
      if (task_id) {
        // 从诊断报告一键创建：任务须终态 diagnosed 且带 report。
        if (!TASK_ID_RE.test(task_id)) {
          sendJSON(res, 400, { error: 'invalid task_id' }, corsOrigin);
          return;
        }
        const task = readTaskState(task_id);
        if (!task || task.status !== 'diagnosed' || !task.report) {
          sendJSON(res, 400, { error: 'task not diagnosed or missing' }, corsOrigin);
          return;
        }
        const report = task.report;
        const phenomenon =
          typeof report.phenomenon_summary === 'string' && report.phenomenon_summary.trim()
            ? report.phenomenon_summary.trim()
            : '未命名问题';
        // 用户描述/observation_id 来自原 bundle（可选）；凭证净化后再进 description。
        let bundle = null;
        try {
          bundle = JSON.parse(readFileSync(join(tasksDir, `${task_id}.bundle.json`), 'utf8'));
        } catch {
          /* bundle 不可读（如手工构造任务）——跳过 statement/observation_id */
        }
        let userStatement = '';
        if (bundle && typeof bundle.statement === 'string' && bundle.statement.trim()) {
          userStatement = redactKey(bundle.statement.trim(), envKey);
        }
        const descLines = [`现象: ${phenomenon}`];
        if (userStatement) descLines.push(`用户描述: ${userStatement}`);
        if (report.root_cause) descLines.push(`根因: ${report.root_cause}`);
        if (report.proposed_fix) descLines.push(`建议修复: ${report.proposed_fix}`);
        if (report.verification) descLines.push(`验证: ${report.verification}`);
        const source = { task_id, report };
        if (bundle && typeof bundle.observation_id === 'string' && bundle.observation_id) {
          source.observation_id = bundle.observation_id;
        }
        input = {
          title: title ?? phenomenon,
          description: description ?? descLines.join('\n'),
          source,
          triage: triage ?? report.triage?.category ?? 'discuss',
          status: status ?? 'open',
          reason,
        };
      } else {
        // 人工创建：title 必填，其余可省略（默认 discuss/open/source null）。
        input = { title, description, triage, status, reason };
      }
      try {
        const problem = createProblem(input, { tasksDir, newId: newProblemId, envKey });
        sendJSON(res, 201, redactProblemJSON(problem), corsOrigin);
      } catch (e) {
        problemError(e);
      }
      return;
    }

    if (req.method === 'GET' && problemDetail) {
      const id = problemDetail[1];
      if (!PROBLEM_ID_RE.test(id)) {
        sendJSON(res, 404, { error: 'not found' }, corsOrigin);
        return;
      }
      const problem = getProblem(id, { tasksDir });
      if (!problem) {
        sendJSON(res, 404, { error: 'not found' }, corsOrigin);
        return;
      }
      sendJSON(res, 200, redactProblemJSON(problem), corsOrigin);
      return;
    }

    if (req.method === 'PATCH' && problemDetail) {
      const id = problemDetail[1];
      if (!PROBLEM_ID_RE.test(id)) {
        sendJSON(res, 404, { error: 'not found' }, corsOrigin);
        return;
      }
      const parsed = await parseJsonBody(req, maxBodyBytes);
      if (!parsed.ok) {
        sendJSON(res, parsed.tooLarge ? 413 : 400, { error: parsed.error }, corsOrigin, parsed.tooLarge ? { connectionClose: true } : undefined);
        return;
      }
      try {
        const updated = updateProblem(id, parsed.body, { tasksDir, envKey });
        if (!updated) {
          sendJSON(res, 404, { error: 'not found' }, corsOrigin);
          return;
        }
        sendJSON(res, 200, redactProblemJSON(updated), corsOrigin);
      } catch (e) {
        problemError(e);
      }
      return;
    }

    if (req.method === 'POST' && problemDiscussion) {
      const id = problemDiscussion[1];
      if (!PROBLEM_ID_RE.test(id)) {
        sendJSON(res, 404, { error: 'not found' }, corsOrigin);
        return;
      }
      const parsed = await parseJsonBody(req, maxBodyBytes);
      if (!parsed.ok) {
        sendJSON(res, parsed.tooLarge ? 413 : 400, { error: parsed.error }, corsOrigin, parsed.tooLarge ? { connectionClose: true } : undefined);
        return;
      }
      // 凭证净化：author/text 先组合 scrub 再落盘（持久化还有 final safety net）。
      const author = redactProblemText(typeof parsed.body.author === 'string' ? parsed.body.author : '');
      const text = redactProblemText(typeof parsed.body.text === 'string' ? parsed.body.text : '');
      try {
        const updated = addDiscussion(id, { author, text }, { tasksDir, envKey });
        if (!updated) {
          sendJSON(res, 404, { error: 'not found' }, corsOrigin);
          return;
        }
        sendJSON(res, 200, redactProblemJSON(updated), corsOrigin);
      } catch (e) {
        problemError(e);
      }
      return;
    }

    if (req.method === 'POST' && problemGithub) {
      const id = problemGithub[1];
      if (!PROBLEM_ID_RE.test(id)) {
        sendJSON(res, 404, { error: 'not found' }, corsOrigin);
        return;
      }
      const problem = getProblem(id, { tasksDir });
      if (!problem) {
        sendJSON(res, 404, { error: 'not found' }, corsOrigin);
        return;
      }
      const parsed = await parseJsonBody(req, maxBodyBytes);
      if (!parsed.ok) {
        sendJSON(res, parsed.tooLarge ? 413 : 400, { error: parsed.error }, corsOrigin, parsed.tooLarge ? { connectionClose: true } : undefined);
        return;
      }
      const repo =
        typeof parsed.body.repo === 'string' && parsed.body.repo.trim()
          ? parsed.body.repo.trim()
          : undefined;
      const dryRun = parsed.body.dryRun === true;
      let result;
      try {
        result = await createGithubIssueFn(problem, { repo, dryRun });
      } catch (e) {
        sendJSON(res, 500, { error: `github issue create failed: ${redactKey(e.message, envKey)}` }, corsOrigin);
        return;
      }
      if (!result.ok) {
        // gh 缺失/未登录/非零退出 → 明确错误；本地 Problem 保持原状。
        sendJSON(res, 502, { error: result.error }, corsOrigin);
        return;
      }
      if (result.dryRun) {
        sendJSON(res, 200, { ok: true, dryRun: true, problem: redactProblemJSON(problem) }, corsOrigin);
        return;
      }
      try {
        const updated = setGithubRef(
          id,
          { issue_number: result.issue_number, url: result.url },
          { tasksDir, envKey }
        );
        if (!updated) {
          sendJSON(res, 404, { error: 'not found' }, corsOrigin);
          return;
        }
        sendJSON(res, 200, redactProblemJSON(updated), corsOrigin);
      } catch (e) {
        problemError(e);
      }
      return;
    }

    sendJSON(res, 404, { error: 'not found' }, corsOrigin);
  }

  return server;
}

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--port') opts.port = Number(next());
    else if (a === '--host') opts.host = next();
    else if (a === '--allow-origin') {
      opts.allowOrigin ??= [];
      opts.allowOrigin.push(next());
    } else if (a === '--tasks-dir') opts.tasksDir = next();
  }
  return opts;
}

function usage() {
  return `usage: node tools/service.mjs --tasks-dir <dir> [--port 8787] [--host 127.0.0.1] [--allow-origin URL ...]

required:
  --tasks-dir DIR   directory the runner persists task/bundle/audit/raw files into

options:
  --port PORT         listen port (default: ${DEFAULT_PORT})
  --host HOST         bind address (default: ${DEFAULT_HOST}). Use 0.0.0.0 to listen on
                      all interfaces, e.g. so a Tailscale in-network page can reach the
                      service; access control for the network is the deployer's concern.
  --allow-origin URL  repeatable: add an exact Origin to the CORS allowlist (e.g.
                      http://100.114.76.34:8000). CORS headers are echoed only for
                      localhost/127.0.0.1 origins or allow-listed origins; any other
                      Origin is rejected without CORS headers.
`;
}

// Default listen wrapper so main() can be unit-tested without binding a port.
const defaultListen = (server, port, host, cb) => server.listen(port, host, cb);

export async function main(
  argv = process.argv.slice(2),
  { log = console.log, listen = defaultListen } = {}
) {
  // Entry-layer .env loading: repo-root `.env` fills in missing process env
  // (existing values win); parse failures warn, never exit; values never logged.
  loadDotEnv();
  // Last-resort guard: an unhandled rejection must not terminate the service
  // (which would lose every in-flight diagnosis). The message is redacted so a
  // credential-shaped value never reaches the log.
  process.on('unhandledRejection', (err) => {
    const key = process.env.ANTHROPIC_API_KEY;
    console.error(`service: unhandled rejection: ${redactKey(err?.message ?? String(err), key)}`);
  });
  const opts = parseArgs(argv);
  if (opts.help || !opts.tasksDir) {
    log(usage());
    if (!opts.tasksDir) process.exitCode = 2;
    return;
  }
  const port = Number.isInteger(opts.port) && opts.port > 0 ? opts.port : DEFAULT_PORT;
  const host = opts.host ?? DEFAULT_HOST;
  const server = createService({
    tasksDir: opts.tasksDir,
    log,
    allowedOrigins: opts.allowOrigin ?? [],
  });
  listen(server, port, host, () => {
    log(`observation diagnosis service listening on http://${host}:${port}`);
    log(`tasks dir: ${opts.tasksDir}`);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`service failed: ${err?.message ?? err}`);
    process.exit(1);
  });
}
