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

// ---- 抢断：四段式（持球 → 逼近 → 碰撞捅开 → 弹开 + 捡球）----
// success → 防守者拿球；fail → 原持球人拿回。
const TACKLE_SUCCESS = { t: 27, type: 'tackle', subject: 10, x: 0.55, y: 0.5, to: 16, x2: 0.45, y2: 0.55, result: 'success' };
const TACKLE_FAIL = { t: 32, type: 'tackle', subject: 11, x: 0.45, y: 0.5, to: 10, x2: 0.43, y2: 0.51, result: 'fail' };

test('tackle success: 持球→逼近→捅开→防守者拿球', () => {
  const anchors = interpretEvent(TACKLE_SUCCESS);
  const balls = anchors.filter((a) => a.kind === 'ball').sort((a, b) => a.t - b.t);
  // 球锚点 >= 3：脚下 → 接触 → 弹开
  assert.ok(balls.length >= 3, `球锚点应 >=3，实际 ${balls.length}`);
  // 起点：球在被铲者脚下（x2/y2）
  assert.equal(balls[0].x, TACKLE_SUCCESS.x2);
  assert.equal(balls[0].y, TACKLE_SUCCESS.y2);
  // 终点：防守者(subject)追到弹开点，与球重合（拾取）
  const ballEnd = balls[balls.length - 1];
  const tacklerEnd = anchors.filter((a) => a.kind === 'player' && a.id === TACKLE_SUCCESS.subject).sort((a, b) => b.t - a.t)[0];
  assert.ok(Math.abs(tacklerEnd.x - ballEnd.x) < 1e-6, `防守者应与球重合，${tacklerEnd.x} vs ${ballEnd.x}`);
  assert.ok(Math.abs(tacklerEnd.y - ballEnd.y) < 1e-6);
});

test('tackle fail: 原持球人拿回球，防守者停在接触点', () => {
  const anchors = interpretEvent(TACKLE_FAIL);
  const balls = anchors.filter((a) => a.kind === 'ball');
  const ballEnd = balls[balls.length - 1];
  // 被铲者(to)追到弹开点，与球重合
  const carrierEnd = anchors.filter((a) => a.kind === 'player' && a.id === TACKLE_FAIL.to).sort((a, b) => b.t - a.t)[0];
  assert.ok(Math.abs(carrierEnd.x - ballEnd.x) < 1e-6);
  assert.ok(Math.abs(carrierEnd.y - ballEnd.y) < 1e-6);
  // 防守者(subject)停在接触点（被铲者原位置），不拿球
  const tacklerEnd = anchors.filter((a) => a.kind === 'player' && a.id === TACKLE_FAIL.subject).sort((a, b) => b.t - a.t)[0];
  assert.equal(tacklerEnd.x, TACKLE_FAIL.x2);
  assert.equal(tacklerEnd.y, TACKLE_FAIL.y2);
  assert.ok(Math.abs(tacklerEnd.x - ballEnd.x) > 1e-6, '失败时防守者不应拿到球');
});

test('tackle: 弹开方向与逼近方向垂直（典型场内用例）', () => {
  const anchors = interpretEvent(TACKLE_SUCCESS);
  const balls = anchors.filter((a) => a.kind === 'ball');
  const loose = balls[balls.length - 1];
  // 弹开向量 = loose − 接触点；逼近向量 = 接触点 − 防守者起点
  const defX = loose.x - TACKLE_SUCCESS.x2;
  const defY = loose.y - TACKLE_SUCCESS.y2;
  const appX = TACKLE_SUCCESS.x2 - TACKLE_SUCCESS.x;
  const appY = TACKLE_SUCCESS.y2 - TACKLE_SUCCESS.y;
  const dot = defX * appX + defY * appY;
  assert.ok(Math.abs(dot) < 1e-9, `弹开方向应垂直，dot=${dot}`);
});

test('tackle: 锚点时间严格递增 t0<tContact<tLoose<tPickup', () => {
  const anchors = interpretEvent(TACKLE_SUCCESS);
  const balls = anchors.filter((a) => a.kind === 'ball').sort((a, b) => a.t - b.t);
  const t0 = balls[0].t;
  const tContact = balls[1].t;
  const tLoose = balls[balls.length - 1].t;
  const tacklerEnd = anchors.filter((a) => a.kind === 'player' && a.id === TACKLE_SUCCESS.subject).sort((a, b) => b.t - a.t)[0];
  const tPickup = tacklerEnd.t;
  assert.ok(t0 < tContact && tContact < tLoose && tLoose < tPickup,
    `应 t0<tContact<tLoose<tPickup，实际 ${t0}<${tContact}<${tLoose}<${tPickup}`);
});

test('tackle: 确定性（同输入 → 同锚点序列）', () => {
  const a = interpretEvent(TACKLE_SUCCESS);
  const b = interpretEvent(TACKLE_SUCCESS);
  assert.deepEqual(a, b);
});

test('tackle: 弹开点在场内', () => {
  for (const e of [TACKLE_SUCCESS, TACKLE_FAIL]) {
    const anchors = interpretEvent(e);
    const balls = anchors.filter((a) => a.kind === 'ball');
    const loose = balls[balls.length - 1];
    assert.ok(loose.x >= 0 && loose.x <= 1 && loose.y >= 0 && loose.y <= 1, `弹开点应在场内，实际 (${loose.x},${loose.y})`);
  }
});

test('tackle: 零距离（防守者已在被铲者脚下）弹开仍有效且在场内', () => {
  const e = { t: 5, type: 'tackle', subject: 10, x: 0.45, y: 0.5, to: 16, x2: 0.45, y2: 0.5, result: 'success' };
  const anchors = interpretEvent(e);
  const balls = anchors.filter((a) => a.kind === 'ball');
  const loose = balls[balls.length - 1];
  // 零距离不应退化到接触点：球应弹开（loose ≠ 接触点）
  assert.ok(Math.abs(loose.x - 0.45) > 1e-6 || Math.abs(loose.y - 0.5) > 1e-6, '零距离也应产生弹开点');
  assert.ok(loose.x >= 0 && loose.x <= 1 && loose.y >= 0 && loose.y <= 1);
});

test('tackle: 贴角球时弹开点被钳制在场内', () => {
  // 被铲者在 (0.97,0.97) 贴角：两个垂线候选都越界 → 钳制回场内
  const e = { t: 5, type: 'tackle', subject: 4, x: 0.5, y: 0.5, to: 21, x2: 0.97, y2: 0.97, result: 'success' };
  const anchors = interpretEvent(e);
  const balls = anchors.filter((a) => a.kind === 'ball');
  const loose = balls[balls.length - 1];
  assert.ok(loose.x >= 0 && loose.x <= 1 && loose.y >= 0 && loose.y <= 1,
    `贴角球弹开点应被钳制在场内，实际 (${loose.x},${loose.y})`);
});

test('tackle: 缺被铲者位置时退化为最小演绎（不伪造球/人位置）', () => {
  // 无 to/x2/y2（malformed/legacy）：不产生球锚点，防守者原地 0.3s 静止片段
  const e = { t: 5, type: 'tackle', subject: 4, x: 0.48, y: 0.52, result: 'success' };
  const anchors = interpretEvent(e);
  const balls = anchors.filter((a) => a.kind === 'ball');
  assert.equal(balls.length, 0, '缺被铲者位置时不应伪造球位置');
  const players = anchors.filter((a) => a.kind === 'player');
  assert.ok(players.length >= 1 && players.every((p) => p.id === 4), '仅防守者锚点');
  // 片段有可播放时长（末锚点 t > 事件 t）
  const endT = players[players.length - 1].t;
  assert.ok(endT > e.t, `退化片段应有时长，实际末锚点 ${endT}`);
});

test('tackle: 防守者位置非法（NaN）时退化为最小演绎（不产生 NaN/损坏时间线）', () => {
  // malformed：有 to/x2/y2 但 x 为 NaN（防守者位置非法）
  const e = { t: 5, type: 'tackle', subject: 4, x: NaN, y: 0.5, to: 16, x2: 0.45, y2: 0.5, result: 'success' };
  const anchors = interpretEvent(e);
  // 守卫必须拦住：不进入四段式（无球锚点），否则 x=NaN 会沿距离/时长传播出 NaN 时间线
  const balls = anchors.filter((a) => a.kind === 'ball');
  assert.equal(balls.length, 0, '非法防守者位置不应进入四段式');
  for (const a of anchors) {
    assert.ok(Number.isFinite(a.t) && Number.isFinite(a.x) && Number.isFinite(a.y),
      `锚点应有限（无 NaN），实际 ${JSON.stringify(a)}`);
  }
});
