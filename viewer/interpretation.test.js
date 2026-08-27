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
  // goal：球停在门里（球心刚过门线 x=1.005，球体完全越线但不飞过球门）
  assert.ok(balls[balls.length - 1].x > 1.0, `进球应越过门线，实际 ${balls[balls.length - 1].x}`);
  // 门将扑向射门侧，但位置与球终点不同（没够到）
  const keeper = anchors.filter((a) => a.kind === 'player' && (a.id === 0 || a.id === 21));
  assert.ok(keeper.length >= 3, '门将应有起始+反应+终点锚点');
  const keeperEnd = keeper[keeper.length - 1];
  // goal：门将停在门线（x2），球停在门里（1.005）——没够到由 x 差异表达（门将终点 = 引擎高亮结束位置）
  assert.notEqual(keeperEnd.x, balls[balls.length - 1].x, 'goal 时门将未够到球（球越过门线）');
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

// ---- Phase B：五段式（带球中被抢）----
const TACKLE_CARRIER = { t: 27, type: 'tackle', subject: 10, x: 0.55, y: 0.5, to: 16, x2: 0.45, y2: 0.55, carrier_from_x: 0.55, carrier_from_y: 0.5, loose_x: 0.4277, loose_y: 0.5053, result: 'success' };

test('tackle 五段式: 被铲者从 carrier_from 带球到接触点', () => {
  const anchors = interpretEvent(TACKLE_CARRIER);
  // 被铲者(to) 锚点：起点 = carrier_from，终点 = 接触点(x2/y2)
  const victimAnchors = anchors.filter((a) => a.kind === 'player' && a.id === TACKLE_CARRIER.to).sort((a, b) => a.t - b.t);
  assert.equal(victimAnchors[0].x, TACKLE_CARRIER.carrier_from_x);
  assert.equal(victimAnchors[0].y, TACKLE_CARRIER.carrier_from_y);
  assert.equal(victimAnchors[1].x, TACKLE_CARRIER.x2);
  assert.equal(victimAnchors[1].y, TACKLE_CARRIER.y2);
  // 带球移动是有时长的：起点 t < 接触 t
  assert.ok(victimAnchors[1].t > victimAnchors[0].t, '被铲者应有带球移动时长');
});

test('tackle 五段式: 引擎 loose_x/y 优先（球弹到引擎给定弹开点）', () => {
  const anchors = interpretEvent(TACKLE_CARRIER);
  const balls = anchors.filter((a) => a.kind === 'ball').sort((a, b) => a.t - b.t);
  const loose = balls[balls.length - 1];
  assert.equal(loose.x, TACKLE_CARRIER.loose_x);
  assert.equal(loose.y, TACKLE_CARRIER.loose_y);
});

test('tackle 五段式: 防守者与球在弹开点重合（success 拿球）', () => {
  const anchors = interpretEvent(TACKLE_CARRIER);
  const balls = anchors.filter((a) => a.kind === 'ball').sort((a, b) => a.t - b.t);
  const loose = balls[balls.length - 1];
  const tacklerEnd = anchors.filter((a) => a.kind === 'player' && a.id === TACKLE_CARRIER.subject).sort((a, b) => b.t - a.t)[0];
  assert.ok(Math.abs(tacklerEnd.x - loose.x) < 1e-6 && Math.abs(tacklerEnd.y - loose.y) < 1e-6);
});

test('tackle 五段式: carrier_from 缺失时被铲者原地持球（fallback）', () => {
  // 无 carrier_from（legacy）：被铲者在接触点原地，球从接触点开始
  const e = { t: 27, type: 'tackle', subject: 10, x: 0.55, y: 0.5, to: 16, x2: 0.45, y2: 0.55, result: 'success' };
  const anchors = interpretEvent(e);
  const victimAnchors = anchors.filter((a) => a.kind === 'player' && a.id === 16).sort((a, b) => a.t - b.t);
  // 起点 = 接触点（fallback 原地）
  assert.equal(victimAnchors[0].x, 0.45);
  assert.equal(victimAnchors[0].y, 0.55);
  // 球起点也在接触点
  const balls = anchors.filter((a) => a.kind === 'ball').sort((a, b) => a.t - b.t);
  assert.equal(balls[0].x, 0.45);
});

// ---- Phase C：off_ball_run 与 dropCarryBeat ----
test('off_ball_run: 短距离碎步移动（人移动，球不动）', () => {
  const e = { t: 10, type: 'off_ball_run', subject: 4, x: 0.40, y: 0.25, x2: 0.42, y2: 0.27, speed: 3, result: 'success' };
  const anchors = interpretEvent(e);
  // 只有球员锚点，无球锚点
  const balls = anchors.filter((a) => a.kind === 'ball');
  assert.equal(balls.length, 0, 'off_ball_run 不应有球锚点');
  const players = anchors.filter((a) => a.kind === 'player');
  assert.equal(players.length, 2);
  assert.equal(players[0].id, 4);
  assert.equal(players[0].x, 0.40);
  assert.equal(players[1].x, 0.42);
  // 时长 = 距离 ÷ 速度（事件驱动）
  const dur = players[1].t - players[0].t;
  assert.ok(dur > 0, `off_ball_run 应有移动时长，实际 ${dur}`);
});

test('off_ball_run: 缺 x2/y2 时不产出 NaN 锚点', () => {
  const e = { t: 10, type: 'off_ball_run', subject: 4, x: 0.40, y: 0.25, result: 'success' };
  const anchors = interpretEvent(e);
  assert.equal(anchors.length, 0, '缺终点应跳过');
});

test('tackle dropCarryBeat: 被铲者从接触点开始（不重放带球段）', () => {
  const e = { t: 27, type: 'tackle', subject: 10, x: 0.55, y: 0.5, to: 16, x2: 0.45, y2: 0.55,
    carrier_from_x: 0.60, carrier_from_y: 0.50, loose_x: 0.4277, loose_y: 0.5053, result: 'success' };
  const anchors = interpretEvent(e, true); // dropCarryBeat=true
  const victimAnchors = anchors.filter((a) => a.kind === 'player' && a.id === 16).sort((a, b) => a.t - b.t);
  // 起点 = 接触点（丢弃带球段）
  assert.equal(victimAnchors[0].x, 0.45);
  assert.equal(victimAnchors[0].y, 0.55);
  // 球起点也在接触点
  const balls = anchors.filter((a) => a.kind === 'ball').sort((a, b) => a.t - b.t);
  assert.equal(balls[0].x, 0.45);
});

test('buildTimeline continuous: tackle 前跳过 off_ball_run 找到同被铲者 dribble → dropCarryBeat', () => {
  const events = [
    { t: 20, type: 'dribble', subject: 16, x: 0.55, y: 0.5, x2: 0.45, y2: 0.55, speed: 3, result: 'success' },
    { t: 21, type: 'off_ball_run', subject: 4, x: 0.40, y: 0.25, x2: 0.42, y2: 0.27, speed: 3, result: 'success' },
    { t: 22, type: 'tackle', subject: 10, x: 0.55, y: 0.5, to: 16, x2: 0.45, y2: 0.55, carrier_from_x: 0.55, carrier_from_y: 0.5, result: 'success' },
  ];
  // continuous 模式：tackle 前跳过 off_ball_run，找到 dribble(16)→tackle(16)，dropCarryBeat 生效
  const tlContinuous = buildTimeline(events, 'continuous');
  const tackleIdx = 2;
  const victimAnchors = tlContinuous.filter((a) => a.kind === 'player' && a.id === 16 && a.evt === tackleIdx).sort((a, b) => a.t - b.t);
  assert.equal(victimAnchors[0].x, 0.45, 'continuous 模式应丢弃 carry-beat（起点=接触点）');
  // clip 模式：不丢（保留带球段）
  const tlClip = buildTimeline(events, 'clip');
  const victimAnchorsClip = tlClip.filter((a) => a.kind === 'player' && a.id === 16 && a.evt === tackleIdx).sort((a, b) => a.t - b.t);
  assert.equal(victimAnchorsClip[0].x, 0.55, 'clip 模式保留 carry-beat（起点=carrier_from）');
});

// ---- v2：beat 节拍演绎 ----

test('beat: movers 铺满整拍 [t, t+1]，main 人球解耦，ball 滚动', () => {
  const e = {
    t: 10, type: 'beat',
    movers: [
      { id: 5, from_x: 0.3, from_y: 0.4, to_x: 0.35, to_y: 0.4, speed: 4, action: 'run' },
      { id: 6, from_x: 0.5, from_y: 0.6, to_x: 0.52, to_y: 0.58, speed: 4, action: 'run' },
    ],
    main: { type: 'dribble', subject: 10, x: 0.55, y: 0.5, x2: 0.58, y2: 0.5, speed: 5, touch_freq: 1.5 },
  };
  const anchors = interpretEvent(e);
  // movers 铺满整拍：起点 t=10，终点 t=11
  const m5 = anchors.filter((a) => a.kind === 'player' && a.id === 5).sort((a, b) => a.t - b.t);
  assert.equal(m5[0].t, 10);
  assert.equal(m5[0].x, 0.3);
  assert.equal(m5[m5.length - 1].t, 11);
  assert.equal(m5[m5.length - 1].x, 0.35);
  // main：球随 carrier（拍边界连续，不做 sep 领先偏移——避免方向变化导致拍边界球跳）
  const carrier = anchors.filter((a) => a.kind === 'player' && a.id === 10).sort((a, b) => a.t - b.t);
  const ball = anchors.filter((a) => a.kind === 'ball').sort((a, b) => a.t - b.t);
  assert.ok(carrier.length >= 2 && ball.length >= 2);
  assert.equal(carrier[0].t, 10);
  assert.equal(ball[0].t, 10);
  // 球位置 = carrier 位置（起点/终点对齐）
  assert.equal(ball[0].x, carrier[0].x, 'beat.main 球起点随 carrier');
  assert.equal(ball[ball.length - 1].x, carrier[carrier.length - 1].x, 'beat.main 球终点随 carrier');
});

test('beat: 松散球 ball 铺满整拍', () => {
  const e = {
    t: 20, type: 'beat',
    ball: { x: 0.4, y: 0.5, x2: 0.42, y2: 0.51, speed: 3, loose: true },
  };
  const anchors = interpretEvent(e);
  const balls = anchors.filter((a) => a.kind === 'ball').sort((a, b) => a.t - b.t);
  assert.equal(balls[0].t, 20);
  assert.equal(balls[0].x, 0.4);
  assert.equal(balls[balls.length - 1].t, 21);
  assert.equal(balls[balls.length - 1].x, 0.42);
});

test('buildTimeline 两层合成: 高亮参与者从重叠 beat movers 排除', () => {
  // pass 高亮 (t=10, 飞行到 ~10.7) + t=11 的 beat 重叠 → pass 参与者 from/to 不在 beat movers
  const events = [
    { t: 10, type: 'pass', from: 8, to: 9, subject: 8, x: 0.4, y: 0.5, x2: 0.6, y2: 0.4, speed: 8, lead: 0.2, result: 'success' },
    { t: 11, type: 'beat', movers: [
      { id: 8, from_x: 0.5, from_y: 0.5, to_x: 0.52, to_y: 0.5, speed: 4, action: 'run' },
      { id: 9, from_x: 0.58, from_y: 0.42, to_x: 0.6, to_y: 0.4, speed: 4, action: 'run' },
      { id: 5, from_x: 0.3, from_y: 0.4, to_x: 0.32, to_y: 0.4, speed: 4, action: 'run' },
    ] },
  ];
  // pass 飞行 = dist/speed：dist=(0.2,0.1)→~22.5m，speed=8 → ~2.8s → 覆盖 [10, 12.8)，t=11 在覆盖内
  const tl = buildTimeline(events, 'continuous');
  // t=11 beat 的 evt=1；其 movers 锚点不应含 id 8 和 9（参与者被排除）
  const beatMovers = tl.filter((a) => a.evt === 1 && a.kind === 'player');
  const idsInBeat = new Set(beatMovers.map((a) => a.id));
  assert.ok(!idsInBeat.has(8), 'pass 传球者 8 应从重叠 beat movers 排除');
  assert.ok(!idsInBeat.has(9), 'pass 接球者 9 应从重叠 beat movers 排除');
  assert.ok(idsInBeat.has(5), '非参与者 5 保留在 beat movers');
  // 高亮参与者仍由高亮事件驱动（evt=0 有 id 8/9 锚点）
  const passAnchors = tl.filter((a) => a.evt === 0 && a.kind === 'player' && (a.id === 8 || a.id === 9));
  assert.ok(passAnchors.length > 0, '高亮参与者由高亮事件驱动');
});

test('buildTimeline 跨 beat 连续: from(N+1)==to(N)', () => {
  const events = [
    { t: 10, type: 'beat', movers: [{ id: 5, from_x: 0.3, from_y: 0.4, to_x: 0.35, to_y: 0.4, speed: 4, action: 'run' }] },
    { t: 11, type: 'beat', movers: [{ id: 5, from_x: 0.35, from_y: 0.4, to_x: 0.38, to_y: 0.42, speed: 4, action: 'run' }] },
  ];
  const tl = buildTimeline(events, 'continuous');
  const m5 = tl.filter((a) => a.kind === 'player' && a.id === 5).sort((a, b) => a.t - b.t);
  // 锚点序列：10(0.3) → 11(0.35) → 11(0.35) → 12(0.38)
  // 跨拍衔接：beat0 终点 (11, 0.35) == beat1 起点 (11, 0.35)
  assert.equal(m5[1].t, 11);
  assert.equal(m5[1].x, 0.35);
  assert.equal(m5[2].t, 11);
  assert.equal(m5[2].x, 0.35, '跨拍 from(N+1)==to(N)，位置连续');
});

// ---- P6：门球 + 进球回中圈 ----

test('P6 interpretPass: 无 to 门球开大脚产球飞行 + 无接球者', () => {
  const e = { t: 100, type: 'pass', from: 21, subject: 21, x: 0.98, y: 0.5, x2: 0.7, y2: 0.5, speed: 18, result: 'contested' };
  const anchors = interpretEvent(e);
  const balls = anchors.filter((a) => a.kind === 'ball');
  // 球从门线飞到落点
  assert.ok(balls.length >= 2);
  assert.equal(balls[0].x, 0.98);
  assert.equal(balls[balls.length - 1].x, 0.7);
  // 无接球者动画（无 receiver 锚点，只有传球者静止）
  const receivers = anchors.filter((a) => a.kind === 'player' && a.id !== 21);
  assert.equal(receivers.length, 0, '无 to pass 不应有接球者锚点');
  const passer = anchors.filter((a) => a.kind === 'player' && a.id === 21);
  assert.ok(passer.length >= 1, '传球者（门将）应有锚点');
});

test('P6 buildTimeline: 进球 whistle 时球直接回中圈', () => {
  const events = [
    { t: 200, type: 'shot', subject: 10, x: 0.7, y: 0.5, x2: 0.98, y2: 0.5, speed: 20, result: 'goal' },
    { t: 200, type: 'beat', movers: [] }, // 模拟事件间隙
    { t: 202, type: 'whistle', subject: 0, x: 0.5, y: 0.5, score: '1-0' },
  ];
  const tl = buildTimeline(events, 'continuous');
  // whistle 时刻应有中圈球锚点（进球确认 → 球直接回中圈）
  const whistleAnchors = tl.filter((a) => a.kind === 'ball' && Math.abs(a.t - 202) < 0.01);
  assert.ok(whistleAnchors.some((a) => a.x === 0.5 && a.y === 0.5), 'whistle 时应产中圈球锚点');
});

test('P6 interpretShot: off_target 越底线偏出，saved 停门线', () => {
  const off = { t: 30, type: 'shot', subject: 10, x: 0.7, y: 0.5, x2: 0.98, y2: 0.15, speed: 20, result: 'off_target' };
  const saved = { t: 30, type: 'shot', subject: 10, x: 0.7, y: 0.5, x2: 0.98, y2: 0.5, speed: 20, result: 'saved' };
  const offAnchors = interpretEvent(off);
  const savedAnchors = interpretEvent(saved);
  const offBallEnd = offAnchors.filter((a) => a.kind === 'ball').sort((a, b) => a.t - b.t).pop();
  const savedBallEnd = savedAnchors.filter((a) => a.kind === 'ball').sort((a, b) => a.t - b.t).pop();
  // off_target 越底线（x>1），saved 停门线（x=0.98）
  assert.ok(offBallEnd.x > 1.0, `off_target 应越底线偏出（x=${offBallEnd.x}）`);
  assert.equal(savedBallEnd.x, 0.98, 'saved 应停门线');
  // y 不同（off_target 偏离球门 vs saved 球门内）
  assert.notEqual(offBallEnd.y, savedBallEnd.y);
});

// ---- P6 批次1：角球/界外球/头球/出界/h 字段 ----

test('P6 批次1 interpretPass: 事件 h 字段优先（h>0 球放大）', () => {
  // 角球发球带 h=0.6：中间锚点 h 应为 0.6（协议值，viewer 球大小表示高度）
  const e = { t: 100, type: 'pass', from: 10, subject: 10, x: 1, y: 0, x2: 0.9, y2: 0.5, speed: 18, h: 0.6, detail: 'corner' };
  const anchors = interpretEvent(e);
  const mid = anchors.filter((a) => a.kind === 'ball' && a.h > 0);
  assert.ok(mid.length >= 1, '应有带 h 的球锚点');
  assert.ok(mid.every((a) => Math.abs(a.h - 0.6) < 1e-6), `h 应透传事件值 0.6，实际 ${mid[0].h}`);
});

test('P6 批次1 interpretPass: h 缺失 → 按飞行时长默认插值（向后兼容）', () => {
  // 旧事件流（无 h）：默认插值 0.08-0.2
  const e = { t: 100, type: 'pass', from: 10, subject: 10, x: 0.5, y: 0.5, x2: 0.7, y2: 0.5, speed: 12 };
  const anchors = interpretEvent(e);
  const mid = anchors.filter((a) => a.kind === 'ball' && a.h > 0);
  assert.ok(mid.length >= 1, '缺 h 时应默认插值出弧线');
  assert.ok(mid[0].h >= 0.08 && mid[0].h <= 0.2, `默认插值应在 0.08-0.2（实际 ${mid[0].h}）`);
});

test('P6 批次1 interpretPass: h=0 → 无高度（球不放大）', () => {
  // 界外球掷球 h=0：所有球锚点 h=0
  const e = { t: 100, type: 'pass', from: 5, subject: 5, to: 1, x: 0.47, y: 0, x2: 0.3, y2: 0.25, speed: 12, h: 0 };
  const anchors = interpretEvent(e);
  const balls = anchors.filter((a) => a.kind === 'ball');
  assert.ok(balls.every((a) => a.h === 0), `h=0 时球锚点应全为 0（实际 ${balls.map((b) => b.h)}）`);
});

test('P6 批次1 interpretShot: 头球射门 h=0 低空（不放大）', () => {
  const e = { t: 200, type: 'shot', subject: 10, x: 0.9, y: 0.5, x2: 0.98, y2: 0.5, speed: 15, result: 'goal', detail: 'header', h: 0 };
  const anchors = interpretEvent(e);
  const balls = anchors.filter((a) => a.kind === 'ball');
  assert.ok(balls.every((a) => a.h === 0), `头球射门 h=0 时球锚点应全为 0（实际 ${balls.map((b) => b.h)}）`);
});

test('P6 批次1 interpretPass: 出界 pass 球飞向边界（落点钳制到边缘）', () => {
  // 传球出边线：落点 y=0（边线），球飞向边界
  const e = { t: 100, type: 'pass', from: 12, subject: 12, x: 0.25, y: 0.33, x2: 0.47, y2: 0, speed: 14, result: 'contested', detail: 'out_sideline' };
  const anchors = interpretEvent(e);
  const ballEnd = anchors.filter((a) => a.kind === 'ball').sort((a, b) => a.t - b.t).pop();
  assert.equal(ballEnd.y, 0, '出界 pass 球应飞到边线（y=0）');
  assert.ok(ballEnd.x > 0, 'x 应保持界内钳制值');
});

test('P6 批次1 interpretPass: 角球发球从角旗飞向禁区（detail=corner 起点角旗）', () => {
  const e = { t: 100, type: 'pass', from: 13, subject: 13, x: 0, y: 1, x2: 0.14, y2: 0.6, speed: 18, h: 0.6, detail: 'corner' };
  const anchors = interpretEvent(e);
  const ballStart = anchors.filter((a) => a.kind === 'ball').sort((a, b) => a.t - b.t)[0];
  assert.equal(ballStart.x, 0, '角球发球起点 x=0（角旗）');
  assert.equal(ballStart.y, 1, '角球发球起点 y=1（角旗）');
});
