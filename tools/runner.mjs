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
// 人话标签双端共享：模块落点在 viewer/（浏览器静态服务只能 import viewer/ 内的模块，
// 见 viewer/event-labels.js 头注释）。tools→viewer 引用有先例（tools/github.mjs）。
import { describeEvent } from '../viewer/event-labels.js';

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
  // P20 事件锚定确认步：captured → [提案] → awaiting_confirmation → [确认] → confirmed
  // → [诊断] → 终态。confirmed 与 captured 同语义（等人来取），不自动触发诊断。
  'awaiting_confirmation',
  'confirmed',
  'auditing',
  'audit_ready',
  'diagnosing',
  'diagnosed',
  'insufficient_evidence',
  'provider_unavailable',
  'failed',
];

// --- P20 事件锚定确认：确认的校验 + 状态流转（service 与 queue-cli 共用） ----

// 确认来自哪个面（design D3/D7）。
export const CONFIRM_SOURCES = ['page', 'cli', 'chat'];

// 接受确认的任务态：captured（跳过提案直接确认）/ awaiting_confirmation（提案后确认）/
// confirmed（诊断前改主意，重确认即覆盖锚点）。诊断已启动或已终态的任务不再接受确认。
export const CONFIRMABLE_STATUSES = ['captured', 'awaiting_confirmation', 'confirmed'];

/**
 * 把一次确认应用到任务上（纯函数，不改入参）。校验 + 状态流转的唯一实现，
 * service 的 POST /tasks/:id/confirm 与 queue-cli 的 confirm 子命令共用，避免两处漂移。
 *
 * @returns {{ok:true, task:object}} 或 {{ok:false, code:'NOT_FOUND'|'BAD_REQUEST'|'CONFLICT', error:string}}
 *   `note` 由调用方先抹除凭证再传入（调用方掌握存活 key）。
 */
export function confirmTask(task, { event_indexes, source = 'page', note = '' } = {}, { at } = {}) {
  if (task === null || typeof task !== 'object') {
    return { ok: false, code: 'NOT_FOUND', error: 'task not found' };
  }
  if (!Array.isArray(event_indexes)) {
    return { ok: false, code: 'BAD_REQUEST', error: 'event_indexes must be an array' };
  }
  if (event_indexes.some((i) => !Number.isInteger(i) || i < 0)) {
    return { ok: false, code: 'BAD_REQUEST', error: 'event_indexes must contain non-negative integers' };
  }
  if (!CONFIRM_SOURCES.includes(source)) {
    return { ok: false, code: 'BAD_REQUEST', error: `source must be one of: ${CONFIRM_SOURCES.join(', ')}` };
  }
  if (!CONFIRMABLE_STATUSES.includes(task.status)) {
    return { ok: false, code: 'CONFLICT', error: `task status is ${task.status}, cannot confirm` };
  }
  const next = { ...task };
  next.confirmation = {
    event_indexes: event_indexes.slice(),
    source,
    note: typeof note === 'string' ? note : '',
  };
  if (next.status !== 'confirmed') {
    next.status = 'confirmed';
    next.status_history = Array.isArray(next.status_history) ? [...next.status_history] : [];
    next.status_history.push({ status: 'confirmed', at: at ?? new Date().toISOString() });
  }
  return { ok: true, task: next };
}

// --- P20 事件锚定确认：人话标签 + 锚点渲染 --------------------------------
//
// 提案与诊断都以「窗口事件的人话标签」为依据；标签函数双端共享（viewer/event-labels.js，
// 见该文件头注释解释为何落点在 viewer/）。

/**
 * 把确认过的事件 index 集合映射回 bundle 里的原文，渲染成带人话标签的锚点块，
 * 供诊断 prompt 使用（design D6）。index 不在窗口里时如实标注，不静默丢弃——
 * 锚点缺失本身就是诊断要看到的证据。
 */
export function anchorEventsBlock(bundle, eventIndexes) {
  if (!Array.isArray(eventIndexes) || eventIndexes.length === 0) {
    return '（用户未锚定任何具体事件——请仅依据窗口全量事件与statement 判断）';
  }
  const events = Array.isArray(bundle?.events) ? bundle.events : [];
  const byIndex = new Map(events.map((e) => [e.index, e]));
  return eventIndexes
    .map((i) => {
      const e = byIndex.get(i);
      if (!e) return `- ${describeEvent({ index: i }, bundle?.lineup)}（该 index 不在观察窗口内）`;
      // 附上关键字段原文：标签给人看，原文让 agent 能据实核对。
      return `- ${describeEvent(e, bundle?.lineup)}  ${JSON.stringify(e)}`;
    })
    .join('\n');
}

// 提案 prompt：只要候选 index 集合 + 每条 why + 漂移提示，明确禁止诊断/改代码。
export function buildProposalPrompt({ bundlePath, statement = null }) {
  return `You are locating WHICH events in a saved match-observation window a user's
description refers to. This is a pure ANCHORING step — you are NOT diagnosing, NOT
proposing fixes, and you MUST NOT modify any file or run state-changing commands.

Read the observation bundle at: ${bundlePath}
${statement ? `\nThe user's statement: ${statement}\n` : ''}
The bundle's "events" array is the complete list of events inside the observation
window; each event carries an "index" (its position in the full event stream). The
"lineup" array maps player ids to teams (home = 0-10, away = 11-21).

Pick the few events the statement most plausibly refers to. IMPORTANT: a statement
may describe something that is NOT in the window (e.g. the user says "shot" but the
window only has a pass out of play). In that case:
- still return the closest candidates (or an empty set if truly nothing matches),
- and record the mismatch in "drift_hints" (what the user mentioned vs what the
  window actually contains), WITHOUT inventing an event.

Respond with a single JSON object containing EXACTLY these keys:
event_indexes, candidates, drift_hints
- event_indexes: array of integers — the candidate event indexes, best first. May be empty.
- candidates: array of { index: integer, why: string } — one entry per event_indexes
  member, "why" explaining the link to the statement (in Chinese).
- drift_hints: array of { mention: string, hint: string } — for each thing the user
  mentioned that is missing or different in the window, "mention" = the user's word,
  "hint" = what the window actually shows (in Chinese). Empty array if none.

Do not add any other keys. Do not diagnose. Do not edit files.
`;
}

// 解析并规范化 agent 的提案输出。非法/缺失字段一律回退为安全默认值，绝不抛异常：
// 提案只是给用户的建议，宁可少给候选也不能因此让确认步失败。
export function normalizeProposal(report) {
  const value = typeof report === 'string' ? extractReportJSON(report) : report;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { event_indexes: [], candidates: [], drift_hints: [] };
  }
  const eventIndexes = Array.isArray(value.event_indexes)
    ? value.event_indexes.filter((i) => Number.isInteger(i))
    : [];
  const candidates = Array.isArray(value.candidates)
    ? value.candidates
        .filter((c) => c && typeof c === 'object' && Number.isInteger(c.index))
        .map((c) => ({ index: c.index, why: typeof c.why === 'string' ? c.why : '' }))
    : [];
  const driftHints = Array.isArray(value.drift_hints)
    ? value.drift_hints
        .filter((d) => d && typeof d === 'object')
        .map((d) => ({
          mention: typeof d.mention === 'string' ? d.mention : '',
          hint: typeof d.hint === 'string' ? d.hint : '',
        }))
    : [];
  return { event_indexes: eventIndexes, candidates, drift_hints: driftHints };
}

// --- prompt construction ----------------------------------------------------

export function buildDiagnosisPrompt({
  bundlePath,
  auditPath,
  replayInstructions,
  sourceRevision,
  bundleSourceRevision = null,
  statement = null,
  permission = 'bypass',
  anchors = null,
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

${anchors ? `The user has CONFIRMED these events as the anchor of their statement (P20
event-anchoring step). Treat them as the authoritative starting point of the
diagnosis — the phenomenon to explain is the one these events show. Do not
re-derive a different anchor set. If the anchor events contradict the statement
(e.g. the user said "shot" but the confirmed event is a pass), call that out
explicitly in phenomenon_summary instead of silently reinterpreting.
Confirmed anchor events (human label + raw event):
${anchors}
` : ''}
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

  // P14 queue-only 续跑：若 runId 对应一个「源自入队」的任务（service 落盘 captured，或
  // 已失败但 status_history 以 captured 开头——queue-cli 允许对失败任务重试），把它的
  // status_history 前置，保证最终历史含 captured → auditing → … 完整流转（即使重试多次，
  // captured 起点也保留，使 queue-cli 能继续判定为可重试）。旧 task 不存在或非入队源起
  // 时不特殊处理（全新跑）。
  const preExistingTaskPath = join(tasksDir, `${finalRunId}.task.json`);
  let preExistingHistory = [];
  let preExistingProposal = null;
  let preExistingConfirmation = null;
  try {
    const pre = JSON.parse(readFileSync(preExistingTaskPath, 'utf8'));
    if (pre && Array.isArray(pre.status_history) && pre.status_history[0]?.status === 'captured') {
      preExistingHistory = pre.status_history;
    }
    // P20：诊断阶段要沿用提案阶段/用户确认落下的 proposal + confirmation（诊断 prompt
    // 据此锚定）。重新构造 task 会把它们冲掉，故显式带过来。旧任务没有这两个字段时保持
    // null（兼容：无确认步的旧 task 诊断行为不变）。
    if (pre && typeof pre === 'object') {
      if (pre.proposal && typeof pre.proposal === 'object') preExistingProposal = pre.proposal;
      if (pre.confirmation && typeof pre.confirmation === 'object') preExistingConfirmation = pre.confirmation;
    }
  } catch {
    // 无旧 task（全新 runId）或文件损坏——忽略，按全新跑处理。
  }
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
    // P20：保留确认步产物（提案 + 用户确认），诊断据此锚定事件。
    proposal: preExistingProposal,
    confirmation: preExistingConfirmation,
    status_history: [...preExistingHistory, { status: 'auditing', at: startedAt }],
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
  // P20 D6：若任务带用户确认的事件锚点（confirmation.event_indexes），把对应事件原文
  // 作为锚点传给诊断 agent，不再让它自己猜。无 confirmation（旧任务/未走确认步）时为 null，
  // 诊断行为与 P19 完全一致。
  const anchors = preExistingConfirmation
    ? anchorEventsBlock(bundle, preExistingConfirmation.event_indexes)
    : null;
  const prompt = buildDiagnosisPrompt({
    bundlePath: displayBundlePath,
    auditPath: displayAuditPath,
    replayInstructions: displayReplay,
    sourceRevision: displayRevision,
    bundleSourceRevision: displayBundleRevision,
    statement: displayStatement,
    permission: cfg.permission,
    anchors,
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

// P20 提案模式：读 bundle → 调 provider 产出候选事件 index 集合 → 写
// awaiting_confirmation + proposal。**只提案不诊断**，也不触碰 audit（确认步发生在诊断前）。
//
// 与 runDiagnosis 的差异（design D5）：
//   - 无 provider（无 API key / provider 报不可用）不失败：写 proposal.source='fallback-empty'、
//     event_indexes/candidates 空，状态仍 awaiting_confirmation。用户直接从全量事件列表选。
//   - agent 输出无法解析时同样回退 fallback-empty（而非 failed）——提案失败不该卡死确认步。
//   - 旧 task 的 proposal/confirmation/status_history 被带过来：提案可重跑，确认不被冲掉。
export async function runProposal({
  bundlePath,
  statement = null,
  tasksDir,
  config = DEFAULT_RUNNER_CONFIG,
  adapter = null,
  env = process.env,
  now = () => new Date().toISOString(),
  runId = null,
} = {}) {
  const cfg = { ...DEFAULT_RUNNER_CONFIG, ...config };
  const finalRunId = runId ?? randomUUID();
  const startedAt = now();
  const envKey = env.ANTHROPIC_API_KEY;

  // 沿用旧 task 的历史与确认产物（提案可重跑；已确认的 confirmation 不因再提案丢失）。
  // 历史只要非空就整体带上——不要求首态是 captured：runProposal 不做 `captured` 源起判定
  // （那是 runDiagnosis/isRerunnable 的事），首态是 awaiting_confirmation 的任务再提案时
  // 若丢掉历史会写空 status_history（复核 N1）。
  const preExistingTaskPath = join(tasksDir, `${finalRunId}.task.json`);
  let preExistingHistory = [];
  let preExistingConfirmation = null;
  let preExistingStatus = null;
  try {
    const pre = JSON.parse(readFileSync(preExistingTaskPath, 'utf8'));
    if (pre && typeof pre === 'object') {
      if (Array.isArray(pre.status_history) && pre.status_history.length > 0) {
        preExistingHistory = pre.status_history;
      }
      if (pre.confirmation && typeof pre.confirmation === 'object') preExistingConfirmation = pre.confirmation;
      if (typeof pre.status === 'string') preExistingStatus = pre.status;
    }
  } catch {
    // 全新 runId 或文件损坏——按全新任务处理。
  }
  // 对一个已 confirmed 的任务重新提案时，状态不能退回 awaiting_confirmation——那会让任务
  // 卡在「isRerunnable 不收、也不等人确认」的死角（复核 finding 2）。已确认的锚点仍在，
  // 重新提案只是刷新候选，状态保持 confirmed（等人取诊断）。
  const reproposalOfConfirmed = preExistingStatus === 'confirmed' && preExistingConfirmation !== null;

  const displayBundlePath = scrubText(bundlePath, envKey);
  const displayStatement = statement == null ? null : scrubText(statement, envKey);

  const task = {
    run_id: finalRunId,
    status: reproposalOfConfirmed ? 'confirmed' : 'awaiting_confirmation',
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
    raw_output_ref: null,
    errors: [],
    retries: { attempts: 0, max_retry: cfg.max_retry, reasons: [] },
    failure_kind: null,
    proposal: null,
    confirmation: preExistingConfirmation,
    status_history: reproposalOfConfirmed
      ? [...preExistingHistory] // 状态未变（confirmed）→ 不追加冗余流转
      : [...preExistingHistory, { status: 'awaiting_confirmation', at: startedAt }],
  };

  const persist = () => {
    const safe = JSON.parse(redactTaskText(task, envKey));
    Object.assign(task, safe);
    persistTask(task, tasksDir, envKey);
    return task;
  };

  // 读 + 校验 bundle（提案需要事件列表）。读不到/非法 → 失败（没有事件无从提案）。
  let bundle;
  try {
    bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  } catch (e) {
    task.errors.push(`cannot read bundle: ${e.message}`);
    task.failure_kind = 'bundle_read_error';
    return persist();
  }
  const bundleCheck = validateObservationBundle(bundle);
  if (!bundleCheck.valid) {
    task.errors.push(...bundleCheck.errors);
    task.failure_kind = 'invalid_bundle';
    return persist();
  }
  task.input_summary = {
    bundle_path: displayBundlePath,
    observation_id: bundle.observation_id,
    seed: bundle.seed,
    match_time: bundle.match_time,
  };

  // 无 provider → fallback-empty（不失败）。用户从全量事件列表自行选。
  if (!env.ANTHROPIC_API_KEY) {
    task.proposal = { event_indexes: [], candidates: [], drift_hints: [], source: 'fallback-empty' };
    task.retries.reasons.push('no provider: proposal is fallback-empty');
    return persist();
  }

  const prompt = buildProposalPrompt({ bundlePath: displayBundlePath, statement: displayStatement });
  const provider = adapter ?? createProviderAdapter(cfg);
  let proposal = { event_indexes: [], candidates: [], drift_hints: [], source: 'fallback-empty' };
  // 单次尝试：提案失败（provider 不可用/超时/error/非零退出/无法解析）一律回退 fallback-empty。
  // 确认步是可选增强，不该因提案失败而失败——用户永远能从全量列表手动勾选，故不重试
  // （与诊断不同：诊断输出非法要重试，提案空/错只是少给建议）。max_retry 仍是任务字段，
  // 但提案路径不用它重跑。
  task.retries.attempts = 1;
  let run;
  try {
    run = await provider.run(prompt, { env, timeoutMs: (cfg.timeout_seconds ?? 300) * 1000 });
  } catch (e) {
    task.retries.reasons.push(`proposal provider.run threw: ${e.message}`);
    run = null;
  }
  if (run) {
    if (run.status === 'provider_unavailable' || run.status === 'timeout' || run.status === 'error' || run.ok === false) {
      task.retries.reasons.push(`proposal provider unavailable/failed: ${run.error ?? run.status}`);
    } else if (run.exitCode !== null && run.exitCode !== undefined && run.exitCode !== 0) {
      task.retries.reasons.push(`proposal provider exited with code ${run.exitCode}`);
    } else {
      const normalized = normalizeProposal(run.stdout ?? '');
      // 空提案（模型没选出任何候选）也算 fallback-empty：用户改从全量列表选。
      if (normalized.event_indexes.length === 0 && normalized.candidates.length === 0) {
        task.retries.reasons.push('proposal returned no candidates; using fallback-empty');
      } else {
        proposal = { ...normalized, source: 'llm' };
      }
    }
  }
  task.proposal = proposal;
  task.command_exit_status = null;
  return persist();
}
