// Observation bundle helpers.
//
// P10 vertical slice: versioned bundle shape validation + credential redaction.
// No WASM, no network, no Claude/API calls. Pure and deterministic.

const REDACTED = '[REDACTED]';

// Core fields the MVP validates. Mirror of design.md decision 1; the bundle must
// carry the event window (`events`), the viewer-observable engine snapshot
// (`engine_snapshot`), the captured frame (`viewer_snapshot`), the meter audit
// input derived from the window (`audit_input`), and `source_revision`. The
// remaining fields (statement, selected_entities) are validated only when present.
const CORE_FIELDS = [
  ['schema_version', ['string']],
  ['observation_id', ['string']],
  ['seed', ['string', 'number']],
  ['config', ['object']],
  ['match_time', ['number']],
  ['window', ['object']],
  ['events', ['array']],
  ['engine_snapshot', ['object']],
  ['viewer_snapshot', ['object']],
  ['audit_input', ['object']],
  ['source_revision', ['string']],
];

// Credential-shaped string values must never enter a bundle, even when they sit
// under a non-secret key like `statement` or `note`. Coverage: Claude sk-ant-*
// and sk-proj-*, GitHub ghp_* (20+ alnum) and github_pat_* (20+ body). Over-
// redaction is the safe direction.
const CREDENTIAL_VALUE_RE =
  /sk-ant-[A-Za-z0-9_-]+|sk-proj-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/;
const isCredentialValue = (value) => typeof value === 'string' && CREDENTIAL_VALUE_RE.test(value);

// Normalize a key for credential detection: lowercase, drop separators.
const normalizeKey = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');

// Key-based credential detection. Over-redaction is the safe direction: matching
// "token"/"secret"/"apikey"/"authorization" substrings only ever hides data.
const isSecretKey = (key) => {
  const n = normalizeKey(key);
  return (
    n.includes('apikey') ||
    n.includes('token') ||
    n.includes('secret') ||
    n.includes('authorization')
  );
};

// Deep-walk a value and run `visit(key, value, path)` for every child. `path`
// is the full JSON pointer to the child (e.g. `$/nested/auth_token`,
// `$/list[0]/api_key`), so credential error messages pinpoint the leak without
// ever exposing its value. Works on plain objects, arrays, and primitives.
function walk(value, visit, path = '$') {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      const childPath = `${path}[${i}]`;
      visit(String(i), item, childPath);
      walk(item, visit, childPath);
    });
    return;
  }
  for (const key of Object.keys(value)) {
    const childPath = `${path}/${key}`;
    visit(key, value[key], childPath);
    walk(value[key], visit, childPath);
  }
}

// Return a deep clone of `obj` with every credential value replaced by [REDACTED].
// The input is never mutated.
export function redactCredentials(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((item) => redactCredentials(item));
  const out = {};
  for (const key of Object.keys(obj)) {
    const child = obj[key];
    if (isSecretKey(key)) {
      out[key] = REDACTED;
    } else if (child !== null && typeof child === 'object') {
      out[key] = redactCredentials(child);
    } else if (isCredentialValue(child)) {
      out[key] = REDACTED;
    } else {
      out[key] = child;
    }
  }
  return out;
}

// Throw if `obj` contains any live credential (a secret key whose value is not the
// [REDACTED] placeholder). The thrown message never includes the secret value;
// only full JSON-pointer paths to the leaking nodes.
export function assertNoCredentials(obj) {
  const leaks = [];
  const check = (key, value, path) => {
    if (isSecretKey(key) && value !== REDACTED) {
      leaks.push(path);
      return;
    }
    // Credential-shaped values leak even under innocuous keys.
    if (isCredentialValue(value)) {
      leaks.push(path);
      return;
    }
  };
  walk(obj, check);
  if (leaks.length > 0) {
    throw new Error(`observation bundle contains credentials at ${leaks.join(', ')}`);
  }
}

// Validate the versioned observation bundle shape. Returns { valid, errors }.
// Errors are field-name strings and never contain credential values.
export function validateObservationBundle(bundle) {
  const errors = [];
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
    return { valid: false, errors: ['bundle must be an object'] };
  }
  for (const [field, types] of CORE_FIELDS) {
    const value = bundle[field];
    if (value === undefined) {
      errors.push(`missing required field: ${field}`);
      continue;
    }
    const actual = types.some((type) => {
      if (type === 'array') return Array.isArray(value);
      // object fields must be a plain object, not null or an array.
      if (type === 'object') return value !== null && !Array.isArray(value) && typeof value === 'object';
      return typeof value === type;
    });
    if (!actual) {
      errors.push(`field ${field} must be one of: ${types.join(', ')}`);
    }
  }
  // source_revision is required and must be a non-empty string (never null/'').
  if (
    bundle.source_revision !== undefined &&
    (typeof bundle.source_revision !== 'string' || bundle.source_revision.trim() === '')
  ) {
    errors.push('field source_revision must be a non-empty string');
  }
  // Credentials are a hard reject: present keys with live values fail the bundle.
  try {
    assertNoCredentials(bundle);
  } catch (e) {
    errors.push(e.message);
  }
  return { valid: errors.length === 0, errors };
}
