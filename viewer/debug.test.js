// 调试日志测试（task 6.3：文本核对验证，无视觉依赖）
// 验证：开启 debug 后，step 会打印球位置 + 移动球员 + 事件切换日志
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from './game.js';
import { config } from './config.js';

function makeDemoGame() {
  const events = [
    { t: 0, type: 'kickoff', subject: 9, from: 9, to: 10, x: 0.5, y: 0.5, x2: 0.55, y2: 0.5, speed: 14, result: 'success' },
    { t: 25, type: 'pass', subject: 5, from: 5, to: 6, x: 0.40, y: 0.20, x2: 0.42, y2: 0.42, speed: 12, receiver_x: 0.42, receiver_y: 0.40, result: 'success' },
    { t: 50, type: 'dribble', subject: 6, x: 0.42, y: 0.42, x2: 0.60, y2: 0.40, speed: 6, touch_freq: 1.2, result: 'success' },
  ];
  const lineup = [
    { id: 5, team: 'home', x: 0.40, y: 0.20 },
    { id: 6, team: 'home', x: 0.42, y: 0.40 },
    { id: 9, team: 'home', x: 0.62, y: 0.35 },
    { id: 10, team: 'home', x: 0.62, y: 0.65 },
  ];
  // 无高亮事件流，关闭跳过（debug 测试验证逐帧日志）
  return new Game(events, lineup, 'continuous', { skipThreshold: Infinity });
}

test('debug: 事件切换打印 [EVENT] 日志', () => {
  const g = makeDemoGame();
  const saved = config.debug.enabled;
  config.debug.enabled = true;
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    g.playing = true;
    g.step(0.016); // 一帧，还在 kickoff
    g.playTime = 25; // 直接到 pass 事件
    g.step(0.016);
  } finally {
    console.log = origLog;
    config.debug.enabled = saved;
  }
  const eventLogs = logs.filter((l) => l.includes('[EVENT'));
  assert.ok(eventLogs.length >= 1, '应有事件切换日志，实际: ' + JSON.stringify(logs));
});

test('debug: 周期打印球位置 [t=] 日志', () => {
  const g = makeDemoGame();
  const saved = config.debug.enabled;
  const savedFreq = config.debug.logEveryNFrames;
  config.debug.enabled = true;
  config.debug.logEveryNFrames = 2;
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    g.playing = true;
    for (let i = 0; i < 4; i++) g.step(0.016);
  } finally {
    console.log = origLog;
    config.debug.enabled = saved;
    config.debug.logEveryNFrames = savedFreq;
  }
  const ballLogs = logs.filter((l) => l.includes('球='));
  assert.ok(ballLogs.length >= 1, '应有球位置日志，实际: ' + JSON.stringify(logs));
});

test('debug: 关闭时不打印', () => {
  const g = makeDemoGame();
  const saved = config.debug.enabled;
  config.debug.enabled = false;
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    g.playing = true;
    for (let i = 0; i < 4; i++) g.step(0.016);
  } finally {
    console.log = origLog;
    config.debug.enabled = saved;
  }
  assert.equal(logs.length, 0, 'debug 关闭时不应有日志');
});
