// Minimal dependency-free .env loader for CLI/service entrypoints.
//
// Contract (design.md decision 9 / diagnosis-runner spec):
// - loads repo-root `.env` when present, parsing `KEY=VALUE` lines (plus an
//   optional leading `export `, common in real .env files);
// - `process.env` values already set always win (never overridden);
// - a malformed line only warns — it never exits the process;
// - values never enter logs or return values; warnings reference line numbers
//   only, never the raw line content (which could carry a secret).
//
// The runner internals keep reading `process.env` only; this loader lives at
// the entry layer (runner-cli / service), so unit tests never touch a real .env.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DOTENV_FILENAME = '.env';

// Repo root = parent of the tools/ directory (tools/*.mjs live at the repo root).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const defaultEnvPath = () => join(repoRoot, DOTENV_FILENAME);

// KEY=VALUE (whitespace around key/`=` tolerated) with an optional `export ` prefix.
const LINE_RE = /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/;

// Parse .env text into { entries: [{ key, value }], errors: [value-free line
// warnings] }. Comments and blank lines are skipped; malformed lines produce a
// warning (line number only, never the raw line).
export function parseDotEnv(text) {
  const entries = [];
  const errors = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const m = LINE_RE.exec(line);
    if (!m) {
      errors.push(`warning: ${DOTENV_FILENAME} line ${i + 1} is not a KEY=VALUE line (skipped)`);
      continue;
    }
    const raw = m[2].trim();
    let value = raw;
    if (
      raw.length >= 2 &&
      ((raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'")))
    ) {
      // Quoted values keep `#` inside the quotes; unescape `\"` / `\'` / `\\`.
      value = raw.slice(1, -1).replace(/\\(["'\\])/g, '$1');
    } else {
      // Unquoted values: strip an inline ` #` comment (the `#` must be preceded
      // by whitespace; `abc#def` is a literal value).
      const cut = raw.search(/[ \t]#/);
      value = (cut === -1 ? raw : raw.slice(0, cut)).trim();
    }
    // Comment-like values (empty, or starting with `#`) skip the whole line.
    if (value === '' || value.startsWith('#')) continue;
    entries.push({ key: m[1], value });
  }
  return { entries, errors };
}

// Load repo-root `.env` into `env` (defaults to process.env). Existing env
// values win; parse failures warn through `warn` without throwing. Returns a
// summary { loaded, file, count, errors } — never containing any value content.
export function loadDotEnv({ envPath = defaultEnvPath(), env = process.env, warn = console.warn } = {}) {
  let text;
  try {
    text = readFileSync(envPath, 'utf8');
  } catch (e) {
    // A missing .env is the normal case — no warning. Any other read error
    // warns but never aborts the entrypoint.
    if (e.code !== 'ENOENT') {
      warn(`warning: cannot read ${envPath}: ${e.code ?? e.message}`);
    }
    return { loaded: false, file: envPath, count: 0, errors: [] };
  }
  const { entries, errors } = parseDotEnv(text);
  let count = 0;
  for (const { key, value } of entries) {
    if (env[key] !== undefined) continue; // existing process.env value wins
    env[key] = value;
    count += 1;
  }
  for (const err of errors) warn(err);
  return { loaded: true, file: envPath, count, errors };
}
