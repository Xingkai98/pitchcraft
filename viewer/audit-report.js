// 审计/诊断报告展示集成（P10 viewer 切片）。
// 纯函数：解析导入的 audit/task/report JSON，格式化 finding，生成时间线 markers。
// 不依赖后端、不做网络请求、不依赖视觉。

const SEVERITIES = ['realism_failure', 'realism_warning', 'invariant_violation', 'unknown'];

// 凭证键名判定（与 tools/bundle.mjs 同口径）：归一化 key 为小写字母数字后包含
// apikey/token/secret/authorization 任一即视为凭证键，允许前缀/后缀
// （ANTHROPIC_API_KEY、my_api_key、accessToken、clientSecret 等都命中）。
function hasCredentialTerm(word) {
  const n = String(word).toLowerCase().replace(/[^a-z0-9]/g, '');
  return n.includes('apikey') || n.includes('token') || n.includes('secret') || n.includes('authorization');
}

// 渲染前抹除明显的凭证片段：已知凭证形值（sk-ant-*/sk-proj-*/ghp_*/github_pat_*）无论
// 是否紧跟在 key 名后都抹除；JSON 风格的凭证键值对（"ANTHROPIC_API_KEY":"..." 等，
// 键名允许前缀/后缀）；未加引号的 `token: xyz` / `ANTHROPIC_API_KEY = xyz` 形式
// （值须像秘密——8+ 个字母数字/符号，或引号包裹，避免误伤 "token: of the month" 这类短语）。
// browser 不知道存活 key 值，但至少应把可识别的 key 形片段替换为 [REDACTED] 再展示。
// 过度抹除是安全方向。
export function redactText(text) {
  let s = String(text ?? '');
  s = s.replace(
    /sk-ant-[A-Za-z0-9_-]+|sk-proj-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g,
    '[REDACTED]'
  );
  // JSON 风格的凭证键值对："any_credential_key":"value"（键名允许前缀/后缀与常见分隔符
  // - _ .，覆盖 "access-token"、"client-secret" 等）。
  s = s.replace(
    /(["'])([A-Za-z0-9_.-]+)\1\s*:\s*(")([^"]*)(")/g,
    (m, q, key, vq, value, ve) =>
      hasCredentialTerm(key) ? `${q}${key}${q}: ${vq}[REDACTED]${ve}` : m
  );
  // 未加引号的 `key: value` / `key = value`：键名含凭证词（允许 - _ . 分隔符），值像秘密才抹除。
  s = s.replace(
    /\b([A-Za-z0-9_.-]+)\s*[:=]\s*("[^"]*"|'[^']*'|[A-Za-z0-9_\-./+=]{8,})/g,
    (m, key) => (hasCredentialTerm(key) ? `${key}: [REDACTED]` : m)
  );
  return s;
}

// 解析粘贴/导入的 JSON。接受三种形状：
//   audit 报告   { profile, findings: [...] }
//   task 记录    { status, report: { findings: [...] }, errors }
//   diagnosis    { status, report: { ... 诊断字段 }, errors }
// 识别不出 → { kind: 'unknown', errors }。任何解析失败都不抛异常。
export function parseAuditImport(text) {
  if (typeof text !== 'string') {
    return { kind: 'invalid', errors: ['input must be a JSON string'] };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { kind: 'invalid', errors: ['not valid JSON'] };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { kind: 'invalid', errors: ['imported value must be a JSON object'] };
  }
  if (Array.isArray(data.findings)) {
    return {
      kind: 'audit',
      status: 'audit_ready',
      profile: data.profile ?? null,
      findings: data.findings,
      errors: [],
    };
  }
  if (data.report && Array.isArray(data.report.findings)) {
    return {
      kind: 'task',
      status: data.status ?? 'audit_ready',
      report: data.report,
      findings: data.report.findings,
      errors: (Array.isArray(data.errors) ? data.errors : []).map(redactText),
    };
  }
  if (data.report && typeof data.report === 'object') {
    return {
      kind: 'diagnosis',
      status: data.status ?? 'diagnosed',
      report: data.report,
      findings: [],
      errors: (Array.isArray(data.errors) ? data.errors : []).map(redactText),
    };
  }
  return { kind: 'unknown', errors: ['unrecognized report shape (expected findings[] or report{...})'] };
}

// 本地服务轮询响应 → 与 parseAuditImport 相同的渲染形状（findings + report +
// status + redacted errors）。服务端 GET /tasks/:id 返回的 task 记录携带
// findings（来自 audit report），这里归一化；所有展示文本渲染前抹除凭证片段。
export function taskResultToRender(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return {
      kind: 'task',
      status: 'failed',
      findings: [],
      report: null,
      errors: ['invalid task response'],
    };
  }
  const findings = Array.isArray(data.findings) ? data.findings : [];
  const report =
    data.report && typeof data.report === 'object' && !Array.isArray(data.report)
      ? data.report
      : null;
  const errors = (Array.isArray(data.errors) ? data.errors : []).map((e) => redactText(String(e)));
  const status = typeof data.status === 'string' ? data.status : 'failed';
  return { kind: 'task', status, findings, report, errors };
}

// 单条 finding → 人类可读的单行摘要（渲染前抹除凭证片段）。
export function formatFinding(f) {
  const parts = [`${f.detector_id ?? 'detector'}:${f.severity ?? 'unknown'}`];
  if (f.match_time != null) parts.push(`t=${f.match_time}s`);
  if (f.entity_id != null) parts.push(`player=${f.entity_id}`);
  if (f.reason) parts.push(f.reason);
  return redactText(parts.join('  '));
}

// findings → 时间线 markers。按 event_index 或 match_time 定位证据，供 viewer 跳转。
export function findingMarkers(findings) {
  return (findings ?? []).map((f, i) => ({
    marker_id: `finding-${i}`,
    event_index: f.event_index ?? null,
    match_time: f.match_time ?? null,
    detector_id: f.detector_id ?? null,
    entity_id: f.entity_id ?? null,
    severity: f.severity ?? 'unknown',
    label: formatFinding(f),
  }));
}

// 诊断报告 → 摘要文本。只展示报告字段；渲染前抹除凭证片段。
export function formatReportSummary(report) {
  if (!report || typeof report !== 'object') return '';
  const lines = [];
  if (report.phenomenon_summary) lines.push(`现象: ${report.phenomenon_summary}`);
  if (report.layer) lines.push(`层次: ${report.layer}`);
  if (report.root_cause) lines.push(`根因: ${report.root_cause}`);
  if (report.proposed_fix) lines.push(`建议修复: ${report.proposed_fix}`);
  if (report.verification) lines.push(`验证: ${report.verification}`);
  if (Array.isArray(report.hypotheses) && report.hypotheses.length > 0) {
    lines.push(`假设(${report.hypotheses.length}): ${report.hypotheses.join(' | ')}`);
  }
  if (typeof report.confidence === 'number') lines.push(`置信度: ${report.confidence}`);
  const triage = formatTriage(report);
  if (triage) {
    const conf = triage.confidence != null ? ` (分类置信度 ${triage.confidence})` : '';
    lines.push(`分类: ${triage.category}${conf} — ${triage.rationale}`);
  }
  return redactText(lines.join('\n'));
}

export { SEVERITIES };

// --- triage 分流（诊断报告分类 + 后续动作）-----------------------------------

export const TRIAGE_CATEGORIES = ['bug', 'design', 'discuss'];
export const TRIAGE_LABELS = {
  bug: 'bug',
  design: 'design',
  discuss: 'discuss',
};

// 从报告取规范化 triage（渲染/面板用）。报告没有 triage 字段（如旧报告/非诊断
// 报告）→ 返回 null 不渲染徽章；triage 存在但字段非法 → 按 runner 同口径兜底为
// discuss。返回 { category, rationale, confidence } 或 null。
export function formatTriage(report) {
  if (report === null || typeof report !== 'object') return null;
  const t = report.triage;
  if (t === null || typeof t !== 'object') return null;
  const category = TRIAGE_CATEGORIES.includes(t.category) ? t.category : 'discuss';
  const rationale =
    typeof t.rationale === 'string' && t.rationale.trim() ? t.rationale : 'agent 未提供分类';
  const confidence = typeof t.confidence === 'number' ? t.confidence : null;
  return { category, rationale, confidence };
}

// OpenSpec 风格 change 草稿（bug → 确认后进入 change 流程）。纯函数、渲染前抹除凭证。
// opts.statement 可选：携带用户描述（报告本身不含原始 statement）。
export function buildChangeDraft(report, opts = {}) {
  const statement =
    typeof opts.statement === 'string' && opts.statement.trim()
      ? opts.statement.trim()
      : '(未提供)';
  const phenomenon = report?.phenomenon_summary ?? '(未提供)';
  const rootCause = report?.root_cause ?? '(未提供)';
  const proposedFix = report?.proposed_fix ?? '(未提供)';
  const verification = report?.verification ?? '(未提供)';
  const title = `修复观察：${String(phenomenon).slice(0, 40)}`;
  const lines = [
    `# Change: ${title}`,
    '',
    '## Why',
    '',
    `现象：${phenomenon}`,
    `用户描述：${statement}`,
    '',
    '## What Changes',
    '',
    `根因：${rootCause}`,
    `修复方案：${proposedFix}`,
    `验证命令：${verification}`,
    '',
    '## Impact / 验证建议',
    '',
    '- 运行上述验证命令复现/验证修复。',
    '- 建议用原观察窗口（seed/config）补回归测试，确认现象不再出现。',
    '- triage: bug（agent 建议；用户确认后进入 change 流程）。',
  ];
  return redactText(lines.join('\n'));
}

// design → 列出 open questions（来自 hypotheses / triage.rationale）。
export function openQuestionsFromReport(report) {
  const items = [];
  if (Array.isArray(report?.hypotheses) && report.hypotheses.length > 0) {
    items.push(...report.hypotheses);
  }
  const rationale = report?.triage?.rationale;
  if (typeof rationale === 'string' && rationale.trim()) items.push(rationale);
  return items.length > 0
    ? items
    : ['无明确 open questions — 请在设计讨论中补全设计/模型缺口'];
}

// discuss → 列出需用户确认的问题（agent 疑问 / 低置信点）。
export function confirmQuestionsFromReport(report) {
  const items = [];
  if (typeof report?.triage?.rationale === 'string' && report.triage.rationale.trim()) {
    items.push(report.triage.rationale);
  }
  if (Array.isArray(report?.hypotheses) && report.hypotheses.length > 0) {
    items.push(...report.hypotheses);
  }
  if (typeof report?.confidence === 'number' && report.confidence < 0.7) {
    items.push(`agent 置信度较低（${report.confidence}），建议人工复核`);
  }
  return items.length > 0
    ? items
    : ['需用户确认：现象是否可复现、根因方向是否可接受'];
}
