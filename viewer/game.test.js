// Game 播放控制单测（解耦模式：每个事件独立片段，默认不播放，点播才播）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, buildGameIndex, PLAYER_TEXTURE } from './game.js';
import { config } from './config.js?v=20261029-1';
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
  const g = new Game([TACKLE_EVENT], TACKLE_LINEUP, 'clip', { baseSpeed: 1 });
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
  const g = new Game([TACKLE_EVENT], TACKLE_LINEUP, 'clip', { baseSpeed: 1 });
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
  const g = new Game([evt], lineup, 'clip', { baseSpeed: 1 });
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
  // P7：无高亮事件流，关闭跳过（保持既有 1:1 断言语义）
  return new Game(events, lineup, 'continuous', { baseSpeed: 1, skipThreshold: Infinity });
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
  // 事件边界位移不应超过正常事件内位移（阈值 ~0.1 归一化）；
  // 但进球后球直接回中圈（死球→kickoff 瞬移例外，P6）允许 ~0.5 跳变——阈值放宽到 0.6
  assert.ok(maxJump < 0.6, `事件边界球位移过大，maxJump=${maxJump}`);
});

// ---- v2：beat 节拍连续播放 ----

function makeV2Game() {
  // lineup 位置与首个 beat movers/main 起点一致（引擎 pos 连续，避免开场滑移干扰测试）
  const lineup = Array.from({ length: 22 }, (_, i) => ({
    id: i, team: i <= 10 ? 'home' : 'away', x: 0.5, y: 0.5,
  }));
  lineup[5] = { id: 5, team: 'home', x: 0.4, y: 0.42 };
  lineup[10] = { id: 10, team: 'home', x: 0.55, y: 0.5 };
  const events = [
    { t: 0, type: 'lineup', subject: 0, x: 0.5, y: 0.5, players: lineup.map((p) => ({ ...p })) },
    { t: 1, type: 'beat', movers: [{ id: 5, from_x: 0.4, from_y: 0.42, to_x: 0.42, to_y: 0.42, speed: 4, action: 'run' }], main: { type: 'dribble', subject: 10, x: 0.55, y: 0.5, x2: 0.58, y2: 0.5, speed: 5, touch_freq: 1.5 } },
    { t: 2, type: 'beat', movers: [{ id: 5, from_x: 0.42, from_y: 0.42, to_x: 0.45, to_y: 0.43, speed: 4, action: 'run' }], main: { type: 'dribble', subject: 10, x: 0.58, y: 0.5, x2: 0.6, y2: 0.51, speed: 5, touch_freq: 1.5 } },
    { t: 3, type: 'beat', movers: [{ id: 5, from_x: 0.45, from_y: 0.43, to_x: 0.47, to_y: 0.43, speed: 4, action: 'run' }], main: { type: 'dribble', subject: 10, x: 0.6, y: 0.51, x2: 0.62, y2: 0.51, speed: 5, touch_freq: 1.5 } },
    { t: 4, type: 'whistle', subject: 0, x: 0.5, y: 0.5, score: '0-0' },
  ];
  return new Game(events, lineup, 'continuous', { baseSpeed: 1, skipThreshold: Infinity });
}

test('v2 continuous: beat 跨拍推进，球员与球并行移动', () => {
  const g = makeV2Game();
  g.playing = true;
  const p5 = g.players.find((p) => p.id === 5);
  const startX = p5.x;
  for (let i = 0; i < 100; i++) g.step(0.1);
  assert.ok(g.playTime >= g.matchEnd - 0.1, `应播到比赛结束，实际 ${g.playTime}/${g.matchEnd}`);
  assert.ok(Math.abs(p5.x - startX) > 0.01, `5 号应跨拍移动，实际 Δ=${Math.abs(p5.x - startX)}`);
  // 球随 main 移动（carrier 10 带球）
  assert.ok(g.ball.x >= 0.55, `球应随 main 前进，实际 x=${g.ball.x}`);
});

test('v2 continuous: beat 事件边界无 snap（球 + 球员位置连续）', () => {
  const g = makeV2Game();
  g.playing = true;
  let prevBall = { ...g.ball };
  let prevP5 = { ...g.players.find((p) => p.id === 5) };
  let maxBallJump = 0;
  let maxPlayerJump = 0;
  for (let i = 0; i < 200; i++) {
    g.step(0.1);
    const bj = Math.hypot(g.ball.x - prevBall.x, g.ball.y - prevBall.y);
    maxBallJump = Math.max(maxBallJump, bj);
    const p = g.players.find((p) => p.id === 5);
    const pj = Math.hypot(p.x - prevP5.x, p.y - prevP5.y);
    maxPlayerJump = Math.max(maxPlayerJump, pj);
    prevBall = { ...g.ball };
    prevP5 = { ...p };
  }
  // 跨拍连续：from(N+1)==to(N)，位移平滑（阈值宽松：单拍位移 ~0.02 归一化）
  assert.ok(maxBallJump < 0.1, `球事件边界跳变过大 maxBallJump=${maxBallJump}`);
  assert.ok(maxPlayerJump < 0.1, `球员事件边界跳变过大 maxPlayerJump=${maxPlayerJump}`);
});

// 事件重叠（传球飞行跨过下一拍 tick）——判别性守卫：插值器不得把球冻在飞行中段再瞬移。
// 复现 e2e-v2 seed1 的失效形态：传球 ballDur 略大于拍间隔 → 末锚点(t=1.0167)排在下一拍
// 起点锚点(t=1)之后。旧逻辑「相邻锚点 evt 不同即 hold」会把球冻在中点(0.4525)、t=1 瞬移
// 到落点(0.605)（≈0.15 归一化，远超阈值）——本测试就是靠这 0.15 的跳变把旧逻辑判红。
function makeOverlapPassGame() {
  const lineup = Array.from({ length: 22 }, (_, i) => ({ id: i, team: i <= 10 ? 'home' : 'away', x: 0.5, y: 0.5 }));
  lineup[10] = { id: 10, team: 'home', x: 0.3, y: 0.5 };
  lineup[11] = { id: 11, team: 'home', x: 0.6, y: 0.5 };
  const events = [
    { t: 0, type: 'lineup', subject: 0, x: 0.5, y: 0.5, players: lineup.map((p) => ({ ...p })) },
    // 传球：dist = |0.605-0.3|·105 = 32.025m ÷ speed 31.5 = ballDur 1.0167s（> 1s 拍间距）
    { t: 0, type: 'pass', subject: 10, from: 10, to: 11, x: 0.3, y: 0.5, x2: 0.605, y2: 0.5, speed: 31.5, result: 'success', receiver_x: 0.6, receiver_y: 0.5, h: 0 },
    { t: 1, type: 'beat', movers: [], main: { type: 'dribble', subject: 11, x: 0.605, y: 0.5, x2: 0.615, y2: 0.5, speed: 5, touch_freq: 1.5 } },
    { t: 2, type: 'beat', movers: [], main: { type: 'dribble', subject: 11, x: 0.615, y: 0.5, x2: 0.615, y2: 0.5, speed: 5, touch_freq: 1.5 } },
    { t: 3, type: 'whistle', subject: 0, x: 0.5, y: 0.5, score: '0-0' },
  ];
  return new Game(events, lineup, 'continuous', { baseSpeed: 1, skipThreshold: Infinity });
}

test('v2 continuous: 传球飞行跨拍（事件重叠）不产生球 snap', () => {
  const g = makeOverlapPassGame();
  g.playing = true;
  let prevBall = { ...g.ball };
  let maxBallJump = 0;
  for (let i = 0; i < 200; i++) {
    g.step(1 / 60);
    maxBallJump = Math.max(maxBallJump, Math.hypot(g.ball.x - prevBall.x, g.ball.y - prevBall.y));
    prevBall = { ...g.ball };
  }
  // 阈值 0.05（与 e2e-v2 同口径）：修复后单帧位移 ≈ 0.005；未修复时 t=1 单帧跳 ≈ 0.15
  assert.ok(maxBallJump < 0.05, `传球跨拍不应产生球 snap，maxBallJump=${maxBallJump}`);
});

// ---- P7：跳过机制（高亮识别 + 间隙检测 + 跳过模式）----

function makeSkipGame() {
  // 构造：beat 过渡 + 高亮 shot（t=30）+ 尾部 beat（t=40，非精彩段）
  const events = [
    { t: 0, type: 'lineup', subject: 0, x: 0.5, y: 0.5, players: [{ id: 5, team: 'home', x: 0.4, y: 0.5 }, { id: 10, team: 'home', x: 0.55, y: 0.5 }] },
    { t: 1, type: 'beat', movers: [], main: { type: 'dribble', subject: 10, x: 0.55, y: 0.5, x2: 0.58, y2: 0.5, speed: 5, touch_freq: 1.5 } },
    // 高亮 shot（t=30，间隙 29s > 阈值 5s）
    { t: 30, type: 'shot', subject: 10, x: 0.6, y: 0.5, x2: 0.98, y2: 0.5, speed: 20, result: 'goal' },
    // 尾部非精彩段（shot 后到 t=40 无高亮）
    { t: 40, type: 'beat', movers: [], main: { type: 'dribble', subject: 10, x: 0.6, y: 0.5, x2: 0.6, y2: 0.5, speed: 5, touch_freq: 1.5 } },
    { t: 40, type: 'whistle', subject: 0, x: 0.5, y: 0.5, score: '1-0' },
  ];
  const lineup = [{ id: 5, team: 'home', x: 0.4, y: 0.5 }, { id: 10, team: 'home', x: 0.55, y: 0.5 }];
  return new Game(events, lineup, 'continuous', { baseSpeed: 1 });
}

test('P7 isHighlightEvent: shot/tackle/精彩 detail 为真，普通 pass 为假', () => {
  const g = makeSkipGame();
  assert.equal(g.isHighlightEvent({ type: 'shot' }), true);
  assert.equal(g.isHighlightEvent({ type: 'tackle' }), true);
  assert.equal(g.isHighlightEvent({ type: 'foul' }), true, 'foul 应是高亮（不跳过）');
  assert.equal(g.isHighlightEvent({ type: 'pass', detail: 'corner' }), true);
  assert.equal(g.isHighlightEvent({ type: 'pass', detail: 'throw_in' }), true);
  assert.equal(g.isHighlightEvent({ type: 'pass', detail: 'out_sideline' }), true);
  assert.equal(g.isHighlightEvent({ type: 'pass', detail: 'free_kick' }), true, '任意球重开应是高亮');
  assert.equal(g.isHighlightEvent({ type: 'pass', to: 5 }), false, '普通 pass 非高亮');
  assert.equal(g.isHighlightEvent({ type: 'beat', movers: [] }), false);
});

test('foul: activeCards 只返回出示窗口内的黄/红牌', () => {
  const events = [
    { t: 0, type: 'lineup', subject: 0, x: 0.5, y: 0.5, players: [{ id: 15, team: 'away', x: 0.58, y: 0.4 }, { id: 6, team: 'home', x: 0.44, y: 0.42 }] },
    { t: 10, type: 'foul', subject: 15, carrier: 6, x: 0.44, y: 0.42, detail: 'foul_trip', card: 'yellow' },
    { t: 50, type: 'foul', subject: 15, carrier: 6, x: 0.44, y: 0.42, detail: 'foul_push', card: 'red' },
    { t: 100, type: 'whistle', subject: 0, x: 0.5, y: 0.5, score: '0-0' },
  ];
  const lineup = [{ id: 15, team: 'away', x: 0.58, y: 0.4 }, { id: 6, team: 'home', x: 0.44, y: 0.42 }];
  const g = new Game(events, lineup, 'continuous', { baseSpeed: 1, skipThreshold: Infinity });
  g.seekTo(10.5); // 第一张黄牌出示窗口内
  let cards = g.activeCards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].card, 'yellow');
  assert.equal(cards[0].subject, 15);
  g.seekTo(50.5); // 红牌出示窗口内
  cards = g.activeCards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].card, 'red');
  g.seekTo(80); // 两张窗口都过
  assert.equal(g.activeCards().length, 0);
});

test('P7 isSkipping: 非高亮窗口且距下一个高亮 > 阈值 → 跳过', () => {
  const g = makeSkipGame();
  g.playTime = 5; // 在 t=1 beat 后、t=30 shot 前，间隙 25s > 阈值
  assert.equal(g.isSkipping(), true);
  g.playTime = 29.5; // 接近高亮
  assert.equal(g.isSkipping(), false, '距高亮 < 阈值不应跳过');
  g.playTime = 30; // 高亮窗口内
  assert.equal(g.isSkipping(), false, '高亮窗口内不应跳过');
});

test('P7 skip 模式: 直接跳到下一个高亮起点', () => {
  const g = makeSkipGame();
  g.skipMode = 'skip';
  g.playing = true;
  g.playTime = 5;
  g.step(1 / 60);
  assert.equal(g.playTime, 30, 'skip 模式应直接跳到下一个高亮 t=30');
});

test('P7 fast 模式: 快进（跳过量 > 正常步进）', () => {
  const g = makeSkipGame();
  g.skipMode = 'fast';
  g.playing = true;
  g.playTime = 5;
  g.step(1 / 60);
  // fast 模式 = 基速 × skipChoice（默认 5），1 帧 1/60s × 5 ≈ 0.083s 比赛时间
  assert.ok(g.playTime > 5.02, `fast 模式应快进（实际 ${g.playTime}）`);
  assert.ok(g.playTime < 30, 'fast 模式不应越过高亮');
});

test('P7 时间显示格式: formatMatchClock 跟随 matchEnd', () => {
  // formatMatchClock 在 app.js（DOM 依赖），这里验证 game.matchEnd 反映时长参数
  const g5 = new Game([{ t: 0, type: 'lineup', subject: 0, x: 0.5, y: 0.5, players: [] }], [], 'continuous', { baseSpeed: 1 });
  // matchEnd = 最后事件 t（无锚点 → 0）——用有锚点的事件
  const g = makeSkipGame();
  assert.ok(g.matchEnd >= 30, `matchEnd 应 ≥ 最后事件 t（实际 ${g.matchEnd}）`);
});

test('P7 skip 模式: 尾部（最后一个高亮后）也跳过到比赛结束', () => {
  const g = makeSkipGame();
  g.skipMode = 'skip';
  g.playing = true;
  g.playTime = 35; // 尾部（shot 窗口 [30,~31] 之后、t=40 无高亮）
  g.step(1 / 60);
  assert.equal(g.playTime, g.matchEnd, '尾部应跳过到比赛结束');
  assert.equal(g.playing, false, '跳过结束后应停止');
});

test('P7 fast 模式: dt 钳制（大 dt 不整段跳过高亮窗口）', () => {
  const g = makeSkipGame();
  g.skipMode = 'fast';
  g.playing = true;
  g.playTime = 5; // 间隙中
  // 模拟帧尖峰 dt=2s：应被钳制到 0.1s，不会直接越过高亮 t=30
  g.step(2);
  assert.ok(g.playTime < 30, `dt 钳制后不应越过高亮（实际 ${g.playTime}）`);
  assert.ok(g.playTime > 5, 'fast 应快进');
});

test('P7 高亮窗口合并级联：相邻高亮（间隔 < 阈值）合并成连续窗口', () => {
  // 构造：角球发球（corner）→ battle beat → 头球（header shot），间隔 < 阈值 → 应合并
  const events = [
    { t: 0, type: 'lineup', subject: 0, x: 0.5, y: 0.5, players: [{ id: 10, team: 'home', x: 0.55, y: 0.5 }] },
    { t: 10, type: 'pass', from: 10, subject: 10, to: undefined, x: 1, y: 0, x2: 0.9, y2: 0.5, speed: 18, detail: 'corner', h: 0.6 },
    { t: 11, type: 'beat', movers: [] }, // battle
    { t: 12, type: 'shot', subject: 10, x: 0.9, y: 0.5, x2: 0.98, y2: 0.5, speed: 15, result: 'goal', detail: 'header', h: 0 },
  ];
  const lineup = [{ id: 10, team: 'home', x: 0.55, y: 0.5 }];
  const g = new Game(events, lineup, 'continuous', { baseSpeed: 1, skipThreshold: 5 });
  // corner pass(t=10) 与 header shot(t=12) 间隔 2s < 阈值 5s → 合并成一个窗口
  assert.equal(g._highlightWindows.length, 1, '角球→头球应合并成单个连续窗口');
  assert.ok(g._highlightWindows[0].t <= 10 && g._highlightWindows[0].end >= 12, '窗口应覆盖角球到头球');
});

test('P7 跳过模式循环：fast → skip → off → fast', () => {
  const g = makeSkipGame();
  assert.equal(g.skipMode, 'fast'); // config 默认 fast
  assert.equal(g.cycleSkipMode(), 'skip');
  assert.equal(g.cycleSkipMode(), 'off');
  assert.equal(g.isSkipEnabled(), false, 'off 模式跳过禁用');
  assert.equal(g.cycleSkipMode(), 'fast');
  assert.equal(g.isSkipEnabled(), true);
});

test('sent-off player is excluded from the rendered players list (no ghost)', () => {
  // P34 审阅 R3-P2-3：引擎在红牌后不再发射该球员锚点（spec：罚下球员不得进 movers），
  // 但时间线会保持其最后锚点——`game.players` 必须过滤罚下球员，否则他会永远杵在原地
  // 被画出来（幽灵）。
  const lineup = [
    { id: 0, team: 'home', x: 0.02, y: 0.5 },
    { id: 5, team: 'home', x: 0.5, y: 0.5 },
    { id: 15, team: 'away', x: 0.6, y: 0.5 },
  ];
  const events = [
    { t: 0, type: 'lineup', subject: 0, x: 0.5, y: 0.5, players: lineup },
    { t: 0, type: 'kickoff', subject: 5, x: 0.5, y: 0.5 },
    { t: 10, type: 'foul', subject: 15, x: 0.6, y: 0.5, card: 'red' },
    { t: 12, type: 'beat', movers: [{ id: 5, from_x: 0.5, from_y: 0.5, to_x: 0.55, to_y: 0.5, speed: 4, action: 'run' }] },
  ];
  const g = new Game(events, lineup, 'continuous');
  g.seekTo(6);
  assert.ok(g.players.some((p) => p.id === 15), '红牌之前 15 应在可见列表');
  g.seekTo(20);
  assert.ok(!g.players.some((p) => p.id === 15), '红牌之后 15 不得出现在可见列表（幽灵排除）');
  // 边界钉死：红牌**当刻**（t == offAt）仍应可见（该时刻他还在场上；口径同
  // `derive-audit-features` 的 `t > offAt` 才跳过采样）。
  const g2 = new Game(events, lineup, 'continuous');
  g2.seekTo(10);
  assert.ok(g2.players.some((p) => p.id === 15), '红牌当刻（t==offAt）15 仍应可见');
  assert.ok(g.players.some((p) => p.id === 5), '未罚下球员应仍在可见列表');
  // 内部全量列表仍保留该球员（保证时间线插值一致性）。
  assert.ok(g._players.some((p) => p.id === 15), '_players（全量）仍含 15');
});

// ---- micro-motion 抑制：高亮参与者回溯（P5 S3；issue #81 修复的守护）----
// pass/shot 的 beat 在同一 tick 之后，故 currentEventIndex() 恒落在 beat 上
// （tackle 的 beat 在前、foul 不产 beat——见 _highlightEnd）。
// 此前 currentHighlightParticipants() 直接取 currentEventIndex() 的事件 → 恒为空集，
// 抑制从不生效（实测约 94-99% 高亮帧，视统计口径）。本测试钉死「按事件窗口回溯查找」的语义。
test('micro-motion 抑制：高亮窗口中点仍能取到参与者（beat 同 tick 不遮蔽）', () => {
  const events = [
    { t: 0, type: 'kickoff', subject: 9, x: 0.5, y: 0.5 },
    { t: 10, type: 'pass', subject: 9, from: 9, to: 5, x: 0.5, y: 0.5, x2: 0.4, y2: 0.5, speed: 10, result: 'success' },
    // 引擎在同 tick 追加的 beat（会遮蔽 currentEventIndex 指向的高亮事件）
    { t: 10, type: 'beat', movers: [], main: { type: 'dribble', subject: 5, x: 0.4, y: 0.5, x2: 0.4, y2: 0.5, speed: 5, touch_freq: 1 } },
    { t: 11, type: 'beat', movers: [] },
  ];
  const lineup = [
    { id: 9, team: 'home', x: 0.5, y: 0.5 },
    { id: 5, team: 'home', x: 0.4, y: 0.5 },
  ];
  const g = new Game(events, lineup, 'continuous', { baseSpeed: 1, skipThreshold: Infinity });
  // 高亮窗口中段：currentEventIndex 指向 beat，但回溯应找到 pass
  g.playTime = 10.3;
  assert.equal(g.events[g.currentEventIndex()].type, 'beat', '前提：当前事件是同 tick 的 beat');
  const parts = g.currentHighlightParticipants().sort((a, b) => a - b);
  assert.deepEqual(parts, [5, 9], '高亮参与者应回溯取到 pass 的 from/to（不被 beat 遮蔽）');
});

test('micro-motion 抑制：高亮窗口外（无覆盖事件）返回空', () => {
  const events = [
    { t: 0, type: 'kickoff', subject: 9, x: 0.5, y: 0.5 },
    { t: 10, type: 'pass', subject: 9, from: 9, to: 5, x: 0.5, y: 0.5, x2: 0.4, y2: 0.5, speed: 10, result: 'success' },
    { t: 30, type: 'shot', subject: 9, x: 0.6, y: 0.5, x2: 0.95, y2: 0.5, speed: 25, result: 'goal' },
  ];
  const lineup = [
    { id: 9, team: 'home', x: 0.5, y: 0.5 },
    { id: 5, team: 'home', x: 0.4, y: 0.5 },
  ];
  const g = new Game(events, lineup, 'continuous', { baseSpeed: 1, skipThreshold: Infinity });
  g.playTime = 20; // pass 已结束（end=10）、shot 未开始（t=30）
  assert.deepEqual(g.currentHighlightParticipants(), [], '窗口外应无参与者');
});

test('micro-motion 抑制：犯规窗口内仍能取到参与者（foul 不产 beat、语义窗口 = 牌显示时长）', () => {
  const events = [
    { t: 0, type: 'kickoff', subject: 9, x: 0.5, y: 0.5 },
    { t: 10, type: 'foul', subject: 6, carrier: 15, x: 0.6, y: 0.4, detail: 'foul_tackle' },
    { t: 11, type: 'beat', movers: [] },
  ];
  const lineup = [
    { id: 6, team: 'home', x: 0.6, y: 0.4 },
    { id: 15, team: 'away', x: 0.6, y: 0.42 },
  ];
  const g = new Game(events, lineup, 'continuous', { baseSpeed: 1, skipThreshold: Infinity });
  // 犯规 tick 之后、牌显示窗口内：窗口零长度会失效，必须由 _highlightEnd 延长
  g.playTime = 10 + config.interpretation.foul.cardShowDuration * 0.5;
  const parts = g.currentHighlightParticipants().sort((a, b) => a - b);
  assert.deepEqual(parts, [6, 15], '犯规窗口内应取到 subject/carrier（不被零长度窗口吞掉）');
});

// ---- #154：静态索引（`buildGameIndex` + `new Game(..., { index })`）----
// 逐窗重建整场锚点索引是整场滑窗扫描逐窗成本的主体（91.5%，见
// `openspec/changes/p154-game-index-cache/design.md` §D1），故把它抽成可复用的纯计算结果。
// 这里钉死的是：**复用索引构造出的 Game 与每次重建构造出的 Game 完全一致**——包括
// `_interpolateAnchors` 返回 null（该实体此刻无锚点）时回落初始站位的那条分支（#152 记为
// 「复用实例的行为差异」；本 change 不复用实例、只复用索引，故那条分支逐位保持）。
// ⚠️ 该分支在**真实事件流**里于窗口区间不可达（§D5 实测：引擎在 lineup/kickoff 就为每个球员
// 发了锚点），故 fixture 里**刻意放一个「在 `game.lineup` 里、但不在 `lineup` 事件的 `players`
// 里」的球员（id 7）**——锚点由 `lineup` 事件的 `players` 产生（`interpretation.js` 的 `lineup`
// 分支），故他会插值返回 null。否则「本用例覆盖了这条分支」就是一句空话
// （#154 审阅 P2-7 实测：旧 fixture 在 12 个时刻上 null 命中 0 次）。
function indexFixture() {
  const lineup = [
    { id: 0, team: 'home', x: 0.02, y: 0.5 },
    { id: 5, team: 'home', x: 0.5, y: 0.5 },
    { id: 7, team: 'home', x: 0.3, y: 0.62 }, // 刻意：无任何锚点 → 插值返回 null
    { id: 9, team: 'home', x: 0.4, y: 0.5 },
    { id: 15, team: 'away', x: 0.6, y: 0.5 },
  ];
  const events = [
    { t: 0, type: 'lineup', subject: 0, x: 0.5, y: 0.5, players: lineup.filter((p) => p.id !== 7) },
    { t: 0, type: 'kickoff', subject: 5, x: 0.5, y: 0.5 },
    { t: 5, type: 'pass', subject: 5, from: 5, to: 9, x: 0.5, y: 0.5, x2: 0.4, y2: 0.5, speed: 10, result: 'success' },
    { t: 5, type: 'beat', movers: [{ id: 15, from_x: 0.6, from_y: 0.5, to_x: 0.62, to_y: 0.55, speed: 4, action: 'run' }] },
    { t: 12, type: 'shot', subject: 9, x: 0.7, y: 0.5, x2: 0.95, y2: 0.5, speed: 25, result: 'goal' },
    { t: 30, type: 'foul', subject: 15, x: 0.6, y: 0.5, card: 'red' },
    { t: 40, type: 'beat', movers: [{ id: 5, from_x: 0.5, from_y: 0.5, to_x: 0.55, to_y: 0.5, speed: 4, action: 'run' }] },
  ];
  return { events, lineup };
}

// 可观测状态快照：位置/球/播放时刻/当前事件/高亮窗口/卡牌 —— 覆盖构造期全部可见产物。
function snapshotOf(g) {
  return JSON.stringify({
    players: g.players.map((p) => ({ id: p.id, x: p.x, y: p.y })),
    allPlayers: g._players.map((p) => ({ id: p.id, x: p.x, y: p.y })),
    ball: g.ball,
    playTime: g.playTime,
    playing: g.playing,
    clipIndex: g._clipIndex,
    matchEnd: g.matchEnd,
    eventEnds: [...g._eventEnds],
    highlightWindows: g._highlightWindows,
    idx: g.currentEventIndex(),
    participants: g.currentHighlightParticipants(),
    cards: g.activeCards(),
    progress: g.getProgress(),
  });
}

test('#154 复用静态索引 == 每窗重建：构造态、seekTo、step 序列逐位一致', () => {
  const { events, lineup } = indexFixture();
  const index = buildGameIndex(events, lineup, 'continuous');
  // 前提自证（防空转）：fixture 里那个无锚点球员**在窗口区间真的会让插值返回 null**——
  // 否则「覆盖了回落分支」这句话没有断言支撑（#154 审阅 P2-7）。
  const probe = new Game(events, lineup, 'continuous');
  probe.seekTo(20);
  assert.equal(probe._interpolateAnchors('player', 20, 7), null, 'fixture 必须让 id=7 的插值返回 null');
  // 构造态
  assert.equal(
    snapshotOf(new Game(events, lineup, 'continuous', { index })),
    snapshotOf(new Game(events, lineup, 'continuous')),
    '构造后的初始状态必须一致'
  );
  // 逐窗（含 t 落在首个锚点之前/窗口之间/末尾/红牌前后的时刻）
  for (const t of [0, 0.5, 3, 5, 9.999, 12, 20, 29.5, 30, 30.5, 45, 999]) {
    const cached = new Game(events, lineup, 'continuous', { index });
    const rebuilt = new Game(events, lineup, 'continuous');
    cached.seekTo(t);
    rebuilt.seekTo(t);
    assert.equal(snapshotOf(cached), snapshotOf(rebuilt), `t=${t} 处 seekTo 后的状态必须一致`);
  }
  // 推进序列（step 会改 playTime 与插值态）
  const a = new Game(events, lineup, 'continuous', { index });
  const b = new Game(events, lineup, 'continuous');
  a.seekTo(5);
  b.seekTo(5);
  a.playing = true;
  b.playing = true;
  for (let i = 0; i < 40; i++) {
    a.step(0.05);
    b.step(0.05);
    assert.equal(snapshotOf(a), snapshotOf(b), `第 ${i} 次 step 后必须一致`);
  }
});

// 索引摘要。`playerAnchors` / `playerBounds` 是 **Map**，而 `JSON.stringify` 把 Map 序列化成
// `{}` —— 裸 `{ ...index }` 摘要对「分组被就地改写 / 组内锚点被删」这一整类污染**完全看不见**
// （#154 审阅 P2-3 实测三类全盲）。故摘要**显式展开 Map**。与 `tools/spacing-sweep.test.mjs`
// 的 `digestIndex` 同口径（那边由一条反证条用例自证区分度；这边由下面那条反证条自证）。
function digestIndexForTest(index) {
  const entries = (m) => [...m].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify({
    mode: index.mode,
    timeline: index.timeline,
    ballAnchors: index.ballAnchors,
    playerAnchors: entries(index.playerAnchors),
    ballBounds: index.ballBounds,
    playerBounds: entries(index.playerBounds),
    eventEnds: index.eventEnds,
    matchEnd: index.matchEnd,
  });
}

test('#154 索引摘要反证条：对「分组 Map 被改写 / 组内锚点被删 / 锚点被改」都有区分度', () => {
  const { events, lineup } = indexFixture();
  const base = buildGameIndex(events, lineup, 'continuous');
  const d = digestIndexForTest(base);
  assert.equal(digestIndexForTest(buildGameIndex(events, lineup, 'continuous')), d, '自反：同输入必须判相同');
  const dropped = new Map(base.playerAnchors);
  dropped.delete(5);
  assert.notEqual(digestIndexForTest({ ...base, playerAnchors: dropped }), d, '分组 Map 整组被删必须判不同');
  const shrunk = new Map(base.playerAnchors);
  shrunk.set(5, shrunk.get(5).slice(0, -1));
  assert.notEqual(digestIndexForTest({ ...base, playerAnchors: shrunk }), d, '组内锚点被删必须判不同');
  assert.notEqual(
    digestIndexForTest({ ...base, timeline: base.timeline.map((a, i) => (i === 0 ? { ...a, x: a.x + 0.01 } : a)) }),
    d,
    '锚点被改必须判不同'
  );
  const ends = base.eventEnds.slice();
  ends[0] = (ends[0] ?? 0) + 1;
  assert.notEqual(digestIndexForTest({ ...base, eventEnds: ends }), d, '结束时刻被改必须判不同');
});

test('#154 索引复用不改变外部输入：构造多窗不修改 events / lineup / 索引本身', () => {
  const { events, lineup } = indexFixture();
  const before = JSON.stringify({ events, lineup });
  const index = buildGameIndex(events, lineup, 'continuous');
  const indexDigest = digestIndexForTest(index);
  for (let i = 0; i < 5; i++) {
    const g = new Game(events, lineup, 'continuous', { index });
    g.seekTo(5 + i * 5);
    g.step(0.1);
  }
  assert.equal(JSON.stringify({ events, lineup }), before, '构造/推进不得改写传入的 events / lineup');
  assert.equal(digestIndexForTest(index), indexDigest, '构造/推进不得改写被复用的静态索引');
});

test('#154 索引复用必须同源：换了事件流/站位/模式 → 报错（不静默用错）', () => {
  const { events, lineup } = indexFixture();
  const index = buildGameIndex(events, lineup, 'continuous');
  assert.doesNotThrow(() => new Game(events, lineup, 'continuous', { index }), '同源复用必须放行');
  const other = indexFixture();
  assert.throws(() => new Game(other.events, other.lineup, 'continuous', { index }), /不同源/);
  assert.throws(() => new Game(events, [...lineup], 'continuous', { index }), /不同源/);
  assert.throws(() => new Game(events, lineup, 'clip', { index }), /不同源/);
  // 合法路径：clip 模式的索引给 clip 模式用
  const clipIndex = buildGameIndex(events, lineup, 'clip');
  assert.doesNotThrow(() => new Game(events, lineup, 'clip', { index: clipIndex }), 'clip 索引复用到 clip 模式必须放行');
});

// ---- R3 T1：球员路径纹理（bow 偏移）----

test('T1 纹理：确定性（同 t 同位置，与 seek 历史/顺序无关）', () => {
  const { events, lineup } = indexFixture();
  const g1 = new Game(events, lineup, 'continuous');
  const g2 = new Game(events, lineup, 'continuous');
  const at = [3.3, 10.7, 47.2, 200.1];
  const p1 = at.map((t) => { g1.seekTo(t); return g1.players.map((p) => [p.id, p.x, p.y]); });
  // 反序 seek（模拟任意播放/跳转路径）
  const p2 = [...at].reverse().map((t) => { g2.seekTo(t); return g2.players.map((p) => [p.id, p.x, p.y]); }).reverse();
  assert.deepEqual(p1, p2, '纹理必须是 t 的纯函数（同 t 同位置）');
});

test('T1 纹理：锚点时刻位置逐位不变（C5 同一承诺）', () => {
  const { events, lineup } = indexFixture();
  const g = new Game(events, lineup, 'continuous');
  let checked = 0;
  for (const [id, arr] of g._playerAnchors) {
    for (const a of arr) {
      if (!(a.t >= 0 && a.t <= g.matchEnd)) continue;
      g.seekTo(a.t);
      const p = g.players.find((q) => q.id === id);
      if (!p) continue; // 罚下球员不渲染
      assert.ok(Math.abs(p.x - a.x) < 1e-9 && Math.abs(p.y - a.y) < 1e-9,
        `球员 ${id} 在锚点 t=${a.t} 位置被纹理移动：(${p.x},${p.y}) vs (${a.x},${a.y})`);
      checked += 1;
      if (checked > 400) return; // 抽样上限（逐锚点全量等价，取前 400 足够覆盖多球员多段）
    }
  }
  assert.ok(checked > 0, '必须真的检查到锚点（防空转）');
});

test('T1 纹理：球不受影响（纹理只属于球员）', () => {
  const { events, lineup } = indexFixture();
  const g = new Game(events, lineup, 'continuous');
  const g0 = new Game(events, lineup, 'continuous', { textureAmpM: 0 });
  for (const t of [3.3, 10.7, 47.2]) {
    g.seekTo(t); g0.seekTo(t);
    assert.deepEqual([g.ball.x, g.ball.y], [g0.ball.x, g0.ball.y], `球位置不得随球员纹理变化（t=${t}）`);
  }
});

test('T1 纹理：偏移幅度上界 ≤ ampM（米），且关掉时逐位等于原行为', () => {
  const { events, lineup } = indexFixture();
  const g = new Game(events, lineup, 'continuous');
  const g0 = new Game(events, lineup, 'continuous', { textureAmpM: 0 });
  const ampM = PLAYER_TEXTURE.ampM;
  let maxDev = 0;
  for (let t = 1; t < 80; t += 0.37) {
    g.seekTo(t); g0.seekTo(t);
    for (const p of g.players) {
      const q = g0.players.find((x) => x.id === p.id);
      const dm = Math.hypot((p.x - q.x) * config.pitch.lengthMeters, (p.y - q.y) * config.pitch.widthMeters);
      if (dm > maxDev) maxDev = dm;
    }
  }
  assert.ok(maxDev > 0.01, `纹理必须真的有偏移（maxDev=${maxDev}），防「空转通过」`);
  assert.ok(maxDev <= ampM + 1e-9, `偏移须 ≤ ampM=${ampM}m，实际 ${maxDev}`);
});
