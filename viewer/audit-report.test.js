// viewer/audit-report.js 纯函数单测（无 DOM、无网络）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAuditImport,
  formatFinding,
  findingMarkers,
  formatReportSummary,
  redactText,
  taskResultToRender,
  formatTriage,
  buildChangeDraft,
  openQuestionsFromReport,
  confirmQuestionsFromReport,
  TRIAGE_CATEGORIES,
} from './audit-report.js';

const AUDIT_JSON = JSON.stringify({
  profile: { id: 'p10-mvp', version: '0.1.0' },
  findings: [
    {
      id: 'unforced_out:3',
      detector_id: 'unforced_out',
      event_index: 3,
      match_time: 12.5,
      entity_id: null,
      severity: 'realism_warning',
      reason: 'no_pressure_out',
    },
  ],
});

const TASK_JSON = JSON.stringify({
  status: 'diagnosed',
  report: {
    findings: [],
    phenomenon_summary: '普通传球在无压力下出界',
    layer: 'interpretation',
    root_cause: '落点未按边线钳制',
    hypotheses: ['边界钳制缺失'],
    proposed_fix: '落点 clamp 到边界内',
    verification: 'node --test viewer',
    confidence: 0.8,
  },
  errors: [],
});

test('parseAuditImport accepts a plain audit report', () => {
  const r = parseAuditImport(AUDIT_JSON);
  assert.equal(r.kind, 'audit');
  assert.equal(r.status, 'audit_ready');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].detector_id, 'unforced_out');
  assert.deepEqual(r.errors, []);
});

test('parseAuditImport accepts a task record and lifts its report findings', () => {
  const r = parseAuditImport(TASK_JSON);
  assert.equal(r.kind, 'task');
  assert.equal(r.status, 'diagnosed');
  assert.equal(r.findings.length, 0);
  assert.equal(r.report.root_cause, '落点未按边线钳制');
});

test('parseAuditImport reports invalid JSON without throwing', () => {
  const r = parseAuditImport('not json {{{');
  assert.equal(r.kind, 'invalid');
  assert.ok(r.errors.length > 0);
});

test('parseAuditImport reports unrecognized shape', () => {
  const r = parseAuditImport(JSON.stringify({ foo: 1 }));
  assert.equal(r.kind, 'unknown');
  assert.ok(r.errors.length > 0);
});

test('parseAuditImport rejects non-object / non-string input', () => {
  assert.equal(parseAuditImport(JSON.stringify([1, 2])).kind, 'invalid');
  assert.equal(parseAuditImport(null).kind, 'invalid');
});

test('formatFinding renders a readable single-line summary', () => {
  const f = {
    detector_id: 'unforced_out',
    severity: 'realism_warning',
    match_time: 12.5,
    entity_id: null,
    reason: 'no_pressure_out',
  };
  const s = formatFinding(f);
  assert.match(s, /unforced_out:realism_warning/);
  assert.match(s, /t=12\.5s/);
  assert.match(s, /no_pressure_out/);
});

test('findingMarkers produce jump targets by event_index and match_time', () => {
  const markers = findingMarkers([
    { detector_id: 'unforced_out', event_index: 3, match_time: 12.5, severity: 'realism_warning' },
    { detector_id: 'inactive_responsibility', entity_id: 5, match_time: 20, severity: 'unknown', reason: 'no trigger' },
  ]);
  assert.equal(markers.length, 2);
  assert.equal(markers[0].event_index, 3);
  assert.equal(markers[0].match_time, 12.5);
  assert.equal(markers[1].entity_id, 5);
  assert.equal(markers[0].marker_id, 'finding-0');
});

test('findingMarkers tolerate missing event_index/match_time', () => {
  const markers = findingMarkers([{ detector_id: 'x' }]);
  assert.equal(markers[0].event_index, null);
  assert.equal(markers[0].match_time, null);
  assert.equal(markers[0].severity, 'unknown');
});

test('findingMarkers handles empty findings', () => {
  assert.deepEqual(findingMarkers([]), []);
  assert.deepEqual(findingMarkers(null), []);
});

test('formatReportSummary renders diagnosis fields and never includes credentials', () => {
  const s = formatReportSummary({
    phenomenon_summary: '普通传球无压力出界',
    layer: 'interpretation',
    root_cause: '边界钳制缺失',
    proposed_fix: 'clamp 落点',
    verification: 'node --test viewer',
    hypotheses: ['A'],
    confidence: 0.8,
  });
  assert.match(s, /现象: 普通传球无压力出界/);
  assert.match(s, /根因: 边界钳制缺失/);
  assert.match(s, /置信度: 0\.8/);
  assert.doesNotMatch(s, /sk-ant|ANTHROPIC_API_KEY|api[_-]?key|secret|token/i);
});

test('formatReportSummary returns empty for empty/missing report', () => {
  assert.equal(formatReportSummary(null), '');
  assert.equal(formatReportSummary({}), '');
});

test('formatFinding redacts a sk-ant credential that leaked into finding reason text', () => {
  const s = formatFinding({
    detector_id: 'x',
    severity: 'realism_warning',
    match_time: 1,
    reason: 'auth leaked sk-ant-fake-secret-value-0001 here',
  });
  assert.match(s, /\[REDACTED\]/);
  assert.doesNotMatch(s, /sk-ant-fake-secret-value-0001/);
  assert.doesNotMatch(s, /sk-ant-/);
});

test('formatReportSummary redacts sk-ant and key-shaped snippets from imported report text', () => {
  const s = formatReportSummary({
    proposed_fix: 'rotate sk-ant-fake-secret-value-0002 now',
    root_cause: JSON.stringify({ api_key: 'live-looking-value' }),
    verification: 'use sk-ant-abc123',
  });
  assert.doesNotMatch(s, /sk-ant-fake-secret-value-0002/);
  assert.doesNotMatch(s, /sk-ant-/);
  assert.doesNotMatch(s, /live-looking-value/);
  assert.match(s, /\[REDACTED\]/);
});

test('redactText scrubs sk-ant tokens and credential key/value JSON snippets', () => {
  const out = redactText('key sk-ant-abc123 and {"api_key":"supersecret"} {"token":"t1"}');
  assert.doesNotMatch(out, /sk-ant-abc123/);
  assert.doesNotMatch(out, /supersecret/);
  assert.doesNotMatch(out, /"t1"/);
  assert.doesNotMatch(out, /sk-ant-/);
  assert.match(out, /\[REDACTED\]/);
});

test('redactText scrubs unquoted token/api_key values that look like secrets', () => {
  const out = redactText('use token: abcdefghij12345 now or api_key = qwerty1234567890');
  assert.doesNotMatch(out, /abcdefghij12345/);
  assert.doesNotMatch(out, /qwerty1234567890/);
  assert.match(out, /token: \[REDACTED\]/);
  assert.match(out, /api_key: \[REDACTED\]/);
});

test('redactText does not redact short unquoted values (e.g. prose like "token: of")', () => {
  const out = redactText('the token: of the month is the first one');
  assert.doesNotMatch(out, /\[REDACTED\]/);
});

test('redactText scrubs ghp_, sk-proj-, and github_pat_ values even without a key prefix', () => {
  const out = redactText(
    'saw ghp_abcdefghijklmnopqrstuvwxyz123456 and sk-proj-abcdefghijklmnop and github_pat_abcdefghijklmnopqrstuvwxyz1234567890 nearby'
  );
  assert.doesNotMatch(out, /ghp_abcdefghijklmnopqrstuvwxyz123456/);
  assert.doesNotMatch(out, /sk-proj-abcdefghijklmnop/);
  assert.doesNotMatch(out, /github_pat_abcdefghijklmnopqrstuvwxyz1234567890/);
  assert.match(out, /\[REDACTED\]/);
});

test('redactText redacts keys with credential terms regardless of prefix/suffix', () => {
  const out = redactText(
    'ANTHROPIC_API_KEY=plain-secret-value my_api_key: plain-secret-value token: plain-secret-value'
  );
  assert.doesNotMatch(out, /plain-secret-value/);
  assert.match(out, /\[REDACTED\]/);
});

test('redactText redacts JSON key/value pairs with prefixed/suffixed credential keys', () => {
  const out = redactText('{"ANTHROPIC_API_KEY":"plain-secret-value"} {"my_api_key":"v2"}');
  assert.doesNotMatch(out, /plain-secret-value/);
  assert.doesNotMatch(out, /"v2"/);
  assert.match(out, /\[REDACTED\]/);
});

test('redactText redacts hyphenated JSON credential keys (access-token, client-secret)', () => {
  const out = redactText(
    '"access-token":"plain-secret-value" and "client-secret":"plain-secret-value"'
  );
  assert.doesNotMatch(out, /plain-secret-value/);
  assert.match(out, /\[REDACTED\]/);
  // Unquoted hyphenated keys are also fully captured (not just the suffix).
  const unquoted = redactText('access-token=plain-secret-value client-secret: plain-secret-value');
  assert.doesNotMatch(unquoted, /plain-secret-value/);
  assert.match(unquoted, /access-token: \[REDACTED\]/);
  assert.match(unquoted, /client-secret: \[REDACTED\]/);
});

test('taskResultToRender normalizes a local-service poll response for rendering', () => {
  const r = taskResultToRender({
    task_id: 't1',
    status: 'diagnosed',
    report: { phenomenon_summary: '传球无压力出界', root_cause: '边界钳制缺失', confidence: 0.8 },
    findings: [{ detector_id: 'unforced_out', event_index: 3, match_time: 12.5, severity: 'realism_warning' }],
    errors: [],
  });
  assert.equal(r.kind, 'task');
  assert.equal(r.status, 'diagnosed');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].detector_id, 'unforced_out');
  assert.equal(r.report.root_cause, '边界钳制缺失');
  assert.deepEqual(r.errors, []);
});

test('taskResultToRender redacts credential-shaped errors from the poll response', () => {
  const r = taskResultToRender({
    status: 'failed',
    errors: ['auth failed with sk-ant-fake-secret-value-0001'],
  });
  assert.equal(r.status, 'failed');
  assert.doesNotMatch(r.errors[0], /sk-ant-fake-secret-value-0001/);
  assert.doesNotMatch(r.errors[0], /sk-ant-/);
  assert.match(r.errors[0], /\[REDACTED\]/);
});

test('taskResultToRender tolerates missing/empty fields and rejects garbage', () => {
  const r = taskResultToRender({ status: 'provider_unavailable' });
  assert.equal(r.status, 'provider_unavailable');
  assert.deepEqual(r.findings, []);
  assert.equal(r.report, null);
  assert.deepEqual(r.errors, []);

  const bad = taskResultToRender(null);
  assert.equal(bad.kind, 'task');
  assert.equal(bad.status, 'failed');
  assert.deepEqual(bad.findings, []);
  assert.equal(bad.report, null);
  assert.ok(bad.errors.length >= 1);

  const arr = taskResultToRender([1, 2]);
  assert.equal(arr.status, 'failed');
  assert.ok(arr.errors.length >= 1);
});

test('TRIAGE_CATEGORIES is exactly bug/design/discuss', () => {
  assert.deepEqual(TRIAGE_CATEGORIES, ['bug', 'design', 'discuss']);
});

test('formatTriage returns a normalized triage for display', () => {
  const t = formatTriage({ triage: { category: 'bug', rationale: 'lib.rs:42 clear bug', confidence: 0.9 } });
  assert.deepEqual(t, { category: 'bug', rationale: 'lib.rs:42 clear bug', confidence: 0.9 });
});

test('formatTriage falls back to discuss for invalid triage and null for missing', () => {
  // 报告根本没有 triage 字段（旧报告/非诊断报告）→ 不渲染徽章。
  assert.equal(formatTriage({}), null);
  assert.equal(formatTriage({ report: { phenomenon_summary: 'x' } }), null);
  assert.equal(formatTriage(null), null);
  // triage 存在但 category 非法 / rationale 空 → 兜底 discuss。
  assert.deepEqual(formatTriage({ triage: { category: 'urgent', rationale: 'x', confidence: 0.5 } }), { category: 'discuss', rationale: 'x', confidence: 0.5 });
  assert.deepEqual(formatTriage({ triage: { category: 'bug', rationale: '', confidence: 0.5 } }), { category: 'bug', rationale: 'agent 未提供分类', confidence: 0.5 });
});

test('buildChangeDraft renders an OpenSpec-style proposal with key fields', () => {
  const draft = buildChangeDraft({
    phenomenon_summary: '普通传球在无压力下出界',
    root_cause: 'interpretation.js: 落点未按边线钳制',
    proposed_fix: '落点 clamp 到边界内',
    verification: 'node --test viewer && node tools/runner-cli.mjs --bundle obs.json --audit audit.json --replay r --revision HEAD',
    triage: { category: 'bug', rationale: 'clear bug', confidence: 0.9 },
  }, { statement: '传球时防守队员完全不干扰' });
  assert.match(draft, /^# Change: 修复观察：/);
  assert.match(draft, /## Why/);
  assert.match(draft, /现象：普通传球在无压力下出界/);
  assert.match(draft, /用户描述：传球时防守队员完全不干扰/);
  assert.match(draft, /## What Changes/);
  assert.match(draft, /根因：interpretation\.js: 落点未按边线钳制/);
  assert.match(draft, /修复方案：落点 clamp 到边界内/);
  assert.match(draft, /验证命令：node --test viewer/);
  assert.match(draft, /## Impact \/ 验证建议/);
  assert.match(draft, /triage: bug/);
});

test('buildChangeDraft falls back for missing statement and never carries credentials', () => {
  const draft = buildChangeDraft({
    phenomenon_summary: 'x',
    root_cause: 'auth leaked sk-ant-fake-secret-value-0001 here',
    proposed_fix: 'fix',
    verification: 'run',
  });
  assert.match(draft, /用户描述：\(未提供\)/);
  assert.doesNotMatch(draft, /sk-ant-fake-secret-value-0001/);
  assert.doesNotMatch(draft, /sk-ant-/);
  assert.match(draft, /\[REDACTED\]/);
});

test('openQuestionsFromReport pulls hypotheses and rationale for the design panel', () => {
  const report = {
    hypotheses: ['缺中场回撤机制', '阵型切换时机缺失'],
    triage: { category: 'design', rationale: '需产品决策：默认阵型', confidence: 0.8 },
  };
  const q = openQuestionsFromReport(report);
  assert.ok(q.includes('缺中场回撤机制'));
  assert.ok(q.includes('需产品决策：默认阵型'));
  const fallback = openQuestionsFromReport({});
  assert.ok(fallback.length >= 1);
});

test('confirmQuestionsFromReport lists rationale, hypotheses and low-confidence note', () => {
  const report = {
    confidence: 0.4,
    hypotheses: ['多因素叠加'],
    triage: { category: 'discuss', rationale: '根因不明，需确认现象', confidence: 0.5 },
  };
  const q = confirmQuestionsFromReport(report);
  assert.ok(q.some((s) => /根因不明/.test(s)));
  assert.ok(q.some((s) => /多因素叠加/.test(s)));
  assert.ok(q.some((s) => /置信度较低（0\.4）/.test(s)));
});

test('formatReportSummary includes the triage line', () => {
  const s = formatReportSummary({
    phenomenon_summary: 'x',
    root_cause: 'y',
    triage: { category: 'design', rationale: '设计缺口', confidence: 0.8 },
  });
  assert.match(s, /分类: design \(分类置信度 0\.8\) — 设计缺口/);
});

test('parseAuditImport redacts key-shaped values inside task errors', () => {
  const r = parseAuditImport(
    JSON.stringify({
      status: 'failed',
      report: { findings: [] },
      errors: ['auth failed with sk-ant-fake-secret-value-0003'],
    })
  );
  assert.equal(r.errors.length, 1);
  assert.doesNotMatch(r.errors[0], /sk-ant-fake-secret-value-0003/);
  assert.match(r.errors[0], /\[REDACTED\]/);
});
