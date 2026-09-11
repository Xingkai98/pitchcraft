// tools/queue-cli.mjs 单测：list 过滤 + buildRunArgs 路径/参数推导。
// 不真 spawn（run 的 spawn 由集成层负责；这里测纯逻辑）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// CLI 脚本绝对路径：从任意 cwd 跑测试都能 spawn 到正确脚本（不依赖 process.cwd()）。
const QUEUE_CLI = join(dirname(fileURLToPath(import.meta.url)), 'queue-cli.mjs');
import { buildRunArgs, isCaptured, isRerunnable, isActionable, statusHint } from './queue-cli.mjs';

test('P14 queue-cli: isCaptured only true for captured status', () => {
  assert.equal(isCaptured({ status: 'captured' }), true);
  assert.equal(isCaptured({ status: 'auditing' }), false);
  assert.equal(isCaptured({ status: 'diagnosed' }), false);
  assert.equal(isCaptured(null), false);
});

test('P14 queue-cli: isRerunnable accepts captured and failed-with-captured-origin, rejects others', () => {
  // captured → 可取
  assert.equal(isRerunnable({ status: 'captured' }), true);
  // 失败终态但源自入队 → 可取（重试）
  assert.equal(isRerunnable({ status: 'failed', status_history: [{ status: 'captured', at: 't0' }, { status: 'auditing', at: 't1' }] }), true);
  assert.equal(isRerunnable({ status: 'provider_unavailable', status_history: [{ status: 'captured', at: 't0' }] }), true);
  // 诊断完成（非失败）→ 不可取
  assert.equal(isRerunnable({ status: 'diagnosed', status_history: [{ status: 'captured', at: 't0' }] }), false);
  // 失败但非源自入队（全新跑）→ 不可取
  assert.equal(isRerunnable({ status: 'failed', status_history: [{ status: 'auditing', at: 't0' }] }), false);
  // 活动态 / null → 不可取
  assert.equal(isRerunnable({ status: 'auditing' }), false);
  assert.equal(isRerunnable(null), false);
});

test('P14 queue-cli: buildRunArgs derives bundle/audit/replay/revision and passes --run-id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-cli-'));
  const bundle = {
    seed: '42',
    source_revision: 'abc123',
    match_time: 100,
    audit_input: { events: [], players: {} },
  };
  const args = buildRunArgs({ tasksDir: dir, taskId: 'task-1', bundle, opts: { permission: 'read-only', maxRetry: '2' } });
  assert.ok(args.includes('--bundle'));
  assert.ok(args.includes(join(dir, 'task-1.bundle.json')));
  assert.ok(args.includes('--audit'));
  assert.ok(args.includes(join(dir, 'task-1.audit.json')));
  assert.ok(args.includes('--tasks-dir'));
  assert.ok(args.includes(dir));
  assert.ok(args.includes('--run-id'));
  assert.ok(args.includes('task-1'));
  assert.ok(args.includes('--permission'));
  assert.ok(args.includes('read-only'));
  // maxRetry → --max-retry (kebab)
  assert.ok(args.includes('--max-retry'));
  assert.ok(args.includes('2'));
  // replay 含 seed 提示
  const replayIdx = args.indexOf('--replay');
  assert.ok(replayIdx >= 0);
  assert.match(args[replayIdx + 1], /seed \(42\)/);
});

// --- P20 事件锚定确认：propose/events/confirm 子命令 ------------------------

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isProposable, parseEventIndexes, formatEventLines } from './queue-cli.mjs';

test('P20 queue-cli: isProposable accepts captured/awaiting_confirmation/confirmed only', () => {
  for (const status of ['captured', 'awaiting_confirmation', 'confirmed']) {
    assert.equal(isProposable({ status }), true, `${status} 可提案`);
  }
  for (const status of ['auditing', 'diagnosing', 'diagnosed', 'failed']) {
    assert.equal(isProposable({ status }), false, `${status} 不可提案`);
  }
  assert.equal(isProposable(null), false);
});

test('P20 queue-cli: isRerunnable accepts confirmed (confirmed == captured 同语义)', () => {
  assert.equal(isRerunnable({ status: 'confirmed' }), true);
  assert.equal(isRerunnable({ status: 'awaiting_confirmation' }), false);
});

test('P20 queue-cli: parseEventIndexes parses lists and rejects junk', () => {
  assert.deepEqual(parseEventIndexes('3,5'), [3, 5]);
  assert.deepEqual(parseEventIndexes(' 3 , 5 '), [3, 5]);
  assert.deepEqual(parseEventIndexes(''), []);
  assert.deepEqual(parseEventIndexes(undefined), []);
  assert.deepEqual(parseEventIndexes('55'), [55]);
  assert.throws(() => parseEventIndexes('3,x'), /非法 index/);
  assert.throws(() => parseEventIndexes('-1'), /非法 index/);
  assert.throws(() => parseEventIndexes('3,,5'), /非法 index/);
});

test('P20 queue-cli: formatEventLines lists highlight events by default, all with showAll', () => {
  const bundle = {
    lineup: [{ id: 7, team: 'home' }],
    events: [
      { index: 0, type: 'kickoff', subject: 9 },
      { index: 55, t: 51, type: 'pass', subject: 7, from: 7, result: 'contested', detail: 'out_sideline' },
      { index: 56, t: 52, type: 'beat', movers: [{ id: 4 }] },
      { index: 57, t: 53, type: 'off_ball_run', subject: 4 },
    ],
  };
  const defaults = formatEventLines(bundle);
  assert.deepEqual(defaults, ['#55 · t=51s · 传球出边线 · 主队 #7'], '默认只列高亮事件');
  const all = formatEventLines(bundle, { showAll: true });
  assert.equal(all.length, 4, '--all 列全量');
  assert.ok(all.some((l) => l.includes('无球跑动')), 'beat 折叠为无球跑动');
});

// 端到端跑真实 CLI 进程（spawn 子进程）：confirm 写盘 → 状态/锚点落进任务文件。
// 用 QUEUE_CLI 绝对路径 + 不依赖 cwd，使 `cd tools && node --test *.test.mjs`（verify.sh）同样通过。
test('P20 queue-cli confirm: writes confirmation + confirmed status to the task file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-cli-p20-'));
  const bundle = {
    seed: '42', source_revision: 'abc', match_time: 51, statement: '踢出边线',
    audit_input: { events: [], players: {} },
    lineup: [{ id: 7, team: 'home' }],
    events: [{ index: 55, t: 51, type: 'pass', subject: 7, from: 7, result: 'contested', detail: 'out_sideline' }],
  };
  writeFileSync(join(dir, 'task-p.task.json'), JSON.stringify({
    run_id: 'task-p', status: 'awaiting_confirmation', status_history: [{ status: 'captured', at: 't0' }],
    proposal: { event_indexes: [55], candidates: [{ index: 55, why: '唯一出边线' }], drift_hints: [], source: 'llm' },
  }));
  writeFileSync(join(dir, 'task-p.bundle.json'), JSON.stringify(bundle));

  // events：应展示提案候选的人话标签（可与页面共用同一 describeEvent）。
  const eventsOut = execFileSync(process.execPath, [QUEUE_CLI, '--tasks-dir', dir, 'events', 'task-p'], { encoding: 'utf8' });
  assert.match(eventsOut, /#55 · t=51s · 传球出边线 · 主队 #7/);
  assert.match(eventsOut, /唯一出边线/);

  // confirm：写确认 → confirmed。
  const confirmOut = execFileSync(process.execPath, [QUEUE_CLI, '--tasks-dir', dir, 'confirm', 'task-p', '--events', '55', '--note', '锚定出边线'], { encoding: 'utf8' });
  assert.match(confirmOut, /已确认 → confirmed/);
  const saved = JSON.parse(readFileSync(join(dir, 'task-p.task.json'), 'utf8'));
  assert.equal(saved.status, 'confirmed');
  assert.deepEqual(saved.confirmation.event_indexes, [55]);
  assert.equal(saved.confirmation.source, 'cli');
  assert.equal(saved.confirmation.note, '锚定出边线');
});

test('P20 queue-cli confirm: empty --events confirms an empty anchor set', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-cli-p20e-'));
  writeFileSync(join(dir, 'task-e.task.json'), JSON.stringify({ run_id: 'task-e', status: 'captured', status_history: [{ status: 'captured', at: 't0' }] }));
  execFileSync(process.execPath, [QUEUE_CLI, '--tasks-dir', dir, 'confirm', 'task-e'], { encoding: 'utf8' });
  const saved = JSON.parse(readFileSync(join(dir, 'task-e.task.json'), 'utf8'));
  assert.equal(saved.status, 'confirmed');
  assert.deepEqual(saved.confirmation.event_indexes, []);
});

// --- P20 复核修复：list 收纳确认两态 + 状态提示 + re-propose 不卡死 ----------

test('P20 queue-cli: isActionable covers captured/awaiting_confirmation/confirmed/failed-retryable', () => {
  for (const status of ['captured', 'awaiting_confirmation', 'confirmed']) {
    assert.equal(isActionable({ status }), true, `${status} 应出现在 list`);
  }
  assert.equal(
    isActionable({ status: 'failed', status_history: [{ status: 'captured', at: 't0' }] }),
    true,
    '失败但源自入队仍可取'
  );
  assert.equal(isActionable({ status: 'diagnosed', status_history: [{ status: 'captured', at: 't0' }] }), false);
  assert.equal(isActionable({ status: 'auditing' }), false);
  assert.equal(isActionable(null), false);
});

test('P20 queue-cli: statusHint 不再把确认两态标成「失败，可重试」', () => {
  assert.equal(statusHint('captured'), '');
  assert.match(statusHint('awaiting_confirmation'), /待确认/);
  assert.doesNotMatch(statusHint('awaiting_confirmation'), /失败/);
  assert.match(statusHint('confirmed'), /已确认/);
  assert.doesNotMatch(statusHint('confirmed'), /失败/);
  assert.match(statusHint('failed'), /失败/);
});

// re-propose 一个已确认任务：状态保持 confirmed（否则任务会卡在 awaiting_confirmation，
// 既不被 isRerunnable 收、也不等人确认 —— 复核 finding 2）。
test('P20 runProposal: 对已 confirmed 任务重新提案，状态保持 confirmed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-cli-reprop-'));
  const tasksDir = join(dir, 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  const bundle = {
    schema_version: '1', observation_id: 'o', seed: '42', config: {}, match_time: 51,
    window: { before: 5, after: 5 }, events: [{ index: 55, type: 'pass', subject: 7 }],
    engine_snapshot: { kind: 'event-stream', source: 'engine-event-stream', match_time: 51, current_event_index: 0, event_count: 1, window: { before: 5, after: 5 }, lineup: [] },
    viewer_snapshot: { match_time: 51, current_event_index: 0, event_count: 1, play_time: 51, players: [], ball: { x: 0.5, y: 0.5 } },
    audit_input: { events: [], players: {} }, source_revision: 'abc',
  };
  writeFileSync(join(tasksDir, 'c1.bundle.json'), JSON.stringify(bundle));
  writeFileSync(join(tasksDir, 'c1.task.json'), JSON.stringify({
    run_id: 'c1', status: 'confirmed',
    confirmation: { event_indexes: [55], source: 'cli', note: '' },
    status_history: [{ status: 'captured', at: 't0' }, { status: 'confirmed', at: 't1' }],
  }));
  const { runProposal } = await import('./runner.mjs');
  const task = await runProposal({
    bundlePath: join(tasksDir, 'c1.bundle.json'), tasksDir, runId: 'c1', env: {},
  });
  assert.equal(task.status, 'confirmed', 're-propose 已确认任务后状态应保持 confirmed');
  assert.deepEqual(task.confirmation.event_indexes, [55], '确认锚点保留');
  assert.equal(
    task.status_history.filter((h) => h.status === 'confirmed').length,
    1,
    '不该重复追加 confirmed 历史'
  );
});

test('P20 queue-cli: statusHint 区分进行中/已完成/证据不足，不再一律「失败，可重试」', () => {
  assert.equal(statusHint('auditing'), ' (进行中)');
  assert.equal(statusHint('diagnosing'), ' (进行中)');
  assert.equal(statusHint('diagnosed'), ' (已完成)');
  assert.equal(statusHint('insufficient_evidence'), ' (证据不足)');
  assert.equal(statusHint('failed'), ' (失败，可重试)');
  assert.equal(statusHint('provider_unavailable'), ' (失败，可重试)');
});

// --- P20 复核 r2 修复：listHint/nextStepHint 按任务判重试 + buildProposeArgs ---

import { listHint, nextStepHint, buildProposeArgs } from './queue-cli.mjs';

test('P20 queue-cli: buildProposeArgs 转发 provider 覆盖参数 + --propose，且不需要 audit/replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-cli-propose-'));
  const args = buildProposeArgs({
    tasksDir: dir, taskId: 'task-1', statement: '踢出边线',
    opts: { model: 'mymodel', permission: 'read-only', timeout: '42', maxRetry: '3' },
  });
  assert.ok(args.includes('--propose'));
  assert.ok(args.includes('--bundle'));
  assert.ok(args.includes(join(dir, 'task-1.bundle.json')));
  assert.ok(args.includes('--tasks-dir'));
  assert.ok(args.includes(dir));
  assert.ok(args.includes('--run-id'));
  assert.ok(args.includes('task-1'));
  assert.ok(args.includes('--statement'));
  assert.ok(args.includes('踢出边线'));
  // provider 覆盖参数（复核 N2：此前 propose 静默丢弃这些 flag）
  assert.ok(args.includes('--model') && args.includes('mymodel'));
  assert.ok(args.includes('--permission') && args.includes('read-only'));
  assert.ok(args.includes('--timeout') && args.includes('42'));
  assert.ok(args.includes('--max-retry') && args.includes('3'));
  // 提案不诊断：不应带 --audit/--replay/--revision
  assert.ok(!args.includes('--audit'));
  assert.ok(!args.includes('--replay'));
  assert.ok(!args.includes('--revision'));
});

test('P20 queue-cli: listHint 只对可重试的失败任务标「可重试」', () => {
  // 失败且源自入队 → 可重试
  assert.match(
    listHint({ status: 'failed', status_history: [{ status: 'captured', at: 't0' }] }),
    /可重试/
  );
  // 失败但非入队源起 → 只说失败，不催重试（复核 N7：run 会拒收）
  assert.equal(listHint({ status: 'failed', status_history: [{ status: 'auditing', at: 't0' }] }), ' (失败)');
  assert.doesNotMatch(listHint({ status: 'provider_unavailable' }), /可重试/);
  // 确认两态不受影响
  assert.match(listHint({ status: 'awaiting_confirmation' }), /待确认/);
  assert.match(listHint({ status: 'confirmed' }), /已确认/);
});

test('P20 queue-cli: nextStepHint 对不可重试的失败任务不给「重试」提示', () => {
  assert.match(nextStepHint({ run_id: 'x', status: 'captured' }), /propose x/);
  assert.match(nextStepHint({ run_id: 'x', status: 'awaiting_confirmation' }), /confirm x/);
  assert.match(nextStepHint({ run_id: 'x', status: 'confirmed' }), /run x/);
  assert.match(
    nextStepHint({ run_id: 'x', status: 'failed', status_history: [{ status: 'captured', at: 't0' }] }),
    /重试：.*run x/
  );
  // 不可重试的失败 → 不给「重试：... run」（run 会拒收）
  assert.doesNotMatch(
    nextStepHint({ run_id: 'x', status: 'failed', status_history: [{ status: 'auditing', at: 't0' }] }),
    /重试：/
  );
});

// list 端到端：三种确认相关状态都应出现在可取清单里（复核 N3：此前只测 isActionable 纯函数，
// 把 list 的过滤换回 isRerunnable 也不会有测试变红）。
test('P20 queue-cli list：captured/awaiting_confirmation/confirmed 都出现在可取清单', () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-cli-list-'));
  const mk = (id, status, extra = {}) => writeFileSync(join(dir, `${id}.task.json`),
    JSON.stringify({ run_id: id, status, input_summary: null, started_at: 't', status_history: [{ status: 'captured', at: 't' }], ...extra }));
  mk('c1', 'captured');
  mk('a1', 'awaiting_confirmation');
  mk('f1', 'confirmed', { confirmation: { event_indexes: [55], source: 'cli', note: '' } });
  mk('d1', 'diagnosed');
  const out = execFileSync(process.execPath, [QUEUE_CLI, '--tasks-dir', dir, 'list'], { encoding: 'utf8' });
  assert.match(out, /c1/);
  assert.match(out, /a1/);
  assert.match(out, /f1/);
  assert.doesNotMatch(out, /d1/, '已诊断（非可取）不应出现');
  assert.match(out, /待确认事件锚点/);
  assert.match(out, /已确认，待跑诊断/);
});

// 复核 N1：首态非 captured（如 await(awaiting_confirmation) 起源）的任务再提案不应写空历史。
test('P20 runProposal: 保留非 captured 起源的历史（不写空 status_history）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-cli-hist-'));
  const tasksDir = join(dir, 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  const bundle = {
    schema_version: '1', observation_id: 'o', seed: '42', config: {}, match_time: 51,
    window: { before: 5, after: 5 }, events: [{ index: 55, type: 'pass', subject: 7 }],
    engine_snapshot: { kind: 'event-stream', source: 'engine-event-stream', match_time: 51, current_event_index: 0, event_count: 1, window: { before: 5, after: 5 }, lineup: [] },
    viewer_snapshot: { match_time: 51, current_event_index: 0, event_count: 1, play_time: 51, players: [], ball: { x: 0.5, y: 0.5 } },
    audit_input: { events: [], players: {} }, source_revision: 'abc',
  };
  writeFileSync(join(tasksDir, 'h1.bundle.json'), JSON.stringify(bundle));
  // 首态是 awaiting_confirmation（非 captured），随后被确认。
  writeFileSync(join(tasksDir, 'h1.task.json'), JSON.stringify({
    run_id: 'h1', status: 'confirmed',
    confirmation: { event_indexes: [55], source: 'cli', note: '' },
    status_history: [{ status: 'awaiting_confirmation', at: 't0' }, { status: 'confirmed', at: 't1' }],
  }));
  const { runProposal } = await import('./runner.mjs');
  const task = await runProposal({ bundlePath: join(tasksDir, 'h1.bundle.json'), tasksDir, runId: 'h1', env: {} });
  assert.equal(task.status, 'confirmed');
  assert.deepEqual(
    task.status_history.map((h) => h.status),
    ['awaiting_confirmation', 'confirmed'],
    '历史应原样保留，而不是被清空'
  );
});
