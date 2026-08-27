// Local diagnosis runner.
//
// P10 vertical slice: coordinates a deterministic audit over an observation
// bundle, then runs a diagnosis against a provider adapter and persists a
// structured, reviewable task record. Diagnosis defaults to bypass permission
// (agent may execute verification commands and modify files); `read-only`
// restores the strict plan+no-edit contract. No WASM. No real Claude/API calls
// happen here directly — only through the injected adapter, and never in tests.
// Credentials live only in the runner process environment.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateObservationBundle, assertNoCredentials } from './bundle.mjs';
import { runAudit } from './detectors.mjs';
import { createProviderAdapter, redactKey } from './provider.mjs';

export const DEFAULT_RUNNER_CONFIG = {
  provider: 'claude-code',
  command: 'claude',
  model: null,
  permission: 'bypass',
  read_only: false,
  budget: null,
  timeout_seconds: 300,
  max_retry: 1,
};

// Structured report fields the agent MUST return. Anything missing them is not
// a valid diagnosis.
export const REPORT_FIELDS = [
  'status',
  'phenomenon_summary',
  'layer',
  'hypotheses',
  'root_cause',
  'proposed_fix',
  'verification',
  'confidence',
];

// statuses the agent may use in its structured report.
export const REPORT_STATUSES = ['diagnosed', 'insufficient_evidence'];

// Triage classification the agent attaches to every diagnosed report.
// Categories judge the NATURE of the root cause, not the fix effort.
export const TRIAGE_CATEGORIES = ['bug', 'design', 'discuss'];

// Fallback when the agent omits triage or returns an invalid one: the report is
// NOT rejected — the runner labels it `discuss` rather than deciding for the
// agent (design.md 4.5).
export const TRIAGE_FALLBACK_MISSING = {
  category: 'discuss',
  rationale: 'agent 未提供分类',
  confidence: 0,
};
export const TRIAGE_FALLBACK_INVALID = {
  category: 'discuss',
  rationale: 'agent 未提供分类（非法分类已兜底）',
  confidence: 0,
};

// task lifecycle statuses assigned by the runner (mirror of match-observation
// spec). Internal failure detail (invalid_bundle, timeout, invalid_agent_output,
// provider error, ...) is recorded via `failure_kind` / `errors`, never persisted
// as a bare task.status.
export const TASK_STATUSES = [
  'captured',
  'auditing',
  'audit_ready',
  'diagnosing',
  'diagnosed',
  'insufficient_evidence',
  'provider_unavailable',
  'failed',
];

// --- prompt construction ----------------------------------------------------

export function buildDiagnosisPrompt({
  bundlePath,
  auditPath,
  replayInstructions,
  sourceRevision,
  bundleSourceRevision = null,
  statement = null,
  permission = 'bypass',
}) {
  // Default is bypass (full tool access): the agent actually executes the
  // replay/verification commands and may modify files, recording what it did.
  // read-only/plan keep the strict no-edit contract and defer command execution
  // to the runner/user.
  const readOnly = permission === 'read-only' || permission === 'plan';
  const modeNote = readOnly
    ? `You are in ${permission} mode (read-only). You MUST NOT modify any source,
configuration, OpenSpec, or test files. Read evidence and code only. You may
inspect files and run read-only verification commands if the environment allows
them, but you MUST NOT attempt to execute state-changing commands.`
    : `You are in ${permission} mode (bypass: full tool access). You have full tool
permission: actually execute the replay/verification commands (same-seed replay,
run the relevant tests) to reproduce the observation. You MAY modify source,
configuration, or test files; record every modification you make in the report.`;

  const verificationNote = readOnly
    ? `Replay / verification instructions (the runner/user re-executes these
separately; you do not run the full pipeline yourself):
${replayInstructions}

Walk the code to locate the responsible layer and rules/symbols. PROPOSE the
exact verification command(s) that replay the original window and prove (or
refute) your conclusion. Those commands go in the "verification" field of your
report so the runner/user can execute them in a permitted environment.`
    : `Replay / verification instructions (you are permitted to execute these in
bypass mode; use them to reproduce the observation):
${replayInstructions}

Walk the code to locate the responsible layer and rules/symbols. EXECUTE the
exact verification command(s) that replay the original window and prove (or
refute) your conclusion (same-seed replay, run the relevant tests). Also include
those commands in the "verification" field of your report so a human can
re-check them. Any file modification you make must be recorded in the report.`;

  return `You are diagnosing a match-realism observation in a football-manager 2D clone.

${modeNote}

Evidence to read (paths are authoritative):
- observation bundle: ${bundlePath}
- deterministic audit report: ${auditPath}
- current source revision (runner/checkout): ${sourceRevision}
${bundleSourceRevision ? `- observation bundle source revision: ${bundleSourceRevision}` : ''}
${statement ? `- user statement: ${statement}` : ''}

${verificationNote}

Classify the finding with a triage category. Judge by the NATURE of the root
cause, NOT by fix effort:
- bug: existing implementation behaves differently than intended; there is a
  clear root cause (file:line) and a verifiable fix path that does not change
  the product intent.
- design: the code works as designed but the design/model has a gap (missing
  mechanism, missing data, needs a product decision); a new design is needed,
  not a bug fix.
- discuss: root cause unclear, multi-factor, your confidence is low (<0.7), or
  the user must weigh trade-offs / confirm the phenomenon.
Every diagnosed report MUST carry a "triage" field. If you cannot classify with
confidence, choose "discuss".

If you CANNOT prove the phenomenon from the available evidence, return status
"insufficient_evidence" and DO NOT fabricate a root cause.

Respond with a single JSON object containing EXACTLY these keys:
${REPORT_FIELDS.join(', ')}
- status: one of ${REPORT_STATUSES.join(' | ')}
- phenomenon_summary, layer, root_cause, proposed_fix, verification: strings
- hypotheses: array of strings
- confidence: a number between 0 and 1
- triage: { category: one of ${TRIAGE_CATEGORIES.join(' | ')}, rationale: a
  string explaining the classification to the user, confidence: a number
  between 0 and 1 (confidence in the classification itself) }
`;
}

// --- structured report validation -------------------------------------------

const STRING_FIELDS = ['phenomenon_summary', 'layer', 'root_cause', 'proposed_fix', 'verification'];

// Extract a JSON object from provider text output. The adapter uses
// --output-format text, so stdout is the model's raw text (our JSON), possibly
// wrapped in a markdown code fence or with a little surrounding prose. Fall back
// to slicing the outermost JSON object so a fenced/verbose reply still parses.
export function extractReportJSON(text) {
  const trimmed = String(text ?? '').trim();
  const withoutFences = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try {
    return JSON.parse(withoutFences);
  } catch {
    /* fall through to slice */
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {
      return null;
    }
  }
  return null;
}

// Normalize the report's `triage` field. A missing or invalid triage does NOT
// reject the report: the runner falls back to `discuss` (design.md 4.5) instead
// of deciding for the agent. Returns { triage, note } where note is non-null for
// a fallback (used to surface the reason without failing the report).
export function normalizeTriage(triage) {
  if (triage === null || typeof triage !== 'object' || Array.isArray(triage)) {
    return { triage: TRIAGE_FALLBACK_MISSING, note: 'triage missing' };
  }
  const categoryOk = TRIAGE_CATEGORIES.includes(triage.category);
  const rationaleOk =
    typeof triage.rationale === 'string' && triage.rationale.trim().length > 0;
  const confidenceOk =
    typeof triage.confidence === 'number' &&
    !Number.isNaN(triage.confidence) &&
    triage.confidence >= 0 &&
    triage.confidence <= 1;
  if (categoryOk && rationaleOk && confidenceOk) {
    return {
      triage: {
        category: triage.category,
        rationale: triage.rationale,
        confidence: triage.confidence,
      },
      note: null,
    };
  }
  return { triage: TRIAGE_FALLBACK_INVALID, note: 'triage invalid (fallback)' };
}

// Parse and validate agent output. Returns { valid, report, errors }. Invalid
// output must not be marked diagnosed. Errors never contain credential values.
export function validateDiagnosisReport(report) {
  const errors = [];
  let value = report;

  if (typeof report === 'string') {
    value = extractReportJSON(report);
    if (value === null) {
      return {
        valid: false,
        report: null,
        errors: ['output does not contain a parseable JSON report'],
      };
    }
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, report: null, errors: ['report must be a JSON object'] };
  }

  for (const field of REPORT_FIELDS) {
    if (!(field in value)) errors.push(`report missing required field: ${field}`);
  }

  if (typeof value.status !== 'string' || !REPORT_STATUSES.includes(value.status)) {
    errors.push(`report status must be one of: ${REPORT_STATUSES.join(', ')}`);
  }

  for (const field of STRING_FIELDS) {
    if (field in value && typeof value[field] !== 'string') {
      // e.g. insufficient_evidence must use an empty string, never null.
      errors.push(`report field ${field} must be a string (use "" rather than null)`);
    }
  }

  if (!Array.isArray(value.hypotheses)) {
    errors.push('report hypotheses must be an array of strings');
  } else if (value.hypotheses.some((h) => typeof h !== 'string')) {
    errors.push('report hypotheses must contain only strings');
  }

  if (
    typeof value.confidence !== 'number' ||
    Number.isNaN(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1
  ) {
    errors.push('report confidence must be a number between 0 and 1');
  }

  // A valid report must never carry credentials into the persisted task.
  try {
    assertNoCredentials(value);
  } catch (e) {
    errors.push(e.message);
  }

  // triage is advisory, not required: a missing/invalid triage falls back to
  // `discuss` (with the reason in rationale) and never rejects the report. The
  // returned report always carries a normalized triage object.
  const { triage } = normalizeTriage(value.triage);
  const normalized = { ...value, triage };

  return { valid: errors.length === 0, report: normalized, errors };
}

// --- redaction helpers -------------------------------------------------------

// Scrub a single user/CLI-controlled value for display, prompt, or persistence.
// Uses redactKey so both a live env key value and generic sk-ant secrets are
// covered. Original values are preserved for real filesystem access; only the
// display/prompt copies returned here are scrubbed.
export function scrubText(value, secret) {
  return redactKey(String(value ?? ''), secret);
}

// Deep-redact a task object before persistence: stringify then scrub the key
// value and generic sk-ant secrets. Used as a final safety net.
export function redactTaskText(task, secret) {
  return redactKey(JSON.stringify(task), secret);
}

// --- persistence -------------------------------------------------------------

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function persistTask(task, tasksDir, envKey) {
  ensureDir(tasksDir);
  // Defense-in-depth: scrub before every persist, since intermediate writes
  // (audit_ready, diagnosing) precede finalize's final safety net. The in-memory
  // `task` is unchanged; only the on-disk copy is scrubbed.
  const safe = JSON.parse(redactTaskText(task, envKey));
  writeFileSync(join(tasksDir, `${task.run_id}.task.json`), JSON.stringify(safe, null, 2));
  return join(tasksDir, `${task.run_id}.task.json`);
}

function persistRaw(raw, runId, tasksDir) {
  ensureDir(tasksDir);
  writeFileSync(join(tasksDir, `${runId}.raw.txt`), raw);
  return `${runId}.raw.txt`;
}

// --- orchestration -----------------------------------------------------------

// Run the full pipeline for one observation bundle: validate -> audit -> (env
// gate) -> diagnosis -> validate output -> persist. `adapter` may be injected
// (tests use a fake); otherwise one is built from `config`.
export async function runDiagnosis({
  bundlePath,
  auditPath,
  replayInstructions,
  sourceRevision,
  statement = null,
  tasksDir,
  config = DEFAULT_RUNNER_CONFIG,
  adapter = null,
  env = process.env,
  now = () => new Date().toISOString(),
  runId = null,
} = {}) {
  const cfg = { ...DEFAULT_RUNNER_CONFIG, ...config };
  // runId is optional: the local service pre-generates a task_id so it can return
  // `202 { task_id }` immediately while runDiagnosis runs in the background. When
  // omitted the runner keeps generating a fresh random id (unchanged behavior).
  const finalRunId = runId ?? randomUUID();
  const startedAt = now();
  const envKey = env.ANTHROPIC_API_KEY;
  // Scrub all user/CLI-controlled values for display, prompt, and persistence so
  // a live key or sk-ant secret never reaches the provider or a persisted record.
  // Original paths are kept below for the real filesystem reads/writes.
  const displayBundlePath = scrubText(bundlePath, envKey);
  const displayAuditPath = scrubText(auditPath, envKey);
  const displayReplay = scrubText(replayInstructions, envKey);
  const displayRevision = scrubText(sourceRevision, envKey);
  const displayStatement = statement == null ? null : scrubText(statement, envKey);
  const rawOutputRef = null;
  const task = {
    run_id: finalRunId,
    status: 'auditing',
    input_summary: null,
    provider: {
      provider: cfg.provider,
      command: cfg.command,
      model: cfg.model ?? null,
      permission: cfg.permission,
      read_only: cfg.read_only,
      budget: cfg.budget ?? null,
      timeout_seconds: cfg.timeout_seconds,
      max_retry: cfg.max_retry,
    },
    started_at: startedAt,
    ended_at: null,
    command_exit_status: null,
    report: null,
    raw_output_ref: rawOutputRef,
    errors: [],
    retries: { attempts: 0, max_retry: cfg.max_retry, reasons: [] },
    failure_kind: null,
    status_history: [{ status: 'auditing', at: startedAt }],
  };

  // Record a status transition in both `status` and the persisted history.
  const transition = (status) => {
    task.status = status;
    task.status_history.push({ status, at: now() });
  };

  const finalize = (status, extra = {}) => {
    if (status !== task.status) transition(status);
    task.ended_at = now();
    if (extra.failure_kind !== undefined) task.failure_kind = extra.failure_kind;
    if (extra.report !== undefined) task.report = extra.report;
    if (extra.raw_output_ref !== undefined) task.raw_output_ref = extra.raw_output_ref;
    if (extra.exit_code !== undefined) task.command_exit_status = extra.exit_code;
    if (extra.errors) task.errors.push(...extra.errors);
    // Final safety net: the persisted task (and the returned object) must never
    // carry a live credential value. Only the process env key is redacted here.
    const redacted = JSON.parse(redactTaskText(task, envKey));
    Object.assign(task, redacted);
    persistTask(task, tasksDir, envKey);
    return task;
  };

  // 1. Load + validate the bundle.
  let bundle;
  try {
    bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  } catch (e) {
    task.errors.push(`cannot read bundle: ${e.message}`);
    return finalize('failed', { failure_kind: 'bundle_read_error' });
  }
  const bundleCheck = validateObservationBundle(bundle);
  if (!bundleCheck.valid) {
    task.errors.push(...bundleCheck.errors);
    return finalize('failed', { failure_kind: 'invalid_bundle' });
  }
  // Provenance: the audit report marks the BUNDLE's captured source revision
  // (that is what the spec says the bundle carries for traceability). The CLI/
  // current-checkout revision stays separate as runner_source_revision and is
  // what the diagnosis prompt uses. Both are scrubbed against the live env key
  // and credential-shaped patterns.
  const displayBundleRevision = scrubText(bundle.source_revision, envKey);

  // 2. Deterministic audit runs before any diagnosis. `audit_input` is a required
  //    bundle field (validator rejects bundles without it), so there is no silent
  //    fallback that would audit raw normalized viewer coordinates as meters.
  const audit = runAudit(bundle.audit_input);
  const auditReport = {
    profile: audit.profile,
    source_revision: displayBundleRevision,
    runner_source_revision: displayRevision,
    observation_id: bundle.observation_id,
    seed: bundle.seed,
    match_time: bundle.match_time,
    findings: audit.findings,
    // Per-detector sample/anomaly/unknown tallies enable deterministic
    // multi-seed aggregation across audit report files (task 2.6).
    stats: audit.stats,
    // Ordinary-pass outcome/pressure buckets for cross-seed aggregation.
    pass_outcomes: audit.pass_outcomes,
  };
  try {
    ensureDir(dirname(auditPath));
    writeFileSync(auditPath, JSON.stringify(auditReport, null, 2));
  } catch (e) {
    task.errors.push(`cannot write audit report: ${e.message}`);
    return finalize('failed', { failure_kind: 'audit_write_error' });
  }

  task.input_summary = {
    bundle_path: displayBundlePath,
    audit_path: displayAuditPath,
    source_revision: displayBundleRevision,
    runner_source_revision: displayRevision,
    observation_id: bundle.observation_id,
    seed: bundle.seed,
    match_time: bundle.match_time,
    finding_count: audit.findings.length,
  };
  transition('audit_ready');
  persistTask(task, tasksDir, envKey);

  // 3. Before any provider run, move to diagnosing. This covers the auth gate
  // below: a missing key still resolves from diagnosing -> provider_unavailable.
  transition('diagnosing');
  persistTask(task, tasksDir, envKey);

  // 4. Auth gate: key lives only in the runner process environment.
  if (!env.ANTHROPIC_API_KEY) {
    task.errors.push(
      'ANTHROPIC_API_KEY is not set; set it in the runner process environment to enable diagnosis'
    );
    return finalize('provider_unavailable');
  }

  // 5. Build the permission-aware prompt from scrubbed display values. Any user/CLI
  // input (statement, replayInstructions, sourceRevision, paths) may itself carry
  // a credential (e.g. the user pasted a key); none of it reaches the provider.
  const prompt = buildDiagnosisPrompt({
    bundlePath: displayBundlePath,
    auditPath: displayAuditPath,
    replayInstructions: displayReplay,
    sourceRevision: displayRevision,
    bundleSourceRevision: displayBundleRevision,
    statement: displayStatement,
    permission: cfg.permission,
  });

  // 6. Run the provider with retries on invalid output.
  const provider = adapter ?? createProviderAdapter(cfg);
  let lastOutput = '';
  let exitCode = null;
  let finalStatus = 'failed';
  let failureKind = 'invalid_agent_output';

  while (task.retries.attempts <= task.retries.max_retry) {
    task.retries.attempts += 1;
    let run;
    try {
      run = await provider.run(prompt, {
        env,
        timeoutMs: (cfg.timeout_seconds ?? 300) * 1000,
      });
    } catch (e) {
      task.retries.reasons.push(`provider.run threw: ${e.message}`);
      lastOutput = '';
      exitCode = null;
      finalStatus = 'failed';
      failureKind = 'provider_error';
      break;
    }

    // Provider-gate failures are terminal; do not retry.
    if (run.status === 'provider_unavailable') {
      task.retries.reasons.push('provider unavailable, not retrying');
      task.errors.push(run.error ?? 'provider unavailable');
      return finalize('provider_unavailable');
    }
    if (run.status === 'timeout') {
      task.retries.reasons.push('provider timed out');
      task.errors.push(run.error ?? 'provider timed out');
      lastOutput = run.stdout ?? '';
      exitCode = run.exitCode ?? null;
      finalStatus = 'failed';
      failureKind = 'timeout';
      break;
    }
    if (run.status === 'error' || run.ok === false) {
      task.retries.reasons.push(`provider error: ${run.error ?? 'unknown'}`);
      task.errors.push(run.error ?? 'provider run failed');
      lastOutput = run.stdout ?? '';
      exitCode = run.exitCode ?? null;
      finalStatus = 'failed';
      failureKind = 'provider_error';
      break;
    }

    lastOutput = run.stdout ?? '';
    exitCode = run.exitCode ?? null;
    task.command_exit_status = exitCode;

    // Even valid-looking output must not be diagnosed if the provider exited
    // non-zero — that signals a provider failure, not a diagnosis.
    if (exitCode !== null && exitCode !== 0) {
      task.retries.reasons.push(`valid-looking output but non-zero exit code ${exitCode}`);
      task.errors.push(`provider exited with code ${exitCode}; output not accepted as a diagnosis`);
      finalStatus = 'failed';
      failureKind = 'provider_error';
      break;
    }

    const check = validateDiagnosisReport(lastOutput);
    if (check.valid) {
      task.report = check.report;
      finalStatus =
        check.report.status === 'insufficient_evidence'
          ? 'insufficient_evidence'
          : 'diagnosed';
      failureKind = null;
      break;
    }
    task.retries.reasons.push(`invalid output: ${check.errors.join('; ')}`);
    task.errors.push(...check.errors.map((e) => `invalid agent output: ${e}`));
    finalStatus = 'failed';
    failureKind = 'invalid_agent_output';
  }

  // 7. Persist raw output to a separate file (never inline), redacted as a
  // final safety net against credential leakage.
  const rawRef = persistRaw(redactKey(lastOutput, envKey), finalRunId, tasksDir);
  return finalize(finalStatus, {
    raw_output_ref: rawRef,
    exit_code: exitCode,
    failure_kind: failureKind,
  });
}
