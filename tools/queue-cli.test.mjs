// tools/queue-cli.mjs 单测：list 过滤 + buildRunArgs 路径/参数推导。
// 不真 spawn（run 的 spawn 由集成层负责；这里测纯逻辑）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRunArgs, isCaptured, isRerunnable } from './queue-cli.mjs';

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
