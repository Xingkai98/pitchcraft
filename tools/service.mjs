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
import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
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
  deleteProblem,
  rerunProblem,
  setProblemReport,
  problemInputFromDiagnosis,
  importProblems,
  ProblemError,
  PROBLEM_ID_RE,
  TRIAGE_VALUES,
  STATUS_VALUES,
  CLOSED_TRIAGE,
  defaultProblemId,
  recordVerify,
  recordFix,
  recordFixFailure,
  recordMergeFix,
  recordRejectFix,
} from './problems.mjs';
import { createGithubIssue } from './github.mjs';
import { verifyProblem, runFix, gitRun } from './actions.mjs';

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
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
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
  // P13 动作注入：verify 执行器 / fix 编排 / git 执行（测试用 fake）。
  verifyProblemFn = verifyProblem,
  runFixFn = runFix,
  gitExec = gitRun,
  log = () => {},
  // P14 queue-only：入队不自动跑诊断（页面只提交，用户在 paseo/CLI 侧手动取任务）。
  queueOnly = false,
} = {}) {
  if (!tasksDir) throw new Error('createService: tasksDir is required');
  mkdirSync(tasksDir, { recursive: true });
  const envKey = env.ANTHROPIC_API_KEY;
  const checkoutRevision = sourceRevision ?? readRepoRevision() ?? null;

  // fix 下发互斥（进程内 Set）：同一 problem 同一时刻只允许一个 fix 在跑。持久化守卫
  // （fix_ref pending_confirm）要等 agent 完成后才写入，存在 check-then-act 窗口——
  // 双击/并发请求会双双通过。进程内互斥在 add 与 check 之间无 await，竞态消除；
  // 服务重启后锁自然消失（残留 worktree 由 fix_ref 不建的失败语义兜底）。
  const fixDispatchInFlight = new Set();

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
      // The bundle is the single source of truth for the observer's description: the
      // page refreshes it back over its localStorage copy. `?? null` keeps an empty
      // string distinct from a missing bundle, so the page can tell "cleared" from
      // "unknown". Redacted below with the rest of the response.
      statement: readBundle(id)?.statement ?? null,
    };
    // Defense-in-depth: the persisted task is already redacted; re-scrub the
    // composed response so a live env key value never leaves the service.
    return JSON.parse(redactKey(JSON.stringify(response), envKey));
  };

  // 读任务关联的原始 bundle（可空）：create-from-report / rerun / import 复用。
  // bundle 是观察采集快照（含 statement/observation_id），用户文本在进 description
  // 前由 problemInputFromDiagnosis 做 redactKey。
  const readBundle = (taskId) => {
    try {
      return JSON.parse(readFileSync(join(tasksDir, `${taskId}.bundle.json`), 'utf8'));
    } catch {
      return null;
    }
  };

  // 列出 tasks 目录里全部任务 id（*.task.json 文件名）。import 缺省扫描用。
  const listTaskIds = () => {
    let files;
    try {
      files = readdirSync(tasksDir);
    } catch {
      return [];
    }
    return files.filter((f) => f.endsWith('.task.json')).map((f) => f.slice(0, -'.task.json'.length));
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

      if (queueOnly) {
        // P14 queue-only：只入队，不自动跑诊断。落盘 captured 任务，用户在 paseo/CLI
        // 侧用 runner-cli --run-id <id> 手动取任务跑。不读 provider 凭证、不启动诊断。
        const capturedAt = new Date().toISOString();
        const capturedTask = {
          run_id: runId,
          task_id: runId,
          status: 'captured',
          input_summary: null,
          provider: null,
          started_at: capturedAt,
          ended_at: null,
          command_exit_status: null,
          report: null,
          raw_output_ref: null,
          errors: [],
          retries: { attempts: 0, max_retry: 0, reasons: [] },
          failure_kind: null,
          status_history: [{ status: 'captured', at: capturedAt }],
        };
        try {
          writeFileSync(join(tasksDir, `${runId}.task.json`), JSON.stringify(capturedTask, null, 2));
        } catch (e) {
          // 写盘失败：删掉刚落的 bundle，避免孤儿 bundle 让 GET /tasks/:id 误显 auditing。
          try { unlinkSync(join(tasksDir, `${runId}.bundle.json`)); } catch { /* best-effort */ }
          sendJSON(res, 500, { error: `cannot persist captured task: ${e.code ?? e.message}` }, corsOrigin);
          return;
        }
        sendJSON(res, 202, { task_id: runId, queued: true }, corsOrigin);
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
    const problemImport = pathname === '/problems/import';
    const problemDetail = /^\/problems\/([^/]+)$/.exec(pathname);
    const problemDiscussion = /^\/problems\/([^/]+)\/discussion$/.exec(pathname);
    const problemGithub = /^\/problems\/([^/]+)\/github$/.exec(pathname);
    const problemRerun = /^\/problems\/([^/]+)\/rerun$/.exec(pathname);
    const problemVerify = /^\/problems\/([^/]+)\/verify$/.exec(pathname);
    const problemFix = /^\/problems\/([^/]+)\/fix$/.exec(pathname);
    const problemMergeFix = /^\/problems\/([^/]+)\/merge-fix$/.exec(pathname);
    // 领域错误映射：MISSING_REASON/BAD_REQUEST → 400，NOT_FOUND → 404，其他 500。
    // 500 分支的 message 一律净化，绝不外泄凭证。
    const problemError = (e) => {
      if (e instanceof ProblemError) {
        sendJSON(res, e.code === 'NOT_FOUND' ? 404 : 400, { error: e.message }, corsOrigin);
      } else {
        sendJSON(res, 500, { error: `problem operation failed: ${redactKey(e.message, envKey)}` }, corsOrigin);
      }
    };

    // --- P12 problem ops（rerun / delete / import）---------------------------

    if (req.method === 'POST' && problemImport) {
      const parsed = await parseJsonBody(req, maxBodyBytes);
      if (!parsed.ok) {
        sendJSON(res, parsed.tooLarge ? 413 : 400, { error: parsed.error }, corsOrigin, parsed.tooLarge ? { connectionClose: true } : undefined);
        return;
      }
      // body 可选 task_ids（TASK_ID_RE 校验，非法 400）；缺省 = 扫描全部 diagnosed 任务。
      let taskIds = null;
      if (parsed.body.task_ids !== undefined) {
        if (!Array.isArray(parsed.body.task_ids)) {
          sendJSON(res, 400, { error: 'task_ids must be an array' }, corsOrigin);
          return;
        }
        for (const t of parsed.body.task_ids) {
          if (typeof t !== 'string' || !TASK_ID_RE.test(t)) {
            sendJSON(res, 400, { error: 'invalid task_id' }, corsOrigin);
            return;
          }
        }
        taskIds = parsed.body.task_ids;
      }
      try {
        const result = importProblems(
          { tasksDir, task_ids: taskIds, readTask: readTaskState, listTaskIds, readBundle },
          { newId: newProblemId, envKey }
        );
        sendJSON(res, 200, result, corsOrigin);
      } catch (e) {
        problemError(e);
      }
      return;
    }

    if (req.method === 'DELETE' && problemDetail) {
      const id = problemDetail[1];
      if (!PROBLEM_ID_RE.test(id)) {
        sendJSON(res, 404, { error: 'not found' }, corsOrigin);
        return;
      }
      const deleted = deleteProblem(id, { tasksDir });
      if (!deleted) {
        sendJSON(res, 404, { error: 'not found' }, corsOrigin);
        return;
      }
      sendJSON(res, 200, { ok: true }, corsOrigin);
      return;
    }

    if (req.method === 'POST' && problemRerun) {
      const id = problemRerun[1];
      if (!PROBLEM_ID_RE.test(id)) {
        sendJSON(res, 404, { error: 'not found' }, corsOrigin);
        return;
      }
      const parsed = await parseJsonBody(req, maxBodyBytes);
      if (!parsed.ok) {
        sendJSON(res, parsed.tooLarge ? 413 : 400, { error: parsed.error }, corsOrigin, parsed.tooLarge ? { connectionClose: true } : undefined);
        return;
      }
      // reason 可空；用户可控文本先组合净化（redactKey + redactCredentialText）。
      const reasonRaw = typeof parsed.body.reason === 'string' ? parsed.body.reason.trim() : '';
      const reason = reasonRaw ? redactProblemText(reasonRaw) : null;
      const problem = getProblem(id, { tasksDir });
      if (!problem) {
        sendJSON(res, 404, { error: 'not found' }, corsOrigin);
        return;
      }
      // 关联任务的 bundle 是重跑输入；无 source.task_id / 非法 task_id / bundle
      // 缺失 → 400，问题不变。
      const oldTaskId = problem.source?.task_id;
      if (typeof oldTaskId !== 'string' || !TASK_ID_RE.test(oldTaskId)) {
        sendJSON(res, 400, { error: 'no bundle for rerun' }, corsOrigin);
        return;
      }
      const bundle = readBundle(oldTaskId);
      if (!bundle) {
        sendJSON(res, 400, { error: 'no bundle for rerun' }, corsOrigin);
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
      // 先落 bundle（202 前持久化），再把 problem 关联指向新任务。
      try {
        const updated = rerunProblem(id, { task_id: runId, reason }, { tasksDir, envKey });
        if (!updated) {
          sendJSON(res, 404, { error: 'not found' }, corsOrigin);
          return;
        }
      } catch (e) {
        problemError(e);
        return;
      }
      const serviceRevision = checkoutRevision ?? bundle.source_revision ?? '<unknown>';
      const replay = replayInstructionsFn(bundle);
      // 后台诊断与 POST /observations 同一模式；终态带 report 时写回 problem
      //（旧报告被覆盖，页面刷新详情拿到新报告）。
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
        .then((task) => {
          if (task && task.report && typeof task.report === 'object') {
            try {
              // runId 校验：写回只对当前 source.task_id 生效（并发 rerun 时丢弃旧诊断写回）。
              setProblemReport(id, task.report, { tasksDir, envKey, runId: task.run_id ?? runId });
            } catch (e) {
              log(`problem ${id} rerun report write-back failed: ${redactKey(e?.message ?? String(e), envKey)}`);
            }
          }
        })
        .catch((err) => {
          log(`problem ${id} rerun background run failed: ${redactKey(err?.message ?? String(err), envKey)}`);
        });
      sendJSON(res, 202, { task_id: runId }, corsOrigin);
      return;
    }

    // --- P13 problem actions（verify / fix / merge-fix）-------------------------

    // POST /problems/:id/verify —— 下发验证命令（白名单）。缺省命令取报告
    // verification 首条白名单命令；无命令/白名单外 → 400。decisions 追加 verify
    // 记录；body mark_fixed:true 且 exit 0 → status fixed（recordVerify 原子处理）。
    if (req.method === 'POST' && problemVerify) {
      const id = problemVerify[1];
      if (!PROBLEM_ID_RE.test(id)) {
        sendJSON(res, 404, { error: 'not found' }, corsOrigin);
        return;
      }
      const parsed = await parseJsonBody(req, maxBodyBytes);
      if (!parsed.ok) {
        sendJSON(res, parsed.tooLarge ? 413 : 400, { error: parsed.error }, corsOrigin, parsed.tooLarge ? { connectionClose: true } : undefined);
        return;
      }
      const problem = getProblem(id, { tasksDir });
      if (!problem) {
        sendJSON(res, 404, { error: 'not found' }, corsOrigin);
        return;
      }
      const command =
        typeof parsed.body.command === 'string' && parsed.body.command.trim()
          ? parsed.body.command.trim()
          : undefined;
      // closed-triage 问题不可能 mark_fixed：命令还没跑就拒绝，避免白跑一次验证。
      if (parsed.body.mark_fixed === true && CLOSED_TRIAGE.includes(problem.triage)) {
        sendJSON(res, 400, { error: `${problem.triage} problems are status=closed (cannot mark fixed)` }, corsOrigin);
        return;
      }
      let result;
      try {
        result = await verifyProblemFn(problem, { command, cwd: repoRoot, envKey });
      } catch (e) {
        problemError(e);
        return;
      }
      if (!result.ok) {
        sendJSON(res, 400, { error: result.error }, corsOrigin);
        return;
      }
      try {
        const updated = recordVerify(
          id,
          {
            command: result.command,
            exit_code: result.exit_code,
            summary: result.summary,
            markFixed: parsed.body.mark_fixed === true,
          },
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

    // POST /problems/:id/fix —— 在隔离 worktree 启动修复 agent（bypass）。同步等待
    // provider 完成；结果一律回写 decisions（成功建 fix_ref + status in_progress，
    // 失败只记录），响应 200 携带更新后的 problem。前置校验：closed-triage 问题与
    // 已有 pending fix 拒绝（400，问题不变）。
    if (req.method === 'POST' && problemFix) {
      const id = problemFix[1];
      if (!PROBLEM_ID_RE.test(id)) {
        sendJSON(res, 404, { error: 'not found' }, corsOrigin);
        return;
      }
      const parsed = await parseJsonBody(req, maxBodyBytes);
      if (!parsed.ok) {
        sendJSON(res, parsed.tooLarge ? 413 : 400, { error: parsed.error }, corsOrigin, parsed.tooLarge ? { connectionClose: true } : undefined);
        return;
      }
      const problem = getProblem(id, { tasksDir });
      if (!problem) {
        sendJSON(res, 404, { error: 'not found' }, corsOrigin);
        return;
      }
      if (CLOSED_TRIAGE.includes(problem.triage)) {
        sendJSON(res, 400, { error: `${problem.triage} problems are closed; cannot dispatch a fix` }, corsOrigin);
        return;
      }
      if (problem.fix_ref && problem.fix_ref.status === 'pending_confirm') {
        sendJSON(res, 400, { error: 'fix already pending; confirm or reject before dispatching another' }, corsOrigin);
        return;
      }
      // 进程内互斥：agent 运行期间（可达 600s）同一 problem 的重复下发直接 400。
      if (fixDispatchInFlight.has(id)) {
        sendJSON(res, 400, { error: 'fix already in progress; wait for it to finish' }, corsOrigin);
        return;
      }
      const extraRaw = typeof parsed.body.extra_instructions === 'string' ? parsed.body.extra_instructions : '';
      const extraInstructions = redactProblemText(extraRaw);
      fixDispatchInFlight.add(id);
      let result;
      try {
        result = await runFixFn({ problem, extraInstructions, env });
      } catch (e) {
        fixDispatchInFlight.delete(id);
        problemError(e);
        return;
      }
      fixDispatchInFlight.delete(id);
      try {
        let updated;
        if (!result.ok) {
          updated = recordFixFailure(
            id,
            {
              error: result.error ?? 'fix failed',
              worktree: result.worktree ?? null,
              branch: result.branch ?? null,
              summary: result.summary ?? null,
            },
            { tasksDir, envKey }
          );
        } else {
          updated = recordFix(
            id,
            {
              worktree: result.worktree,
              branch: result.branch,
              summary: result.summary,
              changed_files: result.changed_files,
              verification_results: result.verification_results,
            },
            { tasksDir, envKey }
          );
        }
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

    // POST /problems/:id/merge-fix —— 确认合入或拒绝修复。
    // 合入：校验 fix_ref pending_confirm + 分支有提交 + 验证记录全过（force 豁免）→
    // git merge --no-ff 入主 checkout → worktree 清理 → problem closed + change_ref +
    // fix_ref.status='merged'。
    // 拒绝（body reject:true）：fix_ref.status='rejected'，worktree 保留，problem 不闭环。
    if (req.method === 'POST' && problemMergeFix) {
      const id = problemMergeFix[1];
      if (!PROBLEM_ID_RE.test(id)) {
        sendJSON(res, 404, { error: 'not found' }, corsOrigin);
        return;
      }
      const parsed = await parseJsonBody(req, maxBodyBytes);
      if (!parsed.ok) {
        sendJSON(res, parsed.tooLarge ? 413 : 400, { error: parsed.error }, corsOrigin, parsed.tooLarge ? { connectionClose: true } : undefined);
        return;
      }
      const problem = getProblem(id, { tasksDir });
      if (!problem) {
        sendJSON(res, 404, { error: 'not found' }, corsOrigin);
        return;
      }
      const fixRef = problem.fix_ref;
      if (!fixRef || typeof fixRef !== 'object' || Array.isArray(fixRef) || fixRef.status !== 'pending_confirm') {
        sendJSON(res, 400, { error: 'no pending fix to merge or reject' }, corsOrigin);
        return;
      }
      const branch = typeof fixRef.branch === 'string' ? fixRef.branch : '';
      const worktree = typeof fixRef.worktree === 'string' ? fixRef.worktree : '';
      if (!branch) {
        sendJSON(res, 400, { error: 'fix_ref missing branch' }, corsOrigin);
        return;
      }

      if (parsed.body.reject === true) {
        const reasonRaw = typeof parsed.body.reason === 'string' ? parsed.body.reason.trim() : '';
        try {
          const updated = recordRejectFix(
            id,
            { reason: reasonRaw ? redactProblemText(reasonRaw) : null, worktree, branch },
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

      // 合入路径：分支必须有提交。
      const rev = await gitExec(['rev-parse', '--verify', `${branch}^{commit}`], { cwd: repoRoot });
      if (!rev.ok) {
        sendJSON(res, 400, { error: `fix branch ${redactKey(branch, envKey)} has no commits` }, corsOrigin);
        return;
      }
      // 验证记录必须全过（exit 0）；force:true 豁免。验证结果存在最近一条成功的 fix
      // 决策里（fix_ref 只记 worktree/branch/status，验证记录在审计轨迹）。
      const force = parsed.body.force === true;
      const fixDecisions = problem.decisions.filter(
        (d) => d && d.action === 'fix' && d.outcome === 'succeeded'
      );
      const lastFix = fixDecisions[fixDecisions.length - 1];
      const vrs = Array.isArray(lastFix?.verification_results) ? lastFix.verification_results : [];
      // 验证记录必须非空且全过（exit 0）；空列表 = agent 未跑验证，不满足「必须存在验证
      // 记录」，需 force 豁免。
      if (!force && (vrs.length === 0 || !vrs.every((v) => v && typeof v === 'object' && v.exit_code === 0))) {
        sendJSON(res, 400, { error: 'fix verification did not all pass (use force to override)' }, corsOrigin);
        return;
      }
      const title = typeof problem.title === 'string' && problem.title.trim() ? problem.title.trim() : id;
      const merge = await gitExec(['merge', '--no-ff', branch, '-m', `fix ${id}: ${title}`], { cwd: repoRoot });
      if (!merge.ok) {
        sendJSON(
          res,
          500,
          { error: `merge failed: ${redactKey(String(merge.stderr || merge.stdout || '').trim() || 'unknown git error', envKey)}` },
          corsOrigin
        );
        return;
      }
      // worktree 清理（best-effort；失败不阻塞闭环，fix_ref 保留 worktree 路径）。
      if (worktree) {
        await gitExec(['worktree', 'remove', '--force', worktree], { cwd: repoRoot });
      }
      const changeRef =
        typeof parsed.body.change_ref === 'string' && parsed.body.change_ref.trim()
          ? parsed.body.change_ref.trim()
          : `fix/${id}`;
      try {
        const updated = recordMergeFix(id, { changeRef, worktree, branch }, { tasksDir, envKey });
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
        // 公共 create-from-report 路径（P12 与 /problems/import 共用）。
        input = problemInputFromDiagnosis({
          task_id,
          task,
          bundle: readBundle(task_id),
          envKey,
          overrides: { title, description, triage, status, reason },
        });
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
    else if (a === '--queue-only') opts.queueOnly = true;
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
  --queue-only        only enqueue observations (persist bundle + captured task);
                      do not auto-start diagnosis. Take tasks manually via
                      runner-cli --run-id <id>.
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
    queueOnly: opts.queueOnly === true,
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
