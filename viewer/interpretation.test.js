// 事件演绎单测（tasks 5.4：动画逻辑纯函数）
// 覆盖：人球解耦（带球踢-追、传球传跑配合）、锚点生成、时间排序

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretEvent, buildTimeline } from './interpretation.js';

test('pass: 生成球飞行 + 接球者跑位锚点', () => {
  const e = { t: 10, type: 'pass', from: 8, to: 9, x: 0.4, y: 0.5, x2: 0.6, y2: 0.4, speed: 12, lead: 0.3, result: 'success' };
  const anchors = interpretEvent(e);
  const balls = anchors.filter((a) => a.kind === 'ball');
  assert.ok(balls.length >= 2);
  assert.equal(balls[0].x, 0.4); // 起点
  assert.equal(balls[balls.length - 1].x, 0.6); // 终点
  // 接球者先跑位：有 to=9 的 player 锚点
  const receivers = anchors.filter((a) => a.kind === 'player' && a.id === 9);
  assert.ok(receivers.length >= 1);
});

test('dribble: 人球解耦（球领先人）', () => {
  const e = { t: 20, type: 'dribble', subject: 6, x: 0.4, y: 0.4, x2: 0.5, y2: 0.4, speed: 3.2, touch_freq: 1.2, result: 'success' };
  const anchors = interpretEvent(e);
  // 球领先人：存在同一时刻，球的 x 比同 subject 球员的 x 大（运动方向前方）
  // 方向：x 从 0.4 → 0.5（向右推进），所以球领先 = 球 x > 球员 x 在同一 t
  const playerByT = new Map(
    anchors.filter((a) => a.kind === 'player' && a.id === e.subject).map((a) => [a.t, a.x]),
  );
  let hasSeparation = false;
  for (const a of anchors) {
    if (a.kind === 'ball' && playerByT.has(a.t)) {
      if (a.x > playerByT.get(a.t)) hasSeparation = true; // 球在人前方
    }
  }
  assert.ok(hasSeparation, 'dribble 应有"球领先人"的分离时刻（人球解耦）');
});

test('shot goal: 球越过门线进网，门将没够到', () => {
  const e = { t: 30, type: 'shot', subject: 10, x: 0.7, y: 0.4, x2: 0.95, y2: 0.5, speed: 20, result: 'goal' };
  const anchors = interpretEvent(e);
  const balls = anchors.filter((a) => a.kind === 'ball');
  assert.ok(balls.length >= 2);
  assert.equal(balls[0].x, 0.7); // 起点
  // goal：球越过门线（x2>=0.5 → 终点 1.02，表示进网）
  assert.ok(balls[balls.length - 1].x > 1.0, `进球应越过门线，实际 ${balls[balls.length - 1].x}`);
  // 门将扑向射门侧，但位置与球终点不同（没够到）
  const keeper = anchors.filter((a) => a.kind === 'player' && (a.id === 0 || a.id === 21));
  assert.ok(keeper.length >= 3, '门将应有起始+反应+终点锚点');
  const keeperEnd = keeper[keeper.length - 1];
  assert.notEqual(keeperEnd.y, balls[balls.length - 1].y, 'goal 时门将未够到球（y 不同）');
});

test('shot saved: 球停在门线，门将扑到球位置挡住', () => {
  const e = { t: 30, type: 'shot', subject: 10, x: 0.7, y: 0.4, x2: 0.95, y2: 0.47, speed: 20, result: 'saved' };
  const anchors = interpretEvent(e);
  const balls = anchors.filter((a) => a.kind === 'ball');
  assert.equal(balls[balls.length - 1].x, 0.95); // 停在门线
  // 门将扑到球终点（挡住）
  const keeper = anchors.filter((a) => a.kind === 'player' && (a.id === 0 || a.id === 21));
  const keeperEnd = keeper[keeper.length - 1];
  assert.ok(Math.abs(keeperEnd.y - balls[balls.length - 1].y) < 0.01, 'saved 时门将扑到球位置');
});

test('interpretEvent: 锚点按时间排序', () => {
  const e = { t: 10, type: 'pass', from: 8, to: 9, x: 0.4, y: 0.5, x2: 0.6, y2: 0.4, result: 'success' };
  const anchors = interpretEvent(e);
  for (let i = 1; i < anchors.length; i++) {
    assert.ok(anchors[i].t >= anchors[i - 1].t, '锚点应按 t 递增');
  }
});

test('buildTimeline: 展开多事件并按时间排序', () => {
  const events = [
    { t: 0, type: 'kickoff', subject: 9, x: 0.5, y: 0.5 },
    { t: 5, type: 'pass', from: 9, to: 8, x: 0.5, y: 0.5, x2: 0.45, y2: 0.5, result: 'success' },
    { t: 10, type: 'dribble', subject: 8, x: 0.45, y: 0.5, x2: 0.55, y2: 0.45, speed: 3, touch_freq: 1, result: 'success' },
  ];
  const timeline = buildTimeline(events);
  assert.ok(timeline.length > 0);
  for (let i = 1; i < timeline.length; i++) {
    assert.ok(timeline[i].t >= timeline[i - 1].t);
  }
});
