// Game 播放控制单测（解耦模式：每个事件独立片段，默认不播放，点播才播）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from './game.js';
import { interpretEvent } from './interpretation.js';

// clip 模式测试：每个事件独立片段，默认不播放，点播才播
function makeGame() {
  const events = [
    { t: 0, type: 'kickoff', subject: 9, x: 0.5, y: 0.5 },
    { t: 5, type: 'pass', subject: 9, from: 9, to: 5, x: 0.5, y: 0.5, x2: 0.4, y2: 0.5, speed: 10, result: 'success' },
    { t: 10, type: 'dribble', subject: 5, x: 0.4, y: 0.5, x2: 0.5, y2: 0.45, speed: 6, touch_freq: 1, result: 'success' },
    { t: 20, type: 'shot', subject: 9, x: 0.6, y: 0.5, x2: 0.95, y2: 0.5, speed: 25, result: 'goal' },
    { t: 20, type: 'whistle', subject: 0, x: 0.5, y: 0.5, score: '1-0' },
  ];
  return new Game(events, [], 'clip');
}

test('默认不自动播放', () => {
  const g = makeGame();
  assert.equal(g.playing, false);
});

test('eventCount 返回事件总数', () => {
  const g = makeGame();
  assert.equal(g.eventCount, 5);
});

test('currentEventIndex: 默认第 0 个', () => {
  const g = makeGame();
  assert.equal(g.currentEventIndex(), 0);
});

test('jumpToEvent: 切到事件初始状态（playTime=事件t），并暂停', () => {
  const g = makeGame();
  g.playing = true;
  const ok = g.jumpToEvent(2);
  assert.equal(ok, true);
  assert.equal(g.playTime, 10); // 事件 2 的 t
  assert.equal(g.playing, false); // 切到事件后暂停
  assert.equal(g.currentEventIndex(), 2);
});

test('jumpToEvent: 越界返回 false', () => {
  const g = makeGame();
  assert.equal(g.jumpToEvent(-1), false);
  assert.equal(g.jumpToEvent(5), false);
});

test('stepEvent: 上下切换事件（直接跳，无过渡）', () => {
  const g = makeGame();
  g.jumpToEvent(2); // t=10
  g.stepEvent(1);   // → 事件 3 (shot, t=20)
  assert.equal(g.playTime, 20);
  assert.equal(g.currentEventIndex(), 3);
  g.stepEvent(-1);  // → 事件 2 (dribble, t=10)
  assert.equal(g.playTime, 10);
  assert.equal(g.currentEventIndex(), 2);
});

test('stepEvent: 边界钳制', () => {
  const g = makeGame();
  g.jumpToEvent(0);
  g.stepEvent(-1);
  assert.equal(g.currentEventIndex(), 0); // 停在第一个
  g.jumpToEvent(4);
  g.stepEvent(1);
  assert.equal(g.currentEventIndex(), 4); // 停在最后一个
});

// ---- 独立片段播放：只在当前事件窗口内推进，播完停 ----
test('step: 播放只推进当前事件片段，不进入下一事件', () => {
  const g = makeGame();
  g.jumpToEvent(2); // dribble t=10
  g.playing = true;
  g.step(0.5); // 推进 0.5 秒
  assert.ok(g.playTime > 10, `playTime 应推进，实际 ${g.playTime}`);
  // dribble 事件结束时间 = 该事件最后锚点 t，不应超过它太多
  const endT = g._eventEnds[2];
  assert.ok(g.playTime <= endT + 0.5, `不应越过事件结束太多，playTime=${g.playTime} end=${endT}`);
  assert.equal(g.currentEventIndex(), 2); // 仍在该事件
});

test('step: 播放到片段末尾自动停', () => {
  const g = makeGame();
  g.jumpToEvent(0); // kickoff t=0
  g.playing = true;
  // 大步推进，超过事件结束时间
  for (let i = 0; i < 100; i++) g.step(0.1);
  assert.equal(g.playing, false, '播完应自动停');
  const endT = g._eventEnds[0];
  assert.ok(g.playTime >= endT, `playTime 应到片段末尾，实际 ${g.playTime} end=${endT}`);
  assert.equal(g.currentEventIndex(), 0); // 仍在该事件，不跳到下一个
});

test('step: 未点播放时不推进', () => {
  const g = makeGame();
  g.jumpToEvent(2);
  assert.equal(g.playing, false);
  const t0 = g.playTime;
  g.step(1);
  assert.equal(g.playTime, t0, '未播放时 playTime 不变');
});

// ---- 解耦：跳到事件即显示初始状态（无过渡/漂移）----
test('跳转到事件：直接显示该事件初始状态', () => {
  const g = makeGame();
  g.jumpToEvent(1); // pass t=5，球应从起点 (0.5,0.5) 开始
  assert.equal(g.playTime, 5);
  // pass 起点球在 (0.5,0.5)
  assert.ok(Math.abs(g.ball.x - 0.5) < 0.001, `跳到 pass 球应在起点，实际 ${g.ball.x}`);
  assert.ok(Math.abs(g.ball.y - 0.5) < 0.001);
});

// ---- 重播当前动作 ----
test('replayCurrent: 回到当前事件起点并播放', () => {
  const g = makeGame();
  g.jumpToEvent(1); // pass t=5
  g.playing = true;
  g.step(0.5); // 播一会
  assert.ok(g.playTime > 5);
  g.replayCurrent();
  assert.equal(g.playTime, 5); // 回到起点
  assert.equal(g.playing, true); // 开始播放
});

test('togglePlay: 播完后再次点击 → 重启片段', () => {
  const g = makeGame();
  g.jumpToEvent(0); // kickoff
  g.playing = true;
  // 大步推进到播完
  for (let i = 0; i < 50; i++) g.step(0.1);
  assert.equal(g.playing, false);
  const endT = g._eventEnds[0];
  assert.ok(g.playTime >= endT);
  // 再点 togglePlay → 应重启片段
  g.togglePlay();
  assert.equal(g.playing, true);
  assert.ok(g.playTime <= endT + 0.01, `应回到片段内，实际 ${g.playTime}`);
});

// ---- 抢断片段：球从接触点弹到弹开点（经插值路径）----
const TACKLE_EVENT = { t: 5, type: 'tackle', subject: 10, x: 0.55, y: 0.5, to: 16, x2: 0.45, y2: 0.55, result: 'success' };
const TACKLE_LINEUP = [
  { id: 10, team: 'home', x: 0.55, y: 0.5 },
  { id: 16, team: 'away', x: 0.45, y: 0.55 },
];

test('step: tackle 事件播完，防守者与球在弹开点重合（拿到球）', () => {
  const g = new Game([TACKLE_EVENT], TACKLE_LINEUP, 'clip');
  // 弹开点 = 球最后锚点位置（从演绎层推导，而非硬编码）
  const anchors = interpretEvent(TACKLE_EVENT);
  const balls = anchors.filter((a) => a.kind === 'ball').sort((a, b) => a.t - b.t);
  const loose = balls[balls.length - 1];
  g.jumpToEvent(0);
  g.playing = true;
  for (let i = 0; i < 300; i++) g.step(0.1);
  assert.equal(g.playing, false, 'tackle 播完应自动停');
  assert.ok(Math.abs(g.ball.x - loose.x) < 0.001 && Math.abs(g.ball.y - loose.y) < 0.001, '球应停在弹开点');
  const tackler = g.players.find((p) => p.id === TACKLE_EVENT.subject);
  assert.ok(Math.abs(tackler.x - g.ball.x) < 0.001 && Math.abs(tackler.y - g.ball.y) < 0.001, '防守者应拿到球');
});

test('step: tackle 中间态——球先到弹开点，捡球人还在路上', () => {
  const g = new Game([TACKLE_EVENT], TACKLE_LINEUP, 'clip');
  const anchors = interpretEvent(TACKLE_EVENT);
  const balls = anchors.filter((a) => a.kind === 'ball').sort((a, b) => a.t - b.t);
  const loose = balls[balls.length - 1];
  const tLoose = loose.t;
  const tacklerEnd = anchors.filter((a) => a.kind === 'player' && a.id === TACKLE_EVENT.subject).sort((a, b) => b.t - a.t)[0];
  const tPickup = tacklerEnd.t;
  const midT = (tLoose + tPickup) / 2;
  g.jumpToEvent(0);
  g.playing = true;
  let guard = 0;
  while (g.playTime < midT && guard < 50000) { g.step(0.0005); guard++; }
  assert.ok(g.playTime >= midT, `应推进到 ${midT}，实际 ${g.playTime}`);
  // 球先到弹开点（球在 tLoose 已到位，之后停在那里等捡球人）
  assert.ok(Math.abs(g.ball.x - loose.x) < 0.001 && Math.abs(g.ball.y - loose.y) < 0.001, '球应先到弹开点');
  // 捡球人（防守者）还在追球路上，未到弹开点
  const tackler = g.players.find((p) => p.id === TACKLE_EVENT.subject);
  const dist = Math.hypot(tackler.x - loose.x, tackler.y - loose.y);
  assert.ok(dist > 0.01, `捡球人应还在路上，实际距弹开点 ${dist}`);
});

test('step: tackle fail——原持球人拿回球，防守者停在接触点', () => {
  const evt = { t: 5, type: 'tackle', subject: 11, x: 0.45, y: 0.5, to: 10, x2: 0.43, y2: 0.51, result: 'fail' };
  const lineup = [
    { id: 10, team: 'home', x: 0.43, y: 0.51 },
    { id: 11, team: 'away', x: 0.45, y: 0.5 },
  ];
  const g = new Game([evt], lineup, 'clip');
  g.jumpToEvent(0);
  g.playing = true;
  for (let i = 0; i < 300; i++) g.step(0.1);
  assert.equal(g.playing, false, 'tackle fail 播完应自动停');
  // 原持球人(10)与球重合（拿回）
  const carrier = g.players.find((p) => p.id === 10);
  assert.ok(Math.abs(carrier.x - g.ball.x) < 0.01 && Math.abs(carrier.y - g.ball.y) < 0.01, '原持球人应拿回球');
  // 防守者(11)停在接触点，没拿到球
  const tackler = g.players.find((p) => p.id === 11);
  assert.ok(Math.abs(tackler.x - g.ball.x) > 0.01 || Math.abs(tackler.y - g.ball.y) > 0.01, '失败时防守者不应拿到球');
});

// ---- 连续模式（continuous）：整场推进、跨事件、off_ball_run 填满 ----
function makeContinuousGame() {
  const events = [
    { t: 0, type: 'kickoff', subject: 9, x: 0.5, y: 0.5 },
    { t: 2, type: 'off_ball_run', subject: 4, x: 0.40, y: 0.25, x2: 0.42, y2: 0.27, speed: 3, result: 'success' },
    { t: 4, type: 'pass', subject: 9, from: 9, to: 5, x: 0.5, y: 0.5, x2: 0.4, y2: 0.5, speed: 10, result: 'success' },
    { t: 6, type: 'off_ball_run', subject: 7, x: 0.62, y: 0.15, x2: 0.63, y2: 0.17, speed: 3, result: 'success' },
    { t: 8, type: 'dribble', subject: 5, x: 0.4, y: 0.5, x2: 0.5, y2: 0.45, speed: 6, touch_freq: 1, result: 'success' },
    { t: 10, type: 'shot', subject: 5, x: 0.5, y: 0.45, x2: 0.95, y2: 0.5, speed: 25, result: 'goal' },
    { t: 12, type: 'whistle', subject: 0, x: 0.5, y: 0.5, score: '1-0' },
  ];
  const lineup = [
    { id: 4, team: 'home', x: 0.40, y: 0.25 },
    { id: 7, team: 'home', x: 0.62, y: 0.15 },
  ];
  return new Game(events, lineup, 'continuous');
}

test('continuous: 默认模式是 continuous，playTime 从 0 到 matchEnd', () => {
  const g = makeContinuousGame();
  assert.equal(g.mode, 'continuous');
  assert.equal(g.playTime, 0);
  g.playing = true;
  for (let i = 0; i < 500; i++) g.step(0.1);
  assert.equal(g.playing, false, '播到比赛结束应自动停');
  assert.ok(g.playTime >= 11.99, `应播到比赛结束，实际 ${g.playTime}`);
});

test('continuous: 跨事件推进（不 clamp 到单个事件）', () => {
  const g = makeContinuousGame();
  g.jumpToEvent(2); // pass t=4
  g.playing = true;
  for (let i = 0; i < 200; i++) g.step(0.1);
  // 应越过 pass 事件进入后续事件
  assert.ok(g.playTime > 8, `应跨过多个事件，实际 ${g.playTime}`);
  assert.ok(g.currentEventIndex() > 2, '应已进入后续事件');
});

test('continuous: off_ball_run 事件让球员碎步移动（球不动）', () => {
  const g = makeContinuousGame();
  // 跳到 off_ball_run 事件（idx 1, t=2），播完
  g.jumpToEvent(1);
  g.playing = true;
  for (let i = 0; i < 100; i++) g.step(0.1);
  const p4 = g.players.find((p) => p.id === 4);
  // 4 号应已从 (0.40,0.25) 移动到 (0.42,0.27)
  assert.ok(Math.abs(p4.x - 0.42) < 0.02, `4 号应移动到 (0.42,0.27)，实际 ${p4.x}`);
});

test('continuous: 事件边界无 snap（球位置平滑）', () => {
  const g = makeContinuousGame();
  g.playing = true;
  let prevBall = { ...g.ball };
  let maxJump = 0;
  for (let i = 0; i < 300; i++) {
    g.step(0.1);
    const jump = Math.hypot(g.ball.x - prevBall.x, g.ball.y - prevBall.y);
    maxJump = Math.max(maxJump, jump);
    prevBall = { ...g.ball };
  }
  // 事件边界位移不应超过正常事件内位移（阈值 ~0.1 归一化）
  assert.ok(maxJump < 0.5, `事件边界球位移过大，maxJump=${maxJump}`);
});
