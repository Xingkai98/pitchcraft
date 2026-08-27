// tools/dotenv.mjs 纯函数单测（无真实 .env 读取、无网络）。
// 通过 envPath 注入临时文件，通过 env/warn 注入进程环境与告警函数，断言：
// KEY=VALUE 解析、export 前缀、引号剥离、process.env 已有值优先、解析失败仅告警不退出、
// 告警与返回对象不含值内容。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDotEnv, loadDotEnv } from './dotenv.mjs';

const mkEnvFile = (dir, content) => {
  const p = join(dir, '.env');
  writeFileSync(p, content);
  return p;
};

test('parseDotEnv parses KEY=VALUE lines and skips comments/blank lines', () => {
  const { entries, errors } = parseDotEnv(
    '# comment\n\nFOO=bar\nBAZ = qux\nexport EXPORTED=yes\n'
  );
  assert.deepEqual(entries, [
    { key: 'FOO', value: 'bar' },
    { key: 'BAZ', value: 'qux' },
    { key: 'EXPORTED', value: 'yes' },
  ]);
  assert.deepEqual(errors, []);
});

test('parseDotEnv strips matching surrounding single/double quotes', () => {
  const { entries } = parseDotEnv('A="double quoted"\nB=\'single quoted\'\nC="has \\" escape"\n');
  const byKey = Object.fromEntries(entries.map((e) => [e.key, e.value]));
  assert.equal(byKey.A, 'double quoted');
  assert.equal(byKey.B, 'single quoted');
  assert.equal(byKey.C, 'has " escape');
});

test('parseDotEnv strips unquoted trailing comments but keeps # inside quotes', () => {
  const { entries, errors } = parseDotEnv(
    'A=abc # note\nB="abc#def"\nC=abc#def\nD=#full comment\nE= # comment only\n'
  );
  const byKey = Object.fromEntries(entries.map((e) => [e.key, e.value]));
  assert.equal(byKey.A, 'abc');        // ` # note` stripped
  assert.equal(byKey.B, 'abc#def');    // quoted `#` preserved
  assert.equal(byKey.C, 'abc#def');    // no whitespace before # -> literal value
  assert.equal(byKey.D, undefined);    // value starts with # -> whole line skipped
  assert.equal(byKey.E, undefined);    // value empty after comment -> whole line skipped
  assert.deepEqual(errors, []);
});

test('parseDotEnv reports malformed line numbers without echoing the line content', () => {
  const { entries, errors } = parseDotEnv('OK=1\nthis line has no equals\nALSO=2');
  assert.equal(entries.length, 2);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /line 2/);
  // The warning must never carry the raw line (it may contain a secret).
  assert.doesNotMatch(errors[0], /no equals/);
});

test('loadDotEnv injects values only when process.env does not already set them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dotenv-test-'));
  try {
    const p = mkEnvFile(dir, 'SET_ME=from-file\nEXISTING=from-file\nEMPTY=\n');
    const env = { EXISTING: 'already-set' };
    const warnings = [];
    const result = loadDotEnv({ envPath: p, env, warn: (m) => warnings.push(m) });
    assert.equal(result.loaded, true);
    assert.equal(result.count, 1); // SET_ME injected; EXISTING not overridden; EMPTY= is a comment-like line
    assert.equal(env.SET_ME, 'from-file');
    assert.equal(env.EXISTING, 'already-set'); // existing value wins
    assert.equal(env.EMPTY, undefined); // `KEY=` with no value is skipped
    assert.deepEqual(warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDotEnv warns on malformed lines but does not exit or throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dotenv-test-'));
  try {
    const p = mkEnvFile(dir, 'GOOD=1\nbad line\n');
    const env = {};
    const warnings = [];
    const result = loadDotEnv({ envPath: p, env, warn: (m) => warnings.push(m) });
    assert.equal(result.loaded, true);
    assert.equal(env.GOOD, '1');
    assert.equal(result.count, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /line 2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDotEnv is a no-op when .env is missing (no warning for ENOENT)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dotenv-test-'));
  try {
    const warnings = [];
    const result = loadDotEnv({ envPath: join(dir, '.env'), env: {}, warn: (m) => warnings.push(m) });
    assert.equal(result.loaded, false);
    assert.equal(result.count, 0);
    assert.deepEqual(warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDotEnv warns (but does not exit) when .env cannot be read for another reason', () => {
  // A directory path yields a non-ENOENT read error (EISDIR) → warning, not exit.
  const dir = mkdtempSync(join(tmpdir(), 'dotenv-test-'));
  try {
    const warnings = [];
    const result = loadDotEnv({ envPath: dir, env: {}, warn: (m) => warnings.push(m) });
    assert.equal(result.loaded, false);
    assert.equal(result.count, 0);
    assert.equal(warnings.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
