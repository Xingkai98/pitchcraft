// 协议解析单测（Node 内置 test runner，无框架）
// 覆盖：字段校验、id 方案、lineup 解析、goal 由 shot 表达、坐标范围

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEvent, parseEventStream, playerTeam, isGoal, EVENT_TYPES } from './protocol.js';

test('EVENT_TYPES 包含 9 类事件', () => {
  assert.deepEqual([...EVENT_TYPES].sort(), [
    'dribble', 'interception', 'kickoff', 'lineup', 'pass', 'shot', 'substitution', 'tackle', 'whistle',
  ]);
});

test('playerTeam: 0-10 home, 11-21 away', () => {
  assert.equal(playerTeam(0), 'home');
  assert.equal(playerTeam(10), 'home');
  assert.equal(playerTeam(11), 'away');
  assert.equal(playerTeam(21), 'away');
  assert.throws(() => playerTeam(22));
  assert.throws(() => playerTeam(-1));
});

test('parseEvent: 基础字段必填', () => {
  const e = parseEvent({ t: 1, type: 'kickoff', subject: 9, x: 0.5, y: 0.5 });
  assert.equal(e.subjectTeam, 'home');
});

test('parseEvent: 缺字段抛错', () => {
  assert.throws(() => parseEvent({ t: 1, type: 'kickoff' }));
  assert.throws(() => parseEvent({ t: 1, type: 'pass', subject: 1, x: 0.5, y: 0.5 }));
  assert.throws(() => parseEvent({ t: 1, type: 'unknown', subject: 1, x: 0.5, y: 0.5 }));
});

test('parseEvent: 坐标越界抛错', () => {
  assert.throws(() => parseEvent({ t: 1, type: 'kickoff', subject: 1, x: 1.2, y: 0.5 }));
  assert.throws(() => parseEvent({ t: 1, type: 'kickoff', subject: 1, x: 0.5, y: -0.1 }));
});

test('parseEventStream: 提取 lineup', () => {
  const lineup = Array.from({ length: 22 }, (_, i) => ({ id: i, x: 0.5, y: 0.5 }));
  const stream = [{ t: 0, type: 'lineup', subject: 0, x: 0.5, y: 0.5, players: lineup }];
  const { events, lineup: l } = parseEventStream(stream);
  assert.equal(l.length, 22);
  assert.equal(l[0].team, 'home');
  assert.equal(l[11].team, 'away');
  assert.equal(events.length, 1);
});

test('isGoal: shot result=goal 为真', () => {
  assert.equal(isGoal({ type: 'shot', result: 'goal' }), true);
  assert.equal(isGoal({ type: 'shot', result: 'saved' }), false);
});
