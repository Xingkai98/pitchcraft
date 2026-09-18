// TrackingPlayer 单测：真实比赛帧序列的插值、播放控制、缺球补全标记。
// 纯逻辑测试，不依赖 DOM。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrackingPlayer, createTrackingPlayer } from './tracking-player.js';

// 造一份最小帧序列：22 人简化为 2 人（其余 null），球移动。
function makeFrames() {
  const P = (x, y) => [x, y];
  const players = (a, b) => {
    const arr = new Array(22).fill(null);
    arr[0] = a;
    arr[11] = b;
    return arr;
  };
  return {
    meta: { keyframeHz: 5, frames: 3, coverage: { ballMissingPct: 0 } },
    frames: [
      { t: 0, players: players(P(0.1, 0.5), P(0.9, 0.5)), ball: P(0.5, 0.5) },
      { t: 1, players: players(P(0.2, 0.5), P(0.8, 0.5)), ball: P(0.6, 0.5) },
      { t: 2, players: players(P(0.3, 0.5), P(0.7, 0.5)), ball: P(0.7, 0.5), ballFill: 11 },
    ],
  };
}

test('构造时拒绝空数据', () => {
  assert.throws(() => new TrackingPlayer(null), /tracking 数据为空/);
  assert.throws(() => new TrackingPlayer({ frames: [] }), /tracking 数据为空/);
});

test('初始状态在首帧', () => {
  const p = new TrackingPlayer(makeFrames());
  assert.equal(p.playTime, 0);
  assert.equal(p.startTime, 0);
  assert.equal(p.endTime, 2);
  assert.equal(p.matchEnd, 2);
  assert.equal(p.playing, false);
  // players 暴露 id/team/x/y（renderFrame 需要）
  assert.equal(p.players.length, 2);
  const home = p.players.find((x) => x.id === 0);
  assert.equal(home.team, 'home');
  assert.equal(home.x, 0.1);
  const away = p.players.find((x) => x.id === 11);
  assert.equal(away.team, 'away');
  assert.equal(away.x, 0.9);
});

// 按真实渲染循环的步长推进（60fps → dt≈1/60），累计到指定时刻。
// 刻意不用单个大 dt：step 与 Game.step 一样把单帧钳到 0.1s 并丢弃超出部分。
function advanceTo(p, target) {
  while (p.playing && p.playTime < target - 1e-9) p.step(1 / 60);
}

test('按时间插值（两帧之间取中间值）', () => {
  const p = new TrackingPlayer(makeFrames());
  p.playing = true;
  advanceTo(p, 0.5); // t ≈ 0.5 → 帧 0 与 1 的中点
  const home = p.players.find((x) => x.id === 0);
  assert.ok(Math.abs(home.x - 0.15) < 1e-6, `期望 ~0.15，实际 ${home.x}`);
  assert.ok(Math.abs(p.ball.x - 0.55) < 1e-6, `期望 ~0.55，实际 ${p.ball.x}`);
});

test('到达末尾自动停住', () => {
  const p = new TrackingPlayer(makeFrames());
  p.playing = true;
  p.step(0.1); // 单帧被钳到 0.1s
  assert.equal(p.playTime, 0.1);
  // 推进到末尾：每次 0.1s 上限，20 次后应停在 endTime
  for (let i = 0; i < 30 && p.playing; i += 1) p.step(0.1);
  assert.equal(p.playTime, 2);
  assert.equal(p.playing, false);
  const home = p.players.find((x) => x.id === 0);
  assert.equal(home.x, 0.3);
});

test('单帧尖峰被钳制，不会一口气快进掉内容', () => {
  const p = new TrackingPlayer(makeFrames());
  p.playing = true;
  p.step(100); // 切标签页回来的场景：未钳制的话直接冲到末尾
  assert.equal(p.playTime, 0.1);
  assert.equal(p.playing, true);
});

test('togglePlay 播完后再播回到开头', () => {
  const p = new TrackingPlayer(makeFrames());
  p.playing = true;
  for (let i = 0; i < 30 && p.playing; i += 1) p.step(0.1); // 播到末尾，playing=false
  assert.equal(p.playing, false);
  p.togglePlay();
  assert.equal(p.playTime, 0);
  assert.equal(p.playing, true);
});

test('replay 回到开头并开始播放', () => {
  const p = new TrackingPlayer(makeFrames());
  p.seekTo(1.5);
  p.replay();
  assert.equal(p.playTime, 0);
  assert.equal(p.playing, true);
});

test('seekTo 钳制范围并暂停', () => {
  const p = new TrackingPlayer(makeFrames());
  p.playing = true;
  p.seekTo(99);
  assert.equal(p.playTime, 2);
  assert.equal(p.playing, false);
  p.seekTo(-5);
  assert.equal(p.playTime, 0);
});

test('缺球补全帧暴露 ballFilled 标记', () => {
  const p = new TrackingPlayer(makeFrames());
  p.seekTo(2); // 末帧带 ballFill: 11
  assert.equal(p.ballFilled, 11);
  p.seekTo(0); // 首帧是真实观测
  assert.equal(p.ballFilled, null);
});

test('getProgress 按时间跨度归一', () => {
  const p = new TrackingPlayer(makeFrames());
  assert.equal(p.getProgress(), 0);
  p.seekTo(1);
  assert.equal(p.getProgress(), 0.5);
  p.seekTo(2);
  assert.equal(p.getProgress(), 1);
});

test('时间窗不从 0 开始时，startTime/endTime 取实际值', () => {
  const data = makeFrames();
  data.frames = data.frames.map((f) => ({ ...f, t: f.t + 60 }));
  const p = new TrackingPlayer(data);
  assert.equal(p.startTime, 60);
  assert.equal(p.endTime, 62);
  assert.equal(p.getProgress(), 0);
  p.seekTo(61);
  assert.equal(p.getProgress(), 0.5);
});

test('某帧缺球员时用最后已知位置停住，而不是跳回原点', () => {
  const frames = makeFrames();
  frames.frames[2].players[0] = null; // 末帧缺 id 0（换人边界）
  const p = new TrackingPlayer(frames);
  p.seekTo(2);
  const home = p.players.find((x) => x.id === 0);
  assert.equal(home.x, 0.2); // 停在上一帧已知位置，而不是跳回 (0,0)
});

test('全程缺某球员时不渲染该球员', () => {
  const frames = makeFrames();
  frames.frames.forEach((f) => { f.players[11] = null; });
  const p = new TrackingPlayer(frames);
  assert.equal(p.players.find((x) => x.id === 11), undefined);
  assert.equal(p.players.length, 1);
});

test('球不借未来帧：当前帧无球时停在最后已知位置，不是下一帧的位置', () => {
  // 回归背景：曾写成"当前帧无球就用下一帧的球位"——球会在 t 时刻出现在 t+1 才该到的
  // 位置（提前 0.2s 瞬移）。与球员侧「刻意不回退到下一帧」的原则不一致。
  const nul = (t) => ({ t, players: Array.from({ length: 22 }, () => [0.5, 0.5]), ball: null });
  const withBall = (t, p) => ({ t, players: Array.from({ length: 22 }, () => [0.5, 0.5]), ball: p });
  const p = new TrackingPlayer({
    meta: {},
    frames: [withBall(0, [0.2, 0.2]), nul(1), withBall(2, [0.9, 0.9])],
  });
  p.seekTo(1); // 该帧无球观测，下一帧才有
  assert.equal(p.ball.x, 0.2, '球应停在最后已知位置 (0.2)，而不是下一帧的 0.9');
  assert.equal(p.ball.y, 0.2);
  p.seekTo(2);
  assert.equal(p.ball.x, 0.9, '到了有观测的帧才移到新位置');
});

test('球在首次观测前不可见（不画默认位置）', () => {
  const p = new TrackingPlayer({
    meta: {},
    frames: [
      { t: 0, players: Array.from({ length: 22 }, () => [0.5, 0.5]), ball: null },
      { t: 1, players: Array.from({ length: 22 }, () => [0.5, 0.5]), ball: [0.3, 0.3] },
    ],
  });
  p.seekTo(0);
  assert.equal(p.ballVisible, false, '首次观测之前不应显示球');
  p.seekTo(1);
  assert.equal(p.ballVisible, true);
  assert.equal(p.ball.x, 0.3);
});

test('球可见性只由帧号决定（直接 seek 与顺播一致）', () => {
  const p = new TrackingPlayer({
    meta: {},
    frames: [
      { t: 0, players: Array.from({ length: 22 }, () => [0.5, 0.5]), ball: null },
      { t: 1, players: Array.from({ length: 22 }, () => [0.5, 0.5]), ball: [0.3, 0.3] },
      { t: 2, players: Array.from({ length: 22 }, () => [0.5, 0.5]), ball: [0.4, 0.4] },
    ],
  });
  // 直接跳到末帧（不经过中间帧）
  const direct = new TrackingPlayer({
    meta: {},
    frames: [
      { t: 0, players: Array.from({ length: 22 }, () => [0.5, 0.5]), ball: null },
      { t: 1, players: Array.from({ length: 22 }, () => [0.5, 0.5]), ball: [0.3, 0.3] },
      { t: 2, players: Array.from({ length: 22 }, () => [0.5, 0.5]), ball: [0.4, 0.4] },
    ],
  });
  direct.seekTo(2);
  p.seekTo(0); p.seekTo(1); p.seekTo(2);
  assert.equal(direct.ballVisible, p.ballVisible);
  assert.deepEqual(direct.ball, p.ball);
});

test('球的可见性与位置在倒带后不残留未来状态', () => {
  // 与球员同样的「帧号决定」原则，对球也要成立：从末帧倒回早帧时，
  // 不能残留末帧才有球的状态。
  const nul = (t) => ({ t, players: Array.from({ length: 22 }, () => [0.5, 0.5]), ball: null });
  const withBall = (t, p) => ({ t, players: Array.from({ length: 22 }, () => [0.5, 0.5]), ball: p });
  const frames = [nul(0), nul(1), withBall(2, [0.7, 0.7])];
  const a = new TrackingPlayer({ meta: {}, frames: frames.map((f) => ({ ...f })) });
  a.seekTo(2); // 到有球的帧
  assert.equal(a.ballVisible, true);
  a.seekTo(0); // 倒回还没有球的帧
  assert.equal(a.ballVisible, false, '倒带后不应残留"有球"状态');

  // 直接 seek vs 顺播，同一时刻结果必须一致
  const b = new TrackingPlayer({ meta: {}, frames: frames.map((f) => ({ ...f })) });
  b.seekTo(0);
  assert.equal(a.ballVisible, b.ballVisible);
  assert.deepEqual(a.ball, b.ball);
});

test('画面只由帧号决定：跳着拖与顺着播结果一致', () => {
  const frames = makeFrames();
  frames.frames[2].players[0] = null; // 末帧缺 id 0
  // A：先前进再后退再前进（经历所有帧）
  const a = new TrackingPlayer(frames);
  a.seekTo(2);
  a.seekTo(1);
  a.seekTo(2);
  // B：直接跳到末帧（不经过前面的帧）
  const b = new TrackingPlayer(frames);
  b.seekTo(2);
  const xa = a.players.find((x) => x.id === 0).x;
  const xb = b.players.find((x) => x.id === 0).x;
  assert.equal(xa, xb, '两种到达方式在同一时刻必须给出相同画面');
  assert.equal(xb, 0.2); // 末帧缺 id 0 → 用帧 1 的最后已知位置
});

test('倒带后同一时刻与首次经过时一致', () => {
  const frames = makeFrames();
  frames.frames[2].players[0] = null;
  const p = new TrackingPlayer(frames);
  p.seekTo(2);
  const atEnd = p.players.find((x) => x.id === 0).x;
  assert.equal(atEnd, 0.2);
  p.seekTo(1);
  assert.equal(p.players.find((x) => x.id === 0).x, 0.2); // 帧 1 有观测值 0.2，不残留
  p.seekTo(2);
  assert.equal(p.players.find((x) => x.id === 0).x, atEnd);
});

test('倒带越过观测点时重新用更早的已知位置', () => {
  const frames = makeFrames();
  frames.frames[1].players[0] = null; // 帧 1 缺 id 0
  const p = new TrackingPlayer(frames);
  p.seekTo(2);
  assert.equal(p.players.find((x) => x.id === 0).x, 0.3);
  p.seekTo(1); // 帧 1 缺观测 → 回落到帧 0 的 0.1
  assert.equal(p.players.find((x) => x.id === 0).x, 0.1);
  p.seekTo(2); // 帧 2 有观测
  assert.equal(p.players.find((x) => x.id === 0).x, 0.3);
});

test('createTrackingPlayer 接受 JSON 文本', () => {
  const p = createTrackingPlayer(JSON.stringify(makeFrames()));
  assert.equal(p.frames.length, 3);
  assert.equal(p.endTime, 2);
});

test('球的插值在相邻帧之间平滑', () => {
  const p = new TrackingPlayer(makeFrames());
  p.seekTo(0.25);
  assert.equal(p.ball.x.toFixed(4), '0.5250');
});
