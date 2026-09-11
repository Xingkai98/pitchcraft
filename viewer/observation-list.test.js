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
  confirmationDetailFromTask,
  proposalIndexes,
  defaultConfirmationSelection,
  toggleEventIndex,
  confirmationEventsToShow,
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

// --- P20 事件锚定确认：纯函数 helper -----------------------------------------

test('P20 confirmationDetailFromTask：从服务端响应提取确认数据；旧任务（无 events/proposal）返回 null', () => {
  const detail = confirmationDetailFromTask({
    proposal: { event_indexes: [55], source: 'llm' },
    confirmation: null,
    events: [{ index: 55, type: 'pass' }],
    lineup: [{ id: 7, team: 'home' }],
  });
  assert.deepEqual(detail.events, [{ index: 55, type: 'pass' }]);
  assert.equal(detail.proposal.source, 'llm');
  assert.equal(detail.confirmation, null);
  assert.deepEqual(detail.lineup, [{ id: 7, team: 'home' }]);
  // 旧任务：events 空 + proposal 缺 → null（页面走原路径）
  assert.equal(confirmationDetailFromTask({}), null);
  assert.equal(confirmationDetailFromTask({ events: [] }), null);
  assert.equal(confirmationDetailFromTask(null), null);
  assert.equal(confirmationDetailFromTask('x'), null);
  // proposal 存在但 events 为空仍算确认数据（提案候选可标注「不在窗口内」）
  assert.ok(confirmationDetailFromTask({ proposal: { event_indexes: [] }, events: [] }) !== null);
});

test('P20 proposalIndexes：去重 + 过滤非整数/负数', () => {
  assert.deepEqual(proposalIndexes({ proposal: { event_indexes: [55, 55, 3] } }), [55, 3]);
  assert.deepEqual(proposalIndexes({ proposal: { event_indexes: [3, 'x', 2.5, -1, 5] } }), [3, 5]);
  assert.deepEqual(proposalIndexes({ proposal: {} }), []);
  assert.deepEqual(proposalIndexes(null), []);
  assert.deepEqual(proposalIndexes({ proposal: { event_indexes: 'nope' } }), []);
});

test('P20 defaultConfirmationSelection：默认勾选 = 模型候选；fallback-empty → 空', () => {
  assert.deepEqual(defaultConfirmationSelection({ proposal: { event_indexes: [55, 3] } }), [55, 3]);
  assert.deepEqual(defaultConfirmationSelection({ proposal: { event_indexes: [], source: 'fallback-empty' } }), []);
  assert.deepEqual(defaultConfirmationSelection(null), []);
});

test('P20 toggleEventIndex：增/删并去重，不改入参', () => {
  const base = [55];
  assert.deepEqual(toggleEventIndex(base, 3), [55, 3], '新增');
  assert.deepEqual(toggleEventIndex([55, 3], 55), [3], '删除');
  assert.deepEqual(base, [55], '不得改动入参数组');
  assert.deepEqual(toggleEventIndex([], 55), [55]);
  assert.deepEqual(toggleEventIndex(null, 55), [55], 'null 选择集视为空');
});

test('P20 confirmationEventsToShow：默认/展开/显示全部三种视图', () => {
  const detail = {
    proposal: { event_indexes: [55] },
    events: [
      { index: 0, type: 'lineup' },
      { index: 55, type: 'pass' },
      { index: 56, type: 'beat' },
      { index: 57, type: 'shot' },
    ],
  };
  // 未展开 → 只列模型候选
  assert.deepEqual(
    confirmationEventsToShow(detail, { expanded: false }).map((e) => e.index),
    [55]
  );
  // 展开 + 只看高亮（isCandidate 注入：pass/shot 算高亮，beat/lineup 不算）
  const isCandidate = (e) => ['pass', 'shot', 'tackle', 'foul'].includes(e.type);
  assert.deepEqual(
    confirmationEventsToShow(detail, { expanded: true, showAll: false, isCandidate }).map((e) => e.index),
    [55, 57]
  );
  // 展开 + 显示全部
  assert.deepEqual(
    confirmationEventsToShow(detail, { expanded: true, showAll: true, isCandidate }).map((e) => e.index),
    [0, 55, 56, 57]
  );
  // 空 detail 不抛
  assert.deepEqual(confirmationEventsToShow(null, { expanded: true }), []);
});

test('P20 sanitizeEntry 丢弃 _confirmUi/confirmationDetail（派生渲染状态不进 localStorage）', () => {
  const entry = {
    ...createListEntry({ id: 'e1', task_id: 't1' }),
    _confirmUi: { selection: [55], dirty: true },
    confirmationDetail: { proposal: { event_indexes: [55] }, events: [] },
  };
  const clean = sanitizeEntry(JSON.parse(serializeObservationList([entry]))[0]);
  assert.equal(clean._confirmUi, undefined, '确认 UI 选择态不持久化');
  assert.equal(clean.confirmationDetail, undefined, '确认派生数据不持久化（刷新从服务端重拉）');
});
