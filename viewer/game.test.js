// Game 播放控制单测（解耦模式：每个事件独立片段，默认不播放，点播才播）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from './game.js';

function makeGame() {
  const events = [
    { t: 0, type: 'kickoff', subject: 9, x: 0.5, y: 0.5 },
    { t: 5, type: 'pass', subject: 9, from: 9, to: 5, x: 0.5, y: 0.5, x2: 0.4, y2: 0.5, speed: 10, result: 'success' },
    { t: 10, type: 'dribble', subject: 5, x: 0.4, y: 0.5, x2: 0.5, y2: 0.45, speed: 6, touch_freq: 1, result: 'success' },
    { t: 20, type: 'shot', subject: 9, x: 0.6, y: 0.5, x2: 0.95, y2: 0.5, speed: 25, result: 'goal' },
    { t: 20, type: 'whistle', subject: 0, x: 0.5, y: 0.5, score: '1-0' },
  ];
  return new Game(events, []);
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
