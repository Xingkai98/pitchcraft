import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateObservationBundle,
  redactCredentials,
  assertNoCredentials,
} from './bundle.mjs';

const validBundle = () => ({
  schema_version: '1',
  observation_id: 'obs-1',
  seed: 'seed-42',
  config: { home: 'A', away: 'B' },
  match_time: 1234.5,
  window: { before: 5, after: 5 },
  events: [{ index: 0, type: 'kickoff' }],
  engine_snapshot: {
    kind: 'event-stream',
    match_time: 1234.5,
    current_event_index: 0,
    event_count: 1,
    window: { before: 5, after: 5 },
    lineup: [],
  },
  viewer_snapshot: {
    match_time: 1234.5,
    current_event_index: 0,
    event_count: 1,
    play_time: 1234.5,
    players: [],
    ball: { x: 0.5, y: 0.5 },
  },
  audit_input: {
    events: [],
    players: {},
  },
  source_revision: 'abc123',
  statement: '防守队员完全不干扰',
});

test('validateObservationBundle accepts a well-formed bundle', () => {
  const { valid, errors } = validateObservationBundle(validBundle());
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test('validateObservationBundle rejects non-object', () => {
  const { valid } = validateObservationBundle(null);
  assert.equal(valid, false);
});

test('validateObservationBundle reports missing required fields without leaking values', () => {
  const { valid, errors } = validateObservationBundle({});
  assert.equal(valid, false);
  for (const err of errors) {
    assert.match(err, /missing required field:/);
    assert.doesNotMatch(err, /sk-ant|secret|token/i);
  }
});

test('validateObservationBundle accepts a numeric seed (engine/viewer seeds are numeric)', () => {
  const bundle = validBundle();
  bundle.seed = 42;
  const { valid, errors } = validateObservationBundle(bundle);
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test('validateObservationBundle rejects a bundle missing engine_snapshot', () => {
  const bundle = validBundle();
  delete bundle.engine_snapshot;
  const { valid, errors } = validateObservationBundle(bundle);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /missing required field: engine_snapshot/.test(e)));
});

test('validateObservationBundle rejects a non-object engine_snapshot', () => {
  const bundle = validBundle();
  bundle.engine_snapshot = 'not-an-object';
  const { valid, errors } = validateObservationBundle(bundle);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /engine_snapshot must be one of: object/.test(e)));
});

test('validateObservationBundle rejects null and array engine_snapshot', () => {
  for (const value of [null, []]) {
    const bundle = validBundle();
    bundle.engine_snapshot = value;
    const { valid, errors } = validateObservationBundle(bundle);
    assert.equal(valid, false, `engine_snapshot=${JSON.stringify(value)} should be invalid`);
    assert.ok(
      errors.some((e) => /engine_snapshot must be one of: object/.test(e)),
      `expected an engine_snapshot type error, got ${JSON.stringify(errors)}`
    );
  }
});

test('validateObservationBundle rejects null and array config/window', () => {
  for (const field of ['config', 'window']) {
    for (const value of [null, []]) {
      const bundle = validBundle();
      bundle[field] = value;
      const { valid, errors } = validateObservationBundle(bundle);
      assert.equal(valid, false, `${field}=${JSON.stringify(value)} should be invalid`);
      assert.ok(
        errors.some((e) => new RegExp(`${field} must be one of: object`).test(e)),
        `expected a ${field} type error, got ${JSON.stringify(errors)}`
      );
    }
  }
});

test('validateObservationBundle requires audit_input and viewer_snapshot (missing/null/array rejected)', () => {
  for (const field of ['audit_input', 'viewer_snapshot']) {
    for (const value of [undefined, null, []]) {
      const bundle = validBundle();
      if (value === undefined) delete bundle[field];
      else bundle[field] = value;
      const { valid, errors } = validateObservationBundle(bundle);
      assert.equal(valid, false, `${field}=${JSON.stringify(value)} should be invalid`);
      assert.ok(
        errors.some((e) => value === undefined
          ? new RegExp(`missing required field: ${field}`).test(e)
          : new RegExp(`${field} must be one of: object`).test(e)),
        `expected a ${field} error, got ${JSON.stringify(errors)}`
      );
    }
  }
});

test('validateObservationBundle rejects missing/null/empty source_revision', () => {
  for (const value of [undefined, null, '', '   ']) {
    const bundle = validBundle();
    if (value === undefined) delete bundle.source_revision;
    else bundle.source_revision = value;
    const { valid, errors } = validateObservationBundle(bundle);
    assert.equal(valid, false, `source_revision=${JSON.stringify(value)} should be invalid`);
    assert.ok(
      errors.some((e) => /source_revision/.test(e)),
      `expected a source_revision error, got ${JSON.stringify(errors)}`
    );
  }
});

test('validateObservationBundle rejects a credential-shaped value under a non-secret key', () => {
  const bundle = validBundle();
  bundle.statement = 'my key is sk-ant-abc123xyz';
  const { valid, errors } = validateObservationBundle(bundle);
  assert.equal(valid, false);
  assert.ok(errors.length >= 1);
  assert.doesNotMatch(errors.join(' '), /sk-ant-abc123xyz/);
});

test('redactCredentials scrubs a credential-shaped value under a non-secret key', () => {
  const out = redactCredentials({ note: 'use sk-ant-abc123 now', safe: 'keep-me' });
  assert.equal(out.note, '[REDACTED]');
  assert.equal(out.safe, 'keep-me');
});

test('assertNoCredentials throws on a credential-shaped value under a non-secret key', () => {
  assert.throws(() => assertNoCredentials({ statement: 'sk-ant-abc123' }));
  assert.doesNotThrow(() => assertNoCredentials({ statement: '防守队员完全不干扰' }));
});

test('redactCredentials scrubs ghp_, sk-proj-, and github_pat_ shapes under innocuous keys', () => {
  const out = redactCredentials({
    note: 'ghp_abcdefghijklmnopqrstuvwxyz123456',
    other: 'sk-proj-abcdefghijklmnop',
    third: 'github_pat_abcdefghijklmnopqrstuvwxyz1234567890',
    safe: 'keep-me',
  });
  assert.equal(out.note, '[REDACTED]');
  assert.equal(out.other, '[REDACTED]');
  assert.equal(out.third, '[REDACTED]');
  assert.equal(out.safe, 'keep-me');
});

test('assertNoCredentials rejects ghp_, sk-proj-, and github_pat_ shapes under non-secret keys', () => {
  assert.throws(() => assertNoCredentials({ statement: 'ghp_abcdefghijklmnopqrstuvwxyz123456' }));
  assert.throws(() => assertNoCredentials({ statement: 'sk-proj-abcdefghijklmnop' }));
  assert.throws(() => assertNoCredentials({ statement: 'github_pat_abcdefghijklmnopqrstuvwxyz1234567890' }));
  // Short ghp_ strings (too short to be a real PAT) are tolerated.
  assert.doesNotThrow(() => assertNoCredentials({ statement: 'ghp_short' }));
});

test('redactCredentials redacts a secret key whose value is an object/array wholesale', () => {
  const original = {
    token: { nested: 'x' },
    api_key: ['a', 'b'],
    safe: { note: 'kept' },
  };
  const redacted = redactCredentials(original);
  assert.equal(redacted.token, '[REDACTED]');
  assert.equal(redacted.api_key, '[REDACTED]');
  assert.deepEqual(redacted.safe, { note: 'kept' });
});

test('assertNoCredentials throws on a secret key holding an object, without leaking values', () => {
  let message = '';
  try {
    assertNoCredentials({ token: { nested: 'super-secret-xyz' } });
  } catch (e) {
    message = e.message;
  }
  assert.ok(message.length > 0);
  assert.doesNotMatch(message, /super-secret-xyz/);
});

test('validateObservationBundle rejects a bundle carrying a live API key', () => {
  const bundle = validBundle();
  bundle.ANTHROPIC_API_KEY = 'sk-ant-secret-value';
  const { valid, errors } = validateObservationBundle(bundle);
  assert.equal(valid, false);
  assert.ok(errors.length >= 1);
  // The value must never appear in the error output.
  assert.doesNotMatch(errors.join(' '), /sk-ant-secret-value/);
});

test('redactCredentials deep-redacts secret keys recursively and leaves input untouched', () => {
  const original = {
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    api_key: 'x',
    token: 'y',
    secret: 'z',
    authorization: 'Bearer abc',
    nested: {
      auth_token: 'inner',
      user_id: 'kept',
      deeper: { accessToken: 'deep' },
    },
    list: [{ api_key: 'in-list' }, { normal: 'kept' }],
    safe: 'keep-me',
  };
  const snapshot = JSON.stringify(original);
  const redacted = redactCredentials(original);
  assert.equal(redacted.ANTHROPIC_API_KEY, '[REDACTED]');
  assert.equal(redacted.api_key, '[REDACTED]');
  assert.equal(redacted.token, '[REDACTED]');
  assert.equal(redacted.secret, '[REDACTED]');
  assert.equal(redacted.authorization, '[REDACTED]');
  assert.equal(redacted.nested.auth_token, '[REDACTED]');
  assert.equal(redacted.nested.deeper.accessToken, '[REDACTED]');
  assert.equal(redacted.nested.user_id, 'kept');
  assert.equal(redacted.list[0].api_key, '[REDACTED]');
  assert.equal(redacted.list[1].normal, 'kept');
  assert.equal(redacted.safe, 'keep-me');
  // Input must not be mutated.
  assert.equal(JSON.stringify(original), snapshot);
});

test('assertNoCredentials throws on live credential and passes when redacted', () => {
  assert.throws(() => assertNoCredentials({ api_key: 'live-value' }));
  assert.throws(() => assertNoCredentials({ nested: { secret: 'x' } }));
  assert.throws(() => assertNoCredentials({ ANTHROPIC_API_KEY: 'sk-ant-' }));
  assert.doesNotThrow(() => assertNoCredentials({ api_key: '[REDACTED]' }));
  assert.doesNotThrow(() => assertNoCredentials({ user_id: 'kept', config: { a: 1 } }));
});

test('assertNoCredentials error message never includes the secret value', () => {
  const secret = 'sk-ant-top-secret-12345';
  let message = '';
  try {
    assertNoCredentials({ authorization: secret });
  } catch (e) {
    message = e.message;
  }
  assert.ok(message.length > 0);
  assert.doesNotMatch(message, /sk-ant-top-secret-12345/);
});

test('assertNoCredentials reports precise nested paths without leaking values', () => {
  let message = '';
  try {
    assertNoCredentials({ nested: { auth: { token: 'secret-value-1' } } });
  } catch (e) {
    message = e.message;
  }
  assert.match(message, /\/nested\/auth\/token/);
  assert.doesNotMatch(message, /secret-value-1/);

  let arrayMessage = '';
  try {
    assertNoCredentials({ list: [{ api_key: 'secret-value-2' }] });
  } catch (e) {
    arrayMessage = e.message;
  }
  assert.match(arrayMessage, /\/list\[0\]\/api_key/);
  assert.doesNotMatch(arrayMessage, /secret-value-2/);
});
