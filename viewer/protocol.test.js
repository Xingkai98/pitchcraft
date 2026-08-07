// 协议解析单测（Node 内置 test runner，无框架）
// 覆盖：字段校验、id 方案、lineup 解析、goal 由 shot 表达、坐标范围

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEvent, parseEventStream, playerTeam, isGoal, EVENT_TYPES } from './protocol.js';

test('EVENT_TYPES 包含 11 类事件（v1 + v2 beat）', () => {
  assert.deepEqual([...EVENT_TYPES].sort(), [
    'beat', 'dribble', 'interception', 'kickoff', 'lineup', 'off_ball_run', 'pass', 'shot', 'substitution', 'tackle', 'whistle',
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

// ---- Phase B：tackle 协议定稿（必填 to/x2/y2 + 可选新字段透传）----

test('tackle: 合法事件含可选字段透传', () => {
  const e = parseEvent({
    t: 27, type: 'tackle', subject: 10, x: 0.55, y: 0.5, to: 16,
    x2: 0.45, y2: 0.55, loose_x: 0.4277, loose_y: 0.5053,
    carrier_from_x: 0.55, carrier_from_y: 0.5, result: 'success',
  });
  assert.equal(e.loose_x, 0.4277);
  assert.equal(e.carrier_from_x, 0.55);
  assert.equal(e.subjectTeam, 'home');
});

test('tackle: 缺 to 抛错（必填）', () => {
  assert.throws(() => parseEvent({ t: 27, type: 'tackle', subject: 10, x: 0.55, y: 0.5, x2: 0.45, y2: 0.55, result: 'success' }));
});

test('tackle: 缺 x2/y2 抛错（必填）', () => {
  assert.throws(() => parseEvent({ t: 27, type: 'tackle', subject: 10, x: 0.55, y: 0.5, to: 16, result: 'success' }));
});

test('interception: 不强制 to/x2/y2（无生产者，语义不同）', () => {
  // 拦截截传球，无持球人；当前引擎/协议不强制必填（Phase B 只定稿 tackle）
  const e = parseEvent({ t: 27, type: 'interception', subject: 10, x: 0.55, y: 0.5, result: 'success' });
  assert.equal(e.type, 'interception');
});

test('tackle: to=null 抛错', () => {
  assert.throws(() => parseEvent({ t: 27, type: 'tackle', subject: 10, x: 0.55, y: 0.5, to: null, x2: 0.45, y2: 0.55, result: 'success' }));
});

test('tackle: to 非数字（字符串/NaN/越界）抛错', () => {
  assert.throws(() => parseEvent({ t: 27, type: 'tackle', subject: 10, x: 0.55, y: 0.5, to: '16', x2: 0.45, y2: 0.55, result: 'success' }));
  assert.throws(() => parseEvent({ t: 27, type: 'tackle', subject: 10, x: 0.55, y: 0.5, to: NaN, x2: 0.45, y2: 0.55, result: 'success' }));
  assert.throws(() => parseEvent({ t: 27, type: 'tackle', subject: 10, x: 0.55, y: 0.5, to: 22, x2: 0.45, y2: 0.55, result: 'success' }));
});

test('tackle: 新坐标字段越界抛错', () => {
  assert.throws(() => parseEvent({ t: 27, type: 'tackle', subject: 10, x: 0.55, y: 0.5, to: 16, x2: 0.45, y2: 0.55, loose_x: 1.5, loose_y: 0.5, result: 'success' }));
  assert.throws(() => parseEvent({ t: 27, type: 'tackle', subject: 10, x: 0.55, y: 0.5, to: 16, x2: 0.45, y2: 0.55, carrier_from_x: -0.1, result: 'success' }));
});

// ---- v2：beat 协议 ----

test('beat: 无顶层 subject/x/y 可解析（含 movers/main/ball）', () => {
  const e = parseEvent({
    t: 1, type: 'beat',
    movers: [{ id: 5, from_x: 0.3, from_y: 0.4, to_x: 0.31, to_y: 0.39, speed: 4, action: 'run' }],
    main: { type: 'dribble', subject: 10, x: 0.55, y: 0.5, x2: 0.56, y2: 0.5, speed: 5, touch_freq: 1.5 },
  });
  assert.equal(e.type, 'beat');
  assert.equal(e.movers.length, 1);
  assert.equal(e.main.subject, 10);
});

test('beat: movers id 重复抛错', () => {
  assert.throws(() => parseEvent({
    t: 1, type: 'beat',
    movers: [
      { id: 5, from_x: 0.3, from_y: 0.4, to_x: 0.31, to_y: 0.39, speed: 4, action: 'run' },
      { id: 5, from_x: 0.3, from_y: 0.4, to_x: 0.31, to_y: 0.39, speed: 4, action: 'run' },
    ],
  }));
});

test('beat: movers 坐标越界抛错', () => {
  assert.throws(() => parseEvent({
    t: 1, type: 'beat',
    movers: [{ id: 5, from_x: 1.5, from_y: 0.4, to_x: 0.31, to_y: 0.39, speed: 4, action: 'run' }],
  }));
});

test('beat: 同时含 main 和 ball 抛错（唯一驱动者）', () => {
  assert.throws(() => parseEvent({
    t: 1, type: 'beat',
    main: { type: 'dribble', subject: 10, x: 0.5, y: 0.5, x2: 0.51, y2: 0.5, speed: 5, touch_freq: 1 },
    ball: { x: 0.3, y: 0.4, x2: 0.31, y2: 0.4, speed: 3, loose: true },
  }));
});

test('beat: 松散球 ball 必须 loose:true', () => {
  const e = parseEvent({
    t: 1, type: 'beat',
    ball: { x: 0.3, y: 0.4, x2: 0.31, y2: 0.4, speed: 3, loose: true },
  });
  assert.equal(e.ball.loose, true);
  assert.throws(() => parseEvent({
    t: 1, type: 'beat',
    ball: { x: 0.3, y: 0.4, x2: 0.31, y2: 0.4, speed: 3, loose: false },
  }));
});

test('beat: main 缺必填字段抛错', () => {
  assert.throws(() => parseEvent({ t: 1, type: 'beat', main: { type: 'dribble', subject: 10 } }));
});

// ---- v2：tackle 用 carrier（被铲者 id）替代 to ----

test('tackle: v2 用 carrier（无 to）合法', () => {
  const e = parseEvent({
    t: 27, type: 'tackle', subject: 10, x: 0.55, y: 0.5, carrier: 16,
    x2: 0.45, y2: 0.55, loose_x: 0.42, loose_y: 0.5, carrier_from_x: 0.45, carrier_from_y: 0.55, result: 'fail',
  });
  assert.equal(e.carrier, 16);
});

test('tackle: 缺 to 且缺 carrier 抛错', () => {
  assert.throws(() => parseEvent({ t: 27, type: 'tackle', subject: 10, x: 0.55, y: 0.5, x2: 0.45, y2: 0.55, result: 'success' }));
});
