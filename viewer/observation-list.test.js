// viewer/observation-list.js 纯函数单测（无 DOM、无网络、无 localStorage）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OBSERVATION_STATUSES,
  OBSERVATION_TERMINAL_STATUSES,
  isTerminalStatus,
  isKnownStatus,
  createListEntry,
  addListEntry,
  updateListEntry,
  upsertListEntry,
  formatMatchTime,
  summarizeStatement,
  applyServerStatement,
  parseObservationList,
  serializeObservationList,
  sanitizeEntry,
  loadList,
  saveList,
  LIST_STORAGE_KEY,
} from './observation-list.js';

test('OBSERVATION_STATUSES is the exact spec vocabulary (P20 adds the two confirmation states)', () => {
  // P20 在 captured 与 auditing 之间插入事件锚定确认步的两态。
  assert.deepEqual(OBSERVATION_STATUSES, [
    'captured', 'awaiting_confirmation', 'confirmed', 'auditing', 'audit_ready', 'diagnosing',
    'diagnosed', 'insufficient_evidence', 'provider_unavailable', 'failed',
  ]);
});

test('isTerminalStatus flags exactly the 4 terminal states', () => {
  for (const s of ['diagnosed', 'insufficient_evidence', 'provider_unavailable', 'failed']) {
    assert.equal(isTerminalStatus(s), true, `${s} should be terminal`);
  }
  for (const s of ['captured', 'auditing', 'audit_ready', 'diagnosing']) {
    assert.equal(isTerminalStatus(s), false, `${s} should not be terminal`);
  }
  assert.equal(isTerminalStatus('bogus'), false);
  assert.deepEqual([...OBSERVATION_TERMINAL_STATUSES], ['diagnosed', 'insufficient_evidence', 'provider_unavailable', 'failed']);
});

test('createListEntry normalizes fields with safe defaults', () => {
  const e = createListEntry({ id: 'e1', statement: '传球无干扰', match_time: 2234, event_index: 314 });
  assert.equal(e.id, 'e1');
  assert.equal(e.statement, '传球无干扰');
  assert.equal(e.match_time, 2234);
  assert.equal(e.event_index, 314);
  assert.equal(e.status, 'captured');
  assert.equal(e.task_id, null);
  assert.equal(e.sync_error, false);
  assert.equal(e.detail_error, null);
  assert.ok(typeof e.created_at === 'string');
});

test('createListEntry accepts an injected created_at (deterministic tests)', () => {
  const e = createListEntry({ id: 'e1', created_at: '2026-08-26T00:00:00.000Z' });
  assert.equal(e.created_at, '2026-08-26T00:00:00.000Z');
});

test('addListEntry appends and updateListEntry patches by id without mutating input', () => {
  const a = createListEntry({ id: 'a' });
  const b = createListEntry({ id: 'b' });
  const list1 = addListEntry([], a);
  const list2 = addListEntry(list1, b);
  assert.equal(list2.length, 2);
  assert.equal(list1.length, 1, 'input list is not mutated');
  const list3 = updateListEntry(list2, 'a', { status: 'diagnosing' });
  assert.equal(list3[0].status, 'diagnosing');
  assert.equal(list2[0].status, 'captured', 'original entry is not mutated');
  assert.deepEqual(updateListEntry(list2, 'missing', { status: 'x' }), list2);
});

test('upsertListEntry adds when absent and updates when present', () => {
  const a = createListEntry({ id: 'a', status: 'captured' });
  const list = upsertListEntry([], a);
  assert.equal(list.length, 1);
  const list2 = upsertListEntry(list, { ...a, status: 'failed' });
  assert.equal(list2.length, 1);
  assert.equal(list2[0].status, 'failed');
});

test('formatMatchTime renders MM:SS from seconds', () => {
  assert.equal(formatMatchTime(0), '0:00');
  assert.equal(formatMatchTime(37), '0:37');
  assert.equal(formatMatchTime(2234), '37:14');
  assert.equal(formatMatchTime(3599), '59:59');
  assert.equal(formatMatchTime(3600), '60:00');
});

test('formatMatchTime tolerates NaN/negative/undefined', () => {
  assert.equal(formatMatchTime(NaN), '0:00');
  assert.equal(formatMatchTime(-5), '0:00');
  assert.equal(formatMatchTime(undefined), '0:00');
});

test('summarizeStatement truncates and falls back for empty input', () => {
  assert.equal(summarizeStatement(''), '(无描述)');
  assert.equal(summarizeStatement('   '), '(无描述)');
  assert.equal(summarizeStatement(null), '(无描述)');
  const long = 'x'.repeat(100);
  assert.equal(summarizeStatement(long).length, 49); // 48 + ellipsis
  assert.ok(summarizeStatement(long).endsWith('…'));
});

// --- P18：服务端 statement 回填（覆盖语义）---
test('applyServerStatement overwrites the local statement with a server string', () => {
  const entry = createListEntry({ id: 'e1', statement: '本地旧值', task_id: 't1' });
  const applied = applyServerStatement(entry, '服务端权威描述');
  assert.equal(applied.statement, '服务端权威描述');
  assert.equal(entry.statement, '本地旧值', '原条目不被改动');
  // 其余字段原样保留。
  assert.equal(applied.id, 'e1');
  assert.equal(applied.task_id, 't1');
});

test('applyServerStatement overwrites with an empty string (server-cleared description)', () => {
  const entry = createListEntry({ id: 'e1', statement: '本地脏值', task_id: 't1' });
  assert.equal(applyServerStatement(entry, '').statement, '', '空串是有效值，必须覆盖');
});

test('applyServerStatement keeps the local statement for null/undefined (missing bundle or old service)', () => {
  const entry = createListEntry({ id: 'e1', statement: '本地值', task_id: 't1' });
  assert.equal(applyServerStatement(entry, null).statement, '本地值');
  assert.equal(applyServerStatement(entry, undefined).statement, '本地值');
  // 非字符串一律视为「未返回该字段」，保持本地值。
  assert.equal(applyServerStatement(entry, 42).statement, '本地值');
  assert.equal(applyServerStatement(entry, {}).statement, '本地值');
});

test('applyServerStatement returns the same entry reference when it does not overwrite', () => {
  const entry = createListEntry({ id: 'e1', statement: 'x' });
  assert.equal(applyServerStatement(entry, null), entry);
});

test('sanitizeEntry rejects non-object and missing/empty id', () => {
  assert.equal(sanitizeEntry(null), null);
  assert.equal(sanitizeEntry([1]), null);
  assert.equal(sanitizeEntry({ statement: 'no id' }), null);
  assert.equal(sanitizeEntry({ id: '' }), null);
});

test('sanitizeEntry normalizes unknown status to failed and drops non-metadata fields', () => {
  const raw = {
    id: 'e1',
    statement: 'x',
    match_time: 10,
    event_index: 2,
    status: 'bogus-status',
    task_id: 'task-1',
    created_at: '2026-08-26T00:00:00.000Z',
    sync_error: true,
    detail_error: 'boom',
    findingsDetail: { markers: [], reportText: 'should be dropped' },
  };
  const e = sanitizeEntry(raw);
  assert.equal(e.status, 'failed');
  assert.equal(e.task_id, 'task-1');
  assert.equal(e.detail_error, 'boom');
  assert.equal(e.findingsDetail, undefined, 'derived render state must not persist');
});

test('parseObservationList round-trips a serialized list and filters garbage', () => {
  const list = [
    createListEntry({ id: 'e1', statement: 'a', match_time: 10, status: 'diagnosed', task_id: 't1', created_at: '2026-08-26T00:00:00.000Z' }),
    createListEntry({ id: 'e2', statement: 'b', created_at: '2026-08-26T00:00:00.000Z' }),
  ];
  const parsed = parseObservationList(serializeObservationList(list));
  assert.deepEqual(parsed, list);

  const withGarbage = parseObservationList(JSON.stringify([list[0], { bad: 1 }, 'x', null, list[1]]));
  assert.equal(withGarbage.length, 2);
  assert.equal(withGarbage[0].id, 'e1');
  assert.equal(withGarbage[1].id, 'e2');
});

test('parseObservationList handles non-array / invalid JSON / empty input', () => {
  assert.deepEqual(parseObservationList(''), []);
  assert.deepEqual(parseObservationList(null), []);
  assert.deepEqual(parseObservationList('not json'), []);
  assert.deepEqual(parseObservationList('{}'), []);
  assert.deepEqual(parseObservationList(JSON.stringify({ id: 'x' })), []);
});

test('loadList/saveList read and write through an injected storage with the versioned key', () => {
  const store = new Map();
  const storage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };
  const list = [createListEntry({ id: 'e1', task_id: 't1', created_at: '2026-08-26T00:00:00.000Z' })];
  saveList(storage, list);
  assert.ok(store.has(LIST_STORAGE_KEY));
  assert.deepEqual(loadList(storage), list);
});

test('loadList returns [] when storage is null or throws', () => {
  assert.deepEqual(loadList(null), []);
  const throwing = { getItem: () => { throw new Error('blocked'); } };
  assert.deepEqual(loadList(throwing), []);
  // saveList swallows quota errors
  const badStore = { setItem: () => { throw new Error('quota'); } };
  saveList(badStore, [createListEntry({ id: 'x' })]);
});
